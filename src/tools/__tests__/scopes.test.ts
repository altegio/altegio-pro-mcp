/**
 * The scope map and the satisfaction rules.
 *
 * Three kinds of test live here. The first pins behaviour that a rename of the
 * placeholder vocabulary must not change: the `write ⊇ read` implication and
 * the action-scopes that are never implied inside the v3 vocabulary. The
 * second pins how the two vocabularies coexist — the platform's
 * `mcp:pro:read`/`mcp:pro:write`, which is what the proxy actually sends, and
 * the rule that a vocabulary this build cannot read restricts nothing. The
 * third is the coverage invariant — every tool this server can execute has
 * exactly one entry in the map — which is what makes it safe for
 * `requiredScopesFor` to be permissive about a name it has never seen.
 */
import * as defs from '../definitions/index.js';
import { onboardingTools } from '../onboarding-registry.js';
import type { DefinedTool } from '../factory.js';
import { parseScopes } from '../../request-context.js';
import {
  KNOWN_SCOPES,
  PLATFORM_SCOPES,
  PLACEHOLDER_ONLY_SCOPES,
  TOOL_SCOPES,
  checkToolScopes,
  grantIsRecognised,
  missingScopes,
  requiredScopesFor,
  scopeRefusalMessage,
  scopeSatisfied,
  type ToolScope,
} from '../scopes.js';

const factoryTools = (Object.values(defs) as unknown[]).filter(
  (tool): tool is DefinedTool =>
    !!tool && typeof tool === 'object' && 'toMcpTool' in tool && 'meta' in tool
);

/** Every executable tool name: factory-defined (disabled included) + wizard. */
const allToolNames = [
  ...factoryTools.map((tool) => tool.meta.name),
  ...onboardingTools.map((spec) => spec.name),
].sort();

const grants = (...scopes: string[]): ReadonlySet<string> => new Set(scopes);

describe('scope vocabulary', () => {
  it('uses only domain:action names', () => {
    for (const scope of KNOWN_SCOPES) {
      expect(scope).toMatch(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    }
  });

  it('declares which names are local placeholders, not v3 catalog names', () => {
    // If this list shrinks, the API team has published a real name for that
    // domain and the map above it should be revisited, not just renamed.
    expect([...PLACEHOLDER_ONLY_SCOPES].sort()).toEqual([
      'analytics:read',
      'analytics:write',
      'api:read',
    ]);
  });
});

describe('the map covers every tool', () => {
  it('has exactly one entry per executable tool and no strays', () => {
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual(allToolNames);
  });

  it('only maps to known scopes', () => {
    for (const name of allToolNames) {
      for (const scope of requiredScopesFor(name)) {
        expect(KNOWN_SCOPES).toContain(scope);
      }
    }
  });

  it('normalises a single scope, a list and null the same way', () => {
    expect(requiredScopesFor('get_staff')).toEqual(['team_members:read']);
    expect(requiredScopesFor('onboarding_rollback_phase')).toEqual([
      'team_members:write',
      'services:write',
      'clients:write',
      'appointments:write',
    ]);
    expect(requiredScopesFor('altegio_login')).toEqual([]);
    expect(requiredScopesFor('onboarding_status')).toEqual([]);
  });

  it('gates every write tool that reaches the API', () => {
    // A tool that is not read-only and is not local-state-only must require
    // something: an ungated write is exactly the hole this feature closes.
    const ungatedWrites = factoryTools
      .filter(
        (tool) =>
          tool.meta.annotations?.readOnlyHint !== true &&
          requiredScopesFor(tool.meta.name).length === 0
      )
      .map((tool) => tool.meta.name)
      .sort();
    // Only the two password-login tools: they obtain the credential itself.
    expect(ungatedWrites).toEqual(['altegio_login', 'altegio_logout']);
  });

  it('reaches the tool definition through the factory, not the definition file', () => {
    const staff = factoryTools.find((tool) => tool.meta.name === 'get_staff')!;
    expect(staff.meta.requiredScopes).toEqual(['team_members:read']);
    // Nothing in a definition module spells a scope out; the factory fills it.
    const remove = factoryTools.find(
      (tool) => tool.meta.name === 'remove_location_user'
    )!;
    expect(remove.meta.requiredScopes).toEqual(['team_members:manage_access']);
  });
});

describe('scopeSatisfied', () => {
  it('accepts the exact scope', () => {
    expect(scopeSatisfied(grants('services:read'), 'services:read')).toBe(true);
  });

  it('lets write cover read on the same domain (v3 A8/F-13)', () => {
    expect(scopeSatisfied(grants('clients:write'), 'clients:read')).toBe(true);
  });

  it('does not let read cover write', () => {
    expect(scopeSatisfied(grants('clients:read'), 'clients:write')).toBe(false);
  });

  it('never implies the action-scopes', () => {
    expect(
      scopeSatisfied(grants('appointments:write'), 'appointments:create')
    ).toBe(false);
    expect(
      scopeSatisfied(grants('team_members:write'), 'team_members:manage_access')
    ).toBe(false);
  });

  it('never crosses domains, including the chain/location level split', () => {
    expect(scopeSatisfied(grants('services:write'), 'clients:read')).toBe(
      false
    );
    expect(
      scopeSatisfied(grants('chain_services:write'), 'services:read')
    ).toBe(false);
  });

  it('reports every missing scope of a composite tool', () => {
    const granted = grants('services:write', 'clients:write');
    expect(
      missingScopes(granted, requiredScopesFor('onboarding_rollback_phase'))
    ).toEqual(['team_members:write', 'appointments:write']);
  });
});

describe('parseScopes', () => {
  it('returns undefined when nothing is declared', () => {
    expect(parseScopes(undefined)).toBeUndefined();
    expect(parseScopes('')).toBeUndefined();
    expect(parseScopes('   ')).toBeUndefined();
  });

  it('splits an OAuth space-delimited list', () => {
    expect([...(parseScopes('clients:read  services:write') ?? [])]).toEqual([
      'clients:read',
      'services:write',
    ]);
  });

  it('drops fragments outside the RFC 6749 scope-token grammar', () => {
    // A quote or a backslash cannot reach a tool result through this header.
    const parsed = parseScopes('clients:read "quoted" back\\slash');
    expect([...(parsed ?? [])]).toEqual(['clients:read']);
  });

  it('treats an entirely malformed header as "not declared", not "empty"', () => {
    // Indistinguishable from a proxy bug; refusing every call would be worse.
    expect(parseScopes('" \\')).toBeUndefined();
  });
});

describe('checkToolScopes', () => {
  const required = requiredScopesFor('delete_staff');

  it('passes a caller that declares no scopes at all', () => {
    // stdio and the public HTTP endpoint (`/public/pro` does not forward
    // identity) are in this state: the gate must be a no-op for both.
    expect(
      checkToolScopes({
        toolName: 'delete_staff',
        required,
        granted: undefined,
      })
    ).toBeUndefined();
  });

  it('passes when the required scope is present', () => {
    expect(
      checkToolScopes({
        toolName: 'delete_staff',
        required,
        granted: grants('team_members:write', 'clients:read'),
      })
    ).toBeUndefined();
  });

  it('passes an ungated tool whatever the caller holds', () => {
    expect(
      checkToolScopes({
        toolName: 'altegio_login',
        required: requiredScopesFor('altegio_login'),
        granted: grants('clients:read'),
      })
    ).toBeUndefined();
  });

  it('refuses in band, with an actionable message, when the scope is absent', () => {
    const result = checkToolScopes({
      toolName: 'delete_staff',
      required,
      granted: grants('clients:read', 'appointments:read'),
    });

    expect(result?.isError).toBe(true);
    const text = result!.content[0]!.text!;
    expect(text).toContain('Nothing was done');
    expect(text).toContain('delete_staff');
    // What is missing, and what the caller actually has.
    expect(text).toContain('team_members:write');
    expect(text).toContain('appointments:read, clients:read');
    // What a person should do about it — and that retrying is not it.
    expect(text).toContain('Do not retry');
    expect(text).toContain('re-authorise');
    // No upstream API text is involved on this path at all.
    expect(text).not.toContain('Upstream API message');
  });

  it('summarises instead of printing an unbounded list of grants', () => {
    const many = new Set(
      Array.from({ length: 20 }, (_, i) => `domain_${i}:read`)
    );
    const text = scopeRefusalMessage(
      'get_staff',
      ['team_members:read'] as ToolScope[],
      many
    );
    expect(text).toContain('(+8 more)');
  });

  it('names every missing scope of a composite tool', () => {
    const result = checkToolScopes({
      toolName: 'onboarding_rollback_phase',
      required: requiredScopesFor('onboarding_rollback_phase'),
      granted: grants('services:write'),
    });
    const text = result!.content[0]!.text!;
    expect(text).toContain('Missing permissions:');
    expect(text).toContain('team_members:write');
    expect(text).toContain('clients:write');
    expect(text).toContain('appointments:write');
    expect(text).not.toContain('Missing permissions: services:write');
  });
});

/**
 * The vocabulary the OAuth proxy really sends.
 *
 * This is the regression suite for the bug that made this file necessary: the
 * first version of the gate assumed no deployment sent `x-mcp-auth-scope`,
 * while `mcp-proxy` had been forwarding `mcp:pro:read mcp:pro:write` on every
 * `forward_identity` route since the platform shipped. Those names are
 * well-formed scope tokens, so the grant was non-empty; none of them matched a
 * v3 requirement, so every gated tool was refused on the closed endpoint.
 *
 * `PROXY_FULL_GRANT` is the literal header value observed in production. If
 * `routes.json` ever changes the names, these tests are what should fail.
 */
describe('the platform vocabulary (mcp:pro:*)', () => {
  const PROXY_FULL_GRANT = 'mcp:pro:read mcp:pro:write';
  const PROXY_READ_GRANT = 'mcp:pro:read';

  /** The gated tools a session touches first; a refusal here is an outage. */
  const gated = [
    'list_locations',
    'get_staff',
    'get_services',
    'get_appointments',
    'clients_search',
    'analytics_get_overview',
    'altegio_call_operation',
  ] as const;

  it('declares exactly the two names routes.json issues for this service', () => {
    expect([...PLATFORM_SCOPES]).toEqual(['mcp:pro:read', 'mcp:pro:write']);
  });

  it('parses the production header into a non-empty grant', () => {
    // Not a hypothetical: this is why the gate fired. The names are valid
    // scope tokens, so "no scopes declared" never applied to them.
    expect([...(parseScopes(PROXY_FULL_GRANT) ?? [])]).toEqual([
      'mcp:pro:read',
      'mcp:pro:write',
    ]);
  });

  it('lets a full proxy grant run every gated tool', () => {
    const granted = parseScopes(PROXY_FULL_GRANT)!;
    for (const name of gated) {
      expect(
        checkToolScopes({
          toolName: name,
          required: requiredScopesFor(name),
          granted,
        })
      ).toBeUndefined();
    }
  });

  it('lets a full proxy grant run writes, including the action-scopes', () => {
    // Deliberate: the platform vocabulary has two grades for the whole
    // service and cannot express `create` or `manage_access` separately, so
    // refusing them would make those tools permanently unreachable rather
    // than strictly guarded. See `scopeSatisfied` for the reasoning.
    const granted = parseScopes(PROXY_FULL_GRANT)!;
    for (const name of [
      'update_location',
      'delete_staff',
      'create_appointment',
      'remove_location_user',
      'onboarding_rollback_phase',
      'analytics_delete_assistant_report',
    ]) {
      expect(
        checkToolScopes({
          toolName: name,
          required: requiredScopesFor(name),
          granted,
        })
      ).toBeUndefined();
    }
  });

  it('lets a read-only proxy grant run every gated read', () => {
    const granted = parseScopes(PROXY_READ_GRANT)!;
    for (const name of gated) {
      expect(
        checkToolScopes({
          toolName: name,
          required: requiredScopesFor(name),
          granted,
        })
      ).toBeUndefined();
    }
  });

  it('refuses every write on a read-only proxy grant', () => {
    // The point of the whole exercise: a token the proxy issued narrow is a
    // real boundary, not a guardrail — the write tools are unreachable on any
    // address, `/mcp` included, not merely hidden from `/mcp/readonly`.
    const granted = parseScopes(PROXY_READ_GRANT)!;
    for (const name of [
      'update_location',
      'create_staff',
      'delete_staff',
      'update_service',
      'create_appointment',
      'delete_appointment',
      'clients_delete',
      'remove_location_user',
      'onboarding_import_clients',
      'onboarding_rollback_phase',
    ]) {
      const result = checkToolScopes({
        toolName: name,
        required: requiredScopesFor(name),
        granted,
      });
      expect(result?.isError).toBe(true);
      expect(result!.content[0]!.text).toContain(name);
    }
  });

  it('keeps read and write apart at the satisfaction rule', () => {
    expect(scopeSatisfied(grants('mcp:pro:read'), 'clients:read')).toBe(true);
    expect(scopeSatisfied(grants('mcp:pro:read'), 'clients:write')).toBe(false);
    expect(scopeSatisfied(grants('mcp:pro:read'), 'appointments:create')).toBe(
      false
    );
    expect(
      scopeSatisfied(grants('mcp:pro:read'), 'team_members:manage_access')
    ).toBe(false);

    expect(scopeSatisfied(grants('mcp:pro:write'), 'clients:read')).toBe(true);
    expect(scopeSatisfied(grants('mcp:pro:write'), 'clients:write')).toBe(true);
    expect(scopeSatisfied(grants('mcp:pro:write'), 'appointments:create')).toBe(
      true
    );
    expect(
      scopeSatisfied(grants('mcp:pro:write'), 'team_members:manage_access')
    ).toBe(true);
  });

  it('does not let another service’s platform scope grant anything here', () => {
    expect(scopeSatisfied(grants('mcp:bi-data:write'), 'clients:read')).toBe(
      false
    );
  });
});

describe('an unrecognised vocabulary restricts nothing', () => {
  it('recognises the two vocabularies this build knows', () => {
    expect(grantIsRecognised(grants('mcp:pro:read'))).toBe(true);
    expect(grantIsRecognised(grants('clients:read'))).toBe(true);
    // Recognition is by v3 domain, not by exact membership: a name this
    // server never requires still proves the caller speaks the vocabulary.
    expect(grantIsRecognised(grants('clients:read_contact'))).toBe(true);
  });

  it('does not recognise names from another vocabulary', () => {
    expect(grantIsRecognised(grants('mcp:bi-data:read'))).toBe(false);
    expect(grantIsRecognised(grants('openid', 'email', 'profile'))).toBe(false);
    expect(grantIsRecognised(grants('visits:read'))).toBe(false);
  });

  it('stands aside entirely when nothing in the grant is recognised', () => {
    // The rule the original design intended and the wrong premise broke: a
    // vocabulary this build cannot map must never become a refusal, or any
    // rename upstream takes the whole server down.
    for (const granted of [
      grants('openid', 'email'),
      grants('mcp:bi-data:read', 'mcp:bi-data:write'),
      grants('some.future.scope'),
    ]) {
      expect(
        checkToolScopes({
          toolName: 'delete_staff',
          required: requiredScopesFor('delete_staff'),
          granted,
        })
      ).toBeUndefined();
    }
  });

  it('enforces as soon as one recognised name is present', () => {
    // A mixed grant is not an excuse to stand aside: the recognised part is
    // evaluated, the rest simply grants nothing.
    const result = checkToolScopes({
      toolName: 'delete_staff',
      required: requiredScopesFor('delete_staff'),
      granted: grants('mcp:pro:read', 'openid'),
    });
    expect(result?.isError).toBe(true);
    expect(result!.content[0]!.text).toContain('team_members:write');
  });
});

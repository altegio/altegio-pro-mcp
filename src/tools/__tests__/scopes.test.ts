/**
 * The scope map and the satisfaction rules.
 *
 * Two kinds of test live here. The first kind pins behaviour that a rename of
 * the placeholder vocabulary must not change: the `write ⊇ read` implication,
 * the action-scopes that are never implied, and the "no declared scopes means
 * no restriction" rule every deployment relies on today. The second kind is
 * the coverage invariant — every tool this server can execute has exactly one
 * entry in the map — which is what makes it safe for `requiredScopesFor` to
 * be permissive about a name it has never seen.
 */
import * as defs from '../definitions/index.js';
import { onboardingTools } from '../onboarding-registry.js';
import type { DefinedTool } from '../factory.js';
import { parseScopes } from '../../request-context.js';
import {
  KNOWN_SCOPES,
  PLACEHOLDER_ONLY_SCOPES,
  TOOL_SCOPES,
  checkToolScopes,
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
    // stdio, the public HTTP endpoint and the closed Google deployment are all
    // in this state today: the gate must be a no-op for every one of them.
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

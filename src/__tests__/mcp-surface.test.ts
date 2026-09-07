import { describe, it, expect } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server.js';
import { orderedToolEntries } from '../tools/registry.js';
import { FACET_BASE_TOOLS, type FacetKey } from '../tools/facets.js';
import {
  GLOSSARY_URI,
  ONBOARDING_GUIDE_URI,
  PRODUCT_LOGIC_URI,
} from '../resources/index.js';
import { ONBOARDING_WALKTHROUGH_PROMPT } from '../prompts/index.js';
import { DEFAULT_FACET_EXTRA_TOOLS } from '../tools/facets.js';
import {
  COVERAGE_URI as ANALYTICS_COVERAGE_URI,
  GLOSSARY_URI as ANALYTICS_GLOSSARY_URI,
} from '../resources/analytics.resources.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The whole MCP surface as a client sees it, over an in-memory transport: the
 * facet-filtered tool list, the refusal of a tool the facet does not serve,
 * the `initialize` instructions, and the resource and prompt handlers.
 */
async function connect(facet?: FacetKey): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer(facet ? { facet } : {});
  const client = new Client({ name: 'surface-test', version: '1.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/**
 * The text body of a `resources/read` result. Every resource this server serves
 * is text, but the SDK types a content entry as text-or-blob, so narrow it here
 * rather than at each call site.
 */
function resourceText(contents: ReadResourceResult['contents']): string {
  const first = contents[0];
  return first && 'text' in first ? String(first.text) : '';
}

describe('tools/list per facet', () => {
  it('serves every non-pack tool plus the analytics entry points on the default view, in the registry order', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      orderedToolEntries()
        .map((entry) => entry.spec.name)
        .filter(
          (name) =>
            !name.startsWith('analytics_') ||
            DEFAULT_FACET_EXTRA_TOOLS.includes(name)
        )
    );
    await client.close();
  });

  it('returns the same list on every call', async () => {
    const client = await connect('catalog');
    const first = await client.listTools();
    const second = await client.listTools();
    expect(second.tools.map((t) => t.name)).toEqual(
      first.tools.map((t) => t.name)
    );
    await client.close();
  });

  it('serves only the ops tools on the ops facet', async () => {
    const client = await connect('ops');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'altegio_login',
      'altegio_logout',
      'create_appointment',
      'delete_appointment',
      'get_appointments',
      'list_locations',
      'update_appointment',
    ]);
    await client.close();
  });

  it('serves only the base tools on the marketing facet', async () => {
    const client = await connect('marketing');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...FACET_BASE_TOOLS].sort()
    );
    await client.close();
  });
});

describe('tools/call outside the facet', () => {
  it('refuses the call and names the facet that serves the tool', async () => {
    const client = await connect('ops');
    await expect(
      client.callTool({ name: 'get_staff', arguments: { location_id: 1 } })
    ).rejects.toThrow(/not served by the "ops" view.*\/mcp\/catalog/s);
    await client.close();
  });

  it('still reports an unknown tool as unknown', async () => {
    const client = await connect('ops');
    await expect(
      client.callTool({ name: 'no_such_tool', arguments: {} })
    ).rejects.toThrow(/Unknown tool: no_such_tool/);
    await client.close();
  });

  it('lets a facet call its own tools through to the handler', async () => {
    const client = await connect('ops');
    // Reaches the handler, which refuses because nobody is authenticated —
    // proof the facet check did not intercept it.
    const result = await client.callTool({
      name: 'get_appointments',
      arguments: { location_id: 1 },
    });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

describe('server instructions', () => {
  it('names the domains, the facets and what is being added', async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? '';

    expect(instructions).toContain('Altegio Pro');
    expect(instructions).toContain('altegio_login');
    expect(instructions).toContain('/mcp/analytics');
    expect(instructions).toContain('/mcp/onboarding');
    expect(instructions).toContain('report builder');
    expect(instructions).toContain('executor');
    expect(instructions.split(/\s+/).filter(Boolean).length).toBeLessThan(120);
    await client.close();
  });

  it('declares the tool, resource and prompt capabilities', async () => {
    const client = await connect();
    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();
    expect(capabilities?.resources?.subscribe).toBe(false);
    await client.close();
  });
});

describe('resources', () => {
  it('lists the documentation resources in a deterministic order', async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toEqual([
      ANALYTICS_COVERAGE_URI,
      ANALYTICS_GLOSSARY_URI,
      GLOSSARY_URI,
      ONBOARDING_GUIDE_URI,
      PRODUCT_LOGIC_URI,
    ]);
    for (const resource of resources) {
      expect(resource.mimeType).toBe('text/markdown');
      expect(resource.description?.length).toBeGreaterThan(20);
    }
    await client.close();
  });

  it('serves the canonical vocabulary with its forbidden synonyms', async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: GLOSSARY_URI });
    const text = resourceText(contents);
    for (const term of [
      'Location',
      'Chain',
      'Team member',
      'Professional',
      'Receptionist',
      'Position',
      'Client',
      'Appointment',
      'Visit',
      'Group event',
      'Service category',
      'Package',
      'Resource',
      'Products',
      'Membership',
      'Gift card',
      'Loyalty card',
      'Loyalty program',
      'Client account',
      'Accounts',
      'Financial transactions',
      'Payroll',
      'Inventory',
      'Digital schedule',
      'Online booking',
      'Analytics',
    ]) {
      expect(text).toContain(term);
    }
    expect(text).toContain('Never use');
    expect(contents[0]?.mimeType).toBe('text/markdown');
    await client.close();
  });

  it('serves the product logic document as markdown', async () => {
    const client = await connect();
    const { contents } = await client.readResource({ uri: PRODUCT_LOGIC_URI });
    expect(resourceText(contents)).toContain(
      'Product Logic Description of Altegio'
    );
    await client.close();
  });

  it('serves the onboarding guide as markdown', async () => {
    const client = await connect();
    const { contents } = await client.readResource({
      uri: ONBOARDING_GUIDE_URI,
    });
    expect(resourceText(contents)).toContain('# Onboarding Wizard');
    await client.close();
  });

  it('rejects an unknown URI with a pointer to resources/list', async () => {
    const client = await connect();
    await expect(
      client.readResource({ uri: 'altegio://docs/nope' })
    ).rejects.toThrow(/Unknown resource.*resources\/list/s);
    await client.close();
  });

  it('serves resources on a narrow facet too', async () => {
    const client = await connect('onboarding');
    const { resources } = await client.listResources();
    expect(resources).toHaveLength(5);
    await client.close();
  });
});

describe('prompts', () => {
  it('lists the onboarding walkthrough with its optional location', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      'analytics_compare_periods',
      'analytics_monthly_review',
      'analytics_team_member_review',
      ONBOARDING_WALKTHROUGH_PROMPT,
    ]);
    const walkthrough = prompts.find(
      (prompt) => prompt.name === ONBOARDING_WALKTHROUGH_PROMPT
    );
    expect(walkthrough?.arguments).toEqual([
      {
        name: 'location_id',
        description: expect.stringContaining('location'),
        required: false,
      },
    ]);
    await client.close();
  });

  it('builds the walkthrough for a given location', async () => {
    const client = await connect();
    const result = await client.getPrompt({
      name: ONBOARDING_WALKTHROUGH_PROMPT,
      arguments: { location_id: '123456' },
    });
    const text = String(
      result.messages[0]?.content.type === 'text'
        ? result.messages[0].content.text
        : ''
    );
    expect(result.messages[0]?.role).toBe('user');
    expect(text).toContain('Set up location 123456.');
    expect(text).toContain('onboarding_add_positions');
    expect(text).toContain('onboarding_set_schedules');
    expect(text).toContain('onboarding_preview_data');
    expect(text).toContain('onboarding_rollback_phase');
    await client.close();
  });

  it('asks which location to set up when none is given', async () => {
    const client = await connect();
    const result = await client.getPrompt({
      name: ONBOARDING_WALKTHROUGH_PROMPT,
    });
    const text = String(
      result.messages[0]?.content.type === 'text'
        ? result.messages[0].content.text
        : ''
    );
    expect(text).toContain('list_locations');
    await client.close();
  });

  it('rejects an unknown prompt with a pointer to prompts/list', async () => {
    const client = await connect();
    await expect(client.getPrompt({ name: 'no_such_prompt' })).rejects.toThrow(
      /Unknown prompt.*prompts\/list/s
    );
    await client.close();
  });
});

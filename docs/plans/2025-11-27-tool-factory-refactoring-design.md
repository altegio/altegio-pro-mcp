# Tool Factory Refactoring Design

**Date:** 2025-11-27
**Status:** Approved
**Author:** Claude + Human

## Problem Statement

The codebase has significant code duplication and maintainability issues:

| File | Lines | Issues |
|------|-------|--------|
| `handlers.ts` | 847 | Monolithic class, 20+ schemas mixed with logic |
| `registry.ts` | 646 | Giant 70-case switch, duplicate JSON schemas |
| `altegio-client.ts` | 833 | Auth check repeated 20+ times |

### Duplication Patterns
- Auth check repeated ~35 times
- Response format repeated ~40 times
- Error handling pattern repeated ~25 times
- Schema duplication: Zod in handlers + JSON Schema in registry

## Solution: Tool Factory Pattern

### Core Concept

Define each tool once with a declarative API that auto-generates MCP schemas from Zod:

```typescript
// src/tools/definitions/staff.tools.ts
export const getStaff = defineTool({
  name: 'get_staff',
  category: 'Staff',
  description: '[Staff] Get list of staff members...',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    page: z.number().optional().describe('Page number'),
    count: z.number().optional().describe('Results per page'),
  }),

  handler: async ({ input, client }) => {
    const staff = await client.getStaff(input.company_id, input);
    return formatStaffList(staff);
  },
});
```

### Factory Implementation

```typescript
// src/tools/factory.ts
import { z, ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AltegioClient } from '../providers/altegio-client.js';

interface ToolDefinition<T extends ZodSchema> {
  name: string;
  category: string;
  description: string;
  requiresAuth: boolean;
  input: T;
  handler: (ctx: {
    input: z.infer<T>;
    client: AltegioClient;
  }) => Promise<string>;
}

const textResponse = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

export function defineTool<T extends ZodSchema>(def: ToolDefinition<T>) {
  return {
    toMcpTool: () => ({
      name: def.name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.input, { target: 'openApi3' }),
    }),

    createHandler: (client: AltegioClient) => async (args: unknown) => {
      if (def.requiresAuth && !client.isAuthenticated()) {
        throw new Error('Authentication required. Please login first.');
      }

      try {
        const input = def.input.parse(args);
        const result = await def.handler({ input, client });
        return textResponse(result);
      } catch (error) {
        return {
          ...textResponse(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`),
          isError: true,
        };
      }
    },

    meta: def,
  };
}
```

### File Structure

```
src/tools/
  factory.ts              # defineTool, types
  formatters.ts           # formatStaffList, formatBookings, etc.

  definitions/            # One file per domain
    auth.tools.ts         # login, logout (2 tools)
    company.tools.ts      # list_companies (1 tool)
    staff.tools.ts        # get, create, update, delete (4 tools)
    services.tools.ts     # get, create, update (3 tools)
    bookings.tools.ts     # get, create, update, delete (4 tools)
    schedule.tools.ts     # get, create, update, delete (4 tools)
    positions.tools.ts    # get, create, update, delete (4 tools)
    categories.tools.ts   # get (1 tool)
    onboarding.tools.ts   # wizard tools (10 tools)
    index.ts              # re-exports all tools

  registry.ts             # Auto-registers from definitions/
```

### Auto-Discovery Registry

```typescript
// src/tools/registry.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import * as allTools from './definitions/index.js';

export function registerTools(server: Server, client: AltegioClient) {
  const tools = Object.values(allTools);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => t.toMcpTool()),
  }));

  const handlers = Object.fromEntries(
    tools.map(t => [t.meta.name, t.createHandler(client)])
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = handlers[req.params.name];
    if (!handler) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool`);
    return handler(req.params.arguments);
  });
}
```

## Migration Strategy

### Phase 1: Infrastructure (non-breaking)
- Add `zod-to-json-schema` dependency
- Create `factory.ts` and `formatters.ts`
- Create `definitions/` directory structure

### Phase 2: Incremental Tool Migration
Migrate by domain, test after each:
1. `auth.tools.ts` (2 tools) - simplest
2. `staff.tools.ts` (4 tools) - representative CRUD
3. `positions.tools.ts` (4 tools)
4. `services.tools.ts` (3 tools)
5. `categories.tools.ts` (1 tool)
6. `schedule.tools.ts` (4 tools)
7. `bookings.tools.ts` (4 tools)
8. `company.tools.ts` (1 tool)
9. `onboarding.tools.ts` (10 tools)

### Phase 3: Registry Replacement
- Switch to auto-discovery registry
- Delete old `handlers.ts` and `registry.ts`

## Expected Impact

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| `handlers.ts` | 847 lines | 0 (deleted) | -100% |
| `registry.ts` | 646 lines | ~40 lines | -94% |
| Tool definitions | ~1500 lines | ~800 lines | -47% |
| Auth checks | 35 places | 1 place | -97% |
| Error handling | 25 places | 1 place | -96% |
| Response format | 40 places | 1 helper | -97% |

## New Dependencies

```json
{
  "zod-to-json-schema": "^3.23.0"
}
```

## Risk Mitigation

- All 157 existing tests must pass after each migration step
- No external API changes - tools behave identically
- Incremental rollout allows stopping at any point
- Each domain migration is independently testable

## Success Criteria

1. All 157 tests passing
2. All 33 tools functional
3. No regression in MCP protocol compliance
4. Reduced total LOC by ~40%
5. Single source of truth for tool definitions

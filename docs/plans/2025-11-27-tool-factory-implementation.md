# Tool Factory Refactoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactor 33 MCP tools to use a declarative Tool Factory pattern, eliminating ~60% code duplication.

**Architecture:** Define tools with `defineTool()` that auto-generates MCP JSON schemas from Zod, handles auth/errors centrally. Migrate incrementally by domain, keeping all 157 tests passing.

**Tech Stack:** TypeScript, Zod, zod-to-json-schema, @modelcontextprotocol/sdk

---

## Task 1: Add zod-to-json-schema Dependency

**Files:**
- Modify: `package.json`

**Step 1: Install dependency**

Run:
```bash
npm install zod-to-json-schema@^3.23.0
```

**Step 2: Verify installation**

Run:
```bash
npm ls zod-to-json-schema
```
Expected: Shows `zod-to-json-schema@3.x.x`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add zod-to-json-schema dependency"
```

---

## Task 2: Create Tool Factory Core

**Files:**
- Create: `src/tools/factory.ts`
- Test: `src/tools/__tests__/factory.test.ts`

**Step 1: Write the failing test**

Create `src/tools/__tests__/factory.test.ts`:

```typescript
import { z } from 'zod';
import { defineTool, textResponse } from '../factory.js';

describe('Tool Factory', () => {
  describe('textResponse', () => {
    it('creates MCP text response format', () => {
      const result = textResponse('Hello');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Hello' }],
      });
    });
  });

  describe('defineTool', () => {
    const mockClient = {
      isAuthenticated: jest.fn(),
    } as any;

    const testTool = defineTool({
      name: 'test_tool',
      category: 'Test',
      description: 'A test tool',
      requiresAuth: true,
      input: z.object({
        value: z.number().describe('A number value'),
      }),
      handler: async ({ input }) => `Received: ${input.value}`,
    });

    it('generates MCP tool definition with JSON schema', () => {
      const mcpTool = testTool.toMcpTool();

      expect(mcpTool.name).toBe('test_tool');
      expect(mcpTool.description).toBe('A test tool');
      expect(mcpTool.inputSchema).toHaveProperty('type', 'object');
      expect(mcpTool.inputSchema.properties).toHaveProperty('value');
    });

    it('creates handler that checks auth when required', async () => {
      mockClient.isAuthenticated.mockReturnValue(false);
      const handler = testTool.createHandler(mockClient);

      await expect(handler({ value: 42 })).rejects.toThrow('Authentication required');
    });

    it('creates handler that executes when authenticated', async () => {
      mockClient.isAuthenticated.mockReturnValue(true);
      const handler = testTool.createHandler(mockClient);

      const result = await handler({ value: 42 });
      expect(result.content[0].text).toBe('Received: 42');
    });

    it('creates handler that validates input with Zod', async () => {
      mockClient.isAuthenticated.mockReturnValue(true);
      const handler = testTool.createHandler(mockClient);

      const result = await handler({ value: 'not a number' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed');
    });
  });

  describe('defineTool without auth', () => {
    const mockClient = {
      isAuthenticated: jest.fn().mockReturnValue(false),
    } as any;

    const publicTool = defineTool({
      name: 'public_tool',
      category: 'Public',
      description: 'No auth needed',
      requiresAuth: false,
      input: z.object({}),
      handler: async () => 'Public response',
    });

    it('executes without auth check when requiresAuth is false', async () => {
      const handler = publicTool.createHandler(mockClient);
      const result = await handler({});

      expect(result.content[0].text).toBe('Public response');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm test -- src/tools/__tests__/factory.test.ts
```
Expected: FAIL - Cannot find module '../factory.js'

**Step 3: Write minimal implementation**

Create `src/tools/factory.ts`:

```typescript
import { z, ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AltegioClient } from '../providers/altegio-client.js';

export interface ToolContext<T> {
  input: T;
  client: AltegioClient;
}

export interface ToolDefinition<T extends ZodSchema> {
  name: string;
  category: string;
  description: string;
  requiresAuth: boolean;
  input: T;
  handler: (ctx: ToolContext<z.infer<T>>) => Promise<string>;
}

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function textResponse(text: string): McpToolResponse {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

export function errorResponse(text: string): McpToolResponse {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

export interface DefinedTool<T extends ZodSchema> {
  toMcpTool: () => {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  createHandler: (client: AltegioClient) => (args: unknown) => Promise<McpToolResponse>;
  meta: ToolDefinition<T>;
}

export function defineTool<T extends ZodSchema>(def: ToolDefinition<T>): DefinedTool<T> {
  return {
    toMcpTool: () => ({
      name: def.name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.input, {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    }),

    createHandler: (client: AltegioClient) => async (args: unknown): Promise<McpToolResponse> => {
      if (def.requiresAuth && !client.isAuthenticated()) {
        throw new Error('Authentication required. Please login first.');
      }

      try {
        const input = def.input.parse(args);
        const result = await def.handler({ input, client });
        return textResponse(result);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Authentication required')) {
          throw error;
        }
        return errorResponse(
          `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    },

    meta: def,
  };
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npm test -- src/tools/__tests__/factory.test.ts
```
Expected: PASS (all 5 tests)

**Step 5: Run all tests to verify no regression**

Run:
```bash
npm test
```
Expected: 157+ tests passing

**Step 6: Commit**

```bash
git add src/tools/factory.ts src/tools/__tests__/factory.test.ts
git commit -m "feat: add tool factory core with defineTool"
```

---

## Task 3: Create Response Formatters

**Files:**
- Create: `src/tools/formatters.ts`
- Test: `src/tools/__tests__/formatters.test.ts`

**Step 1: Write the failing test**

Create `src/tools/__tests__/formatters.test.ts`:

```typescript
import {
  formatStaffList,
  formatServicesList,
  formatBookingsList,
  formatCompaniesList,
  formatCategoriesList,
  formatPositionsList,
  formatScheduleList,
} from '../formatters.js';

describe('Formatters', () => {
  describe('formatStaffList', () => {
    it('formats empty list', () => {
      const result = formatStaffList([], 123);
      expect(result).toContain('Found 0 staff members');
    });

    it('formats staff with position', () => {
      const staff = [{
        id: 1,
        name: 'John Doe',
        specialization: 'Stylist',
        rating: 4.5,
        position: { id: 10, title: 'Senior' },
      }];
      const result = formatStaffList(staff, 123);
      expect(result).toContain('John Doe');
      expect(result).toContain('Stylist');
      expect(result).toContain('Senior');
    });
  });

  describe('formatServicesList', () => {
    it('formats services with price and duration', () => {
      const services = [{
        id: 1,
        title: 'Haircut',
        cost: 50,
        duration: 30,
        category_id: 5,
      }];
      const result = formatServicesList(services, 123);
      expect(result).toContain('Haircut');
      expect(result).toContain('50');
      expect(result).toContain('30 min');
    });
  });

  describe('formatCompaniesList', () => {
    it('formats companies list', () => {
      const companies = [{
        id: 1,
        title: 'Salon ABC',
        public_title: 'Salon ABC',
        address: '123 Main St',
        phone: '+123456789',
      }];
      const result = formatCompaniesList(companies, false);
      expect(result).toContain('Salon ABC');
      expect(result).toContain('123 Main St');
    });
  });

  describe('formatBookingsList', () => {
    it('formats bookings with client and services', () => {
      const bookings = [{
        id: 1,
        datetime: '2025-01-15 10:00:00',
        client: { name: 'Jane', phone: '+123' },
        staff: { name: 'John' },
        services: [{ title: 'Haircut' }],
        status: 'confirmed',
      }];
      const result = formatBookingsList(bookings, 123);
      expect(result).toContain('Jane');
      expect(result).toContain('Haircut');
      expect(result).toContain('confirmed');
    });
  });

  describe('formatPositionsList', () => {
    it('formats positions', () => {
      const positions = [{ id: 1, title: 'Manager' }];
      const result = formatPositionsList(positions);
      expect(result).toContain('Manager');
      expect(result).toContain('ID: 1');
    });

    it('handles empty list', () => {
      const result = formatPositionsList([]);
      expect(result).toContain('No positions found');
    });
  });

  describe('formatScheduleList', () => {
    it('formats schedule entries', () => {
      const schedule = [{
        date: '2025-01-15',
        time: '09:00',
        seance_length: 60,
        datetime: '2025-01-15 09:00:00',
      }];
      const result = formatScheduleList(schedule, 1);
      expect(result).toContain('2025-01-15');
      expect(result).toContain('09:00');
      expect(result).toContain('60 min');
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm test -- src/tools/__tests__/formatters.test.ts
```
Expected: FAIL - Cannot find module '../formatters.js'

**Step 3: Write minimal implementation**

Create `src/tools/formatters.ts`:

```typescript
import type {
  AltegioStaff,
  AltegioService,
  AltegioBooking,
  AltegioCompany,
  AltegioServiceCategory,
  AltegioPosition,
  AltegioScheduleEntry,
} from '../types/altegio.types.js';

export function formatStaffList(staff: AltegioStaff[], companyId: number): string {
  const summary = `Found ${staff.length} staff ${staff.length === 1 ? 'member' : 'members'} for company ${companyId}:\n\n`;

  if (staff.length === 0) return summary;

  const list = staff
    .map(
      (s, idx) =>
        `${idx + 1}. ID: ${s.id} - ${s.name}\n` +
        `   Specialization: ${s.specialization || 'N/A'}\n` +
        `   Rating: ${s.rating !== undefined ? s.rating : 'N/A'}` +
        (s.position?.title ? `\n   Position: ${s.position.title} (ID: ${s.position.id})` : '')
    )
    .join('\n\n');

  return summary + list;
}

export function formatServicesList(services: AltegioService[], companyId: number): string {
  const summary = `Found ${services.length} ${services.length === 1 ? 'service' : 'services'} for company ${companyId}:\n\n`;

  if (services.length === 0) return summary;

  const list = services
    .map(
      (s, idx) =>
        `${idx + 1}. ID: ${s.id} - "${s.title}"\n` +
        `   Price: ${s.cost}` +
        (s.duration ? `\n   Duration: ${s.duration} min` : '') +
        (s.category_id ? `\n   Category ID: ${s.category_id}` : '')
    )
    .join('\n\n');

  return summary + list;
}

export function formatBookingsList(bookings: AltegioBooking[], companyId: number): string {
  const summary = `Found ${bookings.length} ${bookings.length === 1 ? 'booking' : 'bookings'} for company ${companyId}:\n\n`;

  if (bookings.length === 0) return summary;

  const list = bookings
    .map(
      (b, idx) =>
        `${idx + 1}. Booking ID: ${b.id}\n` +
        `   Date: ${b.datetime || b.date}\n` +
        `   Client: ${b.client?.name || 'N/A'} (${b.client?.phone || 'no phone'})\n` +
        `   Staff: ${b.staff?.name || 'N/A'}\n` +
        `   Services: ${b.services?.map((s) => s.title).join(', ') || 'N/A'}\n` +
        `   Status: ${b.status}`
    )
    .join('\n\n');

  return summary + list;
}

export function formatCompaniesList(companies: AltegioCompany[], isUserCompanies: boolean): string {
  const summary = `Found ${companies.length} ${companies.length === 1 ? 'company' : 'companies'}${isUserCompanies ? ' (user companies)' : ''}:\n\n`;

  if (companies.length === 0) return summary;

  const list = companies
    .map(
      (c, idx) =>
        `${idx + 1}. ID: ${c.id} - "${c.title || c.public_title}"\n` +
        `   Address: ${c.address || 'N/A'}\n` +
        `   Phone: ${c.phone || 'N/A'}`
    )
    .join('\n\n');

  return summary + list;
}

export function formatCategoriesList(categories: AltegioServiceCategory[], companyId: number): string {
  const summary = `Found ${categories.length} service ${categories.length === 1 ? 'category' : 'categories'} for company ${companyId}:\n\n`;

  if (categories.length === 0) return summary;

  const list = categories
    .map(
      (c, idx) =>
        `${idx + 1}. ID: ${c.id} - "${c.title}"` +
        (c.services ? `\n   Services count: ${c.services.length}` : '')
    )
    .join('\n\n');

  return summary + list;
}

export function formatPositionsList(positions: AltegioPosition[]): string {
  if (!positions || positions.length === 0) {
    return 'No positions found for this company.';
  }

  const list = positions
    .map((p, idx) => `${idx + 1}. ${p.title} (ID: ${p.id})`)
    .join('\n');

  return `Found ${positions.length} position(s):\n\n${list}`;
}

export function formatScheduleList(schedule: AltegioScheduleEntry[], staffId: number): string {
  const summary = `Found ${schedule.length} schedule ${schedule.length === 1 ? 'entry' : 'entries'} for staff ${staffId}:\n\n`;

  if (schedule.length === 0) return summary;

  const list = schedule
    .map((s, idx) => `${idx + 1}. ${s.date} at ${s.time} (${s.seance_length} min)`)
    .join('\n');

  return summary + list;
}
```

**Step 4: Run test to verify it passes**

Run:
```bash
npm test -- src/tools/__tests__/formatters.test.ts
```
Expected: PASS (all tests)

**Step 5: Run all tests**

Run:
```bash
npm test
```
Expected: All tests passing

**Step 6: Commit**

```bash
git add src/tools/formatters.ts src/tools/__tests__/formatters.test.ts
git commit -m "feat: add response formatters for all entity types"
```

---

## Task 4: Create Auth Tools

**Files:**
- Create: `src/tools/definitions/auth.tools.ts`
- Test: `src/tools/__tests__/definitions/auth.tools.test.ts`

**Step 1: Write the failing test**

Create directory and test file:

```bash
mkdir -p src/tools/__tests__/definitions
```

Create `src/tools/__tests__/definitions/auth.tools.test.ts`:

```typescript
import { loginTool, logoutTool } from '../../definitions/auth.tools.js';

describe('Auth Tools', () => {
  describe('loginTool', () => {
    it('has correct metadata', () => {
      expect(loginTool.meta.name).toBe('altegio_login');
      expect(loginTool.meta.requiresAuth).toBe(false);
    });

    it('generates valid MCP schema', () => {
      const mcp = loginTool.toMcpTool();
      expect(mcp.inputSchema.properties).toHaveProperty('email');
      expect(mcp.inputSchema.properties).toHaveProperty('password');
      expect(mcp.inputSchema.required).toContain('email');
      expect(mcp.inputSchema.required).toContain('password');
    });

    it('handles successful login', async () => {
      const mockClient = {
        isAuthenticated: () => false,
        login: jest.fn().mockResolvedValue({ success: true, user_token: 'token123' }),
      } as any;

      const handler = loginTool.createHandler(mockClient);
      const result = await handler({ email: 'test@test.com', password: 'pass' });

      expect(result.content[0].text).toContain('Successfully logged in');
      expect(mockClient.login).toHaveBeenCalledWith('test@test.com', 'pass');
    });

    it('handles failed login', async () => {
      const mockClient = {
        isAuthenticated: () => false,
        login: jest.fn().mockResolvedValue({ success: false, error: 'Invalid credentials' }),
      } as any;

      const handler = loginTool.createHandler(mockClient);
      const result = await handler({ email: 'test@test.com', password: 'wrong' });

      expect(result.content[0].text).toContain('Login failed');
      expect(result.content[0].text).toContain('Invalid credentials');
    });
  });

  describe('logoutTool', () => {
    it('has correct metadata', () => {
      expect(logoutTool.meta.name).toBe('altegio_logout');
      expect(logoutTool.meta.requiresAuth).toBe(false);
    });

    it('calls client logout', async () => {
      const mockClient = {
        isAuthenticated: () => true,
        logout: jest.fn().mockResolvedValue({ success: true }),
      } as any;

      const handler = logoutTool.createHandler(mockClient);
      const result = await handler({});

      expect(result.content[0].text).toContain('Successfully logged out');
      expect(mockClient.logout).toHaveBeenCalled();
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm test -- src/tools/__tests__/definitions/auth.tools.test.ts
```
Expected: FAIL - Cannot find module

**Step 3: Write minimal implementation**

```bash
mkdir -p src/tools/definitions
```

Create `src/tools/definitions/auth.tools.ts`:

```typescript
import { z } from 'zod';
import { defineTool } from '../factory.js';

export const loginTool = defineTool({
  name: 'altegio_login',
  category: 'Auth',
  description:
    '[Auth] Login to Altegio with email and password. REQUIRED for administrative operations.',
  requiresAuth: false,

  input: z.object({
    email: z.string().email().describe('User email address'),
    password: z.string().min(1).describe('User password'),
  }),

  handler: async ({ input, client }) => {
    const result = await client.login(input.email, input.password);

    if (result.success) {
      return 'Successfully logged in to Altegio';
    }
    return `Login failed: ${result.error}`;
  },
});

export const logoutTool = defineTool({
  name: 'altegio_logout',
  category: 'Auth',
  description: '[Auth] Logout from Altegio and clear stored credentials.',
  requiresAuth: false,

  input: z.object({}),

  handler: async ({ client }) => {
    await client.logout();
    return 'Successfully logged out from Altegio';
  },
});
```

**Step 4: Run test to verify it passes**

Run:
```bash
npm test -- src/tools/__tests__/definitions/auth.tools.test.ts
```
Expected: PASS

**Step 5: Run all tests**

Run:
```bash
npm test
```
Expected: All passing

**Step 6: Commit**

```bash
git add src/tools/definitions/auth.tools.ts src/tools/__tests__/definitions/
git commit -m "feat: migrate auth tools to factory pattern"
```

---

## Task 5: Create Staff Tools

**Files:**
- Create: `src/tools/definitions/staff.tools.ts`
- Test: `src/tools/__tests__/definitions/staff.tools.test.ts`

**Step 1: Write the failing test**

Create `src/tools/__tests__/definitions/staff.tools.test.ts`:

```typescript
import {
  getStaffTool,
  createStaffTool,
  updateStaffTool,
  deleteStaffTool,
} from '../../definitions/staff.tools.js';

describe('Staff Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getStaff: jest.fn(),
    createStaff: jest.fn(),
    updateStaff: jest.fn(),
    deleteStaff: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(true);
  });

  describe('getStaffTool', () => {
    it('requires auth', () => {
      expect(getStaffTool.meta.requiresAuth).toBe(true);
    });

    it('fetches and formats staff list', async () => {
      mockClient.getStaff.mockResolvedValue([
        { id: 1, name: 'John', specialization: 'Stylist' },
      ]);

      const handler = getStaffTool.createHandler(mockClient);
      const result = await handler({ company_id: 123 });

      expect(result.content[0].text).toContain('John');
      expect(mockClient.getStaff).toHaveBeenCalledWith(123, {});
    });
  });

  describe('createStaffTool', () => {
    it('creates staff member', async () => {
      mockClient.createStaff.mockResolvedValue({
        id: 99,
        name: 'New Staff',
        specialization: 'Barber',
      });

      const handler = createStaffTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        name: 'New Staff',
        specialization: 'Barber',
        position_id: null,
        phone_number: null,
        user_email: 'staff@test.com',
        user_phone: '+123',
        is_user_invite: false,
      });

      expect(result.content[0].text).toContain('Successfully created');
      expect(result.content[0].text).toContain('99');
    });
  });

  describe('updateStaffTool', () => {
    it('updates staff member', async () => {
      mockClient.updateStaff.mockResolvedValue({
        id: 1,
        name: 'Updated Name',
        specialization: 'Senior Stylist',
      });

      const handler = updateStaffTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        staff_id: 1,
        name: 'Updated Name',
      });

      expect(result.content[0].text).toContain('Successfully updated');
    });
  });

  describe('deleteStaffTool', () => {
    it('deletes staff member', async () => {
      mockClient.deleteStaff.mockResolvedValue(undefined);

      const handler = deleteStaffTool.createHandler(mockClient);
      const result = await handler({ company_id: 123, staff_id: 1 });

      expect(result.content[0].text).toContain('Successfully deleted');
      expect(mockClient.deleteStaff).toHaveBeenCalledWith(123, 1);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run:
```bash
npm test -- src/tools/__tests__/definitions/staff.tools.test.ts
```
Expected: FAIL

**Step 3: Write minimal implementation**

Create `src/tools/definitions/staff.tools.ts`:

```typescript
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatStaffList } from '../formatters.js';

export const getStaffTool = defineTool({
  name: 'get_staff',
  category: 'Staff',
  description:
    '[Staff] Get list of staff members for a company. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    page: z.number().int().positive().optional().describe('Page number'),
    count: z.number().int().positive().optional().describe('Results per page'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...params } = input;
    const staff = await client.getStaff(
      company_id,
      Object.keys(params).length > 0 ? params : undefined
    );
    return formatStaffList(staff, company_id);
  },
});

export const createStaffTool = defineTool({
  name: 'create_staff',
  category: 'Staff',
  description: '[Staff] Create a new employee/staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    name: z.string().min(1).describe('Employee name'),
    specialization: z.string().min(1).describe('Employee specialization'),
    position_id: z.number().int().positive().nullable().describe('Position ID'),
    phone_number: z.string().nullable().describe('Phone number'),
    user_email: z.string().email().describe('User email'),
    user_phone: z.string().min(1).describe('User phone'),
    is_user_invite: z.boolean().describe('Send user invite'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...staffData } = input;
    const staff = await client.createStaff(company_id, staffData);
    return `Successfully created staff member:\nID: ${staff.id}\nName: ${staff.name}\nSpecialization: ${staff.specialization}`;
  },
});

export const updateStaffTool = defineTool({
  name: 'update_staff',
  category: 'Staff',
  description: '[Staff] Update existing staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    name: z.string().min(1).optional().describe('Employee name'),
    specialization: z.string().optional().describe('Specialization'),
    position_id: z.number().int().positive().nullable().optional().describe('Position ID'),
    phone_number: z.string().nullable().optional().describe('Phone number'),
    hidden: z.number().int().min(0).max(1).optional().describe('Hidden flag'),
    fired: z.number().int().min(0).max(1).optional().describe('Fired flag'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, staff_id, ...updateData } = input;
    const staff = await client.updateStaff(company_id, staff_id, updateData);
    return `Successfully updated staff member ${staff_id}:\nName: ${staff.name}\nSpecialization: ${staff.specialization}`;
  },
});

export const deleteStaffTool = defineTool({
  name: 'delete_staff',
  category: 'Staff',
  description: '[Staff] Delete/remove staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
  }),

  handler: async ({ input, client }) => {
    await client.deleteStaff(input.company_id, input.staff_id);
    return `Successfully deleted staff member ${input.staff_id} from company ${input.company_id}`;
  },
});
```

**Step 4: Run test to verify it passes**

Run:
```bash
npm test -- src/tools/__tests__/definitions/staff.tools.test.ts
```
Expected: PASS

**Step 5: Run all tests**

Run:
```bash
npm test
```
Expected: All passing

**Step 6: Commit**

```bash
git add src/tools/definitions/staff.tools.ts src/tools/__tests__/definitions/staff.tools.test.ts
git commit -m "feat: migrate staff tools to factory pattern"
```

---

## Task 6-11: Migrate Remaining Domain Tools

Follow the same pattern as Task 5 for:

- **Task 6:** `positions.tools.ts` (4 tools: get, create, update, delete)
- **Task 7:** `services.tools.ts` (3 tools: get, create, update)
- **Task 8:** `categories.tools.ts` (1 tool: get)
- **Task 9:** `schedule.tools.ts` (4 tools: get, create, update, delete)
- **Task 10:** `bookings.tools.ts` (4 tools: get, create, update, delete)
- **Task 11:** `company.tools.ts` (1 tool: list_companies)

Each task follows the same structure:
1. Write failing tests
2. Run to verify failure
3. Implement tool definitions
4. Run tests to verify pass
5. Run all tests
6. Commit

---

## Task 12: Create Tools Index

**Files:**
- Create: `src/tools/definitions/index.ts`

**Step 1: Create index file**

Create `src/tools/definitions/index.ts`:

```typescript
export * from './auth.tools.js';
export * from './staff.tools.js';
export * from './positions.tools.js';
export * from './services.tools.js';
export * from './categories.tools.js';
export * from './schedule.tools.js';
export * from './bookings.tools.js';
export * from './company.tools.js';
```

**Step 2: Verify exports**

Run:
```bash
npx tsc --noEmit
```
Expected: No errors

**Step 3: Commit**

```bash
git add src/tools/definitions/index.ts
git commit -m "feat: add tools index for auto-discovery"
```

---

## Task 13: Migrate Onboarding Tools

**Files:**
- Create: `src/tools/definitions/onboarding.tools.ts`
- Update: `src/tools/definitions/index.ts`

Follow same pattern - migrate all 10 onboarding tools.

---

## Task 14: Replace Registry with Auto-Discovery

**Files:**
- Modify: `src/tools/registry.ts`
- Delete: `src/tools/handlers.ts` (after migration complete)

**Step 1: Update registry.ts**

Replace `src/tools/registry.ts` with:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../providers/altegio-client.js';
import * as allTools from './definitions/index.js';
import type { DefinedTool } from './factory.js';
import type { ZodSchema } from 'zod';

export function registerTools(server: Server, client: AltegioClient): string[] {
  // Collect all exported tools
  const tools = Object.values(allTools).filter(
    (t): t is DefinedTool<ZodSchema> =>
      t && typeof t === 'object' && 'toMcpTool' in t && 'createHandler' in t
  );

  // Build handlers map
  const handlers = new Map(
    tools.map((t) => [t.meta.name, t.createHandler(client)])
  );

  // Register list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.toMcpTool()),
  }));

  // Register call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers.get(name);

    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return handler(args);
  });

  return tools.map((t) => t.meta.name);
}
```

**Step 2: Run all tests**

Run:
```bash
npm test
```
Expected: All 157+ tests passing

**Step 3: Run integration test**

Run:
```bash
npm run build && npm start
```
Verify MCP server starts and lists tools correctly.

**Step 4: Delete old handlers.ts**

```bash
rm src/tools/handlers.ts
```

**Step 5: Update any remaining imports**

Search for and update any files still importing from handlers.ts.

**Step 6: Final test run**

Run:
```bash
npm test && npm run build && npm run typecheck
```
Expected: All passing

**Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace registry with auto-discovery, delete old handlers"
```

---

## Task 15: Final Cleanup and PR

**Step 1: Run full verification**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```
Expected: All passing

**Step 2: Push and create PR**

```bash
git push origin refactor/tool-factory
gh pr create --title "refactor: tool factory pattern" --body "$(cat <<'EOF'
## Summary
- Refactored 33 MCP tools to use declarative Tool Factory pattern
- Eliminated ~60% code duplication
- Single source of truth for tool definitions (Zod → JSON Schema)
- Auth check centralized (35 places → 1)
- Error handling centralized (25 places → 1)

## Test plan
- [ ] All 157+ tests passing
- [ ] Manual test: `npm start` and verify tool listing
- [ ] Manual test: login/logout flow
- [ ] Manual test: CRUD operations
EOF
)"
```

---

**Plan complete and saved to `docs/plans/2025-11-27-tool-factory-implementation.md`.**

**Two execution options:**

1. **Subagent-Driven (this session)** - I dispatch fresh subagent per task, review between tasks, fast iteration

2. **Parallel Session (separate)** - Open new session with executing-plans, batch execution with checkpoints

Which approach?

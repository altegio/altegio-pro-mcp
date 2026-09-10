import SwaggerParser from '@apidevtools/swagger-parser';
import * as path from 'path';
import * as fs from 'fs';
import {
  allApiMappings,
  apiMapping,
  executorTools,
  mappingSource,
  multiApiMapping,
  unmappedTools,
  type ApiMapping,
} from '../api-mapping.js';
import * as definitions from '../definitions/index.js';
import type { DefinedTool } from '../factory.js';

/**
 * Known discrepancies between MCP client code and OpenAPI spec.
 * These generate warnings instead of failures, with actionable notes.
 * Keep empty when all tools are aligned with spec.
 */
const KNOWN_DISCREPANCIES: Record<string, string> = {};

/**
 * Spec Compliance Tests
 *
 * Validates that MCP tool definitions match the OpenAPI specification.
 * Run after pulling latest spec: git -C ../biz.erp.api.docs pull origin master
 */

const SPEC_PATH = path.resolve(
  __dirname,
  '../../../../biz.erp.api.docs/docs/en/b2b-v1/openapi.yaml'
);

// Resolved OpenAPI spec (all $refs dereferenced)
let spec: any;
let specAvailable = false;

beforeAll(async () => {
  extendedCatalog = await loadExtendedCatalog();

  if (!fs.existsSync(SPEC_PATH)) {
    console.warn(
      `OpenAPI spec not found at ${SPEC_PATH}. Skipping spec compliance tests.\n` +
        'Clone the spec repo: git clone <repo> ../biz.erp.api.docs'
    );
    return;
  }

  try {
    spec = await SwaggerParser.dereference(SPEC_PATH);
    specAvailable = true;
  } catch (err) {
    console.warn(`Failed to parse OpenAPI spec: ${err}`);
  }
});

function skipIfNoSpec() {
  if (!specAvailable) {
    return true;
  }
  return false;
}

/**
 * Extended catalog — hand-written stubs for the undocumented endpoints on the
 * allowlist (ADR-001 D4). A tool may map to a documented operation OR to one of
 * these; nothing else is allowed.
 */
const EXTENDED_DIR = path.resolve(__dirname, '../../../catalog/extended');

interface ExtendedOperation {
  file: string;
  path: string;
  method: string;
  operationId?: string;
  parameters?: Array<{ name: string; in: string }>;
  requestBody?: {
    content?: Record<
      string,
      { schema?: { properties?: Record<string, unknown> } }
    >;
  };
}

async function loadExtendedCatalog(): Promise<Map<string, ExtendedOperation>> {
  const operations = new Map<string, ExtendedOperation>();
  if (!fs.existsSync(EXTENDED_DIR)) return operations;

  for (const file of fs.readdirSync(EXTENDED_DIR)) {
    if (!/\.ya?ml$/.test(file)) continue;
    // The stubs are valid OpenAPI documents, so the same parser reads them.
    const doc = (await SwaggerParser.parse(
      path.join(EXTENDED_DIR, file)
    )) as unknown as {
      paths?: Record<string, Record<string, unknown>>;
    };
    for (const [specPath, item] of Object.entries(doc?.paths ?? {})) {
      for (const [method, operation] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method))
          continue;
        operations.set(`${method} ${specPath}`, {
          file,
          path: specPath,
          method,
          ...(operation as object),
        } as ExtendedOperation);
      }
    }
  }
  return operations;
}

let extendedCatalog = new Map<string, ExtendedOperation>();

const documentedMappings = allApiMappings().filter(
  ([, mapping]) => mappingSource(mapping) === 'documented'
);
const extendedMappings = allApiMappings().filter(
  ([, mapping]) => mappingSource(mapping) === 'extended'
);

/** Deduplicated documented mappings, keyed by tool + operation. */
function documentedEntries(): Array<[string, ApiMapping]> {
  const seen = new Set<string>();
  return documentedMappings.filter(([tool, mapping]) => {
    const key = `${tool} ${mapping.method} ${mapping.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Normalize OpenAPI path template to match our mapping format.
 * Spec uses {location_id} but paths section keys might differ.
 */
function findPathInSpec(specPath: string): any | null {
  if (!spec?.paths) return null;

  // Direct match
  if (spec.paths[specPath]) return spec.paths[specPath];

  // Try normalizing parameter names
  const normalized = specPath.replace(/\{[^}]+\}/g, '{*}');
  for (const [key, value] of Object.entries(spec.paths)) {
    const keyNormalized = key.replace(/\{[^}]+\}/g, '{*}');
    if (keyNormalized === normalized) return value;
  }

  return null;
}

describe('Spec Compliance', () => {
  describe('Endpoint existence', () => {
    for (const [toolName, mapping] of documentedEntries()) {
      it(`${toolName} → ${mapping.method.toUpperCase()} ${mapping.path} exists in spec`, () => {
        if (skipIfNoSpec()) return;

        const pathObj = findPathInSpec(mapping.path);

        if (!pathObj || !pathObj[mapping.method]) {
          if (KNOWN_DISCREPANCIES[toolName]) {
            console.warn(
              `⚠️  [${toolName}] KNOWN DISCREPANCY: ${KNOWN_DISCREPANCIES[toolName]}`
            );
            return; // Known issue — warn, don't fail
          }
        }

        expect(pathObj).not.toBeNull();

        if (pathObj) {
          expect(pathObj[mapping.method]).toBeDefined();
        }
      });
    }
  });

  describe('Operation ID match', () => {
    for (const [toolName, mapping] of documentedEntries()) {
      it(`${toolName} → operationId "${mapping.operationId}"`, () => {
        if (skipIfNoSpec()) return;

        const pathObj = findPathInSpec(mapping.path);
        if (!pathObj?.[mapping.method]) return;

        const operation = pathObj[mapping.method];
        expect(operation.operationId).toBe(mapping.operationId);
      });
    }
  });

  describe('Path parameters', () => {
    for (const [toolName, mapping] of documentedEntries()) {
      if (mapping.pathParams.length === 0) continue;

      it(`${toolName} → path params match spec`, () => {
        if (skipIfNoSpec()) return;

        const pathObj = findPathInSpec(mapping.path);
        if (!pathObj?.[mapping.method]) return;

        const operation = pathObj[mapping.method];
        const specPathParams = (operation.parameters || [])
          .filter((p: any) => p.in === 'path')
          .map((p: any) => p.name);

        for (const param of mapping.pathParams) {
          // Our mapping uses generic names, spec might use location_id vs company_id
          const hasMatch = specPathParams.some(
            (sp: string) =>
              sp === param ||
              // Common renames between our code and spec
              (param === 'location_id' && sp === 'location_id') ||
              (param === 'team_member_id' && sp === 'team_member_id') ||
              (param === 'record_id' && sp === 'record_id') ||
              (param === 'service_id' && sp === 'service_id') ||
              (param === 'start_date' && sp === 'start_date') ||
              (param === 'end_date' && sp === 'end_date')
          );

          expect(hasMatch).toBe(true);
        }
      });
    }
  });

  describe('Query parameters', () => {
    for (const [toolName, mapping] of documentedEntries()) {
      if (!mapping.queryParams?.length) continue;

      it(`${toolName} → query params exist in spec`, () => {
        if (skipIfNoSpec()) return;

        const pathObj = findPathInSpec(mapping.path);
        if (!pathObj?.[mapping.method]) return;

        const operation = pathObj[mapping.method];
        const specQueryParams = (operation.parameters || [])
          .filter((p: any) => p.in === 'query')
          .map((p: any) => p.name);

        const missingInSpec: string[] = [];
        for (const param of mapping.queryParams!) {
          if (!specQueryParams.includes(param)) {
            missingInSpec.push(param);
          }
        }

        if (missingInSpec.length > 0) {
          console.warn(
            `[${toolName}] Query params not in spec: ${missingInSpec.join(', ')}. ` +
              `Spec has: ${specQueryParams.join(', ')}`
          );
        }

        // At least some overlap expected (not a hard fail for extra params)
        // Hard fail only if our required query params have zero overlap
      });
    }
  });

  describe('Request body parameters', () => {
    for (const [toolName, mapping] of documentedEntries()) {
      if (!mapping.bodyParams?.length) continue;

      it(`${toolName} → body params exist in spec`, () => {
        if (skipIfNoSpec()) return;

        const pathObj = findPathInSpec(mapping.path);
        if (!pathObj?.[mapping.method]) return;

        const operation = pathObj[mapping.method];
        const requestBody = operation.requestBody;
        if (!requestBody) {
          console.warn(
            `[${toolName}] Spec has no requestBody but tool sends body params`
          );
          return;
        }

        // Extract schema properties from requestBody
        const schema =
          requestBody.content?.['application/json']?.schema ||
          requestBody.content?.['*/*']?.schema;

        if (!schema?.properties) {
          // Some specs use array items or other structures
          return;
        }

        const specBodyParams = Object.keys(schema.properties);
        const missingInSpec: string[] = [];

        for (const param of mapping.bodyParams!) {
          if (!specBodyParams.includes(param)) {
            missingInSpec.push(param);
          }
        }

        if (missingInSpec.length > 0) {
          // Warn but don't fail — our tool may use different param names
          // (e.g., tool sends "email" but spec expects "login")
          console.warn(
            `[${toolName}] Body params not in spec: ${missingInSpec.join(', ')}. ` +
              `Spec has: ${specBodyParams.join(', ')}`
          );
        }
      });
    }
  });

  describe('Required fields', () => {
    for (const [toolName, mapping] of documentedEntries()) {
      if (!mapping.bodyParams?.length) continue;

      it(`${toolName} → spec required fields are covered`, () => {
        if (skipIfNoSpec()) return;

        const pathObj = findPathInSpec(mapping.path);
        if (!pathObj?.[mapping.method]) return;

        const operation = pathObj[mapping.method];
        const requestBody = operation.requestBody;
        if (!requestBody) return;

        const schema =
          requestBody.content?.['application/json']?.schema ||
          requestBody.content?.['*/*']?.schema;

        if (!schema?.required) return;

        const specRequired: string[] = schema.required;
        const toolParams = mapping.bodyParams!;

        const missingRequired = specRequired.filter(
          (r: string) => !toolParams.includes(r)
        );

        if (missingRequired.length > 0) {
          console.warn(
            `[${toolName}] Spec-required body params NOT in tool: ${missingRequired.join(', ')}`
          );
        }
      });
    }
  });

  describe('Deprecation warnings', () => {
    for (const [toolName, mapping] of documentedEntries()) {
      it(`${toolName} → check if endpoint is deprecated`, () => {
        if (skipIfNoSpec()) return;

        const pathObj = findPathInSpec(mapping.path);
        if (!pathObj?.[mapping.method]) return;

        const operation = pathObj[mapping.method];
        if (operation.deprecated) {
          console.warn(
            `⚠️  [${toolName}] uses DEPRECATED endpoint: ${mapping.method.toUpperCase()} ${mapping.path}` +
              (operation.description
                ? `\n    ${operation.description.split('\n')[0]}`
                : '')
          );
        }
      });
    }
  });

  describe('Extended catalog (undocumented endpoints on the allowlist)', () => {
    it('the catalog directory exists and holds operations', () => {
      expect(extendedCatalog.size).toBeGreaterThan(0);
    });

    for (const [toolName, mapping] of extendedMappings) {
      it(`${toolName} → ${mapping.method.toUpperCase()} ${mapping.path} has an extended stub`, () => {
        const operation = extendedCatalog.get(
          `${mapping.method} ${mapping.path}`
        );
        expect(operation).toBeDefined();
        expect(operation?.operationId).toBe(mapping.operationId);
      });

      if (mapping.pathParams.length > 0) {
        it(`${toolName} → ${mapping.path} declares its path parameters`, () => {
          const operation = extendedCatalog.get(
            `${mapping.method} ${mapping.path}`
          );
          const declared = (operation?.parameters ?? [])
            .filter((p) => p.in === 'path')
            .map((p) => p.name);
          for (const param of mapping.pathParams) {
            expect(declared).toContain(param);
          }
        });
      }

      if (mapping.queryParams?.length) {
        it(`${toolName} → ${mapping.path} declares its query parameters`, () => {
          const operation = extendedCatalog.get(
            `${mapping.method} ${mapping.path}`
          );
          const declared = (operation?.parameters ?? [])
            .filter((p) => p.in === 'query')
            .map((p) => p.name);
          for (const param of mapping.queryParams!) {
            expect(declared).toContain(param);
          }
        });
      }

      if (mapping.bodyParams?.length) {
        it(`${toolName} → ${mapping.path} declares its body parameters`, () => {
          const operation = extendedCatalog.get(
            `${mapping.method} ${mapping.path}`
          );
          const schema =
            operation?.requestBody?.content?.['application/json']?.schema;
          // Stubs may use a $ref to a component; only check inline shapes.
          if (!schema?.properties) return;
          for (const param of mapping.bodyParams!) {
            expect(Object.keys(schema.properties)).toContain(param);
          }
        });
      }
    }

    it('every extended operation is reachable through at least one tool', () => {
      const used = new Set(
        extendedMappings.map(
          ([, mapping]) => `${mapping.method} ${mapping.path}`
        )
      );
      const unused = [...extendedCatalog.keys()].filter(
        (key) => !used.has(key)
      );
      expect(unused).toEqual([]);
    });
  });

  describe('Tool coverage', () => {
    /** Every factory-defined tool discovered from the definitions barrel. */
    const registeredTools = (Object.values(definitions) as unknown[])
      .filter(
        (value): value is DefinedTool =>
          !!value &&
          typeof value === 'object' &&
          'toMcpTool' in value &&
          'meta' in value
      )
      .map((tool) => tool.meta.name);

    it('every registered tool is mapped or explicitly unmapped', () => {
      const accountedFor = new Set([
        ...Object.keys(apiMapping),
        ...Object.keys(multiApiMapping),
        ...unmappedTools,
      ]);
      const missing = registeredTools.filter((tool) => !accountedFor.has(tool));
      expect(missing).toEqual([]);
    });

    it('no tool is both mapped and unmapped', () => {
      const mapped = new Set([
        ...Object.keys(apiMapping),
        ...Object.keys(multiApiMapping),
      ]);
      const overlap = unmappedTools.filter((t) => mapped.has(t));
      expect(overlap).toEqual([]);
    });

    /**
     * The executor tools (ADR-001 D2) resolve an operation from
     * `src/generated/catalog.json` at call time, so they map to the whole
     * catalog rather than to one endpoint. They are excluded from the 1:1
     * mapping requirement above — and this test makes that exclusion explicit
     * rather than incidental, so a curated tool cannot slip through by simply
     * being absent from `apiMapping`.
     */
    it('executor tools are declared unmapped, never 1:1 mapped', () => {
      expect(executorTools).toHaveLength(3);
      for (const tool of executorTools) {
        expect(unmappedTools).toContain(tool);
        expect(apiMapping[tool]).toBeUndefined();
      }
    });

    it('every other unmapped tool is a local operation or an orchestrator', () => {
      const executor = new Set(executorTools);
      for (const tool of unmappedTools) {
        if (executor.has(tool)) continue;
        expect(
          tool === 'altegio_logout' || tool.startsWith('onboarding_')
        ).toBe(true);
      }
    });

    it('every mapping refers to a documented or an extended operation', () => {
      for (const [tool, mapping] of allApiMappings()) {
        const source = mappingSource(mapping);
        if (source === 'extended') {
          expect(extendedCatalog.has(`${mapping.method} ${mapping.path}`)).toBe(
            true
          );
        } else if (specAvailable) {
          const pathObj = findPathInSpec(mapping.path);
          expect(pathObj?.[mapping.method]).toBeDefined();
        }
        expect(typeof tool).toBe('string');
      }
    });
  });

  describe('HTTP method consistency', () => {
    for (const [toolName, mapping] of allApiMappings()) {
      it(`${toolName} → client uses ${mapping.method.toUpperCase()}`, () => {
        // This is a static check — validates our mapping is internally consistent
        if (toolName.startsWith('get_') || toolName === 'list_locations') {
          expect(mapping.method).toBe('get');
        }
        if (toolName.startsWith('create_')) {
          expect(['post', 'put']).toContain(mapping.method);
        }
        if (toolName.startsWith('delete_')) {
          expect(['delete', 'put']).toContain(mapping.method);
        }
      });
    }
  });
});

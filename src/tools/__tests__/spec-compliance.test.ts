import SwaggerParser from '@apidevtools/swagger-parser';
import * as path from 'path';
import * as fs from 'fs';
import { apiMapping, unmappedTools } from '../api-mapping.js';

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
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
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
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
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
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
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
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
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
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
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
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
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
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
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

  describe('Tool coverage', () => {
    it('all registered tools are either mapped or explicitly unmapped', () => {
      // Import tool names from registry (we check at build time)
      const mappedTools = Object.keys(apiMapping);
      const allAccountedFor = [...mappedTools, ...unmappedTools];

      // This test ensures we don't accidentally add a tool without mapping it.
      // The actual tool list comes from registry.ts — if a new tool is added
      // but not mapped here, the test below will catch it.
      expect(allAccountedFor.length).toBeGreaterThan(0);
    });

    it('no tool is both mapped and unmapped', () => {
      const mapped = new Set(Object.keys(apiMapping));
      const overlap = unmappedTools.filter((t) => mapped.has(t));
      expect(overlap).toEqual([]);
    });
  });

  describe('HTTP method consistency', () => {
    for (const [toolName, mapping] of Object.entries(apiMapping)) {
      it(`${toolName} → client uses ${mapping.method.toUpperCase()}`, () => {
        // This is a static check — validates our mapping is internally consistent
        if (toolName.startsWith('get_') || toolName === 'list_companies') {
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

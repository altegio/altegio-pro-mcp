import { describe, it, expect } from '@jest/globals';
import {
  DISABLED_TOOL_NAMES,
  isDisabledOperationPath,
  isToolDisabled,
} from '../disabled-tools.js';
import { orderedToolEntries } from '../registry.js';
import { allOperations, getOperation } from '../executor/catalog.js';
import {
  ANALYTICS_PROMPTS,
  getAnalyticsPrompt,
} from '../../prompts/analytics.prompts.js';
import {
  listAnalyticsResources,
  listAnalyticsResourceTemplates,
  readAnalyticsResource,
} from '../../resources/analytics.resources.js';

/**
 * The report builder is off (see ../disabled-tools.ts). These are the invariants
 * that keep it off: no tool, no catalog route, and no guidance naming it.
 */
describe('disabled report builder', () => {
  it('serves none of the disabled tools on any view', () => {
    const served = orderedToolEntries().map((entry) => entry.spec.name);
    for (const name of DISABLED_TOOL_NAMES) {
      expect(isToolDisabled(name)).toBe(true);
      expect(served).not.toContain(name);
    }
  });

  it('hides the report-builder routes from the universal executor', () => {
    for (const path of [
      '/company/{location_id}/ac/{report_id}',
      '/locations/{location_id}/ac/{report_id}',
      '/locations/{location_id}/ac',
      '/locations/{location_id}/analytics_constructor/reports',
    ]) {
      expect(isDisabledOperationPath(path)).toBe(true);
    }
    expect(
      isDisabledOperationPath('/locations/{location_id}/analytics/overall')
    ).toBe(false);
    expect(isDisabledOperationPath('/locations/{location_id}/access')).toBe(
      false
    );
    for (const op of allOperations()) {
      expect(op.path).not.toContain('analytics_constructor');
    }
    expect(getOperation('run_report_builder_report')).toBeUndefined();
    expect(getOperation('list_report_builder_templates')).toBeUndefined();
  });

  it('never names a disabled tool in a prompt or an analytics resource', async () => {
    const texts: string[] = [];
    for (const prompt of ANALYTICS_PROMPTS) {
      const rendered = getAnalyticsPrompt(prompt.name, { location_id: '1' })!;
      texts.push(rendered.description, rendered.messages[0]!.content.text);
    }
    // No templated resources are advertised while the builder is off.
    expect(listAnalyticsResourceTemplates()).toEqual([]);
    for (const entry of listAnalyticsResources()) {
      texts.push(entry.description);
      const read = await readAnalyticsResource(entry.uri);
      if (read) texts.push(read.contents[0]!.text);
    }

    for (const text of texts) {
      for (const name of DISABLED_TOOL_NAMES) {
        expect(text).not.toContain(name);
      }
    }
  });

  it('never sends a caller to a report template or report-builder dataset', async () => {
    // A served text that says "run the X report template" or names a builder
    // dataset sends the model after a tool it cannot call; guidance must name a
    // served curated tool instead.
    const texts: string[] = orderedToolEntries().map(
      (entry) => entry.spec.description ?? ''
    );
    for (const prompt of ANALYTICS_PROMPTS) {
      const rendered = getAnalyticsPrompt(prompt.name, { location_id: '1' })!;
      texts.push(rendered.description, rendered.messages[0]!.content.text);
    }
    for (const entry of listAnalyticsResources()) {
      const read = await readAnalyticsResource(entry.uri);
      if (read) texts.push(read.contents[0]!.text);
    }
    for (const text of texts) {
      expect(text).not.toMatch(
        /report template|from the report table|Report builder datasets/i
      );
      expect(text).not.toMatch(/"(?:financial_transactions|sales)" dataset/);
    }
  });
});

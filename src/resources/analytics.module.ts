/**
 * Analytics pack resources, adapted to the shared resource registry.
 *
 * `analytics.resources.ts` owns the content (glossary, coverage, report fields,
 * report CSVs); this module only maps its list/read functions onto the
 * `ResourceModule` contract so the pack plugs into `src/resources/index.ts`
 * with one array entry.
 */
import type { ResourceContent, ResourceModule } from './registry.js';
import {
  listAnalyticsResources,
  listAnalyticsResourceTemplates,
  readAnalyticsResource,
} from './analytics.resources.js';

async function readText(uri: string): Promise<ResourceContent | null> {
  const result = await readAnalyticsResource(uri);
  const first = result?.contents[0];
  if (!first) return null;
  return { uri: first.uri, mimeType: first.mimeType, text: first.text };
}

export const analyticsResources: ResourceModule = {
  resources: listAnalyticsResources().map((entry) => ({
    uri: entry.uri,
    name: entry.name,
    title: entry.title,
    description: entry.description,
    mimeType: entry.mimeType,
    read: async () => (await readText(entry.uri))?.text ?? '',
  })),
  templates: listAnalyticsResourceTemplates(),
  resolve: readText,
};

/**
 * Every resource module the server serves.
 *
 * A pack plugs in with two lines: import its module here and add it to the
 * array. Nothing else changes — the handlers, the ordering and the capability
 * declaration are shared. For example, once the analytics pack lands:
 *
 * ```ts
 * import { analyticsResources } from './analytics.resources.js';
 * export const resourceModules: ResourceModule[] = [docsResources, analyticsResources];
 * ```
 */
import { docsResources } from './docs.resources.js';
export { analyticsResources } from './analytics.module.js';
import { analyticsResources } from './analytics.module.js';
export {
  clientsResources,
  CLIENTS_SEGMENTATION_URI,
} from './clients.resources.js';
import { clientsResources } from './clients.resources.js';
import type { ResourceModule } from './registry.js';

export const resourceModules: readonly ResourceModule[] = [
  docsResources,
  analyticsResources,
  clientsResources,
];

export {
  collectResources,
  collectResourceTemplates,
  readResource,
  registerResources,
} from './registry.js';
export type {
  ResourceContent,
  ResourceEntry,
  ResourceModule,
  ResourceTemplateEntry,
} from './registry.js';
export {
  docsResources,
  GLOSSARY_URI,
  ONBOARDING_GUIDE_URI,
  PRODUCT_LOGIC_URI,
} from './docs.resources.js';

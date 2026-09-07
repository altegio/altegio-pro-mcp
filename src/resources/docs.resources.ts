/**
 * Documentation resources: the product model, the canonical vocabulary and the
 * onboarding guide, addressed under `altegio://docs/`.
 *
 * These answer the questions a session asks before it calls anything — what a
 * location, an appointment or a membership is in this product, and what to call
 * them — without spending tool calls on it.
 */
import { readRepoDoc } from './doc-loader.js';
import { GLOSSARY_MARKDOWN } from './glossary.js';
import type { ResourceModule } from './registry.js';

export const PRODUCT_LOGIC_URI = 'altegio://docs/product-logic';
export const GLOSSARY_URI = 'altegio://docs/glossary';
export const ONBOARDING_GUIDE_URI = 'altegio://docs/onboarding-guide';

const PRODUCT_LOGIC_FILE = 'Altegio API and Product Logic Documentation.md';
const ONBOARDING_GUIDE_FILE = 'ONBOARDING_GUIDE.md';

export const docsResources: ResourceModule = {
  resources: [
    {
      uri: PRODUCT_LOGIC_URI,
      name: 'product-logic',
      title: 'Altegio product model and business logic',
      description:
        'How the product is put together: chains and locations, team members and clients, the service catalog, the scheduling and booking model, the visit and payment lifecycle, loyalty, finance and inventory. Read this before designing a multi-step workflow.',
      mimeType: 'text/markdown',
      read: () => readRepoDoc(PRODUCT_LOGIC_FILE),
    },
    {
      uri: GLOSSARY_URI,
      name: 'glossary',
      title: 'Canonical vocabulary',
      description:
        'The approved term for every concept this server exposes — location, team member, professional, receptionist, appointment, visit, membership, client account, digital schedule, analytics — and the synonyms never to use. Use it to word replies and report titles.',
      mimeType: 'text/markdown',
      read: () => GLOSSARY_MARKDOWN,
    },
    {
      uri: ONBOARDING_GUIDE_URI,
      name: 'onboarding-guide',
      title: 'Onboarding walkthrough guide',
      description:
        'Setting up a location from nothing with the onboarding tools: the order of the phases, the CSV and JSON shapes each import accepts, resuming after an error, and rolling a phase back.',
      mimeType: 'text/markdown',
      read: () => readRepoDoc(ONBOARDING_GUIDE_FILE),
    },
  ],
};

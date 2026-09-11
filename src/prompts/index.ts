/**
 * Every prompt module the server serves.
 *
 * A pack plugs in with two lines: import its module here and add it to the
 * array. The onboarding and analytics workflow packs are registered below.
 */
import { onboardingPrompts } from './onboarding.prompts.js';
export { analyticsPrompts } from './analytics.module.js';
import { analyticsPrompts } from './analytics.module.js';
import type { PromptModule } from './registry.js';

export const promptModules: readonly PromptModule[] = [
  onboardingPrompts,
  analyticsPrompts,
];

export {
  collectPrompts,
  getPrompt,
  registerPrompts,
  userText,
} from './registry.js';
export type {
  PromptArgumentSpec,
  PromptBuildResult,
  PromptEntry,
  PromptModule,
} from './registry.js';
export {
  onboardingPrompts,
  ONBOARDING_WALKTHROUGH_PROMPT,
} from './onboarding.prompts.js';

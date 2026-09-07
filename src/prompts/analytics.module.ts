/**
 * Analytics pack prompts, adapted to the shared prompt registry.
 *
 * `analytics.prompts.ts` owns the prompt texts; this module maps them onto the
 * `PromptModule` contract so the pack plugs into `src/prompts/index.ts` with
 * one array entry.
 */
import type { PromptEntry, PromptModule } from './registry.js';
import {
  getAnalyticsPrompt,
  listAnalyticsPrompts,
} from './analytics.prompts.js';

export const analyticsPrompts: PromptModule = {
  prompts: listAnalyticsPrompts().map((entry): PromptEntry => ({
    name: entry.name,
    title: entry.title,
    description: entry.description,
    arguments: entry.arguments.map((argument) => ({
      name: argument.name,
      description: argument.description,
      required: argument.required,
    })),
    build: (args) => {
      const result = getAnalyticsPrompt(entry.name, { ...args });
      if (!result) {
        throw new Error(`Unknown prompt: ${entry.name}`);
      }
      return { description: result.description, messages: result.messages };
    },
  })),
};

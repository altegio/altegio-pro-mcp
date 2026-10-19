import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '../../utils/logger.js';
import { currentCallCorrelation } from '../../utils/tool-call-observation.js';
import { getOperation } from '../executor/catalog.js';
import { defineTool } from '../factory.js';
import { feedbackReceiptOutput } from '../output-schemas.js';

/** Bounds on each free-text field, in characters after trimming. */
export const FEEDBACK_TEXT_LIMITS = {
  summary: 200,
  goal: 1000,
  observed: 1000,
  expected: 1000,
  error_text: 2000,
} as const;

type FeedbackTextField = keyof typeof FEEDBACK_TEXT_LIMITS;

const text = (field: FeedbackTextField) =>
  z.string().trim().min(1).max(FEEDBACK_TEXT_LIMITS[field]);

/** Control characters other than tab and newline. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * What a report must not carry, masked before it is written. The description
 * asks the agent for ids instead of personal data; this is the backstop for
 * what slips through, not the control. Secrets come first, since a token may
 * contain an email-like or digit-run fragment. Phones are matched only in
 * shapes an id or a date does not take: a leading `+`, a bracketed area code,
 * or a run of 11–15 digits (Altegio ids are at most 10 digits).
 */
const MASKS: readonly (readonly [RegExp, string])[] = [
  [/\b(Bearer|User)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [secret]'],
  [
    /\b(user_token|partner_token|access_token|token|password)(["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    '$1$2[secret]',
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/\+\d(?:[\s().-]{0,2}\d){9,14}/g, '[phone]'],
  [
    /(?<!\d)\d?\s?\(\d{3,5}\)\s?\d{2,4}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
    '[phone]',
  ],
  [/(?<![\d.])\d{11,15}(?![\d.])/g, '[phone]'],
];

/**
 * One free-text field as the log may carry it: control characters removed,
 * blank-line runs collapsed, contact details and secrets masked, and cut to
 * the field's bound again in case a mask lengthened it.
 */
export function maskFeedbackText(
  value: string,
  limit: number
): { text: string; masked: number } {
  let masked = 0;
  let result = value
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARACTERS, ' ')
    .replace(/\n{3,}/g, '\n\n');
  for (const [pattern, replacement] of MASKS) {
    result = result.replace(pattern, (...match) => {
      masked += 1;
      return replacement.replace(/\$(\d)/g, (_, group: string) =>
        String(match[Number(group)] ?? '')
      );
    });
  }
  return { text: result.trim().slice(0, limit), masked };
}

const feedbackLog = createLogger('agent-feedback');

export const submitFeedbackTool = defineTool({
  name: 'feedback_submit',
  category: 'Feedback',
  description:
    'Report a problem with this server or the Altegio API to the team that runs this server (on the hosted Altegio endpoint, the Altegio team). ' +
    'kind "bug": a tool or operation failed, contradicted its description, or returned wrong or inconsistent data. ' +
    'kind "feature_request": the user\'s task needs a capability no tool and no documented operation offers (check api_search_operations first). ' +
    'One report per distinct problem; it changes nothing in the location and returns a report id. ' +
    "Not for the user's own complaints about their business, clients or the Altegio product (point them to Altegio support), for arguments you can correct yourself, or for access the user can grant. " +
    'Never include personal data of clients or team members — no names, phones, emails or comment text; refer to records by id. Contact details and tokens that slip through are masked. ' +
    'Tell the user in one line that you sent a report.',
  annotations: {
    title: 'Report a Bug or Missing Capability',
    // It writes one line to this server's own log and nothing to the
    // location, so every view serves it, the read-only one included.
    readOnlyHint: true,
    openWorldHint: false,
  },
  input: z.object({
    kind: z
      .enum(['bug', 'feature_request'])
      .describe(
        'bug: something failed or answered wrongly; feature_request: a capability the task needs is missing.'
      ),
    summary: text('summary').describe(
      'One line naming the problem, e.g. "appointments_list ignores team_member_id".'
    ),
    goal: text('goal').describe(
      'What the user asked for and what you were trying to do when it happened.'
    ),
    tool: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional()
      .describe(
        'The tool involved; for a feature request, the tool you expected to exist.'
      ),
    operation_id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)
      .optional()
      .describe('The catalog operation_id involved, if any.'),
    location_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('The location where it happened, so a bug can be reproduced.'),
    observed: text('observed')
      .optional()
      .describe('What happened: the result or behaviour you saw.'),
    expected: text('expected')
      .optional()
      .describe('What should have happened, or the capability you needed.'),
    error_text: text('error_text')
      .optional()
      .describe('The error message as returned, without personal data.'),
    impact: z
      .enum(['blocked', 'workaround', 'minor'])
      .optional()
      .describe(
        'blocked: the task could not be done; workaround: done another way; minor: cosmetic or slower.'
      ),
  }),
  outputSchema: feedbackReceiptOutput,
  handler: async ({ input }) => {
    const reportId = `fb_${randomBytes(6).toString('hex')}`;
    let maskedValues = 0;
    const freeText: Partial<Record<FeedbackTextField, string>> = {};
    for (const field of Object.keys(
      FEEDBACK_TEXT_LIMITS
    ) as FeedbackTextField[]) {
      const value = input[field];
      if (value === undefined) continue;
      const { text: clean, masked } = maskFeedbackText(
        value,
        FEEDBACK_TEXT_LIMITS[field]
      );
      maskedValues += masked;
      freeText[field] = clean;
    }

    // The one event in this server that carries free text: the agent wrote it
    // for us, bounded and masked above. Its correlation fields are the ones
    // the same call's `tool_call` line carries.
    feedbackLog.info(
      {
        event: 'agent_feedback',
        ...currentCallCorrelation(),
        report_id: reportId,
        kind: input.kind,
        ...(input.impact ? { impact: input.impact } : {}),
        ...(input.tool ? { reported_tool: input.tool } : {}),
        ...(input.operation_id
          ? {
              reported_operation_id: input.operation_id,
              reported_operation_documented:
                getOperation(input.operation_id) !== undefined,
            }
          : {}),
        ...(input.location_id ? { location_id: input.location_id } : {}),
        ...freeText,
        masked_values: maskedValues,
      },
      'Agent feedback'
    );

    const kindLabel = input.kind === 'bug' ? 'bug report' : 'feature request';
    return {
      text: [
        `Recorded ${kindLabel} ${reportId} for the team that runs this server; nothing in the location changed.`,
        ...(maskedValues > 0
          ? [
              `${maskedValues} value(s) that looked like contact details or secrets were masked.`,
            ]
          : []),
        "Continue the user's task, or tell them what is missing.",
      ].join(' '),
      structuredContent: {
        status: 'recorded',
        report_id: reportId,
        kind: input.kind,
        masked_values: maskedValues,
      },
    };
  },
});

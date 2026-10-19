import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { requestPrincipalKey } from '../../request-context.js';
import { createLogger, logSafeToken } from '../../utils/logger.js';
import {
  currentCallCorrelation,
  noteRateLimited,
} from '../../utils/tool-call-observation.js';
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

/**
 * The sentence a failed call ends with when it looks like a defect (see
 * `invitesFeedback` in `../registry.ts`): the one moment an agent has both
 * the reason and the details to report, at no standing cost in context.
 */
export const FEEDBACK_NUDGE =
  'If this looks like a defect of the server or the API, report it with feedback_submit; no need to ask the user.';

/** The same, for an operation search that matched nothing at all. */
export const MISSING_OPERATION_NUDGE =
  'If broader words find nothing either and the task needs it, report it with feedback_submit (feature_request); no need to ask the user.';

/**
 * Reports one caller may file per window. A caller is the signed-in principal,
 * else the MCP session: some hosts open a session per call, so a session
 * alone would not bound a looping agent. Process-local, like the sessions.
 */
export const FEEDBACK_RATE_LIMIT = { reports: 5, windowMs: 10 * 60_000 };
/** Callers tracked at once; the least recently reporting is forgotten first. */
const MAX_TRACKED_CALLERS = 10_000;
const recentReports = new Map<string, number[]>();

/** Count one report for `caller`, or refuse it when the window is full. */
function admitReport(caller: string, now: number): boolean {
  const since = now - FEEDBACK_RATE_LIMIT.windowMs;
  const times = (recentReports.get(caller) ?? []).filter((t) => t > since);
  const admitted = times.length < FEEDBACK_RATE_LIMIT.reports;
  if (admitted) times.push(now);
  recentReports.delete(caller);
  recentReports.set(caller, times);
  if (recentReports.size > MAX_TRACKED_CALLERS) {
    const oldest = recentReports.keys().next().value;
    if (oldest !== undefined) recentReports.delete(oldest);
  }
  return admitted;
}

/** Forget every caller's recent reports. */
export function clearFeedbackRateLimit(): void {
  recentReports.clear();
}

export const submitFeedbackTool = defineTool({
  name: 'feedback_submit',
  category: 'Feedback',
  description:
    'Report a bug or a missing capability of this server or the Altegio API to the team that runs it. ' +
    'bug: a tool or operation failed or answered wrongly; feature_request: no tool or documented operation does what the task needs. ' +
    "One report per problem; refer to records by id, never personal data (names, phones, emails, comments). Not for the user's own complaints. " +
    'Do not ask the user first; mention the report in one line.',
  annotations: {
    title: 'Report a Bug or Missing Capability',
    // It writes one line to this server's own log and nothing to the
    // location, so every view serves it, the read-only one included.
    readOnlyHint: true,
    openWorldHint: false,
  },
  input: z.object({
    kind: z.enum(['bug', 'feature_request']),
    summary: text('summary').describe(
      'One line, e.g. "appointments_list ignores team_member_id".'
    ),
    goal: text('goal').describe('What the user wanted and what you tried.'),
    tool: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional()
      .describe('The tool involved, or the one you expected to exist.'),
    operation_id: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/)
      .optional(),
    location_id: z.number().int().positive().optional(),
    observed: text('observed').optional(),
    expected: text('expected').optional(),
    error_text: text('error_text').optional(),
    impact: z
      .enum(['blocked', 'workaround', 'minor'])
      .optional()
      .describe('blocked: task not done; workaround: done another way.'),
    model: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('The model you run as, if you know it.'),
  }),
  outputSchema: feedbackReceiptOutput,
  handler: async ({ input }) => {
    const correlation = currentCallCorrelation();
    const principal = requestPrincipalKey();
    const caller =
      principal ??
      (typeof correlation.session === 'string' ? correlation.session : 'local');
    if (!admitReport(caller, Date.now())) {
      noteRateLimited();
      return {
        isError: true,
        text: `Report not recorded: this caller already sent ${FEEDBACK_RATE_LIMIT.reports} reports in the last ${FEEDBACK_RATE_LIMIT.windowMs / 60_000} minutes. Continue the user's task; report again later only for a new problem.`,
      };
    }
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
        ...correlation,
        ...(principal ? { principal } : {}),
        report_id: reportId,
        kind: input.kind,
        ...(input.model ? { model: logSafeToken(input.model) } : {}),
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

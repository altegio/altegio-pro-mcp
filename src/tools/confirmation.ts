/**
 * Human confirmation for destructive tools.
 *
 * `destructiveHint` is a hint, not a boundary: MCP forbids clients from relying
 * on tool annotations for security decisions, and on an autonomous agent with
 * no human in the loop an annotation protects nothing at all. The protocol's
 * own answer is elicitation — the server asks the operator itself, regardless
 * of how the host is configured.
 *
 * A tool opts in by declaring `confirm` on its definition (see
 * `./factory.ts`). Enforcement happens in exactly one place, the `tools/call`
 * handler in `./registry.ts`, which is the only code path with both the MCP
 * `Server` (to send `elicitation/create`) and the per-request id needed to
 * route the prompt back to the right HTTP session.
 *
 * Two paths, chosen from the capabilities the client declared at `initialize`:
 *
 * - **Host supports elicitation** — the server sends the consequence text as an
 *   `elicitation/create` form and performs the operation only on an explicit
 *   accept. A decline, a cancel, or a broken elicitation stops the call.
 * - **Host does not** — the first call performs nothing and returns the
 *   consequence text plus a one-time `confirmation_token`; the caller must
 *   repeat the call with that token to proceed. Without this fallback the call
 *   would simply hang on an older host. That answer is a successful result
 *   with `structuredContent.status = "confirmation_required"`, not an error:
 *   nothing failed, the call is waiting for a person, and hosts that treat an
 *   error as "retry differently" looped on it.
 *
 * The token is an HMAC over the tool name and the parsed arguments, keyed by a
 * secret minted per process, so it cannot be guessed, cannot be replayed
 * against a different target (confirming the deletion of client 5 never
 * authorises deleting client 7), and expires. It binds the input after Zod has
 * read it, with absent and `null` optionals removed (`canonicalInput`), so the
 * repeat may differ cosmetically — `"4564"` for `4564`, `null` for an omitted
 * field — and still match. Nothing is stored server-side: `tools/list` stays
 * static and no state is scoped to a session (ADR-001 D7).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AltegioClient } from '../providers/altegio-client.js';
import { sanitizeUntrusted, type ToolResult } from './tool-result.js';
import { canonicalInput } from './input-normalization.js';

/** The argument every confirmable tool accepts, on every host (ADR-001 D7). */
export const CONFIRMATION_TOKEN_ARG = 'confirmation_token';

/** JSON Schema fragment injected into every confirmable tool's `inputSchema`. */
export const CONFIRMATION_TOKEN_SCHEMA = {
  type: 'string',
  description:
    'Omit at first; then from this tool’s confirmation_required answer, once the user agreed.',
} as const;

const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Per-process key. Restarting the server invalidates every outstanding token. */
const TOKEN_SECRET = randomBytes(32);

// ========== declaration ==========

/**
 * How one tool describes what the operator is about to approve.
 *
 * `target` must name the concrete object from the arguments alone so the gate
 * never depends on a network read; `resolve` is the optional API lookup that
 * upgrades `123` to `Ivan Petrov (Stylist), id 123`.
 */
export interface ConfirmationSpec<TInput> {
  /** Imperative action title, e.g. `Delete team member`. */
  readonly action: string;
  /** Names the target from the arguments alone. Never reads the API. */
  readonly target: (input: TInput) => string;
  /**
   * Optional API read that replaces `target` with a human-readable name.
   * Resolving a label must never decide whether the gate runs, so a rejection
   * or an `undefined` result silently keeps the argument-derived `target`.
   */
  readonly resolve?: (
    input: TInput,
    client: AltegioClient
  ) => Promise<string | undefined>;
  /** What the operation destroys and what survives it. */
  readonly consequence: string | ((input: TInput) => string);
  /**
   * Optional API read that spells out exactly what changes — the lines a
   * document holds, the before/after of a list the call replaces — under the
   * consequence. It is read back from the API, so every line is cleaned
   * like a resolved label. A failure leaves it out, with one exception: a
   * `ConfirmationRefusal` says the call would be refused anyway, and the gate
   * then answers that refusal instead of asking a person to approve it.
   */
  readonly detail?: (
    input: TInput,
    client: AltegioClient
  ) => Promise<string | undefined>;
}

/**
 * Thrown by `ConfirmationSpec.detail` when the call cannot succeed (a
 * duplicate, an unknown id, an impossible change), so nobody is asked to
 * approve it. Nothing is performed either way; the message is the refusal.
 */
export class ConfirmationRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmationRefusal';
  }
}

/** A `ConfirmationSpec` bound to one set of arguments, with the generic erased. */
export interface PreparedConfirmation {
  readonly action: string;
  readonly target: string;
  readonly consequence: string;
  readonly resolve?: (client: AltegioClient) => Promise<string | undefined>;
  readonly detail?: (client: AltegioClient) => Promise<string | undefined>;
  /**
   * What the token binds: the parsed input in canonical form. Absent only for
   * a hand-built preparation, which then binds the raw arguments.
   */
  readonly binding?: unknown;
}

/**
 * Bind a spec to raw tool arguments, erasing the input generic so specs for
 * different tools can share one registry. `parse` returns `undefined` for
 * arguments the tool would reject anyway; the gate then steps aside and lets
 * the handler produce its usual validation error, because invalid arguments
 * cannot destroy anything.
 */
export function prepareConfirmation<TInput>(
  spec: ConfirmationSpec<TInput>,
  parse: (args: unknown) => TInput | undefined
): (args: unknown) => PreparedConfirmation | undefined {
  return (args: unknown) => {
    const input = parse(args);
    if (input === undefined) return undefined;
    return {
      binding: canonicalInput(input),
      action: spec.action,
      target: spec.target(input),
      consequence:
        typeof spec.consequence === 'function'
          ? spec.consequence(input)
          : spec.consequence,
      ...(spec.resolve
        ? { resolve: (client: AltegioClient) => spec.resolve!(input, client) }
        : {}),
      ...(spec.detail
        ? { detail: (client: AltegioClient) => spec.detail!(input, client) }
        : {}),
    };
  };
}

// ========== token ==========

/**
 * Stable serialisation of the call the token authorises: the tool name plus
 * every argument except the token itself, with object keys sorted so that an
 * equivalent second call produces an identical string.
 */
function canonicalCall(toolName: string, args: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== CONFIRMATION_TOKEN_ARG)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, stable(entry)])
      );
    }
    return value;
  };
  return `${toolName}\n${JSON.stringify(stable(args ?? {}))}`;
}

function sign(expiresAt: number, toolName: string, args: unknown): string {
  return createHmac('sha256', TOKEN_SECRET)
    .update(`${expiresAt}\n${canonicalCall(toolName, args)}`)
    .digest('base64url');
}

/** Mint a token that authorises exactly this tool with exactly these arguments. */
export function mintConfirmationToken(
  toolName: string,
  args: unknown,
  now: number = Date.now()
): string {
  const expiresAt = now + TOKEN_TTL_MS;
  return `${expiresAt}.${sign(expiresAt, toolName, args)}`;
}

/** True only for an unexpired token this process minted for this exact call. */
export function verifyConfirmationToken(
  token: unknown,
  toolName: string,
  args: unknown,
  now: number = Date.now()
): boolean {
  if (typeof token !== 'string') return false;
  const separator = token.indexOf('.');
  if (separator <= 0) return false;

  const expiresAt = Number(token.slice(0, separator));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;

  const provided = Buffer.from(token.slice(separator + 1), 'utf8');
  const expected = Buffer.from(sign(expiresAt, toolName, args), 'utf8');
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

// ========== the gate ==========

/** What the host answered, normalised across transports. */
export type ConfirmationAnswer = 'accept' | 'decline' | 'cancel';

/**
 * The transport half of the gate, supplied per call by the registry because
 * `relatedRequestId` differs for every request.
 */
export interface ConfirmationRuntime {
  /** Did the client declare form elicitation at `initialize`? */
  readonly supportsElicitation: () => boolean;
  /** Ask the operator. Rejecting is treated as a failure to confirm. */
  readonly elicit: (message: string) => Promise<ConfirmationAnswer>;
}

/**
 * A refusal — declined, dismissed, undeliverable prompt, invalid token — is an
 * `isError` result: the tool did not do what it was asked to do and there is
 * no token to continue with, so a model has no room to read "cancelled" as
 * "deleted". A confirmation request is not a refusal (see `requireConfirmation`).
 */
function refusal(message: string): ToolResult {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

/** `Delete team member — Ivan Petrov, id 123, at location 4564.` */
function subjectLine(prepared: PreparedConfirmation, target: string): string {
  return `${prepared.action} — ${target}.`;
}

/**
 * Run the gate for one call.
 *
 * Returns `undefined` when the operation may proceed, or the `ToolResult` to
 * return to the caller instead of performing it.
 */
export async function requireConfirmation(options: {
  readonly toolName: string;
  readonly args: unknown;
  readonly prepared: PreparedConfirmation;
  readonly client: AltegioClient;
  readonly runtime: ConfirmationRuntime;
}): Promise<ToolResult | undefined> {
  const { toolName, args, prepared, client, runtime } = options;

  const supplied =
    args && typeof args === 'object'
      ? (args as Record<string, unknown>)[CONFIRMATION_TOKEN_ARG]
      : undefined;

  // What the token binds: the canonical parsed input, or the raw arguments
  // for a preparation that did not supply one.
  const bound = 'binding' in prepared ? prepared.binding : args;

  // Already confirmed, for these arguments, within the last 10 minutes.
  if (verifyConfirmationToken(supplied, toolName, bound)) return undefined;

  // A token that does not verify is never silently ignored: it is a stale,
  // altered or reused one, and proceeding would defeat the argument binding.
  if (supplied !== undefined) {
    return refusal(
      `Nothing was changed: the ${CONFIRMATION_TOKEN_ARG} for ${toolName} is not valid for these arguments. A token is bound to the call it was issued for (same target and options) and expires after 10 minutes. Repeat the call without a token to get a new one.`
    );
  }

  const target = await resolveTarget(prepared, client);
  const headline = subjectLine(prepared, target);
  let detail: string | undefined;
  try {
    detail = await resolveDetail(prepared, client);
  } catch (error) {
    if (!(error instanceof ConfirmationRefusal)) throw error;
    return refusal(`Nothing was changed: ${error.message}`);
  }
  const consequence = detail
    ? `${prepared.consequence}\n\n${detail}`
    : prepared.consequence;

  if (runtime.supportsElicitation()) {
    let answer: ConfirmationAnswer;
    try {
      answer = await runtime.elicit(`${headline}\n\n${consequence}`);
    } catch (error) {
      // The host advertised elicitation and then failed to deliver it. Fail
      // closed: minting a token here would let the caller route around the
      // one check that actually reaches a human.
      const reason = error instanceof Error ? error.message : String(error);
      return refusal(
        `Nothing was changed: ${toolName} could not obtain confirmation from the host (${reason}). ${headline}`
      );
    }

    if (answer === 'accept') return undefined;
    return refusal(
      answer === 'decline'
        ? `Confirmation declined — nothing was changed. ${headline}`
        : `Confirmation dismissed by the host — nothing was changed. ${headline} Ask the user to confirm before retrying.`
    );
  }

  // No elicitation on this host: hand back the consequences and a token, and
  // perform nothing until the caller repeats the call with it. This is a
  // successful answer, not a failure: the call is waiting for a person.
  const now = Date.now();
  const token = mintConfirmationToken(toolName, bound, now);
  const expiresAt = new Date(now + TOKEN_TTL_MS).toISOString();
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Confirmation required — nothing was changed.`,
          ``,
          headline,
          consequence,
          ``,
          `Show this to the person you act for. Only if they agree, call ${toolName} again with the same arguments plus ${CONFIRMATION_TOKEN_ARG}="${token}" (valid until ${expiresAt}, for this call only). Do not retry without asking.`,
        ].join('\n'),
      },
    ],
    structuredContent: {
      status: 'confirmation_required',
      changed: false,
      tool: toolName,
      summary: `${headline} ${consequence}`,
      [CONFIRMATION_TOKEN_ARG]: token,
      expires_at: expiresAt,
      next_step: `Ask the user. Only if they agree, call ${toolName} again with the same arguments plus ${CONFIRMATION_TOKEN_ARG}.`,
    },
  };
}

/** Lines of a detail block: cleaned one by one, capped in count and width. */
const DETAIL_MAX_LINES = 40;
const DETAIL_LINE_MAX_CHARS = 240;

/**
 * The optional detail under the consequence. Like a resolved label it is read
 * back from the API and holds names other people typed, so each line is
 * cleaned in place (`sanitizeUntrusted`) and the block is capped. Only a
 * `ConfirmationRefusal` escapes; any other failure leaves the detail out,
 * because a lookup failure must not decide whether the operator is asked.
 */
async function resolveDetail(
  prepared: PreparedConfirmation,
  client: AltegioClient
): Promise<string | undefined> {
  if (!prepared.detail) return undefined;
  let raw: string | undefined;
  try {
    raw = await prepared.detail(client);
  } catch (error) {
    if (error instanceof ConfirmationRefusal) throw error;
    return undefined;
  }
  if (!raw) return undefined;
  const lines = raw
    .split('\n')
    .map((line) => sanitizeUntrusted(line, { maxChars: DETAIL_LINE_MAX_CHARS }))
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return undefined;
  const kept = lines.slice(0, DETAIL_MAX_LINES);
  if (lines.length > kept.length) {
    kept.push(`… and ${lines.length - kept.length} more line(s).`);
  }
  return kept.join('\n');
}

async function resolveTarget(
  prepared: PreparedConfirmation,
  client: AltegioClient
): Promise<string> {
  if (!prepared.resolve) return prepared.target;
  try {
    const resolved = await prepared.resolve(client);
    // `target` is built from the arguments alone, but a resolved label is a
    // name read back from the API — a client, a team member, a booking form,
    // named by someone outside this server. It cannot go in a fenced block:
    // the point of the headline is that it reads as one sentence, to a person.
    // So it is cleaned in place instead, which is the whole job of
    // `sanitizeUntrusted`: crude turn markup and invisible characters out, one
    // line, capped. The gate itself never depends on this value.
    const safe = sanitizeUntrusted(resolved, { maxChars: 200 });
    return safe ?? prepared.target;
  } catch {
    // A lookup failure must not decide whether the operator is asked.
    return prepared.target;
  }
}

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
 *   would simply hang on an older host.
 *
 * The token is an HMAC over the tool name and the exact arguments, keyed by a
 * secret minted per process, so it cannot be guessed, cannot be replayed
 * against a different target (confirming the deletion of client 5 never
 * authorises deleting client 7), and expires. Nothing is stored server-side:
 * `tools/list` stays static and no state is scoped to a session (ADR-001 D7).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AltegioClient } from '../providers/altegio-client.js';
import { sanitizeUntrusted, type ToolResult } from './tool-result.js';

/** The argument every confirmable tool accepts, on every host (ADR-001 D7). */
export const CONFIRMATION_TOKEN_ARG = 'confirmation_token';

/** JSON Schema fragment injected into every confirmable tool's `inputSchema`. */
export const CONFIRMATION_TOKEN_SCHEMA = {
  type: 'string',
  description:
    'Confirmation token for this destructive operation. Omit it on the first call. If the host cannot show a confirmation prompt, the first call performs nothing and returns a token together with the consequences; repeat the identical call with that token to proceed. The token is bound to these exact arguments and expires in 10 minutes.',
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
}

/** A `ConfirmationSpec` bound to one set of arguments, with the generic erased. */
export interface PreparedConfirmation {
  readonly action: string;
  readonly target: string;
  readonly consequence: string;
  readonly resolve?: (client: AltegioClient) => Promise<string | undefined>;
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
      action: spec.action,
      target: spec.target(input),
      consequence:
        typeof spec.consequence === 'function'
          ? spec.consequence(input)
          : spec.consequence,
      ...(spec.resolve
        ? { resolve: (client: AltegioClient) => spec.resolve!(input, client) }
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
  readonly elicit: (
    message: string,
    title: string
  ) => Promise<ConfirmationAnswer>;
}

/**
 * Every outcome of the gate is an `isError` result, because in every one of
 * them the tool did not do what it was asked to do. It is the same channel the
 * executor uses to refuse a write (`ExecutorRefusalError`), it leaves a model
 * no room to read "cancelled" as "deleted", and it keeps the result legal for
 * a tool that declares an `outputSchema`: a client rejects a non-error result
 * that carries no `structuredContent`.
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

  // Already confirmed, for these exact arguments, within the last 10 minutes.
  if (verifyConfirmationToken(supplied, toolName, args)) return undefined;

  // A token that does not verify is never silently ignored: it is a stale,
  // altered or reused one, and proceeding would defeat the argument binding.
  if (supplied !== undefined) {
    return refusal(
      `Nothing was changed: the ${CONFIRMATION_TOKEN_ARG} for ${toolName} is not valid for these arguments. A token is bound to the exact call it was issued for and expires after 10 minutes. Repeat the call without a token.`
    );
  }

  const target = await resolveTarget(prepared, client);
  const headline = subjectLine(prepared, target);

  if (runtime.supportsElicitation()) {
    let answer: ConfirmationAnswer;
    try {
      answer = await runtime.elicit(
        `${headline}\n\n${prepared.consequence}`,
        prepared.action
      );
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
      `Cancelled by the operator — nothing was changed. ${headline}`
    );
  }

  // No elicitation on this host: hand back the consequences and a token, and
  // perform nothing until the caller repeats the call with it.
  const token = mintConfirmationToken(toolName, args);
  return refusal(
    [
      `Confirmation required — nothing was changed yet.`,
      ``,
      headline,
      prepared.consequence,
      ``,
      `This host cannot show a confirmation prompt, so confirmation is explicit: show the line above to the person you are acting for, and only if they agree, call ${toolName} again with the identical arguments plus ${CONFIRMATION_TOKEN_ARG}="${token}". The token authorises only this exact call and expires in 10 minutes.`,
    ].join('\n')
  );
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

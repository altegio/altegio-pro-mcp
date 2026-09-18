/**
 * The one definition of the "contacts are opt-in" rule.
 *
 * **The rule:** a client's phone and email are personal data. No tool returns
 * them — in the text summary or in the structured content — unless the call
 * explicitly passed `include_contacts: true`, and a tool that withheld them
 * says so once, so the model stops guessing. Segmenting, counting, ranking and
 * scheduling never need a contact; asking to call someone does.
 *
 * It is the default projection of the "read clients without contacts" access
 * level in the v3 authorization RFC, and — like the untrusted-text fence in
 * `./tool-result.ts` — a default, not a boundary: the same token can read the
 * contact through another operation. What it buys is that the common path does
 * not spill hundreds of phone numbers into a model's context by accident.
 *
 * Everything the rule needs lives here — the argument, its description, and the
 * notice — because it was written three times before and the copies were
 * already drifting apart.
 */
import { z } from 'zod';

/** Description of the `include_contacts` argument, identical on every tool. */
export const CONTACTS_OPT_IN_DESCRIPTION =
  'Return the client’s contact details (phone, and email where the tool has one). ' +
  'Off by default: contacts are personal data and most questions do not need them, ' +
  'and one call can cover hundreds of clients. Turn it on only when the user ' +
  'explicitly asked to see or use a contact.';

/**
 * The `include_contacts` argument itself. Shared so a new pack opts into the
 * rule by importing it rather than by re-describing it.
 */
export const includeContactsArg = z
  .boolean()
  .optional()
  .describe(CONTACTS_OPT_IN_DESCRIPTION);

/** The single line a result carries when it withheld contacts. */
export const CONTACTS_WITHHELD_NOTICE =
  'Contacts withheld by default. Pass include_contacts: true when the user asked to contact someone.';

/**
 * The rule as prose, for documentation resources. Kept next to the code it
 * describes so a change to one is a change to the other.
 */
export const CONTACTS_OPT_IN_RULE =
  'Phone and email are withheld from every client result by default — in the text ' +
  'summary and in the structured content alike. Pass `include_contacts: true` only ' +
  'when the user explicitly asked to see or use a contact.';

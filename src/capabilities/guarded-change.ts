/**
 * A guarded read-modify-write behind a confirmation.
 *
 * Some writes replace a whole record — the consumables of a service on an
 * appointment, every field of a financial transaction, a whole appointment for
 * a product sold on its visit — so the change is worked out on a fresh read
 * and sent back in full. Three steps keep it from overwriting a change nobody
 * saw:
 *
 * 1. plan: read the record, work out the change and take a `version` of what
 *    was read (`stateVersion`);
 * 2. describe (`planForConfirmation`): the confirmation shows the plan and
 *    binds its version; a plan that refuses becomes a `ConfirmationRefusal`,
 *    so nobody is asked to approve a change that cannot run;
 * 3. run (`planConfirmed`): the confirmed call plans again on a fresh read and
 *    is refused when the version moved after the confirmation was shown.
 *
 * The visit-product save adds a step in its adapter: the replace route reads
 * the appointment again just before it writes, refuses on a moved version and
 * reads back what was saved.
 */
import {
  ConfirmationRefusal,
  type ConfirmedCall,
} from '../tools/confirmation.js';

/** A planned change and the version of the state it was planned on. */
export interface GuardedPlan {
  readonly version: string;
}

/** The "Nothing was changed: " a refusal starts with; the gate says it once. */
const NOTHING_WAS = /^Nothing was [a-z]+: /;

/**
 * Plan the change the confirmation shows. A refusal of the plan (an error of
 * `refusal`) is raised as a `ConfirmationRefusal`; any other error propagates.
 */
export async function planForConfirmation<P extends GuardedPlan>(
  plan: () => Promise<P>,
  refusal: abstract new (...args: never[]) => Error
): Promise<P> {
  try {
    return await plan();
  } catch (error) {
    if (error instanceof refusal) {
      throw new ConfirmationRefusal(error.message.replace(NOTHING_WAS, ''));
    }
    throw error;
  }
}

/**
 * Plan the change a confirmed call makes, refused with `moved(plan)` when the
 * state no longer has the version the confirmation showed. A call confirmed
 * without a version (no detail was shown) is not checked.
 */
export async function planConfirmed<P extends GuardedPlan>(
  plan: () => Promise<P>,
  confirmation: ConfirmedCall | undefined,
  moved: (plan: P) => Error
): Promise<P> {
  const planned = await plan();
  if (
    confirmation?.version !== undefined &&
    confirmation.version !== planned.version
  ) {
    throw moved(planned);
  }
  return planned;
}

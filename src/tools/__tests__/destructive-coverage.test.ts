/**
 * The invariant that keeps the gate honest as tools are added: anything
 * annotated `destructiveHint: true` must also declare a confirmation, and the
 * `confirmation_token` argument must be on its published schema.
 *
 * `destructiveHint` on its own is only a hint to the host; a tool that carries
 * it without a `confirm` block would be exactly the "trust the annotation"
 * posture this feature replaces.
 */
import * as defs from '../definitions/index.js';
import {
  onboardingConfirmations,
  onboardingTools,
} from '../onboarding-registry.js';
import { CONFIRMATION_TOKEN_ARG } from '../confirmation.js';
import type { DefinedTool } from '../factory.js';

const factoryTools = (Object.values(defs) as unknown[]).filter(
  (tool): tool is DefinedTool =>
    !!tool && typeof tool === 'object' && 'toMcpTool' in tool && 'meta' in tool
);

/**
 * The destructive dispatcher of the compact listing runs deletions, so it is
 * marked destructive, but it has no confirmation of its own: the registry
 * runs the confirmation of the tool it dispatches to
 * (`src/__tests__/dispatch-e2e.test.ts`).
 */
const DISPATCHER = 'tools_call_destructive';

/** Every destructive tool, factory-defined or hand-written, by name. */
const destructiveNames = [
  ...factoryTools
    .filter((tool) => tool.meta.annotations?.destructiveHint === true)
    .map((tool) => tool.meta.name),
  ...onboardingTools
    .filter((spec) => spec.annotations?.destructiveHint === true)
    .map((spec) => spec.name),
].sort();

describe('destructive tools are gated', () => {
  it('covers exactly the known destructive surface', () => {
    expect(destructiveNames).toEqual([
      'analytics_delete_assistant_report',
      'appointments_apply_attendance',
      'appointments_delete',
      'appointments_set_consumables',
      'booking_forms_delete',
      'clients_delete',
      'events_delete',
      'events_delete_duplication_strategy',
      'financial_transactions_delete',
      'financial_transactions_update',
      'inventory_delete_document',
      'inventory_update_document',
      'locations_remove_user',
      'memberships_delete_type',
      'memberships_set_balance',
      'memberships_set_validity',
      'onboarding_rollback_phase',
      'positions_delete',
      'product_categories_delete',
      'products_archive',
      'schedules_delete',
      'service_categories_delete',
      'services_delete',
      'services_unlink_team_member',
      'team_members_delete',
      'tools_call_destructive',
      'visits_cancel_payment',
      'visits_remove_product',
    ]);
  });

  it.each(
    factoryTools.filter(
      (tool) =>
        tool.meta.annotations?.destructiveHint === true &&
        tool.meta.name !== DISPATCHER
    )
  )('$meta.name declares a confirmation', (tool) => {
    expect(tool.meta.confirm).toBeDefined();
    expect(tool.prepareConfirmation).toBeInstanceOf(Function);

    // The consequence has to say something concrete, not "are you sure?".
    const consequence = tool.meta.confirm!.consequence;
    const sample =
      typeof consequence === 'function'
        ? consequence({ location_id: 1 } as never)
        : consequence;
    expect(sample.length).toBeGreaterThan(60);
    expect(tool.meta.confirm!.action.length).toBeGreaterThan(0);
  });

  it.each(
    factoryTools.filter(
      (tool) =>
        tool.meta.annotations?.destructiveHint === true &&
        tool.meta.name !== DISPATCHER
    )
  )('$meta.name publishes an optional confirmation_token', (tool) => {
    const schema = tool.toMcpTool().inputSchema;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    expect(properties[CONFIRMATION_TOKEN_ARG]).toMatchObject({
      type: 'string',
    });
    expect((schema.required ?? []) as string[]).not.toContain(
      CONFIRMATION_TOKEN_ARG
    );
  });

  it('gates the hand-written onboarding rollback too', () => {
    const spec = onboardingTools.find(
      (tool) => tool.name === 'onboarding_rollback_phase'
    )!;
    const properties = (spec.inputSchema.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(properties[CONFIRMATION_TOKEN_ARG]).toMatchObject({
      type: 'string',
    });
    expect((spec.inputSchema.required ?? []) as string[]).not.toContain(
      CONFIRMATION_TOKEN_ARG
    );

    const prepared = onboardingConfirmations.onboarding_rollback_phase!({
      location_id: 4564,
      phase_name: 'services',
    });
    expect(prepared?.target).toContain('"services"');
    expect(prepared?.target).toContain('4564');
    expect(prepared?.consequence).toContain('deleted');
  });

  /**
   * Recording money or stock is additive — nothing is overwritten, so
   * `destructiveHint` stays false — but a payment, a client account deposit, a
   * cash operation, a payroll payout, an inventory operation or a product sold on a visit moves
   * money or stock a person has to stand behind, so these ask first too. So
   * do product cards and categories: sales, receipts and consumables all read
   * the one product list, and an agent creating them in bulk from an invoice
   * should not do so unseen. Service category writes ask first as a family, as
   * do position changes: the service list and online booking show them. The
   * list is explicit so the gate does not spread to ordinary creates.
   */
  const CONFIRMED_ADDITIVE = [
    'client_accounts_deposit',
    'financial_transactions_create',
    'inventory_create_operation',
    'inventory_pay_document',
    'payroll_record_payout',
    'positions_update',
    'product_categories_create',
    'product_categories_update',
    'products_create',
    'products_update',
    'service_categories_create',
    'service_categories_update',
    'visits_add_payment',
    'visits_add_product',
  ];

  it('gates nothing that is not destructive, except recording money or stock', () => {
    const confirmedButNotDestructive = factoryTools.filter(
      (tool) =>
        tool.meta.confirm !== undefined &&
        tool.meta.annotations?.destructiveHint !== true
    );
    expect(
      confirmedButNotDestructive.map((tool) => tool.meta.name).sort()
    ).toEqual(CONFIRMED_ADDITIVE);
  });
});

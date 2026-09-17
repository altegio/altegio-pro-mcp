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
      'clients_delete',
      'delete_appointment',
      'delete_booking_form',
      'delete_schedule',
      'delete_service',
      'delete_service_category',
      'delete_staff',
      'onboarding_rollback_phase',
      'remove_location_user',
      'unlink_service_team_member',
    ]);
  });

  it.each(
    factoryTools.filter(
      (tool) => tool.meta.annotations?.destructiveHint === true
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
      (tool) => tool.meta.annotations?.destructiveHint === true
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

  it('does not gate anything that is not destructive', () => {
    const confirmedButNotDestructive = factoryTools.filter(
      (tool) =>
        tool.meta.confirm !== undefined &&
        tool.meta.annotations?.destructiveHint !== true
    );
    expect(confirmedButNotDestructive.map((tool) => tool.meta.name)).toEqual(
      []
    );
  });
});

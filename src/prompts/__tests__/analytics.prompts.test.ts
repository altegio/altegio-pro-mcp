/**
 * Prompt module tests: the exported list and renderer the transport change will
 * wire into `prompts/list` and `prompts/get`.
 */
import {
  getAnalyticsPrompt,
  listAnalyticsPrompts,
} from '../analytics.prompts.js';

describe('prompt listing', () => {
  it('offers the three review prompts', () => {
    expect(listAnalyticsPrompts().map((prompt) => prompt.name)).toEqual([
      'analytics_monthly_review',
      'analytics_team_member_review',
      'analytics_compare_periods',
    ]);
  });

  it('requires a location on every prompt and describes every argument', () => {
    for (const prompt of listAnalyticsPrompts()) {
      const required = prompt.arguments.filter((a) => a.required);
      expect(required.map((a) => a.name)).toContain('location_id');
      for (const argument of prompt.arguments) {
        expect(argument.description.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('getAnalyticsPrompt', () => {
  it('renders the monthly review as a plan over the analytics tools', () => {
    const rendered = getAnalyticsPrompt('analytics_monthly_review', {
      location_id: '4564',
      period: 'last_month',
    })!;
    const text = rendered.messages[0]!.content.text;

    expect(rendered.messages[0]!.role).toBe('user');
    expect(text).toContain('location 4564');
    expect(text).toContain('analytics_get_overview');
    expect(text).toContain('analytics_get_daily_series');
    expect(text).toContain('analytics_get_appointments_breakdown');
    expect(text).toContain('analytics_run_report');
    expect(text).toContain('no-show');
  });

  it('defaults the period and keeps placeholders visible without arguments', () => {
    const text = getAnalyticsPrompt('analytics_monthly_review')!.messages[0]!
      .content.text;
    expect(text).toContain('"last_month"');
    expect(text).toContain('<location_id>');
  });

  it('branches the team review on whether ids were given', () => {
    const withIds = getAnalyticsPrompt('analytics_team_member_review', {
      location_id: '4564',
      team_member_ids: '9001,9002',
    })!.messages[0]!.content.text;
    expect(withIds).toContain('team_member_ids=[9001,9002]');

    const withoutIds = getAnalyticsPrompt('analytics_team_member_review', {
      location_id: '4564',
    })!.messages[0]!.content.text;
    expect(withoutIds).toContain('Pick the two or three team members');
  });

  it('uses the built-in comparison when no baseline is given', () => {
    const text = getAnalyticsPrompt('analytics_compare_periods', {
      location_id: '4564',
      date_from: '2026-08-01',
      date_to: '2026-08-31',
    })!.messages[0]!.content.text;
    expect(text).toContain('date_from=2026-08-01');
    expect(text).toContain('previous period of equal length');
  });

  it('calls the key metrics twice when a baseline is given', () => {
    const text = getAnalyticsPrompt('analytics_compare_periods', {
      location_id: '4564',
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      baseline_date_from: '2025-08-01',
      baseline_date_to: '2025-08-31',
    })!.messages[0]!.content.text;
    expect(text.match(/analytics_get_overview/g)).toHaveLength(2);
    expect(text).toContain('date_from=2025-08-01');
  });

  it('returns null for a prompt of another pack', () => {
    expect(getAnalyticsPrompt('onboarding_start')).toBeNull();
  });
});

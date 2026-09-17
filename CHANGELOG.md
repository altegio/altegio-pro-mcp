# Changelog

All notable server releases are recorded here. Versions follow Semantic
Versioning and use an `alpha.N` prerelease suffix until the public MCP contract
is declared stable.

## [0.3.0-alpha.0] - 2026-09-17

- Withheld the six report-builder tools (`analytics_list_report_templates`,
  `analytics_list_report_fields`, `analytics_run_report`,
  `analytics_list_saved_reports`, `analytics_run_saved_report`,
  `analytics_delete_assistant_report`) from every view, including stdio: the
  backend report-data API fails for every report in production, the legacy route
  ignores the requested period, and the reports this server created cannot be
  deleted with the rights it has. Definitions, adapter, use cases and tests are
  unchanged; `src/tools/disabled-tools.ts` holds the evidence and the re-enable
  step.
- Rewrote the analytics playbook, prompts, coverage resource and tool
  descriptions so no guidance points at the report builder, and answered the
  questions it used to serve from the key-metrics, series, breakdown, occupancy
  and day-end tools — or declined them as gaps.
- Withdrew the two report-builder resource templates (dataset field catalogue,
  truncated-report CSV) from the advertised resource list.

## [0.2.0-alpha.1] - 2026-09-11

- Fixed the deletion ownership check to use the least-privileged report list;
  the detailed report endpoint can return `403` for users who can still list
  and delete assistant-created reports.

## [0.2.0-alpha.0] - 2026-09-11

- Added guarded deletion for assistant-created analytics reports through the
  compatible report-builder route.
- Exposed the build version in MCP initialization metadata and `/health`.
- Corrected the package version from the old placeholder `1.0.0`.

## [0.1.9-alpha.0] - 2026-09-11

- Baseline public alpha after the analytics, client-base, request-scoped auth,
  demo-location management, and knowledge-resource audits.

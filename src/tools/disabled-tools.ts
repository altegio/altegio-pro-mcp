/**
 * Tools withheld from every view of this server, including stdio's unfiltered
 * `all` facet.
 *
 * **The report builder (Analytics Constructor) is off.** Verified against
 * production on 2026-09-17:
 *
 *  - `POST /company/{id}/analytics_constructor/reports/{id}/data` answers 400 for
 *    every report, even with a valid `BETWEEN {from,to}` override and a report
 *    whose data mart reports `success`. That endpoint always builds its query
 *    with the new query builder, while the mart is queued with the old context
 *    because the backend flag `new_query_builder_analytics_constructor` is off
 *    in production.
 *  - The legacy `POST /company/{id}/ac/{id}/data` does return rows, but its
 *    request accepts only `report_columns` — no filter override — and it ignores
 *    the report's stored date filter, so every answer is all-time data wearing
 *    the label of the requested period.
 *  - A freshly created report's first mart build always fails; only the hourly
 *    sweep upstream turns it into `success`, up to an hour later.
 *  - `DELETE /company/{id}/ac/{id}` needs the `analytics_constructor_access`
 *    user right, which neither an owner's OAuth token nor the marketplace
 *    system user carries, so the reports this server created cannot be removed.
 *
 * Serving these tools therefore produced failed calls and unremovable
 * `[Altegio Assistant] …` artifacts in the owner's builder. The definitions,
 * adapter, use cases and tests are kept intact — only the surface is closed,
 * and the guidance that pointed at them is marked `report builder disabled`
 * where it was rewritten.
 *
 * **To re-enable:** confirm the backend flag is on and that the data endpoint
 * returns a table, then empty this set and restore the guidance. `./surface.ts`
 * renders the effect of this set next to every other admission rule, so the
 * generated `docs/architecture/tool-surface.md` shows it turning back on.
 */
export const DISABLED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'analytics_list_report_templates',
  'analytics_list_report_fields',
  'analytics_run_report',
  'analytics_list_saved_reports',
  'analytics_run_saved_report',
  'analytics_delete_assistant_report',
]);

/** Whether a tool name is withheld from every view. */
export function isToolDisabled(name: string): boolean {
  return DISABLED_TOOL_NAMES.has(name);
}

/**
 * The same closure applied to the API catalog: the report-builder routes are
 * hidden from `altegio_search_operations`, `altegio_describe_operation` and
 * `altegio_call_operation`, so a session cannot walk back into the builder
 * through the universal executor. The routes stay documented in
 * `catalog/extended/analytics.yaml` — this hides them, it does not forget them.
 */
export function isDisabledOperationPath(path: string): boolean {
  return (
    path.includes('/analytics_constructor') ||
    /\/company\/[^/]+\/ac(\/|$)/.test(path)
  );
}

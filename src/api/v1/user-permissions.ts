/**
 * Effective permission groups of the request's own user at one location.
 *
 * `GET /user/permissions/{location_id}` answers for the Business User behind the
 * request's user token — never for another user — as `{group: {right: value}}`.
 * Access diagnosis, the attendance preview and the finance reports all read it
 * with the same credential as the operation they check.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { asRecord } from './wire-values.js';

/** Permission groups by slug; a group the response did not carry is absent. */
export type PermissionGroups = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

export async function readUserPermissions(
  client: AltegioClient,
  locationId: number
): Promise<PermissionGroups> {
  const { data } = await client.request<unknown>(
    'GET',
    `/user/permissions/${locationId}`
  );
  const groups: Record<string, Record<string, unknown>> = {};
  for (const [slug, rights] of Object.entries(asRecord(data))) {
    if (rights && typeof rights === 'object' && !Array.isArray(rights))
      groups[slug] = rights as Record<string, unknown>;
  }
  return groups;
}

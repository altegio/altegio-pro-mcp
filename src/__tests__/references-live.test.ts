/**
 * Opt-in live suite for changing positions and service categories, through
 * the real `tools/call` path of a host without elicitation: a position of its
 * own is renamed (its description stays), its description cleared, then
 * deleted twice; a service category of its own is renamed and reordered (its
 * weight stays through a rename), then deleted.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Credentials and the location come from the
 * environment, never a file in this public repo:
 *
 * - `ALTEGIO_E2E_LOCATION_ID` — a disposable test location.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… \
 *     npx jest references-live
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import { httpFromClient } from '../api/altegio-http.js';
import {
  describeLive,
  liveClient,
  liveHost,
  liveIds,
  textOf,
  type LiveHost,
} from './helpers/live.js';

describeLive(
  'position and service category changes on the test location',
  () => {
    let ids: Record<'LOCATION_ID', number>;
    let altegio: AltegioClient;
    let host: LiveHost;
    const stamp = Date.now();
    const made = { position: 0, category: 0 };

    beforeAll(async () => {
      ids = liveIds(['LOCATION_ID']);
      altegio = liveClient();
      host = await liveHost(altegio, 'references-live');
    });

    // Whatever a failed run left behind goes, straight through the API.
    afterAll(async () => {
      if (made.position) {
        await altegio
          .deletePosition(ids.LOCATION_ID, made.position)
          .catch(() => undefined);
      }
      if (made.category) {
        await altegio
          .deleteServiceCategory(ids.LOCATION_ID, made.category)
          .catch(() => undefined);
      }
      await host?.close();
    });

    const at = () => ({ location_id: ids.LOCATION_ID });

    const confirmedRun = async (
      tool: string,
      args: Record<string, unknown>
    ) => {
      const asked = await host.confirmed(tool, args);
      const result = await asked.run();
      if (result.isError) {
        throw new Error(`${tool} failed: ${textOf(result).slice(0, 400)}`);
      }
      return { result, asked };
    };

    it('renames a position, keeps its description, clears it, deletes it', async () => {
      const created = await host.call('positions_create', {
        ...at(),
        title: `references-live ${stamp}`,
        description: 'kept through a rename',
      });
      made.position = (created.structuredContent as { id: number }).id;

      await confirmedRun('positions_update', {
        ...at(),
        position_id: made.position,
        title: `references-live renamed ${stamp}`,
      });
      expect(
        await altegio.getPosition(ids.LOCATION_ID, made.position)
      ).toMatchObject({
        title: `references-live renamed ${stamp}`,
        description: 'kept through a rename',
      });

      await confirmedRun('positions_update', {
        ...at(),
        position_id: made.position,
        description: '',
      });
      expect(
        (await altegio.getPosition(ids.LOCATION_ID, made.position)).description
      ).toBeNull();

      // Nothing left to change: refused before anyone is asked.
      const same = await host.call('positions_update', {
        ...at(),
        position_id: made.position,
        description: '',
      });
      expect(textOf(same)).toMatch(/already has that title and description/);

      const removal = await confirmedRun('positions_delete', {
        ...at(),
        position_id: made.position,
      });
      expect(removal.result.structuredContent).toMatchObject({ deleted: true });
      const repeat = await removal.asked.run();
      expect(repeat.structuredContent).toMatchObject({
        deleted: false,
        already_deleted: true,
      });
      made.position = 0;
    }, 120_000);

    it('renames and reorders a service category, then deletes it', async () => {
      const created = await httpFromClient(altegio).request(
        `/service_categories/${ids.LOCATION_ID}`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: `references-live ${stamp}`,
            weight: 3,
          }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      made.category = (
        (await created.json()) as { data: { id: number } }
      ).data.id;

      await confirmedRun('service_categories_update', {
        ...at(),
        category_id: made.category,
        title: `references-live renamed ${stamp}`,
      });
      expect(
        await altegio.getServiceCategory(ids.LOCATION_ID, made.category)
      ).toMatchObject({ title: `references-live renamed ${stamp}`, weight: 3 });

      const reorder = await confirmedRun('service_categories_update', {
        ...at(),
        category_id: made.category,
        sort_weight: 9,
      });
      expect(reorder.result.structuredContent).toMatchObject({
        category: { title: `references-live renamed ${stamp}`, sort_weight: 9 },
      });

      await confirmedRun('service_categories_delete', {
        ...at(),
        category_id: made.category,
      });
      made.category = 0;
    }, 120_000);
  }
);

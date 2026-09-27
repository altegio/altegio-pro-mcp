import { runWithContext } from '../../../request-context.js';
import {
  clearReportStore,
  putReportCsv,
  getReportCsv,
} from '../report-store.js';

const input = {
  location_id: 1,
  name: 'report',
  csv: 'amount\n10',
  row_count: 1,
};
afterEach(clearReportStore);

it('binds full report resources to their creating principal', () => {
  const owner = { identity: null, userToken: 'owner-token' };
  const stored = runWithContext(owner, () => putReportCsv(input));
  expect(runWithContext(owner, () => getReportCsv(1, stored.run_id))?.csv).toBe(
    input.csv
  );
  expect(
    runWithContext({ identity: null, userToken: 'other-token' }, () =>
      getReportCsv(1, stored.run_id)
    )
  ).toBeUndefined();
  expect(
    runWithContext({ identity: null }, () => getReportCsv(1, stored.run_id))
  ).toBeUndefined();
  expect(getReportCsv(1, stored.run_id)).toBeUndefined();
  expect(
    runWithContext({ ...owner, companyIds: new Set([2]) }, () =>
      getReportCsv(1, stored.run_id)
    )
  ).toBeUndefined();
});

it('does not expose local reports to HTTP callers', () => {
  const stored = putReportCsv(input);
  expect(getReportCsv(1, stored.run_id)?.csv).toBe(input.csv);
  expect(
    runWithContext({ identity: null }, () => getReportCsv(1, stored.run_id))
  ).toBeUndefined();
});

it('rechecks the analytics grant when a report is downloaded', () => {
  const owner = { identity: null, userToken: 'owner-token' };
  const stored = runWithContext(owner, () => putReportCsv(input));
  expect(
    runWithContext({ ...owner, scopes: new Set(['clients:read']) }, () =>
      getReportCsv(1, stored.run_id)
    )
  ).toBeUndefined();
  expect(
    runWithContext({ ...owner, scopes: new Set(['mcp:pro:read']) }, () =>
      getReportCsv(1, stored.run_id)
    )?.csv
  ).toBe(input.csv);
});

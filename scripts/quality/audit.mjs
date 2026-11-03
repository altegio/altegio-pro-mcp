import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const exceptions = JSON.parse(
  await readFile(
    new URL('../../.github/dependency-advisories.json', import.meta.url),
    'utf8'
  )
);
const today = new Date().toISOString().slice(0, 10);
for (const entry of exceptions) {
  assert.ok(
    /^GHSA-/.test(entry.id) && entry.owner && entry.reason,
    'Incomplete advisory triage'
  );
  assert.ok(
    entry.expires >= today,
    `Expired advisory triage: ${entry.id} (${entry.owner})`
  );
}
function audit(production) {
  const result = spawnSync(
    'npm',
    ['audit', ...(production ? ['--omit=dev'] : []), '--json'],
    {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  assert.ok(
    !result.error && (result.status === 0 || result.status === 1),
    'npm audit request failed'
  );
  const report = JSON.parse(result.stdout);
  assert.ok(
    !report.error && report.vulnerabilities,
    'npm audit did not return an advisory report'
  );
  const advisories = new Map();
  for (const vulnerable of Object.values(report.vulnerabilities)) {
    for (const via of vulnerable.via) {
      if (typeof via === 'object') advisories.set(via.url, via);
    }
  }
  return [...advisories.values()];
}
let failed = false;
for (const production of [true, false]) {
  const advisories = audit(production);
  const label = production
    ? 'runtime'
    : 'complete dependency tree (includes development)';
  console.log(`${label}: ${advisories.length} unique advisories`);
  for (const advisory of advisories) {
    const id = advisory.url.split('/').at(-1);
    const exception = exceptions.find(
      (entry) => entry.id === id && entry.package === advisory.name
    );
    const blocking =
      ['high', 'critical'].includes(advisory.severity) ||
      (production && !exception);
    failed ||= blocking;
    console.log(
      `  ${id} ${advisory.name} ${advisory.severity}: ${blocking ? 'BLOCKED' : exception ? `triaged through ${exception.expires} (${exception.owner})` : 'review in dependency updates'}`
    );
  }
}
process.exitCode = failed ? 1 : 0;

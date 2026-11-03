import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const [image, revision] = process.argv.slice(2);
assert.ok(
  image && /^[a-f0-9]{40}$/.test(revision ?? ''),
  'Usage: node scripts/smoke/container.mjs <image-id> <commit-sha>'
);
const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
    ...options,
  }).trim();
const version = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8')
).version;
const cid = docker([
  'run',
  '--detach',
  '--network',
  'bridge',
  '--publish',
  '127.0.0.1::3000',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,noexec,nosuid,size=32m',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  '--pids-limit=128',
  '--memory=512m',
  '-e',
  'ALTEGIO_API_TOKEN=synthetic-smoke-partner',
  '-e',
  'ALTEGIO_API_BASE=http://127.0.0.1:9/api/v1',
  '-e',
  'CREDENTIALS_DIR=/tmp/credentials',
  '-e',
  'ONBOARDING_STATE_DIR=/tmp/onboarding',
  '-e',
  'LOG_LEVEL=error',
  '-e',
  `EXPECTED_VERSION=${version}`,
  '-e',
  `EXPECTED_REVISION=${revision}`,
  image,
]);
try {
  assert.equal(
    docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      cid,
    ]),
    revision
  );
  let healthy = false;
  for (let deadline = Date.now() + 15_000; Date.now() < deadline;) {
    try {
      docker(
        [
          'exec',
          cid,
          'node',
          '-e',
          'fetch("http://127.0.0.1:3000/health",{signal:AbortSignal.timeout(1000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))',
        ],
        { timeout: 2500 }
      );
      healthy = true;
      break;
    } catch {
      await setTimeout(500);
    }
  }
  assert.ok(healthy, 'Container did not become healthy within 15 seconds');
  // A loopback-only listener inside the container passes docker exec probes
  // but is unreachable through the published port used by real deployments.
  const published = docker(['port', cid, '3000/tcp']);
  assert.match(published, /^127\.0\.0\.1:\d+$/);
  const externalHealth = await fetch(`http://${published}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(externalHealth.status, 200);
  assert.equal((await externalHealth.json()).commit, revision);
  const discovery = await fetch(`http://${published}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(discovery.status, 200);
  const text = await discovery.text();
  const event = text.split('\n').find((line) => line.startsWith('data: '));
  const reply = JSON.parse(event ? event.slice(6) : text);
  assert.ok(
    reply.result?.tools?.length > 0,
    'Published MCP route is unavailable'
  );
  console.log(
    docker(['exec', '-i', cid, 'node', '--input-type=module'], {
      input: await readFile(
        new URL('./http-probe.mjs', import.meta.url),
        'utf8'
      ),
    })
  );
  console.log(
    docker(['exec', '-i', cid, 'node', '--input-type=module'], {
      input:
        (await readFile(new URL('./stdio.mjs', import.meta.url), 'utf8')) +
        "\nconsole.log(JSON.stringify(await smokeStdio('/app')));\n",
    })
  );
} finally {
  docker(['rm', '--force', cid]);
}

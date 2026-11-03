// Runs inside the image via docker exec; never calls an Altegio business API.
import assert from 'node:assert/strict';

const response = await fetch('http://127.0.0.1:3000/health', {
  signal: AbortSignal.timeout(5000),
});
assert.equal(response.status, 200);
const health = await response.json();
assert.equal(health.status, 'ok');
assert.equal(health.commit, process.env.EXPECTED_REVISION);
assert.equal(process.env.COMMIT_SHA, process.env.EXPECTED_REVISION);
assert.equal(health.version, process.env.EXPECTED_VERSION);
assert.equal(process.getuid(), 1001);
assert.equal(Number(process.versions.node.split('.')[0]), 26);
console.log(
  JSON.stringify({
    health: 'ok',
    revision: health.commit,
    version: health.version,
    node: process.version,
    uid: process.getuid(),
  })
);

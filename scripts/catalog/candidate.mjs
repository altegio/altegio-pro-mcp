import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'altegio/altegio-pro-mcp';
const CONTEXT = 'Catalog (pinned spec)';

export function validateCandidate(pr, sha) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/);
  assert.equal(pr.state, 'open');
  assert.equal(pr.base.repo.full_name, REPOSITORY);
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.head.sha, sha);
}

export async function candidateStatus({
  env = process.env,
  request = fetch,
  complete = false,
}) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.match(env.PR_NUMBER ?? '', /^[1-9]\d*$/);
  assert.match(env.CANDIDATE_SHA ?? '', /^[a-f0-9]{40}$/);
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let valid = false;
  try {
    const response = await request(
      `https://api.github.com/repos/${REPOSITORY}/pulls/${env.PR_NUMBER}`,
      { headers, signal: AbortSignal.timeout(30_000) }
    );
    assert.ok(response.ok);
    validateCandidate(await response.json(), env.CANDIDATE_SHA);
    valid = true;
  } catch {
    assert.ok(complete, 'Reviewed candidate is no longer the open PR head');
  }
  if (!complete) {
    await appendFile(env.GITHUB_OUTPUT, `sha=${env.CANDIDATE_SHA}\n`);
    return;
  }
  const success =
    valid && env.VALIDATION === 'success' && env.JOB_STATUS === 'success';
  const response = await request(
    `https://api.github.com/repos/${REPOSITORY}/statuses/${env.CANDIDATE_SHA}`,
    {
      method: 'POST',
      headers: {
        ...headers,
        Authorization: `Bearer ${env.CATALOG_STATUS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        state: success ? 'success' : 'failure',
        context: CONTEXT,
        description: success
          ? 'Reviewed source matches the pinned private specification'
          : 'Validation failed, was cancelled, or the reviewed head changed',
        target_url: `https://github.com/${REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
      }),
    }
  );
  assert.ok(response.ok, 'Dedicated status update failed');
  assert.ok(success, 'Private validation or reviewed-head recheck failed');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await candidateStatus({ complete: process.argv.includes('--complete') });
  } catch {
    console.error(
      'Trusted catalog validation/status failed; no success was granted.'
    );
    process.exitCode = 1;
  }
}

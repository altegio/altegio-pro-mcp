/** Deliberate coordinator-only setup. No mutation occurs without --apply. */
import assert from 'node:assert/strict';
import { createSign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCandidate } from './candidate.mjs';

const REPOSITORY = 'altegio/altegio-pro-mcp';
const ENVIRONMENT = 'catalog-spec';
const CONTEXT = 'Catalog (pinned spec)';
const RULESET = 26491479;
const repositoryAPI = `/repos/${REPOSITORY}`;

function gh(args, input) {
  const result = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(
    result.status,
    0,
    'GitHub CLI operation failed (details suppressed)'
  );
  return result.stdout.trim();
}
async function api(
  endpoint,
  token,
  { method = 'GET', body, allow404 = false } = {}
) {
  const response = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (allow404 && response.status === 404) return undefined;
  assert.ok(response.ok, `GitHub API operation failed (${response.status})`);
  return response.status === 204 ? undefined : response.json();
}

export function requiredRuleset(current, appID) {
  assert.equal(current.id, RULESET);
  assert.equal(current.enforcement, 'active');
  assert.deepEqual(current.bypass_actors, []);
  const rules = structuredClone(current.rules);
  const checks = rules.find((rule) => rule.type === 'required_status_checks');
  const review = rules.find((rule) => rule.type === 'pull_request');
  assert.equal(
    review.parameters.required_approving_review_count,
    0,
    'Preserve the owner approval policy'
  );
  assert.equal(checks.parameters.strict_required_status_checks_policy, true);
  for (const context of [
    'Quality',
    'Tests (Node 26)',
    'Tests (Node 24)',
    'Artifacts',
    'Package (Node 24)',
    'Dependency audit',
    'CodeQL analysis',
  ]) {
    assert.ok(
      checks.parameters.required_status_checks.some(
        (check) => check.context === context && check.integration_id === 15368
      ),
      'An existing mandatory source-bound check is missing'
    );
  }
  const present = checks.parameters.required_status_checks.find(
    (check) => check.context === CONTEXT
  );
  if (present)
    assert.equal(
      present.integration_id,
      appID,
      'Catalog status is bound to another issuer'
    );
  else
    checks.parameters.required_status_checks.push({
      context: CONTEXT,
      integration_id: appID,
    });
  return {
    name: current.name,
    enforcement: current.enforcement,
    bypass_actors: current.bypass_actors,
    conditions: current.conditions,
    rules,
  };
}

async function inspectApp(appID, keyFile) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' })
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 300, iss: appID })
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(await readFile(keyFile))
    .toString('base64url');
  const jwt = `${unsigned}.${signature}`;
  const app = await api('/app', jwt);
  assert.equal(app.id, appID);
  assert.equal(app.owner.login, 'altegio');
  assert.deepEqual(app.permissions, { metadata: 'read', statuses: 'write' });
  assert.deepEqual(app.events, []);
  const installations = await api('/app/installations', jwt);
  assert.equal(
    installations.length,
    1,
    'Use a dedicated single-installation App'
  );
  const installation = installations[0];
  assert.equal(installation.account.login, 'altegio');
  assert.equal(installation.repository_selection, 'selected');
  assert.ok(!installation.suspended_at);
  const access = await api(
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
    { method: 'POST', body: { permissions: { statuses: 'write' } } }
  );
  try {
    const repositories = await api('/installation/repositories', access.token);
    assert.equal(
      repositories.total_count,
      1,
      'The installation must cover only this repository'
    );
    assert.equal(repositories.repositories[0].full_name, REPOSITORY);
  } finally {
    await api('/installation/token', access.token, { method: 'DELETE' });
  }
  return app;
}

async function configureEnvironment({
  appID,
  keyFile,
  urlFile,
  providerFile,
  apply,
  token,
}) {
  const before = await api(
    `${repositoryAPI}/environments/${ENVIRONMENT}`,
    token,
    { allow404: true }
  );
  if (before) {
    assert.deepEqual(before.deployment_branch_policy, {
      protected_branches: false,
      custom_branch_policies: true,
    });
    const branches = await api(
      `${repositoryAPI}/environments/${ENVIRONMENT}/deployment-branch-policies`,
      token
    );
    assert.equal(branches.branch_policies.length, 1);
    assert.equal(branches.branch_policies[0].name, 'main');
    assert.equal(branches.branch_policies[0].type, 'branch');
  }
  const variable = before
    ? await api(
        `${repositoryAPI}/environments/${ENVIRONMENT}/variables/CATALOG_STATUS_APP_ID`,
        token,
        { allow404: true }
      )
    : undefined;
  if (variable)
    assert.equal(
      variable.value,
      String(appID),
      'Existing App identity differs; do not rotate it silently'
    );
  const body = {
    can_admins_bypass: false,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
  console.log(
    JSON.stringify({
      environment: ENVIRONMENT,
      create: !before,
      preserveExistingProtectionRules: !!before,
      body: before ? undefined : body,
      appID,
      secrets: [
        'CATALOG_STATUS_APP_PRIVATE_KEY',
        'SPEC_ARCHIVE_URL',
        'SPEC_WIF_PROVIDER',
      ],
      apply,
    })
  );
  const source = (await readFile(urlFile, 'utf8')).trim();
  const provider = (await readFile(providerFile, 'utf8')).trim();
  assert.equal(new URL(source).origin, 'https://storage.googleapis.com');
  assert.match(
    new URL(source).searchParams.get('generation') ?? '',
    /^[1-9]\d*$/
  );
  assert.match(
    provider,
    /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/
  );
  if (!apply) return;
  if (!before) {
    await api(`${repositoryAPI}/environments/${ENVIRONMENT}`, token, {
      method: 'PUT',
      body,
    });
    await api(
      `${repositoryAPI}/environments/${ENVIRONMENT}/deployment-branch-policies`,
      token,
      { method: 'POST', body: { name: 'main', type: 'branch' } }
    );
  }
  const existing = await api(
    `${repositoryAPI}/environments/${ENVIRONMENT}/secrets?per_page=100`,
    token
  );
  assert.equal(
    existing.total_count,
    existing.secrets.length,
    'Refuse to provision from an incomplete secret inventory'
  );
  const names = new Set(existing.secrets.map((secret) => secret.name));
  for (const [name, value] of [
    ['CATALOG_STATUS_APP_PRIVATE_KEY', await readFile(keyFile, 'utf8')],
    ['SPEC_ARCHIVE_URL', source],
    ['SPEC_WIF_PROVIDER', provider],
  ]) {
    if (!names.has(name))
      gh(
        ['secret', 'set', name, '--repo', REPOSITORY, '--env', ENVIRONMENT],
        value
      );
  }
  if (!variable)
    gh([
      'variable',
      'set',
      'CATALOG_STATUS_APP_ID',
      '--repo',
      REPOSITORY,
      '--env',
      ENVIRONMENT,
      '--body',
      String(appID),
    ]);
  const after = await api(
    `${repositoryAPI}/environments/${ENVIRONMENT}`,
    token
  );
  if (before) assert.deepEqual(after.protection_rules, before.protection_rules);
  else assert.equal(after.can_admins_bypass, false);
  console.log(
    'Main-only environment and missing encrypted inputs provisioned; existing reviews/secrets preserved. Required status remains inactive.'
  );
}

export async function verifyActivation({
  app,
  pr,
  sha,
  runID,
  token,
  request = api,
}) {
  validateCandidate(await request(`${repositoryAPI}/pulls/${pr}`, token), sha);
  const run = await request(`${repositoryAPI}/actions/runs/${runID}`, token);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.path, '.github/workflows/catalog-trusted.yml');
  assert.equal(run.conclusion, 'success');
  const target = `https://github.com/${REPOSITORY}/actions/runs/${runID}`;
  // Combined statuses omit creator. Individual statuses include the issuer
  // and are newest first; never accept an older success over a newer failure.
  const statuses = await request(
    `${repositoryAPI}/commits/${sha}/statuses?per_page=100`,
    token
  );
  assert.ok(Array.isArray(statuses));
  const latest = statuses.find((entry) => entry.context === CONTEXT);
  assert.equal(latest?.state, 'success');
  assert.equal(latest.creator?.login, `${app.slug}[bot]`);
  assert.equal(latest.creator?.type, 'Bot');
  assert.equal(latest.target_url, target);
}

async function activate({ app, pr, sha, runID, token, apply }) {
  await verifyActivation({ app, pr, sha, runID, token });
  const current = await api(`${repositoryAPI}/rulesets/${RULESET}`, token);
  const proposed = requiredRuleset(current, app.id);
  const output = path.resolve('.inventory/catalog-gate-setup');
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(output, 'rules-before.json'),
    JSON.stringify(current, null, 2),
    { mode: 0o600 }
  );
  await writeFile(
    path.join(output, 'rules-proposed.json'),
    JSON.stringify(proposed, null, 2),
    { mode: 0o600 }
  );
  console.log(
    JSON.stringify({
      appID: app.id,
      sha,
      runID,
      requiredContext: CONTEXT,
      apply,
    })
  );
  if (!apply) return;
  const after = await api(`${repositoryAPI}/rulesets/${RULESET}`, token, {
    method: 'PUT',
    body: proposed,
  });
  assert.deepEqual(after.rules, proposed.rules);
  assert.equal(after.enforcement, 'active');
  assert.deepEqual(after.bypass_actors, []);
  console.log(
    'Required catalog status is bound to the verified dedicated App; existing rules preserved.'
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [mode, id, keyFile, ...args] = process.argv
      .slice(2)
      .filter((value) => value !== '--apply');
    const appID = Number(id);
    assert.ok(Number.isSafeInteger(appID) && appID > 0);
    assert.ok(['app-check', 'environment', 'require'].includes(mode));
    const app = await inspectApp(appID, keyFile);
    console.log(
      JSON.stringify({
        appID: app.id,
        slug: app.slug,
        permission: 'statuses:write',
        repositories: [REPOSITORY],
      })
    );
    if (mode !== 'app-check') {
      const token = gh(['auth', 'token']);
      const apply = process.argv.includes('--apply');
      if (mode === 'environment') {
        const [urlFile, providerFile] = args;
        await configureEnvironment({
          appID,
          keyFile,
          urlFile,
          providerFile,
          apply,
          token,
        });
      } else {
        const [pr, sha, runID] = args;
        assert.match(pr ?? '', /^[1-9]\d*$/);
        assert.match(runID ?? '', /^[1-9]\d*$/);
        await activate({ app, pr, sha, runID, apply, token });
      }
    }
  } catch {
    console.error(
      'Catalog administrative check failed. No protection bypass is permitted; inspect the prepared configuration privately.'
    );
    process.exitCode = 1;
  }
}

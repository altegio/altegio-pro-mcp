import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 64 * 1024 * 1024;
const requestOptions = () => ({
  redirect: 'error',
  signal: AbortSignal.timeout(60_000),
});

/** Exchange runner OIDC for object-only access; no persistent archive secret. */
export async function acquireSnapshot({
  env = process.env,
  request = fetch,
  pin,
  destination,
}) {
  const provider = env.SPEC_WIF_PROVIDER;
  assert.match(
    provider ?? '',
    /^projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]+\/providers\/[a-z0-9-]+$/
  );
  const source = new URL(env.SPEC_ARCHIVE_URL);
  assert.equal(source.origin, 'https://storage.googleapis.com');
  assert.match(
    source.pathname,
    /^\/download\/storage\/v1\/b\/[^/]+\/o\/[^/]+$/
  );
  assert.equal(source.searchParams.get('alt'), 'media');
  assert.match(source.searchParams.get('generation') ?? '', /^[1-9]\d*$/);
  assert.match(pin.archive_sha256 ?? '', /^[a-f0-9]{64}$/);
  const identityURL = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  assert.equal(identityURL.protocol, 'https:');
  identityURL.searchParams.set(
    'audience',
    `https://iam.googleapis.com/${provider}`
  );
  const identity = await request(identityURL, {
    ...requestOptions(),
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  assert.ok(identity.ok, 'Runner identity request failed');
  const { value } = await identity.json();
  assert.ok(typeof value === 'string' && value.length > 0);
  const exchange = await request('https://sts.googleapis.com/v1/token', {
    ...requestOptions(),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience: `//iam.googleapis.com/${provider}`,
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'https://www.googleapis.com/auth/devstorage.read_only',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      subjectToken: value,
    }),
  });
  assert.ok(exchange.ok, 'Archive identity exchange failed');
  const { access_token: token } = await exchange.json();
  assert.ok(typeof token === 'string' && token.length > 0);
  const partial = `${destination}.part`;
  let output;
  let response;
  try {
    response = await request(source, {
      ...requestOptions(),
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.ok(response.ok && response.body, 'Private archive request failed');
    assert.ok(Number(response.headers.get('content-length') ?? 0) <= LIMIT);
    output = await open(partial, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= LIMIT, 'Private archive exceeds the download limit');
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    assert.equal(
      hash.digest('hex'),
      pin.archive_sha256,
      'Archive digest mismatch'
    );
    await output.close();
    output = undefined;
    await rename(partial, destination);
  } finally {
    await response?.body?.cancel().catch(() => {});
    await output?.close();
    await rm(partial, { force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const pin = JSON.parse(
      await readFile(new URL('./spec-pin.json', import.meta.url), 'utf8')
    );
    await acquireSnapshot({ pin, destination: process.argv[2] });
    console.log('Private archive acquired and its immutable digest verified.');
  } catch {
    // Native fetch errors can contain URLs. Never publish the underlying error.
    console.error(
      'Private specification acquisition failed. Check access privately.'
    );
    process.exitCode = 1;
  }
}

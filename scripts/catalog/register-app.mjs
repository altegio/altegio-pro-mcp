/** GitHub's manifest registration requires an owner browser session once. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const escape = (value) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');

export async function registration({ output, request = fetch }) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  for (const name of ['status-app.pem', 'status-app.json']) {
    assert.equal(
      await lstat(path.join(output, name)).then(
        () => true,
        () => false
      ),
      false,
      'Do not overwrite an existing App identity'
    );
  }
  const lock = path.join(output, 'registration.lock');
  await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  const state = randomBytes(32).toString('hex');
  const template = JSON.parse(
    await readFile(
      new URL(
        '../../.github/catalog-status-app-manifest.json',
        import.meta.url
      ),
      'utf8'
    )
  );
  let base;
  let used = false;
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'"
      );
      if (req.method !== 'GET' || req.headers.host !== new URL(base).host) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const url = new URL(req.url, base);
      if (url.pathname === `/register/${state}`) {
        const manifest = { ...template, redirect_url: `${base}/callback` };
        res.end(
          `<title>Register catalog status App</title><h1>Altegio catalog gate</h1><p>Create this private App with Commit statuses: write and inactive webhooks. Then install it on altegio/altegio-pro-mcp only.</p><form action="https://github.com/organizations/altegio/settings/apps/new?state=${state}" method="post"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button>Register private App on altegio</button></form>`
        );
        return;
      }
      if (
        url.pathname !== '/callback' ||
        url.searchParams.get('state') !== state ||
        used
      ) {
        res.writeHead(403).end('Invalid or already-used registration');
        return;
      }
      const code = url.searchParams.get('code');
      assert.match(code ?? '', /^[A-Za-z0-9_-]{20,200}$/);
      used = true;
      const response = await request(
        `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );
      assert.ok(response.ok, 'App manifest conversion failed');
      const app = await response.json();
      assert.ok(Number.isSafeInteger(app.id) && app.id > 0);
      assert.match(app.slug, /^[a-z0-9-]+$/);
      assert.match(app.pem, /^-----BEGIN (RSA )?PRIVATE KEY-----/);
      await writeFile(path.join(output, 'status-app.pem'), app.pem, {
        mode: 0o600,
        flag: 'wx',
      });
      await writeFile(
        path.join(output, 'status-app.json'),
        JSON.stringify({ id: app.id, slug: app.slug }, null, 2),
        { mode: 0o600, flag: 'wx' }
      );
      // Discard client/webhook secrets: neither is needed by this App.
      res.end(
        `<title>App registered</title><h1>Private key saved locally</h1><p><a href="https://github.com/apps/${app.slug}/installations/new">Install on altegio/altegio-pro-mcp only</a>. The coordinator can then validate the installation and provision encrypted environment inputs.</p>`
      );
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end(
        'Registration failed. Inspect local setup state; no credentials were printed.'
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/register/${state}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await rm(lock, { force: true });
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const session = await registration({
      output: path.resolve('.inventory/catalog-gate-setup'),
    });
    console.log(
      `Complete the one-time App registration and repository-only installation: ${session.url}`
    );
    if (process.argv.includes('--open')) {
      assert.equal(
        process.platform,
        'darwin',
        '--open uses the macOS default browser'
      );
      spawn('open', [session.url], { stdio: 'ignore' });
    }
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      clearTimeout(timer);
      await session.close();
    };
    const timer = setTimeout(() => {
      void close();
    }, 10 * 60_000);
    process.once('SIGINT', () => {
      void close();
    });
    process.once('SIGTERM', () => {
      void close();
    });
  } catch {
    console.error(
      'App registration could not start. Existing App credentials were preserved.'
    );
    process.exitCode = 1;
  }
}

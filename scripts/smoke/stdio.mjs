import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Probe an installed CLI from outside its checkout, using no real identity. */
export async function smokeStdio(packageRoot) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'altegio-stdio-smoke-'));
  const child = spawn(
    process.execPath,
    [path.join(packageRoot, 'dist/index.js')],
    {
      cwd: temp,
      env: {
        PATH: process.env.PATH,
        HOME: temp,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        ALTEGIO_API_TOKEN: 'synthetic-smoke-partner',
        ALTEGIO_API_BASE: 'http://127.0.0.1:9/api/v1',
        CREDENTIALS_DIR: path.join(temp, 'credentials'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  const pending = new Map();
  let nextId = 0;
  let invalidOutput;
  // Drain stderr; subprocess logs contain only synthetic state and aren't the
  // JSON-RPC channel being verified. Bound memory independently of log volume.
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      assert.equal(
        message?.jsonrpc,
        '2.0',
        'Stdout must contain only JSON-RPC messages'
      );
      if (pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    } catch {
      invalidOutput = new Error(
        'Non-JSON output on the stdio protocol channel'
      );
      for (const { reject } of pending.values()) reject(invalidOutput);
    }
  });
  const rejectPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', (code) =>
    rejectPending(new Error(`CLI exited (${code}): ${stderr}`))
  );
  const deadline = setTimeout(() => {
    rejectPending(new Error('Stdio smoke deadline exceeded'));
    child.kill('SIGKILL');
  }, 30_000);
  function call(method, params = {}) {
    if (invalidOutput) return Promise.reject(invalidOutput);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      );
    });
  }
  try {
    const initialized = await call('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'artifact-smoke', version: '1.0.0' },
    });
    assert.ok(initialized.protocolVersion);
    child.stdin.write(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
    );
    const tools = await call('tools/list');
    const names = new Set(tools.tools.map((tool) => tool.name));
    for (const name of [
      'auth_login',
      'locations_list',
      'appointments_list',
      'api_search_operations',
    ]) {
      assert.ok(names.has(name), `Missing documented tool: ${name}`);
    }
    const prompts = await call('prompts/list');
    assert.ok(
      prompts.prompts.some((prompt) => prompt.name === 'onboarding_walkthrough')
    );
    for (const name of ['product-logic', 'onboarding-guide']) {
      const result = await call('resources/read', {
        uri: `altegio://docs/${name}`,
      });
      const expected = await readFile(
        path.join(packageRoot, 'docs', `${name}.md`),
        'utf8'
      );
      assert.ok(
        expected.startsWith('# ') && expected.length > 100,
        `Empty packaged resource: ${name}`
      );
      assert.equal(
        result.contents[0]?.text,
        expected,
        `Packaged resource: ${name}`
      );
    }
    const catalog = JSON.parse(
      await readFile(
        path.join(packageRoot, 'dist/generated/catalog.json'),
        'utf8'
      )
    );
    assert.ok(catalog.operationCount > 0);
    assert.equal(catalog.operations.length, catalog.operationCount);
    assert.equal(invalidOutput, undefined);
    return {
      protocol: initialized.protocolVersion,
      tools: names.size,
      resources: 2,
    };
  } finally {
    clearTimeout(deadline);
    lines.close();
    const exit = new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      await exit;
      clearTimeout(force);
    }
    await rm(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(await smokeStdio(path.resolve(process.argv[2] ?? '.')))
  );
}

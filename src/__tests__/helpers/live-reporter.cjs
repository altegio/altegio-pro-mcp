/**
 * Jest reporter for the scheduled live run, whose log and summary are public:
 * it prints each test's name and outcome and, for a failure, only the
 * assertion line, the expected and received lines and the test's own source
 * line — truncated, with long digit runs, e-mail addresses, phone numbers and
 * tokens masked. It never prints a received object, a stack or console
 * output, so run a suite locally for the full failure.
 *
 *   npx jest --silent --reporters=./src/__tests__/helpers/live-reporter.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_LINE = 160;

function redact(line) {
  return line
    .replace(/(Bearer|User)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/\+\s?\d[\d\s()-]{6,}\d/g, '<phone>')
    .replace(/\d{5,}/g, '#')
    .slice(0, MAX_LINE);
}

/** The short, masked lines of one failure message. */
function failureLines(message, rootDir) {
  const lines = message.split('\n').map((l) => l.trim());
  const picked = [];
  const head = lines.find((l) => l.length > 0);
  if (head) picked.push(head.replace(/\u001b\[[0-9;]*m/g, ''));
  for (const line of lines) {
    const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
    if (/^(Expected|Received)( [a-z ]+)?:/.test(plain)) picked.push(plain);
  }
  const frame = lines
    .map((l) => /\(([^()]+\.test\.ts):(\d+):\d+\)/.exec(l))
    .find(Boolean);
  if (frame) picked.push(`at ${path.relative(rootDir, frame[1])}:${frame[2]}`);
  return picked.slice(0, 4).map(redact);
}

const MARK = {
  passed: '✓',
  failed: '✕',
  pending: '○',
  skipped: '○',
  todo: '○',
};

class LiveReporter {
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir;
    this.rows = [];
  }

  onTestResult(test, result) {
    const file = path.relative(this.rootDir, result.testFilePath);
    console.log(
      `${result.numFailingTests > 0 || result.testExecError ? 'FAIL' : 'PASS'} ${file}`
    );
    if (result.testExecError) {
      console.log(`  ✕ the suite did not run`);
      for (const line of failureLines(
        result.testExecError.message ?? '',
        this.rootDir
      )) {
        console.log(`      ${line}`);
      }
      this.rows.push({ file, name: 'the suite did not run', status: 'failed' });
    }
    for (const t of result.testResults) {
      const name = [...t.ancestorTitles, t.title].join(' › ');
      console.log(
        `  ${MARK[t.status] ?? '?'} ${name}${t.duration ? ` (${t.duration} ms)` : ''}`
      );
      if (t.status === 'failed') {
        for (const message of t.failureMessages) {
          for (const line of failureLines(message, this.rootDir)) {
            console.log(`      ${line}`);
          }
        }
      }
      this.rows.push({ file, name, status: t.status });
    }
  }

  onRunComplete(_contexts, results) {
    const totals = `${results.numPassedTests} passed, ${results.numFailedTests} failed, ${results.numPendingTests} skipped, ${results.numTotalTests} total`;
    console.log(`Tests: ${totals}`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (!summary) return;
    const table = this.rows
      .map(
        (r) =>
          `| ${MARK[r.status] ?? '?'} | ${r.file} | ${r.name.replace(/\|/g, '\\|')} |`
      )
      .join('\n');
    fs.appendFileSync(
      summary,
      `### Live suites\n\n${totals}\n\n| | Suite | Test |\n|---|---|---|\n${table}\n`
    );
  }

  getLastError() {
    return undefined;
  }
}

module.exports = LiveReporter;

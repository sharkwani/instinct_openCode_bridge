const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const core = require('../src/core');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-output-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

const cfgFor = (dir) => ({ bridge_secret: 's3cret', repos: { main: dir }, task_timeout_minutes: 30 });

describe('task output: helper caps and labels', () => {
  it('caps at 12KB with truncation label', () => {
    assert.equal(core.MAX_OUTPUT_CHARS, 12 * 1024);
    const big = 'x'.repeat(13 * 1024);
    const out = core.toSafeOutput(big);
    assert.ok(out.length <= 12 * 1024 + 100, `len=${out.length}`);
    assert.match(out, /truncated/i);
    assert.match(out, /12KB/);
    assert.ok(out.startsWith('x'.repeat(100)));
  });

  it('short output passes through unchanged', () => {
    assert.equal(core.toSafeOutput('hello'), 'hello');
    assert.equal(core.toSafeOutput(''), '');
    assert.equal(core.toSafeOutput(null), '');
  });
});

describe('task output: success carried with summary compat', () => {
  it('assistant response appears in output, summary kept', async () => {
    const dir = makeTempRepo();
    const executor = { async run() { return { summary: 'did the thing\nline2', sessionId: 'ses_o1', questions: [] }; } };
    const res = await core._handle(cfgFor(dir), executor, { id: 't-o1', repo: 'main', task: 'work' }, null);
    assert.equal(res.status, 'done');
    assert.equal(res.summary, 'did the thing\nline2');
    assert.equal(res.output, 'did the thing\nline2');
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('executor stdout/output preferred over summary when present', async () => {
    const dir = makeTempRepo();
    const executor = { async run() { return { summary: 'short', output: 'full stdout body', sessionId: 'ses_o2', questions: [] }; } };
    const res = await core._handle(cfgFor(dir), executor, { id: 't-o2', repo: 'main', task: 'work' }, null);
    assert.equal(res.summary, 'short');
    assert.equal(res.output, 'full stdout body');
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });
});

describe('task output: errors carried', () => {
  it('error message appears in output', async () => {
    const dir = makeTempRepo();
    const executor = { async run() { throw new Error('boom-xyz-fail'); } };
    const res = await core._handle(cfgFor(dir), executor, { id: 't-oe1', repo: 'main', task: 'work' }, null);
    assert.equal(res.status, 'error');
    assert.match(res.summary, /boom-xyz-fail/);
    assert.match(res.output, /boom-xyz-fail/);
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('error stdout/stderr appended to output', async () => {
    const dir = makeTempRepo();
    const err = new Error('cmd failed');
    err.stdout = 'partial stdout here';
    err.stderr = 'detail stderr here';
    const executor = { async run() { throw err; } };
    const res = await core._handle(cfgFor(dir), executor, { id: 't-oe2', repo: 'main', task: 'work' }, null);
    assert.match(res.output, /cmd failed/);
    assert.match(res.output, /partial stdout here/);
    assert.match(res.output, /detail stderr here/);
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });
});

describe('task output: secret-safe, no raw .env', () => {
  it('scrubs bearer, secret assignments, hex and dotenv lines', async () => {
    const dir = makeTempRepo();
    const evil = 'Authorization: Bearer abcDEF1234567890abcdef1234567890\ntoken=supersecret-value\nOPENCODE_SERVER_PASSWORD=hunter2-value\nMY_API_KEY=abcdef1234567890abcdef1234567890\nUPSTASH_TOKEN=tok123';
    const executor = { async run() { return { summary: evil, sessionId: 'ses_s', questions: [] }; } };
    const res = await core._handle(cfgFor(dir), executor, { id: 't-os1', repo: 'main', task: 'work' }, null);
    assert.ok(!res.output.includes('abcDEF1234567890abcdef1234567890'), 'bearer leaked');
    assert.ok(!res.output.includes('supersecret-value'), 'token value leaked');
    assert.ok(!res.output.includes('hunter2-value'), '.env password leaked');
    assert.ok(!res.output.includes('tok123') || res.output.includes('[redacted]'), 'token leaked without redaction');
    assert.ok(res.output.includes('[redacted]'), 'expected redaction label');
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('redacts KEY=VALUE dotenv lines but keeps key names', () => {
    const out = core.toSafeOutput('FOO=bar123\nnormal line');
    assert.match(out, /FOO=\[redacted\]/);
    assert.match(out, /normal line/);
    assert.ok(!out.includes('bar123'));
  });
});

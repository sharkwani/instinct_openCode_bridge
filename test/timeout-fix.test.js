const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const server = require('../adapters/executor-opencode-server');
const core = require('../src/core');

describe('timeout fix: generous wait', () => {
  it('default wait is generous (>=90min, was 30min)', () => {
    assert.ok(server.DEFAULT_WAIT_MS >= 90 * 60000, `DEFAULT_WAIT_MS=${server.DEFAULT_WAIT_MS}`);
  });
});

describe('timeout fix: still-running error carries session', () => {
  it('stillRunningError includes session id and open command', () => {
    const err = server.stillRunningError('ses_abc123');
    assert.equal(err.sessionId, 'ses_abc123');
    assert.equal(err.code, 'STILL_RUNNING');
    assert.match(err.message, /still running remotely/i);
    assert.match(err.message, /ses_abc123/);
    assert.match(err.message, /opencode --session ses_abc123/);
  });

  it('isWaitExhaustion detects new and legacy timeout messages', () => {
    assert.ok(server.isWaitExhaustion(server.stillRunningError('ses_x')));
    assert.ok(server.isWaitExhaustion(new Error('opencode wait timeout')));
    assert.ok(!server.isWaitExhaustion(new Error('fetch failed')));
  });

  it('openCommand formats the open instruction', () => {
    assert.equal(core.openCommand('ses_abc123'), 'opencode --session ses_abc123');
    assert.equal(core.openCommand(null), '');
  });
});

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-timeout-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('timeout fix: handle preserves session on wait exhaustion', () => {
  it('returns still_running with session id and open command', async () => {
    const dir = makeTempRepo();
    const sid = 'ses_timeout123';
    const executor = {
      async run() { throw server.stillRunningError(sid); },
    };
    const cfg = { repos: { main: dir }, task_timeout_minutes: 30 };
    const res = await core._handle(cfg, executor, { id: 't-timeout-test', repo: 'main', task: 'do work' });
    assert.equal(res.status, 'still_running');
    assert.equal(res.session_id, sid);
    assert.equal(res.open_command, `opencode --session ${sid}`);
    assert.match(res.summary, /still running remotely/i);
    assert.match(res.summary, new RegExp(sid));
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('keeps submission-time session id even for non-timeout errors', async () => {
    const dir = makeTempRepo();
    const executor = {
      async run() { const e = new Error('boom'); return Promise.reject(e); },
    };
    const cfg = { repos: { main: dir }, task_timeout_minutes: 30 };
    const res = await core._handle(cfg, executor, { id: 't-subid-test', repo: 'main', task: 'x', session_id: 'ses_sub1' });
    assert.equal(res.session_id, 'ses_sub1');
    assert.equal(res.open_command, 'opencode --session ses_sub1');
  });
});

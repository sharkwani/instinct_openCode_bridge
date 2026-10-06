const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const server = require('../adapters/executor-opencode-server');
const core = require('../src/core');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-wakeup-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

const T0 = 1791000000000;

describe('prompt wakeup: delivery verification helpers', () => {
  it('userMessageLanded detects our prompt with skew tolerance', () => {
    const data = [{ type: 'user', time: { created: T0 } }];
    assert.ok(server.userMessageLanded(data, T0));
    assert.ok(server.userMessageLanded(data, T0 + 4000));
    assert.ok(!server.userMessageLanded(data, T0 + 6000));
    assert.ok(!server.userMessageLanded([{ type: 'assistant', time: { created: T0 } }], T0));
    assert.ok(!server.userMessageLanded([], T0));
  });

  it('promptNotAcceptedError carries session and distinct code', () => {
    const err = server.promptNotAcceptedError('ses_x1');
    assert.equal(err.code, 'PROMPT_NOT_ACCEPTED');
    assert.equal(err.sessionId, 'ses_x1');
    assert.match(err.message, /prompt not accepted/);
    assert.match(err.message, /ses_x1/);
  });
});

describe('prompt wakeup: stall diagnosis on exhaustion', () => {
  it('zero new activity -> STALLED_NO_PROGRESS with hint and session', () => {
    const old = [{ type: 'idle', time: { created: T0 - 60000 } }];
    const err = server.decideExhaustion({ data: old, sid: 'ses_s1', promptAt: T0, now: T0 + 30 * 60000 });
    assert.equal(err.code, 'STALLED_NO_PROGRESS');
    assert.equal(err.sessionId, 'ses_s1');
    assert.match(err.message, /pending permission approval or question/);
    assert.match(err.message, /ses_s1/);
  });

  it('some activity but no idle -> keeps STILL_RUNNING', () => {
    const data = [
      { type: 'user', time: { created: T0 + 1000 } },
      { type: 'assistant', time: { created: T0 + 2000 }, content: [{ type: 'text', text: 'partial' }] },
    ];
    const err = server.decideExhaustion({ data, sid: 'ses_s2', promptAt: T0, now: T0 + 130 * 60000 });
    assert.equal(err.code, 'STILL_RUNNING');
    assert.equal(err.sessionId, 'ses_s2');
  });
});

describe('prompt wakeup: core maps delivery faults to failed with session', () => {
  it('PROMPT_NOT_ACCEPTED -> error with session preserved', async () => {
    const dir = makeTempRepo();
    const executor = { async run() { throw server.promptNotAcceptedError('ses_p1'); } };
    const res = await core._handle({ repos: { main: dir } }, executor, { id: 't-w1', repo: 'main', task: 'x' }, null);
    assert.equal(res.status, 'error');
    assert.equal(res.session_id, 'ses_p1');
    assert.equal(res.open_command, 'opencode --session ses_p1');
    assert.match(res.summary, /prompt not accepted/);
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('STALLED_NO_PROGRESS -> error with submission session preserved', async () => {
    const dir = makeTempRepo();
    const executor = { async run() { throw server.stalledNoProgressError(null, 31); } };
    const res = await core._handle({ repos: { main: dir } }, executor, { id: 't-w2', repo: 'main', task: 'y', session_id: 'ses_sub9' }, null);
    assert.equal(res.status, 'error');
    assert.equal(res.session_id, 'ses_sub9');
    assert.match(res.summary, /no progress/);
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('terminalEvent still maps error->failed for status push', () => {
    assert.equal(core.terminalEvent('error'), 'failed');
  });
});

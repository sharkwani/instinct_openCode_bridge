const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const status = require('../src/status');
const core = require('../src/core');
const server = require('../adapters/executor-opencode-server');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-status-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

const flush = () => new Promise((r) => setTimeout(r, 50));

function capturingSender(store, { failTimes = 0 } = {}) {
  let calls = 0;
  const send = async (event) => {
    calls++;
    if (calls <= failTimes) throw new Error('fetch failed');
    store.push(event);
  };
  send.calls = () => calls;
  return send;
}

describe('status events: shape and idempotency', () => {
  it('buildEvent includes id, session, timestamp, eventId', () => {
    const e = status.buildEvent('queued', { id: 't-1', sessionId: null });
    assert.equal(e.event, 'queued');
    assert.equal(e.id, 't-1');
    assert.equal(e.session_id, null);
    assert.equal(e.eventId, 't-1:queued');
    assert.ok(Date.parse(e.timestamp));
  });

  it('terminalEvent maps done/needs_input->done, error/still_running->failed', () => {
    assert.equal(core.terminalEvent('done'), 'done');
    assert.equal(core.terminalEvent('needs_input'), 'done');
    assert.equal(core.terminalEvent('error'), 'failed');
    assert.equal(core.terminalEvent('still_running'), 'failed');
  });
});

describe('status events: session-id propagation', () => {
  it('running carries submission-time session; done carries executor session', async () => {
    const dir = makeTempRepo();
    const events = [];
    const send = capturingSender(events);
    const executor = { async run() { return { summary: 'ok', sessionId: 'ses_new1', questions: [] }; } };
    const cfg = { repos: { main: dir }, task_timeout_minutes: 30 };
    const res = await core._handle(cfg, executor, { id: 't-sid1', repo: 'main', task: 'x', session_id: 'ses_sub1' }, send);
    await flush();
    assert.equal(res.session_id, 'ses_new1');
    const running = events.find((e) => e.event === 'running');
    assert.ok(running, 'expected running event');
    assert.equal(running.session_id, 'ses_sub1');
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('still_running failure preserves session id for failed event payload', async () => {
    const dir = makeTempRepo();
    const sid = 'ses_timeout9';
    const executor = { async run() { throw server.stillRunningError(sid); } };
    const cfg = { repos: { main: dir }, task_timeout_minutes: 30 };
    const res = await core._handle(cfg, executor, { id: 't-sid2', repo: 'main', task: 'y' }, null);
    assert.equal(res.status, 'still_running');
    assert.equal(res.session_id, sid);
    assert.equal(core.terminalEvent(res.status), 'failed');
    const failed = status.buildEvent(core.terminalEvent(res.status), { id: res.id, sessionId: res.session_id, detail: res.status, error: res.summary });
    assert.equal(failed.event, 'failed');
    assert.equal(failed.session_id, sid);
    assert.match(failed.error, new RegExp(sid));
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });
});

describe('status events: delivery failures and retry', () => {
  it('emit retries then delivers (bounded)', async () => {
    const events = [];
    const send = capturingSender(events, { failTimes: 2 });
    await status.emit(send, status.buildEvent('queued', { id: 't-r1' }));
    assert.equal(send.calls(), 3);
    assert.equal(events.length, 1);
  });

  it('emit drops after max attempts without throwing', async () => {
    const events = [];
    const send = capturingSender(events, { failTimes: 99 });
    await status.emit(send, status.buildEvent('running', { id: 't-r2' }));
    assert.equal(send.calls(), status.MAX_ATTEMPTS);
    assert.equal(events.length, 0);
  });

  it('notify never throws and handle completes when sender fails', async () => {
    const dir = makeTempRepo();
    assert.doesNotThrow(() => status.notify(null, { eventId: 'x' }));
    assert.doesNotThrow(() => status.notify(async () => { throw new Error('boom'); }, { eventId: 'y' }));
    const bad = async () => { throw new Error('status down'); };
    const executor = { async run() { return { summary: 'ok', sessionId: 'ses_ok', questions: [] }; } };
    const cfg = { repos: { main: dir }, task_timeout_minutes: 30 };
    const res = await core._handle(cfg, executor, { id: 't-r3', repo: 'main', task: 'z' }, bad);
    await flush();
    assert.equal(res.status, 'done');
    assert.equal(res.session_id, 'ses_ok');
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });
});

describe('status events: no secrets or private content', () => {
  it('scrubs bearer tokens and secret assignments, truncates', () => {
    const evil = 'Authorization: Bearer abcDEF1234567890abcdef\ntoken: supersecretvalue\ntask body here';
    const e = status.buildEvent('failed', { id: 't-s1', error: evil + 'x'.repeat(2000) });
    assert.ok(!e.error.includes('abcDEF1234567890abcdef'));
    assert.ok(!e.error.includes('supersecretvalue'));
    assert.ok(e.error.length <= status.MAX_TEXT);
  });

  it('never echoes task text or config: handle events carry only safe summary', async () => {
    const dir = makeTempRepo();
    const events = [];
    const send = capturingSender(events);
    const secretTask = 'do thing with Bearer mytoken1234567890abcdef1234567890';
    const executor = { async run() { return { summary: 'fine Bearer shouldnotleak ' + 'y'.repeat(100), sessionId: 'ses_s1', questions: [] }; } };
    const cfg = { repos: { main: dir }, task_timeout_minutes: 30, bridge_secret: 'shh', upstash_token: 'tok' };
    await core._handle(cfg, executor, { id: 't-s2', repo: 'main', task: secretTask }, send);
    await flush();
    for (const e of events) {
      assert.ok(!JSON.stringify(e).includes(secretTask.slice(0, 20)) || e.event === 'running');
      assert.ok(!JSON.stringify(e).includes('shh'));
    }
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });
});

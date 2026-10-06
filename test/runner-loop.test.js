const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const core = require('../src/core');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-loop-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

// In-memory queue source: next() dequeues, sendResult records.
function mockSource(tasks, { failSendOnce = false } = {}) {
  const queue = tasks.map((t) => ({ secret: 's3cret', repo: 'main', ...t }));
  const sent = [];
  const statuses = [];
  let sends = 0;
  return {
    sent,
    statuses,
    async next() { return queue.length ? queue.shift() : null; },
    async sendResult(r) {
      sends++;
      if (failSendOnce && sends === 1) throw new Error('transport down');
      sent.push(r);
    },
    async sendStatus(e) { statuses.push(e); },
  };
}

function mockExecutor({ delayMs = 5, failIds = [] } = {}) {
  const started = [];
  let active = 0;
  let maxActive = 0;
  return {
    started,
    maxActive: () => maxActive,
    async run({ task, cwd, sessionId }) {
      started.push(task);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      if (failIds.includes(task)) throw new Error('boom-' + task);
      return { summary: 'did ' + task, sessionId: sessionId || 'ses_mock', questions: [] };
    },
  };
}

let logged = [];
const origLog = console.log;
function captureLogs() {
  logged = [];
  console.log = (...a) => { logged.push(a.join(' ')); };
}
afterEach(() => { console.log = origLog; });

const cfgFor = (dir) => ({ bridge_secret: 's3cret', repos: { main: dir }, task_timeout_minutes: 30 });

describe('runner loop: every queued task is picked up, one at a time', () => {
  it('three queued tasks all run in order with a pickup log each', async () => {
    const dir = makeTempRepo();
    const source = mockSource([{ id: 't-a', task: 'a' }, { id: 't-b', task: 'b' }, { id: 't-c', task: 'c' }]);
    const executor = mockExecutor();
    captureLogs();
    const r1 = await core.runOnce(cfgFor(dir), source, executor);
    const r2 = await core.runOnce(cfgFor(dir), source, executor);
    const r3 = await core.runOnce(cfgFor(dir), source, executor);
    const r4 = await core.runOnce(cfgFor(dir), source, executor);
    console.log = origLog;
    assert.equal(r1.id, 't-a');
    assert.equal(r2.id, 't-b');
    assert.equal(r3.id, 't-c');
    assert.equal(r4, null, 'empty queue returns null');
    assert.deepEqual(executor.started, ['a', 'b', 'c']);
    assert.equal(executor.maxActive(), 1, 'never concurrent');
    assert.equal(source.sent.length, 3);
    for (const id of ['t-a', 't-b', 't-c']) {
      assert.ok(logged.some((l) => l.includes('pickup task') && l.includes(id)), `missing pickup log for ${id}`);
    }
    const queued = source.statuses.filter((e) => e.event === 'queued').map((e) => e.id);
    assert.deepEqual(queued, ['t-a', 't-b', 't-c']);
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('a transport failure on one task does not wedge later tasks', async () => {
    const dir = makeTempRepo();
    const source = mockSource([{ id: 't-1', task: 'one' }, { id: 't-2', task: 'two' }], { failSendOnce: true });
    const executor = mockExecutor();
    captureLogs();
    await assert.rejects(core.runOnce(cfgFor(dir), source, executor), /transport down/);
    const r2 = await core.runOnce(cfgFor(dir), source, executor);
    console.log = origLog;
    assert.equal(r2.id, 't-2');
    assert.deepEqual(executor.started, ['one', 'two']);
    assert.ok(logged.some((l) => l.includes('pickup task') && l.includes('t-2')));
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('a failing task still publishes its error result and the loop continues', async () => {
    const dir = makeTempRepo();
    const source = mockSource([{ id: 't-x', task: 'bad' }, { id: 't-y', task: 'good' }]);
    const executor = mockExecutor({ failIds: ['bad'] });
    captureLogs();
    const r1 = await core.runOnce(cfgFor(dir), source, executor);
    const r2 = await core.runOnce(cfgFor(dir), source, executor);
    console.log = origLog;
    assert.equal(r1.status, 'error');
    assert.equal(r2.status, 'done');
    assert.equal(source.sent.length, 2);
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });
});

describe('runner loop: queue pop cannot hang forever', () => {
  it('source adapter bounds every Upstash call with an abort signal', async () => {
    const realFetch = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = opts;
      return { ok: true, json: async () => ({ result: null }) };
    };
    try {
      const create = require('../adapters/source-upstash').create;
      const source = create({ upstash_url: 'https://example.invalid', upstash_token: 'x', poll_seconds: 25 });
      await source.next();
      assert.ok(captured && captured.signal, 'fetch must carry an abort signal');
      assert.equal(typeof captured.signal.aborted, 'boolean');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

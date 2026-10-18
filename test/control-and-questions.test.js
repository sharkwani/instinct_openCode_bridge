'use strict';
// New behavior: opencode error detail, question/form surfacing, and the
// set_model/get_model control channel. Pure helpers + core with mocks; no live
// opencode server and no external queue.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const core = require('../src/core');
const status = require('../src/status');
const server = require('../adapters/executor-opencode-server');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cq-test-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}
const flush = () => new Promise((r) => setTimeout(r, 60));

describe('model ref parsing and matching', () => {
  it('parses provider/model and optional #variant', () => {
    assert.deepEqual(server.parseModelRef('opencode/deepseek-v4.1-flash-free'),
      { id: 'deepseek-v4.1-flash-free', providerID: 'opencode' });
    assert.deepEqual(server.parseModelRef('openrouter/anthropic/claude-4'),
      { id: 'anthropic/claude-4', providerID: 'openrouter' });
    assert.deepEqual(server.parseModelRef('opencode/x#fast'),
      { id: 'x', providerID: 'opencode', variant: 'fast' });
    assert.equal(server.parseModelRef('no-slash'), null);
    assert.equal(server.parseModelRef(''), null);
    assert.equal(server.parseModelRef(null), null);
  });

  it('matches a config string against GET /api/model rows (id or modelID)', () => {
    const list = [
      { id: 'deepseek-v4.1-flash-free', modelID: 'ds-v41', providerID: 'opencode' },
      { id: 'claude-4', modelID: 'claude-4', providerID: 'anthropic' },
    ];
    assert.ok(core.modelMatchesList(list, 'opencode/deepseek-v4.1-flash-free'));
    assert.ok(core.modelMatchesList(list, 'opencode/ds-v41'));
    assert.ok(!core.modelMatchesList(list, 'opencode/nope'));
    assert.ok(!core.modelMatchesList(list, 'anthropic/deepseek-v4.1-flash-free'));
  });
});

describe('opencode errors are surfaced with detail', () => {
  it('formatStructuredError renders type: message', () => {
    const s = server.formatStructuredError({ type: 'provider.no-route', message: 'Model unavailable: opencode/nope' });
    assert.match(s, /provider\.no-route/);
    assert.match(s, /Model unavailable/);
  });

  it('turnFailedError carries the provider error instead of a bare outcome', () => {
    const err = server.turnFailedError('ses_x', {
      outcome: 'failed',
      error: { type: 'provider.no-route', message: 'Model unavailable: opencode/nope' },
    });
    assert.equal(err.code, 'TURN_FAILED');
    assert.equal(err.sessionId, 'ses_x');
    assert.match(err.message, /turn failed/);
    assert.match(err.message, /ses_x/);
    assert.match(err.message, /Model unavailable: opencode\/nope/);
  });

  it('core _handle maps a detailed turn failure into summary+output', async () => {
    const dir = makeTempRepo();
    const executor = { async run() { throw server.turnFailedError('ses_e1', { outcome: 'interrupted', error: { type: 'x', message: 'user aborted' } }); } };
    const res = await core._handle({ repos: { main: dir } }, executor, { id: 't-err1', repo: 'main', task: 'x' }, null);
    assert.equal(res.status, 'error');
    assert.equal(res.session_id, 'ses_e1');
    assert.match(res.summary, /user aborted/);
    assert.match(res.output, /user aborted/);
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });
});

describe('questions / forms become needs_input', () => {
  const form = {
    id: 'frm_1',
    title: 'Which environment should I deploy to?',
    fields: [
      { key: 'env', type: 'string', title: 'Environment', options: [{ value: 'staging', label: 'Staging' }, { value: 'prod', label: 'Prod' }] },
    ],
  };

  it('formQuestions and buildQuestionText include title and fields', () => {
    const qs = server.formQuestions(form);
    assert.equal(qs[0], 'Which environment should I deploy to?');
    assert.match(qs[1], /Environment/);
    assert.match(qs[1], /Staging/);
    assert.match(server.buildQuestionText(form), /Answer with a new task on this same session/);
  });

  it('answerForForm maps single-field free text and option matches', () => {
    assert.deepEqual(server.answerForForm(form, 'staging'), { env: 'staging' });
    assert.deepEqual(server.answerForForm(form, 'please use Prod'), { env: 'prod' });
  });

  it('coerceField handles boolean/number/multiselect', () => {
    assert.equal(server.coerceField({ type: 'boolean' }, 'yes'), true);
    assert.equal(server.coerceField({ type: 'boolean' }, 'no'), false);
    assert.equal(server.coerceField({ type: 'integer' }, '42'), 42);
    assert.deepEqual(server.coerceField({ type: 'multiselect', options: [{ value: 'a' }, { value: 'b' }] }, 'a, b'), ['a', 'b']);
  });

  it('questionsFromText finds a trailing question', () => {
    const qs = server.questionsFromText('Done so far.\n\nShould I also update the docs?');
    assert.deepEqual(qs, ['Should I also update the docs?']);
    assert.deepEqual(server.questionsFromText('No questions here.'), []);
  });

  it('runOnce returns needs_input and status event carries the questions', async () => {
    const dir = makeTempRepo();
    const question = server.buildQuestionText(form);
    const executor = { async run() { return { summary: question, output: question, sessionId: 'ses_q1', questions: server.formQuestions(form) }; } };
    const statuses = [];
    let posted = null;
    let queued = [{ id: 't-q1', repo: 'main', task: 'do it', secret: 's3cret' }];
    const source = {
      next: async () => queued.shift() || null,
      sendResult: async (r) => { posted = r; },
      sendStatus: async (e) => { statuses.push(e); },
    };
    const res = await core.runOnce({ bridge_secret: 's3cret', repos: { main: dir }, task_timeout_minutes: 30 }, source, executor);
    assert.equal(res.status, 'needs_input');
    assert.ok(res.questions.length >= 1);
    assert.equal(posted.status, 'needs_input');
    await flush();
    const done = statuses.find((e) => e.event === 'done');
    assert.ok(done, 'expected terminal done event');
    assert.equal(done.detail, 'needs_input');
    assert.ok(Array.isArray(done.questions) && done.questions.length >= 1, 'status event carries questions');
    execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: dir });
  });

  it('status.buildEvent caps and scrubs questions', () => {
    const e = status.buildEvent('done', { id: 't', detail: 'needs_input', questions: ['ok?', 'Bearer abcDEF1234567890abcdef?'] });
    assert.equal(e.questions.length, 2);
    assert.ok(!e.questions[1].includes('abcDEF1234567890abcdef'));
    const many = status.buildEvent('done', { id: 't', questions: Array.from({ length: 25 }, (_, i) => 'q' + i) });
    assert.ok(many.questions.length <= status.MAX_QUESTIONS);
  });
});

describe('control tasks: set_model / get_model', () => {
  let cfgFile;
  beforeEach(() => {
    cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cfg-')), 'bridge.config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ model: 'opencode/old', bridge_secret: 's3cret' }) + '\n', { mode: 0o600 });
  });

  it('set_model mutates cfg, persists, and acks', async () => {
    const cfg = { model: 'opencode/old', bridge_secret: 's3cret', repos: {} };
    const res = await core.handleControl(cfg, { id: 'c1', action: 'set_model', model: 'opencode/new' }, { configPath: cfgFile });
    assert.equal(res.status, 'done');
    assert.equal(res.model, 'opencode/new');
    assert.equal(cfg.model, 'opencode/new');
    assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).model, 'opencode/new');
  });

  it('set_model rejects an unknown model when a list is available', async () => {
    const cfg = { model: 'opencode/old', repos: {} };
    const res = await core.handleControl(cfg, { id: 'c2', action: 'set_model', model: 'opencode/nope' }, {
      configPath: cfgFile,
      listModels: async () => [{ id: 'real', modelID: 'real', providerID: 'opencode' }],
    });
    assert.equal(res.status, 'error');
    assert.match(res.summary, /unknown model/);
    assert.equal(cfg.model, 'opencode/old', 'cfg untouched on rejection');
  });

  it('get_model reports the current model', async () => {
    const cfg = { model: 'opencode/current' };
    const res = await core.handleControl(cfg, { id: 'c3', action: 'get_model' }, {});
    assert.equal(res.status, 'done');
    assert.equal(res.model, 'opencode/current');
  });

  it('list_models returns provider/model strings', async () => {
    const res = await core.handleControl({}, { id: 'c3b', action: 'list_models' }, {
      listModels: async () => [
        { id: 'b', modelID: 'b', providerID: 'opencode' },
        { id: 'a', modelID: 'a', providerID: 'anthropic' },
      ],
    });
    assert.equal(res.status, 'done');
    assert.deepEqual(res.models, ['anthropic/a', 'opencode/b']);
  });

  it('unknown action fails cleanly', async () => {
    const res = await core.handleControl({}, { id: 'c4', action: 'nope' }, {});
    assert.equal(res.status, 'error');
    assert.match(res.summary, /unknown action/);
  });

  it('runOnce routes a control task and acks over result + status', async () => {
    const cfg = { model: 'opencode/old', bridge_secret: 's3cret', repos: {} };
    const task = { id: 'c5', action: 'set_model', model: 'opencode/new', secret: 's3cret' };
    let queued = [task];
    let posted = null;
    const statuses = [];
    const source = {
      next: async () => queued.shift() || null,
      sendResult: async (r) => { posted = r; },
      sendStatus: async (e) => { statuses.push(e); },
    };
    const res = await core.runOnce(cfg, source, { run: async () => { throw new Error('executor must not run for control'); } }, { configPath: cfgFile });
    assert.equal(res.status, 'done');
    assert.equal(res.model, 'opencode/new');
    assert.equal(cfg.model, 'opencode/new');
    assert.ok(posted && posted.id === 'c5');
    await flush();
    assert.ok(statuses.some((e) => e.event === 'done' && e.id === 'c5'));
  });
});

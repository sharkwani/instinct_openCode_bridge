'use strict';
// Public redaction proof: isolated synthetic only. No real config/env/queue/history/results reads.
// Exercises ACTUAL public src/core.js + src/status.js + adapters with mocked executor/source,
// real HTTP port0, temp git/cwd/cache/results. Seed fixtures skipEnv:true.
// Safe asserts: boolean labels only, never dumps secrets.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const san = require('../src/sanitizer.js');
const core = require('../src/core.js');
const status = require('../src/status.js');

// ---- synthetic fixtures (clearly fake, deterministic) ----
const SYN_RAW = 'synth-pub-ABCDEF1234567890XYZabc123';
const SYN_BEARER_INNER = 'synth-pub-bearer-ABCDEF1234567890XYZq';
const SYN_BEARER = 'Bearer ' + SYN_BEARER_INNER;
const SYN_USERPASS_B64 = Buffer.from('synthuser:synthpass1234567890').toString('base64');
const SYN_BASIC = 'Basic ' + SYN_USERPASS_B64;
const SYN_B64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5QUJDREVG';
const SYN_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aC1zeW50aCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
const SYN_AKIA = 'AKIASYNTHPUB1234567';
const SYN_REG = 'reg-pub-embedded-ABCDEF1234567890';
const OLD_FAKE = 'test-secret';
const COMMIT_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const JOB_ID = 't-pub-synth-001';
const SESSION_ID = 'sess-pub-abc123';
const BALANCE_TXT = 'balance $1,234.56 count 42 tasks';
const BRIDGE_SECRET = 'synth-pub-bridge-9999';

const SYN_CFG = {
  synthetic_token: SYN_REG,
  synthetic_secret: SYN_RAW,
  extra_api_key: OLD_FAKE,
  bearer_token: SYN_BEARER_INNER,
};

function absent(hay, needle, label) {
  assert.ok(!String(hay).includes(needle), label + '-absence');
}
function markerPresent(hay, label) {
  assert.ok(String(hay).includes('[REDACTED') || String(hay).includes('[redacted]'), label + '-marker');
}

beforeEach(() => {
  san._resetRegistryForTests();
  san.loadSecretRegistry(SYN_CFG, { skipEnv: true });
});

let tmpDirs = [];
let servers = [];
let origLog = console.log;
let logLines = [];

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'synth@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'synth'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'synth\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}
function mkTmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-http-'));
  tmpDirs.push(dir);
  return path.join(dir, 'results.jsonl');
}
function waitListening(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
}
function closeServer(s) {
  return new Promise((res) => s.close(() => res()));
}
async function pollGet(base, id, secs = 10) {
  const end = Date.now() + secs * 1000;
  while (Date.now() < end) {
    const r = await fetch(base + '/results/' + encodeURIComponent(id), { headers: { 'X-Bridge-Secret': BRIDGE_SECRET } });
    const j = await r.json();
    if (j && (j.status === 'done' || j.status === 'error' || j.status === 'needs_input' || j.status === 'still_running')) return j;
    await new Promise((x) => setTimeout(x, 200));
  }
  throw new Error('poll timeout');
}

const _before = beforeEach;
const _after = afterEach;
_after(async () => {
  console.log = origLog;
  for (const s of servers) { try { await closeServer(s); } catch {} }
  servers = [];
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  tmpDirs = [];
  san._resetRegistryForTests();
});
_before(() => {
  logLines = [];
  console.log = (...a) => { logLines.push(a.map(String).join(' ')); };
});

// ---- sanitizer unit (ported, public preserved) ----
test('pub no canary exemption exports remain', () => {
  assert.ok(san.CANARY_FIXTURES === undefined, 'no-canary-export');
  assert.ok(typeof san.isCanary === 'undefined', 'no-isCanary-export');
});

test('pub raw registered secret in prose redacted', () => {
  const s = san.sanitizeString('deployed prose ' + SYN_RAW + ' end');
  absent(s, SYN_RAW, 'raw');
  markerPresent(s, 'raw');
});

test('pub old fake value when registered does NOT bypass', () => {
  const s = san.sanitizeString('prefix ' + OLD_FAKE + ' suffix');
  absent(s, OLD_FAKE, 'fake');
  markerPresent(s, 'fake');
});

test('pub Basic auth redacted', () => {
  const s = san.sanitizeString('Authorization: ' + SYN_BASIC + ' ok');
  absent(s, SYN_USERPASS_B64, 'basic');
  markerPresent(s, 'basic');
});

test('pub Bearer redacted', () => {
  const s = san.sanitizeString('call with ' + SYN_BEARER + ' ok');
  absent(s, SYN_BEARER_INNER, 'bearer');
  markerPresent(s, 'bearer');
});

test('pub long base64 redacted but commit SHA preserved', () => {
  const s = san.sanitizeString('blob ' + SYN_B64 + ' sha ' + COMMIT_SHA);
  absent(s, SYN_B64, 'b64');
  markerPresent(s, 'b64');
  assert.ok(s.includes(COMMIT_SHA), 'sha-preserved');
});

test('pub secret key fields redacted', () => {
  const s = san.sanitizeString('api_key=' + SYN_RAW + ' done');
  absent(s, SYN_RAW, 'kv');
  markerPresent(s, 'kv');
});

test('pub nested arrays and objects redacted', () => {
  const obj = { summary: 'hi ' + SYN_RAW, nested: [{ token: SYN_BEARER_INNER }, ['x', SYN_B64]] };
  const out = san.sanitizeObject(obj);
  const j = JSON.stringify(out);
  absent(j, SYN_RAW, 'nest-raw');
  absent(j, SYN_BEARER_INNER, 'nest-bearer');
  absent(j, SYN_B64, 'nest-b64');
  markerPresent(j, 'nest');
});

test('pub Error objects and multiline secrets redacted', () => {
  const e = new Error('fail line1\nsecret ' + SYN_RAW + '\nline3 ' + SYN_USERPASS_B64);
  const out = san.sanitizeObject({ error: e, summary: 'a\n' + SYN_BEARER + '\nb' });
  const j = JSON.stringify(out);
  absent(j, SYN_RAW, 'err-raw');
  absent(j, SYN_USERPASS_B64, 'err-b64');
  absent(j, SYN_BEARER_INNER, 'err-bearer');
  markerPresent(j, 'err');
});

test('pub JWT and AWS key redacted', () => {
  const a = san.sanitizeString('jwt ' + SYN_JWT);
  absent(a, SYN_JWT, 'jwt');
  markerPresent(a, 'jwt');
  const b = san.sanitizeString('key ' + SYN_AKIA + ' end');
  absent(b, SYN_AKIA, 'akia');
  markerPresent(b, 'akia');
});

test('pub sanitizeResult preserves public output/open_command ids', () => {
  const r = san.sanitizeResult({
    id: JOB_ID, status: 'done', branch: 'bridge/x', session_id: SESSION_ID,
    summary: 'out ' + SYN_REG + ' ok', output: 'full ' + SYN_RAW, open_command: 'opencode --session ' + SESSION_ID,
    diffstat: '1 file', questions: ['q ' + SYN_RAW + '?'], error: null,
  });
  const j = JSON.stringify(r);
  absent(j, SYN_REG, 'res-reg');
  absent(j, SYN_RAW, 'res-raw');
  markerPresent(j, 'res');
  assert.ok(r.id === JOB_ID, 'res-id');
  assert.ok(r.session_id === SESSION_ID, 'res-session');
  assert.ok(r.open_command.includes(SESSION_ID), 'res-open');
  assert.ok(typeof r.output === 'string', 'res-output');
});

test('pub idempotent', () => {
  const once = san.sanitizeResult({ id: JOB_ID, status: 'done', summary: 'v ' + SYN_RAW, output: 'v ' + SYN_RAW, questions: [] });
  const twice = san.sanitizeResult(once);
  assert.ok(JSON.stringify(once) === JSON.stringify(twice), 'idempotent');
  absent(JSON.stringify(twice), SYN_RAW, 'idem');
});

test('pub ids counts balance preserved', () => {
  const out = san.sanitizeObject({ id: JOB_ID, sha: COMMIT_SHA, note: BALANCE_TXT, count: 42 });
  assert.ok(out.id === JOB_ID, 'keep-id');
  assert.ok(String(out.sha).includes(COMMIT_SHA), 'keep-sha');
  assert.ok(String(out.note).includes(BALANCE_TXT), 'keep-balance');
  assert.ok(out.count === 42, 'keep-count');
});

test('pub short secret-key field redacted even when short', () => {
  const SHORT_VAL = 's3cr3t-x7';
  san._resetRegistryForTests();
  san.loadSecretRegistry({ apiKey: SHORT_VAL }, { skipEnv: true });
  const out = san.sanitizeObject({ apiKey: SHORT_VAL, nested: { password: SHORT_VAL, authorization: SHORT_VAL } });
  absent(JSON.stringify(out), SHORT_VAL, 'short');
  markerPresent(JSON.stringify(out), 'short');
  const out2 = san.sanitizeObject({ upstash_token: SHORT_VAL, basic_auth: SHORT_VAL });
  absent(JSON.stringify(out2), SHORT_VAL, 'short-alias');
});

test('pub encoded known credential decoded password prose redacted', () => {
  const user = 'synthuser2';
  const pass = 'synthpass-decoded-7890XYZ';
  const full = user + ':' + pass;
  const enc = Buffer.from(full, 'utf8').toString('base64');
  san._resetRegistryForTests();
  san.loadSecretRegistry({ basic_auth: enc }, { skipEnv: true });
  const reg = san.getSecretRegistry();
  assert.ok(reg.has(enc), 'reg-enc');
  assert.ok(reg.has(full), 'reg-full');
  assert.ok(reg.has(pass), 'reg-pass');
  const s1 = san.sanitizeString('leak decoded ' + full + ' end');
  absent(s1, full, 'dec-full');
  absent(s1, pass, 'dec-pass');
  markerPresent(s1, 'dec');
  const s3 = san.sanitizeString('auth Basic ' + enc + ' ok');
  absent(s3, enc, 'dec-enc');
  markerPresent(s3, 'dec-enc');
});

test('pub overlap longer secrets first', () => {
  const LONG_V = 'overlap-pub-ABCDEF1234567890XYZ-long';
  const SHORT_V = 'ABCDEF1234567890';
  san._resetRegistryForTests();
  san.loadSecretRegistry({ synthetic_secret: LONG_V, other_token: SHORT_V }, { skipEnv: true });
  const s = san.sanitizeString('combo ' + LONG_V + ' end');
  absent(s, LONG_V, 'overlap-long');
  absent(s, SHORT_V, 'overlap-short');
  markerPresent(s, 'overlap');
});

test('pub nested config secrets recursed', () => {
  const NESTED_S = 'nested-pub-ABCDEF1234567890XYZ';
  san._resetRegistryForTests();
  san.loadSecretRegistry({ outer: { inner: { upstash_token: NESTED_S } } }, { skipEnv: true });
  assert.ok(san.getSecretRegistry().has(NESTED_S), 'nested-reg');
  absent(san.sanitizeString('val ' + NESTED_S), NESTED_S, 'nested');
});

test('pub registered hex redacted while unregistered sha preserved', () => {
  const HEX_S = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  san._resetRegistryForTests();
  san.loadSecretRegistry({ hex_secret: HEX_S }, { skipEnv: true });
  const s = san.sanitizeString('hex ' + HEX_S + ' sha ' + COMMIT_SHA);
  absent(s, HEX_S, 'hex-reg');
  markerPresent(s, 'hex-reg');
  assert.ok(s.includes(COMMIT_SHA), 'hex-sha');
});

test('pub metric numeric tokens preserved while secret numerics redacted', () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry({}, { skipEnv: true });
  const out = san.sanitizeObject({ input_tokens: 42, output_tokens: 7, token_count: 49, password: 123, auth_token: 123 });
  assert.ok(out.input_tokens === 42, 'metric-in');
  assert.ok(out.output_tokens === 7, 'metric-out');
  assert.ok(out.token_count === 49, 'metric-count');
  assert.ok(out.password === '[REDACTED]', 'secret-pwd-num');
  assert.ok(out.auth_token === '[REDACTED]', 'secret-auth-num');
});

// ---- public-specific: toSafeOutput + handle output/open_command ----
test('pub toSafeOutput caps 12KB and redacts registry', () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry({ synthetic_secret: SYN_RAW }, { skipEnv: true });
  assert.ok(core.toSafeOutput('hi ' + SYN_RAW).includes('[REDACTED') || core.toSafeOutput('hi ' + SYN_RAW).includes('[redacted]'), 'out-marker');
  absent(core.toSafeOutput('hi ' + SYN_RAW), SYN_RAW, 'out-raw');
  const big = 'x'.repeat(13 * 1024);
  assert.ok(core.toSafeOutput(big).match(/truncated/i), 'out-trunc');
});

test('pub _handle unmasked executor => sanitized boundary, keeps session/open/output', async () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry(SYN_CFG, { skipEnv: true });
  const repo = mkGitRepo();
  const evil = 'leak ' + SYN_RAW + ' ' + SYN_BEARER + ' ' + SYN_BASIC + ' b64 ' + SYN_B64;
  const mockExec = { run: async () => ({ sessionId: SESSION_ID, summary: evil, output: evil, questions: [] }) };
  const events = [];
  const send = async (e) => { events.push(e); };
  const cfg = { bridge_secret: BRIDGE_SECRET, repos: { r1: repo }, task_timeout_minutes: 1 };
  const res = await core._handle(cfg, mockExec, { id: JOB_ID + '-h', repo: 'r1', task: 'synth' }, send);
  const j = JSON.stringify(res);
  absent(j, SYN_RAW, 'h-raw');
  absent(j, SYN_BEARER_INNER, 'h-bearer');
  absent(j, SYN_USERPASS_B64, 'h-basic');
  markerPresent(j, 'h');
  assert.ok(res.session_id === SESSION_ID, 'h-session');
  assert.ok(String(res.open_command).includes(SESSION_ID), 'h-open');
  assert.ok(typeof res.output === 'string', 'h-output');
  await new Promise((r) => setTimeout(r, 60));
  const ej = JSON.stringify(events);
  absent(ej, SYN_RAW, 'h-status-raw');
  const logs = logLines.join('\n');
  absent(logs, SYN_RAW, 'h-log-raw');
  execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: repo });
});

test('pub _handle failure sanitized, logs status only', async () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry(SYN_CFG, { skipEnv: true });
  const repo = mkGitRepo();
  const mockFail = { run: async () => { throw new Error('boom ' + SYN_RAW); } };
  const cfg = { bridge_secret: BRIDGE_SECRET, repos: { r1: repo }, task_timeout_minutes: 1 };
  const res = await core._handle(cfg, mockFail, { id: JOB_ID + '-f', repo: 'r1', task: 'synth' }, null);
  absent(JSON.stringify(res), SYN_RAW, 'f-raw');
  markerPresent(JSON.stringify(res), 'f');
  absent(logLines.join('\n'), SYN_RAW, 'f-log');
  execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: repo });
});

// ---- public HTTP boundary: real port0 routes ----
test('pub HTTP completion + GET JSON + view HTML + persist + status capture', async () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry(
    { http_token: SYN_RAW, short_api_key: 'h7-short-x9', hex_secret: 'cafebabecafebabecafebabecafebabecafebabe', bridge_secret: BRIDGE_SECRET },
    { skipEnv: true }
  );
  const repo = mkGitRepo();
  const resultsFile = mkTmpFile();
  const statusEvents = [];
  const statusSend = async (e) => { statusEvents.push(e); };
  const evilSummary = 'leak ' + SYN_RAW + ' <b>tag</b> & amp sha ' + COMMIT_SHA;
  const mockExec = { run: async () => ({ sessionId: SESSION_ID, summary: evilSummary, output: evilSummary, questions: [] }) };
  const cfg = { bridge_secret: BRIDGE_SECRET, repos: { r1: repo }, task_timeout_minutes: 1 };
  const { server } = core.startHttp(cfg, { executor: mockExec, resultsFile, port: 0, statusSend });
  servers.push(server);
  await waitListening(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  const id = JOB_ID + '-http-a';
  const pr = await fetch(base + '/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, repo: 'r1', task: 'do synth', secret: BRIDGE_SECRET }),
  });
  assert.ok(pr.ok, 'post-accepted');
  const done = await pollGet(base, id);
  const dj = JSON.stringify(done);
  absent(dj, SYN_RAW, 'http-raw');
  markerPresent(dj, 'http');
  assert.ok(done.id === id, 'http-id');
  assert.ok(String(done.open_command).includes(SESSION_ID) || done.session_id === SESSION_ID, 'http-session');
  assert.ok(dj.includes(COMMIT_SHA), 'http-sha');
  // GET /results JSON list
  const lr = await fetch(base + '/results?secret=' + encodeURIComponent(BRIDGE_SECRET));
  const lj = await lr.json();
  absent(JSON.stringify(lj), SYN_RAW, 'list-raw');
  // POST /results/view HTML escape
  const vr = await fetch(base + '/results/view', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, secret: BRIDGE_SECRET }),
  });
  const html = await vr.text();
  assert.ok(vr.ok, 'view-ok');
  absent(html, SYN_RAW, 'view-raw');
  markerPresent(html, 'view');
  assert.ok(!html.includes('<b>'), 'view-escaped');
  // persistence redacted
  absent(fs.readFileSync(resultsFile, 'utf8'), SYN_RAW, 'persist-raw');
  markerPresent(fs.readFileSync(resultsFile, 'utf8'), 'persist');
  // status publishes redacted, carry session
  await new Promise((r) => setTimeout(r, 80));
  const sj = JSON.stringify(statusEvents);
  absent(sj, SYN_RAW, 'status-raw');
  assert.ok(statusEvents.some((e) => e.event === 'queued'), 'status-queued');
  assert.ok(statusEvents.some((e) => e.event === 'done'), 'status-done');
  absent(logLines.join('\n'), SYN_RAW, 'http-log-raw');
});

test('pub HTTP cached file load synthetic history only redacted', async () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry({ http_token: SYN_RAW, bridge_secret: BRIDGE_SECRET }, { skipEnv: true });
  const repo = mkGitRepo();
  const resultsFile = mkTmpFile();
  fs.writeFileSync(resultsFile, JSON.stringify({ id: 't-cached-pub-1', status: 'done', summary: 'cached ' + SYN_RAW, output: SYN_RAW, diffstat: COMMIT_SHA }) + '\n');
  const mockExec = { run: async () => ({ sessionId: 's', summary: 'ok', questions: [] }) };
  const cfg = { bridge_secret: BRIDGE_SECRET, repos: { r1: repo } };
  const { server } = core.startHttp(cfg, { executor: mockExec, resultsFile, port: 0 });
  servers.push(server);
  await waitListening(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(base + '/results/t-cached-pub-1', { headers: { 'X-Bridge-Secret': BRIDGE_SECRET } });
  const j = await r.json();
  absent(JSON.stringify(j), SYN_RAW, 'cached-raw');
  markerPresent(JSON.stringify(j), 'cached');
  assert.ok(JSON.stringify(j).includes(COMMIT_SHA), 'cached-sha');
});

test('pub runOnce queue + upstash mock publish no external queue', async () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry(SYN_CFG, { skipEnv: true });
  const repo = mkGitRepo();
  const cfg = { bridge_secret: BRIDGE_SECRET, repos: { r1: repo }, task_timeout_minutes: 1 };
  const mockExec = { run: async () => ({ sessionId: SESSION_ID, summary: 'up ' + SYN_RAW, output: SYN_RAW, questions: [] }) };
  const task = { id: JOB_ID + '-q', repo: 'r1', task: 't', secret: BRIDGE_SECRET, session_id: null };
  let queued = [task];
  let postedResult = null;
  let postedStatus = [];
  const mockSource = {
    next: async () => queued.shift() || null,
    sendResult: async (res) => { postedResult = JSON.stringify(res); },
    sendStatus: async (ev) => { postedStatus.push(ev); },
  };
  const res = await core.runOnce(cfg, mockSource, mockExec);
  absent(JSON.stringify(res), SYN_RAW, 'q-raw');
  markerPresent(JSON.stringify(res), 'q');
  assert.ok(postedResult !== null, 'q-posted');
  absent(postedResult, SYN_RAW, 'q-up-raw');
  absent(JSON.stringify(postedStatus), SYN_RAW, 'q-status-raw');
  execFileSync('git', ['switch', '--detach', 'HEAD'], { cwd: repo });
});

test('pub legacy ingress adapter real HTTP sanitized', async () => {
  san._resetRegistryForTests();
  san.loadSecretRegistry({ http_token: SYN_RAW, bridge_secret: BRIDGE_SECRET }, { skipEnv: true });
  const resultsFile = mkTmpFile();
  const { startHttpIngress } = require('../adapters/http-ingress.js');
  const runTask = async () => ({ summary: 'legacy ' + SYN_RAW });
  const { server } = startHttpIngress({ secret: BRIDGE_SECRET, port: 0, runTask, resultsFile });
  servers.push(server);
  await waitListening(server);
  const base = 'http://127.0.0.1:' + server.address().port;
  const id = JOB_ID + '-legacy';
  const pr = await fetch(base + '/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Bridge-Secret': BRIDGE_SECRET },
    body: JSON.stringify({ id, repo: 'r1', prompt: 'hi' }),
  });
  assert.ok(pr.ok, 'legacy-accepted');
  const end = Date.now() + 8000;
  let got = null;
  while (Date.now() < end) {
    const r = await fetch(base + '/results/' + id, { headers: { 'X-Bridge-Secret': BRIDGE_SECRET } });
    got = await r.json();
    if (got && got.status !== 'running') break;
    await new Promise((x) => setTimeout(x, 200));
  }
  absent(JSON.stringify(got), SYN_RAW, 'legacy-raw');
  markerPresent(JSON.stringify(got), 'legacy');
  absent(fs.readFileSync(resultsFile, 'utf8'), SYN_RAW, 'legacy-persist');
});

test('pub upstash adapter mock redacts result+status, no external queue', async () => {
  let postedResult = null;
  let postedStatus = null;
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = String(opts && opts.body);
    if (body.includes('bridge:results')) postedResult = body;
    if (body.includes('bridge:status')) postedStatus = body;
    return { ok: true, json: async () => ({ result: 'OK' }) };
  };
  try {
    const src = require('../adapters/source-upstash.js').create({
      upstash_url: 'https://synth.invalid',
      upstash_token: 'synth-token',
    });
    await src.sendResult({ id: JOB_ID, status: 'done', summary: 'leak ' + SYN_RAW, output: SYN_RAW });
    await src.sendStatus({ event: 'done', id: JOB_ID, summary: 'leak ' + SYN_RAW });
    assert.ok(postedResult !== null, 'up-posted');
    absent(postedResult, SYN_RAW, 'up-raw');
    markerPresent(postedResult, 'up');
    assert.ok(postedStatus !== null, 'up-status-posted');
    absent(postedStatus, SYN_RAW, 'up-status-raw');
  } finally {
    global.fetch = origFetch;
  }
});

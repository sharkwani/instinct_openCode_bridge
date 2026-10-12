// Core loop: source -> git guardrails -> executor -> source. Knows nothing about Upstash or OpenCode.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const sh = promisify(execFile);
// Bound git children: an stuck git process (lock, prompt) must fail the
// task, never wedge the shared serial queue (and every later task) forever.
const GIT_TIMEOUT_MS = 60000;
const git = async (cwd, ...a) => (await sh('git', a, { cwd, timeout: GIT_TIMEOUT_MS })).stdout.trim();
exports.GIT_TIMEOUT_MS = GIT_TIMEOUT_MS;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const express = require('express');
const fs = require('node:fs');
const PROTECTED = ['main', 'master'];
const status = require('./status');
const { sanitizeResult, sanitizeForPersistence, sanitizeForHttpResponse, loadSecretRegistry, sanitizeString } = require('./sanitizer');

// Map a task result status to the Instinct-facing terminal event.
// done|needs_input -> done (work produced output); error|still_running -> failed.
const terminalEvent = (s) => (s === 'done' || s === 'needs_input' ? 'done' : 'failed');
exports.terminalEvent = terminalEvent;

// Open a captured OpenCode session in the terminal (verified against
// `opencode --help` v2.0.18: top-level --session/-s flag; there is no
// `opencode session open` subcommand). No per-session UI deep-link exists;
// `opencode pair` / `opencode serve` only connect to the server generally.
const openCommand = (sid) => sid ? `opencode --session ${sid}` : '';
exports.openCommand = openCommand;

// Task output visibility: final assistant response / stdout / error details
// are carried in result JSON field `output` (GET /results/:id). `summary`
// is kept unchanged for compatibility. Capped at 12KB, truncation labeled,
// secrets scrubbed, raw .env values never exposed. No broad logging here.
const MAX_OUTPUT_CHARS = 12 * 1024;
const TRUNC_SUFFIX = '\n[truncated: output exceeded 12KB]';
function toSafeOutput(raw) {
  let out = raw == null ? '' : String(raw);
  try { out = status.scrub(out); } catch {}
  // Redact dotenv-style assignments (KEY=value) so raw .env contents never
  // leak via echoed output; keep the key name for debuggability.
  out = out.replace(/^([A-Z_][A-Z0-9_]*)\s*=\s*\S.*$/gm, '$1=[redacted]');
  // Central registry + pattern redaction (nested/encoded/base64 variants,
  // longest-first, no canary exemption). Idempotent, preserves ids/sha/counts.
  try { out = sanitizeString(out); } catch {}
  if (out.length > MAX_OUTPUT_CHARS) out = out.slice(0, MAX_OUTPUT_CHARS) + TRUNC_SUFFIX;
  return out;
}
exports.MAX_OUTPUT_CHARS = MAX_OUTPUT_CHARS;
exports.toSafeOutput = toSafeOutput;

// Bridge secret: task submission (POST /tasks) historically carried it in
// the JSON/urlencoded body, while result reads (GET /results/:id) required
// the X-Bridge-Secret header. Instinct sends the same secret the same way
// for both, so reads failed with {error:'bad secret'}. Accept the secret
// from header, ?secret= query, or body on every gated endpoint.
function getReqSecret(req) {
  if (!req) return undefined;
  const viaHeader = typeof req.get === 'function' ? req.get('X-Bridge-Secret') : undefined;
  if (viaHeader) return viaHeader;
  if (req.query && typeof req.query.secret === 'string' && req.query.secret) return req.query.secret;
  if (req.body && typeof req.body.secret === 'string' && req.body.secret) return req.body.secret;
  return undefined;
}
exports.getReqSecret = getReqSecret;

// adapters are chosen in config by file name: "source": "source-upstash", "executor": "executor-opencode"
exports.load = (cfg) => {
  // Production: load secret registry internally from config (+env). No secret output.
  // useCache:true preserves synthetic seeded registry in offline tests (skipEnv:true).
  try { loadSecretRegistry(cfg, { useCache: true }); } catch {}
  return {
    source: require(path.join(__dirname, '..', 'adapters', cfg.source || 'source-upstash')).create(cfg),
    executor: require(path.join(__dirname, '..', 'adapters', cfg.executor || 'executor-opencode')).create(cfg),
  };
};

// Serialize all task execution (HTTP ingress + Upstash loop) so git branches and the
// shared opencode session directory never race.
let tail = Promise.resolve();
const serial = (fn) => { const res = tail.then(fn); tail = res.catch(() => {}); return res; };

async function handle(cfg, executor, t, statusSend) {
  const res = { id: t.id, status: 'error', branch: null, session_id: t.session_id || null, open_command: '', summary: '', output: '', diffstat: '', questions: [] };
  // Capture the submission-time session ID immediately so a later wait
  // timeout still reports where to look. Executor-created sessions are
  // merged in after run() and, on failure, from err.sessionId.
  if (res.session_id) res.open_command = openCommand(res.session_id);
  try {
    const cwd = cfg.repos[t.repo];
    if (!cwd) throw new Error(`unknown repo "${t.repo}"`);
    if (!t.id || !t.task) throw new Error('payload needs id and task');
    //if (await git(cwd, 'status', '--porcelain')) throw new Error('working tree not clean; refusing to start');
    const base = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    const branch = res.branch = `bridge/${String(t.id).replace(/[^A-Za-z0-9._-]/g, '-')}`;
    const exists = await git(cwd, 'branch', '--list', branch);
    await git(cwd, ...(exists ? ['switch', branch] : ['switch', '-c', branch]));
    // Instinct: task is now executing. Non-blocking; carries the
    // submission-time session when known (executor-created sessions are
    // reported on done/failed). Never throws.
    status.notify(statusSend, status.buildEvent('running', { id: t.id, sessionId: res.session_id }));
    try {
      const r = await executor.run({ task: t.task, cwd, sessionId: t.session_id, timeoutMs: (cfg.task_timeout_minutes || 30) * 60000 });
      res.session_id = r.sessionId || res.session_id; res.summary = r.summary; res.questions = r.questions || [];
      res.output = toSafeOutput(r.output ?? r.stdout ?? r.summary ?? '');
      res.open_command = openCommand(res.session_id);
      log('session', res.session_id || '(none)', 'task', t.id, '| open:', res.open_command || '(no session captured)');
      res.status = res.questions.length ? 'needs_input' : 'done';
    } catch (e) {
      // Preserve the session even when the wait is exhausted: the executor
      // attaches err.sessionId (created at prompt time, before waiting).
      const errSid = e && (e.sessionId || e.sessionID);
      if (errSid && !res.session_id) res.session_id = errSid;
      if (res.session_id) res.open_command = openCommand(res.session_id);
      const msg = String((e && e.message) || e);
      const exhausted = (e && e.code === 'STILL_RUNNING') || /still running remotely|opencode wait timeout/i.test(msg);
      // Delivery/stall diagnostics carry their own actionable summary
      // (prompt never landed, or turn never started). Keep them as failures
      // with the session preserved; never auto-approve or retry blindly.
      const deliveryFault = e && (e.code === 'PROMPT_NOT_ACCEPTED' || e.code === 'STALLED_NO_PROGRESS');
      if (deliveryFault) {
        res.status = 'error';
        res.summary = msg;
        try { log('session', res.session_id || '(none)', 'task', t.id, '| open:', res.open_command || '(no session captured)', '-', sanitizeString(res.summary).split('\n')[0].slice(0, 120)); } catch { log('session', res.session_id || '(none)', 'task', t.id, res.status); }
      } else if (exhausted) {
        res.status = 'still_running';
        // Clear, actionable summary: never a bare timeout. Always includes
        // the session ID and the exact open command when known.
        res.summary = res.session_id
          ? `still running remotely (session ${res.session_id}); open with: ${res.open_command}`
          : msg;
        try { log('session', res.session_id || '(none)', 'task', t.id, '| open:', res.open_command || '(no session captured)', '-', sanitizeString(res.summary).split('\n')[0].slice(0, 120)); } catch { log('session', res.session_id || '(none)', 'task', t.id, res.status); }
      } else {
        res.summary = msg;
      }
      const errExtra = [e && e.stdout, e && e.stderr, e && e.output].filter((v) => typeof v === 'string' && v).join('\n');
      res.output = toSafeOutput(errExtra ? `${res.summary}\n${errExtra}` : res.summary);
    }
    const now = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (now !== branch || PROTECTED.includes(now)) { res.status = 'error'; res.summary += `\n[bridge] HEAD is ${now}; expected ${branch}`; }
    res.diffstat = await git(cwd, 'diff', '--stat', `${base}...${branch}`).catch(() => '');
    if (await git(cwd, 'status', '--porcelain')) res.diffstat += '\n[bridge] uncommitted changes remain on branch';
  } catch (e) { res.summary = res.summary || String(e.message || e); }
  if (!res.output) res.output = toSafeOutput(res.summary || '');
  // Central boundary: every outward field (summary/output/questions/error/detail/diffstat)
  // redacted via registry + patterns, longest-first, no canary exemption, idempotent.
  // Preserves ids/session/branch/open_command/sha/counts. No secret output.
  try { return sanitizeResult(res); } catch { return res; }
}
exports._handle = handle;

exports.startHttp = (cfg, opts = {}) => {
  // Registry: production loads internally via load() when executor/source not injected.
  // Tests inject executor + seed registry via skipEnv:true; do not overwrite when injected.
  let _loaded = null;
  const _needExecutor = !(opts && opts.executor);
  const _needSource = !(opts && opts.source) && !(opts && opts.statusSend);
  if (_needExecutor || _needSource) { try { _loaded = exports.load(cfg); } catch {} }
  const executor = (opts && opts.executor) || (_loaded && _loaded.executor);
  const source = (opts && opts.source) || (_loaded && _loaded.source);
  const statusSend = (opts && opts.statusSend) || (source && typeof source.sendStatus === 'function' ? source.sendStatus.bind(source) : null);
  const resultsFile = (opts && opts.resultsFile) || path.join(__dirname, '..', 'results.jsonl');
  const listenPort = (opts && opts.port !== undefined) ? opts.port : 8787;
  const listenHost = (opts && opts.host) || '127.0.0.1';
  const results = new Map();
  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { 
        const r = JSON.parse(line);
        // Sanitize cached history on read for display (synthetic temp files in tests).
        try { results.set(r.id, sanitizeForHttpResponse(r)); } catch { results.set(r.id, r); }
      } catch {}
    }
  }
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/tasks/new', (req, res) => {
  res.type('html').send('<form id="f">' +
    '<input name="id" placeholder="id">' +
    '<input name="repo" placeholder="repo">' +
    '<textarea name="task" placeholder="task"></textarea>' +
    '<input name="secret" type="password" placeholder="secret">' +
    '<button>run</button></form>' +
    '<pre id="out"></pre>' +
    '<script>' +
    'const f=document.getElementById("f"),out=document.getElementById("out");' +
    'const freshId=()=>{f.id.value="t"+Date.now().toString(36)};freshId();' +
    'f.addEventListener("submit",async e=>{e.preventDefault();out.textContent="submitting...";' +
    'const b=new URLSearchParams(new FormData(f));' +
    'try{const r=await fetch("/tasks",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:b});' +
    'out.textContent=await r.text();}catch(err){out.textContent=String(err);}' +
    'f.task.value="";freshId();});' +
    '</script>');
});

  app.post('/results/view', (req, res) => {
  if (getReqSecret(req) !== cfg.bridge_secret) { log('reject /results/view: bad secret, id=', (req.body || {}).id); return res.status(401).send('bad secret'); }
  const r = results.get((req.body || {}).id);
  if (!r) return res.status(404).send('unknown id');
  const esc = (s) => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  let safe = r;
  try { safe = sanitizeForHttpResponse(r); } catch {}
  const openLine = safe.session_id ? `<p>Open session: <code>${esc(safe.open_command || openCommand(safe.session_id))}</code></p>` : '<p>No session captured.</p>';
  res.type('html').send(openLine + '<pre>' + JSON.stringify(safe, null, 2).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>');
});

  app.get('/results', (req, res) => {
    const supplied = getReqSecret(req);
    // Machine clients read JSON with the same secret used for submission
    // (header, ?secret=, or body). Browsers with no secret get the HTML form.
    if (supplied !== undefined) {
      if (supplied !== cfg.bridge_secret) return res.status(401).json({ error: 'bad secret' });
      try { return res.json([...results.values()].map((v) => sanitizeForHttpResponse(v))); } catch { return res.json([...results.values()]); }
    }
    res.type('html').send('<form method="post" action="/results/view">' +
    '<input name="id" placeholder="id">' +
    '<input name="secret" type="password" placeholder="secret">' +
    '<button>view</button></form>');
  });
  app.post('/tasks', (req, res) => {
    const t = req.body || {};
    log('submission from', req.ip, 'id=', t.id, 'repo=', t.repo);
    if (getReqSecret(req) !== cfg.bridge_secret) { log('reject id=', t.id, ': bad secret'); return res.status(401).json({ error: 'bad secret' }); }
    if (!t.id || !t.repo || !t.task) { log('reject id=', t.id, ': missing fields: need {id, repo, task, secret}'); return res.status(400).json({ error: 'need {id, repo, task, secret}' }); }
    if (results.has(t.id)) { log('reject id=', t.id, ': duplicate id'); return res.status(409).json({ error: 'duplicate id' }); }
    results.set(t.id, { id: t.id, status: 'running' });
    log('accepted task', t.id, t.repo);
    res.json({ id: t.id, status: 'accepted' });
    status.notify(statusSend, status.buildEvent('queued', { id: t.id, sessionId: t.session_id || null }));
    serial(() => handle(cfg, executor, t, statusSend)).then((r) => {
      let safe = r;
      try { safe = sanitizeResult(r); } catch {}
      results.set(safe.id, safe);
      try { log('task finished', safe.id, safe.status, 'session', safe.session_id || '(none)', '| open:', safe.open_command || '(no session captured)', safe.summary ? String(sanitizeString(safe.summary)).split('\n')[0].slice(0, 120) : ''); } catch { log('task finished', safe.id, safe.status); }
      try { fs.appendFileSync(resultsFile, JSON.stringify(sanitizeForPersistence(safe)) + '\n'); } catch {}
      status.notify(statusSend, status.buildEvent(terminalEvent(safe.status), { id: safe.id, sessionId: safe.session_id, branch: safe.branch, detail: safe.status, summary: safe.status === 'done' || safe.status === 'needs_input' ? safe.summary : undefined, error: terminalEvent(safe.status) === 'failed' ? safe.summary : undefined, output: safe.output || undefined }));
    }).catch((err) => {
      const summary = String((err && err.message) || err);
      let failed = { id: t.id, status: 'error', branch: null, session_id: null, summary, output: toSafeOutput(summary), diffstat: '', questions: [] };
      try { failed = sanitizeResult(failed); } catch {}
      results.set(t.id, failed);
      log('task crashed', t.id, failed.status);
      try { fs.appendFileSync(resultsFile, JSON.stringify(sanitizeForPersistence(failed)) + '\n'); } catch {}
      status.notify(statusSend, status.buildEvent('failed', { id: t.id, sessionId: null, detail: 'error', error: failed.summary, output: failed.output }));
    });
  });
  app.get('/results/:id', (req, res) => {
    if (getReqSecret(req) !== cfg.bridge_secret) return res.status(401).json({ error: 'bad secret' });
    const r = results.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'unknown id' });
    try { return res.json(sanitizeForHttpResponse(r)); } catch { return res.json(r); }
  });
  const server = app.listen(listenPort, listenHost, () => { try { log('http ingress on :' + server.address().port); } catch { log('http ingress on :' + listenPort); } });
  return { app, server, results };
};
// One queue iteration: pick up a single task, run it serially, publish the
// result. Returns the result, or null when nothing was queued. Throws on
// transport failures so the caller (run) can back off and keep looping
// forever; one bad task can never wedge later ones.
async function runOnce(cfg, source, executor) {
  const t = await source.next();
  if (!t) return null;
  if (t.secret !== cfg.bridge_secret) { log('secret mismatch, rejected', t.id); return null; }
  log('pickup task', t.id, t.repo);
  log('task', t.id, t.repo);
  const statusSend = source.sendStatus ? source.sendStatus.bind(source) : null;
  status.notify(statusSend, status.buildEvent('queued', { id: t.id, sessionId: t.session_id || null }));
  const res = await serial(() => handle(cfg, executor, t, statusSend));
  // Defense-in-depth: handle() already sanitizes; re-sanitize idempotent before publish.
  let safe = res;
  try { safe = sanitizeResult(res); } catch {}
  status.notify(statusSend, status.buildEvent(terminalEvent(safe.status), { id: safe.id, sessionId: safe.session_id, branch: safe.branch, detail: safe.status, summary: terminalEvent(safe.status) === 'done' ? safe.summary : undefined, error: terminalEvent(safe.status) === 'failed' ? safe.summary : undefined, output: safe.output || undefined }));
  await source.sendResult(safe);
  log('result', safe.id, safe.status, 'session', safe.session_id || '(none)', '| open:', safe.open_command || '(no session captured)');
  return safe;
}
exports.runOnce = runOnce;
exports.run = async (cfg) => {
  const { source, executor } = exports.load(cfg);
  log('bridge up; repos:', Object.keys(cfg.repos).join(', '));
  exports.startHttp(cfg);
  log('ingress started');
  for (;;) {
    try {
      await runOnce(cfg, source, executor);
    } catch (e) { log('loop error:', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
};


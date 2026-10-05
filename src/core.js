// Core loop: source -> git guardrails -> executor -> source. Knows nothing about Upstash or OpenCode.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const sh = promisify(execFile);
const git = async (cwd, ...a) => (await sh('git', a, { cwd })).stdout.trim();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const express = require('express');
const fs = require('node:fs');
const PROTECTED = ['main', 'master'];

// Open a captured OpenCode session in the terminal (verified against
// `opencode --help` v2.0.18: top-level --session/-s flag; there is no
// `opencode session open` subcommand). No per-session UI deep-link exists;
// `opencode pair` / `opencode serve` only connect to the server generally.
const openCommand = (sid) => sid ? `opencode --session ${sid}` : '';
exports.openCommand = openCommand;

// adapters are chosen in config by file name: "source": "source-upstash", "executor": "executor-opencode"
exports.load = (cfg) => ({
  source: require(path.join(__dirname, '..', 'adapters', cfg.source || 'source-upstash')).create(cfg),
  executor: require(path.join(__dirname, '..', 'adapters', cfg.executor || 'executor-opencode')).create(cfg),
});

// Serialize all task execution (HTTP ingress + Upstash loop) so git branches and the
// shared opencode session directory never race.
let tail = Promise.resolve();
const serial = (fn) => { const res = tail.then(fn); tail = res.catch(() => {}); return res; };

async function handle(cfg, executor, t) {
  const res = { id: t.id, status: 'error', branch: null, session_id: t.session_id || null, open_command: '', summary: '', diffstat: '', questions: [] };
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
    try {
      const r = await executor.run({ task: t.task, cwd, sessionId: t.session_id, timeoutMs: (cfg.task_timeout_minutes || 30) * 60000 });
      res.session_id = r.sessionId || res.session_id; res.summary = r.summary; res.questions = r.questions || [];
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
      if (exhausted) {
        res.status = 'still_running';
        // Clear, actionable summary: never a bare timeout. Always includes
        // the session ID and the exact open command when known.
        res.summary = res.session_id
          ? `still running remotely (session ${res.session_id}); open with: ${res.open_command}`
          : msg;
        log('session', res.session_id || '(none)', 'task', t.id, '| open:', res.open_command || '(no session captured)', '-', res.summary);
      } else {
        res.summary = msg;
      }
    }
    const now = await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    if (now !== branch || PROTECTED.includes(now)) { res.status = 'error'; res.summary += `\n[bridge] HEAD is ${now}; expected ${branch}`; }
    res.diffstat = await git(cwd, 'diff', '--stat', `${base}...${branch}`).catch(() => '');
    if (await git(cwd, 'status', '--porcelain')) res.diffstat += '\n[bridge] uncommitted changes remain on branch';
  } catch (e) { res.summary = res.summary || String(e.message || e); }
  // HOOK: secret sanitization goes here (scrub res.summary / res.diffstat before it leaves the machine).
  return res;
}
exports._handle = handle;

exports.startHttp = (cfg) => {
  const { executor } = exports.load(cfg);
  const resultsFile = path.join(__dirname, '..', 'results.jsonl');
  const results = new Map();
  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { 
        const r = JSON.parse(line); results.set(r.id, r); 
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
  if ((req.body || {}).secret !== cfg.bridge_secret) { log('reject /results/view: bad secret, id=', (req.body || {}).id); return res.status(401).send('bad secret'); }
  const r = results.get((req.body || {}).id);
  if (!r) return res.status(404).send('unknown id');
  const esc = (s) => String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const openLine = r.session_id ? `<p>Open session: <code>${esc(r.open_command || openCommand(r.session_id))}</code></p>` : '<p>No session captured.</p>';
  res.type('html').send(openLine + '<pre>' + JSON.stringify(r, null, 2).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</pre>');
});

  app.get('/results', (req, res) => {
    res.type('html').send('<form method="post" action="/results/view">' +
    '<input name="id" placeholder="id">' +
    '<input name="secret" type="password" placeholder="secret">' +
    '<button>view</button></form>');
});
  app.post('/tasks', (req, res) => {
    const t = req.body || {};
    log('submission from', req.ip, 'id=', t.id, 'repo=', t.repo);
    if (t.secret !== cfg.bridge_secret) { log('reject id=', t.id, ': bad secret'); return res.status(401).json({ error: 'bad secret' }); }
    if (!t.id || !t.repo || !t.task) { log('reject id=', t.id, ': missing fields: need {id, repo, task, secret}'); return res.status(400).json({ error: 'need {id, repo, task, secret}' }); }
    if (results.has(t.id)) { log('reject id=', t.id, ': duplicate id'); return res.status(409).json({ error: 'duplicate id' }); }
    results.set(t.id, { id: t.id, status: 'running' });
    log('accepted task', t.id, t.repo);
    res.json({ id: t.id, status: 'accepted' });
    serial(() => handle(cfg, executor, t)).then((r) => {
      results.set(r.id, r);
      log('task finished', r.id, r.status, 'session', r.session_id || '(none)', '| open:', r.open_command || '(no session captured)', r.summary ? String(r.summary).split('\n')[0].slice(0,120) : '');
      fs.appendFileSync(resultsFile, JSON.stringify(r) + '\n');
    }).catch((err) => {
      const failed = { id: t.id, status: 'error', branch: null, session_id: null, summary: String((err && err.message) || err), diffstat: '', questions: [] };
      results.set(t.id, failed);
      log('task crashed', t.id, failed.summary);
      try { fs.appendFileSync(resultsFile, JSON.stringify(failed) + '\n'); } catch {}
    });
  });
  app.get('/results/:id', (req, res) => {
    if (req.get('X-Bridge-Secret') !== cfg.bridge_secret) return res.status(401).json({ error: 'bad secret' });
    const r = results.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'unknown id' });
    res.json(r);
  });
  app.listen(8787, '127.0.0.1', () => log('http ingress on :8787'));
};
exports.run = async (cfg) => {
  const { source, executor } = exports.load(cfg);
  log('bridge up; repos:', Object.keys(cfg.repos).join(', '));
  exports.startHttp(cfg);
  log('ingress started');
  for (;;) {
    try {
      const t = await source.next();
      if (!t) continue;
      if (t.secret !== cfg.bridge_secret) { log('secret mismatch, rejected', t.id); continue; }
      log('task', t.id, t.repo);
      const res = await serial(() => handle(cfg, executor, t));
      await source.sendResult(res);
      log('result', res.id, res.status, 'session', res.session_id || '(none)', '| open:', res.open_command || '(no session captured)');
    } catch (e) { log('loop error:', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
};


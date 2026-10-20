const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
// Long clean-repo tasks (copy + README + verify) exceed the old 30min wait
// (t-cleanrepo1 and t-cleanrepo-recovery both hit exactly ~30m00s and threw
// bare "opencode wait timeout" with session_id null). Keep the wait generous
// so slow model turns can finish; callers may still pass a larger timeoutMs.
const DEFAULT_WAIT_MS = 120 * 60000;
exports.DEFAULT_WAIT_MS = DEFAULT_WAIT_MS;

// How long to wait for `opencode serve` to answer before failing the task.
const SERVER_BOOT_TIMEOUT_MS = 90 * 1000;
exports.SERVER_BOOT_TIMEOUT_MS = SERVER_BOOT_TIMEOUT_MS;

// Build the wait-exhaustion error. It must carry the session ID so callers
// can report "still running remotely" with an `opencode --session <id>`
// open command instead of a bare timeout.
function stillRunningError(sid) {
  const err = new Error(
    sid
      ? `still running remotely (session ${sid}); open with: opencode --session ${sid}`
      : 'still running remotely (session unknown)',
  );
  if (sid) err.sessionId = sid;
  err.code = 'STILL_RUNNING';
  return err;
}
exports.stillRunningError = stillRunningError;
exports.isWaitExhaustion = (e) => {
  const msg = String((e && e.message) || e || '');
  return (e && e.code === 'STILL_RUNNING') || /still running remotely|opencode wait timeout/i.test(msg);
};

// POST /prompt returned 2xx but no user message appeared: the turn never
// entered the queue (e.g. a dropped enqueue). Failing fast here distinguishes
// "never delivered" from "delivered but stuck".
function promptNotAcceptedError(sid) {
  const err = new Error(
    sid
      ? `prompt not accepted (session ${sid}); no user message landed after POST /prompt; open with: opencode --session ${sid}`
      : 'prompt not accepted (session unknown)',
  );
  if (sid) err.sessionId = sid;
  err.code = 'PROMPT_NOT_ACCEPTED';
  return err;
}
exports.promptNotAcceptedError = promptNotAcceptedError;

// Wait exhausted with zero new activity since the prompt: nothing streamed,
// no idle, not even our user message visible. The turn most likely never
// started (pending permission approval or question with no attached UI to
// answer it, or a stalled session). Never auto-approve; report where to look.
function stalledNoProgressError(sid, elapsedMin) {
  const err = new Error(
    sid
      ? `no progress in ~${elapsedMin}m (session ${sid}); turn never started - check the UI for a pending permission approval or question, then open with: opencode --session ${sid}`
      : 'no progress since prompt; turn never started',
  );
  if (sid) err.sessionId = sid;
  err.code = 'STALLED_NO_PROGRESS';
  return err;
}
exports.stalledNoProgressError = stalledNoProgressError;

// Render opencode's structured error ({type,message,status,response.body})
// into one actionable line. This is the missing piece that turned every
// provider/model failure into an opaque "OpenCode turn failed (session ...)".
function formatStructuredError(e) {
  if (!e) return '';
  if (typeof e === 'string') return e.slice(0, 1000);
  const type = e.type ? String(e.type) : '';
  const message = e.message ? String(e.message) : '';
  const status = e.status ? ` [${e.status}]` : '';
  let body = '';
  try {
    if (e.response && e.response.body) body = String(e.response.body);
  } catch {}
  const head = [type, message].filter(Boolean).join(': ');
  const combined = (head || message || type) + status;
  return (combined + (body ? ` (${body})` : '')).slice(0, 1000);
}
exports.formatStructuredError = formatStructuredError;

// Turn ended with outcome failed/interrupted or an assistant error. Carry the
// real opencode error text so Instinct sees WHY, not just that it failed.
function turnFailedError(sid, msg) {
  const outcome = (msg && msg.outcome) || 'failed';
  const detail = formatStructuredError((msg && msg.error) || msg);
  const err = new Error(
    `OpenCode turn ${outcome} (session ${sid})${detail ? `: ${detail}` : ''}`,
  );
  if (sid) err.sessionId = sid;
  err.code = 'TURN_FAILED';
  err.outcome = outcome;
  if (detail) err.opencodeError = detail;
  return err;
}
exports.turnFailedError = turnFailedError;

// --- Model selection ---------------------------------------------------------
// opencode v2 model refs are {id, providerID, variant?}. The bridge config
// stores the human form "provider/model" (optionally "#variant"), matching
// `opencode run --model`.
function parseModelRef(str) {
  if (typeof str !== 'string') return null;
  let s = str.trim();
  if (!s) return null;
  let variant;
  const hash = s.indexOf('#');
  if (hash >= 0) {
    variant = s.slice(hash + 1).trim() || undefined;
    s = s.slice(0, hash).trim();
  }
  const slash = s.indexOf('/');
  if (slash <= 0 || slash === s.length - 1) return null;
  const providerID = s.slice(0, slash);
  const id = s.slice(slash + 1);
  return variant ? { id, providerID, variant } : { id, providerID };
}
exports.parseModelRef = parseModelRef;

function modelRefKey(m) {
  if (!m) return '';
  return `${m.providerID}/${m.id}${m.variant ? '#' + m.variant : ''}`;
}
exports.modelRefKey = modelRefKey;

// Match a config model string against the live model list from GET /api/model.
function modelExists(list, str) {
  const want = parseModelRef(str);
  if (!want) return false;
  const strip = (s) => String(s || '').split('#')[0];
  const wanted = `${want.providerID}/${want.id}`;
  return (list || []).some((m) => {
    if (!m || m.providerID !== want.providerID) return false;
    return strip(m.id) === want.id || strip(m.modelID) === want.id;
  });
}
exports.modelExists = modelExists;

// --- Questions (opencode "form") --------------------------------------------
// When the agent wants a decision it opens a form; the turn blocks until the
// form is answered or cancelled. Turn that into needs_input instead of letting
// the wait expire as a silent stall.
function formQuestions(form) {
  const out = [];
  if (form && form.title) out.push(String(form.title));
  for (const f of (form && form.fields) || []) {
    if (!f || f.hidden) continue;
    const label = f.title || f.key || 'input';
    const opts = Array.isArray(f.options)
      ? f.options.map((o) => (o && (o.label || o.value)) || '').filter(Boolean)
      : [];
    out.push(opts.length ? `${label} (options: ${opts.join(', ')})` : label);
  }
  return out.filter(Boolean);
}
exports.formQuestions = formQuestions;

function buildQuestionText(form) {
  const lines = [];
  lines.push((form && form.title) || 'The agent is waiting for your input.');
  for (const f of (form && form.fields) || []) {
    if (!f || f.hidden) continue;
    const label = f.title || f.key || 'input';
    const opts = Array.isArray(f.options)
      ? f.options.map((o) => (o && (o.label || o.value)) || '').filter(Boolean)
      : [];
    lines.push(`- ${label}${opts.length ? ': ' + opts.join(' / ') : ''}${f.description ? ' - ' + f.description : ''}`);
  }
  lines.push('Answer with a new task on this same session.');
  return lines.join('\n');
}
exports.buildQuestionText = buildQuestionText;

const yes = /^(y|yes|true|1|ok|okay|sure)$/i;
const no = /^(n|no|false|0|nope|cancel)$/i;

function coerceField(field, text) {
  const t = String(text == null ? '' : text).trim();
  if (!field) return t;
  if (field.type === 'boolean') {
    if (yes.test(t)) return true;
    if (no.test(t)) return false;
    return t;
  }
  if (field.type === 'number' || field.type === 'integer') {
    const n = Number(t);
    return Number.isNaN(n) ? t : (field.type === 'integer' ? Math.trunc(n) : n);
  }
  if (field.type === 'multiselect') {
    const opts = field.options || [];
    const hit = opts.find((o) => t.toLowerCase() === String(o.value).toLowerCase() || t.toLowerCase() === String(o.label || '').toLowerCase());
    return hit ? [hit.value] : t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return t;
}
exports.coerceField = coerceField;

// Best-effort mapping of a free-text follow-up task onto a pending form. Single
// field forms are exact; multi-field forms match options by label/value, then
// fall back to defaults, then place the raw text in the first string field.
function answerForForm(form, text) {
  const fields = ((form && form.fields) || []).filter((f) => f && !f.hidden && f.type !== 'external');
  const answer = {};
  if (fields.length === 0) return answer;
  const raw = String(text == null ? '' : text).trim();
  const lower = raw.toLowerCase();
  const matchOption = (f) => (f.options || []).find((o) => {
    const v = String((o && o.value) || '').toLowerCase();
    const l = String((o && o.label) || '').toLowerCase();
    return (v && lower.includes(v)) || (l && lower.includes(l));
  });
  if (fields.length === 1) {
    const f = fields[0];
    const hit = (f.options || []).length ? matchOption(f) : null;
    if (hit) { answer[f.key] = f.type === 'multiselect' ? [hit.value] : hit.value; return answer; }
    answer[f.key] = coerceField(f, raw);
    return answer;
  }
  let textUsed = false;
  for (const f of fields) {
    if ((f.options || []).length) {
      const hit = matchOption(f);
      if (hit) { answer[f.key] = f.type === 'multiselect' ? [hit.value] : hit.value; continue; }
    }
    if (f.default !== undefined) { answer[f.key] = f.default; continue; }
    if (!textUsed && f.type === 'string' && raw) { answer[f.key] = raw; textUsed = true; }
  }
  return answer;
}
exports.answerForForm = answerForForm;

// Same heuristic as the CLI executor: a question is a line in the final
// paragraph that ends with '?'.
function questionsFromText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const last = t.split(/\n\s*\n/).pop() || '';
  return last.split('\n').map((s) => s.trim()).filter((s) => s.endsWith('?'));
}
exports.questionsFromText = questionsFromText;

// Clock-skew tolerance when comparing bridge clock to server message times.
const TIME_SKEW_MS = 5000;
exports.TIME_SKEW_MS = TIME_SKEW_MS;

function userMessageLanded(data, since) {
  return (data || []).some((m) => m && m.type === 'user' && m.time && m.time.created >= since - TIME_SKEW_MS);
}
exports.userMessageLanded = userMessageLanded;

function latestActivity(data) {
  let max = 0;
  for (const m of data || []) {
    const t = m && m.time && m.time.created;
    if (typeof t === 'number' && t > max) max = t;
  }
  return max;
}
exports.latestActivity = latestActivity;

// Choose the exhaustion error: a silent stall (nothing new at all) gets the
// actionable STALLED code; a turn that produced output but never went idle
// keeps the existing STILL_RUNNING still-running report.
function decideExhaustion({ data, sid, promptAt, now }) {
  if (latestActivity(data) <= promptAt - TIME_SKEW_MS) {
    return stalledNoProgressError(sid, Math.max(1, Math.round((now - promptAt) / 60000)));
  }
  return stillRunningError(sid);
}
exports.decideExhaustion = decideExhaustion;

let server = null;
let BIN = 'opencode';
let cfgRef = {};
const sessions = new Map(); // cwd -> sessionId
const pendingForms = new Map(); // sessionId -> { form, at }
const answeredFormIds = new Set(); // form ids we just replied to
const appliedModel = new Map(); // sessionId -> model key
let AUTH = null;
let OCPW = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Probe the loopback server. Distinguishes "healthy with our auth",
// "listening but rejecting our auth" (foreign/older server on the port), and
// "nothing there / unreachable" so we can fail with an actionable message
// instead of a bare "opencode serve did not come up".
async function probeSession() {
  try {
    const headers = AUTH ? { authorization: AUTH } : {};
    const r = await fetch(`${BASE}/api/session`, { headers, signal: AbortSignal.timeout(5000) });
    if (r.ok) return { ok: true, status: r.status };
    if (r.status === 401 || r.status === 403) return { ok: false, unauthorized: true, status: r.status };
    return { ok: false, status: r.status };
  } catch (e) {
    return { ok: false, error: e };
  }
}
exports.probeSession = probeSession;

async function ensureServer() {
  if (server) return;

  // 1. Reuse an already-running server (e.g. orphaned by a previous daemon run)
  //    when it accepts our auth.
  const probe = await probeSession();
  if (probe.ok) return;
  if (probe.unauthorized) {
    throw new Error(
      `opencode server already running on 127.0.0.1:${PORT} but it rejected our credentials - ` +
      `set openCodeServerPassword to match that server (or stop it), then retry`,
    );
  }

  // 2. Spawn our own. Always pass a password: without one opencode generates a
  //    random password and every bridge call would 401 forever.
  let spawnError = null;
  let exitInfo = null;
  let errBuf = '';
  const child = spawn(BIN, ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...(OCPW ? { OPENCODE_SERVER_PASSWORD: OCPW } : {}) },
  });
  server = child;
  try {
    if (child.stderr) child.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-4000); });
  } catch {}
  child.on('error', (e) => { spawnError = e; });
  child.on('exit', (code, signal) => { server = null; exitInfo = { code, signal }; });

  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const p = await probeSession();
    if (p.ok) return;
    if (spawnError) throw new Error(`could not start "${BIN}": ${spawnError.message}`);
    if (exitInfo) {
      const tail = errBuf.trim().split('\n').slice(-3).join(' | ');
      throw new Error(`opencode serve exited early (code ${exitInfo.code}${tail ? `: ${tail}` : ''})`);
    }
    await sleep(1000);
  }
  const tail = errBuf.trim().split('\n').slice(-3).join(' | ');
  throw new Error(`opencode serve did not come up within ${Math.round(SERVER_BOOT_TIMEOUT_MS / 1000)}s${tail ? `: ${tail}` : ''}`);
}
exports.ensureServer = ensureServer;

async function api(method, p, body) {
  const headers = { 'content-type': 'application/json' };
  if (AUTH) headers.authorization = AUTH;
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

// Apply cfg.model to a session before prompting, but only when it changed so we
// do not spam model-switched messages every turn.
async function applyModel(sid) {
  const model = parseModelRef(cfgRef && cfgRef.model);
  if (!model) return;
  const key = modelRefKey(model);
  if (appliedModel.get(sid) === key) return;
  await api('POST', `/api/session/${sid}/model`, { model });
  appliedModel.set(sid, key);
}

exports.create = (cfg) => {
  cfgRef = cfg || {};
  BIN = cfgRef.opencode_bin || 'opencode';
  // Password fallback chain: explicit server password, env, then bridge_secret
  // (already a local secret shared with Instinct over loopback-only HTTP), then
  // a random one so a password is ALWAYS set and opencode never self-generates.
  OCPW = cfgRef.opencodeServerPassword || process.env.OPENCODE_SERVER_PASSWORD || cfgRef.bridge_secret || crypto.randomBytes(32).toString('base64url');
  AUTH = 'Basic ' + Buffer.from((process.env.OPENCODE_SERVER_USERNAME || 'opencode') + ':' + OCPW).toString('base64');

  return {
    // Live model list for validating a set_model control task (GET /api/model).
    async listModels() {
      await ensureServer();
      const r = await api('GET', '/api/model');
      return (r && r.data) || [];
    },

    async run({ task, cwd, sessionId, timeoutMs }) {
      await ensureServer();
      // Prefer the submission-time session when the caller already knows it;
      // otherwise reuse/create the per-cwd server session. sid is known here,
      // before the long wait, so wait exhaustion can still report it.
      let sid = sessionId || sessions.get(cwd);
      // Never hijack a session that is parked on an unanswered form with an
      // unrelated task; a session waiting on a form only continues when the
      // caller explicitly passes that session id back.
      if (!sessionId && sid && pendingForms.has(sid)) sid = null;
      if (sessionId) sessions.set(cwd, sessionId);
      if (!sid) {
        const model = parseModelRef(cfgRef.model);
        const s = await api('POST', '/api/session', {
          location: { directory: cwd },
          ...(model ? { model } : {}),
        });
        sid = s.data.id;
        sessions.set(cwd, sid);
        if (model) appliedModel.set(sid, modelRefKey(model));
      }

      const startedAt = Date.now();

      // If this session is parked on a question, the task text is the answer.
      const pending = pendingForms.get(sid);
      if (pending) {
        pendingForms.delete(sid);
        answeredFormIds.add(pending.form.id);
        if (answeredFormIds.size > 500) answeredFormIds.clear();
        const answer = answerForForm(pending.form, task);
        await api('POST', `/api/session/${sid}/form/${pending.form.id}/reply`, { answer });
      } else {
        await applyModel(sid);
        await api('POST', `/api/session/${sid}/prompt`, { text: task });

        // Delivery check: the prompt call can return 2xx without the turn ever
        // entering the queue. Confirm our user message landed (3 tries); fail
        // fast with the session id instead of burning the full wait.
        let landed = false;
        for (let i = 0; i < 3 && !landed; i++) {
          if (i) await sleep(2000);
          const check = await api('GET', `/api/session/${sid}/message?order=desc&limit=10`);
          landed = userMessageLanded(check.data || [], startedAt);
        }
        if (!landed) throw promptNotAcceptedError(sid);
      }

      // Generous floor: even if the caller passes the old 30min timeout,
      // wait at least DEFAULT_WAIT_MS so long tasks are not cut off.
      const waitMs = Math.max(timeoutMs || 0, DEFAULT_WAIT_MS);
      const deadline = Date.now() + waitMs;
      let last = null;
      while (Date.now() < deadline) {
        // Did the agent open a form (question) we must relay to Instinct?
        const forms = await api('GET', `/api/session/${sid}/form`).catch(() => null);
        const form = (forms && forms.data || []).find((f) => f && !answeredFormIds.has(f.id));
        if (form) {
          pendingForms.set(sid, { form, at: Date.now() });
          const question = buildQuestionText(form);
          return { summary: question, output: question, sessionId: sid, questions: formQuestions(form) };
        }

        const active = await api('GET', '/api/session/active');
        if (!active || !active.data || typeof active.data !== 'object') {
          throw new Error('Invalid OpenCode active-session response');
        }
        if (!Object.prototype.hasOwnProperty.call(active.data, sid)) {
          const msgs = await api('GET', `/api/session/${sid}/message?order=desc&limit=10`);
          const data = msgs.data || [];
          // A historical idle anywhere in the page is not a completion gate.
          const idle = data[0];
          if (idle?.type === 'idle' && idle.time?.created > startedAt) {
            if (idle.outcome !== 'succeeded') {
              throw turnFailedError(sid, idle);
            }
            // Filter before pagination, so intervening non-text messages cannot
            // hide the newest assistant response behind the 10-message limit.
            const reply = await api('GET', `/api/session/${sid}/message?order=desc&limit=1&type=assistant`);
            const candidate = (reply.data || [])[0];
            if (candidate?.time?.created > startedAt &&
                candidate.time.completed != null &&
                candidate.time.completed <= idle.time.created) {
              // A provider/agent error can still land as a successful idle with
              // an assistant.error or finish:"error"; surface it, never as done.
              if (candidate.error || candidate.finish === 'error') {
                throw turnFailedError(sid, candidate);
              }
              if ((candidate.content || []).some(p => p.type === 'text' && typeof p.text === 'string' && p.text.trim())) {
                // Revalidate the boundary after fetching text. A successor drain
                // must not make an old idle/ack snapshot look terminal.
                const tail = await api('GET', `/api/session/${sid}/message?order=desc&limit=1`);
                const current = await api('GET', '/api/session/active');
                if (!current || !current.data || typeof current.data !== 'object') {
                  throw new Error('Invalid OpenCode active-session response');
                }
                if ((tail.data || [])[0]?.id === idle.id &&
                    !Object.prototype.hasOwnProperty.call(current.data, sid)) {
                  last = candidate;
                  break;
                }
              }
            }
          }
        }
        await sleep(2000);
      }
      if (!last) {
        const tail = await api('GET', `/api/session/${sid}/message?order=desc&limit=10`).catch(() => null);
        throw decideExhaustion({ data: (tail && tail.data) || [], sid, promptAt: startedAt, now: Date.now() });
      }
      const text = last.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      return { summary: text || '(no assistant text)', sessionId: sid, questions: questionsFromText(text) };
    },
  };
};

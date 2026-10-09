const { spawn } = require('node:child_process');

const PORT = 4199;
const BASE = `http://127.0.0.1:${PORT}`;
// Long clean-repo tasks (copy + README + verify) exceed the old 30min wait
// (t-cleanrepo1 and t-cleanrepo-recovery both hit exactly ~30m00s and threw
// bare "opencode wait timeout" with session_id null). Keep the wait generous
// so slow model turns can finish; callers may still pass a larger timeoutMs.
const DEFAULT_WAIT_MS = 120 * 60000;
exports.DEFAULT_WAIT_MS = DEFAULT_WAIT_MS;

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
const sessions = new Map(); // cwd -> sessionId
let AUTH = null;
let OCPW = null;

async function ensureServer() {
  if (server) return;
  // Reuse an already-running server (e.g. orphaned by a previous daemon run) if it accepts our auth.
  try {
    const r = await fetch(`${BASE}/api/session`, { headers: { authorization: AUTH }, signal: AbortSignal.timeout(5000) });
    if (r.ok) return;
  } catch {}
  server = spawn('opencode', ['serve', '--port', String(PORT), '--hostname', '127.0.0.1'], {
    stdio: 'ignore',
    env: { ...process.env, ...(OCPW ? { OPENCODE_SERVER_PASSWORD: OCPW } : {}) },
  });
  server.on('exit', () => { server = null; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/session`, { headers: { authorization: AUTH }, signal: AbortSignal.timeout(5000) });
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('opencode serve did not come up');
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${await r.text()}`);
  return r.json();
}

exports.create = (cfg) => {
  OCPW = cfg.opencodeServerPassword || process.env.OPENCODE_SERVER_PASSWORD || null;
  AUTH = OCPW ? 'Basic ' + Buffer.from((process.env.OPENCODE_SERVER_USERNAME || 'opencode') + ':' + OCPW).toString('base64') : null;

  return {
    async run({ task, cwd, sessionId, timeoutMs }) {
      await ensureServer();
      // Prefer the submission-time session when the caller already knows it;
      // otherwise reuse/create the per-cwd server session. sid is known here,
      // before the long wait, so wait exhaustion can still report it.
      let sid = sessionId || sessions.get(cwd);
      if (sessionId) sessions.set(cwd, sessionId);
      if (!sid) {
        const s = await api('POST', '/api/session', { location: { directory: cwd } });
        sid = s.data.id;
        sessions.set(cwd, sid);
      }
      const startedAt = Date.now();
      const promptAt = startedAt;
      await api('POST', `/api/session/${sid}/prompt`, { text: task });

      // Delivery check: the prompt call can return 2xx without the turn ever
      // entering the queue. Confirm our user message landed (3 tries); fail
      // fast with the session id instead of burning the full wait.
      let landed = false;
      for (let i = 0; i < 3 && !landed; i++) {
        if (i) await new Promise((r) => setTimeout(r, 2000));
        const check = await api('GET', `/api/session/${sid}/message?order=desc&limit=10`);
        landed = userMessageLanded(check.data || [], promptAt);
      }
      if (!landed) throw promptNotAcceptedError(sid);

      // Generous floor: even if the caller passes the old 30min timeout,
      // wait at least DEFAULT_WAIT_MS so long tasks are not cut off.
      const waitMs = Math.max(timeoutMs || 0, DEFAULT_WAIT_MS);
      const deadline = Date.now() + waitMs;
      let last = null;
      while (Date.now() < deadline) {
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
              const err = new Error(`OpenCode turn ${idle.outcome || 'unknown'} (session ${sid})`);
              err.sessionId = sid;
              throw err;
            }
            // Filter before pagination, so intervening non-text messages cannot
            // hide the newest assistant response behind the 10-message limit.
            const reply = await api('GET', `/api/session/${sid}/message?order=desc&limit=1&type=assistant`);
            const candidate = (reply.data || [])[0];
            if (candidate?.time?.created > startedAt &&
                candidate.time.completed != null &&
                candidate.time.completed <= idle.time.created &&
                (candidate.content || []).some(p => p.type === 'text' && typeof p.text === 'string' && p.text.trim())) {
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
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!last) {
        const tail = await api('GET', `/api/session/${sid}/message?order=desc&limit=10`).catch(() => null);
        throw decideExhaustion({ data: (tail && tail.data) || [], sid, promptAt, now: Date.now() });
      }
      const text = last.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      return { summary: text || '(no assistant text)', sessionId: sid, questions: [] };
    },
  };
};
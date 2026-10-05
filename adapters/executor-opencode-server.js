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
      await api('POST', `/api/session/${sid}/prompt`, { text: task });

      // Generous floor: even if the caller passes the old 30min timeout,
      // wait at least DEFAULT_WAIT_MS so long tasks are not cut off.
      const waitMs = Math.max(timeoutMs || 0, DEFAULT_WAIT_MS);
      const deadline = Date.now() + waitMs;
      let last = null;
      while (Date.now() < deadline) {
        const msgs = await api('GET', `/api/session/${sid}/message?order=desc&limit=10`);
        const data = msgs.data || [];
        // The turn isn't done until an idle message lands; assistant content streams
        // in progressively before that, so returning early yields fragments.
        const finished = data.some(m => m.type === 'idle' && m.time && m.time.created > startedAt);
        if (finished) {
          const candidates = data.filter(m => m.type === 'assistant' && m.time && m.time.created > startedAt && (m.content || []).some(p => p.type === 'text' && p.text.trim()));
          if (candidates.length) { last = candidates.sort((a, b) => b.time.created - a.time.created)[0]; break; }
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!last) throw stillRunningError(sid);
      const text = last.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      return { summary: text || '(no assistant text)', sessionId: sid, questions: [] };
    },
  };
};
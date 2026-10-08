// Status events for Instinct: queued -> running -> done|failed.
// Delivery reuses the ALREADY-CONFIGURED Upstash transport (same
// cfg.upstash_url + cfg.upstash_token as tasks/results; see
// adapters/source-upstash.js and README "Queue protocol"). No new URL,
// identity, credential, or public callback is introduced. Instinct reads
// with BLPOP bridge:status (same pattern as bridge:results). If Instinct
// is not listening, events accumulate harmlessly alongside results.
//
// Safety: events contain only {event, id, session_id, timestamp,
// status/detail, branch, summary/error truncated+scrubbed, output full-text
// capped+scrubbed}. They NEVER include task text, source diffs, config
// values, or secrets.
const log = (...a) => console.log(new Date().toISOString(), '[status]', ...a);

const MAX_TEXT = 500;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;
// Full task output carried on terminal events (done/failed). Preserves
// newlines; capped at 12KB like core.toSafeOutput, truncation labeled.
const MAX_OUTPUT = 12 * 1024;
const OUTPUT_TRUNC_SUFFIX = '\n[truncated: output exceeded 12KB]';

// Scrub anything that looks like a credential if it ever leaks into a
// summary/error string. Conservative: redacts bearer tokens, key=value
// secrets, and long hex blobs.
function scrub(s) {
  let out = String(s || '');
  out = out.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, 'Bearer [redacted]');
  out = out.replace(/(token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  out = out.replace(/\b[0-9a-f]{32,}\b/gi, '[redacted]');
  return out;
}

function safeText(s) {
  const t = scrub(s).split('\n')[0].slice(0, MAX_TEXT);
  return t;
}

function safeOutput(s) {
  let out = scrub(s == null ? '' : String(s));
  if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + OUTPUT_TRUNC_SUFFIX;
  return out;
}

function buildEvent(state, { id, sessionId, summary, error, branch, detail, output }) {
  return {
    event: state, // queued|running|done|failed
    id,
    session_id: sessionId || null,
    timestamp: new Date().toISOString(),
    eventId: `${id}:${state}`,
    ...(branch ? { branch } : {}),
    ...(detail ? { detail } : {}),
    ...(summary ? { summary: safeText(summary) } : {}),
    ...(error ? { error: safeText(error) } : {}),
    ...(output ? { output: safeOutput(output) } : {}),
  };
}

// Fire-and-forget sender. Never throws; bounded retry; never blocks task
// completion. `send` is source.sendStatus (RPUSH bridge:status).
async function emit(send, event) {
  if (typeof send !== 'function') return;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await send(event);
      return;
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) {
        log('delivery failed, dropping', event.eventId, String((e && e.message) || e).slice(0, 120));
        return;
      }
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

// Non-blocking wrapper: schedules emit without awaiting. Returns void.
function notify(send, event) {
  if (typeof send !== 'function') return;
  setImmediate(() => { emit(send, event).catch(() => {}); });
}

module.exports = { buildEvent, emit, notify, scrub, safeText, safeOutput, MAX_TEXT, MAX_OUTPUT, MAX_ATTEMPTS };

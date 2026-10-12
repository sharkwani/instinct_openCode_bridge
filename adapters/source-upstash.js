// SOURCE ADAPTER (seam 1). Contract - export create(cfg) returning:
//   next(): Promise<task|null>     block up to cfg.poll_seconds, resolve one task object or null
//   sendResult(result): Promise    publish a result object
//   push(task): Promise            supervisor side: enqueue a task
//   nextResult(waitSec): Promise<result|null>   supervisor side: read one result
// Swap this file (e.g. Telegram, SQS, websocket) to change the transport or the supervising AI's side.
const { sanitizeResult, sanitizeObject } = require('../src/sanitizer.js');
exports.create = (cfg) => {
  // Bound every Upstash call: the queue loop BLPOPs with a server-side
  // timeout, but a dropped connection would otherwise hang fetch() forever
  // with no timeout, wedging the runner silently after its current task.
  // Margin above one poll window keeps long-polls intact while guaranteeing
  // the loop always gets control back (then backs off and retries).
  const timeoutMs = Math.max(15000, (cfg.poll_seconds || 25) * 1000 + 10000);
  const call = async (...cmd) => {
    const r = await fetch(cfg.upstash_url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.upstash_token}` }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j.result;
  };
  const pop = async (key, sec) => { const r = await call('BLPOP', key, String(sec)); return r ? JSON.parse(r[1]) : null; };
  return {
    ping: () => call('PING'),
    next: () => pop('bridge:tasks', cfg.poll_seconds || 25),
    sendResult: (res) => { let safe = res; try { safe = sanitizeResult(res); } catch {} return call('RPUSH', 'bridge:results', JSON.stringify(safe)); },
    // Status channel for Instinct (queued/running/done/failed). Same
    // Upstash URL + token as tasks/results; new list key only, no new
    // credential or endpoint. Read with BLPOP bridge:status.
    sendStatus: (event) => { let safe = event; try { safe = sanitizeObject(event); } catch {} return call('RPUSH', 'bridge:status', JSON.stringify(safe)); },
    push: (task) => call('RPUSH', 'bridge:tasks', JSON.stringify(task)),
    nextResult: (sec = 20) => pop('bridge:results', sec),
  };
};


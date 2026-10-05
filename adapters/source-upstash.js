// SOURCE ADAPTER (seam 1). Contract - export create(cfg) returning:
//   next(): Promise<task|null>     block up to cfg.poll_seconds, resolve one task object or null
//   sendResult(result): Promise    publish a result object
//   push(task): Promise            supervisor side: enqueue a task
//   nextResult(waitSec): Promise<result|null>   supervisor side: read one result
// Swap this file (e.g. Telegram, SQS, websocket) to change the transport or the supervising AI's side.
exports.create = (cfg) => {
  const call = async (...cmd) => {
    const r = await fetch(cfg.upstash_url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.upstash_token}` }, body: JSON.stringify(cmd) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
    return j.result;
  };
  const pop = async (key, sec) => { const r = await call('BLPOP', key, String(sec)); return r ? JSON.parse(r[1]) : null; };
  return {
    ping: () => call('PING'),
    next: () => pop('bridge:tasks', cfg.poll_seconds || 25),
    sendResult: (res) => call('RPUSH', 'bridge:results', JSON.stringify(res)),
    push: (task) => call('RPUSH', 'bridge:tasks', JSON.stringify(task)),
    nextResult: (sec = 20) => pop('bridge:results', sec),
  };
};


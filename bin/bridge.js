#!/usr/bin/env node
// bridge init | start | push <repo> "<task>" [session_id] | result [secs]
const fs = require('node:fs');
const readline = require('node:readline/promises');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const core = require('../src/core');
const CFG = process.env.BRIDGE_CONFIG || 'bridge.config.json';
const load = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));

async function init() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, d) => (await rl.question(d ? `${q} [${d}]: ` : `${q}: `)).trim() || d || '';
  const old = fs.existsSync(CFG) ? load() : {};
  const cfg = { source: 'source-upstash', executor: 'executor-opencode', poll_seconds: 25, task_timeout_minutes: 30, opencode_bin: 'opencode', model: '', ...old };
  console.log('\nBridge setup. Create a free Redis DB at console.upstash.com and copy its REST URL + token.\n');
  for (;;) {
    cfg.upstash_url = (await ask('Upstash REST URL', old.upstash_url)).replace(/\/$/, '');
    cfg.upstash_token = await ask('Upstash REST token', old.upstash_token);
    try { await core.load(cfg).source.ping(); console.log('  connected to Upstash.'); break; }
    catch (e) { console.log('  could not connect:', e.message, '- try again.'); }
  }
  cfg.bridge_secret = old.bridge_secret || crypto.randomBytes(24).toString('hex');
  cfg.repos = { ...(old.repos || {}) };
  for (;;) {
    const p = await ask('Add a repo (absolute path, blank to finish)', '');
    if (!p) break;
    try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: p, stdio: 'ignore' }); }
    catch { console.log('  not a git repo, skipped.'); continue; }
    cfg.repos[await ask('  name for it', require('node:path').basename(p))] = p;
  }
  try { execFileSync(cfg.opencode_bin, ['--version'], { stdio: 'ignore' }); console.log('opencode found.'); }
  catch { console.log(`WARNING: "${cfg.opencode_bin}" not found on PATH; install it and run "opencode auth login".`); }
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  console.log(`\nWrote ${CFG} (chmod 600). Keep it out of git.\nbridge_secret (share with Instinct over a secure link, never in chat): ${cfg.bridge_secret}\nNext: npm start`);
  rl.close();
}

(async () => {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'init') return init();
  const cfg = load();
  if (cmd === 'start') return core.run(cfg);
  const { source } = core.load(cfg);
  if (cmd === 'push') {
    const id = 't' + Date.now().toString(36);
    await source.push({ id, secret: cfg.bridge_secret, repo: a, task: b, ...(c ? { session_id: c } : {}) });
    return console.log(id);
  }
  if (cmd === 'result') return console.log(JSON.stringify(await source.nextResult(Number(a) || 20)) );
  console.log('usage: bridge init | start | push <repo> "<task>" [session_id] | result [secs]');
})().catch(e => { console.error(e.message); process.exit(1); });


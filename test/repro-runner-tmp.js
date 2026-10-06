// Repro: bridge daemon should pick up EVERY queued task, one at a time, forever.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const core = require('../src/core');

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runner-repro-'));
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

(async () => {
  const dir = makeTempRepo();
  const SECRET = 's3cret';
  const queued = [
    { id: 't1', repo: 'main', task: 'task one', secret: SECRET },
    { id: 't2', repo: 'main', task: 'task two', secret: SECRET },
    { id: 't3', repo: 'main', task: 'task three', secret: SECRET },
  ];
  const started = [];
  const finished = [];
  const source = {
    next: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return queued.shift() || null;
    },
    sendResult: async (res) => { finished.push(res.id); },
    sendStatus: null,
  };
  const executor = {
    run: async ({ task }) => {
      started.push(task);
      await new Promise((r) => setTimeout(r, 50));
      return { sessionId: 'ses_x', summary: 'ok ' + task, questions: [] };
    },
  };
  core.load = () => ({ source, executor });
  core.startHttp = () => {};

  const cfg = { repos: { main: dir }, bridge_secret: SECRET, task_timeout_minutes: 30 };
  const timeout = setTimeout(() => {
    console.log(JSON.stringify({ started: started.length, finished: finished.length }));
    console.log(started.length === 3 && finished.length === 3 ? 'PASS: all 3 tasks picked up' : 'FAIL: runner stalled — only picked up ' + started.length + ' of 3');
    process.exit(started.length === 3 && finished.length === 3 ? 0 : 1);
  }, 8000);

  core.run(cfg).catch((e) => { console.log('RUN CRASHED', e); process.exit(2); });
  const iv = setInterval(() => {
    if (started.length === 3 && finished.length === 3) {
      clearInterval(iv); clearTimeout(timeout);
      console.log('PASS: all 3 tasks picked up one at a time:', JSON.stringify(finished));
      process.exit(0);
    }
  }, 100);
})();

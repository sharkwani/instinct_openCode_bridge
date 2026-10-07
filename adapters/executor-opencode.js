// EXECUTOR ADAPTER (seam 2). Contract - export create(cfg) returning:
//   run({ task, cwd, sessionId, timeoutMs }) -> Promise<{ sessionId, summary, questions: string[] }>
// It runs the coding agent inside cwd (already on the safe branch) and reports back. Throw on failure.
// Swap this file for Codex, Claude Code, etc.
const { execFile } = require('node:child_process');
const RULE = '\n\n(Bridge rule: stay on the current git branch; never switch to or commit on main/master. Commit your work here. If you need a decision from the user, end your reply with a clear question.)';

exports.create = (cfg) => ({
  bin: cfg.opencode_bin || 'opencode',
  run({ task, cwd, sessionId, timeoutMs }) {
    const args = ['run', '--auto', '--format', 'json'];
    if (sessionId) args.push('--session', sessionId);
    if (cfg.model) args.push('--model', cfg.model);
    args.push(task + RULE);
    return new Promise((resolve, reject) => {
      
      const child= execFile(this.bin, args, { cwd, timeout: timeoutMs, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout) => {
        if (err && err.killed) return reject(new Error(`timed out after ${Math.round(timeoutMs / 60000)} min`));
        if (err && !stdout) return reject(err);
        // `--format json` emits JSON event lines; shape is parsed defensively (verify on your version).
        let sid = sessionId || null; const texts = [];
        for (const line of stdout.split('\n')) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          sid = sid || e.sessionID || e.part?.sessionID || null;
          if (e.type === 'text' && (e.part?.text || e.text)) texts.push(e.part?.text || e.text);
        }
        const summary = texts.join('\n').trim();
        const last = summary.split(/\n\s*\n/).pop() || '';
        resolve({ sessionId: sid, summary, questions: last.split('\n').map(s => s.trim()).filter(s => s.endsWith('?')) });
      });
      if (child.stdin) child.stdin.end();
    });
  },
});


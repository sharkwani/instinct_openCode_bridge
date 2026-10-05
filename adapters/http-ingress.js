
const express = require('express');
const fs = require('fs');

function startHttpIngress({ secret, port, runTask, resultsFile }) {
  const app = express();
  app.use(express.json());
  const results = new Map();

  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); results.set(r.id, r); } catch {}
    }
  }

  function gate(req, res, next) {
    if (req.get('X-Bridge-Secret') !== secret) return res.status(401).json({ error: 'bad secret' });
    next();
  }

  app.post('/tasks', gate, async (req, res) => {
    const { id, repo, prompt } = req.body || {};
    if (!id || !repo || !prompt) return res.status(400).json({ error: 'need {id, repo, prompt}' });
    if (results.has(id)) return res.status(409).json({ error: 'duplicate id' });
    results.set(id, { id, status: 'running' });
    res.json({ id, status: 'accepted' });
    try {
      const out = await runTask({ id, repo, prompt });
      const done = { id, status: 'done', summary: out && out.summary ? out.summary : String(out), diff: out && out.diff };
      results.set(id, done);
      fs.appendFileSync(resultsFile, JSON.stringify(done) + '\n');
    } catch (err) {
      const failed = { id, status: 'error', error: String((err && err.message) || err) };
      results.set(id, failed);
      fs.appendFileSync(resultsFile, JSON.stringify(failed) + '\n');
    }
  });

  app.get('/results/:id', gate, (req, res) => {
    const r = results.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'unknown id' });
    res.json(r);
  });

  app.listen(port, '127.0.0.1', () => console.log('http ingress on :' + port));
}

module.exports = { startHttpIngress };
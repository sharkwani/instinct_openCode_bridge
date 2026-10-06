const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_JSON = path.join(__dirname, '..', 'opencode.json');
const load = () => JSON.parse(fs.readFileSync(PROJECT_JSON, 'utf8'));
const bridgeRepos = () => {
  try {
    return Object.values(require('../bridge.config.json').repos || {});
  } catch {
    return ['/Users/srw/WebstormProjects/letAiChatWithEachOther/instinct-bridge'];
  }
};

describe('bridge approval config: project-scoped, no yolo', () => {
  it('opencode.json exists with schema and object permission (never bare allow)', () => {
    assert.ok(fs.existsSync(PROJECT_JSON), 'opencode.json must exist at project root');
    const cfg = load();
    assert.equal(cfg.$schema, 'https://opencode.ai/config.json');
    assert.ok(cfg.permission && typeof cfg.permission === 'object', 'permission must be an object, not allow');
    assert.notEqual(cfg.permission['*'], 'allow', 'no global allow-all');
  });

  it('edit is deny-by-default with allow only under bridge repo roots', () => {
    const edit = load().permission.edit;
    assert.ok(edit && typeof edit === 'object');
    assert.equal(edit['*'], 'deny', 'edit catch-all must be deny');
    const repos = bridgeRepos();
    const allows = Object.entries(edit).filter(([, v]) => v === 'allow').map(([k]) => k);
    assert.ok(allows.length > 0, 'need at least one edit allow');
    for (const a of allows) {
      // Absolute allows must sit under a bridge root; relative allows are
      // project-scoped by definition but must not escape with '..'.
      // ('*' is segment-scoped: it does not cross '/', hence per-dir entries.)
      if (a.startsWith('/')) {
        assert.ok(repos.some((r) => a.startsWith(r)), `edit allow pattern outside bridge roots: ${a}`);
      } else {
        assert.ok(!a.includes('..'), `edit allow pattern escapes project: ${a}`);
      }
    }
    for (const r of repos) {
      assert.ok(allows.some((a) => a.startsWith(r)), `repo root not covered by edit allow: ${r}`);
    }
  });

  it('bash is ask-by-default, allows safe prefixes, denies destructive', () => {
    const bash = load().permission.bash;
    assert.ok(bash && typeof bash === 'object');
    assert.equal(bash['*'], 'ask', 'bash catch-all must be ask, not allow');
    for (const p of ['git *', 'npm *', 'node *', 'npx *']) {
      assert.equal(bash[p], 'allow', `expected bash allow: ${p}`);
    }
    for (const p of ['sudo *', 'rm -rf *', 'git push *']) {
      assert.equal(bash[p], 'deny', `expected bash deny: ${p}`);
    }
  });

  it('external_directory denies everything outside the session cwd', () => {
    const ext = load().permission.external_directory;
    assert.ok(ext && typeof ext === 'object');
    assert.equal(ext['*'], 'deny');
    const allows = Object.entries(ext).filter(([, v]) => v === 'allow');
    assert.equal(allows.length, 0, 'no external paths allowed; bridge sessions run with cwd=repo root');
  });

  it('no secrets or system paths leak into opencode.json', () => {
    const raw = fs.readFileSync(PROJECT_JSON, 'utf8');
    assert.ok(!/upstash|bridge_secret|opencodeServerPassword/i.test(raw));
    assert.ok(!/\/etc\/|\/Library\/|\/root\//.test(raw), 'must not reference system paths');
  });

  it('risky network tools stay ask (not allow)', () => {
    const p = load().permission;
    assert.equal(p.webfetch, 'ask');
    assert.equal(p.websearch, 'ask');
  });
});

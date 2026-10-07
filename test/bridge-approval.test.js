const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_JSON = path.join(__dirname, '..', 'opencode.json');
const load = () => JSON.parse(fs.readFileSync(PROJECT_JSON, 'utf8'));

const EXPECTED_RELATIVE_ALLOWS = [
  'adapters/*',
  'bin/*',
  'src/*',
  'test/*',
  'LICENSE',
  'README.md',
  'package.json',
];

const PROTECTED_EDIT_DENIES = [
  'bridge.config.json',
  'opencode.json',
  '.env',
  '.env.*',
  '*.env',
  '*.env.*',
  '*.log',
  'results.jsonl',
];

const isAbsolutePosix = (p) => p.startsWith('/');
const isWindowsDrive = (p) => /^[A-Za-z]:[\\/]/.test(p);
const isUnc = (p) => p.startsWith('\\\\');
const isHomeExpansion = (p) => p === '~' || p.startsWith('~/');
const isGenericCatchAll = (p) => p === '*' || p === '**';

const isInvalidEditAllow = (p) => {
  if (isAbsolutePosix(p)) return true;
  if (isWindowsDrive(p)) return true;
  if (isUnc(p)) return true;
  if (isHomeExpansion(p)) return true;
  if (p.includes('..')) return true;
  if (isGenericCatchAll(p)) return true;
  if (PROTECTED_EDIT_DENIES.includes(p)) return true;
  return false;
};

describe('bridge approval config: project-scoped, no yolo', () => {
  it('opencode.json exists with schema and object permission (never bare allow)', () => {
    assert.ok(fs.existsSync(PROJECT_JSON), 'opencode.json must exist at project root');
    const raw = fs.readFileSync(PROJECT_JSON, 'utf8');
    const cfg = JSON.parse(raw);
    assert.equal(cfg.$schema, 'https://opencode.ai/config.json');
    assert.ok(cfg.permission && typeof cfg.permission === 'object', 'permission must be an object, not allow');
    assert.notEqual(cfg.permission['*'], 'allow', 'no global allow-all');
  });

  it('edit is deny-by-default with project-scoped relative allows only', () => {
    const edit = load().permission.edit;
    assert.ok(edit && typeof edit === 'object');
    assert.equal(edit['*'], 'deny', 'edit catch-all must be deny');
    const allows = Object.entries(edit).filter(([, v]) => v === 'allow').map(([k]) => k);
    assert.ok(allows.length > 0, 'need at least one edit allow');
    for (const a of EXPECTED_RELATIVE_ALLOWS) {
      assert.equal(edit[a], 'allow', `expected shipped edit allow: ${a}`);
    }
    for (const a of allows) {
      assert.ok(!isAbsolutePosix(a), `absolute POSIX path not allowed: ${a}`);
      assert.ok(!isWindowsDrive(a), `Windows drive path not allowed: ${a}`);
      assert.ok(!isUnc(a), `UNC path not allowed: ${a}`);
      assert.ok(!isHomeExpansion(a), `home expansion not allowed: ${a}`);
      assert.ok(!a.includes('..'), `edit allow pattern escapes project: ${a}`);
      assert.ok(!isGenericCatchAll(a), `generic catch-all allow not permitted: ${a}`);
      assert.ok(!PROTECTED_EDIT_DENIES.includes(a), `protected file must not be allowed: ${a}`);
      assert.ok(!a.startsWith('/'), `edit allows must be relative project-scoped: ${a}`);
    }
  });

  it('edit explicitly denies protected config/env/runtime files', () => {
    const edit = load().permission.edit;
    for (const p of PROTECTED_EDIT_DENIES) {
      assert.equal(edit[p], 'deny', `protected path must be explicitly denied: ${p}`);
    }
  });

  it('edit rejects invalid path rules and protected files (negative cases)', () => {
    const invalid = [
      '/tmp/evil',
      '/Users/someone/repo',
      'C:\\Windows\\evil',
      'C:/evil',
      '\\\\server\\share',
      '~/evil',
      '../escape',
      'src/../../escape',
      '*',
      '**',
      'bridge.config.json',
      'opencode.json',
      '.env',
      'results.jsonl',
    ];
    for (const p of invalid) {
      assert.ok(isInvalidEditAllow(p), `expected invalid edit allow to be rejected: ${p}`);
    }
    const valid = [...EXPECTED_RELATIVE_ALLOWS];
    for (const p of valid) {
      assert.ok(!isInvalidEditAllow(p), `expected valid edit allow to be accepted: ${p}`);
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

  it('read/glob/grep/list stay permissive with env-file denials on read', () => {
    const p = load().permission;
    assert.equal(p.glob, 'allow');
    assert.equal(p.grep, 'allow');
    assert.equal(p.list, 'allow');
    const read = p.read;
    assert.ok(read && typeof read === 'object');
    assert.equal(read['*'], 'allow');
    for (const pat of ['.env', '.env.*', '*.env', '*.env.*']) {
      assert.equal(read[pat], 'deny', `expected read deny: ${pat}`);
    }
  });
});

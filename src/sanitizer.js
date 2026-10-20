// Sanitization module for the instinct-bridge
// Centralized redaction of secrets from all outward/persisted data
// No canary exemptions: every synthetic or real secret is redacted.

const SECRET_PATTERNS = [
  /API_KEY$/i,
  /^PASSWORD$/i,
  /SECRET$/i,
  /TOKEN$/i,
  /PRIVATE_KEY$/i,
  /SECRET_KEY$/i,
  /ACCESS_KEY$/i,
  /SECRET_ID$/i,
  /CLIENT_SECRET$/i,
  /AUTH_TOKEN$/i,
  /BEARER_TOKEN$/i,
  /JWT_SECRET$/i,
  /WEBHOOK_SECRET$/i,
  /DATABASE_PASSWORD$/i,
  /DB_PASSWORD$/i,
  /REDIS_PASSWORD$/i,
];

let secretRegistryLoaded = false;
let customSecretRegistry = null;

function isSecretKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  const upper = key.toUpperCase();
  if (SECRET_PATTERNS.some((p) => p.test(upper))) return true;
  // Alias coverage: strip separators and match substrings so
  // apiKey/password/authorization/upstash_token/basic_auth all hit.
  const norm = upper.replace(/[^A-Z0-9]/g, '');
  const tokens = [
    'APIKEY',
    'PASSWORD',
    'PASSWD',
    'SECRET',
    'TOKEN',
    'PRIVATEKEY',
    'ACCESSKEY',
    'CLIENTSECRET',
    'AUTHTOKEN',
    'BEARER',
    'AUTHORIZATION',
    'BASICAUTH',
    'CREDENTIAL',
    'UPSTASHTOKEN',
    'BRIDGESECRET',
    'WEBHOOKSECRET',
    'JWTSECRET',
  ];
  return tokens.some((t) => norm.includes(t));
}

function looksLikeSecret(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 16) return false;
  if (value.length >= 40 && /^[A-Za-z0-9+/=]+$/.test(value)) return true;
  if (/^sk-[a-zA-Z0-9]{32,}$/.test(value)) return true;
  if (/^sk_live_[a-zA-Z0-9]{24,}$/.test(value)) return true;
  if (value.startsWith('sk_') && value.length > 20) return true;
  if (value.startsWith('sk-') && value.length > 20) return true;
  if (value.startsWith('Bearer ') && value.length > 20) return true;
  if (value.startsWith('Basic ') && value.length > 20) return true;
  return false;
}

function isPrintableAscii(s) {
  return /^[\x20-\x7E]*$/.test(s);
}

// Only decode when caller already knows the field is secret/auth.
// Returns {decoded,password} or null. No arbitrary decode of every string.
function tryDecodeUserPass(b64) {
  if (typeof b64 !== 'string') return null;
  if (b64.length < 16) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  if (b64.length % 4 !== 0) return null;
  try {
    const dec = Buffer.from(b64, 'base64').toString('utf8');
    if (!dec || !dec.includes(':')) return null;
    if (!isPrintableAscii(dec)) return null;
    const re = Buffer.from(dec, 'utf8').toString('base64');
    if (re !== b64) return null;
    const idx = dec.indexOf(':');
    const user = dec.slice(0, idx);
    const pass = dec.slice(idx + 1);
    if (!user || !pass) return null;
    if (user.length > 64 || pass.length > 256) return null;
    return { decoded: dec, password: pass };
  } catch {
    return null;
  }
}

function addSecretVariants(key, val, out) {
  if (typeof val !== 'string' || val.length === 0) return;
  out.push(val);
  try {
    const b64 = Buffer.from(val, 'utf8').toString('base64');
    if (b64 && b64 !== val) out.push(b64);
    // If the stored value is already decoded user:pass, pre-register Basic forms of its encoding.
    if (val.includes(':') && isPrintableAscii(val) && isSecretKey(key)) {
      out.push('Basic ' + b64);
      out.push('Authorization: Basic ' + b64);
    }
  } catch {}
  // Explicit secret/auth field holding canonical base64 user:password.
  if (isSecretKey(key)) {
    const d = tryDecodeUserPass(val);
    if (d) {
      out.push(d.decoded);
      out.push(d.password);
      out.push('Basic ' + val);
      out.push('Basic ' + d.decoded);
      out.push('Authorization: Basic ' + val);
    }
  }
}

function collectFromConfig(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') collectFromConfig(item, out, seen);
    }
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && v.length > 0) {
      if (isSecretKey(k)) {
        addSecretVariants(k, v, out);
      } else if (looksLikeSecret(v)) {
        out.push(v);
      }
    } else if (v && typeof v === 'object') {
      collectFromConfig(v, out, seen);
    }
  }
}

function loadSecretRegistry(config, opts = {}) {
  const hasExplicitConfig = config !== undefined && config !== null;
  // Cache semantics: refresh only on explicit load (or forced). Otherwise use cache.
  if (secretRegistryLoaded && !hasExplicitConfig && !opts.force) return;
  if (secretRegistryLoaded && hasExplicitConfig && opts.useCache && !opts.force) return;

  const found = [];
  if (config && typeof config === 'object') {
    collectFromConfig(config, found, new Set());
  }
  if (!opts.skipEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && value.length > 0) {
        if (isSecretKey(key)) {
          addSecretVariants(key, value, found);
        } else if (looksLikeSecret(value)) {
          found.push(value);
        }
      }
    }
  }
  customSecretRegistry = new Set(found.filter((s) => typeof s === 'string' && s.length >= 4));
  secretRegistryLoaded = true;
}

function _resetRegistryForTests() {
  secretRegistryLoaded = false;
  customSecretRegistry = null;
}

function getSecretRegistry() {
  if (!secretRegistryLoaded) {
    loadSecretRegistry(null);
  }
  return customSecretRegistry || new Set();
}

function isPreservedHexId(s) {
  return /^[0-9a-fA-F]{40,64}$/.test(s);
}

// Narrow metric exception: numeric usage counters must survive even though
// their names contain TOKEN. No broad token exemption: strings still redact.
function isMetricNumericKey(key, value) {
  if (typeof value !== 'number') return false;
  if (typeof key !== 'string') return false;
  const norm = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (norm === 'TOKENCOUNT') return true;
  if (norm.endsWith('TOKENS')) return true;
  return false;
}

function sortedRegistrySecrets() {
  const reg = getSecretRegistry();
  return [...reg].filter((s) => typeof s === 'string' && s.length >= 4).sort((a, b) => b.length - a.length);
}

function sanitizeString(str, options = {}) {
  if (typeof str !== 'string') return str;
  if (str.length === 0) return str;
  let result = str;
  // Longer secrets first to avoid partial-overlap leak.
  for (const secret of sortedRegistrySecrets()) {
    if (result.includes(secret)) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  let out = result;
  const patterns = [
    { pattern: /(Authorization:\s*Basic\s+)([A-Za-z0-9+/=]+)/gi, replacement: '$1[REDACTED]' },
    { pattern: /(Bearer\s+)([A-Za-z0-9\-._~+/=]+)/gi, replacement: '$1[REDACTED]' },
    { pattern: /(api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|secret[_-]?key|secret[_-]?token)["\s:=]+([A-Za-z0-9\-._~+/]{16,})/gi, replacement: '$1=[REDACTED]' },
    { pattern: /(eyJ[A-Za-z0-9\-_=]+\.eyJ[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+)/g, replacement: '[REDACTED_JWT]' },
    { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: '[REDACTED_AWS_KEY]' },
    { pattern: /(-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA )?PRIVATE KEY-----)/gi, replacement: '[REDACTED_PRIVATE_KEY]' },
    { pattern: /\b([A-Za-z0-9+/]{38,}={0,2})/g, replacement: (match) => {
      if (isPreservedHexId(match)) return match;
      // Preserve low-entropy filler (e.g. 'x'.repeat(13KB) truncation tests) — real
      // secrets are high-entropy. Single-char repeats or <=2 distinct chars are not secrets.
      try { if (new Set(match).size <= 2) return match; } catch {}
      if (match.length >= 40 && /^[A-Za-z0-9+/]+={0,2}$/.test(match)) return '[REDACTED_BASE64]';
      return match;
    }},
    { pattern: /(key|secret|token|password|credential)["\s:=]+([A-Za-z0-9\-._~+/]{16,})/gi, replacement: '$1=[REDACTED]' },
  ];
  for (const { pattern, replacement } of patterns) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactByKey(key, value, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length === 0) return value;
    return '[REDACTED]';
  }
  if (typeof value !== 'object') return '[REDACTED]';
  return '[REDACTED]';
}

function sanitizeObject(obj, seen = new WeakSet()) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return sanitizeString(obj);
  if (typeof obj !== 'object') return obj;
  if (seen.has(obj)) return '[Circular]';
  seen.add(obj);
  if (obj instanceof Error) {
    const out = { name: obj.name || 'Error' };
    if (obj.message !== undefined) out.message = sanitizeObject(obj.message, seen);
    if (obj.stack !== undefined) out.stack = sanitizeObject(String(obj.stack), seen);
    for (const [k, v] of Object.entries(obj)) {
      const sk = sanitizeString(k);
      if (isMetricNumericKey(k, v)) { out[sk] = v; continue; }
      out[sk] = isSecretKey(k) ? redactByKey(k, v, seen) : sanitizeObject(v, seen);
    }
    return out;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, seen));
  }
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const sanitizedKey = sanitizeString(key);
    if (isMetricNumericKey(key, value)) {
      result[sanitizedKey] = value;
    } else if (isSecretKey(key)) {
      result[sanitizedKey] = redactByKey(key, value, seen);
    } else {
      result[sanitizedKey] = sanitizeObject(value, seen);
    }
  }
  return result;
}

function sanitizeResult(result) {
  if (!result) return result;
  const sanitized = sanitizeObject(result);
  return {
    ...sanitized,
    id: sanitized.id,
    status: sanitized.status,
    branch: sanitized.branch,
    session_id: sanitized.session_id,
    summary: sanitized.summary,
    diffstat: sanitized.diffstat,
    questions: sanitized.questions,
    error: sanitized.error,
  };
}

function sanitizeForHttpResponse(obj) {
  const sanitized = sanitizeObject(obj);
  return JSON.parse(JSON.stringify(sanitized));
}

function sanitizeForPersistence(obj) {
  return sanitizeObject(obj);
}

function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

function createSanitizedResultHook(cfg) {
  return (result) => {
    if (cfg) {
      loadSecretRegistry(cfg);
    }
    return sanitizeResult(result);
  };
}

module.exports = {
  loadSecretRegistry,
  _resetRegistryForTests,
  getSecretRegistry,
  sanitizeString,
  sanitizeObject,
  sanitizeResult,
  sanitizeForHttpResponse,
  sanitizeForPersistence,
  createSanitizedResultHook,
  escapeHtml,
  isSecretKey,
  looksLikeSecret,
};

// The fixtures are public: synthetic content only. This scan states what a fixture may hold (an
// allowlist where one applies: model ids, time zones, URLs) and refuses what a capture from a real
// machine would leak, by pattern, never by naming a real value (that would leak it here instead).
// Text and binary files are both scanned as bytes, and so is every base64 run inside them, decoded
// (and inflated when it is zstd or gzip), so nothing hides in an encoded field or a blob.
//
// Known limits. None hides a value in today's fixtures, and the scan of the published export is
// the gate:
// - JSON inside JSON strings is read to three levels, and quoting is unescaped to two levels
//   (modelValues);
// - in text that is not JSON, a model value that starts with `[` or `{` and does not parse is
//   skipped as a fragment;
// - in JavaScript, an array literal of strings under a model key (`models: ['…']`) and a quoted key
//   (`'model': '…'`) are not read; only `.js` and `.mjs` files are read as JavaScript (not `.cjs`);
// - a URL with escaped slashes (`http:\/\/host.example:8080`) is not checked for a port, and a port
//   of six or more digits is not matched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodedOf } from '../conformance/decode.js';
import { fileURLToPath } from 'node:url';
import { filesOf } from '../conformance/runner.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// The one synthetic user the fixtures may name in a home path.
const HOME_OK = new Set(['user']);
// Documentation and loopback addresses only (RFC 5737, RFC 3849 style).
const IP_OK = [/^127\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./, /^0\.0\.0\.0$/];
const MAIL_OK = /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i;
// The model ids a fixture may name: the synthetic gateway models, and public vendor and placeholder
// names. A model field holding anything else fails, so a capture's real route never shows.
const TOY_MODEL = /^(?:(?:gateway|toy)\/)?toy-model(?:-[a-z])?$/;
const VENDOR_MODELS = new Set([
  'claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5', 'gpt-5', 'gpt-5-codex', 'gpt-6-luna', 'GPT-6 Luna',
  'gemini-3.5-flash', 'gemini-4-argon', 'grok-4.6', 'cursor-grok-4.5-high', 'swe-1-6-slow', 'mai-code-1.1-flash', 'copilot/auto',
]);
const PLACEHOLDER_MODELS = new Set(['auto', 'default', 'inherit', 'router', 'other', 'compactor', 'fake-1', 'mock-model', '<synthetic>', 'MODEL_PLACEHOLDER_M417', 'Subagent Default']);
// Display names a harness stores beside the id.
const MODEL_DISPLAY_NAMES = new Set(['Gemini 4 Argon (High)']);
// Any key that names a model, in any case, is checked; the allowlist decides. A key for the id of a
// message or a call (`modelMessageId`, `modelCallId`, `model_call_id`) holds no model name.
const isModelKey = (k) => /model/i.test(k) && !/(message|call)_?id$/i.test(k);
const modelOk = (v) => v === '' || TOY_MODEL.test(v) || VENDOR_MODELS.has(v) || PLACEHOLDER_MODELS.has(v) || MODEL_DISPLAY_NAMES.has(v);

// Every model field's decoded value, whatever its length or escapes:
// - the text's JSON values (a file, or one per line), walked structurally: a string, or each string
//   of an array, under a model key; JSON held in a string is parsed and walked in turn, to a depth
//   of three (a fourth level of JSON inside JSON strings is not read);
// - for text that is not JSON (a decoded blob, a line cut by a capture tool), each
//   `"key": "value"` and `"key": ["…", …]` pair, also after unescaping one and two quoting levels
//   (JSON quoted inside a string once or twice); deeper quoting is not unescaped;
// - for a JavaScript source (a generator), each `key: '…'` and `key: "…"`, its escapes decoded.
// An array encoded as JSON in a model field is still under that field: its strings are checked.
function modelValues(text, js = false) {
  const out = [];
  const walk = (x, depth, key) => {
    if (typeof x === 'string') {
      if (depth < 3 && /^\s*[[{]/.test(x)) {
        try { walk(JSON.parse(x), depth + 1, key); return; } catch { /* not JSON */ }
      }
      if (key) out.push([key, x]);
    } else if (Array.isArray(x)) for (const v of x) walk(v, depth, key);
    else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) walk(v, depth, isModelKey(k) ? k : undefined);
    }
  };
  const docs = [];
  try { docs.push(JSON.parse(text)); } catch {
    for (const line of text.split('\n')) { try { docs.push(JSON.parse(line)); } catch { /* not a JSON line */ } }
  }
  for (const d of docs) walk(d, 0);
  const str = (body) => {
    try { return JSON.parse(`"${body}"`); } catch { return body; }
  };
  // A JavaScript literal's value: \xHH, \uHHHH, \u{H…} and the one-letter escapes decoded.
  const ONE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  const jsStr = (body) => body.replace(/\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|u\{([0-9A-Fa-f]{1,6})\}|(.))/g, (m, x, u, cp, c) => {
    if (x || u) return String.fromCharCode(parseInt(x || u, 16));
    if (cp) return parseInt(cp, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(cp, 16)) : m;
    return ONE[c] ?? c;
  });
  // A value that is itself JSON (`model_config_json`) is walked, not compared whole.
  const take = (k, v) => {
    if (/^\s*[[{]/.test(v)) {
      // JSON, or a fragment of JSON cut at a quote an unescaping pass exposed: the next pass reads it.
      try { walk(JSON.parse(v), 1, k); } catch { /* a fragment */ }
      return;
    }
    out.push([k, v]);
  };
  const unescape = (t) => t.replace(/\\(["\\])/g, '$1');
  for (const t of [text, unescape(text), unescape(unescape(text))]) {
    for (const m of t.matchAll(/"([^"\\]*model[^"\\]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi)) if (isModelKey(m[1])) take(m[1], str(m[2]));
    for (const m of t.matchAll(/"([^"\\]*model[^"\\]*)"\s*:\s*\[((?:\s*"(?:[^"\\]|\\.)*"\s*,?)*)\]/gi)) {
      if (!isModelKey(m[1])) continue;
      for (const e of m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)) take(m[1], str(e[1]));
    }
  }
  if (js) {
    for (const m of text.matchAll(/\b(\w*model\w*)\s*:\s*(['"])((?:(?!\2)[^\\\n]|\\.)*)\2/gi)) if (isModelKey(m[1])) take(m[1], jsStr(m[3]));
  }
  return out;
}

function findings(text, js = false) {
  const out = [];
  for (const m of text.matchAll(/(?:\/home\/|\/Users\/|C:\\\\?Users\\\\?)([A-Za-z0-9._-]+)/g)) {
    if (!HOME_OK.has(m[1])) out.push(`home path for "${m[1].slice(0, 1)}…"`);
  }
  for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const ip = m[0];
    // A protobuf field path in a decoded dump (`5.26.1.2 msg[11]`, `5.26.1.2.1 v=…`) is not an
    // address: it continues with `.N`, follows `N.`, or is followed by a dump marker.
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    const after = text.slice(m.index + ip.length, m.index + ip.length + 6);
    if (/\d\.$/.test(before) || /^(\.\d| (msg|str|bytes)\[| (v|len|f32|f64)=)/.test(after)) continue;
    if (m.slice(1).every((x) => Number(x) <= 255) && !IP_OK.some((re) => re.test(ip))) out.push('an IPv4 address outside the documentation ranges');
  }
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (!MAIL_OK.test(m[0])) out.push('an e-mail address outside example domains');
  }
  if (/\b[a-z0-9-]+\.local\b/i.test(text)) out.push('a .local host name');
  // A capture's local time zone says where its machine was: fixture times are UTC.
  if (/\d\d:\d\d:\d\d(?:\.\d+)? ?[+-](?!00:?00)\d\d:?\d\d\b/.test(text)) out.push('a time with a local UTC offset');
  if (/\(UTC[+-]\d{1,2}\)/.test(text)) out.push('a local UTC offset');
  if (/\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(text)) out.push('a credential-shaped token');
  // A model reached through a gateway is `gateway/toy-model` (a letter suffix tells several apart).
  // The whole token is compared, so an allowed prefix (`toy-model-production`) does not pass.
  for (const m of text.matchAll(/gateway\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g)) {
    if (!TOY_MODEL.test(m[1])) { out.push('a gateway model id outside the allowlist'); break; }
  }
  for (const [k, v] of modelValues(text, js)) {
    if (!modelOk(v)) { out.push(`a ${k} value outside the allowlist`); break; }
  }
  // A URL names no port: a fixture's endpoints are documentation hosts on their default port.
  // Any scheme, in any case; with or without userinfo (`user[:pass]@`); a name, an IPv4 or a
  // bracketed IPv6 host.
  if (/\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s"'\\@]*@)?(?:\[[0-9A-Fa-f:.]+\]|[^/\s"'\\:@[\]]+):\d{1,5}(?!\d)/i.test(text)) out.push('a URL with an explicit port');
  return out;
}

test('fixtures: nothing a real machine would leak', () => {
  const bad = [];
  for (const rel of filesOf(ROOT)) {
    const text = fs.readFileSync(path.join(ROOT, rel)).toString('latin1');
    for (const f of findings(text, /\.m?js$/.test(rel))) bad.push(`${rel}: ${f}`);
    for (const d of decodedOf(text)) for (const f of findings(d)) bad.push(`${rel} (decoded): ${f}`);
  }
  assert.deepEqual(bad, []);
});

test('fixtures scan: catches what it is for', () => {
  assert.ok(findings('cwd: /home/someone/repo').length);
  for (const leak of ['"model":"gateway/some-model"', '{"model":"gateway/toy-model-production"}', 'gateway/toy-model-a-private', 'gateway/toy-model.foo',
    '{"served_model":"some-vendor/unlisted-model"}', '{\\"modelId\\":\\"unlisted\\"}', 'http://host.example:8080/v1', 'http://localhost:9/mcp', 'http://[::1]:8080/v1',
    '{"model":"unlisted\\/private-model"}', 'http://user:secret@host.example:8443/x', 'HTTPS://HOST.EXAMPLE:443/', 'ftp://anon@files.example:21/',
    '{"model_id":"unlisted"}', '{"Model":"unlisted"}', '{"availableModels":["gpt-5","unlisted"]}', '"preferredModels": ["unlisted"]', `{"model":"${'x'.repeat(200)}"}`, '{"payload":"{\\"selectedModel\\":\\"unlisted\\"}"}', JSON.stringify({ model: JSON.stringify(['unlisted']) }), 'cut "model": "[\\"unlisted\\"]"', '12:00:00+05:00', 'Mon (UTC+5)']) {
    assert.ok(findings(leak).length, leak);
  }
  // A generator's JavaScript: `key: '…'` and `key: "…"` are read only in .js/.mjs sources.
  for (const leak of ["{ model: 'unlisted' }", '{ selectedModel: "unlisted" }', "{ response_model: 'unlisted' }", String.raw`{ model: '\x75nlisted' }`]) assert.ok(findings(leak, true).length, leak);
  // Escapes are decoded first, so another spelling of a listed id passes.
  assert.deepEqual(findings(String.raw`{ model: '\u0067pt-5', modelName: '\x67pt-5', requestedModel: "gpt\x2d5", fallbackModel: '\u{67}pt-5', altModel: 'gpt\-5' }`, true), []);
  assert.deepEqual(findings("{ model: 'gpt-5', requestedModel: 'gateway/toy-model-a', modelCallId: 'call-1' }", true), []);
  assert.deepEqual(findings('{"modelMessageId":"m-1","model_call_id":"c-1","model_config_json":"{\\"model_name\\":\\"gateway/toy-model-a\\"}","availableModels":["gpt-5"]}'), []);
  assert.deepEqual(findings('{"model":"gateway/toy-model","served_model":"gateway/toy-model-b","modelId":"gpt-5"} served by gateway/toy-model-a at https://api.example/v1, 10:00:00+00:00'), []);
  assert.ok(findings('ssh 10.1.2.3').length);
  assert.ok(findings('mail a.person@university.edu').length);
  assert.deepEqual(findings('cwd /home/user/repo, host 192.0.2.7, mail dev@example.com, 2026.01.02.10'), []);
  // Protobuf field paths in decoded dumps are not addresses; an address beside one still is.
  assert.deepEqual(findings('      5.26.1.2 msg[11]\n        5.26.1.2.1 v=17'), []);
  assert.ok(findings('      5.26.1.2 msg[11] url http://10.0.0.9/x').length);
});

test('fixtures scan: decodes base64 fields and compressed blobs', () => {
  const leak = '{"cwd":"/home/someone/repo"}';
  const b64 = Buffer.from(leak).toString('base64');
  const hits = (text) => decodedOf(text).flatMap(findings);
  // An encoded field inside JSON text, as in a captured `toolCallBinary`.
  assert.ok(hits(JSON.stringify({ toolCallBinary: b64 })).length);
  // url-safe, and nested: base64 of a JSON text that holds base64.
  assert.ok(hits(Buffer.from(JSON.stringify({ blob: b64 })).toString('base64url')).length);
  // A zstd or gzip blob parameter of a database fixture. The second `/home/` is a back-reference in
  // the compressed bytes, so only the inflated text shows the path.
  const doc = Buffer.from(JSON.stringify({ a: '/home/user/x', b: '/home/user/y', cwd: '/home/someone/repo' }));
  for (const packed of [zlib.zstdCompressSync(doc), zlib.gzipSync(doc)]) {
    assert.deepEqual(findings(packed.toString('latin1')), []);
    assert.ok(hits(JSON.stringify({ params: [{ $b64: packed.toString('base64') }] })).length);
  }
  assert.deepEqual(hits(JSON.stringify({ toolCallBinary: Buffer.from('{"cwd":"/home/user/repo"}').toString('base64') })), []);
});

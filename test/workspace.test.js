// The session adapters package stays self-contained (design note §7.3).
// An allowlist, checked over every .js, .mjs and .cjs file in the package, fixtures included.
// Comments are stripped first. Each module specifier (static imports, side-effect imports,
// re-exports, import() and require()) must be a node: builtin, a relative
// path that stays inside the package once percent-decoded, the package itself, or a name in
// its own dependencies; hs and memhouse never. A non-literal specifier fails, and so does a
// template literal other than a './' path whose ${} parts are plain identifiers. Loaders that
// hide a specifier fail too (createRequire, import.meta.resolve, module.require,
// process.mainModule, new Worker, a bare eval or Function call), as do a symlink in the
// package and a package.json main or export that points outside it.
//
// It is a tripwire against mistakes, not a sandbox: deliberate obfuscation (escaped
// identifiers, code read from a file and run) is out of its scope, and it would rather miss
// such a trick than block ordinary adapter code. node:child_process stays allowed, since the
// shared host code runs ioreg on macOS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = path.join(repo, 'packages', 'harness-session-adapters');
// Never allowed, even when listed as a dependency: the package depends on neither tool.
const FORBIDDEN = ['harness-skeleton', 'memhouse'];

function jsFiles(dir) {
  const out = [];
  for (const n of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    if (n === 'node_modules') continue;
    const p = path.join(dir, n);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) out.push(...jsFiles(p));
    else if (/\.(c|m)?js$/.test(n)) out.push(p);
  }
  return out;
}

// Every specifier a file loads: static imports (side-effect ones too), re-exports, dynamic
// import() and require(). Dynamic forms keep their raw argument, so a non-literal one is seen.
// Whitespace and comments, which may sit between the tokens of an import.
const COMMENT = String.raw`\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$)`;
const GAP = `(?:\\s|${COMMENT})*`;
const QUOTED = String.raw`(['"])([^'"]+)\1`;
const STATIC = [
  new RegExp(String.raw`\bimport\b(?:${COMMENT}|[^'"\x60;(])*?\bfrom${GAP}${QUOTED}`, 'g'), // import x from '…'
  new RegExp(String.raw`\bimport${GAP}${QUOTED}`, 'g'), // import '…'
  new RegExp(String.raw`\bexport\b(?:${COMMENT}|[^'"\x60;(])*?\bfrom${GAP}${QUOTED}`, 'g'), // export … from '…'
];
const DYNAMIC = new RegExp(String.raw`\b(?:import|require)${GAP}\(${GAP}([^)]*?)${GAP}\)`, 'g');

const LOADERS = [
  [/\bcreateRequire\b/, 'createRequire'],
  [/\bimport\s*\.\s*meta\s*\.\s*resolve\b/, 'import.meta.resolve'],
  [/\bmodule\s*(\.\s*require\b|\[)/, 'module.require'],
  [/\bprocess\s*\.\s*mainModule\b/, 'process.mainModule'],
  [/\bnew\s+Worker\b/, 'new Worker'],
  [/(?<![.\w$])eval\s*\(/, 'eval'],
  [/\bnew\s+Function\b|(?<![.\w$])Function\s*\(/, 'new Function'],
];

// Comments out, by a small scanner: strings and template literals are copied whole, and a '/'
// after an operator, a bracket or a keyword starts a regex literal, also copied whole. So a
// URL or a glob in a string and a regex such as /\/\*.*\*\// survive; only real comments go.
const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
function stripComments(src) {
  let out = '';
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_AFTER.has(prev) || /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(out.trimEnd()))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

function specifiers(text) {
  const out = [];
  for (const re of STATIC) for (const m of text.matchAll(re)) out.push({ literal: m[2] });
  for (const m of text.matchAll(DYNAMIC)) {
    const arg = m[1].replace(new RegExp(COMMENT, 'g'), '').trim();
    const lit = /^(['"])([^'"]*)\1$/.exec(arg);
    const tpl = /^`([^`]*)`$/.exec(arg);
    out.push(lit ? { literal: lit[2] } : tpl ? { template: tpl[1] } : { dynamic: arg });
  }
  return out;
}

export function checkPackage(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const deps = new Set(Object.keys({ ...meta.dependencies, ...meta.peerDependencies, ...meta.optionalDependencies }));
  const offenders = [];
  for (const file of jsFiles(dir)) {
    const at = path.relative(dir, file);
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const [re, what] of LOADERS) if (re.test(code)) offenders.push(`${at}: ${what}`);
    for (const s of specifiers(code)) {
      if (s.dynamic !== undefined) {
        offenders.push(`${at}: a non-literal specifier (${s.dynamic})`);
        continue;
      }
      if (s.template !== undefined) {
        const parts = [...s.template.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
        const ok = s.template.startsWith('./') && !/\.\.|\\|%/.test(s.template) && parts.every((p) => /^[\w$.]+$/.test(p));
        if (!ok) offenders.push(`${at}: \`${s.template}\``);
        continue;
      }
      const spec = s.literal;
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        // ESM resolves a relative specifier as a URL, so `%2e%2e` is `..`.
        let decoded;
        try {
          decoded = decodeURIComponent(spec);
        } catch {
          offenders.push(`${at}: ${spec} is not a valid URL path`);
          continue;
        }
        const target = path.resolve(path.dirname(file), decoded);
        if (target === dir || target.startsWith(dir + path.sep)) continue;
        offenders.push(`${at}: ${spec} leaves the package`);
        continue;
      }
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!FORBIDDEN.includes(name) && (name === meta.name || deps.has(name))) continue;
      offenders.push(`${at}: ${spec}`);
    }
  }
  // A symlink anywhere in the package can lead a relative path outside it.
  const links = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      if (n === 'node_modules') continue;
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) links.push(path.relative(dir, p));
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  for (const l of links) offenders.push(`${l}: a symlink in the package`);
  // The package's own entry points stay inside it.
  const targets = [];
  const collect = (v) => {
    if (typeof v === 'string') targets.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(meta.main);
  collect(meta.exports);
  for (const t of targets) {
    const abs = path.resolve(dir, t);
    if (!t.startsWith('./') || !(abs === dir || abs.startsWith(dir + path.sep))) offenders.push(`package.json: ${t} points outside the package`);
  }
  const forbidden = FORBIDDEN.filter((n) => deps.has(n));
  if (forbidden.length) offenders.push(`package.json depends on ${forbidden.join(', ')}`);
  return { meta, offenders };
}

test('the session adapters package loads only builtins, its own files and its own dependencies', () => {
  const { meta, offenders } = checkPackage(pkg);
  assert.equal(meta.name, '@agent-realm/harness-session-adapters');
  assert.deepEqual(offenders, []);
});

test('the guard catches every way out of the package (a review\'s three findings, and more)', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-guard-')));
  try {
    const put = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    put('package.json', JSON.stringify({ name: '@agent-realm/harness-session-adapters', dependencies: { allowed: '1.0.0' } }));
    put('src/ok.js', [
      "import fs from 'node:fs';",
      "import { a } from './harnesses/claude-code/index.js';",
      "import self from '@agent-realm/harness-session-adapters/host';",
      "import x from 'allowed/sub';",
      "export * from './errors.js';",
      'const h = await import(`./harnesses/${id}/index.js`);',
      // ordinary adapter code that must not trip the guard
      'const ANSI = /\\u001b([0-9;]+m)/g;',
      'const reply = client.eval(command);',
      "const glob = 'fixtures/*'; const tail = '*/output.json';",
      'const url = `${base}//${rest}`;',
      "const doc = 'see //documentation and http://host/path';",
      '/* a comment that mentions import x from "../../elsewhere.js" */',
      "const blockRe = /\\/\\*[\\s\\S]*?\\*\\//; // a regex that looks like a comment",
      '// import y from "../../elsewhere-too.js"',
    ].join('\n'));
    assert.deepEqual(checkPackage(dir).offenders, [], 'the allowed forms pass');

    put('src/bad.js', [
      "import '../../src/host.js';", // a side-effect import out of the package
      "import { host } from 'file:///repo/src/host.js';", // a file: URL
      "import y from '/abs/src/host.js';", // an absolute path
      "import z from 'memhouse/editors/claude.js';", // memhouse
      "import t from 'smol-toml';", // a package not in its dependencies
      "export { q } from '../../outside.js';", // a re-export out of the package
      'const m = require(name);', // a non-literal require
      'const n = await import(`../${x}`);', // a template literal that climbs out
      "import {\n  multi,\n  line,\n} from 'harness-skeleton/src/host.js';", // a multi-line import
    ].join('\n'));
    put('fixtures/claude-code/helper.cjs', "require('../../../src/host.js');"); // JS among the fixtures
    // A second review: bypasses a static tripwire should still catch
    put('src/sly.js', [
      "import/*x*/'../../outside-a.js';",
      "import /* (c) */ w from '../../outside-b.js';",
      "import { createRequire } from 'node:module';",
      "const r = createRequire(import.meta.url);",
      "const u = import.meta.resolve('../../x.js');",
      "const v = await import(`./${'\\\\x2e\\\\x2e/outside.js'}`);",
      "import//hidden\n'../../outside-c.js';",
      "import './%2e%2e/%2e%2e/outside-e.js';",
      "new Worker('../../outside-d.js');",
      "eval(src);",
    ].join('\n'));
    fs.symlinkSync('/tmp', path.join(dir, 'src', 'escape'));
    put('package.json', JSON.stringify({ name: '@agent-realm/harness-session-adapters', dependencies: { allowed: '1.0.0', memhouse: '0.20.0' }, exports: { '.': './src/index.js', './escape': '../../outside.js' } }));
    const { offenders } = checkPackage(dir);
    for (const needle of ['../../src/host.js', 'file:///repo', '/abs/src/host.js', 'memhouse/editors', 'smol-toml', '../../outside.js',
      'non-literal specifier (name)', '`../${x}`', 'harness-skeleton/src/host.js', 'fixtures/claude-code/helper.cjs', 'package.json depends on memhouse',
      '../../outside-a.js', '../../outside-b.js', 'createRequire', 'import.meta.resolve', "x2e", '../../outside-c.js', '%2e%2e/%2e%2e/outside-e.js', 'new Worker', 'eval',
      'src/escape: a symlink', '../../outside.js points outside']) {
      assert.ok(offenders.some((o) => o.includes(needle)), `${needle} is caught: ${offenders.join(' | ')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

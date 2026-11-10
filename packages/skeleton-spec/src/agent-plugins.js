// The Agent Plugins format (design note v0.2 §5.7), imported by reference: https://agent-plugins.org/specification,
// version 1.0.0, read 2026-11-10, cited [AP §n], with its two JSON schemas. A package is read here
// as the format defines it, with no harness in view: `readPackage` returns what it holds and every
// way it breaks the format. What a harness's route can keep of it (§5.7, Translation) is the
// driver's question, asked through `literalText` and `cwdBeyondRoot`. Nothing here echoes a
// string from the package: it may be anything, so a problem names the field, never its value.

import path from 'node:path';
import fs from 'node:fs';
import { readJson, readText } from './files.js';

export const AGENT_PLUGINS = 'agent-plugins';
// The two placeholders the format expands, and the fields it expands them in [AP §9.2].
export const PLACEHOLDERS = ['${PLUGIN_ROOT}', '${PLUGIN_DATA}'];

// `$schema` names the version [AP §5.2, §7.2.1, §10.1]: one canonical identifier per version and
// file. Anything else is no version this format defines.
const SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(\d+\.\d+\.\d+)\/(plugin|mcp)\.schema\.json$/;
export function schemaVersion(value, file) {
  const m = typeof value === 'string' ? SCHEMA.exec(value) : null;
  return m && m[2] === file ? m[1] : null;
}

// [AP §5.5], as the schema writes it: 1 to 64 characters, lowercase alphanumerics, `-` and `.`,
// alphanumeric at both ends, no `--` and no `..`.
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const pluginNameValid = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 64 && PLUGIN_NAME.test(n);

// The manifest's metadata fields and their JSON types [AP §5.4, plugin schema]. The schema closes
// the object, but the specification has a client report an unknown field and load the plugin
// anyway [AP §5.2], so an unknown field is a warning, never a refusal.
const METADATA = {
  version: 'string', description: 'string', homepage: 'string', repository: 'string', license: 'string',
  author: 'author', keywords: 'strings',
};
export const METADATA_FIELDS = Object.keys(METADATA);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const typed = {
  string: (v) => typeof v === 'string',
  strings: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  author: (v) => isObject(v) && Object.entries(v).every(([k, x]) => ['name', 'email', 'url'].includes(k) && typeof x === 'string'),
};

// The Agent Skills frontmatter, as far as validity needs it (agentskills.io/specification, read
// 2026-11-10): top-level scalar keys, plain, quoted, or a block scalar (`|`, `>`). A key whose value
// is a mapping or a list reads as a non-string. This is not a YAML parser: it reads what a
// SKILL.md writes in practice, and what it cannot read counts against the skill, which validate
// then names.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const out = {};
  const indented = (l) => l !== undefined && (/^[ \t]+\S/.test(l) || l.trim() === '');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(lines[i]);
    if (!kv) continue;
    const raw = (kv[2] ?? '').trim();
    const body = [];
    while (indented(lines[i + 1])) body.push(lines[++i].trim());
    while (body.length && body.at(-1) === '') body.pop();
    let value;
    if (/^[|>][+-]?[0-9]?$/.test(raw)) value = raw[0] === '|' ? body.join('\n') : body.filter((l) => l !== '').join(' ');
    else if (raw === '') value = body.length && !/^(-|[^\s'"]+[ \t]*:)/.test(body[0]) ? body.filter((l) => l !== '').join(' ') : (body.length ? null : '');
    else if (/^'(.*)'$/.test(raw)) value = raw.slice(1, -1).replaceAll("''", "'");
    else if (/^"(.*)"$/.test(raw)) value = raw.slice(1, -1);
    else if (/^[[{]/.test(raw)) value = null;
    else value = [raw.replace(/[ \t]+#.*$/, ''), ...body.filter((l) => l !== '')].join(' ');
    out[kv[1]] = value;
  }
  return out;
}

// What the Agent Skills specification refuses in one skill directory: a missing frontmatter; a
// `name` outside 1 to 64 lowercase alphanumerics and single hyphens, not starting or ending with
// one, or differing from the directory; a `description` that is not 1 to 1024 characters; a
// `compatibility` over 500. Returns the reasons, empty when the skill is valid.
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function skillProblems(text, dir) {
  const fm = frontmatter(text);
  if (!fm) return ['SKILL.md has no frontmatter'];
  const out = [];
  const { name, description, compatibility } = fm;
  if (typeof name !== 'string' || name.length < 1 || name.length > 64 || !SKILL_NAME.test(name)) out.push('its name is not 1 to 64 lowercase letters, digits and single hyphens');
  else if (name !== dir) out.push('its name differs from its directory');
  if (typeof description !== 'string' || description.length < 1 || description.length > 1024) out.push('its description is not 1 to 1024 characters');
  if (compatibility !== undefined && (typeof compatibility !== 'string' || compatibility.length < 1 || compatibility.length > 500)) out.push('its compatibility is not 1 to 500 characters');
  return out;
}

// A path the format resolves against the plugin root [AP §4.1]: `./` and what follows, which must
// stay inside the root. Returns the normalized relative path ('' for the root), or null.
export function inRoot(p, prefix = './') {
  if (typeof p !== 'string' || !p.startsWith(prefix)) return null;
  const rest = path.posix.normalize(p.slice(prefix.length) || '.');
  if (rest === '..' || rest.startsWith('../') || rest.startsWith('/')) return null;
  return rest === '.' ? '' : rest.replace(/\/$/, '');
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
// [AP §7.2.1]: an absolute http(s) URL with no user information and no fragment; HTTPS unless the
// host is loopback.
function urlProblem(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return 'url is not an absolute URL';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'url is not http or https';
  if (url.username || url.password) return 'url carries user information';
  if (u.includes('#')) return 'url carries a fragment';
  const loopback = LOOPBACK.has(url.hostname) || /^127\./.test(url.hostname);
  if (url.protocol === 'http:' && !loopback) return 'url is http to a host that is not loopback; the format needs https there';
  return null;
}

const STDIO = new Set(['type', 'command', 'args', 'env', 'cwd']);
const REMOTE = new Set(['type', 'url', 'headers']);
const strings = (v) => isObject(v) && Object.values(v).every((x) => typeof x === 'string');

// One server of mcp.json against its closed variant [AP §7.2.1, mcp schema]. Returns the reasons.
function serverProblems(s) {
  if (!isObject(s)) return ['is not an object'];
  const out = [];
  if (s.type === 'stdio') {
    for (const k of Object.keys(s)) if (!STDIO.has(k)) out.push(`has ${JSON.stringify(k)}, which a stdio server does not take`);
    // One executable token, bare or plugin-relative, never a shell string [AP §7.2.1].
    if (typeof s.command !== 'string' || s.command === '' || /\s/.test(s.command)) out.push('command is not one executable token');
    else if (s.command.startsWith('./')) {
      const rel = inRoot(s.command, './');
      if (rel === null) out.push('command leaves the plugin root');
      else if (rel === '') out.push('command names the plugin root itself, not a file in it');
    } else if (s.command.includes('/')) out.push('command is neither a bare name nor a ./ path');
    if (s.args !== undefined && !(Array.isArray(s.args) && s.args.every((a) => typeof a === 'string'))) out.push('args is not a list of strings');
    if (s.env !== undefined) {
      if (!strings(s.env)) out.push('env is not an object of strings');
      else for (const k of ['PLUGIN_ROOT', 'PLUGIN_DATA']) if (Object.hasOwn(s.env, k)) out.push(`env sets ${k}, which the client provides [AP §9.2]`);
    }
    if (s.cwd !== undefined && cwdPlace(s.cwd) === null) out.push('cwd is not ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}, or a path inside one of them');
  } else if (s.type === 'streamable-http' || s.type === 'sse') {
    for (const k of Object.keys(s)) if (!REMOTE.has(k)) out.push(`has ${JSON.stringify(k)}, which a remote server does not take`);
    if (typeof s.url !== 'string' || s.url === '') out.push('url is missing');
    else {
      const p = urlProblem(s.url);
      if (p) out.push(p);
    }
    if (s.headers !== undefined && !strings(s.headers)) out.push('headers is not an object of strings');
  } else {
    out.push('type is not stdio, streamable-http or sse');
  }
  return out;
}

// Where a stdio server's cwd points: { base: 'root' | 'data', rel }, or null when it names
// neither [AP §7.2.1, mcp schema]. Omitted, it is the root.
export function cwdPlace(cwd) {
  if (cwd === undefined) return { base: 'root', rel: '' };
  for (const [prefix, base] of [['./', 'root'], ['${PLUGIN_ROOT}', 'root'], ['${PLUGIN_DATA}', 'data']]) {
    if (typeof cwd !== 'string' || !cwd.startsWith(prefix)) continue;
    const rest = cwd.slice(prefix.length);
    if (prefix !== './' && rest !== '' && !rest.startsWith('/')) return null;
    const rel = inRoot(`./${rest.replace(/^\//, '')}`, './');
    return rel === null ? null : { base, rel };
  }
  return null;
}

// A package directory, read as the format defines it. Returns:
//   manifest: the parsed plugin.json, or null; name; version: what its $schema names, or null;
//   mcp: the parsed mcp.json, or null; mcp_version; skills: [{ dir, path }] for every skill the
//   format discovers [AP §7.1]; problems: [{ code, message }], where code is plugin_malformed (the
//   package breaks the format), plugin_skill_invalid (a skill the Agent Skills specification
//   refuses), or the warning plugin_field_unknown.
// The version is not judged here: which versions a route maps is the driver's (validate).
export function readPackage(dir) {
  const problems = [];
  const bad = (message) => problems.push({ code: 'plugin_malformed', message });
  const out = { manifest: null, name: null, version: null, mcp: null, mcp_version: null, skills: [], problems };

  const m = readJson(path.join(dir, 'plugin.json'));
  if (!m.present) {
    bad('the package has no plugin.json at its root [AP §4.1, §5.1]');
    return out;
  }
  if (m.error) {
    bad(`plugin.json: ${m.error} [AP §5.2]`);
    return out;
  }
  const manifest = m.value;
  out.manifest = manifest;
  if (manifest.$schema === undefined) bad('plugin.json has no $schema, which names the version [AP §5.3]');
  else out.version = schemaVersion(manifest.$schema, 'plugin');
  out.schema_given = manifest.$schema !== undefined;
  if (!pluginNameValid(manifest.name)) bad('plugin.json name is not 1 to 64 lowercase letters, digits, - and ., alphanumeric at both ends, with no -- or .. [AP §5.5]');
  else out.name = manifest.name;
  for (const [k, v] of Object.entries(manifest)) {
    if (k === '$schema' || k === 'name') continue;
    if (k === 'extensions') {
      // Not an object: reported and ignored, and the plugin still loads [AP §8.1].
      if (!isObject(v)) problems.push({ code: 'plugin_field_unknown', severity: 'warning', message: 'plugin.json extensions is not an object, so it is ignored [AP §8.1]' });
      continue;
    }
    if (!METADATA[k]) problems.push({ code: 'plugin_field_unknown', severity: 'warning', message: `plugin.json has ${JSON.stringify(k)}, a field the format does not define; it is ignored [AP §5.2]` });
    else if (!typed[METADATA[k]](v)) bad(`plugin.json ${k} is not ${METADATA[k] === 'author' ? 'an object of name, email and url strings' : METADATA[k] === 'strings' ? 'a list of strings' : 'a string'} [AP §5.4]`);
  }

  // Skills [AP §7.1]: each immediate child directory of skills/ holding a SKILL.md that is a
  // regular file, never deeper. A symlink is not followed: hs copies no package holding one.
  const skillsDir = path.join(dir, 'skills');
  let names = [];
  try {
    if (fs.lstatSync(skillsDir).isDirectory()) names = fs.readdirSync(skillsDir).sort();
  } catch {
    // no skills/
  }
  for (const n of names) {
    const sd = path.join(skillsDir, n);
    let st;
    try {
      st = fs.lstatSync(sd);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const file = path.join(sd, 'SKILL.md');
    let fst;
    try {
      fst = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (!fst.isFile()) {
      problems.push({ code: 'plugin_skill_invalid', skill: n, message: `skill ${JSON.stringify(n)}: its SKILL.md is not a regular file` });
      continue;
    }
    out.skills.push({ dir: n, path: sd });
    const r = readText(file);
    const why = r.text === undefined ? [`its SKILL.md cannot be read${r.error ? ` (${r.error})` : ''}`] : skillProblems(r.text, n);
    if (why.length) problems.push({ code: 'plugin_skill_invalid', skill: n, message: `skill ${JSON.stringify(n)}: ${why.join('; ')} (Agent Skills specification)` });
  }

  // MCP servers [AP §7.2].
  const j = readJson(path.join(dir, 'mcp.json'));
  if (j.present) {
    if (j.error) bad(`mcp.json: ${j.error} [AP §7.2.1]`);
    else {
      out.mcp = j.value;
      if (j.value.$schema === undefined) bad('mcp.json has no $schema [AP §7.2.1]');
      else out.mcp_version = schemaVersion(j.value.$schema, 'mcp');
      out.mcp_schema_given = j.value.$schema !== undefined;
      for (const k of Object.keys(j.value)) if (k !== '$schema' && k !== 'mcpServers') bad(`mcp.json has ${JSON.stringify(k)}, which the format does not define [AP §7.2.1]`);
      if (!isObject(j.value.mcpServers)) bad('mcp.json mcpServers is not an object [AP §7.2.1]');
      else {
        for (const [id, s] of Object.entries(j.value.mcpServers)) {
          for (const why of serverProblems(s)) bad(`mcp.json server ${JSON.stringify(id)} ${why} [AP §7.2.1]`);
        }
      }
    }
  }
  return out;
}

// The text the format keeps literal [AP §9.2], by server and field: any `${` in command, url and
// headers (names and values), and in args and env (names and values) once the two placeholders are
// taken out. A route whose harness expands `${…}` in those fields cannot keep it (§5.7).
export function literalText(mcp) {
  const out = [];
  if (!isObject(mcp?.mcpServers)) return out;
  const rest = (v) => PLACEHOLDERS.reduce((s, p) => s.replaceAll(p, ''), v);
  for (const [id, s] of Object.entries(mcp.mcpServers)) {
    if (!isObject(s)) continue;
    const fields = [
      ['command', s.command], ['url', s.url],
      ...(isObject(s.headers) ? Object.entries(s.headers).flatMap(([n, v]) => [['a header name', n], ['a header value', v]]) : []),
      ...(Array.isArray(s.args) ? s.args.map((a, i) => [`args[${i}]`, typeof a === 'string' ? rest(a) : a]) : []),
      ...(isObject(s.env) ? Object.entries(s.env).flatMap(([n, v]) => [['an env name', n], [`env ${JSON.stringify(n)}`, typeof v === 'string' ? rest(v) : v]]) : []),
    ];
    for (const [where, v] of fields) if (typeof v === 'string' && v.includes('${')) out.push({ server: id, where });
  }
  return out;
}

// The stdio servers whose working directory is not the plugin root (§5.7): a route that can only
// start a server in the root cannot keep them.
export function cwdBeyondRoot(mcp) {
  if (!isObject(mcp?.mcpServers)) return [];
  return Object.entries(mcp.mcpServers)
    .filter(([, s]) => isObject(s) && s.type === 'stdio' && s.cwd !== undefined)
    .filter(([, s]) => {
      const p = cwdPlace(s.cwd);
      return !(p && p.base === 'root' && p.rel === '');
    })
    .map(([id]) => id);
}

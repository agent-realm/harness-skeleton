// `validate` (design note v0.2 §7.1): a resolved spec against the standard and one harness,
// before anything is planned. It reports problems by item and layer, never a value: a
// binding that is not a reference may be a pasted secret, so it is named, never echoed.

import path from 'node:path';
import { processProblems } from './process-checks.js';
import { resolve } from './layers.js';
import { readText } from './files.js';

// Reference schemes (§1 `reference`).
const REFERENCE = /^(keychain:[^\s]+|op:\/\/[^\s]+|age:[^\s]+|env:[A-Za-z_][A-Za-z0-9_]*|file:\/[^\s]*)$/;
const REF_FIELDS = new Set(['env_refs', 'header_refs', 'bearer_ref']);
const STATE_VALUES = { sessions: ['keep', 'none'], prompt_history: ['keep', 'none'] };
// The wires an endpoint can speak (§5.2), how its credential is sent, the login modes, the roles.
const WIRES = ['anthropic-messages', 'openai-responses', 'openai-chat'];
const AUTHS = ['bearer', 'x-api-key'];
const LOGIN_MODES = ['isolated', 'endpoint'];
const ROLES = ['primary', 'small', 'subagent', 'effort'];
// The requirement policy (§5.10).
export const REQUIRE = ['required', 'if-supported'];
// Hooks (§5.6): the portable events, then the facet ones; the matcher each event takes.
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'PermissionRequest', 'SubagentStart', 'SubagentStop'];
const HOOK_MATCH = { PreToolUse: 'tool', PostToolUse: 'tool', PermissionRequest: 'tool', SessionStart: 'source', PreCompact: 'trigger', PostCompact: 'trigger', SubagentStart: 'agent', SubagentStop: 'agent' };
const HOOK_SOURCES = ['startup', 'resume', 'clear', 'compact'];
const TOOL_CLASS = /^(shell|edit|read|fetch|mcp:[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?)$/;

// The ref names an item uses: env_refs and header_refs map to names, bearer_ref is one name,
// at any depth (a process inside a hook or status line carries its own env_refs).
function refsUsed(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => refsUsed(v, out));
  else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value)) {
      if (REF_FIELDS.has(k)) {
        if (typeof v === 'string') out.push(v);
        else if (v && typeof v === 'object') out.push(...Object.values(v).filter((x) => typeof x === 'string'));
      } else refsUsed(v, out);
    }
  }
  return out;
}

// Claude Code expands `@path` imports and strips block HTML comments in an imported file, so
// the canonical AGENTS.md holds neither (§5.7). Both are skipped inside code fences, and
// imports inside code spans [CC §3].
// The one rule the standard adds to the Agent Skills format (§5.7): `name` in SKILL.md's
// frontmatter equals the directory. Read from the top-level `name:` line of the frontmatter.
export function skillName(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  const line = m[1].split(/\r?\n/).find((l) => /^name\s*:/.test(l));
  if (!line) return null;
  return line.replace(/^name\s*:\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
}

export function agentsMdProblems(text) {
  const imports = [];
  const comments = [];
  // CommonMark: a fence opens with three or more backticks or tildes, indented at most three
  // spaces, and closes only on a run of the same character at least as long, with nothing after it.
  let fence = null;
  text.split('\n').forEach((line, i) => {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      return;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      return;
    }
    const outsideSpans = line.replace(/`[^`]*`/g, '');
    if (/(^|\s)@[^\s@]/.test(outsideSpans)) imports.push(i + 1);
    if (/^\s*<!--/.test(line)) comments.push(i + 1);
  });
  return { imports, comments };
}

export function validate(resolved, descriptor) {
  const problems = [...resolved.problems];
  const push = (p) => problems.push({ severity: 'error', ...p });

  // install_local_misplaced and unknown_kind come from resolve(), per layer, before merging.

  // Refs: every declared ref is bound in local.toml; every used ref is declared; every
  // binding is a reference.
  const declared = new Set(resolved.items.filter((i) => i.kind === 'refs').map((i) => i.id.slice('refs.'.length)));
  const bindings = resolved.items.filter((i) => i.kind === 'binding');
  const bound = new Set(bindings.filter((b) => b.local).map((b) => b.id.slice('binding.'.length)));
  for (const ref of declared) {
    if (!bound.has(ref)) push({ code: 'ref_unbound', item: `refs.${ref}`, message: `ref ${ref} is declared but local.toml binds no reference to it` });
  }
  for (const item of resolved.items) {
    for (const ref of new Set(refsUsed(item.value))) {
      if (!declared.has(ref)) push({ code: 'ref_undeclared', item: item.id, layer: item.layer, message: `${item.id} uses ref ${ref}, which no layer declares under [refs.${ref}]` });
    }
  }
  for (const b of bindings) {
    if (typeof b.value !== 'string' || !REFERENCE.test(b.value)) {
      push({ code: 'ref_not_reference', item: b.id, layer: b.layer,
        message: `${b.id} is not a reference (keychain:…, op://…, age:…, env:…, file:/…); its value is not shown, and if it is a secret, rotate it` });
    }
  }

  // Endpoints, login and model roles (§5.2). An endpoint's credential is a reference, checked
  // like a ref binding and never echoed.
  const endpoints = resolved.items.filter((i) => i.kind === 'endpoints');
  for (const e of endpoints) {
    const wire = e.id.slice('endpoints.'.length);
    const v = e.value ?? {};
    if (!WIRES.includes(wire)) push({ code: 'endpoint_wire_unknown', item: e.id, layer: e.layer, message: `${e.id}: the wire must be one of ${WIRES.join(', ')}` });
    if (typeof v.base_url !== 'string' || !/^https?:\/\//.test(v.base_url)) push({ code: 'item_malformed', item: e.id, layer: e.layer, message: `${e.id} needs base_url, an http(s) URL` });
    if (typeof v.credential !== 'string' || !REFERENCE.test(v.credential)) {
      push({ code: 'ref_not_reference', item: e.id, layer: e.layer, message: `${e.id}: credential is not a reference (keychain:…, op://…, age:…, env:…, file:/…); its value is not shown, and if it is a secret, rotate it` });
    }
    if (v.auth !== undefined && !AUTHS.includes(v.auth)) push({ code: 'item_malformed', item: e.id, layer: e.layer, message: `${e.id}: auth must be one of ${AUTHS.join(', ')}` });
  }
  for (const l of resolved.items.filter((i) => i.kind === 'login')) {
    if (l.id !== 'login.mode' || !LOGIN_MODES.includes(l.value)) {
      push({ code: 'item_malformed', item: l.id, layer: l.layer, message: `[login] takes mode = ${LOGIN_MODES.join(' | ')}` });
    } else if (l.value === 'endpoint' && endpoints.length === 0) {
      push({ code: 'item_malformed', item: l.id, layer: l.layer, message: 'login mode "endpoint" needs an endpoint in local.toml' });
    }
  }
  for (const r of resolved.items.filter((i) => i.kind === 'model.roles')) {
    const role = r.id.slice('model.roles.'.length);
    if (!ROLES.includes(role) || typeof r.value !== 'string' || r.value === '') {
      push({ code: 'item_malformed', item: r.id, layer: r.layer, message: `${r.id}: model roles are ${ROLES.join(', ')}, each a non-empty string` });
    }
  }

  // [state] (§5.12): its values, and what this harness can express.
  for (const item of resolved.items.filter((i) => i.kind === 'state')) {
    const key = item.id.slice('state.'.length);
    const spec = descriptor.state[key];
    if (key === 'retention_days') {
      if (!Number.isInteger(item.value) || item.value < 1) {
        push({ code: 'state_value_invalid', item: item.id, layer: item.layer, message: 'retention_days must be an integer of at least 1' });
        continue;
      }
    } else if (STATE_VALUES[key]) {
      if (!STATE_VALUES[key].includes(item.value)) {
        push({ code: 'state_value_invalid', item: item.id, layer: item.layer, message: `${item.id} must be one of ${STATE_VALUES[key].join(', ')}` });
        continue;
      }
    } else {
      push({ code: 'state_value_invalid', item: item.id, layer: item.layer, message: `${item.id} is not a [state] item (sessions, prompt_history, retention_days)` });
      continue;
    }
    // State items are if-supported (§5.10): one this harness cannot express is skipped and
    // listed in the plan, so it is a warning here.
    if (spec && !spec.expressible && item.value !== spec.harness_default) {
      push({ severity: 'warning', code: 'state_unexpressible', item: item.id, layer: item.layer,
        message: `${descriptor.name} cannot express ${item.id}${spec.reason ? `: ${spec.reason}` : ''}; it will be skipped and listed in the plan` });
    }
  }

  // MCP servers (§5.5): a process (stdio) or a remote server, with secrets only through refs.
  const strings = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
  for (const m of resolved.items.filter((i) => i.kind === 'mcp')) {
    const v = m.value;
    const bad = (why) => push({ code: 'item_malformed', item: m.id, layer: m.layer, message: `${m.id}: ${why}` });
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      bad('an MCP server is a table');
      continue;
    }
    const stdio = v.exec !== undefined || v.shell !== undefined;
    const remote = v.url !== undefined;
    if (stdio === remote) {
      bad('give either exec (or shell), for a server hs starts, or url, for a remote one');
      continue;
    }
    if (stdio) {
      // A server hs starts is a process: the shared checks (§5.4), `${` in its strings included.
      for (const p of processProblems(m.id, v)) push({ ...p, item: m.id, layer: m.layer });
      for (const k of ['url', 'headers', 'header_refs', 'bearer_ref', 'type']) if (v[k] !== undefined) bad(`${k} is for a remote server`);
    } else {
      if (typeof v.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(v.url)) bad('url must be an http(s) URL');
      if (v.type !== undefined && !['http', 'sse'].includes(v.type)) bad('type is http or sse');
      for (const k of ['headers', 'header_refs']) if (v[k] !== undefined && !strings(v[k])) bad(`${k} must be a table of strings`);
      if (v.bearer_ref !== undefined && typeof v.bearer_ref !== 'string') bad('bearer_ref names one ref');
      for (const k of ['exec', 'shell', 'args', 'env', 'env_refs']) if (v[k] !== undefined) bad(`${k} is for a server hs starts`);
    }
    if (v.exposure !== undefined && !['direct', 'deferred', 'codemode'].includes(v.exposure)) bad('exposure is direct, deferred or codemode');
    // Never interpolation inside strings (§5.3): Claude Code expands every ${VAR} in the file it is
    // given, a shell string's -c argument included, so `${ANTHROPIC_AUTH_TOKEN}` in a header or an
    // argument would hand the endpoint's credential, another ref, or any ambient variable to the
    // server. Secrets come only through env_refs, header_refs and bearer_ref. The string is not
    // echoed.
    // A started server's strings are checked by processProblems above; these are a remote one's.
    const fields = stdio ? [] : [
      ['url', v.url],
      ...(v.headers && typeof v.headers === 'object' ? Object.entries(v.headers).flatMap(([n, x]) => [[`headers name ${JSON.stringify(n)}`, n], [`headers.${n}`, x]]) : []),
      // A ref table's names become header names in the file too.
      ...(v.header_refs && typeof v.header_refs === 'object' ? Object.keys(v.header_refs).map((n) => ['header_refs name', n]) : []),
    ];
    for (const [where, x] of fields) {
      if (typeof x === 'string' && x.includes('${')) {
        push({ code: 'interpolation_refused', item: m.id, layer: m.layer, message: `${m.id}: ${where} holds \${…}, which Claude Code would expand from its environment, credentials included; pass a secret with env_refs, header_refs or bearer_ref` });
      }
    }
  }

  // The status line (§5.9, §5.10): `run` is a process; refresh in seconds; require.
  for (const sl of resolved.items.filter((i) => i.kind === 'statusline')) {
    const v = sl.value;
    const bad = (message) => push({ code: 'item_malformed', item: sl.id, layer: sl.layer, message: `${sl.id}: ${message}` });
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.run === undefined) {
      bad('statusline = { run = { exec = "…" } }, with refresh and require optional');
      continue;
    }
    for (const p of processProblems(`${sl.id}.run`, v.run)) push({ ...p, item: sl.id, layer: sl.layer });
    if (v.refresh !== undefined && (!Number.isInteger(v.refresh) || v.refresh < 1)) bad('refresh is a whole number of seconds, at least 1');
    if (v.require !== undefined && !REQUIRE.includes(v.require)) bad(`require is ${REQUIRE.join(' or ')}`);
  }

  // Hooks (§5.6): an event, a matcher typed by it, a process, a requirement.
  for (const h of resolved.items.filter((i) => i.kind === 'hook')) {
    const v = h.value;
    const bad = (message) => push({ code: 'item_malformed', item: h.id, layer: h.layer, message: `${h.id}: ${message}` });
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      bad('a hook is a table: event, run, and match and require if needed');
      continue;
    }
    if (!HOOK_EVENTS.includes(v.event)) {
      bad(`event is one of ${HOOK_EVENTS.join(', ')}`);
      continue;
    }
    if (v.run === undefined) bad('run = { exec = "…" } is needed');
    else for (const p of processProblems(`${h.id}.run`, v.run)) push({ ...p, item: h.id, layer: h.layer });
    if (v.require !== undefined && !REQUIRE.includes(v.require)) bad(`require is ${REQUIRE.join(' or ')}`);
    if (v.timeout !== undefined && (!Number.isInteger(v.timeout) || v.timeout < 1)) bad('timeout is a whole number of seconds, at least 1');
    // may_allow: the hook's allow skips the permission prompt (a grants-permission launch risk).
    if (v.may_allow !== undefined && (typeof v.may_allow !== 'boolean' || v.event !== 'PreToolUse')) bad('may_allow is true or false, on a PreToolUse hook only');
    if (v.match !== undefined) {
      const key = HOOK_MATCH[v.event];
      const m = v.match;
      if (!key) bad(`${v.event} takes no match`);
      else if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some((k) => k !== key) || !Array.isArray(m[key]) || !m[key].length || !m[key].every((x) => typeof x === 'string' && x !== '')) {
        bad(`${v.event} matches { ${key} = [ … ] }, a list of non-empty strings`);
      } else if (key === 'tool') {
        for (const c of m.tool) if (!TOOL_CLASS.test(c)) bad(`tool class ${JSON.stringify(c)} is not one of shell, edit, read, fetch, mcp:<server>[/<tool>]`);
      } else if (key === 'source') {
        for (const x of m.source) if (!HOOK_SOURCES.includes(x)) bad(`source is one of ${HOOK_SOURCES.join(', ')}`);
      } else if (key === 'trigger') {
        for (const x of m.trigger) if (!['manual', 'auto'].includes(x)) bad('trigger is manual or auto');
      }
      if (key === 'agent') for (const x of m.agent) if (!/^[A-Za-z0-9_.:-]+$/.test(x)) bad(`agent type ${JSON.stringify(x)} holds a character a matcher would read as a pattern`);
    }
  }

  const reserved = descriptor?.writable?.reserved?.skills ?? [];
  for (const f of resolved.files.filter((x) => x.kind === 'skill')) {
    const dir = f.id.slice('skill.'.length);
    // A hidden skill would be skipped (Codex skips hidden directories) or land in the harness's own
    // (.trash, .system); a reserved name is the harness's. Either way it would never load as given.
    if (dir.startsWith('.') || reserved.includes(dir)) {
      push({ code: 'skill_name_reserved', item: f.id, layer: f.layer, message: `${f.id}: ${dir.startsWith('.') ? 'a skill name starting with . is hidden' : `${dir} is a name ${descriptor.name} keeps for itself`}, so it would not load as given; rename it` });
      continue;
    }
    const r = readText(path.join(f.path, 'SKILL.md'));
    const name = r.text === undefined ? null : skillName(r.text);
    if (r.text === undefined) push({ code: 'skill_malformed', item: f.id, layer: f.layer, message: `${f.id} has no readable SKILL.md${r.error ? ` (${r.error})` : ''}` });
    else if (name === null) push({ code: 'skill_malformed', item: f.id, layer: f.layer, message: `${f.id}: SKILL.md has no frontmatter name` });
    else if (name !== dir) push({ code: 'skill_name_mismatch', item: f.id, layer: f.layer, message: `${f.id}: SKILL.md names the skill differently from its directory; they must be equal (§5.7)` });
  }

  for (const part of resolved.agents_md) {
    const { imports, comments } = agentsMdProblems(part.text);
    if (imports.length) push({ code: 'agents_md_import', layer: part.layer, lines: imports, message: `AGENTS.md of layer ${part.layer} has @path imports on lines ${imports.join(', ')}` });
    if (comments.length) push({ code: 'agents_md_comment', layer: part.layer, lines: comments, message: `AGENTS.md of layer ${part.layer} has block HTML comments on lines ${comments.join(', ')}` });
  }

  const checked = new Set(['refs', 'binding', 'state', 'unknown', 'skill', 'endpoints', 'login', 'model.roles', 'mcp', 'statusline', 'hook']);
  const kinds = [
    ...resolved.items.map((i) => i.kind),
    ...resolved.files.map((f) => f.id.split('.')[0]),
    ...(resolved.permissions.length ? ['permissions'] : []),
  ];
  const unchecked = [...new Set(kinds.filter((k) => !checked.has(k)))].sort();
  return {
    valid: !problems.some((p) => p.severity === 'error'),
    digest: resolved.digest,
    layers: resolved.layers.map((l) => ({ name: l.name, version: l.version, local: l.local })),
    items: resolved.items.map((i) => ({ id: i.id, layer: i.layer })),
    files: resolved.files.map((f) => ({ id: f.id, layer: f.layer, sha256: f.sha256 })),
    removed: resolved.removed,
    replaced: resolved.replaced,
    problems,
    // Kinds this build resolves but does not yet check against the harness; their checks
    // arrive with the milestone that delivers them (build plan).
    unchecked_kinds: unchecked,
  };
}

export function validateLayers({ layers, local }, descriptor) {
  return validate(resolve(layers, local), descriptor);
}

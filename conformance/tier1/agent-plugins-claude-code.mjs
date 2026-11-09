#!/usr/bin/env node
// Tier 1 conformance (design note v0.2 §5.7, §10), on Claude Code. It starts the real harness, so
// it runs only on a bench (AGENTS.md, Testing), and refuses unless HS_BENCH=1.
//
//   HS_BENCH=1 node conformance/tier1/agent-plugins-claude-code.mjs --claude <path> [--hs-rev <sha>] [--keep]
//
// What Claude Code does with an Agent Plugins 1.0.0 package (https://agent-plugins.org/specification),
// and whether the translation of §5.7 delivers one. No hs code delivers plugins yet: the check builds
// by hand what a driver will build (lib/agent-plugins.mjs). Each run is one `-p` launch from hs's
// launch-spec for a plain layer (endpoint and model only), with `--plugin-dir` added, against a
// local listener that answers 400 and records markers and tool names. The packages: `clean` (one
// valid skill; one stdio server whose args use ${PLUGIN_ROOT} and whose env uses ${PLUGIN_DATA};
// every manifest metadata field), `future` (the same, with only its two $schema values naming
// 9.9.9), `mixed` (`clean` plus a skill without the description the Agent Skills specification
// requires), `literal` (`clean` plus text the format keeps literal, in a stdio server's env and in
// a remote server's header) and `dotted` (`clean` named with a dot, which the format allows). Every
// package also holds a root `commands/` entry and a `hooks/hooks.json` SessionStart hook, which the
// format never discovers [AP §6.1, §7].
// Runs:
//   control     no plugin. Expected: no marker reaches a request (the premise).
//   published   `clean`, `future` and `mixed`, each in a launch of its own, as published. Claude
//               Code has no loader for the format (§12 row 35), so these are recorded, not judged.
//   translated  `clean` translated by the rules of §5.7: the package nested whole under
//               `package/`, the format's plugin root there, with only the manifest, .mcp.json and a
//               copy of skills/ at the translated plugin's root, and each stdio server started
//               through the /bin/sh prelude that changes to the plugin root. Expected: the skill
//               reaches the request under the plugin's name, from a manifest that keeps `name` and
//               every metadata field; the server, given as a `./` command, starts in the plugin root
//               with both placeholders expanded, PLUGIN_ROOT the plugin root and PLUGIN_DATA an
//               existing, writable directory that ${PLUGIN_DATA} names; its tool reaches the
//               request; the package's commands/ and hooks/ stay inert (the command reaches no
//               request and the hook does not run).
//   flat        `clean` copied whole to the translated plugin's root instead of nested. Expected
//               (the nesting's premise, and the positive control for "inert"): Claude Code acts on
//               the root commands/ or hooks/.
//   unbridged   nested, without the prelude. Expected (the prelude's premise): the server does not
//               start in the plugin root.
//   literal     `literal`, renamed as the translation renames and nothing more, with HS_BENCH_OTHER
//               set in Claude Code's environment. Expected (the premise of §5.7's
//               plugin_placeholder_literal): the stdio server's env and the remote server's header
//               both arrive as the variable's value, so the text did not stay literal.
//   dotted      `dotted`, translated. Recorded: whether Claude Code loads a plugin whose name has a
//               dot.
// The translation is the check's own, built by hand to the rules of §5.7. None of the adapter's
// refusals (version, literal text, cwd, invalid skill) is exercised here: no driver exists yet.
// A skill or command counts as loaded when its name, `<plugin>:<name>`, or its description's marker reaches a
// request: Claude Code 2.1.321 lists skills by name, without the description. Both are recorded.
// The listeners and the server record names and booleans only. The credential is a dummy; HOME
// and XDG are scratch.

import fs from 'node:fs';
import path from 'node:path';
import { REF_VAR, bench, evidence, fromSpec, guard } from '../lib/bench.mjs';
import { INERT_COMMAND, LITERAL_MARKERS, OTHER, OTHER_VALUE, literalOpts, probe, writePackage } from '../lib/agent-plugins.mjs';

const claude = guard('agent-plugins-claude-code.mjs');
const PROMPT = 'tier 1 Agent Plugins check';
const TOOL = 'hs_plugin_tool';
const NAME = 'hs-bench-plugin';
const DOTTED = 'hs.bench-plugin';
const META = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'];
const M = { skill: 'hs-tier1-ap-skill-4d1a', invalid: 'hs-tier1-ap-nodesc-8e3c', tool: 'hs-tier1-ap-tool-2b7f', command: 'hs-tier1-ap-command-7e0b' };
const NEST = 'package';
const b = bench('hs-tier1-agent-plugins-cc-');

// The translation of §5.7, by hand: what a Claude Code driver will write for an Agent Plugins
// package that validate accepts. It refuses nothing: the literal run uses it to show why §5.7
// refuses. The package is nested whole under `package/`, the format's plugin root there, so that
// nothing the format treats as inert sits where Claude Code acts on it; only the manifest,
// .mcp.json and a copy of skills/ are at the translated plugin's root. The prelude reads
// $PLUGIN_ROOT, without braces, from the env the translation adds, so Claude Code's own ${...}
// expansion never touches it, and takes the server's command and args as positional parameters,
// never spliced into the script. `nest: false` copies the package to the root instead, for the flat
// run; `prelude: false` leaves the prelude out, for the unbridged run.
function translate(pkg, out, { prelude = true, nest = true } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'plugin.json'), 'utf8'));
  const meta = Object.fromEntries(META.filter((k) => k in manifest).map((k) => [k, manifest[k]]));
  const root = nest ? `\${CLAUDE_PLUGIN_ROOT}/${NEST}` : '${CLAUDE_PLUGIN_ROOT}';
  if (nest) {
    fs.cpSync(pkg, path.join(out, NEST), { recursive: true });
    fs.cpSync(path.join(pkg, 'skills'), path.join(out, 'skills'), { recursive: true });
  } else {
    const rewritten = [path.join(pkg, 'plugin.json'), path.join(pkg, 'mcp.json')];
    fs.cpSync(pkg, out, { recursive: true, filter: (src) => !rewritten.includes(src) });
  }
  fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(out, '.claude-plugin', 'plugin.json'), JSON.stringify(meta, null, 2) + '\n');
  const swap = (v) => v.replaceAll('${PLUGIN_ROOT}', root).replaceAll('${PLUGIN_DATA}', '${CLAUDE_PLUGIN_DATA}');
  const TYPE = { sse: 'sse', 'streamable-http': 'http' };
  const mcp = JSON.parse(fs.readFileSync(path.join(pkg, 'mcp.json'), 'utf8'));
  const servers = {};
  for (const [id, s] of Object.entries(mcp.mcpServers)) {
    if (s.type !== 'stdio') {
      servers[id] = { type: TYPE[s.type], url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
      continue;
    }
    const command = s.command.startsWith('./') ? `${root}/${s.command.slice(2)}` : s.command;
    const args = (s.args ?? []).map(swap);
    const env = { ...Object.fromEntries(Object.entries(s.env ?? {}).map(([k, v]) => [k, swap(v)])), PLUGIN_ROOT: root, PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}' };
    servers[id] = prelude
      ? { type: 'stdio', command: '/bin/sh', args: ['-c', 'cd "$PLUGIN_ROOT" && exec "$@"', 'sh', command, ...args], env }
      : { type: 'stdio', command, args, env };
  }
  fs.writeFileSync(path.join(out, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2) + '\n');
  return out;
}

const markers = [M.skill, M.invalid, M.tool, M.command, `${NAME}:notes`, `${NAME}:no-desc`, `${DOTTED}:notes`, `${NAME}:${INERT_COMMAND}`];
const shape = (r) => ({ exit: r.exit, signal: r.signal, timed_out: r.timed_out, descendants_left: r.descendants_left, requests: r.seen.ENDPOINT.length,
  markers: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.markers))].sort(), bench_tools: [...new Set(r.seen.ENDPOINT.flatMap((q) => q.tools ?? []).filter((t) => typeof t === 'string' && t.includes(TOOL)))].sort(),
  remote: [...new Set(r.seen.REMOTE.flatMap((q) => q.markers))].sort() });

try {
  const L = await b.listener('ENDPOINT', { markers, toolNames: true });
  const R = await b.listener('REMOTE', { markers: LITERAL_MARKERS });
  const cwd = path.join(b.work, 'work');
  fs.mkdirSync(cwd);
  const folder = path.join(b.work, 'folder');
  fs.mkdirSync(folder);
  const plain = path.join(b.work, 'plain');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'spec.toml'), '[spec]\nname = "plain"\nversion = "1.0.0"\nformat = "0.2"\n\n[model.roles]\nprimary = "bench-primary"\n');
  const local = path.join(b.work, 'local.toml');
  fs.writeFileSync(local, `[endpoints.anthropic-messages]\nbase_url = "${L.url}"\ncredential = "env:${REF_VAR}"\nauth = "bearer"\n\n[login]\nmode = "endpoint"\n`);
  const probeOut = path.join(b.work, 'probe');
  const hookProbe = path.join(b.work, 'hook-ran');
  const marks = { skill: M.skill, tool: M.tool };
  const pkg = (dir, opts) => writePackage(path.join(b.work, 'pkgs', dir, opts.name ?? NAME), { name: NAME, tool: TOOL, probeOut, marks, inert: { command: M.command, hookProbe }, ...opts });
  const clean = pkg('clean', {});
  const future = pkg('future', { version: '9.9.9' });
  const mixed = pkg('mixed', { marks: M });
  const translated = translate(clean, path.join(b.work, 'translated', NAME));
  const flat = translate(clean, path.join(b.work, 'flat', NAME), { nest: false });
  const unbridged = translate(clean, path.join(b.work, 'unbridged', NAME), { prelude: false });
  const literal = translate(pkg('literal', literalOpts(`${R.url}/mcp`)), path.join(b.work, 'translated-literal', NAME));
  const dotted = translate(pkg('dotted', { name: DOTTED }), path.join(b.work, 'translated-dotted', DOTTED));
  const spec = b.hs('launch-spec', ['--harness', 'claude-code', '--folder', folder, '--layer', plain, '--local', local, '--bin', claude, '--headless']);
  // The plugin flag goes right after the binary, so nothing can read the prompt as a plugin path.
  const run = async (dir, extraEnv = {}) => {
    for (const f of [probeOut, hookProbe]) fs.rmSync(f, { force: true });
    const l = fromSpec(spec, extraEnv, claude, [PROMPT]);
    if (dir) l.argv.splice(1, 0, '--plugin-dir', dir);
    const r = await b.launch([L, R], l.argv, l.env, cwd);
    return { ...r, probe: probe(probeOut), hook_ran: fs.existsSync(hookProbe) };
  };

  const folderBefore = fs.readdirSync(folder).sort();
  const control = await run(null);
  const published = { clean: await run(clean), future: await run(future), mixed: await run(mixed) };
  const carried = await run(translated);
  const flatRun = await run(flat);
  const bare = await run(unbridged);
  const lit = await run(literal, { [OTHER]: OTHER_VALUE });
  const dot = await run(dotted);
  const folderAfter = fs.readdirSync(folder).sort();

  const has = (r, m) => r.seen.ENDPOINT.some((q) => q.markers.includes(m));
  const loaded = (r, skill, mark, name = NAME) => has(r, `${name}:${skill}`) || has(r, mark);
  const offered = (r) => r.seen.ENDPOINT.some((q) => (q.tools ?? []).some((t) => typeof t === 'string' && t.includes(TOOL)));
  const remoteGot = (r, m) => r.seen.REMOTE.some((q) => q.markers.includes(m));
  const commandSeen = (r) => loaded(r, INERT_COMMAND, M.command);
  const seenAs = (r) => ({ skill_loads: loaded(r, 'notes', M.skill), skill_description_reaches: has(r, M.skill), server_starts: r.probe !== null, tool_reaches: has(r, M.tool) && offered(r), root_command_loads: commandSeen(r), root_hook_runs: r.hook_ran });
  const kept = Object.keys(JSON.parse(fs.readFileSync(path.join(translated, '.claude-plugin', 'plugin.json'), 'utf8')));
  const recorded = {
    'clean, as published': seenAs(published.clean),
    'future (9.9.9), as published': seenAs(published.future),
    'mixed, as published': { ...seenAs(published.mixed), invalid_skill_loads: loaded(published.mixed, 'no-desc', M.invalid) },
    translated: { skill_description_reaches: has(carried, M.skill), manifest_fields: kept },
    flat: { root_command_loads: commandSeen(flatRun), root_hook_runs: flatRun.hook_ran },
    'dotted name, translated': { skill_loads: loaded(dot, 'notes', M.skill, DOTTED), server_starts: dot.probe !== null, tool_reaches: has(dot, M.tool) && offered(dot) },
  };
  const p = carried.probe;
  const checks = {
    'without a plugin no marker reaches a request (premise)': control.seen.ENDPOINT.length > 0 && !markers.some((m) => has(control, m)) && !offered(control),
    'translated: the skill reaches the request, under the plugin\'s name': has(carried, `${NAME}:notes`),
    'translated: the manifest keeps name and every metadata field, and the plugin loads from it': META.every((k) => kept.includes(k)) && has(carried, `${NAME}:notes`),
    'translated: the server, a ./ command, starts with ${PLUGIN_ROOT} expanded in args': p?.started === true && p.args_expanded === true,
    'translated: ${PLUGIN_DATA} is expanded in env': p?.data_expanded === true,
    'translated: PLUGIN_ROOT is the plugin root, and PLUGIN_DATA an existing, writable directory that ${PLUGIN_DATA} names': p?.root_matches === true && p.data_exists === true && p.data_writable === true && p.data_matches === true,
    'translated: the server runs in the plugin root, through the prelude': p?.cwd_is_root === true,
    'translated: the server\'s tool reaches the request': has(carried, M.tool) && offered(carried),
    'translated: the package\'s commands/ and hooks/ stay inert: the command reaches no request and the hook does not run': !commandSeen(carried) && carried.hook_ran === false,
    'flat (premise of nesting, and control for the line above): copied to the root, Claude Code acts on commands/ or hooks/': commandSeen(flatRun) || flatRun.hook_ran === true,
    'unbridged (premise of the prelude): without it the server does not run in the plugin root': bare.probe?.started === true && bare.probe.cwd_is_root === false,
    'literal (premise of plugin_placeholder_literal): Claude Code expands the env text to the variable\'s value': lit.probe?.started === true && lit.probe.literal_kept === false && lit.probe.literal_is_other === true,
    'literal (premise of plugin_placeholder_literal): Claude Code expands the header text': remoteGot(lit, OTHER_VALUE) && !remoteGot(lit, LITERAL_MARKERS[0]),
  };
  const reached = [control, ...Object.values(published), carried, flatRun, bare, lit, dot].every((r) => r.seen.ENDPOINT.length > 0);
  const verdict = !reached ? 'inconclusive: a start reached no endpoint' : Object.values(checks).every(Boolean) ? 'pass' : 'fail';
  const report = {
    check: 'tier 1: an Agent Plugins 1.0.0 package on Claude Code, as published and translated to the .claude-plugin layout (design note v0.2 §5.7, §10)',
    at: new Date().toISOString(),
    evidence: evidence(b, claude),
    runs: { control: shape(control), ...Object.fromEntries(Object.entries(published).map(([k, r]) => [`published_${k}`, shape(r)])), translated: shape(carried), flat: shape(flatRun), unbridged: shape(bare), literal: shape(lit), dotted: shape(dot) },
    recorded,
    server_probes: { ...Object.fromEntries(Object.entries(published).map(([k, r]) => [`published_${k}`, r.probe])), translated: carried.probe, flat: flatRun.probe, unbridged: bare.probe, literal: lit.probe, dotted: dot.probe },
    folder_entries_new: folderAfter.filter((n) => !folderBefore.includes(n)),
    folder_plugins_entries: fs.existsSync(path.join(folder, 'plugins')) ? fs.readdirSync(path.join(folder, 'plugins')).sort() : [],
    checks,
    verdict,
  };
  process.stdout.write(JSON.stringify(report, null, 2).split(R.url).join('<REMOTE>').split(L.url).join('<ENDPOINT>').split(b.work).join('<WORK>') + '\n');
  process.exitCode = verdict === 'pass' ? 0 : verdict.startsWith('inconclusive') ? 3 : 1;
} catch (e) {
  process.stderr.write(`tier 1 Agent Plugins check on Claude Code failed to run: ${e.message}\n`);
  process.exitCode = 4;
} finally {
  if (!(await b.finish())) process.exitCode = 4;
}

// The problems of a process value (design note §5.4): what `validate` checks of anything a spec
// runs, an MCP server, a hook or the status line, as `{exec, args, env, env_refs}` or `{shell}`.
// Part of the skeleton spec; hs's launch-time handling of processes stays in hs.

const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => isTable(v) && Object.values(v).every((x) => typeof x === 'string');

// The problems of a process value, for `validate`: its shape, and any `${` in a string (§5.3),
// which a harness may expand from its own environment, credentials included. Never echoes a
// string. `allowEnv` false refuses env and env_refs for a harness slot that has none.
export function processProblems(id, proc, { allowEnv = true } = {}) {
  const out = [];
  const bad = (message) => out.push({ code: 'item_malformed', message: `${id}: ${message}` });
  if (!isTable(proc)) {
    bad('a process is a table: { exec, args } or { shell }');
    return out;
  }
  if ((proc.exec === undefined) === (proc.shell === undefined)) bad('give exec or shell, not both');
  if (proc.exec !== undefined && (typeof proc.exec !== 'string' || proc.exec === '')) bad('exec must be a non-empty string');
  if (proc.shell !== undefined && (typeof proc.shell !== 'string' || proc.shell === '')) bad('shell must be a non-empty string');
  if (proc.args !== undefined && (!Array.isArray(proc.args) || !proc.args.every((a) => typeof a === 'string'))) bad('args must be a list of strings');
  // A shell string carries its own arguments: args beside it would be dropped, so they are refused.
  if (proc.shell !== undefined && proc.args !== undefined) bad('args go with exec; a shell string carries its own');
  if (proc.cwd !== undefined && (typeof proc.cwd !== 'string' || proc.cwd === '')) bad('cwd must be a non-empty string');
  // The author's word, for a process a plan persists, that the directory it runs from holds
  // everything it loads (§7.5, bind by copy).
  if (proc.self_contained !== undefined && typeof proc.self_contained !== 'boolean') bad('self_contained is true or false');
  for (const k of ['env', 'env_refs']) {
    if (proc[k] === undefined) continue;
    if (!allowEnv) bad(`${k} is not carried for this item in this build`);
    else if (!strings(proc[k])) bad(`${k} must be a table of strings`);
  }
  const fields = [
    ['exec', proc.exec], ['shell', proc.shell], ['cwd', proc.cwd],
    ...(Array.isArray(proc.args) ? proc.args.map((a, i) => [`args[${i}]`, a]) : []),
    ...(isTable(proc.env) ? Object.entries(proc.env).flatMap(([n, x]) => [['env name', n], [`env.${n}`, x]]) : []),
    ...(isTable(proc.env_refs) ? Object.keys(proc.env_refs).map((n) => ['env_refs name', n]) : []),
  ];
  for (const [where, x] of fields) {
    if (typeof x === 'string' && x.includes('${')) {
      out.push({ code: 'interpolation_refused', message: `${id}: ${where} holds \${…}, which the harness may expand from its environment, credentials included; pass a secret with env_refs` });
    }
  }
  return out;
}

// A path in the item's layer, given absolutely; anything else is passed as written. Walked one
// component at a time, as the spec digest walks it (§5.4): a path through a symlink would run what
// the link points at, which the digest binds only by the link's target string, so it is refused.
// `.` is the layer's directory.

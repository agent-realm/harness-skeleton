#!/usr/bin/env node
// hs: the harness-skeleton reference adapter.
//
//   hs < request.json                     one hs/0.2 envelope on stdin, one response on stdout
//   hs <op> --harness <h> [options]       the same request, built from flags
//
// Options: --folder <path> (args.harness_path), --state, --bin <path>, --layer <dir> (repeatable,
// lowest first; args.layers), --local <local.toml> (args.local), --owner <name>, --mode <mode>,
// --prune, --adopt, --strict-version, --plan <plan.json>, --receipt <receipt.json>,
// --item <id> (repeatable; remove), --cwd <dir> (observe --state), --headless (launch-spec),
// --no-persist-state (overlay plans), --store <file> (sessions.*: a database-file store, a name in
// the folder or an absolute path), --pretty.
// Exit status: 0 for an ok response, 1 for an error response, 2 for a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { handle } from '../src/hs.js';
import { PROTOCOL, fail, parseRequest } from '../src/protocol.js';

function usage(message) {
  process.stderr.write(`hs: ${message}\nusage: hs < request.json | hs <op> --harness <h> [--folder <path>] [--state] [--bin <path>] [--layer <dir>]... [--local <file>]\n          [--owner <name>] [--mode materialize] [--prune] [--adopt] [--strict-version] [--plan <file>] [--receipt <file>] [--item <id>]... [--store <file>] [--pretty]\n`);
  process.exit(2);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    usage(`${file} is not a readable JSON file (${e.code ?? 'not JSON'})`);
  }
}

function fromFlags(argv) {
  const [op, ...rest] = argv;
  const args = {};
  let pretty = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      if (i + 1 >= rest.length) usage(`${flag} needs a value`);
      return rest[++i];
    };
    if (flag === '--harness') args.harness = value();
    // Relative paths resolve against the shell's directory here, in the CLI only; the
    // protocol itself takes absolute paths.
    else if (flag === '--folder') args.harness_path = path.resolve(value());
    else if (flag === '--bin') args.bin = path.resolve(value());
    // A file name inside the folder stays as given; an absolute path names a store elsewhere.
    else if (flag === '--store') args.store = value();
    else if (flag === '--layer') (args.layers ??= []).push(path.resolve(value()));
    else if (flag === '--local') args.local = path.resolve(value());
    else if (flag === '--state') args.state = true;
    else if (flag === '--cwd') args.cwd = path.resolve(value());
    else if (flag === '--headless') args.headless = true;
    else if (flag === '--no-persist-state') args.no_persist_state = true;
    else if (flag === '--owner') args.owner = value();
    else if (flag === '--mode') args.mode = value();
    else if (flag === '--prune') args.prune = true;
    else if (flag === '--adopt') args.adopt = true;
    else if (flag === '--strict-version') args.strict_version = true;
    else if (flag === '--plan') {
      // a plan, or the response envelope `hs plan` printed around it
      const p = readJsonFile(value());
      args.plan = p && p.ok === true && p.result ? p.result : p;
    }
    else if (flag === '--receipt') args.receipt = readJsonFile(value());
    else if (flag === '--item') (args.items ??= []).push(value());
    else if (flag === '--pretty') pretty = true;
    else usage(`unknown option ${flag}`);
  }
  return { req: { protocol: PROTOCOL, request_id: 'cli', op, args }, pretty };
}

const argv = process.argv.slice(2);
let req;
let pretty = false;
let res;
if (argv.length === 0) {
  try {
    req = parseRequest(fs.readFileSync(0, 'utf8'));
    res = handle(req);
  } catch (e) {
    res = fail(null, e);
  }
} else {
  if (argv[0].startsWith('-')) usage('the op comes first');
  ({ req, pretty } = fromFlags(argv));
  res = handle(req);
}
process.stdout.write(JSON.stringify(res, null, pretty ? 2 : 0) + '\n');
process.exitCode = res.ok ? 0 : 1;

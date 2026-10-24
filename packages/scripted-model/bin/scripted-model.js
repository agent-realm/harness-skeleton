#!/usr/bin/env node
// The scripted model as a process, for a setup step that starts it detached (a gentar scenario's
// [oracle] steps, a bench script):
//
//   scripted-model --script <script.json> [--port <n>] [--port-file <path>] [--seen <path.jsonl>]
//
// The script is the object scriptedModel takes, as JSON: { steps, fallback, markers, credentials }.
// Once listening on 127.0.0.1 it writes the port to --port-file (written whole, then renamed into
// place, so a reader never sees half a number), and appends each request's record to --seen as
// one JSON line. It serves until SIGTERM or SIGINT, then exits 0; its port file is removed on
// any exit Node runs (only SIGKILL leaves it). A request whose record cannot be appended to
// --seen gets 500, and the model keeps serving.
// A --port-file that already exists is refused (exit 2): a readiness check polling for it would
// read the old port, so the caller removes it before starting, as the README's example does.

import fs from 'node:fs';
import path from 'node:path';
import { scriptedModel } from '../src/index.js';

const USAGE = 'usage: scripted-model --script <script.json> [--port <n>] [--port-file <path>] [--seen <path.jsonl>]';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--script', '--port', '--port-file', '--seen'].includes(k) || argv[i + 1] === undefined) {
      process.stderr.write(`${USAGE}\n`);
      process.exit(2);
    }
    out[k.slice(2)] = argv[++i];
  }
  if (!out.script) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  return out;
}

const a = args(process.argv.slice(2));
let script;
try {
  script = JSON.parse(fs.readFileSync(a.script, 'utf8'));
} catch (e) {
  process.stderr.write(`scripted-model: ${a.script}: ${e.message}\n`);
  process.exit(2);
}
if (a['port-file'] && fs.existsSync(a['port-file'])) {
  process.stderr.write(`scripted-model: ${a['port-file']} already exists; remove it before starting, so a readiness check cannot read a stale port\n`);
  process.exit(2);
}
const port = a.port === undefined ? 0 : Number(a.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`scripted-model: --port ${a.port} is not a port\n`);
  process.exit(2);
}
const { steps, fallback, markers, credentials } = script ?? {};
// The handlers come first, before anything listens or any port file exists: a caller that sees
// the port file and signals at once must find them installed, or the default action kills the
// process with the file left behind. A signal during startup stops it as well.
let m = null;
let ours = false;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (m) await m.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// The port file, once ours, goes on any exit Node runs (a signal above, an error). Only SIGKILL
// leaves it. A file that was there before is never ours: it was refused above.
process.on('exit', () => {
  if (ours) fs.rmSync(a['port-file'], { force: true });
});
try {
  m = await scriptedModel({
    steps, fallback, markers, credentials, port,
    onSeen: a.seen ? (r) => fs.appendFileSync(a.seen, JSON.stringify(r) + '\n') : undefined,
  });
} catch (e) {
  // A script the model refuses, or a port it cannot take: nothing is listening, no port file.
  process.stderr.write(`scripted-model: ${e.message}\n`);
  process.exit(2);
}
if (stopping) await m.close();
else if (a['port-file']) {
  const tmp = path.join(path.dirname(a['port-file']), `.${path.basename(a['port-file'])}.${process.pid}`);
  fs.writeFileSync(tmp, `${m.port}\n`);
  fs.renameSync(tmp, a['port-file']);
  ours = true;
}
if (!stopping) process.stdout.write(`${m.url}\n`);

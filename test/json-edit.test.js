// Minimal edits to a JSON file the user owns (src/json-edit.js): one array element is inserted,
// replaced or removed, and every byte outside it stays as it was.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getElement, parseSpans, pathBlocked, setElement, setKey } from '../src/json-edit.js';

const ours = (v) => JSON.stringify(v).includes('/hs-run/hook.g/');
const group = (cmd) => ({ matcher: 'Bash', hooks: [{ type: 'command', command: cmd, timeout: 70 }] });
const mine = group('node /f/hs-run/hook-shim/claude-code.js PreToolUse -- /f/hs-run/hook.g/run.sh # hs');

const USER_FILE = `{
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write",
        "hooks": [{ "type": "command", "command": "echo \\"{[not json]}\\"" }]
      }
    ],
    "Stop": []
  },
  "env": { "A": "1" }
}
`;

test('append, replace and remove our element; everything else byte for byte; a round trip restores the file exactly', () => {
  const added = setElement(USER_FILE, ['hooks', 'PreToolUse'], ours, mine);
  assert.deepEqual(JSON.parse(added).hooks.PreToolUse, [JSON.parse(USER_FILE).hooks.PreToolUse[0], mine]);
  // Everything before the user's last element's end, and after the array's end, is the same text.
  const cut = USER_FILE.indexOf('    ]\n  ');
  assert.equal(added.slice(0, USER_FILE.lastIndexOf('}', cut) + 1), USER_FILE.slice(0, USER_FILE.lastIndexOf('}', cut) + 1));
  assert.ok(added.endsWith(USER_FILE.slice(cut)));
  const replaced = setElement(added, ['hooks', 'PreToolUse'], ours, { ...mine, matcher: 'Edit' });
  assert.equal(JSON.parse(replaced).hooks.PreToolUse[1].matcher, 'Edit');
  assert.deepEqual(JSON.parse(replaced).hooks.PreToolUse[0], JSON.parse(USER_FILE).hooks.PreToolUse[0]);
  assert.equal(setElement(added, ['hooks', 'PreToolUse'], ours, undefined), USER_FILE, 'remove restores the exact bytes');
  assert.deepEqual(getElement(added, ['hooks', 'PreToolUse'], ours), { present: true, value: mine });
  assert.deepEqual(getElement(USER_FILE, ['hooks', 'PreToolUse'], ours), { present: false });
});

test('an empty array, a missing array, a missing hooks object; the first and the only element removed', () => {
  const intoEmpty = setElement(USER_FILE, ['hooks', 'Stop'], ours, mine);
  assert.deepEqual(JSON.parse(intoEmpty).hooks.Stop, [mine]);
  assert.equal(setElement(intoEmpty, ['hooks', 'Stop'], ours, undefined), USER_FILE, 'remove gives back the exact bytes of an empty array');
  const created = setElement(USER_FILE, ['hooks', 'SessionStart'], ours, mine);
  assert.deepEqual(JSON.parse(created).hooks.SessionStart, [mine]);
  assert.ok(created.startsWith(USER_FILE.slice(0, USER_FILE.indexOf('    "Stop": []') + '    "Stop": []'.length)));
  const bare = '{\n  "model": "opus"\n}\n';
  const fresh = setElement(bare, ['hooks', 'PreToolUse'], ours, mine);
  assert.deepEqual(JSON.parse(fresh), { model: 'opus', hooks: { PreToolUse: [mine] } });
  assert.ok(fresh.startsWith('{\n  "model": "opus",\n  "hooks": '));
  // First of two removed: the second keeps its place and indentation.
  const two = setElement(setElement(bare, ['hooks', 'PreToolUse'], ours, mine), ['hooks', 'PreToolUse'], (v) => v.matcher === 'X', group('x'));
  const firstGone = setElement(two, ['hooks', 'PreToolUse'], ours, undefined);
  assert.deepEqual(JSON.parse(firstGone).hooks.PreToolUse, [group('x')]);
  assert.deepEqual(JSON.parse(setElement(fresh, ['hooks', 'PreToolUse'], ours, undefined)).hooks.PreToolUse, []);
});

test('other layouts: tabs, four spaces, one line; strings with brackets and escapes', () => {
  for (const text of [
    '{\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t{"matcher": "A"}\n\t\t]\n\t}\n}\n',
    '{\n    "hooks": {\n        "PreToolUse": [\n            {"matcher": "A"}\n        ]\n    }\n}\n',
    '{"hooks":{"PreToolUse":[{"matcher":"A"}]},"x":"]}{\\"["}',
  ]) {
    const out = setElement(text, ['hooks', 'PreToolUse'], ours, mine);
    assert.deepEqual(JSON.parse(out).hooks.PreToolUse, [{ matcher: 'A' }, mine], text);
    assert.equal(setElement(out, ['hooks', 'PreToolUse'], ours, undefined), text, 'round trip');
  }
  assert.equal(JSON.parse('{"x":"]}{\\"["}').x, ']}{"[');
});

test('refusals: two entries for one address, a key that is not an object or not an array, a file that is not JSON', () => {
  const twice = setElement(setElement(USER_FILE, ['hooks', 'Stop'], ours, mine), ['hooks', 'Stop'], () => false, mine);
  assert.throws(() => setElement(twice, ['hooks', 'Stop'], ours, mine), /2 entries/);
  assert.ok(getElement(twice, ['hooks', 'Stop'], ours).blocked);
  assert.throws(() => setElement('{"hooks": []}', ['hooks', 'PreToolUse'], ours, mine), /hooks is not an object/);
  assert.throws(() => setElement('{"hooks": {"PreToolUse": {}}}', ['hooks', 'PreToolUse'], ours, mine), /not an array/);
  assert.throws(() => parseSpans('{"a": 1,}'), /not JSON/);
  assert.throws(() => parseSpans('{"a": 1} x'), /not JSON/);
});

test('setKey: replace, insert and delete a member in place; everything else byte for byte', async () => {
  const text = '{\n    "model": "opus",\n    "env": {"A": "1"},\n    "z": [1,2]\n}\n';
  assert.equal(setKey(text, ['model'], 'sonnet'), text.replace('"opus"', '"sonnet"'));
  const added = setKey(text, ['cleanupPeriodDays'], 9999);
  assert.deepEqual(JSON.parse(added), { ...JSON.parse(text), cleanupPeriodDays: 9999 });
  assert.ok(added.startsWith(text.slice(0, text.indexOf('[1,2]') + 5)));
  assert.equal(setKey(added, ['cleanupPeriodDays'], undefined), text, 'a round trip restores the bytes');
  assert.equal(setKey(text, ['env', 'B'], '2').includes('"A": "1"'), true);
  assert.deepEqual(JSON.parse(setKey(text, ['env', 'B'], '2')).env, { A: '1', B: '2' });
  assert.deepEqual(JSON.parse(setKey(text, ['statusLine', 'type'], 'command')).statusLine, { type: 'command' });
  assert.equal(setKey(text, ['missing'], undefined), text);
  assert.deepEqual(JSON.parse(setKey(text, ['model'], undefined)), { env: { A: '1' }, z: [1, 2] });
  assert.throws(() => setKey(text, ['z', 'q'], 1), /z is not an object/);
});

test('review: a container that was empty keeps its exact bytes over a round trip, whatever its whitespace', () => {
  for (const inside of ['', ' ', '\n    ', ' \n  ', '\n\n    ', '\t']) {
    const text = `{\n  "hooks": {\n    "Stop": [${inside}]\n  },\n  "env": {${inside}}\n}\n`;
    const added = setElement(text, ['hooks', 'Stop'], ours, mine);
    assert.deepEqual(JSON.parse(added).hooks.Stop, [mine], JSON.stringify(inside));
    assert.equal(setElement(added, ['hooks', 'Stop'], ours, undefined), text, `array ${JSON.stringify(inside)}`);
    const keyed = setKey(text, ['env', 'A'], '1');
    assert.deepEqual(JSON.parse(keyed).env, { A: '1' });
    assert.equal(setKey(keyed, ['env', 'A'], undefined), text, `object ${JSON.stringify(inside)}`);
  }
  // `[]` takes the entry inside its brackets, so nothing has to be guessed on the way out.
  assert.ok(setElement('{\n  "Stop": []\n}\n', ['Stop'], ours, mine).startsWith('{\n  "Stop": [{\n    "matcher"'));
});

test('review: a key held twice on the edited path is refused, in every edit and read, never edited where nothing reads it', () => {
  const dupHooks = '{"hooks": {"PreToolUse": []}, "model": "sonnet", "hooks": {"PreToolUse": [{"matcher": "Write", "hooks": []}]}}';
  assert.throws(() => setElement(dupHooks, ['hooks', 'PreToolUse'], ours, mine), /has "hooks" 2 times; JSON readers take the last one/);
  assert.match(getElement(dupHooks, ['hooks', 'PreToolUse'], ours).blocked, /"hooks" 2 times/);
  assert.match(pathBlocked(dupHooks, ['hooks', 'PreToolUse']), /"hooks" 2 times/);
  const dupKey = '{"cleanupPeriodDays": 30, "cleanupPeriodDays": 7}';
  assert.throws(() => setKey(dupKey, ['cleanupPeriodDays'], 9999), /"cleanupPeriodDays" 2 times/);
  assert.throws(() => setKey(dupKey, ['cleanupPeriodDays'], undefined), /2 times/);
  const deep = '{"hooks": {"Stop": [], "Stop": []}}';
  assert.throws(() => setElement(deep, ['hooks', 'Stop'], ours, mine), /hooks has "Stop" 2 times/);
  // A key held twice off the path is not this edit's business: JSON.parse and the edit agree.
  const off = '{"a": 1, "a": 2, "hooks": {"Stop": []}}';
  assert.equal(pathBlocked(off, ['hooks', 'Stop']), null);
  assert.deepEqual(JSON.parse(setElement(off, ['hooks', 'Stop'], ours, mine)).hooks.Stop, [mine]);
});

test('review: a CRLF file gets CRLF in the span hs writes, and every line break stays CRLF', () => {
  const crlf = USER_FILE.replace(/\n/g, '\r\n');
  for (const out of [
    setElement(crlf, ['hooks', 'PreToolUse'], ours, mine),
    setElement(crlf, ['hooks', 'Stop'], ours, mine),
    setElement(crlf, ['hooks', 'SessionStart'], ours, mine),
    setKey(crlf, ['statusLine'], { type: 'command', command: 'x' }),
  ]) {
    assert.equal(/[^\r]\n/.test(out), false, 'no bare LF');
    assert.equal(setElement(out, ['hooks', 'PreToolUse'], ours, undefined).length > 0, true);
  }
  assert.equal(setElement(setElement(crlf, ['hooks', 'PreToolUse'], ours, mine), ['hooks', 'PreToolUse'], ours, undefined), crlf);
});

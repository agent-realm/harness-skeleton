// The scripted model (src/index.js): three wires, streamed and whole, steps matched by turn, tool
// result, marker, wire and tool, errors, stalls and hangs, records by names only, loopback only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptedModel } from '../src/index.js';

const BIN = fileURLToPath(new URL('../bin/scripted-model.js', import.meta.url));

const post = (url, route, body, headers = {}) => fetch(url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

// An SSE body as its events: { event, data } with data parsed ([DONE] kept as the string).
async function events(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? null;
    const data = lines.find((l) => l.startsWith('data: ')).slice(6);
    return { event, data: data === '[DONE]' ? data : JSON.parse(data) };
  });
}

const FULL = { reasoning: { text: 'think' }, text: 'hello', tool_calls: [{ id: 'call_1', name: 'shell', args: { command: 'ls' } }], usage: { input: 10, output: 5, cache_read: 3, cache_write: 2, reasoning: 1 } };

test('Anthropic Messages, streamed: thinking with its signature, text, a tool use with its input as JSON deltas, then usage and stop', async () => {
  const m = await scriptedModel({ steps: [{ reply: FULL }] });
  try {
    const res = await post(m.url, '/v1/messages', { model: 'claude-x', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const ev = await events(res);
    assert.deepEqual(ev.map((e) => e.event), ['message_start',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_stop',
      'message_delta', 'message_stop']);
    assert.ok(ev.every((e) => e.event === e.data.type), 'each event names its data type');
    assert.equal(ev[0].data.message.model, 'claude-x');
    assert.deepEqual(ev[0].data.message.usage, { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 0 });
    assert.equal(ev[1].data.content_block.type, 'thinking');
    assert.equal(ev[2].data.delta.thinking, 'think');
    assert.equal(ev[3].data.delta.type, 'signature_delta');
    assert.equal(ev[6].data.delta.text, 'hello');
    assert.deepEqual(ev[8].data.content_block, { type: 'tool_use', id: 'call_1', name: 'shell', input: {} });
    assert.deepEqual(JSON.parse(ev[9].data.delta.partial_json), { command: 'ls' });
    assert.equal(ev[11].data.delta.stop_reason, 'tool_use');
    assert.deepEqual(ev[11].data.usage, { output_tokens: 5 });
  } finally {
    await m.close();
  }
});

test('Anthropic Messages, whole: the same parts as one message; opaque reasoning is redacted_thinking; text only ends the turn', async () => {
  const m = await scriptedModel({ steps: [{ reply: FULL }, { reply: { reasoning: { opaque: true }, text: 'ok' } }] });
  try {
    const one = await (await post(m.url, '/v1/messages', { model: 'claude-x', messages: [] })).json();
    assert.equal(one.type, 'message');
    assert.deepEqual(one.content.map((c) => c.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(one.content[2].input, { command: 'ls' });
    assert.equal(one.stop_reason, 'tool_use');
    assert.deepEqual(one.usage, { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 });
    const two = await (await post(m.url, '/v1/messages', { model: 'claude-x', messages: [] })).json();
    assert.deepEqual(two.content.map((c) => c.type), ['redacted_thinking', 'text']);
    assert.equal(two.stop_reason, 'end_turn');
  } finally {
    await m.close();
  }
});

test('OpenAI Chat Completions, streamed and whole: reasoning_content, content, tool_calls, the finish reason, a usage chunk, [DONE]; created from the clock', async () => {
  const m = await scriptedModel({ steps: [{ reply: FULL }, { reply: FULL }], clock: () => 1_700_000_000_999 });
  try {
    const ev = await events(await post(m.url, '/v1/chat/completions', { model: 'gpt-x', stream: true, messages: [] }));
    assert.equal(ev.at(-1).data, '[DONE]');
    const chunks = ev.slice(0, -1).map((e) => e.data);
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.created === 1_700_000_000 && c.model === 'gpt-x'));
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    assert.equal(chunks[1].choices[0].delta.reasoning_content, 'think');
    assert.equal(chunks[2].choices[0].delta.content, 'hello');
    assert.deepEqual(chunks[3].choices[0].delta.tool_calls, [{ index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }]);
    assert.equal(chunks[4].choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(chunks[5].choices, []);
    assert.deepEqual(chunks[5].usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } });
    const whole = await (await post(m.url, '/v1/chat/completions', { model: 'gpt-x', messages: [] })).json();
    assert.equal(whole.object, 'chat.completion');
    assert.deepEqual(whole.choices[0].message, { role: 'assistant', content: 'hello', reasoning_content: 'think', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }] });
    assert.equal(whole.choices[0].finish_reason, 'tool_calls');
  } finally {
    await m.close();
  }
});

test('OpenAI Responses, streamed and whole: the API\'s item lifecycle with deltas, sequence numbers, completed with usage', async () => {
  const m = await scriptedModel({ steps: [{ reply: FULL }, { reply: { reasoning: { opaque: true }, text: 'done' } }], clock: () => 5000 });
  try {
    const ev = await events(await post(m.url, '/v1/responses', { model: 'gpt-x', stream: true, input: [] }));
    assert.deepEqual(ev.map((e) => e.event), [
      'response.created', 'response.in_progress',
      'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done',
      'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.output_item.done',
      'response.completed']);
    assert.deepEqual(ev.map((e) => e.data.sequence_number), ev.map((_, i) => i));
    const done = ev.filter((e) => e.event === 'response.output_item.done');
    assert.deepEqual(done.map((e) => [e.data.output_index, e.data.item.type]), [[0, 'reasoning'], [1, 'message'], [2, 'function_call']]);
    assert.deepEqual(done[0].data.item.summary, [{ type: 'summary_text', text: 'think' }]);
    assert.equal(ev.find((e) => e.event === 'response.reasoning_summary_text.delta').data.delta, 'think');
    // What an SDK consumer renders: the text deltas.
    assert.equal(ev.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join(''), 'hello');
    assert.equal(ev.find((e) => e.event === 'response.output_text.delta').data.item_id, done[1].data.item.id);
    assert.equal(done[2].data.item.call_id, 'call_1');
    assert.equal(ev.find((e) => e.event === 'response.function_call_arguments.done').data.arguments, '{"command":"ls"}');
    assert.equal(ev.at(-1).data.response.created_at, 5);
    assert.deepEqual(ev.at(-1).data.response.usage, { input_tokens: 10, input_tokens_details: { cached_tokens: 3 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 15 });
    const whole = await (await post(m.url, '/v1/responses', { model: 'gpt-x', input: [] })).json();
    assert.equal(whole.object, 'response');
    assert.deepEqual(whole.output.map((o) => o.type), ['reasoning', 'message']);
    assert.equal(whole.output[0].encrypted_content.length > 0, true);
  } finally {
    await m.close();
  }
});

test('steps: by turn, by the tool result a request returns, by marker, by wire and by tool; each answers once; the first that fits wins', async () => {
  const m = await scriptedModel({
    steps: [
      { when: { after_tool: 'call_9' }, reply: { text: 'after the tool' } },
      { when: { marker: 'MARK-7' }, reply: { text: 'marked' } },
      { when: { wire: 'chat', tool: 'shell' }, reply: { text: 'chat with shell' } },
      { when: { turn: 1 }, reply: { tool_calls: [{ id: 'call_9', name: 'shell', args: {} }] } },
    ],
  });
  try {
    const first = await (await post(m.url, '/v1/messages', { model: 'a', messages: [{ role: 'user', content: 'go' }] })).json();
    assert.equal(first.content[0].id, 'call_9');
    const second = await (await post(m.url, '/v1/messages', { model: 'a', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_9', content: 'x' }] }] })).json();
    assert.equal(second.content[0].text, 'after the tool');
    const third = await (await post(m.url, '/v1/responses', { model: 'a', input: [{ role: 'user', content: 'MARK-7 please' }] })).json();
    assert.equal(third.output[0].content[0].text, 'marked');
    const fourth = await (await post(m.url, '/v1/chat/completions', { model: 'a', tools: [{ type: 'function', function: { name: 'shell' } }], messages: [] })).json();
    assert.equal(fourth.choices[0].message.content, 'chat with shell');
    // Every step is used; the next request fits none and gets 400 in the wire's shape.
    assert.deepEqual(m.unused(), []);
    const none = await post(m.url, '/v1/messages', { model: 'a', messages: [] });
    assert.equal(none.status, 400);
    assert.deepEqual(await none.json(), { type: 'error', error: { type: 'invalid_request_error', message: 'scripted model: no step fits this request' } });
    assert.deepEqual(m.seen.map((s) => s.step), [3, 0, 1, 2, null]);
    assert.deepEqual(m.seen.map((s) => s.turn), [1, 2, 3, 4, 5]);
  } finally {
    await m.close();
  }
});

test('tool results are read per wire: Chat tool messages and Responses function_call_output', async () => {
  const m = await scriptedModel({ steps: [{ when: { after_tool: 'c1' }, reply: { text: 'chat' } }, { when: { after_tool: 'r1' }, reply: { text: 'resp' } }] });
  try {
    await post(m.url, '/v1/chat/completions', { model: 'a', messages: [{ role: 'tool', tool_call_id: 'c1', content: 'out' }] });
    await post(m.url, '/v1/responses', { model: 'a', input: [{ type: 'function_call_output', call_id: 'r1', output: 'out' }] });
    assert.deepEqual(m.seen.map((s) => [s.tool_results, s.step]), [[['c1'], 0], [['r1'], 1]]);
  } finally {
    await m.close();
  }
});

test('a fallback answers whatever no step fits, any number of times', async () => {
  const m = await scriptedModel({ steps: [{ when: { marker: 'X' }, reply: { text: 'x' } }], fallback: { text: 'fallback' } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await (await post(m.url, '/v1/messages', { model: 'a', messages: [] })).json()).content[0].text, 'fallback');
    assert.deepEqual(m.seen.map((s) => s.step), ['fallback', 'fallback', 'fallback']);
    assert.deepEqual(m.unused(), [0]);
  } finally {
    await m.close();
  }
});

test('errors in each wire\'s shape, with retry-after; a stall answers late; a hang never answers until the client gives up', async () => {
  const m = await scriptedModel({
    steps: [
      { when: { wire: 'anthropic' }, reply: { error: { status: 529, message: 'busy' } } },
      { when: { wire: 'chat' }, reply: { error: { status: 429, message: 'slow down', retry_after: 2 } } },
      { when: { wire: 'responses', turn: 3 }, reply: { stall_ms: 150, text: 'late' } },
      { when: { wire: 'responses', turn: 4 }, reply: { hang: true } },
    ],
  });
  try {
    const a = await post(m.url, '/v1/messages', { model: 'a', messages: [] });
    assert.equal(a.status, 529);
    assert.deepEqual(await a.json(), { type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
    const c = await post(m.url, '/v1/chat/completions', { model: 'a', messages: [] });
    assert.equal(c.status, 429);
    assert.equal(c.headers.get('retry-after'), '2');
    assert.equal((await c.json()).error.type, 'rate_limit_exceeded');
    const t0 = Date.now();
    const late = await (await post(m.url, '/v1/responses', { model: 'a', input: [] })).json();
    assert.ok(Date.now() - t0 >= 140);
    assert.equal(late.output[0].content[0].text, 'late');
    await assert.rejects(fetch(m.url + '/v1/responses', { method: 'POST', body: JSON.stringify({ model: 'a', input: [] }), signal: AbortSignal.timeout(200) }), /TimeoutError|aborted/);
  } finally {
    await m.close();
  }
});

test('records by names only: never a prompt, a tool result or a credential value', async () => {
  const SECRET = 'sk-not-a-real-key-but-treated-as-one';
  const m = await scriptedModel({ steps: [{ reply: { text: 'ok' } }], markers: ['MARK-1', 'ABSENT'], credentials: { 'bench-dummy': 'dummy' } });
  try {
    await post(m.url, '/v1/messages', { model: 'claude-x', stream: true, tools: [{ name: 'Bash', input_schema: {} }], messages: [{ role: 'user', content: 'private prompt MARK-1' }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'private output' }] }] }, { 'x-api-key': SECRET });
    await post(m.url, '/v1/messages', 'not json', { authorization: 'Bearer bench-dummy' });
    await fetch(m.url + '/v1/models');
    assert.deepEqual(m.seen[0], { turn: 1, method: 'POST', path: '/v1/messages', wire: 'anthropic', model: 'claude-x', stream: true, credential: 'x-api-key:other', tools: ['Bash'], tool_results: ['call_1'], markers: ['MARK-1'], step: 0 });
    assert.equal(m.seen[1].credential, 'bearer:dummy');
    assert.equal(m.seen[1].step, null);
    assert.deepEqual([m.seen[2].wire, m.seen[2].turn, m.seen[2].path], [null, null, '/v1/models']);
    const all = JSON.stringify(m.seen);
    for (const s of [SECRET, 'private prompt', 'private output', 'not json']) assert.equal(all.includes(s), false, s);
  } finally {
    await m.close();
  }
});

test('only loopback: it listens on 127.0.0.1, and a GET or an unknown path is no wire (404)', async () => {
  const m = await scriptedModel({ steps: [] });
  try {
    assert.match(m.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(m.url + '/v1/messages')).status, 404);
    assert.equal((await post(m.url, '/v2/other', {})).status, 404);
  } finally {
    await m.close();
  }
});

test('a script is checked before the server starts', async () => {
  await assert.rejects(scriptedModel({ steps: [{}] }), /steps\[0\]\.reply must be an object/);
  await assert.rejects(scriptedModel({ steps: [{ reply: { tool_calls: [{ name: 'x' }] } }] }), /a string id and name/);
  await assert.rejects(scriptedModel({ steps: {} }), /steps must be an array/);
});

test('the command: serves a JSON script, writes its port file whole, appends each record as a JSON line, stops on SIGTERM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-model-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ steps: [{ reply: { text: 'from a file' } }], markers: ['M'] }));
    const portFile = path.join(dir, 'port');
    const seenFile = path.join(dir, 'seen.jsonl');
    const p = spawn(process.execPath, [BIN, '--script', path.join(dir, 'script.json'), '--port-file', portFile, '--seen', seenFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise((ok) => p.on('exit', (code) => ok(code)));
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((ok) => setTimeout(ok, 50));
    const port = Number(fs.readFileSync(portFile, 'utf8'));
    assert.ok(port > 0);
    const res = await (await post(`http://127.0.0.1:${port}`, '/v1/messages', { model: 'a', messages: [{ role: 'user', content: 'M' }] })).json();
    assert.equal(res.content[0].text, 'from a file');
    const lines = fs.readFileSync(seenFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.wire, l.markers, l.step]), [['anthropic', ['M'], 0]]);
    p.kill('SIGTERM');
    assert.equal(await exited, 0);
    const bad = spawn(process.execPath, [BIN, '--nope'], { stdio: 'ignore' });
    assert.equal(await new Promise((ok) => bad.on('exit', (code) => ok(code))), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load replaces the script between runs; inspect sees the parsed body, and the model keeps none of it', async () => {
  const kept = [];
  const m = await scriptedModel({ steps: [{ reply: { text: 'one' } }], markers: ['HDR-MARK'], inspect: (body, record) => kept.push([record.turn, body.messages.length]) });
  try {
    assert.equal((await (await post(m.url, '/v1/messages', { model: 'a', messages: [1, 2] }, { 'x-trace': 'HDR-MARK' })).json()).content[0].text, 'one');
    assert.deepEqual(m.seen[0].markers, ['HDR-MARK'], 'a marker in a header counts');
    m.load({ steps: [{ when: { turn: 1 }, reply: { text: 'two' } }] });
    m.seen.length = 0;
    assert.equal((await (await post(m.url, '/v1/messages', { model: 'a', messages: [1] })).json()).content[0].text, 'two');
    assert.deepEqual(m.seen.map((r) => r.turn), [1], 'the turn count starts again');
    assert.deepEqual(kept, [[1, 2], [1, 1]]);
    assert.deepEqual(Object.keys(m.seen[0]).sort(), ['credential', 'markers', 'method', 'model', 'path', 'step', 'stream', 'tool_results', 'tools', 'turn', 'wire']);
    assert.throws(() => m.load({ steps: [{}] }), /reply must be an object/);
  } finally {
    await m.close();
  }
});

test('review: the port must be an integer, so listen() cannot take an options object that binds beyond loopback', async () => {
  for (const port of [{ port: 0, host: '0.0.0.0' }, '0', -1, 70000, 1.5]) {
    await assert.rejects(scriptedModel({ port }), /port must be an integer from 0 to 65535/, JSON.stringify(port));
  }
});

test('review: a tool name that is not a string is recorded as null, never copied into the record', async () => {
  const m = await scriptedModel({ steps: [] });
  try {
    await post(m.url, '/v1/messages', { model: 'a', tools: [{ name: { description: 'private prompt', apiKey: 'secret-value' } }, { type: { x: 'secret-2' } }, { name: 'Bash' }], messages: [] });
    await post(m.url, '/v1/chat/completions', { model: 'a', tools: [{ type: 'function', function: { name: ['secret-3'] } }], messages: [] });
    assert.deepEqual(m.seen.map((r) => r.tools), [[null, null, 'Bash'], ['function']]);
    const all = JSON.stringify(m.seen);
    for (const x of ['private prompt', 'secret-value', 'secret-2', 'secret-3']) assert.equal(all.includes(x), false, x);
  } finally {
    await m.close();
  }
});

test('review: markers are matched in the decoded strings, so one with a newline, a quote or a backslash fits', async () => {
  const marker = 'line one\nline "two" C:\\work';
  const m = await scriptedModel({ steps: [{ when: { marker }, reply: { text: 'found' } }], fallback: { text: 'fallback' }, markers: [marker] });
  try {
    const res = await (await post(m.url, '/v1/messages', { model: 'a', messages: [{ role: 'user', content: `before ${marker} after` }] })).json();
    assert.equal(res.content[0].text, 'found');
    assert.deepEqual(m.seen[0].markers, [marker]);
    assert.deepEqual(m.unused(), []);
  } finally {
    await m.close();
  }
});

test('review: the command refuses a port file that already exists, and removes its own when it stops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-model-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ steps: [] }));
    const portFile = path.join(dir, 'port');
    fs.writeFileSync(portFile, '12345\n');
    const stale = spawn(process.execPath, [BIN, '--script', path.join(dir, 'script.json'), '--port-file', portFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    stale.stderr.on('data', (c) => (err += c));
    assert.equal(await new Promise((ok) => stale.on('exit', (code) => ok(code))), 2);
    assert.match(err, /already exists; remove it before starting/);
    fs.rmSync(portFile);
    const p = spawn(process.execPath, [BIN, '--script', path.join(dir, 'script.json'), '--port-file', portFile], { stdio: 'ignore' });
    const exited = new Promise((ok) => p.on('exit', (code) => ok(code)));
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.ok(Number(fs.readFileSync(portFile, 'utf8')) > 0);
    p.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(fs.existsSync(portFile), false, 'removed on stop');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('review: a reply that could not be sent is refused when the script loads: a bad status, a bad retry_after, args that are not JSON', async () => {
  const cases = [
    [{ error: { status: 42 } }, /error\.status must be an integer from 400 to 599/],
    [{ error: { status: 429, retry_after: '1\r\nX-Injected: yes' } }, /retry_after must be a whole number of seconds/],
    [{ tool_calls: [{ id: 'c', name: 'n', args: { n: 1n } }] }, /args cannot be sent as JSON/],
    [{ stall_ms: -1 }, /stall_ms must be a whole number/],
    [{ text: 7 }, /text must be a string/],
    [{ reasoning: { text: 1 } }, /reasoning must be/],
  ];
  for (const [reply, why] of cases) {
    await assert.rejects(scriptedModel({ steps: [{ reply }] }), why);
    await assert.rejects(scriptedModel({ steps: [], fallback: reply }), why);
  }
  const m = await scriptedModel({ steps: [] });
  try {
    assert.throws(() => m.load({ steps: [{ reply: { error: { status: 42 } } }] }), /400 to 599/);
  } finally {
    await m.close();
  }
});

test('review: a throw while answering gets 500 at once in the wire\'s shape, marks the record failed, and close still resolves', async () => {
  let n = 0;
  const m = await scriptedModel({
    fallback: { text: 'ok' },
    onSeen: () => {
      if (n++ === 0) throw new Error('seen sink failed');
    },
    inspect: (body) => {
      if (body.boom) throw new Error('inspect failed');
    },
  });
  try {
    const one = await post(m.url, '/v1/messages', { model: 'a', messages: [] }, {});
    assert.equal(one.status, 500);
    assert.deepEqual(await one.json(), { type: 'error', error: { type: 'api_error', message: 'scripted model: the reply could not be sent: seen sink failed' } });
    const two = await post(m.url, '/v1/chat/completions', { model: 'a', boom: true, messages: [] });
    assert.equal(two.status, 500);
    assert.match((await two.json()).error.message, /inspect failed/);
    const three = await post(m.url, '/v1/messages', { model: 'a', messages: [] });
    assert.equal(three.status, 200, 'the model keeps serving');
    assert.deepEqual(m.seen.map((r) => r.failed ?? false), [true, true, false]);
  } finally {
    await m.close();
  }
});

test('review: a credential is a label only through an own property: Bearer constructor is other', async () => {
  const m = await scriptedModel({ steps: [], credentials: { 'bench-dummy': 'dummy' } });
  try {
    await post(m.url, '/v1/messages', { model: 'a', messages: [] }, { authorization: 'Bearer constructor' });
    await post(m.url, '/v1/messages', { model: 'a', messages: [] }, { 'x-api-key': '__proto__' });
    await post(m.url, '/v1/messages', { model: 'a', messages: [] }, { authorization: 'Bearer toString' });
    assert.deepEqual(m.seen.map((r) => r.credential), ['bearer:other', 'x-api-key:other', 'bearer:other']);
  } finally {
    await m.close();
  }
});

test('review: the command keeps serving when --seen cannot be written, and removes its port file on exit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-model-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ steps: [], fallback: { text: 'ok' } }));
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ steps: [{ reply: { error: { status: 42 } } }] }));
    const portFile = path.join(dir, 'port');
    // A bad script exits 2 before any port file exists.
    const bad = spawn(process.execPath, [BIN, '--script', path.join(dir, 'bad.json'), '--port-file', portFile], { stdio: 'ignore' });
    assert.equal(await new Promise((ok) => bad.on('exit', (code) => ok(code))), 2);
    assert.equal(fs.existsSync(portFile), false);
    // --seen names a directory, so every append fails.
    const p = spawn(process.execPath, [BIN, '--script', path.join(dir, 'script.json'), '--port-file', portFile, '--seen', dir], { stdio: 'ignore' });
    const exited = new Promise((ok) => p.on('exit', (code) => ok(code)));
    for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((ok) => setTimeout(ok, 50));
    const url = `http://127.0.0.1:${Number(fs.readFileSync(portFile, 'utf8'))}`;
    for (let i = 0; i < 2; i++) assert.equal((await post(url, '/v1/messages', { model: 'a', messages: [] })).status, 500);
    p.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(fs.existsSync(portFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the package imports only node: builtins and its own files, so the reference harness and gentar scenarios can depend on it', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = ['src', 'bin'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(root, d, f)));
  assert.ok(files.length >= 2);
  for (const f of files) {
    for (const [, spec] of fs.readFileSync(f, 'utf8').matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)) {
      const ok = spec.startsWith('node:') || (spec.startsWith('.') && path.resolve(path.dirname(f), spec).startsWith(root));
      assert.ok(ok, `${path.relative(root, f)} imports ${spec}`);
    }
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'no dependencies');
});

test('the command: a signal the moment its port file appears still stops it cleanly, every time', async () => {
  // The handlers are installed before the port file is written. Signalled as soon as the file
  // shows, the command must exit 0 and take the file with it; without that order, the default
  // action kills it and the file stays (a CI race on Node 22).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripted-model-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ steps: [] }));
    const runs = 120;
    for (let i = 0; i < runs; i++) {
      const portFile = path.join(dir, `port-${i}`);
      const p = spawn(process.execPath, [BIN, '--script', path.join(dir, 'script.json'), '--port-file', portFile], { stdio: 'ignore' });
      const exited = new Promise((ok) => p.on('exit', (code, signal) => ok({ code, signal })));
      // Poll as tightly as the event loop allows, then signal at once.
      await new Promise((ok, fail) => {
        const t0 = Date.now();
        const tick = () => {
          if (fs.existsSync(portFile)) return ok();
          if (Date.now() - t0 > 10_000) return fail(new Error(`run ${i}: no port file`));
          setImmediate(tick);
        };
        tick();
      });
      p.kill(i % 2 ? 'SIGINT' : 'SIGTERM');
      const { code, signal } = await exited;
      assert.deepEqual({ code, signal }, { code: 0, signal: null }, `run ${i}`);
      assert.equal(fs.existsSync(portFile), false, `run ${i}: the port file is gone`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

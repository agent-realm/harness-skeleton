// @agent-realm/scripted-model: a model endpoint that answers from a script, for deterministic
// harness tests (the reference-harness design note §5). It speaks three wires, each as its vendor
// serves it, streamed (SSE) when the request asks for a stream and one JSON body when it does not:
//   POST /v1/messages          Anthropic Messages
//   POST /v1/chat/completions  OpenAI Chat Completions
//   POST /v1/responses         OpenAI Responses
// It binds 127.0.0.1 only. It has no token, and on a shared bench loopback is what keeps another
// process from driving a run. It records each request by names only: the wire, the model, the
// kind of credential, the tools offered, the tool results returned, which markers appear. It never
// records content.
//
//   const m = await scriptedModel({ steps: [{ when: { turn: 1 }, reply: { tool_calls: [...] } }, ...] });
//   ... point the harness at m.url ...; m.seen; m.unused(); await m.close();
//
// The script (README.md has the full format):
//   steps     [{ when, reply }]. `when`, every field optional and all of them required to hold:
//             `turn` (the request's position, from 1, over every request to a wire), `wire`,
//             `after_tool` (the request returns this call id's result), `marker` (a string in one
//             of the body's decoded strings, or a header), `tool` (the request offers a tool of
//             this name). Each step answers
//             once; a request takes the first unused step that fits.
//   fallback  a reply for a request no step fits, used any number of times. Without one, such a
//             request gets 400, as an endpoint that is not a model would answer.
//   reply     any of `text`, `reasoning` ({ text } or { opaque: true }), `tool_calls`
//             ([{ id, name, args }]), `usage` (the wire's own numbers: { input, output, cache_read,
//             cache_write, reasoning }, sent as given, never converted), `error` ({ status,
//             message, retry_after }), `stall_ms` (wait that long, then answer), `hang` (never
//             answer: the client's own timeout ends the request).
//   markers   strings whose presence each request's record notes (in its body or its headers).
//   credentials  { '<dummy value>': '<label>' }: a request's credential is recorded as its kind
//             and label (`bearer:<label>`, `x-api-key:other`), never its value.
//   clock     () => milliseconds, for the timestamps a wire carries (Chat's `created`, Responses'
//             `created_at`). Date.now when not given.
//   port      0 (any free port) when not given. `onSeen(record)` is called with each record.
//   inspect   (body, record) => void: the caller's own look at a request's parsed body, for a
//             check that needs to know what a harness sent (which variable names a tool's output
//             holds, say). The model keeps nothing of it; what the caller keeps is the caller's.
//
// `load({ steps, fallback })` replaces the script between runs: the turn count starts again and
// every step is unused. The records stay; a caller clears them with `seen.length = 0`.

import http from 'node:http';

export const WIRES = Object.freeze({ '/v1/messages': 'anthropic', '/v1/chat/completions': 'chat', '/v1/responses': 'responses' });

// A placeholder for what a vendor sends opaque (a thinking signature, encrypted reasoning).
const OPAQUE = 'c2NyaXB0ZWQtbW9kZWw=';
const n = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);

// ---- reading a request: names only ---------------------------------------------------------

// The call ids whose results a request carries back, per wire.
export function toolResults(wire, body) {
  const out = [];
  if (wire === 'anthropic') {
    for (const m of Array.isArray(body?.messages) ? body.messages : []) {
      for (const c of Array.isArray(m?.content) ? m.content : []) if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') out.push(c.tool_use_id);
    }
  } else if (wire === 'chat') {
    for (const m of Array.isArray(body?.messages) ? body.messages : []) if (m?.role === 'tool' && typeof m.tool_call_id === 'string') out.push(m.tool_call_id);
  } else if (wire === 'responses') {
    for (const i of Array.isArray(body?.input) ? body.input : []) if (i?.type === 'function_call_output' && typeof i.call_id === 'string') out.push(i.call_id);
  }
  return out;
}

// The names of the tools a request offers, per wire; a tool without a name by its type. Only a
// string is a name: anything else a malformed request puts there is recorded as null.
export function toolNames(wire, body) {
  const str = (x) => (typeof x === 'string' ? x : null);
  return (Array.isArray(body?.tools) ? body.tools : []).map((t) => str(wire === 'chat' ? t?.function?.name : t?.name) ?? str(t?.type));
}

// Every string a parsed body holds, decoded: a marker is looked for in what the request says,
// not in its JSON escaping (a marker with a newline, a quote or a backslash).
function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

function credentialKind(headers, known) {
  // Own properties only: a credential such as `constructor` is not a label.
  const label = (v) => (Object.hasOwn(known, v) ? known[v] : 'other');
  const kinds = [];
  const bearer = /^Bearer (.*)$/i.exec(headers.authorization ?? '');
  if (bearer) kinds.push(`bearer:${label(bearer[1])}`);
  if (headers['x-api-key'] !== undefined) kinds.push(`x-api-key:${label(headers['x-api-key'])}`);
  return kinds.length ? kinds.join(',') : 'none';
}

// ---- answering: each wire as its vendor sends it -------------------------------------------

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

// Anthropic Messages: one content block per part, reasoning first, then text, then tool uses.
function anthropic(id, model, r, stream) {
  const u = r.usage ?? {};
  const usage = { input_tokens: n(u.input), cache_creation_input_tokens: n(u.cache_write), cache_read_input_tokens: n(u.cache_read), output_tokens: n(u.output) };
  const stop = r.tool_calls?.length ? 'tool_use' : 'end_turn';
  const blocks = [];
  if (r.reasoning?.opaque) blocks.push({ start: { type: 'redacted_thinking', data: OPAQUE }, deltas: [], full: { type: 'redacted_thinking', data: OPAQUE } });
  else if (typeof r.reasoning?.text === 'string') {
    blocks.push({ start: { type: 'thinking', thinking: '', signature: '' }, deltas: [{ type: 'thinking_delta', thinking: r.reasoning.text }, { type: 'signature_delta', signature: OPAQUE }], full: { type: 'thinking', thinking: r.reasoning.text, signature: OPAQUE } });
  }
  if (typeof r.text === 'string') blocks.push({ start: { type: 'text', text: '' }, deltas: [{ type: 'text_delta', text: r.text }], full: { type: 'text', text: r.text } });
  for (const c of r.tool_calls ?? []) {
    blocks.push({ start: { type: 'tool_use', id: c.id, name: c.name, input: {} }, deltas: [{ type: 'input_json_delta', partial_json: JSON.stringify(c.args ?? {}) }], full: { type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} } });
  }
  if (!stream) return { type: 'message', id, role: 'assistant', model, content: blocks.map((b) => b.full), stop_reason: stop, stop_sequence: null, usage };
  const events = [{ type: 'message_start', message: { type: 'message', id, role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } }];
  blocks.forEach((b, index) => {
    events.push({ type: 'content_block_start', index, content_block: b.start });
    for (const delta of b.deltas) events.push({ type: 'content_block_delta', index, delta });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: n(u.output) } });
  events.push({ type: 'message_stop' });
  return sse(events);
}

// OpenAI Chat Completions: reasoning as `reasoning_content`, as gateways that pass it send it;
// usage in a last chunk with no choices, as `stream_options.include_usage` asks for.
function chat(id, model, r, stream, created) {
  const u = r.usage ?? {};
  const usage = { prompt_tokens: n(u.input), completion_tokens: n(u.output), total_tokens: n(u.input) + n(u.output), prompt_tokens_details: { cached_tokens: n(u.cache_read) }, completion_tokens_details: { reasoning_tokens: n(u.reasoning) } };
  const finish = r.tool_calls?.length ? 'tool_calls' : 'stop';
  const calls = (r.tool_calls ?? []).map((c, index) => ({ index, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }));
  if (!stream) {
    const message = { role: 'assistant', content: typeof r.text === 'string' ? r.text : null, ...(typeof r.reasoning?.text === 'string' ? { reasoning_content: r.reasoning.text } : {}), ...(calls.length ? { tool_calls: calls.map(({ index, ...c }) => c) } : {}) };
    return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage };
  }
  const base = { id, object: 'chat.completion.chunk', created, model };
  const chunk = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });
  const chunks = [chunk({ role: 'assistant', content: '' })];
  if (typeof r.reasoning?.text === 'string') chunks.push(chunk({ reasoning_content: r.reasoning.text }));
  if (typeof r.text === 'string') chunks.push(chunk({ content: r.text }));
  for (const c of calls) chunks.push(chunk({ tool_calls: [c] }));
  chunks.push(chunk({}, finish));
  chunks.push({ ...base, choices: [], usage });
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

// OpenAI Responses: one output item per part. Streamed, each item goes through the lifecycle the
// API sends: added; its text, summary or arguments as a delta and a done; then the whole item
// done, with a sequence number on every event [developers.openai.com/api/docs/guides/streaming-
// responses, read 2026-10-23]. Codex reads the whole item from `response.output_item.done`
// (codex-rs/core/tests/common/responses.rs at rust-v0.160.0), an SDK's text from the deltas.
function responses(id, model, r, stream, created) {
  const u = r.usage ?? {};
  const usage = { input_tokens: n(u.input), input_tokens_details: { cached_tokens: n(u.cache_read) }, output_tokens: n(u.output), output_tokens_details: { reasoning_tokens: n(u.reasoning) }, total_tokens: n(u.input) + n(u.output) };
  const output = [];
  if (r.reasoning?.opaque) output.push({ type: 'reasoning', id: `rs_${id}`, summary: [], encrypted_content: OPAQUE });
  else if (typeof r.reasoning?.text === 'string') output.push({ type: 'reasoning', id: `rs_${id}`, summary: [{ type: 'summary_text', text: r.reasoning.text }] });
  if (typeof r.text === 'string') output.push({ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: r.text, annotations: [] }] });
  (r.tool_calls ?? []).forEach((c, i) => output.push({ type: 'function_call', id: `fc_${id}_${i}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}), status: 'completed' }));
  const response = { id, object: 'response', created_at: created, model, status: 'completed', output, usage };
  if (!stream) return response;
  const started = { id, object: 'response', created_at: created, model, status: 'in_progress', output: [] };
  const events = [{ type: 'response.created', response: started }, { type: 'response.in_progress', response: started }];
  output.forEach((item, output_index) => {
    const at = { item_id: item.id, output_index };
    if (item.type === 'message') {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } });
      const text = item.content[0].text;
      events.push({ type: 'response.content_part.added', ...at, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      events.push({ type: 'response.output_text.delta', ...at, content_index: 0, delta: text });
      events.push({ type: 'response.output_text.done', ...at, content_index: 0, text });
      events.push({ type: 'response.content_part.done', ...at, content_index: 0, part: item.content[0] });
    } else if (item.type === 'reasoning') {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, summary: [] } });
      for (const [summary_index, part] of item.summary.entries()) {
        events.push({ type: 'response.reasoning_summary_part.added', ...at, summary_index, part: { type: 'summary_text', text: '' } });
        events.push({ type: 'response.reasoning_summary_text.delta', ...at, summary_index, delta: part.text });
        events.push({ type: 'response.reasoning_summary_text.done', ...at, summary_index, text: part.text });
        events.push({ type: 'response.reasoning_summary_part.done', ...at, summary_index, part });
      }
    } else {
      events.push({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', arguments: '' } });
      events.push({ type: 'response.function_call_arguments.delta', ...at, delta: item.arguments });
      events.push({ type: 'response.function_call_arguments.done', ...at, arguments: item.arguments });
    }
    events.push({ type: 'response.output_item.done', output_index, item });
  });
  events.push({ type: 'response.completed', response });
  return sse(events.map((e, sequence_number) => ({ ...e, sequence_number })));
}

const ENCODE = { anthropic, chat, responses };

// An error body in the wire's own shape.
function errorBody(wire, status, message) {
  if (wire === 'anthropic') {
    const type = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error', 529: 'overloaded_error' }[status] ?? 'api_error';
    return { type: 'error', error: { type, message } };
  }
  return { error: { message, type: status === 429 ? 'rate_limit_exceeded' : status < 500 ? 'invalid_request_error' : 'server_error', code: null } };
}

// ---- the server ----------------------------------------------------------------------------

// A script is checked whole before it is used, so a reply that fits a request can always be sent.
function checkScript({ steps, fallback }) {
  if (!Array.isArray(steps)) throw new TypeError('scripted-model: steps must be an array');
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const replyOk = (r, where) => {
    const bad = (what) => {
      throw new TypeError(`scripted-model: ${where}.reply${what}`);
    };
    if (!isObject(r)) bad(' must be an object');
    if (r.text !== undefined && typeof r.text !== 'string') bad('.text must be a string');
    if (r.reasoning !== undefined && !(isObject(r.reasoning) && (typeof r.reasoning.text === 'string' || r.reasoning.opaque === true))) bad('.reasoning must be { text } or { opaque: true }');
    if (r.tool_calls !== undefined && !Array.isArray(r.tool_calls)) bad('.tool_calls must be an array');
    for (const c of r.tool_calls ?? []) {
      if (typeof c?.id !== 'string' || typeof c?.name !== 'string') bad('.tool_calls entries need a string id and name');
      try {
        JSON.stringify(c.args ?? {});
      } catch (e) {
        bad(`.tool_calls args cannot be sent as JSON (${e.message})`);
      }
    }
    if (r.usage !== undefined && !isObject(r.usage)) bad('.usage must be an object');
    if (r.error !== undefined) {
      if (!isObject(r.error)) bad('.error must be an object');
      if (r.error.status !== undefined && !(Number.isInteger(r.error.status) && r.error.status >= 400 && r.error.status <= 599)) bad('.error.status must be an integer from 400 to 599');
      if (r.error.message !== undefined && typeof r.error.message !== 'string') bad('.error.message must be a string');
      if (r.error.retry_after !== undefined && !((Number.isInteger(r.error.retry_after) && r.error.retry_after >= 0) || (typeof r.error.retry_after === 'string' && /^\d+$/.test(r.error.retry_after)))) bad('.error.retry_after must be a whole number of seconds');
    }
    if (r.stall_ms !== undefined && !(Number.isInteger(r.stall_ms) && r.stall_ms >= 0)) bad('.stall_ms must be a whole number of milliseconds');
    if (r.hang !== undefined && typeof r.hang !== 'boolean') bad('.hang must be true or false');
  };
  steps.forEach((s, i) => replyOk(s?.reply, `steps[${i}]`));
  if (fallback !== undefined) replyOk(fallback, 'fallback');
}

export async function scriptedModel({ steps = [], fallback, markers = [], credentials = {}, clock = Date.now, port = 0, onSeen, inspect } = {}) {
  let script;
  let fallbackReply;
  let turn;
  const load = (next) => {
    checkScript(next);
    script = next.steps.map((s, i) => ({ when: s.when ?? {}, reply: s.reply, index: i, used: false }));
    fallbackReply = next.fallback;
    turn = 0;
  };
  load({ steps, fallback });
  const seen = [];
  const open = new Set();
  const fits = (s, req) => !s.used
    && (s.when.turn === undefined || s.when.turn === req.turn)
    && (s.when.wire === undefined || s.when.wire === req.wire)
    && (s.when.after_tool === undefined || req.results.includes(s.when.after_tool))
    && (s.when.marker === undefined || req.has(s.when.marker))
    && (s.when.tool === undefined || req.tools.includes(s.when.tool));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const ctx = { record: null, wire: null };
      answer(req, res, Buffer.concat(chunks).toString('utf8'), ctx).catch((e) => {
        // A reply that cannot be sent fails as clearly as one that fits no step: 500 in the wire's
        // shape, naming what failed, or the connection closed if the answer had begun.
        if (ctx.record) ctx.record.failed = true;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify(errorBody(ctx.wire ?? 'chat', 500, `scripted model: the reply could not be sent: ${e?.message ?? e}`)));
      });
    });
  });
  async function answer(req, res, text, ctx) {
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: no step fits
    }
    const route = (req.url ?? '').split('?')[0];
    const headers = Object.values(req.headers).join('\n');
    const wire = req.method === 'POST' ? WIRES[route] ?? null : null;
    ctx.wire = wire;
    if (wire) turn++;
    // A marker is looked for in the body's decoded strings (or the raw text of a body that is
    // not JSON) and in the headers.
    const strs = body !== null ? stringsOf(body) : [text];
    const has = (m) => strs.some((x) => x.includes(m)) || headers.includes(m);
    const r = { turn: wire ? turn : null, wire, has, results: wire ? toolResults(wire, body) : [], tools: wire ? toolNames(wire, body) : [] };
    const step = wire && body ? script.find((s) => fits(s, r)) : undefined;
    if (step) step.used = true;
    const reply = step ? step.reply : wire && body && fallbackReply !== undefined ? fallbackReply : null;
    const stream = body?.stream === true;
    const record = {
      turn: r.turn, method: req.method, path: route, wire, model: typeof body?.model === 'string' ? body.model : null, stream,
      credential: credentialKind(req.headers, credentials), tools: r.tools, tool_results: r.results,
      markers: markers.filter(has), step: step ? step.index : reply ? 'fallback' : null,
    };
    seen.push(record);
    ctx.record = record;
    onSeen?.(record);
    if (body !== null) inspect?.(body, record);
    if (!wire) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `scripted model: no wire at ${req.method} ${route}` } }));
      return;
    }
    if (!reply) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errorBody(wire, 400, body ? 'scripted model: no step fits this request' : 'scripted model: the request body is not JSON')));
      return;
    }
    if (reply.hang) {
      open.add(res);
      res.on('close', () => open.delete(res));
      return;
    }
    if (Number.isInteger(reply.stall_ms) && reply.stall_ms > 0) await new Promise((ok) => setTimeout(ok, reply.stall_ms));
    if (res.destroyed) return;
    if (reply.error) {
      const status = Number.isInteger(reply.error.status) ? reply.error.status : 500;
      res.writeHead(status, { 'content-type': 'application/json', ...(reply.error.retry_after !== undefined ? { 'retry-after': String(reply.error.retry_after) } : {}) });
      res.end(JSON.stringify(errorBody(wire, status, reply.error.message ?? 'scripted error')));
      return;
    }
    const id = `scripted_${String(r.turn).padStart(4, '0')}`;
    const created = Math.floor(clock() / 1000);
    const out = ENCODE[wire](id, typeof body.model === 'string' ? body.model : 'scripted', reply, stream, created);
    const payload = stream ? out : JSON.stringify(out);
    res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-cache' });
    res.end(payload);
  }
  // An options object with the host fixed: a port that is not a number could otherwise pick
  // listen()'s options overload and bind beyond loopback.
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError(`scripted-model: port must be an integer from 0 to 65535, not ${JSON.stringify(port)}`);
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, ok);
  });
  if (server.address().address !== '127.0.0.1') {
    server.close();
    throw new Error('scripted-model: not listening on 127.0.0.1 only');
  }
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    seen,
    load,
    // The steps no request used: a script that expected more requests than came.
    unused: () => script.filter((s) => !s.used).map((s) => s.index),
    close: () => new Promise((ok) => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}

// Writes the Codex fixture stores: generated text only, no real transcript content.
//   node fixtures/codex/generate.js
// `basic` and `no-ids` are shaped by the seeded generator ported from memhouse's
// fixture generator (its Codex session generator, Apache-2.0): bootstrap context, turns with
// reasoning, a shell call and its output, token_count events (some repeating the running total),
// an aborted turn with tokens and no assistant output, tokens before a turn's first assistant item,
// and (ids on) steering under one turn id. `live` is its `codexLiveRollout`: the record-type
// sequence of a live Codex 0.160.0 rollout, two turns. `features` is written by hand, one record
// per behaviour the adapter claims, with an archived session and a session of two rollouts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const WORDS = ['alpha', 'bravo', 'delta', 'gamma', 'kappa', 'sigma', 'vector', 'buffer', 'cursor', 'archive', 'replay', 'anchor',
  'ğüşıöç', 'çalışma', 'naïve', 'über', '漢字', 'テスト', '🙂', '🚀', 'x'];
const textOf = (r, n) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');
function uuidOf(r) {
  const s = (n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  return `${s(8)}-${s(4)}-4${s(3)}-a${s(3)}-${s(12)}`;
}
const iso = (ms) => new Date(ms).toISOString();

// Where Codex writes a rollout: sessions/YYYY/MM/DD/rollout-<stamp>-<session>.jsonl.
function rolloutPath(startMs, sid, archived = false) {
  const d = iso(startMs);
  const name = `rollout-${d.slice(0, 19).replace(/:/g, '-')}-${sid}.jsonl`;
  return archived ? `archived_sessions/${name}` : `sessions/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${name}`;
}

function codexSession({ seed = 2, turns = 5, start = Date.UTC(2026, 0, 3, 14, 0, 0), cwd = '/work/proj-beta', ids = true } = {}) {
  const r = rng(seed);
  const sid = uuidOf(r);
  let t = start;
  const tick = () => { t += Math.floor(500 + r() * 4000); return iso(t); };
  const lines = [];
  const push = (type, payload) => lines.push(JSON.stringify({ timestamp: tick(), type, payload }));
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const tokens = (last) => {
    for (const k of Object.keys(last)) total[k] += last[k];
    push('event_msg', { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: last, model_context_window: 200000 } });
  };
  const id = (p) => (ids && r() < 0.6 ? { id: `${p}_${uuidOf(r).replace(/-/g, '').slice(0, 24)}` } : {});
  push('session_meta', { id: sid, timestamp: iso(t), cwd, originator: 'codex_cli_rs', cli_version: '0.46.0', git: { branch: 'dev' } });
  push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] });
  for (let n = 0; n < turns; n++) {
    if (ids) push('event_msg', { type: 'task_started', turn_id: `turn_${n}`, model_context_window: 200000 });
    push('response_item', { type: 'message', role: 'user', ...id('msg'), content: [{ type: 'input_text', text: `${textOf(r, 7)} turn ${n}` }] });
    push('event_msg', { type: 'user_message', message: 'dup of the prompt', images: [] });
    push('turn_context', { cwd, approval_policy: 'on-request', model: n % 2 ? 'gpt-5-codex' : 'gpt-5', effort: n % 2 ? 'high' : 'medium', summary: 'auto', ...(ids ? { turn_id: `turn_${n}` } : {}) });
    push('event_msg', { type: 'token_count', info: null, rate_limits: {} });
    if (n === 2) {
      // Tokens with no assistant output at all (an aborted turn).
      tokens({ input_tokens: 300, cached_input_tokens: 100, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 305 });
      push('event_msg', { type: 'turn_aborted', reason: 'interrupted' });
      continue;
    }
    if (n === 3) {
      // Tokens BEFORE the turn's first assistant item.
      tokens({ input_tokens: 50, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 51 });
    }
    push('response_item', { type: 'reasoning', ...id('rs'), summary: r() < 0.5 ? [{ type: 'summary_text', text: textOf(r, 5) }] : [], encrypted_content: 'gAAAA' });
    const callId = `call_${uuidOf(r).replace(/-/g, '').slice(0, 20)}`;
    push('response_item', { type: 'function_call', ...id('fc'), name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', `ls ${textOf(r, 1)}`] }), call_id: callId });
    push('response_item', { type: 'function_call_output', call_id: callId, output: JSON.stringify({ output: textOf(r, 15), metadata: { exit_code: r() < 0.3 ? 1 : 0, duration_seconds: 0.1 } }) });
    tokens({ input_tokens: 1000 + n, cached_input_tokens: 600, output_tokens: 80, reasoning_output_tokens: 32, total_tokens: 1080 + n });
    // The same running total again (a rate-limit refresh): adds nothing.
    push('event_msg', { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: { input_tokens: 1000 + n, cached_input_tokens: 600, output_tokens: 80, reasoning_output_tokens: 32, total_tokens: 1080 + n }, model_context_window: 200000 } });
    if (ids && n === 4) {
      // The user steers mid-turn and the turn writes a second turn_context with the SAME turn_id.
      push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `steer ${textOf(r, 3)}` }] });
      push('turn_context', { cwd, model: 'gpt-5', effort: 'medium', turn_id: `turn_${n}` });
      push('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: textOf(r, 3) }], encrypted_content: 'gAAAA' });
      tokens({ input_tokens: 70, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 77 });
    }
    push('response_item', { type: 'message', role: 'assistant', ...id('msg'), content: [{ type: 'output_text', text: textOf(r, 11) }] });
    tokens({ input_tokens: 200, cached_input_tokens: 150, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 240 });
    push('event_msg', { type: 'agent_message', message: 'dup of the answer' });
    if (ids) push('event_msg', { type: 'task_complete', turn_id: `turn_${n}`, last_agent_message: 'done' });
  }
  return { sid, start, lines };
}

// The record-type sequence of a live Codex 0.160.0 rollout (two turns, 38 records), with generated
// content. The working directory is a neutral path, not a home directory.
function codexLiveRollout({ seed = 3, start = Date.UTC(2026, 9, 14, 12, 18, 49), cwd = '/work/primes' } = {}) {
  const r = rng(seed);
  const sid = uuidOf(r);
  let t = start;
  const lines = [];
  const at = (s = 1) => { t += Math.floor(200 + r() * s * 1000); return iso(t); };
  const push = (type, payload) => lines.push(JSON.stringify({ timestamp: at(), type, payload }));
  const usage = (i, o) => ({ input_tokens: i, cached_input_tokens: Math.floor(i / 2), cache_write_input_tokens: 0, output_tokens: o, reasoning_output_tokens: Math.floor(o / 3), total_tokens: i + o });
  const total = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const tokenCount = (u) => { for (const k of Object.keys(total)) total[k] += u[k]; push('event_msg', { type: 'token_count', info: { total_token_usage: { ...total }, last_token_usage: u, model_context_window: 200000 }, rate_limits: null }); };
  const tur = (turn, u) => lines.push(JSON.stringify({ timestamp: at(), type: 'token_usage_record', payload: { session_id: sid, thread_id: sid, turn_id: turn, root_turn_id: turn, response_id: `resp_${uuidOf(r)}`, usage: u, turn_token_usage: u, thread_token_usage: { ...total } } }));
  const ic = (turn, item) => push('event_msg', { type: 'item_completed', thread_id: sid, turn_id: turn, item, started_at_ms: t, completed_at_ms: t + 5 });
  const id = (p) => `${p}_${uuidOf(r).replace(/-/g, '').slice(0, 24)}`;
  push('session_meta', { id: sid, timestamp: iso(t), cwd, originator: 'codex_exec', cli_version: '0.160.0', instructions: textOf(r, 20), model_provider: 'router' });
  const turnOf = (n, first) => {
    const turn = uuidOf(r);
    push('event_msg', { type: 'task_started', turn_id: turn, model_context_window: 200000 });
    if (first) {
      push('response_item', { type: 'message', role: 'developer', id: id('msg'), content: [{ type: 'input_text', text: `<permissions> ${textOf(r, 5)}` }, { type: 'input_text', text: `<skills> ${textOf(r, 5)}` }] });
      push('response_item', { type: 'message', role: 'user', id: id('msg'), content: [{ type: 'input_text', text: `<environment_context>${textOf(r, 4)}</environment_context>` }] });
      lines.push(JSON.stringify({ timestamp: at(), type: 'world_state', payload: { cwd, files: textOf(r, 6) } }));
    }
    push('turn_context', { turn_id: turn, cwd, model: 'toy-model-a', effort: 'medium', approval_policy: 'never', sandbox_policy: { type: 'workspace-write' } });
    const prompt = `${textOf(r, 6)} turn ${n}`;
    push('response_item', { type: 'message', role: 'user', id: id('msg'), content: [{ type: 'input_text', text: prompt }] });
    ic(turn, { type: 'UserMessage', id: uuidOf(r), content: [{ type: 'text', text: prompt }] });
    const rs = id('rs');
    ic(turn, { type: 'Reasoning', id: rs, summary_text: [textOf(r, 3)], raw_content: [] });
    push('response_item', { type: 'reasoning', id: rs, summary: [{ type: 'summary_text', text: textOf(r, 5) }], content: null, encrypted_content: null });
    const callId = `call_${uuidOf(r).replace(/-/g, '').slice(0, 24)}`;
    push('response_item', { type: 'function_call', id: `fc_${callId}`, name: 'exec_command', arguments: JSON.stringify({ cmd: `python3 primes.py ${n}` }), call_id: callId });
    const u1 = usage(3000 + n * 7, 400 + n);
    tur(turn, u1);
    ic(turn, { type: 'CommandExecution', id: uuidOf(r), command: `python3 primes.py ${n}`, cwd, aggregated_output: textOf(r, 8), exit_code: 0, duration: 0.2, parsed_cmd: [], process_id: '1', source: 'agent', status: 'completed' });
    push('response_item', { type: 'function_call_output', id: id('fco'), call_id: callId, output: textOf(r, 10) });
    tokenCount(u1);
    const ms = id('msg');
    ic(turn, { type: 'AgentMessage', id: ms, content: [{ type: 'text', text: textOf(r, 4) }] });
    push('response_item', { type: 'message', role: 'assistant', id: ms, content: [{ type: 'output_text', text: textOf(r, 9) }] });
    const u2 = usage(120 + n, 40 + n);
    tur(turn, u2);
    tokenCount(u2);
    push('event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: textOf(r, 3) });
    return turn;
  };
  turnOf(1, true);
  push('event_msg', { type: 'thread_settings_applied', settings: { model: 'toy-model-a' } });
  push('event_msg', { type: 'thread_settings_applied', settings: { model: 'toy-model-a' } });
  turnOf(2, false);
  return { sid, start, lines };
}

// One record per behaviour, written by hand. Three sessions: one in sessions/ with every feature,
// one archived (its only rollout under archived_sessions/), and one whose two rollouts share an id
// (the earlier one archived), so the session stays active.
function features() {
  const ts = (d, s) => iso(Date.UTC(2026, 1, d, 9, 0, s));
  const L = (d, s, type, payload) => JSON.stringify({ timestamp: ts(d, s), type, payload });
  const cwd = '/work/toy-repo';
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  const tc = (tot, last) => ({ type: 'token_count', info: { total_token_usage: tot, ...(last ? { last_token_usage: last } : {}), model_context_window: 200000 }, rate_limits: null });
  const u = (input, cached, output, reasoning) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });

  const sidA = '0c0d0e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
  const a = [
    L(10, 0, 'session_meta', { id: sidA, timestamp: ts(10, 0), cwd, originator: 'codex_cli_rs', cli_version: '0.50.0', git: { branch: 'main' } }),
    // Injected context: developer instructions, AGENTS.md and the environment.
    L(10, 1, 'response_item', { type: 'message', role: 'developer', id: 'msg_dev_1', content: [{ type: 'input_text', text: '<permissions instructions>synthetic sandbox rules</permissions instructions>' }] }),
    L(10, 1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /work/toy-repo\n\n<INSTRUCTIONS>\nsynthetic rules\n</INSTRUCTIONS>' }] }),
    L(10, 1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] }),
    // Turn A: a prompt with an image, encrypted reasoning, a failing shell call.
    L(10, 2, 'event_msg', { type: 'task_started', turn_id: 'turn_a', model_context_window: 200000 }),
    L(10, 2, 'turn_context', { turn_id: 'turn_a', cwd, model: 'gpt-5-codex', effort: 'high', approval_policy: 'on-request' }),
    L(10, 3, 'response_item', { type: 'message', role: 'user', id: 'msg_u_1', content: [{ type: 'input_text', text: 'fix the failing test' }, { type: 'input_image', image_url: `data:image/png;base64,${png}` }] }),
    L(10, 3, 'event_msg', { type: 'user_message', message: 'fix the failing test', images: [] }),
    L(10, 3, 'event_msg', { type: 'token_count', info: null, rate_limits: null }),
    L(10, 4, 'response_item', { type: 'reasoning', id: 'rs_1', summary: [], content: null, encrypted_content: 'gAAAAsyntheticopaquereasoning' }),
    L(10, 5, 'response_item', { type: 'function_call', id: 'fc_1', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }), call_id: 'call_shell_1' }),
    // A non-zero exit code: an error.
    L(10, 6, 'response_item', { type: 'function_call_output', call_id: 'call_shell_1', output: JSON.stringify({ output: '1 failing', metadata: { exit_code: 2, duration_seconds: 0.4 } }) }),
    L(10, 6, 'event_msg', tc(u(1200, 800, 60, 20), u(1200, 800, 60, 20))),
    // Steering: the user types while the turn works; the turn re-sends its context, same id.
    L(10, 7, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'also keep the old behaviour' }] }),
    L(10, 7, 'turn_context', { turn_id: 'turn_a', cwd, model: 'gpt-5-codex', effort: 'high', approval_policy: 'on-request' }),
    // A custom tool call (free-form input), and its output.
    L(10, 8, 'response_item', { type: 'custom_tool_call', id: 'ctc_1', status: 'completed', call_id: 'call_patch_1', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-old\n+new\n*** End Patch\n' }),
    L(10, 9, 'response_item', { type: 'custom_tool_call_output', call_id: 'call_patch_1', output: JSON.stringify({ output: 'Success. Updated src/a.js', metadata: { exit_code: 0 } }) }),
    // A local shell call; its output carries no error flag at all.
    L(10, 10, 'response_item', { type: 'local_shell_call', id: 'lsh_1', call_id: 'call_local_1', status: 'completed', action: { type: 'exec', command: ['git', 'status'], timeout_ms: 1000 } }),
    L(10, 11, 'response_item', { type: 'function_call_output', call_id: 'call_local_1', output: 'nothing to commit' }),
    // A web search: no call_id, so '@<message_id>:0'.
    L(10, 12, 'response_item', { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'node test runner flags' } }),
    L(10, 13, 'response_item', { type: 'message', role: 'assistant', id: 'msg_a_1', content: [{ type: 'output_text', text: 'patched src/a.js; the test passes' }] }),
    L(10, 13, 'event_msg', { type: 'agent_message', message: 'patched src/a.js; the test passes' }),
    L(10, 13, 'event_msg', tc(u(1500, 1000, 90, 25), u(300, 200, 30, 5))),
    // The same running total again: adds nothing.
    L(10, 14, 'event_msg', tc(u(1500, 1000, 90, 25), u(300, 200, 30, 5))),
    L(10, 14, 'event_msg', { type: 'task_complete', turn_id: 'turn_a', last_agent_message: 'patched' }),
    // Turn B: aborted, with tokens and no assistant output.
    L(10, 20, 'event_msg', { type: 'task_started', turn_id: 'turn_b', model_context_window: 200000 }),
    L(10, 20, 'turn_context', { turn_id: 'turn_b', cwd, model: 'gpt-5-codex', effort: 'low', approval_policy: 'on-request' }),
    L(10, 21, 'response_item', { type: 'message', role: 'user', id: 'msg_u_2', content: [{ type: 'input_text', text: 'now refactor everything' }] }),
    L(10, 22, 'event_msg', tc(u(1900, 1000, 95, 25), u(400, 0, 5, 0))),
    L(10, 23, 'event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    // A compaction.
    L(10, 30, 'compacted', { message: 'Summary: the user fixed a failing test with a patch; a refactor was interrupted.' }),
    // Turn C: a running total only (no last_token_usage), in a subdirectory.
    L(10, 40, 'event_msg', { type: 'task_started', turn_id: 'turn_c', model_context_window: 200000 }),
    L(10, 40, 'turn_context', { turn_id: 'turn_c', cwd: `${cwd}/sub`, model: 'gpt-5', effort: 'medium', approval_policy: 'on-request' }),
    L(10, 41, 'response_item', { type: 'message', role: 'user', id: 'msg_u_3', content: [{ type: 'input_text', text: 'summarise the change' }] }),
    L(10, 42, 'response_item', { type: 'message', role: 'assistant', id: 'msg_a_3', content: [{ type: 'output_text', text: 'one file changed' }] }),
    L(10, 42, 'event_msg', tc(u(2100, 1100, 110, 25))),
    L(10, 43, 'event_msg', { type: 'task_complete', turn_id: 'turn_c', last_agent_message: 'one file changed' }),
  ];

  const sidB = '1d2e3f40-5a6b-4c7d-9e8f-0a1b2c3d4e5f';
  const b = [
    L(1, 0, 'session_meta', { id: sidB, timestamp: ts(1, 0), cwd: '/work/old-proj', originator: 'codex_exec', cli_version: '0.48.0' }),
    L(1, 1, 'event_msg', { type: 'task_started', turn_id: 'turn_x', model_context_window: 200000 }),
    L(1, 1, 'turn_context', { turn_id: 'turn_x', cwd: '/work/old-proj', model: 'gpt-5', effort: 'minimal', approval_policy: 'never' }),
    L(1, 2, 'response_item', { type: 'message', role: 'user', id: 'msg_x_u', content: [{ type: 'input_text', text: 'print the version' }] }),
    L(1, 3, 'response_item', { type: 'message', role: 'assistant', id: 'msg_x_a', content: [{ type: 'output_text', text: 'version 1.0.0' }] }),
    L(1, 3, 'event_msg', tc(u(500, 0, 12, 0), u(500, 0, 12, 0))),
    L(1, 4, 'event_msg', { type: 'task_complete', turn_id: 'turn_x', last_agent_message: 'version 1.0.0' }),
  ];

  const sidC = '2e3f4051-6b7c-4d8e-8f90-1b2c3d4e5f60';
  const c1 = [
    L(5, 0, 'session_meta', { id: sidC, timestamp: ts(5, 0), cwd: '/work/two-parts', originator: 'codex_cli_rs', cli_version: '0.47.0' }),
    L(5, 1, 'event_msg', { type: 'task_started', turn_id: 'turn_c1', model_context_window: 200000 }),
    L(5, 1, 'turn_context', { turn_id: 'turn_c1', cwd: '/work/two-parts', model: 'gpt-5', effort: 'medium', approval_policy: 'never' }),
    L(5, 2, 'response_item', { type: 'message', role: 'user', id: 'msg_c1_u', content: [{ type: 'input_text', text: 'start the plan' }] }),
    L(5, 3, 'response_item', { type: 'message', role: 'assistant', id: 'msg_c1_a', content: [{ type: 'output_text', text: 'plan started' }] }),
    L(5, 3, 'event_msg', tc(u(700, 100, 20, 0), u(700, 100, 20, 0))),
  ];
  const c2 = [
    L(6, 0, 'session_meta', { id: sidC, timestamp: ts(6, 0), cwd: '/work/two-parts', originator: 'codex_cli_rs', cli_version: '0.49.0' }),
    L(6, 1, 'event_msg', { type: 'task_started', turn_id: 'turn_c2', model_context_window: 200000 }),
    L(6, 1, 'turn_context', { turn_id: 'turn_c2', cwd: '/work/two-parts', model: 'gpt-5-codex', effort: 'medium', approval_policy: 'never' }),
    L(6, 2, 'response_item', { type: 'message', role: 'user', id: 'msg_c2_u', content: [{ type: 'input_text', text: 'finish the plan' }] }),
    L(6, 3, 'response_item', { type: 'message', role: 'assistant', id: 'msg_c2_a', content: [{ type: 'output_text', text: 'plan finished' }] }),
    L(6, 3, 'event_msg', tc(u(900, 600, 30, 10), u(900, 600, 30, 10))),
  ];

  return [
    [rolloutPath(Date.UTC(2026, 1, 10, 9, 0, 0), sidA), a],
    [rolloutPath(Date.UTC(2026, 1, 1, 9, 0, 0), sidB, true), b],
    [rolloutPath(Date.UTC(2026, 1, 5, 9, 0, 0), sidC, true), c1],
    [rolloutPath(Date.UTC(2026, 1, 6, 9, 0, 0), sidC), c2],
  ];
}

function writeCase(name, files) {
  const dir = path.join(HERE, name, 'store');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, lines] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), lines.join('\n') + '\n');
  }
}

const basic = codexSession({ seed: 11, turns: 5, ids: true });
writeCase('basic', [[rolloutPath(basic.start, basic.sid), basic.lines]]);

const noIds = codexSession({ seed: 12, turns: 5, ids: false });
writeCase('no-ids', [[rolloutPath(noIds.start, noIds.sid), noIds.lines]]);

const live = codexLiveRollout();
writeCase('live', [[rolloutPath(live.start, live.sid), live.lines]]);

writeCase('features', features());

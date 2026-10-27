// Writes the Claude Code fixture stores: generated text only, no real transcript content.
//   node fixtures/claude-code/generate.js
// `basic` is shaped by the seeded generator ported from memhouse's fixture generator
// (Apache-2.0): split responses sharing `message.id` with growing usage, tool calls and
// results, a sub-agent file, a compact boundary and a generated title. `features` is written by
// hand, one record per behaviour the adapter claims.

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
const encodeCwd = (cwd) => cwd.replace(/[/.]/g, '-');

function claudeSession({ seed, rounds, start, cwd, subagent }) {
  const r = rng(seed);
  const sid = uuidOf(r);
  let t = start;
  const tick = (s = 7) => { t += Math.floor(1000 + r() * s * 1000); return iso(t); };
  const lines = [];
  let parent = null;
  const push = (o) => { lines.push(JSON.stringify(o)); if (o.uuid) parent = o.uuid; };
  const common = () => ({ parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.9', gitBranch: 'main' });
  const agents = [];
  for (let round = 0; round < rounds; round++) {
    push({ ...common(), type: 'user', uuid: uuidOf(r), timestamp: tick(), message: { role: 'user', content: `${textOf(r, 8)} round ${round}` } });
    const msgId = `msg_${uuidOf(r).replace(/-/g, '').slice(0, 20)}`;
    const model = round % 3 === 2 ? 'claude-sonnet-4-5' : 'claude-opus-4-1';
    const input = 100 + Math.floor(r() * 50);
    const cr = 2000 + round * 100;
    const cw = 30 + round;
    const blocks = [{ type: 'thinking', thinking: textOf(r, 6), signature: 'c2lnbmF0dXJl' }, { type: 'text', text: textOf(r, 10) }];
    const toolIds = [];
    const nTools = 1 + Math.floor(r() * 2);
    for (let i = 0; i < nTools; i++) {
      const id = `toolu_${uuidOf(r).replace(/-/g, '').slice(0, 22)}`;
      toolIds.push(id);
      const isAgent = subagent && round === 1 && i === 0;
      blocks.push({ type: 'tool_use', id, name: isAgent ? 'Agent' : i ? 'Read' : 'Bash',
        input: isAgent ? { description: 'synthetic helper task', subagent_type: 'general-purpose', prompt: textOf(r, 5) } : { command: `echo ${textOf(r, 2)}` } });
    }
    const ts0 = tick(2);
    blocks.forEach((b, i) => {
      const last = i === blocks.length - 1;
      push({ ...common(), type: 'assistant', uuid: uuidOf(r), timestamp: i ? tick(1) : ts0, requestId: `req_${round}`,
        message: { id: msgId, type: 'message', role: 'assistant', model, content: [b], stop_reason: last ? 'tool_use' : null,
          usage: { input_tokens: input, cache_creation_input_tokens: cw, cache_read_input_tokens: cr, output_tokens: last ? 40 + round : 1 + i } } });
    });
    for (const id of toolIds) {
      const isAgent = subagent && round === 1 && id === toolIds[0];
      let content = `${textOf(r, 12)}\nexit 0`;
      if (isAgent) {
        const agentId = `a${uuidOf(r).replace(/-/g, '').slice(0, 16)}`;
        agents.push({ id: agentId, ...claudeAgent({ seed: seed * 31 + round, sid, agentId, start: t, cwd }) });
        content = `${textOf(r, 5)}\nagentId: ${agentId} (for resuming)`;
      }
      push({ ...common(), type: 'user', uuid: uuidOf(r), timestamp: tick(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: r() < 0.2 }] } });
    }
    const msg2 = `msg_${uuidOf(r).replace(/-/g, '').slice(0, 20)}`;
    push({ ...common(), type: 'assistant', uuid: uuidOf(r), timestamp: tick(),
      message: { id: msg2, role: 'assistant', model, content: [{ type: 'text', text: textOf(r, 9) }], stop_reason: 'end_turn',
        usage: { input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: cr + 50, output_tokens: 22 } } });
  }
  push({ ...common(), type: 'system', subtype: 'compact_boundary', uuid: uuidOf(r), timestamp: tick(), content: 'Conversation compacted', level: 'info' });
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: `generated ${textOf(r, 3)}`, sessionId: sid }));
  return { sid, lines, agents };
}

function claudeAgent({ seed, sid, agentId, start, cwd }) {
  const r = rng(seed);
  let t = start;
  const tick = () => { t += Math.floor(500 + r() * 2000); return iso(t); };
  const lines = [];
  let parent = null;
  const push = (o) => { lines.push(JSON.stringify(o)); parent = o.uuid; };
  const common = () => ({ parentUuid: parent, isSidechain: true, agentId, cwd, sessionId: sid, version: '2.1.9' });
  push({ ...common(), type: 'user', uuid: uuidOf(r), timestamp: tick(), message: { role: 'user', content: `sub task: ${textOf(r, 6)}` } });
  for (let i = 0; i < 3; i++) {
    const msgId = `msg_${uuidOf(r).replace(/-/g, '').slice(0, 20)}`;
    push({ ...common(), type: 'assistant', uuid: uuidOf(r), timestamp: tick(),
      message: { id: msgId, role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: textOf(r, 7) }], usage: { input_tokens: 9, cache_creation_input_tokens: 3, cache_read_input_tokens: 400, output_tokens: 11 + i } } });
  }
  return { lines, meta: { agentType: 'general-purpose', spawnDepth: 1 } };
}

// One record per behaviour, written by hand.
function features() {
  const sid = '0f5e1c2a-7b3d-4e8f-a9c1-2d3e4f5a6b7c';
  const cwd = '/work/toy-repo';
  const base = { isSidechain: false, userType: 'external', cwd, sessionId: sid, version: '2.1.9', gitBranch: 'main' };
  const u = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
  const ts = (s) => iso(Date.UTC(2026, 0, 5, 10, 0, s));
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
  const lines = [
    // A prompt, and an injected reminder hidden from the user.
    { ...base, parentUuid: null, type: 'user', uuid: u(1), timestamp: ts(1), message: { role: 'user', content: 'list the files in the toy repo' } },
    { ...base, parentUuid: u(1), type: 'user', uuid: u(2), timestamp: ts(1), isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>synthetic reminder</system-reminder>' }] } },
    // One response over two records: usage grows, one usage record.
    { ...base, parentUuid: u(2), type: 'assistant', uuid: u(3), timestamp: ts(2), message: { id: 'msg_feat_001', role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'thinking', thinking: 'plan the listing', signature: 'c2ln' }], usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 1 } } },
    { ...base, parentUuid: u(3), type: 'assistant', uuid: u(4), timestamp: ts(3), message: { id: 'msg_feat_001', role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'tool_use', id: 'toolu_feat_bash', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'toolu_feat_mcp', name: 'mcp__toyserver__lookup', input: { q: 'readme' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 25 } } },
    // Tool results, and a prompt in the same record: two speakers, two messages.
    { ...base, parentUuid: u(4), type: 'user', uuid: u(5), timestamp: ts(4), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_feat_bash', content: 'README.md\nsrc', is_error: false },
      { type: 'tool_result', tool_use_id: 'toolu_feat_mcp', content: [{ type: 'text', text: 'not found' }], is_error: true },
      { type: 'text', text: 'also show the image' },
    ] } },
    // An image the user attached.
    { ...base, parentUuid: u(5), type: 'user', uuid: u(6), timestamp: ts(5), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
    // The same record appended again, verbatim: folded once.
    { ...base, parentUuid: u(5), type: 'user', uuid: u(6), timestamp: ts(5), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } },
    // A provider error stored as an assistant record.
    { ...base, parentUuid: u(6), type: 'assistant', uuid: u(7), timestamp: ts(6), isApiErrorMessage: true, message: { id: 'msg_feat_err', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }], usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } },
    // A rename by the user.
    { type: 'custom-title', customTitle: 'toy listing', sessionId: sid },
    // A local command notice.
    { ...base, parentUuid: u(7), type: 'system', subtype: 'local_command', uuid: u(8), timestamp: ts(7), content: '<command-name>/status</command-name>', level: 'info' },
    // A rewind: the next prompt hangs off u(1), leaving u(2)…u(8) on an abandoned branch.
    { ...base, parentUuid: u(1), type: 'user', uuid: u(9), timestamp: ts(8), message: { role: 'user', content: 'actually, only count the files' } },
    { ...base, parentUuid: u(9), type: 'assistant', uuid: u(10), timestamp: ts(9), message: { id: 'msg_feat_002', role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text: 'there are two entries' }], stop_reason: 'end_turn', usage: { input_tokens: 12, cache_creation_input_tokens: 4, cache_read_input_tokens: 120, output_tokens: 6 } } },
    // A sidechain record inside the main file, carrying its agent id.
    { ...base, isSidechain: true, agentId: 'afeat0001', parentUuid: null, type: 'user', uuid: u(11), timestamp: ts(10), message: { role: 'user', content: 'sidechain prompt' } },
    // A compaction: the boundary names the last message it replaced, then the summary.
    { ...base, parentUuid: null, logicalParentUuid: u(10), type: 'system', subtype: 'compact_boundary', uuid: u(12), timestamp: ts(11), content: 'Conversation compacted', level: 'info', compactMetadata: { trigger: 'manual', preTokens: 1234 } },
    { ...base, parentUuid: u(12), type: 'user', uuid: u(13), timestamp: ts(11), isCompactSummary: true, message: { role: 'user', content: [{ type: 'text', text: 'Summary: the user asked to list and then count files.' }] } },
    // A response through a gateway that runs a tool itself: the call and a plain `tool_result` in the
    // assistant record, then the reply.
    { ...base, parentUuid: u(13), type: 'assistant', uuid: u(14), timestamp: ts(12), message: { id: 'msg_feat_003', role: 'assistant', model: 'gateway/toy-model', content: [
      { type: 'tool_use', id: 'toolu_feat_gw', name: 'web_search', input: { query: 'toy repo layout' } },
      { type: 'tool_result', tool_use_id: 'toolu_feat_gw', content: [{ type: 'text', text: 'two results for the toy repo' }], is_error: false },
      { type: 'text', text: 'the toy repo holds a README and a src folder' },
    ], stop_reason: 'end_turn', usage: { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 14 } } },
    // Bookkeeping that makes no record.
    { type: 'file-history-snapshot', messageId: u(13), snapshot: { trackedFileBackups: {} } },
  ];
  return { sid, cwd, lines: lines.map((o) => JSON.stringify(o)) };
}

function writeCase(name, files) {
  const dir = path.join(HERE, name, 'store');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

const basic = claudeSession({ seed: 1, rounds: 3, start: Date.UTC(2026, 0, 2, 9, 0, 0), cwd: '/work/proj-alpha', subagent: true });
const bdir = `projects/${encodeCwd('/work/proj-alpha')}`;
writeCase('basic', [
  [`${bdir}/${basic.sid}.jsonl`, basic.lines.join('\n') + '\n'],
  ...basic.agents.flatMap((a) => [
    [`${bdir}/${basic.sid}/subagents/agent-${a.id}.jsonl`, a.lines.join('\n') + '\n'],
    [`${bdir}/${basic.sid}/subagents/agent-${a.id}.meta.json`, JSON.stringify(a.meta) + '\n'],
  ]),
]);

const feat = features();
writeCase('features', [[`projects/${encodeCwd(feat.cwd)}/${feat.sid}.jsonl`, feat.lines.join('\n') + '\n']]);

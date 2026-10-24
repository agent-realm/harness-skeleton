// The protobuf wire format agy stores its rows in, decoded by field number with schemas of only the
// fields this adapter reads. Ported from memhouse's v4 normaliser (its agy
// module: the varint reader, the decoder, the schema table, the enums and the model-name map). The
// field numbers
// were mined from the agy 1.4.4 binary's descriptors (an excerpt kept in the fixture captures,
// synthetic, captured on a test VM); every one used here was checked against that
// excerpt on 2026-10-22.
//
// New here: `project()`, a wire-level projection that keeps only the listed fields of a message, so
// `read` can return a `gen_metadata` row without the prompt it re-stores (25-52 KB a generation).

// A schema maps a field number to [name, type, repeated]. Types: 's' string, 'b' bytes, 'len' the
// byte length only, 'u' unsigned, 'i' signed, 'e' enum, 'bool', 'f' float, 'ts' a Timestamp read as
// epoch milliseconds, or a nested schema. Unknown fields are skipped without decoding.

function toBuf(v) {
  if (v == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  throw new Error('pb: not bytes');
}

// [value, next position]: a Number up to 49 bits, a BigInt beyond.
function varint(buf, p) {
  let n = 0;
  let mul = 1;
  for (let i = 0; i < 7; i++) {
    if (p >= buf.length) throw new Error('pb: truncated varint');
    const b = buf[p++];
    n += (b & 0x7f) * mul;
    if (b < 0x80) return [n, p];
    mul *= 128;
  }
  let big = BigInt(n);
  let shift = 49n;
  for (let i = 7; i < 10; i++) {
    if (p >= buf.length) throw new Error('pb: truncated varint');
    const b = buf[p++];
    big |= BigInt(b & 0x7f) << shift;
    if (b < 0x80) return [BigInt.asUintN(64, big), p];
    shift += 7n;
  }
  throw new Error('pb: varint too long');
}
const unsigned = (v) => (typeof v === 'bigint' ? Number(v) : v);
const signed = (v) => (typeof v === 'bigint' ? Number(BigInt.asIntN(64, v)) : v);
const PACKABLE = new Set(['u', 'i', 'e', 'bool']);
const TS = { 1: ['seconds', 'i'], 2: ['nanos', 'i'] };

// One field: [field number, wire type, value (number | bigint | Buffer), start, end] over `buf`.
function* fields(buf) {
  let p = 0;
  while (p < buf.length) {
    const start = p;
    let key;
    [key, p] = varint(buf, p);
    key = unsigned(key);
    const no = Math.floor(key / 8);
    const wt = key % 8;
    let val;
    if (wt === 0) [val, p] = varint(buf, p);
    else if (wt === 2) {
      let len;
      [len, p] = varint(buf, p);
      len = unsigned(len);
      if (p + len > buf.length) throw new Error('pb: truncated field');
      val = buf.subarray(p, p + len);
      p += len;
    } else if (wt === 1) {
      if (p + 8 > buf.length) throw new Error('pb: truncated');
      val = buf.subarray(p, p + 8);
      p += 8;
    } else if (wt === 5) {
      if (p + 4 > buf.length) throw new Error('pb: truncated');
      val = buf.subarray(p, p + 4);
      p += 4;
    } else throw new Error(`pb: wire type ${wt}`);
    yield [no, wt, val, start, p];
  }
}

function scalar(type, wt, val) {
  switch (type) {
    case 's': return wt === 2 ? val.toString('utf8') : '';
    case 'b': return wt === 2 ? val : null;
    case 'len': return wt === 2 ? val.length : 0;
    case 'u': return wt === 0 ? unsigned(val) : 0;
    case 'i': case 'e': return wt === 0 ? signed(val) : 0;
    case 'bool': return wt === 0 ? unsigned(val) !== 0 : false;
    case 'f': return wt === 5 ? val.readFloatLE(0) : 0;
    case 'ts': {
      if (wt !== 2) return null;
      const t = decode(val, TS);
      return t.seconds > 0 ? t.seconds * 1000 + Math.floor((t.nanos || 0) / 1e6) : null;
    }
    default: return wt === 2 ? decode(val, type) : null;
  }
}

// Decode a protobuf message (bytes, or base64 text) with a schema; it throws on a malformed one.
export function decode(input, schema) {
  const buf = toBuf(input);
  const out = {};
  for (const [no, wt, val] of fields(buf)) {
    const f = schema[no];
    if (!f) continue;
    const [name, type, rep] = f;
    if (rep && wt === 2 && PACKABLE.has(type)) {
      const arr = out[name] || (out[name] = []);
      let q = 0;
      while (q < val.length) {
        let v;
        [v, q] = varint(val, q);
        arr.push(scalar(type, 0, v));
      }
      continue;
    }
    const v = scalar(type, wt, val);
    if (rep) (out[name] || (out[name] = [])).push(v);
    else out[name] = v;
  }
  return out;
}

// Decode, or {} when the bytes are absent or malformed (side rows whose loss costs one field).
export function safeDecode(v, schema) {
  try {
    return v == null ? {} : decode(v, schema);
  } catch {
    return {};
  }
}

function varintBytes(n) {
  let x = BigInt(n);
  const out = [];
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x) b |= 0x80;
    out.push(b);
  } while (x);
  return Buffer.from(out);
}

// Keep only the fields `keep` names: `true` keeps a field's bytes as stored; a nested object keeps
// a length-delimited field's own fields by the same rule, re-framed. Field order is kept. Throws on
// malformed bytes.
export function project(input, keep) {
  const buf = toBuf(input);
  const out = [];
  for (const [no, wt, val, start, end] of fields(buf)) {
    const k = keep[no];
    if (!k) continue;
    if (k === true || wt !== 2) out.push(buf.subarray(start, end));
    else {
      const inner = project(val, k);
      out.push(varintBytes(no * 8 + 2), varintBytes(inner.length), inner);
    }
  }
  return Buffer.concat(out);
}

// Field numbers from the agy 1.4.4 descriptors. Only the fields this adapter reads.
export const S = {};
S.ChatToolCall = { 1: ['id', 's'], 2: ['name', 's'], 3: ['arguments_json', 's'] }; // 7 thinking_signature: never read
S.Usage = {
  1: ['model', 'e'], 2: ['input_tokens', 'u'], 3: ['output_tokens', 'u'], 4: ['cache_write_tokens', 'u'],
  5: ['cache_read_tokens', 'u'], 9: ['thinking_output_tokens', 'u'], 10: ['response_output_tokens', 'u'], 11: ['response_id', 's'],
};
S.StepInfo = { 1: ['trajectory_id', 's'], 2: ['step_index', 'u'], 3: ['metadata_index', 'u'], 4: ['cascade_id', 's'] };
S.RetryInfo = { 2: ['usage', S.Usage] };
S.ModelOrAlias = { 1: ['model', 'e'] };
S.Meta = {
  1: ['created_at', 'ts'], 3: ['source', 'e'], 4: ['tool_call', S.ChatToolCall], 8: ['completed_at', 'ts'],
  9: ['model_usage', S.Usage], 10: ['model_cost', 'f'], 11: ['generator_model', 'e'], 12: ['execution_id', 's'], 13: ['requested_model', S.ModelOrAlias],
  20: ['source_trajectory_step_info', S.StepInfo], 28: ['retry_infos', S.RetryInfo, true], 35: ['model_api_content_id', 's'],
};
S.ImageData = { 1: ['base64_data', 's'], 2: ['mime_type', 's'], 4: ['uri', 's'] };
S.Media = { 1: ['mime_type', 's'], 2: ['inline_data', 'b'], 5: ['uri', 's'], 9: ['display_name', 's'] };
S.TextOrScopeItem = { 1: ['text', 's'] };
S.UserInput = { 1: ['query', 's'], 2: ['user_response', 's'], 3: ['items', S.TextOrScopeItem, true], 5: ['images', S.ImageData, true], 9: ['media', S.Media, true] };
S.Planner = {
  1: ['response', 's'], 3: ['thinking', 's'], 4: ['signature_len', 'len'], 5: ['thinking_redacted', 'bool'],
  6: ['message_id', 's'], 7: ['tool_calls', S.ChatToolCall, true], 8: ['modified_response', 's'], 14: ['thinking_signature_len', 'len'],
};
S.Checkpoint = {
  1: ['checkpoint_index', 'u'], 3: ['included_step_indices', 'u', true], 5: ['session_summary', 's'],
  11: ['included_step_index_start', 'u'], 12: ['included_step_index_end', 'u'],
};
S.ErrorDetails = { 1: ['user_error_message', 's'], 2: ['short_error', 's'], 3: ['full_error', 's'], 9: ['model_error_message', 's'] };
S.Ephemeral = { 1: ['content', 's'], 2: ['media', S.Media, true] };
S.ToolSource = { 1: ['conversation_id', 's'], 2: ['step_index', 'i'], 3: ['tool_call', S.ChatToolCall] };
S.SourceMetadata = { 1: ['tool', S.ToolSource] };
S.AgentMessage = { 1: ['id', 's'], 2: ['recipient', 's'], 3: ['sender', 's'], 4: ['content', 's'], 11: ['hide_from_user', 'bool'], 12: ['source_metadata', S.SourceMetadata] };
S.Any = { 1: ['type_url', 's'], 2: ['value', 'b'] };
S.RenderInfo = { 4: ['hidden', 'bool'] };
S.McpServerTool = { 1: ['name', 's'], 2: ['server_name', 's'] }; // genai.McpServerToolCallStep / ResultStep
S.ToolCallStep = { 6: ['mcp_server_tool_call', S.McpServerTool] };
S.ToolResultStep = { 7: ['mcp_server_tool_result', S.McpServerTool] };
S.GenericResult = {
  1: ['result', 's'], 3: ['step_render_info', S.RenderInfo], 4: ['media', S.Media, true], 6: ['payload', S.Any], 7: ['full_output_uri', 's'],
  8: ['tool_call_step', S.ToolCallStep], 9: ['tool_result_step', S.ToolResultStep],
};
// Tool payloads (google.protobuf.Any in GenericStepResult.payload).
S.RunCommand = { 1: ['exit_code', 'i'], 2: ['timed_out', 'bool'], 8: ['exit_code_unknown', 'bool'] };
S.SubagentResult = { 1: ['conversation_id', 's'] };
S.InvokeSubagent = { 2: ['results', S.SubagentResult, true] };
S.SystemMessage = { 1: ['message', 's'], 2: ['render_info', S.RenderInfo], 3: ['event_type', 's'], 4: ['agent_message', S.AgentMessage], 6: ['media', S.Media, true] };
S.Generic = { 2: ['result', S.GenericResult] };
S.TaskDetails = { 1: ['id', 's'], 4: ['description', 's'], 7: ['title', 's'] };
S.McpTool = { 1: ['server_name', 's'] }; // CortexStepMcpTool, as a nested legacy step (source-only)
S.Step = {
  1: ['type', 'e'], 4: ['status', 'e'], 5: ['metadata', S.Meta], 19: ['user_input', S.UserInput],
  20: ['planner_response', S.Planner], 30: ['checkpoint', S.Checkpoint], 31: ['error', S.ErrorDetails],
  47: ['mcp_tool', S.McpTool], 103: ['ephemeral_message', S.Ephemeral], 114: ['system_message', S.SystemMessage],
  140: ['generic', S.Generic], 148: ['task_details', S.TaskDetails],
};
S.ChatModel = { 3: ['model', 'e'], 4: ['usage', S.Usage], 5: ['model_cost', 'f'], 13: ['credit_cost', 'i'], 19: ['response_model', 's'], 21: ['model_display_name', 's'] };
S.GenMeta = { 1: ['chat_model', S.ChatModel], 2: ['step_indices', 'u', true], 4: ['execution_id', 's'] };
S.ExecMeta = { 1: ['termination_reason', 'e'], 3: ['last_step_idx', 'i'], 9: ['execution_id', 's'] };
S.Workspace = { 1: ['workspace_folder_absolute_uri', 's'], 2: ['git_root_absolute_uri', 's'], 4: ['branch_name', 's'] };
S.TrajMeta = {
  1: ['workspaces', S.Workspace, true], 2: ['created_at', 'ts'], 5: ['parent_conversation_id', 's'],
  6: ['root_conversation_id', 's'], 7: ['workspace_uris', 's', true], 17: ['nesting_depth', 'i'], 18: ['project_id', 's'],
};
S.TrajRef = { 1: ['trajectory_id', 's'], 2: ['step_index', 'i'], 3: ['trajectory_type', 'e'], 4: ['step_type', 'e'], 5: ['reference_type', 'e'], 6: ['conversation_id', 's'] };

// What `read` keeps of a gen_metadata blob: the fields derive reads (S.GenMeta, S.ChatModel and the
// usage counters of S.Usage). The prompt, tools and context breakdown it re-stores are dropped.
const USAGE_KEEP = { 1: true, 2: true, 3: true, 4: true, 5: true, 9: true, 11: true };
export const GEN_KEEP = { 1: { 3: true, 4: USAGE_KEEP, 5: true, 13: true, 19: true, 21: true }, 2: true, 4: true };

// Store enums (spec §3; the 1.4.4 descriptors).
export const T = { USER_INPUT: 14, PLANNER_RESPONSE: 15, GENERIC: 132, SYSTEM_MESSAGE: 101, EPHEMERAL_MESSAGE: 90, CHECKPOINT: 23 };
export const ST = { PENDING: 1, RUNNING: 2, DONE: 3, CANCELED: 6, ERROR: 7, GENERATING: 8, WAITING: 9, QUEUED: 11, INTERRUPTED: 12 };
export const OPEN = new Set([ST.PENDING, ST.RUNNING, ST.GENERATING, ST.WAITING, ST.QUEUED]);
export const REF_FORK = 2; // CortexTrajectoryReferenceType FORK
export const SRC = { SYSTEM: 5, SYSTEM_SDK: 6 }; // CortexStepSource

// exa.codeium_common_pb.Model: 1000-2650 are MODEL_PLACEHOLDER_M<n-1000> (checked against the 1.4.4
// enum). The name is kept verbatim; effort is folded into it and left unparsed.
export function modelName(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1000 && n <= 2650) return `MODEL_PLACEHOLDER_M${n - 1000}`;
  return `model_enum:${n}`;
}

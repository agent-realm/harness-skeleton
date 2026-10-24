# @agent-realm/scripted-model

A model endpoint that answers from a script, for deterministic harness tests. A test points a
harness at it like any API gateway. The harness then gets exactly the replies the script
gives: text, reasoning, tool calls, usage numbers, errors, stalls, hangs. No model and no network
are involved, and no credential is needed.

Used by hs's tier 1 checks (`conformance/lib/bench.mjs`, `model()`), by the reference harness's
tests, and by gentar scenarios, which start the command in a setup step (design note
[`reference-harness-2026-10-23.md`](../../docs/design/reference-harness-2026-10-23.md) §5, §9.4).

## Rules

- **Loopback only.** It listens on `127.0.0.1` and nowhere else. It has no token, so on a shared
  bench loopback is what keeps another process from driving a run.
- **Names only.** Each request is recorded by names only:
  - the wire, the path and the model;
  - whether it asked for a stream;
  - the kind of credential;
  - the names of the tools offered (a name that is not a string is recorded as null) and the
    call ids of the tool results returned;
  - which of the script's markers appear (in one of the body's decoded strings, or a header);
  - which step answered.

  A prompt, a tool's output and a credential's value are never recorded. A check that needs
  to know what a harness sent passes `inspect`, its own look at each request, and keeps what it
  chooses.
- **No dependencies.** Node.js 22 or later, builtins only; a test holds the package to that.
- **No size cap.** A request body is read whole before it is answered. That suits a test tool on
  loopback; do not put the model where an untrusted client can reach it.

## The wires

| Route | Wire | Streamed (`"stream": true`) | Whole |
|---|---|---|---|
| `POST /v1/messages` | Anthropic Messages | `message_start`, a `content_block_start` / `_delta` / `_stop` run per part, `message_delta` with the stop reason and output tokens, `message_stop` | one `message` |
| `POST /v1/chat/completions` | OpenAI Chat Completions | `chat.completion.chunk`s: role, `reasoning_content`, `content`, `tool_calls`, the finish reason, then a usage chunk with no choices, then `[DONE]` | one `chat.completion` |
| `POST /v1/responses` | OpenAI Responses | `response.created`, `response.in_progress`, then per part `response.output_item.added`, its text, summary or arguments as a delta and a done (`response.output_text.*` within a content part, `response.reasoning_summary_text.*` within a summary part, `response.function_call_arguments.*`), and `response.output_item.done`; then `response.completed` with usage. Every event carries a `sequence_number` | one `response` |

The parts, in this order in every wire:
- **Reasoning:** Anthropic `thinking` with a signature, or `redacted_thinking` when opaque. Chat
  `reasoning_content`. Responses `reasoning` with a summary, or with `encrypted_content` when
  opaque.
- **Text.**
- **Tool calls:** Anthropic `tool_use`, with its input sent as `input_json_delta`. Chat
  `tool_calls`. Responses `function_call`.

A reply with tool calls stops as a tool use (`tool_use`, `tool_calls`); any other stops as the
end of the turn. Any other method or path gets 404. A request whose body is not JSON gets 400.

## The script

```js
import { scriptedModel } from '@agent-realm/scripted-model';

const m = await scriptedModel({
  steps: [
    { when: { turn: 1 }, reply: { tool_calls: [{ id: 'call_1', name: 'exec_command', args: { cmd: 'ls' } }] } },
    { when: { after_tool: 'call_1' }, reply: { text: 'done', usage: { input: 120, output: 4 } } },
  ],
  markers: ['MY-MARKER'],
});
// point the harness at m.url (a base URL such as `${m.url}/v1`) ...
m.seen;      // one record per request, names only
m.unused();  // the steps no request used
await m.close();
```

- **`steps`:** `[{ when, reply }]`. A request takes the first unused step whose `when` fits,
  and each step answers once. Every field of `when` is optional, and all the fields given must
  hold:
  - `turn`: the request's position among the requests to a wire, from 1;
  - `wire`: `anthropic`, `chat` or `responses`;
  - `after_tool`: the request returns the result of the call with this id;
  - `marker`: one of the body's strings, decoded, holds this string (so a marker may hold a
    newline, a quote or a backslash), or a header does;
  - `tool`: the request offers a tool with this name.
- **`fallback`:** a reply for a request no step fits, used any number of times. Without one,
  such a request gets 400 in the wire's error shape, as from an endpoint that is not a model.
- **`reply`:** any of these:
  - `text`;
  - `reasoning`: `{ text }`, or `{ opaque: true }`;
  - `tool_calls`: `[{ id, name, args }]`;
  - `usage`: `{ input, output, cache_read, cache_write, reasoning }`, the wire's own numbers,
    sent as given and never converted. Each wire carries the fields it has: Anthropic has no
    reasoning count, and Chat and Responses have no cache-write count;
  - `error`: `{ status, message, retry_after }`, sent in the wire's error shape, with a
    `retry-after` header when given. `status` is from 400 to 599, and `retry_after` a whole
    number of seconds;
  - `stall_ms`: wait this many milliseconds, then answer;
  - `hang`: never answer, so the client's own timeout ends the request.

  A script is checked whole when it loads: a reply that could not be sent (a status outside 400
  to 599, a `retry_after` that is not a number, `args` that are not JSON) is refused there, not
  at the request it fits. A reply that still fails while it is sent (an `onSeen` or `inspect`
  that throws, a `--seen` the command cannot write) gets 500 in the wire's error shape, naming
  what failed, and its record carries `failed: true`. The model keeps serving.
- **`markers`:** strings whose presence each record notes, looked for as `marker` is.
- **`credentials`:** `{ '<dummy value>': '<label>' }`. A request's credential is recorded as its
  kind and label (`bearer:<label>`, `x-api-key:other`), never its value. Only the object's own
  keys are labels, so a credential such as `constructor` records as `other`.
- **`clock`:** `() => milliseconds`, for the timestamps a wire carries (Chat's `created`,
  Responses' `created_at`). The default is `Date.now`.
- **`port`:** an integer, 0 (any free port) when not given. Anything else is refused, and the
  host is always `127.0.0.1`.
- **`onSeen(record)`:** called with each record as it is made.
- **`inspect(body, record)`:** the caller's own look at each request's parsed body.

`m.load({ steps, fallback })` replaces the script between runs: the turn count starts again and
every step is unused. The records stay; clear them with `m.seen.length = 0`.

## The command

For a setup step that starts the model detached:

```sh
rm -f port
scripted-model --script script.json --port-file port --seen seen.jsonl &
until [ -s port ]; do sleep 0.1; done
```

- **`--script`:** the options above as JSON (`steps`, `fallback`, `markers`, `credentials`).
- **`--port-file`:** written once the model is listening. The number is written whole, then
  renamed into place, so a reader never sees half of it. It is removed on any exit Node runs (a
  signal, an error); only SIGKILL leaves it. A port file that already exists is refused (exit 2),
  since a readiness check polling for it would read the old port: remove it before starting, as
  above, or use a fresh path per run.
- **`--seen`:** each record is appended as one JSON line.
- **`--port`:** a fixed port instead of a free one.

It serves until SIGTERM or SIGINT, then exits 0. A bad argument, a script the model refuses, or a
port it cannot take exits 2, before any port file is written.

## Tests

`npm test` in this directory, or from the repository root. The tests start the model on
loopback and talk to it with `fetch`; they reach no network.

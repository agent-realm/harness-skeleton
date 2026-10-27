// Writes the Zed fixture stores as text: for each case, the schema and the statements that build
// `threads/threads.db` and the channels' `db/<channel>/db.sqlite` (conformance/sql-store.js builds
// the databases at test time; no binary file is committed). A thread blob is the thread's compact
// JSON compressed with node:zlib's zstd, as Zed stores it, written `{"$b64": …}`; the readable
// threads are the objects below.
//   node fixtures/zed/generate.js
// - `lab`: a Zed 1.24.3 lab capture of a synthetic session (inventory-cli) and its sub-agent, from
//   the fixture captures (synthetic, captured on a test VM), scrubbed
//   outside this repository (home /home/user, gateway model names). The provider-issued tool call
//   ids (`chatcmpl-tool-…`) are replaced by synthetic ones of the same length, and so are the User
//   message ids; the thread ids and the cited User id are re-minted too (the lab cases describe them; unpublished).
//   The provider label is `gateway`.
// - `features`: written here, one thread per behaviour the adapter claims, ported from memhouse's
//   normaliser tests, in the toy-shop repo: the anchored ids, the tool
//   results and their statuses, the usage, the reasoning kinds, a Mention and an Image, Resume and
//   Compaction (read from Zed's source by memhouse, never captured), a sub-agent spawned by
//   spawn_agent, an open call held, the archive flag in two channels, a plain-JSON blob and a
//   legacy
//   agent-1 thread.
// - `restore`: synthetic, written before a restore was captured: one thread saved in place, a turn
//   appended, then a checkpoint restore and the regrown turn in one save, then a rename. Observed
//   since in `restore-lab`: the restore removes the restored User message and everything after it,
//   and the regrown turn has a new User id. Not as observed: Zed saves the truncation alone, and
//   without moving `updated_at`; here the restore and the regrow share one save that moves it.
//   Not shown either way: whether a surviving turn keeps its `request_token_usage` entry (the
//   capture restored to the first message, and its restore cleared them all).
// - `restore-lab`: a Zed 1.24.3 lab capture (a test VM, 2026-10-22) of a checkpoint restore and a
//   regrow, scrubbed on the VM; read from `restore-lab/capture/*.json`, the three states of the
//   thread row (blob decoded) and its sidebar row: before the restore (11 messages, User ids at 0
//   and 7), after "Restore Checkpoint" on the first User message (0 messages: the restored message
//   goes too; `request_token_usage` cleared; `cumulative_token_usage` and the row's `updated_at`
//   unmoved), and after the regrow (a new User id at 0, Agent messages at 1-3). The ops write the
//   row three times. The provider label is `gateway`, as in `lab`, and the 10 provider-issued
//   tool call ids were re-minted at the same length (`chatcmpl-tool-00000000000a5001`…`a5010`)
//   before
//   the capture was copied in; thread and User ids are Zed's own and stay.
// - `sentinel`: a fake secret on each declared redaction path, and the same value in free text,
//   which stays (sessions-model §4.6).
// The threads schema is the lab capture's schema dump, verbatim. The sidebar schema is the
// one memhouse's normaliser test builds (read from Zed's source; UNVERIFIED against a capture),
// with the WAL mode the captures showed.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const THREADS_REL = 'threads/threads.db';
export const sidebarRel = (channel) => `db/${channel}/db.sqlite`;

export const THREADS_SCHEMA = `CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL,
    data BLOB NOT NULL
, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT);
`;
export const SIDEBAR_SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE sidebar_threads (thread_id BLOB PRIMARY KEY, session_id TEXT, agent_id TEXT, title TEXT NOT NULL, updated_at TEXT NOT NULL, created_at TEXT, folder_paths TEXT, folder_paths_order TEXT, archived INTEGER DEFAULT 0) STRICT;
`;

// ---- the lab capture (scrubbed; ids replaced as above)
// ---------------------------------------------

export const LAB_PARENT = {
  "title": "inventory thread (renamed)",
  "messages": [
    {
      "User": {
        "id": "00000000-0000-4000-8000-0000000000b1",
        "content": [
          {
            "Text": "What does this CLI do? One sentence, no tools."
          }
        ]
      }
    },
    {
      "User": {
        "id": "00000000-0000-4000-8000-0000000000b2",
        "content": [
          {
            "Text": "What does this CLI do? One sentence, no tools."
          }
        ]
      }
    },
    {
      "User": {
        "id": "00000000-0000-4000-8000-0000000000b3",
        "content": [
          {
            "Text": "What does this CLI do? One sentence, no tools."
          }
        ]
      }
    },
    {
      "Agent": {
        "content": [
          {
            "Text": "Synthetic reply 142e4d. synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply tex"
          }
        ],
        "tool_results": {},
        "reasoning_details": null
      }
    },
    {
      "User": {
        "id": "00000000-0000-4000-8000-0000000000b4",
        "content": [
          {
            "Text": "Add a \"count\" command to src/cli.js that prints how many skus exist. Then run in the terminal: node src/cli.js count   and then run: node src/cli.js get B-2 && exit 3"
          }
        ]
      }
    },
    {
      "Agent": {
        "content": [
          {
            "Text": "Synthetic reply dfb99a. synthetic reply text for the toy shop fixture s"
          },
          {
            "ToolUse": {
              "id": "chatcmpl-tool-00000000000a0001",
              "name": "read_file",
              "raw_input": "{\"path\": \"src/cli.js\"}",
              "input": {
                "type": "json",
                "value": {
                  "path": "src/cli.js"
                }
              },
              "is_input_complete": true,
              "thought_signature": null
            }
          }
        ],
        "tool_results": {
          "chatcmpl-tool-00000000000a0001": {
            "tool_use_id": "chatcmpl-tool-00000000000a0001",
            "tool_name": "read_file",
            "is_error": false,
            "content": [
              {
                "Text": "     1\t#!/usr/bin/env node\n     2\t// Synthetic inventory CLI for agent exercises.\n     3\tconst stock = { \"A-1\": 4, \"B-2\": 0 };\n     4\tconst [cmd, sku] = process.argv.slice(2);\n     5\tif (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\n     6\telse if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\n     7\telse console.log(\"usage: inv get <sku>\");\n"
              }
            ],
            "output": {
              "Text": "     1\t#!/usr/bin/env node\n     2\t// Synthetic inventory CLI for agent exercises.\n     3\tconst stock = { \"A-1\": 4, \"B-2\": 0 };\n     4\tconst [cmd, sku] = process.argv.slice(2);\n     5\tif (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\n     6\telse if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\n     7\telse console.log(\"usage: inv get <sku>\");\n"
            }
          }
        },
        "reasoning_details": null
      }
    },
    {
      "Agent": {
        "content": [
          {
            "Text": "Synthetic reply 046b3d. synthetic"
          },
          {
            "ToolUse": {
              "id": "chatcmpl-tool-00000000000a0002",
              "name": "edit_file",
              "raw_input": "{\"path\": \"src/cli.js\", \"edits\": [{\"old_text\": \"else if (cmd === \\\"list\\\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\", \"new_text\": \"else if (cmd === \\\"list\\\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\\nelse if (cmd === \\\"count\\\") console.log(Object.keys(stock).length);\"}]}",
              "input": {
                "type": "json",
                "value": {
                  "path": "src/cli.js",
                  "edits": [
                    {
                      "old_text": "else if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);",
                      "new_text": "else if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\nelse if (cmd === \"count\") console.log(Object.keys(stock).length);"
                    }
                  ]
                }
              },
              "is_input_complete": true,
              "thought_signature": null
            }
          }
        ],
        "tool_results": {
          "chatcmpl-tool-00000000000a0002": {
            "tool_use_id": "chatcmpl-tool-00000000000a0002",
            "tool_name": "edit_file",
            "is_error": false,
            "content": [
              {
                "Text": "Edited src/cli.js successfully"
              }
            ],
            "output": {
              "input_path": "src/cli.js",
              "new_text": "#!/usr/bin/env node\n// Synthetic inventory CLI for agent exercises.\nconst stock = { \"A-1\": 4, \"B-2\": 0 };\nconst [cmd, sku] = process.argv.slice(2);\nif (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\nelse if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\nelse if (cmd === \"count\") console.log(Object.keys(stock).length);\nelse console.log(\"usage: inv get <sku>\");\n",
              "old_text": "#!/usr/bin/env node\n// Synthetic inventory CLI for agent exercises.\nconst stock = { \"A-1\": 4, \"B-2\": 0 };\nconst [cmd, sku] = process.argv.slice(2);\nif (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\nelse if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\nelse console.log(\"usage: inv get <sku>\");\n",
              "diff": "@@ -4,4 +4,5 @@\n const [cmd, sku] = process.argv.slice(2);\n if (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\n else if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\n+else if (cmd === \"count\") console.log(Object.keys(stock).length);\n else console.log(\"usage: inv get <sku>\");\n"
            }
          }
        },
        "reasoning_details": null
      }
    },
    {
      "Agent": {
        "content": [
          {
            "ToolUse": {
              "id": "chatcmpl-tool-00000000000a0003",
              "name": "terminal",
              "raw_input": "{\"command\": \"node src/cli.js count\", \"cd\": \"/home/user/work/inventory-cli\"}",
              "input": {
                "type": "json",
                "value": {
                  "command": "node src/cli.js count",
                  "cd": "/home/user/work/inventory-cli"
                }
              },
              "is_input_complete": true,
              "thought_signature": null
            }
          }
        ],
        "tool_results": {
          "chatcmpl-tool-00000000000a0003": {
            "tool_use_id": "chatcmpl-tool-00000000000a0003",
            "tool_name": "terminal",
            "is_error": false,
            "content": [
              {
                "Text": "Note: this command ran WITHOUT an OS sandbox because one could not be created (`bwrap` is installed but couldn't create a sandbox, likely because unprivileged user namespaces are disabled on this system.).\n\n```\n2\n```"
              }
            ],
            "output": "Note: this command ran WITHOUT an OS sandbox because one could not be created (`bwrap` is installed but couldn't create a sandbox, likely because unprivileged user namespaces are disabled on this system.).\n\n```\n2\n```"
          }
        },
        "reasoning_details": null
      }
    },
    {
      "Agent": {
        "content": [
          {
            "ToolUse": {
              "id": "chatcmpl-tool-00000000000a0004",
              "name": "terminal",
              "raw_input": "{\"command\": \"node src/cli.js get B-2 && exit 3\", \"cd\": \"/home/user/work/inventory-cli\"}",
              "input": {
                "type": "json",
                "value": {
                  "command": "node src/cli.js get B-2 && exit 3",
                  "cd": "/home/user/work/inventory-cli"
                }
              },
              "is_input_complete": true,
              "thought_signature": null
            }
          }
        ],
        "tool_results": {
          "chatcmpl-tool-00000000000a0004": {
            "tool_use_id": "chatcmpl-tool-00000000000a0004",
            "tool_name": "terminal",
            "is_error": false,
            "content": [
              {
                "Text": "Note: this command ran WITHOUT an OS sandbox because the user allowed unsandboxed execution for the rest of this thread.\n\nCommand \"node src/cli.js get B-2 && exit 3\" failed with exit code 3.\n\n```\n0\n```"
              }
            ],
            "output": "Note: this command ran WITHOUT an OS sandbox because the user allowed unsandboxed execution for the rest of this thread.\n\nCommand \"node src/cli.js get B-2 && exit 3\" failed with exit code 3.\n\n```\n0\n```"
          }
        },
        "reasoning_details": null
      }
    },
    {
      "Agent": {
        "content": [
          {
            "Text": "Synthetic reply b18cbe. synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply text for the toy shop fixture synthetic reply t"
          }
        ],
        "tool_results": {},
        "reasoning_details": null
      }
    },
    {
      "User": {
        "id": "00000000-0000-4000-8000-0000000000b5",
        "content": [
          {
            "Text": "Say hello in five words."
          }
        ]
      }
    },
    {
      "Agent": {
        "content": [
          {
            "Text": "Synthetic reply 4c3c5a. s"
          }
        ],
        "tool_results": {},
        "reasoning_details": null
      }
    }
  ],
  "updated_at": "2026-10-19T23:03:14.698339247Z",
  "detailed_summary": null,
  "initial_project_snapshot": {
    "worktree_snapshots": [
      {
        "worktree_path": "/home/user/work/inventory-cli",
        "git_state": {
          "remote_url": null,
          "head_sha": "ffbe68007901e8c59e7dff38ff62f45b5b259ea2",
          "current_branch": "main",
          "diff": "diff --git a/src/cli.js b/src/cli.js\nindex ec719eb..4d3e1dc 100644\n--- a/src/cli.js\n+++ b/src/cli.js\n@@ -3,4 +3,5 @@\n const stock = { \"A-1\": 4, \"B-2\": 0 };\n const [cmd, sku] = process.argv.slice(2);\n if (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\n+else if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\n else console.log(\"usage: inv get <sku>\");\n"
        }
      }
    ],
    "timestamp": "2026-10-19T22:23:11.365759796Z"
  },
  "cumulative_token_usage": {
    "input_tokens": 130477,
    "output_tokens": 1319,
    "cache_read_input_tokens": 73216
  },
  "request_token_usage": {
    "00000000-0000-4000-8000-0000000000b5": {
      "input_tokens": 737,
      "output_tokens": 115,
      "cache_read_input_tokens": 10752
    },
    "00000000-0000-4000-8000-0000000000b4": {
      "input_tokens": 599,
      "output_tokens": 232,
      "cache_read_input_tokens": 10752
    },
    "00000000-0000-4000-8000-0000000000b3": {
      "input_tokens": 10799,
      "output_tokens": 153
    }
  },
  "model": {
    "provider": "gateway",
    "model": "gateway/toy-model-a"
  },
  "profile": "write",
  "subagent_context": null,
  "speed": null,
  "thinking_enabled": false,
  "thinking_effort": null,
  "draft_prompt": null,
  "ui_scroll_position": null,
  "sandboxed_terminal_temp_dir": null,
  "sandbox_grants": {
    "write_paths": [],
    "network_hosts": [],
    "network_any_host": false,
    "allow_fs_write_all": false,
    "unsandboxed": false,
    "sandbox_fallback": true
  },
  "version": "0.3.0"
};

export const LAB_CHILD = {
  "title": "Reading package.json bin name",
  "messages": [
    {
      "User": {
        "id": "1a818d58-2c97-404f-b27b-cfcb27ce7c43",
        "content": [
          {
            "Text": "Read the file /home/user/work/inventory-cli/package.json and report the \"bin\" field's name (the command name the package exposes). Just report the bin name (and its target path if present) in your final message. Do not modify anything."
          }
        ]
      }
    },
    {
      "Agent": {
        "content": [
          {
            "ToolUse": {
              "id": "chatcmpl-tool-00000000000c0001",
              "name": "read_file",
              "raw_input": "{\"path\": \"/home/user/work/inventory-cli/package.json\"}",
              "input": {
                "type": "json",
                "value": {
                  "path": "/home/user/work/inventory-cli/package.json"
                }
              },
              "is_input_complete": true,
              "thought_signature": null
            }
          }
        ],
        "tool_results": {
          "chatcmpl-tool-00000000000c0001": {
            "tool_use_id": "chatcmpl-tool-00000000000c0001",
            "tool_name": "read_file",
            "is_error": false,
            "content": [
              {
                "Text": "     1\t{ \"name\": \"inventory-cli\", \"version\": \"0.0.1\", \"type\": \"module\", \"bin\": { \"inv\": \"src/cli.js\" } }\n"
              }
            ],
            "output": {
              "Text": "     1\t{ \"name\": \"inventory-cli\", \"version\": \"0.0.1\", \"type\": \"module\", \"bin\": { \"inv\": \"src/cli.js\" } }\n"
            }
          }
        },
        "reasoning_details": null
      }
    },
    {
      "Agent": {
        "content": [
          {
            "Text": "Synthetic reply aa68b4. synthetic reply text for the toy shop fixture synthetic"
          }
        ],
        "tool_results": {},
        "reasoning_details": null
      }
    }
  ],
  "updated_at": "2026-10-19T23:01:30.178926971Z",
  "detailed_summary": null,
  "initial_project_snapshot": {
    "worktree_snapshots": [
      {
        "worktree_path": "/home/user/work/inventory-cli",
        "git_state": {
          "remote_url": null,
          "head_sha": "ffbe68007901e8c59e7dff38ff62f45b5b259ea2",
          "current_branch": "main",
          "diff": "diff --git a/src/cli.js b/src/cli.js\nindex ec719eb..f78dc60 100644\n--- a/src/cli.js\n+++ b/src/cli.js\n@@ -3,4 +3,7 @@\n const stock = { \"A-1\": 4, \"B-2\": 0 };\n const [cmd, sku] = process.argv.slice(2);\n if (cmd === \"get\") console.log(stock[sku] ?? \"unknown sku\");\n+else if (cmd === \"list\") for (const [s, qty] of Object.entries(stock)) console.log(`${s} ${qty}`);\n+else if (cmd === \"count\") console.log(Object.keys(stock).length);\n else console.log(\"usage: inv get <sku>\");\n+// end of file\n"
        }
      }
    ],
    "timestamp": "2026-10-19T23:01:21.400504443Z"
  },
  "cumulative_token_usage": {
    "input_tokens": 25684,
    "output_tokens": 98,
    "cache_read_input_tokens": 9216
  },
  "request_token_usage": {
    "1a818d58-2c97-404f-b27b-cfcb27ce7c43": {
      "input_tokens": 710,
      "output_tokens": 53,
      "cache_read_input_tokens": 9216
    }
  },
  "model": {
    "provider": "gateway",
    "model": "gateway/toy-model-a"
  },
  "profile": "write",
  "subagent_context": {
    "parent_thread_id": "89a7f120-e9ac-4ed6-9738-070990d1e4db",
    "depth": 1
  },
  "speed": null,
  "thinking_enabled": false,
  "thinking_effort": null,
  "draft_prompt": null,
  "ui_scroll_position": null,
  "sandboxed_terminal_temp_dir": null,
  "sandbox_grants": {
    "write_paths": [],
    "network_hosts": [],
    "network_any_host": false,
    "allow_fs_write_all": false,
    "unsandboxed": false,
    "sandbox_fallback": false
  },
  "version": "0.3.0"
};

// The lab rows (the capture's threads table): no folder_paths_order was captured.
export const LAB = {
  PARENT: '89a7f120-e9ac-4ed6-9738-070990d1e4db',
  CHILD: '865975e1-85d6-4094-8ebc-a79b4dfe199a',
  CHILD_USER: '1a818d58-2c97-404f-b27b-cfcb27ce7c43',
};
const LAB_ROWS = [
  { id: LAB.PARENT, summary: 'inventory thread (renamed)', updated_at: '2026-10-19T23:03:14.698339247+00:00', parent_id: null, folder_paths: '/home/user/work/inventory-cli', created_at: '2026-10-19T22:23:11.194068463+00:00' },
  { id: LAB.CHILD, summary: 'Reading package.json bin name', updated_at: '2026-10-19T23:01:30.178926971+00:00', parent_id: LAB.PARENT, folder_paths: '/home/user/work/inventory-cli', created_at: '2026-10-19T23:01:21.277599864+00:00' },
];

// ---- builders
// -------------------------------------------------------------------------------------

// A thread blob as Zed stores it: compact JSON, zstd ('zstd') or as is ('json').
export const zstdBlob = (t) => ({ $b64: zlib.zstdCompressSync(Buffer.from(JSON.stringify(t), 'utf8')).toString('base64') });
export const jsonBlob = (t) => ({ $b64: Buffer.from(JSON.stringify(t), 'utf8').toString('base64') });

export const say = (s) => ({ Text: s });
export const user = (id, ...content) => ({ User: { id, content: content.map((c) => (typeof c === 'string' ? say(c) : c)) } });
export const agent = (content, results = {}, reasoning = null) => ({ Agent: { content, tool_results: results, reasoning_details: reasoning } });
export const use = (id, name, input, extra = {}) => ({
  ToolUse: { id, name, raw_input: JSON.stringify(input), input: { type: 'json', value: input }, is_input_complete: true, thought_signature: null, ...extra },
});
export const res = (id, name, text, { isError = false, output } = {}) => ({
  [id]: { tool_use_id: id, tool_name: name, is_error: isError, content: [{ Text: text }], output: output === undefined ? { Text: text } : output },
});

export const TOYSHOP = '/home/user/work/toyshop';
// A thread of format 0.3.0, in the lab capture's key order.
export function thread(title, messages, extra = {}) {
  return {
    title,
    messages,
    updated_at: '2026-10-21T09:30:00.000000000Z',
    detailed_summary: null,
    initial_project_snapshot: {
      worktree_snapshots: [{ worktree_path: TOYSHOP, git_state: { remote_url: null, head_sha: '5a1e0000000000000000000000000000000000c0', current_branch: 'main', diff: '' } }],
      timestamp: '2026-10-21T09:00:00.000000000Z',
    },
    cumulative_token_usage: {},
    request_token_usage: {},
    model: { provider: 'gateway', model: 'gateway/toy-model-a' },
    profile: 'write',
    subagent_context: null,
    speed: null,
    thinking_enabled: false,
    thinking_effort: null,
    draft_prompt: null,
    ui_scroll_position: null,
    sandboxed_terminal_temp_dir: null,
    sandbox_grants: { write_paths: [], network_hosts: [], network_any_host: false, allow_fs_write_all: false, unsandboxed: false, sandbox_fallback: false },
    version: '0.3.0',
    ...extra,
  };
}

// The statements of one database.
class Db {
  constructor(schema) {
    this.schema = schema;
    this.ops = [];
  }

  op(sql, params = []) {
    this.ops.push({ sql, params });
  }
}

export const INSERT_THREAD = 'INSERT INTO threads (id, summary, updated_at, data_type, data, parent_id, folder_paths, folder_paths_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
function putThread(db, r, t, { json = false } = {}) {
  db.op(INSERT_THREAD, [r.id, r.summary, r.updated_at, json ? 'json' : 'zstd', json ? jsonBlob(t) : zstdBlob(t),
    r.parent_id ?? null, r.folder_paths ?? null, r.folder_paths_order ?? null, r.created_at ?? null]);
}
export const INSERT_SIDEBAR = 'INSERT INTO sidebar_threads (thread_id, session_id, agent_id, title, updated_at, created_at, folder_paths, folder_paths_order, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)';
// A sidebar row; `thread_id` is a sidebar-local 16-byte key.
function putSidebar(db, n, sid, title, archived) {
  db.op(INSERT_SIDEBAR, [{ $b64: Buffer.from(`5a1e00000000400080000000000000${String(n).padStart(2, '0')}`, 'hex').toString('base64') }, sid, null, title,
    '2026-10-21T09:40:00Z', '2026-10-21T09:00:00Z', TOYSHOP, '0', archived]);
}
const row = (id, summary, extra = {}) => ({
  id, summary, updated_at: '2026-10-21T09:30:00.000000000+00:00', parent_id: null, folder_paths: TOYSHOP, folder_paths_order: '0',
  created_at: '2026-10-21T09:00:00.123456789+00:00', ...extra,
});

// ---- the cases
// ------------------------------------------------------------------------------------

function lab() {
  const db = new Db(THREADS_SCHEMA);
  putThread(db, LAB_ROWS[0], LAB_PARENT);
  putThread(db, LAB_ROWS[1], LAB_CHILD);
  return { [THREADS_REL]: db };
}

// Thread, User and call ids of the features case (synthetic).
const id = (n) => `5a1e0000-0000-4000-8000-0000000000${n}`;
export const T = { CART: id('c1'), NOTES: id('c2'), COMPACT: id('c3'), PARENT: id('c4'), CHILD: id('c5'), HELD: id('c6'), LEGACY: id('c7') };
export const U = {
  U0: id('a0'), U1: id('a1'), U2: id('a2'), U3: id('a3'), U4: id('a4'), U5: id('a5'), U6: id('a6'), U7: id('a7'), U8: id('a8'),
  U9: id('a9'), U10: id('aa'),
};
export const C = {
  READ: 'toolu_toy_000000000000000001', EDIT: 'toolu_toy_000000000000000002', TEST: 'toolu_toy_000000000000000003',
  WAIT: 'toolu_toy_000000000000000004', CLEAN: 'toolu_toy_000000000000000005', SPAWN: 'toolu_toy_000000000000000006',
  LOOK: 'toolu_toy_000000000000000007', RUN: 'toolu_toy_000000000000000008',
};
export const NOTE = 'Note: this command ran WITHOUT an OS sandbox because the user allowed unsandboxed execution for the rest of this thread.';
const TEST_OUT = `${NOTE}\n\nCommand "python3 -m pytest -q && exit 3" failed with exit code 3.\n\n\`\`\`\n3 passed\n\`\`\``;

// Turn 0: a prompt with no reply (the lab repeats one). Turn 1: thinking and a reply. Turn 2: a
// read, an edit, a shell that exits 3 (stored is_error false), then the answer after redacted
// thinking. Turn 3: a call the user cancelled and one they denied.
export function cartThread() {
  return thread('Toy cart qty fix', [
    user(U.U0, 'What does this cart do? One sentence, no tools.'),
    user(U.U1, 'What does this cart do? One sentence, no tools.'),
    agent([{ Thinking: { text: 'Answer from the name alone.', signature: null } }, say('A toy shopping cart: items, qty, totals.')]),
    user(U.U2, 'Fix total_cents to use qty, then run: python3 -m pytest -q && exit 3'),
    agent([say('Reading cart.py first.'), use(C.READ, 'read_file', { path: 'toyshop/cart.py' })],
      res(C.READ, 'read_file', '     1\tdef total_cents(items):\n     2\t    return sum(i.price for i in items)\n')),
    agent([say('Now the fix:'), use(C.EDIT, 'edit_file', { path: 'toyshop/cart.py', edits: [{ old_text: 'i.price', new_text: 'i.price * i.qty' }] })],
      res(C.EDIT, 'edit_file', 'Edited toyshop/cart.py successfully', {
        output: { input_path: 'toyshop/cart.py', old_text: 'return sum(i.price for i in items)', new_text: 'return sum(i.price * i.qty for i in items)', diff: '-    return sum(i.price for i in items)\n+    return sum(i.price * i.qty for i in items)\n' },
      })),
    agent([use(C.TEST, 'terminal', { command: 'python3 -m pytest -q && exit 3', cd: TOYSHOP })], res(C.TEST, 'terminal', TEST_OUT, { output: TEST_OUT })),
    agent([{ RedactedThinking: 'ZW5jcnlwdGVk' }, say('Fixed: total_cents multiplies by qty; the tests pass, then the shell exits 3 as asked.')]),
    user(U.U3, 'Wait 90 s, then clean the build.'),
    agent([use(C.WAIT, 'terminal', { command: 'sleep 90', cd: TOYSHOP }), use(C.CLEAN, 'terminal', { command: 'rm -rf build', cd: TOYSHOP })], {
      ...res(C.WAIT, 'terminal', 'Tool canceled by user', { isError: true, output: null }),
      ...res(C.CLEAN, 'terminal', 'Permission to run tool denied by user', { isError: true, output: null }),
    }),
    agent([say('Stopped: nothing ran.')]),
  ], {
    cumulative_token_usage: { input_tokens: 130477, output_tokens: 1319, cache_creation_input_tokens: 2048, cache_read_input_tokens: 73216 },
    request_token_usage: {
      [U.U0]: { input_tokens: 777, output_tokens: 1 },
      [U.U1]: { input_tokens: 10799, output_tokens: 153 },
      [U.U2]: { input_tokens: 599, output_tokens: 232, cache_read_input_tokens: 10752 },
      [U.U3]: { input_tokens: 812, output_tokens: 40, cache_creation_input_tokens: 2048 },
    },
    thinking_enabled: true,
    thinking_effort: 'high',
  });
}

// The reasoning kinds, and a prompt with a Mention and an Image.
export function notesThread() {
  return thread('Label and notes', [
    user(U.U4, 'Look at this label and the notes file.',
      { Mention: { uri: { File: { abs_path: `${TOYSHOP}/NOTES.md` } }, content: '# Notes\nPrices are in cents.\n' } },
      { Image: { source: Buffer.from('PNG-TOY-LABEL-240x120').toString('base64'), size: { width: 240, height: 120 } } }),
    agent([{ Thinking: { text: '', signature: 'c2lnbmF0dXJl' } }, { RedactedThinking: 'ZGF0YQ==' }, say('Done.')]),
    agent([say('Second.')], {}, [{ type: 'reasoning.text', text: 'Provider-side reasoning.' }]),
    agent([say('Third.')], {}, [{ type: 'reasoning.encrypted', data: 'b3BhcXVl' }]),
    agent([{ Thinking: { text: 'Own thinking.', signature: null } }, say('Fourth.')], {}, [{ type: 'reasoning.text', text: 'Own thinking.' }]),
    agent([say('Fifth.'), { Hologram: { frames: 3 } }]),
  ]);
}

// Resume, the two Compaction kinds and a message kind this adapter does not know.
export function compactThread() {
  return thread('Cart refactor', [
    user(U.U5, 'Refactor cart.py.'),
    agent([say('Step one.')]),
    'Resume',
    agent([say('Step two.')]),
    { Compaction: { Summary: 'Refactored cart.py in two steps.' } },
    user(U.U6, 'Next?'),
    { Compaction: { ProviderNative: { provider: 'openai', items: [{ encrypted_content: 'b3BhcXVl' }] } } },
    { SomethingNew: {} },
    agent([say('Done.')]),
  ]);
}

// A parent whose spawn_agent result names the child thread, and the child.
export function parentThread() {
  const out = { session_id: T.CHILD, output: 'cart.py, test_cart.py', session_info: {} };
  return thread('Files via a sub-agent', [
    user(U.U7, 'Use a sub-agent to list the files.'),
    agent([use(C.SPAWN, 'spawn_agent', { label: 'list files', message: 'List the files in toyshop/.' })],
      res(C.SPAWN, 'spawn_agent', JSON.stringify({ session_id: T.CHILD, output: 'cart.py, test_cart.py' }), { output: out })),
    agent([say('Two files.')]),
  ]);
}
export function childThread() {
  return thread('List toyshop files', [
    user(U.U8, 'List the files in toyshop/.'),
    agent([say('cart.py, test_cart.py')]),
  ], { subagent_context: { parent_thread_id: T.PARENT, depth: 1 } });
}

// An earlier turn whose call never got a result (interrupted), and a last turn still running one.
export function heldThread({ done = false } = {}) {
  return thread('Run the tests', [
    user(U.U9, 'Read cart.py.'),
    agent([say('Reading.'), use(C.LOOK, 'read_file', { path: 'toyshop/cart.py' })]),
    user(U.U10, 'Never mind. Now run the tests.'),
    agent([say('Running the tests.'), use(C.RUN, 'terminal', { command: 'python3 -m pytest -q', cd: TOYSHOP })],
      done ? res(C.RUN, 'terminal', '```\n3 passed\n```', { output: '```\n3 passed\n```' }) : {}),
    ...(done ? [agent([say('3 passed.')])] : []),
  ], {
    request_token_usage: {
      [U.U9]: { input_tokens: 500, output_tokens: 20 },
      [U.U10]: done ? { input_tokens: 700, output_tokens: 12 } : { input_tokens: 620, output_tokens: 31 },
    },
  });
}

// An agent-1 thread (format 0.2.0): Zed upgrades it when it next saves it; never listed until then.
export const LEGACY_THREAD = {
  version: '0.2.0', summary: 'An old thread', updated_at: '2025-06-01T00:00:00Z',
  messages: [{ id: 0, role: 'user', segments: [{ type: 'text', text: 'Hi.' }] }, { id: 1, role: 'assistant', segments: [{ type: 'text', text: 'Hello.' }] }],
};

function features() {
  const db = new Db(THREADS_SCHEMA);
  putThread(db, row(T.CART, 'Toy cart qty fix (renamed)', { folder_paths: '/home/user/work/a-lib\n/home/user/work/toyshop', folder_paths_order: '1,0' }), cartThread());
  putThread(db, row(T.NOTES, 'Label and notes'), notesThread(), { json: true });
  putThread(db, row(T.COMPACT, 'Cart refactor'), compactThread());
  putThread(db, row(T.PARENT, 'Files via a sub-agent'), parentThread());
  putThread(db, row(T.CHILD, 'List toyshop files', { parent_id: T.PARENT, created_at: '2026-10-21T09:05:00.000000000+00:00' }), childThread());
  putThread(db, row(T.HELD, 'Run the tests'), heldThread());
  putThread(db, row(T.LEGACY, 'An old thread', { folder_paths: null, folder_paths_order: null, created_at: null }), LEGACY_THREAD);
  // The archive flag: CART archived in the stable channel's sidebar, not in the preview one; a
  // draft row names no thread.
  const stable = new Db(SIDEBAR_SCHEMA);
  putSidebar(stable, 1, T.CART, 'Toy cart qty fix (renamed)', 1);
  putSidebar(stable, 2, T.NOTES, 'Label and notes', 0);
  putSidebar(stable, 3, null, '', 0);
  const preview = new Db(SIDEBAR_SCHEMA);
  putSidebar(preview, 4, T.CART, 'Toy cart qty fix (renamed)', 0);
  return { [THREADS_REL]: db, [sidebarRel('0-stable')]: stable, [sidebarRel('0-preview')]: preview };
}

// One thread saved in place (synthetic): v1, then a turn appended (v2), then a checkpoint restore
// on
// R2 with the turn regrown under a new User id (v3), then a rename. R2 goes with the restore, as
// `restore-lab` observed; v3 folds the restore and the regrow into one save that moves
// `updated_at`, where Zed saves the truncation alone and leaves `updated_at` (restore-lab). R1's
// `request_token_usage` entry surviving the restore is assumed, not observed.
export const R = { ID: id('d1'), R1: id('e1'), R2: id('e2'), R3: id('e3'), R4: id('e4'), C1: 'toolu_toy_000000000000000011', C2: 'toolu_toy_000000000000000012' };
export function restoreThread(v) {
  const t1 = [user(R.R1, 'Name the cart module.'), agent([say('toyshop/cart.py.')])];
  const t2 = [
    user(R.R2, 'Add a qty check.'),
    agent([say('Reading.'), use(R.C1, 'read_file', { path: 'toyshop/cart.py' })], res(R.C1, 'read_file', '     1\tdef total_cents(items):\n')),
    agent([say('Added the check.')]),
  ];
  const t3 = [
    user(R.R3, 'Now run the tests.'),
    agent([use(R.C2, 'terminal', { command: 'python3 -m pytest -q', cd: TOYSHOP })], res(R.C2, 'terminal', '```\n4 passed\n```', { output: '```\n4 passed\n```' })),
    agent([say('4 passed.')]),
  ];
  const regrown = [user(R.R4, 'Add a qty check, with a test.'), agent([say('Added the check and a test.')])];
  const rtu = { [R.R1]: { input_tokens: 400, output_tokens: 9 }, [R.R2]: { input_tokens: 520, output_tokens: 14 } };
  if (v === 1) return thread('Cart qty check', [...t1, ...t2], { request_token_usage: rtu });
  if (v === 2) return thread('Cart qty check', [...t1, ...t2, ...t3], { request_token_usage: { ...rtu, [R.R3]: { input_tokens: 610, output_tokens: 8 } } });
  return thread('Cart qty check', [...t1, ...regrown], { request_token_usage: { [R.R1]: rtu[R.R1], [R.R4]: { input_tokens: 530, output_tokens: 16 } } });
}
export const UPDATE_DATA = 'UPDATE threads SET data = ?, updated_at = ? WHERE id = ?';

function restore() {
  const db = new Db(THREADS_SCHEMA);
  putThread(db, row(R.ID, 'Cart qty check'), restoreThread(1));
  db.op(UPDATE_DATA, [zstdBlob(restoreThread(2)), '2026-10-21T09:40:00.000000000+00:00', R.ID]);
  db.op(UPDATE_DATA, [zstdBlob(restoreThread(3)), '2026-10-21T09:50:00.000000000+00:00', R.ID]);
  db.op('UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?', ['Cart qty check (renamed)', '2026-10-21T09:55:00.000000000+00:00', R.ID]);
  return { [THREADS_REL]: db };
}

// The sentinel: on the remote URL, in the diff and in the draft (each a declared path), and in a
// prompt (free text, kept).
export const SENTINEL = 'sentinel-0a1b2c3d4e5f-not-a-secret';
export const S = { ID: id('f1'), U1: id('f2') };
export function sentinelThread() {
  return thread('Sentinel', [user(S.U1, `Remember this value for later: ${SENTINEL}`), agent([say('Noted.')])], {
    initial_project_snapshot: {
      worktree_snapshots: [{
        worktree_path: TOYSHOP,
        git_state: { remote_url: `https://toy:${SENTINEL}@example.com/toyshop.git`, head_sha: '5a1e0000000000000000000000000000000000c0', current_branch: 'main', diff: `diff --git a/.env b/.env\n+TOY_TOKEN=${SENTINEL}\n` },
      }],
      timestamp: '2026-10-21T09:00:00.000000000Z',
    },
    draft_prompt: [{ type: 'text', text: `use ${SENTINEL} next` }],
  });
}
function sentinel() {
  const db = new Db(THREADS_SCHEMA);
  putThread(db, row(S.ID, 'Sentinel'), sentinelThread());
  return { [THREADS_REL]: db };
}

// The restore-lab capture: the thread row (its blob decoded) and the sidebar row, per state.
export const RESTORE_LAB_STATES = ['1-before-restore', '2-after-restore', '3-after-regrow'];
export function restoreLabCapture() {
  return RESTORE_LAB_STATES.map((s) => JSON.parse(fs.readFileSync(path.join(HERE, 'restore-lab', 'capture', `${s}.json`), 'utf8')));
}
// The capture's sidebar columns, in its order. Their types beyond the memhouse schema above
// (main_worktree_paths … title_override) are not captured: TEXT, UNVERIFIED.
const LAB_SIDEBAR_COLS = ['thread_id', 'session_id', 'agent_id', 'title', 'updated_at', 'created_at', 'folder_paths', 'folder_paths_order', 'archived',
  'main_worktree_paths', 'main_worktree_paths_order', 'remote_connection', 'interacted_at', 'title_override'];
export const LAB_SIDEBAR_SCHEMA = `PRAGMA journal_mode=WAL;
CREATE TABLE sidebar_threads (thread_id BLOB PRIMARY KEY, session_id TEXT, agent_id TEXT, title TEXT NOT NULL, updated_at TEXT NOT NULL, created_at TEXT, folder_paths TEXT, folder_paths_order TEXT, archived INTEGER DEFAULT 0, main_worktree_paths TEXT, main_worktree_paths_order TEXT, remote_connection TEXT, interacted_at TEXT, title_override TEXT) STRICT;
`;

function restoreLab() {
  const states = restoreLabCapture();
  const db = new Db(THREADS_SCHEMA);
  const [first, ...later] = states.map((s) => s.threads[0]);
  putThread(db, first, first.data);
  // Each later save rewrites the blob in place; `updated_at` as captured (the restore left it).
  for (const t of later) db.op(UPDATE_DATA, [zstdBlob(t.data), t.updated_at, t.id]);
  // The sidebar row: inserted as first captured, then the columns a later state moved.
  const side = new Db(LAB_SIDEBAR_SCHEMA);
  const value = (r, c) => (c === 'thread_id' ? { $b64: Buffer.from(r[c], 'hex').toString('base64') } : r[c]);
  const rows = states.map((s) => s.sidebar_threads[0]);
  side.op(`INSERT INTO sidebar_threads (${LAB_SIDEBAR_COLS.join(', ')}) VALUES (${LAB_SIDEBAR_COLS.map(() => '?').join(', ')})`, LAB_SIDEBAR_COLS.map((c) => value(rows[0], c)));
  for (let i = 1; i < rows.length; i++) {
    const moved = LAB_SIDEBAR_COLS.filter((c) => rows[i][c] !== rows[i - 1][c]);
    if (moved.length) side.op(`UPDATE sidebar_threads SET ${moved.map((c) => `${c} = ?`).join(', ')} WHERE thread_id = ?`, [...moved.map((c) => value(rows[i], c)), value(rows[i], 'thread_id')]);
  }
  return { [THREADS_REL]: db, [sidebarRel('0-stable')]: side };
}

// ---- writing
// --------------------------------------------------------------------------------------

export const CASES = { lab, features, restore, 'restore-lab': restoreLab, sentinel };

function writeCase(name, dbs) {
  const dir = path.join(HERE, name);
  fs.rmSync(path.join(dir, 'store-sql'), { recursive: true, force: true });
  for (const [rel, db] of Object.entries(dbs)) {
    const base = path.join(dir, 'store-sql', rel);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(`${base}.schema.sql`, db.schema);
    fs.writeFileSync(`${base}.ops.jsonl`, db.ops.map((o) => JSON.stringify(o) + '\n').join(''));
  }
  console.log(`zed/${name}: ${Object.values(dbs).reduce((n, d) => n + d.ops.length, 0)} statements`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, build] of Object.entries(CASES)) writeCase(name, build());
}

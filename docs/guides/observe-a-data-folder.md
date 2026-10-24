# Observe a data folder

**Goal:** see what a harness's data folder holds, without changing it.

```sh
node bin/hs.js observe --harness claude-code --folder ~/.claude --state --pretty
node bin/hs.js observe --harness codex --folder ~/.codex --state --pretty
```

What comes back:
- **`store`**: the key that names this folder's sessions: `host` (this machine's id),
  `harness`, and `harness_path` (the folder's real path, every symlink resolved).
- **`inventory.classes`**: every path by class. Each class is listed path by path while it holds
  at most 20 entries, and by totals above that.

  | Class | Holds |
  |---|---|
  | `config` | settings, instructions, skills, plugins, MCP servers |
  | `sessions` | transcripts and their side files |
  | `history` | prompt history, file checkpoints |
  | `credentials` | login stores: listed, never read |
  | `cache`, `runtime`, `logs` | regenerable or transient state |
  | `skeleton` | `hs`'s own records, `.harness-skeleton/` |
  | `unknown` | anything no rule classes; reported, never guessed |

- **`escapes`**: what the harness keeps outside the folder, such as the macOS login keychain.
- **`state`**: the value in effect for each `[state]` item (transcript retention, prompt
  history), with its source: `folder`, `managed`, or `default`.

**With `--cwd <dir>`,** `observe --state` also reads the project and local layers a launch in that
directory would add. A project that sets a shorter retention shows up there.

**Without `--state`,** `observe` reports drift in a Claude Code folder `hs` delivers to: managed
items that differ from what was installed, and entries no ledger owns.

`observe` writes nothing into the folder. On a machine with no readable machine id, it writes
one `host-id` file outside the folder, where the session contracts place it.

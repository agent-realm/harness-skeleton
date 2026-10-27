# Deliver to a folder

**Goal:** write a spec into a data folder, so a bare start of the harness gets it too, and take it
out again cleanly. This is the `materialize` mode: for a folder a tool owns.

![validate and plan write nothing; the user approves the plan with a receipt bound to its digest; apply writes under a lock with a journal, or refuses with a code.](../diagrams/plan-and-receipt.svg)

**1. Plan:**

```sh
node bin/hs.js plan --harness claude-code --folder ./env-1 --layer ./team --local ./local.toml \
  --owner builder > plan.json
```

A plan is data: declarative operations, each with an address (`settings.json#model`,
`skills/notes`, `settings.json#hooks/PreToolUse[hook.guard]`), an action (`create`, `update`,
`reset`, `remove`, `restore`, `clear`), its preconditions and its risks. It also lists:
- `skipped` items, with the reason;
- `launch_only` items, which only a launch carries;
- items that would reduce capture, such as a shorter retention;
- `unverified`: what `hs` could not check.

It writes nothing.

**2. Approve.** The user reads the plan and writes a receipt for its digest, allowing the risky
operations by id:

```json
{"format": "hs-receipt/0.2", "plan_digest": "sha256:…", "allows": ["op-2", "op-4"], "by": "user"}
```

**3. Apply:**

```sh
node bin/hs.js apply --harness claude-code --folder ./env-1 --plan plan.json --receipt receipt.json
```

`apply` works in this order:
1. It derives the plan again and refuses it as `plan_stale` if anything changed.
2. It takes the folder's lock, and refuses as `folder_busy` while another writer holds it.
3. It journals each step, writes by atomic rename, and reads each write back.
4. It records each item in the owner's ledger (`.harness-skeleton/ledger.json`).

JSON files the user also edits, such as `settings.json`, are changed in place: one key, or one
element of an array. Every other byte stays as it was.

**4. Remove:**

```sh
node bin/hs.js remove --harness claude-code --folder ./env-1 --owner builder
```

`remove` takes out one owner's items, only where each is still what was installed, and puts back
what was there before. `--item <id>` removes one item. `plan --prune` plans the removal of the
items a spec no longer has.

**Owners.** Each tool applies under its own `--owner`. An item two owners deliver is counted
twice, and stays until both remove it. An item that is in the folder but in no ledger is refused
as `unowned_conflict`; `--adopt` records it under the applying owner.

**Recover.** If an apply is interrupted, the next one is refused as `recover_first`. Then
`recover` finishes the steps from the journal:

```sh
node bin/hs.js recover --harness claude-code --folder ./env-1
```

**Never written:** `sessions`, `history` and `credentials` paths. A plan step that would touch one
is refused as `state_write_refused`.

See [example 05](../../examples/05-materialize/).

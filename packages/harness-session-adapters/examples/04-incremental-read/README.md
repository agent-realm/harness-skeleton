# 04: read on from a saved position

A consumer does not read a whole store on every pass. It keeps, per source, the position `read`
returned and the generation, plus the derive state, and reads on from there next time.

```sh
node examples/04-incremental-read/incremental-read.js
```

The script plays one Claude Code transcript (fixture `claude-code/features`) back as a harness
writes it, in four passes. Between passes it keeps only a JSON string, as a consumer would keep
its own file or table (never anything in the harness store).

| Pass | The file | `read` says | The consumer |
|---|---|---|---|
| 1 | 8 lines and half of the 9th | `reset`: 8 units; the half line is `held_back` | derives with no state and `complete: true`, saves position, generation 1 and state |
| 2 | the rest appended in place | `appended`: the 9th line whole, then the rest | derives only the new units with the saved state, `complete: false` |
| 3 | unchanged | `unchanged`: no units | derives nothing |
| 4 | rewritten with its first 5 lines, through a new file | `reset`: every unit again | starts generation 2, derives with no state and `complete: true`, tombstones the keys no longer live |

- **A position is opaque.** Store it whole and hand it back. For a stream it holds the device and
  inode, the offset, and hashes of line 1 and of the 64 KiB before the offset, so a same-size
  rewrite of the tail is still seen as a `reset`. The script prints only the offset.
- **`reset` means start again** for that source: a new generation, and the session derived from
  empty state with every unit of every source (sessions §2).
- **Keys that vanish** after a reset, in neither `live` nor `held` any more, are the ones a
  consumer deletes: here the 9 messages and 2 usage records of the lines the rewrite dropped, and
  its 2 lifecycle records, a compaction and a rename. A held key is not deleted: it keeps its last
  written version.

Next: [05-full-pass](../05-full-pass/).

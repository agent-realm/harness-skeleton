# 05: deliver into a folder a tool owns

Under `materialize`, `hs` writes the spec into the data folder itself, so a bare start of the
harness gets it too. Every write goes through a plan and a receipt.

```sh
sh examples/05-materialize/run.sh
```

1. **`plan`** lists declarative operations, each with an address (`settings.json#model`,
   `skills/notes`) and its risks (`runs-code` for the skill). It writes nothing.
2. **The receipt** names the plan's digest and the operations the user allows. A plan made for
   another spec, another folder state or another harness version has another digest.
3. **`apply`** checks that the folder still matches the plan, takes the folder's lock, writes
   by atomic rename, reads each write back, and journals every step. The ledger
   (`.harness-skeleton/ledger.json`) records what the owner `builder` installed.
4. **A second plan** is `unchanged`.
5. **`remove`** takes out the owner's items where they are still what it installed, and gives
   back what was there before. The user's own `theme` key was never touched: `settings.json` is
   edited in place, one key at a time.

`recover` finishes an apply a crash interrupted, from its journal.

Next: [06-processes](../06-processes/).

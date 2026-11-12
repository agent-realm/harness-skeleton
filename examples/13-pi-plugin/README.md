# 13: an Agent Plugins package on pi

pi reads no Agent Plugins package: its own bundle is the pi package. hs translates the package into
one, with a manifest that declares only the package's skills and one extension hs generates to
register its MCP servers. The package is copied whole under `package/`, so anything else in it, such
as `extensions/not-declared.js`, never loads.

```sh
sh examples/13-pi-plugin/run.sh
```

- At launch, the generated package goes into the temp dir and is passed with `-e`.
- Into the folder, the plan writes the package under `hs-run/plugin.notes-kit/` and adds one member
  to `settings.json`'s `packages`. The user's own member stays as it was.
- The server keeps its data in `hs-run/plugin-data/notes-kit/`. `remove` keeps it and says where;
  `remove --purge-data` deletes it as well.

The guide: [`docs/guides/pi.md`](../../docs/guides/pi.md).

# Error codes

An error response is `{"ok": false, "error": {"code", "message", "items", "retryable"}}`.

## Requests

| Code | Means | Do |
|---|---|---|
| `bad_request` | the request or an argument is malformed | fix the request; the message names the argument |
| `protocol_unsupported` | the envelope's `protocol` is not one this adapter speaks | send `hs/0.2` |
| `op_unknown` | no such operation | see [the operations](cli-and-protocol.md#operations) |
| `not_implemented` | the operation or an item kind is defined but not carried by this build | remove the item, or wait for the milestone that carries it |
| `harness_unknown` | no driver and no session adapter for that harness | check `--harness` |
| `platform_unsupported` | the host id cannot be derived on this platform | run on macOS or Linux |
| `internal` | a guard inside `hs` refused | report it, with the message |

## The folder and the harness

| Code | Means | Do |
|---|---|---|
| `folder_missing` | no store at the path given | check `--folder` or `--store` |
| `folder_busy` | another writer holds the folder's lock, or the harness's own | wait, or stop the other writer |
| `version_unsupported` | the harness binary is missing, or its version is outside every range | install a supported version, or pass `--bin` |
| `probe_failed` | running the binary with `--version` failed | check the binary |
| `login_present` | an endpoint launch on a folder that holds a stored login | use a folder with no login |
| `gateway_required` | the harness speaks a wire no endpoint in `local.toml` offers | add an endpoint for that wire, or a gateway that translates |

## Specs

| Code | Means | Do |
|---|---|---|
| `spec_invalid` | `validate` found errors; `plan` and `launch-spec` refuse such a spec | read `items`, each a problem with its code (below) |
| `item_unsupported` | the harness cannot carry an item this way, with the reason | follow the reason: deliver it at launch instead, or change the item |
| `interpolation_refused` | a string the harness would expand holds `${…}` | remove it; secrets go through refs |

Problem codes inside `spec_invalid`:
- **layers:** `layer_unreadable`, `spec_header_missing`, `format_unsupported`,
  `layer_name_duplicate`;
- **items:** `item_malformed`, `skill_malformed`, `skill_name_mismatch`, `skill_name_reserved`;
- **refs:** `ref_unbound`, `ref_undeclared`, `ref_not_reference`;
- **instructions:** `agents_md_import`, `agents_md_comment`;
- **state:** `install_local_misplaced`, `state_value_invalid`, `state_unexpressible`;
- **endpoints:** `endpoint_wire_unknown`.

The design note's §7.1 lists them with their meaning.

## Plans and receipts

| Code | Means | Do |
|---|---|---|
| `receipt_required` | `apply` or `launch-spec` needs a receipt; the items carry the digest and what to allow | write a receipt for that digest |
| `plan_stale` | the plan no longer matches what its arguments give for this folder now | plan again |
| `plan_tampered` | the plan does not match its own digest | plan again; never edit a plan |
| `unowned_conflict` | the spec wants an item that exists in the folder but in no ledger | `--adopt` to take it over, or remove it by hand |
| `owner_conflict` | another owner holds the item at another value | resolve between the owners |
| `state_write_refused` | a step would write a `sessions`, `history` or `credentials` path | nothing to do: such paths are never written |
| `write_refused` | a write handler refused an address or a source (outside the folder, through a symlink, not writable) | follow the message |
| `precondition_failed` | the folder changed while the write was staged | plan again |
| `write_unverified` | a write did not read back as written | check the folder; `recover` |
| `recover_first` | an earlier apply did not finish | run `recover` |
| `recover_failed` | the journal cannot be replayed | inspect `.harness-skeleton/journal/` |
| `ledger_unreadable` | the ledger is not valid | inspect `.harness-skeleton/ledger.json` |

## Sessions

| Code | Means | Do |
|---|---|---|
| `session_unknown` | the session key names another store, or no such session | list again |
| `incarnation_gone` | the session's incarnation no longer exists | list again; it is another session now |
| `source_unknown` | no such source in that session | use a `source_key` from the list |

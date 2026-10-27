// The adapter-side conformance checklist, item by item, as sessions-model v1 and sessions v1 state
// it (the contracts as frozen at v1), plus the items a v1.x adds, each title marked with its
// version. The matrix (conformance/matrix.js) says, for every item and every harness, what proves
// it. Ids are stable; titles abbreviate the contract's wording.

export const ITEMS = [
  // sessions-model, Conformance (adapter side)
  { id: 'M.replay', of: 'sessions-model', title: 'Replay: derive from empty state gives the golden; every incremental split folds to the same state' },
  { id: 'M.keys-stable', of: 'sessions-model', title: 'Keys are stable: re-deriving after a lost state gives identical keys' },
  { id: 'M.file-stores', of: 'sessions-model', title: 'File harness stores: a database-file store keys by the file\'s real path' },
  { id: 'M.host', of: 'sessions-model', title: 'Host: derived from the machine id, never the hostname; r- fallback' },
  { id: 'M.regenerated-id', of: 'sessions-model', title: 'Regenerated machine id: a different host, two sessions' },
  { id: 'M.known-answers', of: 'sessions-model', title: 'Known answers: every host and harness_path vector' },
  { id: 'M.one-store-one-session', of: 'sessions-model', title: 'One harness store, one session: two hosts give two session keys' },
  { id: 'M.incarnation', of: 'sessions-model', title: 'Incarnation: reuse is told apart where it can be, declared where it cannot' },
  { id: 'M.anchored-ids', of: 'sessions-model', title: 'Anchored ids: a truncate and regrow gives new keys under a new anchor, the same key revised under a surviving one' },
  { id: 'M.tool-linkage', of: 'sessions-model', title: 'Tool linkage: a tool_call with a result links to exactly one tool_result' },
  { id: 'M.is-error', of: 'sessions-model', title: 'is_error (v1.x proposal (#6)): every tool_result copies the store\'s own flag; null where it has none, where the flag says success beside a shell\'s non-zero exit_code, and where status is cancelled or denied; a fixture result with a non-zero exit_code and no failure flag never has is_error true' },
  { id: 'M.folding', of: 'sessions-model', title: 'Folding: a repeated native id yields one record per key, in its last state' },
  { id: 'M.migration-fold', of: 'sessions-model', title: 'Migration fold: migration copies fold only on evidence; identical records stay apart' },
  { id: 'M.explicit-links', of: 'sessions-model', title: 'Explicit links: each explicit link yields one link with the right fields' },
  { id: 'M.cmp-sha', of: 'sessions-model', title: 'cmp_sha: a fork copy that re-minted ids has its origin\'s cmp_sha sequence' },
  { id: 'M.retraction', of: 'sessions-model', title: 'Retraction vs destruction: retracted stays, destroyed is tombstoned' },
  { id: 'M.speaker-split', of: 'sessions-model', title: 'Speaker split: one native record with both sides gives two messages' },
  { id: 'M.orphans', of: 'sessions-model', title: 'Orphans: a transcript with no live session is not listed' },
  { id: 'M.compaction', of: 'sessions-model', title: 'Compaction is not deletion: replaced messages stay present' },
  { id: 'M.redaction', of: 'sessions-model', title: 'Redaction: declared paths redacted in units and records; free text stays; the name lint is clean' },
  { id: 'M.usage', of: 'sessions-model', title: 'Usage: flags, granularity and anchor as declared; a stored zero for unknown is null; no overlap' },
  { id: 'M.setup', of: 'sessions-model', title: 'Setup: null unless the harness store records it; hashes and names only' },
  // sessions, Conformance, adapter side
  { id: 'S.describe', of: 'sessions', title: 'describe states every facet; each explicit claim is backed by a fixture' },
  { id: 'S.positive', of: 'sessions', title: 'Positive control: an appended turn reads as appended (stream) or keeps every earlier key (snapshot, delta)' },
  { id: 'S.negative', of: 'sessions', title: 'Negative control: an implicit rewrite is a reset and drops exactly the vanished keys' },
  { id: 'S.delta-known', of: 'sessions', title: 'Delta with known: a changed row returns with a new sha, a deleted row in gone' },
  { id: 'S.live-keys', of: 'sessions', title: 'Live keys: derive returns the complete live set' },
  { id: 'S.unchanged', of: 'sessions', title: 'Unchanged: a second read with nothing new gives unchanged and no units' },
  { id: 'S.held-back', of: 'sessions', title: 'Held back: a partial line or a streaming turn is not returned until whole' },
  { id: 'S.errors', of: 'sessions', title: 'Errors: session_unknown, incarnation_gone, busy, damaged; never an empty source' },
  { id: 'S.held', of: 'sessions', title: 'Held: a record withheld again is in held, not changed or live, until it completes' },
  { id: 'S.list-deleted', of: 'sessions', title: 'list omits a deleted session, even where a native index keeps it' },
];

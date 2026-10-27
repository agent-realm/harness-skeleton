// Example 01: what one adapter says about itself. describe() takes nothing: no store, no file.
//   node examples/01-describe/describe.js [harness]        (default: claude-code)

import { ADAPTERS, adapterFor } from '@agent-realm/harness-session-adapters';

const harness = process.argv[2] ?? 'claude-code';
if (!ADAPTERS[harness]) {
  console.error(`no adapter for ${harness}: one of ${Object.keys(ADAPTERS).join(', ')}`);
  process.exit(2);
}
const d = adapterFor(harness).describe();

console.log(`== ${d.harness}`);
console.log(`adapter        ${d.adapter} ${d.adapter_ver}`);
console.log(`model_version  ${d.model_version}`);
console.log(`state_ver      ${d.state_ver}`);
console.log(`store_shape    ${JSON.stringify(d.store_shape)}`);
console.log(`ts_source      ${d.ts_source}`);

console.log('\n== sources: role, mode, position_kind, pattern');
for (const s of d.sources) console.log(`${s.role.padEnd(8)} ${s.mode.padEnd(9)} ${s.position_kind.padEnd(16)} ${s.pattern}`);

console.log(`\n== redaction: ${d.redaction.paths.length} path(s)`);
for (const p of d.redaction.paths) console.log(JSON.stringify(p));

console.log('\n== lifecycle facets: how each operation shows in the store');
const byFacet = {};
for (const [op, facet] of Object.entries(d.facets.lifecycle)) (byFacet[facet] ??= []).push(op);
for (const facet of Object.keys(byFacet).sort()) console.log(`${facet.padEnd(9)} ${byFacet[facet].join(', ')}`);
console.log(`hook join  ${d.facets.join.hook}: ${d.facets.join.rule}`);

console.log('\n== every adapter in the package');
for (const [h, a] of Object.entries(ADAPTERS)) {
  const x = a.describe();
  console.log(`${h.padEnd(13)} adapter_ver ${x.adapter_ver}  state_ver ${x.state_ver}  store ${x.store_shape.kind}`);
}

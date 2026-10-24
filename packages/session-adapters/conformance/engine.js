// A minimal consumer for conformance: it keeps what sessions v1 §4 gives the engine (a cursor and
// a generation per source, the current units of each generation, the derive state) and folds
// derive output into a view of records, tombstoning keys absent from `live` and `held`. It is the
// reference the runner compares adapters against, not memhouse's engine.

import { applyDerive } from '../src/records.js';

export class MiniEngine {
  constructor(adapter, store) {
    this.adapter = adapter;
    this.store = store;
    this.sessions = new Map(); // session_id -> { sources: Map, state, view }
    this.log = []; // [{session_id, source_key, continuity}] of the last pass
  }

  sessionKey(s) {
    return { ...this.store, session_id: s.session_id, incarnation: s.incarnation ?? '' };
  }

  // One capture pass over the harness store. Returns the sessions that changed.
  pass() {
    this.log = [];
    const listed = this.adapter.list(this.store);
    const seen = new Set();
    for (const s of listed) {
      const id = `${s.session_id}\u0000${s.incarnation ?? ''}`;
      seen.add(id);
      let held = this.sessions.get(id);
      if (!held) {
        held = { sources: new Map(), state: null, view: new Map() };
        this.sessions.set(id, held);
      }
      let full = held.state === null;
      const fresh = new Map();
      const listedKeys = new Set(s.sources.map((x) => x.source_key));
      for (const sk of [...held.sources.keys()]) {
        if (!listedKeys.has(sk)) {
          held.sources.delete(sk);
          full = true;
        }
      }
      for (const src of s.sources) {
        let cur = held.sources.get(src.source_key);
        if (!cur) {
          cur = { position: null, generation: 0, units: new Map() };
          held.sources.set(src.source_key, cur);
        }
        const known = Object.fromEntries([...cur.units].map(([k, u]) => [k, u.sha256]));
        const r = this.adapter.read(this.store, this.sessionKey(s), src.source_key, cur.position, cur.units.size ? known : null);
        // A capped read says `more`: keep reading from the returned position in the same pass.
        while (r.more) {
          const next = this.adapter.read(this.store, this.sessionKey(s), src.source_key, r.position, null);
          if (next.continuity === 'reset') throw new Error(`${src.source_key} reset in the middle of a capped read`);
          r.units = [...r.units, ...next.units];
          r.position = next.position;
          r.held_back = next.held_back;
          r.more = next.more;
          if (r.continuity === 'unchanged' && next.units.length) r.continuity = 'appended';
        }
        this.log.push({ session_id: s.session_id, source_key: src.source_key, continuity: r.continuity, units: r.units.length, held_back: r.held_back });
        const added = [];
        switch (r.continuity) {
          case 'reset':
            cur.generation += 1;
            cur.units = new Map(r.units.map((u) => [u.unit_key, u]));
            full = true;
            break;
          case 'appended':
          case 'delta':
            for (const u of r.units) cur.units.set(u.unit_key, u);
            for (const k of r.gone ?? []) cur.units.delete(k);
            added.push(...r.units);
            break;
          case 'snapshot':
            cur.units = new Map(r.units.map((u) => [u.unit_key, u]));
            added.push(...r.units);
            break;
          case 'unchanged':
            break;
          default:
            throw new Error(`unknown continuity ${r.continuity}`);
        }
        cur.position = r.position;
        fresh.set(src.source_key, { added, gone: r.gone ?? [] });
      }
      let input;
      if (full) {
        // A reset of any source re-derives the whole session from empty state (sessions §2).
        held.state = null;
        input = [...held.sources].map(([sk, cur]) => ({ source_key: sk, generation: cur.generation, complete: true, units: [...cur.units.values()], gone: [] }));
      } else {
        input = [...fresh].filter(([, f]) => f.added.length || f.gone.length)
          .map(([sk, f]) => ({ source_key: sk, generation: held.sources.get(sk).generation, complete: false, units: f.added, gone: f.gone }));
        if (!input.length) continue;
      }
      const out = this.adapter.derive(this.sessionKey(s), input, held.state);
      for (const r of out.changed) {
        for (const k of ['host', 'harness', 'harness_path', 'session_id', 'incarnation']) {
          if (r[k] !== this.sessionKey(s)[k] && !(k === 'harness' && r[k] === this.store.harness)) {
            throw new Error(`record ${r.type} carries ${k}=${r[k]}, not the session's`);
          }
        }
      }
      held.view = applyDerive(held.view, out);
      held.state = out.state;
      held.last = out;
    }
    for (const id of [...this.sessions.keys()]) if (!seen.has(id)) this.sessions.delete(id);
  }

  // The folded records of every session, keyed `session_id`.
  views() {
    const out = {};
    for (const [id, s] of this.sessions) out[id.split('\u0000')[0]] = s.view;
    return out;
  }
}

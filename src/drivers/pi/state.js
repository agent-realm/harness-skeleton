// The value in effect for each [state] item on pi, with its source (design note v0.2 §5.12), and
// what a launch leaves to pi: its project trust. pi has no switch for any [state] item [PI §16].
//
// Project trust [P15:security; P15:dist/core/trust-manager.js]: a project's .pi/ resources load once
// trusted. pi takes the closest saved decision for the working directory or a parent from the
// folder's trust.json (a map of canonical directory paths to true, false or null), else the
// folder's defaultProjectTrust (default "ask"). Print, JSON and RPC modes cannot ask: "always"
// loads, "ask" and "never" skip. Reported without a path: the default, the counts of saved
// decisions, and with --cwd whether a trusted project .pi/ is there.

import fs from 'node:fs';
import path from 'node:path';
import { readDoc } from '../../native.js';

// The project resources pi loads only after trust [P15:dist/core/trust-manager.js].
const PROTECTED = ['settings.json', 'mcp.json', 'extensions', 'skills', 'prompts', 'themes', 'SYSTEM.md', 'APPEND_SYSTEM.md'];
const TRUST_VALUES = ['always', 'ask', 'never'];

export function stateInEffect(harnessPath, descriptor, { cwd } = {}) {
  const items = descriptor.state;
  const errors = [];
  const escapes = [];
  const settings = readDoc(path.join(harnessPath, 'settings.json'));
  if (settings.blocked) errors.push({ path: 'settings.json', error: settings.blocked });
  const doc = settings.doc && typeof settings.doc === 'object' && !Array.isArray(settings.doc) ? settings.doc : {};
  // A sessionDir moves sessions out of the folder (§8): reported, never changed; its value is not
  // shown.
  if (typeof doc.sessionDir === 'string' && doc.sessionDir !== '') {
    escapes.push({ kind: 'outbound-write', path: 'settings.json sessionDir', class: 'sessions', closable: false, applies: true, note: 'the folder\'s settings move its sessions out of it', source: 'P15:settings' });
  }

  const def = TRUST_VALUES.includes(doc.defaultProjectTrust) ? doc.defaultProjectTrust : 'ask';
  const trust = readDoc(path.join(harnessPath, 'trust.json'));
  if (trust.blocked) errors.push({ path: 'trust.json', error: trust.blocked });
  const saved = trust.doc && typeof trust.doc === 'object' && !Array.isArray(trust.doc) ? trust.doc : {};
  const decisions = Object.values(saved);
  const project = {
    default: def,
    default_source: TRUST_VALUES.includes(doc.defaultProjectTrust) ? 'settings.json' : 'default',
    saved: { trusted: decisions.filter((d) => d === true).length, untrusted: decisions.filter((d) => d === false).length },
  };
  if (cwd !== undefined) {
    const present = PROTECTED.filter((n) => fs.existsSync(path.join(cwd, '.pi', n)));
    // The closest saved decision for the directory or a parent; null clears a level.
    let decision = null;
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (saved[dir] === true || saved[dir] === false) {
        decision = saved[dir];
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
    const json = decision ?? def === 'always';
    const interactive = decision === null ? (def === 'always' ? 'loads' : def === 'never' ? 'skipped' : 'asks') : decision ? 'loads' : 'skipped';
    project.cwd = {
      protected_present: present,
      saved_decision: decision,
      headless: present.length ? (json ? 'loads' : 'skipped') : 'nothing to load',
      interactive: present.length ? interactive : 'nothing to load',
      // What the known limit asks: a project .pi/ that a launch here loads.
      trusted_project_pi: present.length > 0 && json,
    };
  }
  return {
    items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { value: v.harness_default, source: 'default', expressible: false, reason: v.reason }])),
    harness_defaults: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.harness_default])),
    escapes,
    errors,
    extra: { project_trust: project },
  };
}

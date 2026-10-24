// Version ranges (design note v0.2 §7.2): `certified` lists tested releases; `compatible` is a
// range [min, below). Outside both, writes refuse.

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? m.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function rangeStatus(version, { certified = [], compatible = null } = {}) {
  if (!parseVersion(version)) return 'unknown';
  if (certified.some((v) => compareVersions(v, version) === 0)) return 'certified';
  if (compatible && compareVersions(version, compatible.min) >= 0 && compareVersions(version, compatible.below) < 0) {
    return 'compatible';
  }
  return 'outside';
}

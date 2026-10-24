// Hook matchers at launch, for every driver (design note v0.2 §5.6). A hook's matcher is null for
// every occurrence; else exact names joined by | while every name is in the harness's exact-match
// charset (`HK.exact`), and an anchored, escaped regex once one is not, or once a part is a
// pattern (an MCP server's every tool): an unanchored regex would match more names.

const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function hookMatcher(HK, v) {
  if (!v.match) return null;
  const join = (names, patterns = []) => (!patterns.length && names.every((x) => HK.exact.test(x))
    ? names.join('|')
    : `^(${names.map(esc).concat(patterns).join('|')})$`);
  if (v.match.tool) {
    const exact = [];
    const patterns = [];
    for (const c of v.match.tool) {
      if (c.startsWith('mcp:')) {
        const [server, tool] = c.slice(4).split('/');
        if (tool) exact.push(`${HK.mcp_prefix}${server}__${tool}`);
        else patterns.push(`${esc(HK.mcp_prefix + server)}__.*`);
      } else exact.push(...HK.classes[c]);
    }
    return join([...new Set(exact)], patterns);
  }
  // Sources, triggers and agent types.
  return join(v.match[Object.keys(v.match)[0]]);
}

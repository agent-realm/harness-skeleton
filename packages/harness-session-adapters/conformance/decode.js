import zlib from 'node:zlib';

// Decoding for the fixture scans.
// Every base64 run (standard or url-safe, 16 characters or more) is decoded and scanned as bytes,
// three levels deep: `$b64` blob parameters of database fixtures, and encoded fields inside JSON
// text (a protobuf `toolCallBinary`, a zstd column). Decoding text that only looks like base64
// yields noise, which the scans' patterns do not match.
export function inflate(b) {
  try {
    if (b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return zlib.zstdDecompressSync(b);
    if (b[0] === 0x1f && b[1] === 0x8b) return zlib.gunzipSync(b);
  } catch {
    // not a whole payload: scanned as decoded bytes only
  }
  return null;
}
export function decodedOf(text, depth = 0, out = []) {
  if (depth >= 3) return out;
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    const raw = Buffer.from(m[0], 'base64'); // Node's decoder also takes the url-safe alphabet
    for (const b of [raw, inflate(raw)]) {
      if (!b) continue;
      const s = b.toString('latin1');
      out.push(s);
      decodedOf(s, depth + 1, out);
    }
  }
  return out;
}

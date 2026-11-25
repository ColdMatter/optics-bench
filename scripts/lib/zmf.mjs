// Reads a Zemax lens catalogue (.ZMF): a uint32 version (1001), then one record per lens. Each
// record is a 144-byte header (the part number as a 100-byte NUL-padded string, seven uint32s, of
// which the last is the data length, then two doubles: effective focal length and entrance pupil
// diameter) followed by the lens's .zmx text, obfuscated with a key derived from those two
// doubles. The scheme is not published by Zemax; it is the one open-source readers use (e.g.
// rayopt's ZmfLibrary), checked here by every record decoding to a parseable .zmx.

const HEADER_BYTES = 144;
const NAME_BYTES = 100;
const VERSION = 1001;

function deobfuscate(blob, efl, enp) {
  let iv = Math.cos(6 * efl + 3 * enp);
  iv = Math.cos(655 * (Math.PI / 180) * iv) + iv;
  const out = Buffer.alloc(blob.length);
  for (let p = 0; p < blob.length; p++) {
    const k = 13.2 * (iv + Math.sin(17 * (p + 3))) * (p + 1);
    // Digits 4–6 of k in "%.8e" form (sign included), as the obfuscation defines them.
    out[p] = blob[p] ^ (Number(k.toExponential(8).slice(4, 7)) & 0xff);
  }
  return out;
}

/** Every lens in a .ZMF buffer as { part, efl, data }, data being the decoded .zmx bytes. */
export function readZmf(buf) {
  const version = buf.readUInt32LE(0);
  if (version !== VERSION) throw new Error(`unknown ZMF version ${version}`);
  const records = [];
  let p = 4;
  while (p + HEADER_BYTES <= buf.length) {
    const part = buf.subarray(p, p + NAME_BYTES).toString('latin1').replace(/\0.*$/s, '');
    const length = buf.readUInt32LE(p + NAME_BYTES + 6 * 4);
    const efl = buf.readDoubleLE(p + NAME_BYTES + 7 * 4);
    const enp = buf.readDoubleLE(p + NAME_BYTES + 7 * 4 + 8);
    p += HEADER_BYTES;
    if (p + length > buf.length) throw new Error(`${part}: record runs past the end of the file`);
    records.push({ part, efl, data: deobfuscate(buf.subarray(p, p + length), efl, enp) });
    p += length;
  }
  if (p !== buf.length) throw new Error(`${buf.length - p} trailing bytes after the last record`);
  return records;
}

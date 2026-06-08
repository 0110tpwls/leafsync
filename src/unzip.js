// unzip.js — minimal ZIP reader (stdlib only: zlib for DEFLATE).
//
// Overleaf's "Download as ZIP" endpoint (/project/{id}/download/zip) is the
// most robust way to mirror ALL project content in one authenticated request —
// it sidesteps the per-doc socket joinDoc and the docstore REST route (which
// 404s on www.overleaf.com). We only need to read the archive, so this handles
// the two methods ZIP actually uses: stored (0) and deflate (8).

import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header

/**
 * Parse a ZIP Buffer into [{ name, data:Buffer, dir:boolean }].
 * Throws if the buffer isn't a ZIP. Ignores ZIP64 (Overleaf archives are small).
 */
export function unzip(buf) {
  // Find EOCD by scanning back from the end (comment field is usually empty).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no EOCD)");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    // Resolve the data start from the local header (its extra field length can
    // differ from the central one).
    if (buf.readUInt32LE(localOff) === LOC_SIG) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      const isDir = name.endsWith("/");
      let data;
      if (isDir) data = Buffer.alloc(0);
      else if (method === 0) data = Buffer.from(comp);
      else if (method === 8) data = zlib.inflateRawSync(comp);
      else throw new Error(`unsupported ZIP method ${method} for ${name}`);
      entries.push({ name, data, dir: isDir });
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Some archives wrap everything under a single top folder. If EVERY entry shares
 * the same first path segment, strip it so paths line up with the project tree.
 */
export function stripCommonRoot(entries) {
  const tops = new Set(
    entries.map((e) => e.name.split("/")[0]).filter(Boolean)
  );
  if (tops.size !== 1) return entries;
  const root = [...tops][0] + "/";
  return entries
    .map((e) => ({ ...e, name: e.name.startsWith(root) ? e.name.slice(root.length) : e.name }))
    .filter((e) => e.name.length > 0);
}

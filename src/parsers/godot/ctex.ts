/**
 * Godot compiled textures (.ctex Godot 4 "GST2", .stex Godot 3 "GDST") often wrap a plain PNG or
 * WebP file when the import mode is Lossless/Lossy. This module lifts that payload out so it can be
 * written as a normal image. VRAM compressed (S3TC/ETC/ASTC) and raw-Image payloads are not touched.
 *
 * The container header is not decoded field by field (it differs between engine versions): after the
 * magic, the image signature is looked for within the first bytes where the first mip level starts.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_SEARCH_LIMIT = 96; // Godot 4: 36-byte header + format/size fields; Godot 3: 20 bytes + fields
const MAX_PNG_CHUNKS = 100000;

export interface CtexImage {
  ext: "png" | "webp";
  data: Buffer;
}

export function isGodotTextureContainer(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  const magic = buf.subarray(0, 4).toString("latin1");
  return magic === "GST2" || magic === "GDST";
}

/** Exact byte length of the PNG starting at `start` (walks chunks up to IEND), or null */
function pngLength(buf: Buffer, start: number): number | null {
  let pos = start + PNG_SIGNATURE.length;
  for (let i = 0; i < MAX_PNG_CHUNKS; i++) {
    if (pos + 12 > buf.length) return null;
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("latin1");
    pos += 12 + len;
    if (pos > buf.length) return null;
    if (type === "IEND") return pos - start;
  }
  return null;
}

/**
 * Return the first (largest) embedded PNG/WebP image of a .ctex/.stex file, or null when the
 * file is not such a container or stores VRAM-compressed/raw pixels.
 */
export function extractCtexImage(buf: Buffer): CtexImage | null {
  if (!isGodotTextureContainer(buf)) return null;
  const limit = Math.min(buf.length, HEADER_SEARCH_LIMIT + PNG_SIGNATURE.length);

  const png = buf.subarray(0, limit).indexOf(PNG_SIGNATURE, 8);
  if (png >= 0) {
    const len = pngLength(buf, png);
    return len ? { ext: "png", data: buf.subarray(png, png + len) } : null;
  }

  for (let i = 8; i + 12 <= limit; i++) {
    if (buf[i] === 0x52 && buf.subarray(i, i + 4).toString("latin1") === "RIFF" && buf.subarray(i + 8, i + 12).toString("latin1") === "WEBP") {
      const total = buf.readUInt32LE(i + 4) + 8;
      if (i + total > buf.length) return null;
      return { ext: "webp", data: buf.subarray(i, i + total) };
    }
  }
  return null;
}

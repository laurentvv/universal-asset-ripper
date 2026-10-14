/**
 * Pure decoders for Windows PE resource payloads (no file access).
 * Every function is best effort: callers fall back to the raw bytes when a decoder returns null.
 */

const BI_BITFIELDS = 3;
const BI_ALPHABITFIELDS = 6;

/**
 * Wrap a raw RT_BITMAP DIB into a standalone .bmp file.
 * bfOffBits = 14 + header size + colour masks + palette. Returns the input unchanged when it
 * already is a .bmp file or when the DIB header variant is unknown.
 */
export function buildBmpFile(dib: Buffer): Buffer {
  if (dib.length >= 2 && dib[0] === 0x42 && dib[1] === 0x4d) return dib;
  if (dib.length < 12) return dib;

  const biSize = dib.readUInt32LE(0);
  let paletteBytes: number;
  let masksBytes = 0;

  if (biSize === 12) {
    const bpp = dib.readUInt16LE(10);
    paletteBytes = bpp <= 8 ? (1 << bpp) * 3 : 0;
  } else if (biSize === 40 || biSize === 108 || biSize === 124) {
    if (dib.length < biSize) return dib;
    const bpp = dib.readUInt16LE(14);
    const compression = dib.readUInt32LE(16);
    const clrUsed = dib.readUInt32LE(32);
    const entries = clrUsed > 0 ? clrUsed : bpp > 0 && bpp <= 8 ? 1 << bpp : 0;
    paletteBytes = entries * 4;
    if (biSize === 40) {
      if (compression === BI_BITFIELDS) masksBytes = 12;
      else if (compression === BI_ALPHABITFIELDS) masksBytes = 16;
    }
  } else {
    return dib;
  }

  const fileHeader = Buffer.alloc(14);
  fileHeader.write("BM", 0, "ascii");
  fileHeader.writeUInt32LE(14 + dib.length, 2);
  fileHeader.writeUInt32LE(14 + biSize + masksBytes + paletteBytes, 10);
  return Buffer.concat([fileHeader, dib]);
}

export interface CursorImage {
  /** Width/height from the RT_GROUP_CURSOR entry (used when the image header is unreadable) */
  width: number;
  height: number;
  /** Raw RT_CURSOR payload: 4 hotspot bytes followed by the DIB/PNG image */
  payload: Buffer;
}

/**
 * Build a standalone .cur file (ICONDIR type 2) from the RT_CURSOR payloads of a cursor group.
 */
export function buildCursorFile(images: CursorImage[]): Buffer | null {
  const usable = images.filter((i) => i.payload.length > 4);
  if (usable.length === 0) return null;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(2, 2); // type 2 = cursor
  header.writeUInt16LE(usable.length, 4);

  const entries: Buffer[] = [];
  const datas: Buffer[] = [];
  let offset = 6 + usable.length * 16;

  for (const img of usable) {
    const hotX = img.payload.readUInt16LE(0);
    const hotY = img.payload.readUInt16LE(2);
    const data = img.payload.subarray(4);

    let width = img.width;
    let height = img.height;
    const isPng = data.length >= 4 && data.readUInt32BE(0) === 0x89504e47;
    if (!isPng && data.length >= 12 && [40, 108, 124].includes(data.readUInt32LE(0))) {
      width = Math.abs(data.readInt32LE(4));
      height = Math.floor(Math.abs(data.readInt32LE(8)) / 2); // DIB height includes the AND mask
    } else if (!isPng && height === width * 2) {
      height = width;
    }

    const entry = Buffer.alloc(16);
    entry.writeUInt8(width >= 256 ? 0 : width, 0);
    entry.writeUInt8(height >= 256 ? 0 : height, 1);
    entry.writeUInt16LE(hotX, 4);
    entry.writeUInt16LE(hotY, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    datas.push(data);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...datas]);
}

/**
 * Decode one RT_STRING block (16 length-prefixed UTF-16LE strings). `blockId` is the resource
 * name; string ids are (blockId - 1) * 16 + index. Empty slots are skipped.
 */
export function decodeStringBlock(buf: Buffer, blockId: number): Record<string, string> | null {
  if (blockId < 1) return null;
  const result: Record<string, string> = {};
  let pos = 0;
  for (let i = 0; i < 16; i++) {
    if (pos + 2 > buf.length) break;
    const len = buf.readUInt16LE(pos);
    pos += 2;
    if (pos + len * 2 > buf.length) return null;
    if (len > 0) {
      result[String((blockId - 1) * 16 + i)] = buf.subarray(pos, pos + len * 2).toString("utf16le");
    }
    pos += len * 2;
  }
  return result;
}

export interface VersionInfo {
  fixedFileInfo: {
    fileVersion: string;
    productVersion: string;
    fileFlags: number;
    fileOS: number;
    fileType: number;
  } | null;
  /** Language/codepage table key (e.g. "040904b0") to string key/values */
  strings: Record<string, Record<string, string>>;
  translations: Array<{ languageId: number; codePage: number }>;
}

interface VersionBlock {
  length: number;
  valueLength: number;
  type: number;
  key: string;
  valueOffset: number;
  childrenOffset: number;
  end: number;
}

function readVersionBlock(buf: Buffer, off: number, limit: number): VersionBlock | null {
  if (off + 6 > limit) return null;
  const length = buf.readUInt16LE(off);
  const valueLength = buf.readUInt16LE(off + 2);
  const type = buf.readUInt16LE(off + 4);
  if (length < 6) return null;
  const end = Math.min(off + length, limit);

  let p = off + 6;
  let key = "";
  while (p + 2 <= end) {
    const ch = buf.readUInt16LE(p);
    p += 2;
    if (ch === 0) break;
    key += String.fromCharCode(ch);
  }
  const valueOffset = (p + 3) & ~3;
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  const childrenOffset = (valueOffset + valueBytes + 3) & ~3;
  return { length, valueLength, type, key, valueOffset, childrenOffset, end };
}

/**
 * Decode an RT_VERSION payload (VS_VERSIONINFO) into fixed file info and StringFileInfo values.
 */
export function decodeVersionInfo(buf: Buffer): VersionInfo | null {
  try {
    const root = readVersionBlock(buf, 0, buf.length);
    if (!root || root.key !== "VS_VERSION_INFO") return null;

    const info: VersionInfo = { fixedFileInfo: null, strings: {}, translations: [] };

    if (root.valueLength >= 52 && root.valueOffset + 52 <= buf.length) {
      const v = root.valueOffset;
      if (buf.readUInt32LE(v) === 0xfeef04bd) {
        const ver = (ms: number, ls: number) => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
        info.fixedFileInfo = {
          fileVersion: ver(buf.readUInt32LE(v + 8), buf.readUInt32LE(v + 12)),
          productVersion: ver(buf.readUInt32LE(v + 16), buf.readUInt32LE(v + 20)),
          fileFlags: buf.readUInt32LE(v + 28),
          fileOS: buf.readUInt32LE(v + 32),
          fileType: buf.readUInt32LE(v + 36)
        };
      }
    }

    let child = root.childrenOffset;
    while (child + 6 <= root.end) {
      const block = readVersionBlock(buf, child, root.end);
      if (!block) break;

      if (block.key === "StringFileInfo") {
        let tableOff = block.childrenOffset;
        while (tableOff + 6 <= block.end) {
          const table = readVersionBlock(buf, tableOff, block.end);
          if (!table) break;
          const values: Record<string, string> = {};
          let strOff = table.childrenOffset;
          while (strOff + 6 <= table.end) {
            const str = readVersionBlock(buf, strOff, table.end);
            if (!str) break;
            const rawEnd = Math.min(str.valueOffset + str.valueLength * 2, str.end);
            const value =
              str.valueLength > 0 && str.valueOffset < rawEnd
                ? buf.subarray(str.valueOffset, rawEnd).toString("utf16le").replace(/\0+$/, "")
                : "";
            values[str.key] = value;
            strOff = (str.end + 3) & ~3;
          }
          info.strings[table.key] = values;
          tableOff = (table.end + 3) & ~3;
        }
      } else if (block.key === "VarFileInfo") {
        let varOff = block.childrenOffset;
        while (varOff + 6 <= block.end) {
          const v = readVersionBlock(buf, varOff, block.end);
          if (!v) break;
          if (v.key === "Translation") {
            for (let p = v.valueOffset; p + 4 <= Math.min(v.valueOffset + v.valueLength, v.end); p += 4) {
              info.translations.push({ languageId: buf.readUInt16LE(p), codePage: buf.readUInt16LE(p + 2) });
            }
          }
          varOff = (v.end + 3) & ~3;
        }
      }
      child = (block.end + 3) & ~3;
    }

    return info;
  } catch {
    return null;
  }
}

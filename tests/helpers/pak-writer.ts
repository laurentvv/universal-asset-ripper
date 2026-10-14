import { createCipheriv, createHash } from "node:crypto";
import * as zlib from "node:zlib";

/**
 * Test-only writer for synthetic Unreal .pak files (versions 3-11). It follows UE's FPakEntry /
 * FPakInfo layout and repak's encoded-entry bit packing, so it exercises the native reader
 * without needing a commercial game archive.
 */

const PAK_MAGIC = 0x5a6f12e1;

export interface PakWriterEntry {
  path: string;
  data: Buffer;
  /** "zlib" really compresses; "oodle" stores the raw bytes under the Oodle method id (unsupported on purpose) */
  compression?: "zlib" | "oodle";
  encrypt?: boolean;
  /** Uncompressed bytes per compression block (default 65536) */
  blockSize?: number;
  /** v10+: keep the entry in the non-encoded list instead of the bit-packed blob */
  nonEncoded?: boolean;
}

export interface PakWriterOptions {
  version?: number;
  /** version 8 with 4 compression slots and u8 compression ids (UE 4.22) */
  v8a?: boolean;
  mountPoint?: string;
  /** 32-byte AES key used for the index (encryptIndex) and for entries flagged encrypt */
  aesKey?: Buffer;
  encryptIndex?: boolean;
  /** v10+: write the full directory index (default true); false leaves only the path hash index */
  fullDirectoryIndex?: boolean;
  compressionNames?: string[];
}

const align16 = (n: number): number => Math.ceil(n / 16) * 16;

function fstring(s: string): Buffer {
  const body = Buffer.from(`${s}\0`, "utf8");
  const len = Buffer.alloc(4);
  len.writeInt32LE(body.length);
  return Buffer.concat([len, body]);
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function ecb(data: Buffer, key: Buffer): Buffer {
  const padded = Buffer.concat([data, Buffer.alloc(align16(data.length) - data.length)]);
  const c = createCipheriv("aes-256-ecb", key, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(padded), c.final()]);
}

function headerSize(version: number, v8a: boolean, compressed: boolean, blocks: number): number {
  let size = 8 + 8 + 8 + (v8a ? 1 : 4) + 20;
  if (version >= 3) {
    if (compressed) size += 4 + 16 * blocks;
    size += 1 + 4;
  }
  return size;
}

interface BuiltEntry {
  entry: PakWriterEntry;
  bytes: Buffer; // in-data header + payload
  compressionId: number;
  compressedSize: number;
  blocks: Array<{ start: number; end: number }>; // relative to the entry (v5+) or absolute (v3/v4) once placed
  rawBlockSizes: number[];
  blockSize: number;
  headerLen: number;
}

function record(
  version: number,
  v8a: boolean,
  offset: number,
  b: BuiltEntry,
  hash: Buffer,
  blocksAbsolute: Array<{ start: number; end: number }>
): Buffer {
  const parts: Buffer[] = [u64(offset), u64(b.compressedSize), u64(b.entry.data.length)];
  parts.push(v8a ? Buffer.from([b.compressionId]) : u32(b.compressionId));
  parts.push(hash);
  if (version >= 3) {
    if (b.compressionId !== 0) {
      parts.push(u32(blocksAbsolute.length));
      for (const blk of blocksAbsolute) parts.push(u64(blk.start), u64(blk.end));
    }
    parts.push(Buffer.from([b.entry.encrypt ? 1 : 0]));
    parts.push(u32(b.compressionId !== 0 ? b.blockSize : 0));
  }
  return Buffer.concat(parts);
}

export function buildPak(entries: PakWriterEntry[], options: PakWriterOptions = {}): Buffer {
  const version = options.version ?? 8;
  const v8a = options.v8a === true && version === 8;
  const mountPoint = options.mountPoint ?? "../../../Game/";
  const key = options.aesKey;
  const names = options.compressionNames ?? ["Zlib", "Oodle"];
  const slotCount = version >= 8 ? (v8a ? 4 : 5) : 0;
  const slots = Array.from({ length: slotCount }, (_, i) => names[i] ?? "");

  const idFor = (kind: "zlib" | "oodle"): number => {
    if (version < 8) return kind === "zlib" ? 1 : 4;
    const idx = slots.findIndex((s) => s.toLowerCase() === kind);
    if (idx < 0) throw new Error(`writer: no '${kind}' compression slot`);
    return idx + 1;
  };

  // --- entries ---
  const chunks: Buffer[] = [];
  const placed: Array<{ built: BuiltEntry; offset: number; hash: Buffer; absBlocks: Array<{ start: number; end: number }> }> = [];
  let cursor = 0;

  for (const e of entries) {
    if (e.encrypt && !key) throw new Error("writer: aesKey required for encrypted entries");
    const compressionId = e.compression ? idFor(e.compression) : 0;
    const blockSize = e.blockSize ?? 65536;

    let payloads: Buffer[];
    let rawBlockSizes: number[] = [];
    if (e.compression) {
      payloads = [];
      for (let i = 0; i < Math.max(1, Math.ceil(e.data.length / blockSize)); i++) {
        const slice = e.data.subarray(i * blockSize, (i + 1) * blockSize);
        payloads.push(e.compression === "zlib" ? zlib.deflateSync(slice) : Buffer.from(slice));
      }
      rawBlockSizes = payloads.map((p) => p.length);
    } else {
      payloads = [e.data];
    }

    const compressedSize = e.compression ? rawBlockSizes.reduce((a, b) => a + b, 0) : e.data.length;
    const hdr = headerSize(version, v8a, compressionId !== 0, e.compression ? payloads.length : 0);

    const rel: Array<{ start: number; end: number }> = [];
    let pos = hdr;
    const bodyParts: Buffer[] = [];
    for (const p of payloads) {
      const stored = e.encrypt ? ecb(p, key!) : p;
      if (e.compression) rel.push({ start: pos, end: pos + p.length });
      bodyParts.push(stored);
      pos += stored.length;
    }

    const built: BuiltEntry = {
      entry: e,
      bytes: Buffer.alloc(0),
      compressionId,
      compressedSize,
      blocks: rel,
      rawBlockSizes,
      blockSize,
      headerLen: hdr
    };
    const offset = cursor;
    const absBlocks = rel.map((b) => ({ start: (version >= 5 ? 0 : offset) + b.start, end: (version >= 5 ? 0 : offset) + b.end }));
    const hash = createHash("sha1").update(e.data).digest();
    const header = record(version, v8a, 0, built, hash, absBlocks);
    if (header.length !== hdr) throw new Error(`writer: header size mismatch ${header.length} != ${hdr}`);
    built.bytes = Buffer.concat([header, ...bodyParts]);
    chunks.push(built.bytes);
    placed.push({ built, offset, hash, absBlocks });
    cursor += built.bytes.length;
  }

  const dataSection = Buffer.concat(chunks);
  const indexOffset = dataSection.length;
  const encryptIndex = options.encryptIndex === true;
  if (encryptIndex && !key) throw new Error("writer: aesKey required for an encrypted index");
  const maybeEncrypt = (b: Buffer): Buffer => (encryptIndex ? ecb(b, key!) : b);

  let indexBytes: Buffer;
  let secondary = Buffer.alloc(0);

  if (version < 10) {
    const parts: Buffer[] = [fstring(mountPoint), u32(entries.length)];
    for (const p of placed) {
      parts.push(fstring(p.built.entry.path), record(version, v8a, p.offset, p.built, p.hash, p.absBlocks));
    }
    indexBytes = maybeEncrypt(Buffer.concat(parts));
  } else {
    // encoded blob + non-encoded list + location per entry
    const encodedParts: Buffer[] = [];
    let encodedLen = 0;
    const nonEncoded: Buffer[] = [];
    const locations: number[] = [];
    for (const p of placed) {
      const b = p.built;
      if (b.entry.nonEncoded) {
        locations.push(-(nonEncoded.length + 1));
        nonEncoded.push(record(version, false, p.offset, b, p.hash, p.absBlocks));
        continue;
      }
      const blockCount = b.entry.compression ? b.blocks.length : 0;
      const sizeField = b.blockSize % 2048 === 0 && b.blockSize / 2048 < 0x3f ? b.blockSize / 2048 : 0x3f;
      const off32 = p.offset <= 0xffffffff;
      const unc32 = b.entry.data.length <= 0xffffffff;
      const cmp32 = b.compressedSize <= 0xffffffff;
      let bits = (b.compressionId !== 0 ? sizeField : 0) | (blockCount << 6) | ((b.entry.encrypt ? 1 : 0) << 22) | (b.compressionId << 23);
      if (cmp32) bits |= 1 << 29;
      if (unc32) bits |= 1 << 30;
      let bitsU = bits >>> 0;
      if (off32) bitsU = (bitsU | 0x80000000) >>> 0;
      const parts: Buffer[] = [u32(bitsU)];
      if (b.compressionId !== 0 && sizeField === 0x3f) parts.push(u32(b.blockSize));
      parts.push(off32 ? u32(p.offset) : u64(p.offset));
      parts.push(unc32 ? u32(b.entry.data.length) : u64(b.entry.data.length));
      if (b.compressionId !== 0) parts.push(cmp32 ? u32(b.compressedSize) : u64(b.compressedSize));
      if (blockCount > 1 || (blockCount > 0 && b.entry.encrypt)) {
        for (const s of b.rawBlockSizes) parts.push(u32(s));
      }
      const enc = Buffer.concat(parts);
      locations.push(encodedLen);
      encodedParts.push(enc);
      encodedLen += enc.length;
    }
    const encodedBlob = Buffer.concat(encodedParts);

    // full directory index
    const dirs = new Map<string, Array<{ file: string; location: number }>>();
    placed.forEach((p, i) => {
      const full = p.built.entry.path;
      const slash = full.lastIndexOf("/");
      const dir = slash >= 0 ? `/${full.slice(0, slash + 1)}` : "/";
      const file = slash >= 0 ? full.slice(slash + 1) : full;
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir)!.push({ file, location: locations[i] });
    });
    const fdParts: Buffer[] = [u32(dirs.size)];
    for (const [dir, files] of dirs) {
      fdParts.push(fstring(dir), u32(files.length));
      for (const f of files) {
        const loc = Buffer.alloc(4);
        loc.writeInt32LE(f.location);
        fdParts.push(fstring(f.file), loc);
      }
    }
    const fullDir = maybeEncrypt(Buffer.concat(fdParts));

    const phParts: Buffer[] = [u32(placed.length)];
    placed.forEach((_p, i) => {
      const loc = Buffer.alloc(4);
      loc.writeInt32LE(locations[i]);
      phParts.push(u64(0x1000 + i), loc);
    });
    phParts.push(u32(0));
    const pathHash = maybeEncrypt(Buffer.concat(phParts));

    const withFullDir = options.fullDirectoryIndex !== false;
    const buildPrimary = (phOff: number, fdOff: number): Buffer =>
      Buffer.concat([
        fstring(mountPoint),
        u32(entries.length),
        u64(0x1234),
        u32(1),
        u64(phOff),
        u64(pathHash.length),
        Buffer.alloc(20),
        u32(withFullDir ? 1 : 0),
        ...(withFullDir ? [u64(fdOff), u64(fullDir.length), Buffer.alloc(20)] : []),
        u32(encodedBlob.length),
        encodedBlob,
        u32(nonEncoded.length),
        ...nonEncoded
      ]);
    const probe = maybeEncrypt(buildPrimary(0, 0));
    const phOffset = indexOffset + probe.length;
    const fdOffset = phOffset + pathHash.length;
    indexBytes = maybeEncrypt(buildPrimary(phOffset, fdOffset));
    secondary = Buffer.concat([pathHash, ...(withFullDir ? [fullDir] : [])]);
  }

  // --- footer ---
  const footer: Buffer[] = [];
  if (version >= 7) footer.push(Buffer.alloc(16));
  if (version >= 4) footer.push(Buffer.from([encryptIndex ? 1 : 0]));
  footer.push(u32(PAK_MAGIC), u32(version), u64(indexOffset), u64(indexBytes.length), Buffer.alloc(20));
  if (version === 9) footer.push(Buffer.alloc(1));
  for (const s of slots) {
    const slot = Buffer.alloc(32);
    slot.write(s, "ascii");
    footer.push(slot);
  }

  return Buffer.concat([dataSection, indexBytes, secondary, ...footer]);
}

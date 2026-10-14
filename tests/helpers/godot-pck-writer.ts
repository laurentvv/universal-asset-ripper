import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { GDPC_MAGIC } from "../../src/parsers/godot/pck-parser.js";

/**
 * Test-only Godot PCK writer with FileAccessEncrypted support (md5 | length | iv | AES-256-CFB data).
 * The encryptor mirrors Godot's writer so the reader is exercised end to end; it is NOT a capture
 * of a real encrypted export.
 */

export function godotEncrypt(plain: Buffer, key: Buffer, iv: Buffer = randomBytes(16)): Buffer {
  const padded = Buffer.concat([plain, Buffer.alloc((16 - (plain.length % 16)) % 16)]);
  const cipher = createCipheriv("aes-256-cfb", key, iv);
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(plain.length));
  return Buffer.concat([createHash("md5").update(plain).digest(), len, iv, enc]);
}

export interface EncPckEntry {
  name: string;
  data: Buffer;
  encrypt?: boolean;
}

export interface EncPckOptions {
  version: 2 | 4;
  key?: Buffer;
  encryptDir?: boolean;
}

const pad4 = (n: number) => (4 - (n % 4)) % 4;

/** v2: inline directory after the header; v4: directory at dir_offset after the files (REL_FILEBASE) */
export function buildGodotPck(entries: EncPckEntry[], opts: EncPckOptions): Buffer {
  const { version, key } = opts;
  const headerLen = version === 2 ? 96 : 104;
  const flags = 2 | (opts.encryptDir ? 1 : 0);

  const blobs = entries.map((e) => (e.encrypt ? godotEncrypt(e.data, key!) : e.data));

  const buildIndex = (offsets: number[]): Buffer => {
    const parts: Buffer[] = [Buffer.alloc(4)];
    parts[0].writeUInt32LE(entries.length);
    entries.forEach((e, i) => {
      const name = Buffer.concat([Buffer.from(e.name), Buffer.alloc(pad4(Buffer.byteLength(e.name)))]);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(name.length);
      const meta = Buffer.alloc(36);
      meta.writeBigUInt64LE(BigInt(offsets[i]), 0);
      meta.writeBigUInt64LE(BigInt(e.data.length), 8); // plaintext length, like the packer records
      createHash("md5").update(e.data).digest().copy(meta, 16);
      meta.writeUInt32LE(e.encrypt ? 1 : 0, 32);
      parts.push(len, name, meta);
    });
    const raw = Buffer.concat(parts);
    return opts.encryptDir ? godotEncrypt(raw, key!) : raw;
  };

  // Directory size does not depend on the offsets, so build once to measure it
  const indexLen = buildIndex(entries.map(() => 0)).length;
  const header = Buffer.alloc(headerLen);
  header.writeUInt32LE(GDPC_MAGIC, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(4, 8);
  header.writeUInt32LE(3, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(flags, 20);

  const fileBase = 16 * Math.ceil((headerLen + (version === 2 ? indexLen : 0)) / 16);
  header.writeBigUInt64LE(BigInt(fileBase), 24);

  const offsets: number[] = [];
  let ofs = 0;
  for (const b of blobs) {
    offsets.push(ofs);
    ofs += b.length;
  }

  if (version === 2) {
    const idx = buildIndex(offsets);
    return Buffer.concat([header, idx, Buffer.alloc(fileBase - headerLen - idx.length), ...blobs]);
  }
  header.writeBigUInt64LE(BigInt(fileBase + ofs), 32);
  return Buffer.concat([header, Buffer.alloc(fileBase - headerLen), ...blobs, buildIndex(offsets)]);
}

/** Godot 4 style .ctex: 36-byte GST2 header, data format, size fields, then one PNG/WebP mip */
export function buildCtex(payload: Buffer, kind: "png" | "webp" | "vram"): Buffer {
  const head = Buffer.alloc(36);
  head.write("GST2", 0, "ascii");
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(8, 8);
  head.writeUInt32LE(8, 12);
  head.writeUInt32LE(0x100000, 16);
  head.writeInt32LE(-1, 20);
  const fields = Buffer.alloc(16);
  fields.writeUInt32LE(kind === "png" ? 1 : kind === "webp" ? 2 : 0, 0);
  fields.writeUInt16LE(8, 4);
  fields.writeUInt16LE(8, 6);
  fields.writeUInt32LE(1, 8);
  fields.writeUInt32LE(5, 12);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([head, fields, size, payload]);
}

export function buildWebpLike(body: Buffer): Buffer {
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WEBP", 8, "ascii");
  return Buffer.concat([riff, body]);
}

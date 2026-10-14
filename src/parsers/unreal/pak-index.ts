import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createDecipheriv } from "node:crypto";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { UnrealPakParser, type UnrealPakInfo } from "./pak-parser.js";
import { categorizeExtension, copyRangeToFile, resolveSafeOutputPath } from "../../utils/file-utils.js";
import type { AssetItem } from "../../types/index.js";

/**
 * Native reader for Unreal Engine .pak primary indexes (pak versions 1-11) and extraction of
 * stored / Zlib / Gzip entries, optionally AES-256 (ECB) encrypted. Layout follows UE's
 * FPakFile / FPakEntry and trumank/repak (pak.rs, entry.rs); Oodle and other codecs are reported
 * as unsupported so callers can fall back to the repak CLI.
 */

const inflateAsync = promisify(zlib.inflate);
const gunzipAsync = promisify(zlib.gunzip);

export const MAX_SUPPORTED_PAK_VERSION = 11;
const MAX_FSTRING = 32768;
const AES_BLOCK = 16;
const DECRYPT_CHUNK = 1024 * 1024; // multiple of 16

export type PakErrorCode =
  | "key-required"
  | "bad-key"
  | "invalid-key-format"
  | "unsupported"
  | "corrupt";

export class PakIndexError extends Error {
  constructor(
    readonly code: PakErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PakIndexError";
  }
}

export interface PakBlock {
  /** Absolute file offsets of the (possibly encrypted) compressed block */
  start: number;
  end: number;
}

export interface PakEntry {
  /** Path relative to the mount point (forward slashes) */
  path: string;
  /** Mount point with leading "../" segments stripped, plus the relative path: the on-disk layout repak uses */
  displayPath: string;
  /** Absolute file offset of the in-data FPakEntry header */
  offset: number;
  /** Absolute file offset of the first data byte (after the in-data header) */
  dataOffset: number;
  /** Stored (compressed) size, not padded for encryption */
  compressedSize: number;
  uncompressedSize: number;
  /** Compression codec name ("Zlib", "Oodle", ...) or null when stored */
  compression: string | null;
  blocks: PakBlock[];
  blockSize: number;
  encrypted: boolean;
  /** false for v10+ paks that only carry the path hash index (names are placeholders) */
  nameKnown: boolean;
}

export interface PakIndex {
  pakPath: string;
  version: number;
  mountPoint: string;
  entries: PakEntry[];
  indexEncrypted: boolean;
  compressionSlots: string[];
  /** v10+: true when the names came from the full directory index */
  hasFullDirectoryIndex: boolean;
  info: UnrealPakInfo;
}

// ---------------------------------------------------------------------------------------------
// Keys & AES
// ---------------------------------------------------------------------------------------------

/**
 * Parse an AES-256 key given as hex (64 chars, optional 0x prefix) or base64 (32 bytes)
 */
export function parseAesKey(input: string | Buffer): Buffer {
  if (Buffer.isBuffer(input)) {
    if (input.length !== 32) throw new PakIndexError("invalid-key-format", "AES key must be 32 bytes (AES-256).");
    return input;
  }
  const s = input.trim();
  const hex = s.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, "hex");
  if ((s.length === 44 || s.length === 43) && /^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    const raw = Buffer.from(s, "base64");
    if (raw.length === 32) return raw;
  }
  throw new PakIndexError(
    "invalid-key-format",
    "Invalid AES key: expected 64 hex characters (optionally prefixed with 0x) or a base64-encoded 32-byte key."
  );
}

function decryptEcb(data: Buffer, key: Buffer): Buffer {
  if (data.length % AES_BLOCK !== 0) {
    throw new PakIndexError("corrupt", "Encrypted data length is not a multiple of the AES block size.");
  }
  const decipher = createDecipheriv("aes-256-ecb", key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

const align16 = (n: number): number => Math.ceil(n / AES_BLOCK) * AES_BLOCK;

// ---------------------------------------------------------------------------------------------
// Binary cursor
// ---------------------------------------------------------------------------------------------

class Cursor {
  constructor(
    readonly buf: Buffer,
    public pos = 0
  ) {}

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new PakIndexError("corrupt", "Unexpected end of pak index data.");
    }
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.pos++);
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  u64(): number {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PakIndexError("corrupt", "64-bit value out of range.");
    return Number(v);
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  /** Unreal FString: i32 length (negative = UTF-16 code units), NUL terminated */
  fstring(): string {
    const len = this.i32();
    if (len === 0) return "";
    if (len === -2147483648 || Math.abs(len) > MAX_FSTRING) {
      throw new PakIndexError("corrupt", "Implausible string length in pak index.");
    }
    if (len < 0) {
      const units = -len;
      this.need(units * 2);
      const s = this.buf.toString("utf16le", this.pos, this.pos + (units - 1) * 2);
      this.pos += units * 2;
      return s;
    }
    this.need(len);
    const s = this.buf.toString("utf8", this.pos, this.pos + len - 1);
    this.pos += len;
    return s;
  }
}

// ---------------------------------------------------------------------------------------------
// Entry records
// ---------------------------------------------------------------------------------------------

/**
 * Serialized size of an FPakEntry record: offset, sizes, compression id, [timestamp v1], sha1,
 * [block table], flags and block size (v3+).
 */
function entryHeaderSize(version: number, v8a: boolean, compressed: boolean, blockCount: number): number {
  let size = 8 + 8 + 8 + (v8a ? 1 : 4) + (version === 1 ? 8 : 0) + 20;
  if (version >= 3) {
    if (compressed) size += 4 + 16 * blockCount;
    size += 1 + 4;
  }
  return size;
}

interface RawEntry {
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  compression: string | null;
  blocks: PakBlock[];
  blockSize: number;
  encrypted: boolean;
  deleted: boolean;
}

function compressionName(raw: number, version: number, slots: string[]): string {
  if (version >= 8) {
    return slots[raw - 1] || `unknown(${raw})`;
  }
  if (raw === 2) return "Gzip";
  if (raw === 4) return "Oodle";
  if ((raw & 0x01) !== 0 || raw === 0x10 || raw === 0x20) return "Zlib";
  return `unknown(${raw})`;
}

/** Classic (non encoded) FPakEntry record as stored in the index of every version */
function readRecord(c: Cursor, version: number, v8a: boolean, slots: string[]): RawEntry {
  const offset = c.u64();
  const compressedSize = c.u64();
  const uncompressedSize = c.u64();
  const rawCompression = v8a ? c.u8() : c.u32();
  if (version === 1) c.skip(8); // timestamp
  c.skip(20); // sha1
  const compression = rawCompression === 0 ? null : compressionName(rawCompression, version, slots);

  const relative = version >= 5; // RelativeChunkOffsets
  const blocks: PakBlock[] = [];
  if (version >= 3 && rawCompression !== 0) {
    const count = c.u32();
    if (count > 1_000_000) throw new PakIndexError("corrupt", "Implausible compression block count.");
    for (let i = 0; i < count; i++) {
      const start = c.u64();
      const end = c.u64();
      blocks.push({ start: (relative ? offset : 0) + start, end: (relative ? offset : 0) + end });
    }
  }
  let flags = 0;
  let blockSize = 0;
  if (version >= 3) {
    flags = c.u8();
    blockSize = c.u32();
  }
  return {
    offset,
    compressedSize,
    uncompressedSize,
    compression,
    blocks,
    blockSize,
    encrypted: (flags & 1) !== 0,
    deleted: (flags & 2) !== 0
  };
}

/** Bit-packed entry of the v10+ encoded entries blob (UE FPakEntry::DecodeFrom / repak read_encoded) */
function decodeEncodedEntry(blob: Buffer, at: number, version: number, slots: string[]): RawEntry {
  const c = new Cursor(blob, at);
  const bits = c.u32();
  const methodIndex = (bits >>> 23) & 0x3f;
  const encrypted = (bits & (1 << 22)) !== 0;
  const blockCount = (bits >>> 6) & 0xffff;
  const sizeField = bits & 0x3f;
  const blockSize = sizeField === 0x3f ? c.u32() : sizeField * 2048;

  const wide = (bit: number): number => (((bits >>> bit) & 1) !== 0 ? c.u32() : c.u64());
  const offset = wide(31);
  const uncompressedSize = wide(30);
  const compressedSize = methodIndex === 0 ? uncompressedSize : wide(29);

  const header = entryHeaderSize(version, false, methodIndex !== 0, blockCount);
  const blocks: PakBlock[] = [];
  if (blockCount === 1 && !encrypted) {
    blocks.push({ start: offset + header, end: offset + header + compressedSize });
  } else if (blockCount > 0) {
    let cursor = offset + header;
    for (let i = 0; i < blockCount; i++) {
      const size = c.u32();
      blocks.push({ start: cursor, end: cursor + size });
      cursor += encrypted ? align16(size) : size;
    }
  }
  return {
    offset,
    compressedSize,
    uncompressedSize,
    compression: methodIndex === 0 ? null : compressionName(methodIndex, version, slots),
    blocks,
    blockSize: methodIndex === 0 ? 0 : blockSize,
    encrypted,
    deleted: false
  };
}

// ---------------------------------------------------------------------------------------------
// Index parsing
// ---------------------------------------------------------------------------------------------

function normalizeMount(mountPoint: string): string {
  let m = mountPoint.replace(/\\/g, "/");
  while (m.startsWith("../")) m = m.slice(3);
  m = m.replace(/^\.\/+/, "").replace(/^\/+/, "");
  return m.length > 0 && !m.endsWith("/") ? `${m}/` : m;
}

function plausibleMountPoint(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return s.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f�]/.test(s);
}

async function readRange(fh: fs.FileHandle, offset: number, length: number, what: string): Promise<Buffer> {
  const size = (await fh.stat()).size;
  if (offset < 0 || length < 0 || offset + length > size) {
    throw new PakIndexError("corrupt", `${what} lies outside the pak file.`);
  }
  const buf = Buffer.alloc(length);
  if (length > 0) {
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    if (bytesRead !== length) throw new PakIndexError("corrupt", `Short read while loading ${what}.`);
  }
  return buf;
}

async function loadIndexSection(
  fh: fs.FileHandle,
  offset: number,
  size: number,
  encrypted: boolean,
  key: Buffer | undefined,
  what: string
): Promise<Buffer> {
  const fileSize = (await fh.stat()).size;
  const length = encrypted ? Math.min(align16(size), Math.max(0, fileSize - offset)) : size;
  const raw = await readRange(fh, offset, length, what);
  if (!encrypted) return raw;
  return decryptEcb(raw.subarray(0, Math.floor(raw.length / AES_BLOCK) * AES_BLOCK), key!);
}

function finalize(
  raw: RawEntry,
  relPath: string,
  mountPrefix: string,
  version: number,
  v8a: boolean,
  nameKnown: boolean
): PakEntry {
  const compressed = raw.compression !== null;
  const header = entryHeaderSize(version, v8a, compressed, compressed ? raw.blocks.length : 0);
  return {
    path: relPath,
    displayPath: `${mountPrefix}${relPath}`,
    offset: raw.offset,
    dataOffset: raw.offset + header,
    compressedSize: raw.compressedSize,
    uncompressedSize: raw.uncompressedSize,
    compression: raw.compression,
    blocks: raw.blocks,
    blockSize: raw.blockSize,
    encrypted: raw.encrypted,
    nameKnown
  };
}

export interface ReadPakIndexOptions {
  /** AES-256 key (hex with/without 0x, or base64) for an encrypted index */
  aesKey?: string | Buffer;
}

/**
 * Read the primary index of a pak (v1-v11). Throws PakIndexError with a code:
 * key-required / bad-key / invalid-key-format for key problems, unsupported / corrupt otherwise.
 */
export async function readPakIndex(pakPath: string, options: ReadPakIndexOptions = {}): Promise<PakIndex> {
  const info = await UnrealPakParser.readPakInfo(pakPath);
  if (!info) throw new PakIndexError("unsupported", "No Unreal pak footer found (not an Unreal .pak file).");
  if (info.version > MAX_SUPPORTED_PAK_VERSION) {
    throw new PakIndexError("unsupported", `Pak version ${info.version} is not supported by the native reader.`);
  }

  const version = info.version;
  const slots = info.compressionSlots ?? [];
  const v8a = version === 8 && slots.length === 4;
  const indexOffset = Number(info.indexOffset);
  const indexSize = Number(info.indexSize);
  const encrypted = info.isEncrypted;

  let key: Buffer | undefined;
  if (options.aesKey !== undefined && options.aesKey !== "") key = parseAesKey(options.aesKey);
  if (encrypted && !key) {
    throw new PakIndexError("key-required", "The pak index is AES encrypted: an AES-256 key is required (--aes-key).");
  }

  const fh = await fs.open(pakPath, "r");
  try {
    const indexBuf = await loadIndexSection(fh, indexOffset, indexSize, encrypted, key, "Pak index");
    const c = new Cursor(indexBuf);

    let mountPoint: string;
    try {
      mountPoint = c.fstring();
    } catch (err) {
      if (encrypted) throw new PakIndexError("bad-key", "Wrong AES key: the decrypted index does not start with a valid mount point.");
      throw err;
    }
    if (!plausibleMountPoint(mountPoint)) {
      throw new PakIndexError(
        encrypted ? "bad-key" : "corrupt",
        encrypted
          ? "Wrong AES key: the decrypted mount point is not valid text."
          : "The pak index mount point is not valid text."
      );
    }
    const mountPrefix = normalizeMount(mountPoint);

    const entries: PakEntry[] = [];
    let hasFullDirectoryIndex = false;

    try {
      const entryCount = c.u32();
      if (entryCount > 50_000_000) throw new PakIndexError("corrupt", "Implausible entry count.");

      if (version < 10) {
        for (let i = 0; i < entryCount; i++) {
          const name = c.fstring().replace(/\\/g, "/");
          const raw = readRecord(c, version, v8a, slots);
          if (!raw.deleted) entries.push(finalize(raw, name, mountPrefix, version, v8a, true));
        }
      } else {
        c.skip(8); // path hash seed
        let pathHashLoc: { offset: number; size: number } | null = null;
        let fullDirLoc: { offset: number; size: number } | null = null;
        if (c.u32() !== 0) {
          pathHashLoc = { offset: c.u64(), size: c.u64() };
          c.skip(20);
        }
        if (c.u32() !== 0) {
          fullDirLoc = { offset: c.u64(), size: c.u64() };
          c.skip(20);
        }
        const encodedSize = c.u32();
        const encodedStart = c.pos;
        c.skip(encodedSize);
        const encoded = indexBuf.subarray(encodedStart, encodedStart + encodedSize);
        const nonEncodedCount = c.u32();
        const nonEncoded: RawEntry[] = [];
        for (let i = 0; i < nonEncodedCount; i++) nonEncoded.push(readRecord(c, version, false, slots));

        const resolve = (location: number): RawEntry => {
          if (location >= 0) return decodeEncodedEntry(encoded, location, version, slots);
          const idx = -location - 1;
          const raw = nonEncoded[idx];
          if (!raw) throw new PakIndexError("corrupt", "Entry location points outside the non-encoded entry list.");
          return raw;
        };

        if (fullDirLoc) {
          hasFullDirectoryIndex = true;
          const dirBuf = await loadIndexSection(fh, fullDirLoc.offset, fullDirLoc.size, encrypted, key, "Full directory index");
          const dc = new Cursor(dirBuf);
          const dirCount = dc.u32();
          for (let d = 0; d < dirCount; d++) {
            const dir = dc.fstring().replace(/\\/g, "/").replace(/^\/+/, "");
            const fileCount = dc.u32();
            for (let f = 0; f < fileCount; f++) {
              const file = dc.fstring();
              const location = dc.i32();
              const raw = resolve(location);
              if (!raw.deleted) entries.push(finalize(raw, `${dir}${file}`, mountPrefix, version, false, true));
            }
          }
        } else if (pathHashLoc) {
          // Only hashes are stored: list the entries under placeholder names
          const hashBuf = await loadIndexSection(fh, pathHashLoc.offset, pathHashLoc.size, encrypted, key, "Path hash index");
          const hc = new Cursor(hashBuf);
          const count = hc.u32();
          for (let i = 0; i < count; i++) {
            const hash = hc.buf.readBigUInt64LE(hc.pos);
            hc.skip(8);
            const location = hc.i32();
            const raw = resolve(location);
            const name = `unnamed/${hash.toString(16).padStart(16, "0")}.bin`;
            if (!raw.deleted) entries.push(finalize(raw, name, mountPrefix, version, false, false));
          }
        }
      }
    } catch (err) {
      if (err instanceof PakIndexError && err.code === "corrupt" && encrypted) {
        throw new PakIndexError("bad-key", `Wrong AES key or corrupt index (${err.message})`);
      }
      throw err;
    }

    return {
      pakPath,
      version,
      mountPoint,
      entries,
      indexEncrypted: encrypted,
      compressionSlots: slots,
      hasFullDirectoryIndex,
      info
    };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

/**
 * Codecs the native extractor can decode; everything else needs the repak CLI
 */
export function isNativeCompression(name: string | null): boolean {
  if (name === null) return true;
  const n = name.toLowerCase();
  return n === "zlib" || n === "gzip";
}

async function readAt(fh: fs.FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
    if (bytesRead === 0) throw new PakIndexError("corrupt", "Entry data lies beyond the end of the pak file.");
    done += bytesRead;
  }
  return buf;
}

async function writeStoredEncrypted(
  fh: fs.FileHandle,
  entry: PakEntry,
  key: Buffer,
  out: fs.FileHandle
): Promise<void> {
  const decipher = createDecipheriv("aes-256-ecb", key, null);
  decipher.setAutoPadding(false);
  const padded = align16(entry.uncompressedSize);
  let read = 0;
  let written = 0;
  while (read < padded) {
    const want = Math.min(DECRYPT_CHUNK, padded - read);
    const plain = decipher.update(await readAt(fh, entry.dataOffset + read, want));
    read += want;
    const keep = Math.min(plain.length, entry.uncompressedSize - written);
    if (keep > 0) await out.write(plain, 0, keep);
    written += Math.max(0, keep);
  }
}

/**
 * Extract one entry to destPath (parent directories are created). Throws PakIndexError
 * ("unsupported") for codecs other than stored/Zlib/Gzip and ("key-required") when the entry
 * is encrypted but no key was given.
 */
export async function extractPakEntry(
  pakPath: string,
  entry: PakEntry,
  destPath: string,
  options: { aesKey?: string | Buffer } = {}
): Promise<void> {
  if (!isNativeCompression(entry.compression)) {
    throw new PakIndexError("unsupported", `Compression '${entry.compression}' is not supported natively (use repak).`);
  }
  let key: Buffer | undefined;
  if (options.aesKey !== undefined && options.aesKey !== "") key = parseAesKey(options.aesKey);
  if (entry.encrypted && !key) {
    throw new PakIndexError("key-required", "This entry is AES encrypted: an AES-256 key is required (--aes-key).");
  }

  const fh = await fs.open(pakPath, "r");
  try {
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    if (entry.compression === null) {
      if (!entry.encrypted) {
        await copyRangeToFile(fh, entry.dataOffset, entry.uncompressedSize, destPath);
        return;
      }
      const out = await fs.open(destPath, "w");
      try {
        await writeStoredEncrypted(fh, entry, key!, out);
      } finally {
        await out.close();
      }
      return;
    }

    const blocks = entry.blocks.length > 0 ? entry.blocks : [{ start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize }];
    const gzip = entry.compression.toLowerCase() === "gzip";
    const out = await fs.open(destPath, "w");
    let total = 0;
    try {
      for (const block of blocks) {
        const len = block.end - block.start;
        if (len < 0) throw new PakIndexError("corrupt", "Negative compression block size.");
        let data = await readAt(fh, block.start, entry.encrypted ? align16(len) : len);
        if (entry.encrypted) data = decryptEcb(data, key!).subarray(0, len);
        let plain: Buffer;
        try {
          plain = gzip ? await gunzipAsync(data) : await inflateAsync(data);
        } catch (err) {
          throw new PakIndexError(
            "corrupt",
            `Could not decompress block (${err instanceof Error ? err.message : String(err)})${entry.encrypted ? "; wrong AES key?" : ""}`
          );
        }
        await out.write(plain);
        total += plain.length;
      }
    } finally {
      await out.close();
    }
    if (total !== entry.uncompressedSize) {
      throw new PakIndexError("corrupt", `Decompressed size ${total} does not match the expected ${entry.uncompressedSize}.`);
    }
  } finally {
    await fh.close();
  }
}

/**
 * Extract a set of entries below outputDir with path-traversal protection
 */
export async function extractPakEntries(
  pakPath: string,
  entries: PakEntry[],
  outputDir: string,
  options: { aesKey?: string | Buffer } = {}
): Promise<{ extracted: PakEntry[]; errors: Array<{ entry: PakEntry; error: PakIndexError | Error }> }> {
  const extracted: PakEntry[] = [];
  const errors: Array<{ entry: PakEntry; error: PakIndexError | Error }> = [];
  for (const entry of entries) {
    const dest = resolveSafeOutputPath(outputDir, entry.displayPath);
    if (!dest) {
      errors.push({ entry, error: new Error("Unsafe entry path rejected (escapes the output directory)") });
      continue;
    }
    try {
      await extractPakEntry(pakPath, entry, dest, options);
      extracted.push(entry);
    } catch (err) {
      errors.push({ entry, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return { extracted, errors };
}

// ---------------------------------------------------------------------------------------------
// Asset listing & key validation
// ---------------------------------------------------------------------------------------------

export function pakEntryToAssetItem(entry: PakEntry, container?: string): AssetItem {
  return {
    path: entry.displayPath,
    category: categorizeExtension(entry.path),
    size: entry.uncompressedSize,
    offset: entry.offset,
    compressed: entry.compression !== null,
    encrypted: entry.encrypted,
    metadata: {
      ...(container ? { container } : {}),
      compression: entry.compression ?? "none",
      compressedSize: entry.compressedSize,
      nameKnown: entry.nameKnown
    }
  };
}

export interface PakKeyValidation {
  /** true = key proven correct, false = key rejected, null = pak gives no way to verify it */
  valid: boolean | null;
  reason: string;
  version?: number;
  mountPoint?: string;
  entryCount?: number;
  method?: "index" | "entry";
}

/**
 * Check an AES key against a pak. With an encrypted index the key is verified by decrypting the
 * index and sanity checking the mount point. With a plain index it tries the first encrypted entry
 * (Zlib block must inflate, or a stored .uasset/.umap must start with the package tag).
 */
export async function validatePakKey(pakPath: string, aesKey: string | Buffer): Promise<PakKeyValidation> {
  let key: Buffer;
  try {
    key = parseAesKey(aesKey);
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : String(err) };
  }

  let index: PakIndex;
  try {
    index = await readPakIndex(pakPath, { aesKey: key });
  } catch (err) {
    if (err instanceof PakIndexError && err.code === "bad-key") {
      return { valid: false, reason: err.message, method: "index" };
    }
    return { valid: null, reason: err instanceof Error ? err.message : String(err) };
  }

  if (index.indexEncrypted) {
    return {
      valid: true,
      reason: `Index decrypted, mount point '${index.mountPoint}', ${index.entries.length} entries.`,
      version: index.version,
      mountPoint: index.mountPoint,
      entryCount: index.entries.length,
      method: "index"
    };
  }

  const probe = index.entries.find((e) => e.encrypted && isNativeCompression(e.compression));
  if (!probe) {
    return {
      valid: null,
      reason: "The pak index is not encrypted and no encrypted entry could be probed: the key cannot be verified.",
      version: index.version,
      mountPoint: index.mountPoint,
      entryCount: index.entries.length
    };
  }

  const fh = await fs.open(pakPath, "r");
  try {
    if (probe.compression !== null) {
      const block = probe.blocks[0] ?? { start: probe.dataOffset, end: probe.dataOffset + probe.compressedSize };
      const len = block.end - block.start;
      const plain = decryptEcb(await readAt(fh, block.start, align16(len)), key).subarray(0, len);
      try {
        if (probe.compression.toLowerCase() === "gzip") zlib.gunzipSync(plain);
        else zlib.inflateSync(plain);
      } catch {
        return { valid: false, reason: "Decrypting the first encrypted entry did not give a valid Zlib stream.", method: "entry" };
      }
      return { valid: true, reason: "First encrypted entry decrypted to a valid compressed stream.", version: index.version, mountPoint: index.mountPoint, entryCount: index.entries.length, method: "entry" };
    }
    if (/\.(uasset|umap)$/i.test(probe.path) && probe.uncompressedSize >= 4) {
      const head = decryptEcb(await readAt(fh, probe.dataOffset, AES_BLOCK), key);
      const ok = head.readUInt32LE(0) === 0x9e2a83c1;
      return {
        valid: ok,
        reason: ok ? "First encrypted .uasset decrypted to a valid package tag." : "Decrypting the first encrypted .uasset did not give a package tag.",
        version: index.version,
        mountPoint: index.mountPoint,
        entryCount: index.entries.length,
        method: "entry"
      };
    }
    return { valid: null, reason: "The first encrypted entry is stored without a known signature: the key cannot be verified.", version: index.version, mountPoint: index.mountPoint, entryCount: index.entries.length };
  } catch (err) {
    return { valid: null, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Fast key verification for many candidates (REA scanner)
// ---------------------------------------------------------------------------------------------

export type PakKeyVerifier = (key: string | Buffer) => Promise<PakKeyValidation>;

/**
 * Prepare a verifier for one pak so thousands of candidate keys can be tried cheaply. With an
 * encrypted index only the first block of the index is decrypted per candidate (mount point sanity
 * check); a match is then confirmed with the full validatePakKey. Plain-index paks fall back to
 * probing an encrypted entry.
 */
export async function createPakKeyVerifier(pakPath: string): Promise<PakKeyVerifier> {
  const info = await UnrealPakParser.readPakInfo(pakPath);
  if (!info) throw new PakIndexError("unsupported", "No Unreal pak footer found (not an Unreal .pak file).");

  if (!info.isEncrypted) {
    return (key) => validatePakKey(pakPath, key);
  }

  const headLen = Math.min(Number(info.indexSize), 1024) & ~(AES_BLOCK - 1);
  const fh = await fs.open(pakPath, "r");
  let head: Buffer;
  try {
    head = await readRange(fh, Number(info.indexOffset), headLen, "Pak index");
  } finally {
    await fh.close();
  }

  return async (candidate) => {
    let key: Buffer;
    try {
      key = parseAesKey(candidate);
    } catch (err) {
      return { valid: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const plain = decryptEcb(head, key);
    const len = plain.length >= 4 ? plain.readInt32LE(0) : 0;
    let plausible = false;
    if (len > 0 && len <= 1024 && 4 + len <= plain.length) {
      const text = plain.subarray(4, 4 + len);
      plausible = text[len - 1] === 0 && plausibleMountPoint(text.subarray(0, len - 1).toString("utf8"));
    } else if (len < 0 && len >= -512 && 4 - len * 2 <= plain.length) {
      const text = plain.subarray(4, 4 + -len * 2);
      plausible = text.readUInt16LE(text.length - 2) === 0 && plausibleMountPoint(text.subarray(0, text.length - 2).toString("utf16le"));
    }
    if (!plausible) return { valid: false, reason: "Index mount point does not decrypt to valid text.", method: "index" };
    return validatePakKey(pakPath, key);
  };
}

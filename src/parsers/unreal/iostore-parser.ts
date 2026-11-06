import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertSafeOutputPath, SecurityError } from "../../utils/file-utils.js";
import type { AssetItem } from "../../types/index.js";

/**
 * Unreal Engine IoStore containers: the `.utoc` table of contents beside each `.ucas` data file
 * (UE 4.26+ Zen/IoStore packaging).
 *
 * Clean-room TypeScript port of craft-anything crates/formats/src/unreal_iostore.rs
 * (commit fc93bd0, MIT OR Apache-2.0), extended with chunk extraction (the upstream module only
 * lists). Layout, as read there:
 *
 * The TOC starts with a 144-byte header (magic `-==--==--==--==-`, version, counts, the
 * compression block size, the directory index size, container flags). Then, in order: a 12-byte
 * chunk id per chunk, a 10-byte offset-and-length per chunk (two 40-bit big-endian numbers), from
 * version 4 the perfect-hash seeds and from 5 the chunks outside the perfect hash, the 12-byte
 * compression blocks, the compression method names, for signed containers the signatures, and
 * (from version 2, when indexed) the directory index: the mount point, a tree of directories and
 * files whose names live in a string table, each file pointing at its chunk.
 *
 * An encrypted container's directory index is encrypted too: it is reported, not decrypted
 * (AES-256 keys for IoStore are only available through the game itself; .pak keeps native AES
 * support in pak-index.ts).
 */

export const IOSTORE_TOC_MAGIC = "-==--==--==--==-";
export const IOSTORE_TOC_HEADER_SIZE = 144;
export const IOSTORE_MAX_TOC_VERSION = 8;

export type IoStoreErrorCode = "unsupported" | "corrupt" | "not-found";

export class IoStoreError extends Error {
  constructor(
    readonly code: IoStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IoStoreError";
  }
}

export interface IoStoreFlags {
  compressed: boolean;
  encrypted: boolean;
  signed: boolean;
  indexed: boolean;
}

export interface IoStoreTocHeader {
  version: number;
  chunkCount: number;
  blockCount: number;
  blockSize: number;
  directoryIndexSize: number;
  partitionCount: number;
  partitionSize: number;
  flags: IoStoreFlags;
  /** The key's GUID as 32 hex chars, when one is named (all zeros otherwise). */
  encryptionKeyGuid: string;
  /** Raw field values used when walking the TOC body (not part of the public layout summary). */
  methodCount: number;
  methodLength: number;
  hashSeeds: number;
  withoutHash: number;
}

/** A compression block: where it is in the `.ucas`, its sizes and its method (0 is none). */
export interface IoStoreBlock {
  offset: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
}

/** One file the directory index names. */
export interface IoStoreFile {
  /** The mount point, its directories and its name, as stored ("../../../Game/B.uasset"). */
  path: string;
  /** Path with leading "../" mount segments stripped: the on-disk layout used for extraction. */
  displayPath: string;
  /** Bytes once uncompressed. */
  size: number;
  /** Bytes stored in the `.ucas` (its blocks' compressed sizes). */
  storedSize: number;
  /** The chunk's first block's method: "none", a name from the TOC, or "method <n>". */
  compression: string;
  /** The chunk it points at. */
  chunk: number;
}

export interface IoStoreToc {
  header: IoStoreTocHeader;
  /** Offset (in the uncompressed stream) and length of each chunk. */
  chunks: Array<[number, number]>;
  blocks: IoStoreBlock[];
  methods: string[];
  /** The directory index as stored (encrypted when the container is). */
  directoryIndex: Buffer;
}

// ---------------------------------------------------------------------------------------------
// Binary cursor
// ---------------------------------------------------------------------------------------------

const MAX_STRING = 4096;
const NONE = 0xffffffff;

class Cursor {
  constructor(
    readonly buf: Buffer,
    public pos = 0
  ) {}

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) {
      throw new IoStoreError("corrupt", `Unexpected end of data while reading at offset ${this.pos} (+${n}).`);
    }
  }

  take(n: number): Buffer {
    this.need(n);
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
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

  /** A non-negative count that fits what's left (`minEach` bytes each). */
  count(what: string, minEach: number): number {
    const n = this.i32();
    if (n < 0) throw new IoStoreError("corrupt", `Negative ${what} count.`);
    if (n * Math.max(1, minEach) > this.buf.length - this.pos) {
      throw new IoStoreError("corrupt", `${what} count ${n} doesn't fit in the remaining data.`);
    }
    return n;
  }

  /** An FString: signed length with its terminating NUL; negative means UTF-16. */
  string(what: string): string {
    const n = this.i32();
    const chars = Math.abs(n);
    if (chars > MAX_STRING) throw new IoStoreError("corrupt", `${what} is ${chars} characters long.`);
    let s: string;
    if (n >= 0) {
      s = this.take(chars).toString("utf8");
    } else {
      const units = this.take(chars * 2);
      s = Buffer.from(units).toString("utf16le");
    }
    return s.replace(/\0+$/, "");
  }
}

/** A 40-bit big-endian number. */
function be40(b: Buffer, at: number): number {
  let n = 0;
  for (let i = 0; i < 5; i++) n = n * 256 + b[at + i]!;
  return n;
}

// ---------------------------------------------------------------------------------------------
// TOC parsing
// ---------------------------------------------------------------------------------------------

/** Read the 144-byte TOC header of a `.utoc` buffer. */
export function readIoStoreTocHeader(data: Buffer): IoStoreTocHeader {
  if (data.length < IOSTORE_TOC_HEADER_SIZE || data.subarray(0, 16).toString("latin1") !== IOSTORE_TOC_MAGIC) {
    throw new IoStoreError("corrupt", "Not an IoStore table of contents (bad magic or too short).");
  }
  const c = new Cursor(data, 16);
  const version = c.u8();
  c.take(3);
  if (version === 0 || version > IOSTORE_MAX_TOC_VERSION) {
    throw new IoStoreError("unsupported", `IoStore TOC version ${version} is not supported (1-${IOSTORE_MAX_TOC_VERSION}).`);
  }
  const headerSize = c.u32();
  if (headerSize !== IOSTORE_TOC_HEADER_SIZE) {
    throw new IoStoreError("unsupported", `Unexpected ${headerSize}-byte TOC header (this reader expects ${IOSTORE_TOC_HEADER_SIZE}).`);
  }
  const chunkCount = c.u32();
  const blockCount = c.u32();
  const blockEntrySize = c.u32();
  if (blockEntrySize !== 12) {
    throw new IoStoreError("unsupported", `${blockEntrySize}-byte compression blocks are not supported.`);
  }
  const methodCount = c.u32();
  const methodLength = c.u32();
  const blockSize = c.u32();
  const directoryIndexSize = c.u32();
  const partitionCount = c.u32();
  c.take(8); // container id
  const encryptionKeyGuid = c.take(16).toString("hex");
  const bits = c.u8();
  c.take(3);
  const hashSeeds = c.u32();
  const partitionSize = c.take(8).readBigUInt64LE(0);
  if (partitionSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IoStoreError("corrupt", "64-bit partition size out of range.");
  }
  const withoutHash = c.u32();
  return {
    version,
    chunkCount,
    blockCount,
    blockSize,
    directoryIndexSize,
    partitionCount,
    partitionSize: Number(partitionSize),
    flags: { compressed: (bits & 1) !== 0, encrypted: (bits & 2) !== 0, signed: (bits & 4) !== 0, indexed: (bits & 8) !== 0 },
    encryptionKeyGuid,
    methodCount,
    methodLength,
    hashSeeds: version >= 4 ? hashSeeds : 0,
    withoutHash: version >= 5 ? withoutHash : 0
  };
}

/** Read the whole table of contents (the `.utoc` file). */
export function readIoStoreToc(data: Buffer): IoStoreToc {
  const header = readIoStoreTocHeader(data);
  const c = new Cursor(data, IOSTORE_TOC_HEADER_SIZE);
  const n = header.chunkCount;
  if (n * 22 > data.length) throw new IoStoreError("corrupt", `${n} chunks don't fit in the TOC.`);
  c.take(n * 12); // chunk ids
  const chunks: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const e = c.take(10);
    chunks.push([be40(e, 0), be40(e, 5)]);
  }
  c.take(header.hashSeeds * 4);
  c.take(header.withoutHash * 4);
  const blocks: IoStoreBlock[] = [];
  for (let i = 0; i < header.blockCount; i++) {
    const b = c.take(12);
    blocks.push({
      offset: b.readUIntLE(0, 5),
      compressedSize: b.readUIntLE(5, 3),
      uncompressedSize: b.readUIntLE(8, 3),
      method: b[11]!
    });
  }
  // A block names its method in one byte, so only the first 255 names can be used; the rest are
  // skipped, never collected (a zero name length would otherwise read billions of empty names).
  const named = Math.min(header.methodCount, 255);
  const methods: string[] = [];
  for (let i = 0; i < named; i++) {
    methods.push(
      c
        .take(header.methodLength)
        .toString("latin1")
        .replace(/\0+$/, "")
    );
  }
  c.take(Math.max(0, header.methodCount - named) * header.methodLength);
  if (header.flags.signed) {
    const hashSize = c.count("signature size", 2);
    c.take(hashSize * 2);
    c.take(header.blockCount * 20);
  }
  const directoryIndex =
    header.version >= 2 && header.flags.indexed && header.directoryIndexSize > 0 ? Buffer.from(c.take(header.directoryIndexSize)) : Buffer.alloc(0);
  return { header, chunks, blocks, methods, directoryIndex };
}

// ---------------------------------------------------------------------------------------------
// Directory index
// ---------------------------------------------------------------------------------------------

/** The stored size and first method of a chunk's blocks. */
function storedInfo(toc: IoStoreToc, chunk: number): [number, string] {
  const location = toc.chunks[chunk];
  if (!location) return [0, "none"];
  const [offset, length] = location;
  const blockSize = Math.max(1, toc.header.blockSize);
  const first = Math.floor(offset / blockSize);
  const count = Math.ceil(length / blockSize);
  const end = Math.min(first + count, toc.blocks.length);
  let size = 0;
  for (let i = first; i < end; i++) size += toc.blocks[i]!.compressedSize;
  const methodIndex = first < toc.blocks.length && count > 0 ? toc.blocks[first]!.method : 0;
  return [size, methodOf(toc, methodIndex)];
}

function methodOf(toc: IoStoreToc, index: number): string {
  if (index === 0) return "none";
  return toc.methods[index - 1] ?? `method ${index}`;
}

/**
 * List the files the (decrypted) directory index names, up to `limit` (the returned `total`
 * counts them all). Throws IoStoreError("unsupported") for an encrypted index.
 */
export function listIoStoreFiles(toc: IoStoreToc, limit: number): { mount: string; files: IoStoreFile[]; total: number } {
  if (toc.header.flags.encrypted) {
    throw new IoStoreError("unsupported", "The directory index is encrypted with the game's AES key (unsupported: IoStore AES keys are game-side).");
  }
  if (!toc.header.flags.indexed || toc.header.version < 2) {
    return { mount: "", files: [], total: 0 };
  }
  const c = new Cursor(toc.directoryIndex, 0);
  const mount = c.string("mount point");
  const dirs: number[][] = [];
  const dirCount = c.count("directories", 16);
  for (let i = 0; i < dirCount; i++) {
    dirs.push([c.u32(), c.u32(), c.u32(), c.u32()]);
  }
  const fileEntries: number[][] = [];
  const fileCount = c.count("files", 12);
  for (let i = 0; i < fileCount; i++) {
    fileEntries.push([c.u32(), c.u32(), c.u32()]);
  }
  const strings: string[] = [];
  const nameCount = c.count("names", 4);
  for (let i = 0; i < nameCount; i++) strings.push(c.string("name"));
  const name = (i: number): string => strings[i] ?? "?";

  const files: IoStoreFile[] = [];
  let total = 0;
  // Depth-first from the root (directory 0); every directory and file is visited at most once,
  // so a damaged index can't loop.
  const stack: Array<[number, string]> = dirs.length > 0 ? [[0, mount]] : [];
  const seenDirs = new Array<boolean>(dirs.length).fill(false);
  const seenFiles = new Array<boolean>(fileEntries.length).fill(false);
  while (stack.length > 0) {
    const [d, dirPath] = stack.pop()!;
    if (d >= dirs.length || seenDirs[d]) continue;
    seenDirs[d] = true;
    const [, firstChild, , firstFile] = dirs[d]!;
    let f = firstFile;
    while (f !== NONE) {
      if (f >= fileEntries.length || seenFiles[f]) break;
      seenFiles[f] = true;
      const [n, next, chunk] = fileEntries[f]!;
      total++;
      if (files.length < limit) {
        const [storedSize, compression] = storedInfo(toc, chunk);
        const filePath = `${dirPath}${name(n)}`;
        const location = toc.chunks[chunk];
        const size = location ? location[1] : 0;
        files.push({ path: filePath, displayPath: normalizeMountPath(filePath), size, storedSize, compression, chunk });
      }
      f = next;
    }
    let child = firstChild;
    let guard = 0;
    while (child !== NONE && child < dirs.length && guard < dirs.length) {
      guard++;
      stack.push([child, `${dirPath}${name(dirs[child]![0])}/`]);
      child = dirs[child]![2];
    }
  }
  return { mount, files, total };
}

/** Strip the leading "../" mount segments and "./" like pak-index does for display paths. */
function normalizeMountPath(p: string): string {
  let m = p.replace(/\\/g, "/");
  while (m.startsWith("../")) m = m.slice(3);
  m = m.replace(/^\.\/+/, "").replace(/^\/+/, "");
  return m;
}

// ---------------------------------------------------------------------------------------------
// Extraction (extension over the upstream listing-only module)
// ---------------------------------------------------------------------------------------------

/** Resolve a `.utoc` path to its sibling `.ucas` data file (same basename). */
export function ucasPathFor(utocPath: string): string {
  const ucas = `${utocPath.slice(0, -".utoc".length)}.ucas`;
  return ucas;
}

async function readAt(fh: fs.FileHandle, offset: number, length: number, what: string): Promise<Buffer> {
  const size = (await fh.stat()).size;
  if (offset < 0 || length < 0 || offset + length > size) {
    throw new IoStoreError("corrupt", `${what} lies outside the .ucas file.`);
  }
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
    if (bytesRead === 0) throw new IoStoreError("corrupt", `Short read while loading ${what}.`);
    done += bytesRead;
  }
  return buf;
}

/**
 * Extract one file's chunk from the `.ucas`: splice its compression blocks (each decompressed
 * with codecs Node supports — stored/deflate/gzip/zstd are handled by the caller's decompressor
 * callback), then cut the chunk's [offset % blockSize, +length) window.
 *
 * `decompress` receives the raw block bytes and the method name and returns the uncompressed
 * block; throw to report an unsupported/corrupt codec. Encrypted blocks must be rejected before
 * reaching here (the TOC flags report them).
 */
export async function extractIoStoreChunk(
  ucasPath: string,
  toc: IoStoreToc,
  chunk: number,
  destPath: string,
  decompress: (data: Buffer, method: string) => Promise<Buffer>
): Promise<void> {
  const location = toc.chunks[chunk];
  if (!location) throw new IoStoreError("corrupt", `Chunk ${chunk} does not exist in the TOC.`);
  const [offset, length] = location;
  const blockSize = Math.max(1, toc.header.blockSize);
  const first = Math.floor(offset / blockSize);
  const count = Math.ceil(length / blockSize);
  if (first + count > toc.blocks.length) {
    throw new IoStoreError("corrupt", `Chunk ${chunk}'s blocks lie outside the TOC block table.`);
  }

  const fh = await fs.open(ucasPath, "r");
  try {
    let plain = Buffer.alloc(0);
    for (let i = first; i < first + count; i++) {
      const block = toc.blocks[i]!;
      const method = methodOf(toc, block.method);
      const raw = await readAt(fh, block.offset, block.compressedSize, `Compression block ${i}`);
      const part = await decompress(raw, method);
      if (part.length !== block.uncompressedSize) {
        throw new IoStoreError("corrupt", `Block ${i} decompressed to ${part.length} bytes, expected ${block.uncompressedSize}.`);
      }
      plain = Buffer.concat([plain, part]);
    }
    const intra = offset - first * blockSize;
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, plain.subarray(intra, intra + length));
  } finally {
    await fh.close();
  }
}

/**
 * Extract a set of files below outputDir with path-traversal protection.
 */
export async function extractIoStoreFiles(
  ucasPath: string,
  toc: IoStoreToc,
  files: IoStoreFile[],
  outputDir: string,
  decompress: (data: Buffer, method: string) => Promise<Buffer>
): Promise<{ extracted: IoStoreFile[]; errors: Array<{ file: IoStoreFile; error: Error }> }> {
  const extracted: IoStoreFile[] = [];
  const errors: Array<{ file: IoStoreFile; error: Error }> = [];
  for (const file of files) {
    let dest: string;
    try {
      dest = assertSafeOutputPath(outputDir, file.displayPath);
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err : new SecurityError(String(err)) });
      continue;
    }
    try {
      await extractIoStoreChunk(ucasPath, toc, file.chunk, dest, decompress);
      extracted.push(file);
    } catch (err) {
      errors.push({ file, error: err instanceof Error ? err : new Error(String(err)) });
    }
  }
  return { extracted, errors };
}

// ---------------------------------------------------------------------------------------------
// Asset mapping
// ---------------------------------------------------------------------------------------------

export function iostoreFileToAssetItem(file: IoStoreFile, container?: string): AssetItem {
  return {
    path: file.displayPath,
    category: categorizeIostorePath(file.path),
    size: file.size,
    encrypted: false, // encrypted containers are reported at the container level, never listed
    metadata: {
      ...(container ? { container } : {}),
      compression: file.compression,
      storedSize: file.storedSize,
      chunk: file.chunk
    }
  };
}

function categorizeIostorePath(p: string): AssetItem["category"] {
  const ext = path.extname(p).toLowerCase();
  if ([".png", ".jpg", ".tga", ".dds", ".exr", ".hdr"].includes(ext)) return "texture";
  if ([".uasset", ".ubulk", ".uptnl", ".uexp"].includes(ext)) return "other";
  if ([".umap"].includes(ext)) return "scene";
  if ([".json", ".ini", ".locres", ".locmeta"].includes(ext)) return "config";
  if ([".usm", ".bk2", ".mp4"].includes(ext)) return "video";
  if ([".wav", ".ogg", ".opus", ".wem", ".bnk", ".fsb"].includes(ext)) return "audio";
  if ([".ttf", ".otf", ".ufont"].includes(ext)) return "font";
  if ([".ushader", ".ushaderbytecode", ".ushadercode"].includes(ext)) return "shader";
  return "other";
}

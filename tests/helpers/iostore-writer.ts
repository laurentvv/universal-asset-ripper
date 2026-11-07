import * as zlib from "node:zlib";

/**
 * Fixture writer for IoStore containers (.utoc/.ucas): mirrors the layout read by
 * src/parsers/unreal/iostore-parser.ts (144-byte header, chunk ids, 40-bit BE chunk
 * offset/length pairs, 12-byte compression blocks, method names, optional signatures and
 * directory index).
 */

export const UTOC_MAGIC = "-==--==--==--==-";
export const UTOC_HEADER_SIZE = 144;
export const BLOCK_ENTRY_SIZE = 12;

export interface IoStoreFixtureBlock {
  /** Bytes as stored in the .ucas. */
  data: Buffer;
  /** Bytes once uncompressed (only used for the block table's uncompressedSize field). */
  uncompressedSize: number;
  /** 0 = none, 1 = first method name, ... */
  method: number;
}

export interface IoStoreFixtureChunk {
  /** Chunk position in the uncompressed stream (should be block-aligned). */
  offset: number;
  /** Chunk length in the uncompressed stream. */
  length: number;
}

export interface IoStoreFixtureDir {
  name: string;
  children: IoStoreFixtureDir[];
  files: Array<{ name: string; chunk: number }>;
}

export interface IoStoreFixtureOptions {
  version?: number;
  flags?: number;
  blockSize?: number;
  methods?: string[];
  chunks: IoStoreFixtureChunk[];
  blocks: IoStoreFixtureBlock[];
  seedsCount?: number;
  withoutHashCount?: number;
  partitionSize?: number;
  /** Method count override (default: methods.length; can exceed the real list). */
  methodCount?: number;
  /** Method name length override (default: max name length + 1). */
  methodLength?: number;
  mount?: string;
  dirs?: IoStoreFixtureDir[];
  files?: Array<{ name: string; chunk: number }>;
  /** Directory index flag override; default: indexed when mount/dirs/files given. */
  indexed?: boolean;
}

function fstring(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const out = Buffer.alloc(4 + bytes.length + 1);
  out.writeInt32LE(bytes.length + 1, 0);
  bytes.copy(out, 4);
  out[4 + bytes.length] = 0;
  return out;
}

function stringTable(names: string[]): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(names.length, 0);
  return Buffer.concat([head, ...names.map(fstring)]);
}

/** Serialize a directory index: mount point + directory tree + file list + string table. */
export function buildDirectoryIndex(mount: string, dirs: IoStoreFixtureDir[], files: Array<{ name: string; chunk: number }>): { buffer: Buffer; stringNames: string[] } {
  const nameOf = new Map<string, number>();
  const intern = (s: string): number => {
    if (!nameOf.has(s)) nameOf.set(s, nameOf.size);
    return nameOf.get(s)!;
  };
  const dirEntries: Array<[number, number, number, number]> = [];
  const fileEntries: Array<[number, number, number]> = [];

  const walk = (dir: IoStoreFixtureDir): number => {
    const index = dirEntries.length;
    dirEntries.push([0, 0, 0, 0]); // placeholder
    intern(dir.name);
    const firstFile = fileEntries.length;
    for (const f of dir.files) fileEntries.push([intern(f.name), NONE, f.chunk]);
    for (let i = firstFile; i < fileEntries.length - 1; i++) fileEntries[i]![1] = i + 1;
    const firstChild = dirEntries.length;
    const childIndices = dir.children.map(walk);
    for (let i = 0; i < childIndices.length - 1; i++) dirEntries[childIndices[i]!]![2] = childIndices[i + 1]!;
    dirEntries[index] = [intern(dir.name), childIndices.length > 0 ? firstChild : NONE, NONE, dir.files.length > 0 ? firstFile : NONE];
    return index;
  };

  // Root directory 0 wraps the given tree; its name is unused by readers that start at 0
  const root: IoStoreFixtureDir = { name: "/", children: dirs, files };
  walk(root);

  const out: Buffer[] = [];
  out.push(fstring(mount));
  const dh = Buffer.alloc(4);
  dh.writeUInt32LE(dirEntries.length, 0);
  out.push(dh);
  for (const [name, firstChild, nextSibling, firstFile] of dirEntries) {
    const e = Buffer.alloc(16);
    e.writeUInt32LE(name, 0);
    e.writeUInt32LE(firstChild, 4);
    e.writeUInt32LE(nextSibling, 8);
    e.writeUInt32LE(firstFile, 12);
    out.push(e);
  }
  const fh = Buffer.alloc(4);
  fh.writeUInt32LE(fileEntries.length, 0);
  out.push(fh);
  for (const [name, next, chunk] of fileEntries) {
    const e = Buffer.alloc(12);
    e.writeUInt32LE(name, 0);
    e.writeUInt32LE(next, 4);
    e.writeUInt32LE(chunk, 8);
    out.push(e);
  }
  out.push(stringTable([...nameOf.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n)));
  return { buffer: Buffer.concat(out), stringNames: [...nameOf.keys()] };
}

const NONE = 0xffffffff;

/** Build a .utoc buffer and its sibling .ucas payload buffer. */
export function buildUtoc(opts: IoStoreFixtureOptions): { utoc: Buffer; ucas: Buffer; dirIndex: Buffer | null } {
  const version = opts.version ?? 8;
  const flags = opts.flags ?? 0x9; // compressed + indexed
  const blockSize = opts.blockSize ?? 65536;
  const methods = opts.methods ?? [];
  const methodCount = opts.methodCount ?? methods.length;
  const methodLength = opts.methodLength ?? Math.max(1, ...methods.map((m) => m.length + 1), 1);
  const indexed = opts.indexed ?? (opts.mount !== undefined || opts.dirs !== undefined || opts.files !== undefined);

  let dirIndex: Buffer | null = null;
  if (indexed && version >= 2) {
    const built = buildDirectoryIndex(opts.mount ?? "../../../", opts.dirs ?? [], opts.files ?? []);
    dirIndex = built.buffer;
  }

  const header = Buffer.alloc(UTOC_HEADER_SIZE);
  Buffer.from(UTOC_MAGIC, "latin1").copy(header, 0);
  header[16] = version;
  header.writeUInt32LE(UTOC_HEADER_SIZE, 20);
  header.writeUInt32LE(opts.chunks.length, 24);
  header.writeUInt32LE(opts.blocks.length, 28);
  header.writeUInt32LE(BLOCK_ENTRY_SIZE, 32);
  header.writeUInt32LE(methodCount, 36);
  header.writeUInt32LE(methodLength, 40);
  header.writeUInt32LE(blockSize, 44);
  header.writeUInt32LE(indexed && dirIndex ? dirIndex.length : 0, 48);
  header.writeUInt32LE(1, 52); // partition count
  header.writeBigUInt64LE(0n, 56); // container id
  header.writeUInt32LE(opts.seedsCount ?? 0, 84);
  header.writeBigUInt64LE(BigInt(opts.partitionSize ?? 0), 88);
  header.writeUInt32LE(opts.withoutHashCount ?? 0, 96);
  header[80] = flags | (indexed ? 8 : 0);

  const body: Buffer[] = [];
  const chunkIds = Buffer.alloc(opts.chunks.length * 12);
  body.push(chunkIds);
  const chunkOffsets = Buffer.alloc(opts.chunks.length * 10);
  opts.chunks.forEach((c, i) => {
    // two 40-bit big-endian numbers: offset, length
    chunkOffsets.writeUIntBE(c.offset, i * 10, 5);
    chunkOffsets.writeUIntBE(c.length, i * 10 + 5, 5);
  });
  body.push(chunkOffsets);
  body.push(Buffer.alloc((opts.seedsCount ?? 0) * 4));
  body.push(Buffer.alloc((opts.withoutHashCount ?? 0) * 4));
  let blockOffset = 0;
  for (const b of opts.blocks) {
    const entry = Buffer.alloc(BLOCK_ENTRY_SIZE);
    entry.writeUIntLE(blockOffset, 0, 5);
    entry.writeUIntLE(b.data.length, 5, 3);
    entry.writeUIntLE(b.uncompressedSize, 8, 3);
    entry[11] = b.method;
    body.push(entry);
    blockOffset += b.data.length;
  }
  for (const m of methods) {
    const slot = Buffer.alloc(methodLength);
    Buffer.from(m, "latin1").copy(slot, 0);
    body.push(slot);
  }
  if ((flags & 4) !== 0) {
    // signed: i32 signature size + sig*2 bytes + blockCount * 20 block signatures
    const sigSize = 20;
    const sizeField = Buffer.alloc(4);
    sizeField.writeInt32LE(sigSize, 0);
    body.push(sizeField, Buffer.alloc(sigSize * 2), Buffer.alloc(opts.blocks.length * 20));
  }
  if (indexed && dirIndex) body.push(dirIndex);

  const ucasParts: Buffer[] = opts.blocks.map((b) => b.data);

  return { utoc: Buffer.concat([header, ...body]), ucas: Buffer.concat(ucasParts), dirIndex };
}

/**
 * Convenience: build a container whose chunks are plain file payloads (optionally compressed
 * with zlib/gzip at block level, method 0 = stored), one chunk per file, block-aligned.
 */
export function buildUtocFromFiles(
  filePayloads: Array<{ path: string; data: Buffer; method?: "none" | "zlib" | "gzip" }>,
  blockSize = 65536
): { utoc: Buffer; ucas: Buffer; expected: Map<string, Buffer> } {
  const methods: string[] = [];
  const methodId = (name: "none" | "zlib" | "gzip"): number => {
    if (name === "none") return 0;
    const idx = methods.indexOf(name === "zlib" ? "Zlib" : "Gzip");
    if (idx >= 0) return idx + 1;
    methods.push(name === "zlib" ? "Zlib" : "Gzip");
    return methods.length;
  };

  const blocks: IoStoreFixtureBlock[] = [];
  const chunks: IoStoreFixtureChunk[] = [];
  const expected = new Map<string, Buffer>();
  let streamOffset = 0;

  for (const f of filePayloads) {
    const chunksForFile: Buffer[] = [];
    for (let at = 0; at < f.data.length; at += blockSize) {
      const slice = f.data.subarray(at, Math.min(at + blockSize, f.data.length));
      const stored = f.method === "zlib" ? zlib.deflateSync(slice) : f.method === "gzip" ? zlib.gzipSync(slice) : slice;
      blocks.push({ data: stored, uncompressedSize: slice.length, method: methodId(f.method ?? "none") });
      chunksForFile.push(slice);
    }
    if (f.data.length === 0) {
      // zero-length file: one empty stored block
      blocks.push({ data: Buffer.alloc(0), uncompressedSize: 0, method: 0 });
      chunksForFile.push(Buffer.alloc(0));
    }
    chunks.push({ offset: streamOffset, length: f.data.length });
    expected.set(f.path, Buffer.concat(chunksForFile));
    streamOffset += Math.max(blockSize, Math.ceil(f.data.length / blockSize) * blockSize);
  }

  const dirs = new Map<string, IoStoreFixtureDir>();
  for (let i = 0; i < filePayloads.length; i++) {
    const parts = filePayloads[i]!.path.split("/");
    const fileName = parts.pop()!;
    const dirPath = parts.join("/");
    if (!dirs.has(dirPath)) dirs.set(dirPath, { name: dirPath, children: [], files: [] });
    dirs.get(dirPath)!.files.push({ name: fileName, chunk: i });
  }
  const rootDirs = [...dirs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, d]) => d);

  const built = buildUtoc({
    methods,
    chunks,
    blocks,
    mount: "../../../",
    dirs: rootDirs,
    blockSize
  });
  return { utoc: built.utoc, ucas: built.ucas, expected };
}


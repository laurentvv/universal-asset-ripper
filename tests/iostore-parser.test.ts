import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  IoStoreError,
  extractIoStoreChunk,
  extractIoStoreFiles,
  listIoStoreFiles,
  readIoStoreToc,
  readIoStoreTocHeader,
  ucasPathFor
} from "../src/parsers/unreal/iostore-parser.js";
import { SecurityError } from "../src/utils/file-utils.js";
import { buildUtoc, buildUtocFromFiles } from "./helpers/iostore-writer.js";

function sampleToc(flags = 0x9, overrides: Partial<Parameters<typeof buildUtoc>[0]> = {}) {
  // Mirrors craft-anything's testkit sample: mount "../../../", chunk0 Game/B.uasset (10 B,
  // Oodle), chunk1 Game/Maps/A.uasset (100000 B, Oodle), chunk2 Game/Maps/A.ubulk (5 B, none).
  return buildUtoc({
    methods: ["Oodle"],
    blockSize: 65536,
    mount: "../../../",
    files: [],
    dirs: [
      {
        name: "Game",
        children: [{ name: "Maps", children: [], files: [{ name: "A.uasset", chunk: 1 }, { name: "A.ubulk", chunk: 2 }] }],
        files: [{ name: "B.uasset", chunk: 0 }]
      }
    ],
    chunks: [
      { offset: 0, length: 10 },
      { offset: 65536, length: 100000 },
      { offset: 196608, length: 5 }
    ],
    blocks: [
      { data: Buffer.alloc(8), uncompressedSize: 65536, method: 1 },
      { data: Buffer.alloc(25000), uncompressedSize: 65536, method: 1 },
      { data: Buffer.alloc(25000), uncompressedSize: 65536, method: 1 },
      { data: Buffer.alloc(5), uncompressedSize: 5, method: 0 }
    ],
    flags,
    ...overrides
  });
}

describe("IoStore TOC header", () => {
  it("parses a version 8 header with its flags", () => {
    const { utoc } = sampleToc(0xb); // compressed + encrypted + indexed
    const h = readIoStoreTocHeader(utoc);
    expect(h.version).toBe(8);
    expect(h.chunkCount).toBe(3);
    expect(h.blockCount).toBe(4);
    expect(h.blockSize).toBe(65536);
    expect(h.flags).toEqual({ compressed: true, encrypted: true, signed: false, indexed: true });
    expect(h.partitionCount).toBe(1);
    expect(h.encryptionKeyGuid).toBe("0".repeat(32));
  });

  it("rejects a bad magic, an unknown version and a wrong header size", () => {
    expect(() => readIoStoreTocHeader(Buffer.alloc(144))).toThrow(IoStoreError);
    expect(() => readIoStoreTocHeader(Buffer.from("-==--==--==--==-"))).toThrow(/bad magic|too short|IoStore/i);
    const { utoc } = sampleToc();
    const badVersion = Buffer.from(utoc);
    badVersion[16] = 99;
    expect(() => readIoStoreTocHeader(badVersion)).toThrow(/version 99/);
    const badSize = Buffer.from(utoc);
    badSize.writeUInt32LE(220, 20);
    expect(() => readIoStoreTocHeader(badSize)).toThrow(/220-byte TOC header/);
  });
});

describe("IoStore TOC body", () => {
  it("reads chunk offsets, blocks and method names of a signed container", () => {
    const { utoc } = sampleToc(0xd); // signed + indexed + compressed
    const toc = readIoStoreToc(utoc);
    expect(toc.methods).toEqual(["Oodle"]);
    expect(toc.chunks).toEqual([
      [0, 10],
      [65536, 100000],
      [196608, 5]
    ]);
    expect(toc.blocks).toHaveLength(4);
    expect(toc.blocks[0]).toEqual({ offset: 0, compressedSize: 8, uncompressedSize: 65536, method: 1 });
    expect(toc.blocks[3]).toEqual({ offset: 50008, compressedSize: 5, uncompressedSize: 5, method: 0 });
    expect(toc.directoryIndex.length).toBeGreaterThan(0);
  });

  it("lists the files of a version 8 container with mount point, sizes and compression", () => {
    for (const flags of [0x9, 0xd]) {
      const { utoc } = sampleToc(flags);
      const toc = readIoStoreToc(utoc);
      const { mount, files, total } = listIoStoreFiles(toc, 10);
      expect([mount, total]).toEqual(["../../../", 3]);
      expect(files.map((f) => [f.path, f.size, f.storedSize, f.compression])).toEqual([
        ["../../../Game/B.uasset", 10, 8, "Oodle"],
        ["../../../Game/Maps/A.uasset", 100000, 50000, "Oodle"],
        ["../../../Game/Maps/A.ubulk", 5, 5, "none"]
      ]);
      expect(files.map((f) => f.displayPath).sort()).toEqual(["Game/B.uasset", "Game/Maps/A.uasset", "Game/Maps/A.ubulk"].sort());
      expect(listIoStoreFiles(toc, 1).files).toHaveLength(1);
    }
    // Unindexed container: no directory index
    const { utoc } = sampleToc(0x1, { indexed: false, mount: undefined, files: undefined, dirs: undefined });
    const toc = readIoStoreToc(utoc);
    expect(listIoStoreFiles(toc, 10)).toEqual({ mount: "", files: [], total: 0 });
  });

  it("refuses an encrypted directory index", () => {
    const { utoc } = sampleToc(0xb); // encrypted + indexed + compressed
    const toc = readIoStoreToc(utoc);
    expect(() => listIoStoreFiles(toc, 10)).toThrow(/directory index is encrypted/);
  });

  it("survives a directory index whose chains loop back on themselves", () => {
    // Corrupt the well-formed index: file 0's next pointer and the root's first child point
    // back at entries already visited. The visited guards keep the walk finite.
    const { utoc, dirIndex } = buildUtoc({
      methods: [],
      blockSize: 65536,
      mount: "../../../",
      files: [
        { name: "B.uasset", chunk: 0 },
        { name: "A.uasset", chunk: 1 },
        { name: "A.ubulk", chunk: 2 }
      ],
      dirs: [],
      chunks: [
        { offset: 0, length: 10 },
        { offset: 65536, length: 100000 },
        { offset: 196608, length: 5 }
      ],
      blocks: []
    });
    expect(dirIndex).not.toBeNull();
    const patch = Buffer.from(dirIndex!);
    // Layout: mount FString (4 + 9 + 1 = 14 bytes) | dirs count (4) | dir entries (16 each)
    // | files count (4) | file entries (12 each)
    const dirsCountAt = 14;
    const dirsEntriesAt = dirsCountAt + 4;
    const dirsCount = patch.readUInt32LE(dirsCountAt);
    const filesCountAt = dirsEntriesAt + dirsCount * 16;
    const filesEntriesAt = filesCountAt + 4;
    // Root dir (entry 0): firstChild at +4 — point it back at the root itself
    patch.writeUInt32LE(0, dirsEntriesAt + 4);
    // File 0: next at +4 — loop the chain onto itself (chain cut at the first repeat)
    patch.writeUInt32LE(0, filesEntriesAt + 4);
    const toc = readIoStoreToc(utoc);
    toc.directoryIndex = patch;
    const { total } = listIoStoreFiles(toc, 10);
    // The loop cut the file chain at the first repeat: file 0 visited once, files 1-2 orphaned
    // by the corrupted next pointer — but the walk terminated, which is what the guard is for.
    expect(total).toBe(1);
  });

  it("skips method names beyond the 255 a block can reference without collecting them", () => {
    const { utoc: base, dirIndex } = sampleToc(0x9);
    // The sample's one 6-byte method name ("Oodle" + NUL) sits right after the block table:
    // 144 header + 3*12 ids + 3*10 offsets + 4*12 blocks = 258
    const methodAt = 258;

    // method count 0x80000000 with name length 0: 255 empty names collected, body still reads
    const huge = Buffer.from(base);
    huge.writeUInt32LE(0x80000000, 36);
    huge.writeUInt32LE(0, 40);
    const toc = readIoStoreToc(huge);
    expect(toc.methods).toHaveLength(255);

    // method count 300, name length 0, with the name bytes removed: the directory index reads
    const drained = Buffer.concat([Buffer.from(base.subarray(0, methodAt)), Buffer.from(base.subarray(methodAt + 6))]);
    drained.writeUInt32LE(300, 36);
    drained.writeUInt32LE(0, 40);
    const toc2 = readIoStoreToc(drained);
    expect(listIoStoreFiles(toc2, 10).total).toBe(3);
    void dirIndex;

    // method count 300 with 32-byte names that don't exist in the file: refused
    const bogus = Buffer.from(base);
    bogus.writeUInt32LE(300, 36);
    bogus.writeUInt32LE(32, 40);
    expect(() => readIoStoreToc(bogus)).toThrow(IoStoreError);
  });

  it("never panics on truncated bodies", () => {
    const { utoc } = sampleToc(0x9);
    for (let cut = 144; cut < utoc.length; cut += 7) {
      try {
        const t = readIoStoreToc(utoc.subarray(0, cut));
        listIoStoreFiles(t, 10);
      } catch (err) {
        expect(err).toBeInstanceOf(IoStoreError);
      }
    }
  });
});

describe("IoStore extraction", () => {
  it("splices stored, zlib and gzip chunks back to exact bytes", async () => {
    const payloads = [
      { path: "Game/hello.txt", data: Buffer.from("hello iostore world"), method: "none" as const },
      { path: "Game/deflated.bin", data: Buffer.from(Array.from({ length: 70000 }, (_, i) => i % 251)), method: "zlib" as const },
      { path: "Game/gzipped.bin", data: Buffer.from("a".repeat(300)), method: "gzip" as const }
    ];
    const { utoc, ucas, expected } = buildUtocFromFiles(payloads);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "iostore-"));
    try {
      const utocPath = path.join(tmp, "Game.utoc");
      const ucasPath = path.join(tmp, "Game.ucas");
      await fs.writeFile(utocPath, utoc);
      await fs.writeFile(ucasPath, ucas);
      expect(ucasPathFor(utocPath)).toBe(ucasPath);

      const toc = readIoStoreToc(await fs.readFile(utocPath));
      const { files } = listIoStoreFiles(toc, 100);
      expect(files).toHaveLength(3);
      const outDir = path.join(tmp, "out");
      const { extracted, errors } = await extractIoStoreFiles(ucasPath, toc, files, outDir, async (data, method) => {
        if (method === "none") return data;
        const { inflate, gunzip } = await import("node:zlib");
        const { promisify } = await import("node:util");
        const m = method.toLowerCase();
        if (m === "zlib" || m === "deflate") return promisify(inflate)(data);
        if (m === "gzip") return promisify(gunzip)(data);
        throw new IoStoreError("unsupported", `no ${method}`);
      });
      expect(errors).toEqual([]);
      expect(extracted).toHaveLength(3);
      for (const f of extracted) {
        expect(f.displayPath.startsWith("Game/")).toBe(true);
        await expect(fs.readFile(path.join(outDir, f.displayPath))).resolves.toEqual(expected.get(f.displayPath)!);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports Oodle chunks as unsupported", async () => {
    const { utoc, ucas } = buildUtoc({
      methods: ["Oodle"],
      blockSize: 65536,
      mount: "../../../",
      files: [],
      dirs: [{ name: "Game", children: [], files: [{ name: "A.uasset", chunk: 0 }] }],
      chunks: [{ offset: 0, length: 10 }],
      blocks: [{ data: Buffer.alloc(8), uncompressedSize: 10, method: 1 }]
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "iostore-"));
    try {
      const utocPath = path.join(tmp, "G.utoc");
      await fs.writeFile(utocPath, utoc);
      await fs.writeFile(path.join(tmp, "G.ucas"), ucas);
      const toc = readIoStoreToc(await fs.readFile(utocPath));
      const { files } = listIoStoreFiles(toc, 10);
      const { errors } = await extractIoStoreFiles(path.join(tmp, "G.ucas"), toc, files, path.join(tmp, "out"), async () => {
        throw new IoStoreError("unsupported", "Compression 'Oodle' is not supported natively");
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.error.message).toMatch(/Oodle/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects path traversal out of the output directory with a SecurityError", async () => {
    const { utoc, ucas } = buildUtoc({
      methods: [],
      blockSize: 65536,
      mount: "../../../",
      files: [],
      dirs: [{ name: "Game", children: [], files: [{ name: "../../evil.txt", chunk: 0 }] }],
      chunks: [{ offset: 0, length: 4 }],
      blocks: [{ data: Buffer.from("pwn!"), uncompressedSize: 4, method: 0 }]
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "iostore-"));
    try {
      const utocPath = path.join(tmp, "G.utoc");
      await fs.writeFile(utocPath, utoc);
      await fs.writeFile(path.join(tmp, "G.ucas"), ucas);
      const toc = readIoStoreToc(await fs.readFile(utocPath));
      const { files } = listIoStoreFiles(toc, 10);
      const { errors } = await extractIoStoreFiles(path.join(tmp, "G.ucas"), toc, files, path.join(tmp, "out"), async (d) => d);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.error).toBeInstanceOf(SecurityError);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("splices the right blocks for a chunk that starts past block 0", async () => {
    // Real containers align chunk offsets to the compression block size: this chunk lives in
    // block 1, so the extractor must read block 1 (8s), not block 0 (7s).
    const { utoc, ucas } = buildUtoc({
      methods: [],
      blockSize: 65536,
      mount: "../../../",
      files: [],
      dirs: [{ name: "Game", children: [], files: [{ name: "x.bin", chunk: 0 }] }],
      chunks: [{ offset: 65536, length: 10 }],
      blocks: [
        { data: Buffer.alloc(65536, 7), uncompressedSize: 65536, method: 0 },
        { data: Buffer.alloc(65536, 8), uncompressedSize: 65536, method: 0 }
      ]
    });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "iostore-"));
    try {
      const utocPath = path.join(tmp, "G.utoc");
      await fs.writeFile(utocPath, utoc);
      await fs.writeFile(path.join(tmp, "G.ucas"), ucas);
      const toc = readIoStoreToc(await fs.readFile(utocPath));
      const { files } = listIoStoreFiles(toc, 10);
      const outPath = path.join(tmp, "x.bin");
      await extractIoStoreChunk(path.join(tmp, "G.ucas"), toc, files[0]!.chunk, outPath, async (d) => d);
      await expect(fs.readFile(outPath)).resolves.toEqual(Buffer.alloc(10, 8));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

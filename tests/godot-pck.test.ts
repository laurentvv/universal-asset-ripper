import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { GodotPckParser, GDPC_MAGIC } from "../src/parsers/godot/pck-parser.js";
import { GodotAdapter } from "../src/adapters/godot-adapter.js";

describe("GodotPckParser & GodotAdapter", () => {
  let tmpDir: string;
  let samplePckPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "godot-test-"));
    samplePckPath = path.join(tmpDir, "test_game.pck");

    // Build synthetic Godot PCK v1 binary:
    // Header:
    //   Magic: uint32 (GDPC = 0x43504447)
    //   Format: uint32 (1)
    //   Major: uint32 (3)
    //   Minor: uint32 (5)
    //   Patch: uint32 (2)
    //   16 uint32 reserved = 64 bytes (zeroed)
    //   File count: uint32 (2)
    // Entry 1: "res://icon.png"
    // Entry 2: "res://main.gd"

    const header = Buffer.alloc(20 + 64 + 4);
    header.writeUInt32LE(GDPC_MAGIC, 0);
    header.writeUInt32LE(1, 4); // format v1
    header.writeUInt32LE(3, 8); // engine major 3
    header.writeUInt32LE(5, 12); // minor 5
    header.writeUInt32LE(2, 16); // patch 2
    // 64 bytes reserved are 0
    header.writeUInt32LE(2, 20 + 64); // 2 files

    // Entry 1 metadata
    const path1 = Buffer.from("res://icon.png", "utf-8");
    const pathLen1 = Buffer.alloc(4);
    pathLen1.writeUInt32LE(path1.length);
    const meta1 = Buffer.alloc(32);
    const file1Data = Buffer.from("PNG_FAKE_IMAGE_DATA_12345");
    // Offset will be calculated after full index
    // Let's compute offsets:
    // Header size = 88 bytes.
    // Entry 1: 4 + 14 + 32 = 50 bytes.
    // Entry 2: "res://scripts/player.gd" (23 bytes): 4 + 23 + 32 = 59 bytes.
    // Total index size = 88 + 50 + 59 = 197 bytes.
    const file1Offset = 197n;
    const file1Size = BigInt(file1Data.length);
    meta1.writeBigInt64LE(file1Offset, 0);
    meta1.writeBigInt64LE(file1Size, 8);

    // Entry 2 metadata
    const path2 = Buffer.from("res://scripts/player.gd", "utf-8");
    const pathLen2 = Buffer.alloc(4);
    pathLen2.writeUInt32LE(path2.length);
    const meta2 = Buffer.alloc(32);
    const file2Data = Buffer.from("extends KinematicBody2D\nfunc _ready(): pass");
    const file2Offset = file1Offset + file1Size;
    const file2Size = BigInt(file2Data.length);
    meta2.writeBigInt64LE(file2Offset, 0);
    meta2.writeBigInt64LE(file2Size, 8);

    const fullPck = Buffer.concat([
      header,
      pathLen1,
      path1,
      meta1,
      pathLen2,
      path2,
      meta2,
      file1Data,
      file2Data
    ]);

    await fs.writeFile(samplePckPath, fullPck);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should successfully parse synthetic Godot PCK header and files", async () => {
    const manifest = await GodotPckParser.readManifest(samplePckPath);
    expect(manifest).not.toBeNull();
    expect(manifest!.header.magic).toBe(GDPC_MAGIC);
    expect(manifest!.header.engineMajor).toBe(3);
    expect(manifest!.header.engineMinor).toBe(5);
    expect(manifest!.header.enginePatch).toBe(2);
    expect(manifest!.files).toHaveLength(2);
    expect(manifest!.files[0].path).toBe("res://icon.png");
    expect(manifest!.files[1].path).toBe("res://scripts/player.gd");
  });

  it("should inspect PCK and categorize assets correctly", async () => {
    const adapter = new GodotAdapter();
    const canHandle = await adapter.canHandle(samplePckPath);
    expect(canHandle).toBe(true);

    const manifest = await adapter.inspect(samplePckPath);
    expect(manifest.engine).toBe("godot");
    expect(manifest.engineVersion).toBe("3.5.2");
    expect(manifest.totalFiles).toBe(2);
    expect(manifest.byCategory.texture.count).toBe(1);
    expect(manifest.byCategory.script.count).toBe(1);
  });

  it("should extract PCK files with proper contents", async () => {
    const adapter = new GodotAdapter();
    const outDir = path.join(tmpDir, "extracted");
    const result = await adapter.extract(samplePckPath, { outputDir: outDir });

    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(2);

    const extractedIcon = await fs.readFile(path.join(outDir, "icon.png"), "utf-8");
    expect(extractedIcon).toBe("PNG_FAKE_IMAGE_DATA_12345");

    const extractedScript = await fs.readFile(path.join(outDir, "scripts", "player.gd"), "utf-8");
    expect(extractedScript).toContain("extends KinematicBody2D");
  });
});

/** Build a Godot PCK. v1: inline index, absolute offsets. v2: inline index + file_base. v4: dir_offset + REL_FILEBASE. */
function buildPck(version: 1 | 2 | 4, entries: Array<{ name: string; data: Buffer }>): Buffer {
  const headerLen = version === 1 ? 84 : version === 2 ? 96 : 104;
  const pad = (n: number) => (4 - (n % 4)) % 4;
  const indexLen =
    4 + entries.reduce((n, e) => n + 4 + Buffer.byteLength(e.name) + pad(Buffer.byteLength(e.name)) + (version === 1 ? 32 : 36), 0);
  const fileBase = version === 1 ? 0 : 16 * Math.ceil((headerLen + (version === 4 ? 0 : indexLen)) / 16);
  const dirOffset = version === 4 ? fileBase + entries.reduce((n, e) => n + e.data.length, 0) : 0;

  const header = Buffer.alloc(headerLen);
  header.writeUInt32LE(GDPC_MAGIC, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(version === 1 ? 3 : 4, 8);
  header.writeUInt32LE(version === 1 ? 5 : 3, 12);
  header.writeUInt32LE(0, 16);
  if (version >= 2) {
    header.writeUInt32LE(2, 20); // flags: PACK_REL_FILEBASE
    header.writeBigUInt64LE(BigInt(fileBase), 24);
  }
  if (version === 4) header.writeBigUInt64LE(BigInt(dirOffset), 32);

  const index: Buffer[] = [Buffer.alloc(4)];
  index[0].writeUInt32LE(entries.length);
  const blobs: Buffer[] = [];
  let ofs = 0;
  for (const e of entries) {
    const nameBuf = Buffer.concat([Buffer.from(e.name), Buffer.alloc(pad(Buffer.byteLength(e.name)))]);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(nameBuf.length);
    const meta = Buffer.alloc(version === 1 ? 32 : 36);
    meta.writeBigUInt64LE(BigInt(version === 1 ? fileBase + indexLen + headerLen + ofs : ofs), 0);
    meta.writeBigUInt64LE(BigInt(e.data.length), 8);
    index.push(len, nameBuf, meta);
    blobs.push(e.data);
    ofs += e.data.length;
  }
  const idx = Buffer.concat(index);
  if (version === 4) {
    return Buffer.concat([header, Buffer.alloc(fileBase - headerLen), ...blobs, idx]);
  }
  return Buffer.concat([header, idx, Buffer.alloc(fileBase - headerLen - idx.length), ...blobs]);
}

describe("GodotPckParser formats and safety", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "godot-fmt-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const realPck = path.resolve("tests/fixtures/godot/godot4-v4.pck");

  it("should list and extract the real Godot 4 (PCK v4) fixture", async () => {
    const manifest = await GodotPckParser.readManifest(realPck);
    expect(manifest).not.toBeNull();
    expect(manifest!.header.formatVersion).toBe(4);
    expect(manifest!.files).toHaveLength(13);
    expect(manifest!.files.map((f) => f.path)).toContain("icon.png");

    const outDir = path.join(tmpDir, "out");
    const result = await new GodotAdapter().extract(realPck, { outputDir: outDir });
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(13);
    const icon = await fs.readFile(path.join(outDir, "icon.png"));
    const expected = await fs.readFile(path.resolve("tests/fixtures/scripts/icon.png"));
    expect(icon.equals(expected)).toBe(true);
  });

  it("should parse PCK v2 (inline index with file_base)", async () => {
    const p = path.join(tmpDir, "v2.pck");
    await fs.writeFile(p, buildPck(2, [{ name: "res://a.txt", data: Buffer.from("hello") }, { name: "res://b/c.gd", data: Buffer.from("world!") }]));
    const manifest = await GodotPckParser.readManifest(p);
    expect(manifest!.files.map((f) => f.path)).toEqual(["res://a.txt", "res://b/c.gd"]);

    const outDir = path.join(tmpDir, "out");
    const result = await GodotPckParser.extractFiles(p, outDir);
    expect(result.errors).toEqual([]);
    expect(await fs.readFile(path.join(outDir, "b", "c.gd"), "utf-8")).toBe("world!");
  });

  it("should find a PCK embedded behind an executable via the trailer", async () => {
    const pck = buildPck(4, [{ name: "res://x.txt", data: Buffer.from("embedded!") }]);
    const exe = Buffer.concat([Buffer.alloc(3000, 0x90), pck]);
    const trailer = Buffer.alloc(12);
    trailer.writeBigUInt64LE(BigInt(pck.length), 0); // ds: PCK start = file length - 12 - ds
    trailer.writeUInt32LE(GDPC_MAGIC, 8);
    const p = path.join(tmpDir, "game.exe");
    await fs.writeFile(p, Buffer.concat([exe, trailer]));

    const loc = await GodotPckParser.findPckOffset(p);
    expect(loc).toEqual({ offset: 3000n, isEmbedded: true });
    const outDir = path.join(tmpDir, "out");
    const result = await GodotPckParser.extractFiles(p, outDir);
    expect(result.errors).toEqual([]);
    expect(await fs.readFile(path.join(outDir, "x.txt"), "utf-8")).toBe("embedded!");
  });

  it("should find a PCK through a PE section named 'pck'", async () => {
    const pck = buildPck(4, [{ name: "res://y.txt", data: Buffer.from("section!") }]);
    const peHeader = Buffer.alloc(512);
    peHeader.writeUInt16LE(0x5a4d, 0);
    peHeader.writeUInt32LE(128, 0x3c);
    peHeader.writeUInt32LE(0x00004550, 128);
    peHeader.writeUInt16LE(1, 128 + 6); // one section
    peHeader.writeUInt16LE(0, 128 + 20); // no optional header
    peHeader.write("pck", 128 + 24, "ascii");
    peHeader.writeUInt32LE(pck.length, 128 + 24 + 16);
    peHeader.writeUInt32LE(512, 128 + 24 + 20);
    const p = path.join(tmpDir, "game.exe");
    await fs.writeFile(p, Buffer.concat([peHeader, pck]));

    const loc = await GodotPckParser.findPckOffset(p);
    expect(loc).toEqual({ offset: 512n, isEmbedded: true });
    const manifest = await GodotPckParser.readManifest(p);
    expect(manifest!.files.map((f) => f.path)).toEqual(["res://y.txt"]);
  });

  it("should reject entries escaping the output dir but keep names like 'a..b'", async () => {
    const p = path.join(tmpDir, "evil.pck");
    await fs.writeFile(
      p,
      buildPck(2, [
        { name: "res://../../escaped.txt", data: Buffer.from("evil") },
        { name: "res://a..b.txt", data: Buffer.from("fine") },
        { name: "C:/Windows/drive.txt", data: Buffer.from("drive") }
      ])
    );
    const outDir = path.join(tmpDir, "sandbox", "out");
    const result = await GodotPckParser.extractFiles(p, outDir);

    expect(result.extractedCount).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toContain("escaped.txt");
    await expect(fs.access(path.join(tmpDir, "escaped.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, "sandbox", "escaped.txt"))).rejects.toThrow();
    expect(await fs.readFile(path.join(outDir, "a..b.txt"), "utf-8")).toBe("fine");
    expect(await fs.readFile(path.join(outDir, "Windows", "drive.txt"), "utf-8")).toBe("drive");
  });

  it("should honour dryRun, categories and filter in GodotAdapter.extract", async () => {
    const p = path.join(tmpDir, "opts.pck");
    await fs.writeFile(p, buildPck(2, [{ name: "res://icon.png", data: Buffer.from("png") }, { name: "res://main.gd", data: Buffer.from("gd") }]));
    const adapter = new GodotAdapter();
    const outDir = path.join(tmpDir, "out");

    const dry = await adapter.extract(p, { outputDir: outDir, dryRun: true });
    expect(dry.extractedCount).toBe(2);
    await expect(fs.access(outDir)).rejects.toThrow();

    const cat = await adapter.extract(p, { outputDir: outDir, categories: ["script"] });
    expect(cat.extractedCount).toBe(1);
    await expect(fs.access(path.join(outDir, "icon.png"))).rejects.toThrow();
  });
});

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

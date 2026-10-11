import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EngineDetector } from "../src/core/detector/engine-detector.js";
import { UE_PAK_MAGIC } from "../src/parsers/unreal/pak-parser.js";
import { GDPC_MAGIC } from "../src/parsers/godot/pck-parser.js";

describe("EngineDetector", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "detector-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should detect Unity game directory with UnityPlayer.dll and *_Data", async () => {
    const unityDir = path.join(tmpDir, "MyUnityGame");
    const dataDir = path.join(unityDir, "MyUnityGame_Data");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(unityDir, "UnityPlayer.dll"), "FAKE_UNITY_DLL");
    await fs.writeFile(path.join(unityDir, "GameAssembly.dll"), "FAKE_IL2CPP_DLL");
    await fs.writeFile(path.join(dataDir, "globalgamemanagers"), "GLOBAL_MANAGERS");

    const result = await EngineDetector.detect(unityDir);
    expect(result.engine).toBe("unity");
    expect(result.confidence).toBeGreaterThan(0.8);
    expect(result.details.isIL2CPP).toBe(true);
    expect(result.details.markersFound).toContain("UnityPlayer.dll");
  });

  it("should detect Unreal Engine game directory with Content/Paks", async () => {
    const ueDir = path.join(tmpDir, "MyUnrealGame");
    const paksDir = path.join(ueDir, "Content", "Paks");
    await fs.mkdir(paksDir, { recursive: true });

    // Create a mock .pak file with FPakInfo footer
    const pakPath = path.join(paksDir, "PakChunk0.pak");
    const pakData = Buffer.alloc(1024);
    // Write UE_PAK_MAGIC near footer (e.g. at 1024 - 48)
    pakData.writeUInt32LE(UE_PAK_MAGIC, 1024 - 48);
    pakData.writeInt32LE(8, 1024 - 44); // version 8
    await fs.writeFile(pakPath, pakData);

    const result = await EngineDetector.detect(ueDir);
    expect(result.engine).toBe("unreal");
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.details.markersFound.some((m) => m.includes("PakChunk0.pak"))).toBe(true);
  });

  it("should detect Godot game with standalone .pck file", async () => {
    const godotDir = path.join(tmpDir, "MyGodotGame");
    await fs.mkdir(godotDir, { recursive: true });

    const pckPath = path.join(godotDir, "game.pck");
    const pckHeader = Buffer.alloc(32);
    pckHeader.writeUInt32LE(GDPC_MAGIC, 0);
    pckHeader.writeUInt32LE(1, 4);
    pckHeader.writeUInt32LE(4, 8); // engine major 4
    pckHeader.writeUInt32LE(2, 12); // minor 2
    pckHeader.writeUInt32LE(0, 16); // patch 0
    await fs.writeFile(pckPath, pckHeader);

    const result = await EngineDetector.detect(godotDir);
    expect(result.engine).toBe("godot");
    expect(result.confidence).toBeGreaterThan(0.7);
    expect(result.version).toBe("4.2.0");
  });
});

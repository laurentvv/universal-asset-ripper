import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EngineDetector } from "../src/core/detector/engine-detector.js";
import { UnityBundleParser } from "../src/parsers/unity/bundle-parser.js";
import { UnrealAdapter } from "../src/adapters/unreal-adapter.js";
import { UnityAdapter } from "../src/adapters/unity-adapter.js";
import { PeResourceParser } from "../src/parsers/pe/pe-resource-parser.js";

/** Smallest PE32+ image the parser accepts (no sections, no resources) */
function minimalPe(): Buffer {
  const buf = Buffer.alloc(1024);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeInt32LE(128, 0x3c);
  buf.writeUInt32LE(0x00004550, 128);
  buf.writeUInt16LE(0x8664, 128 + 4);
  buf.writeUInt16LE(240, 128 + 20);
  buf.writeUInt16LE(0x020b, 128 + 24);
  return buf;
}

describe("Detector false-positive guards", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "detector-fp-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not treat a Chromium/Electron .pak file as Unreal", async () => {
    const pak = path.join(tmpDir, "resources.pak");
    await fs.writeFile(pak, Buffer.alloc(4096, 7));

    const result = await EngineDetector.detect(pak);
    expect(result.engine).not.toBe("unreal");
    expect(result.engine).toBe("unknown");
  });

  it("does not detect an engine from generic *_Data / Content / Engine folders alone", async () => {
    const dir = path.join(tmpDir, "app");
    await fs.mkdir(path.join(dir, "myapp_data"), { recursive: true });
    await fs.mkdir(path.join(dir, "Content"));
    await fs.mkdir(path.join(dir, "Engine"));

    const result = await EngineDetector.detect(dir);
    expect(result.engine).toBe("unknown");
    expect(await new UnrealAdapter().canHandle(dir)).toBe(false);
    expect(await new UnityAdapter().canHandle(dir)).toBe(false);
  });

  it("ignores a Chromium resources.pak next to an executable (Electron stays a PE app)", async () => {
    const dir = path.join(tmpDir, "electronapp");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "app.exe"), minimalPe());
    await fs.writeFile(path.join(dir, "resources.pak"), Buffer.alloc(4096, 3));

    const result = await EngineDetector.detect(dir);
    expect(result.engine).toBe("pe-software");
    expect(result.details.framework).toBe("Electron");
    expect(result.details.markersFound.some((m) => m.includes("Unreal"))).toBe(false);
  });

  it("flags Electron when only resources/app.asar sits next to a PE", async () => {
    await fs.mkdir(path.join(tmpDir, "resources"));
    await fs.writeFile(path.join(tmpDir, "resources", "app.asar"), "asar");
    const exe = path.join(tmpDir, "app.exe");
    await fs.writeFile(exe, minimalPe());

    expect((await PeResourceParser.parse(exe))?.framework).toBe("Electron");
  });

  it("does not inherit a sibling directory's engine for an unrelated single file", async () => {
    await fs.writeFile(path.join(tmpDir, "UnityPlayer.dll"), "FAKE_UNITY_DLL");
    const other = path.join(tmpDir, "notes.bin");
    await fs.writeFile(other, Buffer.alloc(256, 1));

    const result = await EngineDetector.detect(other);
    expect(result.engine).toBe("unknown");
  });

  it("lets a game executable inherit the engine of its own _Data folder", async () => {
    const dataDir = path.join(tmpDir, "Game_Data");
    await fs.mkdir(dataDir);
    await fs.writeFile(path.join(dataDir, "globalgamemanagers"), "GGM");
    await fs.writeFile(path.join(tmpDir, "UnityPlayer.dll"), "FAKE_UNITY_DLL");
    const exe = path.join(tmpDir, "Game.exe");
    await fs.writeFile(exe, "not a PE");

    const result = await EngineDetector.detect(exe);
    expect(result.engine).toBe("unity");
    expect(result.targetPath).toBe(exe);
  });
});

describe("UnityBundleParser", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "unity-bundle-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns the second string of a UnityFS header as the engine version", async () => {
    const p = path.join(tmpDir, "t.unity3d");
    const hdr = Buffer.concat([
      Buffer.from("UnityFS\0"),
      Buffer.from([0, 0, 0, 6]),
      Buffer.from("5.x.x\0"),
      Buffer.from("2021.3.16f1\0"),
      Buffer.alloc(64)
    ]);
    await fs.writeFile(p, hdr);

    const info = await UnityBundleParser.readBundleInfo(p);
    expect(info?.signature).toBe("UnityFS");
    expect(info?.engineVersion).toBe("2021.3.16f1");
    expect(info?.minPlayerVersion).toBe("5.x.x");
  });

  it("does not classify a PNG as a Unity SerializedFile", async () => {
    const png = path.resolve("tests/fixtures/scripts/icon.png");
    expect(await UnityBundleParser.readBundleInfo(png)).toBeNull();
  });

  it("accepts a SerializedFile only when the stored file size matches (v17 and v22)", async () => {
    const v17 = Buffer.alloc(128);
    v17.writeUInt32BE(40, 0); // metadata size
    v17.writeUInt32BE(128, 4); // file size
    v17.writeUInt32BE(17, 8); // version
    v17.writeUInt32BE(64, 12); // data offset
    const good = path.join(tmpDir, "level0");
    await fs.writeFile(good, v17);
    expect((await UnityBundleParser.readBundleInfo(good))?.formatVersion).toBe(17);

    v17.writeUInt32BE(9999, 4);
    const bad = path.join(tmpDir, "level1");
    await fs.writeFile(bad, v17);
    expect(await UnityBundleParser.readBundleInfo(bad)).toBeNull();

    const v22 = Buffer.alloc(128);
    v22.writeUInt32BE(22, 8);
    v22.writeUInt32BE(40, 16);
    v22.writeBigUInt64BE(128n, 20);
    v22.writeBigUInt64BE(64n, 28);
    const p22 = path.join(tmpDir, "level2");
    await fs.writeFile(p22, v22);
    expect((await UnityBundleParser.readBundleInfo(p22))?.formatVersion).toBe(22);
  });
});

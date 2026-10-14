import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// repak is simulated: `--version` fails unless repakInstalled, every other call is recorded
const state = vi.hoisted(() => ({
  repakInstalled: false,
  calls: [] as Array<{ file: string; args: string[] }>
}));

vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    state.calls.push({ file, args });
    if (file === "repak" && !state.repakInstalled) {
      cb(new Error("spawn repak ENOENT"));
      return;
    }
    cb(null, { stdout: "", stderr: "" });
  }
}));

import { UnrealAdapter } from "../src/adapters/unreal-adapter.js";
import { buildPak, type PakWriterEntry } from "./helpers/pak-writer.js";

const KEY = Buffer.from("00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f", "hex");

const entries: PakWriterEntry[] = [
  { path: "Content/Maps/Level1.umap", data: Buffer.from("MAP") },
  { path: "Content/Tex/hero.png", data: Buffer.from("PNGDATA".repeat(30)), compression: "zlib", blockSize: 32 },
  { path: "Content/Tex/hero.uasset", data: Buffer.from("asset") },
  { path: "Content/Audio/boom.wav", data: Buffer.from("RIFF....".repeat(8)), encrypt: true }
];

describe("UnrealAdapter with the native pak reader", () => {
  let tmpDir: string;
  const adapter = new UnrealAdapter();

  beforeEach(async () => {
    state.repakInstalled = false;
    state.calls.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "unreal-native-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function pak(opts: Parameters<typeof buildPak>[1], list: PakWriterEntry[] = entries, name = "Game-WindowsNoEditor.pak") {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, buildPak(list, opts));
    return p;
  }

  it("inspect lists the real entries with categories, sizes and compression", async () => {
    const p = await pak({ version: 8, aesKey: KEY });
    const manifest = await adapter.inspect(p);

    expect(manifest.engineVersion).toBe("UE Pak v8");
    expect(manifest.totalFiles).toBe(4);
    expect(manifest.byCategory.scene.count).toBe(1); // .umap
    expect(manifest.byCategory.texture.count).toBe(1);
    expect(manifest.byCategory.audio.count).toBe(1);
    expect(manifest.byCategory.other.count).toBe(1); // .uasset
    const tex = manifest.assets.find((a) => a.path.endsWith("hero.png"))!;
    expect(tex).toMatchObject({ path: "Game/Content/Tex/hero.png", size: 210, compressed: true, encrypted: false });
    expect(tex.metadata).toMatchObject({ compression: "Zlib" });
    expect(manifest.assets.find((a) => a.path.endsWith("boom.wav"))!.encrypted).toBe(true);
  });

  it("inspect needs the key for an encrypted index and keeps a container item explaining why", async () => {
    const p = await pak({ version: 11, aesKey: KEY, encryptIndex: true });

    const locked = await adapter.inspect(p);
    expect(locked.totalFiles).toBe(1);
    expect(locked.assets[0]).toMatchObject({ encrypted: true });
    expect(locked.assets[0].metadata).toMatchObject({ isContainerPackage: true, listErrorCode: "key-required" });

    const wrong = await adapter.inspect(p, { aesKey: "ff".repeat(32) });
    expect(wrong.assets[0].metadata).toMatchObject({ listErrorCode: "bad-key" });

    const open = await adapter.inspect(p, { aesKey: `0x${KEY.toString("hex")}` });
    expect(open.totalFiles).toBe(4);
  });

  it("extracts natively (no repak call needed) and honours categories, filter and dry-run", async () => {
    const p = await pak({ version: 11, aesKey: KEY, encryptIndex: true });
    const out = path.join(tmpDir, "out");

    const dry = await adapter.extract(p, { outputDir: out, aesKey: KEY.toString("hex"), dryRun: true, categories: ["texture", "audio"] });
    expect(dry).toMatchObject({ success: true, extractedCount: 2 });
    await expect(fs.access(out)).rejects.toThrow();

    const res = await adapter.extract(p, { outputDir: out, aesKey: KEY.toString("base64"), categories: ["texture", "audio"] });
    expect(res).toMatchObject({ success: true, extractedCount: 2, errors: [] });
    expect((await fs.readFile(path.join(out, "Game", "Content", "Audio", "boom.wav"))).toString()).toBe("RIFF....".repeat(8));
    expect((await fs.readFile(path.join(out, "Game", "Content", "Tex", "hero.png"))).toString()).toBe("PNGDATA".repeat(30));
    await expect(fs.access(path.join(out, "Game", "Content", "Maps", "Level1.umap"))).rejects.toThrow();

    const filtered = await adapter.extract(p, { outputDir: path.join(tmpDir, "out2"), aesKey: KEY.toString("hex"), filter: "level1" });
    expect(filtered.extractedCount).toBe(1);
    expect(state.calls.some((c) => c.args.includes("unpack"))).toBe(false);
  });

  it("reports a missing or wrong key instead of falling back to repak", async () => {
    state.repakInstalled = true;
    const p = await pak({ version: 8, aesKey: KEY, encryptIndex: true });
    const out = path.join(tmpDir, "out");

    const missing = await adapter.extract(p, { outputDir: out });
    expect(missing.success).toBe(false);
    expect(missing.errors[0].error).toMatch(/AES-256 key is required/);

    const wrong = await adapter.extract(p, { outputDir: out, aesKey: "ab".repeat(32) });
    expect(wrong.success).toBe(false);
    expect(wrong.errors[0].error).toMatch(/Wrong AES key/);
    expect(state.calls.some((c) => c.args.includes("unpack"))).toBe(false);
  });

  it("flags encrypted entries when only the entries (not the index) are encrypted and no key is given", async () => {
    const p = await pak({ version: 8, aesKey: KEY });
    const res = await adapter.extract(p, { outputDir: path.join(tmpDir, "out") });
    expect(res.extractedCount).toBe(3);
    expect(res.success).toBe(false);
    expect(res.errors.some((e) => /key is required/.test(e.error) && e.file.includes("boom.wav"))).toBe(true);
  });

  it("reports Oodle entries without repak, and falls back to repak unpack when it exists", async () => {
    const list: PakWriterEntry[] = [
      { path: "a/plain.txt", data: Buffer.from("plain") },
      { path: "a/packed.bin", data: Buffer.from("oodle bytes"), compression: "oodle" }
    ];
    const p = await pak({ version: 8 }, list);
    const out = path.join(tmpDir, "out");

    const noRepak = await adapter.extract(p, { outputDir: out });
    expect(noRepak.extractedCount).toBe(1);
    expect(noRepak.success).toBe(false);
    expect(noRepak.errors[0].error).toMatch(/Oodle compression, which needs the repak CLI/);

    state.repakInstalled = true;
    state.calls.length = 0;
    const withRepak = await adapter.extract(p, { outputDir: out, aesKey: "0xabc" });
    // invalid key format is a clear error, repak is not invoked with it
    expect(withRepak.errors[0].error).toMatch(/Invalid AES key/);

    const ok = await adapter.extract(p, { outputDir: path.join(tmpDir, "out3") });
    expect(ok.extractedCount).toBe(2);
    expect(ok.errors).toEqual([]);
    const unpack = state.calls.find((c) => c.args.includes("unpack"));
    expect(unpack).toMatchObject({ file: "repak", args: ["unpack", p, "-o", path.join(tmpDir, "out3")] });

    state.calls.length = 0;
    const withSelection = await adapter.extract(p, { outputDir: path.join(tmpDir, "out4"), filter: "packed" });
    expect(withSelection.errors[0].error).toMatch(/re-run without --categories\/--filter/);
    expect(state.calls.some((c) => c.args.includes("unpack"))).toBe(false);
  });

  it("falls back to repak for files the native reader cannot parse", async () => {
    state.repakInstalled = true;
    const p = path.join(tmpDir, "weird.pak");
    await fs.writeFile(p, "not a real pak");
    const res = await adapter.extract(p, { outputDir: path.join(tmpDir, "out"), dryRun: true });
    expect(res.extractedCount).toBe(0); // mocked `repak list` prints nothing
    expect(state.calls.some((c) => c.args.includes("list"))).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { GodotPckParser } from "../src/parsers/godot/pck-parser.js";
import { GodotAdapter } from "../src/adapters/godot-adapter.js";
import { GodotCryptoError, decryptGodotBlock, parseGodotKey } from "../src/parsers/godot/godot-crypto.js";
import { extractCtexImage } from "../src/parsers/godot/ctex.js";
import { EngineDetector } from "../src/core/detector/engine-detector.js";
import { buildCtex, buildGodotPck, buildWebpLike, godotEncrypt } from "./helpers/godot-pck-writer.js";

const KEY = createHash("sha256").update("godot-script-key").digest();
const KEY_HEX = KEY.toString("hex");
const WRONG_HEX = createHash("sha256").update("other").digest("hex");

const entries = [
  { name: "res://main.gd", data: Buffer.from("extends Node\nfunc _ready(): print('hi')") },
  { name: "res://secret/data.json", data: Buffer.from('{"level": 7}'.repeat(10)), encrypt: true },
  { name: "res://secret/odd.bin", data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]), encrypt: true }
];

describe("Godot encrypted PCK and texture conversion", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "godot-enc-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(name: string, data: Buffer): Promise<string> {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, data);
    return p;
  }

  describe("FileAccessEncrypted blocks", () => {
    it("roundtrips with our encryptor and rejects a wrong key through the MD5 check", () => {
      for (const len of [0, 1, 15, 16, 17, 1000]) {
        const plain = Buffer.alloc(len, 0xab);
        const block = godotEncrypt(plain, KEY);
        expect(block.length).toBe(40 + Math.ceil(len / 16) * 16);
        expect(decryptGodotBlock(block, KEY).equals(plain)).toBe(true);
      }
      const block = godotEncrypt(Buffer.from("hello world"), KEY);
      expect(() => decryptGodotBlock(block, parseGodotKey(WRONG_HEX))).toThrow(/Wrong AES key/);
      expect(() => decryptGodotBlock(block.subarray(0, 45), KEY)).toThrow(GodotCryptoError);
    });

    it("parses 64-hex keys with or without 0x and rejects others", () => {
      expect(parseGodotKey(KEY_HEX).equals(KEY)).toBe(true);
      expect(parseGodotKey(`0x${KEY_HEX.toUpperCase()}`).equals(KEY)).toBe(true);
      expect(() => parseGodotKey("abcd")).toThrow(/64 hex/);
      expect(() => parseGodotKey(KEY.toString("base64"))).toThrow(GodotCryptoError);
    });
  });

  describe.each([2, 4] as const)("PCK v%i with an encrypted directory and encrypted files", (version) => {
    it("needs the key to list, rejects a wrong key, and extracts every file byte for byte", async () => {
      const pck = await write("enc.pck", buildGodotPck(entries, { version, key: KEY, encryptDir: true }));

      const locked = await GodotPckParser.readManifest(pck);
      expect(locked!.header.flags & 1).toBe(1);
      expect(locked!.files).toEqual([]);
      expect(locked!.directoryError).toMatch(/script encryption key is required/);

      const wrong = await GodotPckParser.readManifest(pck, { aesKey: WRONG_HEX });
      expect(wrong!.files).toEqual([]);
      expect(wrong!.directoryError).toMatch(/Wrong AES key|implausible/);

      const bad = await GodotPckParser.readManifest(pck, { aesKey: "xyz" });
      expect(bad!.directoryError).toMatch(/64 hex/);

      const manifest = await GodotPckParser.readManifest(pck, { aesKey: `0x${KEY_HEX}` });
      expect(manifest!.directoryError).toBeUndefined();
      expect(manifest!.files.map((f) => f.path)).toEqual(entries.map((e) => e.name));
      expect(manifest!.files.map((f) => f.flags & 1)).toEqual([0, 1, 1]);

      const out = path.join(tmpDir, "out");
      const res = await GodotPckParser.extractFiles(pck, out, manifest!.files, { aesKey: KEY_HEX });
      expect(res.errors).toEqual([]);
      expect(res.extractedCount).toBe(3);
      for (const e of entries) {
        const written = await fs.readFile(path.join(out, e.name.replace("res://", "")));
        expect(written.equals(e.data), e.name).toBe(true);
      }
    });

    it("GodotAdapter: inspect and extract with --aes-key, clear errors without it", async () => {
      const pck = await write("enc.pck", buildGodotPck(entries, { version, key: KEY, encryptDir: true }));
      const adapter = new GodotAdapter();

      await expect(adapter.inspect(pck)).rejects.toThrow(/directory is encrypted/);
      await expect(adapter.inspect(pck, { aesKey: WRONG_HEX })).rejects.toThrow();
      const manifest = await adapter.inspect(pck, { aesKey: KEY_HEX });
      expect(manifest.totalFiles).toBe(3);
      expect(manifest.assets.filter((a) => a.encrypted)).toHaveLength(2);

      const out = path.join(tmpDir, "out");
      const noKey = await adapter.extract(pck, { outputDir: out });
      expect(noKey.success).toBe(false);
      expect(noKey.errors[0].error).toMatch(/directory is encrypted/);

      const ok = await adapter.extract(pck, { outputDir: out, aesKey: KEY_HEX, categories: ["config", "other"] });
      expect(ok.errors).toEqual([]);
      expect(ok.extractedCount).toBe(2);
      expect(await fs.readFile(path.join(out, "secret", "data.json"), "utf-8")).toBe('{"level": 7}'.repeat(10));
    });
  });

  it("encrypts only the files: the directory lists without a key and each file asks for it", async () => {
    const pck = await write("files.pck", buildGodotPck(entries, { version: 4, key: KEY }));
    const adapter = new GodotAdapter();
    const manifest = await adapter.inspect(pck);
    expect(manifest.totalFiles).toBe(3);

    const out = path.join(tmpDir, "out");
    const noKey = await adapter.extract(pck, { outputDir: out });
    expect(noKey.extractedCount).toBe(1);
    expect(noKey.errors).toHaveLength(2);
    expect(noKey.errors[0].error).toMatch(/script encryption key is required/);

    const wrong = await adapter.extract(pck, { outputDir: path.join(tmpDir, "o2"), aesKey: WRONG_HEX });
    expect(wrong.errors).toHaveLength(2);
    expect(wrong.errors[0].error).toMatch(/Wrong AES key/);

    const ok = await adapter.extract(pck, { outputDir: path.join(tmpDir, "o3"), aesKey: KEY_HEX });
    expect(ok).toMatchObject({ success: true, extractedCount: 3 });
  });

  it("detect flags an encrypted PCK directory without needing the key", async () => {
    const pck = await write("enc.pck", buildGodotPck(entries, { version: 4, key: KEY, encryptDir: true }));
    const result = await EngineDetector.detect(pck);
    expect(result.engine).toBe("godot");
    expect(result.details.encrypted).toBe(true);
  });

  describe("ctex / stex conversion", () => {
    const png = () => fs.readFile(path.resolve("tests/fixtures/scripts/icon.png"));

    it("lifts a plain PNG out of a GST2 container", async () => {
      const original = await png();
      const image = extractCtexImage(buildCtex(original, "png"));
      expect(image?.ext).toBe("png");
      expect(image?.data.equals(original)).toBe(true);
    });

    it("lifts a WebP payload and leaves VRAM-compressed / unknown data alone", async () => {
      const webp = buildWebpLike(Buffer.from("VP8L-fake-bitstream"));
      const image = extractCtexImage(buildCtex(webp, "webp"));
      expect(image).toMatchObject({ ext: "webp" });
      expect(image?.data.equals(webp)).toBe(true);

      expect(extractCtexImage(buildCtex(Buffer.alloc(200, 0x5a), "vram"))).toBeNull();
      expect(extractCtexImage(Buffer.from("not a texture at all, just text"))).toBeNull();
      const truncated = buildCtex(await png(), "png");
      expect(extractCtexImage(truncated.subarray(0, 120))).toBeNull();
    });

    it("GodotAdapter writes images only when conversion is requested", async () => {
      const original = await png();
      const pck = await write(
        "tex.pck",
        buildGodotPck(
          [
            { name: "res://.godot/imported/icon.png-abc.ctex", data: buildCtex(original, "png") },
            { name: "res://.godot/imported/vram.png-def.ctex", data: buildCtex(Buffer.alloc(100, 7), "vram") },
            { name: "res://.godot/imported/old.png-123.stex", data: Buffer.concat([Buffer.from("GDST"), Buffer.alloc(16), original]) }
          ],
          { version: 4 }
        )
      );
      const adapter = new GodotAdapter();

      const plain = await adapter.extract(pck, { outputDir: path.join(tmpDir, "raw") });
      expect(plain.extractedCount).toBe(3);
      await expect(fs.access(path.join(tmpDir, "raw", ".godot", "imported", "icon.png-abc.png"))).rejects.toThrow();

      const out = path.join(tmpDir, "conv");
      const res = await adapter.extract(pck, { outputDir: out, convertFormats: true });
      expect(res.errors).toEqual([]);
      expect(res.extractedCount).toBe(3);
      const dir = path.join(out, ".godot", "imported");
      expect((await fs.readFile(path.join(dir, "icon.png-abc.png"))).equals(original)).toBe(true);
      expect((await fs.readFile(path.join(dir, "old.png-123.png"))).equals(original)).toBe(true);
      expect((await fs.readFile(path.join(dir, "vram.png-def.ctex"))).length).toBeGreaterThan(100); // untouched container
      await expect(fs.access(path.join(dir, "icon.png-abc.ctex"))).rejects.toThrow();
    });
  });
});

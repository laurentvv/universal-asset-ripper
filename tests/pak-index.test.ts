import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import {
  PakIndexError,
  extractPakEntries,
  parseAesKey,
  readPakIndex,
  validatePakKey
} from "../src/parsers/unreal/pak-index.js";
import { buildPak, type PakWriterEntry } from "./helpers/pak-writer.js";

const KEY = Buffer.from("00112233445566778899aabbccddeeff102132435465768798a9bacbdcedfe0f", "hex");
const WRONG = Buffer.from("ff".repeat(32), "hex");

function sampleEntries(): PakWriterEntry[] {
  return [
    { path: "Content/Maps/Level1.umap", data: Buffer.from("MAPDATA".repeat(10)) },
    { path: "Content/Textures/T_Hero.png", data: Buffer.from(randomBytes(300)), compression: "zlib", blockSize: 64 },
    { path: "Content/Text/readme.txt", data: Buffer.from("hello world, ".repeat(200)), compression: "zlib" },
    { path: "root.ini", data: Buffer.from("[Section]\nKey=Value\n") },
    { path: "Content/Secret/secret.uasset", data: Buffer.concat([Buffer.from([0xc1, 0x83, 0x2a, 0x9e]), Buffer.from("secret-stored-".repeat(7))]), encrypt: true },
    { path: "Content/Secret/packed.uexp", data: Buffer.from("secret packed ".repeat(50)), compression: "zlib", blockSize: 100, encrypt: true }
  ];
}

describe("pak index reader", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pak-index-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writePak(entries: PakWriterEntry[], opts: Parameters<typeof buildPak>[1] = {}, name = "t.pak"): Promise<string> {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, buildPak(entries, opts));
    return p;
  }

  async function roundtrip(pak: string, entries: PakWriterEntry[], aesKey?: string | Buffer) {
    const index = await readPakIndex(pak, { aesKey });
    expect(index.entries).toHaveLength(entries.length);
    const out = path.join(tmpDir, "out");
    const res = await extractPakEntries(pak, index.entries, out, { aesKey });
    expect(res.errors.map((e) => `${e.entry.path}: ${e.error.message}`)).toEqual([]);
    for (const e of entries) {
      const entry = index.entries.find((x) => x.path === e.path)!;
      expect(entry, e.path).toBeDefined();
      expect(entry.uncompressedSize).toBe(e.data.length);
      expect(entry.encrypted).toBe(e.encrypt === true);
      const written = await fs.readFile(path.join(out, "Game", e.path));
      expect(written.equals(e.data), e.path).toBe(true);
    }
    return index;
  }

  describe.each([3, 4, 5, 7, 8, 9])("classic index, version %i", (version) => {
    it("lists and extracts stored, zlib multi-block and AES-encrypted entries", async () => {
      const entries = sampleEntries();
      const pak = await writePak(entries, { version, aesKey: KEY, encryptIndex: false });
      const index = await roundtrip(pak, entries, KEY);
      expect(index.version).toBe(version);
      expect(index.mountPoint).toBe("../../../Game/");
      expect(index.indexEncrypted).toBe(false);
      expect(index.entries.find((e) => e.path.endsWith("T_Hero.png"))!.compression).toBe("Zlib");
      expect(index.entries.find((e) => e.path.endsWith("T_Hero.png"))!.blocks.length).toBe(5);
      expect(index.entries[0].displayPath).toBe("Game/Content/Maps/Level1.umap");
    });
  });

  it("supports the v8A layout (4 compression slots, u8 compression ids)", async () => {
    const entries = sampleEntries();
    const pak = await writePak(entries, { version: 8, v8a: true, aesKey: KEY });
    await roundtrip(pak, entries, KEY);
  });

  it("decrypts an AES-encrypted index with hex, 0x-hex and base64 keys", async () => {
    const entries = sampleEntries();
    const pak = await writePak(entries, { version: 8, aesKey: KEY, encryptIndex: true });
    for (const k of [KEY.toString("hex"), `0x${KEY.toString("hex")}`, KEY.toString("base64"), KEY]) {
      const index = await readPakIndex(pak, { aesKey: k });
      expect(index.indexEncrypted).toBe(true);
      expect(index.entries).toHaveLength(entries.length);
    }
    await roundtrip(pak, entries, `0x${KEY.toString("hex")}`);
  });

  it("fails clearly with a missing, wrong or malformed key", async () => {
    const pak = await writePak(sampleEntries(), { version: 8, aesKey: KEY, encryptIndex: true });
    await expect(readPakIndex(pak)).rejects.toMatchObject({ code: "key-required" });
    await expect(readPakIndex(pak, { aesKey: WRONG })).rejects.toMatchObject({ code: "bad-key" });
    await expect(readPakIndex(pak, { aesKey: WRONG })).rejects.toThrow(/Wrong AES key/);
    await expect(readPakIndex(pak, { aesKey: "not a key" })).rejects.toMatchObject({ code: "invalid-key-format" });
    expect(() => parseAesKey("abcd")).toThrow(PakIndexError);
  });

  describe("v10 / v11 path hash + full directory index", () => {
    it.each([10, 11])("reads bit-packed encoded entries, version %i", async (version) => {
      const entries = sampleEntries();
      const pak = await writePak(entries, { version, aesKey: KEY });
      const index = await roundtrip(pak, entries, KEY);
      expect(index.hasFullDirectoryIndex).toBe(true);
      expect(index.version).toBe(version);
    });

    it("reads an encrypted v11 index (primary + full directory) and non-encoded entries", async () => {
      const entries = sampleEntries().map((e, i) => ({ ...e, nonEncoded: i % 2 === 1 }));
      const pak = await writePak(entries, { version: 11, aesKey: KEY, encryptIndex: true });
      const index = await roundtrip(pak, entries, KEY.toString("base64"));
      expect(index.indexEncrypted).toBe(true);
      await expect(readPakIndex(pak, { aesKey: WRONG })).rejects.toMatchObject({ code: "bad-key" });
    });

    it("falls back to placeholder names when only the path hash index exists", async () => {
      const entries = sampleEntries().slice(0, 3);
      const pak = await writePak(entries, { version: 11, aesKey: KEY, fullDirectoryIndex: false });
      const index = await readPakIndex(pak);
      expect(index.hasFullDirectoryIndex).toBe(false);
      expect(index.entries).toHaveLength(3);
      expect(index.entries.every((e) => !e.nameKnown && e.path.startsWith("unnamed/"))).toBe(true);
    });
  });

  it("reports Oodle entries as unsupported without breaking the others", async () => {
    const entries: PakWriterEntry[] = [
      { path: "a/ok.txt", data: Buffer.from("ok") },
      { path: "a/oodle.bin", data: Buffer.from("not really oodle"), compression: "oodle" }
    ];
    for (const version of [8, 11]) {
      const pak = await writePak(entries, { version }, `oodle${version}.pak`);
      const index = await readPakIndex(pak);
      const out = path.join(tmpDir, `out${version}`);
      const res = await extractPakEntries(pak, index.entries, out);
      expect(res.extracted.map((e) => e.path)).toEqual(["a/ok.txt"]);
      expect(res.errors).toHaveLength(1);
      expect((res.errors[0].error as PakIndexError).code).toBe("unsupported");
      expect(index.entries.find((e) => e.path === "a/oodle.bin")!.compression).toBe("Oodle");
    }
  });

  it("rejects entries whose path escapes the output directory", async () => {
    const pak = await writePak([{ path: "../../evil.txt", data: Buffer.from("x") }], { version: 8, mountPoint: "/" });
    const index = await readPakIndex(pak);
    const out = path.join(tmpDir, "out");
    const res = await extractPakEntries(pak, index.entries, out);
    expect(res.extracted).toHaveLength(0);
    expect(res.errors[0].error.message).toMatch(/unsafe/i);
    await expect(fs.access(path.join(tmpDir, "evil.txt"))).rejects.toThrow();
  });

  it("rejects non-pak files and truncated indexes", async () => {
    const junk = path.join(tmpDir, "junk.pak");
    await fs.writeFile(junk, "pak");
    await expect(readPakIndex(junk)).rejects.toMatchObject({ code: "unsupported" });

    const good = buildPak(sampleEntries(), { version: 8, aesKey: KEY });
    const broken = path.join(tmpDir, "broken.pak");
    // keep the footer but cut the data so the index offset lies outside the file
    await fs.writeFile(broken, Buffer.concat([good.subarray(0, 40), good.subarray(good.length - 221)]));
    await expect(readPakIndex(broken)).rejects.toBeInstanceOf(PakIndexError);
  });

  describe("validatePakKey", () => {
    it("verifies keys through the encrypted index", async () => {
      const pak = await writePak(sampleEntries(), { version: 11, aesKey: KEY, encryptIndex: true });
      const good = await validatePakKey(pak, `0x${KEY.toString("hex")}`);
      expect(good).toMatchObject({ valid: true, method: "index", mountPoint: "../../../Game/", entryCount: 6 });
      const bad = await validatePakKey(pak, WRONG.toString("hex"));
      expect(bad.valid).toBe(false);
      expect((await validatePakKey(pak, "zz")).valid).toBe(false);
    });

    it("falls back to probing an encrypted entry when the index is plain", async () => {
      const pak = await writePak(sampleEntries(), { version: 8, aesKey: KEY, encryptIndex: false });
      expect(await validatePakKey(pak, KEY)).toMatchObject({ valid: true, method: "entry" });
      expect((await validatePakKey(pak, WRONG)).valid).toBe(false);
    });

    it("reports null when nothing can prove the key", async () => {
      const pak = await writePak([{ path: "a.txt", data: Buffer.from("plain") }], { version: 8 });
      expect((await validatePakKey(pak, KEY)).valid).toBeNull();
    });
  });
});

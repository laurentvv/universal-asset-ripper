import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { BinaryScanner } from "../src/rea/binary-scanner.js";
import { ReaBridge } from "../src/rea/rea-bridge.js";
import { buildPak } from "./helpers/pak-writer.js";

const sha = (label: string) => createHash("sha256").update(label).digest();
const hexKey = (label: string) => sha(label).toString("hex");

const SBOX_PREFIX = [0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76];
const SBOX_AT = 4096;

/** A binary with an S-box-like table (distinct bytes, so windows inside it look random) and a key 64 bytes after it */
function buildSBoxBuffer(key: Buffer, size = 16384): Buffer {
  const rest = Array.from({ length: 256 }, (_, i) => i).filter((v) => !SBOX_PREFIX.includes(v));
  const buf = Buffer.alloc(size, 0);
  [...SBOX_PREFIX, ...rest].forEach((v, i) => (buf[SBOX_AT + i] = v));
  key.copy(buf, SBOX_AT + 256 + 64);
  return buf;
}

describe("BinaryScanner & ReaBridge", () => {
  let tmpDir: string;
  let mockBinPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rea-test-"));
    mockBinPath = path.join(tmpDir, "Game-Win64-Shipping.exe");

    // Create a mock binary buffer containing:
    // 1. MZ / PE header stub
    // 2. High-entropy 64-char hex AES key string: "0x4A6B8D1F3C5E7A9B0C2D4E6F8A1B3C5D7E9F0A2B4C6D8E0F2A4B6C8D0E2F4A6B"
    // 3. Unreal signature text
    const buf = Buffer.alloc(8192);
    // Write MZ signature
    buf.writeUInt16LE(0x5a4d, 0);

    const testAesKey = "0x4a6b8d1f3c5e7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f2a4b6c8d0e2f4a6b";
    buf.write(testAesKey, 512, "ascii");
    buf.write("UnrealEngine Game Client", 1024, "ascii");

    await fs.writeFile(mockBinPath, buf);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should calculate buffer entropy correctly", () => {
    const zeroBuf = Buffer.alloc(100, 0);
    expect(BinaryScanner.calculateEntropy(zeroBuf)).toBe(0);

    // Random-like buffer
    const randomBuf = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const entropy = BinaryScanner.calculateEntropy(randomBuf);
    expect(entropy).toBeCloseTo(8, 0.1);
  });

  it("should locate candidate hex AES keys in binary buffer", async () => {
    const scan = await BinaryScanner.scanBinary(mockBinPath);
    expect(scan.candidateAesKeys.length).toBeGreaterThan(0);
    expect(scan.candidateAesKeys[0].keyHex).toBe(
      "0x4a6b8d1f3c5e7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f2a4b6c8d0e2f4a6b"
    );
    expect(scan.stringsFound).toContain("UnrealEngine signature");
  });

  it("should generate structured REA evidence bundle", async () => {
    const { bundle } = await ReaBridge.inspectBinary(mockBinPath);
    expect(bundle.targetBinary).toBe(mockBinPath);
    expect(bundle.findings.candidateAesKeys.length).toBeGreaterThan(0);
    expect(bundle.findings.candidateTotal).toBe(1);
    expect(bundle.reaTaskPrompt).toContain("Candidate AES keys detected");
  });

  describe("false positive filtering", () => {
    const counting = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, "0")).join("");

    it("classifies counting tables, repeated blocks, low entropy and trivial strings", () => {
      expect(BinaryScanner.classifyHexKey(counting)).toBe("sequential");
      expect(BinaryScanner.classifyHexKey("0123456789abcdef".repeat(4))).toBe("repeatedBlock");
      expect(BinaryScanner.classifyHexKey(hexKey("a").slice(0, 32).repeat(2))).toBe("repeatedBlock");
      expect(BinaryScanner.classifyHexKey("ab".repeat(32))).toBe("repeatedBlock");
      expect(BinaryScanner.classifyHexKey("0".repeat(64))).toBe("trivial");
      expect(BinaryScanner.classifyHexKey("0000000100000002000000030000000400000001000000020000000500000006")).toBe("lowEntropy");
      expect(BinaryScanner.classifyHexKey(hexKey("good"))).toBeNull();
    });

    it("drops hex strings that are part of longer hex runs and reports the counts", () => {
      const stats = { longerHexRun: 0, sequential: 0, lowEntropy: 0, repeatedBlock: 0, trivial: 0 };
      const longRun = hexKey("one") + hexKey("two").slice(0, 20);
      const buf = Buffer.from(`xx ${longRun} yy 0x${hexKey("keep")} zz ${hexKey("three")}g`, "latin1");
      const found = BinaryScanner.searchHexAesStrings(buf, stats);
      expect(found.map((f) => f.keyHex)).toEqual([`0x${hexKey("keep")}`, `0x${hexKey("three")}`]);
      expect(stats.longerHexRun).toBe(1);
    });

    it("scan result reports what was filtered out", async () => {
      const bin = path.join(tmpDir, "filtered.exe");
      await fs.writeFile(bin, Buffer.from([counting, "ab".repeat(32), "0".repeat(64), hexKey("k")].join(" \0 "), "latin1"));
      const scan = await BinaryScanner.scanBinary(bin);
      expect(scan.candidateTotal).toBe(1);
      expect(scan.filteredOut).toMatchObject({ sequential: 1, repeatedBlock: 1, trivial: 1 });
    });
  });

  describe("whole-file chunked scanning", () => {
    it("finds keys in every chunk, across chunk borders and without duplicates", async () => {
      const bin = path.join(tmpDir, "big.exe");
      const buf = Buffer.alloc(40000, 0);
      const keys = ["k0", "k1", "k2", "k3"].map(hexKey);
      buf.write(keys[0], 10, "latin1");
      buf.write(keys[1], 4096 - 30, "latin1"); // straddles the first chunk border
      buf.write(keys[2], 20000, "latin1");
      buf.write(keys[3], 39900, "latin1"); // near the end, far beyond any prefix
      // a long hex run across a border: its 64-char windows must not become candidates
      buf.write(hexKey("l1") + hexKey("l2") + hexKey("l3"), 8192 - 50, "latin1");
      await fs.writeFile(bin, buf);

      const scan = await BinaryScanner.scanBinary(bin, { chunkBytes: 4096 });
      const found = scan.candidateAesKeys.map((c) => c.keyHex.slice(2)).sort();
      expect(found).toEqual([...keys].sort());
      expect(scan.scannedBytes).toBe(40000);
      expect(scan.filteredOut.longerHexRun).toBe(1);
    });

    it("reads chunk after chunk instead of only a prefix", async () => {
      const bin = path.join(tmpDir, "tail.exe");
      const buf = Buffer.alloc(3 * 1024 * 1024, 0);
      buf.write(hexKey("tail"), buf.length - 100, "latin1");
      await fs.writeFile(bin, buf);
      const scan = await BinaryScanner.scanBinary(bin, { chunkBytes: 1024 * 1024 });
      expect(scan.candidateAesKeys.map((c) => c.keyHex)).toEqual([`0x${hexKey("tail")}`]);
    });
  });

  describe("S-box candidates and honest counts", () => {
    it("reports the key next to the S-box but never the table itself", async () => {
      const key = sha("sbox-key");
      const bin = path.join(tmpDir, "sbox.exe");
      await fs.writeFile(bin, buildSBoxBuffer(key));
      const scan = await BinaryScanner.scanBinary(bin);
      const sbox = scan.candidateAesKeys.filter((c) => c.pattern === "Near Rijndael S-Box");
      expect(sbox.map((c) => c.keyHex)).toEqual([`0x${key.toString("hex")}`]);
      expect(sbox[0].distanceFromSBox).toBe(64);
      expect(sbox.every((c) => c.offset >= SBOX_AT + 256 || c.offset + 32 <= SBOX_AT)).toBe(true);
    });

    it("never lets many hex strings hide S-box candidates, and says N candidates, showing M", async () => {
      const bin = path.join(tmpDir, "sbox2.exe");
      const buf = Buffer.concat([buildSBoxBuffer(sha("sbox-key")), Buffer.alloc(40 * 70, 0)]);
      for (let i = 0; i < 40; i++) buf.write(hexKey(`hex-${i}`), 16384 + i * 70, "latin1");
      await fs.writeFile(bin, buf);

      const scan = await BinaryScanner.scanBinary(bin, { maxShown: 6 });
      expect(scan.candidateCounts).toEqual({ hexString: 40, sbox: 1 });
      expect(scan.candidateTotal).toBe(41);
      expect(scan.candidatesShown).toBe(6);
      expect(scan.candidateAesKeys).toHaveLength(6);
      expect(scan.candidateAesKeys.some((c) => c.pattern === "Near Rijndael S-Box")).toBe(true);
      expect(scan.recommendations.join("\n")).toContain("41 candidate AES-256 keys");
      expect(scan.recommendations.join("\n")).toContain("showing 6");
    });
  });

  describe("key validation against a pak", () => {
    it("verifies, rejects and sorts candidates; ReaBridge.validateKeyAgainstPak uses the native reader", async () => {
      const key = sha("pak-key");
      const pak = path.join(tmpDir, "enc.pak");
      await fs.writeFile(
        pak,
        buildPak([{ path: "Content/x.uasset", data: Buffer.from("x") }], { version: 8, aesKey: key, encryptIndex: true })
      );

      expect(await ReaBridge.validateKeyAgainstPak(pak, key.toString("hex"))).toMatchObject({
        valid: true,
        mountPoint: "../../../Game/"
      });
      expect((await ReaBridge.validateKeyAgainstPak(pak, hexKey("other"))).valid).toBe(false);

      const bin = path.join(tmpDir, "v.exe");
      const buf = Buffer.alloc(4096, 0);
      buf.write(hexKey("d1"), 100, "latin1");
      buf.write(hexKey("d2"), 300, "latin1");
      buf.write(key.toString("hex"), 2000, "latin1");
      await fs.writeFile(bin, buf);

      const { scan, bundle } = await ReaBridge.inspectBinary(bin, { pakPath: pak });
      expect(scan.candidateAesKeys[0]).toMatchObject({ keyHex: `0x${key.toString("hex")}`, verified: true });
      expect(scan.candidateAesKeys.slice(1).map((c) => c.verified)).toEqual([false, false]);
      expect(bundle.findings.candidateAesKeys[0].verified).toBe(true);
      expect(bundle.reaTaskPrompt).toContain("Verified AES keys");
      expect(scan.recommendations.join("\n")).toContain("--aes-key");
    });

    it("marks candidates as unverifiable when the pak cannot prove a key", async () => {
      const pak = path.join(tmpDir, "plain.pak");
      await fs.writeFile(pak, buildPak([{ path: "a.txt", data: Buffer.from("plain") }], { version: 8 }));
      const bin = path.join(tmpDir, "u.exe");
      const buf = Buffer.alloc(1024, 0);
      buf.write(hexKey("u1"), 10, "latin1");
      await fs.writeFile(bin, buf);
      const { scan } = await ReaBridge.inspectBinary(bin, { pakPath: pak });
      expect(scan.candidateAesKeys[0].verified).toBeNull();
    });
  });
});

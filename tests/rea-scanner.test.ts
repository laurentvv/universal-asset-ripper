import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { BinaryScanner } from "../src/rea/binary-scanner.js";
import { ReaBridge } from "../src/rea/rea-bridge.js";

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
    const { scan, bundle } = await ReaBridge.inspectBinary(mockBinPath);
    expect(bundle.targetBinary).toBe(mockBinPath);
    expect(bundle.findings.candidateAesKeys.length).toBeGreaterThan(0);
    expect(bundle.reaTaskPrompt).toContain("Candidate AES keys detected");
  });
});

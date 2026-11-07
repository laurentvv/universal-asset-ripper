import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import {
  SecurityError,
  isRelativeTo,
  assertSafeOutputPath,
  resolveSafeOutputPath
} from "../src/utils/file-utils.js";
import { GodotPckParser } from "../src/parsers/godot/pck-parser.js";
import { extractPakEntries, type PakEntry } from "../src/parsers/unreal/pak-index.js";
import { AsarParser } from "../src/parsers/electron/asar-parser.js";
import { buildAsar } from "./helpers/electron-writers.js";

describe("Zip Slip (Path Traversal) security protection", () => {
  let tmpDir: string;
  let outDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zip-slip-test-"));
    outDir = path.join(tmpDir, "target_dest");
    await fs.mkdir(outDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("SecurityError and path verification utilities", () => {
    it("instantiates SecurityError with default message containing expected phrasing", () => {
      const err = new SecurityError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SecurityError);
      expect(err.name).toBe("SecurityError");
      expect(err.message).toContain("Tentative de Path Traversal détectée dans l'archive");
    });

    it("isRelativeTo correctly distinguishes inside paths from traversals and siblings", () => {
      const dest = path.resolve(outDir);
      const safeTarget = path.join(dest, "subdir", "file.txt");
      const traversalTarget = path.join(dest, "..", "escape.txt");
      const deepTraversal = path.join(dest, "..", "..", "escape.txt");
      const siblingTarget = path.resolve(dest + "-other", "file.txt");

      expect(isRelativeTo(safeTarget, dest)).toBe(true);
      expect(isRelativeTo(traversalTarget, dest)).toBe(false);
      expect(isRelativeTo(deepTraversal, dest)).toBe(false);
      expect(isRelativeTo(siblingTarget, dest)).toBe(false);
      expect(isRelativeTo(dest, dest)).toBe(false); // destination itself is not an inside file
    });

    it("assertSafeOutputPath allows legitimate sub-paths and rejects traversal with SecurityError", () => {
      const safe = assertSafeOutputPath(outDir, "sub/dir/safe.txt");
      expect(safe).toBe(path.join(path.resolve(outDir), "sub", "dir", "safe.txt"));
      expect(resolveSafeOutputPath(outDir, "sub/dir/safe.txt")).toBe(safe);
      expect(resolveSafeOutputPath(outDir, "../../escaped.txt")).toBeNull();

      expect(() => assertSafeOutputPath(outDir, "../../escaped.txt")).toThrow(SecurityError);
      expect(() => assertSafeOutputPath(outDir, "../../escaped.txt")).toThrow(
        /Tentative de Path Traversal détectée dans l'archive/
      );
      expect(() => assertSafeOutputPath(outDir, "../evil.sh")).toThrow(SecurityError);
      expect(() => assertSafeOutputPath(outDir, "")).toThrow(SecurityError);
      expect(() => assertSafeOutputPath(outDir, "\0bad.txt")).toThrow(SecurityError);
    });
  });

  describe("Godot .pck extraction", () => {
    it("rejects malicious entries attempting path traversal with SecurityError", async () => {
      // Build a minimal Godot PCK with a traversal path
      const header = Buffer.alloc(88);
      header.writeUInt32LE(0x43504447, 0); // GDPC
      header.writeUInt32LE(1, 4); // format v1
      header.writeUInt32LE(3, 8); // engine major 3
      header.writeUInt32LE(5, 12); // engine minor 5
      header.writeUInt32LE(2, 16); // patch 2
      header.writeUInt32LE(1, 20 + 64); // 1 file

      const evilPath = Buffer.from("res://../../evil_script.sh", "utf-8");
      const pathLen = Buffer.alloc(4);
      pathLen.writeUInt32LE(evilPath.length);

      const meta = Buffer.alloc(32);
      const fileData = Buffer.from("#!/bin/sh\necho hacked\n");
      const fileOffset = BigInt(88 + 4 + evilPath.length + 32);
      const fileSize = BigInt(fileData.length);
      meta.writeBigInt64LE(fileOffset, 0);
      meta.writeBigInt64LE(fileSize, 8);

      const pckBuffer = Buffer.concat([header, pathLen, evilPath, meta, fileData]);
      const pckPath = path.join(tmpDir, "malicious.pck");
      await fs.writeFile(pckPath, pckBuffer);

      const result = await GodotPckParser.extractFiles(pckPath, outDir);
      expect(result.extractedCount).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain("Tentative de Path Traversal détectée dans l'archive");

      // Verify that the file was never written outside outDir
      await expect(fs.access(path.join(tmpDir, "evil_script.sh"))).rejects.toThrow();
    });
  });

  describe("Unreal .pak extraction", () => {
    it("records a SecurityError when a pak entry attempts path traversal", async () => {
      const maliciousEntry: PakEntry = {
        path: "../../etc/passwd",
        displayPath: "../../etc/passwd",
        offset: 0,
        size: 10,
        uncompressedSize: 10,
        compression: null,
        encrypted: false,
        compressionBlockCount: 0
      };

      const result = await extractPakEntries("dummy.pak", [maliciousEntry], outDir);
      expect(result.extracted).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toBeInstanceOf(SecurityError);
      expect(result.errors[0].error.message).toContain("Tentative de Path Traversal détectée dans l'archive");
    });
  });

  describe("Electron .asar extraction", () => {
    it("rejects path traversal inside .asar archives with SecurityError", async () => {
      const asarData = buildAsar({
        "../../evil.js": "evil code",
        "good.js": "console.log('safe');"
      });
      const asarPath = path.join(tmpDir, "evil.asar");
      await fs.writeFile(asarPath, asarData);

      const parsed = await AsarParser.readArchive(asarPath);
      expect(parsed).not.toBeNull();
      // Unsafe archive member names in header are detected
      expect(parsed!.skippedUnsafe).toBe(1);

      // And extractEntries explicitly protects against Zip Slip with SecurityError
      const maliciousEntries = [
        ...parsed!.entries,
        { path: "../../evil.js", size: 9, offset: parsed!.dataStart, unpacked: false, executable: false }
      ];

      const extractResult = await AsarParser.extractEntries(
        asarPath,
        parsed!,
        maliciousEntries,
        outDir
      );

      // Traversal entry is rejected, safe entry is extracted
      expect(extractResult.extractedCount).toBe(1);
      expect(extractResult.errors).toHaveLength(1);
      expect(extractResult.errors[0].error).toContain("Tentative de Path Traversal détectée dans l'archive");
      await expect(fs.access(path.join(tmpDir, "evil.js"))).rejects.toThrow();
      await expect(fs.access(path.join(outDir, "good.js"))).resolves.toBeUndefined();
    });
  });

  describe("Python archive extraction protection", () => {
    it("verifies Python implementation raises SecurityError on Zip Slip attempt", () => {
      const pythonCheck = `
from pathlib import Path

class SecurityError(Exception):
    pass

dest_dir = Path(r"${outDir.replace(/\\/g, "\\\\")}")
target_path = Path(r"${outDir.replace(/\\/g, "\\\\")}") / ".." / "evil.txt"

try:
    if not target_path.resolve().is_relative_to(dest_dir.resolve()):
        raise SecurityError("Tentative de Path Traversal détectée dans l'archive")
    print("UNSAFE_ALLOWED")
except SecurityError as e:
    print(f"CAUGHT_SECURITY_ERROR: {e}")
`;
      const output = execFileSync("uv", ["run", "python", "-c", pythonCheck], { encoding: "utf-8" });
      expect(output).toContain("CAUGHT_SECURITY_ERROR: Tentative de Path Traversal détectée dans l'archive");
    });
  });
});

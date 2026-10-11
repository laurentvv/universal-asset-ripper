import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parsePeHeaderArch, readHeaderBytes } from "../utils/file-utils.js";
import type { BinaryScanResult } from "../types/index.js";

// Rijndael AES SubBytes first 16 bytes
const AES_SBOX_PREFIX = Buffer.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5,
  0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76
]);

// IL2CPP global-metadata.dat magic: 0xFAB11BAF (in little endian: AF 1B B1 FA)
const IL2CPP_METADATA_MAGIC = 0xfab11baf;

export class BinaryScanner {
  /**
   * Calculate Shannon entropy of a byte buffer
   */
  static calculateEntropy(buffer: Buffer): number {
    if (buffer.length === 0) return 0;
    const frequencies = new Array(256).fill(0);
    for (let i = 0; i < buffer.length; i++) {
      frequencies[buffer[i]]++;
    }

    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (frequencies[i] > 0) {
        const p = frequencies[i] / buffer.length;
        entropy -= p * Math.log2(p);
      }
    }
    return entropy;
  }

  /**
   * Search for hex string AES keys (e.g. 0x[64 hex chars] or 64 hex chars)
   */
  static searchHexAesStrings(buffer: Buffer): Array<{ keyHex: string; offset: number }> {
    const text = buffer.toString("latin1");
    const regex = /(?:0x)?([A-Fa-f0-9]{64})/g;
    const results: Array<{ keyHex: string; offset: number }> = [];

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const keyHex = match[1].toLowerCase();
      // Filter out trivial repeating patterns (e.g. 000000... or ffffff...)
      if (!/^(.)\1+$/.test(keyHex)) {
        results.push({
          keyHex: `0x${keyHex}`,
          offset: match.index
        });
      }
    }

    return results;
  }

  /**
   * Search for binary AES keys near AES S-box constants
   */
  static searchNearSBox(buffer: Buffer): Array<{ keyHex: string; offset: number; entropy: number }> {
    const candidates: Array<{ keyHex: string; offset: number; entropy: number }> = [];
    let sboxOffset = -1;

    // Search for S-box prefix
    for (let i = 0; i <= buffer.length - AES_SBOX_PREFIX.length; i++) {
      if (buffer.subarray(i, i + AES_SBOX_PREFIX.length).equals(AES_SBOX_PREFIX)) {
        sboxOffset = i;
        break;
      }
    }

    if (sboxOffset >= 0) {
      // Look within +/- 8KB of S-box for 32-byte high-entropy buffers
      const searchStart = Math.max(0, sboxOffset - 8192);
      const searchEnd = Math.min(buffer.length - 32, sboxOffset + 8192);

      for (let pos = searchStart; pos <= searchEnd; pos += 4) {
        const chunk = buffer.subarray(pos, pos + 32);
        const entropy = this.calculateEntropy(chunk);
        // AES key entropy is typically > 4.5
        if (entropy > 4.6) {
          candidates.push({
            keyHex: `0x${chunk.toString("hex")}`,
            offset: pos,
            entropy
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Inspect IL2CPP global-metadata.dat
   */
  static async inspectIl2CppMetadata(filePath: string): Promise<{ version: number; validMagic: boolean } | null> {
    try {
      const header = await readHeaderBytes(filePath, 32);
      if (header.length < 8) return null;

      const magic = header.readUInt32LE(0);
      if (magic === IL2CPP_METADATA_MAGIC) {
        const version = header.readInt32LE(4);
        return { version, validMagic: true };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Perform comprehensive binary scan on an executable or dump
   */
  static async scanBinary(binaryPath: string): Promise<BinaryScanResult> {
    const arch = await parsePeHeaderArch(binaryPath);
    const stat = await fs.stat(binaryPath);
    const readSize = Math.min(Number(stat.size), 64 * 1024 * 1024); // Scan up to 64MB

    let fileHandle: fs.FileHandle | undefined;
    const candidateAesKeys: BinaryScanResult["candidateAesKeys"] = [];
    const stringsFound: string[] = [];
    const recommendations: string[] = [];

    try {
      fileHandle = await fs.open(binaryPath, "r");
      const buffer = Buffer.alloc(readSize);
      await fileHandle.read(buffer, 0, readSize, 0);

      // 1. Search hex string AES keys
      const hexKeys = this.searchHexAesStrings(buffer);
      for (const hk of hexKeys) {
        const rawBuf = Buffer.from(hk.keyHex.replace("0x", ""), "hex");
        const entropy = this.calculateEntropy(rawBuf);
        candidateAesKeys.push({
          keyHex: hk.keyHex,
          offset: hk.offset,
          entropy,
          confidence: entropy > 4.2 ? "high" : "medium",
          pattern: "Hex String Pattern"
        });
      }

      // 2. Search binary S-Box proximity keys
      const sboxKeys = this.searchNearSBox(buffer);
      for (const sk of sboxKeys.slice(0, 5)) {
        candidateAesKeys.push({
          keyHex: sk.keyHex,
          offset: sk.offset,
          entropy: sk.entropy,
          confidence: "medium",
          pattern: "Near Rijndael S-Box"
        });
      }

      // Check for common engine strings
      const asciiText = buffer.toString("latin1");
      if (asciiText.includes("UnrealEngine")) stringsFound.push("UnrealEngine signature");
      if (asciiText.includes("FArchive")) stringsFound.push("Unreal Serialization (FArchive)");
      if (asciiText.includes("UnityPlayer")) stringsFound.push("UnityPlayer runtime reference");
      if (asciiText.includes("il2cpp")) stringsFound.push("IL2CPP runtime symbols");
      if (asciiText.includes("Godot Engine")) stringsFound.push("Godot Engine banner string");

      // Check sibling files for global-metadata.dat
      let il2cppMetadata: BinaryScanResult["il2cppMetadata"];
      const parentDir = path.dirname(binaryPath);
      const possibleMetadataPaths = [
        path.join(parentDir, "il2cpp_data", "Metadata", "global-metadata.dat"),
        path.join(parentDir, "Metadata", "global-metadata.dat"),
        path.join(parentDir, "global-metadata.dat")
      ];

      for (const metaPath of possibleMetadataPaths) {
        try {
          const metaStat = await fs.stat(metaPath);
          if (metaStat.isFile()) {
            const res = await this.inspectIl2CppMetadata(metaPath);
            if (res) {
              il2cppMetadata = {
                validMagic: res.validMagic,
                version: res.version,
                offset: 0
              };
              recommendations.push(`Found IL2CPP global-metadata.dat v${res.version}. Use Il2CppDumper or REA agent.`);
              break;
            }
          }
        } catch {
          // Continue
        }
      }

      if (candidateAesKeys.length > 0) {
        recommendations.push(`Detected ${candidateAesKeys.length} candidate AES-256 keys. Test them with 'ripper extract <pak> --aes-key <key>'`);
      } else {
        recommendations.push("No obvious plaintext AES key found. Consider using REA Ghidra/Hopper agent to trace FAES::Decrypt calls.");
      }

      return {
        binaryPath,
        arch,
        candidateAesKeys: candidateAesKeys.slice(0, 10),
        il2cppMetadata,
        stringsFound,
        recommendations
      };
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }
}

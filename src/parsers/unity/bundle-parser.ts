import * as fs from "node:fs/promises";

export interface UnityBundleInfo {
  signature: "UnityFS" | "UnityWeb" | "UnityRaw" | "SerializedFile";
  formatVersion: number;
  engineVersion: string;
  minPlayerVersion?: string;
  size: bigint;
  compressedSize?: number;
  uncompressedSize?: number;
}

export class UnityBundleParser {
  /**
   * Check if file is a Unity bundle or serialized asset file
   */
  static async readBundleInfo(filePath: string): Promise<UnityBundleInfo | null> {
    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      const stat = await fileHandle.stat();
      if (stat.size < 32) return null;

      const headerBuf = Buffer.alloc(256);
      await fileHandle.read(headerBuf, 0, 256, 0);

      // Check for string signature at start
      const signatureStr = headerBuf.subarray(0, 16).toString("ascii").replace(/\0.*$/, "").trim();

      if (signatureStr === "UnityFS" || signatureStr === "UnityWeb" || signatureStr === "UnityRaw") {
        // Read format version
        const sigLen = signatureStr.length + 1; // null-terminated
        const formatVersion = headerBuf.readUInt32BE(sigLen);

        // Unity version string null-terminated
        const unityVerStart = sigLen + 4;
        const nullIdx = headerBuf.indexOf(0, unityVerStart);
        const engineVersion = nullIdx > unityVerStart
          ? headerBuf.subarray(unityVerStart, nullIdx).toString("ascii")
          : "Unknown";

        return {
          signature: signatureStr,
          formatVersion,
          engineVersion,
          size: BigInt(stat.size)
        };
      }

      // Check SerializedFile (usually starts with metadataSize, fileSize in Big-Endian)
      // SerializedFile header has version at offset 8 (or 12 in 64-bit format)
      // Usually version is between 9 and 22 for Unity 4 to Unity 2022/6
      const possibleVer = headerBuf.readUInt32BE(8);
      if (possibleVer >= 9 && possibleVer <= 30) {
        return {
          signature: "SerializedFile",
          formatVersion: possibleVer,
          engineVersion: `Unity Serialized v${possibleVer}`,
          size: BigInt(stat.size)
        };
      }

      return null;
    } catch {
      return null;
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }
}

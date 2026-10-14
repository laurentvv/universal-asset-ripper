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

        // Two null-terminated strings follow: the minimum player version ("5.x.x")
        // and the real engine version/revision ("2021.3.16f1")
        const minPlayerVersion = this.readCString(headerBuf, sigLen + 4);
        const engineVersion = minPlayerVersion
          ? this.readCString(headerBuf, sigLen + 4 + minPlayerVersion.length + 1)
          : undefined;

        return {
          signature: signatureStr,
          formatVersion,
          engineVersion: engineVersion || minPlayerVersion || "Unknown",
          minPlayerVersion: minPlayerVersion || undefined,
          size: BigInt(stat.size)
        };
      }

      // SerializedFile header is Big-Endian: metadataSize, fileSize, version, dataOffset (v9-21).
      // v22+ zeroes those legacy fields and stores metadataSize(u32@16), fileSize(i64@20), dataOffset(i64@28).
      // The version range alone also matches PNG and other formats, so the stored size must equal the real one.
      const possibleVer = headerBuf.readUInt32BE(8);
      if (possibleVer >= 9 && possibleVer <= 21) {
        const metadataSize = headerBuf.readUInt32BE(0);
        const fileSize = headerBuf.readUInt32BE(4);
        const dataOffset = headerBuf.readUInt32BE(12);
        if (fileSize === stat.size && metadataSize <= fileSize && dataOffset <= fileSize) {
          return this.serializedInfo(possibleVer, stat.size);
        }
      } else if (possibleVer >= 22 && possibleVer <= 30) {
        const metadataSize = headerBuf.readUInt32BE(16);
        const fileSize = headerBuf.readBigUInt64BE(20);
        const dataOffset = headerBuf.readBigUInt64BE(28);
        if (fileSize === BigInt(stat.size) && BigInt(metadataSize) <= fileSize && dataOffset <= fileSize) {
          return this.serializedInfo(possibleVer, stat.size);
        }
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

  private static serializedInfo(version: number, size: number): UnityBundleInfo {
    return {
      signature: "SerializedFile",
      formatVersion: version,
      engineVersion: `Unity Serialized v${version}`,
      size: BigInt(size)
    };
  }

  private static readCString(buf: Buffer, start: number): string {
    if (start >= buf.length) return "";
    const end = buf.indexOf(0, start);
    return buf.subarray(start, end > start ? end : start).toString("ascii");
  }
}

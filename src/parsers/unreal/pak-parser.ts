import * as fs from "node:fs/promises";

export const UE_PAK_MAGIC = 0x5a6f12e1; // 0xE1, 0x12, 0x6F, 0x5A

export interface UnrealPakInfo {
  magic: number;
  version: number;
  indexOffset: bigint;
  indexSize: bigint;
  isEncrypted: boolean;
  compressionMethods?: string[];
  footerOffset: number;
}

export class UnrealPakParser {
  /**
   * Search for FPakInfo in the last 512 bytes of a file
   */
  static async readPakInfo(filePath: string): Promise<UnrealPakInfo | null> {
    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      const stat = await fileHandle.stat();
      if (stat.size < 64) return null;

      const footerReadSize = Math.min(512, Number(stat.size));
      const footerBuf = Buffer.alloc(footerReadSize);
      await fileHandle.read(footerBuf, 0, footerReadSize, stat.size - footerReadSize);

      // Search for UE_PAK_MAGIC
      for (let offset = footerReadSize - 4; offset >= 0; offset--) {
        if (footerBuf.readUInt32LE(offset) === UE_PAK_MAGIC) {
          // Version is 4 bytes after magic (or earlier depending on format version)
          // In UE Pak format:
          // Version 1..7: Magic is at offset 0 of FPakInfo, or at the end.
          // In standard UE4 FPakInfo (v8+):
          // Format has:
          // ...
          // Magic: uint32
          // Version: int32
          // IndexOffset: int64
          // IndexSize: int64
          // IndexSHA1: 20 bytes
          // bEncrypted: uint8
          // Let's parse with safe guards
          const version = offset + 8 <= footerReadSize ? footerBuf.readInt32LE(offset + 4) : 0;
          let indexOffset = 0n;
          let indexSize = 0n;
          let isEncrypted = false;

          if (offset >= 16) {
            // In modern UE4/5 (v8A-v11), FPakInfo has index offset and size preceding or following magic
            // Let's check common layout
            if (offset + 24 <= footerReadSize) {
              indexOffset = footerBuf.readBigInt64LE(offset + 8);
              indexSize = footerBuf.readBigInt64LE(offset + 16);
            }
          }

          // Check encrypted flag (last byte or near end)
          if (offset + 45 <= footerReadSize) {
            isEncrypted = footerBuf.readUInt8(offset + 44) !== 0;
          }

          return {
            magic: UE_PAK_MAGIC,
            version: version > 0 && version < 20 ? version : 8,
            indexOffset,
            indexSize,
            isEncrypted,
            footerOffset: Number(stat.size) - (footerReadSize - offset)
          };
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
}

import * as fs from "node:fs/promises";

export const UE_PAK_MAGIC = 0x5a6f12e1; // 0xE1, 0x12, 0x6F, 0x5A

const MIN_PAK_VERSION = 1;
const MAX_PAK_VERSION = 12;
const COMPRESSION_NAME_SIZE = 32;

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
   * Search for FPakInfo in the last 512 bytes of a file.
   *
   * Footer layout (trumank/repak footer.rs), always ending at EOF:
   *   [guid16 (v7+)][encrypted u8 (v4+)][magic u32][version u32][indexOffset u64][indexSize u64]
   *   [hash20][frozen u8 (v9 only)][compression names, 32 bytes each: none below v8, 4 for v8A, 5 for v8B+]
   */
  static async readPakInfo(filePath: string): Promise<UnrealPakInfo | null> {
    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      const stat = await fileHandle.stat();
      if (stat.size < 44) return null;

      const footerReadSize = Math.min(512, Number(stat.size));
      const footerBuf = Buffer.alloc(footerReadSize);
      await fileHandle.read(footerBuf, 0, footerReadSize, stat.size - footerReadSize);

      // Search for UE_PAK_MAGIC, nearest to EOF first
      for (let offset = footerReadSize - 8; offset >= 0; offset--) {
        if (footerBuf.readUInt32LE(offset) !== UE_PAK_MAGIC) continue;

        const version = footerBuf.readInt32LE(offset + 4);
        if (version < MIN_PAK_VERSION || version > MAX_PAK_VERSION) continue;

        let indexOffset = 0n;
        let indexSize = 0n;
        if (offset + 24 <= footerReadSize) {
          indexOffset = footerBuf.readBigInt64LE(offset + 8);
          indexSize = footerBuf.readBigInt64LE(offset + 16);
        }

        // The encrypted-index flag is the byte right before the magic (v4+)
        const isEncrypted = version >= 4 && offset >= 1 ? footerBuf.readUInt8(offset - 1) !== 0 : false;

        // Everything after hash (and the v9 frozen byte) is the compression method table
        const compressionMethods: string[] = [];
        if (version >= 8) {
          const fixedLen = 44 + (version === 9 ? 1 : 0);
          const nameCount = Math.min(5, Math.floor((footerReadSize - offset - fixedLen) / COMPRESSION_NAME_SIZE));
          for (let i = 0; i < nameCount; i++) {
            const start = offset + fixedLen + i * COMPRESSION_NAME_SIZE;
            const raw = footerBuf.subarray(start, start + COMPRESSION_NAME_SIZE);
            const nul = raw.indexOf(0);
            const name = (nul >= 0 ? raw.subarray(0, nul) : raw).toString("ascii");
            if (name.length > 0) compressionMethods.push(name);
          }
        }

        return {
          magic: UE_PAK_MAGIC,
          version,
          indexOffset,
          indexSize,
          isEncrypted,
          compressionMethods,
          footerOffset: Number(stat.size) - (footerReadSize - offset)
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

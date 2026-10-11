import * as fs from "node:fs/promises";
import * as path from "node:path";
import { categorizeExtension } from "../../utils/file-utils.js";
import type { AssetItem } from "../../types/index.js";

export const GDPC_MAGIC = 0x43504447; // "GDPC" in Little Endian

export interface PckHeader {
  magic: number;
  formatVersion: number;
  engineMajor: number;
  engineMinor: number;
  enginePatch: number;
  flags: number;
  filesBaseOffset: bigint;
  fileCount: number;
  isEmbedded: boolean;
  pckStartOffset: bigint;
}

export interface PckFileEntry {
  path: string;
  offset: bigint;
  size: bigint;
  md5: string;
  flags: number;
}

export class GodotPckParser {
  /**
   * Find PCK start offset in a file (standalone or embedded in an executable)
   */
  static async findPckOffset(filePath: string): Promise<{ offset: bigint; isEmbedded: boolean } | null> {
    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      const stat = await fileHandle.stat();
      if (stat.size < 16) return null;

      // 1. Check if starts with GDPC
      const headBuf = Buffer.alloc(4);
      await fileHandle.read(headBuf, 0, 4, 0);
      if (headBuf.readUInt32LE(0) === GDPC_MAGIC) {
        return { offset: 0n, isEmbedded: false };
      }

      // 2. Check footer for embedded PCK
      // Godot embeds: [PCK content] ... [8 bytes offset to PCK] [4 bytes GDPC magic] (total 12 bytes footer)
      const footerSize = Math.min(64, Number(stat.size));
      const footBuf = Buffer.alloc(footerSize);
      await fileHandle.read(footBuf, 0, footerSize, stat.size - footerSize);

      // Search for magic GDPC near the end
      for (let i = footerSize - 4; i >= 0; i--) {
        if (footBuf.readUInt32LE(i) === GDPC_MAGIC) {
          // In standard Godot binaries, 8 bytes before magic holds int64 offset to PCK
          if (i >= 8) {
            const pckOffset = footBuf.readBigInt64LE(i - 8);
            if (pckOffset >= 0n && pckOffset < BigInt(stat.size)) {
              // Verify that at pckOffset, there is GDPC
              const verifyBuf = Buffer.alloc(4);
              await fileHandle.read(verifyBuf, 0, 4, Number(pckOffset));
              if (verifyBuf.readUInt32LE(0) === GDPC_MAGIC) {
                return { offset: pckOffset, isEmbedded: true };
              }
            }
          }
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

  /**
   * Read and parse the PCK header & index
   */
  static async readManifest(filePath: string): Promise<{ header: PckHeader; files: PckFileEntry[] } | null> {
    const loc = await this.findPckOffset(filePath);
    if (!loc) return null;

    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      let currentOffset = loc.offset;

      // Read initial header block (magic + format + versions = 20 bytes)
      const headerBuf = Buffer.alloc(128);
      await fileHandle.read(headerBuf, 0, 128, Number(currentOffset));

      const magic = headerBuf.readUInt32LE(0);
      if (magic !== GDPC_MAGIC) return null;

      const formatVersion = headerBuf.readUInt32LE(4);
      const engineMajor = headerBuf.readUInt32LE(8);
      const engineMinor = headerBuf.readUInt32LE(12);
      const enginePatch = headerBuf.readUInt32LE(16);

      let flags = 0;
      let filesBaseOffset = 0n;
      let cursor = 20;

      if (formatVersion >= 2) {
        flags = headerBuf.readUInt32LE(cursor);
        cursor += 4;
        filesBaseOffset = headerBuf.readBigInt64LE(cursor);
        cursor += 8;
      }
      // In Godot PCK format, 16 reserved uint32 (64 bytes) follow
      cursor += 64;

      // Read file count
      const countBuf = Buffer.alloc(4);
      await fileHandle.read(countBuf, 0, 4, Number(currentOffset) + cursor);
      cursor += 4;
      const fileCount = countBuf.readUInt32LE(0);

      const files: PckFileEntry[] = [];
      let indexOffset = Number(currentOffset) + cursor;

      // Read all file entries
      for (let i = 0; i < fileCount; i++) {
        const lenBuf = Buffer.alloc(4);
        await fileHandle.read(lenBuf, 0, 4, indexOffset);
        indexOffset += 4;
        const pathLen = lenBuf.readUInt32LE(0);

        if (pathLen > 4096 || pathLen === 0) {
          break; // Safeguard against malformed index
        }

        // Align pathLen to 4 bytes if padded, or read exact
        const pathBuf = Buffer.alloc(pathLen);
        await fileHandle.read(pathBuf, 0, pathLen, indexOffset);
        indexOffset += pathLen;
        // Godot strings in PCK might have null terminator or 4-byte alignment
        const nullIdx = pathBuf.indexOf(0);
        const entryPath = pathBuf.subarray(0, nullIdx >= 0 ? nullIdx : pathLen).toString("utf-8");

        const metaBuf = Buffer.alloc(formatVersion >= 2 ? 36 : 32);
        // Offset: 8 bytes (int64)
        // Size: 8 bytes (int64)
        // MD5: 16 bytes
        // Flags: 4 bytes (v2+)
        await fileHandle.read(metaBuf, 0, metaBuf.length, indexOffset);
        indexOffset += metaBuf.length;

        const fileOffset = metaBuf.readBigInt64LE(0);
        const fileSize = metaBuf.readBigInt64LE(8);
        const md5 = metaBuf.subarray(16, 32).toString("hex");
        const fileFlags = formatVersion >= 2 ? metaBuf.readUInt32LE(32) : 0;

        files.push({
          path: entryPath,
          offset: fileOffset,
          size: fileSize,
          md5,
          flags: fileFlags
        });
      }

      return {
        header: {
          magic,
          formatVersion,
          engineMajor,
          engineMinor,
          enginePatch,
          flags,
          filesBaseOffset,
          fileCount: files.length,
          isEmbedded: loc.isEmbedded,
          pckStartOffset: loc.offset
        },
        files
      };
    } catch {
      return null;
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }

  /**
   * Convert PCK files list into standard AssetItem array
   */
  static toAssetItems(files: PckFileEntry[]): AssetItem[] {
    return files.map((file) => {
      // Clean 'res://' prefix
      const cleanPath = file.path.replace(/^res:\/\//, "");
      const category = categorizeExtension(cleanPath);

      return {
        path: cleanPath,
        category,
        size: Number(file.size),
        offset: Number(file.offset),
        encrypted: (file.flags & 1) !== 0,
        metadata: {
          originalPath: file.path,
          md5: file.md5,
          flags: file.flags
        }
      };
    });
  }

  /**
   * Extract files from PCK to target directory
   */
  static async extractFiles(
    pckFilePath: string,
    outputDir: string,
    filesToExtract?: PckFileEntry[]
  ): Promise<{ extractedCount: number; errors: Array<{ file: string; error: string }> }> {
    const manifest = await this.readManifest(pckFilePath);
    if (!manifest) {
      throw new Error(`Failed to parse Godot PCK header in: ${pckFilePath}`);
    }

    const targetList = filesToExtract ?? manifest.files;
    let fileHandle: fs.FileHandle | undefined;
    const errors: Array<{ file: string; error: string }> = [];
    let extractedCount = 0;

    try {
      fileHandle = await fs.open(pckFilePath, "r");

      for (const entry of targetList) {
        try {
          const cleanRelPath = entry.path.replace(/^res:\/\//, "").replace(/\.\./g, "_");
          const outFilePath = path.join(outputDir, cleanRelPath);
          await fs.mkdir(path.dirname(outFilePath), { recursive: true });

          const size = Number(entry.size);
          const buf = Buffer.alloc(size);
          if (size > 0) {
            await fileHandle.read(buf, 0, size, Number(entry.offset));
          }
          await fs.writeFile(outFilePath, buf);
          extractedCount++;
        } catch (err: unknown) {
          errors.push({
            file: entry.path,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      return { extractedCount, errors };
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }
}

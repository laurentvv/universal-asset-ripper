import * as fs from "node:fs/promises";
import * as path from "node:path";
import { categorizeExtension, copyRangeToFile, resolveSafeOutputPath } from "../../utils/file-utils.js";
import type { AssetItem } from "../../types/index.js";

export const GDPC_MAGIC = 0x43504447; // "GDPC" in Little Endian

const PACK_DIR_ENCRYPTED = 1;
const PACK_REL_FILEBASE = 2;
const PCK_ENTRY_ENCRYPTED = 1;
const MAX_INDEX_READ = 256 * 1024 * 1024;

export interface PckHeader {
  magic: number;
  formatVersion: number;
  engineMajor: number;
  engineMinor: number;
  enginePatch: number;
  flags: number;
  filesBaseOffset: bigint;
  directoryOffset: bigint; // Relative to pckStartOffset (v3+ only, 0 otherwise)
  fileCount: number;
  isEmbedded: boolean;
  pckStartOffset: bigint;
}

export interface PckFileEntry {
  path: string;
  offset: bigint; // Absolute position of the file data inside the container file
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
      const fileSize = stat.size;
      if (fileSize < 16) return null;

      const hasMagicAt = async (pos: number): Promise<boolean> => {
        if (pos < 0 || pos + 4 > fileSize) return false;
        const b = Buffer.alloc(4);
        await fileHandle!.read(b, 0, 4, pos);
        return b.readUInt32LE(0) === GDPC_MAGIC;
      };

      // 1. Standalone PCK
      if (await hasMagicAt(0)) {
        return { offset: 0n, isEmbedded: false };
      }

      // 2. Trailer of an embedded PCK: [u64 pck data size][GDPC], PCK starts at size - 12 - dataSize
      const trailer = Buffer.alloc(12);
      await fileHandle.read(trailer, 0, 12, fileSize - 12);
      if (trailer.readUInt32LE(8) === GDPC_MAGIC) {
        const dataSize = trailer.readBigUInt64LE(0);
        if (dataSize > 0n && dataSize <= BigInt(fileSize - 12)) {
          const start = fileSize - 12 - Number(dataSize);
          if (await hasMagicAt(start)) {
            return { offset: BigInt(start), isEmbedded: true };
          }
        }
      }

      // 3. Modern exports also store the PCK in a PE section named "pck"
      const sectionStart = await this.findPckPeSection(fileHandle, fileSize);
      if (sectionStart !== null && (await hasMagicAt(sectionStart))) {
        return { offset: BigInt(sectionStart), isEmbedded: true };
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
   * Return the raw file pointer of the PE section named "pck", if any
   */
  private static async findPckPeSection(fileHandle: fs.FileHandle, fileSize: number): Promise<number | null> {
    const dos = Buffer.alloc(64);
    await fileHandle.read(dos, 0, 64, 0);
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;

    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset + 24 > fileSize) return null;
    const coff = Buffer.alloc(24);
    await fileHandle.read(coff, 0, 24, peOffset);
    if (coff.readUInt32LE(0) !== 0x00004550) return null;

    const numSections = Math.min(coff.readUInt16LE(6), 96);
    const optionalSize = coff.readUInt16LE(20);
    const table = Buffer.alloc(numSections * 40);
    await fileHandle.read(table, 0, table.length, peOffset + 24 + optionalSize);

    for (let i = 0; i < numSections; i++) {
      const raw = table.subarray(i * 40, i * 40 + 8);
      const nul = raw.indexOf(0);
      const name = (nul >= 0 ? raw.subarray(0, nul) : raw).toString("ascii");
      if (name === "pck") return table.readUInt32LE(i * 40 + 20);
    }
    return null;
  }

  /**
   * Parse the directory entries of a PCK from an index buffer (starting at file_count).
   * Returns truncated=true when the buffer ended before all entries were read.
   */
  private static parseIndex(
    buf: Buffer,
    formatVersion: number,
    entryBase: bigint
  ): { files: PckFileEntry[]; truncated: boolean } {
    const files: PckFileEntry[] = [];
    if (buf.length < 4) return { files, truncated: false };

    const fileCount = buf.readUInt32LE(0);
    const metaSize = formatVersion >= 2 ? 36 : 32;
    let pos = 4;

    for (let i = 0; i < fileCount; i++) {
      if (pos + 4 > buf.length) return { files, truncated: true };
      const pathLen = buf.readUInt32LE(pos);
      if (pathLen > 4096 || pathLen === 0) break; // Safeguard against malformed index
      if (pos + 4 + pathLen + metaSize > buf.length) return { files, truncated: true };
      pos += 4;

      // Godot pads strings with zeros to a 4-byte boundary (pathLen includes the padding)
      const pathBuf = buf.subarray(pos, pos + pathLen);
      const nullIdx = pathBuf.indexOf(0);
      const entryPath = pathBuf.subarray(0, nullIdx >= 0 ? nullIdx : pathLen).toString("utf-8");
      pos += pathLen;

      files.push({
        path: entryPath,
        offset: entryBase + buf.readBigUInt64LE(pos),
        size: buf.readBigUInt64LE(pos + 8),
        md5: buf.subarray(pos + 16, pos + 32).toString("hex"),
        flags: formatVersion >= 2 ? buf.readUInt32LE(pos + 32) : 0
      });
      pos += metaSize;
    }

    return { files, truncated: false };
  }

  /**
   * Read and parse the PCK header & index (formats v0-v4)
   */
  static async readManifest(filePath: string): Promise<{ header: PckHeader; files: PckFileEntry[] } | null> {
    const loc = await this.findPckOffset(filePath);
    if (!loc) return null;

    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      const fileSize = (await fileHandle.stat()).size;
      const pckStart = Number(loc.offset);

      const headerBuf = Buffer.alloc(128);
      await fileHandle.read(headerBuf, 0, 128, pckStart);

      const magic = headerBuf.readUInt32LE(0);
      if (magic !== GDPC_MAGIC) return null;

      const formatVersion = headerBuf.readUInt32LE(4);
      if (formatVersion > 4) return null; // Unsupported future format
      const engineMajor = headerBuf.readUInt32LE(8);
      const engineMinor = headerBuf.readUInt32LE(12);
      const enginePatch = headerBuf.readUInt32LE(16);

      let flags = 0;
      let filesBaseOffset = 0n;
      let directoryOffset = 0n;
      let cursor = 20;

      if (formatVersion >= 2) {
        flags = headerBuf.readUInt32LE(cursor);
        filesBaseOffset = headerBuf.readBigUInt64LE(cursor + 4);
        cursor += 12;
      }
      if (formatVersion >= 3) {
        directoryOffset = headerBuf.readBigUInt64LE(cursor);
        cursor += 8;
      }
      // 16 reserved uint32 (64 bytes) follow
      cursor += 64;

      // v3+ keeps the directory at an explicit offset, older formats index inline after the header
      const indexStart = pckStart + (formatVersion >= 3 ? Number(directoryOffset) : cursor);
      const entryBase = loc.offset + (flags & PACK_REL_FILEBASE ? filesBaseOffset : 0n);

      let files: PckFileEntry[] = [];
      if (!(flags & PACK_DIR_ENCRYPTED) && indexStart < fileSize) {
        // Read the whole index in one buffer, growing it only if the directory is bigger
        const avail = fileSize - indexStart;
        let readLen = Math.min(avail, 4 * 1024 * 1024);
        for (;;) {
          const indexBuf = Buffer.alloc(readLen);
          await fileHandle.read(indexBuf, 0, readLen, indexStart);
          const parsed = this.parseIndex(indexBuf, formatVersion, entryBase);
          files = parsed.files;
          if (!parsed.truncated || readLen >= avail || readLen >= MAX_INDEX_READ) break;
          readLen = Math.min(avail, MAX_INDEX_READ, readLen * 4);
        }
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
          directoryOffset,
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
        encrypted: (file.flags & PCK_ENTRY_ENCRYPTED) !== 0,
        metadata: {
          originalPath: file.path,
          md5: file.md5,
          flags: file.flags
        }
      };
    });
  }

  /**
   * Extract files from PCK to target directory. Pass `filesToExtract` (entries from
   * readManifest, offsets are absolute) to avoid parsing the index again.
   */
  static async extractFiles(
    pckFilePath: string,
    outputDir: string,
    filesToExtract?: PckFileEntry[]
  ): Promise<{ extractedCount: number; errors: Array<{ file: string; error: string }> }> {
    let targetList = filesToExtract;
    if (!targetList) {
      const manifest = await this.readManifest(pckFilePath);
      if (!manifest) {
        throw new Error(`Failed to parse Godot PCK header in: ${pckFilePath}`);
      }
      targetList = manifest.files;
    }

    let fileHandle: fs.FileHandle | undefined;
    const errors: Array<{ file: string; error: string }> = [];
    let extractedCount = 0;

    try {
      fileHandle = await fs.open(pckFilePath, "r");
      const fileSize = (await fileHandle.stat()).size;

      for (const entry of targetList) {
        try {
          if (entry.flags & PCK_ENTRY_ENCRYPTED) {
            throw new Error("Encrypted PCK entries are not supported");
          }
          const outFilePath = resolveSafeOutputPath(outputDir, entry.path);
          if (!outFilePath) {
            throw new Error("Unsafe entry path rejected (escapes the output directory)");
          }
          if (entry.offset + entry.size > BigInt(fileSize)) {
            throw new Error("Entry data lies beyond the end of the file");
          }
          await fs.mkdir(path.dirname(outFilePath), { recursive: true });
          await copyRangeToFile(fileHandle, Number(entry.offset), Number(entry.size), outFilePath);
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

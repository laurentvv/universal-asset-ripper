import * as fs from "node:fs/promises";
import * as path from "node:path";
import { copyRangeToFile, resolveSafeOutputPath } from "../../utils/file-utils.js";

/**
 * Reader for Electron .asar archives.
 *
 * Layout (Chromium Pickle): [u32 4][u32 headerSize] then a header pickle of headerSize bytes:
 * [u32 payloadSize][u32 jsonLength][json, padded to 4]. File data starts at 8 + headerSize and the
 * JSON "files" tree stores each file as { size, offset: "<decimal string>" }; "unpacked" files live in
 * "<archive>.unpacked/", "link" entries are symlinks.
 */

const MAX_HEADER_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 2_000_000;

export interface AsarEntry {
  /** Forward-slash path inside the archive */
  path: string;
  size: number;
  /** Absolute offset of the data in the .asar file (-1 for unpacked files and links) */
  offset: number;
  unpacked: boolean;
  executable: boolean;
  /** Symlink target (such entries carry no data) */
  link?: string;
}

export interface AsarArchive {
  headerSize: number;
  dataStart: number;
  fileSize: number;
  entries: AsarEntry[];
  /** Header names that were ignored because they could escape the archive root */
  skippedUnsafe: number;
}

interface AsarNode {
  files?: Record<string, AsarNode>;
  size?: number;
  offset?: string | number;
  unpacked?: boolean;
  executable?: boolean;
  link?: string;
}

function isSafeName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/\0]/.test(name) && !/^[a-zA-Z]:/.test(name);
}

export class AsarParser {
  /**
   * Read and parse the header of an .asar archive; null when the file is not an asar
   */
  static async readArchive(filePath: string): Promise<AsarArchive | null> {
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(filePath, "r");
      const fileSize = (await fh.stat()).size;
      if (fileSize < 20) return null;

      const head = Buffer.alloc(16);
      await fh.read(head, 0, 16, 0);
      if (head.readUInt32LE(0) !== 4) return null;
      const headerSize = head.readUInt32LE(4);
      const payloadSize = head.readUInt32LE(8);
      const jsonLength = head.readUInt32LE(12);
      if (headerSize < 8 || headerSize > MAX_HEADER_BYTES || 8 + headerSize > fileSize) return null;
      if (payloadSize + 4 !== headerSize || jsonLength === 0 || jsonLength + 4 > payloadSize) return null;

      const json = Buffer.alloc(jsonLength);
      await fh.read(json, 0, jsonLength, 16);
      const root = JSON.parse(json.toString("utf8")) as AsarNode;
      if (!root || typeof root !== "object" || typeof root.files !== "object" || root.files === null) return null;

      const dataStart = 8 + headerSize;
      const entries: AsarEntry[] = [];
      let skippedUnsafe = 0;

      const walk = (node: AsarNode, prefix: string): void => {
        for (const [name, child] of Object.entries(node.files ?? {})) {
          if (entries.length >= MAX_ENTRIES) return;
          if (!isSafeName(name) || typeof child !== "object" || child === null) {
            skippedUnsafe++;
            continue;
          }
          const rel = prefix ? `${prefix}/${name}` : name;
          if (child.files && typeof child.files === "object") {
            walk(child, rel);
            continue;
          }
          const size = typeof child.size === "number" && child.size >= 0 ? child.size : 0;
          const unpacked = child.unpacked === true;
          const link = typeof child.link === "string" ? child.link : undefined;
          let offset = -1;
          if (!unpacked && link === undefined) {
            const raw = typeof child.offset === "string" ? Number(child.offset) : child.offset;
            if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
              skippedUnsafe++;
              continue;
            }
            offset = dataStart + raw;
          }
          entries.push({ path: rel, size, offset, unpacked, executable: child.executable === true, ...(link !== undefined ? { link } : {}) });
        }
      };
      walk(root, "");

      return { headerSize, dataStart, fileSize, entries, skippedUnsafe };
    } catch {
      return null;
    } finally {
      await fh?.close();
    }
  }

  /**
   * Quick check used by detection
   */
  static async isAsar(filePath: string): Promise<boolean> {
    return (await this.readArchive(filePath)) !== null;
  }

  /**
   * Extract entries below outputDir. `mapPath` turns an archive path into the output-relative path
   * (so adapters can prefix it); unsafe paths are rejected. Symlinks are skipped, "unpacked" files
   * are copied from "<archive>.unpacked/".
   */
  static async extractEntries(
    archivePath: string,
    archive: AsarArchive,
    entries: AsarEntry[],
    outputDir: string,
    mapPath: (entryPath: string) => string = (p) => p
  ): Promise<{ extractedCount: number; skippedLinks: number; errors: Array<{ file: string; error: string }> }> {
    const errors: Array<{ file: string; error: string }> = [];
    let extractedCount = 0;
    let skippedLinks = 0;
    const unpackedRoot = `${archivePath}.unpacked`;

    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(archivePath, "r");
      for (const entry of entries) {
        if (entry.link !== undefined) {
          skippedLinks++;
          continue;
        }
        try {
          const dest = resolveSafeOutputPath(outputDir, mapPath(entry.path));
          if (!dest) throw new Error("Unsafe entry path rejected (escapes the output directory)");
          await fs.mkdir(path.dirname(dest), { recursive: true });

          if (entry.unpacked) {
            const src = resolveSafeOutputPath(unpackedRoot, entry.path);
            if (!src) throw new Error("Unsafe unpacked path rejected");
            try {
              await fs.copyFile(src, dest);
            } catch {
              throw new Error(`Unpacked file not found next to the archive (${path.basename(unpackedRoot)}/${entry.path})`);
            }
          } else {
            if (entry.offset + entry.size > archive.fileSize) {
              throw new Error("Entry data lies beyond the end of the archive");
            }
            await copyRangeToFile(fh, entry.offset, entry.size, dest);
          }
          extractedCount++;
        } catch (err: unknown) {
          errors.push({ file: entry.path, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { extractedCount, skippedLinks, errors };
    } finally {
      await fh?.close();
    }
  }
}

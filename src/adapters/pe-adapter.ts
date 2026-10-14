import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { PeResourceParser, type PeInfo, type PeResourceEntry } from "../parsers/pe/pe-resource-parser.js";
import { buildBmpFile, decodeStringBlock, decodeVersionInfo } from "../parsers/pe/pe-resource-decoders.js";
import { convertBinaryDfmToText, isBinaryDfm } from "../parsers/delphi/dfm-converter.js";
import { resolveSafeOutputPath } from "../utils/file-utils.js";
import type {
  AssetCategory,
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult
} from "../types/index.js";

interface PeAssetEntry {
  asset: AssetItem;
  res: PeResourceEntry;
  /** "_l<languageId>" when the same resource exists in several languages, otherwise "" */
  suffix: string;
}

export class PeSoftwareAdapter extends BaseEngineAdapter {
  readonly engine: EngineType = "pe-software";

  async canHandle(targetPath: string): Promise<boolean> {
    try {
      const targetExe = await this.resolveExecutablePath(targetPath);
      if (!targetExe) return false;
      const peInfo = await PeResourceParser.parse(targetExe);
      return peInfo !== null;
    } catch {
      return false;
    }
  }

  private async resolveExecutablePath(targetPath: string): Promise<string | null> {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      const ext = path.extname(targetPath).toLowerCase();
      if (ext === ".exe" || ext === ".dll") return targetPath;
      return null;
    }
    if (stat.isDirectory()) {
      const files = await fs.readdir(targetPath);
      // Look for primary .exe
      const exes = files.filter((f) => f.toLowerCase().endsWith(".exe"));
      if (exes.length > 0) {
        return path.join(targetPath, exes[0]);
      }
    }
    return null;
  }

  /**
   * Resources that exist in several languages get a `_l<languageId>` suffix so they do not
   * overwrite each other; single-language resources keep their plain names.
   */
  private multiLanguageKeys(resources: PeResourceEntry[]): Set<string> {
    const langs = new Map<string, Set<number>>();
    for (const r of resources) {
      const key = `${r.typeName}|${r.nameOrId}`;
      const set = langs.get(key) ?? new Set<number>();
      set.add(r.languageId);
      langs.set(key, set);
    }
    return new Set([...langs].filter(([, set]) => set.size > 1).map(([key]) => key));
  }

  private languageSuffix(res: PeResourceEntry, multi: Set<string>): string {
    return multi.has(`${res.typeName}|${res.nameOrId}`) ? `_l${res.languageId}` : "";
  }

  /**
   * Build the AssetItems that inspect() reports, each paired with its PE resource so that
   * extract() can match categories/filter against exactly what inspect() shows.
   */
  private buildAssetEntries(peInfo: PeInfo): PeAssetEntry[] {
    const entries: PeAssetEntry[] = [];
    const multi = this.multiLanguageKeys(peInfo.resources);

    // Group icons / cursors represent unified .ico / .cur files
    const groupIcons = peInfo.resources.filter((r) => r.typeId === 14);
    const groupCursors = peInfo.resources.filter((r) => r.typeId === 12);
    for (const g of [...groupIcons, ...groupCursors]) {
      const suffix = this.languageSuffix(g, multi);
      const isIcon = g.typeId === 14;
      entries.push({
        res: g,
        suffix,
        asset: {
          path: isIcon ? `icons/icon_${g.nameOrId}${suffix}.ico` : `cursors/cursor_${g.nameOrId}${suffix}.cur`,
          category: "texture",
          size: g.size,
          metadata: {
            type: isIcon ? "RT_GROUP_ICON" : "RT_GROUP_CURSOR",
            nameOrId: g.nameOrId,
            languageId: g.languageId
          }
        }
      });
    }

    // Process other resources
    for (const res of peInfo.resources) {
      // Single RT_ICON / RT_CURSOR entries are bundled into their groups
      if (res.typeId === 3 && groupIcons.length > 0) continue;
      if (res.typeId === 1 && groupCursors.length > 0) continue;
      // Groups were added above
      if (res.typeId === 14 || res.typeId === 12) continue;

      const suffix = this.languageSuffix(res, multi);
      let category: AssetCategory = "other";
      let relPath = `resources/${res.typeName}/${res.nameOrId}${suffix}`;

      switch (res.typeId) {
        case 2: // RT_BITMAP
          category = "texture";
          relPath += ".bmp";
          break;
        case 24: // RT_MANIFEST
          category = "config";
          relPath += ".xml";
          break;
        case 16: // RT_VERSION
        case 6: // RT_STRING
          category = "config";
          relPath += ".json";
          break;
        case 10: // RT_RCDATA
          category = "config";
          relPath += ".rcdata";
          break;
        case 4: // RT_MENU
        case 5: // RT_DIALOG
          relPath += ".bin";
          break;
        case 8: // RT_FONT
          category = "font";
          relPath += ".fnt";
          break;
      }

      entries.push({
        res,
        suffix,
        asset: {
          path: relPath,
          category,
          size: res.size,
          offset: res.offset,
          metadata: {
            typeId: res.typeId,
            typeName: res.typeName,
            nameOrId: res.nameOrId,
            languageId: res.languageId
          }
        }
      });
    }

    return entries;
  }

  async inspect(targetPath: string): Promise<AssetManifest> {
    const exePath = await this.resolveExecutablePath(targetPath);
    if (!exePath) {
      throw new Error(`No Windows PE executable found in: ${targetPath}`);
    }

    const peInfo = await PeResourceParser.parse(exePath);
    if (!peInfo) {
      throw new Error(`Failed to parse PE resource header in: ${exePath}`);
    }

    const assets = this.buildAssetEntries(peInfo).map((e) => e.asset);
    const engineVersion = `${peInfo.framework} (${peInfo.arch})`;
    return this.createManifest(targetPath, assets, engineVersion);
  }

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const exePath = await this.resolveExecutablePath(targetPath);
    if (!exePath) {
      return {
        success: false,
        extractedCount: 0,
        outputDir: options.outputDir,
        durationMs: 0,
        errors: [{ file: targetPath, error: "No executable file found" }]
      };
    }

    const peInfo = await PeResourceParser.parse(exePath);
    if (!peInfo) {
      return {
        success: false,
        extractedCount: 0,
        outputDir: options.outputDir,
        durationMs: 0,
        errors: [{ file: exePath, error: "Failed to parse PE headers" }]
      };
    }

    const { selected, dryRun } = this.planExtraction(this.buildAssetEntries(peInfo), options, (e) => e.asset);

    let extractedCount = 0;
    const errors: Array<{ file: string; error: string }> = [];

    if (dryRun) {
      return {
        success: true,
        extractedCount: selected.length,
        outputDir: options.outputDir,
        durationMs: Date.now() - startTime,
        errors
      };
    }

    let fileHandle: fs.FileHandle | undefined;

    try {
      await fs.mkdir(options.outputDir, { recursive: true });
      fileHandle = await fs.open(exePath, "r");

      // 1. Extract selected icon / cursor groups as standalone .ico / .cur files
      const groupJobs = [
        { typeId: 14, dir: "icons", prefix: "icon", ext: "ico" },
        { typeId: 12, dir: "cursors", prefix: "cursor", ext: "cur" }
      ];
      for (const job of groupJobs) {
        const wanted = selected.filter((e) => e.res.typeId === job.typeId);
        if (wanted.length === 0) continue;

        const suffixOf = new Map(wanted.map((e) => [e.res, e.suffix]));
        const groupOptions = {
          groups: wanted.map((e) => e.res),
          nameFor: (g: PeResourceEntry) => `${job.prefix}_${g.nameOrId}${suffixOf.get(g) ?? ""}.${job.ext}`
        };
        const images =
          job.typeId === 14
            ? await PeResourceParser.extractIcons(exePath, peInfo.resources, groupOptions)
            : await PeResourceParser.extractCursors(exePath, peInfo.resources, groupOptions);

        for (const img of images) {
          try {
            const outPath = resolveSafeOutputPath(options.outputDir, `${job.dir}/${img.name}`);
            if (!outPath) throw new Error("Unsafe resource path rejected");
            await fs.mkdir(path.dirname(outPath), { recursive: true });
            await fs.writeFile(outPath, img.buffer);
            extractedCount++;
          } catch (err: unknown) {
            errors.push({ file: img.name, error: String(err) });
          }
        }
      }

      // 2. Extract manifests, bitmaps, RCDATA, strings, version info and other selected resources
      for (const { res, suffix } of selected) {
        // Icon / cursor groups were handled above
        if (res.typeId === 14 || res.typeId === 12) continue;

        try {
          const buf = Buffer.alloc(res.size);
          await fileHandle.read(buf, 0, res.size, res.offset);

          const id = `${res.nameOrId}${suffix}`;
          let subDir = res.typeName.toLowerCase();
          let fileName = `res_${id}`;
          let content: Buffer = buf;
          let extra: { fileName: string; content: Buffer } | null = null;

          if (res.typeId === 24) {
            // RT_MANIFEST
            subDir = "manifest";
            fileName = `manifest_${id}.xml`;
          } else if (res.typeId === 2) {
            // RT_BITMAP: add a BITMAPFILEHEADER with the right pixel data offset
            subDir = "bitmaps";
            fileName = `bitmap_${id}.bmp`;
            content = buildBmpFile(buf);
          } else if (res.typeId === 6) {
            // RT_STRING: one 16-string block as JSON
            const strings = typeof res.nameOrId === "number" ? decodeStringBlock(buf, res.nameOrId) : null;
            if (strings) {
              subDir = "strings";
              fileName = `strings_${id}.json`;
              content = Buffer.from(
                JSON.stringify({ blockId: res.nameOrId, languageId: res.languageId, strings }, null, 2),
                "utf8"
              );
            } else {
              fileName = `res_${id}.bin`;
            }
          } else if (res.typeId === 16) {
            // RT_VERSION: fixed file info + StringFileInfo as JSON
            const info = decodeVersionInfo(buf);
            subDir = "version";
            if (info) {
              fileName = `version_${id}.json`;
              content = Buffer.from(JSON.stringify(info, null, 2), "utf8");
            } else {
              fileName = `version_${id}.bin`;
            }
          } else if (res.typeId === 4 || res.typeId === 5) {
            // RT_MENU / RT_DIALOG stay raw
            fileName = `res_${id}.bin`;
          } else if (res.typeId === 10) {
            // RT_RCDATA
            subDir = "rcdata";
            if (isBinaryDfm(buf)) {
              // Delphi binary form: keep the raw .dfm and add a readable text version
              fileName = `form_${id}.dfm`;
              const text = convertBinaryDfmToText(buf);
              if (text !== null) {
                extra = { fileName: `form_${id}.txt`, content: Buffer.from(text, "utf8") };
              }
            } else if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
              fileName = `image_${id}.png`;
            } else {
              fileName = `data_${id}.bin`;
            }
          }

          // Resource type names can be arbitrary strings: never let them leave outputDir
          const outPath = resolveSafeOutputPath(options.outputDir, `${subDir}/${fileName}`);
          if (!outPath) {
            throw new Error("Unsafe resource path rejected");
          }
          await fs.mkdir(path.dirname(outPath), { recursive: true });
          await fs.writeFile(outPath, content);
          extractedCount++;

          if (extra) {
            const extraPath = resolveSafeOutputPath(options.outputDir, `${subDir}/${extra.fileName}`);
            if (extraPath) await fs.writeFile(extraPath, extra.content);
          }
        } catch (err: unknown) {
          errors.push({ file: `${res.typeName}_${res.nameOrId}`, error: String(err) });
        }
      }

      return {
        success: errors.length === 0,
        extractedCount,
        outputDir: options.outputDir,
        durationMs: Date.now() - startTime,
        errors
      };
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }
}

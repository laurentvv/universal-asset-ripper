import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { PeResourceParser, type PeInfo, type PeResourceEntry } from "../parsers/pe/pe-resource-parser.js";
import type {
  AssetCategory,
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult
} from "../types/index.js";

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

  async inspect(targetPath: string): Promise<AssetManifest> {
    const exePath = await this.resolveExecutablePath(targetPath);
    if (!exePath) {
      throw new Error(`No Windows PE executable found in: ${targetPath}`);
    }

    const peInfo = await PeResourceParser.parse(exePath);
    if (!peInfo) {
      throw new Error(`Failed to parse PE resource header in: ${exePath}`);
    }

    const assets: AssetItem[] = [];

    // Group icons represent unified .ico files
    const groupIcons = peInfo.resources.filter((r) => r.typeId === 14);
    for (const g of groupIcons) {
      assets.push({
        path: `icons/icon_${g.nameOrId}.ico`,
        category: "texture",
        size: g.size,
        metadata: { type: "RT_GROUP_ICON", nameOrId: g.nameOrId }
      });
    }

    // Process other resources
    for (const res of peInfo.resources) {
      // Skip single RT_ICON entries since they are bundled into group icons
      if (res.typeId === 3 && groupIcons.length > 0) continue;

      let category: AssetCategory = "other";
      let relPath = `resources/${res.typeName}/${res.nameOrId}`;

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
          category = "config";
          relPath += ".json";
          break;
        case 10: // RT_RCDATA
          category = "config";
          relPath += ".rcdata";
          break;
        case 8: // RT_FONT
          category = "font";
          relPath += ".fnt";
          break;
      }

      assets.push({
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
      });
    }

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

    let extractedCount = 0;
    const errors: Array<{ file: string; error: string }> = [];
    let fileHandle: fs.FileHandle | undefined;

    try {
      await fs.mkdir(options.outputDir, { recursive: true });
      fileHandle = await fs.open(exePath, "r");

      // 1. Extract icons as standalone .ico files
      const icons = await PeResourceParser.extractIcons(exePath, peInfo.resources);
      const iconDir = path.join(options.outputDir, "icons");
      if (icons.length > 0) {
        await fs.mkdir(iconDir, { recursive: true });
        for (const ico of icons) {
          try {
            await fs.writeFile(path.join(iconDir, ico.name), ico.buffer);
            extractedCount++;
          } catch (err: unknown) {
            errors.push({ file: ico.name, error: String(err) });
          }
        }
      }

      // 2. Extract manifests, bitmaps, RCDATA, and other resources
      for (const res of peInfo.resources) {
        // Skip RT_ICON and RT_GROUP_ICON as they were extracted above
        if (res.typeId === 3 || res.typeId === 14) continue;

        try {
          const buf = Buffer.alloc(res.size);
          await fileHandle.read(buf, 0, res.size, res.offset);

          let subDir = path.join(options.outputDir, res.typeName.toLowerCase());
          let fileName = `res_${res.nameOrId}`;

          if (res.typeId === 24) {
            // RT_MANIFEST
            subDir = path.join(options.outputDir, "manifest");
            fileName = `manifest_${res.nameOrId}.xml`;
          } else if (res.typeId === 2) {
            // RT_BITMAP
            subDir = path.join(options.outputDir, "bitmaps");
            fileName = `bitmap_${res.nameOrId}.bmp`;
            // Check if DIB header needs BITMAPFILEHEADER
            if (buf.length >= 40 && buf.readUInt32LE(0) === 40) {
              const fileHeader = Buffer.alloc(14);
              fileHeader.write("BM", 0);
              fileHeader.writeUInt32LE(14 + buf.length, 2);
              fileHeader.writeUInt32LE(14 + 40, 10);
              const bmpBuf = Buffer.concat([fileHeader, buf]);
              await fs.mkdir(subDir, { recursive: true });
              await fs.writeFile(path.join(subDir, fileName), bmpBuf);
              extractedCount++;
              continue;
            }
          } else if (res.typeId === 10) {
            // RT_RCDATA
            subDir = path.join(options.outputDir, "rcdata");
            // Check Delphi DFM magic "TPF0"
            if (buf.length >= 4 && buf.readUInt32LE(0) === 0x30465054) {
              fileName = `form_${res.nameOrId}.dfm`;
            } else if (buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
              fileName = `image_${res.nameOrId}.png`;
            } else {
              fileName = `data_${res.nameOrId}.bin`;
            }
          }

          await fs.mkdir(subDir, { recursive: true });
          await fs.writeFile(path.join(subDir, fileName), buf);
          extractedCount++;
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

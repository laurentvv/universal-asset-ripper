import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { GodotPckParser } from "../parsers/godot/pck-parser.js";
import type {
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult,
  InspectOptions
} from "../types/index.js";

export class GodotAdapter extends BaseEngineAdapter {
  readonly engine: EngineType = "godot";

  async canHandle(targetPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(targetPath);
      if (stat.isFile()) {
        const offsetInfo = await GodotPckParser.findPckOffset(targetPath);
        return offsetInfo !== null;
      }
      if (stat.isDirectory()) {
        const files = await fs.readdir(targetPath);
        for (const file of files) {
          if (file.toLowerCase().endsWith(".pck")) return true;
          if (file.toLowerCase().endsWith(".exe")) {
            const exePath = path.join(targetPath, file);
            const offsetInfo = await GodotPckParser.findPckOffset(exePath);
            if (offsetInfo !== null) return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Locate all PCK sources from the given target (single file or directory)
   */
  private async findPckSources(targetPath: string): Promise<string[]> {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      const info = await GodotPckParser.findPckOffset(targetPath);
      return info ? [targetPath] : [];
    }

    const sources: string[] = [];
    const entries = await fs.readdir(targetPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(targetPath, entry.name);
      if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (lower.endsWith(".pck")) {
          sources.push(fullPath);
        } else if (lower.endsWith(".exe")) {
          const info = await GodotPckParser.findPckOffset(fullPath);
          if (info) sources.push(fullPath);
        }
      }
    }

    return sources;
  }

  async inspect(targetPath: string, options: InspectOptions = {}): Promise<AssetManifest> {
    const sources = await this.findPckSources(targetPath);
    if (sources.length === 0) {
      throw new Error(`No Godot PCK package found in target: ${targetPath}`);
    }

    const allAssets: AssetItem[] = [];
    let detectedEngineVersion: string | undefined;

    for (const source of sources) {
      const manifest = await GodotPckParser.readManifest(source, { aesKey: options.aesKey });
      if (manifest) {
        if (manifest.directoryError) {
          throw new Error(`${path.basename(source)}: ${manifest.directoryError}`);
        }
        if (!detectedEngineVersion) {
          detectedEngineVersion = `${manifest.header.engineMajor}.${manifest.header.engineMinor}.${manifest.header.enginePatch}`;
        }
        const assets = GodotPckParser.toAssetItems(manifest.files);
        allAssets.push(...assets);
      }
    }

    return this.createManifest(targetPath, allAssets, detectedEngineVersion);
  }

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const sources = await this.findPckSources(targetPath);
    if (sources.length === 0) {
      return {
        success: false,
        extractedCount: 0,
        outputDir: options.outputDir,
        durationMs: Date.now() - startTime,
        errors: [{ file: targetPath, error: "No Godot PCK package found." }]
      };
    }

    let totalExtracted = 0;
    const errors: Array<{ file: string; error: string }> = [];

    // Parse and filter assets
    for (const source of sources) {
      const manifest = await GodotPckParser.readManifest(source, { aesKey: options.aesKey });
      if (!manifest) continue;
      if (manifest.directoryError) {
        errors.push({ file: source, error: manifest.directoryError });
        continue;
      }

      // Match categories/filter against the same AssetItem that inspect() reports
      const { selected, dryRun } = this.planExtraction(
        manifest.files,
        options,
        (fe) => GodotPckParser.toAssetItems([fe])[0]
      );

      if (dryRun) {
        totalExtracted += selected.length;
        continue;
      }

      const res = await GodotPckParser.extractFiles(source, options.outputDir, selected, {
        aesKey: options.aesKey,
        convertFormats: options.convertFormats
      });
      totalExtracted += res.extractedCount;
      errors.push(...res.errors);
    }

    const durationMs = Date.now() - startTime;
    return {
      success: errors.length === 0,
      extractedCount: totalExtracted,
      outputDir: options.outputDir,
      durationMs,
      errors
    };
  }
}

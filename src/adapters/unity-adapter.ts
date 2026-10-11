import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { UnityBundleParser } from "../parsers/unity/bundle-parser.js";
import { categorizeExtension, listFilesRecursively } from "../utils/file-utils.js";
import type {
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult
} from "../types/index.js";

const execAsync = promisify(exec);

export class UnityAdapter extends BaseEngineAdapter {
  readonly engine: EngineType = "unity";

  async canHandle(targetPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(targetPath);
      if (stat.isFile()) {
        const bundleInfo = await UnityBundleParser.readBundleInfo(targetPath);
        if (bundleInfo !== null) return true;
        const name = path.basename(targetPath).toLowerCase();
        if (name === "unityplayer.dll" || name === "globalgamemanagers" || name.endsWith(".assets")) {
          return true;
        }
      } else if (stat.isDirectory()) {
        const files = await fs.readdir(targetPath);
        for (const f of files) {
          const lower = f.toLowerCase();
          if (lower === "unityplayer.dll" || lower.endsWith("_data") || lower === "monobleedingedge") {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private async findUnityAssets(targetPath: string): Promise<string[]> {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      return [targetPath];
    }
    return listFilesRecursively(targetPath, 4);
  }

  async inspect(targetPath: string): Promise<AssetManifest> {
    const files = await this.findUnityAssets(targetPath);
    const assets: AssetItem[] = [];
    let detectedVersion: string | undefined;

    for (const f of files) {
      const stat = await fs.stat(f);
      const ext = path.extname(f).toLowerCase();
      const baseName = path.basename(f).toLowerCase();
      const relPath = path.relative(targetPath, f) || baseName;

      // Check bundle header for version if applicable
      if (assets.length < 5) {
        const bundleInfo = await UnityBundleParser.readBundleInfo(f);
        if (bundleInfo && !detectedVersion) {
          detectedVersion = bundleInfo.engineVersion;
        }
      }

      let category = categorizeExtension(f);
      if (ext === ".assets" || ext === ".sharedassets" || baseName === "globalgamemanagers") {
        category = "scene";
      }

      assets.push({
        path: relPath,
        category,
        size: stat.size,
        metadata: {
          isDataFile: ext === ".assets" || ext === ".sharedassets"
        }
      });
    }

    return this.createManifest(targetPath, assets, detectedVersion);
  }

  /**
   * Check if AssetRipper CLI is available
   */
  private async isAssetRipperAvailable(): Promise<string | null> {
    const candidates = ["AssetRipper", "AssetRipper.Cli", "AssetRipper.GUI"];
    for (const cmd of candidates) {
      try {
        await execAsync(`${cmd} --version`);
        return cmd;
      } catch {
        // Continue
      }
    }
    return null;
  }

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    await fs.mkdir(options.outputDir, { recursive: true });

    const assetRipperCmd = await this.isAssetRipperAvailable();
    const errors: Array<{ file: string; error: string }> = [];

    if (assetRipperCmd) {
      try {
        const cmd = `${assetRipperCmd} "${targetPath}" --output "${options.outputDir}" --quiet`;
        await execAsync(cmd);
        const extracted = await listFilesRecursively(options.outputDir);
        return {
          success: true,
          extractedCount: extracted.length,
          outputDir: options.outputDir,
          durationMs: Date.now() - startTime,
          errors: []
        };
      } catch (err: unknown) {
        errors.push({
          file: targetPath,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    } else {
      errors.push({
        file: targetPath,
        error: "AssetRipper CLI is not installed in PATH. Please install it via 'dotnet tool install -g AssetRipper.Cli' or download the release from https://github.com/AssetRipper/AssetRipper."
      });
    }

    return {
      success: errors.length === 0,
      extractedCount: 0,
      outputDir: options.outputDir,
      durationMs: Date.now() - startTime,
      errors
    };
  }
}

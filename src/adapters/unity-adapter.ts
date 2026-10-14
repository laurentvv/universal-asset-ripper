import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { UnityBundleParser } from "../parsers/unity/bundle-parser.js";
import { categorizeExtension, listFilesRecursively } from "../utils/file-utils.js";
import { findAssetRipper, runAssetRipperHeadless } from "../utils/assetripper.js";
import type {
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult
} from "../types/index.js";

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
          if (lower === "unityplayer.dll" || lower === "monobleedingedge") {
            return true;
          }
          // A *_Data folder alone is not enough: require Unity's own files inside
          if (lower.endsWith("_data")) {
            const inner = await fs.readdir(path.join(targetPath, f)).catch(() => [] as string[]);
            if (inner.some((n) => /^(globalgamemanagers|data\.unity3d|level0|resources\.assets)$/i.test(n))) {
              return true;
            }
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

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const errors: Array<{ file: string; error: string }> = [];
    const fail = (): ExtractionResult => ({
      success: false,
      extractedCount: 0,
      outputDir: options.outputDir,
      durationMs: Date.now() - startTime,
      errors
    });

    const hasSelection = (options.categories?.length ?? 0) > 0 || !!options.filter;

    if (options.dryRun) {
      // Nothing is written: report what the (filtered) inspection would cover
      const manifest = await this.inspect(targetPath);
      const { selected } = this.planExtraction(manifest.assets, options, (a) => a);
      return {
        success: true,
        extractedCount: selected.length,
        outputDir: options.outputDir,
        durationMs: Date.now() - startTime,
        errors: []
      };
    }

    if (hasSelection) {
      // AssetRipper exports the whole project; silently ignoring the selection would be misleading
      errors.push({
        file: targetPath,
        error: "categories/filter are not supported for Unity extraction (AssetRipper exports everything). Re-run without them, or use --dry-run to preview."
      });
      return fail();
    }

    const assetRipper = await findAssetRipper();

    if (assetRipper) {
      try {
        await fs.mkdir(options.outputDir, { recursive: true });
        await runAssetRipperHeadless({ executable: assetRipper, targetPath, outputDir: options.outputDir });
        const extracted = await listFilesRecursively(options.outputDir, 64);
        return {
          success: extracted.length > 0,
          extractedCount: extracted.length,
          outputDir: options.outputDir,
          durationMs: Date.now() - startTime,
          errors:
            extracted.length > 0
              ? []
              : [{ file: targetPath, error: "AssetRipper finished but wrote no files to the output directory." }]
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
        error:
          "AssetRipper was not found. Download AssetRipper.GUI.Free from https://github.com/AssetRipper/AssetRipper/releases, then set ASSETRIPPER_PATH to the executable (or its folder) or add it to PATH. It is driven through its headless web mode (there is no AssetRipper.Cli)."
      });
    }

    return fail();
  }
}

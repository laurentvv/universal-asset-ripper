import * as path from "node:path";
import type {
  AssetCategory,
  AssetItem,
  AssetManifest,
  CategorySummary,
  EngineType,
  ExtractOptions,
  ExtractionResult,
  IEngineAdapter
} from "../types/index.js";

export abstract class BaseEngineAdapter implements IEngineAdapter {
  abstract readonly engine: EngineType;

  abstract canHandle(targetPath: string): Promise<boolean>;
  abstract inspect(targetPath: string): Promise<AssetManifest>;
  abstract extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult>;

  /**
   * Helper to build a standard AssetManifest from a list of AssetItem
   */
  protected createManifest(
    targetPath: string,
    assets: AssetItem[],
    engineVersion?: string
  ): AssetManifest {
    const byCategory: Record<AssetCategory, CategorySummary> = {
      texture: { count: 0, totalBytes: 0 },
      mesh: { count: 0, totalBytes: 0 },
      audio: { count: 0, totalBytes: 0 },
      scene: { count: 0, totalBytes: 0 },
      script: { count: 0, totalBytes: 0 },
      shader: { count: 0, totalBytes: 0 },
      font: { count: 0, totalBytes: 0 },
      video: { count: 0, totalBytes: 0 },
      animation: { count: 0, totalBytes: 0 },
      config: { count: 0, totalBytes: 0 },
      other: { count: 0, totalBytes: 0 }
    };

    let totalBytes = 0;

    for (const asset of assets) {
      const cat = asset.category;
      if (!byCategory[cat]) {
        byCategory[cat] = { count: 0, totalBytes: 0 };
      }
      byCategory[cat].count++;
      byCategory[cat].totalBytes += asset.size;
      totalBytes += asset.size;
    }

    return {
      engine: this.engine,
      engineVersion,
      targetPath,
      totalFiles: assets.length,
      totalBytes,
      byCategory,
      assets
    };
  }

  /**
   * Filter assets based on ExtractOptions (categories, wildcard / regex filter)
   */
  protected filterAssets(assets: AssetItem[], options: ExtractOptions): AssetItem[] {
    let result = assets;

    if (options.categories && options.categories.length > 0) {
      const allowed = new Set(options.categories);
      result = result.filter((a) => allowed.has(a.category));
    }

    if (options.filter) {
      const filterLower = options.filter.toLowerCase();
      result = result.filter((a) => a.path.toLowerCase().includes(filterLower));
    }

    return result;
  }
}

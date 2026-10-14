import type {
  AssetCategory,
  AssetItem,
  AssetManifest,
  CategorySummary,
  EngineType,
  ExtractOptions,
  ExtractionResult,
  IEngineAdapter,
  InspectOptions
} from "../types/index.js";

export abstract class BaseEngineAdapter implements IEngineAdapter {
  abstract readonly engine: EngineType;

  abstract canHandle(targetPath: string): Promise<boolean>;
  abstract inspect(targetPath: string, options?: InspectOptions): Promise<AssetManifest>;
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
   * Single place where ExtractOptions (categories, substring filter, dry-run) are applied.
   * `describe` maps an adapter-specific item to the AssetItem fields used for matching, so
   * adapters filter on what inspect() reports.
   */
  protected planExtraction<T>(
    items: T[],
    options: ExtractOptions,
    describe: (item: T) => Pick<AssetItem, "path" | "category">
  ): { selected: T[]; dryRun: boolean } {
    let selected = items;

    if (options.categories && options.categories.length > 0) {
      const allowed = new Set(options.categories);
      selected = selected.filter((item) => allowed.has(describe(item).category));
    }

    if (options.filter) {
      const filterLower = options.filter.toLowerCase();
      selected = selected.filter((item) => describe(item).path.toLowerCase().includes(filterLower));
    }

    return { selected, dryRun: options.dryRun === true };
  }

  /**
   * Filter assets based on ExtractOptions (categories, substring filter)
   */
  protected filterAssets(assets: AssetItem[], options: ExtractOptions): AssetItem[] {
    return this.planExtraction(assets, options, (a) => a).selected;
  }
}

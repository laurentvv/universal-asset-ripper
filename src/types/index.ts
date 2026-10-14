export type EngineType = "unity" | "unreal" | "godot" | "pe-software" | "electron" | "unknown";

export const ASSET_CATEGORIES = [
  "texture",
  "mesh",
  "audio",
  "scene",
  "script",
  "shader",
  "font",
  "video",
  "animation",
  "config",
  "other"
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export interface EngineDetails {
  framework?: string;
  isIL2CPP?: boolean;
  isMono?: boolean;
  encrypted?: boolean;
  entryPoint?: string;
  markersFound: string[];
  detectedFiles: string[];
  notes?: string[];
}

export interface EngineDetectionResult {
  engine: EngineType;
  confidence: number; // 0.0 to 1.0
  version?: string;
  arch?: "x86" | "x64" | "arm64" | "unknown";
  containerType?: string;
  targetPath: string;
  details: EngineDetails;
}

export interface AssetItem {
  path: string;
  category: AssetCategory;
  size: number;
  offset?: number;
  format?: string;
  compressed?: boolean;
  encrypted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CategorySummary {
  count: number;
  totalBytes: number;
}

export interface AssetManifest {
  engine: EngineType;
  engineVersion?: string;
  targetPath: string;
  totalFiles: number;
  totalBytes: number;
  byCategory: Record<AssetCategory, CategorySummary>;
  assets: AssetItem[];
}

export interface ExtractOptions {
  outputDir: string;
  categories?: AssetCategory[];
  filter?: string;
  aesKey?: string;
  dryRun?: boolean;
  overwrite?: boolean;
  convertFormats?: boolean;
}

export interface ExtractionResult {
  success: boolean;
  extractedCount: number;
  outputDir: string;
  durationMs: number;
  errors: Array<{ file: string; error: string }>;
  manifest?: AssetManifest;
}

export interface IEngineAdapter {
  readonly engine: EngineType;
  canHandle(targetPath: string): Promise<boolean>;
  inspect(targetPath: string): Promise<AssetManifest>;
  extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult>;
}

export interface BinaryScanResult {
  binaryPath: string;
  arch: "x86" | "x64" | "arm64" | "unknown";
  candidateAesKeys: Array<{
    keyHex: string;
    offset: number;
    entropy: number;
    confidence: "high" | "medium" | "low";
    pattern: string;
  }>;
  il2cppMetadata?: {
    version?: number;
    offset?: number;
    validMagic?: boolean;
  };
  stringsFound: string[];
  recommendations: string[];
}

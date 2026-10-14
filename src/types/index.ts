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

export interface InspectOptions {
  /** AES-256 key (Unreal encrypted .pak index, Godot encrypted PCK) used to list encrypted containers */
  aesKey?: string;
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
  inspect(targetPath: string, options?: InspectOptions): Promise<AssetManifest>;
  extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult>;
}

export interface AesKeyCandidate {
  keyHex: string;
  offset: number;
  entropy: number;
  confidence: "high" | "medium" | "low";
  pattern: string;
  /** Number of places in the binary where the same key bytes/text were found */
  occurrences?: number;
  /** Distance in bytes from the nearest Rijndael S-box table (S-box candidates only) */
  distanceFromSBox?: number;
  /** Set when a pak was supplied: true = key opens it, false = rejected, null = pak cannot prove it */
  verified?: boolean | null;
  verification?: string;
}

export interface BinaryScanResult {
  binaryPath: string;
  arch: "x86" | "x64" | "arm64" | "unknown";
  candidateAesKeys: AesKeyCandidate[];
  /** Candidates found after filtering (the list above may be shorter) */
  candidateTotal: number;
  candidatesShown: number;
  candidateCounts: { hexString: number; sbox: number };
  /** Hex strings discarded as probable false positives, by reason */
  filteredOut: { longerHexRun: number; sequential: number; lowEntropy: number; repeatedBlock: number; trivial: number };
  scannedBytes: number;
  /** true when a safety cap stopped collecting candidates early */
  candidateCapReached?: boolean;
  /** Pak used for key verification, when given */
  verifiedAgainst?: string;
  il2cppMetadata?: {
    version?: number;
    offset?: number;
    validMagic?: boolean;
  };
  stringsFound: string[];
  recommendations: string[];
}

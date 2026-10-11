import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { UnrealPakParser, type UnrealPakInfo } from "../parsers/unreal/pak-parser.js";
import { categorizeExtension, listFilesRecursively } from "../utils/file-utils.js";
import type {
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult
} from "../types/index.js";

const execAsync = promisify(exec);

export class UnrealAdapter extends BaseEngineAdapter {
  readonly engine: EngineType = "unreal";

  async canHandle(targetPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(targetPath);
      if (stat.isFile()) {
        const ext = path.extname(targetPath).toLowerCase();
        if (ext === ".pak" || ext === ".utoc" || ext === ".ucas") return true;
        const pakInfo = await UnrealPakParser.readPakInfo(targetPath);
        return pakInfo !== null;
      }
      if (stat.isDirectory()) {
        const files = await fs.readdir(targetPath);
        for (const f of files) {
          const lower = f.toLowerCase();
          if (lower.endsWith(".pak") || lower === "engine" || lower === "content") {
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private async findUnrealContainers(targetPath: string): Promise<string[]> {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      return [targetPath];
    }

    const allFiles = await listFilesRecursively(targetPath, 4);
    return allFiles.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return ext === ".pak" || ext === ".utoc" || ext === ".ucas";
    });
  }

  async inspect(targetPath: string): Promise<AssetManifest> {
    const containers = await this.findUnrealContainers(targetPath);
    const assets: AssetItem[] = [];
    let engineVersion: string | undefined;

    for (const container of containers) {
      const stat = await fs.stat(container);
      const ext = path.extname(container).toLowerCase();
      let isEncrypted = false;

      if (ext === ".pak") {
        const info = await UnrealPakParser.readPakInfo(container);
        if (info) {
          isEncrypted = info.isEncrypted;
          if (!engineVersion) {
            engineVersion = `UE Pak v${info.version}`;
          }
        }
      } else if (ext === ".utoc" || ext === ".ucas") {
        engineVersion = "UE Zen Store (UE 4.26+ / 5)";
      }

      assets.push({
        path: path.relative(targetPath, container) || path.basename(container),
        category: "other",
        size: stat.size,
        encrypted: isEncrypted,
        metadata: {
          containerType: ext.toUpperCase().replace(".", ""),
          isContainerPackage: true
        }
      });
    }

    return this.createManifest(targetPath, assets, engineVersion);
  }

  /**
   * Check if repak CLI is available in PATH
   */
  private async isRepakAvailable(): Promise<boolean> {
    try {
      await execAsync("repak --version");
      return true;
    } catch {
      return false;
    }
  }

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const containers = await this.findUnrealContainers(targetPath);
    const errors: Array<{ file: string; error: string }> = [];
    let extractedCount = 0;

    await fs.mkdir(options.outputDir, { recursive: true });
    const hasRepak = await this.isRepakAvailable();

    for (const container of containers) {
      const ext = path.extname(container).toLowerCase();
      if (ext === ".pak" && hasRepak) {
        try {
          const keyArg = options.aesKey ? `-k "${options.aesKey}"` : "";
          const cmd = `repak unpack ${keyArg} "${container}" -o "${options.outputDir}"`;
          await execAsync(cmd);
          extractedCount++;
        } catch (err: unknown) {
          errors.push({
            file: container,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      } else {
        // Fallback or tool notification
        if (!hasRepak) {
          errors.push({
            file: container,
            error: "repak CLI is not installed in PATH. Install via 'cargo install repak' to unpack encrypted/compressed Unreal .pak containers."
          });
        }
      }
    }

    return {
      success: errors.length === 0 && extractedCount > 0,
      extractedCount,
      outputDir: options.outputDir,
      durationMs: Date.now() - startTime,
      errors
    };
  }
}

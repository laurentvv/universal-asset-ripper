import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { UnrealPakParser, type UnrealPakInfo } from "../parsers/unreal/pak-parser.js";
import { listFilesRecursively } from "../utils/file-utils.js";
import { runTool } from "../utils/exec.js";
import type {
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult
} from "../types/index.js";

export class UnrealAdapter extends BaseEngineAdapter {
  readonly engine: EngineType = "unreal";

  async canHandle(targetPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(targetPath);
      if (stat.isFile()) {
        const ext = path.extname(targetPath).toLowerCase();
        if (ext === ".utoc" || ext === ".ucas") return true;
        const pakInfo = await UnrealPakParser.readPakInfo(targetPath);
        return pakInfo !== null;
      }
      if (stat.isDirectory()) {
        // Engine/Content folders alone are not enough: require a real container or project marker
        const files = await listFilesRecursively(targetPath, 4);
        for (const f of files) {
          const lower = f.toLowerCase();
          if (lower.endsWith(".utoc") || lower.endsWith(".ucas") || lower.endsWith(".uproject")) return true;
          if (lower.endsWith("-win64-shipping.exe")) return true;
          if (lower.endsWith(".pak") && (await UnrealPakParser.readPakInfo(f)) !== null) return true;
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
      await runTool("repak", ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * repak takes global options (--aes-key) BEFORE the subcommand
   */
  private repakArgs(subcommand: string[], aesKey?: string): string[] {
    return aesKey ? ["--aes-key", aesKey, ...subcommand] : subcommand;
  }

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const allContainers = await this.findUnrealContainers(targetPath);
    const errors: Array<{ file: string; error: string }> = [];
    let extractedCount = 0;

    // Containers are matched like inspect() reports them (relative path, category "other")
    const { selected: containers, dryRun } = this.planExtraction(allContainers, options, (c) => ({
      path: path.relative(targetPath, c) || path.basename(c),
      category: "other"
    }));

    const hasRepak = await this.isRepakAvailable();
    if (!dryRun) {
      await fs.mkdir(options.outputDir, { recursive: true });
    }

    for (const container of containers) {
      const ext = path.extname(container).toLowerCase();

      if (ext === ".utoc" || ext === ".ucas") {
        errors.push({
          file: container,
          error: "Unsupported: IoStore containers (.utoc/.ucas) cannot be unpacked yet (repak handles .pak only)."
        });
        continue;
      }

      if (!hasRepak) {
        errors.push({
          file: container,
          error: "repak CLI is not installed in PATH. Install via 'cargo install repak' to unpack encrypted/compressed Unreal .pak containers."
        });
        continue;
      }

      try {
        if (dryRun) {
          // List only: count the entries repak would unpack
          const { stdout } = await runTool("repak", this.repakArgs(["list", container], options.aesKey));
          extractedCount += stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
        } else {
          const before = (await listFilesRecursively(options.outputDir, 64)).length;
          await runTool("repak", this.repakArgs(["unpack", container, "-o", options.outputDir], options.aesKey));
          const after = (await listFilesRecursively(options.outputDir, 64)).length;
          extractedCount += Math.max(0, after - before);
        }
      } catch (err: unknown) {
        errors.push({
          file: container,
          error: err instanceof Error ? err.message : String(err)
        });
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

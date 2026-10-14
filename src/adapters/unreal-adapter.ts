import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { UnrealPakParser } from "../parsers/unreal/pak-parser.js";
import {
  PakIndexError,
  extractPakEntries,
  isNativeCompression,
  pakEntryToAssetItem,
  readPakIndex,
  type PakEntry,
  type PakIndex
} from "../parsers/unreal/pak-index.js";
import { listFilesRecursively } from "../utils/file-utils.js";
import { runTool } from "../utils/exec.js";
import type {
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult,
  InspectOptions
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

  /**
   * Lists the real entries of every readable .pak (native index reader). Containers that cannot be
   * listed (IoStore, encrypted without a valid key, damaged) stay a single container-level item
   * whose metadata explains why.
   */
  async inspect(targetPath: string, options: InspectOptions = {}): Promise<AssetManifest> {
    const containers = await this.findUnrealContainers(targetPath);
    const assets: AssetItem[] = [];
    let engineVersion: string | undefined;

    for (const container of containers) {
      const stat = await fs.stat(container);
      const ext = path.extname(container).toLowerCase();
      const relContainer = path.relative(targetPath, container) || path.basename(container);
      let isEncrypted = false;
      let listError: Error | undefined;

      if (ext === ".pak") {
        const info = await UnrealPakParser.readPakInfo(container);
        if (info) {
          isEncrypted = info.isEncrypted;
          if (!engineVersion) {
            engineVersion = `UE Pak v${info.version}`;
          }
          try {
            const index = await readPakIndex(container, { aesKey: options.aesKey });
            assets.push(...index.entries.map((e) => pakEntryToAssetItem(e, relContainer)));
            continue;
          } catch (err: unknown) {
            listError = err instanceof Error ? err : new Error(String(err));
          }
        }
      } else if (ext === ".utoc" || ext === ".ucas") {
        engineVersion = "UE Zen Store (UE 4.26+ / 5)";
      }

      assets.push({
        path: relContainer,
        category: "other",
        size: stat.size,
        encrypted: isEncrypted,
        metadata: {
          containerType: ext.toUpperCase().replace(".", ""),
          isContainerPackage: true,
          ...(listError
            ? {
                listError: listError.message,
                ...(listError instanceof PakIndexError ? { listErrorCode: listError.code } : {})
              }
            : {})
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

  /** Run repak on a whole container (list for dry-run, unpack otherwise); returns the number of files */
  private async repakContainer(container: string, options: ExtractOptions, dryRun: boolean): Promise<number> {
    if (dryRun) {
      // List only: count the entries repak would unpack
      const { stdout } = await runTool("repak", this.repakArgs(["list", container], options.aesKey));
      return stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    }
    const before = (await listFilesRecursively(options.outputDir, 64)).length;
    await runTool("repak", this.repakArgs(["unpack", container, "-o", options.outputDir], options.aesKey));
    const after = (await listFilesRecursively(options.outputDir, 64)).length;
    return Math.max(0, after - before);
  }

  /**
   * Natively read and extract one .pak. Returns null when the native reader cannot handle the
   * container at all (caller falls back to repak); key errors are reported, not retried.
   */
  private async extractPakNatively(
    container: string,
    options: ExtractOptions,
    dryRun: boolean,
    hasRepak: boolean,
    errors: Array<{ file: string; error: string }>
  ): Promise<number | null> {
    let index: PakIndex;
    try {
      index = await readPakIndex(container, { aesKey: options.aesKey });
    } catch (err: unknown) {
      if (
        err instanceof PakIndexError &&
        (err.code === "key-required" || err.code === "bad-key" || err.code === "invalid-key-format")
      ) {
        errors.push({ file: container, error: err.message });
        return 0;
      }
      return null;
    }

    const hasSelection = (options.categories?.length ?? 0) > 0 || !!options.filter;
    const { selected } = this.planExtraction(index.entries, options, (e) => pakEntryToAssetItem(e));
    if (dryRun) return selected.length;

    const native = selected.filter((e) => isNativeCompression(e.compression));
    const needsRepak = selected.filter((e) => !isNativeCompression(e.compression));
    let count = 0;

    const result = await extractPakEntries(container, native, options.outputDir, { aesKey: options.aesKey });
    count += result.extracted.length;
    this.reportEntryErrors(container, result.errors, errors);

    if (needsRepak.length > 0) {
      const codecs = [...new Set(needsRepak.map((e) => e.compression))].join(", ");
      if (!hasRepak) {
        errors.push({
          file: container,
          error: `${needsRepak.length} entries use ${codecs} compression, which needs the repak CLI (cargo install repak). Example: ${needsRepak[0].displayPath}`
        });
      } else if (hasSelection) {
        errors.push({
          file: container,
          error: `${needsRepak.length} selected entries use ${codecs} compression and are only extractable via repak, which unpacks whole containers: re-run without --categories/--filter. Example: ${needsRepak[0].displayPath}`
        });
      } else {
        try {
          await runTool("repak", this.repakArgs(["unpack", container, "-o", options.outputDir], options.aesKey));
          count += needsRepak.length;
        } catch (err: unknown) {
          errors.push({ file: container, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return count;
  }

  /** Group repetitive per-entry failures (e.g. every entry needing the same missing key) into one line */
  private reportEntryErrors(
    container: string,
    failures: Array<{ entry: PakEntry; error: Error }>,
    errors: Array<{ file: string; error: string }>
  ): void {
    const groups = new Map<string, PakEntry[]>();
    for (const f of failures) {
      const list = groups.get(f.error.message) ?? [];
      list.push(f.entry);
      groups.set(f.error.message, list);
    }
    for (const [message, entries] of groups) {
      if (entries.length > 5) {
        errors.push({ file: container, error: `${entries.length} entries failed: ${message} (first: ${entries[0].displayPath})` });
      } else {
        for (const e of entries) errors.push({ file: `${container}::${e.displayPath}`, error: message });
      }
    }
  }

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const allContainers = await this.findUnrealContainers(targetPath);
    const errors: Array<{ file: string; error: string }> = [];
    let extractedCount = 0;
    const dryRun = options.dryRun === true;

    // Containers the native reader cannot list are matched like inspect() reports them (relative path, category "other")
    const containerSelected = (c: string): boolean =>
      this.planExtraction([c], options, (x) => ({
        path: path.relative(targetPath, x) || path.basename(x),
        category: "other"
      })).selected.length > 0;

    const hasRepak = await this.isRepakAvailable();
    if (!dryRun) {
      await fs.mkdir(options.outputDir, { recursive: true });
    }

    for (const container of allContainers) {
      const ext = path.extname(container).toLowerCase();

      if (ext === ".utoc" || ext === ".ucas") {
        if (!containerSelected(container)) continue;
        errors.push({
          file: container,
          error: "Unsupported: IoStore containers (.utoc/.ucas) cannot be unpacked yet (repak handles .pak only)."
        });
        continue;
      }

      // Native reader first (stored/Zlib, AES); anything it cannot read at all goes to repak
      const native = await this.extractPakNatively(container, options, dryRun, hasRepak, errors);
      if (native !== null) {
        extractedCount += native;
        continue;
      }

      if (!containerSelected(container)) continue;

      if (!hasRepak) {
        errors.push({
          file: container,
          error: "repak CLI is not installed in PATH. Install via 'cargo install repak' to unpack encrypted/compressed Unreal .pak containers."
        });
        continue;
      }

      try {
        extractedCount += await this.repakContainer(container, options, dryRun);
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

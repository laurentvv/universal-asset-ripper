import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BaseEngineAdapter } from "./engine-adapter.js";
import { AsarParser, type AsarArchive, type AsarEntry } from "../parsers/electron/asar-parser.js";
import {
  ChromiumPakParser,
  guessResourceExtension,
  type ChromiumPak,
  type ChromiumPakResource
} from "../parsers/electron/chromium-pak.js";
import { listElectronContainers } from "../parsers/electron/electron-layout.js";
import { categorizeExtension, resolveSafeOutputPath } from "../utils/file-utils.js";
import type {
  AssetItem,
  AssetManifest,
  EngineType,
  ExtractOptions,
  ExtractionResult
} from "../types/index.js";

const SAMPLE_BYTES = 4096;
const WHOLE_SAMPLE_LIMIT = 256 * 1024; // small resources are read fully so JSON can be recognised

type Source =
  | { kind: "asar"; file: string; rel: string; archive: AsarArchive }
  | { kind: "pak"; file: string; rel: string; pak: ChromiumPak };

type Planned =
  | { kind: "asar"; source: Extract<Source, { kind: "asar" }>; entry: AsarEntry; item: AssetItem }
  | { kind: "pak"; source: Extract<Source, { kind: "pak" }>; resource: ChromiumPakResource; item: AssetItem };

/**
 * Electron applications: app.asar archives (code, node_modules, assets) and Chromium .pak data
 * packs (resources.pak, chrome_*_percent.pak, locales/*.pak).
 *
 * Output layout (identical to the paths inspect() reports):
 *   app.asar            -> <out>/<path inside the asar>
 *   other.asar          -> <out>/other/<path inside the asar>
 *   resources.pak       -> <out>/resources/res_<id>.<ext>   (locales/en-US.pak -> locales/en-US/res_<id>.<ext>)
 */
export class ElectronAdapter extends BaseEngineAdapter {
  readonly engine: EngineType = "electron";

  async canHandle(targetPath: string): Promise<boolean> {
    try {
      return (await this.findSources(targetPath)).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Locate readable containers for a target: an .asar / Chromium .pak file, an executable (its folder
   * is used) or an application folder
   */
  private async findSources(targetPath: string): Promise<Source[]> {
    const stat = await fs.stat(targetPath);
    let files: string[];
    let baseDir: string;

    if (stat.isFile()) {
      const lower = targetPath.toLowerCase();
      if (lower.endsWith(".asar") || lower.endsWith(".pak")) {
        files = [targetPath];
        baseDir = path.dirname(targetPath);
      } else {
        baseDir = path.dirname(targetPath);
        files = await listElectronContainers(baseDir);
      }
    } else {
      baseDir = targetPath;
      files = await listElectronContainers(targetPath);
    }

    const sources: Source[] = [];
    for (const file of files) {
      const rel = path.relative(baseDir, file).split(path.sep).join("/") || path.basename(file);
      if (file.toLowerCase().endsWith(".asar")) {
        const archive = await AsarParser.readArchive(file);
        if (archive) sources.push({ kind: "asar", file, rel, archive });
      } else {
        const pak = await ChromiumPakParser.readPak(file);
        if (pak) sources.push({ kind: "pak", file, rel, pak });
      }
    }
    return sources;
  }

  /** Output-relative path of an asar entry (see class comment) */
  private asarOutPath(source: Extract<Source, { kind: "asar" }>, inner: string): string {
    const base = path.posix.basename(source.rel);
    if (base.toLowerCase() === "app.asar") return inner;
    return `${base.replace(/\.asar$/i, "")}/${inner}`;
  }

  private pakOutPath(source: Extract<Source, { kind: "pak" }>, resource: ChromiumPakResource, ext: string): string {
    return `${source.rel.replace(/\.pak$/i, "")}/res_${resource.id}.${ext}`;
  }

  /** Build the item list shared by inspect and extract (reads resource samples to guess extensions) */
  private async plan(sources: Source[]): Promise<Planned[]> {
    const planned: Planned[] = [];
    for (const source of sources) {
      if (source.kind === "asar") {
        for (const entry of source.archive.entries) {
          if (entry.link !== undefined) continue; // symlinks carry no data
          const outPath = this.asarOutPath(source, entry.path);
          planned.push({
            kind: "asar",
            source,
            entry,
            item: {
              path: outPath,
              category: categorizeExtension(entry.path),
              size: entry.size,
              ...(entry.offset >= 0 ? { offset: entry.offset } : {}),
              metadata: { container: source.rel, archivePath: entry.path, unpacked: entry.unpacked, executable: entry.executable }
            }
          });
        }
      } else {
        const fh = await fs.open(source.file, "r");
        try {
          for (const resource of source.pak.resources) {
            const sampleLen = resource.size <= WHOLE_SAMPLE_LIMIT ? resource.size : SAMPLE_BYTES;
            const sample = Buffer.alloc(sampleLen);
            if (sampleLen > 0) await fh.read(sample, 0, sampleLen, resource.offset);
            const ext = guessResourceExtension(sample);
            const outPath = this.pakOutPath(source, resource, ext);
            planned.push({
              kind: "pak",
              source,
              resource,
              item: {
                path: outPath,
                category: categorizeExtension(`x.${ext}`),
                size: resource.size,
                offset: resource.offset,
                metadata: {
                  container: source.rel,
                  resourceId: resource.id,
                  guessedExtension: ext,
                  ...(resource.aliasOf !== undefined ? { aliasOf: resource.aliasOf } : {})
                }
              }
            });
          }
        } finally {
          await fh.close();
        }
      }
    }
    return planned;
  }

  /** "name@version" from the app's package.json, when an app.asar carries one */
  private async readAppInfo(sources: Source[]): Promise<string | undefined> {
    const app = sources.find((s): s is Extract<Source, { kind: "asar" }> => s.kind === "asar" && /(^|\/)app\.asar$/i.test(s.rel));
    const pkg = app?.archive.entries.find((e) => e.path === "package.json" && !e.unpacked && e.size > 0 && e.size < 256 * 1024);
    if (!app || !pkg) return undefined;
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(app.file, "r");
      const buf = Buffer.alloc(pkg.size);
      await fh.read(buf, 0, pkg.size, pkg.offset);
      const json = JSON.parse(buf.toString("utf8")) as { name?: unknown; version?: unknown };
      if (typeof json.name !== "string") return undefined;
      return `Electron app ${json.name}${typeof json.version === "string" ? `@${json.version}` : ""}`;
    } catch {
      return undefined;
    } finally {
      await fh?.close();
    }
  }

  async inspect(targetPath: string): Promise<AssetManifest> {
    const sources = await this.findSources(targetPath);
    if (sources.length === 0) {
      throw new Error(`No readable app.asar or Chromium .pak (resources.pak) found in target: ${targetPath}`);
    }
    const planned = await this.plan(sources);
    return this.createManifest(
      targetPath,
      planned.map((p) => p.item),
      (await this.readAppInfo(sources)) ?? "Electron app"
    );
  }

  async extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult> {
    const startTime = Date.now();
    const sources = await this.findSources(targetPath);
    if (sources.length === 0) {
      return {
        success: false,
        extractedCount: 0,
        outputDir: options.outputDir,
        durationMs: Date.now() - startTime,
        errors: [{ file: targetPath, error: "No readable app.asar or Chromium .pak (resources.pak) found." }]
      };
    }

    const planned = await this.plan(sources);
    const { selected, dryRun } = this.planExtraction(planned, options, (p) => p.item);
    const errors: Array<{ file: string; error: string }> = [];
    let extractedCount = 0;

    if (!dryRun) {
      await fs.mkdir(options.outputDir, { recursive: true });

      // asar entries, one archive at a time
      for (const source of sources) {
        if (source.kind !== "asar") continue;
        const entries = selected
          .filter((p): p is Extract<Planned, { kind: "asar" }> => p.kind === "asar" && p.source === source)
          .map((p) => p.entry);
        if (entries.length === 0) continue;
        const res = await AsarParser.extractEntries(source.file, source.archive, entries, options.outputDir, (p) =>
          this.asarOutPath(source, p)
        );
        extractedCount += res.extractedCount;
        errors.push(...res.errors.map((e) => ({ file: `${source.rel}::${e.file}`, error: e.error })));
      }

      // Chromium pak resources
      for (const source of sources) {
        if (source.kind !== "pak") continue;
        const items = selected.filter((p): p is Extract<Planned, { kind: "pak" }> => p.kind === "pak" && p.source === source);
        if (items.length === 0) continue;
        const fh = await fs.open(source.file, "r");
        try {
          for (const p of items) {
            try {
              const dest = resolveSafeOutputPath(options.outputDir, p.item.path);
              if (!dest) throw new Error("Unsafe entry path rejected (escapes the output directory)");
              const data = await ChromiumPakParser.readResource(fh, p.resource);
              await fs.mkdir(path.dirname(dest), { recursive: true });
              await fs.writeFile(dest, data);
              extractedCount++;
            } catch (err: unknown) {
              errors.push({ file: `${source.rel}::${p.item.path}`, error: err instanceof Error ? err.message : String(err) });
            }
          }
        } finally {
          await fh.close();
        }
      }
    } else {
      extractedCount = selected.length;
    }

    return {
      success: errors.length === 0,
      extractedCount,
      outputDir: options.outputDir,
      durationMs: Date.now() - startTime,
      errors
    };
  }
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EngineDetector } from "../core/detector/engine-detector.js";
import { DecompilerRegistry } from "../decompiler/decompiler-registry.js";
import { PeResourceParser } from "../parsers/pe/pe-resource-parser.js";

export interface ExecutableAuditSummary {
  name: string;
  relativePath: string;
  sizeBytes: number;
  architecture?: string;
  isPrimary: boolean;
  cliFlags: string[];
  importedDlls: string[];
  importedFunctionCount: number;
  dialogCount: number;
  iconCount: number;
  hasManifest: boolean;
  version?: Record<string, string>;
}

export interface SiblingDllAuditSummary {
  name: string;
  relativePath: string;
  sizeBytes: number;
  exportedFunctions: string[];
  importedDlls: string[];
  purposeInferred: string;
}

export interface ConfigFileSummary {
  relativePath: string;
  category: "syntax-language" | "theme-palette" | "menu-definition" | "autocomplete" | "function-list" | "general-config";
  sizeBytes: number;
  description: string;
}

export interface ApplicationAuditReport {
  targetDirectory: string;
  appName: string;
  engine: string;
  confidence: number;
  timestamp: string;
  totalFiles: number;
  totalSizeBytes: number;
  primaryExecutable?: ExecutableAuditSummary;
  executables: ExecutableAuditSummary[];
  siblingDlls: SiblingDllAuditSummary[];
  assetContainers: string[];
  configurationModels: ConfigFileSummary[];
  summary: {
    totalDialogs: number;
    totalIcons: number;
    totalCliFlags: number;
    totalPluginExports: number;
  };
  recommendations: string[];
}

export interface AuditOptions {
  maxDepth?: number;
  extractResources?: boolean;
  outputDir?: string;
}

export class ApplicationAuditor {
  /**
   * Run end-to-end automated reverse engineering audit across an application directory.
   */
  public static async auditDirectory(
    dirPath: string,
    options: AuditOptions = {}
  ): Promise<ApplicationAuditReport> {
    const resolvedDir = path.resolve(dirPath);
    const stat = await fs.stat(resolvedDir);
    if (!stat.isDirectory()) {
      throw new Error(`Target is not a directory: ${resolvedDir}`);
    }

    // 1. Detect Engine
    const engineResult = await EngineDetector.detect(resolvedDir);

    // 2. Discover all files
    const allFiles: { fullPath: string; relPath: string; size: number }[] = [];
    await this.collectFiles(resolvedDir, "", allFiles, options.maxDepth ?? 4);

    let totalSizeBytes = 0;
    const exeFiles: { fullPath: string; relPath: string; size: number }[] = [];
    const dllFiles: { fullPath: string; relPath: string; size: number }[] = [];
    const assetContainers: string[] = [];
    const configFiles: { fullPath: string; relPath: string; size: number }[] = [];

    for (const f of allFiles) {
      totalSizeBytes += f.size;
      const lower = f.relPath.toLowerCase();
      if (lower.endsWith(".exe")) {
        exeFiles.push(f);
      } else if (lower.endsWith(".dll") || lower.endsWith(".so") || lower.endsWith(".dylib")) {
        dllFiles.push(f);
      } else if (
        lower.endsWith(".pak") ||
        lower.endsWith(".pck") ||
        lower.endsWith(".asar") ||
        lower.endsWith(".bundle") ||
        lower.endsWith("resources.pak")
      ) {
        assetContainers.push(f.relPath);
      } else if (
        lower.endsWith(".xml") ||
        lower.endsWith(".json") ||
        lower.endsWith(".yaml") ||
        lower.endsWith(".yml") ||
        lower.endsWith(".toml") ||
        lower.endsWith(".ini") ||
        lower.endsWith(".cfg")
      ) {
        configFiles.push(f);
      }
    }

    // 3. Audit Executables
    const executables: ExecutableAuditSummary[] = [];
    for (const exe of exeFiles) {
      const summary = await this.auditExecutable(exe.fullPath, exe.relPath, exe.size);
      executables.push(summary);
    }

    // Designate primary executable
    let primary = executables.find((e) => !e.relativePath.includes(path.sep));
    if (!primary && executables.length > 0) {
      primary = executables.sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    }
    if (primary) {
      primary.isPrimary = true;
    }

    // 4. Audit Sibling DLLs
    const siblingDlls: SiblingDllAuditSummary[] = [];
    for (const dll of dllFiles) {
      const summary = await this.auditDll(dll.fullPath, dll.relPath, dll.size);
      siblingDlls.push(summary);
    }

    // 5. Audit Configurations
    const configurationModels: ConfigFileSummary[] = configFiles.map((c) => {
      const lower = c.relPath.toLowerCase();
      let category: ConfigFileSummary["category"] = "general-config";
      let description = "Configuration file";

      if (lower.includes("lang") || lower.endsWith("langs.model.xml")) {
        category = "syntax-language";
        description = "Programming languages & syntax definitions (extensions, comment prefixes, keywords)";
      } else if (lower.includes("styler") || lower.includes("theme")) {
        category = "theme-palette";
        description = "Color schemes & editor style definitions";
      } else if (lower.includes("contextmenu") || lower.includes("menu")) {
        category = "menu-definition";
        description = "Menu hierarchy & command IDs mapping";
      } else if (lower.includes("autocompletion")) {
        category = "autocomplete";
        description = "Language autocompletion definitions and function prototypes";
      } else if (lower.includes("functionlist")) {
        category = "function-list";
        description = "Function and class parser regexes for outline views";
      }

      return {
        relativePath: c.relPath,
        category,
        sizeBytes: c.size,
        description
      };
    });

    // 6. Summarize & Generate Recommendations
    let totalDialogs = 0;
    let totalIcons = 0;
    let totalCliFlags = 0;
    let totalPluginExports = 0;

    for (const exe of executables) {
      totalDialogs += exe.dialogCount;
      totalIcons += exe.iconCount;
      totalCliFlags += exe.cliFlags.length;
    }
    for (const dll of siblingDlls) {
      totalPluginExports += dll.exportedFunctions.length;
    }

    const recommendations: string[] = [];
    if (totalDialogs > 0) {
      recommendations.push(
        `Discovered ${totalDialogs} embedded Win32 dialog templates. Extract them to JSON schemas to mirror UI layouts.`
      );
    }
    if (totalCliFlags > 0) {
      recommendations.push(
        `Discovered ${totalCliFlags} CLI parameters. Mirror these switches in the CLI parser for complete drop-in compatibility.`
      );
    }
    if (siblingDlls.length > 0) {
      recommendations.push(
        `Detected ${siblingDlls.length} sibling DLLs / plugins with ${totalPluginExports} exported functions. Reimplement these as native modular sub-crates or plugins.`
      );
    }
    const syntaxConfigs = configurationModels.filter((c) => c.category === "syntax-language");
    if (syntaxConfigs.length > 0) {
      recommendations.push(
        `Found language definition models (${syntaxConfigs.map((c) => c.relativePath).join(", ")}). Import extension mappings and comment markers into syntax highlighting.`
      );
    }

    const appName = primary ? path.basename(primary.name, path.extname(primary.name)) : path.basename(resolvedDir);

    const report: ApplicationAuditReport = {
      targetDirectory: resolvedDir,
      appName,
      engine: engineResult.engine,
      confidence: engineResult.confidence,
      timestamp: new Date().toISOString(),
      totalFiles: allFiles.length,
      totalSizeBytes,
      primaryExecutable: primary,
      executables,
      siblingDlls,
      assetContainers,
      configurationModels,
      summary: {
        totalDialogs,
        totalIcons,
        totalCliFlags,
        totalPluginExports
      },
      recommendations
    };

    // If output dir specified, write JSON and Markdown report
    if (options.outputDir) {
      const outDir = path.resolve(options.outputDir);
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, "audit-report.json"), JSON.stringify(report, null, 2), "utf-8");
      await fs.writeFile(path.join(outDir, "audit-report.md"), this.generateMarkdownReport(report), "utf-8");
    }

    return report;
  }

  private static async collectFiles(
    baseDir: string,
    currentRel: string,
    outList: { fullPath: string; relPath: string; size: number }[],
    maxDepth: number,
    currentDepth = 0
  ): Promise<void> {
    if (currentDepth > maxDepth) return;
    const dir = path.join(baseDir, currentRel);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = currentRel ? path.join(currentRel, entry.name) : entry.name;
        const full = path.join(baseDir, rel);
        if (entry.isDirectory()) {
          await this.collectFiles(baseDir, rel, outList, maxDepth, currentDepth + 1);
        } else if (entry.isFile()) {
          try {
            const s = await fs.stat(full);
            outList.push({ fullPath: full, relPath: rel, size: s.size });
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // directory unreadable
    }
  }

  private static async auditExecutable(
    fullPath: string,
    relPath: string,
    size: number
  ): Promise<ExecutableAuditSummary> {
    // 1. Strings: discover CLI switches
    const strings = await DecompilerRegistry.extractStrings(fullPath, 4);
    const cliFlags: string[] = [];
    const flagRegex = /^-{1,2}[a-zA-Z0-9_-]{2,}/;
    for (const s of strings) {
      if (flagRegex.test(s) && !cliFlags.includes(s) && s.length < 40) {
        cliFlags.push(s);
        if (cliFlags.length >= 50) break;
      }
    }

    // 2. Imports & Symbols
    const symbolsResult = await DecompilerRegistry.dumpSymbols(fullPath);
    const importedDllsSet = new Set<string>();
    for (const s of symbolsResult.symbols) {
      if (s.section) importedDllsSet.add(s.section);
    }

    // 3. PE resources
    let dialogCount = 0;
    let iconCount = 0;
    let hasManifest = false;
    let arch: string | undefined;

    try {
      const peInfo = await PeResourceParser.parse(fullPath);
      if (peInfo) {
        arch = peInfo.arch;
        dialogCount = peInfo.resources.filter((r) => r.typeName === "RT_DIALOG").length;
        iconCount = peInfo.resources.filter((r) => r.typeName === "RT_GROUP_ICON" || r.typeName === "RT_ICON").length;
        hasManifest = peInfo.resources.some((r) => r.typeName === "RT_MANIFEST");
      }
    } catch {
      // ignore
    }

    return {
      name: path.basename(fullPath),
      relativePath: relPath,
      sizeBytes: size,
      architecture: arch,
      isPrimary: false,
      cliFlags,
      importedDlls: Array.from(importedDllsSet),
      importedFunctionCount: symbolsResult.totalCount,
      dialogCount,
      iconCount,
      hasManifest
    };
  }

  private static async auditDll(
    fullPath: string,
    relPath: string,
    size: number
  ): Promise<SiblingDllAuditSummary> {
    const symbolsResult = await DecompilerRegistry.dumpSymbols(fullPath);
    const exportedFunctions: string[] = [];
    const importedDllsSet = new Set<string>();

    for (const s of symbolsResult.symbols) {
      if (s.kind === "function" || s.kind === "export") {
        exportedFunctions.push(s.name);
      }
      if (s.section) importedDllsSet.add(s.section);
    }

    let purposeInferred = "Dynamic Link Library";
    const lower = relPath.toLowerCase();
    if (lower.includes("plugin")) purposeInferred = "Application Plugin Extension";
    else if (lower.includes("shell") || lower.includes("contextmenu")) purposeInferred = "Windows Explorer Shell Integration";
    else if (lower.includes("export")) purposeInferred = "Document Export Engine";
    else if (lower.includes("convert")) purposeInferred = "Data Conversion Tool";

    return {
      name: path.basename(fullPath),
      relativePath: relPath,
      sizeBytes: size,
      exportedFunctions,
      importedDlls: Array.from(importedDllsSet),
      purposeInferred
    };
  }

  public static generateMarkdownReport(report: ApplicationAuditReport): string {
    const lines: string[] = [];
    lines.push(`# Reverse Engineering Audit Report: ${report.appName}`);
    lines.push(`**Generated on:** ${report.timestamp}`);
    lines.push(`**Target Directory:** \`${report.targetDirectory}\``);
    lines.push(`**Engine Detected:** ${report.engine} (Confidence: ${Math.round(report.confidence * 100)}%)`);
    lines.push(`**Total Files:** ${report.totalFiles.toLocaleString()} (${(report.totalSizeBytes / 1024 / 1024).toFixed(2)} MB)`);
    lines.push("");

    lines.push("## Summary of Discovered Assets & Contracts");
    lines.push(`- **Embedded Dialogs:** ${report.summary.totalDialogs}`);
    lines.push(`- **Embedded Icons:** ${report.summary.totalIcons}`);
    lines.push(`- **Discovered CLI Switches:** ${report.summary.totalCliFlags}`);
    lines.push(`- **Sibling DLLs & Plugins:** ${report.siblingDlls.length} (${report.summary.totalPluginExports} exported functions)`);
    lines.push(`- **Configuration Models:** ${report.configurationModels.length}`);
    lines.push("");

    if (report.primaryExecutable) {
      lines.push("## Primary Executable");
      lines.push(`- **Binary:** \`${report.primaryExecutable.name}\` (${(report.primaryExecutable.sizeBytes / 1024 / 1024).toFixed(2)} MB)`);
      lines.push(`- **Imported DLLs:** ${report.primaryExecutable.importedDlls.join(", ")}`);
      lines.push(`- **Imported Functions:** ${report.primaryExecutable.importedFunctionCount}`);
      if (report.primaryExecutable.cliFlags.length > 0) {
        lines.push(`- **CLI Flags:** \`${report.primaryExecutable.cliFlags.slice(0, 15).join("`, `")}\``);
      }
      lines.push("");
    }

    if (report.siblingDlls.length > 0) {
      lines.push("## Sibling DLLs & Plugins");
      for (const dll of report.siblingDlls) {
        lines.push(`- **\`${dll.relativePath}\`** (${dll.purposeInferred})`);
        if (dll.exportedFunctions.length > 0) {
          lines.push(`  - Exports: \`${dll.exportedFunctions.join("`, `")}\``);
        }
      }
      lines.push("");
    }

    if (report.configurationModels.length > 0) {
      lines.push("## Configuration Models");
      for (const cfg of report.configurationModels.slice(0, 25)) {
        lines.push(`- **\`${cfg.relativePath}\`** [${cfg.category}]: ${cfg.description}`);
      }
      if (report.configurationModels.length > 25) {
        lines.push(`- *... and ${report.configurationModels.length - 25} more config files*`);
      }
      lines.push("");
    }

    if (report.recommendations.length > 0) {
      lines.push("## Recommendations for Implementation");
      for (const rec of report.recommendations) {
        lines.push(`1. ${rec}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

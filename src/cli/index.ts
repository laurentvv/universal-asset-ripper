import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EngineDetector } from "../core/detector/engine-detector.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ReaBridge } from "../rea/rea-bridge.js";
import { runMcpServer, setAllowedRoots } from "../mcp/server.js";
import { ASSET_CATEGORIES } from "../types/index.js";
import { runDoctor } from "../utils/doctor.js";
import { validateCategories } from "../utils/file-utils.js";
import { DecompilerRegistry } from "../decompiler/decompiler-registry.js";
import type { DecompilerBackendType } from "../decompiler/types.js";
import { ApplicationAuditor } from "../pipeline/application-auditor.js";

const program = new Command();

/**
 * Spinner that stays silent in --json mode so stdout only carries the JSON document
 */
function startSpinner(text: string, json?: boolean) {
  return ora({ text, isSilent: json === true }).start();
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Report a fatal error (stderr in --json mode) and set a failing exit code
 */
function failCommand(spinner: ReturnType<typeof ora>, json: boolean | undefined, message: string): void {
  if (json) {
    console.error(message);
  } else {
    spinner.fail(message);
  }
  process.exit(1);
}

program
  .name("ripper")
  .description("Universal Asset Ripper - Multi-engine game asset extractor & REA orchestrator")
  .version("0.1.0");

// Command: detect
program
  .command("detect <target>")
  .description("Detect the game engine (Unity, Unreal, Godot) and analyze binary/container signatures")
  .option("--json", "Print machine-readable JSON to stdout")
  .action(async (target: string, opts: { json?: boolean }) => {
    const spinner = startSpinner(`Analyzing target: ${chalk.cyan(target)}...`, opts.json);
    try {
      const resolved = path.resolve(target);
      const result = await EngineDetector.detect(resolved);
      if (opts.json) {
        printJson(result);
        return;
      }
      spinner.succeed(`Engine analysis completed.`);

      console.log();
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(chalk.bold.green("  Engine Detection Results"));
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(`  Engine:         ${chalk.yellow.bold(result.engine.toUpperCase())}`);
      console.log(`  Confidence:     ${chalk.cyan(Math.round(result.confidence * 100))}%`);
      if (result.version) {
        console.log(`  Version:        ${chalk.white(result.version)}`);
      }
      if (result.containerType) {
        console.log(`  Container:      ${chalk.white(result.containerType)}`);
      }
      if (result.arch && result.arch !== "unknown") {
        console.log(`  Architecture:   ${chalk.white(result.arch)}`);
      }
      if (result.details.isIL2CPP) {
        console.log(`  Runtime:        ${chalk.magenta("IL2CPP (Native AOT)")}`);
      } else if (result.details.isMono) {
        console.log(`  Runtime:        ${chalk.magenta("Mono (.NET CIL)")}`);
      }
      if (result.details.encrypted !== undefined) {
        console.log(`  Encrypted:      ${result.details.encrypted ? chalk.red("Yes") : chalk.green("No")}`);
      }

      if (result.details.markersFound.length > 0) {
        console.log();
        console.log(chalk.bold("  Signatures & Markers Found:"));
        for (const marker of result.details.markersFound) {
          console.log(`   ${chalk.green("✔")} ${marker}`);
        }
      }

      if (result.details.notes && result.details.notes.length > 0) {
        console.log();
        console.log(chalk.bold("  Notes:"));
        for (const note of result.details.notes) {
          console.log(`   ${chalk.dim("ℹ")} ${note}`);
        }
      }
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log();
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Detection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

// Command: inspect
program
  .command("inspect <target>")
  .description("Inspect game assets, listing counts and total sizes by category")
  .option("--aes-key <key>", "AES-256 key to list encrypted containers (Unreal .pak index, hex or base64)")
  .option("--json", "Print the full asset manifest as JSON to stdout")
  .action(async (target: string, opts: { json?: boolean; aesKey?: string }) => {
    const spinner = startSpinner(`Inspecting package: ${chalk.cyan(target)}...`, opts.json);
    try {
      const resolved = path.resolve(target);
      const { adapter, engine } = await AdapterRegistry.resolveAdapter(resolved);
      const manifest = await adapter.inspect(resolved, { aesKey: opts.aesKey });
      if (opts.json) {
        printJson(manifest);
        return;
      }
      spinner.succeed(`Inspection complete for ${chalk.yellow(engine.toUpperCase())}.`);

      console.log();
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(chalk.bold.green(`  Asset Manifest: ${chalk.white(path.basename(resolved))}`));
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(`  Engine:         ${chalk.yellow(manifest.engine.toUpperCase())}`);
      if (manifest.engineVersion) {
        console.log(`  Engine Version: ${chalk.white(manifest.engineVersion)}`);
      }
      console.log(`  Total Files:    ${chalk.cyan(manifest.totalFiles.toLocaleString())}`);
      console.log(`  Total Size:     ${chalk.cyan((manifest.totalBytes / 1024 / 1024).toFixed(2))} MB`);
      console.log();
      console.log(chalk.bold("  Assets Breakdown by Category:"));
      console.log(chalk.dim("  ┌──────────────┬────────────┬──────────────┐"));
      console.log(chalk.dim("  │ Category     │ Files      │ Size (MB)    │"));
      console.log(chalk.dim("  ├──────────────┼────────────┼──────────────┤"));

      for (const [category, summary] of Object.entries(manifest.byCategory)) {
        if (summary.count > 0) {
          const catPadded = category.padEnd(12);
          const countPadded = summary.count.toString().padStart(10);
          const sizeMb = (summary.totalBytes / 1024 / 1024).toFixed(2).padStart(12);
          console.log(`  │ ${chalk.cyan(catPadded)} │ ${countPadded} │ ${sizeMb} │`);
        }
      }
      console.log(chalk.dim("  └──────────────┴────────────┴──────────────┘"));
      console.log();
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Inspection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

// Command: extract
program
  .command("extract <target>")
  .description("Extract game assets to an output directory")
  .requiredOption("-o, --output <dir>", "Output directory for extracted assets")
  .option("--categories <cats>", `Comma-separated categories to extract (${ASSET_CATEGORIES.join(",")})`)
  .option("--filter <pattern>", "Filter files containing this substring")
  .option("--aes-key <key>", "AES-256 decryption key: Unreal .pak (hex or base64), Godot encrypted PCK (32-byte hex script key)")
  .option("--convert", "Convert formats while extracting (Godot .ctex/.stex wrapping a plain PNG/WebP are written as images)")
  .option("--dry-run", "Simulate extraction without writing files to disk")
  .option("--json", "Print the extraction result as JSON to stdout")
  .action(async (target: string, opts: { output: string; categories?: string; filter?: string; aesKey?: string; convert?: boolean; dryRun?: boolean; json?: boolean }) => {
    const spinner = startSpinner(`Extracting assets from ${chalk.cyan(target)}...`, opts.json);
    try {
      const resolved = path.resolve(target);
      const outDir = path.resolve(opts.output);

      let categories;
      if (opts.categories) {
        const { valid, invalid } = validateCategories(
          opts.categories.split(",").map((c) => c.trim()).filter((c) => c.length > 0)
        );
        if (invalid.length > 0) {
          failCommand(
            spinner,
            opts.json,
            `Unknown categories: ${invalid.join(", ")}. Valid categories: ${ASSET_CATEGORIES.join(", ")}`
          );
          return;
        }
        categories = valid;
      }

      const { adapter } = await AdapterRegistry.resolveAdapter(resolved);

      const result = await adapter.extract(resolved, {
        outputDir: outDir,
        categories,
        filter: opts.filter,
        aesKey: opts.aesKey,
        convertFormats: opts.convert,
        dryRun: opts.dryRun
      });

      if (!result.success) {
        process.exitCode = 1;
      }

      if (opts.json) {
        printJson(result);
        return;
      }

      if (result.success) {
        spinner.succeed(
          `Extracted ${chalk.green(result.extractedCount)} files to ${chalk.cyan(outDir)} in ${result.durationMs}ms.`
        );
      } else {
        spinner.warn(
          `Extraction finished with warnings. Extracted: ${result.extractedCount} files.`
        );
        if (result.errors.length > 0) {
          console.log();
          console.log(chalk.bold.red("  Errors/Warnings:"));
          for (const err of result.errors.slice(0, 10)) {
            console.log(`   ${chalk.red("✖")} [${err.file}] ${err.error}`);
          }
        }
      }
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

// Command: rea-inspect
program
  .command("rea-inspect <binary>")
  .description("Run deep binary reverse engineering scan (AES keys, IL2CPP metadata, and REA evidence bundle)")
  .option("--pak <file>", "Unreal .pak used to verify every candidate key (verified keys are listed first)")
  .option("--bundle <file>", "Write the REA evidence bundle (JSON) to this file")
  .option("--json", "Print the scan result and evidence bundle as JSON to stdout")
  .action(async (binary: string, opts: { json?: boolean; pak?: string; bundle?: string }) => {
    const spinner = startSpinner(`Running REA deep binary scan on: ${chalk.cyan(binary)}...`, opts.json);
    try {
      const resolved = path.resolve(binary);
      const pakPath = opts.pak ? path.resolve(opts.pak) : undefined;
      const { scan, bundle } = await ReaBridge.inspectBinary(resolved, { pakPath });
      let bundlePath: string | undefined;
      if (opts.bundle) {
        bundlePath = path.resolve(opts.bundle);
        await fs.mkdir(path.dirname(bundlePath), { recursive: true });
        await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2), "utf-8");
      }
      if (opts.json) {
        printJson({ scan, bundle, ...(bundlePath ? { bundleFile: bundlePath } : {}) });
        return;
      }
      spinner.succeed(`Binary inspection complete.`);

      console.log();
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(chalk.bold.magenta("  REA Binary Analysis & Evidence Bundle"));
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(`  Binary:         ${chalk.white(path.basename(resolved))}`);
      console.log(`  Architecture:   ${chalk.white(scan.arch)}`);
      console.log(`  Scanned:        ${chalk.white((scan.scannedBytes / 1024 / 1024).toFixed(2))} MB (whole file)`);
      if (scan.verifiedAgainst) {
        console.log(`  Verified with:  ${chalk.white(path.basename(scan.verifiedAgainst))}`);
      }

      if (scan.candidateAesKeys.length > 0) {
        console.log();
        console.log(
          chalk.bold.yellow(
            `  Candidate AES-256 Keys Discovered: ${scan.candidateTotal} candidates, showing ${scan.candidatesShown}`
          )
        );
        for (const key of scan.candidateAesKeys) {
          const tag =
            key.verified === true
              ? chalk.bgGreen.black(" VERIFIED ")
              : key.verified === false
                ? chalk.red("rejected")
                : key.verified === null
                  ? chalk.dim("unverifiable")
                  : "";
          const extra = key.distanceFromSBox !== undefined ? `, ${key.distanceFromSBox}B from S-box` : "";
          console.log(
            `   ${chalk.green("🔑")} ${chalk.bold(key.keyHex)} ${tag} (Offset: 0x${key.offset.toString(16)}, Entropy: ${key.entropy.toFixed(2)}, Conf: ${key.confidence}, ${key.pattern}${extra})`
          );
        }
      } else {
        console.log(`  AES Keys:       ${chalk.dim("No plaintext 256-bit keys detected")}`);
      }

      const dropped = Object.values(scan.filteredOut).reduce((a, b) => a + b, 0);
      if (dropped > 0) {
        console.log();
        console.log(
          chalk.dim(
            `  Filtered out ${dropped} hex strings (longer hex runs ${scan.filteredOut.longerHexRun}, counting tables ${scan.filteredOut.sequential}, low entropy ${scan.filteredOut.lowEntropy}, repeated blocks ${scan.filteredOut.repeatedBlock}, trivial ${scan.filteredOut.trivial})`
          )
        );
      }

      if (scan.il2cppMetadata) {
        console.log();
        console.log(chalk.bold.cyan("  IL2CPP Metadata Detected:"));
        console.log(`   Version: ${scan.il2cppMetadata.version}`);
      }

      if (scan.stringsFound.length > 0) {
        console.log();
        console.log(chalk.bold("  Signatures & Symbols Found:"));
        for (const s of scan.stringsFound) {
          console.log(`   ${chalk.cyan("✔")} ${s}`);
        }
      }

      if (scan.recommendations.length > 0) {
        console.log();
        console.log(chalk.bold("  Recommendations for REA Agents:"));
        for (const rec of scan.recommendations) {
          console.log(`   ${chalk.yellow("⚡")} ${rec}`);
        }
      }

      if (bundlePath) {
        console.log();
        console.log(`  Evidence bundle written to ${chalk.cyan(bundlePath)}`);
      }

      console.log(chalk.bold("────────────────────────────────────────"));
      console.log();
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Binary inspection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

// Command: mcp
program
  .command("mcp")
  .description("Start the Model Context Protocol (MCP) server over standard I/O")
  .option("--root <dir>", "Restrict every path the server touches to this directory (repeatable; also UAR_ALLOWED_ROOTS)", (v: string, prev: string[]) => [...prev, v], [] as string[])
  .action(async (opts: { root: string[] }) => {
    setAllowedRoots(opts.root.map((r) => path.resolve(r)));
    await runMcpServer();
  });

// Command: doctor
program
  .command("doctor")
  .description("Check the environment: Node.js, repak, AssetRipper and rea")
  .option("--json", "Output the report as JSON")
  .action(async (opts: { json?: boolean }) => {
    const report = await runDoctor();
    if (opts.json) {
      printJson(report);
    } else {
      console.log(chalk.bold("Universal Asset Ripper - doctor"));
      for (const c of report.checks) {
        const mark = c.found ? chalk.green("OK     ") : chalk.yellow("MISSING");
        console.log(`  ${mark} ${c.name.padEnd(12)} ${c.found ? `${c.version ?? "(version unknown)"}${c.path ? ` [${c.path}]` : ""}` : (c.hint ?? "")}`);
      }
    }
    if (!report.ok) process.exitCode = 1;
});

// Command: decompilers
program
  .command("decompilers")
  .description("List reverse engineering and decompiler engines (Ghidra, Cutter, Hopper, IDA, Binutils)")
  .option("--json", "Print output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const backends = await DecompilerRegistry.getAvailableBackends();
    if (opts.json) {
      printJson(backends);
      return;
    }
    console.log();
    console.log(chalk.bold("────────────────────────────────────────"));
    console.log(chalk.bold.magenta("  Reverse Engineering & Decompiler Engines"));
    console.log(chalk.bold("────────────────────────────────────────"));
    for (const b of backends) {
      const mark = b.found ? chalk.green("✔ READY  ") : chalk.yellow("✖ MISSING");
      console.log(`  ${mark} ${chalk.bold(b.id.padEnd(10))} ${chalk.white(b.name)}`);
      if (b.executablePath) {
        console.log(`             ${chalk.dim("Path:")} ${b.executablePath}`);
      }
      if (b.version) {
        console.log(`             ${chalk.dim("Version:")} ${b.version}`);
      }
      const caps = Object.entries(b.capabilities)
        .filter(([_, enabled]) => enabled)
        .map(([cap]) => cap)
        .join(", ");
      console.log(`             ${chalk.dim("Capabilities:")} ${caps}`);
      if (!b.found) {
        console.log(`             ${chalk.yellow("Hint:")} ${b.hint}`);
      }
      console.log();
    }
    console.log(chalk.bold("────────────────────────────────────────"));
  });

// Command: disasm
program
  .command("disasm <binary>")
  .description("Disassemble binary machine code (Ghidra, Cutter, Hopper, IDA, Binutils)")
  .option("-f, --function <name>", "Function name or address")
  .option("-n, --count <number>", "Number of instructions", (v) => parseInt(v, 10), 50)
  .option("--backend <backend>", "Decompiler backend (ghidra, cutter, hopper, ida, binutils, auto)", "auto")
  .option("--att", "Use AT&T syntax (default is Intel)")
  .option("--json", "Print output as JSON")
  .action(async (binary: string, opts: { function?: string; count: number; backend: string; att?: boolean; json?: boolean }) => {
    const spinner = startSpinner(`Disassembling: ${chalk.cyan(binary)}...`, opts.json);
    try {
      const resolved = path.resolve(binary);
      const result = await DecompilerRegistry.disassemble(resolved, {
        functionOrAddress: opts.function,
        count: opts.count,
        backend: opts.backend as DecompilerBackendType,
        syntax: opts.att ? "att" : "intel"
      });

      if (opts.json) {
        printJson(result);
        return;
      }
      spinner.succeed(`Disassembly complete via ${chalk.green(result.backendUsed.toUpperCase())}.`);

      console.log();
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(chalk.bold.green(`  Disassembly: ${chalk.white(path.basename(resolved))}`));
      if (result.target) {
        console.log(`  Target:     ${chalk.cyan(result.target)}`);
      }
      console.log(`  Engine:     ${chalk.yellow(result.backendUsed.toUpperCase())}`);
      console.log(chalk.bold("────────────────────────────────────────"));
      for (const inst of result.instructions) {
        const addr = chalk.dim(inst.address.padEnd(16));
        const bytes = chalk.gray((inst.bytes ?? "").padEnd(20));
        const mnem = chalk.bold.cyan(inst.mnemonic.padEnd(10));
        const ops = chalk.white(inst.operands ?? "");
        console.log(`  ${addr} ${bytes} ${mnem} ${ops}`);
      }
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log();
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Disassembly failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

// Command: decompile
program
  .command("decompile <binary>")
  .description("Decompile binary code to C/pseudocode (Ghidra, Cutter, IDA)")
  .option("-f, --function <name>", "Function name or address to decompile")
  .option("--backend <backend>", "Decompiler backend (ghidra, cutter, ida, auto)", "auto")
  .option("-o, --output <file>", "Save decompiled C code to file")
  .option("--json", "Print output as JSON")
  .action(async (binary: string, opts: { function?: string; backend: string; output?: string; json?: boolean }) => {
    const spinner = startSpinner(`Decompiling: ${chalk.cyan(binary)}...`, opts.json);
    try {
      const resolved = path.resolve(binary);
      const result = await DecompilerRegistry.decompile(resolved, {
        functionOrAddress: opts.function,
        backend: opts.backend as DecompilerBackendType
      });

      if (opts.output) {
        const outPath = path.resolve(opts.output);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, result.code, "utf-8");
      }

      if (opts.json) {
        printJson(result);
        return;
      }

      spinner.succeed(`Decompilation complete via ${chalk.green(result.backendUsed.toUpperCase())} in ${result.durationMs}ms.`);
      console.log();
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(chalk.bold.green(`  Decompiled C Code: ${chalk.white(path.basename(resolved))}`));
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(result.code);
      console.log(chalk.bold("────────────────────────────────────────"));
      if (opts.output) {
        console.log(`  Written to: ${chalk.cyan(opts.output)}`);
      }
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Decompilation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

// Command: symbols
program
  .command("symbols <binary>")
  .description("Dump symbols from binary (functions, data, imports, exports)")
  .option("--filter <filter>", "Filter symbols containing this substring")
  .option("--json", "Print output as JSON")
  .action(async (binary: string, opts: { filter?: string; json?: boolean }) => {
    const spinner = startSpinner(`Dumping symbols from: ${chalk.cyan(binary)}...`, opts.json);
    try {
      const resolved = path.resolve(binary);
      const result = await DecompilerRegistry.dumpSymbols(resolved, opts.filter);

      if (opts.json) {
        printJson(result);
        return;
      }
      spinner.succeed(`Found ${chalk.green(result.totalCount)} symbols via ${chalk.yellow(result.backendUsed.toUpperCase())}.`);

      console.log();
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(chalk.bold.green(`  Symbols: ${chalk.white(path.basename(resolved))}`));
      console.log(chalk.bold("────────────────────────────────────────"));
      for (const s of result.symbols.slice(0, 100)) {
        const kindTag = s.kind === "function" ? chalk.cyan("[FUNC]") : s.kind === "data" ? chalk.yellow("[DATA]") : chalk.gray("[IMP ]");
        console.log(`  ${s.address.padEnd(18)} ${kindTag} ${chalk.white(s.name)}`);
      }
      if (result.symbols.length > 100) {
        console.log(chalk.dim(`  ... and ${result.symbols.length - 100} more symbols (use --filter or --json)`));
      }
      console.log(chalk.bold("────────────────────────────────────────"));
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Symbol dump failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

// Command: audit (alias: rea-dir)
program
  .command("audit <targetDir>")
  .alias("rea-dir")
  .description("Run automated end-to-end reverse engineering, asset discovery, PE resource extraction, and multi-binary audit on a directory")
  .option("-o, --output <dir>", "Directory where audit-report.json and audit-report.md will be saved")
  .option("--max-depth <number>", "Maximum directory recursion depth", (v) => parseInt(v, 10), 4)
  .option("--no-decompile", "Skip automated C decompilation phase (enabled by default)")
  .option("--json", "Print output as JSON")
  .action(async (targetDir: string, opts: { output?: string; maxDepth: number; decompile?: boolean; json?: boolean }) => {
    const spinner = startSpinner(`Running automated application audit on: ${chalk.cyan(targetDir)}...`, opts.json);
    try {
      const resolved = path.resolve(targetDir);
      const report = await ApplicationAuditor.auditDirectory(resolved, {
        outputDir: opts.output,
        maxDepth: opts.maxDepth,
        decompile: opts.decompile !== false
      });

      if (opts.json) {
        printJson(report);
        return;
      }

      spinner.succeed(`Audit complete for ${chalk.green(report.appName)}.`);

      console.log();
      console.log(chalk.bold("──────────────────────────────────────────────────────────"));
      console.log(chalk.bold.magenta(`  Application Reverse Engineering Audit: ${chalk.white(report.appName)}`));
      console.log(chalk.bold("──────────────────────────────────────────────────────────"));
      console.log(`  Target Directory:    ${chalk.white(report.targetDirectory)}`);
      console.log(`  Engine Detected:     ${chalk.yellow(report.engine.toUpperCase())} (${Math.round(report.confidence * 100)}%)`);
      console.log(`  Total Files:         ${chalk.cyan(report.totalFiles.toLocaleString())} (${(report.totalSizeBytes / 1024 / 1024).toFixed(2)} MB)`);
      console.log();

      console.log(chalk.bold("  Summary of Recovered Artifacts:"));
      console.log(`   ✔ ${chalk.bold("Dialog Templates:")}     ${chalk.green(report.summary.totalDialogs)} embedded Win32 dialogs`);
      console.log(`   ✔ ${chalk.bold("Icons & Bitmaps:")}      ${chalk.green(report.summary.totalIcons)} visual resources`);
      console.log(`   ✔ ${chalk.bold("Discovered CLI Flags:")} ${chalk.green(report.summary.totalCliFlags)} flags`);
      console.log(`   ✔ ${chalk.bold("Sibling DLLs & Plugins:")} ${chalk.green(report.siblingDlls.length)} libraries (${report.summary.totalPluginExports} exports)`);
      console.log(`   ✔ ${chalk.bold("Config Models:")}        ${chalk.green(report.configurationModels.length)} XML/JSON/YAML models`);
      console.log(`   ✔ ${chalk.bold("EntryPoint Disassembly:")} ${chalk.green(report.summary.totalDisassembledInstructions)} instructions (${report.decompilationBackend.toUpperCase()})`);
      if (report.summary.totalDecompiledFunctions > 0) {
        console.log(`   ✔ ${chalk.bold("Decompiled Functions:")}  ${chalk.green(report.summary.totalDecompiledFunctions)} functions exported to C`);
      } else {
        console.log(`   - ${chalk.bold("Decompilation Engine:")}  ${report.decompilationEngineAvailable ? chalk.green("Ready (Ghidra/Cutter)") : chalk.yellow("Standby (Pass --decompile or install Ghidra)")}`);
      }

      if (report.primaryExecutable) {
        console.log();
        console.log(chalk.bold("  Primary Executable:"));
        console.log(`   File:        ${chalk.white(report.primaryExecutable.name)}`);
        console.log(`   Imports:     ${chalk.cyan(report.primaryExecutable.importedFunctionCount)} functions across ${report.primaryExecutable.importedDlls.length} DLLs`);
        if (report.primaryExecutable.cliFlags.length > 0) {
          console.log(`   CLI Flags:   ${chalk.dim(report.primaryExecutable.cliFlags.slice(0, 8).join(", "))}...`);
        }
      }

      if (report.siblingDlls.length > 0) {
        console.log();
        console.log(chalk.bold("  Sibling DLLs & Plugins Discovered:"));
        for (const dll of report.siblingDlls) {
          console.log(`   • ${chalk.white(dll.relativePath)} (${chalk.yellow(dll.purposeInferred)})`);
          if (dll.exportedFunctions.length > 0) {
            console.log(`     Exports: ${chalk.dim(dll.exportedFunctions.slice(0, 6).join(", "))}`);
          }
        }
      }

      if (report.configurationModels.length > 0) {
        console.log();
        console.log(chalk.bold("  Key Configuration Models:"));
        for (const cfg of report.configurationModels.slice(0, 8)) {
          console.log(`   • ${chalk.white(cfg.relativePath)} [${chalk.cyan(cfg.category)}]: ${chalk.dim(cfg.description)}`);
        }
        if (report.configurationModels.length > 8) {
          console.log(chalk.dim(`     ... and ${report.configurationModels.length - 8} more configuration files`));
        }
      }

      if (report.recommendations.length > 0) {
        console.log();
        console.log(chalk.bold("  Recommendations for Clean-Room Recovery:"));
        for (const rec of report.recommendations) {
          console.log(`   ⚡ ${chalk.yellow(rec)}`);
        }
      }

      if (opts.output) {
        console.log();
        console.log(`  Audit report saved to: ${chalk.cyan(opts.output)} (audit-report.json & audit-report.md)`);
      }

      console.log(chalk.bold("──────────────────────────────────────────────────────────"));
      console.log();
    } catch (err: unknown) {
      failCommand(spinner, opts.json, `Directory audit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

program.parse(process.argv);

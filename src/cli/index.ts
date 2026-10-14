import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as path from "node:path";
import { EngineDetector } from "../core/detector/engine-detector.js";
import { AdapterRegistry } from "../adapters/index.js";
import { ReaBridge } from "../rea/rea-bridge.js";
import { runMcpServer } from "../mcp/server.js";
import { ASSET_CATEGORIES } from "../types/index.js";
import { validateCategories } from "../utils/file-utils.js";

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
  .option("--json", "Print the full asset manifest as JSON to stdout")
  .action(async (target: string, opts: { json?: boolean }) => {
    const spinner = startSpinner(`Inspecting package: ${chalk.cyan(target)}...`, opts.json);
    try {
      const resolved = path.resolve(target);
      const { adapter, engine } = await AdapterRegistry.resolveAdapter(resolved);
      const manifest = await adapter.inspect(resolved);
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
  .option("--aes-key <hex>", "AES-256 decryption key (Unreal Engine)")
  .option("--dry-run", "Simulate extraction without writing files to disk")
  .option("--json", "Print the extraction result as JSON to stdout")
  .action(async (target: string, opts: { output: string; categories?: string; filter?: string; aesKey?: string; dryRun?: boolean; json?: boolean }) => {
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
  .option("--json", "Print the scan result and evidence bundle as JSON to stdout")
  .action(async (binary: string, opts: { json?: boolean }) => {
    const spinner = startSpinner(`Running REA deep binary scan on: ${chalk.cyan(binary)}...`, opts.json);
    try {
      const resolved = path.resolve(binary);
      const { scan, bundle } = await ReaBridge.inspectBinary(resolved);
      if (opts.json) {
        printJson({ scan, bundle });
        return;
      }
      spinner.succeed(`Binary inspection complete.`);

      console.log();
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(chalk.bold.magenta("  REA Binary Analysis & Evidence Bundle"));
      console.log(chalk.bold("────────────────────────────────────────"));
      console.log(`  Binary:         ${chalk.white(path.basename(resolved))}`);
      console.log(`  Architecture:   ${chalk.white(scan.arch)}`);

      if (scan.candidateAesKeys.length > 0) {
        console.log();
        console.log(chalk.bold.yellow("  Candidate AES-256 Keys Discovered:"));
        for (const key of scan.candidateAesKeys) {
          console.log(`   ${chalk.green("🔑")} ${chalk.bold(key.keyHex)} (Offset: 0x${key.offset.toString(16)}, Entropy: ${key.entropy.toFixed(2)}, Conf: ${key.confidence})`);
        }
      } else {
        console.log(`  AES Keys:       ${chalk.dim("No plaintext 256-bit keys detected")}`);
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
  .action(async () => {
    await runMcpServer();
  });

program.parse(process.argv);

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ApplicationAuditor } from "../dist/pipeline/application-auditor.js";
import { DecompilerRegistry } from "../dist/decompiler/decompiler-registry.js";
import chalk from "chalk";

const TARGET_DIR = "C:\\Program Files\\Notepad++";
const OUTPUT_DIR = "D:\\notepadpp_decompiled";

const RIZIN_EXE = "D:\\tools\\rizin-win-installer-clang_cl-64\\bin\\rizin.exe";
const SLEIGH_HOME = "D:\\tools\\Cutter\\Cutter-v2.5.0-Windows-x86_64\\lib\\rizin\\plugins\\rz_ghidra_sleigh";

const ENV = {
  ...process.env,
  SLEIGHHOME: SLEIGH_HOME
};

function decompileFunctionWithRizin(binaryPath, funcTarget) {
  const res = spawnSync(
    RIZIN_EXE,
    ["-q", "-e", "scr.color=0", "-c", `aaa; s ${funcTarget}; pdg`, binaryPath],
    { env: ENV, encoding: "utf-8", timeout: 45000 }
  );

  const raw = res.stdout || res.stderr || "// No code produced";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter((l) => !l.startsWith("ERROR: Cannot peek memory"))
    .join("\n")
    .trim();
}

function decompileBatchWithRizin(binaryPath, funcTargets) {
  const commands = ["aaa"];
  for (const fn of funcTargets) {
    commands.push(`s ${fn}`);
    commands.push("pdg");
  }

  const res = spawnSync(
    RIZIN_EXE,
    ["-q", "-e", "scr.color=0", "-c", commands.join("; "), binaryPath],
    { env: ENV, encoding: "utf-8", timeout: 90000 }
  );

  // eslint-disable-next-line no-control-regex
  const raw = (res.stdout || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  const lines = raw.split(/\r?\n/).filter((l) => !l.startsWith("ERROR: Cannot peek memory"));
  
  // Split output by function definitions
  const results = {};
  let currentFunc = funcTargets[0] || "unknown";
  let currentBuffer = [];

  for (const line of lines) {
    // Check if line looks like a function signature starting
    const matchesTarget = funcTargets.find((fn) => line.includes(fn) && (line.includes("(") || line.endsWith("{")));
    if (matchesTarget) {
      if (currentBuffer.length > 0) {
        results[currentFunc] = currentBuffer.join("\n").trim();
        currentBuffer = [];
      }
      currentFunc = matchesTarget;
    }
    currentBuffer.push(line);
  }
  if (currentBuffer.length > 0) {
    results[currentFunc] = currentBuffer.join("\n").trim();
  }

  return results;
}

async function main() {
  console.log(chalk.bold.magenta("══════════════════════════════════════════════════════════"));
  console.log(chalk.bold.magenta("  Universal Asset Ripper — Full Decompilation Suite"));
  console.log(chalk.bold.magenta("══════════════════════════════════════════════════════════"));
  console.log(`  Source Target:      ${chalk.white(TARGET_DIR)}`);
  console.log(`  Output Destination: ${chalk.cyan(OUTPUT_DIR)}`);
  console.log(`  Decompiler Engine:  ${chalk.green("NSA Ghidra (via Rizin Native Sleigh Engine)")}`);
  console.log();

  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const allDecompiledUnits = [];

  // 1. Binaries to Process
  const targets = [
    {
      name: "notepad++.exe",
      fullPath: path.join(TARGET_DIR, "notepad++.exe"),
      category: "primary",
      keyFunctions: ["entry0", "fcn.140001000", "fcn.140001020"]
    },
    {
      name: "mimeTools.dll",
      fullPath: path.join(TARGET_DIR, "plugins", "mimeTools", "mimeTools.dll"),
      category: "plugin",
      keyFunctions: [
        "sym.mimeTools.dll_getName",
        "sym.mimeTools.dll_isUnicode",
        "sym.mimeTools.dll_setInfo",
        "sym.mimeTools.dll_getFuncsArray",
        "sym.mimeTools.dll_beNotified",
        "sym.mimeTools.dll_messageProc"
      ]
    },
    {
      name: "NppConverter.dll",
      fullPath: path.join(TARGET_DIR, "plugins", "NppConverter", "NppConverter.dll"),
      category: "plugin",
      keyFunctions: [
        "sym.NppConverter.dll_getName",
        "sym.NppConverter.dll_isUnicode",
        "sym.NppConverter.dll_setInfo",
        "sym.NppConverter.dll_getFuncsArray",
        "sym.NppConverter.dll_beNotified",
        "sym.NppConverter.dll_messageProc"
      ]
    },
    {
      name: "NppExport.dll",
      fullPath: path.join(TARGET_DIR, "plugins", "NppExport", "NppExport.dll"),
      category: "plugin",
      keyFunctions: [
        "sym.NppExport.dll_getName",
        "sym.NppExport.dll_isUnicode",
        "sym.NppExport.dll_setInfo",
        "sym.NppExport.dll_getFuncsArray",
        "sym.NppExport.dll_beNotified",
        "sym.NppExport.dll_messageProc"
      ]
    },
    {
      name: "NppShell.dll",
      fullPath: path.join(TARGET_DIR, "contextMenu", "NppShell.dll"),
      category: "shell-extension",
      keyFunctions: [
        "sym.NppShell.dll_DllMain",
        "sym.NppShell.dll_DllGetClassObject",
        "sym.NppShell.dll_DllCanUnloadNow",
        "sym.NppShell.dll_DllRegisterServer",
        "sym.NppShell.dll_DllUnregisterServer",
        "sym.NppShell.dll_CleanupDll"
      ]
    }
  ];

  for (const target of targets) {
    console.log(chalk.bold(`► Decompiling Module: ${chalk.cyan(target.name)}...`));
    const modDir = path.join(OUTPUT_DIR, target.name.replace(/\.[^.]+$/, ""));
    await fs.mkdir(modDir, { recursive: true });

    // Also dump full symbol table and disassembly summary
    try {
      const symbols = await DecompilerRegistry.dumpSymbols(target.fullPath);
      await fs.writeFile(
        path.join(modDir, "symbols.json"),
        JSON.stringify(symbols, null, 2),
        "utf-8"
      );
    } catch {
      // ignore
    }

    try {
      const disasm = await DecompilerRegistry.disassemble(target.fullPath, { count: 100 });
      await fs.writeFile(
        path.join(modDir, "entrypoint.asm"),
        disasm.rawText,
        "utf-8"
      );
    } catch {
      // ignore
    }

    // Decompile key target functions
    const batchResults = decompileBatchWithRizin(target.fullPath, target.keyFunctions);

    for (const fn of target.keyFunctions) {
      let code = batchResults[fn];
      if (!code || code.length < 15) {
        // Retry single function
        code = decompileFunctionWithRizin(target.fullPath, fn);
      }

      const cleanFnName = fn.replace(/^sym\.[^.]+\.dll_/, "").replace(/^fcn\./, "func_");
      const cFilePath = path.join(modDir, `${cleanFnName}.c`);
      await fs.writeFile(cFilePath, code, "utf-8");

      allDecompiledUnits.push({
        module: target.name,
        functionName: cleanFnName,
        code,
        isExport: fn.startsWith("sym.")
      });

      console.log(`   ✔ Decompiled: ${chalk.white(cleanFnName)} -> ${chalk.dim(cFilePath)}`);
    }

    // Combine into full module C file
    const combinedC = allDecompiledUnits
      .filter((u) => u.module === target.name)
      .map((u) => `// ==========================================================================\n// Function: ${u.functionName}\n// ==========================================================================\n${u.code}\n`)
      .join("\n\n");
    await fs.writeFile(path.join(modDir, "combined_decompiled.c"), combinedC, "utf-8");

    console.log();
  }

  // 2. Run Application Auditor to generate full discovery, dialogs & configs
  console.log(chalk.bold("► Running Full Application Directory Audit & Resource Extraction..."));
  const auditReport = await ApplicationAuditor.auditDirectory(TARGET_DIR, {
    outputDir: OUTPUT_DIR,
    maxDepth: 4,
    decompile: true
  });
  console.log(`   ✔ Extracted ${auditReport.summary.totalDialogs} Dialogs, ${auditReport.summary.totalIcons} Icons, ${auditReport.summary.totalCliFlags} CLI Flags.`);
  console.log();

  // 3. Generate Master Decompilation Catalog
  console.log(chalk.bold("► Generating Master Decompilation Catalog & Architecture Guide..."));
  const catalogLines = [];
  catalogLines.push("# Notepad++ Full Decompilation & Reverse Engineering Catalog");
  catalogLines.push("");
  catalogLines.push(`**Generated on:** ${new Date().toISOString()}`);
  catalogLines.push(`**Source Location:** \`${TARGET_DIR}\``);
  catalogLines.push(`**Output Location:** \`${OUTPUT_DIR}\``);
  catalogLines.push(`**Decompiler Backend:** NSA Ghidra (via Rizin Native Sleigh Architecture Engine)`);
  catalogLines.push("");
  catalogLines.push("## Summary of Decompiled Artifacts");
  catalogLines.push(`- **Decompiled C Functions:** ${allDecompiledUnits.length} functions across ${targets.length} modules`);
  catalogLines.push(`- **Extracted Win32 Dialogs:** ${auditReport.summary.totalDialogs}`);
  catalogLines.push(`- **Discovered CLI Switches:** ${auditReport.summary.totalCliFlags}`);
  catalogLines.push(`- **Configuration Models:** ${auditReport.configurationModels.length}`);
  catalogLines.push("");

  catalogLines.push("## Modules & Decompiled Functions");
  for (const target of targets) {
    const modUnits = allDecompiledUnits.filter((u) => u.module === target.name);
    catalogLines.push(`### \`${target.name}\` (${target.category})`);
    catalogLines.push(`- **Target Path:** \`${target.fullPath}\``);
    catalogLines.push(`- **Decompiled Units:**`);
    for (const u of modUnits) {
      catalogLines.push(`  - **\`${u.functionName}\`** (${u.isExport ? "Exported ABI" : "Internal"}): [${u.functionName}.c](./${target.name.replace(/\.[^.]+$/, "")}/${u.functionName}.c)`);
    }
    catalogLines.push("");
  }

  catalogLines.push("## Key Decompiled Pseudocode Previews");
  for (const u of allDecompiledUnits.slice(0, 8)) {
    catalogLines.push(`### \`${u.module}\` :: \`${u.functionName}\``);
    catalogLines.push("```c");
    catalogLines.push(u.code.slice(0, 1200) + (u.code.length > 1200 ? "\n// ... [truncated for preview]" : ""));
    catalogLines.push("```");
    catalogLines.push("");
  }

  catalogLines.push("## Architectural Insights & Rust Reimplementation Recommendations");
  catalogLines.push("1. **Plugin Protocol (`setInfo` / `NppData`)**: Notepad++ passes three 64-bit HWNDs (`_nppHandle`, `_scintillaMainHandle`, `_scintillaSecondHandle`) at offsets 0, 8, 16. In Rust, represent this as a `struct NppData { npp_hwnd: isize, scintilla_primary: isize, scintilla_secondary: isize }`.");
  catalogLines.push("2. **Ready Notification (`NPPN_READY = 0x403`)**: Plugins wait for notification 0x403 to initialize custom toolbars, dockable panels, and menu hookups.");
  catalogLines.push("3. **Command Registration (`getFuncsArray`)**: Returns an array of `FuncItem` structures with command name, shortcut key, and function pointer. The count is returned by reference (`*(undefined4 *)arg1 = 0x16`).");
  catalogLines.push("4. **Unicode Signature (`isUnicode`)**: Simply returns boolean 1 (`return 1;`), asserting UTF-16 Win32 ABI compliance.");

  const catalogContent = catalogLines.join("\n");
  await fs.writeFile(path.join(OUTPUT_DIR, "DECOMPILATION_CATALOG.md"), catalogContent, "utf-8");

  console.log(chalk.bold.green(`✔ Full Decompilation Suite Completed Successfully!`));
  console.log(`  All artifacts saved to: ${chalk.cyan(OUTPUT_DIR)}`);
  console.log(chalk.bold.magenta("══════════════════════════════════════════════════════════"));
}

main().catch((err) => {
  console.error("Decompilation failed:", err);
  process.exit(1);
});

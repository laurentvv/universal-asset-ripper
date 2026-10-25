#!/usr/bin/env node
/**
 * Setup and installation guide for reverse engineering and decompiler engines:
 * - NSA Ghidra
 * - Cutter / Rizin
 * - Hopper Disassembler
 * - IDA Pro / Free
 * - GNU Binutils
 */

import { DecompilerRegistry } from "../dist/decompiler/decompiler-registry.js";
import chalk from "chalk";

console.log(chalk.bold.magenta("──────────────────────────────────────────────────────────"));
console.log(chalk.bold.magenta("  Decompiler & Reverse Engineering Tools Setup Guide"));
console.log(chalk.bold.magenta("──────────────────────────────────────────────────────────"));
console.log();

const backends = await DecompilerRegistry.getAvailableBackends();

for (const b of backends) {
  const status = b.found ? chalk.green("✔ INSTALLED") : chalk.yellow("✖ NOT FOUND");
  console.log(`${status} ${chalk.bold(b.name)} [${chalk.cyan(b.id)}]`);
  if (b.executablePath) {
    console.log(`   Location: ${chalk.white(b.executablePath)}`);
    if (b.version) console.log(`   Version:  ${chalk.white(b.version)}`);
  } else {
    console.log(`   Installation / Setup instructions:`);
    if (b.id === "ghidra") {
      console.log(`     • Via winget (Windows):   ${chalk.cyan("winget install NSA.Ghidra")}`);
      console.log(`     • Official release zip:   ${chalk.cyan("https://github.com/NationalSecurityAgency/ghidra/releases")}`);
      console.log(`     • Environment variable:   ${chalk.white("Set GHIDRA_INSTALL_DIR=C:\\tools\\ghidra_xx.x")}`);
      console.log(`     • Requirement:            ${chalk.dim("JDK 17 or 21 (JAVA_HOME)")}`);
    } else if (b.id === "cutter") {
      console.log(`     • Via winget (Windows):   ${chalk.cyan("winget install Rizin.Cutter")}`);
      console.log(`     • Official release:       ${chalk.cyan("https://github.com/rizinorg/cutter/releases")}`);
      console.log(`     • Environment variable:   ${chalk.white("Set CUTTER_PATH=C:\\Program Files\\Cutter\\cutter.exe")}`);
    } else if (b.id === "hopper") {
      console.log(`     • Official download:      ${chalk.cyan("https://www.hopperapp.com/")}`);
      console.log(`     • Environment variable:   ${chalk.white("Set HOPPER_PATH=C:\\Program Files\\Hopper Disassembler v4\\hopper.exe")}`);
    } else if (b.id === "ida") {
      console.log(`     • Official release:       ${chalk.cyan("https://hex-rays.com/ida-pro/ or IDA Free")}`);
      console.log(`     • Environment variable:   ${chalk.white("Set IDA_PATH=C:\\Program Files\\IDA Pro 8.x\\idat64.exe")}`);
    } else if (b.id === "binutils") {
      console.log(`     • Via MSYS2 (Windows):    ${chalk.cyan("pacman -S mingw-w64-ucrt-x86_64-binutils")}`);
      console.log(`     • Already present:        ${chalk.white("Available via C:\\msys64\\ucrt64\\bin")}`);
    }
  }
  console.log();
}

console.log(chalk.bold.magenta("──────────────────────────────────────────────────────────"));
console.log(chalk.bold("To test disassembly right now (using Binutils):"));
console.log(chalk.cyan("  node ./bin/ripper.js disasm \"C:\\Program Files\\Notepad++\\notepad++.exe\" -n 20"));
console.log(chalk.bold("To dump all functions and imported symbols:"));
console.log(chalk.cyan("  node ./bin/ripper.js symbols \"C:\\Program Files\\Notepad++\\notepad++.exe\" --filter \"Create\""));
console.log(chalk.bold.magenta("──────────────────────────────────────────────────────────"));

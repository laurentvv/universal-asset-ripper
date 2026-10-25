import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { runTool } from "../../utils/exec.js";
import type {
  BinarySymbol,
  DecompilerBackendInfo,
  DisassembledInstruction,
  DisassemblyOptions,
  DisassemblyResult,
  SymbolDumpResult
} from "../types.js";

const COMMON_BINUTILS_PATHS = [
  "C:\\msys64\\ucrt64\\bin",
  "C:\\msys64\\mingw64\\bin",
  "C:\\msys64\\usr\\bin",
  "C:\\Program Files\\Git\\usr\\bin"
];

export class BinutilsBackend {
  public static async findExecutable(name: string): Promise<string | null> {
    try {
      const { stdout } = await runTool("where", [name]);
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) return lines[0];
    } catch {
      // not on PATH
    }

    if (process.platform === "win32") {
      const exeName = name.endsWith(".exe") ? name : `${name}.exe`;
      for (const dir of COMMON_BINUTILS_PATHS) {
        const fullPath = path.join(dir, exeName);
        try {
          await fs.access(fullPath);
          return fullPath;
        } catch {
          // ignore
        }
      }
    }
    return null;
  }

  public static async getInfo(): Promise<DecompilerBackendInfo> {
    const objdumpPath = await this.findExecutable("objdump");
    let version: string | undefined;
    if (objdumpPath) {
      try {
        const { stdout } = await runTool(objdumpPath, ["--version"]);
        const firstLine = stdout.split(/\r?\n/)[0];
        if (firstLine) version = firstLine.trim();
      } catch {
        version = "found";
      }
    }

    return {
      id: "binutils",
      name: "GNU Binutils / LLVM (objdump, nm, strings)",
      found: objdumpPath !== null,
      executablePath: objdumpPath ?? undefined,
      version,
      capabilities: {
        disassembly: true,
        decompilation: false,
        controlFlowGraph: false,
        symbols: true,
        strings: true,
        demangle: true,
        crossReferences: false
      },
      hint: "Provides native x86/x64/ARM disassembly, symbol dumps and string inspection via objdump and nm"
    };
  }

  public static async disassemble(binaryPath: string, options: DisassemblyOptions = {}): Promise<DisassemblyResult> {
    const objdump = (await this.findExecutable("objdump")) ?? "objdump";
    const args: string[] = ["-d"];

    if (options.syntax !== "att") {
      args.push("-M", "intel");
    }
    if (options.demangle !== false) {
      args.push("-C");
    }

    args.push(binaryPath);

    const child = spawn(objdump, args, { windowsHide: true });
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    const instructions: DisassembledInstruction[] = [];
    const rawLines: string[] = [];
    const maxCount = options.count ?? 50;

    // Parse objdump output:
    //   140001000:       48 83 ec 28             sub    rsp,0x28
    const lineRegex = /^\s*([0-9a-fA-F]+):\s+((?:[0-9a-fA-F]{2}\s+)+)\s+([a-zA-Z0-9_.]+)(?:\s+(.*))?$/;
    let targetFound = !options.functionOrAddress;

    return new Promise((resolve, reject) => {
      child.on("error", (err) => reject(err));

      rl.on("line", (line) => {
        if (options.functionOrAddress && !targetFound) {
          if (line.includes(`<${options.functionOrAddress}>`) || line.includes(options.functionOrAddress)) {
            targetFound = true;
          }
        }

        if (targetFound) {
          const match = line.match(lineRegex);
          if (match) {
            rawLines.push(line);
            instructions.push({
              address: `0x${match[1]}`,
              bytes: match[2].trim(),
              mnemonic: match[3],
              operands: match[4]?.trim()
            });

            if (instructions.length >= maxCount) {
              rl.close();
              child.kill();
              resolve({
                binaryPath,
                backendUsed: "binutils",
                target: options.functionOrAddress,
                instructions,
                rawText: rawLines.join("\n")
              });
            }
          }
        }
      });

      child.on("close", () => {
        resolve({
          binaryPath,
          backendUsed: "binutils",
          target: options.functionOrAddress,
          instructions,
          rawText: rawLines.join("\n")
        });
      });
    });
  }

  public static async dumpSymbols(binaryPath: string, filter?: string): Promise<SymbolDumpResult> {
    const nm = (await this.findExecutable("nm")) ?? "nm";
    const symbols: BinarySymbol[] = [];

    try {
      const { stdout } = await runTool(nm, ["-C", binaryPath]);
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) {
          const [addr, typeChar, ...nameParts] = parts;
          const name = nameParts.join(" ");
          if (filter && !name.toLowerCase().includes(filter.toLowerCase())) continue;

          let kind: BinarySymbol["kind"] = "unknown";
          if (typeChar.toUpperCase() === "T") kind = "function";
          else if (typeChar.toUpperCase() === "D" || typeChar.toUpperCase() === "B") kind = "data";
          else if (typeChar.toUpperCase() === "U") kind = "import";

          symbols.push({
            name,
            address: `0x${addr}`,
            kind
          });
        }
      }
    } catch {
      // ignore nm failure
    }

    // If nm returns empty or fails (common for stripped PE binaries), parse import table with objdump -p
    if (symbols.length === 0) {
      const objdump = (await this.findExecutable("objdump")) ?? "objdump";
      try {
        const { stdout } = await runTool(objdump, ["-p", binaryPath]);
        const lines = stdout.split(/\r?\n/);
        let currentDll = "";
        const importRegex = /^\s+([0-9a-fA-F]{8})\s+(?:<none>|\d+)\s+(?:[0-9a-fA-F]+|<none>)\s+([a-zA-Z0-9_@?]+)/;

        for (const line of lines) {
          if (line.includes("DLL Name:")) {
            const match = line.match(/DLL Name:\s+([^\r\n]+)/);
            if (match) currentDll = match[1].trim();
          } else {
            const match = line.match(importRegex);
            if (match) {
              const addr = match[1];
              const func = match[2];
              const fullName = currentDll ? `${currentDll}!${func}` : func;
              if (filter && !fullName.toLowerCase().includes(filter.toLowerCase())) continue;

              symbols.push({
                name: fullName,
                address: `0x${addr}`,
                kind: "import",
                section: currentDll
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      binaryPath,
      backendUsed: "binutils",
      symbols,
      totalCount: symbols.length
    };
  }

  public static async extractStrings(binaryPath: string, minLength = 4): Promise<string[]> {
    const stringsCmd = (await this.findExecutable("strings")) ?? "strings";
    try {
      const { stdout } = await runTool(stringsCmd, ["-a", "-n", String(minLength), binaryPath]);
      return stdout.split(/\r?\n/).filter((l) => l.trim().length >= minLength);
    } catch {
      return [];
    }
  }
}

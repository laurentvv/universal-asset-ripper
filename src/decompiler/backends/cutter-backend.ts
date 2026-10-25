import * as fs from "node:fs/promises";
import { runTool } from "../../utils/exec.js";
import type { DecompileOptions, DecompileResult, DecompilerBackendInfo } from "../types.js";

export class CutterBackend {
  public static async findExecutable(): Promise<string | null> {
    if (process.env.CUTTER_PATH) {
      try {
        await fs.access(process.env.CUTTER_PATH);
        return process.env.CUTTER_PATH;
      } catch {
        // invalid
      }
    }

    try {
      const { stdout } = await runTool("where", ["cutter"], { timeoutMs: 1500 });
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) return lines[0];
    } catch {
      // not on PATH
    }

    try {
      const { stdout } = await runTool("where", ["rizin"], { timeoutMs: 1500 });
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) return lines[0];
    } catch {
      // not on PATH
    }

    const candidatePaths = [
      "D:\\tools\\rizin-win-installer-clang_cl-64\\bin\\rizin.exe",
      "D:\\tools\\Cutter\\Cutter-v2.5.0-Windows-x86_64\\cutter.exe",
      "C:\\tools\\rizin\\bin\\rizin.exe",
      "C:\\Program Files\\Cutter\\cutter.exe",
      "C:\\tools\\Cutter\\cutter.exe"
    ];

    for (const p of candidatePaths) {
      try {
        await fs.access(p);
        return p;
      } catch {
        // continue
      }
    }
    return null;
  }

  public static async findSleighHome(): Promise<string | null> {
    if (process.env.SLEIGHHOME) {
      try {
        await fs.access(process.env.SLEIGHHOME);
        return process.env.SLEIGHHOME;
      } catch {
        // invalid
      }
    }
    const candidates = [
      "D:\\tools\\Cutter\\Cutter-v2.5.0-Windows-x86_64\\lib\\rizin\\plugins\\rz_ghidra_sleigh",
      "D:\\tools\\rizin-win-installer-clang_cl-64\\lib\\rizin\\plugins\\rz_ghidra_sleigh",
      "C:\\tools\\Cutter\\lib\\rizin\\plugins\\rz_ghidra_sleigh",
      "C:\\Program Files\\Cutter\\lib\\rizin\\plugins\\rz_ghidra_sleigh"
    ];
    for (const c of candidates) {
      try {
        await fs.access(c);
        return c;
      } catch {
        // continue
      }
    }
    return null;
  }

  public static async getInfo(): Promise<DecompilerBackendInfo> {
    const exePath = await this.findExecutable();
    let version: string | undefined;

    if (exePath) {
      try {
        const flag = exePath.toLowerCase().includes("rizin") ? "-v" : "--version";
        const { stdout } = await runTool(exePath, [flag], { timeoutMs: 1500 });
        const firstLine = stdout.split(/\r?\n/)[0];
        if (firstLine) version = firstLine.trim();
      } catch {
        version = "found";
      }
    }

    return {
      id: "cutter",
      name: "Cutter / Rizin (Open Source Reverse Engineering Platform with Ghidra)",
      found: exePath !== null,
      executablePath: exePath ?? undefined,
      version,
      capabilities: {
        disassembly: true,
        decompilation: true,
        controlFlowGraph: true,
        symbols: true,
        strings: true,
        demangle: true,
        crossReferences: true
      },
      hint: "Set CUTTER_PATH to cutter.exe/rizin.exe or install via 'winget install Rizin.Cutter'"
    };
  }

  public static async decompile(
    binaryPath: string,
    options: DecompileOptions = {}
  ): Promise<DecompileResult> {
    const startTime = Date.now();
    const exePath = await this.findExecutable();
    if (!exePath) {
      throw new Error("Cutter / Rizin executable not found.");
    }
    const sleighHome = await this.findSleighHome();
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (sleighHome) {
      env.SLEIGHHOME = sleighHome;
    }

    const target = options.functionOrAddress ?? "entry0";
    const rzCommands = `aaa; s ${target}; pdg`;

    const { stdout, stderr } = await runTool(
      exePath,
      ["-q", "-e", "scr.color=0", "-c", rzCommands, binaryPath],
      {
        env,
        timeoutMs: options.timeoutMs ?? 60000
      }
    );

    const cleanOutput = stdout
      // eslint-disable-next-line no-control-regex
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("ERROR: Cannot peek memory"))
      .join("\n")
      .trim();

    return {
      binaryPath,
      backendUsed: "cutter",
      functionTarget: options.functionOrAddress,
      code: cleanOutput || stderr.trim(),
      durationMs: Date.now() - startTime
    };
  }

  public static async listFunctions(
    binaryPath: string
  ): Promise<{ name: string; address: string; size: number }[]> {
    const exePath = await this.findExecutable();
    if (!exePath) return [];
    try {
      const { stdout } = await runTool(exePath, ["-q", "-c", "aaa; aflj", binaryPath]);
      const parsed = JSON.parse(stdout) as { name: string; offset: number; size: number }[];
      return parsed.map((f) => ({
        name: f.name,
        address: `0x${f.offset.toString(16)}`,
        size: f.size
      }));
    } catch {
      return [];
    }
  }
}

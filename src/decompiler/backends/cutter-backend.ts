import * as fs from "node:fs/promises";
import { runTool } from "../../utils/exec.js";
import type { DecompilerBackendInfo } from "../types.js";

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
      const { stdout } = await runTool("where", ["cutter"]);
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) return lines[0];
    } catch {
      // not on PATH
    }

    try {
      const { stdout } = await runTool("where", ["rizin"]);
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) return lines[0];
    } catch {
      // not on PATH
    }

    const candidatePaths = [
      "C:\\Program Files\\Cutter\\cutter.exe",
      "C:\\tools\\Cutter\\cutter.exe",
      "C:\\tools\\rizin\\bin\\rizin.exe"
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

  public static async getInfo(): Promise<DecompilerBackendInfo> {
    const exePath = await this.findExecutable();
    let version: string | undefined;

    if (exePath) {
      try {
        const { stdout } = await runTool(exePath, ["--version"]);
        const firstLine = stdout.split(/\r?\n/)[0];
        if (firstLine) version = firstLine.trim();
      } catch {
        version = "found";
      }
    }

    return {
      id: "cutter",
      name: "Cutter / Rizin (Open Source Reverse Engineering Platform)",
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
}

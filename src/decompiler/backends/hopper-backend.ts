import * as fs from "node:fs/promises";
import { runTool } from "../../utils/exec.js";
import type { DecompilerBackendInfo } from "../types.js";

export class HopperBackend {
  public static async findExecutable(): Promise<string | null> {
    if (process.env.HOPPER_PATH) {
      try {
        await fs.access(process.env.HOPPER_PATH);
        return process.env.HOPPER_PATH;
      } catch {
        // invalid
      }
    }

    try {
      const { stdout } = await runTool("where", ["hopper"]);
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 0) return lines[0];
    } catch {
      // not on PATH
    }

    const candidatePaths = [
      "C:\\Program Files\\Hopper Disassembler v4\\hopper.exe",
      "C:\\Program Files\\Hopper Disassembler v5\\hopper.exe",
      "C:\\tools\\hopper\\hopper.exe"
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
    return {
      id: "hopper",
      name: "Hopper Disassembler (macOS / Linux / Windows)",
      found: exePath !== null,
      executablePath: exePath ?? undefined,
      capabilities: {
        disassembly: true,
        decompilation: true,
        controlFlowGraph: true,
        symbols: true,
        strings: true,
        demangle: true,
        crossReferences: true
      },
      hint: "Set HOPPER_PATH to hopper.exe or add Hopper to PATH"
    };
  }
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runTool } from "../../utils/exec.js";
import type { DecompilerBackendInfo } from "../types.js";

export class IdaBackend {
  public static async findExecutable(): Promise<string | null> {
    if (process.env.IDA_PATH) {
      try {
        await fs.access(process.env.IDA_PATH);
        return process.env.IDA_PATH;
      } catch {
        // invalid
      }
    }

    const exes = ["idat64", "ida64", "idat", "ida"];
    for (const exe of exes) {
      try {
        const { stdout } = await runTool("where", [exe]);
        const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
        if (lines.length > 0) return lines[0];
      } catch {
        // continue
      }
    }

    const candidateDirs = [
      "C:\\Program Files\\IDA Pro 8.4",
      "C:\\Program Files\\IDA Pro 8.3",
      "C:\\Program Files\\IDA Pro 9.0",
      "C:\\tools\\ida"
    ];

    for (const dir of candidateDirs) {
      for (const exe of ["idat64.exe", "ida64.exe", "ida.exe"]) {
        const full = path.join(dir, exe);
        try {
          await fs.access(full);
          return full;
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  public static async getInfo(): Promise<DecompilerBackendInfo> {
    const exePath = await this.findExecutable();
    return {
      id: "ida",
      name: "IDA Pro / Hex-Rays Decompiler",
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
      hint: "Set IDA_PATH to idat64.exe or ida64.exe to enable Hex-Rays / IDAPython automation"
    };
  }
}

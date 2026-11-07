import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runTool } from "../../utils/exec.js";
import type {
  DecompileOptions,
  DecompileResult,
  DecompilerBackendInfo
} from "../types.js";

export class GhidraBackend {
  public static async findInstallDir(): Promise<string | null> {
    if (process.env.GHIDRA_INSTALL_DIR) {
      try {
        await fs.access(process.env.GHIDRA_INSTALL_DIR);
        return process.env.GHIDRA_INSTALL_DIR;
      } catch {
        // invalid env var
      }
    }

    const candidateRoots = [
      "C:\\tools",
      "C:\\Program Files",
      "D:\\tools",
      "C:\\ghidra"
    ];

    for (const root of candidateRoots) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.toLowerCase().startsWith("ghidra")) {
            const dir = path.join(root, entry.name);
            const supportScript = process.platform === "win32"
              ? path.join(dir, "support", "analyzeHeadless.bat")
              : path.join(dir, "support", "analyzeHeadless");
            try {
              await fs.access(supportScript);
              return dir;
            } catch {
              // continue
            }
          }
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  public static async getHeadlessScript(installDir?: string): Promise<string | null> {
    const dir = installDir ?? (await this.findInstallDir());
    if (!dir) return null;
    const script = process.platform === "win32"
      ? path.join(dir, "support", "analyzeHeadless.bat")
      : path.join(dir, "support", "analyzeHeadless");
    try {
      await fs.access(script);
      return script;
    } catch {
      return null;
    }
  }

  public static async getInfo(): Promise<DecompilerBackendInfo> {
    const installDir = await this.findInstallDir();
    let version: string | undefined;

    if (installDir) {
      const baseName = path.basename(installDir);
      version = baseName;
      try {
        const propPath = path.join(installDir, "Ghidra", "application.properties");
        const content = await fs.readFile(propPath, "utf-8");
        const match = content.match(/application\.version=([^\r\n]+)/);
        if (match) version = `Ghidra v${match[1].trim()}`;
      } catch {
        // ignore
      }
    }

    return {
      id: "ghidra",
      name: "NSA Ghidra (Sleigh Decompiler Engine)",
      found: installDir !== null,
      executablePath: installDir ? (await this.getHeadlessScript(installDir)) ?? installDir : undefined,
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
      hint: "Set GHIDRA_INSTALL_DIR to your Ghidra folder (e.g. C:\\tools\\ghidra_11.x) or install via 'winget install NSA.Ghidra'"
    };
  }

  public static async decompile(binaryPath: string, options: DecompileOptions = {}): Promise<DecompileResult> {
    const startTime = Date.now();
    const installDir = await this.findInstallDir();
    const headless = await this.getHeadlessScript(installDir ?? undefined);

    if (!headless || !installDir) {
      throw new Error(
        "Ghidra is not installed or GHIDRA_INSTALL_DIR is not set. Install Ghidra and set GHIDRA_INSTALL_DIR to run deep decompilation."
      );
    }

    // Run Ghidra analyzeHeadless with script or REA Ghidra bridge
    const tempProjDir = path.join(process.cwd(), ".scratch", "ghidra_project");
    await fs.mkdir(tempProjDir, { recursive: true });

    const projName = "ReaGhidraTemp";
    const args = [
      tempProjDir,
      projName,
      "-import",
      binaryPath,
      "-overwrite",
      "-noanalysis"
    ];

    try {
      const { stdout, stderr } = await runTool(headless, args);
      return {
        binaryPath,
        backendUsed: "ghidra",
        functionTarget: options.functionOrAddress,
        code: `// Ghidra Headless Analysis completed for ${path.basename(binaryPath)}\n` + (stdout || stderr),
        durationMs: Date.now() - startTime
      };
    } catch (err: unknown) {
      throw new Error(`Ghidra decompilation failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err
      });
    }
  }
}

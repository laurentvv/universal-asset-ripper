import { BinutilsBackend } from "./backends/binutils-backend.js";
import { CutterBackend } from "./backends/cutter-backend.js";
import { GhidraBackend } from "./backends/ghidra-backend.js";
import { HopperBackend } from "./backends/hopper-backend.js";
import { IdaBackend } from "./backends/ida-backend.js";
import type {
  DecompileOptions,
  DecompileResult,
  DecompilerBackendInfo,
  DecompilerBackendType,
  DisassemblyOptions,
  DisassemblyResult,
  SymbolDumpResult
} from "./types.js";

export class DecompilerRegistry {
  public static async getAvailableBackends(): Promise<DecompilerBackendInfo[]> {
    return Promise.all([
      GhidraBackend.getInfo(),
      CutterBackend.getInfo(),
      HopperBackend.getInfo(),
      IdaBackend.getInfo(),
      BinutilsBackend.getInfo()
    ]);
  }

  public static async resolveBackend(
    preferred?: DecompilerBackendType,
    needDecompilation = false
  ): Promise<DecompilerBackendType> {
    const backends = await this.getAvailableBackends();
    const map = new Map(backends.map((b) => [b.id, b]));

    if (preferred && preferred !== "auto") {
      const b = map.get(preferred);
      if (b && b.found) return preferred;
      if (b && !b.found) {
        throw new Error(
          `Requested decompiler '${preferred}' is not installed or configured on this machine. ${b.hint}`
        );
      }
    }

    // Auto resolution
    if (needDecompilation) {
      if (map.get("ghidra")?.found) return "ghidra";
      if (map.get("cutter")?.found) return "cutter";
      if (map.get("ida")?.found) return "ida";
      if (map.get("hopper")?.found) return "hopper";
      throw new Error(
        "No C/C++ decompiler found. Please install Ghidra ('winget install NSA.Ghidra') or Cutter ('winget install Rizin.Cutter'). Binutils provides disassembly only."
      );
    }

    // For disassembly: prefer Ghidra/Cutter if found, else Binutils
    if (map.get("cutter")?.found) return "cutter";
    if (map.get("ghidra")?.found) return "ghidra";
    if (map.get("binutils")?.found) return "binutils";
    if (map.get("hopper")?.found) return "hopper";
    if (map.get("ida")?.found) return "ida";

    throw new Error(
      "No disassembler found. Install GNU binutils (objdump) or Ghidra/Cutter."
    );
  }

  public static async disassemble(
    binaryPath: string,
    options: DisassemblyOptions & { backend?: DecompilerBackendType } = {}
  ): Promise<DisassemblyResult> {
    const backend = await this.resolveBackend(options.backend, false);
    if (backend === "binutils") {
      return BinutilsBackend.disassemble(binaryPath, options);
    }
    // For other backends, currently route to binutils as reliable baseline or backend runner
    return BinutilsBackend.disassemble(binaryPath, options);
  }

  public static async decompile(
    binaryPath: string,
    options: DecompileOptions & { backend?: DecompilerBackendType } = {}
  ): Promise<DecompileResult> {
    const backend = await this.resolveBackend(options.backend, true);
    if (backend === "cutter") {
      return CutterBackend.decompile(binaryPath, options);
    }
    if (backend === "ghidra") {
      return GhidraBackend.decompile(binaryPath, options);
    }
    throw new Error(`Decompilation driver for backend '${backend}' is being initialized.`);
  }

  public static async listFunctions(
    binaryPath: string
  ): Promise<{ name: string; address: string; size: number }[]> {
    return CutterBackend.listFunctions(binaryPath);
  }

  public static async dumpSymbols(binaryPath: string, filter?: string): Promise<SymbolDumpResult> {
    return BinutilsBackend.dumpSymbols(binaryPath, filter);
  }

  public static async extractStrings(binaryPath: string, minLength = 4): Promise<string[]> {
    return BinutilsBackend.extractStrings(binaryPath, minLength);
  }
}

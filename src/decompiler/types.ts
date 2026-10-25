/**
 * Supported decompiler and disassembler backends.
 */
export type DecompilerBackendType = "ghidra" | "cutter" | "hopper" | "ida" | "binutils" | "auto";

export interface DecompilerCapabilities {
  disassembly: boolean;
  decompilation: boolean;
  controlFlowGraph: boolean;
  symbols: boolean;
  strings: boolean;
  demangle: boolean;
  crossReferences: boolean;
}

export interface DecompilerBackendInfo {
  id: DecompilerBackendType;
  name: string;
  found: boolean;
  executablePath?: string;
  version?: string;
  capabilities: DecompilerCapabilities;
  hint: string;
}

export interface DisassemblyOptions {
  functionOrAddress?: string;
  count?: number;
  syntax?: "intel" | "att";
  demangle?: boolean;
}

export interface DisassembledInstruction {
  address: string;
  bytes?: string;
  mnemonic: string;
  operands?: string;
  comment?: string;
}

export interface DisassemblyResult {
  binaryPath: string;
  backendUsed: DecompilerBackendType;
  target?: string;
  instructions: DisassembledInstruction[];
  rawText: string;
}

export interface DecompileOptions {
  functionOrAddress?: string;
  outputFormat?: "c" | "pseudo" | "json";
  timeoutSeconds?: number;
  timeoutMs?: number;
}

export interface DecompileResult {
  binaryPath: string;
  backendUsed: DecompilerBackendType;
  functionTarget?: string;
  code: string;
  durationMs: number;
  warnings?: string[];
}

export interface BinarySymbol {
  name: string;
  address: string;
  kind: "function" | "data" | "import" | "export" | "unknown";
  section?: string;
  demangled?: string;
}

export interface SymbolDumpResult {
  binaryPath: string;
  backendUsed: DecompilerBackendType;
  symbols: BinarySymbol[];
  totalCount: number;
}

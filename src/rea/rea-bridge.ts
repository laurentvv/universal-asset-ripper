import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BinaryScanner, type ScanOptions } from "./binary-scanner.js";
import type { PakKeyValidation } from "../parsers/unreal/pak-index.js";
import { runTool } from "../utils/exec.js";
import type { BinaryScanResult } from "../types/index.js";

export interface ReaEvidenceBundle {
  targetBinary: string;
  architecture: string;
  evidenceType: "GameBinaryAnalysis";
  timestamp: string;
  findings: {
    candidateAesKeys: Array<{
      key: string;
      offset: number;
      confidence: string;
      pattern: string;
      occurrences?: number;
      /** true = opens the supplied pak, false = rejected, null = could not be proven; absent without --pak */
      verified?: boolean | null;
      verification?: string;
    }>;
    /** Honest candidate accounting: the list above can be shorter than the total */
    candidateTotal: number;
    candidatesShown: number;
    verifiedAgainst?: string;
    il2cppVersion?: number;
    signatures: string[];
  };
  reaTaskPrompt: string;
}

export class ReaBridge {
  /**
   * Locate local vendored REA script if present
   */
  static getLocalReaScriptPath(): string | null {
    try {
      const candidates = [
        path.resolve(process.cwd(), "rea", "scripts", "rea.mjs"),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "rea", "scripts", "rea.mjs")
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          return c;
        }
      }
    } catch {
      // Fallback if import.meta.url or path resolution fails
    }
    return null;
  }

  /**
   * Check if REA CLI is installed in environment or available via local repo runtime
   */
  static async isReaAvailable(preferLocal = false): Promise<boolean> {
    const localScript = this.getLocalReaScriptPath();

    if (preferLocal && localScript) {
      try {
        await runTool("node", [localScript, "--version"]);
        return true;
      } catch {
        // Fall back to CLI
      }
    }

    try {
      await runTool("rea", ["--version"]);
      return true;
    } catch {
      // Check local if not already checked
    }

    if (!preferLocal && localScript) {
      try {
        await runTool("node", [localScript, "--version"]);
        return true;
      } catch {
        // Local script runtime not built
      }
    }

    return false;
  }

  /**
   * Run binary inspection and generate REA evidence bundle
   */
  static async inspectBinary(
    binaryPath: string,
    options: ScanOptions = {}
  ): Promise<{
    scan: BinaryScanResult;
    bundle: ReaEvidenceBundle;
  }> {
    const scan = await BinaryScanner.scanBinary(binaryPath, options);
    const verifiedKeys = scan.candidateAesKeys.filter((k) => k.verified === true);

    const reaPrompt = [
      `Target: ${path.basename(binaryPath)} (${scan.arch})`,
      verifiedKeys.length > 0
        ? `Verified AES keys (open ${path.basename(scan.verifiedAgainst ?? "the pak")}): ${verifiedKeys.map((k) => k.keyHex).join(", ")}`
        : scan.candidateAesKeys.length > 0
          ? `Candidate AES keys detected (${scan.candidateTotal} candidates, showing ${scan.candidatesShown}): ${scan.candidateAesKeys.map((k) => k.keyHex).join(", ")}`
          : "No direct AES keys in plaintext; trace FAES::Decrypt via Ghidra or hook dynamically with Frida.",
      scan.il2cppMetadata
        ? `IL2CPP metadata detected (version ${scan.il2cppMetadata.version}). Reconstruct CIL bytecode with Cpp2IL or trace il2cpp_init.`
        : "Standard native binary.",
      "Objective: Confirm decryption keys / recovery offsets.",
      "Methodology: Separate findings into [Confirmed Facts], [Inferences], and [Unknowns]. Cite offsets/functions for evidence."
    ].join("\n");

    const bundle: ReaEvidenceBundle = {
      targetBinary: binaryPath,
      architecture: scan.arch,
      evidenceType: "GameBinaryAnalysis",
      timestamp: new Date().toISOString(),
      findings: {
        candidateAesKeys: scan.candidateAesKeys.map((k) => ({
          key: k.keyHex,
          offset: k.offset,
          confidence: k.confidence,
          pattern: k.pattern,
          ...(k.occurrences !== undefined ? { occurrences: k.occurrences } : {}),
          ...(k.verified !== undefined ? { verified: k.verified } : {}),
          ...(k.verification !== undefined ? { verification: k.verification } : {})
        })),
        candidateTotal: scan.candidateTotal,
        candidatesShown: scan.candidatesShown,
        ...(scan.verifiedAgainst ? { verifiedAgainst: scan.verifiedAgainst } : {}),
        il2cppVersion: scan.il2cppMetadata?.version,
        signatures: scan.stringsFound
      },
      reaTaskPrompt: reaPrompt
    };

    return { scan, bundle };
  }

  /**
   * Check a candidate AES key against an Unreal pak with the native index reader
   */
  static async validateKeyAgainstPak(pakPath: string, keyHex: string): Promise<PakKeyValidation> {
    return BinaryScanner.validateKeyAgainstPak(pakPath, keyHex);
  }

  /**
   * Execute REA CLI task if available (via global 'rea' or local './rea' runtime)
   */
  static async runReaTask(
    binaryPath: string,
    taskDescription?: string,
    options: { preferLocal?: boolean } = {}
  ): Promise<{ success: boolean; output: string }> {
    const task = taskDescription ?? "Extract AES encryption keys and analyze binary offsets";
    const localScript = this.getLocalReaScriptPath();

    // If preferLocal requested, try local script first
    if (options.preferLocal && localScript) {
      try {
        const { stdout, stderr } = await runTool("node", [localScript, "inspect", binaryPath, "--task", task]);
        return { success: true, output: stdout || stderr };
      } catch (err: unknown) {
        return { success: false, output: err instanceof Error ? err.message : String(err) };
      }
    }

    // Default: try global CLI 'rea'
    try {
      await runTool("rea", ["--version"]);
      const { stdout, stderr } = await runTool("rea", ["inspect", binaryPath, "--task", task]);
      return {
        success: true,
        output: stdout || stderr
      };
    } catch {
      // Fall back to local ./rea runtime if available
      if (localScript) {
        try {
          const { stdout, stderr } = await runTool("node", [localScript, "inspect", binaryPath, "--task", task]);
          return {
            success: true,
            output: stdout || stderr
          };
        } catch {
          return {
            success: false,
            output:
              "Local REA is present in ./rea, but its compiled runtime is missing. Run 'cd rea && npm ci && npm run build:cached' to build it, or install 'rea' globally."
          };
        }
      }

      return {
        success: false,
        output: "REA CLI ('rea') is not found in PATH. Install morluto/rea via 'npm install -g @morluto/rea' or build local ./rea."
      };
    }
  }
}

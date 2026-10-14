import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { BinaryScanner } from "./binary-scanner.js";
import type { BinaryScanResult } from "../types/index.js";

const execAsync = promisify(exec);

export interface ReaEvidenceBundle {
  targetBinary: string;
  architecture: string;
  evidenceType: "GameBinaryAnalysis";
  timestamp: string;
  findings: {
    candidateAesKeys: Array<{ key: string; offset: number; confidence: string }>;
    il2cppVersion?: number;
    signatures: string[];
  };
  reaTaskPrompt: string;
}

export class ReaBridge {
  /**
   * Check if REA CLI is installed in environment
   */
  static async isReaAvailable(): Promise<boolean> {
    try {
      await execAsync("rea --version");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run binary inspection and generate REA evidence bundle
   */
  static async inspectBinary(binaryPath: string): Promise<{
    scan: BinaryScanResult;
    bundle: ReaEvidenceBundle;
  }> {
    const scan = await BinaryScanner.scanBinary(binaryPath);

    const reaPrompt = [
      `Target: ${path.basename(binaryPath)} (${scan.arch})`,
      scan.candidateAesKeys.length > 0
        ? `Candidate AES keys detected: ${scan.candidateAesKeys.map((k) => k.keyHex).join(", ")}`
        : "No direct AES keys in plaintext; trace FAES::Decrypt via Ghidra or hook dynamically with Frida.",
      scan.il2cppMetadata
        ? `IL2CPP metadata detected (version ${scan.il2cppMetadata.version}). Reconstruct CIL bytecode with Cpp2IL or trace il2cpp_init.`
        : "Standard native binary.",
      "Objective: Confirm decryption keys / recovery offsets."
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
          confidence: k.confidence
        })),
        il2cppVersion: scan.il2cppMetadata?.version,
        signatures: scan.stringsFound
      },
      reaTaskPrompt: reaPrompt
    };

    return { scan, bundle };
  }

  /**
   * Execute REA CLI task if available
   */
  static async runReaTask(binaryPath: string, taskDescription?: string): Promise<{ success: boolean; output: string }> {
    const isAvail = await this.isReaAvailable();
    if (!isAvail) {
      return {
        success: false,
        output: "REA CLI ('rea') is not found in PATH. Install morluto/rea via 'npm install -g @morluto/rea' or run REA as an MCP server."
      };
    }

    try {
      const task = taskDescription ?? "Extract AES encryption keys and analyze binary offsets";
      const cmd = `rea inspect "${binaryPath}" --task "${task}"`;
      const { stdout, stderr } = await execAsync(cmd);
      return {
        success: true,
        output: stdout || stderr
      };
    } catch (err: unknown) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err)
      };
    }
  }
}

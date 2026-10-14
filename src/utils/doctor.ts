import { findAssetRipper } from "./assetripper.js";
import { runTool } from "./exec.js";

export interface DoctorCheck {
  name: string;
  found: boolean;
  required: boolean;
  version?: string;
  path?: string;
  hint?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

async function probeVersion(command: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await runTool(command, ["--version"]);
    const line = (stdout || stderr).trim().split(/\r?\n/)[0];
    return line && line.length > 0 ? line : "(version unknown)";
  } catch {
    return null;
  }
}

/** Check the Node.js version and the optional external tools; only Node.js >= 22 is required */
export async function runDoctor(env: NodeJS.ProcessEnv = process.env): Promise<DoctorReport> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const checks: DoctorCheck[] = [
    {
      name: "node",
      found: nodeMajor >= 22,
      required: true,
      version: process.versions.node,
      hint: "Node.js >= 22 is required"
    }
  ];

  const repak = await probeVersion("repak");
  checks.push({
    name: "repak",
    found: repak !== null,
    required: false,
    version: repak ?? undefined,
    hint: "Optional, needed for Oodle/Zlib Unreal paks: cargo install repak"
  });

  const assetRipper = await findAssetRipper(env);
  checks.push({
    name: "AssetRipper",
    found: assetRipper !== null,
    required: false,
    path: assetRipper ?? undefined,
    version: assetRipper ? "found" : undefined,
    hint: "Optional, needed for Unity export: set ASSETRIPPER_PATH or add it to PATH"
  });

  const rea = await probeVersion("rea");
  checks.push({
    name: "rea",
    found: rea !== null,
    required: false,
    version: rea ?? undefined,
    hint: "Optional, needed for binary inspection: npm install -g @morluto/rea"
  });

  return { ok: checks.filter((c) => c.required).every((c) => c.found), checks };
}

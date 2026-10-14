import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run an external tool without a shell: arguments are passed as an argv array,
 * so paths and keys are never interpreted by cmd.exe / sh.
 */
export async function runTool(
  file: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  return { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
}

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";

/**
 * Drive AssetRipper (https://github.com/AssetRipper/AssetRipper) through its headless web mode:
 * the GUI build is started with `--headless --port <free port>`, the game is loaded with a form
 * POST to /LoadFolder (or /LoadFile), exported with POST /Export/UnityProject, and the process is
 * shut down again. There is no AssetRipper.Cli.
 */

const WINDOWS = process.platform === "win32";
export const ASSETRIPPER_EXECUTABLES = WINDOWS
  ? ["AssetRipper.GUI.Free.exe", "AssetRipper.exe"]
  : ["AssetRipper.GUI.Free", "AssetRipper"];

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_LOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_EXPORT_TIMEOUT_MS = 60 * 60_000;
const SHUTDOWN_GRACE_MS = 5_000;
const OUTPUT_TAIL_BYTES = 4096;

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the AssetRipper executable: ASSETRIPPER_PATH (a file, or a folder containing it) first,
 * then every PATH entry. Returns null when it is not installed.
 */
export async function findAssetRipper(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.ASSETRIPPER_PATH?.trim();
  if (configured) {
    try {
      const stat = await fs.stat(configured);
      if (stat.isFile()) return configured;
      if (stat.isDirectory()) {
        for (const name of ASSETRIPPER_EXECUTABLES) {
          const candidate = path.join(configured, name);
          if (await isFile(candidate)) return candidate;
        }
      }
    } catch {
      // Configured path is wrong: fall through to PATH
    }
  }

  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(path.delimiter).filter((d) => d.length > 0)) {
    for (const name of ASSETRIPPER_EXECUTABLES) {
      const candidate = path.join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Ask the OS for a free TCP port on the loopback interface
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("Could not allocate a free port."))));
    });
  });
}

export interface AssetRipperRunOptions {
  /** AssetRipper.GUI.Free(.exe) / AssetRipper(.exe) */
  executable: string;
  /** Game folder (LoadFolder) or a single file (LoadFile) */
  targetPath: string;
  /** Directory the Unity project is exported to */
  outputDir: string;
  /** Extra arguments placed before --headless (mostly for tests: a script path when executable is node) */
  prefixArgs?: string[];
  startupTimeoutMs?: number;
  loadTimeoutMs?: number;
  exportTimeoutMs?: number;
}

class OutputTail {
  private text = "";
  push(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
  }
  toString(): string {
    return this.text.trim();
  }
}

function describeFailure(what: string, tail: OutputTail): string {
  const out = tail.toString();
  return out ? `${what}\nAssetRipper output:\n${out}` : what;
}

async function waitForServer(
  port: number,
  child: ChildProcess,
  exited: Promise<string>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let earlyExit: string | undefined;
  void exited.then((reason) => {
    earlyExit = reason;
  });

  while (Date.now() < deadline) {
    if (earlyExit) throw new Error(`AssetRipper exited before its web server was ready (${earlyExit}).`);
    try {
      // Any HTTP answer means the server is up
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`AssetRipper did not start its web server on port ${port} within ${Math.round(timeoutMs / 1000)}s.`);
}

async function postForm(url: string, fields: Record<string, string>, timeoutMs: number, what: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err: unknown) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(
      timedOut
        ? `${what} timed out after ${Math.round(timeoutMs / 1000)}s.`
        : `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
  // 2xx and redirects (AssetRipper answers form posts with a redirect) are success
  if (res.status >= 400) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`${what} failed: HTTP ${res.status}${body ? ` - ${body}` : ""}`);
  }
  await res.arrayBuffer().catch(() => undefined);
}

/** Stop the process: polite kill first, forced kill if it lingers. Resolves once it is gone. */
async function shutdown(child: ChildProcess, exited: Promise<string>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS).unref());
  if ((await Promise.race([exited, timer])) === "timeout") {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS).unref())]);
  }
}

/**
 * Run one headless AssetRipper session: start, load, export, shut down. Always stops the process,
 * also when loading or exporting fails or times out.
 */
export async function runAssetRipperHeadless(options: AssetRipperRunOptions): Promise<void> {
  const targetStat = await fs.stat(options.targetPath);
  // A Unity game executable stands for its folder
  const isExe = targetStat.isFile() && path.extname(options.targetPath).toLowerCase() === ".exe";
  const loadTarget = isExe ? path.dirname(options.targetPath) : options.targetPath;
  const loadAsFolder = isExe || targetStat.isDirectory();

  const port = await getFreePort();
  const tail = new OutputTail();
  const child = spawn(options.executable, [...(options.prefixArgs ?? []), "--headless", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout?.on("data", (d) => tail.push(d));
  child.stderr?.on("data", (d) => tail.push(d));

  const exited = new Promise<string>((resolve) => {
    child.once("error", (err) => resolve(`failed to start: ${err.message}`));
    child.once("exit", (code, signal) => resolve(signal ? `signal ${signal}` : `exit code ${code}`));
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    try {
      await waitForServer(port, child, exited, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    } catch (err: unknown) {
      throw new Error(describeFailure(err instanceof Error ? err.message : String(err), tail), { cause: err });
    }

    try {
      await fs.mkdir(options.outputDir, { recursive: true });
      await postForm(
        `${base}/${loadAsFolder ? "LoadFolder" : "LoadFile"}`,
        { Path: loadTarget },
        options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
        loadAsFolder ? "Loading the game folder" : "Loading the game file"
      );
      await postForm(
        `${base}/Export/UnityProject`,
        { Path: options.outputDir },
        options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
        "Exporting the Unity project"
      );
    } catch (err: unknown) {
      throw new Error(describeFailure(err instanceof Error ? err.message : String(err), tail), { cause: err });
    }
  } finally {
    await shutdown(child, exited);
  }
}

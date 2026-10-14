import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Record every spawned process; `exec` is intentionally missing from the mock so any
// remaining shell-string call would blow up. An "unpack" call drops one file in its -o dir.
const spawned = vi.hoisted(() => [] as Array<{ file: string; args: string[] }>);

vi.mock("node:child_process", () => ({
  execFile: (file: string, args: string[], _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
    spawned.push({ file, args });
    const outIdx = args.indexOf("-o");
    if (args.includes("unpack") && outIdx >= 0) {
      fsSync.mkdirSync(args[outIdx + 1], { recursive: true });
      fsSync.writeFileSync(path.join(args[outIdx + 1], `file${spawned.length}.uasset`), "x");
    }
    cb(null, { stdout: args.includes("list") ? "a.uasset\nb.uasset\n" : "", stderr: "" });
  }
}));

import { UnrealAdapter } from "../src/adapters/unreal-adapter.js";
import { ReaBridge } from "../src/rea/rea-bridge.js";

const EVIL_KEY = 'x" & echo hi > marker & "';

describe("external tools are spawned without a shell", () => {
  let tmpDir: string;

  beforeEach(async () => {
    spawned.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exec-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes the AES key to repak as one argv entry, before the subcommand", async () => {
    const pak = path.join(tmpDir, "Game-WindowsNoEditor.pak");
    await fs.writeFile(pak, "pak");
    const outDir = path.join(tmpDir, "out dir");

    const result = await new UnrealAdapter().extract(pak, { outputDir: outDir, aesKey: EVIL_KEY });

    const unpack = spawned.find((c) => c.args.includes("unpack"));
    expect(unpack?.file).toBe("repak");
    expect(unpack?.args).toEqual(["--aes-key", EVIL_KEY, "unpack", pak, "-o", outDir]);
    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1); // counted from files actually written
    await expect(fs.access(path.join(process.cwd(), "marker"))).rejects.toThrow();
  });

  it("reports .utoc/.ucas as explicitly unsupported", async () => {
    await fs.writeFile(path.join(tmpDir, "global.utoc"), "toc");
    await fs.writeFile(path.join(tmpDir, "global.ucas"), "cas");

    const result = await new UnrealAdapter().extract(tmpDir, { outputDir: path.join(tmpDir, "out") });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.every((e) => /unsupported/i.test(e.error))).toBe(true);
    expect(spawned.some((c) => c.args.includes("unpack"))).toBe(false);
  });

  it("dry-run lists with repak and never creates the output directory", async () => {
    const pak = path.join(tmpDir, "a.pak");
    await fs.writeFile(pak, "pak");
    const outDir = path.join(tmpDir, "out");

    const result = await new UnrealAdapter().extract(pak, { outputDir: outDir, dryRun: true, aesKey: EVIL_KEY });

    expect(result.extractedCount).toBe(2);
    expect(spawned.some((c) => c.args.includes("unpack"))).toBe(false);
    await expect(fs.access(outDir)).rejects.toThrow();
  });

  it("passes paths to REA as argv entries", async () => {
    await ReaBridge.runReaTask('bin"; calc; "', 'task "q" & echo hi');
    const rea = spawned.find((c) => c.file === "rea" && c.args[0] === "inspect");
    expect(rea?.args).toEqual(["inspect", 'bin"; calc; "', "--task", 'task "q" & echo hi']);
  });
});

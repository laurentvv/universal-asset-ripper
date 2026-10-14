import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Any spawn of the fake "AssetRipper.GUI.Free.exe" is redirected to the fake node script,
// which behaves like AssetRipper's headless web server. Other spawns are untouched.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("./helpers/fake-assetripper.mjs", import.meta.url));
  return {
    ...actual,
    spawn: (file: string, args: string[], opts: import("node:child_process").SpawnOptions) =>
      file.endsWith("AssetRipper.GUI.Free.exe")
        ? actual.spawn(process.execPath, [script, ...args], opts)
        : actual.spawn(file, args, opts)
  };
});

import { findAssetRipper, runAssetRipperHeadless } from "../src/utils/assetripper.js";
import { UnityAdapter } from "../src/adapters/unity-adapter.js";

const FAKE_SCRIPT = path.resolve("tests/helpers/fake-assetripper.mjs");

interface LogLine {
  event: string;
  args?: string[];
  pid?: number;
  method?: string;
  url?: string;
  contentType?: string;
  form?: Record<string, string>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("AssetRipper headless web mode", () => {
  let tmpDir: string;
  let logFile: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assetripper-"));
    logFile = path.join(tmpDir, "log.jsonl");
    process.env.FAKE_AR_LOG = logFile;
    delete process.env.FAKE_AR_MODE;
  });

  afterEach(async () => {
    process.env = { ...saved };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function readLog(): Promise<LogLine[]> {
    const text = await fs.readFile(logFile, "utf-8").catch(() => "");
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogLine);
  }

  async function expectProcessGone(): Promise<void> {
    const start = (await readLog()).find((l) => l.event === "start")!;
    expect(start.pid).toBeGreaterThan(0);
    for (let i = 0; i < 40 && isAlive(start.pid!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(isAlive(start.pid!)).toBe(false);
  }

  function run(target: string, out: string, extra: Partial<Parameters<typeof runAssetRipperHeadless>[0]> = {}) {
    return runAssetRipperHeadless({
      executable: process.execPath,
      prefixArgs: [FAKE_SCRIPT],
      targetPath: target,
      outputDir: out,
      ...extra
    });
  }

  it("starts with --headless --port, posts Path to /LoadFolder and /Export/UnityProject, then kills the process", async () => {
    const game = path.join(tmpDir, "Game");
    await fs.mkdir(game);
    const out = path.join(tmpDir, "out");

    await run(game, out);

    const log = await readLog();
    const start = log.find((l) => l.event === "start")!;
    const portIdx = start.args!.indexOf("--port");
    expect(start.args).toContain("--headless");
    expect(Number(start.args![portIdx + 1])).toBeGreaterThan(1023);

    const posts = log.filter((l) => l.event === "request" && l.method === "POST");
    expect(posts.map((p) => p.url)).toEqual(["/LoadFolder", "/Export/UnityProject"]);
    expect(posts[0].form).toEqual({ Path: game });
    expect(posts[1].form).toEqual({ Path: out });
    expect(posts[0].contentType).toContain("application/x-www-form-urlencoded");
    expect(log.some((l) => l.event === "request" && l.method === "GET")).toBe(true);

    expect(await fs.readFile(path.join(out, "ExportedProject", "Assets", "hello.txt"), "utf-8")).toBe("hi");
    await expectProcessGone();
  });

  it("uses /LoadFile for a single file and the folder for a game executable", async () => {
    const file = path.join(tmpDir, "data.unity3d");
    await fs.writeFile(file, "x");
    await run(file, path.join(tmpDir, "out1"));
    let posts = (await readLog()).filter((l) => l.event === "request" && l.method === "POST");
    expect(posts[0]).toMatchObject({ url: "/LoadFile", form: { Path: file } });

    await fs.rm(logFile);
    const exe = path.join(tmpDir, "Game.exe");
    await fs.writeFile(exe, "x");
    await run(exe, path.join(tmpDir, "out2"));
    posts = (await readLog()).filter((l) => l.event === "request" && l.method === "POST");
    expect(posts[0]).toMatchObject({ url: "/LoadFolder", form: { Path: tmpDir } });
  });

  it("times out when the web server never comes up, and still kills the process", async () => {
    process.env.FAKE_AR_MODE = "never-listen";
    const game = path.join(tmpDir, "Game");
    await fs.mkdir(game);
    await expect(run(game, path.join(tmpDir, "out"), { startupTimeoutMs: 600 })).rejects.toThrow(/did not start its web server/);
    await expectProcessGone();
  });

  it("reports an early exit with the process output", async () => {
    process.env.FAKE_AR_MODE = "exit-early";
    const game = path.join(tmpDir, "Game");
    await fs.mkdir(game);
    const err = await run(game, path.join(tmpDir, "out"), { startupTimeoutMs: 5000 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited before its web server was ready/);
    expect((err as Error).message).toContain("boom: cannot start the web server");
  });

  it("reports an HTTP error from the export and shuts the process down", async () => {
    process.env.FAKE_AR_MODE = "export-500";
    const game = path.join(tmpDir, "Game");
    await fs.mkdir(game);
    await expect(run(game, path.join(tmpDir, "out"))).rejects.toThrow(/Exporting the Unity project failed: HTTP 500 - export exploded/);
    await expectProcessGone();
  });

  describe("findAssetRipper", () => {
    it("honours ASSETRIPPER_PATH as a file or as a folder, then PATH", async () => {
      const exeName = process.platform === "win32" ? "AssetRipper.GUI.Free.exe" : "AssetRipper.GUI.Free";
      const dir = path.join(tmpDir, "ar");
      await fs.mkdir(dir);
      const exe = path.join(dir, exeName);
      await fs.writeFile(exe, "x");

      expect(await findAssetRipper({ ASSETRIPPER_PATH: exe, PATH: "" })).toBe(exe);
      expect(await findAssetRipper({ ASSETRIPPER_PATH: dir, PATH: "" })).toBe(exe);
      expect(await findAssetRipper({ PATH: [path.join(tmpDir, "nope"), dir].join(path.delimiter) })).toBe(exe);
      expect(await findAssetRipper({ ASSETRIPPER_PATH: path.join(tmpDir, "missing"), PATH: "" })).toBeNull();
      expect(await findAssetRipper({ PATH: "" })).toBeNull();
    });
  });

  describe("UnityAdapter.extract", () => {
    it("exports through the headless server when ASSETRIPPER_PATH is set", async () => {
      const exe = path.join(tmpDir, "AssetRipper.GUI.Free.exe");
      await fs.writeFile(exe, "x");
      process.env.ASSETRIPPER_PATH = exe;
      const game = path.join(tmpDir, "Game");
      await fs.mkdir(path.join(game, "Game_Data"), { recursive: true });
      await fs.writeFile(path.join(game, "UnityPlayer.dll"), "x");
      const out = path.join(tmpDir, "out");

      const result = await new UnityAdapter().extract(game, { outputDir: out });

      expect(result).toMatchObject({ success: true, extractedCount: 2, errors: [] });
      const posts = (await readLog()).filter((l) => l.event === "request" && l.method === "POST");
      expect(posts.map((p) => p.url)).toEqual(["/LoadFolder", "/Export/UnityProject"]);
      await expectProcessGone();
    });

    it("surfaces export failures as errors", async () => {
      const exe = path.join(tmpDir, "AssetRipper.GUI.Free.exe");
      await fs.writeFile(exe, "x");
      process.env.ASSETRIPPER_PATH = exe;
      process.env.FAKE_AR_MODE = "export-500";
      const game = path.join(tmpDir, "Game");
      await fs.mkdir(game);

      const result = await new UnityAdapter().extract(game, { outputDir: path.join(tmpDir, "out") });
      expect(result.success).toBe(false);
      expect(result.errors[0].error).toContain("HTTP 500");
    });

    it("explains how to install AssetRipper without mentioning a CLI package", async () => {
      delete process.env.ASSETRIPPER_PATH;
      process.env.PATH = "";
      process.env.Path = "";
      const game = path.join(tmpDir, "Game");
      await fs.mkdir(game);

      const result = await new UnityAdapter().extract(game, { outputDir: path.join(tmpDir, "out") });
      expect(result.success).toBe(false);
      expect(result.errors[0].error).toContain("ASSETRIPPER_PATH");
      expect(result.errors[0].error).toContain("headless");
      expect(result.errors[0].error).not.toMatch(/dotnet tool install/);
    });
  });
});

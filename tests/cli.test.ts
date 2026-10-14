import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { GDPC_MAGIC } from "../src/parsers/godot/pck-parser.js";

const execAsync = promisify(exec);

describe("CLI commands", () => {
  let tmpDir: string;
  let cliPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-test-"));
    cliPath = path.resolve("./dist/cli/index.js");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should execute 'ripper detect' successfully", async () => {
    const pckPath = path.join(tmpDir, "test.pck");
    const pckHeader = Buffer.alloc(32);
    pckHeader.writeUInt32LE(GDPC_MAGIC, 0);
    pckHeader.writeUInt32LE(1, 4);
    pckHeader.writeUInt32LE(4, 8);
    pckHeader.writeUInt32LE(0, 12);
    pckHeader.writeUInt32LE(0, 16);
    await fs.writeFile(pckPath, pckHeader);

    const { stdout } = await execAsync(`node "${cliPath}" detect "${pckPath}"`);
    expect(stdout).toContain("GODOT");
    expect(stdout).toContain("Engine Detection Results");
  });

  /** Run the CLI and return exit code + streams without throwing on non-zero exit */
  async function runCli(args: string): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execAsync(`node "${cliPath}" ${args}`);
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("should print pure JSON with --json for detect, inspect, extract and rea-inspect", async () => {
    const pck = path.resolve("tests/fixtures/godot/godot4-v4.pck");

    const detect = await runCli(`detect "${pck}" --json`);
    expect(detect.code).toBe(0);
    expect(JSON.parse(detect.stdout).engine).toBe("godot");

    const inspect = await runCli(`inspect "${pck}" --json`);
    expect(JSON.parse(inspect.stdout).totalFiles).toBe(13);

    const extract = await runCli(`extract "${pck}" -o "${path.join(tmpDir, "out")}" --dry-run --json`);
    expect(extract.code).toBe(0);
    expect(JSON.parse(extract.stdout)).toMatchObject({ success: true, extractedCount: 13 });

    const binPath = path.join(tmpDir, "test.exe");
    await fs.writeFile(binPath, Buffer.alloc(1024));
    const rea = await runCli(`rea-inspect "${binPath}" --json`);
    expect(JSON.parse(rea.stdout).scan.binaryPath).toBe(binPath);
  });

  it("should exit 1 on unknown --categories", async () => {
    const pck = path.resolve("tests/fixtures/godot/godot4-v4.pck");
    const res = await runCli(`extract "${pck}" -o "${path.join(tmpDir, "out")}" --categories texture,bogus`);
    expect(res.code).toBe(1);
    expect(res.stdout + res.stderr).toContain("bogus");
  });

  it("should exit 1 when extraction reports success=false", async () => {
    const utoc = path.join(tmpDir, "global.utoc");
    await fs.writeFile(utoc, Buffer.alloc(128));
    const res = await runCli(`extract "${utoc}" -o "${path.join(tmpDir, "out")}" --json`);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.stdout).success).toBe(false);
  });

  it("should execute 'ripper rea-inspect' on binary with AES key", async () => {
    const binPath = path.join(tmpDir, "test.exe");
    const buf = Buffer.alloc(1024);
    buf.write("0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff", 100, "ascii");
    await fs.writeFile(binPath, buf);

    const { stdout } = await execAsync(`node "${cliPath}" rea-inspect "${binPath}"`);
    expect(stdout).toContain("Candidate AES-256 Keys Discovered");
    expect(stdout).toContain("0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff");
  });
});

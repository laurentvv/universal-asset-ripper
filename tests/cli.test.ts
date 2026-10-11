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
    pckHeader.writeUInt32LE(4, 3);
    pckHeader.writeUInt32LE(0, 12);
    pckHeader.writeUInt32LE(0, 16);
    await fs.writeFile(pckPath, pckHeader);

    const { stdout } = await execAsync(`node "${cliPath}" detect "${pckPath}"`);
    expect(stdout).toContain("GODOT");
    expect(stdout).toContain("Engine Detection Results");
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

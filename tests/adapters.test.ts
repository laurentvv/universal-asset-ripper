import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AdapterRegistry } from "../src/adapters/index.js";
import { GDPC_MAGIC } from "../src/parsers/godot/pck-parser.js";

describe("AdapterRegistry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should get registered adapters by engine type", () => {
    const godot = AdapterRegistry.getAdapter("godot");
    const unreal = AdapterRegistry.getAdapter("unreal");
    const unity = AdapterRegistry.getAdapter("unity");

    expect(godot?.engine).toBe("godot");
    expect(unreal?.engine).toBe("unreal");
    expect(unity?.engine).toBe("unity");
  });

  it("should resolve adapter automatically for Godot target", async () => {
    const pckPath = path.join(tmpDir, "game.pck");
    const pckHeader = Buffer.alloc(32);
    pckHeader.writeUInt32LE(GDPC_MAGIC, 0);
    pckHeader.writeUInt32LE(1, 4);
    pckHeader.writeUInt32LE(4, 8);
    pckHeader.writeUInt32LE(1, 12);
    pckHeader.writeUInt32LE(0, 16);
    await fs.writeFile(pckPath, pckHeader);

    const { adapter, engine } = await AdapterRegistry.resolveAdapter(pckPath);
    expect(engine).toBe("godot");
    expect(adapter.engine).toBe("godot");
  });
});

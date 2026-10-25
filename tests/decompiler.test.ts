import { describe, it, expect } from "vitest";
import { DecompilerRegistry } from "../src/decompiler/decompiler-registry.js";
import { BinutilsBackend } from "../src/decompiler/backends/binutils-backend.js";

describe("Decompiler Registry & Engines", { timeout: 15000 }, () => {
  it("discovers all 5 backends with metadata and capabilities", async () => {
    const backends = await DecompilerRegistry.getAvailableBackends();
    expect(backends.length).toBe(5);
    const ids = backends.map((b) => b.id);
    expect(ids).toContain("ghidra");
    expect(ids).toContain("cutter");
    expect(ids).toContain("hopper");
    expect(ids).toContain("ida");
    expect(ids).toContain("binutils");

    const binutils = backends.find((b) => b.id === "binutils")!;
    expect(binutils.capabilities.disassembly).toBe(true);
    expect(binutils.capabilities.symbols).toBe(true);
  });

  it("resolves available backend automatically", async () => {
    const backend = await DecompilerRegistry.resolveBackend("auto", false);
    expect(["binutils", "ghidra", "cutter"]).toContain(backend);
  });

  it("fails gracefully when requesting an uninstalled decompiler", async () => {
    const backends = await DecompilerRegistry.getAvailableBackends();
    const missing = backends.find((b) => !b.found);
    if (missing) {
      await expect(DecompilerRegistry.resolveBackend(missing.id, false)).rejects.toThrow(
        /not installed or configured/
      );
    }
  });

  it("disassembles a binary using BinutilsBackend", async () => {
    const binutilsInfo = await BinutilsBackend.getInfo();
    if (!binutilsInfo.found) return;

    // Use current node executable as test binary
    const nodeExe = process.execPath;
    const result = await BinutilsBackend.disassemble(nodeExe, { count: 5 });
    expect(result.backendUsed).toBe("binutils");
    expect(result.instructions.length).toBeGreaterThanOrEqual(1);
    expect(result.instructions[0].address).toMatch(/^0x[0-9a-fA-F]+/);
    expect(result.instructions[0].mnemonic).toBeDefined();
  });
});

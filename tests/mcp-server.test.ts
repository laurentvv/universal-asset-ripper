import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { callTool } from "../src/mcp/server.js";

function textOf(result: Awaited<ReturnType<typeof callTool>>): string {
  return result.content[0].text;
}

describe("MCP tool calls", () => {
  let tmpDir: string;
  const realPck = path.resolve("tests/fixtures/godot/godot4-v4.pck");

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns isError with a clear message for missing or non-string targetPath", async () => {
    for (const tool of ["ripper_detect", "ripper_inspect"]) {
      const missing = await callTool(tool, {});
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("'targetPath'");

      const wrongType = await callTool(tool, { targetPath: 42 });
      expect(wrongType.isError).toBe(true);
      expect(textOf(wrongType)).toContain("non-empty string");
    }
    expect((await callTool("ripper_extract", { targetPath: realPck })).isError).toBe(true);
    expect((await callTool("ripper_scan_binary", undefined)).isError).toBe(true);
  });

  it("rejects unknown categories and non-boolean dryRun", async () => {
    const badCat = await callTool("ripper_extract", {
      targetPath: realPck,
      outputDir: tmpDir,
      categories: ["texture", "bogus"]
    });
    expect(badCat.isError).toBe(true);
    expect(textOf(badCat)).toContain("bogus");

    const badDry = await callTool("ripper_extract", { targetPath: realPck, outputDir: tmpDir, dryRun: "yes" });
    expect(badDry.isError).toBe(true);
    expect(textOf(badDry)).toContain("dryRun");
  });

  it("supports dryRun without writing files", async () => {
    const outDir = path.join(tmpDir, "out");
    const res = await callTool("ripper_extract", { targetPath: realPck, outputDir: outDir, dryRun: true });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(res));
    expect(parsed.success).toBe(true);
    expect(parsed.extractedCount).toBe(13);
    await expect(fs.access(outDir)).rejects.toThrow();
  });

  it("truncates ripper_inspect assets to limit and keeps the totals", async () => {
    const res = await callTool("ripper_inspect", { targetPath: realPck, limit: 5 });
    const parsed = JSON.parse(textOf(res));
    expect(parsed.assets).toHaveLength(5);
    expect(parsed.assetsReturned).toBe(5);
    expect(parsed.assetsTruncated).toBe(true);
    expect(parsed.totalFiles).toBe(13);
    expect(parsed.totalBytes).toBeGreaterThan(0);

    const full = JSON.parse(textOf(await callTool("ripper_inspect", { targetPath: realPck })));
    expect(full.assets).toHaveLength(13);
    expect(full.assetsTruncated).toBe(false);

    const badLimit = await callTool("ripper_inspect", { targetPath: realPck, limit: -1 });
    expect(badLimit.isError).toBe(true);
  });
});

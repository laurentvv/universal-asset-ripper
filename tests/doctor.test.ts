import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { runDoctor } from "../src/utils/doctor.js";

const execAsync = promisify(exec);

describe("doctor", () => {
  it("reports node and optional tools", async () => {
    const report = await runDoctor({ PATH: "" });
    const names = report.checks.map((c) => c.name);
    expect(names).toEqual(["node", "repak", "AssetRipper", "rea"]);
    const node = report.checks[0];
    expect(node.found).toBe(true);
    expect(node.version).toBe(process.versions.node);
    expect(report.checks.find((c) => c.name === "AssetRipper")!.found).toBe(false);
    expect(report.ok).toBe(true);
  });

  it("'ripper doctor --json' prints a JSON report", async () => {
    const cli = path.resolve("./dist/cli/index.js");
    const { stdout } = await execAsync(`node "${cli}" doctor --json`);
    const parsed = JSON.parse(stdout);
    expect(parsed.checks[0].name).toBe("node");
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});

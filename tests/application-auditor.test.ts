import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { ApplicationAuditor } from "../src/pipeline/application-auditor.js";

describe("ApplicationAuditor Pipeline", { timeout: 15000 }, () => {
  it("audits a directory and returns an exhaustive application report", async () => {
    // Audit the current repository root as a test directory
    const repoRoot = path.resolve(".");
    const report = await ApplicationAuditor.auditDirectory(repoRoot, { maxDepth: 2 });

    expect(report.targetDirectory).toBe(repoRoot);
    expect(report.totalFiles).toBeGreaterThan(0);
    expect(report.timestamp).toBeDefined();
    expect(report.decompilationBackend).toBeDefined();
    expect(typeof report.decompilationEngineAvailable).toBe("boolean");
    expect(typeof report.summary.totalDisassembledInstructions).toBe("number");
    expect(typeof report.summary.totalDecompiledFunctions).toBe("number");
    expect(Array.isArray(report.configurationModels)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
  });

  it("generates markdown report content", async () => {
    const repoRoot = path.resolve(".");
    const report = await ApplicationAuditor.auditDirectory(repoRoot, { maxDepth: 1 });
    const md = ApplicationAuditor.generateMarkdownReport(report);

    expect(md).toContain("# Reverse Engineering Audit Report:");
    expect(md).toContain("Target Directory:");
    expect(md).toContain("Total Files:");
  });
});

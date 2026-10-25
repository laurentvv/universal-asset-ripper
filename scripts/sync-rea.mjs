#!/usr/bin/env node
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const UPSTREAM_URL = "https://github.com/morluto/rea.git";
const REPO_ROOT = process.cwd();
const REA_DIR = path.join(REPO_ROOT, "rea");
const ZCODE_SKILLS_DIR = path.join(REPO_ROOT, ".zcode", "skills");
const AGENTS_SKILLS_DIR = path.join(REPO_ROOT, ".agents", "skills");

function getLocalVersion() {
  const pkgPath = path.join(REA_DIR, "package.json");
  if (!fsSync.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
    return pkg.version || null;
  } catch {
    return null;
  }
}

async function getRemoteTags() {
  const { stdout } = await exec("git", ["ls-remote", "--tags", "--refs", UPSTREAM_URL]);
  const tags = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    const [sha, ref] = line.trim().split(/\s+/);
    const tagMatch = ref.replace("refs/tags/", "");
    // match rea-agents-X.Y.Z
    const verMatch = tagMatch.match(/^rea-agents-([0-9]+\.[0-9]+\.[0-9]+.*)$/);
    if (verMatch) {
      tags.push({ sha, tag: tagMatch, version: verMatch[1] });
    }
  }
  tags.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return tags;
}

async function copyDir(src, dest, ignoreList = [".git", "node_modules", ".cache"]) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoreList.includes(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, ignoreList);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function syncSkills(sourceSkillsDir) {
  if (!fsSync.existsSync(sourceSkillsDir)) return [];
  const entries = await fs.readdir(sourceSkillsDir, { withFileTypes: true });
  const synced = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillSrc = path.join(sourceSkillsDir, entry.name);
    // Copy to .zcode/skills
    const zcodeDest = path.join(ZCODE_SKILLS_DIR, entry.name);
    await copyDir(skillSrc, zcodeDest);

    // Copy to .agents/skills if the folder exists
    if (fsSync.existsSync(AGENTS_SKILLS_DIR)) {
      const agentsDest = path.join(AGENTS_SKILLS_DIR, entry.name);
      await copyDir(skillSrc, agentsDest);
    }
    synced.push(entry.name);
  }
  return synced;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const force = args.includes("--force");
  const refIndex = args.indexOf("--ref");
  const requestedRef = refIndex >= 0 ? args[refIndex + 1] : null;

  console.log("==> REA Upstream Sync Utility");
  const localVer = getLocalVersion();
  console.log(`Local vendored REA version : ${localVer || "not installed"}`);

  console.log(`Fetching tags from ${UPSTREAM_URL}...`);
  const tags = await getRemoteTags();
  if (tags.length === 0) {
    throw new Error("No release tags found in upstream repository.");
  }

  const latestTag = tags[0];
  console.log(`Latest upstream release    : ${latestTag.version} (${latestTag.tag}, sha: ${latestTag.sha.slice(0, 7)})`);

  const targetTag = requestedRef ? requestedRef : latestTag.tag;
  const targetVer = requestedRef ? requestedRef.replace(/^rea-agents-/, "") : latestTag.version;

  if (checkOnly) {
    if (localVer === latestTag.version) {
      console.log("\n[OK] Up-to-date: Local vendored REA matches the latest upstream release.");
    } else {
      console.log(`\n[UPDATE AVAILABLE] A newer version is available: ${localVer} -> ${latestTag.version}`);
      console.log("Run 'npm run sync:rea' to perform the update.");
    }
    return;
  }

  if (localVer === targetVer && !force) {
    console.log(`\n[OK] Local REA is already at version ${targetVer}. (Use --force to re-sync)`);
    return;
  }

  console.log(`\n==> Syncing REA to ref: ${targetTag}...`);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rea-sync-"));

  try {
    console.log(`Cloning shallowly into temporary staging area...`);
    await exec("git", ["clone", "--depth", "1", "--branch", targetTag, UPSTREAM_URL, tmpDir]);

    console.log(`Syncing files to ./rea...`);
    await copyDir(tmpDir, REA_DIR, [".git", "node_modules", ".cache"]);

    console.log(`Syncing agent skills to .zcode/skills/ and .agents/skills/...`);
    const upstreamSkills = path.join(tmpDir, ".agents", "skills");
    const syncedSkills = await syncSkills(upstreamSkills);
    console.log(`Synced ${syncedSkills.length} skills: ${syncedSkills.join(", ")}`);

    const newVer = getLocalVersion();
    console.log(`\n[SUCCESS] Successfully synced REA to version ${newVer}!`);
    console.log("Next steps:");
    console.log("  1. Run 'npm test' and 'npm run lint' to verify parent project compatibility.");
    console.log("  2. If building native local runtime, run: (cd rea && npm ci && npm run build:cached).");
    console.log("  3. Commit the changes to your branch.");
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore tmp cleanup error
    }
  }
}

main().catch((err) => {
  console.error("\n[ERROR] Sync failed:", err.message);
  process.exit(1);
});

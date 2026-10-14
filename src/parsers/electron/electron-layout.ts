import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Where an Electron application keeps its code and Chromium resources, relative to its folder
 * (Windows/Linux layout): resources/app.asar, app.asar next to the executable, resources.pak.
 */

async function exists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Existence-only check used by engine detection: returns the app archive and/or Chromium
 * resources.pak found directly in `dir`.
 */
export async function findElectronPayload(dir: string): Promise<{ asar?: string; resourcesPak?: string } | null> {
  const payload: { asar?: string; resourcesPak?: string } = {};
  for (const candidate of [path.join(dir, "resources", "app.asar"), path.join(dir, "app.asar")]) {
    if (await exists(candidate)) {
      payload.asar = candidate;
      break;
    }
  }
  for (const candidate of [path.join(dir, "resources.pak"), path.join(dir, "resources", "resources.pak")]) {
    if (await exists(candidate)) {
      payload.resourcesPak = candidate;
      break;
    }
  }
  return payload.asar || payload.resourcesPak ? payload : null;
}

/**
 * Candidate containers (.asar / .pak files) of an Electron folder: its root, resources/ and locales/.
 * Only a bounded set of folders is listed, never the (huge) unpacked node_modules tree.
 */
export async function listElectronContainers(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const sub of ["", "resources", "locales", path.join("resources", "locales")]) {
    const folder = path.join(dir, sub);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".asar") || lower.endsWith(".pak")) found.push(path.join(folder, entry.name));
    }
  }
  return found.sort();
}

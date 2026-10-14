import { UnityBundleParser } from "file:///C:/GIT/universal-asset-ripper/dist/parsers/unity/bundle-parser.js";
import * as fs from "node:fs/promises"; import * as path from "node:path";
const fsx = await import("node:fs");
// 1. UnityFS header: which version string is reported?
const sp = process.argv[2];
const hdr = Buffer.concat([Buffer.from("UnityFS\0"), Buffer.from([0,0,0,6]), Buffer.from("5.x.x\0"), Buffer.from("2021.3.16f1\0"), Buffer.alloc(64)]);
await fs.writeFile(`${sp}/t.unity3d`, hdr);
console.log("UnityFS 2021.3.16f1 ->", (await UnityBundleParser.readBundleInfo(`${sp}/t.unity3d`))?.engineVersion);
// 2. SerializedFile heuristic false positives on ordinary files
const dirs = ["C:/Windows/Fonts", "C:/Windows/Media", "C:/Windows/System32/drivers", "C:/Windows/Cursors", "C:/Windows/Web/Wallpaper/Windows", "C:/Program Files/Python313/Lib", "C:/Program Files/Python313/DLLs", "C:/Windows/System32/config"];
let total = 0, fp = [];
async function walk(d, depth) { let ents = []; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) { const p = path.join(d, e.name);
    if (e.isDirectory() && depth < 2) await walk(p, depth + 1);
    else if (e.isFile()) { const r = await UnityBundleParser.readBundleInfo(p); total++; if (r) fp.push(p + "  -> " + r.signature + " v" + r.formatVersion); } } }
for (const d of dirs) await walk(d, 0);
console.log(`files probed: ${total}, classified as Unity: ${fp.length}`); fp.slice(0, 8).forEach(x => console.log("  " + x));

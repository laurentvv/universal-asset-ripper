import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AsarParser } from "../src/parsers/electron/asar-parser.js";
import { ChromiumPakParser, guessResourceExtension } from "../src/parsers/electron/chromium-pak.js";
import { ElectronAdapter } from "../src/adapters/electron-adapter.js";
import { AdapterRegistry } from "../src/adapters/index.js";
import { EngineDetector } from "../src/core/detector/engine-detector.js";
import { buildAsar, buildChromiumPak } from "./helpers/electron-writers.js";
import { minimalPe } from "./helpers/minimal-pe.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);

describe("Electron: asar, Chromium pak, adapter and detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "electron-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const sampleAsar = () =>
    buildAsar({
      "package.json": JSON.stringify({ name: "demo-app", version: "1.2.3", main: "main.js" }),
      "main.js": "console.log('hi');",
      assets: { "logo.png": PNG, deep: { "style.css": "body{color:red}" } },
      native: { "addon.node": { unpacked: true, size: 5 } },
      "link.js": { link: "main.js" }
    });

  async function appFolder(): Promise<string> {
    const dir = path.join(tmpDir, "App");
    await fs.mkdir(path.join(dir, "resources", "app.asar.unpacked", "native"), { recursive: true });
    await fs.mkdir(path.join(dir, "locales"));
    await fs.writeFile(path.join(dir, "App.exe"), minimalPe());
    await fs.writeFile(path.join(dir, "resources", "app.asar"), sampleAsar());
    await fs.writeFile(path.join(dir, "resources", "app.asar.unpacked", "native", "addon.node"), "NATIV");
    await fs.writeFile(
      path.join(dir, "resources.pak"),
      buildChromiumPak({
        version: 5,
        resources: [
          { id: 101, data: "<!doctype html><html><body>hi</body></html>" },
          { id: 102, data: PNG },
          { id: 103, data: '{"a":1}' },
          { id: 104, data: Buffer.from([0, 1, 2, 3, 0, 255]) }
        ],
        aliases: [{ id: 150, of: 102 }]
      })
    );
    await fs.writeFile(path.join(dir, "locales", "en-US.pak"), buildChromiumPak({ version: 4, resources: [{ id: 5, data: "Hello" }] }));
    return dir;
  }

  describe("AsarParser", () => {
    it("reads the file tree, offsets and flags", async () => {
      const file = path.join(tmpDir, "a.asar");
      await fs.writeFile(file, sampleAsar());
      const archive = (await AsarParser.readArchive(file))!;
      expect(archive).not.toBeNull();
      expect(archive.entries.map((e) => e.path).sort()).toEqual(
        ["assets/deep/style.css", "assets/logo.png", "link.js", "main.js", "native/addon.node", "package.json"].sort()
      );
      expect(archive.entries.find((e) => e.path === "native/addon.node")).toMatchObject({ unpacked: true, size: 5, offset: -1 });
      expect(archive.entries.find((e) => e.path === "link.js")!.link).toBe("main.js");
      expect(await AsarParser.isAsar(file)).toBe(true);
    });

    it("extracts files (and unpacked ones) byte for byte and skips symlinks", async () => {
      const file = path.join(tmpDir, "app.asar");
      await fs.writeFile(file, sampleAsar());
      await fs.mkdir(path.join(`${file}.unpacked`, "native"), { recursive: true });
      await fs.writeFile(path.join(`${file}.unpacked`, "native", "addon.node"), "NATIV");
      const archive = (await AsarParser.readArchive(file))!;
      const out = path.join(tmpDir, "out");

      const res = await AsarParser.extractEntries(file, archive, archive.entries, out);
      expect(res.errors).toEqual([]);
      expect(res).toMatchObject({ extractedCount: 5, skippedLinks: 1 });
      expect((await fs.readFile(path.join(out, "assets", "logo.png"))).equals(PNG)).toBe(true);
      expect(await fs.readFile(path.join(out, "assets", "deep", "style.css"), "utf-8")).toBe("body{color:red}");
      expect(await fs.readFile(path.join(out, "native", "addon.node"), "utf-8")).toBe("NATIV");
      await expect(fs.access(path.join(out, "link.js"))).rejects.toThrow();
    });

    it("reports a missing .unpacked file and out-of-range data instead of crashing", async () => {
      const file = path.join(tmpDir, "app.asar");
      await fs.writeFile(file, sampleAsar());
      const archive = (await AsarParser.readArchive(file))!;
      const bad = { ...archive.entries.find((e) => e.path === "main.js")!, size: 10_000_000 };
      const res = await AsarParser.extractEntries(file, archive, [bad, archive.entries.find((e) => e.unpacked)!], path.join(tmpDir, "out"));
      expect(res.extractedCount).toBe(0);
      expect(res.errors.map((e) => e.error)).toEqual([
        expect.stringMatching(/beyond the end/),
        expect.stringMatching(/Unpacked file not found/)
      ]);
    });

    it("ignores header names that could escape the output directory", async () => {
      const file = path.join(tmpDir, "evil.asar");
      await fs.writeFile(
        file,
        buildAsar({}, {
          files: {
            "..": { files: { "x.txt": { size: 1, offset: "0" } } },
            "a\\..\\b.txt": { size: 1, offset: "0" },
            "/abs.txt": { size: 1, offset: "0" },
            "ok.txt": { size: 1, offset: "0" }
          }
        })
      );
      const archive = (await AsarParser.readArchive(file))!;
      expect(archive.entries.map((e) => e.path)).toEqual(["ok.txt"]);
      expect(archive.skippedUnsafe).toBe(3);
    });

    it("rejects files that are not asar archives", async () => {
      const p = path.join(tmpDir, "x.asar");
      await fs.writeFile(p, Buffer.alloc(200, 7));
      expect(await AsarParser.readArchive(p)).toBeNull();
      await fs.writeFile(p, "tiny");
      expect(await AsarParser.readArchive(p)).toBeNull();
    });
  });

  describe("ChromiumPakParser", () => {
    it.each([3, 4, 5] as const)("reads version %i resources", async (version) => {
      const file = path.join(tmpDir, `v${version}.pak`);
      await fs.writeFile(
        file,
        buildChromiumPak({
          version,
          resources: [
            { id: 1, data: "first" },
            { id: 7, data: PNG },
            { id: 9, data: "" }
          ]
        })
      );
      const pak = (await ChromiumPakParser.readPak(file))!;
      expect(pak.version).toBe(version);
      expect(pak.resources.map((r) => [r.id, r.size])).toEqual([
        [1, 5],
        [7, PNG.length],
        [9, 0]
      ]);
      const fh = await fs.open(file, "r");
      try {
        expect((await ChromiumPakParser.readResource(fh, pak.resources[1])).equals(PNG)).toBe(true);
      } finally {
        await fh.close();
      }
    });

    it("resolves v5 aliases to the data of the aliased resource", async () => {
      const file = path.join(tmpDir, "alias.pak");
      await fs.writeFile(file, buildChromiumPak({ version: 5, resources: [{ id: 1, data: "aaa" }, { id: 2, data: "bbbb" }], aliases: [{ id: 50, of: 2 }] }));
      const pak = (await ChromiumPakParser.readPak(file))!;
      expect(pak.resources).toHaveLength(3);
      expect(pak.resources[2]).toMatchObject({ id: 50, size: 4, aliasOf: 2 });
    });

    it("rejects data that is not a pack (e.g. Unreal pak footers or random bytes)", async () => {
      const file = path.join(tmpDir, "no.pak");
      await fs.writeFile(file, Buffer.alloc(4096, 3));
      expect(await ChromiumPakParser.readPak(file)).toBeNull();
      await fs.writeFile(file, "short");
      expect(await ChromiumPakParser.readPak(file)).toBeNull();
    });

    it("guesses extensions from magic numbers and text", () => {
      expect(guessResourceExtension(PNG)).toBe("png");
      expect(guessResourceExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe("jpg");
      expect(guessResourceExtension(Buffer.from("<!DOCTYPE html><html></html>"))).toBe("html");
      expect(guessResourceExtension(Buffer.from('{"k": [1, 2]}'))).toBe("json");
      expect(guessResourceExtension(Buffer.from("(function(){ var a = 1; })();"))).toBe("js");
      expect(guessResourceExtension(Buffer.from("body { color: red; }\n.a { margin: 0; }"))).toBe("css");
      expect(guessResourceExtension(Buffer.from("Just some words\nand lines"))).toBe("txt");
      expect(guessResourceExtension(Buffer.from([0, 1, 2, 3, 0, 255, 254]))).toBe("bin");
      expect(guessResourceExtension(Buffer.alloc(0))).toBe("bin");
    });
  });

  describe("ElectronAdapter", () => {
    it("inspects asar entries and Chromium resources with categories and the app name", async () => {
      const dir = await appFolder();
      const manifest = await new ElectronAdapter().inspect(dir);

      expect(manifest.engine).toBe("electron");
      expect(manifest.engineVersion).toBe("Electron app demo-app@1.2.3");
      const paths = manifest.assets.map((a) => a.path);
      expect(paths).toContain("main.js");
      expect(paths).toContain("assets/logo.png");
      expect(paths).toContain("resources/res_101.html");
      expect(paths).toContain("resources/res_102.png");
      expect(paths).toContain("resources/res_150.png"); // alias
      expect(paths).toContain("resources/res_103.json");
      expect(paths).toContain("resources/res_104.bin");
      expect(paths).toContain("locales/en-US/res_5.txt");
      expect(paths).not.toContain("link.js");
      expect(manifest.byCategory.script.count).toBe(1);
      expect(manifest.byCategory.texture.count).toBe(3); // logo.png + res_102 + alias
    });

    it("honours dryRun, categories and filter, and writes nothing on dryRun", async () => {
      const dir = await appFolder();
      const out = path.join(tmpDir, "out");
      const adapter = new ElectronAdapter();

      const dry = await adapter.extract(dir, { outputDir: out, dryRun: true, categories: ["texture"] });
      expect(dry).toMatchObject({ success: true, extractedCount: 3 });
      await expect(fs.access(out)).rejects.toThrow();

      const filtered = await adapter.extract(dir, { outputDir: out, filter: "res_10" });
      expect(filtered.errors).toEqual([]);
      expect(filtered.extractedCount).toBe(4);
      expect(await fs.readFile(path.join(out, "resources", "res_101.html"), "utf-8")).toContain("<body>hi</body>");
      await expect(fs.access(path.join(out, "main.js"))).rejects.toThrow();
    });

    it("extracts the whole application: code, unpacked native files and resources", async () => {
      const dir = await appFolder();
      const out = path.join(tmpDir, "out");
      const res = await new ElectronAdapter().extract(dir, { outputDir: out });

      expect(res.errors).toEqual([]);
      expect(res.success).toBe(true);
      expect(await fs.readFile(path.join(out, "main.js"), "utf-8")).toBe("console.log('hi');");
      expect((await fs.readFile(path.join(out, "resources", "res_102.png"))).equals(PNG)).toBe(true);
      expect((await fs.readFile(path.join(out, "resources", "res_150.png"))).equals(PNG)).toBe(true);
      expect(await fs.readFile(path.join(out, "native", "addon.node"), "utf-8")).toBe("NATIV");
      expect(await fs.readFile(path.join(out, "locales", "en-US", "res_5.txt"), "utf-8")).toBe("Hello");
    });

    it("works on a single app.asar and prefixes other archives with their name", async () => {
      const file = path.join(tmpDir, "app.asar");
      await fs.writeFile(file, buildAsar({ "main.js": "x" }));
      const manifest = await new ElectronAdapter().inspect(file);
      expect(manifest.assets.map((a) => a.path)).toEqual(["main.js"]);

      const other = path.join(tmpDir, "node_modules.asar");
      await fs.writeFile(other, buildAsar({ "lib.js": "y" }));
      expect((await new ElectronAdapter().inspect(other)).assets[0].path).toBe("node_modules/lib.js");
    });

    it("fails clearly when nothing readable is present", async () => {
      await expect(new ElectronAdapter().inspect(tmpDir)).rejects.toThrow(/No readable app.asar/);
      const res = await new ElectronAdapter().extract(tmpDir, { outputDir: path.join(tmpDir, "o") });
      expect(res.success).toBe(false);
    });
  });

  describe("detection and registry", () => {
    it("reports engine electron for a PE next to app.asar, keeping the PE framework info", async () => {
      const dir = await appFolder();
      const result = await EngineDetector.detect(dir);
      expect(result.engine).toBe("electron");
      expect(result.details.framework).toBe("Electron");
      expect(result.containerType).toBe("ASAR");
      expect(result.details.markersFound.some((m) => m.includes("app.asar"))).toBe(true);

      const { adapter, engine } = await AdapterRegistry.resolveAdapter(dir);
      expect(engine).toBe("electron");
      expect(adapter).toBeInstanceOf(ElectronAdapter);
    });

    it("detects the executable, the asar and a Chromium pack when given as single files", async () => {
      const dir = await appFolder();
      expect((await EngineDetector.detect(path.join(dir, "App.exe"))).engine).toBe("electron");
      expect((await EngineDetector.detect(path.join(dir, "resources", "app.asar"))).engine).toBe("electron");
      const pak = await EngineDetector.detect(path.join(dir, "resources.pak"));
      expect(pak.engine).toBe("electron");
      expect(pak.confidence).toBeLessThan(0.9);
    });

    it("detects a resources folder holding an app.asar without any executable", async () => {
      const dir = path.join(tmpDir, "resources");
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "app.asar"), buildAsar({ "main.js": "x" }));
      expect((await EngineDetector.detect(dir)).engine).toBe("electron");
    });

    it("keeps a plain PE without Electron payload as pe-software", async () => {
      const dir = path.join(tmpDir, "plain");
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "tool.exe"), minimalPe());
      expect((await EngineDetector.detect(dir)).engine).toBe("pe-software");
    });
  });
});

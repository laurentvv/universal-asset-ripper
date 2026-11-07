import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { UnrealAdapter } from "../src/adapters/unreal-adapter.js";
import { buildUtocFromFiles } from "./helpers/iostore-writer.js";
import { buildUnrealTexturePackage } from "./helpers/utexture-writer.js";

describe("UnrealAdapter with IoStore containers", () => {
  let tmp: string;
  const savedPath = process.env.PATH;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "unreal-adapter-"));
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeGame(withTexture: boolean): Promise<{ gameDir: string; utoc: string; ucas: string }> {
    const gameDir = path.join(tmp, "MyGame");
    await fs.mkdir(gameDir);
    const utoc = path.join(gameDir, "MyGame.utoc");
    const ucas = path.join(gameDir, "MyGame.ucas");

    if (withTexture) {
      // A texture package (uasset + uexp + ubulk) plus a plain file, packed as IoStore chunks
      const fx = buildUnrealTexturePackage({
        exportName: "T_Hero",
        pixelFormat: "PF_B8G8R8A8",
        width: 4,
        height: 4,
        mips: [
          { width: 4, height: 4, data: Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 7) % 256)), location: "ubulk" },
          { width: 2, height: 2, data: Buffer.alloc(16, 9), location: "inline" }
        ]
      });
      const payloads = [
        { path: "Game/T_Hero.uasset", data: fx.uasset, method: "none" as const },
        { path: "Game/T_Hero.uexp", data: fx.uexp, method: "zlib" as const },
        { path: "Game/T_Hero.ubulk", data: fx.ubulk!, method: "none" as const },
        { path: "Game/ReadMe.txt", data: Buffer.from("hello"), method: "none" as const }
      ];
      const { utoc: utocBuf, ucas: ucasBuf } = buildUtocFromFiles(payloads);
      await fs.writeFile(utoc, utocBuf);
      await fs.writeFile(ucas, ucasBuf);
      return { gameDir, utoc, ucas };
    }

    const { utoc: utocBuf, ucas: ucasBuf } = buildUtocFromFiles([{ path: "Game/hello.txt", data: Buffer.from("hi there"), method: "none" as const }]);
    await fs.writeFile(utoc, utocBuf);
    await fs.writeFile(ucas, ucasBuf);
    return { gameDir, utoc, ucas };
  }

  it("detects and inspects a .utoc/.ucas pair", async () => {
    const { gameDir } = await writeGame(false);
    const adapter = new UnrealAdapter();
    expect(await adapter.canHandle(gameDir)).toBe(true);
    expect(await adapter.canHandle(path.join(gameDir, "MyGame.utoc"))).toBe(true);

    const manifest = await adapter.inspect(gameDir);
    expect(manifest.engine).toBe("unreal");
    expect(manifest.engineVersion).toMatch(/IoStore v8/);
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.assets[0]).toMatchObject({ path: "Game/hello.txt", size: 8, encrypted: false });
    expect(manifest.assets[0]!.metadata.container).toBe("MyGame.utoc");
  });

  it("extracts an .utoc/.ucas pair natively (stored + zlib)", async () => {
    const { gameDir } = await writeGame(false);
    const adapter = new UnrealAdapter();
    const out = path.join(tmp, "out");
    const result = await adapter.extract(gameDir, { outputDir: out });
    expect(result.errors).toEqual([]);
    expect(result.extractedCount).toBe(1);
    await expect(fs.readFile(path.join(out, "Game", "hello.txt"), "utf-8")).resolves.toBe("hi there");
  });

  it("counts a dry run without writing", async () => {
    const { gameDir } = await writeGame(false);
    const adapter = new UnrealAdapter();
    const out = path.join(tmp, "out-dry");
    const result = await adapter.extract(gameDir, { outputDir: out, dryRun: true });
    expect(result.extractedCount).toBe(1);
    expect(result.success).toBe(true);
    const entries = await fs.readdir(out).catch(() => null);
    expect(entries).toBeNull();
  });

  it("decodes Texture2D packages to PNG with --convert, and leaves raw files without it", async () => {
    const { gameDir } = await writeGame(true);
    const adapter = new UnrealAdapter();

    const outRaw = path.join(tmp, "out-raw");
    const raw = await adapter.extract(gameDir, { outputDir: outRaw });
    expect(raw.errors).toEqual([]);
    expect(raw.extractedCount).toBe(4);
    await expect(fs.stat(path.join(outRaw, "Game", "T_Hero.uasset"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(outRaw, "Game", "T_Hero.png"))).rejects.toBeTruthy();

    const outConverted = path.join(tmp, "out-converted");
    const converted = await adapter.extract(gameDir, { outputDir: outConverted, convertFormats: true });
    expect(converted.errors).toEqual([]);
    // 4 extracted files + 1 derived PNG
    expect(converted.extractedCount).toBe(5);
    const png = await fs.readFile(path.join(outConverted, "Game", "T_Hero.png"));
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // The PNG is 4x4 RGBA (the .ubulk mip): IHDR width/height
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(4);
  });

  it("reports an orphan .ucas without its .utoc", async () => {
    const dir = path.join(tmp, "Orphan");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "Orphan.ucas"), Buffer.alloc(64, 1));
    const adapter = new UnrealAdapter();
    const manifest = await adapter.inspect(dir);
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.assets[0]!.metadata.containerType).toBe("UCAS");
    const result = await adapter.extract(dir, { outputDir: path.join(tmp, "out") });
    expect(result.extractedCount).toBe(0);
    expect(result.errors[0]!.error).toMatch(/without its .utoc/);
  });

  it("refuses a corrupted .utoc with a clear error", async () => {
    const { gameDir, utoc, ucas } = await writeGame(false);
    // Corrupt the TOC header size field
    const buf = await fs.readFile(utoc);
    buf.writeUInt32LE(999, 20);
    await fs.writeFile(utoc, buf);
    void ucas;
    const adapter = new UnrealAdapter();
    const result = await adapter.extract(gameDir, { outputDir: path.join(tmp, "out") });
    expect(result.extractedCount).toBe(0);
    expect(result.errors[0]!.error).toMatch(/999-byte TOC header/);
  });
});

describe("UnrealAdapter pak behavior is untouched by IoStore wiring", () => {
  it("still reports the classic error for unreadable paks", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "unreal-pak-"));
    try {
      await fs.writeFile(path.join(tmp, "not-a-pak.pak"), Buffer.alloc(200, 7));
      const adapter = new UnrealAdapter();
      const result = await adapter.extract(tmp, { outputDir: path.join(tmp, "out") });
      expect(result.extractedCount).toBe(0);
      expect(result.success).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

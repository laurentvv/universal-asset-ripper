import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { PeResourceParser } from "../src/parsers/pe/pe-resource-parser.js";
import {
  buildBmpFile,
  buildCursorFile,
  decodeStringBlock,
  decodeVersionInfo
} from "../src/parsers/pe/pe-resource-decoders.js";
import { convertBinaryDfmToText } from "../src/parsers/delphi/dfm-converter.js";
import { PeSoftwareAdapter } from "../src/adapters/pe-adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(here, "..", "examples", "treesize-clone", "assets");

interface TestResource {
  type: number;
  name: number | string;
  lang?: number;
  data: Buffer;
}

interface BuildPeOptions {
  resources?: TestResource[];
  /** Raw bytes appended after the PE image (to simulate strings inside the binary) */
  trailing?: Buffer;
  clr?: boolean;
}

/** Build a minimal PE32+ image with a real 3-level resource tree */
function buildPe(opts: BuildPeOptions = {}): Buffer {
  const resources = opts.resources ?? [];
  const SECTION_RVA = 0x1000;

  // Layout of the resource section
  const types = [...new Set(resources.map((r) => r.type))].sort((a, b) => a - b);
  let off = 16 + 8 * types.length;
  const typeOff = new Map<number, number>();
  const nameOff = new Map<string, number>();
  const namesOfType = new Map<number, Array<number | string>>();
  const langsOf = new Map<string, TestResource[]>();

  for (const r of resources) {
    const names = namesOfType.get(r.type) ?? [];
    if (!names.includes(r.name)) names.push(r.name);
    namesOfType.set(r.type, names);
    const key = `${r.type}|${r.name}`;
    langsOf.set(key, [...(langsOf.get(key) ?? []), r]);
  }
  for (const t of types) {
    typeOff.set(t, off);
    off += 16 + 8 * namesOfType.get(t)!.length;
    for (const n of namesOfType.get(t)!) {
      nameOff.set(`${t}|${n}`, off);
      off += 16 + 8 * langsOf.get(`${t}|${n}`)!.length;
    }
  }
  const entryOff = new Map<TestResource, number>();
  for (const r of resources) {
    entryOff.set(r, off);
    off += 16;
  }
  const strOff = new Map<string, number>();
  for (const r of resources) {
    if (typeof r.name === "string" && !strOff.has(r.name)) {
      strOff.set(r.name, off);
      off += (2 + r.name.length * 2 + 3) & ~3;
    }
  }
  const dataOff = new Map<TestResource, number>();
  for (const r of resources) {
    dataOff.set(r, off);
    off += (r.data.length + 3) & ~3;
  }

  const rsrc = Buffer.alloc(Math.max(off, 16));
  rsrc.writeUInt16LE(types.length, 14);
  types.forEach((t, i) => {
    rsrc.writeUInt32LE(t, 16 + i * 8);
    rsrc.writeUInt32LE(0x80000000 + typeOff.get(t)!, 20 + i * 8);
    const names = namesOfType.get(t)!;
    const tOff = typeOff.get(t)!;
    rsrc.writeUInt16LE(names.filter((n) => typeof n === "string").length, tOff + 12);
    rsrc.writeUInt16LE(names.filter((n) => typeof n === "number").length, tOff + 14);
    names.forEach((n, j) => {
      rsrc.writeUInt32LE(typeof n === "string" ? 0x80000000 + strOff.get(n)! : n, tOff + 16 + j * 8);
      rsrc.writeUInt32LE(0x80000000 + nameOff.get(`${t}|${n}`)!, tOff + 20 + j * 8);
      const nOff = nameOff.get(`${t}|${n}`)!;
      const langs = langsOf.get(`${t}|${n}`)!;
      rsrc.writeUInt16LE(langs.length, nOff + 14);
      langs.forEach((r, k) => {
        rsrc.writeUInt32LE(r.lang ?? 0, nOff + 16 + k * 8);
        rsrc.writeUInt32LE(entryOff.get(r)!, nOff + 20 + k * 8);
        const eOff = entryOff.get(r)!;
        rsrc.writeUInt32LE(SECTION_RVA + dataOff.get(r)!, eOff);
        rsrc.writeUInt32LE(r.data.length, eOff + 4);
        r.data.copy(rsrc, dataOff.get(r)!);
      });
    });
  });
  for (const [name, o] of strOff) {
    rsrc.writeUInt16LE(name.length, o);
    rsrc.write(name, o + 2, "utf16le");
  }

  const dos = Buffer.alloc(128);
  dos.writeUInt16LE(0x5a4d, 0);
  dos.writeInt32LE(128, 0x3c);

  const pe = Buffer.alloc(4 + 20 + 240);
  pe.writeUInt32LE(0x00004550, 0);
  pe.writeUInt16LE(0x8664, 4);
  pe.writeUInt16LE(1, 6);
  pe.writeUInt16LE(240, 20);
  pe.writeUInt16LE(0x020b, 24);
  pe.writeUInt32LE(SECTION_RVA, 136 + 2 * 8);
  pe.writeUInt32LE(rsrc.length, 136 + 2 * 8 + 4);
  if (opts.clr) pe.writeUInt32LE(0x3000, 136 + 14 * 8);

  const sec = Buffer.alloc(40);
  sec.write(".rsrc", 0, "ascii");
  sec.writeUInt32LE(rsrc.length, 8);
  sec.writeUInt32LE(SECTION_RVA, 12);
  sec.writeUInt32LE(rsrc.length, 16);
  sec.writeUInt32LE(128 + pe.length + sec.length, 20);

  // The parser rejects files smaller than 512 bytes
  const parts = [dos, pe, sec, rsrc, opts.trailing ?? Buffer.alloc(0)];
  const total = Buffer.concat(parts);
  return total.length >= 512 ? total : Buffer.concat([total, Buffer.alloc(512 - total.length)]);
}

/** BITMAPINFOHEADER-based DIB */
function makeDib(opts: { bpp: number; clrUsed?: number; compression?: number; w?: number; h?: number; pixels?: number }): Buffer {
  const w = opts.w ?? 4;
  const h = opts.h ?? 2;
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(w, 4);
  hdr.writeInt32LE(h, 8);
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(opts.bpp, 14);
  hdr.writeUInt32LE(opts.compression ?? 0, 16);
  hdr.writeUInt32LE(opts.clrUsed ?? 0, 32);
  return Buffer.concat([hdr, Buffer.alloc(opts.pixels ?? 16, 0xaa)]);
}

function utf16Block(strings: Record<number, string>): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < 16; i++) {
    const s = strings[i] ?? "";
    const len = Buffer.alloc(2);
    len.writeUInt16LE(s.length, 0);
    parts.push(len, Buffer.from(s, "utf16le"));
  }
  return Buffer.concat(parts);
}

describe("RT_BITMAP to .bmp (bfOffBits)", () => {
  it("accounts for the palette of 4bpp and 8bpp bitmaps", () => {
    const four = buildBmpFile(makeDib({ bpp: 4 }));
    expect(four.readUInt32LE(10)).toBe(14 + 40 + 16 * 4); // 118
    expect(four.readUInt32LE(2)).toBe(four.length);

    const one = buildBmpFile(makeDib({ bpp: 1 }));
    expect(one.readUInt32LE(10)).toBe(14 + 40 + 2 * 4);

    const eight = buildBmpFile(makeDib({ bpp: 8 }));
    expect(eight.readUInt32LE(10)).toBe(14 + 40 + 256 * 4);

    const eightUsed = buildBmpFile(makeDib({ bpp: 8, clrUsed: 10 }));
    expect(eightUsed.readUInt32LE(10)).toBe(14 + 40 + 10 * 4);
  });

  it("handles true colour, BI_BITFIELDS, OS/2 core and V4/V5 headers", () => {
    expect(buildBmpFile(makeDib({ bpp: 24 })).readUInt32LE(10)).toBe(54);
    expect(buildBmpFile(makeDib({ bpp: 16, compression: 3 })).readUInt32LE(10)).toBe(14 + 40 + 12);
    expect(buildBmpFile(makeDib({ bpp: 32, compression: 6 })).readUInt32LE(10)).toBe(14 + 40 + 16);

    const core = Buffer.alloc(12 + 8 * 3 + 8);
    core.writeUInt32LE(12, 0);
    core.writeUInt16LE(2, 4);
    core.writeUInt16LE(2, 6);
    core.writeUInt16LE(1, 8);
    core.writeUInt16LE(3, 10); // 3bpp is not valid but exercises 1<<bpp
    expect(buildBmpFile(core).readUInt32LE(10)).toBe(14 + 12 + 8 * 3);

    for (const size of [108, 124]) {
      const dib = Buffer.alloc(size + 16);
      dib.writeUInt32LE(size, 0);
      dib.writeUInt16LE(32, 14);
      const bmp = buildBmpFile(dib);
      expect(bmp.readUInt32LE(10)).toBe(14 + size);
      expect(bmp.readUInt32LE(2)).toBe(14 + dib.length);
    }
  });

  it("returns unknown headers and existing .bmp files unchanged", () => {
    const unknown = Buffer.alloc(32, 1);
    expect(buildBmpFile(unknown)).toBe(unknown);
    const bmp = Buffer.concat([Buffer.from("BM"), Buffer.alloc(30)]);
    expect(buildBmpFile(bmp)).toBe(bmp);
  });

  it("extracts a synthetic 4bpp bitmap with the right pixel offset", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-bmp-"));
    try {
      const exe = path.join(dir, "bmp.exe");
      await fs.writeFile(exe, buildPe({ resources: [{ type: 2, name: 7, data: makeDib({ bpp: 4 }) }] }));
      const out = path.join(dir, "out");
      const res = await new PeSoftwareAdapter().extract(exe, { outputDir: out });
      expect(res.success).toBe(true);
      const bmp = await fs.readFile(path.join(out, "bitmaps", "bitmap_7.bmp"));
      expect(bmp.readUInt32LE(10)).toBe(118);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  const appverif = "C:\\Windows\\System32\\appverifUI.dll";
  it.skipIf(!fsSync.existsSync(appverif))("fixes the real 4bpp bitmap 3002 of appverifUI.dll", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-bmp-real-"));
    try {
      const out = path.join(dir, "out");
      await new PeSoftwareAdapter().extract(appverif, { outputDir: out, filter: "RT_BITMAP/3002" });
      const bmp = await fs.readFile(path.join(out, "bitmaps", "bitmap_3002.bmp"));
      expect(bmp.readUInt32LE(10)).toBe(118);
      expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("produces valid offsets for the real treesize bitmaps", async () => {
    const files = (await fs.readdir(path.join(ASSETS, "bitmaps"))).filter((f) => f.endsWith(".bmp"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files.slice(0, 10)) {
      const bmp = await fs.readFile(path.join(ASSETS, "bitmaps", f));
      const dib = bmp.subarray(14);
      const rebuilt = buildBmpFile(dib);
      expect(rebuilt.readUInt32LE(10)).toBeLessThanOrEqual(rebuilt.length);
      expect(rebuilt.readUInt32LE(2)).toBe(rebuilt.length);
    }
  });
});

describe("Multi-language resources", () => {
  let dir: string;
  let exe: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-lang-"));
    exe = path.join(dir, "lang.exe");
    await fs.writeFile(
      exe,
      buildPe({
        resources: [
          { type: 2, name: 1, lang: 1033, data: makeDib({ bpp: 24 }) },
          { type: 2, name: 1, lang: 1036, data: makeDib({ bpp: 24, pixels: 32 }) },
          { type: 2, name: 2, lang: 1033, data: makeDib({ bpp: 24 }) },
          { type: 24, name: 1, lang: 0, data: Buffer.from("<assembly/>") }
        ]
      })
    );
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("suffixes only the resources present in several languages", async () => {
    const manifest = await new PeSoftwareAdapter().inspect(exe);
    const paths = manifest.assets.map((a) => a.path).sort();
    expect(paths).toEqual(
      [
        "resources/RT_BITMAP/1_l1033.bmp",
        "resources/RT_BITMAP/1_l1036.bmp",
        "resources/RT_BITMAP/2.bmp",
        "resources/RT_MANIFEST/1.xml"
      ].sort()
    );
  });

  it("extracts every language to its own file and filters match the inspected paths", async () => {
    const out = path.join(dir, "out");
    const res = await new PeSoftwareAdapter().extract(exe, { outputDir: out });
    expect(res.extractedCount).toBe(4);
    const names = (await fs.readdir(path.join(out, "bitmaps"))).sort();
    expect(names).toEqual(["bitmap_1_l1033.bmp", "bitmap_1_l1036.bmp", "bitmap_2.bmp"]);

    const out2 = path.join(dir, "out2");
    const one = await new PeSoftwareAdapter().extract(exe, { outputDir: out2, filter: "_l1036" });
    expect(one.extractedCount).toBe(1);
    expect(await fs.readdir(path.join(out2, "bitmaps"))).toEqual(["bitmap_1_l1036.bmp"]);
  });
});

describe("RT_GROUP_CURSOR / RT_CURSOR to .cur", () => {
  function cursorPayload(hotX: number, hotY: number, w: number, h: number): Buffer {
    const hot = Buffer.alloc(4);
    hot.writeUInt16LE(hotX, 0);
    hot.writeUInt16LE(hotY, 2);
    return Buffer.concat([hot, makeDib({ bpp: 1, w, h: h * 2, pixels: 64 })]);
  }

  function groupCursor(entries: Array<{ w: number; h: number; bytes: number; id: number }>): Buffer {
    const buf = Buffer.alloc(6 + entries.length * 14);
    buf.writeUInt16LE(2, 2);
    buf.writeUInt16LE(entries.length, 4);
    entries.forEach((e, i) => {
      const o = 6 + i * 14;
      buf.writeUInt16LE(e.w, o);
      buf.writeUInt16LE(e.h, o + 2);
      buf.writeUInt16LE(1, o + 4);
      buf.writeUInt16LE(1, o + 6);
      buf.writeUInt32LE(e.bytes, o + 8);
      buf.writeUInt16LE(e.id, o + 12);
    });
    return buf;
  }

  it("builds an ICONDIR type 2 with hotspot and halved height", () => {
    const payload = cursorPayload(3, 5, 32, 32);
    const cur = buildCursorFile([{ width: 32, height: 64, payload }])!;
    expect(cur.readUInt16LE(2)).toBe(2);
    expect(cur.readUInt16LE(4)).toBe(1);
    expect(cur[6]).toBe(32);
    expect(cur[7]).toBe(32);
    expect(cur.readUInt16LE(6 + 4)).toBe(3);
    expect(cur.readUInt16LE(6 + 6)).toBe(5);
    expect(cur.readUInt32LE(6 + 8)).toBe(payload.length - 4);
    expect(cur.readUInt32LE(6 + 12)).toBe(22);
    expect(cur.subarray(22).equals(payload.subarray(4))).toBe(true);
  });

  it("falls back to the group entry size (halved) when the image header is not a DIB", () => {
    const payload = Buffer.concat([Buffer.from([1, 0, 2, 0]), Buffer.alloc(20, 9)]);
    const cur = buildCursorFile([{ width: 16, height: 32, payload }])!;
    expect(cur[6]).toBe(16);
    expect(cur[7]).toBe(16);
    expect(buildCursorFile([])).toBeNull();
  });

  it("extracts cursors/ from a synthetic PE and skips raw RT_CURSOR entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-cur-"));
    try {
      const payload = cursorPayload(4, 6, 32, 32);
      const exe = path.join(dir, "cur.exe");
      await fs.writeFile(
        exe,
        buildPe({
          resources: [
            { type: 1, name: 24, data: payload },
            { type: 12, name: "HAND", data: groupCursor([{ w: 32, h: 64, bytes: payload.length, id: 24 }]) }
          ]
        })
      );
      const adapter = new PeSoftwareAdapter();
      const manifest = await adapter.inspect(exe);
      expect(manifest.assets.map((a) => a.path)).toEqual(["cursors/cursor_HAND.cur"]);

      const out = path.join(dir, "out");
      const res = await adapter.extract(exe, { outputDir: out });
      expect(res.success).toBe(true);
      expect(res.extractedCount).toBe(1);
      const cur = await fs.readFile(path.join(out, "cursors", "cursor_HAND.cur"));
      expect(cur.readUInt16LE(2)).toBe(2);
      expect(cur.readUInt16LE(10)).toBe(4);
      expect(cur.readUInt16LE(12)).toBe(6);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("converts the real treesize cursor group 32761 (cursor id 24)", async () => {
    const group = await fs.readFile(path.join(ASSETS, "rt_group_cursor", "res_32761"));
    const payload = await fs.readFile(path.join(ASSETS, "rt_cursor", "res_24"));
    const cur = buildCursorFile([
      { width: group.readUInt16LE(6), height: group.readUInt16LE(8), payload }
    ])!;
    expect(cur.readUInt16LE(2)).toBe(2);
    expect(cur[6]).toBe(32);
    expect(cur[7]).toBe(32);
    expect(cur.readUInt16LE(10)).toBe(payload.readUInt16LE(0));
    expect(cur.readUInt16LE(12)).toBe(payload.readUInt16LE(2));
  });
});

describe("RT_STRING, RT_VERSION, RT_DIALOG and RT_MENU", () => {
  it("decodes string blocks with id = (block - 1) * 16 + index", () => {
    const block = utf16Block({ 0: "Hello", 3: "World" });
    expect(decodeStringBlock(block, 2)).toEqual({ "16": "Hello", "19": "World" });
    expect(decodeStringBlock(Buffer.from([5, 0, 65]), 1)).toBeNull(); // truncated
  });

  it("decodes the real treesize string block 3751", async () => {
    const raw = await fs.readFile(path.join(ASSETS, "rt_string", "res_3751"));
    const strings = decodeStringBlock(raw, 3751)!;
    expect(strings["60001"]).toBe("Label:InternalCmd2");
  });

  it("decodes the real treesize version resource", async () => {
    const raw = await fs.readFile(path.join(ASSETS, "rt_version", "res_1"));
    const info = decodeVersionInfo(raw)!;
    expect(info).not.toBeNull();
    expect(info.fixedFileInfo!.fileVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(info.fixedFileInfo!.productVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const table = Object.values(info.strings)[0];
    expect(Object.keys(table)).toContain("CompanyName");
    expect(decodeVersionInfo(Buffer.alloc(10))).toBeNull();
  });

  it("extracts strings/, version/ JSON and .bin dialog/menu from a synthetic PE", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-misc-"));
    try {
      const version = await fs.readFile(path.join(ASSETS, "rt_version", "res_1"));
      const exe = path.join(dir, "misc.exe");
      await fs.writeFile(
        exe,
        buildPe({
          resources: [
            { type: 6, name: 2, data: utf16Block({ 1: "Open" }) },
            { type: 16, name: 1, data: version },
            { type: 5, name: "ABOUT", data: Buffer.from([1, 2, 3, 4]) },
            { type: 4, name: 100, data: Buffer.from([5, 6]) }
          ]
        })
      );
      const adapter = new PeSoftwareAdapter();
      const manifest = await adapter.inspect(exe);
      const paths = manifest.assets.map((a) => a.path).sort();
      expect(paths).toEqual(
        ["resources/RT_DIALOG/ABOUT.bin", "resources/RT_MENU/100.bin", "resources/RT_STRING/2.json", "resources/RT_VERSION/1.json"].sort()
      );

      const out = path.join(dir, "out");
      const res = await adapter.extract(exe, { outputDir: out });
      expect(res.success).toBe(true);
      expect(res.extractedCount).toBe(4);

      const strings = JSON.parse(await fs.readFile(path.join(out, "strings", "strings_2.json"), "utf8"));
      expect(strings.strings["17"]).toBe("Open");
      const ver = JSON.parse(await fs.readFile(path.join(out, "version", "version_1.json"), "utf8"));
      expect(ver.fixedFileInfo.fileVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect((await fs.readFile(path.join(out, "rt_dialog", "res_ABOUT.bin"))).length).toBe(4);
      expect((await fs.readFile(path.join(out, "rt_menu", "res_100.bin"))).length).toBe(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Delphi binary form (TPF0) to text", () => {
  const sstr = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s, "latin1")]);
  const prop = (name: string, ...value: Buffer[]) => Buffer.concat([sstr(name), ...value]);
  const int8 = (n: number) => Buffer.from([2, n & 0xff]);
  const int16 = (n: number) => {
    const b = Buffer.alloc(3);
    b[0] = 3;
    b.writeInt16LE(n, 1);
    return b;
  };
  const int32 = (n: number) => {
    const b = Buffer.alloc(5);
    b[0] = 4;
    b.writeInt32LE(n, 1);
    return b;
  };

  function makeForm(): Buffer {
    const wstr = Buffer.alloc(5 + 6);
    wstr[0] = 0x12;
    wstr.writeUInt32LE(3, 1);
    wstr.write("W\u00e9!", 5, "utf16le");
    const i64 = Buffer.alloc(9);
    i64[0] = 0x13;
    i64.writeBigInt64LE(-5n, 1);
    const single = Buffer.alloc(5);
    single[0] = 0x0f;
    single.writeFloatLE(1.5, 1);
    const lstr = Buffer.concat([Buffer.from([0x0c, 2, 0, 0, 0]), Buffer.from("hi")]);
    const binary = Buffer.concat([Buffer.from([0x0a, 3, 0, 0, 0]), Buffer.from([0xde, 0xad, 0xbe])]);
    const utf8 = Buffer.concat([Buffer.from([0x14, 3, 0, 0, 0]), Buffer.from("o'k")]);

    const child = Buffer.concat([
      sstr("TButton"),
      sstr("Button1"),
      prop("Caption", Buffer.from([6]), sstr("O'K\r")),
      prop("Enabled", Buffer.from([8])),
      prop("Visible", Buffer.from([9])),
      prop("OnClick", Buffer.from([0x0d])),
      Buffer.from([0]), // end props
      Buffer.from([0]) // end children
    ]);
    const inherited = Buffer.concat([
      Buffer.from([0xf1]),
      sstr("TFrame"),
      sstr("Frame1"),
      Buffer.from([0]),
      Buffer.from([0])
    ]);

    return Buffer.concat([
      Buffer.from("TPF0"),
      sstr("TForm1"),
      sstr("Form1"),
      prop("Left", int8(10)),
      prop("Top", int16(300)),
      prop("Width", int32(100000)),
      prop("Name", Buffer.from([7]), sstr("clBtnFace")),
      prop("Style", Buffer.from([0x0b]), sstr("fsBold"), sstr("fsItalic"), Buffer.from([0])),
      prop("Items", Buffer.from([1]), Buffer.from([6]), sstr("a"), Buffer.from([6]), sstr("b"), Buffer.from([0])),
      prop(
        "Cols",
        Buffer.from([0x0e]),
        Buffer.from([1]),
        prop("Width", int8(5)),
        Buffer.from([0]),
        Buffer.from([0])
      ),
      prop("Wide", wstr),
      prop("Big", i64),
      prop("Sing", single),
      prop("Long", lstr),
      prop("Data", binary),
      prop("U", utf8),
      Buffer.from([0]), // end props
      child,
      inherited,
      Buffer.from([0]), // end children of root
      Buffer.from([0])
    ]);
  }

  it("renders objects, children, inherited and every supported value type", () => {
    const text = convertBinaryDfmToText(makeForm())!;
    expect(text).not.toBeNull();
    expect(text).toContain("object Form1: TForm1");
    expect(text).toContain("  Left = 10");
    expect(text).toContain("  Top = 300");
    expect(text).toContain("  Width = 100000");
    expect(text).toContain("  Name = clBtnFace");
    expect(text).toContain("  Style = [fsBold, fsItalic]");
    expect(text).toMatch(/Items = \(\n {4}'a'\n {4}'b'\)/);
    expect(text).toMatch(/Cols = <\n {4}item\n {6}Width = 5\n {4}end>/);
    expect(text).toContain("#233");
    expect(text).toContain("  Big = -5");
    expect(text).toContain("  Sing = 1.5s");
    expect(text).toContain("  Long = 'hi'");
    expect(text).toContain("DEADBE");
    expect(text).toContain("  U = 'o''k'");
    expect(text).toContain("  object Button1: TButton");
    expect(text).toContain("    Caption = 'O''K'#13");
    expect(text).toContain("    Enabled = False");
    expect(text).toContain("    Visible = True");
    expect(text).toContain("    OnClick = nil");
    expect(text).toContain("  inherited Frame1: TFrame");
    expect(text.trimEnd().endsWith("end")).toBe(true);
  });

  it("returns null instead of throwing on unknown value types and truncated data", () => {
    const bad = Buffer.concat([
      Buffer.from("TPF0"),
      sstr("TForm1"),
      sstr("Form1"),
      prop("Weird", Buffer.from([0x7f])),
      Buffer.from([0, 0])
    ]);
    expect(convertBinaryDfmToText(bad)).toBeNull();
    expect(convertBinaryDfmToText(makeForm().subarray(0, 40))).toBeNull();
    expect(convertBinaryDfmToText(Buffer.from("not a form"))).toBeNull();
  });

  it("converts every real treesize .dfm without throwing", async () => {
    const dir = path.join(ASSETS, "rcdata");
    const dfms = (await fs.readdir(dir)).filter((f) => f.startsWith("form_") && f.endsWith(".dfm"));
    expect(dfms.length).toBeGreaterThan(5);
    for (const f of dfms) {
      const text = convertBinaryDfmToText(await fs.readFile(path.join(dir, f)));
      expect(text, f).not.toBeNull();
      expect(text!, f).toMatch(/^(object|inherited|inline) /);
    }
    const renamer = convertBinaryDfmToText(await fs.readFile(path.join(dir, "form_TRENAMERDIALOG.dfm")))!;
    expect(renamer).toContain("object RenamerDialog: TRenamerDialog");
    expect(renamer).toContain("Caption = 'Bulk Rename'");
  });

  it("writes form_NAME.txt next to the raw form_NAME.dfm", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-dfm-"));
    try {
      const exe = path.join(dir, "delphi.exe");
      const form = makeForm();
      const broken = Buffer.concat([Buffer.from("TPF0"), sstr("TForm1"), sstr("Form1"), prop("X", Buffer.from([0x7f]))]);
      await fs.writeFile(
        exe,
        buildPe({
          resources: [
            { type: 10, name: "TFORM1", data: form },
            { type: 10, name: "TBROKEN", data: broken }
          ]
        })
      );
      const out = path.join(dir, "out");
      const res = await new PeSoftwareAdapter().extract(exe, { outputDir: out });
      expect(res.success).toBe(true);
      expect(res.extractedCount).toBe(2);
      const files = (await fs.readdir(path.join(out, "rcdata"))).sort();
      expect(files).toEqual(["form_TBROKEN.dfm", "form_TFORM1.dfm", "form_TFORM1.txt"]);
      expect((await fs.readFile(path.join(out, "rcdata", "form_TFORM1.dfm"))).equals(form)).toBe(true);
      expect(await fs.readFile(path.join(out, "rcdata", "form_TFORM1.txt"), "utf8")).toContain("object Form1: TForm1");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Framework detection", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-fw-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function detect(opts: BuildPeOptions, name = "app.exe") {
    const exe = path.join(dir, name);
    await fs.writeFile(exe, buildPe(opts));
    return PeResourceParser.parse(exe);
  }
  const text = (s: string) => Buffer.from(`\0\0${s}\0\0`, "latin1");

  it("detects Delphi from PACKAGEINFO / DVCLAL names, a TPF0 RCDATA, or Borland strings", async () => {
    expect((await detect({ resources: [{ type: 10, name: "PACKAGEINFO", data: Buffer.alloc(8) }] }))!.framework).toBe("Delphi");
    expect((await detect({ resources: [{ type: 10, name: "dvclal", data: Buffer.alloc(8) }] }))!.framework).toBe("Delphi");
    expect((await detect({ resources: [{ type: 10, name: "TFORM", data: Buffer.from("TPF0\0\0\0\0") }] }))!.framework).toBe("Delphi");
    expect((await detect({ trailing: text("Embarcadero Delphi for Win32 compiler Borland") }))!.framework).toBe("Delphi");
    expect((await detect({ resources: [{ type: 10, name: "OTHER", data: Buffer.alloc(8) }] }))!.framework).toBe("Native C/C++");
  });

  it("detects Qt, Rust, Go, Electron and .NET", async () => {
    expect((await detect({ trailing: text("Qt6Core.dll") }))!.framework).toBe("Qt");
    expect((await detect({ trailing: text("Qt5Cored.dll") }))!.framework).toBe("Qt");
    expect((await detect({ trailing: text("qt_resource_data") }))!.framework).toBe("Qt");
    expect((await detect({ trailing: text("rust_begin_unwind") }))!.framework).toBe("Rust");
    expect((await detect({ trailing: text("C:/rustc/abc123/library/core/src/lib.rs") }))!.framework).toBe("Rust");
    expect((await detect({ trailing: text("\u00ff Go buildinf:") }))!.framework).toBe("Go");
    expect((await detect({ trailing: text("Go build ID: \"abc\"") }))!.framework).toBe("Go");
    expect((await detect({ trailing: text("runtime.main") }))!.framework).toBe("Go");
    expect((await detect({ trailing: text("ELECTRON_RUN_AS_NODE") }))!.framework).toBe("Electron");
    const net = await detect({ clr: true });
    expect(net!.framework).toBe(".NET");
    expect(net!.isDotNet).toBe(true);
  });

  it("records .NET Core single-file bundles through the apphost signature", async () => {
    const sig = Buffer.from("8b1202b96a612038727b930214d7a03213f5b9e6efae3318ee3b2dce24b36aae", "hex");
    const unbundled = Buffer.concat([Buffer.alloc(8), sig]);
    const offset = Buffer.alloc(8);
    offset.writeBigUInt64LE(123456n);
    const bundled = Buffer.concat([offset, sig]);

    const plain = await detect({ trailing: unbundled }, "host.exe");
    expect(plain!.framework).toBe(".NET");
    expect(plain!.dotNetSingleFile).toBe(false);
    const single = await detect({ trailing: bundled }, "single.exe");
    expect(single!.framework).toBe(".NET");
    expect(single!.dotNetSingleFile).toBe(true);
    expect((await detect({}, "plain.exe"))!.dotNetSingleFile).toBeUndefined();
  });

  it("only samples the first 8MB and the last 1MB of the file", async () => {
    const mb = 1024 * 1024;
    const base = buildPe();
    const total = 12 * mb;
    const marker = Buffer.from("rust_begin_unwind");
    const make = async (name: string, markerAt: number) => {
      const buf = Buffer.alloc(total);
      base.copy(buf, 0);
      marker.copy(buf, markerAt);
      const p = path.join(dir, name);
      await fs.writeFile(p, buf);
      return PeResourceParser.parse(p);
    };
    expect((await make("head.exe", 5 * mb))!.framework).toBe("Rust");
    expect((await make("tail.exe", total - mb / 2))!.framework).toBe("Rust");
    expect((await make("middle.exe", 10 * mb))!.framework).toBe("Native C/C++");
  });
});

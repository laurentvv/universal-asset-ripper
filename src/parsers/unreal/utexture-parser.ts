import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodePixels, type PixelLayout } from "../texture/pixel-layouts.js";
import { encodePng } from "../texture/png-writer.js";
import { listFilesRecursively } from "../../utils/file-utils.js";

/**
 * Unreal Engine 4 cooked textures: a package's `.uasset` (summary, names, imports, exports) and
 * a Texture2D export's data (in the `.uexp`), with its mips inline or in a `.ubulk`/`.uptnl`.
 *
 * Clean-room TypeScript port of craft-anything crates/formats/src/unreal_texture.rs
 * (commit fc93bd0, MIT OR Apache-2.0). Read as observed in games cooked with Unreal 4.26-4.27
 * (package file version -7, versioned or not); Unreal 5 packages and packages written without
 * property names are refused: reading them needs the game's own type layouts.
 */

const MAX_STRING = 4096;
const UNVERSIONED_PROPERTIES = 0x2000;
const EDITOR_ONLY_FILTERED = 0x80000000;

// Bulk data flags
const PAYLOAD_AT_END = 0x1;
const ZLIB = 0x2;
const UNUSED = 0x20;
const SEPARATE_FILE = 0x100;
const OPTIONAL = 0x800;
const SIZE_64 = 0x2000;

export const UE_PACKAGE_TAG = 0x9e2a83c1;

export type UTextureErrorCode = "unsupported" | "corrupt";

export class UTextureError extends Error {
  constructor(
    readonly code: UTextureErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UTextureError";
  }
}

export interface UTextureExport {
  name: string;
  /** Its class's name (Texture2D, Material, ...). */
  className: string;
  /** Where its data is in the .uasset and .uexp taken as one file, and how long. */
  serialOffset: number;
  serialSize: number;
}

export interface UTexturePackage {
  /** The .uasset's length: the .uexp's bytes count from here. */
  headerSize: number;
  names: string[];
  exports: UTextureExport[];
}

/** Where a mip's pixels are. */
export type UTextureMipData =
  | { kind: "inline"; start: number; length: number }
  | { kind: "file"; extension: "ubulk" | "uptnl"; offset: number; length: number }
  | { kind: "missing" };

export interface UTextureMip {
  width: number;
  height: number;
  data: UTextureMipData;
}

export interface UTexture2D {
  /** The full size (the largest mip stored can be smaller when the game was cooked with a bias). */
  width: number;
  height: number;
  /** Unreal's pixel format, e.g. PF_DXT5. */
  pixelFormat: string;
  mips: UTextureMip[];
}

// ---------------------------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------------------------

class Cursor {
  constructor(
    readonly data: Buffer,
    public pos = 0
  ) {}

  private need(n: number): void {
    if (n < 0 || this.pos + n > this.data.length) {
      throw new UTextureError("corrupt", `Unexpected end of data at offset ${this.pos} (+${n}).`);
    }
  }

  take(n: number): Buffer {
    this.need(n);
    const s = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  u8(): number {
    this.need(1);
    return this.data.readUInt8(this.pos++);
  }

  u32(): number {
    this.need(4);
    const v = this.data.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.data.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  i64(): number {
    this.need(8);
    const v = this.data.readBigInt64LE(this.pos);
    this.pos += 8;
    if (v < BigInt(Number.MIN_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new UTextureError("corrupt", "64-bit value out of range.");
    }
    return Number(v);
  }

  /** A non-negative count that fits what's left (`minEach` bytes each). */
  count(what: string, minEach: number): number {
    const n = this.i32();
    if (n < 0) throw new UTextureError("corrupt", `Negative ${what} count.`);
    if (n * Math.max(1, minEach) > this.data.length - this.pos) {
      throw new UTextureError("corrupt", `${what} count ${n} doesn't fit in the remaining data.`);
    }
    return n;
  }

  /** An FString: a signed length with its terminating NUL; negative means UTF-16. */
  string(what: string): string {
    const n = this.i32();
    const chars = Math.abs(n);
    if (chars > MAX_STRING) throw new UTextureError("corrupt", `${what} is ${chars} characters long.`);
    let s: string;
    if (n >= 0) {
      s = this.take(chars).toString("utf8");
    } else {
      s = this.take(chars * 2).toString("utf16le");
    }
    return s.replace(/\0+$/, "");
  }
}

/** A name-table entry by index (the name's number is ignored). */
function nameAt(names: string[], c: Cursor, what: string): string {
  const i = c.i32();
  c.i32();
  const n = names[i];
  if (n === undefined) throw new UTextureError("corrupt", `${what} names entry ${i} is out of range.`);
  return n;
}

// ---------------------------------------------------------------------------------------------
// Package summary (.uasset)
// ---------------------------------------------------------------------------------------------

/** Read a cooked package's `.uasset`. */
export function readUassetPackage(uasset: Buffer): UTexturePackage {
  const c = new Cursor(uasset, 0);
  if (c.u32() !== UE_PACKAGE_TAG) throw new UTextureError("corrupt", "Not an Unreal package.");
  const legacy = c.i32();
  if (legacy === -8 || legacy === -9) throw new UTextureError("unsupported", "Unreal 5 packages are not supported.");
  if (legacy !== -7) throw new UTextureError("unsupported", `Unreal packages of file version ${legacy} (before Unreal 4.26) are not supported.`);
  c.i32(); // UE3 version
  c.i32(); // UE4 version
  c.i32(); // licensee version
  const customs = c.count("custom versions", 20);
  c.take(customs * 20);
  const headerSize = c.i32();
  if (headerSize < 0) throw new UTextureError("corrupt", "Negative header size.");
  c.string("folder name");
  const flags = c.u32();
  if ((flags & UNVERSIONED_PROPERTIES) !== 0) {
    throw new UTextureError("unsupported", "Packages written without property names (unversioned properties) are not supported.");
  }
  const nameCount = c.count("names", 9);
  const nameOffset = c.i32();
  if ((flags & EDITOR_ONLY_FILTERED) === 0) {
    c.string("localization id");
  }
  c.i64(); // gatherable text
  const exportCount = c.count("exports", 104);
  const exportOffset = c.i32();
  const importCount = c.count("imports", 28);
  const importOffset = c.i32();

  const at = (offset: number, what: string): number => {
    if (offset < 0 || offset > uasset.length) throw new UTextureError("corrupt", `${what} offset ${offset} is out of range.`);
    return offset;
  };

  const nc = new Cursor(uasset, at(nameOffset, "name"));
  const names: string[] = [];
  for (let i = 0; i < nameCount; i++) {
    names.push(nc.string("name"));
    nc.take(4); // name hashes
  }

  const ic = new Cursor(uasset, at(importOffset, "import"));
  const imports: string[] = [];
  for (let i = 0; i < importCount; i++) {
    ic.take(16); // import class
    ic.i32(); // import outer
    imports.push(nameAt(names, ic, "import name"));
  }

  const ec = new Cursor(uasset, at(exportOffset, "export"));
  const exports: UTextureExport[] = [];
  for (let i = 0; i < exportCount; i++) {
    const classNameIdx = ec.i32();
    ec.take(12); // export super, template and outer
    const exportName = nameAt(names, ec, "export name");
    ec.u32(); // object flags
    const serialSize = ec.i64();
    const serialOffset = ec.i64();
    if (serialSize < 0 || serialOffset < 0) throw new UTextureError("corrupt", "Negative serial size/offset.");
    ec.take(104 - 44); // export flags and dependencies
    // A negative class is an import: -1 is the first.
    const classIdx = -classNameIdx - 1;
    const className = classNameIdx < 0 ? (imports[classIdx] ?? "") : "";
    exports.push({ name: exportName, className, serialOffset, serialSize });
  }
  return { headerSize, names, exports };
}

// ---------------------------------------------------------------------------------------------
// Texture2D export data (.uexp slice)
// ---------------------------------------------------------------------------------------------

/** Skip the tagged properties up to `None`. */
function skipProperties(c: Cursor, names: string[]): void {
  for (let i = 0; i < 10000; i++) {
    const property = nameAt(names, c, "property name");
    if (property === "None") return;
    const kind = nameAt(names, c, "property type");
    const size = c.count("property size", 1);
    c.i32(); // array index
    const headerSize =
      kind === "StructProperty" ? 8 + 16 : kind === "BoolProperty" ? 1 : ["ByteProperty", "EnumProperty", "ArrayProperty", "SetProperty"].includes(kind) ? 8 : kind === "MapProperty" ? 16 : 0;
    c.take(headerSize);
    if (c.u8() !== 0) c.take(16); // property guid
    c.take(size);
  }
  throw new UTextureError("corrupt", "Too many properties.");
}

/** Read a Texture2D export's data (`data`: its serialSize bytes, starting at serialOffset). */
export function readTexture2D(data: Buffer, names: string[]): UTexture2D {
  const c = new Cursor(data, 0);
  skipProperties(c, names);
  if (c.i32() !== 0) c.take(16); // guid
  c.take(4); // strip flags
  if (c.i32() === 0) throw new UTextureError("unsupported", "An editor (uncooked) texture is not supported.");
  const formatName = nameAt(names, c, "pixel format name");
  if (formatName === "None") throw new UTextureError("corrupt", "No platform data.");
  c.i64(); // skip offset
  let width = c.i32();
  let height = c.i32();
  const packed = c.u32();
  const pixelFormat = c.string("pixel format");
  if ((packed & (1 << 30)) !== 0) c.take(8); // optional data
  c.i32(); // first mip
  const count = c.count("mips", 28);
  const mips: UTextureMip[] = [];
  for (let i = 0; i < count; i++) {
    c.i32(); // mip cooked
    const flags = c.u32();
    let onDisk: number;
    if ((flags & SIZE_64) !== 0) {
      c.i64(); // element count
      onDisk = c.i64();
    } else {
      c.i32(); // element count
      onDisk = c.i32();
    }
    const offset = c.i64();
    if (onDisk < 0) throw new UTextureError("corrupt", "Negative mip size.");
    const elsewhere = (flags & (PAYLOAD_AT_END | SEPARATE_FILE | UNUSED)) !== 0;
    let mipData: UTextureMipData = { kind: "missing" };
    if (!elsewhere) {
      const start = c.pos;
      c.take(onDisk);
      if ((flags & ZLIB) === 0) mipData = { kind: "inline", start, length: onDisk };
    } else if ((flags & SEPARATE_FILE) !== 0 && (flags & (UNUSED | ZLIB)) === 0) {
      mipData = { kind: "file", extension: (flags & OPTIONAL) !== 0 ? "uptnl" : "ubulk", offset: offset < 0 ? Number.MAX_SAFE_INTEGER : offset, length: onDisk };
    }
    const mipWidth = Math.abs(c.i32());
    const mipHeight = Math.abs(c.i32());
    c.i32(); // mip depth
    mips.push({ width: mipWidth, height: mipHeight, data: mipData });
  }
  width = Math.abs(width);
  height = Math.abs(height);
  if (width < 1 || width > 16384 || height < 1 || height > 16384 || mips.some((m) => m.width === 0 || m.height === 0)) {
    throw new UTextureError("unsupported", "This texture's layout isn't one that's read here.");
  }
  return { width, height, pixelFormat, mips };
}

// ---------------------------------------------------------------------------------------------
// Pixel formats and PNG conversion
// ---------------------------------------------------------------------------------------------

/** How an Unreal pixel format is laid out, for the formats that are decoded. */
export function unrealPixelFormatLayout(pixelFormat: string): PixelLayout | null {
  switch (pixelFormat) {
    case "PF_B8G8R8A8":
      return "bgra32";
    case "PF_R8G8B8A8":
      return "rgba32";
    case "PF_G8":
    case "PF_L8":
      return "r8";
    case "PF_A8":
      return "alpha8";
    case "PF_DXT1":
      return "dxt1";
    case "PF_DXT5":
      return "dxt5";
    case "PF_BC4":
      return "bc4";
    case "PF_BC5":
      return "bc5";
    case "PF_BC6H":
      return "bc6h";
    case "PF_BC7":
      return "bc7";
    default:
      return null;
  }
}

export interface TexturePngResult {
  width: number;
  height: number;
  pixelFormat: string;
  png: Buffer;
  /** Which mip level was decoded (0 = largest stored). */
  mip: number;
}

/**
 * Decode the largest stored mip of a texture to PNG. Rows are stored top-first in Unreal
 * packages, so no flip is needed (unlike Unity). `mipData`: the raw bytes of that mip.
 * Throws UTextureError("unsupported") for pixel formats we cannot decode.
 */
export function textureToPng(texture: UTexture2D, mipIndex: number, mipData: Buffer): TexturePngResult {
  if (mipIndex < 0 || mipIndex >= texture.mips.length) {
    throw new UTextureError("corrupt", `Mip ${mipIndex} does not exist (texture has ${texture.mips.length} mips).`);
  }
  const layout = unrealPixelFormatLayout(texture.pixelFormat);
  if (!layout) throw new UTextureError("unsupported", `Pixel format ${texture.pixelFormat} cannot be decoded to PNG.`);
  const mip = texture.mips[mipIndex]!;
  const rgba = decodePixels(layout, mip.width, mip.height, mipData);
  return { width: mip.width, height: mip.height, pixelFormat: texture.pixelFormat, png: encodePng(rgba, mip.width, mip.height), mip: mipIndex };
}

/** Base output name for a texture package: the .uasset path without its extension. */
export function textureOutputStem(uassetPath: string): string {
  return uassetPath.slice(0, uassetPath.length - path.extname(uassetPath).length);
}

/**
 * Decode extracted Unreal packages (uasset + uexp pairs) into PNG textures. Only Texture2D
 * exports with a decodable pixel format produce files; everything else (materials, blueprints,
 * undecodable formats) is left untouched without error. Returns the number of PNGs written;
 * hard failures (corrupt texture data) are reported through `errors`.
 */
export async function convertExtractedUnrealTextures(outputDir: string, errors: Array<{ file: string; error: string }>): Promise<number> {
  const all = await listFilesRecursively(outputDir, 64);
  let written = 0;
  for (const uassetPath of all.filter((f) => f.toLowerCase().endsWith(".uasset"))) {
    try {
      const uexpPath = uassetPath.replace(/\.uasset$/i, ".uexp");
      const [uasset, uexp] = await Promise.all([fs.readFile(uassetPath), fs.readFile(uexpPath).catch(() => null)]);
      if (!uexp) continue;
      const pkg = readUassetPackage(uasset);
      for (const exp of pkg.exports.filter((e) => e.className === "Texture2D")) {
        try {
          const start = exp.serialOffset - pkg.headerSize;
          if (start < 0 || start + exp.serialSize > uexp.length) continue;
          const texture = readTexture2D(uexp.subarray(start, start + exp.serialSize), pkg.names);
          const mip = texture.mips.findIndex((m) => m.data.kind !== "missing");
          if (mip < 0) continue;
          const mipData = texture.mips[mip]!.data;
          let bytes: Buffer | null;
          if (mipData.kind === "inline") {
            bytes = uexp.subarray(start + mipData.start, start + mipData.start + mipData.length);
          } else if (mipData.kind === "file") {
            bytes = await fs.readFile(uassetPath.replace(/\.uasset$/i, `.${mipData.extension}`)).then(
              (b) => b.subarray(mipData.offset, mipData.offset + mipData.length),
              () => null
            );
          } else {
            continue;
          }
          if (!bytes) continue;
          const png = textureToPng(texture, mip, bytes);
          const stem = uassetPath.replace(/\.uasset$/i, "");
          const out = pkg.exports.length > 1 ? `${stem}__${exp.name}.png` : `${stem}.png`;
          await fs.writeFile(out, png.png);
          written++;
        } catch (err: unknown) {
          if (err instanceof UTextureError && err.code === "unsupported") continue;
          errors.push({ file: uassetPath, error: `Texture export ${exp.name}: ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    } catch {
      // Not a readable package (e.g. arbitrary data): leave as is
    }
  }
  return written;
}

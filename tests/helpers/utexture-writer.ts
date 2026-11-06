/**
 * Fixture writer for cooked Unreal 4 texture packages: builds a .uasset (summary + names +
 * imports + exports), a .uexp (Texture2D export data) and an optional .ubulk/.uptnl, matching
 * the layout read by src/parsers/unreal/utexture-parser.ts (package file version -7).
 */

export interface UTextureFixtureMip {
  width: number;
  height: number;
  data: Buffer;
  /** Where the mip's pixels live: inline in the .uexp, or in the .ubulk/.uptnl. */
  location: "inline" | "ubulk" | "uptnl" | "missing";
}

export interface UTextureFixtureOptions {
  exportName: string;
  pixelFormat: string;
  width: number;
  height: number;
  mips: UTextureFixtureMip[];
  /** Package legacy version override (default -7). */
  legacyVersion?: number;
  /** Package flags override (default EDITOR_ONLY_FILTERED, which hides the localization id). */
  flags?: number;
  /** Skip the leading None property (simulates tagged properties being present). */
  withProperties?: boolean;
}

export interface UTextureFixture {
  uasset: Buffer;
  uexp: Buffer;
  ubulk: Buffer | null;
  uptnl: Buffer | null;
}

const UE_PACKAGE_TAG = 0x9e2a83c1;
const EDITOR_ONLY_FILTERED = 0x80000000;
// Bulk data flags (as read by the parser)
const PAYLOAD_AT_END = 0x1;
const SEPARATE_FILE = 0x100;
const OPTIONAL = 0x800;

function fstring(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const out = Buffer.alloc(4 + bytes.length + 1);
  out.writeInt32LE(bytes.length + 1, 0);
  bytes.copy(out, 4);
  out[4 + bytes.length] = 0;
  return out;
}

export function buildUnrealTexturePackage(opts: UTextureFixtureOptions): UTextureFixture {
  const legacy = opts.legacyVersion ?? -7;
  const flags = opts.flags ?? EDITOR_ONLY_FILTERED;

  const u32 = (v: number): Buffer => Buffer.from([v >>> 0 & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const i32 = (v: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    return b;
  };
  const i64 = (v: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v), 0);
    return b;
  };

  // ---- .ubulk / .uptnl payload: file-located mips concatenated in order ----
  const fileMips = opts.mips.filter((m) => m.location === "ubulk" || m.location === "uptnl");
  let bulkOffset = 0;
  const fileOffsets = new Map<UTextureFixtureMip, number>();
  for (const m of fileMips) {
    fileOffsets.set(m, bulkOffset);
    bulkOffset += m.data.length;
  }
  const bulk = Buffer.concat(fileMips.map((m) => m.data));
  const ubulk = opts.mips.some((m) => m.location === "ubulk") ? bulk : null;
  const uptnl = opts.mips.some((m) => m.location === "uptnl") ? bulk : null;

  // ---- Texture2D export data (the .uexp payload) ----
  const names = opts.withProperties ? ["None", "Texture2D", opts.exportName, opts.pixelFormat, "SomeProp"] : ["None", "Texture2D", opts.exportName, opts.pixelFormat];
  const nameIdx = (s: string): number => names.indexOf(s);

  const expParts: Buffer[] = [];
  if (opts.withProperties) {
    // One 4-byte-value property (name SomeProp, type Texture2D → no extra header) then the
    // None terminator, so skipProperties has real work
    expParts.push(i32(nameIdx("SomeProp")), i32(0));
    expParts.push(i32(nameIdx("Texture2D")), i32(0));
    expParts.push(i32(4), i32(0)); // property size + array index
    expParts.push(Buffer.from([0])); // guid flag
    expParts.push(i32(0)); // value
  }
  expParts.push(i32(nameIdx("None")), i32(0)); // property list terminator
  expParts.push(i32(0)); // guid flag
  expParts.push(u32(0)); // strip flags
  expParts.push(i32(1)); // cooked
  expParts.push(i32(nameIdx(opts.pixelFormat)), i32(0)); // pixel format name
  expParts.push(i64(0)); // skip offset
  expParts.push(i32(opts.width), i32(opts.height));
  expParts.push(u32(0)); // packed slice flags
  expParts.push(fstring(opts.pixelFormat)); // platform pixel format string
  expParts.push(i32(0)); // first mip
  expParts.push(i32(opts.mips.length));
  for (const mip of opts.mips) {
    expParts.push(i32(1)); // mip cooked
    const bulkFlags = mip.location === "ubulk" ? SEPARATE_FILE : mip.location === "uptnl" ? SEPARATE_FILE | OPTIONAL : mip.location === "missing" ? PAYLOAD_AT_END : 0;
    expParts.push(u32(bulkFlags));
    expParts.push(i32(1)); // element count
    expParts.push(i32(mip.data.length)); // size on disk
    expParts.push(i64(mip.location === "ubulk" || mip.location === "uptnl" ? fileOffsets.get(mip)! : 0)); // bulk offset
    if (mip.location === "inline") expParts.push(mip.data);
    expParts.push(i32(mip.width), i32(mip.height), i32(1)); // mip width/height/depth
  }
  const uexp = Buffer.concat(expParts);

  // ---- uasset: summary, names table, imports, exports ----
  const summary: Buffer[] = [];
  summary.push(u32(UE_PACKAGE_TAG));
  summary.push(i32(legacy));
  summary.push(i32(0), i32(522), i32(0)); // UE3 / UE4 / licensee versions
  summary.push(i32(0)); // custom versions
  summary.push(Buffer.alloc(4)); // headerSize slot (patched to the full uasset length)
  const folder = fstring("../../../ThisGame/");
  summary.push(folder);
  summary.push(u32(flags));
  summary.push(i32(names.length), Buffer.alloc(4)); // names count + name offset slot
  if ((flags & EDITOR_ONLY_FILTERED) === 0) summary.push(fstring("")); // localization id
  summary.push(i64(0)); // gatherable text
  summary.push(i32(1), Buffer.alloc(4)); // exports count + export offset slot
  summary.push(i32(1), Buffer.alloc(4)); // imports count + import offset slot

  const namesTableOffset = Buffer.concat(summary).length;
  const namesTable = Buffer.concat(names.map((n) => Buffer.concat([fstring(n), Buffer.alloc(4)])));
  const importsOffset = namesTableOffset + namesTable.length;
  // One import whose name is "Texture2D": 16 opaque class bytes + outer + name ref
  const importsTable = Buffer.concat([Buffer.alloc(16), i32(0), i32(nameIdx("Texture2D")), i32(0)]);
  const exportsOffset = importsOffset + importsTable.length;

  const exportRecord = Buffer.alloc(104);
  exportRecord.writeInt32LE(-1, 0); // class = first import
  exportRecord.writeInt32LE(nameIdx(opts.exportName), 16); // name index
  exportRecord.writeUInt32LE(0x02000000, 24); // object flags
  exportRecord.writeBigInt64LE(BigInt(uexp.length), 28); // serial size
  exportRecord.writeBigInt64LE(BigInt(exportsOffset + 104), 36); // serial offset (uexp starts right after)
  const exportsTable = exportRecord;

  const uasset = Buffer.concat([Buffer.concat(summary), namesTable, importsTable, exportsTable]);

  // Patch the headerSize slot (at 24) and the three offset slots
  uasset.writeUInt32LE(uasset.length, 24);
  const namesOffsetSlotAt = 28 + folder.length + 4 + 4;
  const afterNamesSlot = namesOffsetSlotAt + 4;
  const localizationLen = (flags & EDITOR_ONLY_FILTERED) === 0 ? fstring("").length : 0;
  const exportsOffsetSlotAt = afterNamesSlot + localizationLen + 8 + 4;
  const importsOffsetSlotAt = exportsOffsetSlotAt + 4 + 4; // export slot, then imports count
  uasset.writeUInt32LE(namesTableOffset, namesOffsetSlotAt);
  uasset.writeUInt32LE(exportsOffset, exportsOffsetSlotAt);
  uasset.writeUInt32LE(importsOffset, importsOffsetSlotAt);

  return { uasset, uexp, ubulk, uptnl };
}

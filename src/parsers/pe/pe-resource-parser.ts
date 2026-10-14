import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildCursorFile, type CursorImage } from "./pe-resource-decoders.js";

export interface PeSection {
  name: string;
  virtualSize: number;
  virtualAddress: number;
  sizeOfRawData: number;
  pointerToRawData: number;
}

export interface PeResourceEntry {
  typeId: number;
  typeName: string;
  nameOrId: string | number;
  languageId: number;
  offset: number; // File offset
  size: number;
  dataRva: number;
}

export interface PeInfo {
  arch: "x86" | "x64" | "arm64" | "unknown";
  isDotNet: boolean;
  subsystem: number;
  sections: PeSection[];
  resources: PeResourceEntry[];
  framework: "Delphi" | ".NET" | "Electron" | "Qt" | "Rust" | "Go" | "Native C/C++" | "Unknown";
  /** .NET Core apphost found; true when a single-file bundle is attached (best effort) */
  dotNetSingleFile?: boolean;
}

/** Signature that the .NET Core apphost keeps right after the (8 byte) bundle header offset */
const DOTNET_BUNDLE_SIGNATURE = Buffer.from([
  0x8b, 0x12, 0x02, 0xb9, 0x6a, 0x61, 0x20, 0x38, 0x72, 0x7b, 0x93, 0x02, 0x14, 0xd7, 0xa0, 0x32, 0x13, 0xf5, 0xb9,
  0xe6, 0xef, 0xae, 0x33, 0x18, 0xee, 0x3b, 0x2d, 0xce, 0x24, 0xb3, 0x6a, 0xae
]);

const SAMPLE_HEAD_BYTES = 8 * 1024 * 1024;
const SAMPLE_TAIL_BYTES = 1024 * 1024;

export interface PeGroupExtractOptions {
  /** Only build these groups (default: all) */
  groups?: PeResourceEntry[];
  /** Output file name for a group (default: `<prefix>_<nameOrId>.<ext>`) */
  nameFor?: (group: PeResourceEntry) => string;
}

const RESOURCE_TYPE_NAMES: Record<number, string> = {
  1: "RT_CURSOR",
  2: "RT_BITMAP",
  3: "RT_ICON",
  4: "RT_MENU",
  5: "RT_DIALOG",
  6: "RT_STRING",
  7: "RT_FONTDIR",
  8: "RT_FONT",
  9: "RT_ACCELERATOR",
  10: "RT_RCDATA",
  11: "RT_MESSAGETABLE",
  12: "RT_GROUP_CURSOR",
  14: "RT_GROUP_ICON",
  16: "RT_VERSION",
  24: "RT_MANIFEST"
};

export class PeResourceParser {
  /**
   * Best-effort check for files that only an Electron app ships beside its executable
   */
  private static async hasElectronSiblings(exePath: string): Promise<boolean> {
    const dir = path.dirname(exePath);
    const markers = ["resources.pak", path.join("resources", "app.asar"), path.join("resources", "app")];
    const exists = async (base: string): Promise<boolean> => {
      for (const rel of markers) {
        try {
          await fs.access(path.join(base, rel));
          return true;
        } catch {
          // Keep looking
        }
      }
      return false;
    };
    if (await exists(dir)) return true;

    // Squirrel/Inno layouts (e.g. VS Code) keep the payload in a versioned or hashed subfolder
    try {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && (await exists(path.join(dir, entry.name)))) return true;
      }
    } catch {
      // Ignore
    }
    return false;
  }

  /**
   * Read the first 8MB and the last 1MB of the file (never the whole file)
   */
  private static async readSample(fileHandle: fs.FileHandle, size: number): Promise<Buffer> {
    const headLen = Math.min(size, SAMPLE_HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fileHandle.read(head, 0, headLen, 0);
    if (size <= SAMPLE_HEAD_BYTES) return head;

    const tailStart = Math.max(SAMPLE_HEAD_BYTES, size - SAMPLE_TAIL_BYTES);
    const tailLen = size - tailStart;
    const tail = Buffer.alloc(tailLen);
    await fileHandle.read(tail, 0, tailLen, tailStart);
    return Buffer.concat([head, Buffer.from([0]), tail]);
  }

  /**
   * Delphi / C++Builder executables carry PACKAGEINFO / DVCLAL RCDATA resources and TPF0 forms
   */
  private static async hasDelphiResources(fileHandle: fs.FileHandle, resources: PeResourceEntry[]): Promise<boolean> {
    const rcdata = resources.filter((r) => r.typeId === 10);
    if (rcdata.some((r) => typeof r.nameOrId === "string" && ["PACKAGEINFO", "DVCLAL"].includes(r.nameOrId.toUpperCase()))) {
      return true;
    }
    const magic = Buffer.alloc(4);
    for (const r of rcdata.slice(0, 256)) {
      if (r.size < 4) continue;
      await fileHandle.read(magic, 0, 4, r.offset);
      if (magic.readUInt32LE(0) === 0x30465054) return true;
    }
    return false;
  }

  /**
   * Parse PE headers, sections, and resource directory tree
   */
  static async parse(filePath: string): Promise<PeInfo | null> {
    let fileHandle: fs.FileHandle | undefined;
    try {
      fileHandle = await fs.open(filePath, "r");
      const stat = await fileHandle.stat();
      if (stat.size < 512) return null;

      // Read DOS header
      const dosBuf = Buffer.alloc(64);
      await fileHandle.read(dosBuf, 0, 64, 0);
      if (dosBuf.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"

      const peOffset = dosBuf.readInt32LE(0x3c);
      if (peOffset + 256 > stat.size) return null;

      // Read PE header + optional header
      const peBuf = Buffer.alloc(512);
      await fileHandle.read(peBuf, 0, 512, peOffset);

      if (peBuf.readUInt32LE(0) !== 0x00004550) return null; // "PE\0\0"

      const machine = peBuf.readUInt16LE(4);
      const numberOfSections = peBuf.readUInt16LE(6);
      const sizeOfOptionalHeader = peBuf.readUInt16LE(20);

      const arch: PeInfo["arch"] =
        machine === 0x8664 ? "x64" : machine === 0x014c ? "x86" : machine === 0xaa64 ? "arm64" : "unknown";

      const optMagic = peBuf.readUInt16LE(24);
      const isPE32Plus = optMagic === 0x020b;

      // Data directories start at 96 for PE32, 112 for PE32+ (relative to optional header start at offset 24)
      const dataDirsOffset = 24 + (isPE32Plus ? 112 : 96);
      let resourceRva = 0;
      let resourceSize = 0;
      let clrRva = 0;

      if (dataDirsOffset + 16 * 8 <= peBuf.length) {
        // Resource Directory is index 2
        resourceRva = peBuf.readUInt32LE(dataDirsOffset + 2 * 8);
        resourceSize = peBuf.readUInt32LE(dataDirsOffset + 2 * 8 + 4);

        // CLR Header is index 14
        clrRva = peBuf.readUInt32LE(dataDirsOffset + 14 * 8);
      }

      const isDotNet = clrRva > 0;

      // Read section headers
      const sectionHeadersStart = peOffset + 24 + sizeOfOptionalHeader;
      const sectionsBuf = Buffer.alloc(numberOfSections * 40);
      await fileHandle.read(sectionsBuf, 0, sectionsBuf.length, sectionHeadersStart);

      const sections: PeSection[] = [];
      for (let i = 0; i < numberOfSections; i++) {
        const sOff = i * 40;
        const nameRaw = sectionsBuf.subarray(sOff, sOff + 8);
        const nullIdx = nameRaw.indexOf(0);
        const name = (nullIdx >= 0 ? nameRaw.subarray(0, nullIdx) : nameRaw).toString("ascii");

        const virtualSize = sectionsBuf.readUInt32LE(sOff + 8);
        const virtualAddress = sectionsBuf.readUInt32LE(sOff + 12);
        const sizeOfRawData = sectionsBuf.readUInt32LE(sOff + 16);
        const pointerToRawData = sectionsBuf.readUInt32LE(sOff + 20);

        sections.push({
          name,
          virtualSize,
          virtualAddress,
          sizeOfRawData,
          pointerToRawData
        });
      }

      // Helper to map RVA to file offset
      const rvaToFileOffset = (rva: number): number | null => {
        for (const s of sections) {
          const sEnd = s.virtualAddress + Math.max(s.virtualSize, s.sizeOfRawData);
          if (rva >= s.virtualAddress && rva < sEnd) {
            return s.pointerToRawData + (rva - s.virtualAddress);
          }
        }
        return null;
      };

      const resources: PeResourceEntry[] = [];

      // Parse resource tree if resource table exists
      if (resourceRva > 0 && resourceSize > 0) {
        const rootOffset = rvaToFileOffset(resourceRva);
        if (rootOffset !== null && rootOffset + resourceSize <= stat.size) {
          // Read entire resource section
          const rsrcBuf = Buffer.alloc(resourceSize);
          await fileHandle.read(rsrcBuf, 0, resourceSize, rootOffset);

          // Level 1: Resource Types
          this.parseResourceDir(rsrcBuf, 0, (typeId, nameOrId, langId, dataRva, dataSize) => {
            const dataFileOffset = rvaToFileOffset(dataRva);
            if (dataFileOffset !== null) {
              resources.push({
                typeId: typeof typeId === "number" ? typeId : -1,
                typeName: typeof typeId === "number" ? RESOURCE_TYPE_NAMES[typeId] || `TYPE_${typeId}` : String(typeId),
                nameOrId,
                languageId: langId,
                offset: dataFileOffset,
                size: dataSize,
                dataRva
              });
            }
          });
        }
      }

      // Detect Framework
      let framework: PeInfo["framework"] = "Native C/C++";
      let dotNetSingleFile: boolean | undefined;
      if (isDotNet) {
        framework = ".NET";
      } else {
        const sample = await this.readSample(fileHandle, Number(stat.size));
        const sampleStr = sample.toString("latin1");

        const bundleIdx = sample.indexOf(DOTNET_BUNDLE_SIGNATURE);
        const delphiByResource = await this.hasDelphiResources(fileHandle, resources);

        if (bundleIdx >= 0) {
          framework = ".NET";
          dotNetSingleFile = bundleIdx >= 8 && sample.readBigUInt64LE(bundleIdx - 8) !== 0n;
        } else if (delphiByResource) {
          framework = "Delphi";
        } else if (
          sampleStr.includes("electron.app") ||
          sampleStr.includes("v8_context_snapshot.bin") ||
          sampleStr.includes("ELECTRON_RUN_AS_NODE")
        ) {
          framework = "Electron";
        } else if (/Qt[3-6]Core/i.test(sampleStr) || sampleStr.includes("qt_resource")) {
          framework = "Qt";
        } else if (sampleStr.includes("rust_begin_unwind") || sampleStr.includes("/rustc/")) {
          framework = "Rust";
        } else if (
          sampleStr.includes("Go build ID") ||
          sampleStr.includes("Go buildinf:") ||
          sampleStr.includes("runtime.main")
        ) {
          framework = "Go";
        } else if (sampleStr.includes("Borland") || sampleStr.includes("Delphi") || sampleStr.includes("TPF0")) {
          framework = "Delphi";
        } else if (sampleStr.includes("QtCore")) {
          framework = "Qt";
        }
      }

      // Electron apps ship Chromium's resources.pak / app.asar next to the executable
      if (framework === "Native C/C++" && (await this.hasElectronSiblings(filePath))) {
        framework = "Electron";
      }

      return {
        arch,
        isDotNet,
        subsystem: peBuf.readUInt16LE(24 + (isPE32Plus ? 68 : 68)),
        sections,
        resources,
        framework,
        ...(dotNetSingleFile !== undefined ? { dotNetSingleFile } : {})
      };
    } catch {
      return null;
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }

  /**
   * Traverse the 3-level PE resource directory tree
   */
  private static parseResourceDir(
    rsrc: Buffer,
    dirOffset: number,
    onLeaf: (typeId: number | string, nameOrId: number | string, langId: number, dataRva: number, dataSize: number) => void
  ): void {
    if (dirOffset + 16 > rsrc.length) return;

    const numNamed = rsrc.readUInt16LE(dirOffset + 12);
    const numId = rsrc.readUInt16LE(dirOffset + 14);
    const totalEntries = numNamed + numId;

    let entryOffset = dirOffset + 16;

    // Level 1: Types
    for (let i = 0; i < totalEntries; i++) {
      if (entryOffset + 8 > rsrc.length) break;

      const typeIdRaw = rsrc.readUInt32LE(entryOffset);
      const subOffsetRaw = rsrc.readUInt32LE(entryOffset + 4);
      entryOffset += 8;

      let typeVal: number | string = typeIdRaw;
      if ((typeIdRaw & 0x80000000) !== 0) {
        typeVal = this.readUnicodeString(rsrc, typeIdRaw & 0x7fffffff);
      }

      if ((subOffsetRaw & 0x80000000) !== 0) {
        const level2Offset = subOffsetRaw & 0x7fffffff;
        if (level2Offset + 16 > rsrc.length) continue;

        const l2NumNamed = rsrc.readUInt16LE(level2Offset + 12);
        const l2NumId = rsrc.readUInt16LE(level2Offset + 14);
        const l2Total = l2NumNamed + l2NumId;
        let l2EntryOffset = level2Offset + 16;

        // Level 2: Names / IDs
        for (let j = 0; j < l2Total; j++) {
          if (l2EntryOffset + 8 > rsrc.length) break;

          const nameIdRaw = rsrc.readUInt32LE(l2EntryOffset);
          const l2SubOffsetRaw = rsrc.readUInt32LE(l2EntryOffset + 4);
          l2EntryOffset += 8;

          let nameVal: number | string = nameIdRaw;
          if ((nameIdRaw & 0x80000000) !== 0) {
            nameVal = this.readUnicodeString(rsrc, nameIdRaw & 0x7fffffff);
          }

          if ((l2SubOffsetRaw & 0x80000000) !== 0) {
            const level3Offset = l2SubOffsetRaw & 0x7fffffff;
            if (level3Offset + 16 > rsrc.length) continue;

            const l3Total = rsrc.readUInt16LE(level3Offset + 12) + rsrc.readUInt16LE(level3Offset + 14);
            let l3EntryOffset = level3Offset + 16;

            // Level 3: Languages
            for (let k = 0; k < l3Total; k++) {
              if (l3EntryOffset + 8 > rsrc.length) break;

              const langId = rsrc.readUInt32LE(l3EntryOffset);
              const dataEntryOffset = rsrc.readUInt32LE(l3EntryOffset + 4);
              l3EntryOffset += 8;

              // Data entry leaf
              if ((dataEntryOffset & 0x80000000) === 0 && dataEntryOffset + 16 <= rsrc.length) {
                const dataRva = rsrc.readUInt32LE(dataEntryOffset);
                const dataSize = rsrc.readUInt32LE(dataEntryOffset + 4);
                onLeaf(typeVal, nameVal, langId, dataRva, dataSize);
              }
            }
          }
        }
      }
    }
  }

  private static readUnicodeString(rsrc: Buffer, strOffset: number): string {
    if (strOffset + 2 > rsrc.length) return "UNKNOWN";
    const len = rsrc.readUInt16LE(strOffset);
    if (strOffset + 2 + len * 2 > rsrc.length) return "UNKNOWN";
    return rsrc.subarray(strOffset + 2, strOffset + 2 + len * 2).toString("utf16le");
  }

  /**
   * Index single-image resources (RT_ICON / RT_CURSOR) by id; the group language is preferred
   */
  private static indexImages(resources: PeResourceEntry[], typeId: number) {
    const byId = new Map<number, PeResourceEntry[]>();
    for (const r of resources) {
      if (r.typeId === typeId && typeof r.nameOrId === "number") {
        const list = byId.get(r.nameOrId) ?? [];
        list.push(r);
        byId.set(r.nameOrId, list);
      }
    }
    return (id: number, languageId: number): PeResourceEntry | undefined => {
      const list = byId.get(id);
      return list?.find((r) => r.languageId === languageId) ?? list?.[0];
    };
  }

  /**
   * Reconstruct standalone Windows .ico files from RT_GROUP_ICON and RT_ICON resources
   */
  static async extractIcons(
    filePath: string,
    resources: PeResourceEntry[],
    options: PeGroupExtractOptions = {}
  ): Promise<Array<{ name: string; buffer: Buffer; group: PeResourceEntry }>> {
    const groupIcons = options.groups ?? resources.filter((r) => r.typeId === 14); // RT_GROUP_ICON
    if (groupIcons.length === 0) return [];
    const findIcon = this.indexImages(resources, 3);

    let fileHandle: fs.FileHandle | undefined;
    const icons: Array<{ name: string; buffer: Buffer; group: PeResourceEntry }> = [];

    try {
      fileHandle = await fs.open(filePath, "r");

      for (const grp of groupIcons) {
        const grpBuf = Buffer.alloc(grp.size);
        await fileHandle.read(grpBuf, 0, grp.size, grp.offset);

        if (grpBuf.length < 6) continue;
        const count = grpBuf.readUInt16LE(4);

        if (grpBuf.length < 6 + count * 14) continue;

        // Collect all icon images for this group
        const imageBuffers: Buffer[] = [];
        const dirEntries: Buffer[] = [];
        let runningOffset = 6 + count * 16; // ICONDIR (6) + N * ICONDIRENTRY (16)

        for (let i = 0; i < count; i++) {
          const entryOff = 6 + i * 14;
          const iconId = grpBuf.readUInt16LE(entryOff + 12);
          const iconRes = findIcon(iconId, grp.languageId);

          if (!iconRes) continue;

          const imgBuf = Buffer.alloc(iconRes.size);
          await fileHandle.read(imgBuf, 0, iconRes.size, iconRes.offset);

          // Build 16-byte ICONDIRENTRY
          const dirEntry = Buffer.alloc(16);
          // Copy width, height, colorCount, reserved, planes, bitCount, bytesInRes
          grpBuf.copy(dirEntry, 0, entryOff, entryOff + 12);
          dirEntry.writeUInt32LE(runningOffset, 12); // Image data offset

          dirEntries.push(dirEntry);
          imageBuffers.push(imgBuf);
          runningOffset += imgBuf.length;
        }

        if (imageBuffers.length > 0) {
          const header = Buffer.alloc(6);
          header.writeUInt16LE(0, 0); // reserved
          header.writeUInt16LE(1, 2); // type 1 = icon
          header.writeUInt16LE(dirEntries.length, 4);

          const fullIco = Buffer.concat([header, ...dirEntries, ...imageBuffers]);
          icons.push({
            name: options.nameFor ? options.nameFor(grp) : `icon_${grp.nameOrId}.ico`,
            buffer: fullIco,
            group: grp
          });
        }
      }

      return icons;
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }

  /**
   * Reconstruct standalone .cur files from RT_GROUP_CURSOR and RT_CURSOR resources
   */
  static async extractCursors(
    filePath: string,
    resources: PeResourceEntry[],
    options: PeGroupExtractOptions = {}
  ): Promise<Array<{ name: string; buffer: Buffer; group: PeResourceEntry }>> {
    const groups = options.groups ?? resources.filter((r) => r.typeId === 12); // RT_GROUP_CURSOR
    if (groups.length === 0) return [];
    const findCursor = this.indexImages(resources, 1);

    let fileHandle: fs.FileHandle | undefined;
    const cursors: Array<{ name: string; buffer: Buffer; group: PeResourceEntry }> = [];

    try {
      fileHandle = await fs.open(filePath, "r");

      for (const grp of groups) {
        const grpBuf = Buffer.alloc(grp.size);
        await fileHandle.read(grpBuf, 0, grp.size, grp.offset);
        if (grpBuf.length < 6) continue;
        const count = grpBuf.readUInt16LE(4);
        if (grpBuf.length < 6 + count * 14) continue;

        const images: CursorImage[] = [];
        for (let i = 0; i < count; i++) {
          // GRPCURSORDIRENTRY: width(2) height(2) planes(2) bitCount(2) bytesInRes(4) id(2)
          const entryOff = 6 + i * 14;
          const cursorRes = findCursor(grpBuf.readUInt16LE(entryOff + 12), grp.languageId);
          if (!cursorRes) continue;

          const payload = Buffer.alloc(cursorRes.size);
          await fileHandle.read(payload, 0, cursorRes.size, cursorRes.offset);
          images.push({
            width: grpBuf.readUInt16LE(entryOff),
            height: grpBuf.readUInt16LE(entryOff + 2),
            payload
          });
        }

        const cur = buildCursorFile(images);
        if (cur) {
          cursors.push({
            name: options.nameFor ? options.nameFor(grp) : `cursor_${grp.nameOrId}.cur`,
            buffer: cur,
            group: grp
          });
        }
      }

      return cursors;
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }
}

import * as fs from "node:fs/promises";
import * as path from "node:path";

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
  framework: "Delphi" | ".NET" | "Electron" | "Qt" | "Native C/C++" | "Unknown";
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
      if (isDotNet) {
        framework = ".NET";
      } else {
        // Sample strings in binary for Delphi / Qt / Electron
        const sampleSize = Math.min(Number(stat.size), 8 * 1024 * 1024);
        const sampleBuf = Buffer.alloc(sampleSize);
        await fileHandle.read(sampleBuf, 0, sampleSize, 0);
        const sampleStr = sampleBuf.toString("latin1");

        if (sampleStr.includes("Borland") || sampleStr.includes("Delphi") || sampleStr.includes("TPF0")) {
          framework = "Delphi";
        } else if (sampleStr.includes("electron.app") || sampleStr.includes("v8_context_snapshot.bin")) {
          framework = "Electron";
        } else if (sampleStr.includes("Qt5Core.dll") || sampleStr.includes("Qt6Core.dll") || sampleStr.includes("QtCore")) {
          framework = "Qt";
        }
      }

      return {
        arch,
        isDotNet,
        subsystem: peBuf.readUInt16LE(24 + (isPE32Plus ? 68 : 68)),
        sections,
        resources,
        framework
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
   * Reconstruct standalone Windows .ico files from RT_GROUP_ICON and RT_ICON resources
   */
  static async extractIcons(
    filePath: string,
    resources: PeResourceEntry[]
  ): Promise<Array<{ name: string; buffer: Buffer }>> {
    const groupIcons = resources.filter((r) => r.typeId === 14); // RT_GROUP_ICON
    const singleIcons = new Map<number, PeResourceEntry>();

    for (const r of resources) {
      if (r.typeId === 3 && typeof r.nameOrId === "number") {
        singleIcons.set(r.nameOrId, r);
      }
    }

    if (groupIcons.length === 0) return [];

    let fileHandle: fs.FileHandle | undefined;
    const icons: Array<{ name: string; buffer: Buffer }> = [];

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
          const iconRes = singleIcons.get(iconId);

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
            name: `icon_${grp.nameOrId}.ico`,
            buffer: fullIco
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
}

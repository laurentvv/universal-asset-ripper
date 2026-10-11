import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { PeResourceParser } from "../src/parsers/pe/pe-resource-parser.js";
import { PeSoftwareAdapter } from "../src/adapters/pe-adapter.js";
import { AdapterRegistry } from "../src/adapters/index.js";

describe("PeResourceParser & PeSoftwareAdapter", () => {
  let tmpDir: string;
  let mockExePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pe-test-"));
    mockExePath = path.join(tmpDir, "test_app.exe");

    // Construct a minimal valid PE32+ (x64) executable with a .rsrc section
    // DOS Header: 64 bytes
    const dos = Buffer.alloc(128);
    dos.writeUInt16LE(0x5a4d, 0); // "MZ"
    dos.writeInt32LE(128, 0x3c); // e_lfanew = 128

    // PE Header at offset 128
    // PE Signature (4 bytes) = 0x00004550
    // COFF Header (20 bytes)
    // Optional Header (240 bytes for PE32+)
    const pe = Buffer.alloc(4 + 20 + 240);
    pe.writeUInt32LE(0x00004550, 0); // "PE\0\0"
    pe.writeUInt16LE(0x8664, 4); // Machine = AMD64 (x64)
    pe.writeUInt16LE(1, 6); // NumberOfSections = 1
    pe.writeUInt16LE(240, 20); // SizeOfOptionalHeader = 240

    // Optional Header
    pe.writeUInt16LE(0x020b, 24); // Magic = PE32+
    // Data directories start at offset 24 + 112 = 136 in pe buffer
    // Directory index 2 = Resource Table: RVA = 0x2000, Size = 128
    pe.writeUInt32LE(0x2000, 136 + 2 * 8);
    pe.writeUInt32LE(128, 136 + 2 * 8 + 4);

    // Section Header 1 (40 bytes)
    const sec = Buffer.alloc(40);
    sec.write(".rsrc\0\0\0", 0, "ascii");
    sec.writeUInt32LE(0x1000, 8); // VirtualSize
    sec.writeUInt32LE(0x2000, 12); // VirtualAddress (RVA)
    sec.writeUInt32LE(512, 16); // SizeOfRawData
    const fileOffsetRsrc = 128 + pe.length + sec.length; // PointerToRawData
    sec.writeUInt32LE(fileOffsetRsrc, 20);

    // Resource section payload (512 bytes)
    const rsrcPayload = Buffer.alloc(512);
    // Level 1: 1 Type: RT_MANIFEST (24)
    rsrcPayload.writeUInt16LE(0, 12); // numNamed
    rsrcPayload.writeUInt16LE(1, 14); // numId = 1
    rsrcPayload.writeUInt32LE(24, 16); // Type 24 (RT_MANIFEST)
    rsrcPayload.writeUInt32LE(0x80000000 + 32, 20); // Subdir at offset 32

    // Level 2 (offset 32): 1 Name: ID 1
    rsrcPayload.writeUInt16LE(0, 32 + 12);
    rsrcPayload.writeUInt16LE(1, 32 + 14);
    rsrcPayload.writeUInt32LE(1, 48); // Name ID = 1
    rsrcPayload.writeUInt32LE(0x80000000 + 64, 52); // Subdir at offset 64

    // Level 3 (offset 64): 1 Language: ID 0
    rsrcPayload.writeUInt16LE(0, 64 + 12);
    rsrcPayload.writeUInt16LE(1, 64 + 14);
    rsrcPayload.writeUInt32LE(0, 80); // Lang ID 0
    rsrcPayload.writeUInt32LE(96, 84); // Data entry at offset 96 (leaf)

    // Data entry leaf (offset 96): 16 bytes
    // Data RVA = 0x2000 + 200 = 0x20C8
    rsrcPayload.writeUInt32LE(0x20c8, 96);
    const manifestContent = Buffer.from("<assembly/>", "utf-8");
    rsrcPayload.writeUInt32LE(manifestContent.length, 100);

    // Write manifest content at offset 200 in rsrcPayload
    manifestContent.copy(rsrcPayload, 200);

    const fullBinary = Buffer.concat([dos, pe, sec, rsrcPayload]);
    await fs.writeFile(mockExePath, fullBinary);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("should parse PE resources and architecture correctly", async () => {
    const info = await PeResourceParser.parse(mockExePath);
    expect(info).not.toBeNull();
    expect(info!.arch).toBe("x64");
    expect(info!.resources).toHaveLength(1);
    expect(info!.resources[0].typeName).toBe("RT_MANIFEST");
    expect(info!.resources[0].size).toBe(Buffer.from("<assembly/>").length);
  });

  it("should inspect PE software executable via PeSoftwareAdapter", async () => {
    const adapter = new PeSoftwareAdapter();
    const canHandle = await adapter.canHandle(mockExePath);
    expect(canHandle).toBe(true);

    const manifest = await adapter.inspect(mockExePath);
    expect(manifest.engine).toBe("pe-software");
    expect(manifest.totalFiles).toBe(1);
    expect(manifest.byCategory.config.count).toBe(1);
  });

  it("should extract resources from PE software application", async () => {
    const adapter = new PeSoftwareAdapter();
    const outDir = path.join(tmpDir, "extracted");
    const result = await adapter.extract(mockExePath, { outputDir: outDir });

    expect(result.success).toBe(true);
    expect(result.extractedCount).toBe(1);

    const manifestFile = path.join(outDir, "manifest", "manifest_1.xml");
    const content = await fs.readFile(manifestFile, "utf-8");
    expect(content).toBe("<assembly/>");
  });

  it("should resolve PeSoftwareAdapter from AdapterRegistry", async () => {
    const { adapter, engine } = await AdapterRegistry.resolveAdapter(mockExePath);
    expect(engine).toBe("pe-software");
    expect(adapter.engine).toBe("pe-software");
  });
});

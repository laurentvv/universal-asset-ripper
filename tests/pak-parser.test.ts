import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { UnrealPakParser, UE_PAK_MAGIC } from "../src/parsers/unreal/pak-parser.js";

/** Real UE pak footer (repak footer.rs): [guid16 v7+][enc u8 v4+][magic][ver][off][size][hash20][frozen v9][names] */
function buildFooter(version: number, opts: { encrypted?: boolean; names?: string[]; nameSlots?: number }): Buffer {
  const parts: Buffer[] = [];
  if (version >= 7) parts.push(Buffer.alloc(16));
  if (version >= 4) parts.push(Buffer.from([opts.encrypted ? 1 : 0]));
  const core = Buffer.alloc(4 + 4 + 8 + 8 + 20);
  core.writeUInt32LE(UE_PAK_MAGIC, 0);
  core.writeInt32LE(version, 4);
  core.writeBigInt64LE(1000n, 8);
  core.writeBigInt64LE(4096n, 16);
  parts.push(core);
  if (version === 9) parts.push(Buffer.alloc(1)); // frozen index flag
  const slots = opts.nameSlots ?? (version >= 8 ? 5 : 0);
  const names = Buffer.alloc(slots * 32);
  (opts.names ?? []).forEach((n, i) => names.write(n, i * 32, "ascii"));
  parts.push(names);
  return Buffer.concat(parts);
}

describe("UnrealPakParser.readPakInfo", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pak-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function readFooter(footer: Buffer) {
    const p = path.join(tmpDir, "t.pak");
    await fs.writeFile(p, Buffer.concat([Buffer.alloc(5000), footer]));
    return UnrealPakParser.readPakInfo(p);
  }

  it("reads a v11 footer that is not encrypted, with Zlib/Oodle names", async () => {
    const info = await readFooter(buildFooter(11, { encrypted: false, names: ["Zlib", "Oodle"] }));
    expect(info).toMatchObject({ version: 11, isEncrypted: false, indexOffset: 1000n, indexSize: 4096n });
    expect(info!.compressionMethods).toEqual(["Zlib", "Oodle"]);
  });

  it("reads a v11 footer with an encrypted index and no compression names", async () => {
    const info = await readFooter(buildFooter(11, { encrypted: true }));
    expect(info).toMatchObject({ version: 11, isEncrypted: true, indexOffset: 1000n, indexSize: 4096n });
    expect(info!.compressionMethods).toEqual([]);
  });

  it("reads a v11 footer with an encrypted index and Zlib/Oodle names", async () => {
    const info = await readFooter(buildFooter(11, { encrypted: true, names: ["Zlib", "Oodle"] }));
    expect(info?.isEncrypted).toBe(true);
    expect(info?.compressionMethods).toEqual(["Zlib", "Oodle"]);
  });

  it("handles older layouts: v3 (no encrypted byte), v6 (no GUID), v8A (4 names), v9 (frozen byte)", async () => {
    expect(await readFooter(buildFooter(3, {}))).toMatchObject({ version: 3, isEncrypted: false, indexOffset: 1000n });
    expect(await readFooter(buildFooter(6, { encrypted: true }))).toMatchObject({ version: 6, isEncrypted: true, indexSize: 4096n });
    const v8a = await readFooter(buildFooter(8, { encrypted: false, names: ["Zlib"], nameSlots: 4 }));
    expect(v8a).toMatchObject({ version: 8, isEncrypted: false });
    expect(v8a!.compressionMethods).toEqual(["Zlib"]);
    const v9 = await readFooter(buildFooter(9, { encrypted: true, names: ["Oodle"] }));
    expect(v9).toMatchObject({ version: 9, isEncrypted: true, indexOffset: 1000n });
    expect(v9!.compressionMethods).toEqual(["Oodle"]);
  });

  it("rejects an unknown version instead of defaulting to 8", async () => {
    expect(await readFooter(buildFooter(99, {}))).toBeNull();
    expect(await readFooter(buildFooter(0, {}))).toBeNull();
  });

  it("returns null for files without the pak magic (e.g. Chromium .pak)", async () => {
    const p = path.join(tmpDir, "resources.pak");
    await fs.writeFile(p, Buffer.alloc(4096, 1));
    expect(await UnrealPakParser.readPakInfo(p)).toBeNull();
  });
});

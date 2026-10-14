/**
 * Test-only writers for Electron .asar archives and Chromium .pak data packs.
 */

export type AsarSpec =
  | Buffer
  | string
  | { unpacked: true; size: number }
  | { link: string }
  | { [name: string]: AsarSpec };

const isLeafObject = (v: object): v is { unpacked: true; size: number } | { link: string } =>
  "unpacked" in v || "link" in v;

/** Build an asar: nested objects are folders, Buffer/string are files, { unpacked, size } and { link } are special */
export function buildAsar(tree: { [name: string]: AsarSpec }, rawHeaderOverride?: unknown): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;

  const toNode = (spec: AsarSpec): unknown => {
    if (Buffer.isBuffer(spec) || typeof spec === "string") {
      const data = Buffer.isBuffer(spec) ? spec : Buffer.from(spec);
      const node = { size: data.length, offset: String(offset) };
      chunks.push(data);
      offset += data.length;
      return node;
    }
    if (isLeafObject(spec)) {
      return "link" in spec ? { link: spec.link } : { size: spec.size, unpacked: true };
    }
    const files: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(spec)) files[name] = toNode(child);
    return { files };
  };

  const header = rawHeaderOverride ?? toNode(tree);
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const padded = Math.ceil(json.length / 4) * 4;
  const payloadSize = 4 + padded;
  const headerSize = 4 + payloadSize;

  const head = Buffer.alloc(8 + headerSize);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerSize, 4);
  head.writeUInt32LE(payloadSize, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  return Buffer.concat([head, ...chunks]);
}

export interface ChromiumPakSpec {
  version?: 3 | 4 | 5;
  encoding?: number;
  resources: Array<{ id: number; data: Buffer | string }>;
  /** v5 only: alias id -> id of an existing resource */
  aliases?: Array<{ id: number; of: number }>;
}

export function buildChromiumPak(spec: ChromiumPakSpec): Buffer {
  const version = spec.version ?? 5;
  const encoding = spec.encoding ?? 1;
  const resources = [...spec.resources].sort((a, b) => a.id - b.id);
  const aliases = [...(spec.aliases ?? [])].sort((a, b) => a.id - b.id);
  const count = resources.length;

  let header: Buffer;
  if (version === 4) {
    header = Buffer.alloc(9);
    header.writeUInt32LE(4, 0);
    header.writeUInt32LE(count, 4);
    header.writeUInt8(encoding, 8);
  } else if (version === 5) {
    header = Buffer.alloc(12);
    header.writeUInt32LE(5, 0);
    header.writeUInt8(encoding, 4);
    header.writeUInt16LE(count, 8);
    header.writeUInt16LE(aliases.length, 10);
  } else {
    header = Buffer.alloc(12);
    header.writeUInt32LE(3, 0);
    header.writeUInt32LE(encoding, 4);
    header.writeUInt32LE(count, 8);
  }

  const tableLen = (count + 1) * 6;
  const aliasLen = version === 5 ? aliases.length * 4 : 0;
  let cursor = header.length + tableLen + aliasLen;
  const table = Buffer.alloc(tableLen);
  const datas: Buffer[] = [];
  resources.forEach((r, i) => {
    const data = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data);
    table.writeUInt16LE(r.id, i * 6);
    table.writeUInt32LE(cursor, i * 6 + 2);
    datas.push(data);
    cursor += data.length;
  });
  table.writeUInt16LE(0, count * 6);
  table.writeUInt32LE(cursor, count * 6 + 2);

  const aliasTable = Buffer.alloc(aliasLen);
  if (version === 5) {
    aliases.forEach((a, i) => {
      aliasTable.writeUInt16LE(a.id, i * 4);
      aliasTable.writeUInt16LE(resources.findIndex((r) => r.id === a.of), i * 4 + 2);
    });
  }
  return Buffer.concat([header, table, aliasTable, ...datas]);
}

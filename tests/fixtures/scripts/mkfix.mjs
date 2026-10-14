import * as fs from "node:fs/promises"; import * as path from "node:path";
const SP = process.argv[2];
const GDPC = 0x43504447;
// synthetic Godot PCK v1 (same layout as the repo's own test) with arbitrary entry names
function pckV1(entries) {
  const head = Buffer.alloc(88); head.writeUInt32LE(GDPC, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(3, 8); head.writeUInt32LE(5, 12); head.writeUInt32LE(2, 16); head.writeUInt32LE(entries.length, 84);
  let idxLen = 0; const idx = entries.map(e => { const p = Buffer.from(e.name, "utf-8"); idxLen += 4 + p.length + 32; return { p, data: Buffer.from(e.data) }; });
  let ofs = 88 + idxLen; const parts = [head];
  for (const e of idx) { const l = Buffer.alloc(4); l.writeUInt32LE(e.p.length); const m = Buffer.alloc(32); m.writeBigInt64LE(BigInt(ofs), 0); m.writeBigInt64LE(BigInt(e.data.length), 8); parts.push(l, e.p, m); ofs += e.data.length; }
  for (const e of idx) parts.push(e.data);
  return Buffer.concat(parts);
}
await fs.mkdir(`${SP}/trav/a/b`, { recursive: true });
await fs.writeFile(`${SP}/trav/evil.pck`, pckV1([
  { name: "res://ok/fine.txt", data: "fine" },
  { name: "res://../../evil_dotdot.txt", data: "ESCAPED?" },
  { name: "res://..\..\evil_backslash.txt", data: "ESCAPED?" },
  { name: "res:///evil_abs.txt", data: "ABS" },
  { name: "res://C:/evil_drive.txt", data: "DRIVE" },
  { name: "res://stream.txt:hidden", data: "ADS" },
]));
// 100k-entry PCK for timing
const many = []; for (let i = 0; i < 100000; i++) many.push({ name: `res://dir${i % 100}/file_${i}.png`, data: "x" });
await fs.writeFile(`${SP}/big100k.pck`, pckV1(many));
// two-game directory + generic-name false positives
await fs.mkdir(`${SP}/fp/myapp_data`, { recursive: true });
await fs.mkdir(`${SP}/fp2/Content`, { recursive: true });
await fs.mkdir(`${SP}/fp2/Engine`, { recursive: true });
// fake pak with arbitrary content for the repak injection test
await fs.writeFile(`${SP}/inj.pak`, Buffer.alloc(2048));
console.log("fixtures ok");

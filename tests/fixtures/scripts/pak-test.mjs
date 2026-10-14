import { UnrealPakParser } from "file:///C:/GIT/universal-asset-ripper/dist/parsers/unreal/pak-parser.js";
import * as fs from "node:fs/promises";
const sp = process.argv[2];
// Real v11 footer (221 bytes) per trumank/repak footer.rs: [guid16][enc1][magic4][ver4][idxOff8][idxSize8][hash20][5 x 32 names]
function footerV11({ encrypted, names }) {
  const f = Buffer.alloc(221); let o = 16;
  f.writeUInt8(encrypted ? 1 : 0, o); o += 1;
  f.writeUInt32LE(0x5a6f12e1, o); o += 4;
  f.writeInt32LE(11, o); o += 4;
  f.writeBigInt64LE(1000n, o); o += 8;
  f.writeBigInt64LE(4096n, o); o += 8;
  o += 20; // hash
  names.forEach((n, i) => f.write(n, o + i * 32, "ascii"));
  return f;
}
const cases = [
  ["v11 NOT encrypted, names Zlib/Oodle", { encrypted: false, names: ["Zlib", "Oodle"] }],
  ["v11 ENCRYPTED index, no compression names", { encrypted: true, names: [] }],
  ["v11 ENCRYPTED index, names Zlib/Oodle", { encrypted: true, names: ["Zlib", "Oodle"] }],
];
for (const [label, c] of cases) {
  const p = `${sp}/t_v11.pak`; await fs.writeFile(p, Buffer.concat([Buffer.alloc(5000), footerV11(c)]));
  const i = await UnrealPakParser.readPakInfo(p);
  console.log(`${label.padEnd(44)} truth.encrypted=${String(c.encrypted).padEnd(5)} tool.isEncrypted=${i?.isEncrypted} version=${i?.version} indexOffset=${i?.indexOffset} indexSize=${i?.indexSize}`);
}

/** Smallest PE32+ image the parser accepts (no sections, no resources) */
export function minimalPe(): Buffer {
  const buf = Buffer.alloc(1024);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeInt32LE(128, 0x3c);
  buf.writeUInt32LE(0x00004550, 128);
  buf.writeUInt16LE(0x8664, 128 + 4);
  buf.writeUInt16LE(240, 128 + 20);
  buf.writeUInt16LE(0x020b, 128 + 24);
  return buf;
}

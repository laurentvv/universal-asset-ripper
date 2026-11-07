/**
 * BPTC block decoders: BC7 (8-bit RGBA) and BC6H (half-float RGB, tone-mapped to 8-bit sRGB).
 *
 * Clean-room TypeScript port of the Khronos Data Format Specification's "BPTC Compressed
 * Texture Image Formats" section, following the reference implementation in craft-anything
 * (crates/formats/src/bptc.rs, commit fc93bd0, MIT OR Apache-2.0). Each 16-byte block holds
 * 4x4 texels, row by row; tables are the specification's, numbered as it numbers them.
 */

/** A block's 128 bits, read from the lowest up (four little-endian 32-bit words). */
class Bits {
  pos = 0;

  constructor(private readonly words: Uint32Array) {}

  static of(block: Buffer | Uint8Array): Bits {
    const words = new Uint32Array(4);
    for (let i = 0; i < 4; i++) {
      words[i] = block[i * 4]! + block[i * 4 + 1]! * 0x100 + block[i * 4 + 2]! * 0x10000 + block[i * 4 + 3]! * 0x1000000;
    }
    return new Bits(words);
  }

  /** The next n bits (at most 16), as a number. */
  take(n: number): number {
    const word = this.pos >> 5;
    const shift = this.pos & 31;
    // Low part of the current word, then the high bits from the next word when the field
    // straddles the boundary; float arithmetic stays exact below 2^53.
    let v = this.words[word]! >>> shift;
    if (shift + n > 32) v += (this.words[word + 1] ?? 0) * 2 ** (32 - shift);
    this.pos += n;
    return v % 2 ** n;
  }
}

/** Interpolation weights by index bits (Table 119). */
const WEIGHTS_2 = [0, 21, 43, 64];
const WEIGHTS_3 = [0, 9, 18, 27, 37, 46, 55, 64];
const WEIGHTS_4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

function weight(indexBits: number, index: number): number {
  const table = indexBits === 2 ? WEIGHTS_2 : indexBits === 3 ? WEIGHTS_3 : WEIGHTS_4;
  return table[index] ?? 0;
}

/** Equation 2: a value between two endpoints. */
function interpolate(e0: number, e1: number, w: number): number {
  return ((64 - w) * e0 + w * e1 + 32) >> 6;
}

/** Which subset texel i is in, for a block with 2 or 3 subsets and the given partition. */
function subset(subsets: number, partition: number, i: number): number {
  if (subsets === 2) return (PARTITIONS_2[partition]! >>> i) & 1;
  if (subsets === 3) return (PARTITIONS_3[partition]! >>> (2 * i)) & 3;
  return 0;
}

/** Whether texel i is an anchor (its index is stored with one bit fewer). */
function anchor(subsets: number, partition: number, i: number): boolean {
  if (i === 0) return true;
  if (subsets === 2) return ANCHOR_2[partition] === i;
  if (subsets === 3) return ANCHOR_3_SECOND[partition] === i || ANCHOR_3_THIRD[partition] === i;
  return false;
}

/** The 16 indices of a block, each `bits` wide (anchors one fewer). */
function indices(r: Bits, bits: number, subsets: number, partition: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 16; i++) out.push(r.take(bits - (anchor(subsets, partition, i) ? 1 : 0)));
  return out;
}

/**
 * BC7's modes (Table 109): subsets, partition bits, rotation bits, index selection bits,
 * colour bits, alpha bits, per-endpoint P-bits, shared P-bits, index bits, secondary index bits.
 */
const BC7_MODES: ReadonlyArray<readonly [number, number, number, number, number, number, number, number, number, number]> = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0]
];

/**
 * Decode one BC7 block into 16 RGBA texels (written into `out` at `outAt`, 4 bytes each).
 * A reserved mode (low byte 0) gives all zeros.
 */
export function decodeBc7Block(block: Buffer | Uint8Array, out: Uint8Array, outAt: number): void {
  out.fill(0, outAt, outAt + 64);
  const mode = block[0] === 0 ? 8 : 31 - Math.clz32(block[0]! & -block[0]!);
  const spec = BC7_MODES[mode];
  if (!spec) return;
  const [subsets, partitionBits, rotationBits, selectionBits, colourBits, alphaBits, endpointP, sharedP, indexBits, index2Bits] = spec;

  const r = Bits.of(block);
  r.pos = mode + 1;
  const partition = r.take(partitionBits);
  const rotation = r.take(rotationBits);
  const swapped = r.take(selectionBits) === 1;
  const ends = subsets * 2;

  // Endpoints: every endpoint's red, then green, blue and alpha; then the P-bits.
  const raw: number[][] = Array.from({ length: 6 }, () => [0, 0, 0, 0]);
  for (let channel = 0; channel < 4; channel++) {
    const bits = channel < 3 ? colourBits : alphaBits;
    for (let e = 0; e < ends; e++) raw[e]![channel] = bits > 0 ? r.take(bits) : 0;
  }
  const p = [0, 0, 0, 0, 0, 0];
  if (endpointP === 1) {
    for (let e = 0; e < ends; e++) p[e] = r.take(1);
  }
  if (sharedP === 1) {
    for (let s = 0; s < subsets; s++) {
      const bit = r.take(1);
      p[s * 2] = bit;
      p[s * 2 + 1] = bit;
    }
  }
  const hasP = endpointP + sharedP > 0;

  const endpoints: number[][] = Array.from({ length: 6 }, (_, e) =>
    Array.from({ length: 4 }, (_, channel) => {
      const bits = channel < 3 ? colourBits : alphaBits;
      const v = raw[e]![channel]!;
      if (bits === 0) return 255;
      const [value, width] = hasP ? [(v << 1) | p[e]!, bits + 1] : [v, bits];
      // The stored bits are a byte's top bits; its top bits repeat into the rest.
      return (value << (8 - width)) | (value >> (2 * width - 8));
    })
  );

  const primary = indices(r, indexBits, subsets, partition);
  const secondary = index2Bits > 0 ? indices(r, index2Bits, 1, 0) : new Array(16).fill(0);
  const colour = swapped ? secondary : primary;
  const colourIndexBits = swapped ? index2Bits : indexBits;
  const alpha = index2Bits > 0 && !swapped ? secondary : primary;
  const alphaIndexBits = index2Bits > 0 && !swapped ? index2Bits : indexBits;

  for (let i = 0; i < 16; i++) {
    const s = subset(subsets, partition, i);
    const e0 = endpoints[s * 2] ?? [0, 0, 0, 0];
    const e1 = endpoints[s * 2 + 1] ?? [0, 0, 0, 0];
    const wc = weight(colourIndexBits, colour[i]!);
    const wa = weight(alphaIndexBits, alpha[i]!);
    const px = [interpolate(e0[0]!, e1[0]!, wc), interpolate(e0[1]!, e1[1]!, wc), interpolate(e0[2]!, e1[2]!, wc), interpolate(e0[3]!, e1[3]!, wa)];
    if (rotation >= 1 && rotation <= 3) {
      const t = px[rotation - 1]!;
      px[rotation - 1] = px[3]!;
      px[3] = t;
    }
    const at = outAt + i * 4;
    out[at] = px[0]!;
    out[at + 1] = px[1]!;
    out[at + 2] = px[2]!;
    out[at + 3] = px[3]!;
  }
}

// -------------------------------------------------------------------------------------------
// BC6H
// -------------------------------------------------------------------------------------------

// BC6H's fields: endpoint e's red, green and blue are fields 3e, 3e + 1 and 3e + 2.
const R0 = 0, G0 = 1, B0 = 2, R1 = 3, G1 = 4, B1 = 5, R2 = 6, G2 = 7, B2 = 8, R3 = 9, G3 = 10, B3 = 11;
/** The partition number. */
const PB = 12;

/** A BC6H mode (Tables 121 and 122). */
interface Bc6hMode {
  id: number;
  /** Endpoints after the first are stored as differences from it. */
  transformed: boolean;
  subsets: number;
  endpointBits: number;
  /** Red, green and blue bits of the endpoints after the first. */
  deltaBits: [number, number, number];
  /**
   * After the mode bits, in block order: [field, a, b] is the spec's "field a..b", so the next
   * |a - b| + 1 bits of the block go to the field's bits b, b ± 1, …, a.
   */
  fields: ReadonlyArray<readonly [number, number, number]>;
}

function signExtend(v: number, bits: number): number {
  return (v << (32 - bits)) >> (32 - bits);
}

/** An endpoint value stretched to 16 bits (the unquantization pseudocode). */
function unquantize(x: number, bits: number, signed: boolean): number {
  const n = bits;
  if (!signed) {
    if (n >= 15) return x;
    if (x === 0) return 0;
    if (x === (1 << n) - 1) return 0xffff;
    return ((x << 15) + 0x4000) >> (n - 1);
  }
  if (n >= 16) return x;
  const magnitude =
    Math.abs(x) === 0 ? 0 : Math.abs(x) >= (1 << (n - 1)) - 1 ? 0x7fff : ((Math.abs(x) << 15) + 0x4000) >> (n - 1);
  return x < 0 ? -magnitude : magnitude;
}

/** An interpolated value as a half float's bits. */
function finishHalf(i: number, signed: boolean): number {
  if (!signed) return ((i * 31) >> 6) & 0xffff;
  return i < 0 ? (((-i * 31) >> 5) | 0x8000) & 0xffff : ((i * 31) >> 5) & 0xffff;
}

/** The 16 RGB texels of a BC6H block as half floats' bits; a reserved mode gives black. */
function bc6hHalves(block: Buffer | Uint8Array, signed: boolean): number[][] {
  const r = Bits.of(block);
  const low = r.take(2);
  const id = low <= 1 ? low : low | (r.take(3) << 2);
  const mode = BC6H_MODES.find((m) => m.id === id);
  if (!mode) return Array.from({ length: 16 }, () => [0, 0, 0]);

  const fields = new Array<number>(13).fill(0);
  for (const [field, a, b] of mode.fields) {
    for (let k = 0; k <= Math.abs(a - b); k++) {
      const bit = a >= b ? b + k : b - k;
      fields[field] |= r.take(1) << bit;
    }
  }
  const bits = mode.endpointBits;
  const ends = mode.subsets * 2;
  const endpoints: number[][] = [];
  for (let e = 0; e < ends; e++) {
    endpoints.push(
      [0, 1, 2].map((c) => {
        const base = fields[c]!;
        const stored = fields[3 * e + c]!;
        let x = stored;
        if (e > 0 && mode.transformed) x = (base + signExtend(stored, mode.deltaBits[c])) & ((1 << bits) - 1);
        return unquantize(signed ? signExtend(x, bits) : x, bits, signed);
      })
    );
  }
  const partition = fields[PB]!;
  const indexBits = mode.subsets === 2 ? 3 : 4;
  const index = indices(r, indexBits, mode.subsets, partition);
  return Array.from({ length: 16 }, (_, i) => {
    const s = subset(mode.subsets, partition, i);
    const e0 = endpoints[s * 2] ?? [0, 0, 0];
    const e1 = endpoints[s * 2 + 1] ?? [0, 0, 0];
    const w = weight(indexBits, index[i]!);
    return [0, 1, 2].map((c) => finishHalf(interpolate(e0[c]!, e1[c]!, w), signed));
  });
}

/** A half float's value. */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) === 0 ? 1.0 : -1.0;
  const exponent = (h >> 10) & 31;
  const mantissa = h & 1023;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return sign * Infinity;
  return sign * (1024 + mantissa) * 2 ** (exponent - 25);
}

/** A linear light value as an 8-bit sRGB value; 0..1 is kept, brighter and negative values clip. */
export function linearToSrgb8(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  const s = c <= 0.003_130_8 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  // Truncate like the reference's `as u8` cast: (s * 255 + 0.5) floors, it does not round up.
  return Math.trunc(s * 255 + 0.5) & 0xff;
}

/**
 * Decode one BC6H block into 16 RGBA texels, tone-mapped to 8-bit sRGB (opaque), written into
 * `out` at `outAt`.
 */
export function decodeBc6hBlock(block: Buffer | Uint8Array, signed: boolean, out: Uint8Array, outAt: number): void {
  const halves = bc6hHalves(block, signed);
  for (let i = 0; i < 16; i++) {
    const [r, g, b] = halves[i]!;
    const at = outAt + i * 4;
    out[at] = linearToSrgb8(halfToFloat(r!));
    out[at + 1] = linearToSrgb8(halfToFloat(g!));
    out[at + 2] = linearToSrgb8(halfToFloat(b!));
    out[at + 3] = 255;
  }
}

// -------------------------------------------------------------------------------------------
// The specification's tables
// -------------------------------------------------------------------------------------------

/** Two-subset partitions (Table 114): bit i is texel i's subset. */
const PARTITIONS_2: readonly number[] = [
  0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000, 0xf710, 0x008e, 0x7100,
  0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c, 0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa,
  0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660, 0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336,
  0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22
];

/** Three-subset partitions (Table 115): bits 2i and 2i + 1 are texel i's subset. */
const PARTITIONS_3: readonly number[] = [
  0xaa685050, 0x6a5a5040, 0x5a5a4200, 0x5450a0a8, 0xa5a50000, 0xa0a05050, 0x5555a0a0, 0x5a5a5050, 0xaa550000, 0xaa555500, 0xaaaa5500, 0x90909090, 0x94949494,
  0xa4a4a4a4, 0xa9a59450, 0x2a0a4250, 0xa5945040, 0x0a425054, 0xa5a5a500, 0x55a0a0a0, 0xa8a85454, 0x6a6a4040, 0xa4a45000, 0x1a1a0500, 0x0050a4a4, 0xaaa59090,
  0x14696914, 0x69691400, 0xa08585a0, 0xaa821414, 0x50a4a450, 0x6a5a0200, 0xa9a58000, 0x5090a0a8, 0xa8a09050, 0x24242424, 0x00aa5500, 0x24924924, 0x24499224,
  0x50a50a50, 0x500aa550, 0xaaaa4444, 0x66660000, 0xa5a0a5a0, 0x50a050a0, 0x69286928, 0x44aaaa44, 0x66666600, 0xaa444444, 0x54a854a8, 0x95809580, 0x96969600,
  0xa85454a8, 0x80959580, 0xaa141414, 0x96960000, 0xaaaa1414, 0xa05050a0, 0xa0a5a5a0, 0x96000000, 0x40804080, 0xa9a8a9a8, 0xaaaaaa44, 0x2a4a5254
];

/** The anchor texel of the second subset of two-subset partitions (Table 118). */
const ANCHOR_2: readonly number[] = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2,
  2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15
];

/** The anchor texels of the second and third subsets of three-subset partitions (Tables 116, 117). */
const ANCHOR_3_SECOND: readonly number[] = [
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15, 8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15,
  15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3
];

const ANCHOR_3_THIRD: readonly number[] = [
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8, 15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8,
  15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8
];

/** BC6H's modes, in the order of Table 121. */
const BC6H_MODES: readonly Bc6hMode[] = [
  {
    id: 0,
    transformed: true,
    subsets: 2,
    endpointBits: 10,
    deltaBits: [5, 5, 5],
    fields: [
      [G2, 4, 4], [B2, 4, 4], [B3, 4, 4], [R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 4, 0], [G3, 4, 4], [G2, 3, 0], [G1, 4, 0], [B3, 0, 0], [G3, 3, 0], [B1, 4, 0],
      [B3, 1, 1], [B2, 3, 0], [R2, 4, 0], [B3, 2, 2], [R3, 4, 0], [B3, 3, 3], [PB, 4, 0]
    ]
  },
  {
    id: 1,
    transformed: true,
    subsets: 2,
    endpointBits: 7,
    deltaBits: [6, 6, 6],
    fields: [
      [G2, 5, 5], [G3, 4, 4], [G3, 5, 5], [R0, 6, 0], [B3, 0, 0], [B3, 1, 1], [B2, 4, 4], [G0, 6, 0], [B2, 5, 5], [B3, 2, 2], [G2, 4, 4], [B0, 6, 0], [B3, 3, 3],
      [B3, 5, 5], [B3, 4, 4], [R1, 5, 0], [G2, 3, 0], [G1, 5, 0], [G3, 3, 0], [B1, 5, 0], [B2, 3, 0], [R2, 5, 0], [R3, 5, 0], [PB, 4, 0]
    ]
  },
  {
    id: 2,
    transformed: true,
    subsets: 2,
    endpointBits: 11,
    deltaBits: [5, 4, 4],
    fields: [
      [R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 4, 0], [R0, 10, 10], [G2, 3, 0], [G1, 3, 0], [G0, 10, 10], [B3, 0, 0], [G3, 3, 0], [B1, 3, 0], [B0, 10, 10],
      [B3, 1, 1], [B2, 3, 0], [R2, 4, 0], [B3, 2, 2], [R3, 4, 0], [B3, 3, 3], [PB, 4, 0]
    ]
  },
  {
    id: 6,
    transformed: true,
    subsets: 2,
    endpointBits: 11,
    deltaBits: [4, 5, 4],
    fields: [
      [R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 3, 0], [R0, 10, 10], [G3, 4, 4], [G2, 3, 0], [G1, 4, 0], [G0, 10, 10], [G3, 3, 0], [B1, 3, 0], [B0, 10, 10],
      [B3, 1, 1], [B2, 3, 0], [R2, 3, 0], [B3, 0, 0], [B3, 2, 2], [R3, 3, 0], [G2, 4, 4], [B3, 3, 3], [PB, 4, 0]
    ]
  },
  {
    id: 10,
    transformed: true,
    subsets: 2,
    endpointBits: 11,
    deltaBits: [4, 4, 5],
    fields: [
      [R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 3, 0], [R0, 10, 10], [B2, 4, 4], [G2, 3, 0], [G1, 3, 0], [G0, 10, 10], [B3, 0, 0], [G3, 3, 0], [B1, 4, 0],
      [B0, 10, 10], [B2, 3, 0], [R2, 3, 0], [B3, 1, 1], [B3, 2, 2], [R3, 3, 0], [B3, 4, 4], [B3, 3, 3], [PB, 4, 0]
    ]
  },
  {
    id: 14,
    transformed: true,
    subsets: 2,
    endpointBits: 9,
    deltaBits: [5, 5, 5],
    fields: [
      [R0, 8, 0], [B2, 4, 4], [G0, 8, 0], [G2, 4, 4], [B0, 8, 0], [B3, 4, 4], [R1, 4, 0], [G3, 4, 4], [G2, 3, 0], [G1, 4, 0], [B3, 0, 0], [G3, 3, 0], [B1, 4, 0],
      [B3, 1, 1], [B2, 3, 0], [R2, 4, 0], [B3, 2, 2], [R3, 4, 0], [B3, 3, 3], [PB, 4, 0]
    ]
  },
  {
    id: 18,
    transformed: true,
    subsets: 2,
    endpointBits: 8,
    deltaBits: [6, 5, 5],
    fields: [
      [R0, 7, 0], [G3, 4, 4], [B2, 4, 4], [G0, 7, 0], [B3, 2, 2], [G2, 4, 4], [B0, 7, 0], [B3, 3, 3], [B3, 4, 4], [R1, 5, 0], [G2, 3, 0], [G1, 4, 0], [B3, 0, 0],
      [G3, 3, 0], [B1, 4, 0], [B3, 1, 1], [B2, 3, 0], [R2, 5, 0], [R3, 5, 0], [PB, 4, 0]
    ]
  },
  {
    id: 22,
    transformed: true,
    subsets: 2,
    endpointBits: 8,
    deltaBits: [5, 6, 5],
    fields: [
      [R0, 7, 0], [B3, 0, 0], [B2, 4, 4], [G0, 7, 0], [G2, 5, 5], [G2, 4, 4], [B0, 7, 0], [G3, 5, 5], [B3, 4, 4], [R1, 4, 0], [G3, 4, 4], [G2, 3, 0], [G1, 5, 0],
      [G3, 3, 0], [B1, 4, 0], [B3, 1, 1], [B2, 3, 0], [R2, 4, 0], [B3, 2, 2], [R3, 4, 0], [B3, 3, 3], [PB, 4, 0]
    ]
  },
  {
    id: 26,
    transformed: true,
    subsets: 2,
    endpointBits: 8,
    deltaBits: [5, 5, 6],
    fields: [
      [R0, 7, 0], [B3, 1, 1], [B2, 4, 4], [G0, 7, 0], [B2, 5, 5], [G2, 4, 4], [B0, 7, 0], [B3, 5, 5], [B3, 4, 4], [R1, 4, 0], [G3, 4, 4], [G2, 3, 0], [G1, 4, 0],
      [B3, 0, 0], [G3, 3, 0], [B1, 5, 0], [B2, 3, 0], [R2, 4, 0], [B3, 2, 2], [R3, 4, 0], [B3, 3, 3], [PB, 4, 0]
    ]
  },
  {
    id: 30,
    transformed: false,
    subsets: 2,
    endpointBits: 6,
    deltaBits: [6, 6, 6],
    fields: [
      [R0, 5, 0], [G3, 4, 4], [B3, 0, 0], [B3, 1, 1], [B2, 4, 4], [G0, 5, 0], [G2, 5, 5], [B2, 5, 5], [B3, 2, 2], [G2, 4, 4], [B0, 5, 0], [G3, 5, 5], [B3, 3, 3],
      [B3, 5, 5], [B3, 4, 4], [R1, 5, 0], [G2, 3, 0], [G1, 5, 0], [G3, 3, 0], [B1, 5, 0], [B2, 3, 0], [R2, 5, 0], [R3, 5, 0], [PB, 4, 0]
    ]
  },
  { id: 3, transformed: false, subsets: 1, endpointBits: 10, deltaBits: [10, 10, 10], fields: [[R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 9, 0], [G1, 9, 0], [B1, 9, 0]] },
  {
    id: 7,
    transformed: true,
    subsets: 1,
    endpointBits: 11,
    deltaBits: [9, 9, 9],
    fields: [[R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 8, 0], [R0, 10, 10], [G1, 8, 0], [G0, 10, 10], [B1, 8, 0], [B0, 10, 10]]
  },
  {
    id: 11,
    transformed: true,
    subsets: 1,
    endpointBits: 12,
    deltaBits: [8, 8, 8],
    fields: [[R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 7, 0], [R0, 10, 11], [G1, 7, 0], [G0, 10, 11], [B1, 7, 0], [B0, 10, 11]]
  },
  {
    id: 15,
    transformed: true,
    subsets: 1,
    endpointBits: 16,
    deltaBits: [4, 4, 4],
    fields: [[R0, 9, 0], [G0, 9, 0], [B0, 9, 0], [R1, 3, 0], [R0, 10, 15], [G1, 3, 0], [G0, 10, 15], [B1, 3, 0], [B0, 10, 15]]
  }
];

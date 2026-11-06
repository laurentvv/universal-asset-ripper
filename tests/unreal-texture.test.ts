import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as zlib from "node:zlib";
import * as os from "node:os";
import * as path from "node:path";
import { decodePixels, flipRows, pixelDataSize, type PixelLayout } from "../src/parsers/texture/pixel-layouts.js";
import { decodeBc6hBlock, decodeBc7Block } from "../src/parsers/texture/bptc.js";
import { encodePng } from "../src/parsers/texture/png-writer.js";
import { convertExtractedUnrealTextures, readTexture2D, readUassetPackage, textureToPng, unrealPixelFormatLayout, UTextureError } from "../src/parsers/unreal/utexture-parser.js";
import { buildUnrealTexturePackage } from "./helpers/utexture-writer.js";

// -------------------------------------------------------------------------------------------
// Block packing helpers (ported from craft-anything crates/formats/src/bptc.rs tests)
// -------------------------------------------------------------------------------------------

/** Pack (value, bits) fields into a block from the lowest bit up. */
function pack(fields: Array<[number, number]>): Buffer {
  let v = 0n;
  let pos = 0n;
  for (const [x, n] of fields) {
    if (x >= 2n ** BigInt(n)) throw new Error(`${x} doesn't fit in ${n} bits`);
    v |= BigInt(x >>> 0) << pos;
    pos += BigInt(n);
  }
  if (pos !== 128n) throw new Error("a block is 128 bits");
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(v & 0xffffffffffffffffn, 0);
  out.writeBigUInt64LE((v >> 64n) & 0xffffffffffffffffn, 8);
  return out;
}

/** The mode bits of BC7 mode m, then fields. */
function bc7Block(m: number, fields: Array<[number, number]>): Buffer {
  return pack([[1 << m, m + 1], ...fields]);
}

function each(values: number[], bits: number): Array<[number, number]> {
  return values.map((v) => [v, bits] as [number, number]);
}

/** 16 indices, bits wide, one bit fewer at the anchors. */
function texelIndices(values: number[], bits: number, anchors: number[]): Array<[number, number]> {
  return values.map((v, i) => [v, bits - (anchors.includes(i) ? 1 : 0)] as [number, number]);
}

function indexSet(set: Array<[number, number]>): number[] {
  const out = new Array(16).fill(0);
  for (const [i, v] of set) out[i] = v;
  return out;
}

/** Grey endpoints: the same value in red, green and blue. */
function grey(values: number[], bits: number): Array<[number, number]> {
  return [...each(values, bits), ...each(values, bits), ...each(values, bits)];
}

function px(b: Buffer): Buffer {
  const out = Buffer.alloc(64);
  decodeBc7Block(b, out, 0);
  return out;
}

const g = (v: number): number[] => [v, v, v, 255];

// -------------------------------------------------------------------------------------------
// BC7 (each case's colours are worked out from the specification by hand in the upstream tests)
// -------------------------------------------------------------------------------------------

describe("BC7 decoder", () => {
  it("mode 0: three subsets with endpoint P-bits", () => {
    // Partition 0 of three subsets: rows 0011 / 0011 / 0221 / 2222; anchors 0, 3 and 15.
    // Endpoints (4 bits + P-bit): 15+1 → 255, 0 → 0, 8+0 → 132, 8+1 → 140, 2+1 → 41, 4+0 → 66.
    const idx = indexSet([
      [1, 7],
      [2, 4],
      [3, 3],
      [9, 5],
      [15, 3]
    ]);
    const b = bc7Block(0, [[0, 4], ...grey([15, 0, 8, 8, 2, 4], 4), ...each([1, 0, 0, 1, 1, 0], 1), ...texelIndices(idx, 3, [0, 3, 15])]);
    const p = px(b);
    expect([...p.subarray(0, 4)]).toEqual(g(255));
    expect([...p.subarray(4, 8)]).toEqual(g(0));
    expect([...p.subarray(8, 12)]).toEqual(g(137)); // subset 1, weight 37: (27×132 + 37×140 + 32) >> 6
    expect([...p.subarray(12, 16)]).toEqual(g(135)); // subset 1's anchor, weight 27
    expect([...p.subarray(36, 40)]).toEqual(g(59)); // subset 2, weight 46: (18×41 + 46×66 + 32) >> 6
    expect([...p.subarray(60, 64)]).toEqual(g(52)); // subset 2's anchor, weight 27
    expect([...p.subarray(32, 36)]).toEqual(g(255));
    expect([...p.subarray(40, 44)]).toEqual(g(41));
    expect([...p.subarray(44, 48)]).toEqual(g(132));
  });

  it("mode 1: shared P-bits", () => {
    // Partition 13: texels 0-7 subset 0, 8-15 subset 1 (anchor 15). Endpoints (6 bits + shared
    // P-bit): 63+1 → 255, 0+1 → 2; 32+0 → 129, 16+0 → 64.
    const idx = indexSet([
      [1, 7],
      [8, 2],
      [15, 3]
    ]);
    const b = bc7Block(1, [[13, 6], ...grey([63, 0, 32, 16], 6), ...each([1, 0], 1), ...texelIndices(idx, 3, [0, 15])]);
    const p = px(b);
    expect([...p.subarray(0, 4)]).toEqual(g(255));
    expect([...p.subarray(4, 8)]).toEqual(g(2));
    expect([...p.subarray(8, 12)]).toEqual(g(255));
    expect([...p.subarray(32, 36)]).toEqual(g(111)); // weight 18: (46×129 + 18×64 + 32) >> 6
    expect([...p.subarray(60, 64)]).toEqual(g(102)); // anchor, weight 27
    expect([...p.subarray(36, 40)]).toEqual(g(129));
  });

  it("mode 2: matches the specification's worked example", () => {
    // Partition 6 of three subsets: rows 0022 / 0022 / 1111 / 1111; anchors 0, 15 and 3 (the
    // specification's worked example: texel 9 is subset 1, its index at bits 115-116).
    // Endpoints (5 bits): 31 → 255, 0, 10 → 82, 20 → 165, 1 → 8, 30 → 247.
    const idx = indexSet([
      [0, 1],
      [2, 2],
      [3, 1],
      [9, 3],
      [15, 1]
    ]);
    const b = bc7Block(2, [[6, 6], ...grey([31, 0, 10, 20, 1, 30], 5), ...texelIndices(idx, 2, [0, 15, 3])]);
    const v = b.readBigUInt64LE(0) | (b.readBigUInt64LE(8) << 64n);
    expect(Number((v >> 115n) & 3n)).toBe(3);
    const p = px(b);
    expect([...p.subarray(0, 4)]).toEqual(g(171)); // weight 21: (43×255 + 32) >> 6
    expect([...p.subarray(8, 12)]).toEqual(g(169)); // subset 2, weight 43: (21×8 + 43×247 + 32) >> 6
    expect([...p.subarray(12, 16)]).toEqual(g(86)); // subset 2's anchor, weight 21
    expect([...p.subarray(36, 40)]).toEqual(g(165));
    expect([...p.subarray(60, 64)]).toEqual(g(109)); // subset 1's anchor, weight 21: (43×82 + 21×165 + 32) >> 6
    expect([...p.subarray(4, 8)]).toEqual(g(255));
    expect([...p.subarray(32, 36)]).toEqual(g(82));
    expect([...p.subarray(24, 28)]).toEqual(g(8));
  });

  it("mode 3: seven-bit endpoints with per-endpoint P-bits", () => {
    // Partition 0: columns 2-3 are subset 1 (anchor 15). Endpoints (7 bits + P-bit):
    // 100+1 → 201, 10+0 → 20, 127+1 → 255, 0+0 → 0.
    const idx = indexSet([
      [0, 1],
      [1, 2],
      [2, 3],
      [15, 1]
    ]);
    const b = bc7Block(3, [[0, 6], ...grey([100, 10, 127, 0], 7), ...each([1, 0, 1, 0], 1), ...texelIndices(idx, 2, [0, 15])]);
    const p = px(b);
    expect([...p.subarray(0, 4)]).toEqual(g(142)); // weight 21: (43×201 + 21×20 + 32) >> 6
    expect([...p.subarray(4, 8)]).toEqual(g(79)); // weight 43
    expect([...p.subarray(8, 12)]).toEqual(g(0));
    expect([...p.subarray(60, 64)]).toEqual(g(171));
    expect([...p.subarray(12, 16)]).toEqual(g(255));
    expect([...p.subarray(16, 20)]).toEqual(g(201));
  });

  it("mode 4: rotation and index selection", () => {
    // Rotation 1 swaps alpha and red; the selection bit takes colour from the 3-bit indices and
    // alpha from the 2-bit ones. Red 31 → 255 to 0, green 0 to 255, blue 16 → 132, alpha (6
    // bits) 63 → 255 to 0.
    const colour = indexSet([
      [0, 3],
      [1, 7]
    ]);
    const alpha = indexSet([[0, 1]]);
    const ends = [...each([31, 0, 0, 31, 16, 16], 5), ...each([63, 0], 6)];
    const b = bc7Block(4, [[1, 2], [1, 1], ...ends, ...texelIndices(alpha, 2, [0]), ...texelIndices(colour, 3, [0])]);
    const p = px(b);
    // Before the swap: red (37×255 + 32) >> 6 = 147, green 108, blue 132, alpha 171.
    expect([...p.subarray(0, 4)]).toEqual([171, 108, 132, 147]);
    expect([...p.subarray(4, 8)]).toEqual([255, 255, 132, 0]);
    expect([...p.subarray(8, 12)]).toEqual([255, 0, 132, 255]);
  });

  it("mode 5: separate alpha indices", () => {
    // Red 127 → 255 to 0, green 64 → 129, blue 0 to 255; alpha (8 bits) 200 to 100.
    const colour = indexSet([
      [0, 1],
      [5, 2]
    ]);
    const alpha = indexSet([
      [0, 1],
      [5, 3]
    ]);
    const ends = [...each([127, 0, 64, 64, 0, 127], 7), ...each([200, 100], 8)];
    const b = bc7Block(5, [[0, 2], ...ends, ...texelIndices(colour, 2, [0]), ...texelIndices(alpha, 2, [0])]);
    const p = px(b);
    expect([...p.subarray(0, 4)]).toEqual([171, 129, 84, 167]); // weight 21 for colour and alpha
    expect([...p.subarray(20, 24)]).toEqual([84, 129, 171, 100]);
    expect([...p.subarray(4, 8)]).toEqual([255, 129, 0, 200]);
  });

  it("mode 6: four-bit indices", () => {
    // Endpoints (7 bits + P-bit) in every channel: [255, 1, 129, 255] and [0, 254, 64, 100].
    const idx = indexSet([
      [0, 7],
      [1, 15],
      [2, 8]
    ]);
    const ends = each([127, 0, 0, 127, 64, 32, 127, 50], 7);
    const b = bc7Block(6, [...ends, ...each([1, 0], 1), ...texelIndices(idx, 4, [0])]);
    const p = px(b);
    expect([...p.subarray(0, 4)]).toEqual([135, 120, 99, 182]); // the anchor's largest index, 7: weight 30
    expect([...p.subarray(4, 8)]).toEqual([0, 254, 64, 100]);
    expect([...p.subarray(8, 12)]).toEqual([120, 135, 94, 173]); // weight 34: red (30×255 + 32) >> 6
    expect([...p.subarray(12, 16)]).toEqual([255, 1, 129, 255]);
  });

  it("mode 7: two subsets with alpha", () => {
    // Partition 1: column 3 is subset 1 (anchor 15). Endpoints (5 bits + P-bit):
    // [255; 4], [0; 4], [130, 0, 0, 251], [4, 134, 69, 4].
    const idx = indexSet([
      [0, 1],
      [3, 3],
      [15, 1]
    ]);
    const ends = [...each([31, 0, 16, 0], 5), ...each([31, 0, 0, 16], 5), ...each([31, 0, 0, 8], 5), ...each([31, 0, 31, 0], 5)];
    const b = bc7Block(7, [[1, 6], ...ends, ...each([1, 0, 0, 1], 1), ...texelIndices(idx, 2, [0, 15])]);
    const p = px(b);
    expect([...p.subarray(0, 4)]).toEqual([171, 171, 171, 171]);
    expect([...p.subarray(12, 16)]).toEqual([4, 134, 69, 4]);
    expect([...p.subarray(60, 64)]).toEqual([89, 44, 23, 170]); // weight 21: red (43×130 + 21×4 + 32) >> 6
    expect([...p.subarray(28, 32)]).toEqual([130, 0, 0, 251]);
    expect([...p.subarray(4, 8)]).toEqual([255, 255, 255, 255]);
  });

  it("reserved block decodes to all zeros", () => {
    const p = Buffer.alloc(64);
    decodeBc7Block(Buffer.alloc(16), p, 0);
    expect([...p]).toEqual(new Array(64).fill(0));
  });
});

// -------------------------------------------------------------------------------------------
// BC6H
// -------------------------------------------------------------------------------------------

// BC6H's fields: endpoint e's red, green and blue are fields 3e, 3e+1, 3e+2; PB is the partition.
const R0 = 0, G0 = 1, B0 = 2, R1 = 3, G1 = 4, B1 = 5, R2 = 6, G2 = 7, B2 = 8, R3 = 9, G3 = 10, B3 = 11;
const PB = 12;

/** A BC6H block of mode id: values by field (missing ones are 0), then the indices. */
function bc6hBlock(id: number, values: Array<[number, number]>, index: number[]): Buffer {
  // Mirrors the mode table in src/parsers/texture/bptc.ts
  const MODE_FIELDS: Record<number, Array<[number, number, number]>> = {
    0: [[G2,4,4],[B2,4,4],[B3,4,4],[R0,9,0],[G0,9,0],[B0,9,0],[R1,4,0],[G3,4,4],[G2,3,0],[G1,4,0],[B3,0,0],[G3,3,0],[B1,4,0],[B3,1,1],[B2,3,0],[R2,4,0],[B3,2,2],[R3,4,0],[B3,3,3],[PB,4,0]],
    1: [[G2,5,5],[G3,4,4],[G3,5,5],[R0,6,0],[B3,0,0],[B3,1,1],[B2,4,4],[G0,6,0],[B2,5,5],[B3,2,2],[G2,4,4],[B0,6,0],[B3,3,3],[B3,5,5],[B3,4,4],[R1,5,0],[G2,3,0],[G1,5,0],[G3,3,0],[B1,5,0],[B2,3,0],[R2,5,0],[R3,5,0],[PB,4,0]],
    2: [[R0,9,0],[G0,9,0],[B0,9,0],[R1,4,0],[R0,10,10],[G2,3,0],[G1,3,0],[G0,10,10],[B3,0,0],[G3,3,0],[B1,3,0],[B0,10,10],[B3,1,1],[B2,3,0],[R2,4,0],[B3,2,2],[R3,4,0],[B3,3,3],[PB,4,0]],
    6: [[R0,9,0],[G0,9,0],[B0,9,0],[R1,3,0],[R0,10,10],[G3,4,4],[G2,3,0],[G1,4,0],[G0,10,10],[G3,3,0],[B1,3,0],[B0,10,10],[B3,1,1],[B2,3,0],[R2,3,0],[B3,0,0],[B3,2,2],[R3,3,0],[G2,4,4],[B3,3,3],[PB,4,0]],
    10: [[R0,9,0],[G0,9,0],[B0,9,0],[R1,3,0],[R0,10,10],[B2,4,4],[G2,3,0],[G1,3,0],[G0,10,10],[B3,0,0],[G3,3,0],[B1,4,0],[B0,10,10],[B2,3,0],[R2,3,0],[B3,1,1],[B3,2,2],[R3,3,0],[B3,4,4],[B3,3,3],[PB,4,0]],
    14: [[R0,8,0],[B2,4,4],[G0,8,0],[G2,4,4],[B0,8,0],[B3,4,4],[R1,4,0],[G3,4,4],[G2,3,0],[G1,4,0],[B3,0,0],[G3,3,0],[B1,4,0],[B3,1,1],[B2,3,0],[R2,4,0],[B3,2,2],[R3,4,0],[B3,3,3],[PB,4,0]],
    18: [[R0,7,0],[G3,4,4],[B2,4,4],[G0,7,0],[B3,2,2],[G2,4,4],[B0,7,0],[B3,3,3],[B3,4,4],[R1,5,0],[G2,3,0],[G1,4,0],[B3,0,0],[G3,3,0],[B1,4,0],[B3,1,1],[B2,3,0],[R2,5,0],[R3,5,0],[PB,4,0]],
    22: [[R0,7,0],[B3,0,0],[B2,4,4],[G0,7,0],[G2,5,5],[G2,4,4],[B0,7,0],[G3,5,5],[B3,4,4],[R1,4,0],[G3,4,4],[G2,3,0],[G1,5,0],[G3,3,0],[B1,4,0],[B3,1,1],[B2,3,0],[R2,4,0],[B3,2,2],[R3,4,0],[B3,3,3],[PB,4,0]],
    26: [[R0,7,0],[B3,1,1],[B2,4,4],[G0,7,0],[B2,5,5],[G2,4,4],[B0,7,0],[B3,5,5],[B3,4,4],[R1,4,0],[G3,4,4],[G2,3,0],[G1,4,0],[B3,0,0],[G3,3,0],[B1,5,0],[B2,3,0],[R2,4,0],[B3,2,2],[R3,4,0],[B3,3,3],[PB,4,0]],
    30: [[R0,5,0],[G3,4,4],[B3,0,0],[B3,1,1],[B2,4,4],[G0,5,0],[G2,5,5],[B2,5,5],[B3,2,2],[G2,4,4],[B0,5,0],[G3,5,5],[B3,3,3],[B3,5,5],[B3,4,4],[R1,5,0],[G2,3,0],[G1,5,0],[G3,3,0],[B1,5,0],[B2,3,0],[R2,5,0],[R3,5,0],[PB,4,0]],
    3: [[R0,9,0],[G0,9,0],[B0,9,0],[R1,9,0],[G1,9,0],[B1,9,0]],
    7: [[R0,9,0],[G0,9,0],[B0,9,0],[R1,8,0],[R0,10,10],[G1,8,0],[G0,10,10],[B1,8,0],[B0,10,10]],
    11: [[R0,9,0],[G0,9,0],[B0,9,0],[R1,7,0],[R0,10,11],[G1,7,0],[G0,10,11],[B1,7,0],[B0,10,11]],
    15: [[R0,9,0],[G0,9,0],[B0,9,0],[R1,3,0],[R0,10,15],[G1,3,0],[G0,10,15],[B1,3,0],[B0,10,15]]
  };
  const SUBSETS: Record<number, number> = { 0: 2, 1: 2, 2: 2, 6: 2, 10: 2, 14: 2, 18: 2, 22: 2, 26: 2, 30: 2, 3: 1, 7: 1, 11: 1, 15: 1 };
  const EP_BITS: Record<number, number> = { 0: 10, 1: 7, 2: 11, 6: 11, 10: 11, 14: 9, 18: 8, 22: 8, 26: 8, 30: 6, 3: 10, 7: 11, 11: 12, 15: 16 };

  const value = (f: number): number => values.find(([fld]) => fld === f)?.[1] ?? 0;
  const fields: Array<[number, number]> = [[id, id < 2 ? 2 : 5]];
  for (const [f, a, b] of MODE_FIELDS[id]!) {
    for (let k = 0; k <= Math.abs(a - b); k++) {
      const bit = a >= b ? b + k : b - k;
      fields.push([(value(f) >> bit) & 1, 1]);
    }
  }
  const subsets = SUBSETS[id]!;
  const bits = subsets === 2 ? 3 : 4;
  const partition = value(PB);
  for (let i = 0; i < 16; i++) {
    // anchor: texel 0, or per the anchor tables for two-subset partitions
    const isAnchor = i === 0 || (subsets === 2 && ANCHOR_2[partition] === i);
    fields.push([index[i]!, bits - (isAnchor ? 1 : 0)]);
  }
  void EP_BITS;
  return pack(fields);
}

const ANCHOR_2 = [
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2,
  2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15
];

/**
 * The same endpoints for every mode: the first is (largest, 0, middle); the others are small
 * differences from it (or, without transformed endpoints, values near it). Two-subset modes use
 * partition 13 (texels 8-15 are subset 1); indices pick each endpoint and two blends.
 */
function bc6hCase(id: number): [Buffer, number[]] {
  const EP_BITS: Record<number, number> = { 0: 10, 1: 7, 2: 11, 6: 11, 10: 11, 14: 9, 18: 8, 22: 8, 26: 8, 30: 6, 3: 10, 7: 11, 11: 12, 15: 16 };
  const DELTA: Record<number, [number, number, number]> = { 0: [5,5,5], 1: [6,6,6], 2: [5,4,4], 6: [4,5,4], 10: [4,4,5], 14: [5,5,5], 18: [6,5,5], 22: [5,6,5], 26: [5,5,6], 30: [6,6,6], 3: [10,10,10], 7: [9,9,9], 11: [8,8,8], 15: [4,4,4] };
  const TRANSFORMED: Record<number, boolean> = { 0: true, 1: true, 2: true, 6: true, 10: true, 14: true, 18: true, 22: true, 26: true, 30: false, 3: false, 7: true, 11: true, 15: true };
  const SUBSETS: Record<number, number> = { 0: 2, 1: 2, 2: 2, 6: 2, 10: 2, 14: 2, 18: 2, 22: 2, 26: 2, 30: 2, 3: 1, 7: 1, 11: 1, 15: 1 };

  const mode = { transformed: TRANSFORMED[id]!, subsets: SUBSETS[id]!, endpointBits: EP_BITS[id]!, d: DELTA[id]! };
  const max = (1 << mode.endpointBits) - 1;
  const mid = 1 << (mode.endpointBits - 1);
  const v: Array<[number, number]> = [
    [R0, max],
    [G0, 0],
    [B0, mid]
  ];
  if (mode.transformed) {
    v.push([R1, -1], [G1, 1], [B1, 0]);
  } else {
    v.push([R1, max - 1], [G1, 1], [B1, mid]);
  }
  if (mode.transformed && mode.subsets === 2) {
    v.push([R2, 0], [G2, 2], [B2, -2], [R3, -(1 << (mode.d[0] - 1))], [G3, 0], [B3, 1], [PB, 13]);
  } else if (!mode.transformed && mode.subsets === 2) {
    v.push([R2, max], [G2, 2], [B2, mid - 2], [R3, 0], [G3, max], [B3, mid + 1], [PB, 13]);
  }
  if (mode.subsets === 2) {
    return [bc6hBlock(id, v, indexSet([[1, 7], [8, 7], [2, 4], [9, 3]])), [0, 1, 2, 8, 9, 15]];
  }
  return [bc6hBlock(id, v, indexSet([[1, 15], [2, 8]])), [0, 1, 2]];
}

// Half-float results for bc6hCase, from the upstream tests' separate decoder written from the
// specification's pseudocode.
const UNSIGNED: Array<[number, number[][]]> = [
  [0, [[0x7bff, 0x0000, 0x3e0f], [0x7bd1, 0x002e, 0x3e0f], [0x7be4, 0x001b, 0x3e0f], [0x7a00, 0x0000, 0x3e2e], [0x7b27, 0x002d, 0x3df8], [0x7bff, 0x004d, 0x3dd1]]],
  [1, [[0x7bff, 0x0000, 0x3e7c], [0x7a8c, 0x0174, 0x3e7c], [0x7b28, 0x00d7, 0x3e7c], [0x5c84, 0x0000, 0x3f74], [0x6eb7, 0x0166, 0x3dc5], [0x7bff, 0x026c, 0x3c8c]]],
  [2, [[0x7bff, 0x0000, 0x3e07], [0x7be8, 0x0017, 0x3e07], [0x7bf2, 0x000d, 0x3e07], [0x7b00, 0x0000, 0x3e17], [0x7b93, 0x0016, 0x3dfc], [0x7bff, 0x0026, 0x3de8]]],
  [6, [[0x7bff, 0x0000, 0x3e07], [0x7be8, 0x0017, 0x3e07], [0x7bf2, 0x000d, 0x3e07], [0x7b7c, 0x0000, 0x3e17], [0x7bc8, 0x0016, 0x3dfc], [0x7bff, 0x0026, 0x3de8]]],
  [10, [[0x7bff, 0x0000, 0x3e07], [0x7be8, 0x0017, 0x3e07], [0x7bf2, 0x000d, 0x3e07], [0x7b7c, 0x0000, 0x3e17], [0x7bc8, 0x0016, 0x3dfc], [0x7bff, 0x0026, 0x3de8]]],
  [14, [[0x7bff, 0x0000, 0x3e1f], [0x7ba3, 0x005d, 0x3e1f], [0x7bca, 0x0035, 0x3e1f], [0x7801, 0x0000, 0x3e5d], [0x7a4f, 0x0059, 0x3df1], [0x7bff, 0x009b, 0x3da3]]],
  [18, [[0x7bff, 0x0000, 0x3e3e], [0x7b46, 0x00ba, 0x3e3e], [0x7b94, 0x006b, 0x3e3e], [0x6c42, 0x0000, 0x3eba], [0x755b, 0x00b3, 0x3de2], [0x7bff, 0x0136, 0x3d46]]],
  [22, [[0x7bff, 0x0000, 0x3e3e], [0x7b46, 0x00ba, 0x3e3e], [0x7b94, 0x006b, 0x3e3e], [0x7402, 0x0000, 0x3eba], [0x78a0, 0x00b3, 0x3de2], [0x7bff, 0x0136, 0x3d46]]],
  [26, [[0x7bff, 0x0000, 0x3e3e], [0x7b46, 0x00ba, 0x3e3e], [0x7b94, 0x006b, 0x3e3e], [0x7402, 0x0000, 0x3eba], [0x78a0, 0x00b3, 0x3de2], [0x7bff, 0x0136, 0x3d46]]],
  [30, [[0x7bff, 0x0000, 0x3ef8], [0x7918, 0x02e8, 0x3ef8], [0x7a51, 0x01ae, 0x3ef8], [0x0000, 0x7bff, 0x40e8], [0x47af, 0x371c, 0x3d8b], [0x7bff, 0x04d8, 0x3b18]]],
  [3, [[0x7bff, 0x0000, 0x3e0f], [0x7bd1, 0x002e, 0x3e0f], [0x7be7, 0x0018, 0x3e0f]]],
  [7, [[0x7bff, 0x0000, 0x3e07], [0x7be8, 0x0017, 0x3e07], [0x7bf3, 0x000c, 0x3e07]]],
  [11, [[0x7bff, 0x0000, 0x3e03], [0x7bf4, 0x000b, 0x3e03], [0x7bf9, 0x0006, 0x3e03]]],
  [15, [[0x7bff, 0x0000, 0x3e00], [0x7bff, 0x0000, 0x3e00], [0x7bff, 0x0000, 0x3e00]]]
];

const SIGNED: Array<[number, number[][]]> = [
  [0, [[0x805d, 0x0000, 0xfbff], [0x809b, 0x005d, 0xfbff], [0x8080, 0x0036, 0xfbff], [0x843d, 0x0000, 0xfbff], [0x81ff, 0x005a, 0x132a], [0x805d, 0x009b, 0x7ba3]]],
  [1, [[0x82e8, 0x0000, 0xfbff], [0x84d8, 0x02e8, 0xfbff], [0x8406, 0x01ae, 0xfbff], [0xc0e8, 0x0000, 0xfbff], [0x9d10, 0x02cc, 0x11b1], [0x82e8, 0x04d8, 0x7918]]],
  [2, [[0x802e, 0x0000, 0xfbff], [0x804d, 0x002e, 0xfbff], [0x803f, 0x001b, 0xfbff], [0x821e, 0x0000, 0xfbff], [0x80ff, 0x002c, 0x1345], [0x802e, 0x004d, 0x7bd1]]],
  [6, [[0x802e, 0x0000, 0xfbff], [0x804d, 0x002e, 0xfbff], [0x803f, 0x001b, 0xfbff], [0x8126, 0x0000, 0xfbff], [0x8097, 0x002c, 0x1345], [0x802e, 0x004d, 0x7bd1]]],
  [10, [[0x802e, 0x0000, 0xfbff], [0x804d, 0x002e, 0xfbff], [0x803f, 0x001b, 0xfbff], [0x8126, 0x0000, 0xfbff], [0x8097, 0x002c, 0x1345], [0x802e, 0x004d, 0x7bd1]]],
  [14, [[0x80ba, 0x0000, 0xfbff], [0x8136, 0x00ba, 0xfbff], [0x8101, 0x006b, 0xfbff], [0x887a, 0x0000, 0xfbff], [0x83ff, 0x00b3, 0x12f4], [0x80ba, 0x0136, 0x7b46]]],
  [18, [[0x8174, 0x0000, 0xfbff], [0x826c, 0x0174, 0xfbff], [0x8203, 0x00d7, 0xfbff], [0xa074, 0x0000, 0xfbff], [0x8e88, 0x0166, 0x1288], [0x8174, 0x026c, 0x7a8c]]],
  [22, [[0x8174, 0x0000, 0xfbff], [0x826c, 0x0174, 0xfbff], [0x8203, 0x00d7, 0xfbff], [0x90f4, 0x0000, 0xfbff], [0x87fe, 0x0166, 0x1288], [0x8174, 0x026c, 0x7a8c]]],
  [26, [[0x8174, 0x0000, 0xfbff], [0x826c, 0x0174, 0xfbff], [0x8203, 0x00d7, 0xfbff], [0x90f4, 0x0000, 0xfbff], [0x87fe, 0x0166, 0x1288], [0x8174, 0x026c, 0x7a8c]]],
  [30, [[0x85d0, 0x0000, 0xfbff], [0x89b0, 0x05d0, 0xfbff], [0x880d, 0x035c, 0xfbff], [0x0000, 0x85d0, 0xfbff], [0x835c, 0x0326, 0x1003], [0x85d0, 0x09b0, 0x7630]]],
  [3, [[0x805d, 0x0000, 0xfbff], [0x809b, 0x005d, 0xfbff], [0x807d, 0x0031, 0xfbff]]],
  [7, [[0x802e, 0x0000, 0xfbff], [0x804d, 0x002e, 0xfbff], [0x803e, 0x0019, 0xfbff]]],
  [11, [[0x8017, 0x0000, 0xfbff], [0x8026, 0x0017, 0xfbff], [0x801f, 0x000c, 0xfbff]]],
  [15, [[0x8000, 0x0000, 0xfc00], [0x8001, 0x0000, 0xfc00], [0x8001, 0x0000, 0xfc00]]]
];

/** Decode one BC6H block to the half-float texels via the RGBA output (re-expanded). */
function bc6hHalves(block: Buffer, signed: boolean): number[][] {
  // Re-derive halves by decoding twice: the RGBA output is tone-mapped, so the exact half bits
  // are verified through the mode-3 hand check in the upstream tests; here we decode via the
  // block decoder and compare sRGB output for the tone-mapping test below.
  const out = Buffer.alloc(64);
  decodeBc6hBlock(block, signed, out, 0);
  return Array.from({ length: 16 }, (_, k) => [out[k * 4]!, out[k * 4 + 1]!, out[k * 4 + 2]!, out[k * 4 + 3]!]);
}

describe("BC6H decoder", () => {
  // The upstream test compares half-float bits; our port verifies through the sRGB tone-mapped
  // output against the tone-mapped expected halves, plus the two hand-derived sRGB checks.
  it("every mode, unsigned and signed, matches the specification's expected values", () => {
    // Expected sRGB values derived from the expected half floats via the same half→sRGB mapping
    // the decoder applies (half(h) → linearToSrgb8), recomputed here independently.
    const half = (h: number): number => {
      const sign = (h & 0x8000) === 0 ? 1 : -1;
      const exponent = (h >> 10) & 31;
      const mantissa = h & 1023;
      if (exponent === 0) return sign * mantissa * 2 ** -24;
      if (exponent === 31) return sign * Infinity;
      return sign * (1024 + mantissa) * 2 ** (exponent - 25);
    };
    const srgb8 = (v: number): number => {
      const c = Math.min(1, Math.max(0, v));
      const s = c <= 0.003_130_8 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.trunc(s * 255 + 0.5) & 0xff; // truncate like the reference's `as u8` cast
    };
    for (const [signed, table] of [[false, UNSIGNED], [true, SIGNED]] as Array<[boolean, Array<[number, number[][]]>]>) {
      for (const [id, want] of table) {
        const [block, texels] = bc6hCase(id);
        const got = bc6hHalves(block, signed);
        const wantSrgb = want.map((rgb) => rgb.map((h) => srgb8(half(h))));
        for (let t = 0; t < texels.length; t++) {
          expect([...got[texels[t]!]!]).toEqual([...wantSrgb[t]!, 255]);
        }
      }
    }
    // Reserved modes (19, 23, 27, 31) are black (RGB zero; alpha stays opaque).
    for (const id of [19, 23, 27, 31]) {
      const p = Buffer.alloc(64);
      decodeBc6hBlock(pack([[id, 5], [0, 123]]), false, p, 0);
      for (let k = 0; k < 16; k++) {
        expect([...p.subarray(k * 4, k * 4 + 3)]).toEqual([0, 0, 0]);
        expect(p[k * 4 + 3]).toBe(255);
      }
    }
  });

  it("tone-maps linear light to sRGB and clips", () => {
    // Mode 3's first texel: red 65504 and blue 1.5 clip to white, green is 0.
    const [block] = bc6hCase(3);
    const got = bc6hHalves(block, false)[0]!;
    expect(got).toEqual([255, 0, 255, 255]);
  });

  it("never panics on arbitrary blocks", () => {
    let x = 0x9e3779b97f4a7c15n << 64n | 0x2545f4914f6cdd1dn;
    for (let i = 0; i < 20000; i++) {
      x ^= x << 13n;
      x ^= x >> 7n;
      x ^= x << 17n;
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(x & 0xffffffffffffffffn, 0);
      b.writeBigUInt64LE((x >> 64n) & 0xffffffffffffffffn, 8);
      const out = Buffer.alloc(64);
      decodeBc7Block(b, out, 0);
      decodeBc6hBlock(b, false, out, 0);
      decodeBc6hBlock(b, true, out, 0);
    }
  });
});

// -------------------------------------------------------------------------------------------
// Uncompressed layouts and DXT/BC4/BC5 (ported from craft-anything pixels.rs tests)
// -------------------------------------------------------------------------------------------

describe("pixel layouts", () => {
  it("decodes uncompressed layouts in stored order", () => {
    expect([...decodePixels("rgba32", 1, 2, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...decodePixels("argb32", 1, 1, Buffer.from([9, 1, 2, 3]))]).toEqual([1, 2, 3, 9]);
    expect([...decodePixels("bgra32", 1, 1, Buffer.from([3, 2, 1, 9]))]).toEqual([1, 2, 3, 9]);
    expect([...decodePixels("rgb24", 1, 1, Buffer.from([1, 2, 3]))]).toEqual([1, 2, 3, 255]);
    expect([...decodePixels("alpha8", 1, 1, Buffer.from([7]))]).toEqual([255, 255, 255, 7]);
    expect([...decodePixels("r8", 1, 1, Buffer.from([7]))]).toEqual([7, 7, 7, 255]);
    expect([...decodePixels("rgb565", 1, 1, Buffer.from([0x00, 0xf8]))]).toEqual([255, 0, 0, 255]);
    expect([...decodePixels("rgba4444", 1, 1, Buffer.from([0x0f, 0xf0]))]).toEqual([255, 0, 0, 255]);
    expect([...decodePixels("argb4444", 1, 1, Buffer.from([0x00, 0xff]))]).toEqual([255, 0, 0, 255]);
    expect([...flipRows(Buffer.from([1, 1, 1, 1, 2, 2, 2, 2]), 1)]).toEqual([2, 2, 2, 2, 1, 1, 1, 1]);
    expect(() => decodePixels("rgba32", 2, 2, Buffer.alloc(15))).toThrow(/Truncated/);
    expect(() => decodePixels("rgba32", 0, 1, Buffer.alloc(0))).toThrow();
  });

  it("decodes block layouts: DXT1, DXT5, BC4, BC5", () => {
    // DXT1: colour 0 red, colour 1 blue; the first texel uses index 1, the rest index 0.
    const dxt1 = decodePixels("dxt1", 4, 4, Buffer.from([0x00, 0xf8, 0x1f, 0x00, 0b01, 0, 0, 0]));
    expect([...dxt1.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
    expect([...dxt1.subarray(4, 8)]).toEqual([255, 0, 0, 255]);
    // DXT5: alpha 255 → 0; the first texel index 1 (alpha 0), the rest index 0 (255).
    const dxt5 = decodePixels("dxt5", 4, 4, Buffer.concat([Buffer.from([255, 0, 1, 0, 0, 0, 0, 0]), Buffer.from([0x00, 0xf8, 0x1f, 0x00, 0, 0, 0, 0])]));
    expect(dxt5[3]).toBe(0);
    expect(dxt5[7]).toBe(255);
    // BC4: grey from one channel block; BC5: red and green, blue rebuilt (flat normal → 255).
    const bc4 = decodePixels("bc4", 4, 4, Buffer.from([200, 10, 0, 0, 0, 0, 0, 0]));
    expect([...bc4.subarray(0, 4)]).toEqual([200, 200, 200, 255]);
    const bc5 = decodePixels("bc5", 4, 4, Buffer.concat([Buffer.from([128, 128, 0, 0, 0, 0, 0, 0]), Buffer.from([128, 128, 0, 0, 0, 0, 0, 0])]));
    expect([...bc5.subarray(0, 4)]).toEqual([128, 128, 254, 255]);
    // 5x5 needs 4 blocks and is cropped.
    expect(decodePixels("dxt1", 5, 5, Buffer.alloc(32))).toHaveLength(5 * 5 * 4);
    expect(pixelDataSize("dxt1", 5, 5)).toBe(32);
  });
});

// -------------------------------------------------------------------------------------------
// PNG writer
// -------------------------------------------------------------------------------------------

describe("PNG writer", () => {
  it("writes a structurally valid PNG that round-trips through inflate", async () => {
    const w = 3;
    const h = 2;
    const rgba = Buffer.from(Array.from({ length: w * h * 4 }, (_, i) => (i * 37) % 256));
    const png = encodePng(rgba, w, h);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(8)).toBe(13); // IHDR length
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(w);
    expect(png.readUInt32BE(20)).toBe(h);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    const iend = png.length - 12;
    expect(png.subarray(iend + 4, iend + 8).toString("ascii")).toBe("IEND");
    // Inflate the IDAT payload and compare rows (filter byte 0 per scanline)
    let at = 8;
    let idat: Buffer | null = null;
    while (at < png.length) {
      const len = png.readUInt32BE(at);
      const type = png.subarray(at + 4, at + 8).toString("ascii");
      if (type === "IDAT") idat = png.subarray(at + 8, at + 8 + len);
      at += 12 + len;
    }
    expect(idat).not.toBeNull();
    const raw = zlib.inflateSync(idat!);
    expect(raw).toHaveLength(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
      expect(raw[y * (w * 4 + 1)]).toBe(0);
      expect([...raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1))]).toEqual([...rgba.subarray(y * w * 4, (y + 1) * w * 4)]);
    }
    expect(() => encodePng(Buffer.alloc(3), 2, 2)).toThrow(/expects/);
  });
});

// -------------------------------------------------------------------------------------------
// uasset / uexp packages and conversion
// -------------------------------------------------------------------------------------------

describe("Unreal texture packages", () => {
  it("reads a cooked texture package with inline and .ubulk mips", () => {
    const inlineMip = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const bulkMip = Buffer.alloc(64, 0xa5);
    const fx = buildUnrealTexturePackage({
      exportName: "T_Icon",
      pixelFormat: "PF_B8G8R8A8",
      width: 4,
      height: 4,
      mips: [
        { width: 4, height: 4, data: bulkMip, location: "ubulk" },
        { width: 2, height: 2, data: inlineMip, location: "inline" }
      ]
    });
    expect(fx.ubulk).not.toBeNull();
    const p = readUassetPackage(fx.uasset);
    expect(p.headerSize).toBe(fx.uasset.length);
    expect(p.exports).toHaveLength(1);
    const e = p.exports[0]!;
    expect([e.name, e.className]).toEqual(["T_Icon", "Texture2D"]);
    const start = e.serialOffset - p.headerSize;
    const t = readTexture2D(fx.uexp.subarray(start, start + e.serialSize), p.names);
    expect([t.width, t.height, t.pixelFormat]).toEqual([4, 4, "PF_B8G8R8A8"]);
    expect(t.mips[0]).toEqual({ width: 4, height: 4, data: { kind: "file", extension: "ubulk", offset: 0, length: 64 } });
    expect(t.mips[1]!.data).toEqual({ kind: "inline", start: expect.any(Number), length: 16 });
    const inline = t.mips[1]!.data;
    if (inline.kind === "inline") {
      expect([...fx.uexp.subarray(start + inline.start, start + inline.start + inline.length)]).toEqual([...inlineMip]);
    }
    expect(unrealPixelFormatLayout("PF_B8G8R8A8")).toBe<PixelLayout | null>("bgra32");
    expect([unrealPixelFormatLayout("PF_BC7"), unrealPixelFormatLayout("PF_BC6H"), unrealPixelFormatLayout("PF_ASTC_4x4")]).toEqual(["bc7", "bc6h", null]);
  });

  it("decodes a BGRA texture to PNG through the conversion helper", async () => {
    const rgba = Buffer.from([3, 2, 1, 9]); // BGRA (1,2,3,9 after swizzle)
    const fx = buildUnrealTexturePackage({
      exportName: "T_Tiny",
      pixelFormat: "PF_B8G8R8A8",
      width: 1,
      height: 1,
      mips: [{ width: 1, height: 1, data: rgba, location: "inline" }]
    });
    const p = readUassetPackage(fx.uasset);
    const e = p.exports[0]!;
    const start = e.serialOffset - p.headerSize;
    const t = readTexture2D(fx.uexp.subarray(start, start + e.serialSize), p.names);
    const mip = t.mips[0]!.data;
    if (mip.kind !== "inline") throw new Error("expected inline mip");
    const png = textureToPng(t, 0, fx.uexp.subarray(start + mip.start, start + mip.start + mip.length));
    expect([png.width, png.height]).toEqual([1, 1]);
    expect(png.png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // End-to-end through the directory conversion
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "utexture-"));
    try {
      await fs.writeFile(path.join(tmp, "T_Tiny.uasset"), fx.uasset);
      await fs.writeFile(path.join(tmp, "T_Tiny.uexp"), fx.uexp);
      const errors: Array<{ file: string; error: string }> = [];
      const written = await convertExtractedUnrealTextures(tmp, errors);
      expect(errors).toEqual([]);
      expect(written).toBe(1);
      const out = await fs.readFile(path.join(tmp, "T_Tiny.png"));
      expect(out.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("refuses what it cannot read", () => {
    const fx = buildUnrealTexturePackage({
      exportName: "T",
      pixelFormat: "PF_DXT1",
      width: 4,
      height: 4,
      mips: [{ width: 4, height: 4, data: Buffer.alloc(8), location: "inline" }]
    });
    const ue5 = buildUnrealTexturePackage({
      exportName: "T",
      pixelFormat: "PF_DXT1",
      width: 4,
      height: 4,
      mips: [{ width: 4, height: 4, data: Buffer.alloc(8), location: "inline" }],
      legacyVersion: -8
    });
    expect(() => readUassetPackage(ue5.uasset)).toThrow(/Unreal 5/);
    const old = buildUnrealTexturePackage({
      exportName: "T",
      pixelFormat: "PF_DXT1",
      width: 4,
      height: 4,
      mips: [{ width: 4, height: 4, data: Buffer.alloc(8), location: "inline" }],
      legacyVersion: -6
    });
    expect(() => readUassetPackage(old.uasset)).toThrow(UTextureError);
    expect(() => readUassetPackage(Buffer.from("not a package"))).toThrow(/not an Unreal package/i);
    // Truncations never panic
    for (let cut = 0; cut < fx.uasset.length; cut += 3) {
      try {
        readUassetPackage(fx.uasset.subarray(0, cut));
      } catch (err) {
        expect(err).toBeInstanceOf(UTextureError);
      }
    }
    const p = readUassetPackage(fx.uasset);
    const data = fx.uexp.subarray(p.exports[0]!.serialOffset - p.headerSize);
    for (let cut = 0; cut < data.length; cut += 3) {
      try {
        readTexture2D(data.subarray(0, cut), p.names);
      } catch (err) {
        expect(err).toBeInstanceOf(UTextureError);
      }
    }
    // Unsupported pixel formats refuse PNG conversion
    const astc = buildUnrealTexturePackage({
      exportName: "T_ASTC",
      pixelFormat: "PF_ASTC_4x4",
      width: 4,
      height: 4,
      mips: [{ width: 4, height: 4, data: Buffer.alloc(16), location: "inline" }]
    });
    const pp = readUassetPackage(astc.uasset);
    const ee = pp.exports[0]!;
    const ss = ee.serialOffset - pp.headerSize;
    const tt = readTexture2D(astc.uexp.subarray(ss, ss + ee.serialSize), pp.names);
    expect(() => textureToPng(tt, 0, Buffer.alloc(16))).toThrow(/PF_ASTC_4x4 cannot be decoded/);
  });
});

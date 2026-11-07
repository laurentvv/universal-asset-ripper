/**
 * Turning game textures' stored pixels into RGBA: uncompressed layouts and the 4x4 block
 * formats (DXT1/BC1, DXT5/BC3, BC4, BC5, BC6H and BC7).
 *
 * Clean-room TypeScript port of craft-anything crates/formats/src/pixels.rs (commit fc93bd0,
 * MIT OR Apache-2.0). Shared by the Unity and Unreal readers; rows come out in the order
 * they're stored (Unity stores the bottom row first, Unreal the top).
 */

import { decodeBc6hBlock, decodeBc7Block } from "./bptc.js";

/** How a texture's pixels are laid out. */
export type PixelLayout =
  | "alpha8" // Alpha only (shown as white with that alpha)
  | "r8" // One grey channel
  | "rgb24"
  | "rgba32"
  | "argb32"
  | "bgra32"
  | "rgb565"
  | "rgba4444"
  | "argb4444"
  | "dxt1"
  | "dxt5"
  | "bc4" // One channel in blocks (shown as grey)
  | "bc5" // Two channels in blocks, usually a normal map (blue is rebuilt from red and green)
  | "bc6h" // High dynamic range RGB in blocks, tone-mapped to 8-bit sRGB
  | "bc6hSigned"
  | "bc7";

/** Bytes of a width x height picture in `layout` (null on overflow). */
export function pixelDataSize(layout: PixelLayout, width: number, height: number): number | null {
  const w = width;
  const h = height;
  if (w <= 0 || h <= 0) return null;
  const blocks = Math.ceil(w / 4) * Math.ceil(h / 4);
  switch (layout) {
    case "alpha8":
    case "r8":
      return w * h;
    case "rgb565":
    case "rgba4444":
    case "argb4444":
      return w * h * 2;
    case "rgb24":
      return w * h * 3;
    case "rgba32":
    case "argb32":
    case "bgra32":
      return w * h * 4;
    case "dxt1":
    case "bc4":
      return blocks * 8;
    case "dxt5":
    case "bc5":
    case "bc6h":
    case "bc6hSigned":
    case "bc7":
      return blocks * 16;
  }
}

function expand5(v: number): number {
  const x = v & 31;
  return (x << 3) | (x >> 2);
}

function expand6(v: number): number {
  const x = v & 63;
  return (x << 2) | (x >> 4);
}

function rgb565(v: number): [number, number, number, number] {
  return [expand5(v >> 11), expand6(v >> 5), expand5(v), 255];
}

function nibbles(v: number, order: [number, number, number, number]): [number, number, number, number] {
  return order.map((shift) => (((v >> shift) & 15) * 17) as number) as [number, number, number, number];
}

/**
 * The four colours of a DXT colour block; `punch` allows the transparent fourth (DXT1 only).
 */
function dxtColours(b: Buffer, punch: boolean): [number, number, number, number][] {
  const c0 = b.readUInt16LE(0);
  const c1 = b.readUInt16LE(2);
  const p = rgb565(c0);
  const q = rgb565(c1);
  const mix = (a: number, bb: number, wa: number, wb: number) => Math.trunc((a * wa + bb * wb) / (wa + wb));
  const blend = (wa: number, wb: number): [number, number, number, number] => [
    mix(p[0], q[0], wa, wb),
    mix(p[1], q[1], wa, wb),
    mix(p[2], q[2], wa, wb),
    255
  ];
  if (c0 > c1 || !punch) return [p, q, blend(2, 1), blend(1, 2)];
  return [p, q, blend(1, 1), [0, 0, 0, 0]];
}

/** The 16 texels of a DXT colour block, row by row. */
function dxtTexels(b: Buffer, punch: boolean): [number, number, number, number][] {
  const colours = dxtColours(b, punch);
  const bits = b.readUInt32LE(4);
  return Array.from({ length: 16 }, (_, k) => colours[(bits >>> (2 * k)) & 3]!);
}

/**
 * The 16 values of an 8-byte single-channel block (DXT5's alpha, BC4, each half of BC5).
 */
function channelBlock(b: Buffer): number[] {
  const a0 = b[0]!;
  const a1 = b[1]!;
  const values: number[] =
    a0 > a1
      ? Array.from({ length: 8 }, (_, i) => (i === 0 ? a0 : i === 1 ? a1 : Math.trunc(((8 - i) * a0 + (i - 1) * a1) / 7)))
      : Array.from({ length: 8 }, (_, i) => (i === 0 ? a0 : i === 1 ? a1 : i === 6 ? 0 : i === 7 ? 255 : Math.trunc(((6 - i) * a0 + (i - 1) * a1) / 5)));
  let bits = 0n;
  for (let i = 7; i >= 2; i--) bits = (bits << 8n) | BigInt(b[i]!);
  return Array.from({ length: 16 }, (_, k) => values[Number((bits >> BigInt(3 * k)) & 7n)]!);
}

function dxt5(b: Buffer): [number, number, number, number][] {
  const texels = dxtTexels(b.subarray(8), false);
  const alpha = channelBlock(b.subarray(0, 8));
  return texels.map((t, k) => [t[0], t[1], t[2], alpha[k]!] as [number, number, number, number]);
}

function bc4(b: Buffer): [number, number, number, number][] {
  return channelBlock(b).map((r) => [r, r, r, 255] as [number, number, number, number]);
}

function bc5(b: Buffer): [number, number, number, number][] {
  const red = channelBlock(b.subarray(0, 8));
  const green = channelBlock(b.subarray(8));
  return Array.from({ length: 16 }, (_, k) => {
    // A unit normal's z from its x and y, each stored as 0..255 for -1..1.
    const x = red[k]! / 127.5 - 1.0;
    const y = green[k]! / 127.5 - 1.0;
    const z = Math.sqrt(Math.max(0.0, 1.0 - x * x - y * y));
    return [red[k]!, green[k]!, Math.trunc((z + 1.0) * 127.5), 255] as [number, number, number, number];
  });
}

/**
 * Decode a width x height picture (`data` starts with it) into RGBA, rows in stored order.
 * Throws when `data` is too short for `layout` at this size.
 */
export function decodePixels(layout: PixelLayout, width: number, height: number, data: Buffer): Buffer {
  const need = pixelDataSize(layout, width, height);
  if (need === null || width === 0 || height === 0) {
    throw new Error(`Invalid picture layout request: ${width}x${height} ${layout}`);
  }
  if (data.length < need) {
    throw new Error(`Truncated pixel data: ${data.length} bytes, ${need} needed`);
  }
  const out = Buffer.alloc(width * height * 4);
  const w = width;
  const h = height;
  const put = (px: Iterable<[number, number, number, number]>): void => {
    let i = 0;
    for (const p of px) {
      out[i++] = p[0];
      out[i++] = p[1];
      out[i++] = p[2];
      out[i++] = p[3];
    }
  };
  const u16s = (d: Buffer): number[] => Array.from({ length: Math.floor(d.length / 2) }, (_, i) => d.readUInt16LE(i * 2));

  switch (layout) {
    case "alpha8":
      put(Array.from(data.subarray(0, need), (a) => [255, 255, 255, a] as [number, number, number, number]));
      break;
    case "r8":
      put(Array.from(data.subarray(0, need), (r) => [r, r, r, 255] as [number, number, number, number]));
      break;
    case "rgb24": {
      const rows: [number, number, number, number][] = [];
      for (let i = 0; i + 2 < need; i += 3) rows.push([data[i]!, data[i + 1]!, data[i + 2]!, 255]);
      put(rows);
      break;
    }
    case "rgba32":
      put(Array.from({ length: need / 4 }, (_, i) => [data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!, data[i * 4 + 3]!] as [number, number, number, number]));
      break;
    case "argb32":
      put(Array.from({ length: need / 4 }, (_, i) => [data[i * 4 + 1]!, data[i * 4 + 2]!, data[i * 4 + 3]!, data[i * 4]!] as [number, number, number, number]));
      break;
    case "bgra32":
      put(Array.from({ length: need / 4 }, (_, i) => [data[i * 4 + 2]!, data[i * 4 + 1]!, data[i * 4]!, data[i * 4 + 3]!] as [number, number, number, number]));
      break;
    case "rgb565":
      put(u16s(data).map(rgb565));
      break;
    case "rgba4444":
      put(u16s(data).map((v) => nibbles(v, [12, 8, 4, 0])));
      break;
    case "argb4444":
      put(u16s(data).map((v) => nibbles(v, [8, 4, 0, 12])));
      break;
    default: {
      // 4x4 block formats, placed left to right then row by row
      const blockBytes = layout === "dxt1" || layout === "bc4" ? 8 : 16;
      const blockCount = Math.ceil(w / 4) * Math.ceil(h / 4);
      if (data.length < blockCount * blockBytes) {
        throw new Error(`Truncated pixel data: ${data.length} bytes, ${blockCount * blockBytes} needed`);
      }
      const across = Math.ceil(w / 4);
      const texel = new Uint8Array(w * h * 4);
      for (let bIdx = 0; bIdx < blockCount; bIdx++) {
        const block = data.subarray(bIdx * blockBytes, (bIdx + 1) * blockBytes);
        const decoded: [number, number, number, number][] =
          layout === "dxt1"
            ? dxtTexels(block, true)
            : layout === "dxt5"
              ? dxt5(block)
              : layout === "bc4"
                ? bc4(block)
                : layout === "bc5"
                  ? bc5(block)
                  : layout === "bc6h" || layout === "bc6hSigned"
                    ? (() => {
                        const tmp = Buffer.alloc(64);
                        decodeBc6hBlock(block, layout === "bc6hSigned", tmp, 0);
                        return Array.from({ length: 16 }, (_, k) => [tmp[k * 4]!, tmp[k * 4 + 1]!, tmp[k * 4 + 2]!, tmp[k * 4 + 3]!] as [number, number, number, number]);
                      })()
                    : (() => {
                        const tmp = Buffer.alloc(64);
                        decodeBc7Block(block, tmp, 0);
                        return Array.from({ length: 16 }, (_, k) => [tmp[k * 4]!, tmp[k * 4 + 1]!, tmp[k * 4 + 2]!, tmp[k * 4 + 3]!] as [number, number, number, number]);
                      })();
        const bx = bIdx % across;
        const by = Math.floor(bIdx / across);
        for (let k = 0; k < 16; k++) {
          const x = bx * 4 + (k % 4);
          const y = by * 4 + Math.floor(k / 4);
          if (x < w && y < h) {
            const at = (y * w + x) * 4;
            texel[at] = decoded[k]![0];
            texel[at + 1] = decoded[k]![1];
            texel[at + 2] = decoded[k]![2];
            texel[at + 3] = decoded[k]![3];
          }
        }
      }
      out.set(texel);
      break;
    }
  }
  return out;
}

/** Flip a width-wide RGBA picture upside down (Unity stores the bottom row first). */
export function flipRows(rgba: Buffer, width: number): Buffer {
  const row = Math.max(1, width * 4);
  const rows: Buffer[] = [];
  for (let at = 0; at < rgba.length; at += row) rows.push(rgba.subarray(at, Math.min(at + row, rgba.length)));
  return Buffer.concat(rows.reverse());
}

import * as fs from "node:fs/promises";

/**
 * Reader for Chromium data packs (resources.pak, chrome_100_percent.pak, locales/*.pak).
 *
 * Layouts (ui/base/resource/data_pack.cc):
 *   v3: u32 version, u32 encoding, u32 resourceCount
 *   v4: u32 version, u32 resourceCount, u8 encoding                       (9 bytes)
 *   v5: u32 version, u8 encoding, 3 padding bytes, u16 resourceCount, u16 aliasCount   (12 bytes)
 * followed by (resourceCount + 1) index entries { u16 id, u32 offset } (the last one only marks the end
 * of the data), and for v5 aliasCount entries { u16 id, u16 entryIndex } that reuse another entry's data.
 */

const ENTRY_SIZE = 6;
const ALIAS_SIZE = 4;

export interface ChromiumPakResource {
  id: number;
  offset: number;
  size: number;
  /** Set when the resource is an alias sharing another resource's data */
  aliasOf?: number;
}

export interface ChromiumPak {
  version: 3 | 4 | 5;
  /** 0 = unknown, 1 = UTF-8, 2 = UTF-16, 3 = binary */
  encoding: number;
  fileSize: number;
  resources: ChromiumPakResource[];
}

export class ChromiumPakParser {
  static async readPak(filePath: string): Promise<ChromiumPak | null> {
    let fh: fs.FileHandle | undefined;
    try {
      fh = await fs.open(filePath, "r");
      const fileSize = (await fh.stat()).size;
      if (fileSize < 12) return null;

      const head = Buffer.alloc(12);
      await fh.read(head, 0, 12, 0);
      const version = head.readUInt32LE(0);

      let encoding: number;
      let count: number;
      let aliasCount = 0;
      let headerLen: number;
      if (version === 4) {
        count = head.readUInt32LE(4);
        encoding = head.readUInt8(8);
        headerLen = 9;
      } else if (version === 5) {
        encoding = head.readUInt8(4);
        count = head.readUInt16LE(8);
        aliasCount = head.readUInt16LE(10);
        headerLen = 12;
      } else if (version === 3) {
        encoding = head.readUInt32LE(4);
        count = head.readUInt32LE(8);
        headerLen = 12;
      } else {
        return null;
      }
      if (encoding > 3) return null;

      const tableLen = (count + 1) * ENTRY_SIZE;
      const dataStart = headerLen + tableLen + aliasCount * ALIAS_SIZE;
      if (count > 1_000_000 || dataStart > fileSize) return null;

      const table = Buffer.alloc(tableLen + aliasCount * ALIAS_SIZE);
      await fh.read(table, 0, table.length, headerLen);

      const resources: ChromiumPakResource[] = [];
      let prevOffset = dataStart;
      let prevId = -1;
      for (let i = 0; i <= count; i++) {
        const id = table.readUInt16LE(i * ENTRY_SIZE);
        const offset = table.readUInt32LE(i * ENTRY_SIZE + 2);
        if (offset < prevOffset || offset > fileSize) return null;
        if (i > 0) {
          resources[i - 1].size = offset - resources[i - 1].offset;
        }
        if (i < count) {
          if (id <= prevId && !(i === 0 && id === 0)) return null; // ids are sorted
          resources.push({ id, offset, size: 0 });
          prevId = id;
        }
        prevOffset = offset;
      }

      for (let i = 0; i < aliasCount; i++) {
        const base = tableLen + i * ALIAS_SIZE;
        const id = table.readUInt16LE(base);
        const index = table.readUInt16LE(base + 2);
        if (index >= resources.length) return null;
        const target = resources[index];
        resources.push({ id, offset: target.offset, size: target.size, aliasOf: target.id });
      }

      return { version: version as 3 | 4 | 5, encoding, fileSize, resources };
    } catch {
      return null;
    } finally {
      await fh?.close();
    }
  }

  static async readResource(fh: fs.FileHandle, resource: ChromiumPakResource): Promise<Buffer> {
    const buf = Buffer.alloc(resource.size);
    let done = 0;
    while (done < resource.size) {
      const { bytesRead } = await fh.read(buf, done, resource.size - done, resource.offset + done);
      if (bytesRead === 0) throw new Error("Unexpected end of file while reading a resource");
      done += bytesRead;
    }
    return buf;
  }
}

/**
 * Best-effort file extension for a resource, from magic numbers and light text heuristics:
 * png/jpg/gif/webp/ico/woff/woff2/gz binary magics, then html/svg/json/js/css/txt for text, else bin.
 */
export function guessResourceExtension(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.length >= 6 && data.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "wOF2") return "woff2";
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "wOFF") return "woff";
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return "ico";
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "gz";
  if (data.length === 0) return "bin";

  const sample = data.subarray(0, 4096);
  if (sample.includes(0)) return "bin";
  const text = sample.toString("utf8");
  const bad = (text.match(/[\u0000-\u0008\u000e-\u001f�]/g) ?? []).length;
  if (bad / Math.max(1, text.length) > 0.02) return "bin";

  const head = text.trimStart().slice(0, 300).toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || /<(html|head|body)[\s>]/.test(head)) return "html";
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";

  const first = head[0];
  if ((first === "{" || first === "[") && data.length <= 2 * 1024 * 1024) {
    try {
      JSON.parse(data.toString("utf8"));
      return "json";
    } catch {
      // Not JSON: fall through to JS / CSS / text
    }
  }
  if (/^(\(function|!function|function\b|"use strict"|'use strict'|var\s|let\s|const\s|import\s|export\s|class\s|\(\(\)|\(\s*\(\s*\)\s*=>)/.test(head)) return "js";
  if (/^(@charset|@import|@media|@font-face|@keyframes|:root|html\b|body\b)/.test(head) || /^[\s\S]{0,80}[.#a-z][\w\s.#:>*,[\]=-]*\{[^}]*:[^}]*[;}]/.test(head)) return "css";
  if (/^(\/\/|\/\*)/.test(head)) return /\{[^}]*:[^}]*;/.test(head) && !/\b(function|var|const|let)\b/.test(head) ? "css" : "js";
  return "txt";
}

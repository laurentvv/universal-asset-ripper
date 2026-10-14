import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parsePeHeaderArch, readHeaderBytes } from "../utils/file-utils.js";
import { createPakKeyVerifier, validatePakKey, type PakKeyValidation } from "../parsers/unreal/pak-index.js";
import type { AesKeyCandidate, BinaryScanResult } from "../types/index.js";

// Rijndael AES SubBytes first 16 bytes
const AES_SBOX_PREFIX = Buffer.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5,
  0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76
]);

// Inverse S-box first 8 bytes (excluded from key windows, like the forward table)
const AES_INV_SBOX_PREFIX = Buffer.from([0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38]);

// IL2CPP global-metadata.dat magic: 0xFAB11BAF (in little endian: AF 1B B1 FA)
const IL2CPP_METADATA_MAGIC = 0xfab11baf;

const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;
const LEFT_OVERLAP = 128; // lets a chunk see that a hex run actually started before it
const RIGHT_OVERLAP = 16 * 1024; // lets a chunk finish runs and S-box windows that cross its end
/** Full AES S-box and inverse S-box, computed once, used to reject candidates that are table fragments */
const AES_TABLES_HEX = (() => {
  const sbox = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const rot = (v: number, n: number) => ((v << n) | (v >> (8 - n))) & 0xff;
    sbox[p] = (q ^ rot(q, 1) ^ rot(q, 2) ^ rot(q, 3) ^ rot(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  sbox[0] = 0x63;
  const inv = new Uint8Array(256);
  sbox.forEach((v, i) => (inv[v] = i));
  return [Buffer.from(sbox).toString("hex"), Buffer.from(inv).toString("hex")];
})();

function isAesTableFragment(keyHex: string): boolean {
  const h = keyHex.replace(/^0x/i, "").toLowerCase();
  // Any 8-byte run lifted from a table means the window overlaps the table itself
  for (let i = 0; i + 16 <= h.length; i += 2) {
    const run = h.slice(i, i + 16);
    if (AES_TABLES_HEX.some((t) => t.includes(run))) return true;
  }
  return false;
}

const SBOX_WINDOW = 8192;
const SBOX_SITE_LIMIT = 16;
const HEX_CANDIDATE_CAP = 20000;
const VERIFY_CAP = 20000;
const DEFAULT_MAX_SHOWN = 50;
const MIN_HEX_STRING_ENTROPY = 3.5;

export interface FilteredCounts {
  longerHexRun: number;
  sequential: number;
  lowEntropy: number;
  repeatedBlock: number;
  trivial: number;
}

export type HexRejectReason = keyof FilteredCounts;

export interface ScanOptions {
  /** Pak used to verify every candidate (decrypts its index / probes an encrypted entry) */
  pakPath?: string;
  /** Maximum number of candidates in the returned list (default 50); verified ones are never hidden */
  maxShown?: number;
  /** Bytes read per chunk (default 16 MiB); mostly useful for tests */
  chunkBytes?: number;
}

const emptyFiltered = (): FilteredCounts => ({
  longerHexRun: 0,
  sequential: 0,
  lowEntropy: 0,
  repeatedBlock: 0,
  trivial: 0
});

export class BinaryScanner {
  /**
   * Calculate Shannon entropy of a byte buffer
   */
  static calculateEntropy(buffer: Buffer): number {
    if (buffer.length === 0) return 0;
    const frequencies = new Array(256).fill(0);
    for (let i = 0; i < buffer.length; i++) {
      frequencies[buffer[i]]++;
    }

    let entropy = 0;
    for (let i = 0; i < 256; i++) {
      if (frequencies[i] > 0) {
        const p = frequencies[i] / buffer.length;
        entropy -= p * Math.log2(p);
      }
    }
    return entropy;
  }

  /**
   * Classify a 64-char hex string that is not itself part of a longer hex run. Returns the reason it
   * is probably not a key (all one digit, repeated block, counting table, low entropy) or null.
   */
  static classifyHexKey(hex: string): HexRejectReason | null {
    const lower = hex.toLowerCase();
    if (/^(.)\1+$/.test(lower)) return "trivial";

    // A block of 2..32 hex chars repeated to fill the key (e.g. 0011..ff twice, abababab...)
    for (const len of [2, 4, 8, 16, 32]) {
      if (lower.length % len === 0 && lower === lower.slice(0, len).repeat(lower.length / len)) {
        return "repeatedBlock";
      }
    }

    // Counting tables: 000102030405..., or 0123456789abcdef0123...
    const bytes = Buffer.from(lower, "hex");
    let stepPairs = 0;
    for (let i = 1; i < bytes.length; i++) {
      const d = (bytes[i] - bytes[i - 1] + 256) % 256;
      if (d === 1 || d === 255) stepPairs++;
    }
    let nibblePairs = 0;
    for (let i = 1; i < lower.length; i++) {
      const a = parseInt(lower[i - 1], 16);
      const b = parseInt(lower[i], 16);
      if ((b - a + 16) % 16 === 1 || (a - b + 16) % 16 === 1) nibblePairs++;
    }
    if (stepPairs / Math.max(1, bytes.length - 1) >= 0.5 || nibblePairs / Math.max(1, lower.length - 1) >= 0.7) {
      return "sequential";
    }

    if (this.calculateEntropy(Buffer.from(lower, "latin1")) < MIN_HEX_STRING_ENTROPY) return "lowEntropy";
    return null;
  }

  /**
   * Search for hex string AES keys (64 hex chars, optionally 0x-prefixed). Hex runs longer than 64
   * characters are skipped entirely: every 64-char window of them is a subsequence of a longer run
   * (hash tables, base-16 blobs), not a stand-alone key string.
   */
  static searchHexAesStrings(
    buffer: Buffer,
    stats: FilteredCounts = emptyFiltered()
  ): Array<{ keyHex: string; offset: number }> {
    return this.scanHexRuns(buffer.toString("latin1"), 0, 0, Infinity, stats);
  }

  /**
   * Run detection over an already decoded latin1 string. Only runs starting at index
   * minStart <= index < maxStart are reported (a chunk owns those); offsets are shifted by baseOffset.
   */
  private static scanHexRuns(
    text: string,
    baseOffset: number,
    minStart: number,
    maxStart: number,
    stats: FilteredCounts
  ): Array<{ keyHex: string; offset: number }> {
    const results: Array<{ keyHex: string; offset: number }> = [];
    const regex = /[A-Fa-f0-9]{64,}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index < minStart) continue;
      if (match.index >= maxStart) break;
      const run = match[0];
      if (run.length > 64) {
        stats.longerHexRun++;
        continue;
      }
      const reason = this.classifyHexKey(run);
      if (reason) {
        stats[reason]++;
        continue;
      }
      results.push({ keyHex: `0x${run.toLowerCase()}`, offset: baseOffset + match.index });
    }
    return results;
  }

  /**
   * Offsets of every Rijndael S-box table in the buffer (up to `max`)
   */
  static findSBoxOffsets(buffer: Buffer, max = SBOX_SITE_LIMIT): number[] {
    const offsets: number[] = [];
    let from = 0;
    while (offsets.length < max) {
      const idx = buffer.indexOf(AES_SBOX_PREFIX, from);
      if (idx < 0) break;
      offsets.push(idx);
      from = idx + AES_SBOX_PREFIX.length;
    }
    return offsets;
  }

  /**
   * High-entropy 32-byte windows around one S-box table. `window` starts at file offset `windowBase`
   * and contains the table at `sboxAbs`; the tables themselves (forward and inverse) are never reported.
   */
  static searchNearSBoxAt(
    window: Buffer,
    windowBase: number,
    sboxAbs: number
  ): Array<{ keyHex: string; offset: number; entropy: number; distanceFromSBox: number }> {
    const candidates: Array<{ keyHex: string; offset: number; entropy: number; distanceFromSBox: number }> = [];
    const tables: Array<[number, number]> = [[sboxAbs, sboxAbs + 256]];
    const inv = window.indexOf(AES_INV_SBOX_PREFIX, Math.max(0, sboxAbs - windowBase - SBOX_WINDOW));
    if (inv >= 0 && Math.abs(inv + windowBase - sboxAbs) <= SBOX_WINDOW + 256) {
      tables.push([inv + windowBase, inv + windowBase + 256]);
    }

    const first = Math.max(windowBase, sboxAbs - SBOX_WINDOW);
    const last = Math.min(windowBase + window.length - 32, sboxAbs + 256 + SBOX_WINDOW);
    for (let pos = first + ((4 - (first % 4)) % 4); pos <= last; pos += 4) {
      if (tables.some(([s, e]) => pos < e && pos + 32 > s)) continue;
      const chunk = window.subarray(pos - windowBase, pos - windowBase + 32);
      const entropy = this.calculateEntropy(chunk);
      // 32 distinct bytes give 5.0; random keys are normally > 4.6
      if (entropy > 4.6) {
        const distance = pos >= sboxAbs + 256 ? pos - (sboxAbs + 256) : sboxAbs - (pos + 32);
        candidates.push({
          keyHex: `0x${chunk.toString("hex")}`,
          offset: pos,
          entropy,
          distanceFromSBox: Math.max(0, distance)
        });
      }
    }
    return candidates;
  }

  /**
   * Search for binary AES keys near AES S-box constants (every S-box in the buffer, tables excluded)
   */
  static searchNearSBox(
    buffer: Buffer
  ): Array<{ keyHex: string; offset: number; entropy: number; distanceFromSBox: number }> {
    return this.findSBoxOffsets(buffer).flatMap((s) => this.searchNearSBoxAt(buffer, 0, s));
  }

  /**
   * Inspect IL2CPP global-metadata.dat
   */
  static async inspectIl2CppMetadata(filePath: string): Promise<{ version: number; validMagic: boolean } | null> {
    try {
      const header = await readHeaderBytes(filePath, 32);
      if (header.length < 8) return null;

      const magic = header.readUInt32LE(0);
      if (magic === IL2CPP_METADATA_MAGIC) {
        const version = header.readInt32LE(4);
        return { version, validMagic: true };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check a candidate key against an Unreal pak using the native index reader (decrypts the index
   * and sanity checks the mount point; plain-index paks are probed through an encrypted entry).
   */
  static async validateKeyAgainstPak(pakPath: string, keyHex: string): Promise<PakKeyValidation> {
    return validatePakKey(pakPath, keyHex);
  }

  private static confidenceRank(c: AesKeyCandidate["confidence"]): number {
    return c === "high" ? 0 : c === "medium" ? 1 : 2;
  }

  private static verifiedRank(c: AesKeyCandidate): number {
    return c.verified === true ? 0 : c.verified === false ? 2 : 1;
  }

  private static compareCandidates(a: AesKeyCandidate, b: AesKeyCandidate): number {
    return (
      this.verifiedRank(a) - this.verifiedRank(b) ||
      this.confidenceRank(a.confidence) - this.confidenceRank(b.confidence) ||
      (a.distanceFromSBox ?? 0) - (b.distanceFromSBox ?? 0) ||
      a.offset - b.offset
    );
  }

  /**
   * Choose the candidates to show: every verified key, then an even share of string and S-box
   * candidates (a share nobody uses goes to the other kind), so neither kind hides the other.
   */
  private static selectShown(all: AesKeyCandidate[], maxShown: number): AesKeyCandidate[] {
    all = all.filter((c) => !isAesTableFragment(c.keyHex));
    const verified = all.filter((c) => c.verified === true);
    const rest = all.filter((c) => c.verified !== true);
    const slots = Math.max(0, maxShown - verified.length);
    const hex = rest.filter((c) => c.pattern === "Hex String Pattern").sort((a, b) => this.compareCandidates(a, b));
    const sbox = rest.filter((c) => c.pattern !== "Hex String Pattern").sort((a, b) => this.compareCandidates(a, b));

    let takeHex = Math.min(hex.length, Math.ceil(slots / 2));
    let takeSbox = Math.min(sbox.length, slots - takeHex);
    takeHex = Math.min(hex.length, slots - takeSbox);
    takeSbox = Math.min(sbox.length, slots - takeHex);

    return [...verified, ...hex.slice(0, takeHex), ...sbox.slice(0, takeSbox)].sort((a, b) =>
      this.compareCandidates(a, b)
    );
  }

  /**
   * Perform comprehensive binary scan on an executable or dump. The whole file is read in
   * overlapping chunks (never only a prefix).
   */
  static async scanBinary(binaryPath: string, options: ScanOptions = {}): Promise<BinaryScanResult> {
    const arch = await parsePeHeaderArch(binaryPath);
    const stat = await fs.stat(binaryPath);
    const fileSize = Number(stat.size);
    const chunkBytes = Math.max(1024, options.chunkBytes ?? SCAN_CHUNK_BYTES);
    const maxShown = Math.max(1, options.maxShown ?? DEFAULT_MAX_SHOWN);

    const filteredOut = emptyFiltered();
    const hexFound: Array<{ keyHex: string; offset: number }> = [];
    const sboxSites: number[] = [];
    const signatureNeedles: Array<[string, string]> = [
      ["UnrealEngine", "UnrealEngine signature"],
      ["FArchive", "Unreal Serialization (FArchive)"],
      ["UnityPlayer", "UnityPlayer runtime reference"],
      ["il2cpp", "IL2CPP runtime symbols"],
      ["Godot Engine", "Godot Engine banner string"]
    ];
    const stringsFound: string[] = [];
    let candidateCapReached = false;

    const recommendations: string[] = [];
    let fileHandle: fs.FileHandle | undefined;

    try {
      fileHandle = await fs.open(binaryPath, "r");

      // Phase 1: sweep the whole file chunk by chunk
      for (let ownStart = 0; ownStart < fileSize; ownStart += chunkBytes) {
        const ownEnd = Math.min(fileSize, ownStart + chunkBytes);
        const readStart = Math.max(0, ownStart - LEFT_OVERLAP);
        const readEnd = Math.min(fileSize, ownEnd + RIGHT_OVERLAP);
        const buffer = Buffer.alloc(readEnd - readStart);
        let done = 0;
        while (done < buffer.length) {
          const { bytesRead } = await fileHandle.read(buffer, done, buffer.length - done, readStart + done);
          if (bytesRead === 0) break;
          done += bytesRead;
        }
        const data = done === buffer.length ? buffer : buffer.subarray(0, done);
        const text = data.toString("latin1");

        if (hexFound.length < HEX_CANDIDATE_CAP) {
          const runs = this.scanHexRuns(text, readStart, ownStart - readStart, ownEnd - readStart, filteredOut);
          for (const r of runs) {
            if (hexFound.length >= HEX_CANDIDATE_CAP) {
              candidateCapReached = true;
              break;
            }
            hexFound.push(r);
          }
        } else {
          candidateCapReached = true;
        }

        for (const rel of this.findSBoxOffsets(data, SBOX_SITE_LIMIT)) {
          const abs = readStart + rel;
          if (abs >= ownStart && abs < ownEnd && sboxSites.length < SBOX_SITE_LIMIT) sboxSites.push(abs);
        }

        for (const [needle, label] of signatureNeedles) {
          if (!stringsFound.includes(label) && text.includes(needle)) stringsFound.push(label);
        }
      }

      // Phase 2: windows around each S-box table
      const sboxFound: Array<{ keyHex: string; offset: number; entropy: number; distanceFromSBox: number }> = [];
      for (const site of sboxSites) {
        const winStart = Math.max(0, site - SBOX_WINDOW - 64);
        const winEnd = Math.min(fileSize, site + 256 + SBOX_WINDOW + 64);
        const win = Buffer.alloc(winEnd - winStart);
        const { bytesRead } = await fileHandle.read(win, 0, win.length, winStart);
        sboxFound.push(...this.searchNearSBoxAt(win.subarray(0, bytesRead), winStart, site));
      }

      // Merge: identical keys collapse into one candidate with an occurrence count
      const merged = new Map<string, AesKeyCandidate>();
      for (const hk of hexFound) {
        const rawBuf = Buffer.from(hk.keyHex.slice(2), "hex");
        const entropy = this.calculateEntropy(rawBuf);
        const id = `hex|${hk.keyHex}`;
        const existing = merged.get(id);
        if (existing) {
          existing.occurrences = (existing.occurrences ?? 1) + 1;
        } else {
          merged.set(id, {
            keyHex: hk.keyHex,
            offset: hk.offset,
            entropy,
            confidence: entropy > 4.2 ? "high" : "medium",
            pattern: "Hex String Pattern",
            occurrences: 1
          });
        }
      }
      for (const sk of sboxFound) {
        const id = `sbox|${sk.keyHex}`;
        const existing = merged.get(id);
        if (existing) {
          existing.occurrences = (existing.occurrences ?? 1) + 1;
        } else {
          merged.set(id, {
            keyHex: sk.keyHex,
            offset: sk.offset,
            entropy: sk.entropy,
            confidence: "medium",
            pattern: "Near Rijndael S-Box",
            occurrences: 1,
            distanceFromSBox: sk.distanceFromSBox
          });
        }
      }
      const all = [...merged.values()];
      const candidateCounts = {
        hexString: all.filter((c) => c.pattern === "Hex String Pattern").length,
        sbox: all.filter((c) => c.pattern !== "Hex String Pattern").length
      };

      // Optional verification against a pak, over every candidate (not just the ones shown)
      let verifiedAgainst: string | undefined;
      if (options.pakPath) {
        verifiedAgainst = options.pakPath;
        const verify = await createPakKeyVerifier(options.pakPath);
        const byKey = new Map<string, Awaited<ReturnType<typeof verify>>>();
        for (const c of all.slice(0, VERIFY_CAP)) {
          let result = byKey.get(c.keyHex);
          if (!result) {
            try {
              result = await verify(c.keyHex);
            } catch (err) {
              result = { valid: null, reason: err instanceof Error ? err.message : String(err) };
            }
            byKey.set(c.keyHex, result);
          }
          c.verified = result.valid;
          c.verification = result.reason;
        }
        if (all.length > VERIFY_CAP) {
          recommendations.push(`Only the first ${VERIFY_CAP} of ${all.length} candidates were checked against the pak.`);
        }
      }

      const shown = this.selectShown(all, maxShown);

      // Check sibling files for global-metadata.dat
      let il2cppMetadata: BinaryScanResult["il2cppMetadata"];
      const parentDir = path.dirname(binaryPath);
      const possibleMetadataPaths = [
        path.join(parentDir, "il2cpp_data", "Metadata", "global-metadata.dat"),
        path.join(parentDir, "Metadata", "global-metadata.dat"),
        path.join(parentDir, "global-metadata.dat")
      ];

      for (const metaPath of possibleMetadataPaths) {
        try {
          const metaStat = await fs.stat(metaPath);
          if (metaStat.isFile()) {
            const res = await this.inspectIl2CppMetadata(metaPath);
            if (res) {
              il2cppMetadata = {
                validMagic: res.validMagic,
                version: res.version,
                offset: 0
              };
              recommendations.push(`Found IL2CPP global-metadata.dat v${res.version}. Reconstruct CIL bytecode with Cpp2IL (SamboyCoding/Cpp2IL) or dump signatures with Il2CppDumper / REA.`);
              break;
            }
          }
        } catch {
          // Continue
        }
      }

      if (all.length > 0) {
        recommendations.push(
          `${all.length} candidate AES-256 keys (${candidateCounts.hexString} hex strings, ${candidateCounts.sbox} near an S-box), showing ${shown.length}.` +
            (candidateCapReached ? " A safety cap stopped collecting more hex strings." : "")
        );
        const verifiedKeys = shown.filter((c) => c.verified === true);
        if (options.pakPath && verifiedKeys.length > 0) {
          recommendations.push(
            `Verified key opens ${path.basename(options.pakPath)}: ripper extract <pak> --aes-key ${verifiedKeys[0].keyHex}`
          );
        } else if (options.pakPath) {
          const unverifiable = all.some((c) => c.verified === null);
          recommendations.push(
            unverifiable
              ? "The pak gives no way to prove a key (plain index, nothing encrypted to probe): candidates stay unverified."
              : `None of the ${all.length} candidates opens ${path.basename(options.pakPath)}.`
          );
        } else {
          recommendations.push(`Test them with 'ripper rea-inspect <binary> --pak <file.pak>' or 'ripper extract <pak> --aes-key <key>'.`);
        }
      } else {
        recommendations.push("No obvious plaintext AES key found. Consider using Ghidra (static decompilation) or Frida (dynamic runtime hooking of FAES::Decrypt).");
      }

      return {
        binaryPath,
        arch,
        candidateAesKeys: shown,
        candidateTotal: all.length,
        candidatesShown: shown.length,
        candidateCounts,
        filteredOut,
        scannedBytes: fileSize,
        ...(candidateCapReached ? { candidateCapReached: true } : {}),
        ...(verifiedAgainst ? { verifiedAgainst } : {}),
        il2cppMetadata,
        stringsFound,
        recommendations
      };
    } finally {
      if (fileHandle) {
        await fileHandle.close();
      }
    }
  }
}

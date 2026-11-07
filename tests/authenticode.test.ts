import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { authenticodeSummary, computeAuthenticodeHash, readAuthenticodeTable } from "../src/parsers/pe/authenticode.js";
import { ApplicationAuditor } from "../src/pipeline/application-auditor.js";
import { minimalPe } from "./helpers/minimal-pe.js";

/** DER length bytes for a content of `len` bytes (short and long forms). */
function derLen(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let v = len;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

function oid(der: string): Buffer {
  return tlv(0x06, Buffer.from(der, "hex"));
}

/** SpcIndirectDataContent wrapping a sha256 DigestInfo of `fileHash`. */
function buildSpcEcontent(fileHash: Buffer): Buffer {
  const attribute = tlv(0x30, Buffer.concat([oid("2b060104018237020104"), Buffer.from([0x05, 0x00])])); // 1.3.6.1.4.1.311.2.1.4 + NULL
  const sha256Oid = oid("608648016503040201"); // 2.16.840.1.101.3.4.2.1
  const algId = tlv(0x30, Buffer.concat([sha256Oid, Buffer.from([0x05, 0x00])]));
  const digestInfo = tlv(0x30, Buffer.concat([algId, tlv(0x04, fileHash)]));
  return tlv(0x30, Buffer.concat([attribute, digestInfo]));
}

/** A PE fixture with dirCount=5 and a security directory entry pointing at the appended table. */
function peWithCertTable(certTable: Buffer, pe32Plus = true): Buffer {
  const pe = Buffer.from(minimalPe());
  pe.writeUInt16LE(pe32Plus ? 0x020b : 0x010b, 128 + 24);
  if (!pe32Plus) pe.writeUInt16LE(224, 128 + 20); // sizeOfOptionalHeader for PE32
  const dirCountPos = pe32Plus ? 128 + 24 + 108 : 128 + 24 + 92;
  const dirsPos = pe32Plus ? 128 + 24 + 112 : 128 + 24 + 96;
  pe.writeUInt32LE(5, dirCountPos);
  const tableAt = pe.length;
  pe.writeUInt32LE(tableAt, dirsPos + 4 * 8);
  pe.writeUInt32LE(certTable.length, dirsPos + 4 * 8 + 4);
  return Buffer.concat([pe, certTable]);
}

function winCert(payload: Buffer, type = 2, revision = 0x0200): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(8 + payload.length, 0);
  header.writeUInt16LE(revision, 4);
  header.writeUInt16LE(type, 6);
  const padded = Buffer.concat([payload, Buffer.alloc((8 - (payload.length % 8)) % 8)]);
  return Buffer.concat([header, padded]);
}

function opensslSelfSigned(dir: string): { certPem: string; keyPem: string } {
  const certPem = path.join(dir, "cert.pem");
  const keyPem = path.join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPem, "-out", certPem, "-days", "1", "-nodes", "-subj", "/CN=Fixture Test CA"]);
  return { certPem, keyPem };
}

function opensslSignDetached(econtent: Buffer, keys: { certPem: string; keyPem: string }, dir: string): Buffer {
  const inFile = path.join(dir, "econtent.bin");
  const outFile = path.join(dir, "sig.p7");
  writeFileSync(inFile, econtent);
  // -nodetach embeds the eContent (Authenticode signatures are attached); -noattr keeps the
  // SignerInfo minimal so the signature covers the econtent directly.
  execFileSync("openssl", ["smime", "-sign", "-binary", "-nodetach", "-noattr", "-md", "sha256", "-outform", "DER", "-signer", keys.certPem, "-inkey", keys.keyPem, "-in", inFile, "-out", outFile]);
  return readFileSync(outFile);
}

/** Real signed Windows binaries, most likely first. */
const SIGNED_CANDIDATES = ["C:/Windows/System32/dism.exe", "C:/Windows/System32/wuauclt.exe", "C:/Windows/System32/kernelbase.dll", "C:/Windows/System32/shell32.dll"];

async function findSignedBinary(): Promise<string> {
  for (const p of SIGNED_CANDIDATES) {
    try {
      const data = await fs.readFile(p);
      const table = readAuthenticodeTable(data);
      if (table && table.entries.length > 0) return p;
    } catch {
      // try the next candidate
    }
  }
  throw new Error("no signed Windows binary found among the candidates");
}

describe("Authenticode on real signed Windows binaries", () => {
  it("verifies the digest and the signature of a real system binary", async () => {
    const exe = await findSignedBinary();
    const data = await fs.readFile(exe);
    const table = readAuthenticodeTable(data)!;
    expect(table.withinFile).toBe(true);
    expect(table.entries.length).toBeGreaterThan(0);
    const summary = authenticodeSummary(table);
    expect(summary.signed).toBe(true);
    // Microsoft binaries sign their content with a digest this reader computes
    expect(["sha256", "sha1", "sha384", "sha512"]).toContain(summary.digestAlgorithm);
    expect(summary.fileHash).toBe("matches");
    expect(summary.signatureCheck).toBe("valid");
    expect(summary.signer).toMatch(/Microsoft/i);
    // Real-world fact: vendors embed the signer and an intermediate CA but never the root
    // (the root lives in the Windows trust store), so the embedded chain is incomplete.
    expect(summary.chainComplete).toBe(false);
    // Signer certificates are exposed with their subject and validity
    const sig = table.entries.find((e) => e.signature)?.signature;
    expect(sig!.certificates.length).toBeGreaterThan(0);
    expect(sig!.certificates[0]!.validFrom).toBeDefined();
  }, 30000);

  it("detects a tampered byte inside the hashed ranges (file hash differs)", async () => {
    const exe = await findSignedBinary();
    const data = Buffer.from(await fs.readFile(exe));
    data[0x42] ^= 0xff; // DOS stub: inside the hashed header range
    const sig = readAuthenticodeTable(data)!.entries.find((e) => e.signature)?.signature;
    expect(sig!.fileHash).toBe("differs");
    expect(sig!.fileDigest).not.toEqual(sig!.computedFileDigest);
    // The signature itself is untouched: it still verifies over the signed content
    expect(sig!.signatureCheck).toBe("valid");
  }, 30000);

  it("reports an unsigned binary (no security directory) as null", () => {
    expect(readAuthenticodeTable(minimalPe())).toBeNull();
  });
});

describe("Authenticode on a synthetic self-signed fixture", () => {
  it("round-trips a valid signature built with openssl", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "authenticode-"));
    try {
      const keys = opensslSelfSigned(tmp);
      // The Authenticode hash excludes the certificate table, and the table sits at EOF, so the
      // digest is stable across table sizes: hash any layout, sign, and the final PE matches.
      const probe = peWithCertTable(winCert(Buffer.alloc(64)));
      const hash = computeAuthenticodeHash(probe, "sha256");
      const sig = opensslSignDetached(buildSpcEcontent(hash), keys, tmp);
      const pe = peWithCertTable(winCert(sig));
      const table = readAuthenticodeTable(pe)!;
      const summary = authenticodeSummary(table);
      expect(summary.signed).toBe(true);
      expect(summary.digestAlgorithm).toBe("sha256");
      expect(summary.fileHash).toBe("matches");
      expect(summary.signatureCheck).toBe("valid");
      expect(summary.signer).toContain("Fixture Test CA");
      expect(summary.chainComplete).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 60000);

  it("flags a corrupted signature value while the file hash still matches", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "authenticode-"));
    try {
      const keys = opensslSelfSigned(tmp);
      const probe = peWithCertTable(winCert(Buffer.alloc(64)));
      const hash = computeAuthenticodeHash(probe, "sha256");
      const sig = opensslSignDetached(buildSpcEcontent(hash), keys, tmp);
      const pe = peWithCertTable(winCert(sig));
      const tableAt = pe.readUInt32LE(128 + 24 + 112 + 4 * 8);
      const entryLen = pe.readUInt32LE(tableAt);
      // Flip a byte at the very end of the signature payload: inside the table (excluded from
      // the hash) but inside the signature value.
      pe[tableAt + entryLen - 2] ^= 0xff;
      const summary = authenticodeSummary(readAuthenticodeTable(pe)!);
      expect(summary.fileHash).toBe("matches");
      expect(summary.signatureCheck).toBe("invalid");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }, 60000);
});

describe("Authenticode structural robustness", () => {
  it("warns on entries shorter than 8 bytes and entries running past the table", () => {
    const bad = Buffer.alloc(12);
    bad.writeUInt32LE(4, 0); // length < 8
    const table = readAuthenticodeTable(peWithCertTable(bad))!;
    expect(table.entries).toHaveLength(0);
    expect(table.warnings.some((w) => /too short/.test(w))).toBe(true);

    const overshoot = Buffer.alloc(32);
    overshoot.writeUInt32LE(0xffff, 0);
    const table2 = readAuthenticodeTable(peWithCertTable(overshoot))!;
    expect(table2.warnings.some((w) => /runs past the end/.test(w))).toBe(true);
  });

  it("reports a table that runs past EOF", () => {
    const pe = peWithCertTable(winCert(Buffer.alloc(16, 3)));
    const dirsPos = 128 + 24 + 112;
    pe.writeUInt32LE(pe.readUInt32LE(dirsPos + 4 * 8 + 4) + 4096, dirsPos + 4 * 8 + 4);
    const table = readAuthenticodeTable(pe)!;
    expect(table.withinFile).toBe(false);
    expect(table.warnings.some((w) => /but the file has/.test(w))).toBe(true);
  });

  it("refuses a garbage PKCS#7 payload as unparsed", () => {
    const pe = peWithCertTable(winCert(Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 31) % 251))));
    const table = readAuthenticodeTable(pe)!;
    expect(table.entries).toHaveLength(1);
    expect(table.entries[0]!.typeName).toContain("PKCS#7");
    expect(table.entries[0]!.signature!.parsed).toBe(false);
  });

  it("parses a PE32 (0x10b) header layout", () => {
    const pe = peWithCertTable(winCert(Buffer.alloc(16, 7)), false);
    const table = readAuthenticodeTable(pe)!;
    expect(table.entries).toHaveLength(1);
    expect(table.fileOffset).toBe(1024);
    expect(table.entries[0]!.certificateType).toBe(2);
  });

  it("never panics on truncated headers", () => {
    const pe = peWithCertTable(winCert(Buffer.alloc(64, 5)));
    for (let cut = 0; cut < pe.length; cut += 17) {
      expect(() => readAuthenticodeTable(pe.subarray(0, cut))).not.toThrow();
    }
  });
});

describe("Authenticode audit wiring", () => {
  it("reports the signature status of a real binary through ripper audit", async () => {
    const exe = await findSignedBinary();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-sig-"));
    try {
      await fs.copyFile(exe, path.join(dir, "signed-app.exe"));
      const report = await ApplicationAuditor.auditDirectory(dir, { maxDepth: 1 });
      expect(report.executables).toHaveLength(1);
      expect(report.executables[0]!.signature).toBeDefined();
      expect(report.executables[0]!.signature!.signed).toBe(true);
      const md = ApplicationAuditor.generateMarkdownReport(report);
      expect(md).toMatch(/Authenticode Signature.*signed/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

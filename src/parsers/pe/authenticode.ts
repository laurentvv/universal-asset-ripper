import { createHash, verify as cryptoVerify, X509Certificate } from "node:crypto";

/**
 * A PE file's Authenticode signature block: the certificate table (whose directory entry is a
 * file offset, not an RVA), the PKCS#7 inside it, the signer, and what can be checked with the
 * file alone: its hash against the signed one, the signature (RSA / ECDSA via node:crypto), and
 * how the embedded certificates link. Whether Windows would trust the signer, revocation and
 * catalog signing are out of reach.
 *
 * Clean-room TypeScript port of craft-anything crates/formats/src/authenticode.rs
 * (commit fc93bd0, MIT OR Apache-2.0); the DER/CMS walking is done by hand, and X.509
 * certificate details come from node:crypto's X509Certificate.
 */

const SECURITY_DIR = 4;
/** WIN_CERT_TYPE_PKCS_SIGNED_DATA. */
const CERT_PKCS_SIGNED = 2;
const SPC_INDIRECT_DATA = "1.3.6.1.4.1.311.2.1.4";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const MAX_ENTRIES = 64;

// ---------------------------------------------------------------------------------------------
// DER reading (a minimal TLV walk, enough for CMS structures)
// ---------------------------------------------------------------------------------------------

interface DerNode {
  tag: number;
  /** Position of the TLV's first byte (the tag itself). */
  tlvStart: number;
  /** Position of the first content byte. */
  start: number;
  /** Position just past the content. */
  end: number;
}

function derRead(buf: Buffer, pos: number): DerNode | null {
  if (pos + 2 > buf.length) return null;
  const tag = buf[pos]!;
  let len = buf[pos + 1]!;
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || pos + 2 + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i]!;
    start = pos + 2 + n;
  }
  const end = start + len;
  if (end > buf.length) return null;
  return { tag, tlvStart: pos, start, end };
}

function derChildren(buf: Buffer, node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  let pos = node.start;
  while (pos < node.end) {
    const child = derRead(buf, pos);
    if (!child || child.end > node.end) break;
    out.push(child);
    pos = child.end;
  }
  return out;
}

function derOid(buf: Buffer, node: DerNode): string | null {
  if (node.tag !== 0x06 || node.end <= node.start) return null;
  const first = buf[node.start]!;
  const parts = [Math.floor(first / 40).toString(), (first % 40).toString()];
  let value = 0;
  for (let i = node.start + 1; i < node.end; i++) {
    const b = buf[i]!;
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(value.toString());
      value = 0;
    }
  }
  return parts.join(".");
}

/** The bytes of an INTEGER without its leading zero padding, as lowercase hex. */
function derSerialHex(buf: Buffer, node: DerNode): string {
  let i = node.start;
  while (i < node.end - 1 && buf[i] === 0) i++;
  return buf.subarray(i, node.end).toString("hex");
}

// ---------------------------------------------------------------------------------------------
// OID names and digests
// ---------------------------------------------------------------------------------------------

const OID_NAMES: Record<string, string> = {
  "1.2.840.113549.1.9.3": "contentType",
  "1.2.840.113549.1.9.4": "messageDigest",
  "1.2.840.113549.1.9.5": "signingTime",
  "1.2.840.113549.1.9.6": "countersignature (timestamp)",
  "1.2.840.113549.1.1.1": "rsaEncryption",
  "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
  "1.2.840.113549.1.1.12": "sha384WithRSAEncryption",
  "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.10045.2.1": "id-ecPublicKey",
  "1.2.840.10045.4.3.2": "ecdsa-with-SHA256",
  "1.2.840.10045.4.3.3": "ecdsa-with-SHA384",
  "1.2.840.10045.4.3.4": "ecdsa-with-SHA512",
  "1.3.6.1.4.1.311.3.3.1": "RFC 3161 timestamp",
  "1.3.6.1.4.1.311.2.4.1": "nested signature",
  "1.3.6.1.4.1.311.2.1.4": "SPC_INDIRECT_DATA"
};

function namedOid(oid: string): string {
  return OID_NAMES[oid] ?? oid;
}

const DIGEST_BY_OID: Record<string, string> = {
  "1.2.840.113549.2.5": "md5",
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512"
};

function digestFromOid(oid: string): string | null {
  return DIGEST_BY_OID[oid] ?? null;
}

/** The digest a signature algorithm OID implies (bare rsaEncryption falls back to the signer's digest). */
const SIG_DIGEST_BY_OID: Record<string, string> = {
  "1.2.840.113549.1.1.5": "sha1",
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512"
};

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export interface AuthenticodeCertInfo {
  subject: string;
  issuer: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
}

export type HashStatus = "matches" | "differs" | "not-checked";
export type SignatureStatus = "valid" | "invalid" | "unsupported";

export interface AuthenticodeSignatureReport {
  /** Not well-formed SignedData: nothing below can be trusted. */
  parsed: boolean;
  signer: AuthenticodeCertInfo | null;
  signerCount: number;
  certificates: AuthenticodeCertInfo[];
  /** The signer's digest algorithm, by name or dotted number. */
  digestAlgorithm: string | null;
  signatureAlgorithm: string | null;
  /** The algorithm and value of the file hash the signature covers. */
  fileDigestAlgorithm: string | null;
  fileDigest: string | null;
  computedFileDigest: string | null;
  fileHash: HashStatus;
  fileHashNote?: string;
  /** The signature, checked against the signer's embedded certificate. */
  signatureCheck: SignatureStatus;
  signatureNote?: string;
  /** How the embedded certificates link to one another (no trust store is consulted). */
  chainComplete: boolean | null;
  /** Things attached outside the signature, such as timestamps and nested signatures. Listed, not read. */
  unsignedAttributes: string[];
  notes: string[];
}

export interface AuthenticodeCertEntry {
  fileOffset: number;
  length: number;
  revision: number;
  certificateType: number;
  typeName: string;
  signature?: AuthenticodeSignatureReport;
}

export interface AuthenticodeTable {
  fileOffset: number;
  size: number;
  /** The whole table lies inside the file. */
  withinFile: boolean;
  entries: AuthenticodeCertEntry[];
  warnings: string[];
}

/** A compact summary for audit reports. */
export interface AuthenticodeSummary {
  signed: boolean;
  entryCount: number;
  signer: string | null;
  digestAlgorithm: string | null;
  fileHash: HashStatus;
  signatureCheck: SignatureStatus;
  chainComplete: boolean | null;
  notes: string[];
}

function certInfo(cert: X509Certificate): AuthenticodeCertInfo {
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    serialNumber: cert.serialNumber.toLowerCase(),
    validFrom: cert.validFrom,
    validTo: cert.validTo
  };
}

function typeName(t: number): string {
  switch (t) {
    case 1:
      return "X.509 certificate";
    case CERT_PKCS_SIGNED:
      return "PKCS#7 signature (Authenticode)";
    case 3:
      return "reserved";
    case 4:
      return "terminal server protocol stack";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------------------------
// PE headers
// ---------------------------------------------------------------------------------------------

interface PeHeaderInfo {
  peOffset: number;
  pe32Plus: boolean;
  securityOffset: number;
  securitySize: number;
}

/** Read enough of the PE headers to locate the security directory; null when not a PE. */
function readPeHeaders(data: Buffer): PeHeaderInfo | null {
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) return null;
  const peOffset = data.readInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 24 > data.length || data.readUInt32LE(peOffset) !== 0x00004550) return null;
  const opt = peOffset + 24;
  if (opt + 2 > data.length) return null;
  const magic = data.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const pe32Plus = magic === 0x20b;
  const dirCountPos = opt + (pe32Plus ? 108 : 92);
  const dirsPos = opt + (pe32Plus ? 112 : 96);
  if (dirCountPos + 4 > data.length) return null;
  const dirCount = data.readUInt32LE(dirCountPos);
  if (dirCount <= SECURITY_DIR || dirsPos + (SECURITY_DIR + 1) * 8 > data.length) return null;
  const at = dirsPos + SECURITY_DIR * 8;
  return { peOffset, pe32Plus, securityOffset: data.readUInt32LE(at), securitySize: data.readUInt32LE(at + 4) };
}

// ---------------------------------------------------------------------------------------------
// Authenticode file hash
// ---------------------------------------------------------------------------------------------

/**
 * The parts of the file an Authenticode hash covers: everything except the header checksum, the
 * security directory entry and the certificate table.
 */
function hashedRanges(data: Buffer, h: PeHeaderInfo): Buffer[] {
  const certStart = h.securityOffset;
  const certEnd = certStart + h.securitySize;
  if (certEnd > data.length) throw new Error("the certificate table runs past the end of the file");
  const opt = h.peOffset + 24;
  const checksum = opt + 64;
  const dirs = opt + (h.pe32Plus ? 112 : 96);
  const entry = dirs + SECURITY_DIR * 8;
  if (checksum + 4 <= entry && entry + 8 <= certStart) {
    return [data.subarray(0, checksum), data.subarray(checksum + 4, entry), data.subarray(entry + 8, certStart), data.subarray(certEnd)];
  }
  throw new Error("the certificate table overlaps the headers");
}

/** Compute the Authenticode hash of a PE file with the named node crypto digest. */
export function computeAuthenticodeHash(data: Buffer, digest: string): Buffer {
  const h = readPeHeaders(data);
  if (!h) throw new Error("not a PE file");
  const hash = createHash(digest);
  for (const part of hashedRanges(data, h)) hash.update(part);
  return hash.digest();
}

// ---------------------------------------------------------------------------------------------
// PKCS#7 SignedData
// ---------------------------------------------------------------------------------------------

interface SignedAttrs {
  /** The whole [0] IMPLICIT SET OF TLV re-tagged as a plain SET (0x31): what the signature covers. */
  covered: Buffer;
  attrs: Array<{ oid: string; value: DerNode }>;
}

interface SignerInfo {
  digestAlgorithm: string | null;
  signatureAlgorithm: string | null;
  signature: Buffer | null;
  serial: string | null;
  signedAttrs: SignedAttrs | null;
  unsignedAttrOids: string[];
}

interface SignedData {
  contentType: string | null;
  econtent: Buffer | null;
  certificates: Buffer[];
  signerInfos: SignerInfo[];
}

function parseSignedData(cms: Buffer): SignedData | null {
  const top = derRead(cms, 0);
  if (!top || top.tag !== 0x30) return null;
  const ci = derChildren(cms, top);
  const contentTypeOid = ci[0] && ci[0]!.tag === 0x06 ? derOid(cms, ci[0]!) : null;
  if (contentTypeOid !== OID_SIGNED_DATA) return null;
  const content = ci[1];
  if (!content || content.tag !== 0xa0) return null;
  const sdNode = derChildren(cms, content)[0];
  if (!sdNode || sdNode.tag !== 0x30) return null;
  const sd = derChildren(cms, sdNode);
  // sd: version (0x02), digestAlgorithms (0x31 SET), encapContentInfo (0x30 SEQUENCE),
  // [0] certificates, [1] crls, signerInfos (0x31). The encapContentInfo is the first SEQUENCE.
  const encap = sd.find((n) => n.tag === 0x30);
  let contentType: string | null = null;
  let econtent: Buffer | null = null;
  if (encap) {
    const kids = derChildren(cms, encap);
    contentType = kids[0] && kids[0]!.tag === 0x06 ? derOid(cms, kids[0]!) : null;
    const ec = kids[1];
    // CMS: eContent is [0] EXPLICIT OCTET STRING (0xa0 wrapping 0x04); some writers emit 0x04.
    if (ec && ec.tag === 0x04) econtent = cms.subarray(ec.start, ec.end);
    else if (ec && ec.tag === 0xa0) {
      const inner = derChildren(cms, ec)[0];
      // Standard CMS wraps the content in an OCTET STRING (0x04) — the value is the content;
      // Authenticode in the wild puts the SpcIndirectDataContent SEQUENCE (0x30) directly
      // inside the [0] EXPLICIT — the value is the whole TLV, header included.
      if (inner && inner.tag === 0x04) econtent = cms.subarray(inner.start, inner.end);
      else if (inner && inner.tag === 0x30) econtent = cms.subarray(inner.tlvStart, inner.end);
    }
  }
  const certificates: Buffer[] = [];
  for (const n of sd) {
    if (n.tag === 0xa0 && n !== encap) {
      for (const c of derChildren(cms, n)) {
        // The full TLV is needed: dropping the SEQUENCE header would corrupt the DER.
        if (c.tag === 0x30) certificates.push(cms.subarray(c.tlvStart, c.end));
      }
    }
  }
  const infosNode = [...sd].reverse().find((n) => n.tag === 0x31);
  const signerInfos: SignerInfo[] = [];
  if (infosNode) {
    for (const si of derChildren(cms, infosNode)) {
      if (si.tag !== 0x30) continue;
      // Walk the SignerInfo fields in order: version, sid, digestAlgorithm, [0] signedAttrs,
      // signatureAlgorithm, signature, [1] unsignedAttrs.
      const kids = derChildren(cms, si);
      const info: SignerInfo = { digestAlgorithm: null, signatureAlgorithm: null, signature: null, serial: null, signedAttrs: null, unsignedAttrOids: [] };
      let seenDigestAlg = false;
      for (const kid of kids) {
        if (kid.tag === 0x02 && !info.serial && !seenDigestAlg) continue; // version
        if (kid.tag === 0x30 && !info.serial && !seenDigestAlg) {
          // issuerAndSerialNumber: SEQUENCE { Name, INTEGER serial }
          const serial = derChildren(cms, kid).find((p) => p.tag === 0x02);
          if (serial) info.serial = derSerialHex(cms, serial);
          continue;
        }
        if (kid.tag === 0x30 && !seenDigestAlg) {
          const alg = derChildren(cms, kid)[0];
          info.digestAlgorithm = alg ? derOid(cms, alg) : null;
          seenDigestAlg = true;
          continue;
        }
        if (kid.tag === 0xa0 && !info.signedAttrs && seenDigestAlg) {
          info.signedAttrs = {
            covered: Buffer.from(cms.subarray(kid.tlvStart, kid.end)),
            attrs: derChildren(cms, kid).map((a) => {
              const kv = derChildren(cms, a);
              return { oid: kv[0] ? (derOid(cms, kv[0]!) ?? "") : "", value: kv[1]! };
            })
          };
          info.signedAttrs.covered[0] = 0x31;
          continue;
        }
        if (kid.tag === 0x30 && seenDigestAlg && info.signatureAlgorithm === null) {
          const alg = derChildren(cms, kid)[0];
          info.signatureAlgorithm = alg ? derOid(cms, alg) : null;
          continue;
        }
        if (kid.tag === 0x04 && info.signature === null && info.signatureAlgorithm !== null) {
          info.signature = cms.subarray(kid.start, kid.end);
          continue;
        }
        if (kid.tag === 0xa1) {
          for (const a of derChildren(cms, kid)) {
            const kv = derChildren(cms, a);
            const oid = kv[0] ? derOid(cms, kv[0]!) : null;
            if (oid) info.unsignedAttrOids.push(oid);
          }
        }
      }
      signerInfos.push(info);
    }
  }
  return { contentType, econtent, certificates, signerInfos };
}

/** The digest named inside SpcIndirectDataContent: (algorithm OID, value). */
function indirectDigest(econtent: Buffer): [string, Buffer] | null {
  const outer = derRead(econtent, 0);
  if (!outer || outer.tag !== 0x30) return null;
  const kids = derChildren(econtent, outer);
  const info = kids[1];
  if (!info || info.tag !== 0x30) return null;
  const ik = derChildren(econtent, info);
  const alg = ik[0];
  if (!alg || alg.tag !== 0x30) return null;
  const oid = derChildren(econtent, alg)[0];
  const value = ik[1];
  if (!oid || !value || value.tag !== 0x04) return null;
  return [derOid(econtent, oid) ?? "", econtent.subarray(value.start, value.end)];
}

// ---------------------------------------------------------------------------------------------
// Signature report
// ---------------------------------------------------------------------------------------------

/** The signature report of one PKCS#7 entry; `tableOk` gates the file-hash check. */
function readSignature(data: Buffer, h: PeHeaderInfo, payload: Buffer, tableOk: boolean): AuthenticodeSignatureReport {
  const notes: string[] = [];
  const unparsed: AuthenticodeSignatureReport = {
    parsed: false,
    signer: null,
    signerCount: 0,
    certificates: [],
    digestAlgorithm: null,
    signatureAlgorithm: null,
    fileDigestAlgorithm: null,
    fileDigest: null,
    computedFileDigest: null,
    fileHash: "not-checked",
    fileHashNote: "the block isn't well-formed PKCS#7 SignedData",
    signatureCheck: "unsupported",
    signatureNote: "the block isn't well-formed PKCS#7 SignedData",
    chainComplete: null,
    unsignedAttributes: [],
    notes
  };
  const sd = parseSignedData(payload);
  if (!sd) return unparsed;

  const parsedCerts: X509Certificate[] = [];
  const certificates: AuthenticodeCertInfo[] = [];
  for (const raw of sd.certificates) {
    try {
      const cert = new X509Certificate(raw);
      parsedCerts.push(cert);
      certificates.push(certInfo(cert));
    } catch {
      notes.push("One embedded certificate could not be parsed.");
    }
  }
  const first = sd.signerInfos[0];
  const signerCount = sd.signerInfos.length;
  if (signerCount > 1) notes.push(`The block has ${signerCount} signers; only the first was read.`);
  if (sd.contentType && sd.contentType !== SPC_INDIRECT_DATA) notes.push("The signed content isn't marked as Authenticode data.");

  let signer: AuthenticodeCertInfo | null = null;
  if (first?.serial) {
    const match = parsedCerts.find((c) => c.serialNumber.toLowerCase() === first.serial);
    if (match) signer = certInfo(match);
  }
  if (!signer && parsedCerts.length > 0) signer = certInfo(parsedCerts[0]!);

  const stated = sd.econtent ? indirectDigest(sd.econtent) : null;
  const report: AuthenticodeSignatureReport = {
    parsed: true,
    signer,
    signerCount,
    certificates,
    digestAlgorithm: first?.digestAlgorithm ? namedOid(first.digestAlgorithm) : null,
    signatureAlgorithm: first?.signatureAlgorithm ? namedOid(first.signatureAlgorithm) : null,
    fileDigestAlgorithm: stated ? (digestFromOid(stated[0]) ?? namedOid(stated[0])) : null,
    fileDigest: stated ? stated[1].toString("hex") : null,
    computedFileDigest: null,
    fileHash: "not-checked",
    signatureCheck: "unsupported",
    signatureNote: sd.econtent ? undefined : "the block holds no signed content",
    chainComplete: null,
    unsignedAttributes: first ? first.unsignedAttrOids.map(namedOid) : [],
    notes
  };

  // The file's hash against the signed one.
  if (!stated) {
    report.fileHashNote = "the signed content names no file hash";
  } else if (!tableOk) {
    report.fileHashNote = "the certificate table runs past the end of the file";
  } else {
    const digest = digestFromOid(stated[0]);
    if (!digest) {
      report.fileHashNote = `hash algorithm ${namedOid(stated[0])} isn't one this reader computes`;
    } else {
      try {
        const computed = computeAuthenticodeHash(data, digest);
        report.computedFileDigest = computed.toString("hex");
        report.fileHash = computed.equals(stated[1]) ? "matches" : "differs";
      } catch (err) {
        report.fileHashNote = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // The signature over the signed content, with the signer's embedded certificate.
  if (first && sd.econtent) {
    const sigDigest = (first.signatureAlgorithm && SIG_DIGEST_BY_OID[first.signatureAlgorithm]) || (first.digestAlgorithm ? digestFromOid(first.digestAlgorithm) : null);
    const cert = parsedCerts[0]!;
    if (!sigDigest) {
      report.signatureNote = `signature algorithm ${namedOid(first.signatureAlgorithm ?? "?")} isn't one this reader verifies`;
    } else if (!first.signature) {
      report.signatureNote = "the block holds no signature value";
    } else if (parsedCerts.length === 0) {
      report.signatureNote = "no embedded signer certificate to verify with";
    } else {
      const covered = first.signedAttrs ? first.signedAttrs.covered : sd.econtent;
      try {
        const ok = cryptoVerify(sigDigest, covered, cert.publicKey, first.signature);
        report.signatureCheck = ok ? "valid" : "invalid";
        // The messageDigest authenticated attribute must match the econtent's hash.
        if (ok && first.signedAttrs) {
          const md = first.signedAttrs.attrs.find((a) => a.oid === OID_MESSAGE_DIGEST);
          const contentDigest = first.digestAlgorithm ? digestFromOid(first.digestAlgorithm) : null;
          if (md && md.value.tag === 0x04 && contentDigest) {
            const stated0 = sd.econtent.subarray(md.value.start, md.value.end);
            const actual = createHash(contentDigest).update(sd.econtent).digest();
            if (!actual.equals(stated0)) {
              report.signatureCheck = "invalid";
              report.signatureNote = "the messageDigest attribute does not match the signed content";
            }
          }
        }
      } catch (err) {
        report.signatureCheck = "unsupported";
        report.signatureNote = `verification failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // Embedded chain links (no trust store): every non-self-signed cert's issuer should name
  // another embedded certificate.
  if (parsedCerts.length > 0) {
    const subjects = new Set(parsedCerts.map((c) => c.subject));
    report.chainComplete = parsedCerts.every((c) => c.issuer === c.subject || subjects.has(c.issuer));
  }

  return report;
}

// ---------------------------------------------------------------------------------------------
// Certificate table
// ---------------------------------------------------------------------------------------------

/**
 * Read the certificate table of a PE file; null when the security directory is empty (the binary
 * is unsigned). Never throws on damaged input: problems are reported in `warnings`.
 */
export function readAuthenticodeTable(data: Buffer): AuthenticodeTable | null {
  const h = readPeHeaders(data);
  if (!h) return null;
  const { securityOffset: offset, securitySize: size } = h;
  if (offset === 0 || size === 0) return null;

  const out: AuthenticodeTable = { fileOffset: offset, size, withinFile: false, entries: [], warnings: [] };
  const end = offset + size;
  out.withinFile = end <= data.length;
  if (!out.withinFile) {
    out.warnings.push(`the certificate table says it ends at byte ${end}, but the file has ${data.length} bytes`);
  }
  const limit = Math.min(end, data.length);
  let pos = offset;
  while (out.entries.length < MAX_ENTRIES) {
    if (pos + 8 > limit) break;
    const length = data.readUInt32LE(pos);
    const revision = data.readUInt16LE(pos + 4);
    const certificateType = data.readUInt16LE(pos + 6);
    if (length < 8) {
      out.warnings.push(`the entry at byte ${pos} has a length of ${length}, too short to be real`);
      break;
    }
    const entryEnd = pos + length;
    if (entryEnd > limit) {
      out.warnings.push(`the entry at byte ${pos} runs past the end of the table`);
      break;
    }
    const payload = data.subarray(pos + 8, entryEnd);
    const entry: AuthenticodeCertEntry = { fileOffset: pos, length, revision, certificateType, typeName: typeName(certificateType) };
    if (certificateType === CERT_PKCS_SIGNED) {
      entry.signature = readSignature(data, h, payload, out.withinFile);
    }
    out.entries.push(entry);
    // Entries start on eight-byte boundaries.
    const next = Math.ceil(entryEnd / 8) * 8;
    if (next <= pos) break;
    pos = next;
  }
  return out;
}

/** A compact signed/unsigned summary for an audit report line. */
export function authenticodeSummary(table: AuthenticodeTable): AuthenticodeSummary {
  const sig = table.entries.map((e) => e.signature).find((s) => s && s.parsed);
  return {
    signed: table.entries.length > 0,
    entryCount: table.entries.length,
    signer: sig?.signer ? sig.signer.subject.split(",").slice(0, 2).join(",").trim() : null,
    digestAlgorithm: sig?.fileDigestAlgorithm ?? sig?.digestAlgorithm ?? null,
    fileHash: sig?.fileHash ?? "not-checked",
    signatureCheck: sig?.signatureCheck ?? "unsupported",
    chainComplete: sig?.chainComplete ?? null,
    notes: [
      ...table.warnings,
      ...(sig?.notes ?? []),
      ...(sig?.fileHashNote ? [sig.fileHashNote] : []),
      ...(sig?.signatureNote ? [sig.signatureNote] : [])
    ]
  };
}


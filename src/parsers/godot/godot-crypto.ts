import { createDecipheriv, createHash } from "node:crypto";

/**
 * Godot's FileAccessEncrypted (core/io/file_access_encrypted.cpp), as used for PCK directories
 * (PACK_DIR_ENCRYPTED) and files flagged PACK_FILE_ENCRYPTED, without the optional "GDEC" magic:
 *
 *   md5(plaintext) [16] | plaintext length u64 LE [8] | iv [16] | ciphertext, zero padded to 16
 *
 * The cipher is AES-256 in CFB mode with 128-bit feedback (what OpenSSL calls aes-256-cfb) using the
 * project's script encryption key. Written from the engine source, validated here only against our own
 * encryptor in the tests (no encrypted Godot export is committed).
 */

export const GODOT_ENCRYPTED_HEADER_BYTES = 16 + 8 + 16;

export class GodotCryptoError extends Error {
  constructor(
    readonly code: "invalid-key-format" | "key-required" | "bad-key" | "corrupt",
    message: string
  ) {
    super(message);
    this.name = "GodotCryptoError";
  }
}

/**
 * Parse the 32-byte script encryption key from 64 hex characters (optional 0x prefix)
 */
export function parseGodotKey(input: string): Buffer {
  const hex = input.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new GodotCryptoError(
      "invalid-key-format",
      "Invalid Godot script encryption key: expected 32 bytes as 64 hex characters (optionally prefixed with 0x)."
    );
  }
  return Buffer.from(hex, "hex");
}

export interface GodotEncryptedHeader {
  md5: Buffer;
  length: number;
  iv: Buffer;
}

export function readGodotEncryptedHeader(buf: Buffer): GodotEncryptedHeader {
  if (buf.length < GODOT_ENCRYPTED_HEADER_BYTES) {
    throw new GodotCryptoError("corrupt", "Encrypted block is shorter than its header.");
  }
  const length = buf.readBigUInt64LE(16);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new GodotCryptoError("corrupt", "Implausible encrypted length.");
  return { md5: buf.subarray(0, 16), length: Number(length), iv: buf.subarray(24, 40) };
}

/** Bytes of ciphertext that follow the header */
export const paddedLength = (length: number): number => Math.ceil(length / 16) * 16;

/**
 * Decrypt a whole block (header + padded ciphertext, as stored in the pack) and verify its MD5.
 * A wrong key fails the MD5 check ("bad-key").
 */
export function decryptGodotBlock(block: Buffer, key: Buffer): Buffer {
  const header = readGodotEncryptedHeader(block);
  const padded = paddedLength(header.length);
  if (block.length < GODOT_ENCRYPTED_HEADER_BYTES + padded) {
    throw new GodotCryptoError("corrupt", "Encrypted block is truncated.");
  }
  const decipher = createDecipheriv("aes-256-cfb", key, header.iv);
  const plain = Buffer.concat([
    decipher.update(block.subarray(GODOT_ENCRYPTED_HEADER_BYTES, GODOT_ENCRYPTED_HEADER_BYTES + padded)),
    decipher.final()
  ]).subarray(0, header.length);
  const md5 = createHash("md5").update(plain).digest();
  if (!md5.equals(header.md5)) {
    throw new GodotCryptoError("bad-key", "Wrong AES key (MD5 check of the decrypted data failed) or corrupt data.");
  }
  return plain;
}

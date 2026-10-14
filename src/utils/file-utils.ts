import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ASSET_CATEGORIES, type AssetCategory } from "../types/index.js";

const EXTENSION_CATEGORIES: Record<string, AssetCategory> = {
  // Textures & Images
  ".png": "texture",
  ".jpg": "texture",
  ".jpeg": "texture",
  ".tga": "texture",
  ".dds": "texture",
  ".ktx": "texture",
  ".ktx2": "texture",
  ".astc": "texture",
  ".webp": "texture",
  ".bmp": "texture",
  ".hdr": "texture",
  ".exr": "texture",
  ".svg": "texture",
  ".ctex": "texture", // Godot compiled texture
  ".stex": "texture", // Godot stream texture
  ".texture": "texture",

  // 3D Models & Meshes
  ".fbx": "mesh",
  ".gltf": "mesh",
  ".glb": "mesh",
  ".obj": "mesh",
  ".dae": "mesh",
  ".blend": "mesh",
  ".mesh": "mesh",
  ".smd": "mesh",
  ".uasset": "other", // Could be mesh/texture/blueprint in UE

  // Audio
  ".wav": "audio",
  ".ogg": "audio",
  ".mp3": "audio",
  ".flac": "audio",
  ".bank": "audio", // FMOD
  ".fsb": "audio",  // FMOD sound bank
  ".ac3": "audio",
  ".aac": "audio",
  ".sample": "audio", // Godot audio sample

  // Scenes & Levels
  ".unity": "scene",
  ".tscn": "scene",
  ".scn": "scene",
  ".umap": "scene",
  ".level": "scene",
  ".map": "scene",

  // Scripts & Code
  ".cs": "script",
  ".gd": "script",
  ".gdc": "script", // Godot compiled script
  ".lua": "script",
  ".js": "script",
  ".ts": "script",
  ".py": "script",
  ".hlsl": "shader",
  ".glsl": "shader",
  ".shader": "shader",
  ".gdshader": "shader",

  // Fonts
  ".ttf": "font",
  ".otf": "font",
  ".woff": "font",
  ".woff2": "font",
  ".fnt": "font",

  // Video
  ".mp4": "video",
  ".webm": "video",
  ".ogv": "video",
  ".avi": "video",

  // Animations
  ".anim": "animation",
  ".controller": "animation",

  // Config & Metadata
  ".json": "config",
  ".xml": "config",
  ".yaml": "config",
  ".yml": "config",
  ".ini": "config",
  ".cfg": "config",
  ".tres": "config", // Godot resource
  ".res": "config"
};

export function categorizeExtension(filePath: string): AssetCategory {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_CATEGORIES[ext] ?? "other";
}

export async function readHeaderBytes(
  filePath: string,
  byteCount = 1024
): Promise<Buffer> {
  let fileHandle: fs.FileHandle | undefined;
  try {
    fileHandle = await fs.open(filePath, "r");
    const stat = await fileHandle.stat();
    const length = Math.min(byteCount, stat.size);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await fileHandle.read(buffer, 0, length, 0);
    }
    return buffer;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export async function readTailBytes(
  filePath: string,
  byteCount = 1024
): Promise<Buffer> {
  let fileHandle: fs.FileHandle | undefined;
  try {
    fileHandle = await fs.open(filePath, "r");
    const stat = await fileHandle.stat();
    const length = Math.min(byteCount, stat.size);
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      const offset = stat.size - length;
      await fileHandle.read(buffer, 0, length, offset);
    }
    return buffer;
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

export async function listFilesRecursively(
  dir: string,
  maxDepth = 5,
  currentDepth = 0
): Promise<string[]> {
  if (currentDepth > maxDepth) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listFilesRecursively(
        fullPath,
        maxDepth,
        currentDepth + 1
      );
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

export async function parsePeHeaderArch(
  filePath: string
): Promise<"x86" | "x64" | "arm64" | "unknown"> {
  try {
    const header = await readHeaderBytes(filePath, 4096);
    // Check MZ signature
    if (header.length < 64 || header.readUInt16LE(0) !== 0x5a4d) {
      return "unknown";
    }
    // e_lfanew at 0x3C
    const peOffset = header.readInt32LE(0x3c);
    if (peOffset + 6 > header.length) {
      return "unknown";
    }
    // Check 'PE\0\0' signature (0x00004550)
    if (header.readUInt32LE(peOffset) !== 0x00004550) {
      return "unknown";
    }
    // Machine field
    const machine = header.readUInt16LE(peOffset + 4);
    switch (machine) {
      case 0x014c:
        return "x86";
      case 0x8664:
        return "x64";
      case 0xaa64:
        return "arm64";
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

/**
 * Resolve an archive entry path inside outputDir. Drops URI prefixes (res://), drive
 * letters, leading slashes and ':' characters, then rejects (returns null) anything
 * that would escape outputDir once resolved.
 */
export function resolveSafeOutputPath(outputDir: string, entryPath: string): string | null {
  let rel = entryPath.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").replace(/\\/g, "/");
  rel = rel.replace(/^[a-zA-Z]:/, "").replace(/:/g, "_").replace(/^\/+/, "");
  if (rel.length === 0 || rel.includes("\0")) return null;

  const root = path.resolve(outputDir);
  const resolved = path.resolve(root, rel);
  if (resolved === root || !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * Copy `size` bytes from an open file handle (starting at `offset`) into outPath in chunks,
 * so large entries never need a Buffer of their full size.
 */
export async function copyRangeToFile(
  source: fs.FileHandle,
  offset: number,
  size: number,
  outPath: string
): Promise<void> {
  const chunk = Buffer.alloc(Math.min(size, 1024 * 1024) || 1);
  const out = await fs.open(outPath, "w");
  try {
    let done = 0;
    while (done < size) {
      const want = Math.min(chunk.length, size - done);
      const { bytesRead } = await source.read(chunk, 0, want, offset + done);
      if (bytesRead === 0) throw new Error("Unexpected end of file while copying entry data");
      await out.write(chunk, 0, bytesRead);
      done += bytesRead;
    }
  } finally {
    await out.close();
  }
}

/**
 * Split user supplied category names into known AssetCategory values and unknown ones
 */
export function validateCategories(values: string[]): { valid: AssetCategory[]; invalid: string[] } {
  const known = new Set<string>(ASSET_CATEGORIES);
  const valid: AssetCategory[] = [];
  const invalid: string[] = [];
  for (const v of values) {
    if (known.has(v)) valid.push(v as AssetCategory);
    else invalid.push(v);
  }
  return { valid, invalid };
}

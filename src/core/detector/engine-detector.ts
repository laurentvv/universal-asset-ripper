import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EngineDetectionResult, EngineDetails, EngineType } from "../../types/index.js";
import { listFilesRecursively, parsePeHeaderArch } from "../../utils/file-utils.js";
import { GodotPckParser } from "../../parsers/godot/pck-parser.js";
import { UnrealPakParser } from "../../parsers/unreal/pak-parser.js";
import { UnityBundleParser } from "../../parsers/unity/bundle-parser.js";

export class EngineDetector {
  /**
   * Main entry point to detect game engine from a folder or file path
   */
  static async detect(targetPath: string): Promise<EngineDetectionResult> {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      return this.detectSingleFile(targetPath);
    } else if (stat.isDirectory()) {
      return this.detectDirectory(targetPath);
    }

    return {
      engine: "unknown",
      confidence: 0,
      targetPath,
      details: {
        markersFound: [],
        detectedFiles: []
      }
    };
  }

  /**
   * Detect engine when given a single file (.exe, .pak, .pck, .bundle, etc.)
   */
  static async detectSingleFile(filePath: string): Promise<EngineDetectionResult> {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath).toLowerCase();
    const markersFound: string[] = [];
    const detectedFiles: string[] = [filePath];
    const arch = await parsePeHeaderArch(filePath);

    // 1. Check Godot (PCK or embedded in EXE)
    const godotPck = await GodotPckParser.readManifest(filePath);
    if (godotPck) {
      markersFound.push(godotPck.header.isEmbedded ? "Godot Embedded GDPC Header" : "Godot Standalone PCK");
      const versionStr = `${godotPck.header.engineMajor}.${godotPck.header.engineMinor}.${godotPck.header.enginePatch}`;
      return {
        engine: "godot",
        confidence: 0.99,
        version: versionStr,
        arch,
        containerType: godotPck.header.isEmbedded ? "Embedded PCK" : "Standalone PCK",
        targetPath: filePath,
        details: {
          markersFound,
          detectedFiles,
          notes: [
            `Format Version: ${godotPck.header.formatVersion}`,
            `Files indexed: ${godotPck.files.length}`,
            `Embedded in executable: ${godotPck.header.isEmbedded}`
          ]
        }
      };
    }

    // 2. Check Unreal Engine (.pak)
    if (ext === ".pak") {
      const pakInfo = await UnrealPakParser.readPakInfo(filePath);
      markersFound.push("Unreal .pak container");
      if (pakInfo) {
        markersFound.push(`Unreal FPakInfo (v${pakInfo.version})`);
        return {
          engine: "unreal",
          confidence: 0.95,
          version: `UE Pak v${pakInfo.version}`,
          containerType: "Unreal PAK",
          targetPath: filePath,
          details: {
            markersFound,
            detectedFiles,
            encrypted: pakInfo.isEncrypted,
            notes: [`Encrypted index: ${pakInfo.isEncrypted}`, `Index offset: ${pakInfo.indexOffset}`]
          }
        };
      }
      return {
        engine: "unreal",
        confidence: 0.85,
        containerType: "Unreal PAK",
        targetPath: filePath,
        details: { markersFound, detectedFiles }
      };
    }

    // 3. Check Unreal Zen Store containers (.utoc, .ucas)
    if (ext === ".utoc" || ext === ".ucas") {
      markersFound.push("Unreal Zen Store IoStore container");
      return {
        engine: "unreal",
        confidence: 0.95,
        version: "Unreal Engine 4.26+ / 5",
        containerType: "IoStore (.utoc/.ucas)",
        targetPath: filePath,
        details: {
          markersFound,
          detectedFiles,
          notes: ["Zen Store format requires IoStore reader"]
        }
      };
    }

    // 4. Check Unity Bundle / Serialized file
    const unityBundle = await UnityBundleParser.readBundleInfo(filePath);
    if (unityBundle) {
      markersFound.push(`Unity Container (${unityBundle.signature})`);
      return {
        engine: "unity",
        confidence: 0.95,
        version: unityBundle.engineVersion,
        containerType: unityBundle.signature,
        targetPath: filePath,
        details: {
          markersFound,
          detectedFiles,
          notes: [`Format Version: ${unityBundle.formatVersion}`]
        }
      };
    }

    // 5. Check if it's a Unity or Unreal binary executable
    if (ext === ".exe" || ext === ".dll") {
      if (fileName === "unityplayer.dll") {
        return {
          engine: "unity",
          confidence: 1.0,
          arch,
          targetPath: filePath,
          details: { markersFound: ["UnityPlayer.dll binary"], detectedFiles }
        };
      }
      if (fileName === "gameassembly.dll") {
        return {
          engine: "unity",
          confidence: 1.0,
          arch,
          targetPath: filePath,
          details: {
            isIL2CPP: true,
            markersFound: ["GameAssembly.dll (IL2CPP)"],
            detectedFiles
          }
        };
      }
    }

    // Fallback: check sibling files if single file is in a folder
    try {
      const parentDir = path.dirname(filePath);
      const parentDetection = await this.detectDirectory(parentDir, 2);
      if (parentDetection.engine !== "unknown") {
        return {
          ...parentDetection,
          targetPath: filePath,
          details: {
            ...parentDetection.details,
            detectedFiles: [filePath, ...parentDetection.details.detectedFiles]
          }
        };
      }
    } catch {
      // Ignore
    }

    return {
      engine: "unknown",
      confidence: 0.1,
      arch,
      targetPath: filePath,
      details: {
        markersFound,
        detectedFiles
      }
    };
  }

  /**
   * Detect engine by scanning a game root directory
   */
  static async detectDirectory(dirPath: string, maxDepth = 4): Promise<EngineDetectionResult> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const markersFound: string[] = [];
    const detectedFiles: string[] = [];
    let detectedArch: "x86" | "x64" | "arm64" | "unknown" = "unknown";

    let unityScore = 0;
    let unrealScore = 0;
    let godotScore = 0;

    let isIL2CPP = false;
    let isMono = false;
    let detectedVersion: string | undefined;
    let detectedContainer: string | undefined;
    let isEncrypted = false;

    // Check direct entries
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile()) {
        detectedFiles.push(entry.name);

        // Check PE arch from exe
        if (lower.endsWith(".exe") && detectedArch === "unknown") {
          detectedArch = await parsePeHeaderArch(fullPath);
        }

        // --- UNITY CHECKS ---
        if (lower === "unityplayer.dll") {
          unityScore += 50;
          markersFound.push("UnityPlayer.dll");
        }
        if (lower === "gameassembly.dll") {
          unityScore += 40;
          isIL2CPP = true;
          markersFound.push("GameAssembly.dll (IL2CPP runtime)");
        }
        if (lower === "data.unity3d") {
          unityScore += 30;
          markersFound.push("data.unity3d");
        }

        // --- UNREAL CHECKS ---
        if (lower.endsWith(".pak")) {
          unrealScore += 35;
          markersFound.push(`Unreal PAK: ${entry.name}`);
          detectedContainer = "PAK";
          const pakInfo = await UnrealPakParser.readPakInfo(fullPath);
          if (pakInfo?.isEncrypted) {
            isEncrypted = true;
          }
        }
        if (lower.endsWith(".utoc") || lower.endsWith(".ucas")) {
          unrealScore += 40;
          markersFound.push(`Unreal Zen Store: ${entry.name}`);
          detectedContainer = "IoStore (.utoc/.ucas)";
          detectedVersion = "Unreal Engine 5 / 4.26+";
        }

        // --- GODOT CHECKS ---
        if (lower.endsWith(".pck")) {
          godotScore += 50;
          markersFound.push(`Godot PCK: ${entry.name}`);
          detectedContainer = "PCK";
          const pckManifest = await GodotPckParser.readManifest(fullPath);
          if (pckManifest) {
            detectedVersion = `${pckManifest.header.engineMajor}.${pckManifest.header.engineMinor}.${pckManifest.header.enginePatch}`;
            markersFound.push(`Godot PCK v${pckManifest.header.formatVersion} (Engine ${detectedVersion})`);
          }
        }

        // Check embedded Godot in .exe
        if (lower.endsWith(".exe")) {
          const embeddedPck = await GodotPckParser.readManifest(fullPath);
          if (embeddedPck) {
            godotScore += 60;
            detectedContainer = "Embedded PCK in EXE";
            detectedVersion = `${embeddedPck.header.engineMajor}.${embeddedPck.header.engineMinor}.${embeddedPck.header.enginePatch}`;
            markersFound.push(`Godot Executable with embedded PCK (Engine ${detectedVersion})`);
          }
        }
      } else if (entry.isDirectory()) {
        // --- UNITY FOLDER CHECKS ---
        if (lower.endsWith("_data")) {
          unityScore += 40;
          markersFound.push(`Unity Data Folder: ${entry.name}`);

          // Look inside _Data folder
          try {
            const dataFiles = await fs.readdir(fullPath);
            for (const df of dataFiles) {
              const dfLower = df.toLowerCase();
              if (dfLower === "globalgamemanagers") {
                unityScore += 20;
                markersFound.push("globalgamemanagers");
              }
              if (dfLower === "managed") {
                unityScore += 15;
                isMono = true;
                markersFound.push("Mono Managed folder");
              }
              if (dfLower === "il2cpp_data") {
                unityScore += 25;
                isIL2CPP = true;
                markersFound.push("il2cpp_data directory");
              }
              if (dfLower.endsWith(".assets")) {
                unityScore += 10;
              }
            }
          } catch {
            // Ignore read errors
          }
        }

        if (lower === "monobleedingedge") {
          unityScore += 25;
          isMono = true;
          markersFound.push("MonoBleedingEdge runtime");
        }

        // --- UNREAL FOLDER CHECKS ---
        if (lower === "engine") {
          unrealScore += 25;
          markersFound.push("Engine directory");
        }
        if (lower === "content" || lower === "paks") {
          unrealScore += 25;
          markersFound.push(`${entry.name} directory`);
          try {
            const subEntries = await listFilesRecursively(fullPath, 3);
            for (const cf of subEntries) {
              const cfLower = cf.toLowerCase();
              if (cfLower.endsWith(".pak")) {
                unrealScore += 40;
                markersFound.push(`Unreal PAK: ${path.basename(cf)}`);
                detectedContainer = "PAK";
                const pakInfo = await UnrealPakParser.readPakInfo(cf);
                if (pakInfo?.isEncrypted) isEncrypted = true;
                break;
              }
              if (cfLower.endsWith(".utoc") || cfLower.endsWith(".ucas")) {
                unrealScore += 45;
                markersFound.push(`Unreal Zen Store: ${path.basename(cf)}`);
                detectedContainer = "IoStore (.utoc/.ucas)";
                detectedVersion = "Unreal Engine 5 / 4.26+";
                break;
              }
            }
          } catch {
            // Ignore
          }
        }
      }
    }

    // Recursive search in subdirectories if scores are low
    if (unityScore === 0 && unrealScore === 0 && godotScore === 0 && maxDepth > 1) {
      try {
        const subdirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(dirPath, e.name));
        for (const sub of subdirs) {
          const subResult = await this.detectDirectory(sub, maxDepth - 1);
          if (subResult.engine !== "unknown") {
            return subResult;
          }
        }
      } catch {
        // Ignore
      }
    }

    // Determine winning engine
    let engine: EngineType = "unknown";
    let confidence = 0;

    if (unityScore > unrealScore && unityScore > godotScore && unityScore >= 20) {
      engine = "unity";
      confidence = Math.min(1.0, unityScore / 80);
      detectedContainer = detectedContainer ?? (isIL2CPP ? "IL2CPP Assets" : "Mono Assets");
    } else if (unrealScore > unityScore && unrealScore > godotScore && unrealScore >= 20) {
      engine = "unreal";
      confidence = Math.min(1.0, unrealScore / 80);
      detectedContainer = detectedContainer ?? "Unreal Content / PAK";
    } else if (godotScore > unityScore && godotScore > unrealScore && godotScore >= 20) {
      engine = "godot";
      confidence = Math.min(1.0, godotScore / 70);
      detectedContainer = detectedContainer ?? "PCK Archive";
    }

    return {
      engine,
      confidence,
      version: detectedVersion,
      arch: detectedArch,
      containerType: detectedContainer,
      targetPath: dirPath,
      details: {
        isIL2CPP,
        isMono,
        encrypted: isEncrypted,
        markersFound,
        detectedFiles: detectedFiles.slice(0, 50)
      }
    };
  }
}

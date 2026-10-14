# Universal Asset Ripper - Architecture Documentation

## 1. Overview

**Universal Asset Ripper** is a modular, multi-engine extraction and reverse engineering orchestrator for video games developed with **Unity**, **Unreal Engine**, and **Godot**. It couples native container parsers with engine-specialized tools and the **REA (`morluto/rea`)** AI agent framework.

It operates in three modes:
1. **Interactive CLI (`ripper`)**: For quick detection, inspection, and extraction from terminals.
2. **MCP Server (`ripper mcp`)**: Standard Model Context Protocol server exposing tools over `stdio` to AI pair-programming agents (Gemini, Claude, Cursor, Antigravity).
3. **TypeScript/Node.js Library**: Direct programmatic API via `import { EngineDetector, AdapterRegistry, ReaBridge } from "universal-asset-ripper"`.

---

## 2. Architectural Blueprint

```
                      ┌────────────────────────────────────────┐
                      │        Universal Asset Ripper          │
                      │  (CLI: commander / MCP: stdio server)  │
                      └───────────────────┬────────────────────┘
                                          │
            ┌─────────────────────────────┴─────────────────────────────┐
            ▼                                                           ▼
┌──────────────────────────────┐                           ┌───────────────────────────┐
│     EngineDetector           │                           │        ReaBridge          │
│ (Signatures, PE Arch, Magic) │                           │  (BinaryScanner, Entropy, │
└──────────────┬───────────────┘                           │   AES search, IL2CPP)     │
               │                                           └───────────────────────────┘
               ▼
┌──────────────────────────────┐
│       AdapterRegistry        │
└──────────────┬───────────────┘
               │
   ┌───────────┼───────────┬───────────┐
   ▼           ▼           ▼           ▼
┌──────────┐┌──────────┐┌──────────┐┌──────────┐
│  Godot   ││  Unreal  ││  Unity   ││ PE Soft. │
│ Adapter  ││ Adapter  ││ Adapter  ││ Adapter  │
└────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘
     │           │           │           │
     ▼           ▼           ▼           ▼
[Native PCK] [repak/   [AssetRipper/  [PE .rsrc /
 [Parser]     CUE4Parse] UnityFS]      Icons/DFM]
```

---

## 3. Core Components

### 3.1. `EngineDetector` (`src/core/detector/engine-detector.ts`)
Heuristic analysis engine that inspects directory trees and binary file headers:
* **Unity:** Detects `UnityPlayer.dll`, `*_Data` directories, `globalgamemanagers`, `data.unity3d`, and discriminates between **Mono** (`MonoBleedingEdge`, `Managed/`) and **IL2CPP** (`GameAssembly.dll`, `il2cpp_data`).
* **Unreal Engine:** Detects `Engine/Binaries`, `Content/Paks`, `.pak` (reads `FPakInfo`), and Zen Store IoStore containers (`.utoc`, `.ucas`).
* **Godot:** Detects standalone `.pck` files and self-contained executables containing embedded PCK archives (`GDPC` magic). Sniffs exact engine version (`major.minor.patch`).

### 3.2. Native Binary Parsers (`src/parsers/`)
* **Godot PCK Parser (`src/parsers/godot/pck-parser.ts`)**:
  - Pure TypeScript binary buffer reader.
  - Supports PCK format versions 1, 2, 3, and 4.
  - Automatically identifies whether the PCK is standalone or appended to a Windows PE `.exe`.
  - Parses file count, path lengths, `res://` paths, offsets, file sizes, MD5 hashes, and encryption flags.
  - Extracts assets directly to disk without requiring external tooling.
* **Unreal PAK Parser (`src/parsers/unreal/pak-parser.ts`)**:
  - Reads `FPakInfo` located in the footer of `.pak` archives (magic `0x5A6F12E1`).
  - Reads version number, index offset, index size, and AES encryption flag.
* **PE Resource Parser (`src/parsers/pe/pe-resource-parser.ts`)**:
  - Traverses Windows PE directory trees across 3 levels (Types, Names/IDs, Languages).
  - Reconstructs complete `.ico` files from `RT_GROUP_ICON` and `RT_ICON`.
  - Extracts `RT_MANIFEST` as XML, `RT_BITMAP` as BMP, and `RT_RCDATA` (Delphi DFM forms, certificates, locales).
  - Sniffs application framework (.NET, Delphi, Electron, Qt, Native C/C++).
* **Unreal Pak Index (`src/parsers/unreal/pak-index.ts`)**: primary index v1-v11 (classic records, v10+ encoded entries + full directory index), AES-256 ECB index/entry decryption, Zlib/Gzip extraction, key validation (`validatePakKey`, `createPakKeyVerifier`). Other codecs fall back to `repak`.
* **Electron (`src/parsers/electron/`)**: `asar-parser.ts`, `chromium-pak.ts`, `electron-layout.ts`.
* **Godot crypto (`src/parsers/godot/godot-crypto.ts`, `ctex.ts`)**: FileAccessEncrypted blocks and texture payload lifting.
* **AssetRipper (`src/utils/assetripper.ts`)**: headless web mode driver (spawn `--headless --port`, POST `/LoadFolder|/LoadFile`, `/Export/UnityProject`, kill).
* **Unity Bundle Parser (`src/parsers/unity/bundle-parser.ts`)**:
  - Identifies `UnityFS`, `UnityWeb`, `UnityRaw`, and `SerializedFile` headers.
  - Extracts engine release version strings (e.g., `2021.3.16f1`).

### 3.3. Adapters (`src/adapters/`)
All engine and software adapters inherit from `BaseEngineAdapter` and implement `IEngineAdapter`:
* `GodotAdapter` (native PCK parsing & extraction)
* `UnrealAdapter` (Unreal PAK & IoStore, AES decryption support)
* `UnityAdapter` (Unity assets, scenes, AssetRipper headless web bridge)
* `PeSoftwareAdapter` (Windows PE desktop software, icons, DFM, manifests, resources)
* `ElectronAdapter` (`app.asar` + Chromium `resources.pak`; engine `electron`)
* `canHandle(targetPath: string): Promise<boolean>`
* `inspect(targetPath: string): Promise<AssetManifest>`
* `extract(targetPath: string, options: ExtractOptions): Promise<ExtractionResult>`

Adapters aggregate asset items into unified categories:
* `texture`, `mesh`, `audio`, `scene`, `script`, `shader`, `font`, `video`, `animation`, `config`, `other`.

### 3.4. REA Bridge & Binary Scanner (`src/rea/`)
* **`BinaryScanner`**:
  - Calculates Shannon entropy across byte windows.
  - Discovers 256-bit candidate AES encryption keys in hex strings or binary arrays near Rijndael S-Box lookup tables (`0x63, 0x7c, 0x77, 0x7b...`).
  - Validates IL2CPP `global-metadata.dat` magic (`0xFAB11BAF`) and extracts metadata version.
* **`ReaBridge`**:
  - Generates structured *Evidence Bundles* conforming to the `morluto/rea` agent protocol.
  - Interfaces with the `rea` CLI and AI agent decompiler workflows (Ghidra, Cpp2IL, JADX, Frida, Hopper, IDA).

### 3.5. External Reverse Engineering Toolchain Ecosystem
When automated heuristics and native parsers encounter locked or obfuscated containers:
* **`morluto/rea`**: High-level reasoning and agentic workflow orchestration.
* **`Ghidra`**: Static binary decompilation of shipping native executables and libraries.
* **`Cpp2IL`**: Ahead-of-Time Unity IL2CPP deobfuscation and CIL bytecode reconstruction.
* **`JADX`**: Dalvik/ART Dex-to-Java decompilation for Android packages (`.apk`).
* **`Frida`**: Dynamic instrumentation and memory interception of runtime keys and buffers.

### 3.6. Model Context Protocol (MCP) Server (`src/mcp/server.ts`)
Exposes four tools over JSON-RPC stdio:
1. `ripper_detect`: Returns engine type, confidence, version, architecture, and signature markers.
2. `ripper_inspect`: Returns complete file count and size breakdowns by category.
3. `ripper_extract`: Performs asset extraction with category filtering and AES key injection.
4. `ripper_scan_binary`: Runs deep binary analysis for candidate AES keys and IL2CPP metadata.

### 3.7. Downstream Ecosystem: Creative Game Modding (`universal-modder`)
Extracted assets and decrypted structures directly empower downstream modding agent suites like **[rehan-remade/universal-modder](https://github.com/rehan-remade/universal-modder)**. While Universal Asset Ripper handles the upstream reconnaissance and extraction layer, `universal-modder` consumes these assets to drive AI asset generation (fal.ai / ComfyUI), code injection, and automated in-game verification.

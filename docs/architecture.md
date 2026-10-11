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
   ┌───────────┼───────────┐
   ▼           ▼           ▼
┌──────────┐┌──────────┐┌──────────┐
│  Godot   ││  Unreal  ││  Unity   │
│ Adapter  ││ Adapter  ││ Adapter  │
└────┬─────┘└────┬─────┘└────┬─────┘
     │           │           │
     ▼           ▼           ▼
[Native PCK] [repak/   [AssetRipper/
 [Parser]     CUE4Parse] UnityFS]
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
* **Unity Bundle Parser (`src/parsers/unity/bundle-parser.ts`)**:
  - Identifies `UnityFS`, `UnityWeb`, `UnityRaw`, and `SerializedFile` headers.
  - Extracts engine release version strings (e.g., `2021.3.16f1`).

### 3.3. Adapters (`src/adapters/`)
All engine adapters inherit from `BaseEngineAdapter` and implement `IEngineAdapter`:
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
  - Interfaces with the `rea` CLI and AI agent decompiler workflows (Ghidra, Hopper, IDA).

### 3.5. Model Context Protocol (MCP) Server (`src/mcp/server.ts`)
Exposes four tools over JSON-RPC stdio:
1. `ripper_detect`: Returns engine type, confidence, version, architecture, and signature markers.
2. `ripper_inspect`: Returns complete file count and size breakdowns by category.
3. `ripper_extract`: Performs asset extraction with category filtering and AES key injection.
4. `ripper_scan_binary`: Runs deep binary analysis for candidate AES keys and IL2CPP metadata.

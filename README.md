# Universal Asset Ripper

<p align="center">
  <img src="docs/media/banner.png" alt="Universal Asset Ripper Banner" width="100%">
</p>

<p align="center">
  <strong>High-performance multi-engine game asset extractor, native container parser, and AI-assisted reverse engineering orchestrator.</strong>
</p>

<p align="center">
  <a href="#-features"><img src="https://img.shields.io/badge/status-active-brightgreen.svg" alt="Status"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-blue.svg" alt="Node Version"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/typescript-5.x-blue.svg" alt="TypeScript"></a>
  <a href="#-mcp-server"><img src="https://img.shields.io/badge/MCP-compatible-purple.svg" alt="MCP Compatible"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License"></a>
</p>

---

## 📖 Overview

**Universal Asset Ripper** is an engine-agnostic extraction and binary reverse engineering platform designed for game developers, modders, and security researchers. It seamlessly bridges native binary format parsers with AI pair-programming agents via the **Model Context Protocol (MCP)** and integrates into an advanced software reverse engineering (SRE) toolchain.

Whether analyzing **Godot** archives, **Unreal Engine** IoStore/PAK containers, **Unity** IL2CPP metadata, or desktop **Windows PE** executables, Universal Asset Ripper provides lightning-fast heuristic detection, categorized asset inventories, targeted extraction, and deep binary entropy inspection for cryptographic keys.

---

## 🎯 Features

* 🔍 **Automatic Engine & Framework Detection (`ripper detect`) :**
  - Heuristics and signature analysis for **Unity**, **Unreal Engine**, and **Godot**.
  - Application framework detection (**Delphi**, **.NET**, **Electron**, **Qt**, **Native C/C++**).
  - PE header architecture analysis (x86, x64, ARM64) and encryption flagging.
* 📦 **100% Native Pure TypeScript Parsers :**
  - **Godot PCK :** Zero-dependency parser for standalone `.pck` packages and embedded executables (`GDPC` magic) supporting format versions 1 through 4.
  - **Windows PE (.rsrc) :** Complete multi-resolution `.ico` icon reconstruction, Delphi `.dfm` form extraction, XML manifests, bitmaps, and raw `RCDATA`.
* 📊 **Asset Manifest & Inspection (`ripper inspect`) :**
  - Full cataloging across unified categories: textures, 3D meshes, audio, scenes, scripts, shaders, fonts, videos, and manifests.
* ⚡ **Targeted Extraction (`ripper extract`) :**
  - Category filtering (`--categories texture,audio,mesh`) and regex/glob filename filtering (`--filter`).
  - Native support for **AES-256** decryption keys (`--aes-key <hex>`) for Unreal Engine packages.
* 🤖 **AI-Assisted Binary Analysis (`ripper rea-inspect`) :**
  - Sliding-window Shannon entropy scanning to spot 256-bit encryption keys.
  - Proximity search around Rijndael S-Box lookup tables (`0x63, 0x7c, 0x77, 0x7b...`).
  - Header sniffing and version validation for Unity IL2CPP `global-metadata.dat`.
  - Automated generation of structured **Evidence Bundles** formatted for AI agents.
* 🔌 **Integrated Model Context Protocol (MCP) Server (`ripper mcp`) :**
  - Exposes extraction, inspection, and scanning tools over standard I/O for Claude Code, Gemini CLI, Cursor, and Antigravity.
* 🎨 **Downstream Modding Pipeline Ready :**
  - Feeds extracted assets and decrypted structures directly into generative game modding frameworks such as [rehan-remade/universal-modder](https://github.com/rehan-remade/universal-modder) (fal.ai / ComfyUI asset replacement and in-game testing).

---

## 🏗️ Architecture

```
                                ┌────────────────────────────────┐
                                │   Universal Asset Ripper       │
                                │   (CLI & MCP stdio Server)     │
                                └──────────────┬─────────────────┘
                                               │
                    ┌──────────────────────────┴──────────────────────────┐
                    ▼                                                     ▼
      [ EngineDetector Engine ]                                 [ ReaBridge & AI Hub ]
  (Unity, Unreal, Godot, Windows PE)                        (BinaryScanner, Shannon Entropy,
                    │                                         AES-256 discovery, Evidence)
       ┌────────────┼────────────┬────────────┐                           │
       ▼            ▼            ▼            ▼              ┌────────────┼────────────┐
  [ Godot ]    [ Unreal ]    [ Unity ]   [ PE Soft. ]        ▼            ▼            ▼
  Adapter       Adapter       Adapter     Adapter       [ Ghidra ]   [ Cpp2IL ]    [ Frida ]
  (Native       (repak /    (AssetRipper (Resource      (Native SRE   (IL2CPP ->   (Runtime
  PCK reader)  CUE4Parse)    CLI bridge)  Extractor)    Decompiler)    C# .NET)     Hooking)
```

---

## 🚀 Installation & Quick Start

### Prerequisites
* **Node.js** >= 22.0.0
* **npm** >= 10.0.0

### Global CLI Installation
Clone and build the repository locally:

```bash
git clone https://github.com/laurentvv/universal-asset-ripper.git
cd universal-asset-ripper
npm install
npm run build
npm link
```

Verify your installation:
```bash
ripper --help
```

---

## 💻 CLI Usage

### 1. Detect Game Engine & Framework
Inspect any folder, game directory, or executable:
```bash
ripper detect "C:/Games/MyGame"
# Or point directly to an executable:
ripper detect "C:/Games/MyGame/MyGame.exe"
```

### 2. Inspect Package Manifest
Display categorized file counts and size breakdowns without writing to disk:
```bash
ripper inspect "C:/Games/MyGame/game.pck"
```

### 3. Extract Assets
Extract all assets or filter by specific categories:
```bash
# Full extraction
ripper extract "C:/Games/MyGame" -o "./extracted"

# Extract only textures and audio files
ripper extract "C:/Games/MyGame" -o "./extracted" --categories texture,audio

# Extract Unreal PAK with AES key
ripper extract "C:/Games/MyGame/Content/Paks/PakChunk0.pak" -o "./extracted" --aes-key 0x4A6B...
```

### 4. Deep Binary Inspection (AI Evidence Bundle)
Scan an executable for cryptographic keys, S-Box constants, and IL2CPP metadata:
```bash
ripper rea-inspect "C:/Games/MyGame/Game-Win64-Shipping.exe"
```

---

## 🤖 MCP Server Setup (AI Agents)

Universal Asset Ripper runs as a standard **Model Context Protocol (MCP)** server over `stdio`. It connects natively with **Claude Code**, **Gemini CLI**, **Cursor**, and **Antigravity**.

Add the server to your `mcpServers` configuration file:

```json
{
  "mcpServers": {
    "universal-asset-ripper": {
      "command": "node",
      "args": ["C:/git/universal-asset-ripper/dist/cli/index.js", "mcp"]
    }
  }
}
```

### Tools Exposed to Agents
| Tool Name | Description |
| :--- | :--- |
| `ripper_detect` | Run heuristic analysis to detect the game engine, architecture, and container type. |
| `ripper_inspect` | Return a complete manifest of files with counts and sizes grouped by category. |
| `ripper_extract` | Extract assets to disk with category filters and optional AES-256 decryption keys. |
| `ripper_scan_binary` | Run Shannon entropy scans, find AES keys, and extract IL2CPP metadata headers. |

---

## 🔬 Reverse Engineering Ecosystem

Universal Asset Ripper forms the upstream reconnaissance and extraction hub within a comprehensive SRE toolchain:

| Tool | Category | Specialty & Role in Pipeline |
| :--- | :--- | :--- |
| **[morluto/rea](https://github.com/morluto/rea)** | Agentic SRE | Autonomous LLM agents consuming Evidence Bundles to plan reverse engineering steps. |
| **[Ghidra](https://github.com/NationalSecurityAgency/ghidra)** | Static SRE | Deep native disassembly and C pseudocode decompilation (x86/x64/ARM). |
| **[Cpp2IL](https://github.com/SamboyCoding/Cpp2IL)** | Unity IL2CPP | Reconstructs executable CIL (.NET) bytecode from `GameAssembly.dll` for decompilation in dnSpy/ILSpy. |
| **[JADX](https://github.com/skylot/jadx)** | Android SRE | Dex-to-Java decompiler for unpacking APK/AAB packages, manifests, and JNI bridges. |
| **[Frida](https://github.com/frida/frida)** | Dynamic SRE | Runtime memory hooking to capture live AES keys and dump uncompressed asset buffers. |
| **[universal-modder](https://github.com/rehan-remade/universal-modder)** | Modding Studio | Downstream mod injection, generative AI assets (fal.ai/ComfyUI), and in-game automated testing. |

---

## 📚 Technical Documentation

* 📘 [Detailed Architecture](docs/architecture.md)
* 📗 [Engine Deep Dive & Tooling Guide](docs/engines.md)
* 📙 [REA & AI Agent Integration Guide](docs/rea-guide.md)

---

## 🧪 Testing

The test suite validates parser accuracy against synthetically generated binary containers (PE headers, Godot PCK archives, and AES memory blocks):

```bash
npm test
```

---

## 📄 License

MIT © [Laurent VOLFF](https://github.com/laurentvv)

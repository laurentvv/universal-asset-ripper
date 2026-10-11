# Engine Deep Dive & Tooling Guide

This document describes internal container structures, extraction workflows, and recommended toolchains for each supported engine.

---

## 1. Unity

### Container Formats
* **AssetBundles (`.bundle`, `.unity3d`)**: Compressed container archive starting with `UnityFS` (LZ4 / LZMA compression) or legacy `UnityWeb` / `UnityRaw`.
* **Serialized Files (`.assets`, `.sharedassets`)**: Binary serialized scene and object trees containing TypeTrees or serialized type definitions.
* **Global Game Managers (`globalgamemanagers`)**: Root project settings and build configurations.

### Runtime Architectures
* **Mono (.NET CIL)**:
  - Bytecode stored in `.dll` files inside `<Game>_Data/Managed/`.
  - Decompilable using standard .NET decompiler tools (dnSpy, ILSpy, dotPeek).
* **IL2CPP (Ahead-of-Time Native)**:
  - C# code compiled directly to native machine code (`GameAssembly.dll`).
  - Class definitions, field names, and method metadata stored in `<Game>_Data/il2cpp_data/Metadata/global-metadata.dat`.
  - Can be inspected using `ripper rea-inspect` or restored using `Il2CppDumper`.

### Recommended External Tooling
* [AssetRipper](https://github.com/AssetRipper/AssetRipper):
  - CLI installation: `dotnet tool install -g AssetRipper.Cli`
  - Fully converts Unity assets into standard glTF, FBX, WAV, PNG, and rebuilds complete Unity project hierarchies.

---

## 2. Unreal Engine

### Container Formats
* **Legacy PAK (`.pak`)**:
  - Container format used from UE4.0 through UE5+.
  - Index and file list stored at an offset pointed to by the footer struct `FPakInfo` (magic `0x5A6F12E1`).
  - Index or file payload can be encrypted with **AES-256**.
* **Zen Store IoStore (`.utoc`, `.ucas`)**:
  - Introduced in UE4.26, standard in UE5.
  - `.utoc` (Table of Contents): Container metadata, chunk hashes, and compression info.
  - `.ucas` (Container Archive Storage): Raw file chunks.

### AES-256 Encryption & Keys
When packages are encrypted, an AES-256 key is required.
* Keys can often be found in the shipping executable or DLL using:
  ```bash
  ripper rea-inspect <Game>-Win64-Shipping.exe
  ```
* Once identified, extract with:
  ```bash
  ripper extract Content/Paks/PakChunk0.pak -o extracted/ --aes-key 0xYOUR_HEX_KEY
  ```

### Recommended External Tooling
* [repak](https://github.com/trumank/repak):
  - High-performance Rust CLI for unpacking and packing `.pak` files.
  - Installation: `cargo install repak`
* [CUE4Parse](https://github.com/FabianFG/CUE4Parse) / [FModel](https://fmodel.app):
  - Industry standard C# library for reading `.pak`, `.utoc`, `.ucas`, `.usmap` mapping tables, and deserializing `.uasset` files into 3D models and textures.

---

## 3. Godot Engine

### Container Formats
* **PCK (`.pck`)**:
  - Standard package archive.
  - Header starts with magic `GDPC` (`0x43504447`).
  - Contains format version (1 to 4) and engine version (`major.minor.patch`).
  - Indexed table maps `res://` paths to offsets and lengths.
* **Embedded PCK in Executable (`.exe`)**:
  - Standalone release binaries for Windows and Linux bundle the `.pck` package directly into the executable file.
  - A 12-byte footer (`[int64 offset] [magic GDPC]`) at the end of the binary references the embedded PCK.

### Native Extraction
**Universal Asset Ripper** includes a 100% native TypeScript binary parser for Godot PCK packages. No external tool is required to extract assets:
```bash
ripper extract Game.pck -o extracted/
# Or directly from the executable:
ripper extract Game.exe -o extracted/
```

### Script & Scene Restoration
* [GDRE Tools](https://github.com/bruvzg/gdsdecomp):
  - Headless Godot fork capable of decompiling compiled GDScript bytecode (`.gdc`) and restoring `.tscn` text scenes.

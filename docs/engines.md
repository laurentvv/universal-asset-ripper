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
  - There is no AssetRipper.Cli: download `AssetRipper.GUI.Free` and set `ASSETRIPPER_PATH` (file or folder) or add it to PATH. The tool runs it with `--headless --port <free port>` and drives its web API.
  - Fully converts Unity assets into standard glTF, FBX, WAV, PNG, and rebuilds complete Unity project hierarchies.
* [Cpp2IL](https://github.com/SamboyCoding/Cpp2IL):
  - In-depth reverse engineering tool for Unity IL2CPP builds.
  - Unlike `Il2CppDumper` (which only recovers signatures and empty dummy DLLs with `throw null;`), **Cpp2IL** analyzes machine code in `GameAssembly.dll` and reconstructs executable **CIL bytecode** within method bodies.
  - Produces valid .NET assemblies that can be decompiled into readable C# using [dnSpy](https://github.com/dnSpy/dnSpy) or [ILSpy](https://github.com/icsharpcode/ILSpy).
* [Il2CppDumper](https://github.com/Perfare/Il2CppDumper):
  - Fast extraction of type declarations, string literals, method addresses, and symbol scripts for Ghidra / IDA.

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

### Advanced Key Recovery (Static & Dynamic)
* **Static Analysis with [Ghidra](https://github.com/NationalSecurityAgency/ghidra)**:
  - If the key is obfuscated or compiled via custom templates, load `<Game>-Win64-Shipping.exe` in Ghidra.
  - Search for references to strings like `AES_set_decrypt_key`, `FPakPlatformFile`, or `FEncryptionKeyRegistration`.
* **Dynamic Hooking with [Frida](https://github.com/frida/frida)**:
  - For games with heavy anti-reverse or dynamic key derivation, attach Frida to the running game process to intercept the decryption key directly from memory as it is passed to the decryption routine:
    ```javascript
    // Example: hook AES key parameter in runtime memory
    const decryptFunc = Module.findExportByName(null, "AES_set_decrypt_key");
    if (decryptFunc) {
      Interceptor.attach(decryptFunc, {
        onEnter(args) {
          console.log("[Frida] AES Key buffer:", hexdump(args[0], { length: 32 }));
        }
      });
    }
    ```

### Native reader
`inspect` lists real entries (`--aes-key` for encrypted indexes). `extract` unpacks stored/Zlib/Gzip entries natively, AES-256 included; Oodle and unparsable paks use `repak`. Wrong keys fail with a clear error (mount point check). `ripper rea-inspect <exe> --pak <file>` marks verified keys.

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

### Encrypted PCK and textures
With the project's script encryption key (`--aes-key`, 64 hex), encrypted directories and files are decrypted (AES-256-CFB; block = md5 | size | iv | data). `--convert` writes `.ctex`/`.stex` with plain PNG/WebP payloads as images. Not validated against a real encrypted export.

### Script & Scene Restoration
* [GDRE Tools](https://github.com/bruvzg/gdsdecomp):
  - Headless Godot fork capable of decompiling compiled GDScript bytecode (`.gdc`) and restoring `.tscn` text scenes.

---

## 3b. Electron

`app.asar` (Chromium Pickle header + JSON tree; `.unpacked` files copied from `app.asar.unpacked/`) and Chromium `.pak` data packs (v3/v4/v5) are read natively. Output: `app.asar` content at the root, other archives under their name, packs as `<pack>/res_<id>.<ext>`. Detection reports engine `electron` for an Electron executable beside `resources/app.asar` or `resources.pak`.

---

## 4. Mobile & Android Containers (APK / AAB / XAPK)

### Structure & Ripping Challenges
* Android games package standard engine assets into ZIP containers:
  - Bytecode: `classes.dex` (Dalvik / ART)
  - Native Engine Binaries: `lib/<arch>/` (`libunity.so`, `libil2cpp.so`, `libUE4.so`, `libgodot_android.so`)
  - Assets & Containers: `assets/`, `res/`, or external expansion files (`.obb`)
* Many games protect asset decryption keys in Java wrapper code, or through JNI bridges connecting to native libraries.

### Recommended Tooling
* [JADX](https://github.com/skylot/jadx):
  - High quality Dex-to-Java decompiler with GUI and CLI (`jadx -d out/ app.apk`).
  - Decodes `AndroidManifest.xml`, resource tables, and Dalvik bytecode back to readable Java/Kotlin code.
  - Indispensable for identifying how assets are decrypted before being fed into native engine runtimes.
* [Frida](https://github.com/frida/frida):
  - Dynamic instrumentation on Android devices / emulators (`frida-server` or `frida-gadget`).
  - Allows hooking JNI functions, bypassing SSL pinning, and dumping decrypted asset buffers directly from memory.
* [Cpp2IL](https://github.com/SamboyCoding/Cpp2IL) + [Ghidra](https://github.com/NationalSecurityAgency/ghidra):
  - For Unity IL2CPP games on Android, run Cpp2IL against `lib/arm64-v8a/libil2cpp.so` + `assets/bin/Data/Managed/Metadata/global-metadata.dat` to extract full C# game code.

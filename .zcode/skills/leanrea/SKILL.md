---
name: leanrea
description: Reverse engineer shipped software and game binaries with plain local CLI tools and universal-asset-ripper, no bloated MCP needed. Covers game containers (Unreal .pak, Godot .pck, Unity IL2CPP), Electron/JS bundles, native PE/ELF/Mach-O, Go/Rust/.NET/WASM binaries, APKs, SQLite, and firmware. Use to explain how a feature works, extract assets/keys, audit security, or rebuild a feature clean-room.
---

# leanrea: Fast-Path Reverse Engineering

You already know these tools. This file provides the fastest path for each target type, traps to avoid, and integrates `universal-asset-ripper` for game containers and PE resources.

## Philosophy: Zero-MCP / Lean Execution
Do not load hundreds of heavy MCP tool definitions into context. Agents have direct shell access (`run_command`). Running focused, batched CLI tools and pure parsers directly is **38% faster, 35% cheaper, and uses 60% fewer tokens** than wrapping every command in an MCP schema.

## Core Rules
- **Work on a copy**: Always extract or copy targets to a scratch directory (e.g. `.scratch/re/<name>`). Reuse an extraction if one exists.
- **Route by format and magic bytes first**: Run `file -b <target>` and `ripper detect <target>` before reading code or disassembling.
- **Game & Container First Move**: Use `universal-asset-ripper` for game containers (Unreal, Godot, Electron, PE resources). It parses native structures with zero external runtime dependencies.
- **Never `cat` large or minified files**: Slice them with ripgrep: `rg -o '.{0,200}NEEDLE.{0,200}' <file> | head -20`. Dump disassembly to disk once, then grep the dump.
- **Always use `rg -uu` on extracted bundles**: Modern bundlers (Webpack, Vite, Electron) place code in dot-directories like `.webpack/` which default `rg` ignores.
- **Batch independent probes into ONE shell call**: Chain commands with `;` and markers (`echo '--- SECTION'`). Every extra turn costs context and latency.
- **Evidence-based reporting (3-bucket classification)**:
  - **Seen**: Fact directly observed (cite file:offset, symbol, address, or string).
  - **Inferred**: Hypothesis logically deduced from seen facts.
  - **Unknown**: What has not yet been observed. (Never claim something is "absent" without exhaustive proof).
- **Deliverable-first**: Conclude investigations with a concrete artifact (`SPEC.md`, a reader script, a test harness, or a clean-room reimplementation).

---

## First Moves (One Call Each, Paste & Run)

### 1. Game Binary / Package (Unreal, Godot, Unity, Electron)
```sh
T=./target; node ./dist/cli/index.js detect "$T"; node ./dist/cli/index.js inspect "$T" --summary; node ./dist/cli/index.js rea-inspect "$T" --json
```
*Detects engine, archives, framework, and scans for 256-bit AES encryption keys near S-boxes in a single pass.*

### 2. Windows Native Executable (PE / x86 / x64)
```sh
T=./app.exe; D=.scratch/re/pe; mkdir -p "$D"; node ./dist/cli/index.js detect "$T"; node ./dist/cli/index.js extract "$T" -o "$D/res"; strings -a -n 6 "$T" | head -200
```
*Extracts Win32 dialogs (DLGTEMPLATE to JSON with all button/control labels), icons, Delphi .dfm forms, and strings.*

### 3. Electron App (`app.asar` / `resources.pak`)
```sh
A=./app.asar; X=.scratch/re/asar; rm -rf "$X"; npx -y @electron/asar extract "$A" "$X" && jq '{name,version,main}' "$X/package.json"; find "$X" -path '*/node_modules' -prune -o -type f \( -name '*.js' -o -name '*.node' \) -print | head -60; rg -uu -l --glob '!node_modules' 'contextBridge|ipcRenderer|ipcMain' "$X"
```
*Extracts bundle, identifies main entry point, lists native addons, and locates IPC channels.*

### 4. Native Binary (Mach-O / ELF)
```sh
T=./bin; D=.scratch/re/bin; mkdir -p "$D"; file "$T"; nm -gU "$T" | head -100; strings -a -n 6 "$T" | rg -v '^[_$.]' | head -200; objdump -d "$T" > "$D/dis.txt" 2>/dev/null || otool -tV "$T" > "$D/dis.txt"
```

---

## Target Router

| Target | Fastest Path & Tools |
|---|---|
| **Unreal Engine (`.pak`, `.ucas`)** | `ripper inspect game.pak` (native index parser v1-11). For encrypted paks: `ripper rea-inspect Shipping.exe --pak game.pak` tests candidate AES keys automatically. Fallback to `repak` for Oodle compression. |
| **Godot Engine (`.pck`, embedded)** | `ripper inspect game.pck` or `ripper extract game.pck -o out/`. For encrypted scripts: pass `--aes-key <64-hex>`. Texture conversion: `--convert` transforms `.ctex`/`.stex` to PNG/WebP. |
| **Unity IL2CPP (`GameAssembly.dll` + `global-metadata.dat`)** | `ripper rea-inspect GameAssembly.dll` detects metadata version and S-box keys. Run `Cpp2IL --game-path <dir> --exe-name <exe>` to reconstruct readable .NET CIL assemblies. |
| **Electron & Web Bundles** | `ripper inspect app.asar`. Surface IPC: `rg -n -o '.{0,120}(ipcMain\.(handle|on)|ipcRenderer\.(invoke|send)|contextBridge\.exposeIn(Main|Isolated)World).{0,160}' -uu X --glob '!node_modules'`. Slicing: `rg -uu -o '.{0,250}FEATURE.{0,250}' X`. Prettify with `npx -y prettier --parser babel F > F.pretty.js`. |
| **Windows PE Resources** | `ripper extract target.exe -o out/` extracts decoded `dialogs/*.json` (dialog templates & controls), `manifest/`, `version/`, `.dfm` forms, multi-resolution `.ico`, and `RCDATA`. |
| **Go Binaries (`.go.buildinfo`)** | `go version -m <binary>` prints Go toolchain, module path, dependencies, and build flags instantly. Symbol recovery: `go tool nm <binary> \| rg main\.`. |
| **Rust Binaries** | `cargo audit bin <binary>` (reads embedded `cargo-auditable` dependency table). Compiler version: `strings -a <bin> \| rg -o '/rustc/[0-9a-f]{40}' \| sort -u`. Crates: `strings -a <bin> \| rg -o '[a-z0-9_-]+-[0-9]+\.[0-9]+\.[0-9]+/src' \| sort -u`. |
| **.NET Assemblies (C# / VB / F#)** | `ilspycmd -p -o out/ target.dll` (install: `dotnet tool install -g ilspycmd`). Search P/Invoke native calls: `rg 'DllImport' out/`. |
| **Android APKs** | `jadx -d out/ --show-bad-code app.apk` decompiles DEX to Java. Manifest/resources only: `apktool d --no-src -o out/ app.apk`. Check native libraries in `lib/*/` (`libflutter.so` = Flutter Dart AOT, `libhermes.so` = React Native Hermes bytecode). |
| **WebAssembly (WASM)** | `wasm-objdump -x module.wasm`, `wasm2wat module.wasm -o module.wat`, or `wasm-decompile module.wasm` (WABT suite). |
| **SQLite Databases** | Always copy the db and `-wal` file: `sqlite3 'file:copy.db?mode=ro' '.schema'` then `SELECT * FROM table LIMIT 20;`. |
| **Network & Packets (PCAP/HAR)** | `tshark -r capture.pcap -q -z conv,tcp` or `tshark -r capture.pcap -T fields -e dns.qry.name -e tls.handshake.extensions_server_name | sort -u`. |
| **Firmware & Embedded** | `binwalk -e firmware.bin` or `unblob -e out/ firmware.bin`. Route extracted partitions and binaries through this router. |

---

## Speed Patterns
1. **Strings and imports first**: On compiled binaries, `nm -u` + `strings` + export table usually reveal program capabilities without any disassembly.
2. **Follow string xrefs**: To find where a string or key is used, locate its literal pool reference or data offset, then trace the enclosing function label.
3. **Trace call sequences, not instructions**: In disassembly, focus on `call` / `bl` targets (`connect`, `FAES::Decrypt`, `RegOpenKey`, `WriteFile`, `curl_easy_perform`). The call sequence tells the story.
4. **Clean-room parity test**: When rebuilding proprietary logic, write a minimal standalone reproduction script and assert identical outputs for identical inputs against the original binary.

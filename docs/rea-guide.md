# REA (Reverse Engineer Anything) Integration Guide

## 1. Context & Motivation

When extracting game assets, standard tools often encounter barriers:
1. **Unreal Engine:** `.pak` or `.ucas` packages encrypted with AES-256 where the key is unknown.
2. **Unity:** IL2CPP builds where C# bytecode has been converted to machine code, or obfuscated `global-metadata.dat`.
3. **Custom Packers:** Proprietary encryption wrappers around standard game engines.

To resolve these challenges without manual static disassembly, **Universal Asset Ripper** connects to **[morluto/rea](https://github.com/morluto/rea)** (`rea-agents`).

---

## 2. Automated Deep Binary Inspection

Run the built-in scanner to identify candidate keys and architectural properties:

```bash
ripper rea-inspect path/to/Game-Win64-Shipping.exe
```

Options: `--pak <file>` verifies each candidate against an Unreal pak (decrypts the index, mount point check; verified keys sorted first), `--bundle <file>` writes the evidence bundle, `--json` prints `{ scan, bundle }`. The whole file is scanned in overlapping chunks; hex runs longer than 64 chars, counting tables, low-entropy and repeated-block strings are dropped, and the output states `N candidates, showing M`.

### What `BinaryScanner` Analyzes:
1. **Shannon Entropy Analysis:** Identifies 32-byte (256-bit) blocks of high randomness characteristic of cryptographic keys.
2. **Hex Pattern Matching:** Detects strings matching 64-character hexadecimal patterns (`0x[A-Fa-f0-9]{64}`).
3. **Cryptographic Proximity:** Scans for Rijndael AES SubBytes S-Box constants (`0x63, 0x7c, 0x77, 0x7b...`) and analyzes adjacent memory blocks.
4. **IL2CPP Metadata Headers:** Inspects `global-metadata.dat` for the magic signature `0xFAB11BAF` and metadata version.

---

## 3. Evidence Bundle Format

When `ReaBridge.inspectBinary()` runs, it outputs an **Evidence Bundle** formatted for AI agents:

```json
{
  "targetBinary": "C:/Games/Title/Game-Win64-Shipping.exe",
  "architecture": "x64",
  "evidenceType": "GameBinaryAnalysis",
  "timestamp": "2026-10-11T13:00:00.000Z",
  "findings": {
    "candidateAesKeys": [
      {
        "key": "0x4a6b8d1f3c5e7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f2a4b6c8d0e2f4a6b",
        "offset": 512,
        "confidence": "high"
      }
    ],
    "il2cppVersion": null,
    "signatures": ["UnrealEngine signature", "FArchive"]
  },
  "reaTaskPrompt": "Target: Game-Win64-Shipping.exe (x64)\nCandidate AES keys detected: 0x4a6b...\nObjective: Confirm decryption keys / recovery offsets."
}
```

---

## 4. Using with AI Agents & MCP

Configure `universal-asset-ripper` in your MCP client (e.g. Claude Code, Gemini CLI, Cursor, Antigravity) by adding to your `mcpServers` configuration:

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

The AI agent can then directly call:
* `ripper_detect`
* `ripper_inspect`
* `ripper_extract`
* `ripper_scan_binary`

---

## 5. The Multi-Tool Reverse Engineering Ecosystem

REA agents do not reinvent static decompilers or dynamic hooks from scratch; rather, they serve as the **reasoning and orchestration engine** coordinating specialized reverse engineering frameworks:

```
                          ┌─────────────────────────────┐
                          │         morluto/rea         │
                          │ (LLM Orchestration & Plans) │
                          └──────────────┬──────────────┘
                                         │
        ┌───────────────────┬────────────┴───────┬───────────────────┐
        ▼                   ▼                    ▼                   ▼
   [ Ghidra ]           [ Cpp2IL ]            [ JADX ]            [ Frida ]
 Native Decompiler    Unity IL2CPP ->      Android DEX ->     Dynamic Runtime
 (x86/x64/ARM C/ASM)  CIL (.NET DLLs)      Java Decompiler     Hooking & Memory
```

### Role & Division of Responsibilities

1. **[morluto/rea](https://github.com/morluto/rea)**:
   * **Role:** High-level autonomous agent coordinating tasks, generating hypotheses, interpreting Evidence Bundles, and running tools.
   * **When to use:** Complex reverse engineering workflows requiring iterative exploration and decision-making.

2. **[Ghidra](https://github.com/NationalSecurityAgency/ghidra)**:
   * **Role:** Deep static SRE framework for native compiled machine code.
   * **When to use:** Tracing `FAES::Decrypt` in Unreal binaries, auditing Delphi / C++ desktop binaries, reversing custom packing wrappers.

3. **[Cpp2IL](https://github.com/SamboyCoding/Cpp2IL)**:
   * **Role:** Specialized Unity IL2CPP deobfuscator and bytecode reconstructor.
   * **When to use:** When `ripper rea-inspect` detects `global-metadata.dat`. Transforms `GameAssembly.dll` machine code back into real .NET assemblies readable in dnSpy/ILSpy.

4. **[JADX](https://github.com/skylot/jadx)**:
   * **Role:** Dalvik/ART Dex-to-Java decompiler for Android packages (`.apk`, `.dex`, `.aab`).
   * **When to use:** Auditing Android game bootstrap loaders, reading `AndroidManifest.xml`, tracing JNI native library bindings.

5. **[Frida](https://github.com/frida/frida)**:
   * **Role:** Dynamic memory instrumentation and runtime function hooking.
   * **When to use:** When static entropy analysis fails to find AES keys (e.g., dynamically computed or encrypted keys). Intercepts keys and decrypted buffers directly from running processes.

---

## 6. Downstream Integration: Modding & Creative Workflows with `universal-modder`

Once assets are extracted and encryption/code is unraveled, the natural next step is often **modding**, asset replacement, or content creation. 

Universal Asset Ripper feeds directly into **[rehan-remade/universal-modder](https://github.com/rehan-remade/universal-modder)**:

```
      [ UPSTREAM : EXTRACTION & REVERSE ]
      Universal Asset Ripper (MCP Server / CLI)
      + Ghidra / Cpp2IL / Frida / JADX
      Tools: ripper_detect, ripper_inspect, ripper_extract, ripper_scan_binary
                           │
                           │ Extracted Assets & Decompiled Logic
                           ▼
      [ DOWNSTREAM : MOD CREATION & TESTING ]
      universal-modder (Agent Skills: Claude Code, Cursor, Codex)
      + fal.ai / ComfyUI MCP (generative 2D/3D/audio)
      Actions: generate replacement assets, build mod DLL/hooks,
               automate in-game verification, capture showcase video
```

* **MCP Synergy:** AI agents configured with both Universal Asset Ripper's MCP tools and `universal-modder` skills can run complete end-to-end game modding loops automatically: from package sniffing and AES decryption to asset regeneration and live in-game testing.

---

## 7. The Zero-MCP Philosophy: Lean Reverse Engineering (`leanrea`)

While REA historically relies on a heavy MCP server exposing over 200 individual tools (consuming upwards of 400k tokens just to load tool definitions), **Universal Asset Ripper** embraces the **lean execution philosophy** popularized by **[aicodeking/leanrea](https://github.com/aicodeking/leanrea)**:

1. **Native Parsers vs. MCP Bloat:** Universal Asset Ripper provides zero-dependency pure TypeScript parsers for Godot PCK, Unreal PAK (v1-v11 with AES-256), Electron ASAR/resources.pak, and Windows PE resources. These run in milliseconds via direct CLI invocations.
2. **Minimal MCP Surface:** When used in MCP mode, Universal Asset Ripper exposes only **4 focused high-level tools** (`ripper_detect`, `ripper_inspect`, `ripper_extract`, `ripper_scan_binary`), keeping context overhead near zero.
3. **Agent Skill Integration:** Agents in this repository can use the [`.zcode/skills/leanrea/SKILL.md`](../.zcode/skills/leanrea/SKILL.md) skill to drive native CLI tools (`ripper`, `file`, `strings`, `nm`, `rg -uu`, `otool`, `objdump`, `go version -m`) via plain shell commands, achieving 38% faster runs and 35% lower cost compared to multi-tool MCP frameworks.

---

## 8. Structured Agent Prompts (REAP Methodology)

To prevent AI hallucination and ensure evidence-backed reverse engineering findings, follow the **REAP (Reverse Engineering Agent Prompts)** methodology derived from **[JoasASantos/REA-Prompts](https://github.com/JoasASantos/REA-Prompts)**:

* **One feature per prompt**: Keep analysis focused on a single subsystem, function, or encryption scheme.
* **The 3-bucket classification**:
  - `[Confirmed Facts]`: Proven by cited offsets, strings, or disassembly opcodes.
  - `[Inferences]`: Deductions logically inferred from confirmed facts.
  - `[Unknowns]`: Questions that static inspection has not yet resolved.
* **Deliverable-oriented**: Conclude investigations with an executable test harness, a behavioral specification (`SPEC.md`), or an [`INVESTIGATION.md`](rea-prompts.md#long-running-investigation-investigationmd-template) progress log.

👉 **See the complete prompt catalog in [REAP: Reverse Engineering Agent Prompts & Investigation Methodology](rea-prompts.md).**

---

## 9. Complete Vendored REA Engine (`v6.8.0`) & Official Skills

Rather than relying strictly on external installations, the entire **[morluto/rea](https://github.com/morluto/rea)** engine (version **6.8.0**, released 2026-10-25) is now managed directly inside this repository under [`rea/`](../rea):

* **Direct Execution:** `ReaBridge` detects `./rea/scripts/rea.mjs` and invokes the local engine seamlessly, with transparent fallback to global `rea`. You can also run it via `npm run rea -- <command>`.
* **Complete Multi-Platform Bridges:** Includes Ghidra (`bridge/ghidra/`), Android Jadx (`bridge/android/`), Hopper (`bridge/hopper/`), Cutter (`bridge/cutter/`), and Swift LLDB/UI instrumentation (`bridge/native/`).
* **Official Agent Skills Attached:**
  * [`.zcode/skills/reverse-engineer-anything/`](../.zcode/skills/reverse-engineer-anything/SKILL.md) — Master reverse engineering skill (35 KB) backed by 7 comprehensive domain guides:
    - `native-and-artifacts.md` (38 KB deep SRE reference)
    - `android-applications.md` (DEX, APK signatures, Jadx, ADB)
    - `connection-and-recovery.md` (deadlines, budgets, failure triage)
    - `environments.md` (AgentEnv manifest serving & replay)
    - `evidence-workflows.md` (canonical Evidence contracts)
    - `javascript-applications.md` (route maps, bundle unbundling, AST)
    - `runtime-observation.md` (Frida, GDB, LLDB, process tracing)
  * [`.zcode/skills/rea-analysis-optimization/`](../.zcode/skills/rea-analysis-optimization/SKILL.md) — Investigation profiling and memory optimization.
  * [`.zcode/skills/rea-tool-design/`](../.zcode/skills/rea-tool-design/SKILL.md) — Deterministic tool design guidelines.
* **New in REA 6.8.0:**
  * **Agent Environments:** Project network captures and Evidence into manifests, build environments from browser scenarios, and serve evidence-gated writes.
  * **Packaged Application Triage:** Inspect & extract Godot PCK, PyInstaller archives, and Node.js Single Executable Application (SEA) blobs.
  * **Unity / IL2CPP Metadata (v24/v27):** Member names and literals linking, native methods and generic instances linking, Ghidra seeds export.
  * **Engine-less PE/ELF Inspection:** Export tables, delay-loads, Authenticode certificates, TLS callbacks/load configuration, ELF notes.
  * **Ghidra Enhancements:** DOL GameCube/Wii language selection and override conflict detection (`REA_GHIDRA_LANGUAGE_ID`).

---

## 10. Keeping REA Up-to-Date (Sync Automation)

To track upstream updates from [morluto/rea](https://github.com/morluto/rea), Universal Asset Ripper provides an automated synchronization utility:

```bash
# Check if a new release is available upstream without changing anything:
npm run sync:rea:check

# Perform the sync to the latest release:
npm run sync:rea

# Sync to a specific tag or branch, or force re-sync:
npm run sync:rea -- --ref rea-agents-6.8.0
npm run sync:rea -- --force
```

### What `sync-rea` Automates:
1. **Upstream Tag Discovery:** Inspects remote git tags on `morluto/rea` and compares them with the local vendored version in `rea/package.json`.
2. **Shallow Staging Clone:** Fetches only the required target tag/ref into an ephemeral staging area.
3. **Vendored Tree Refresh:** Syncs the fresh engine source, bridges, docs, and configurations into `./rea/` (excluding `.git` and `node_modules`).
4. **Agent Skills Synchronization:** Automatically updates the official skills (`reverse-engineer-anything`, `rea-analysis-optimization`, etc.) in [`.zcode/skills/`](../.zcode/skills/) and `.agents/skills/`.
5. **Post-Sync Verification:** Prompts to run `npm test` and `npm run lint` on the parent repository.

---

## 11. Multi-Engine Decompilers & Disassembly Backends

Universal Asset Ripper integrates 5 decompiler and disassembly backends orchestrated through `DecompilerRegistry`:
- **NSA Ghidra** (Sleigh C decompiler)
- **Cutter / Rizin** (Open-source RE platform & Ghidra decompiler plugin)
- **Hopper Disassembler** (macOS, Linux, Windows x86/ARM disassembly)
- **IDA Pro / Hex-Rays** (Batch mode execution)
- **GNU Binutils** (Zero-install baseline: `objdump`, `nm`, `strings` from MSYS2/PATH)

### CLI Commands:
```bash
ripper decompilers      # Inspect engines
ripper disasm <target>  # Disassemble machine instructions
ripper symbols <target> # Extract symbol tables & imported APIs
ripper decompile <tgt>  # Decompile to C with Ghidra/Cutter
```

For complete setup guides and the full reverse engineering pipeline, see:
- [Decompiler Backends Guide](decompiler-guide.md)
- [Complete Functional REA Workflow](workflow-rea-complete.md)







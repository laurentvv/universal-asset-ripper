# REAP: Reverse Engineering Agent Prompts & Investigation Methodology

A curated collection of structured reverse engineering prompts and investigation patterns for AI coding agents (Claude Code, Antigravity, Cursor, Codex) paired with **Universal Asset Ripper** and **leanrea**.

Derived from battle-tested methodologies in [`JoasASantos/REA-Prompts`](https://github.com/JoasASantos/REA-Prompts) and [`aicodeking/leanrea`](https://github.com/aicodeking/leanrea), these prompts enforce evidence-backed reasoning and prevent AI hallucinations when inspecting compiled software, game packages, and binary formats.

---

## 🧭 The 5 Core Principles

1. **One Feature per Prompt:** Broad questions like *"Explain the whole architecture"* produce superficial, imprecise summaries. Narrow prompts focused on a single mechanism (e.g. *"Trace how encryption keys are derived on startup"*) yield exact function chains, offsets, and opcode evidence.
2. **Demand Tangible Evidence:** Require file paths, hex offsets, function names, and disassembly snippets for every conclusion.
3. **The 3-Bucket Format (Non-Negotiable):**
   * **[Confirmed Facts]**: Directly observed in the binary or data stream with cited proof.
   * **[Inferences & Hypotheses]**: Logically deduced from observed facts (clearly labeled as unconfirmed).
   * **[Unknowns]**: Specific questions that static analysis has not yet answered (never claim a feature is "absent" without exhaustive proof).
4. **Static First, Dynamic When Necessary:** Interdict program execution until static triage (`file`, `strings`, `nm`, `ripper detect`, `ripper rea-inspect`) maps the expected path.
5. **End with a Verifiable Deliverable:** A `SPEC.md`, a minimal reproduction script, a test harness, or a clean-room parser that validates claims against ground-truth data.

---

## 📋 Prompt Library

### 1. Game Asset Extraction & Decryption Key Hunt
*Use when dealing with encrypted game archives (`.pak`, `.pck`, `.ucas`) or protected Unity IL2CPP builds.*

```text
Target: <PATH TO GAME EXECUTABLE OR ARCHIVE>

Run `ripper rea-inspect` on the binary and verify candidate AES-256 keys against <PATH TO PAK/PCK>.
Trace how the game decrypts its asset index:

1. Identify candidate keys found via Shannon entropy analysis and proximity to Rijndael S-Boxes.
2. Check if the keys open the asset index or if the key is dynamically computed/unpacked at runtime.
3. If no plaintext key is present, identify the decryption entry point (e.g. FAES::Decrypt in Unreal Engine, or godot_script_decrypt in Godot).
4. Present findings using the 3-bucket format ([Confirmed Facts], [Inferences], [Unknowns]) with precise offsets.
```

---

### 2. Proprietary File Format Reverse Engineering
*Use when analyzing an unknown binary save file, custom model/mesh container, or proprietary asset format.*

```text
Target: <PATH TO UNKNOWN FILE OR ASSET DUMP>

Reverse engineer the structure of this binary format:

1. Identify header magic bytes, format version, and endianness.
2. Map the table of contents (TOC): entry count, offset table, compressed size vs uncompressed size, and checksums.
3. Detect data compression (Zlib, Gzip, Zstd, Oodle, LZ4) or XOR/AES encryption flags.
4. Write a standalone TypeScript or Python reader script that parses the header and extracts the raw payload.
5. Provide a hex dump breakdown annotating the first 256 bytes with corresponding fields.
```

---

### 3. Feature Tracing (UI Event to Execution)
*Use to understand how a specific capability works from the user interface down to storage or network.*

```text
Application: <PATH TO APPLICATION>
Feature to investigate: <BUTTON, MENU OPTION, OR CLI FLAG>

Trace the exact execution path triggered by this feature:

1. Extract application resources with `ripper extract` (or dialog templates via `dialogs/*.json`).
2. Identify the control ID / label and locate its corresponding event handler in the binary or JavaScript bundle.
3. Follow the data flow: user inputs -> validation logic -> state mutations -> persistence or network transmission.
4. Name every function and module on the path with exact offsets or file locations.
5. Do not execute the application; rely entirely on static evidence.
```

---

### 4. Game Logic & Mechanics Recovery
*Use to extract exact gameplay formulas, physical constants, or rule engines for modding or clean-room recreation.*

```text
Game binary: <PATH TO BINARY>
Mechanic to recover: <e.g. DAMAGE CALCULATION, JUMP VELOCITY, LOOT DROP PROBABILITY>

Recover the exact mathematical formula and state machine governing this mechanic:

1. Locate strings, constants, or configuration tables related to this system.
2. Disassemble the responsible function and trace the arithmetic operations / branch logic.
3. Write down the complete formula in plain mathematical notation and in pseudocode.
4. Provide a standalone Python or TypeScript test harness that computes the outcome for sample inputs.
5. Mark the findings as [Confirmed Facts], [Inferences], or [Unknowns].
```

---

### 5. Clean-Room Implementation Specification
*Use to specify a clean-room clone from observed inputs, outputs, dialogs, and protocol specs.*

```text
Reference software: <NAME AND PATH OF APPLICATION>
Target language: <RUST / TYPESCRIPT / PYTHON>

Create a complete clean-room specification (SPEC.md) for reimplementing this tool:

1. Inventory the external surface: CLI arguments, environment variables, config files, Win32 dialogs, and output formats.
2. Define the architectural boundary: separate core domain logic from OS-specific adapters.
3. Write a behavioral specification covering all documented error codes, edge cases, and protocol frames.
4. Formulate automated unit and integration tests (with a mock server or test vectors) to prove parity.
5. Strictly exclude any decompiled proprietary code; specify behavior solely from observable interfaces and public protocols.
```

---

### 6. Electron App Anatomy & IPC Audit
*Use for Electron desktop applications to map IPC attack surfaces and extract internal business logic.*

```text
Electron package: <PATH TO APP.ASAR>

Inspect the architecture and IPC boundary of this Electron app:

1. Extract the package with `ripper inspect` and `@electron/asar extract`.
2. Inspect `package.json` for entry points, main script, and dependencies.
3. Search with `rg -uu` for `contextBridge.exposeInMainWorld`, `ipcMain.handle`, and `ipcRenderer.invoke`.
4. Construct a table mapping each IPC channel name, expected arguments, sender context, and backend handler.
5. Flag any insecure patterns (e.g. `nodeIntegration: true`, `contextIsolation: false`, or raw shell execution).
```

---

## 📝 Long-Running Investigation: `INVESTIGATION.md` Template

For complex reverse engineering tasks spanning multiple sessions, maintain an `INVESTIGATION.md` log in the scratch directory to prevent context drift:

```markdown
# Investigation Log: <Target Name>

## Status & Objective
- **Target**: `<Path or Binary Name>`
- **Objective**: `<What specific question we are trying to answer>`
- **Last Updated**: `<Timestamp>`

## 1. Confirmed Facts (Evidence-Backed)
- [x] Architecture: x64 PE (MSVC runtime). Entry point at `0x140012340`.
- [x] Package encryption: Unreal Engine pak format v8, AES-256 encrypted index.
- [x] Candidate key `0x4a6b...` verified: opens `GameContent.pak` (Mount point: `../../../Game/`).

## 2. Working Hypotheses
- [ ] Network telemetry uses custom protobuf over TLS on port 443.
- [ ] Asset index chunk tables use Zstandard compression based on magic `0x28B52FFD`.

## 3. Discarded Theories
- [x] *Hypothesis*: S-Box near `0x14028000` is an encryption routine. *Reason Discarded*: Confirmed to be standard CRC32 lookup table upon disassembly inspection.

## 4. Residual Unknowns & Next Steps
1. Disassemble `sub_140045A10` to confirm protobuf deserializer structure.
2. Extract remaining localized dialog strings from `.rsrc`.
```

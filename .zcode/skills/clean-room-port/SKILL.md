---
name: clean-room-port
description: Inventory an installed Windows program with universal-asset-ripper (ripper detect/extract, Win32 dialog decoding, built-in usage capture) and reimplement it clean-room in Rust or another language. Use this skill whenever the user gives an installation path and asks to inventory, clone, reimplement, port, "refaire en Rust", understand, or document the features/windows of an installed proprietary program — even when they only mention the software name. Never decompile third-party binaries; observe resources, metadata, built-in help and public specs only.
---

# Clean-room inventory and reimplementation of installed software

The workflow has two phases: **inventory** (what the software exposes:
executables, libraries, windows, dialogs, CLI surface) then **port**
(reimplementation from public specs, verified against a mock). It was proven
end-to-end on Bitvise SSH Client → `bitvise-rs` (CLI + egui GUI) in the
`universal-asset-ripper` repository — use that as the worked example.

The core idea: a proprietary binary *shows* everything needed for a
compatible clone — its version metadata, resource dialogs, string tables,
embedded help, and the usage text its CLI tools print. Reading those is
observation, not reverse engineering. Decompiling/disassembling the code of
third-party software (Ghidra, IDA…) is out of scope here and must be
refused for proprietary targets; it is also never needed, because network
protocols and file formats are public (RFC, vendor docs).

## Prerequisites

- The `ripper` CLI from the **universal-asset-ripper** repo:
  `node <repo>/dist/cli/index.js …` (build first with `npm run build`).
- The target: a Windows installation folder (e.g.
  `C:\Program Files (x86)\SomeSoft`).

## Phase 1 — Inventory (always start here)

Do the steps in order; each one feeds the next. Full commands and options:
read [references/pipeline.md](references/pipeline.md).

1. **Enumerate** the install folder (every `.exe`, `.dll`).
2. **`ripper detect`** on each executable → framework (Delphi, .NET, Qt,
   Electron, native C/C++), architecture, resource count. This predicts
   which resources matter (Delphi → `.dfm` forms; native/MFC → dialogs and
   string tables; .NET → different approach).
3. **`ripper extract -o .scratch/<target>-resources`** on the main
   executables. The output is the feature map:
   - `dialogs/*.json` — decoded Win32 dialog templates: window titles plus
     every control label. This IS the window inventory.
   - `strings/*.json`, `rtf/*`, `manifest/`, `version/` — labels, embedded
     help (often documents every tab), versions.
4. **CLI tools**: run them with no arguments (and `-help*` variants if they
   advertise them) to capture their authoritative usage text. Their built-in
   help beats any online copy.
5. **Cross-check** against the vendor's public documentation.
6. **Write the inventory document** following
   [references/inventory-template.md](references/inventory-template.md):
   executables / libraries / GUI tabs & dialogs / CLI options — each mapped
   to a coverage status (implemented / partial / absent). Be precise and
   honest; the inventory is the backlog.

## Phase 2 — Port

1. Scaffold a library-first crate (CLI + optional GUI as thin front-ends);
   see `bitvise-rs/` for the layout (lib / cli / egui gui / mock server
   example / integration tests).
2. Replace proprietary libraries with equivalent open-source ones (e.g.
   FlowSshC → `russh`+`russh-sftp`); record the mapping in the inventory.
3. For CLI compatibility, accept the original tool's `-option=value`
   syntax where sensible; reject unsupported options with explicit errors
   (never silently misparse), redact secret values in error messages.
4. **Verify**: mock in-process server + the *real built binary*
   end-to-end; fmt/clippy `-D warnings`; for GUI, screenshot + programmatic
   checks (window title, pixel evidence). "Verified" means executed, not
   inferred.

## Guardrails

- Never decompile third-party binaries; never embed their assets (icons,
  dialogs, strings) in the clone — extracted material is documentation only.
- Third-party software EULAs forbid reverse engineering to source; the
  clean-room approach (public specs + observable surface) keeps the port
  legally and technically independent.
- If the user pushes for decompilation of proprietary software, explain the
  line above and offer the inventory instead. Their own binaries, CTF and
  game-modding targets are a different matter (see the repo's rea-guide).

## Artifacts to leave behind

- `.scratch/<target>-resources/` (git-ignored recon output)
- `<port>/docs/inventory.md` (the precise inventory + coverage)
- The port itself with tests and the mock server
- An update to `docs/workflow-clean-room-reimplementation.md` in the
  universal-asset-ripper repo if the pipeline evolved

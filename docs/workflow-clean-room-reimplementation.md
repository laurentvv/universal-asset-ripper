# Workflow: Clean-Room Reimplementation of Installed Software

How this repository's own tooling is used as the reconnaissance phase for
reimplementing third-party Windows software (clean-room) in another
language. Proven on two ports:

- **TreeSize Free → dirsize** (C++): concept-only port (directory size analysis).
- **Bitvise SSH Client → bvrs / bvrs-gui** (Rust): CLI tools + command-line
  compatibility layer + GUI, from the installed 9.66 suite.

## Principles

1. **Never decompile.** The upstream binaries are proprietary; their EULAs
   forbid reverse engineering to source. Everything below observes what the
   software *exposes* (resources, metadata, built-in help, runtime UI) —
   not its code. A decompiler (Ghidra bridge) exists in the toolchain for
   authorized targets (your own binaries, CTF, games you may mod) — it is
   not used on third-party desktop software, and never to feed a clone.
2. **The reimplementation is independent.** No extracted asset, string
   table or icon from the target is embedded into the clone; extracted
   material serves as *documentation of behavior* only.
3. **Cross-check with public documentation.** Built-in usage text is
   authoritative for CLI syntax; vendor docs confirm it.

## Pipeline

```text
install dir ──► ripper detect ──► framework/arch/engine + resource count
            └─► ripper extract ──► resources: dialogs, menus, string tables,
                                   icons, RTF help → UI structure & feature map
CLI tools   ──► run with no args / -help* ──► authoritative usage + option list
GUI         ──► launch + screenshot       ──► layout reference (optional)
public docs ──► vendor documentation      ──► confirmation
                    │
                    ▼
      clean-room implementation (own code, public specs/protocols)
                    │
                    ▼
      tests: in-process mock server + real binary end-to-end
```

### Step details

| Step | Command | What it yields |
|---|---|---|
| Identify | `ripper detect <exe>` | framework (Delphi/MFC/.NET/Qt/native), architecture, resource inventory |
| Inventory | `ripper extract <exe> -o dir` | `dialogs/*.json` (decoded Win32 dialog templates: title + every control label), `strings/*`, `rtf/*` help, icons — the UI feature map |
| Usage text | run `<cli-tool>.exe` (no args), `-help-*` | exact option surface for CLI compatibility |
| Cross-check | vendor documentation | semantics of each option |
| Port | own code, public protocol specs (RFC 4251… for SSH) | the clone |
| Verify | mock server + the real built binary (see bitvise-rs `tests/`) | end-to-end green, fmt/clippy gates |

## Where the artifacts live

- Reconnaissance output: `.scratch/<target>-resources/` (git-ignored).
- Ports live next to their inputs' study notes; see `bitvise-rs/README.md`
  for the Bitvise mapping, and `bitvise-rs/docs/inventory.md` for the full
  precise inventory (executables, DLLs, tabs, 57 decoded dialogs) built
  with this workflow.

## Skill

The whole pipeline is packaged as the ZCode skill **`clean-room-port`**
(`~/.agents/skills/clean-room-port/`): trigger it by giving an installation
path and asking for an inventory or a reimplementation. A one-line prompt
is enough:

> Fais l'inventaire clean-room de « C:\Program Files\<Logiciel> » avec le
> projet universal-asset-ripper (skill clean-room-port), puis le port Rust.

## Lessons

- [2026-10-21] Bitvise port — the built-in usage text of `sftpc` 9.66
  (printed by running the tool with no arguments) is more precise than any
  online copy for the option surface; capture it first.
- [2026-10-21] A mock in-process server (russh server side) driving the
  *real* built binary is the cheapest honest verification of a client
  clone; visual checks need a standalone runnable of the same server
  (`examples/mock-sshd.rs` pattern).

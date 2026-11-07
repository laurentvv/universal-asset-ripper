# Reverse Engineering Ecosystem Catalog

> Survey of 20 external tools (shared 2026-11-07), triaged against what this
> repository already ships. Upstream READMEs and repo metadata were fetched on
> **2026-11-07** to `.scratch/ecosystem-2026-11-07/` (git-ignored evidence, one
> directory per tool). Versions cited are the latest release tags at fetch
> time. Companion docs: [decompiler-guide.md](decompiler-guide.md),
> [rea-guide.md](rea-guide.md), [workflow-clean-room-reimplementation.md](workflow-clean-room-reimplementation.md).

---

## Verdict at a glance

| Verdict | Tool | Latest release (2026-11-07) | Rationale |
| :-- | :-- | :-- | :-- |
| **Adopt** | GhidraMCP (LaurieWired) | 2.0 | MCP server for Ghidra, incl. headless PyGhidra mode — agent-driven Ghidra sessions next to our own `ripper mcp`. |
| **Adopt** | Hex-Rays IDA MCP (official) | — (repo) | Official IDA MCP server; `ida-pro-mcp` itself recommends it over itself. |
| **Adopt** | ida-pro-mcp (mrexodia) | 1.4.0 | Fallback when IDA < 9.4; requires idalib activation. |
| **Adopt** | Apktool | v3.0.3 | Decodes APK resources/manifest/raw assets — the Android packaging layer our native parsers and rea's jadx bridge do not cover. |
| **Adopt** | ILSpy (`ilspycmd`) | v11.2 | Headless .NET decompiler for Unity Mono `Assembly-CSharp.dll` → C# source. |
| **Adopt** | Speedrunlab self-learning loop | no releases (skill) | Parity-checklist methodology upgrade for our `clean-room-port` skill. |
| **Adopt** | zhuyansen/awesome-ai-reverse-engineering | — (list) | Closest live replacement for the dead `wtsxDev` list; 122 graded repos incl. REA, GhidraMCP, IDA MCP. |
| Covered | rea (morluto) | rea-agents-6.8.0 | Vendored at v6.8.0 = latest upstream; `npm run sync:rea:check` tracks it. |
| Covered | Ghidra | 12.2 | Bridged via `rea/bridge/ghidra` + native Sleigh engine in `ripper audit`; note GhidraMCP pins 12.1.4. |
| Covered | jadx | v1.5.6 | `rea/bridge/android/ReaJadxBridge.java`. |
| Covered | Frida | 17.26.2 | rea runtime observation + ecosystem table in README. |
| Covered | mitmproxy | v12.3.1 | `rea/bridge/mitmproxy`. |
| Covered | rizin | v0.9.1 | Cutter/rizin backend (decompiler-guide §2.C). |
| Covered | Hopper | — | `rea/bridge/hopper_bridge.py`. |
| Reject | radare2 | 6.2.6 | rizin is its fork and already the integrated engine; duplicate. |
| Reject | x64dbg | 2026.05.27 | GUI-only manual debugger; our pipeline is headless, runtime observation goes through rea (LLDB tracer, pwndbg/pwntools). |
| Reject | ImHex | v1.38.1 | GUI hex editor (GPL-2.0); parsers are prototyped natively in TS against synthetic fixtures, no agent surface. |
| Reject | angr | — | Python symbolic execution, CTF-oriented; no fit with a TypeScript extraction pipeline. |
| Reject | raddebugger | v0.9.29-alpha | Alpha, x64-only, GUI, converts PDB/DWARF for code you build — shipped games carry no symbols; not agent-drivable. |
| Reject | dnSpy | (archived) | Upstream archived 2020-12-20; use the dnSpyex fork for GUI debugging, `ilspycmd` for headless. |
| Reject | wtsxDev/awesome-ai-reverse-engineering | — | Repo deleted (HTTP 404). |
| Reject | alphaSeclab/awesome-reverse-engineering | — | 258 KB general mega-list, no project-specific signal. |
| Reject | cabbitar Substack | — | Profile exposes no posts; nothing assessable. |

---

## A. Adopt — integration notes

### A.1 GhidraMCP 2.0 (Apache-2.0, LaurieWired)

MCP server + Ghidra plugin: decompile, rename methods/data, list
methods/classes/imports/exports — the interactive counterpart to our batch
`ripper audit` (native Sleigh, < 900 ms/function). Requires **Ghidra 12.1.4**
(not 12.2 yet) and the extension zip from its releases.

```json
{
  "mcpServers": {
    "ghidra": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/LaurieWired/GhidraMCP",
               "ghidra-mcp", "--ghidra-server", "http://127.0.0.1:8080/"]
    }
  }
}
```

Headless (no Ghidra GUI) via PyGhidra, reusable for CI-style runs:

```bash
uvx --python 3.13 --from "ghidra-mcp[headless] @ git+https://github.com/LaurieWired/GhidraMCP" \
    ghidra-mcp --headless --binary /path/to/target   # add --project DIR to persist
```

### A.2 IDA MCP (Hex-Rays official, then mrexodia fallback)

- **Primary — [HexRaysSA/ida-mcp](https://github.com/HexRaysSA/ida-mcp)**:
  IDA 9.4+, headless worker on idalib, GUI bridging via plugin.
  ```bash
  uvx ida-hcli mcp install          # installs GUI plugin + agent plugins
  ```
- **Fallback — [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp) 1.4.0**:
  IDA 8.3+/9 (IDA Free not supported); activate idalib first:
  ```bash
  uv run "C:\Program Files\IDA Professional 9.3\idalib\python\py-activate-idalib.py"
  ```
  Its README also ships battle-tested RE prompt discipline (never convert
  number bases by hand — use the `int_convert` tool; rename → retype →
  comment loop) worth reusing in our REAP prompts.

The ripper keeps its `IDA_PATH` headless bridge (`ripper decompile --backend
ida`); the MCP servers add interactive agent sessions on top.

### A.3 Apktool 3.0.3 (Apache-2.0, iBotPeaches)

`main` is now the 3.x line (2.x in maintenance). Fills our Android packaging
gap — rea's jadx bridge recovers Java sources, Apktool decodes what jadx does
not: `AndroidManifest.xml`, `resources.arsc` → res/, raw `assets/` (where
Unity `bin/Data`, IL2CPP `global-metadata.dat` and obb payload hints live).

```bash
apktool d game.apk -o apk-out -s      # -s = skip smali, resources + assets only
```

Natural pre-step for `ripper detect`/`inspect` on extracted
`assets/bin/Data/...` content.

### A.4 ILSpy 11.2 / `ilspycmd` (MIT, icsharpcode)

Scriptable, cross-platform .NET decompiler — the headless replacement for the
GUI dnSpy step of the Unity flow (Mono backend → `Assembly-CSharp.dll`;
IL2CPP keeps going through Cpp2IL first, then ILSpy for readable C#).

```bash
dotnet tool install -g ilspycmd
ilspycmd -p -o ./decompiled ./Assembly-CSharp.dll    # -p = whole project mode
```

Also ships PowerShell cmdlets and an Avalonia GUI. dnSpy upstream is
**archived since 2020-12-20** — use the dnSpyex fork when a debugging GUI is
really needed.

### A.5 Speedrunlab self-learning loop (MIT, skill)

Not a tool but a methodology upgrade directly applicable to
[`workflow-clean-room-reimplementation.md`](workflow-clean-room-reimplementation.md)
and the `clean-room-port` skill: the examination inventory becomes a **signed
parity checklist** (one testable behaviour per item, tiered must/should/out,
concrete input + expected output), the build is scored
must-haves-passing/total each iteration, and "done" means every must-have
passing in **two consecutive reviews** — with stop rules (stalled score,
protected material needed, budget spent) and a learning loop that stages
fix-recipes for approval. Install as a companion skill next to
`clean-room-port` in `.zcode/skills/` if adopted.

### A.6 zhuyansen/awesome-ai-reverse-engineering

The linked `wtsxDev` list is gone (404). This is the closest live equivalent:
122 agent-RE repos individually read and security-graded (Ghidra MCP, IDA Pro
MCP, jadx, Frida, skills, REA) — a mining source for future tool evaluations.

---

## B. Already covered — where

| Capability | In-repo home |
| :-- | :-- |
| rea engine (v6.8.0, = latest upstream `rea-agents-6.8.0` of 2026-10-25) | `rea/`, sync via `npm run sync:rea:check` |
| Ghidra headless + native Sleigh decompilation | `rea/bridge/ghidra`, `src/` audit pipeline, [decompiler-guide.md](decompiler-guide.md) |
| jadx (Android Java layer) | `rea/bridge/android/ReaJadxBridge.java` |
| mitmproxy (traffic capture) | `rea/bridge/mitmproxy` |
| Cutter/rizin, Hopper, IDA headless, Binutils | `rea/bridge/cutter`, `rea/bridge/hopper_bridge.py`, decompiler-guide |
| Frida (runtime hooking) | rea skills + README ecosystem table |

---

## C. Rejected — evidence

Each verdict is backed by the fetched upstream README under
`.scratch/ecosystem-2026-11-07/`:

- **radare2 6.2.6** — rizin forked from it; Cutter/rizin is already the
  integrated engine. Adding r2 would duplicate the disassembly backend.
- **x64dbg 2026.05.27** — interactive GUI debugger for manual analysis;
  no headless/agent surface. Runtime observation is already covered by rea
  (`rea_lldb_tracer.py`, pwndbg/pwntools bridges, process bridge).
- **ImHex v1.38.1** — GUI hex editor + pattern language (GPL-2.0). Our
  container parsers are developed natively in TypeScript against synthetic
  fixtures with round-trip tests; no place in the automated pipeline.
- **angr** — symbolic execution framework (Python, BSD-2), CTF/crackme
  oriented; nothing in the extraction pipeline needs SMT solving.
- **raddebugger v0.9.29-alpha** — Epic's native debugger is alpha, x64-only,
  GUI-first, and converts PDB/DWARF for software you build. Shipped game
  binaries ship no debug info; would not attach usefully.
- **dnSpy** — upstream archived 2020-12-20 (metadata: `archived: true`).
- **alphaSeclab/awesome-reverse-engineering** — 258 KB general-purpose
  mega-list; no signal specific to this stack.
- **cabbitar Substack** — profile page exposes zero posts; nothing to assess.

---

## Version pins at survey time (2026-11-07)

| Repo | Latest release | Published |
| :-- | :-- | :-- |
| morluto/rea | rea-agents-6.8.0 | 2026-10-25 |
| NationalSecurityAgency/ghidra | Ghidra_12.2_build | 2026-10-22 |
| LaurieWired/GhidraMCP | 2.0 | 2026-10-10 |
| mrexodia/ida-pro-mcp | 1.4.0 | 2025-10-06 |
| HexRaysSA/ida-mcp | (no releases, repo) | — |
| iBotPeaches/Apktool | v3.0.3 | 2026-07-20 |
| icsharpcode/ILSpy | v11.2 | 2026-10-27 |
| skylot/jadx | v1.5.6 | 2026-07-10 |
| frida/frida | 17.26.2 | 2026-11-07 |
| mitmproxy/mitmproxy | v12.3.1 | 2026-10-25 |
| radareorg/radare2 | 6.2.6 | 2026-11-05 |
| rizinorg/rizin | v0.9.1 | 2026-06-29 |
| WerWolv/ImHex | v1.38.1 | 2025-12-21 |
| EpicGames/raddebugger | v0.9.29-alpha | 2026-09-30 |
| x64dbg/x64dbg | 2026.05.27 | 2026-05-27 |

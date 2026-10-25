# Changelog

## Unreleased (lots 1-3)

### Lot 3 - Hardening and tooling
- Complete vendored `morluto/rea` (v6.8.0, 2026-10-25) integrated into `rea/` with multi-platform bridges (Ghidra, Jadx, Hopper, Cutter, Swift LLDB/UI), docs, and `npm run rea` entrypoint.
- Automated upstream sync tool (`scripts/sync-rea.mjs`, `npm run sync:rea:check`, `npm run sync:rea`) to track upstream releases and refresh vendored sources and agent skills.
- Official REA agent skills attached in `.zcode/skills/`: `reverse-engineer-anything` (with 7 deep domain reference guides for native SRE, Android, runtime observation, environments, evidence), `rea-analysis-optimization`, and `rea-tool-design`.
- `ReaBridge`: native local resolution of `./rea/scripts/rea.mjs` with graceful fallback to global CLI.
- Lean RE skill (`.zcode/skills/leanrea`) and REAP structured prompt catalog (`docs/rea-prompts.md`) integrating zero-MCP reverse engineering and evidence-backed prompt methodology.
- MCP: optional allow-list of root directories (`UAR_ALLOWED_ROOTS`, `ripper mcp --root <dir>`); all path arguments are checked after symlink resolution.
- New `ripper doctor [--json]` command (Node, repak, AssetRipper, rea).
- ESLint flat config (`npm run lint`), coverage (`npm run test:coverage`), `clean` script, `files` whitelist in package.json, `.gitattributes` (LF).
- GitHub Actions CI: Ubuntu and Windows, Node 22 and 24 (lint, build, test).

### Lots 1-2 - Core extraction
- Native Unreal pak reader (index, AES-256 encrypted indexes) with repak fallback for compressed entries.
- Electron `app.asar` and Chromium `resources.pak` support.
- Godot PCK v0-v4 parsing and encrypted PCK decryption.
- Unity extraction through headless AssetRipper (`ASSETRIPPER_PATH` or PATH).
- PE resource decoders (bitmaps, icons, cursors, version info) and detector heuristics.
- REA binary scanner with AES key candidate verification against a pak and evidence bundles.
- Safe process execution (no shell), JSON output for CLI commands, hardened MCP argument validation.

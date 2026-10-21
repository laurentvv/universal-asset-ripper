# Pipeline reference — commands and tactics

Concrete commands for each phase. `RIPPER` = `node <universal-asset-ripper>/dist/cli/index.js`
(build once with `npm run build` inside the repo).

## 1. Enumerate and detect

```bash
ls "<install dir>"                          # every exe/dll + shipped docs/samples
RIPPER detect "<install dir>/<tool>.exe"    # framework, arch, resource inventory
```

Framework reading (drives the rest):

| Detection | What to extract | Where the features live |
|---|---|---|
| Delphi | `ripper extract` gives `.dfm` forms (+ text) | forms + string tables |
| Native C/C++ (MFC) | dialogs (`dialogs/*.json`), string tables, RTF help | dialog controls + help texts |
| .NET | dnSpy-style analysis is out of clean-room scope; rely on public docs | vendor docs |
| Electron | `app.asar`, `resources.pak` | JS sources (often readable) |
| Qt | `.qm` translations, embedded resources | UI texts |

## 2. Extract resources

```bash
RIPPER extract "<install dir>/<main>.exe" -o .scratch/<target>-resources
```

Key outputs:

- `dialogs/dialog_<id>.json` — `{ format, title, menu, style, controlCount,
  controls: [{ class, text, id }] }`. One JSON per dialog template; titles +
  control labels give the precise window inventory.
- `strings/strings_<id>.json` — `{ blockId, strings: { id: text } }`.
- `rtf/res_<id>` — embedded help; strip RTF markup to plain text (a short
  Python script works; keep it in `.scratch/`). Help texts usually document
  every tab and option in prose.
- `version/`, `manifest/`, `bitmaps/`, `cursors/`.

Useful flags: `--categories config`, `--filter <substr>`, `--json`.

## 3. Capture CLI usage (authoritative)

Run each CLI tool **with no arguments** and capture stdout/stderr: most
print their full usage when a required parameter is missing. If the usage
lists `-help-*` variants, capture those too (`-help-params`,
`-help-examples`, `-help-codes`, `-help-shell`…). Parse the usage line to
get the exact option surface — it is the source of truth for a compatible
parser, more precise than vendor web pages.

## 4. Inventory document

Follow `inventory-template.md`. Statuses: ✅ implemented · 🟡 partial ·
❌ absent · n/a. Group dialogs by function (connection, keys, main window…)
with their decoded titles.

## 5. Port scaffold (Rust)

Proven layout (see bitvise-rs):

```
<port>/
  Cargo.toml            # workspace
  src/                  # library: dest parsing, auth, protocol, sessions
  src/bin or main.rs    # CLI
  bvrs-gui/ (optional)  # egui front-end; net thread owns the tokio runtime,
                         # communicates with the UI via channels + repaint
  examples/mock-*.rs    # standalone mock server for manual testing
  tests/                # in-process server (tests/support) + REAL binary
                         # driven end-to-end (CARGO_BIN_EXE_<name>)
  docs/inventory.md
```

Library choices by domain (start from public protocols):

- SSH/SFTP → `russh` + `russh-sftp` (pure Rust; on Windows without
  cmake/nasm use the `ring` feature, not the default `aws-lc-rs`)
- HTTP(S) → `reqwest`; TLS → `rustls`; GUI → `egui`/`eframe` (pin the
  version you tested; API moves between releases)

## 6. Verification requirements

- Integration tests spawn the mock **and run the real built binary** via
  `env!("CARGO_BIN_EXE_<name>")` — full path including arg parsing.
- Mock servers: russh has a full server side; reuse it in
  `tests/support/mod.rs` and in a runnable `examples/mock-server.rs`.
- GUI: launch with auto-connect flags, check the window title via
  `Get-Process`, screenshot, and pixel-check for expected UI colors.
- Gates: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test` — all actually executed before claiming done.

## Known pitfalls (learned the hard way)

- Compiled `.res` DIALOGEX templates start with `01 00 ff ff` (version then
  signature) — not `ff ff` first as the MSDN struct listing suggests.
- `tokio` current-thread runtimes starve spawned servers while a test blocks
  in `Command::output()`; use `flavor = "multi_thread"` + async process.
- Pair russh/russh-sftp versions as tested upstream (check each crate's
  dev-dependencies) — newest+newest can be untested together.
- A mock server that echoes all channel data will corrupt SFTP protocol
  packets; scope echo behavior to the channels that need it.

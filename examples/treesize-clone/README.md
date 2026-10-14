# treesize-clone (Rust)

A disk-usage analyzer in 100% Rust that re-creates the look and behaviour of JAM TreeSize Free,
built on assets extracted by Universal Asset Ripper (main icon, chevron bitmaps).

## Run

```bash
cargo run --release -- [PATH]          # GUI (PATH is scanned at startup)
cargo run --release -- --cli PATH -d 3 # headless tree print
cargo run --release -- --screenshot out.png --view treemap PATH   # developer screenshot
cargo test
```

## Structure

| Path | Role |
|---|---|
| `src/main.rs` | entry point, `--cli` / GUI dispatch |
| `src/cli.rs` | headless mode (previous 220-line scanner, now on the shared engine) |
| `src/scan/model.rs` | arena `Tree` of `Node` (parent/children indices, size, allocated, files, dirs, mtime, attrs, is_dir/is_link), `remove_subtree`, formatting helpers |
| `src/scan/walker.rs` | rayon parallel walker, `Progress` atomics, cancel flag, collected errors, symlink/junction guard, allocated size (`GetCompressedFileSizeW` for compressed/sparse files, 4 KiB cluster rounding otherwise, `st_blocks` on Unix) |
| `src/scan/mod.rs` | `spawn_scan` background thread + crossbeam channel, scan unit tests |
| `src/ui/app.rs` | eframe/egui app: toolbar, virtualised sortable tree table, status bar, context menu, properties/errors windows |
| `src/analysis/{types,filter,duplicates}.rs` | file types and rankings, filters, duplicate finder |
| `src/export.rs`, `src/settings.rs` | CSV/HTML/JSON export, JSON settings |
| `src/scan/mft.rs` | NTFS MFT fast scan |
| `src/ui/{treemap,views}.rs` | squarified layout maths, treemap/chart/types/list views |
| `src/i18n.rs`, `src/dfm.rs` | gettext `.mo` catalogues and `tr()`; Delphi binary DFM reader plus main-form/About specs |
| `src/ui/app/{chrome,dialogs}.rs` | DFM menu/toolbar to command mapping and Delphi shortcuts; Options and About dialogs |
| `src/ui/assets.rs` | `include_bytes!` of `icon_MAINICON.ico` (window icon) and `bitmap_CHEVRON_*_22.bmp` (luminance converted to alpha, tinted) |

## Done (Part A)

- Parallel scan, arena tree, progress counters, Stop (cancel), non-fatal errors (shown from the status bar), links never followed.
- GUI: Scan / Stop / Refresh / Up, path box (Enter scans), drive picker, columns Name, Size, Allocated, % of parent (bar), Files, Folders, Last modified; click headers to sort (default Size desc); chevron expand/collapse; virtualised rows; right-click: Open in Explorer, Copy path, Properties, Exclude.
- 9 unit tests (sizes/counts, cancel, exclude, link loop, background scan, unreadable root, asset decoding).

## Done (Part B)

- Views (toolbar tabs): Tree, Treemap (squarified, `src/ui/treemap.rs`; category colours, hover tooltip, click to drill down, breadcrumb up), Chart (pie + bars of top folders), File types (`src/analysis/types.rs`: count, size, %), Top 100 largest files, Oldest files, Duplicates.
- Filters (`src/analysis/filter.rs`, filter bar behind the "Filters" toggle): name substring or glob, min/max size ("10MB"), modified after/before (YYYY-MM-DD, local), extension list. Applied in `rebuild_rows`; matching files are shown with their ancestors.
- Export (`src/export.rs`, toolbar "Export" menu with a save dialog via `rfd`): CSV (all nodes), self-contained HTML folder table, nested JSON (depth 8 from the UI).
- Duplicate finder (`src/analysis/duplicates.rs`): size, then 64 KiB partial BLAKE3, then full BLAKE3, rayon, cancellable, progress; UI lists groups and wasted space.
- NTFS fast scan (`src/scan/mft.rs`, checkbox "Fast NTFS scan (admin)"): MFT parser and tree builder unit-tested on synthetic records. **Untested on a real volume** (needs elevation); falls back to the walker with a status message when not elevated, not a whole drive, or on any error. Limits: hard links only under their first name; allocated size of resident data = logical size.
- Persistence (`src/settings.rs`): `%APPDATA%/treesize-clone/settings.json` (last path, exclusions, sort, view, language slot, fast-scan flag).
- Timestamps are now shown in local time (chrono).
- 47 unit tests at the end of Part B; 73 now (`cargo test`), `cargo clippy --all-targets` clean.

## Done (Part C)

- **i18n** (`src/i18n.rs`): the 40 gettext `.mo` catalogues extracted from the original program (`assets/rcdata/data_LOCALE_*_DEFAULT.bin`) are embedded with `include_bytes!` and parsed at runtime (GNU MO, both byte orders, plural header reduced to `nplurals`, plural msgids use their first form). `tr(&str)` falls back to the English text. The language is chosen in Options (persisted in `Settings::language`; `"auto"` follows the system: `GetUserDefaultLocaleName` on Windows, `LC_ALL`/`LC_MESSAGES`/`LANG` elsewhere). For CJK, Thai, Indic, Arabic and Hebrew the matching Windows system font is added as an egui fallback at runtime (not embedded; not visually checked).
  - The catalogues are Delphi-style: msgids are `Form.Component.Property<EOT>English` (for example `TMainForm.RefreshAction.Caption<EOT>&Refresh`) or `<resource id><EOT>English`. DFM-driven labels (menus, toolbar, column headers, About) are looked up with their exact context; our own labels are matched by their English text without context and without `&`.
  - Translated by the original catalogue: Name, Size, Allocated, Files, Folders, Last Modified, Attributes, Type, Scan, Options, Export, Properties, Exclude, Drive, Language, Unit, Style, Columns, Show Details, Values in Byte/KB/MB/GB, Automatic Units, Percent, Apply, Clear, Cancel, Open, Version, Dark, Chart, Images/Audio, the whole menu bar, toolbar captions and hints and the DFM column captions.
  - Kept in English (invented by this clone): Open in Explorer, Copy path, Fast NTFS scan, Filters bar placeholders (After, Before, Min, Max, Types), Tree/Treemap/File types/Top 100/Oldest/Duplicates tabs, duplicate finder texts, status words (Scanning, Scan complete, on disk, errors, partial), file categories (Documents, Archives, Code...), Light, Excluded folders, About credits, error and export messages.
  - Some original catalogues are partial: Thai is header-only, Croatian has 39 entries, Lithuanian 83, Serbian 188; missing labels fall back to English.
- **DFM-driven layout** (`src/dfm.rs`): binary `TPF0` reader (Rust mirror of `src/parsers/delphi/dfm-converter.ts`) with object name/class, typed properties (ints, floats, strings, idents, sets, lists, collections, binary), children. It reads `form_TMAINFORM.dfm` at start-up and drives: window caption and default size (`ClientWidth` x `ClientHeight` = 900 x 750, used when no saved geometry), minimum size (the form has none, fallback 640 x 360), the top menu bar (`MainMenu`: File, Scan, View, Expand, Options, Help with their captions and shortcut texts), the toolbar (`MainToolBar`: order, captions, hints, separators, resolved through `ActionManager`), the status bar panels (widths 210/120/100/50) and the tree column header captions (`*ColumnAction` captions). `TJamAboutForm` provides the About box (600 x 448, black, labels at their DFM positions, original product name, copyright and version read from `rt_version/res_1`).
  - Menu and toolbar entries with no equivalent in the clone (print, ribbon-only commands, Professional upsell, update check, treemap options...) are left out; the remaining ones are wired to real commands.
  - The DFM has no column widths for the tree (columns are created in code in the original), so widths remain ours.
- **Options dialog** (menu Options, `src/ui/app/dialogs.rs`): language, units (auto, bytes, KB, MB, GB), percent basis (size or allocated), light/dark theme, allocated column and detail columns, fast NTFS scan default, exclusions editor. Units apply to the tree, status bar, views and the CSV/HTML/JSON exports.
- **Polish**: keyboard shortcuts (F5 refresh, Ctrl+C copy path, Delete exclude, Backspace up, Ctrl+F filters, plus the DFM shortcuts such as Alt+Up, Ctrl+1/2/3/5, Ctrl+N), window size and position remembered, release build without a console window (`windows_subsystem = "windows"`; `--cli` and `--help` re-attach to the parent console with `AttachConsole`).
- **Developer screenshots**: `treesize-clone --screenshot out.png [--view tree|treemap|chart|types|largest|oldest|duplicates] [--lang CODE] [PATH]` scans PATH, renders, saves a PNG through `ViewportCommand::Screenshot` and exits (settings are neither read nor written, English unless `--lang`). Results are in `docs/screenshots/` (`tree.png`: repo root; `treemap.png`: `src/` of the repo; `tree_fr.png`: French catalogue).

## Derived from the extracted assets vs written from scratch

| From the ripper-extracted assets | Written from scratch |
|---|---|
| `icon_MAINICON.ico` (window icon, About icon), `bitmap_CHEVRON_*_22.bmp` (tree chevrons) | scanner, arena tree, MFT parser, duplicate finder, filters, exports |
| `data_LOCALE_*_DEFAULT.bin` (40 gettext catalogues) | the `.mo` reader and the lookup/fallback rules |
| `form_TMAINFORM.dfm` (window, menu, toolbar, status panels, column captions, actions and shortcuts), `form_TJAMABOUTFORM.dfm` (About layout) | the DFM reader, the egui rendering of all of it |
| `rt_version/res_1` (product name, version, copyright shown in About) | treemap, charts, file-type statistics, Options dialog, themes, screenshots mode |

## Limitations

- The NTFS MFT scan is untested on a real volume (unit-tested on synthetic records only).
- The GUI was visually reviewed through the screenshot mode (light theme, English and French); the dark theme, other languages and the CJK/Thai/Indic fallback fonts were not looked at.
- Non-Windows builds compile the same code but were not run (`st_blocks` allocated size, `xdg-open`, `LANG` detection are untested).
- Live partial tree during the scan: not done (the walker builds its tree at the end); only counters are live.
- The two toolbar sort buttons (Name, Size) coexist with the Size/Allocated/Percent/File Count buttons because that is how the original toolbar is laid out; both "Size" buttons sort by size.
- Removing an exclusion in Options applies at the next scan.
- Real shell icons: skipped.
- Known limits: file nodes are kept in memory (large drives use a lot of RAM); chevron "hot" bitmaps are only used for hover colouring.

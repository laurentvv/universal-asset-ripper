# treesize-clone (Rust)

A disk-usage analyzer in 100% Rust that re-creates the look and behaviour of JAM TreeSize Free,
built on assets extracted by Universal Asset Ripper (main icon, chevron bitmaps).

## Run

```bash
cargo run --release -- [PATH]          # GUI (PATH is scanned at startup)
cargo run --release -- --cli PATH -d 3 # headless tree print
cargo run --release -- --screenshot out.png --view treemap PATH   # developer screenshot
cargo run --release -- --screenshot-live live.png PATH  # frame captured ~1 s into the scan
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
- GUI: Scan / Stop / Refresh / Up, path box (Enter scans), drive picker, columns Name, Size, Allocated, % of parent (bar), Files, Folders, Last modified; click headers to sort (default Size desc); chevron expand/collapse; virtualised rows; right-click menu (see Part D).
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
- **Polish**: keyboard shortcuts (F5 refresh, Ctrl+C copy path, Delete sends to the Recycle Bin, Backspace up, Ctrl+F filters, plus the DFM shortcuts such as Alt+Up, Ctrl+1/2/3/5, Ctrl+N), window size and position remembered, release build without a console window (`windows_subsystem = "windows"`; `--cli` and `--help` re-attach to the parent console with `AttachConsole`).
- **Live scan tree** (`src/scan/walker.rs`, `src/ui/app.rs`): directories are registered in a shared arena the moment they are discovered, and a helper thread publishes a consistent snapshot every ~200 ms (backing off to 4x the snapshot cost on huge trees) as `ScanMsg::Partial(Tree)` over a bounded channel with `try_send`, so a busy UI drops snapshots instead of slowing the scan. A snapshot holds directories only plus a bounded `LiveStats` (`Tree::live`): per-directory direct-file aggregates (count, size, allocated), per-extension aggregates and top-100 largest / oldest lists (updated per directory behind floor/ceiling thresholds, so the cost is independent of the file count and no file node is cloned). With them Types, Top 100 files, Oldest files, the "[N Files]" rows and a same-size duplicate-candidate list fill progressively during the scan; the final result still carries the real file nodes and the views switch to exact data. The root row shows live files/folders/size counters from the first frame (patched from the scanner's atomic counters, a one-node placeholder tree is shown at t=0). Unfinished folders are flagged `scanning`; expansion and selection are mapped between snapshots by path (`remap_ids`). Stop keeps what was walked. Limits: the fast NTFS (MFT) scan has no snapshots (blank until done); the treemap only shows folders during a scan (no per-file tiles, no by-type treemap); real duplicate hashing runs after the scan.
- **TreeSize-like tree** (`src/ui/app.rs`, `src/ui/paint.rs`, `src/fmt.rs`): each folder lists its files as one aggregated "[30 Files]" row (catalogue string `[%d Files]`, sorted with the folders, expandable to the individual files, which are the retained file nodes; with an active filter files are listed individually instead). The name column draws the size bar behind "size  name" (top three siblings bold and brighter), "% of parent" is a blue/violet gradient bar, numeric columns are right-aligned with locale thousands separators, headers show a sort arrow, folders and pages are painter glyphs (no emoji). Column widths are resizable and persisted (`col_widths` in the settings). Window default 1200x800, centred.
- **Localised formatting** (`src/fmt.rs`): French uses Octets/Ko/Mo/Go/To with decimal comma, no-break-space grouping and dd/mm/yyyy dates; English uses Bytes/KB/MB/GB; other locales get the Windows short-date pattern (`GetLocaleInfoEx`, converted to a chrono format). One decimal like the original. Status bar: "Free Space: 101 GB (of 930 GB)", file count, errors link with a red badge, "4 096 Bytes per Cluster (NTFS)" (`GetDiskFreeSpaceExW`, `GetDiskFreeSpaceW`, `GetVolumeInformationW`).
- **Theme**: `auto` (default) follows the Windows app theme (`AppsUseLightTheme` read with `RegGetValueW`), plus `dark` and `light` in Options. The dark theme uses #1F1F1F panels, #3C3C3C selection and blue accents.
- **Ribbon** (`src/ui/app/ribbon.rs`): compact tabbed ribbon (File, Home, Scan, View, Options, Help) with big icon buttons and group captions. Tab, group and command names come from the actions of `MAIN_RIBBON` / the DFM catalogue (`TabHomeTitleAction`, `GrpModeTitleAction`, `GrpUnitTitleAction`, `GrpFolderOperationsAction`, `GrpToolsTitleAction`, ...; the UIRibbon markup itself is a binary format whose command strings were read, its layout was not decoded). Icons are vector glyphs drawn with the egui painter; the extracted bitmaps do not contain the ribbon artwork. The File tab holds the full menu bar, so every previous command stays reachable.
- **Developer screenshots**: `treesize-clone --screenshot out.png [--view tree|treemap|chart|types|largest|oldest|duplicates|compare|cleanup|age] [--tab N] [--lang CODE] [PATH]` scans PATH, renders, saves a PNG through `ViewportCommand::Screenshot` and exits (settings are neither read nor written, English unless `--lang`). Results are in `docs/screenshots/` (dark theme, `C:\Windows`: `tree.png` English final, `tree_fr.png` French final, `live_scan.png` French mid-scan, `treemap.png` treemap).

## Done (Part D: beyond the original)

- **Full right-click menu** (tree rows): Open, Open in Explorer, Open in Terminal (`wt`, else `cmd`), Expand / Collapse this branch, Rescan Folder, Count of sub-folders, New folder, Exclude, Copy path, Copy as path (quoted), Rename, Delete (Recycle Bin), in-app Properties and the native Windows Properties dialog (`ShellExecuteExW`). `src/shell.rs` and `src/trash.rs` (`SHFileOperationW` with undo) hold the Win32 calls; Delete and Rename always go through a confirmation / name dialog.
- **Rescan one folder in place** (`Tree::graft`, `ScanHandle` second scan): the subtree is scanned in the background and grafted into the loaded arena, ancestors are re-totalled, selection and expansion are kept. Verified against a full rescan in a unit test.
- **Restart as Administrator** (`ShellExecuteW` "runas" on the current exe and root) from the ribbon; disabled when already elevated.
- **Scan history and "Changes" view** (`src/analysis/snapshot.rs`): every finished scan stores a compact per-directory snapshot (20 per root in `%APPDATA%/treesize-clone/snapshots`). The Changes view ranks folders by absolute size change against the previous scan (grew / shrank / new / deleted); "Compare with snapshot..." and "Save snapshot..." work with any file.
- **Clean-up view** (`src/analysis/insights.rs`): well-known reclaimable folders (node_modules, Cargo `target` only next to a `Cargo.toml`, `__pycache__`, `.gradle`, Windows.old, ...) plus truly empty folders, total reclaimable, confirmed Recycle Bin deletion.
- **File age view**: size and file count per last-modified bucket (30 days ... more than 5 years).
- **Duplicates**: delete a single copy or "keep one copy of each, delete the rest" (shortest path kept), with confirmation; groups update in place.
- **Nested proportional map** (`treemap::nested`): 4 levels, folder captions, aggregated file blocks, level legend like the original "Carte proportionnelle"; click selects, double click drills down, tooltips show path, size and share.
- **Keyboard navigation** in the tree (arrows, Home/End, PageUp/PageDown, Enter, Right/Left to expand/collapse or jump to the parent), drag and drop a folder on the window to scan it, recent paths in the drive picker.
- **CLI**: `--cli PATH [-d N] [--export FILE.csv|json|html] [--changes] [--cleanup]` (export, diff against the previous scan, reclaimable folders) for scripted reports.
- **French wording** for the labels invented by the clone (`src/i18n_fr.rs`, used only when the French catalogue lacks the text).
- **CI**: the Rust crate is now built, linted (`clippy -D warnings`, Windows) and tested on Linux and Windows.
- **Docked proportional map** (default on, like the latest TreeSize Free): under the tree or on the right, follows the selected folder, draggable size, close button; clicking a tile selects it in the tree. Options like the original "Options de graphique": level of detail (1-4 folder levels, legend shows 0-4), show unique files (individual file tiles, 120 largest per folder + a block), hierarchy captions, legend, labels, free-space tile when the map shows a drive root. Layout is pure and tested (`treemap::nested_with`).
- **View/Analyse parity** (checked tab by tab against the real app): TB unit, configurable decimals (0-3), Configure columns menu, Find in tree (Ctrl+F, next/previous, selects and reveals), Clear filter, Hide empty folders, Expanded / Collapse branch.
- **Start page** with one card per drive (file system, usage bar, free/total, computed off-thread) and recent folders; paths pasted with quotes or `%VARS%` are cleaned; a bare `C:` means the drive root; UNC paths work in GUI and CLI.
- **Access denied**: after a scan with refused folders a banner offers Restart as Administrator (the original asks the same question); "Always start as administrator" in Options.
- **Right-click menus** on the tree, the Top 100 / Oldest / Clean-up lists and treemap tiles (Open, Show in tree, Copy path, Windows properties, Delete to the Recycle Bin with confirmation); delete duplicates from the finder.
- **Change history**: baseline picker (any earlier scan) and a size-over-time chart in the Changes view; scan index in `%APPDATA%/treesize-clone/snapshots`.
- Developer flag `--tab N` (0 File ... 5 Help) selects the ribbon tab for screenshots; `docs/screenshots/ribbon_view.png` shows the View tab.
- **Multi-selection** in the tree: Ctrl+click toggles, Shift+click selects a range; the context menu (or Delete) then copies the paths, excludes or sends all selected rows to the Recycle Bin after one confirmation (rows below another selected folder are skipped). Export writes the selected folder.
- **Explorer context menu** entry "Analyze with TreeSize" (folders, folder backgrounds, drives) toggled from Options; written under `HKCU\Software\Classes` only, removed when unticked (`src/shell_ext.rs`, round trip tested against the real registry).
- Measured on this machine: `C:\` (3.75 M files, 655 k folders) scans in about 24 s (peak working set about 1.0 GB after reserving the final arena up front (was 1.25 GB)); long paths beyond MAX_PATH are scanned.

## Derived from the extracted assets vs written from scratch

| From the ripper-extracted assets | Written from scratch |
|---|---|
| `icon_MAINICON.ico` (window icon, About icon), `bitmap_CHEVRON_*_22.bmp` (tree chevrons) | scanner, arena tree, MFT parser, duplicate finder, filters, exports |
| `data_LOCALE_*_DEFAULT.bin` (40 gettext catalogues) | the `.mo` reader and the lookup/fallback rules |
| `form_TMAINFORM.dfm` (window, menu, toolbar, status panels, column captions, actions and shortcuts), `form_TJAMABOUTFORM.dfm` (About layout) | the DFM reader, the egui rendering of all of it |
| `rt_version/res_1` (product name, version, copyright shown in About) | treemap, charts, file-type statistics, Options dialog, themes, screenshots mode |

## Limitations

- The NTFS MFT scan is untested on a real volume (unit-tested on synthetic records only).
- The GUI was visually reviewed through the screenshot mode (light theme, English and French); other languages and the CJK/Thai/Indic fallback fonts were not looked at.
- Non-Windows builds compile the same code but were not run (`st_blocks` allocated size, `xdg-open`, `LANG` detection are untested).
- The two toolbar sort buttons (Name, Size) coexist with the Size/Allocated/Percent/File Count buttons because that is how the original toolbar is laid out; both "Size" buttons sort by size.
- Removing an exclusion in Options applies at the next scan.
- Real shell icons: skipped.
- Known limits: file nodes are kept in memory (large drives use a lot of RAM); chevron "hot" bitmaps are only used for hover colouring.

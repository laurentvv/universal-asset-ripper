mod chrome;
mod dialogs;
mod ribbon;

use self::chrome::{cmd_for, hint_text, pruned, shortcut_text, to_egui_shortcut, Cmd};
use super::assets::{self, Chevrons};
use super::paint::{self, Icon};
use super::views::{self, ListEvent, MenuAct};
use crate::analysis::duplicates::{self, DupGroup};
use crate::analysis::filter::{self, Filter};
use crate::analysis::insights::{self, AgeBucket};
use crate::analysis::snapshot::{self, DirDelta, Snapshot};
use crate::analysis::types::{self, TypeStat};
use crate::dfm::{self, Item};
use crate::export;
use crate::fmt;
use crate::i18n::{self, tr, tr_ctx};
use crate::scan::model::DirectFiles;
use crate::scan::{self, format_bytes, format_time, model::normalize_root, NodeId, ScanHandle, ScanMsg, Tree, NONE};
use crate::settings::{self, SizeMode, Settings, SortKey as SortCol, Theme, Units, ViewKind, WindowGeom};
use eframe::egui::{self, Color32, RichText, Sense, Stroke};
use egui_extras::{Column, TableBuilder};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A line of the tree: a node, or the aggregated "[N Files]" pseudo-row of a folder.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum RowKind {
    Node(NodeId),
    Files(NodeId),
}

#[derive(Clone, Copy)]
struct Row {
    kind: RowKind,
    depth: u16,
    /// One of the three biggest siblings (drawn bold, like the original).
    bold: bool,
    /// Aggregate of a `Files` row.
    files: DirectFiles,
}

/// Sorted children of one folder plus its files aggregate.
#[derive(Default)]
struct Sib {
    order: Vec<RowKind>,
    top: Vec<RowKind>,
    files: DirectFiles,
}

struct Key {
    name: String,
    size: u64,
    alloc: u64,
    files: u64,
    dirs: u64,
    modified: i64,
}

/// "[30 Files]" from the catalogue template (`[%d Files]`).
pub fn files_label_with(template: &str, count: u64) -> String {
    template.replace("%d", &fmt::group_int(count))
}

fn files_label(count: u64) -> String {
    files_label_with(&tr("[%d Files]"), count)
}

fn row_key(tree: &Tree, k: RowKind, files: &DirectFiles) -> Key {
    match k {
        RowKind::Node(id) => {
            let n = tree.get(id);
            Key { name: n.name.to_lowercase(), size: n.size, alloc: n.alloc, files: n.files, dirs: n.dirs, modified: n.modified }
        }
        RowKind::Files(_) => Key { name: files_label(files.count).to_lowercase(), size: files.size, alloc: files.alloc, files: files.count, dirs: 0, modified: files.modified },
    }
}

fn key_cmp(sort: SortCol, desc: bool, a: &Key, b: &Key) -> std::cmp::Ordering {
    let o = match sort {
        SortCol::Name => a.name.cmp(&b.name),
        SortCol::Size | SortCol::Percent => a.size.cmp(&b.size),
        SortCol::Alloc => a.alloc.cmp(&b.alloc),
        SortCol::Files => a.files.cmp(&b.files),
        SortCol::Folders => a.dirs.cmp(&b.dirs),
        SortCol::Modified => a.modified.cmp(&b.modified),
    };
    if desc { o.reverse() } else { o }
}

/// Children of `id` as tree lines: sub-folders, then one aggregated Files line (unless a filter is
/// active, which lists matching files individually).
fn build_sib(tree: &Tree, id: NodeId, filtering: bool, sort: SortCol, desc: bool) -> Sib {
    let files = if filtering { DirectFiles::default() } else { tree.direct_files(id) };
    let mut items: Vec<(RowKind, Key)> = Vec::new();
    for &c in &tree.get(id).children {
        if filtering || tree.get(c).is_dir {
            let k = RowKind::Node(c);
            items.push((k, row_key(tree, k, &files)));
        }
    }
    if !filtering && files.count > 0 {
        let k = RowKind::Files(id);
        items.push((k, row_key(tree, k, &files)));
    }
    let mut by_size: Vec<usize> = (0..items.len()).collect();
    by_size.sort_by_key(|&i| std::cmp::Reverse(items[i].1.size));
    let top = by_size.iter().take(3).filter(|&&i| items[i].1.size > 0).map(|&i| items[i].0).collect();
    items.sort_by(|a, b| key_cmp(sort, desc, &a.1, &b.1));
    Sib { order: items.into_iter().map(|(k, _)| k).collect(), top, files }
}

/// "of" as in "101 GB (of 930 GB)"; the catalogue has no entry for it.
fn of_word() -> String {
    let t = tr("of");
    if t == "of" && fmt::loc() == fmt::Loc::Fr { "sur".into() } else { t }
}

#[derive(Clone, Copy)]
enum NavKey {
    Up,
    Down,
    Left,
    Right,
    Toggle,
    First,
    Last,
    PageUp,
    PageDown,
}

/// Row to select after moving `delta` rows from `cur` (rows without a node are skipped; the move
/// stops at the ends instead of wrapping).
fn nav_target(ids: &[Option<NodeId>], cur: Option<usize>, delta: i32) -> Option<usize> {
    let step = delta.signum();
    let mut i = match cur {
        Some(c) => c as i64,
        None => if step > 0 { -1 } else { ids.len() as i64 },
    };
    let mut remaining = delta.unsigned_abs();
    let mut last_ok = None;
    while remaining > 0 {
        i += step as i64;
        if i < 0 || i >= ids.len() as i64 {
            break;
        }
        if ids[i as usize].is_some() {
            last_ok = Some(i as usize);
            remaining -= 1;
        }
    }
    last_ok
}

/// Scan errors caused by "access denied" (Win32 error 5; the message text itself is localised).
fn access_denied_count(errors: &[scan::ScanError]) -> usize {
    errors.iter().filter(|e| e.message.contains("(os error 5)")).count()
}

fn expandable(tree: &Tree, id: NodeId) -> bool {
    let n = tree.get(id);
    n.is_dir && (!n.children.is_empty() || (tree.live.is_some() && tree.direct_files(id).count > 0))
}

enum Action {
    ToggleFiles(NodeId),
    Toggle(NodeId),
    Select(NodeId),
    OpenExplorer(NodeId),
    CopyPath(NodeId),
    Properties(NodeId),
    Exclude(NodeId),
    Delete(NodeId),
    Rescan(NodeId),
    Reveal(NodeId),
    Open(NodeId),
    Terminal(NodeId),
    ExpandBranch(NodeId),
    CollapseBranch(NodeId),
    CountSubfolders(NodeId),
    Rename(NodeId),
    NewFolder(NodeId),
    ShellProps(NodeId),
    CopyPathQuoted(NodeId),
}

/// Text prompt for Rename / New folder.
struct NameDialog {
    id: NodeId,
    new_folder: bool,
    text: String,
    err: String,
}

/// Result of comparing the current scan with an older snapshot.
struct Comparison {
    /// Where the old snapshot comes from (`last scan` or a file name) and when it was taken.
    label: String,
    taken: i64,
    changes: Vec<DirDelta>,
}

struct Loaded {
    tree: Tree,
    root: PathBuf,
    elapsed: Duration,
    error_list: Vec<scan::ScanError>,
    cancelled: bool,
}

#[derive(Default)]
struct FilterInputs {
    name: String,
    min: String,
    max: String,
    after: String,
    before: String,
    exts: String,
}

struct DupRun {
    rx: crossbeam_channel::Receiver<Option<Vec<DupGroup>>>,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicU64>,
    total: usize,
}

pub struct App {
    settings: Settings,
    saved_settings: Settings,
    settings_path: Option<PathBuf>,
    view: ViewKind,
    filter: Filter,
    filter_in: FilterInputs,
    filter_err: String,
    filter_set: Option<HashSet<NodeId>>,
    show_filters: bool,
    fast_ntfs: bool,
    notice: String,
    view_root: NodeId,
    types_cache: Option<Vec<TypeStat>>,
    largest_cache: Option<Vec<views::RankedRow>>,
    oldest_cache: Option<Vec<views::RankedRow>>,
    cleanup_cache: Option<Vec<views::CleanRow>>,
    age_cache: Option<Vec<AgeBucket>>,
    dup_run: Option<DupRun>,
    dup_result: Option<Vec<DupGroup>>,
    dup_min: String,
    path_text: String,
    drives: Vec<String>,
    /// Space usage of each drive for the start page, filled by a background thread.
    drive_infos: Vec<(String, scan::DiskInfo)>,
    drive_rx: Option<std::sync::mpsc::Receiver<Vec<(String, scan::DiskInfo)>>>,
    handle: Option<ScanHandle>,
    /// A live snapshot of the running scan has been shown (ids are then remapped by path).
    partial_seen: bool,
    scan_started: Instant,
    scan_root: PathBuf,
    /// Used bytes of the drive being scanned (progress estimate); `None` = indeterminate bar.
    scan_total: Option<u64>,
    loaded: Option<Loaded>,
    excludes: Vec<PathBuf>,
    expanded: HashSet<NodeId>,
    sort: SortCol,
    desc: bool,
    sorted: HashMap<NodeId, Sib>,
    files_expanded: HashSet<NodeId>,
    rows: Vec<Row>,
    ribbon_tab: usize,
    disk: Option<scan::DiskInfo>,
    system_dark: bool,
    sys_checked: Instant,
    col_live: Vec<(SortCol, f32)>,
    col_changed: Instant,
    rows_dirty: bool,
    selected: Option<NodeId>,
    props: Option<NodeId>,
    confirm_delete: Option<NodeId>,
    name_dialog: Option<NameDialog>,
    /// Files waiting for confirmation before going to the Recycle Bin (duplicate clean-up).
    confirm_files: Option<Vec<(PathBuf, u64)>>,
    comparison: Option<Comparison>,
    size_history: Vec<snapshot::HistoryPoint>,
    /// Number of folders refused with "access denied" in the last scan (offers an elevated restart).
    admin_hint: Option<usize>,
    scroll_to: Option<usize>,
    /// Node to scroll to once the tree rows have been rebuilt ("Show in tree").
    reveal: Option<NodeId>,
    compare_notice: String,
    /// Background re-scan of one folder: its name path (stable across tree edits) and the scan.
    sub_scan: Option<(Vec<String>, ScanHandle)>,
    delete_error: Option<String>,
    show_errors: bool,
    chevrons: Option<Chevrons>,
    status: String,
    menu_items: Vec<Item>,
    toolbar_items: Vec<Item>,
    shortcuts: Vec<(egui::KeyboardShortcut, Cmd)>,
    show_options: bool,
    show_about: bool,
    about_icon: Option<egui::TextureHandle>,
    exclude_input: String,
    lang_applied: String,
    dark_applied: Option<bool>,
    persist_enabled: bool,
    win_geom: Option<WindowGeom>,
    win_changed: Instant,
    shot: Option<ShotState>,
}

/// State of the `--screenshot` developer mode.
struct ShotState {
    file: PathBuf,
    settle: u32,
    requested: bool,
    prepared: bool,
    started: Instant,
    /// `--screenshot-live`: capture mid-scan instead of waiting for the end.
    live: bool,
}

/// Command-line options of the GUI.
#[derive(Debug, Default, PartialEq)]
pub struct RunOptions {
    pub start: Option<PathBuf>,
    pub screenshot: Option<PathBuf>,
    /// With `screenshot`: capture about a second into the scan instead of after it.
    pub live: bool,
    pub view: Option<ViewKind>,
    pub lang: Option<String>,
}

pub fn parse_view(name: &str) -> Option<ViewKind> {
    Some(match name.to_ascii_lowercase().as_str() {
        "tree" => ViewKind::Tree,
        "treemap" => ViewKind::Treemap,
        "chart" => ViewKind::Chart,
        "types" => ViewKind::Types,
        "largest" => ViewKind::Largest,
        "oldest" => ViewKind::Oldest,
        "duplicates" => ViewKind::Duplicates,
        "compare" => ViewKind::Compare,
        "cleanup" => ViewKind::Cleanup,
        "age" => ViewKind::Age,
        _ => return None,
    })
}

/// Parse `[PATH] [--screenshot FILE] [--view NAME] [--lang CODE]`.
pub fn parse_args(args: &[String]) -> Result<RunOptions, String> {
    let mut o = RunOptions::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--screenshot" => o.screenshot = Some(PathBuf::from(it.next().ok_or("--screenshot needs a file")?)),
            "--screenshot-live" => {
                o.screenshot = Some(PathBuf::from(it.next().ok_or("--screenshot-live needs a file")?));
                o.live = true;
            }
            "--view" => {
                let v = it.next().ok_or("--view needs a name")?;
                o.view = Some(parse_view(v).ok_or_else(|| format!("unknown view '{v}'"))?);
            }
            "--lang" => o.lang = Some(it.next().ok_or("--lang needs a code")?.clone()),
            s if s.starts_with('-') => return Err(format!("unknown option '{s}'")),
            s => o.start = Some(PathBuf::from(s)),
        }
    }
    Ok(o)
}

/// Saved window geometry only if it is plausible (not minimised at -32000, not absurdly big).
pub fn sanitize_geom(g: WindowGeom, min: (f32, f32)) -> Option<WindowGeom> {
    if !(g.w.is_finite() && g.h.is_finite()) || g.w < min.0 || g.h < min.1 || g.w > 10000.0 || g.h > 10000.0 {
        return None;
    }
    let ok = |v: Option<f32>| v.is_none_or(|v| v.is_finite() && (-200.0..=10000.0).contains(&v));
    if !ok(g.x) || !ok(g.y) {
        return Some(WindowGeom { x: None, y: None, ..g });
    }
    Some(g)
}

/// Dirs (with children) shown by "Expand to level N" (`None` = fully expanded).
pub fn expand_levels(tree: &Tree, levels: Option<u32>) -> HashSet<NodeId> {
    let mut out = HashSet::new();
    if tree.nodes.is_empty() {
        return out;
    }
    let mut stack = vec![(Tree::ROOT, 0u32)];
    while let Some((id, d)) = stack.pop() {
        let n = tree.get(id);
        if !n.is_dir || n.children.is_empty() || levels.is_some_and(|l| d >= l) {
            continue;
        }
        out.insert(id);
        stack.extend(n.children.iter().map(|&c| (c, d + 1)));
    }
    out
}

fn save_png(img: &egui::ColorImage, path: &std::path::Path) -> Result<(), String> {
    let rgba: Vec<u8> = img.pixels.iter().flat_map(|p| p.to_array()).collect();
    let buf = image::RgbaImage::from_raw(img.size[0] as u32, img.size[1] as u32, rgba).ok_or("bad image size")?;
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    buf.save_with_format(path, image::ImageFormat::Png).map_err(|e| e.to_string())
}

/// Dark theme close to the original: dark grey rows (#1F1F1F), #3C3C3C selection, blue accents.
fn visuals_for(dark: bool) -> egui::Visuals {
    if !dark {
        return egui::Visuals::light();
    }
    let mut v = egui::Visuals::dark();
    v.panel_fill = Color32::from_rgb(31, 31, 31);
    v.window_fill = Color32::from_rgb(37, 37, 38);
    v.extreme_bg_color = Color32::from_rgb(22, 22, 22);
    v.faint_bg_color = Color32::from_rgb(36, 36, 36);
    v.selection.bg_fill = Color32::from_rgb(60, 60, 60);
    v.selection.stroke = Stroke::new(1.0, Color32::from_rgb(230, 230, 230));
    v.hyperlink_color = Color32::from_rgb(85, 160, 255);
    v.widgets.hovered.weak_bg_fill = Color32::from_rgb(52, 52, 56);
    v
}

fn list_drives() -> Vec<String> {
    if cfg!(windows) {
        ('A'..='Z')
            .map(|c| format!("{c}:\\"))
            .filter(|d| std::path::Path::new(d).exists())
            .collect()
    } else {
        vec!["/".to_string()]
    }
}

pub fn run(opts: RunOptions) -> eframe::Result<()> {
    let spec = dfm::main_spec();
    let shot_mode = opts.screenshot.is_some();
    let st = if shot_mode {
        Settings::default()
    } else {
        settings::default_path().as_deref().map(settings::load_from).unwrap_or_default()
    };
    let geom = st.window.and_then(|g| sanitize_geom(g, (spec.min_w, spec.min_h))).filter(|_| !shot_mode);
    // Default window: 1200x800, centred; a saved geometry wins.
    let (w, h) = match geom {
        Some(g) => (g.w, g.h),
        None => (1200.0, 800.0),
    };
    let mut vp = egui::ViewportBuilder::default()
        .with_inner_size([w, h])
        .with_min_inner_size([spec.min_w, spec.min_h])
        .with_title(format!("{} - Rust clone", spec.caption));
    if let Some(WindowGeom { x: Some(x), y: Some(y), .. }) = geom {
        vp = vp.with_position([x, y]);
    }
    if let Some(icon) = assets::window_icon() {
        vp = vp.with_icon(std::sync::Arc::new(icon));
    }
    let options = eframe::NativeOptions { viewport: vp, centered: geom.is_none(), ..Default::default() };
    eframe::run_native(
        "treesize-clone",
        options,
        Box::new(move |cc| {
            let mut app = App::new(&cc.egui_ctx, st, &opts);
            if let Some(p) = &opts.start {
                let cleaned = PathBuf::from(scan::model::clean_path_input(&p.to_string_lossy()));
                let cleaned = scan::model::normalize_root(&cleaned);
                let abs = std::path::absolute(&cleaned).unwrap_or(cleaned);
                app.path_text = abs.to_string_lossy().into_owned();
                app.start_scan();
            }
            Ok(Box::new(app))
        }),
    )
}

fn collect_shortcuts(items: &[Item], out: &mut Vec<(egui::KeyboardShortcut, Cmd)>) {
    let spec = dfm::main_spec();
    for it in items {
        if let (Some(c), Some(a)) = (cmd_for(it), it.action.as_ref().and_then(|a| spec.actions.get(a))) {
            if let Some(sc) = to_egui_shortcut(a.shortcut) {
                if !out.iter().any(|(s, _)| *s == sc) {
                    out.push((sc, c));
                }
            }
        }
        collect_shortcuts(&it.children, out);
    }
}

impl App {
    fn new(ctx: &egui::Context, st: Settings, opts: &RunOptions) -> Self {
        let drives = list_drives();
        let drive_rx = {
            let (tx, rx) = std::sync::mpsc::channel();
            let list = drives.clone();
            std::thread::spawn(move || {
                // Slow or disconnected volumes must not freeze the UI: this runs off-thread.
                let _ = tx.send(list.into_iter().filter_map(|d| scan::disk_info(std::path::Path::new(&d)).map(|i| (d, i))).collect());
            });
            Some(rx)
        };
        let first = drives.first().cloned().unwrap_or_default();
        let settings_path = if opts.screenshot.is_some() { None } else { settings::default_path() };
        let spec = dfm::main_spec();
        let menu_items = pruned(&spec.menu);
        let toolbar_items = pruned(&spec.toolbar);
        let mut shortcuts = Vec::new();
        collect_shortcuts(&menu_items, &mut shortcuts);
        collect_shortcuts(&toolbar_items, &mut shortcuts);
        let mut st = st;
        if let Some(l) = &opts.lang {
            st.language = l.clone();
        } else if opts.screenshot.is_some() {
            // Reproducible screenshots: English unless --lang is given.
            st.language = "en".into();
        }
        let eff = i18n::set_language(&i18n::resolve_language(&st.language));
        assets::install_language_fonts(ctx, &eff);
        fmt::set_locale(&eff);
        scan::set_units(st.units);
        let system_dark = settings::system_dark();
        let dark = st.theme.is_dark(system_dark);
        ctx.set_visuals(visuals_for(dark));
        let view = opts.view.unwrap_or(st.view);
        Self {
            path_text: if st.last_path.is_empty() { first } else { st.last_path.clone() },
            view,
            fast_ntfs: st.fast_ntfs,
            sort: st.sort,
            desc: st.sort_desc,
            excludes: st.excludes.iter().map(PathBuf::from).collect(),
            saved_settings: st.clone(),
            lang_applied: st.language.clone(),
            dark_applied: Some(dark),
            chevrons: Chevrons::load(ctx, dark),
            system_dark,
            sys_checked: Instant::now(),
            col_live: Vec::new(),
            col_changed: Instant::now(),
            files_expanded: HashSet::new(),
            ribbon_tab: 1,
            disk: None,
            settings: st,
            settings_path,
            filter: Filter::default(),
            filter_in: FilterInputs::default(),
            filter_err: String::new(),
            filter_set: None,
            show_filters: false,
            notice: String::new(),
            view_root: Tree::ROOT,
            types_cache: None,
            largest_cache: None,
            oldest_cache: None,
            cleanup_cache: None,
            age_cache: None,
            dup_run: None,
            dup_result: None,
            dup_min: "64KB".into(),
            drives,
            drive_infos: Vec::new(),
            drive_rx,
            handle: None,
            partial_seen: false,
            scan_started: Instant::now(),
            scan_root: PathBuf::new(),
            scan_total: None,
            loaded: None,
            expanded: HashSet::new(),
            sorted: HashMap::new(),
            rows: Vec::new(),
            rows_dirty: true,
            selected: None,
            props: None,
            confirm_delete: None,
            name_dialog: None,
            confirm_files: None,
            comparison: None,
            size_history: Vec::new(),
            admin_hint: None,
            scroll_to: None,
            reveal: None,
            compare_notice: String::new(),
            sub_scan: None,
            delete_error: None,
            show_errors: false,
            status: tr("Ready"),
            menu_items,
            toolbar_items,
            shortcuts,
            show_options: false,
            show_about: false,
            about_icon: None,
            exclude_input: String::new(),
            persist_enabled: opts.screenshot.is_none(),
            win_geom: None,
            win_changed: Instant::now(),
            shot: opts.screenshot.as_ref().map(|f| ShotState {
                file: f.clone(),
                settle: 0,
                requested: false,
                prepared: false,
                started: Instant::now(),
                live: opts.live,
            }),
        }
    }

    fn start_scan(&mut self) {
        if let Some(h) = &self.handle {
            h.cancel();
        }
        let root = normalize_root(std::path::Path::new(&scan::model::clean_path_input(&self.path_text)));
        self.status = format!("{} {} ...", tr("Scanning"), root.display());
        self.notice.clear();
        self.settings.last_path = root.to_string_lossy().into_owned();
        settings::push_recent(&mut self.settings.recent, &self.settings.last_path.clone(), 10);
        self.partial_seen = false;
        self.admin_hint = None;
        self.scan_started = Instant::now();
        self.scan_total = scan::drive_used_bytes(&root);
        self.scan_root = root.clone();
        self.disk = scan::disk_info(&root);
        // Show the root row (with live counters) from the very first frame.
        self.expanded.clear();
        self.expanded.insert(Tree::ROOT);
        self.files_expanded.clear();
        self.selected = None;
        self.props = None;
        self.view_root = Tree::ROOT;
        self.loaded = Some(Loaded {
            tree: Tree::placeholder(&root.to_string_lossy()),
            root: root.clone(),
            elapsed: Duration::ZERO,
            error_list: Vec::new(),
            cancelled: false,
        });
        self.invalidate();
        self.handle = Some(scan::spawn_scan_opts(root, self.excludes.clone(), self.fast_ntfs));
    }

    /// Rescan one folder in the background and graft the result into the loaded tree.
    fn start_sub_scan(&mut self, id: NodeId) {
        let Some(l) = &self.loaded else { return };
        if self.handle.is_some() || self.sub_scan.is_some() || !l.tree.get(id).is_dir {
            return;
        }
        if id == Tree::ROOT {
            self.path_text = l.root.to_string_lossy().into_owned();
            self.start_scan();
            return;
        }
        let names: Vec<String> = l.tree.name_path(id).into_iter().map(str::to_string).collect();
        let path = l.tree.path_of(id);
        self.status = format!("{} {} ...", tr("Scanning"), path.display());
        self.sub_scan = Some((names, scan::spawn_scan_opts(path, self.excludes.clone(), false)));
    }

    fn poll_sub_scan(&mut self) {
        let mut done = None;
        if let Some((_, h)) = &self.sub_scan {
            while let Ok(msg) = h.rx.try_recv() {
                if let ScanMsg::Done(res) = msg {
                    done = Some(*res);
                }
            }
        }
        let Some(res) = done else { return };
        let Some((names, _)) = self.sub_scan.take() else { return };
        self.status = if res.cancelled { tr("Scan cancelled") } else { tr("Scan complete") };
        if res.cancelled {
            return;
        }
        let Some(l) = &mut self.loaded else { return };
        let to_ids = |t: &Tree, p: &[String]| t.resolve_path(&p.iter().map(String::as_str).collect::<Vec<_>>());
        let to_names = |t: &Tree, id: NodeId| -> Vec<String> { t.name_path(id).into_iter().map(str::to_string).collect() };
        let Some(old) = to_ids(&l.tree, &names) else { return };
        let sel = self.selected.map(|s| to_names(&l.tree, s));
        let vroot = to_names(&l.tree, self.view_root);
        let exp: Vec<Vec<String>> = self.expanded.iter().filter(|&&e| (e as usize) < l.tree.nodes.len()).map(|&e| to_names(&l.tree, e)).collect();
        if l.tree.graft(old, res.tree).is_none() {
            return;
        }
        l.error_list.extend(res.errors);
        self.selected = sel.and_then(|p| to_ids(&l.tree, &p));
        self.view_root = to_ids(&l.tree, &vroot).unwrap_or(Tree::ROOT);
        self.expanded = exp.iter().filter_map(|p| to_ids(&l.tree, p)).collect();
        self.expanded.insert(Tree::ROOT);
        self.props = None;
        self.invalidate();
    }

    /// Move expansion / selection from the tree currently shown to `new` (ids are rebuilt by every
    /// snapshot, so they are mapped by path).
    fn carry_state(&mut self, new: &Tree) {
        let Some(old) = self.loaded.as_ref().map(|l| &l.tree) else { return };
        let map_one = |id: Option<NodeId>| id.filter(|&i| (i as usize) < old.nodes.len()).and_then(|i| new.resolve_path(&old.name_path(i)));
        self.expanded = scan::model::remap_ids(old, new, &self.expanded);
        self.expanded.insert(Tree::ROOT);
        let (sel, props, vroot) = (map_one(self.selected), map_one(self.props), map_one(Some(self.view_root)));
        self.selected = sel;
        self.props = props;
        self.view_root = vroot.unwrap_or(Tree::ROOT);
    }

    /// Show a live snapshot of the running scan in the normal views.
    fn apply_partial(&mut self, tree: Tree) {
        if self.partial_seen {
            self.carry_state(&tree);
        } else {
            self.partial_seen = true;
            self.expanded.clear();
            self.expanded.insert(Tree::ROOT);
            self.selected = None;
            self.props = None;
            self.view_root = Tree::ROOT;
            self.dup_result = None;
        }
        self.invalidate();
        self.loaded = Some(Loaded {
            tree,
            root: self.scan_root.clone(),
            elapsed: self.scan_started.elapsed(),
            error_list: Vec::new(),
            cancelled: false,
        });
    }

    fn poll_scan(&mut self) {
        let mut latest: Option<Tree> = None;
        while let Some(msg) = self.handle.as_ref().and_then(|h| h.rx.try_recv().ok()) {
            let res = match msg {
                ScanMsg::Notice(m) => {
                    self.notice = m;
                    continue;
                }
                ScanMsg::Partial(t) => {
                    latest = Some(t);
                    continue;
                }
                ScanMsg::Done(res) => *res,
            };
            self.handle = None;
            latest = None;
            if self.partial_seen {
                self.carry_state(&res.tree);
            } else {
                self.expanded.clear();
                self.expanded.insert(Tree::ROOT);
                self.selected = None;
                self.props = None;
                self.view_root = Tree::ROOT;
            }
            self.partial_seen = false;
            self.invalidate();
            self.dup_result = None;
            self.status = if res.cancelled { tr("Scan cancelled") } else { tr("Scan complete") };
            let denied = access_denied_count(&res.errors);
            self.admin_hint = (denied > 0 && cfg!(windows) && !scan::mft::is_elevated() && self.shot.is_none()).then_some(denied);
            self.loaded = Some(Loaded {
                tree: res.tree,
                root: res.root,
                elapsed: res.elapsed,
                error_list: res.errors,
                cancelled: res.cancelled,
            });
            self.on_scan_complete();
        }
        if let Some(t) = latest {
            self.apply_partial(t);
        }
        self.patch_live_counters();
    }

    /// After a finished scan: compare with the newest stored snapshot of this root, then store the
    /// new one (history is capped at 20 files per root).
    fn on_scan_complete(&mut self) {
        let Some(l) = &self.loaded else { return };
        if l.cancelled || !self.persist_enabled {
            return;
        }
        let Some(dir) = snapshot::history_dir() else { return };
        self.comparison = snapshot::record_and_compare(&dir, &l.tree, chrono::Utc::now().timestamp())
            .map(|(taken, changes)| Comparison { label: tr("last scan"), taken, changes });
        self.size_history = snapshot::history_points(&dir, &l.tree.get(Tree::ROOT).name);
    }

    fn save_snapshot_dialog(&mut self) {
        let Some(l) = &self.loaded else { return };
        let root = l.tree.get(Tree::ROOT).name.clone();
        let snap = Snapshot::from_tree(&l.tree, chrono::Utc::now().timestamp());
        let mut dlg = rfd::FileDialog::new().add_filter("Snapshot", &["json"]).set_file_name("snapshot.json");
        if let Some(d) = snapshot::history_dir() {
            let _ = std::fs::create_dir_all(&d);
            dlg = dlg.set_directory(d);
        }
        if let Some(p) = dlg.save_file() {
            self.compare_notice = match snap.save(&p) {
                Ok(()) => format!("{}: {} ({root})", tr("Snapshot saved"), p.display()),
                Err(e) => e,
            };
        }
    }

    fn compare_snapshot_dialog(&mut self) {
        let Some(l) = &self.loaded else { return };
        let mut dlg = rfd::FileDialog::new().add_filter("Snapshot", &["json"]);
        if let Some(d) = snapshot::history_dir() {
            dlg = dlg.set_directory(d);
        }
        let Some(p) = dlg.pick_file() else { return };
        match Snapshot::load(&p) {
            Ok(old) => {
                let new = Snapshot::from_tree(&l.tree, chrono::Utc::now().timestamp());
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                self.comparison = Some(Comparison { label: name, taken: old.taken, changes: snapshot::diff(&old, &new) });
                self.compare_notice.clear();
                self.view = ViewKind::Compare;
            }
            Err(e) => self.compare_notice = format!("{}: {e}", p.display()),
        }
    }

    /// While scanning, the root row shows the scanner's own counters when they are ahead of the
    /// last snapshot (the real TreeSize shows files and folders counting up from the first second).
    fn patch_live_counters(&mut self) {
        let (Some(h), Some(l)) = (&self.handle, &mut self.loaded) else { return };
        if let Some(r) = l.tree.nodes.first_mut() {
            r.files = r.files.max(h.progress.files.load(Ordering::Relaxed));
            r.dirs = r.dirs.max(h.progress.dirs.load(Ordering::Relaxed).saturating_sub(1));
            r.size = r.size.max(h.progress.bytes.load(Ordering::Relaxed));
            l.elapsed = self.scan_started.elapsed();
        }
    }

    /// Drop every cache derived from the tree (after a scan or a structural change).
    fn invalidate(&mut self) {
        self.sorted.clear();
        self.rows_dirty = true;
        self.filter_set = None;
        self.types_cache = None;
        self.largest_cache = None;
        self.oldest_cache = None;
        self.cleanup_cache = None;
        self.age_cache = None;
    }

    fn rebuild_rows(&mut self) {
        self.rows.clear();
        let Some(loaded) = self.loaded.take() else { return };
        let tree = &loaded.tree;
        if !self.filter.is_empty() && self.filter_set.is_none() {
            self.filter_set = Some(filter::matching_set(tree, &self.filter));
        } else if self.filter.is_empty() {
            self.filter_set = None;
        }
        let fset = self.filter_set.as_ref();
        let filtering = fset.is_some();
        let (sort, desc) = (self.sort, self.desc);
        if !tree.nodes.is_empty() {
            let mut stack = vec![Row { kind: RowKind::Node(Tree::ROOT), depth: 0, bold: false, files: DirectFiles::default() }];
            while let Some(row) = stack.pop() {
                self.rows.push(row);
                match row.kind {
                    RowKind::Node(id) => {
                        if !(tree.get(id).is_dir && (filtering || self.expanded.contains(&id))) {
                            continue;
                        }
                        let sib = self.sorted.entry(id).or_insert_with(|| build_sib(tree, id, filtering, sort, desc));
                        for &c in sib.order.iter().rev() {
                            let (keep, files) = match c {
                                RowKind::Node(x) => (fset.is_none_or(|s| s.contains(&x)), DirectFiles::default()),
                                RowKind::Files(_) => (true, sib.files),
                            };
                            if keep {
                                stack.push(Row { kind: c, depth: row.depth + 1, bold: sib.top.contains(&c), files });
                            }
                        }
                    }
                    RowKind::Files(dir) => {
                        if tree.has_file_nodes() && self.files_expanded.contains(&dir) {
                            let mut items: Vec<(NodeId, Key)> = tree
                                .get(dir)
                                .children
                                .iter()
                                .copied()
                                .filter(|&c| !tree.get(c).is_dir)
                                .map(|c| (c, row_key(tree, RowKind::Node(c), &DirectFiles::default())))
                                .collect();
                            items.sort_by(|a, b| key_cmp(sort, desc, &a.1, &b.1));
                            for (c, _) in items.into_iter().rev() {
                                stack.push(Row { kind: RowKind::Node(c), depth: row.depth + 1, bold: false, files: DirectFiles::default() });
                            }
                        }
                    }
                }
            }
        }
        self.loaded = Some(loaded);
        self.rows_dirty = false;
    }

    fn set_sort(&mut self, col: SortCol) {
        if self.sort == col {
            self.desc = !self.desc;
        } else {
            self.sort = col;
            self.desc = col != SortCol::Name;
        }
        self.sorted.clear();
        self.rows_dirty = true;
    }

    fn apply(&mut self, ctx: &egui::Context, actions: Vec<Action>) {
        for a in actions {
            match a {
                Action::ToggleFiles(id) => {
                    if !self.files_expanded.remove(&id) {
                        self.files_expanded.insert(id);
                    }
                    self.rows_dirty = true;
                }
                Action::Toggle(id) => {
                    if !self.expanded.remove(&id) {
                        self.expanded.insert(id);
                    }
                    self.rows_dirty = true;
                }
                Action::Select(id) => self.selected = Some(id),
                Action::Properties(id) => self.props = Some(id),
                Action::CopyPath(id) => {
                    if let Some(l) = &self.loaded {
                        ctx.copy_text(l.tree.path_of(id).to_string_lossy().into_owned());
                    }
                }
                Action::OpenExplorer(id) => {
                    if let Some(l) = &self.loaded {
                        open_in_explorer(&l.tree.path_of(id));
                    }
                }
                Action::Delete(id) => self.confirm_delete = Some(id),
                Action::Rescan(id) => self.start_sub_scan(id),
                Action::Reveal(id) => self.reveal_in_tree(id),
                Action::Open(id) => {
                    if let Some(l) = &self.loaded {
                        crate::shell::open(&l.tree.path_of(id));
                    }
                }
                Action::Terminal(id) => {
                    if let Some(l) = &self.loaded {
                        let p = l.tree.path_of(id);
                        crate::shell::open_terminal(if l.tree.get(id).is_dir { &p } else { p.parent().unwrap_or(&p) });
                    }
                }
                Action::ShellProps(id) => {
                    if let Some(l) = &self.loaded {
                        crate::shell::properties(&l.tree.path_of(id));
                    }
                }
                Action::CopyPathQuoted(id) => {
                    if let Some(l) = &self.loaded {
                        ctx.copy_text(format!("\"{}\"", l.tree.path_of(id).display()));
                    }
                }
                Action::ExpandBranch(id) | Action::CollapseBranch(id) => {
                    if let Some(l) = &self.loaded {
                        let expand = matches!(a, Action::ExpandBranch(_));
                        let mut stack = vec![id];
                        while let Some(cur) = stack.pop() {
                            let n = l.tree.get(cur);
                            if !n.is_dir {
                                continue;
                            }
                            if expand && !n.children.is_empty() {
                                self.expanded.insert(cur);
                            } else if !expand && cur != Tree::ROOT {
                                self.expanded.remove(&cur);
                            }
                            stack.extend(n.children.iter().copied());
                        }
                        self.rows_dirty = true;
                    }
                }
                Action::CountSubfolders(id) => {
                    if let Some(l) = &self.loaded {
                        let n = l.tree.get(id);
                        self.notice = format!("{}: {} {}, {} {}", n.name, fmt::group_int(n.dirs), tr("Folders"), fmt::group_int(n.files), tr("Files"));
                    }
                }
                Action::Rename(id) => {
                    if let Some(l) = &self.loaded {
                        self.name_dialog = Some(NameDialog { id, new_folder: false, text: l.tree.get(id).name.clone(), err: String::new() });
                    }
                }
                Action::NewFolder(id) => self.name_dialog = Some(NameDialog { id, new_folder: true, text: String::new(), err: String::new() }),
                Action::Exclude(id) => {
                    if let Some(l) = &mut self.loaded {
                        self.excludes.push(l.tree.path_of(id));
                        l.tree.remove_subtree(id);
                        self.selected = None;
                        self.view_root = Tree::ROOT;
                        self.invalidate();
                    }
                }
            }
        }
    }

    fn item_label(item: &Item) -> String {
        let by_name = tr_ctx(&format!("TMainForm.{}.Caption", item.name), &item.caption);
        if by_name != i18n::strip_accel(&item.caption) {
            return by_name;
        }
        match &item.action {
            Some(a) => tr_ctx(&format!("TMainForm.{a}.Caption"), &item.caption),
            None => by_name,
        }
    }

    fn item_hint(item: &Item) -> String {
        if item.hint.is_empty() {
            return String::new();
        }
        let ctx = format!("TMainForm.{}.Hint", item.action.as_deref().unwrap_or(&item.name));
        hint_text(&tr_ctx(&ctx, &item.hint)).to_string()
    }

    fn cmd_enabled(&self, cmd: Cmd) -> bool {
        let scanning = self.handle.is_some();
        let loaded = self.loaded.is_some();
        match cmd {
            Cmd::Stop => scanning,
            Cmd::Refresh | Cmd::ParentFolder | Cmd::ScanDir => !scanning,
            Cmd::RescanSelected => {
                let is_dir = |s: NodeId| self.loaded.as_ref().is_some_and(|l| l.tree.get(s).is_dir && !l.tree.get(s).is_link);
                !scanning && self.sub_scan.is_none() && self.selected.is_some_and(is_dir)
            }
            Cmd::RestartAdmin => cfg!(windows) && !scan::mft::is_elevated(),
            Cmd::NewFolder => loaded && !scanning && self.sub_scan.is_none(),
            Cmd::SnapshotSave | Cmd::SnapshotCompare => loaded && !scanning,
            Cmd::OpenLocation | Cmd::ExpandLevel(_) | Cmd::ExpandFull => loaded,
            Cmd::ExcludeSelected => self.selected.is_some_and(|s| s != Tree::ROOT) && loaded,
            _ => true,
        }
    }

    fn cmd_checked(&self, cmd: Cmd) -> bool {
        match cmd {
            Cmd::SortBy(k) => self.sort == k,
            Cmd::SetUnits(u) => self.settings.units == u,
            Cmd::ToggleDetails => self.settings.details,
            Cmd::Filter => self.show_filters,
            Cmd::SetView(v) => self.view == v,
            Cmd::ToggleFast => self.fast_ntfs,
            _ => false,
        }
    }

    fn run_cmd(&mut self, ctx: &egui::Context, cmd: Cmd) {
        match cmd {
            Cmd::ParentFolder => {
                if matches!(self.view, ViewKind::Treemap | ViewKind::Chart) && self.view_root != Tree::ROOT {
                    if let Some(l) = &self.loaded {
                        let p = l.tree.get(self.view_root).parent;
                        self.view_root = if p == NONE { Tree::ROOT } else { p };
                        return;
                    }
                }
                if self.handle.is_none() {
                    let cur = PathBuf::from(self.path_text.trim());
                    if let Some(parent) = cur.parent().filter(|p| !p.as_os_str().is_empty()) {
                        self.path_text = parent.to_string_lossy().into_owned();
                        self.start_scan();
                    }
                }
            }
            Cmd::ScanDir => {
                if let Some(dir) = rfd::FileDialog::new().pick_folder() {
                    self.path_text = dir.to_string_lossy().into_owned();
                    self.start_scan();
                }
            }
            Cmd::Stop => {
                if let Some(h) = &self.handle {
                    h.cancel();
                }
            }
            Cmd::Refresh => {
                if self.handle.is_none() {
                    if let Some(l) = &self.loaded {
                        self.path_text = l.root.to_string_lossy().into_owned();
                    }
                    self.start_scan();
                }
            }
            Cmd::OpenLocation => {
                if let Some(l) = &self.loaded {
                    open_in_explorer(&l.tree.path_of(self.selected.unwrap_or(Tree::ROOT)));
                }
            }
            Cmd::SortBy(k) => self.set_sort(k),
            Cmd::SetUnits(u) => self.settings.units = u,
            Cmd::ToggleDetails => self.settings.details = !self.settings.details,
            Cmd::Exit => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            Cmd::NewInstance => {
                if let Ok(exe) = std::env::current_exe() {
                    let _ = std::process::Command::new(exe).spawn();
                }
            }
            Cmd::NewFolder => {
                let target = self.selected.filter(|&s| self.loaded.as_ref().is_some_and(|l| l.tree.get(s).is_dir)).unwrap_or(Tree::ROOT);
                self.apply(ctx, vec![Action::NewFolder(target)]);
            }
            Cmd::SnapshotSave => self.save_snapshot_dialog(),
            Cmd::SnapshotCompare => self.compare_snapshot_dialog(),
            Cmd::RescanSelected => {
                if let Some(id) = self.selected {
                    self.apply(ctx, vec![Action::Rescan(id)]);
                }
            }
            Cmd::RestartAdmin => {
                let path = self.loaded.as_ref().map(|l| l.root.clone()).unwrap_or_else(|| PathBuf::from(self.path_text.trim()));
                if restart_as_admin(&path) {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                } else {
                    self.notice = tr("Administrator restart was cancelled or failed");
                }
            }
            Cmd::Filter => self.show_filters = !self.show_filters,
            Cmd::SetView(v) => self.view = v,
            Cmd::ToggleFast => self.fast_ntfs = !self.fast_ntfs,
            Cmd::Options => self.show_options = true,
            Cmd::About => self.show_about = true,
            Cmd::ExpandLevel(n) => self.expand_to(Some(n as u32)),
            Cmd::ExpandFull => self.expand_to(None),
            Cmd::ExcludeSelected => {
                if let Some(id) = self.selected.filter(|&s| s != Tree::ROOT) {
                    self.apply(ctx, vec![Action::Exclude(id)]);
                }
            }
        }
    }

    fn expand_to(&mut self, levels: Option<u32>) {
        if let Some(l) = &self.loaded {
            self.expanded = expand_levels(&l.tree, levels);
            self.expanded.insert(Tree::ROOT);
            self.rows_dirty = true;
            self.view = ViewKind::Tree;
        }
    }

    fn draw_menu_items(&self, ui: &mut egui::Ui, items: &[Item], out: &mut Option<Cmd>) {
        let spec = dfm::main_spec();
        for it in items {
            if it.separator {
                ui.separator();
            } else if !it.children.is_empty() {
                ui.menu_button(Self::item_label(it), |ui| self.draw_menu_items(ui, &it.children, out));
            } else if let Some(cmd) = cmd_for(it) {
                let mut b = egui::Button::new(Self::item_label(it)).selected(self.cmd_checked(cmd));
                if let Some(a) = it.action.as_ref().and_then(|a| spec.actions.get(a)) {
                    let sc = shortcut_text(a.shortcut);
                    if !sc.is_empty() {
                        b = b.shortcut_text(sc);
                    }
                }
                let mut r = ui.add_enabled(self.cmd_enabled(cmd), b);
                let hint = Self::item_hint(it);
                if !hint.is_empty() {
                    r = r.on_hover_text(hint);
                }
                if r.clicked() {
                    *out = Some(cmd);
                    ui.close();
                }
            }
        }
    }

    /// Top menu bar built from the `MainMenu` of the original form (items without an equivalent are left out).
    fn menu_bar(&mut self, ui: &mut egui::Ui) -> Option<Cmd> {
        let mut out = None;
        egui::MenuBar::new().ui(ui, |ui| self.draw_menu_items(ui, &self.menu_items, &mut out));
        out
    }

    fn path_row(&mut self, ui: &mut egui::Ui) {
        let scanning = self.handle.is_some();
        ui.horizontal(|ui| {
            egui::ComboBox::from_id_salt("drives").selected_text(tr("Drive")).show_ui(ui, |ui| {
                for d in self.drives.clone() {
                    if ui.selectable_label(false, &d).clicked() {
                        self.path_text = d;
                        self.start_scan();
                    }
                }
                if !self.settings.recent.is_empty() {
                    ui.separator();
                    ui.weak(tr("Recent"));
                }
                for r in self.settings.recent.clone() {
                    if ui.selectable_label(false, &r).clicked() {
                        self.path_text = r;
                        self.start_scan();
                    }
                }
            });
            if ui.add_enabled(!scanning, egui::Button::new(tr("Scan"))).clicked() {
                self.start_scan();
            }
            let edit = ui.add_sized(
                [ui.available_width(), 20.0],
                egui::TextEdit::singleline(&mut self.path_text).hint_text(tr("Path to scan")),
            );
            if edit.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !scanning {
                self.start_scan();
            }
        });
    }

    fn status_bar(&mut self, ui: &mut egui::Ui) {
        fn cell(ui: &mut egui::Ui, w: f32, f: impl FnOnce(&mut egui::Ui)) {
            ui.allocate_ui_with_layout(egui::vec2(w, 18.0), egui::Layout::left_to_right(egui::Align::Center), |ui| {
                ui.set_width(w);
                ui.set_clip_rect(ui.max_rect().intersect(ui.clip_rect()));
                f(ui);
            });
            ui.separator();
        }
        let l = fmt::loc();
        let free_text = self
            .disk
            .as_ref()
            .map(|d| format!("{}: {} ({} {})", tr("Free Space"), fmt::format_bytes_short_in(d.free, l), of_word(), fmt::format_bytes_short_in(d.total, l)))
            .unwrap_or_default();
        let cluster_text = self
            .disk
            .as_ref()
            .filter(|d| d.cluster > 0)
            .map(|d| format!("{}{}{}", fmt::group_int(d.cluster as u64), tr(" Bytes per Cluster"), if d.fs.is_empty() { String::new() } else { format!(" ({})", d.fs) }))
            .unwrap_or_default();
        let err_text = |n: usize| format!("{} {}", fmt::group_int(n as u64), tr("Errors"));
        ui.horizontal(|ui| {
            if let Some(h) = &self.handle {
                let f = h.progress.files.load(Ordering::Relaxed);
                let d = h.progress.dirs.load(Ordering::Relaxed);
                let b = h.progress.bytes.load(Ordering::Relaxed);
                let errs = h.progress.errors.load(Ordering::Relaxed) as usize;
                let cur = h.progress.current.lock().map(|c| c.clone()).unwrap_or_default();
                cell(ui, 230.0, |ui| {
                    scan_marker(ui, 12.0);
                    ui.add(egui::Label::new(if free_text.is_empty() { tr("Scanning") } else { free_text.clone() }).truncate());
                });
                cell(ui, 110.0, |ui| {
                    ui.add(egui::Label::new(format_bytes(b)).truncate());
                });
                cell(ui, 120.0, |ui| {
                    ui.add(egui::Label::new(format!("{} {}", fmt::group_int(f), tr("Files"))).truncate());
                });
                cell(ui, 110.0, |ui| {
                    ui.add(egui::Label::new(format!("{} {}", fmt::group_int(d), tr("Folders"))).truncate());
                });
                if errs > 0 {
                    cell(ui, 100.0, |ui| {
                        let (r, _) = ui.allocate_exact_size(egui::vec2(14.0, 14.0), Sense::hover());
                        paint::error_badge(ui.painter(), r.center(), 6.5);
                        ui.label(err_text(errs));
                    });
                }
                cell(ui, 130.0, |ui| {
                    let frac = self.scan_total.filter(|&t| t > 0).map(|t| (b as f32 / t as f32).min(0.99));
                    progress_bar(ui, frac);
                });
                ui.add(egui::Label::new(format!("{cur}{}", if self.notice.is_empty() { String::new() } else { format!(" | {}", self.notice) })).truncate());
            } else if let Some(l) = &self.loaded {
                let Some(r) = l.tree.root() else { return };
                let (alloc, files, dirs) = (r.alloc, r.files, r.dirs);
                cell(ui, 250.0, |ui| {
                    ui.add(egui::Label::new(if free_text.is_empty() { self.status.clone() } else { free_text.clone() }).truncate());
                });
                cell(ui, 130.0, |ui| {
                    ui.add(egui::Label::new(format!("{} {}", fmt::group_int(files), tr("Files"))).truncate());
                });
                cell(ui, 110.0, |ui| {
                    if !l.error_list.is_empty() {
                        let (r, _) = ui.allocate_exact_size(egui::vec2(14.0, 14.0), Sense::hover());
                        paint::error_badge(ui.painter(), r.center(), 6.5);
                        if ui.link(err_text(l.error_list.len())).clicked() {
                            self.show_errors = !self.show_errors;
                        }
                    }
                });
                if !cluster_text.is_empty() {
                    cell(ui, 220.0, |ui| {
                        ui.add(egui::Label::new(cluster_text.clone()).truncate());
                    });
                }
                ui.add(
                    egui::Label::new(format!(
                        "{} - {} {} {}, {:.2?}{}{}",
                        self.status,
                        format_bytes(alloc),
                        tr("on disk"),
                        format_args!("{} {}", fmt::group_int(dirs), tr("Folders")),
                        l.elapsed,
                        if l.cancelled { format!(" ({})", tr("partial")) } else { String::new() },
                        if self.notice.is_empty() { String::new() } else { format!(" | {}", self.notice) }
                    ))
                    .truncate(),
                );
            } else {
                cell(ui, 210.0, |ui| {
                    ui.add(egui::Label::new(self.status.clone()).truncate());
                });
            }
        });
    }

    /// Header text of a tree column, taken from the `*ColumnAction` captions of the original form.
    fn column_caption(&self, col: SortCol) -> String {
        let spec = dfm::main_spec();
        let (action, fallback) = match col {
            SortCol::Name => ("NameColumnAction", "Name"),
            SortCol::Size => ("SizeColumnAction", "Size"),
            SortCol::Alloc => ("AllocatedSpaceColumnAction", "Allocated"),
            SortCol::Percent => ("PercentColumnAction", "% of Parent"),
            SortCol::Files => ("FilesCountAction", "Files"),
            SortCol::Folders => ("FoldersCountAction", "Folders"),
            SortCol::Modified => ("LastChangeColumnAction", "Last Modified"),
        };
        match spec.actions.get(action) {
            Some(a) if !a.caption.is_empty() => {
                let t = tr_ctx(&format!("TMainForm.{action}.Caption"), &a.caption);
                // The original caption reads "% of Parent (Allocated)"; in Size mode drop the qualifier.
                if col == SortCol::Percent && self.settings.size_mode == SizeMode::Size {
                    t.split(" (").next().unwrap_or(&t).to_string()
                } else {
                    t
                }
            }
            _ => tr(fallback),
        }
    }

    fn tree_columns(&self) -> Vec<SortCol> {
        let mut cols = vec![SortCol::Name, SortCol::Size];
        if self.settings.show_allocated {
            cols.push(SortCol::Alloc);
        }
        cols.push(SortCol::Percent);
        if self.settings.details {
            cols.extend([SortCol::Files, SortCol::Folders, SortCol::Modified]);
        }
        cols
    }

    fn tree_table(&mut self, ui: &mut egui::Ui) {
        let can_rescan = self.sub_scan.is_none() && self.handle.is_none();
        if self.loaded.is_none() {
            self.start_page(ui);
            return;
        }
        if self.rows_dirty {
            self.rebuild_rows();
        }
        if let Some(id) = self.reveal.take() {
            if let Some(pos) = self.rows.iter().position(|r| matches!(r.kind, RowKind::Node(i) if i == id)) {
                self.scroll_to = Some(pos);
            }
        }
        let cols = self.tree_columns();
        let captions: Vec<String> = cols.iter().map(|&c| self.column_caption(c)).collect();
        let by_alloc = self.settings.size_mode == SizeMode::Allocated;
        let mut actions: Vec<Action> = Vec::new();
        let mut new_sort: Option<SortCol> = None;
        let (sort, desc) = (self.sort, self.desc);
        let saved_widths = self.settings.col_widths.clone();
        let mut cur_widths: Vec<f32> = Vec::new();
        let Some(loaded) = &self.loaded else { return };
        let tree = &loaded.tree;
        let rows = &self.rows;
        let expanded = &self.expanded;
        let files_expanded = &self.files_expanded;
        let filtering = self.filter_set.is_some();
        let selected = self.selected;
        let chev = self.chevrons.as_ref();
        let row_h = 20.0;
        let dark = ui.visuals().dark_mode;
        let (pct_l, pct_r) = if dark { (Color32::from_rgb(52, 52, 190), Color32::from_rgb(120, 112, 255)) } else { (Color32::from_rgb(110, 110, 230), Color32::from_rgb(170, 160, 255)) };
        let bar_col = |bold: bool| match (dark, bold) {
            (true, false) => Color32::from_rgb(56, 56, 70),
            (true, true) => Color32::from_rgb(80, 80, 124),
            (false, false) => Color32::from_rgb(214, 216, 236),
            (false, true) => Color32::from_rgb(168, 172, 222),
        };
        let numeric = |c: SortCol| matches!(c, SortCol::Size | SortCol::Alloc | SortCol::Files | SortCol::Folders);

        let header_cell = |ui: &mut egui::Ui, label: &str, col: SortCol, new_sort: &mut Option<SortCol>| {
            let layout = if numeric(col) { egui::Layout::right_to_left(egui::Align::Center) } else { egui::Layout::left_to_right(egui::Align::Center) };
            ui.with_layout(layout, |ui| {
                let arrow = |ui: &mut egui::Ui| {
                    if sort == col {
                        let (r, _) = ui.allocate_exact_size(egui::vec2(12.0, 12.0), Sense::hover());
                        paint::sort_arrow(ui.painter(), r.center(), desc, ui.visuals().text_color());
                    }
                };
                if numeric(col) {
                    arrow(ui);
                }
                let r = ui.add(egui::Label::new(RichText::new(label)).sense(Sense::click()).truncate());
                if r.clicked() {
                    *new_sort = Some(col);
                }
                if !numeric(col) {
                    arrow(ui);
                }
            });
        };
        let right_label = |ui: &mut egui::Ui, text: String, bold: bool| {
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.add_space(4.0);
                let t = RichText::new(text);
                ui.label(if bold { t.strong() } else { t });
            });
        };

        let mut table = TableBuilder::new(ui)
            .striped(!dark)
            .resizable(true)
            .sense(Sense::click())
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center));
        if let Some(row) = self.scroll_to.take() {
            table = table.scroll_to_row(row, None);
        }
        for (i, c) in cols.iter().enumerate() {
            let default = match c {
                SortCol::Name => 400.0,
                SortCol::Size | SortCol::Alloc => 100.0,
                SortCol::Percent => 110.0,
                SortCol::Files | SortCol::Folders => 80.0,
                SortCol::Modified => 110.0,
            };
            let w = saved_widths.iter().find(|(k, _)| k == c).map(|(_, w)| *w).filter(|w| w.is_finite() && *w >= 30.0).unwrap_or(default);
            let col = Column::initial(w).at_least(if *c == SortCol::Name { 140.0 } else { 44.0 }).clip(true);
            table = table.column(if i + 1 == cols.len() { Column::remainder().at_least(60.0).clip(true) } else { col });
        }
        table
            .header(24.0, |mut h| {
                for (c, cap) in cols.iter().zip(&captions) {
                    h.col(|ui| header_cell(ui, cap, *c, &mut new_sort));
                }
            })
            .body(|body| {
                cur_widths = body.widths().to_vec();
                // Virtualised: only the visible rows are laid out.
                body.rows(row_h, rows.len(), |mut trow| {
                    let r = rows[trow.index()];
                    let depth = r.depth;
                    let pseudo = matches!(r.kind, RowKind::Files(_));
                    let (id, dir_for_files) = match r.kind {
                        RowKind::Node(i) => (i, NONE),
                        RowKind::Files(d) => (d, d),
                    };
                    let n = tree.get(id);
                    let is_folder = n.is_dir && !n.is_link;
                    let metric = |x: &scan::model::Node| if by_alloc { x.alloc } else { x.size };
                    // Per-row values (a Files row aggregates the direct files of folder `id`).
                    let (name, size, alloc, files, dirs, modified, num, den, is_dir, is_link, scanning, can_open, open) = if pseudo {
                        let f = r.files;
                        (files_label(f.count), f.size, f.alloc, Some(f.count), None, f.modified, if by_alloc { f.alloc } else { f.size }, metric(n), false, false, false, tree.has_file_nodes() && f.count > 0, files_expanded.contains(&id))
                    } else {
                        let den = if n.parent == NONE { 0 } else { metric(tree.get(n.parent)) };
                        (n.name.clone(), n.size, n.alloc, n.is_dir.then_some(n.files), n.is_dir.then_some(n.dirs), n.modified, metric(n), den, n.is_dir, n.is_link, n.scanning, expandable(tree, id), filtering || expanded.contains(&id))
                    };
                    let is_root = !pseudo && n.parent == NONE;
                    let frac = if is_root { 1.0 } else if den > 0 { (num as f64 / den as f64).min(1.0) } else { 0.0 };
                    if !pseudo {
                        trow.set_selected(selected == Some(id));
                    }
                    for &c in &cols {
                        trow.col(|ui| match c {
                            SortCol::Name => {
                                ui.add_space(depth as f32 * 14.0);
                                if can_open {
                                    let (rect, resp) = ui.allocate_exact_size(egui::vec2(11.0, 11.0), Sense::click());
                                    if let Some(ch) = chev {
                                        let tex = match (open, resp.hovered()) {
                                            (true, true) => &ch.opened_hot,
                                            (true, false) => &ch.opened,
                                            (false, true) => &ch.closed_hot,
                                            (false, false) => &ch.closed,
                                        };
                                        egui::Image::new(tex).paint_at(ui, rect);
                                    } else {
                                        ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, if open { "v" } else { ">" }, egui::FontId::monospace(10.0), ui.visuals().text_color());
                                    }
                                    if resp.clicked() {
                                        actions.push(if pseudo { Action::ToggleFiles(dir_for_files) } else { Action::Toggle(id) });
                                    }
                                } else {
                                    ui.add_space(11.0 + ui.spacing().item_spacing.x);
                                }
                                let (ir, _) = ui.allocate_exact_size(egui::vec2(16.0, 13.0), Sense::hover());
                                if pseudo || !is_dir {
                                    paint::page(ui.painter(), egui::Rect::from_center_size(ir.center(), egui::vec2(10.0, 13.0)), pseudo);
                                } else {
                                    paint::folder(ui.painter(), ir, is_link);
                                }
                                // Size bar behind "<size>  <name>", as in the original name column.
                                let cell = ui.max_rect();
                                if !is_root && size > 0 {
                                    let start = ui.cursor().min.x;
                                    let w = ((cell.right() - start) * frac as f32).max(2.0);
                                    let bar = egui::Rect::from_min_size(egui::pos2(start, cell.top() + 1.0), egui::vec2(w, cell.height() - 2.0));
                                    ui.painter().rect_filled(bar, 0.0, bar_col(r.bold));
                                }
                                ui.allocate_ui_with_layout(egui::vec2(70.0, cell.height()), egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    let t = RichText::new(format_bytes(if by_alloc && !is_root { alloc } else { size }));
                                    ui.label(if r.bold { t.strong() } else { t });
                                });
                                ui.add_space(4.0);
                                let mut t = RichText::new(&name);
                                if is_link {
                                    t = t.italics();
                                }
                                if r.bold || is_root {
                                    t = t.strong();
                                }
                                ui.add(egui::Label::new(t).truncate());
                                if scanning {
                                    scan_marker(ui, 10.0);
                                    ui.label(RichText::new(format!("{}...", tr("Scanning"))).weak().small());
                                }
                            }
                            SortCol::Size => right_label(ui, format_bytes(size), r.bold),
                            SortCol::Alloc => right_label(ui, format_bytes(alloc), r.bold),
                            SortCol::Percent => {
                                let w = ui.available_width().max(10.0);
                                let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 15.0), Sense::hover());
                                ui.painter().rect_filled(rect, 0.0, ui.visuals().extreme_bg_color);
                                let mut fill = rect.shrink(1.0);
                                fill.set_width((rect.width() - 2.0) * frac as f32);
                                paint::gradient(ui.painter(), fill, pct_l, pct_r);
                                ui.painter().rect_stroke(rect, 0.0, Stroke::new(1.0, Color32::from_gray(if dark { 150 } else { 170 })), egui::StrokeKind::Inside);
                                let txt = fmt::percent(frac);
                                let col = if dark { Color32::WHITE } else { Color32::BLACK };
                                let font = egui::FontId::proportional(11.5);
                                if r.bold {
                                    ui.painter().text(rect.center() + egui::vec2(0.4, 0.0), egui::Align2::CENTER_CENTER, &txt, font.clone(), col);
                                }
                                ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, txt, font, col);
                            }
                            SortCol::Files => {
                                if let Some(f) = files {
                                    right_label(ui, fmt::group_int(f), r.bold);
                                }
                            }
                            SortCol::Folders => {
                                if let Some(d) = dirs {
                                    right_label(ui, fmt::group_int(d), r.bold);
                                }
                            }
                            SortCol::Modified => {
                                let t = RichText::new(fmt::format_date(modified));
                                ui.label(if r.bold { t.strong() } else { t });
                            }
                        });
                    }
                    let resp = trow.response();
                    if resp.clicked() && !pseudo {
                        actions.push(Action::Select(id));
                    }
                    if resp.double_clicked() && pseudo && can_open {
                        actions.push(Action::ToggleFiles(dir_for_files));
                    }
                    resp.context_menu(|ui| {
                        let mut item = |ui: &mut egui::Ui, label: &str, act: Action| {
                            if ui.button(tr(label)).clicked() {
                                actions.push(act);
                                ui.close();
                            }
                        };
                        if pseudo {
                            item(ui, "Open in Explorer", Action::OpenExplorer(id));
                            return;
                        }
                        let not_root = id != Tree::ROOT;
                        item(ui, "Open", Action::Open(id));
                        item(ui, "Open in Explorer", Action::OpenExplorer(id));
                        item(ui, "Open in Terminal", Action::Terminal(id));
                        ui.separator();
                        if is_folder {
                            ui.menu_button(tr("Expand"), |ui| {
                                item(ui, "Expand this branch", Action::ExpandBranch(id));
                                item(ui, "Collapse this branch", Action::CollapseBranch(id));
                            });
                            if can_rescan {
                                item(ui, "Rescan Folder", Action::Rescan(id));
                            }
                            item(ui, "Count of sub-folders", Action::CountSubfolders(id));
                            item(ui, "New folder", Action::NewFolder(id));
                        }
                        if not_root {
                            item(ui, "Exclude", Action::Exclude(id));
                        }
                        ui.separator();
                        item(ui, "Copy path", Action::CopyPath(id));
                        item(ui, "Copy as path", Action::CopyPathQuoted(id));
                        if not_root {
                            item(ui, "Rename", Action::Rename(id));
                            item(ui, "Delete (Recycle Bin)", Action::Delete(id));
                        }
                        ui.separator();
                        item(ui, "Properties", Action::Properties(id));
                        item(ui, "Windows properties", Action::ShellProps(id));
                    });
                });
            });

        if let Some(c) = new_sort {
            self.set_sort(c);
        }
        // Persist user-resized column widths once they stop changing.
        let mut needs_repaint = false;
        let widths: Vec<(SortCol, f32)> = cols.iter().copied().zip(cur_widths.iter().copied()).take(cols.len().saturating_sub(1)).collect();
        let stored_differs = widths.iter().any(|(k, w)| self.settings.col_widths.iter().find(|(sk, _)| sk == k).is_none_or(|(_, sw)| (sw - w).abs() > 0.5));
        if stored_differs {
            let changed = widths.len() != self.col_live.len() || widths.iter().zip(&self.col_live).any(|(a, b)| a.0 != b.0 || (a.1 - b.1).abs() > 0.5);
            if changed {
                self.col_live = widths.clone();
                self.col_changed = Instant::now();
            }
            if self.col_changed.elapsed() > Duration::from_millis(600) {
                for (k, w) in &widths {
                    match self.settings.col_widths.iter_mut().find(|(mk, _)| mk == k) {
                        Some(e) => e.1 = *w,
                        None => self.settings.col_widths.push((*k, *w)),
                    }
                }
            } else {
                needs_repaint = true;
            }
        }
        let ctx = ui.ctx().clone();
        if needs_repaint {
            ctx.request_repaint_after(Duration::from_millis(650));
        }
        self.apply(&ctx, actions);
    }

    fn apply_filter_inputs(&mut self) {
        let fi = &self.filter_in;
        let parsed = (|| -> Result<Filter, String> {
            Ok(Filter {
                name: fi.name.trim().to_string(),
                min_size: filter::parse_size(&fi.min)?,
                max_size: filter::parse_size(&fi.max)?,
                modified_after: filter::parse_date(&fi.after)?,
                modified_before: filter::parse_date(&fi.before)?,
                exts: filter::parse_exts(&fi.exts),
            })
        })();
        match parsed {
            Ok(f) => {
                self.filter = f;
                self.filter_err.clear();
                self.filter_set = None;
                self.rows_dirty = true;
            }
            Err(e) => self.filter_err = e,
        }
    }

    fn filter_bar(&mut self, ui: &mut egui::Ui) {
        let mut apply = false;
        let mut clear = false;
        ui.horizontal_wrapped(|ui| {
            let field = |ui: &mut egui::Ui, label: &str, text: &mut String, w: f32, hint: &str| {
                ui.label(label);
                let r = ui.add(egui::TextEdit::singleline(text).desired_width(w).hint_text(hint));
                r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter))
            };
            apply |= field(ui, &tr("Name"), &mut self.filter_in.name, 110.0, &tr("text or *.jpg"));
            apply |= field(ui, &tr("Min"), &mut self.filter_in.min, 60.0, "10MB");
            apply |= field(ui, &tr("Max"), &mut self.filter_in.max, 60.0, "1GB");
            apply |= field(ui, &tr("After"), &mut self.filter_in.after, 80.0, "YYYY-MM-DD");
            apply |= field(ui, &tr("Before"), &mut self.filter_in.before, 80.0, "YYYY-MM-DD");
            apply |= field(ui, &tr("Types"), &mut self.filter_in.exts, 90.0, "jpg,png");
            apply |= ui.button(tr("Apply")).clicked();
            clear |= ui.button(tr("Clear")).clicked();
            if !self.filter_err.is_empty() {
                ui.colored_label(Color32::LIGHT_RED, &self.filter_err);
            }
        });
        if clear {
            self.filter_in = FilterInputs::default();
            apply = true;
        }
        if apply {
            self.apply_filter_inputs();
        }
    }

    fn export(&mut self, fmt: export::Format) {
        let Some(l) = &self.loaded else { return };
        let Some(path) = rfd::FileDialog::new()
            .set_file_name(format!("treesize-report.{}", fmt.ext()))
            .add_filter(fmt.ext(), &[fmt.ext()])
            .save_file()
        else {
            return;
        };
        let res = export::export_to_file(&l.tree, Tree::ROOT, fmt, 8, &path);
        self.notice = match res {
            Ok(()) => format!("{} {}", tr("Exported"), path.display()),
            Err(e) => format!("{}: {e}", tr("Export failed")),
        };
    }

    fn start_duplicates(&mut self) {
        let Some(l) = &self.loaded else { return };
        let min = match filter::parse_size(&self.dup_min) {
            Ok(m) => m.unwrap_or(1).max(1),
            Err(e) => {
                self.notice = e;
                return;
            }
        };
        let cands = duplicates::size_candidates(&l.tree, Tree::ROOT, min);
        let total: usize = cands.iter().map(|(_, p)| p.len()).sum();
        let (tx, rx) = crossbeam_channel::bounded(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicU64::new(0));
        let (c2, d2) = (cancel.clone(), done.clone());
        std::thread::spawn(move || {
            let _ = tx.send(duplicates::find_duplicates_in(cands, &c2, &d2));
        });
        self.dup_result = None;
        self.dup_run = Some(DupRun { rx, cancel, done, total });
    }

    fn poll_duplicates(&mut self) {
        if let Some(run) = &self.dup_run {
            if let Ok(res) = run.rx.try_recv() {
                self.dup_result = res;
                self.dup_run = None;
            }
        }
    }

    fn duplicates_view(&mut self, ui: &mut egui::Ui) {
        let running = self.dup_run.is_some();
        let mut start = false;
        ui.horizontal(|ui| {
            ui.label(tr("Minimum size"));
            ui.add(egui::TextEdit::singleline(&mut self.dup_min).desired_width(70.0));
            start = ui.add_enabled(!running, egui::Button::new(tr("Find duplicates"))).clicked();
            if let Some(run) = &self.dup_run {
                if ui.button(tr("Cancel")).clicked() {
                    run.cancel.store(true, Ordering::Relaxed);
                }
                ui.spinner();
                ui.label(format!("{} / {} {}", run.done.load(Ordering::Relaxed), run.total, tr("files hashed")));
            }
        });
        if start {
            self.start_duplicates();
        }
        if let Some(live) = self.loaded.as_ref().and_then(|l| l.tree.live.as_ref().map(|x| (&l.tree, x))) {
            // Scan running: candidates are same-size files among the largest ones seen so far.
            let (tree, live) = live;
            let cands = types::live_size_candidates(&live.largest);
            ui.label(RichText::new(format!("{} {}", cands.len(), tr("duplicate groups"))).strong());
            ui.weak(tr("Candidates by size while the scan runs; hashing starts when it ends."));
            egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                for (size, files) in cands.iter().take(500) {
                    egui::CollapsingHeader::new(format!("{} x {} {}", format_bytes(*size), files.len(), tr("copies"))).id_salt(("cand", *size)).show(ui, |ui| {
                        for f in files {
                            ui.label(tree.path_of(f.dir).join(&f.name).display().to_string());
                        }
                    });
                }
            });
            return;
        }
        let Some(groups) = &self.dup_result else {
            ui.label(tr("Groups files by size, then by a partial hash, then by a full BLAKE3 hash."));
            return;
        };
        let wasted: u64 = groups.iter().map(|g| g.wasted()).sum();
        ui.label(RichText::new(format!("{} {}, {} {}", groups.len(), tr("duplicate groups"), format_bytes(wasted), tr("wasted"))).strong());
        let mut open = None;
        let mut delete: Option<Vec<(PathBuf, u64)>> = None;
        if ui.button(tr("Keep one copy of each, delete the rest")).clicked() {
            delete = Some(groups.iter().flat_map(|g| duplicates::extras_to_delete(std::slice::from_ref(g)).into_iter().map(|p| (p, g.size))).collect());
        }
        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
            for (gi, g) in groups.iter().take(2000).enumerate() {
                egui::CollapsingHeader::new(format!(
                    "{} x {} {} - {} {}",
                    format_bytes(g.size),
                    g.paths.len(),
                    tr("copies"),
                    format_bytes(g.wasted()),
                    tr("wasted")
                ))
                .id_salt(("dup", gi))
                .show(ui, |ui| {
                    for p in &g.paths {
                        ui.horizontal(|ui| {
                            if ui.small_button(tr("Open")).clicked() {
                                open = Some(p.clone());
                            }
                            if ui.small_button(tr("Delete")).clicked() {
                                delete = Some(vec![(p.clone(), g.size)]);
                            }
                            ui.label(p.display().to_string());
                        });
                    }
                });
            }
        });
        if let Some(p) = open {
            open_in_explorer(&p);
        }
        if let Some(d) = delete.filter(|d| !d.is_empty()) {
            self.confirm_files = Some(d);
        }
    }

    fn central(&mut self, ui: &mut egui::Ui) {
        if matches!(self.view, ViewKind::Cleanup | ViewKind::Age) {
            self.insight_view(ui);
            return;
        }
        if self.view == ViewKind::Compare {
            let open = views::compare_view(ui, self.comparison.as_ref().map(|c| (c.label.as_str(), c.taken, c.changes.as_slice())), &self.size_history, &self.compare_notice, self.loaded.as_ref().map(|l| l.tree.get(Tree::ROOT).name.as_str()));
            if let Some(p) = open {
                open_in_explorer(std::path::Path::new(&p));
            }
            return;
        }
        if self.view == ViewKind::Duplicates {
            if self.loaded.is_none() {
                ui.label(tr("Scan a folder first."));
            } else {
                self.duplicates_view(ui);
            }
            return;
        }
        if self.view == ViewKind::Tree || self.loaded.is_none() {
            self.tree_table(ui);
            return;
        }
        if self.view_root as usize >= self.loaded.as_ref().map_or(0, |l| l.tree.nodes.len()) {
            self.view_root = Tree::ROOT;
        }
        // Live snapshots carry bounded aggregates / top lists instead of file nodes.
        if self.types_cache.is_none() {
            self.types_cache = self.loaded.as_ref().map(|l| match &l.tree.live {
                Some(live) => types::stats_from_live(&live.types),
                None => types::aggregate_by_extension(&l.tree, Tree::ROOT),
            });
        }
        if self.largest_cache.is_none() {
            self.largest_cache = self.loaded.as_ref().map(|l| match &l.tree.live {
                Some(live) => views::rows_from_live(&l.tree, &live.largest),
                None => views::rows_from_ids(&l.tree, &types::largest_files(&l.tree, Tree::ROOT, 100)),
            });
        }
        if self.oldest_cache.is_none() {
            self.oldest_cache = self.loaded.as_ref().map(|l| match &l.tree.live {
                Some(live) => views::rows_from_live(&l.tree, &live.oldest),
                None => views::rows_from_ids(&l.tree, &types::oldest_files(&l.tree, Tree::ROOT, 100)),
            });
        }
        let Some(l) = &self.loaded else { return };
        let tree = &l.tree;
        let mut ev = None;
        match self.view {
            ViewKind::Treemap => ev = views::treemap_view(ui, tree, &mut self.view_root, &mut self.selected),
            ViewKind::Chart => views::chart_view(ui, tree, &mut self.view_root),
            ViewKind::Types => views::types_view(ui, self.types_cache.as_deref().unwrap_or(&[])),
            ViewKind::Largest => {
                ev = views::file_list_view(ui, self.largest_cache.as_deref().unwrap_or(&[]), "largest", self.selected)
            }
            ViewKind::Oldest => {
                ev = views::file_list_view(ui, self.oldest_cache.as_deref().unwrap_or(&[]), "oldest", self.selected)
            }
            ViewKind::Tree | ViewKind::Duplicates | ViewKind::Compare | ViewKind::Cleanup | ViewKind::Age => {}
        }
        let ctx = ui.ctx().clone();
        self.list_event(&ctx, ev);
    }

    /// Handle what a ranked / clean-up list reported (selection, open, right-click menu).
    fn list_event(&mut self, ctx: &egui::Context, ev: Option<ListEvent>) {
        match ev {
            Some(ListEvent::Select(id)) => self.selected = Some(id),
            Some(ListEvent::Open(id)) => {
                if let Some(l) = &self.loaded {
                    open_in_explorer(&l.tree.path_of(id));
                }
            }
            Some(ListEvent::OpenPath(p)) => open_in_explorer(std::path::Path::new(&p)),
            Some(ListEvent::Menu(id, act)) => {
                self.selected = Some(id);
                let actions = match act {
                    MenuAct::OpenItem => vec![Action::Open(id)],
                    MenuAct::Explorer => vec![Action::OpenExplorer(id)],
                    MenuAct::CopyPath => vec![Action::CopyPath(id)],
                    MenuAct::Properties => vec![Action::ShellProps(id)],
                    MenuAct::Delete => vec![Action::Delete(id)],
                    MenuAct::Reveal => vec![Action::Reveal(id)],
                };
                self.apply(ctx, actions);
            }
            None => {}
        }
    }

    /// Save settings when something changed (cheap structural comparison each frame).
    fn persist(&mut self) {
        self.settings.excludes = self.excludes.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        self.settings.sort = self.sort;
        self.settings.sort_desc = self.desc;
        self.settings.view = self.view;
        self.settings.fast_ntfs = self.fast_ntfs;
        if !self.persist_enabled {
            return;
        }
        if self.settings != self.saved_settings {
            if let Some(p) = &self.settings_path {
                if settings::save_to(p, &self.settings).is_ok() {
                    self.saved_settings = self.settings.clone();
                }
            }
        }
    }

    /// Apply settings that have a side effect outside the app state (language, theme, units).
    fn apply_settings(&mut self, ctx: &egui::Context) {
        if self.settings.language != self.lang_applied {
            let eff = i18n::set_language(&i18n::resolve_language(&self.settings.language));
            assets::install_language_fonts(ctx, &eff);
            fmt::set_locale(&eff);
            self.sorted.clear();
            self.rows_dirty = true;
            self.lang_applied = self.settings.language.clone();
            self.status = if self.loaded.is_some() { tr("Scan complete") } else { tr("Ready") };
        }
        if self.settings.theme == Theme::Auto {
            if self.sys_checked.elapsed() > Duration::from_secs(2) {
                self.system_dark = settings::system_dark();
                self.sys_checked = Instant::now();
            }
            ctx.request_repaint_after(Duration::from_secs(2));
        }
        let dark = self.settings.theme.is_dark(self.system_dark);
        if self.dark_applied != Some(dark) {
            ctx.set_visuals(visuals_for(dark));
            self.chevrons = Chevrons::load(ctx, dark);
            self.dark_applied = Some(dark);
        }
        scan::set_units(self.settings.units);
    }

    /// Keyboard shortcuts: F5 refresh, Ctrl+C copy path, Delete exclude, Backspace up, Ctrl+F filters,
    /// plus every shortcut of the DFM actions we implement.
    fn handle_keys(&mut self, ctx: &egui::Context) {
        if ctx.egui_wants_keyboard_input() {
            return;
        }
        let mut cmds: Vec<Cmd> = Vec::new();
        let mut copy = false;
        let mut nav: Option<NavKey> = None;
        ctx.input_mut(|i| {
            if self.view == ViewKind::Tree && self.loaded.is_some() {
                for (k, n) in [(egui::Key::ArrowDown, NavKey::Down), (egui::Key::ArrowUp, NavKey::Up), (egui::Key::ArrowRight, NavKey::Right), (egui::Key::ArrowLeft, NavKey::Left), (egui::Key::Enter, NavKey::Toggle), (egui::Key::Home, NavKey::First), (egui::Key::End, NavKey::Last), (egui::Key::PageDown, NavKey::PageDown), (egui::Key::PageUp, NavKey::PageUp)] {
                    if i.consume_key(egui::Modifiers::NONE, k) {
                        nav = Some(n);
                    }
                }
            }
            if i.consume_key(egui::Modifiers::NONE, egui::Key::F5) {
                cmds.push(Cmd::Refresh);
            }
            if i.consume_key(egui::Modifiers::NONE, egui::Key::Backspace) {
                cmds.push(Cmd::ParentFolder);
            }
            if i.consume_key(egui::Modifiers::COMMAND, egui::Key::F) {
                cmds.push(Cmd::Filter);
            }
            copy = i.events.iter().any(|e| matches!(e, egui::Event::Copy)) || i.consume_key(egui::Modifiers::COMMAND, egui::Key::C);
            for (sc, c) in &self.shortcuts {
                if i.consume_shortcut(sc) {
                    cmds.push(*c);
                }
            }
        });
        if let Some(k) = nav {
            self.navigate(k);
        }
        if copy {
            if let (Some(id), Some(l)) = (self.selected, &self.loaded) {
                ctx.copy_text(l.tree.path_of(id).to_string_lossy().into_owned());
            }
        }
        for c in cmds {
            if self.cmd_enabled(c) {
                self.run_cmd(ctx, c);
            }
        }
    }

    /// Dropping a folder (or a file: its folder) on the window scans it.
    fn handle_drop(&mut self, ctx: &egui::Context) {
        let dropped = ctx.input(|i| i.raw.dropped_files.iter().find_map(|f| Some(f.path().to_path_buf()).filter(|p| !p.as_os_str().is_empty())));
        let Some(p) = dropped else { return };
        if self.handle.is_some() {
            return;
        }
        let dir = if p.is_dir() { p } else { p.parent().map(|d| d.to_path_buf()).unwrap_or(p) };
        self.path_text = dir.to_string_lossy().into_owned();
        self.start_scan();
    }

    /// Switch to the tree, expand every ancestor of `id`, select it and scroll to it.
    fn reveal_in_tree(&mut self, id: NodeId) {
        let Some(l) = &self.loaded else { return };
        if id as usize >= l.tree.nodes.len() {
            return;
        }
        let n = l.tree.get(id);
        if !n.is_dir && n.parent != NONE {
            // Files live under the aggregated "[N Files]" row of their folder.
            self.files_expanded.insert(n.parent);
        }
        let mut cur = n.parent;
        while cur != NONE {
            self.expanded.insert(cur);
            cur = l.tree.get(cur).parent;
        }
        self.selected = Some(id);
        self.view = ViewKind::Tree;
        self.rows_dirty = true;
        self.reveal = Some(id);
    }

    /// Keyboard navigation of the tree rows (arrows, Home/End, Page keys, Enter).
    fn navigate(&mut self, key: NavKey) {
        let Some(l) = &self.loaded else { return };
        let ids: Vec<Option<NodeId>> = self.rows.iter().map(|r| if let RowKind::Node(i) = r.kind { Some(i) } else { None }).collect();
        let cur = self.selected.and_then(|s| ids.iter().position(|&i| i == Some(s)));
        let sel = self.selected;
        let is_open = |id: NodeId| self.expanded.contains(&id);
        let target = match key {
            NavKey::Down => nav_target(&ids, cur, 1),
            NavKey::Up => nav_target(&ids, cur, -1),
            NavKey::PageDown => nav_target(&ids, cur, 15),
            NavKey::PageUp => nav_target(&ids, cur, -15),
            NavKey::First => nav_target(&ids, None, 1),
            NavKey::Last => nav_target(&ids, Some(ids.len()), -1),
            NavKey::Right => match sel {
                Some(id) if expandable(&l.tree, id) && !is_open(id) => {
                    self.expanded.insert(id);
                    self.rows_dirty = true;
                    None
                }
                _ => nav_target(&ids, cur, 1),
            },
            NavKey::Left => match sel {
                Some(id) if is_open(id) && id != Tree::ROOT => {
                    self.expanded.remove(&id);
                    self.rows_dirty = true;
                    None
                }
                Some(id) if l.tree.get(id).parent != NONE => ids.iter().position(|&i| i == Some(l.tree.get(id).parent)),
                _ => None,
            },
            NavKey::Toggle => {
                if let Some(id) = sel.filter(|&id| expandable(&l.tree, id) && id != Tree::ROOT) {
                    if !self.expanded.remove(&id) {
                        self.expanded.insert(id);
                    }
                    self.rows_dirty = true;
                }
                None
            }
        };
        if let Some(t) = target {
            self.selected = ids[t];
            self.scroll_to = Some(t);
        }
    }

    /// Track the window geometry and store it in the settings once it has been stable for a moment.
    fn track_window(&mut self, ctx: &egui::Context) {
        let cur = ctx.input(|i| {
            let v = i.viewport();
            if v.minimized == Some(true) || v.maximized == Some(true) {
                return None;
            }
            let (r, o) = (v.inner_rect?, v.outer_rect?);
            Some(WindowGeom { w: r.width(), h: r.height(), x: Some(o.min.x), y: Some(o.min.y) })
        });
        if let Some(g) = cur {
            if self.win_geom != Some(g) {
                self.win_geom = Some(g);
                self.win_changed = Instant::now();
            }
        }
        if self.win_geom.is_some() && self.win_geom != self.settings.window {
            if self.win_changed.elapsed() > Duration::from_millis(800) {
                self.settings.window = self.win_geom;
            } else {
                ctx.request_repaint_after(Duration::from_millis(850));
            }
        }
    }

    /// `--screenshot` mode: wait for the scan (and duplicates), settle a few frames, capture, quit.
    fn drive_shot(&mut self, ctx: &egui::Context) {
        let Some(live) = self.shot.as_ref().map(|s| s.live) else { return };
        let ready = if live {
            // About a second into the scan: whatever tree is on screen then is the evidence.
            self.loaded.is_some() && self.shot.as_ref().is_some_and(|s| s.started.elapsed() > Duration::from_millis(1200))
        } else {
            self.loaded.is_some() && self.handle.is_none() && (self.view != ViewKind::Duplicates || self.dup_result.is_some())
        };
        ctx.request_repaint();
        if self.shot.as_ref().is_some_and(|s| s.started.elapsed() > Duration::from_secs(120)) {
            eprintln!("screenshot: timed out waiting for the scan");
            std::process::exit(2);
        }
        if !live && self.loaded.is_some() && self.handle.is_none() && self.view == ViewKind::Duplicates && self.dup_result.is_none() && self.dup_run.is_none() {
            self.dup_min = "1".into();
            self.start_duplicates();
        }
        let Some(shot) = self.shot.as_mut() else { return };
        if !ready {
            return;
        }
        shot.prepared = true;
        shot.settle += 1;
        if shot.settle == 8 && !shot.requested {
            shot.requested = true;
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::default()));
        }
    }

    fn take_screenshot_event(&mut self, ctx: &egui::Context) {
        let Some(shot) = &self.shot else { return };
        let img = ctx.input(|i| {
            i.events.iter().find_map(|e| match e {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        });
        if let Some(img) = img {
            match save_png(&img, &shot.file) {
                Ok(()) => println!("screenshot saved: {}", shot.file.display()),
                Err(e) => {
                    eprintln!("screenshot failed: {e}");
                    std::process::exit(1);
                }
            }
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
    }

    /// Offer an elevated restart when folders were refused (the original asks the same question).
    fn admin_banner(&mut self, ui: &mut egui::Ui) {
        let Some(n) = self.admin_hint else { return };
        let mut restart = false;
        let mut dismiss = false;
        egui::Frame::new().fill(ui.visuals().faint_bg_color).inner_margin(6.0).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(format!("{} {}", fmt::group_int(n as u64), tr("folders could not be read (access denied).")));
                restart = ui.button(tr("Restart as Administrator")).clicked();
                dismiss = ui.button(tr("Dismiss")).clicked();
            });
        });
        ui.add_space(4.0);
        if dismiss {
            self.admin_hint = None;
        }
        if restart {
            let ctx = ui.ctx().clone();
            self.run_cmd(&ctx, Cmd::RestartAdmin);
        }
    }

    /// Start page: one card per drive with its space usage (click to scan), then recent folders.
    fn start_page(&mut self, ui: &mut egui::Ui) {
        if let Some(rx) = &self.drive_rx {
            if let Ok(v) = rx.try_recv() {
                self.drive_infos = v;
                self.drive_rx = None;
            } else {
                ui.ctx().request_repaint_after(Duration::from_millis(100));
            }
        }
        ui.add_space(12.0);
        ui.label(RichText::new(tr("Pick a drive or type a path, then press Scan.")).heading());
        ui.add_space(10.0);
        let loc = fmt::loc();
        let mut start: Option<String> = None;
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = egui::vec2(12.0, 12.0);
            for (d, info) in &self.drive_infos {
                let used = info.total.saturating_sub(info.free);
                let frac = if info.total > 0 { used as f32 / info.total as f32 } else { 0.0 };
                let (rect, resp) = ui.allocate_exact_size(egui::vec2(280.0, 74.0), Sense::click());
                let vis = ui.visuals();
                let bg = if resp.hovered() { vis.widgets.hovered.weak_bg_fill } else { vis.widgets.inactive.weak_bg_fill };
                let p = ui.painter();
                p.rect_filled(rect, 4.0, bg);
                p.rect_stroke(rect, 4.0, Stroke::new(1.0, vis.widgets.noninteractive.bg_stroke.color), egui::StrokeKind::Inside);
                p.text(rect.min + egui::vec2(10.0, 8.0), egui::Align2::LEFT_TOP, format!("{d}  ({})", info.fs), egui::FontId::proportional(14.0), vis.text_color());
                let bar = egui::Rect::from_min_size(rect.min + egui::vec2(10.0, 32.0), egui::vec2(rect.width() - 20.0, 14.0));
                p.rect_filled(bar, 2.0, vis.extreme_bg_color);
                let mut fill = bar;
                fill.set_width(bar.width() * frac);
                let col = if frac > 0.9 { Color32::from_rgb(210, 70, 60) } else { Color32::from_rgb(90, 110, 220) };
                p.rect_filled(fill, 2.0, col);
                p.text(
                    rect.min + egui::vec2(10.0, 52.0),
                    egui::Align2::LEFT_TOP,
                    format!("{} {} {} {}", fmt::format_bytes_short_in(info.free, loc), tr("free"), of_word(), fmt::format_bytes_short_in(info.total, loc)),
                    egui::FontId::proportional(12.0),
                    vis.weak_text_color(),
                );
                if resp.clicked() {
                    start = Some(d.clone());
                }
            }
        });
        if !self.settings.recent.is_empty() {
            ui.add_space(16.0);
            ui.label(RichText::new(tr("Recent")).strong());
            for r in self.settings.recent.clone() {
                if ui.add(egui::Button::new(&r).frame(false)).clicked() {
                    start = Some(r);
                }
            }
        }
        if let Some(p) = start {
            self.path_text = p;
            self.start_scan();
        }
    }

    /// Clean-up and File age views (computed from the finished tree, cached until it changes).
    fn insight_view(&mut self, ui: &mut egui::Ui) {
        let Some(l) = &self.loaded else {
            ui.label(tr("Scan a folder first."));
            return;
        };
        if l.tree.live.is_some() {
            ui.label(tr("Available when the scan has finished."));
            return;
        }
        if self.view == ViewKind::Age {
            if self.age_cache.is_none() {
                self.age_cache = Some(insights::age_buckets(&l.tree, chrono::Utc::now().timestamp()));
            }
            views::age_view(ui, self.age_cache.as_deref().unwrap_or(&[]));
            return;
        }
        if self.cleanup_cache.is_none() {
            let tree = &l.tree;
            let mut rows: Vec<views::CleanRow> = insights::reclaimable(tree)
                .into_iter()
                .map(|r| views::CleanRow { id: r.id, kind: tr(r.kind), path: tree.path_of(r.id).to_string_lossy().into_owned(), size: r.size })
                .collect();
            let empty = tr("Empty folder");
            rows.extend(insights::empty_dirs(tree).into_iter().map(|id| views::CleanRow { id, kind: empty.clone(), path: tree.path_of(id).to_string_lossy().into_owned(), size: 0 }));
            self.cleanup_cache = Some(rows);
        }
        let rows = self.cleanup_cache.clone().unwrap_or_default();
        let total: u64 = rows.iter().map(|r| r.size).sum();
        ui.label(RichText::new(format!("{}: {} ({} {})", tr("Can be reclaimed"), format_bytes(total), rows.len(), tr("folders"))).strong());
        ui.horizontal(|ui| {
            let sel = self.selected.filter(|s| rows.iter().any(|r| r.id == *s));
            if ui.add_enabled(sel.is_some(), egui::Button::new(tr("Delete (Recycle Bin)"))).clicked() {
                self.confirm_delete = sel;
            }
            ui.weak(tr("Select a folder, then delete it. Nothing is removed without confirmation."));
        });
        let ev = views::cleanup_list(ui, &rows, self.selected);
        let ctx = ui.ctx().clone();
        self.list_event(&ctx, ev);
    }

    /// Confirmation (and execution) of a batch of file deletions from the duplicate finder.
    fn files_delete_window(&mut self, ctx: &egui::Context) {
        let Some(files) = self.confirm_files.clone() else { return };
        let total: u64 = files.iter().map(|(_, s)| *s).sum();
        let (mut yes, mut no) = (false, false);
        egui::Window::new(tr("Delete (Recycle Bin)")).collapsible(false).resizable(false).show(ctx, |ui| {
            ui.label(format!("{} {} - {}", files.len(), tr("Files"), format_bytes(total)));
            egui::ScrollArea::vertical().max_height(160.0).show(ui, |ui| {
                for (p, _) in files.iter().take(200) {
                    ui.label(p.display().to_string());
                }
                if files.len() > 200 {
                    ui.weak(format!("... +{}", files.len() - 200));
                }
            });
            ui.horizontal(|ui| {
                yes = ui.button(tr("Delete")).clicked();
                no = ui.button(tr("Cancel")).clicked();
            });
        });
        if no {
            self.confirm_files = None;
        } else if yes {
            self.confirm_files = None;
            let mut removed = HashSet::new();
            let mut failed = 0usize;
            for (p, _) in &files {
                match crate::trash::recycle(p) {
                    Ok(()) => {
                        removed.insert(p.clone());
                    }
                    Err(_) => failed += 1,
                }
            }
            if let Some(groups) = &mut self.dup_result {
                duplicates::remove_paths(groups, &removed);
            }
            self.notice = if failed == 0 {
                format!("{} {} - {}", removed.len(), tr("Files"), tr("Rescan to refresh the tree."))
            } else {
                format!("{} / {} {}", failed, files.len(), tr("could not be deleted"))
            };
        }
    }

    /// Rename / New folder prompt.
    fn name_window(&mut self, ctx: &egui::Context) {
        let Some(mut d) = self.name_dialog.take() else { return };
        let Some(l) = &self.loaded else { return };
        let path = l.tree.path_of(d.id);
        let title = tr(if d.new_folder { "New folder" } else { "Rename" });
        let (mut ok, mut cancel) = (false, false);
        egui::Window::new(title).collapsible(false).resizable(false).show(ctx, |ui| {
            ui.label(path.to_string_lossy());
            let r = ui.text_edit_singleline(&mut d.text);
            r.request_focus();
            if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                ok = true;
            }
            if !d.err.is_empty() {
                ui.colored_label(Color32::LIGHT_RED, &d.err);
            }
            ui.horizontal(|ui| {
                ok |= ui.button(tr("OK")).clicked();
                cancel = ui.button(tr("Cancel")).clicked();
            });
        });
        if ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            cancel = true;
        }
        if cancel {
            return;
        }
        if !ok {
            self.name_dialog = Some(d);
            return;
        }
        let name = d.text.trim().to_string();
        if !valid_file_name(&name) {
            d.err = tr("Invalid name");
            self.name_dialog = Some(d);
            return;
        }
        if d.new_folder {
            match std::fs::create_dir(path.join(&name)) {
                Ok(()) => self.start_sub_scan(d.id),
                Err(e) => {
                    d.err = e.to_string();
                    self.name_dialog = Some(d);
                }
            }
        } else {
            match std::fs::rename(&path, path.with_file_name(&name)) {
                Ok(()) => {
                    if let Some(l) = &mut self.loaded {
                        l.tree.nodes[d.id as usize].name = name;
                    }
                    self.invalidate();
                }
                Err(e) => {
                    d.err = e.to_string();
                    self.name_dialog = Some(d);
                }
            }
        }
    }

    fn delete_window(&mut self, ctx: &egui::Context) {
        if self.confirm_delete.is_none() && self.delete_error.is_none() {
            if ctx.input(|i| i.key_pressed(egui::Key::Delete)) && !ctx.egui_wants_keyboard_input() {
                if let Some(id) = self.selected.filter(|&id| id != Tree::ROOT && self.handle.is_none()) {
                    self.confirm_delete = Some(id);
                }
            }
            return;
        }
        if let Some(err) = self.delete_error.clone() {
            let mut open = true;
            egui::Window::new(tr("Delete (Recycle Bin)")).open(&mut open).collapsible(false).show(ctx, |ui| {
                ui.label(err);
                if ui.button(tr("OK")).clicked() {
                    self.delete_error = None;
                }
            });
            if !open {
                self.delete_error = None;
            }
            return;
        }
        let Some(id) = self.confirm_delete else { return };
        let Some(l) = &self.loaded else {
            self.confirm_delete = None;
            return;
        };
        let path = l.tree.path_of(id);
        let size = l.tree.get(id).size;
        let (mut yes, mut no) = (false, false);
        egui::Window::new(tr("Delete (Recycle Bin)")).collapsible(false).resizable(false).show(ctx, |ui| {
            ui.label(path.to_string_lossy());
            ui.label(format_bytes(size));
            ui.horizontal(|ui| {
                yes = ui.button(tr("Delete")).clicked();
                no = ui.button(tr("Cancel")).clicked();
            });
        });
        if no {
            self.confirm_delete = None;
        } else if yes {
            self.confirm_delete = None;
            match crate::trash::recycle(&path) {
                Ok(()) => {
                    if let Some(l) = &mut self.loaded {
                        l.tree.remove_subtree(id);
                    }
                    self.selected = None;
                    self.view_root = Tree::ROOT;
                    self.invalidate();
                }
                Err(e) => self.delete_error = Some(format!("{}: {e}", path.display())),
            }
        }
    }

    fn windows(&mut self, ctx: &egui::Context) {
        self.options_window(ctx);
        self.delete_window(ctx);
        self.name_window(ctx);
        self.files_delete_window(ctx);
        self.about_window(ctx);
        if let (Some(id), Some(l)) = (self.props, &self.loaded) {
            let mut open = true;
            let n = l.tree.get(id);
            egui::Window::new(tr("Properties")).open(&mut open).collapsible(false).show(ctx, |ui| {
                ui.label(RichText::new(l.tree.path_of(id).to_string_lossy()).strong());
                ui.separator();
                egui::Grid::new("props").num_columns(2).show(ui, |ui| {
                    let mut kv = |k: &str, v: String| {
                        ui.label(k);
                        ui.label(v);
                        ui.end_row();
                    };
                    let kind = if n.is_link { "Link / junction" } else if n.is_dir { "Folder" } else { "File" };
                    kv(&tr("Type"), tr(kind));
                    kv(&tr("Size"), format!("{} ({} bytes)", format_bytes(n.size), n.size));
                    kv(&tr("Allocated"), format!("{} ({} bytes)", format_bytes(n.alloc), n.alloc));
                    if n.is_dir {
                        kv(&tr("Files"), n.files.to_string());
                        kv(&tr("Folders"), n.dirs.to_string());
                    }
                    kv(&tr("Last Modified"), format_time(n.modified));
                    kv(&tr("Attributes"), format!("0x{:08X}", n.attrs));
                });
            });
            if !open {
                self.props = None;
            }
        }
        if self.show_errors {
            if let Some(l) = &self.loaded {
                let mut open = true;
                egui::Window::new(tr("Scan errors")).open(&mut open).default_height(300.0).show(ctx, |ui| {
                    egui::ScrollArea::vertical().show_rows(ui, 18.0, l.error_list.len(), |ui, range| {
                        for e in &l.error_list[range] {
                            ui.label(format!("{}  -  {}", e.path.display(), e.message));
                        }
                    });
                });
                self.show_errors = open;
            }
        }
    }
}

/// Small rotating dot used for unfinished folders. Unlike `ui.spinner()` it does not request a
/// repaint by itself: the app already repaints at ~10 fps while a scan runs.
fn scan_marker(ui: &mut egui::Ui, size: f32) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(size, size), Sense::hover());
    let c = rect.center();
    let r = size / 2.0 - 1.0;
    let col = ui.visuals().text_color();
    ui.painter().circle_stroke(c, r, egui::Stroke::new(1.0, col.gamma_multiply(0.3)));
    let a = ui.input(|i| i.time) as f32 * 6.0;
    ui.painter().circle_filled(c + egui::vec2(a.cos(), a.sin()) * r, 1.6, col);
}

/// Scan progress: a filled bar when a total is known, otherwise a bouncing segment.
fn progress_bar(ui: &mut egui::Ui, frac: Option<f32>) {
    let w = ui.available_width().clamp(40.0, 120.0);
    let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 10.0), Sense::hover());
    let p = ui.painter();
    p.rect_filled(rect, 2.0, ui.visuals().extreme_bg_color);
    let fill = Color32::from_rgb(70, 140, 70);
    let mut bar = rect;
    match frac {
        Some(f) => bar.set_width(rect.width() * f.clamp(0.0, 1.0)),
        None => {
            let t = (ui.input(|i| i.time) as f32 * 0.8).fract();
            let pos = if t < 0.5 { t * 2.0 } else { (1.0 - t) * 2.0 };
            let seg = rect.width() * 0.3;
            bar = egui::Rect::from_min_size(egui::pos2(rect.left() + (rect.width() - seg) * pos, rect.top()), egui::vec2(seg, rect.height()));
        }
    }
    p.rect_filled(bar, 2.0, fill);
}

/// A single path component that Windows accepts (no separators or reserved characters).
fn valid_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
}

/// Relaunch this program elevated (UAC prompt) on `path`; `true` when the new process was started.
fn restart_as_admin(path: &std::path::Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let wide = |s: &std::ffi::OsStr| -> Vec<u16> { s.encode_wide().chain(std::iter::once(0)).collect() };
        let Ok(exe) = std::env::current_exe() else { return false };
        let verb = wide(std::ffi::OsStr::new("runas"));
        let file = wide(exe.as_os_str());
        let params = wide(std::ffi::OsStr::new(&format!("\"{}\"", path.display())));
        // SAFETY: all strings are NUL-terminated and outlive the call; null window/directory are allowed.
        let rc = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), params.as_ptr(), std::ptr::null(), 1) } as usize;
        rc > 32
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn open_in_explorer(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    }
    #[cfg(not(windows))]
    {
        let dir = path.parent().unwrap_or(path);
        let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        self.take_screenshot_event(&ctx);
        self.apply_settings(&ctx);
        self.poll_scan();
        self.poll_sub_scan();
        self.poll_duplicates();
        if self.handle.is_some() || self.dup_run.is_some() {
            ctx.request_repaint_after(Duration::from_millis(100));
        }
        self.handle_keys(&ctx);
        self.handle_drop(&ctx);
        let mut cmd = None;
        egui::Panel::top("toolbar").show(ui, |ui| {
            cmd = cmd.or(self.ribbon(ui));
            ui.add_space(2.0);
            self.path_row(ui);
            if self.show_filters {
                self.filter_bar(ui);
            }
            ui.add_space(4.0);
        });
        egui::Panel::bottom("status").show(ui, |ui| {
            ui.add_space(2.0);
            self.status_bar(ui);
            ui.add_space(2.0);
        });
        egui::CentralPanel::default().show(ui, |ui| {
            self.admin_banner(ui);
            self.central(ui);
        });
        self.windows(&ctx);
        if let Some(c) = cmd {
            self.run_cmd(&ctx, c);
        }
        self.drive_shot(&ctx);
        if self.persist_enabled {
            self.track_window(&ctx);
        }
        self.persist();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_screenshot_flag_is_parsed() {
        let a: Vec<String> = ["--screenshot-live", "l.png", "C:\\x"].iter().map(|s| s.to_string()).collect();
        let o = parse_args(&a).unwrap();
        assert_eq!(o.screenshot, Some(PathBuf::from("l.png")));
        assert!(o.live);
        assert!(parse_args(&["--screenshot-live".into()]).is_err());
    }

    #[test]
    fn args_are_parsed() {
        let a: Vec<String> = ["C:\\x", "--screenshot", "o.png", "--view", "treemap", "--lang", "fr"].iter().map(|s| s.to_string()).collect();
        let o = parse_args(&a).unwrap();
        assert_eq!(o.start, Some(PathBuf::from("C:\\x")));
        assert_eq!(o.screenshot, Some(PathBuf::from("o.png")));
        assert_eq!(o.view, Some(ViewKind::Treemap));
        assert_eq!(o.lang.as_deref(), Some("fr"));
        assert_eq!(parse_args(&[]).unwrap(), RunOptions::default());
        assert!(parse_args(&["--view".into(), "nope".into()]).is_err());
        assert!(parse_args(&["--screenshot".into()]).is_err());
        assert!(parse_args(&["--bogus".into()]).is_err());
        for v in ["tree", "treemap", "chart", "types", "largest", "oldest", "duplicates", "TREE"] {
            assert!(parse_view(v).is_some(), "{v}");
        }
    }

    #[test]
    fn window_geometry_is_sanitised() {
        let min = (640.0, 360.0);
        let g = WindowGeom { w: 900.0, h: 700.0, x: Some(10.0), y: Some(20.0) };
        assert_eq!(sanitize_geom(g, min), Some(g));
        assert_eq!(sanitize_geom(WindowGeom { w: 100.0, ..g }, min), None);
        assert_eq!(sanitize_geom(WindowGeom { h: f32::NAN, ..g }, min), None);
        assert_eq!(sanitize_geom(WindowGeom { w: 50000.0, ..g }, min), None);
        // A minimised window reports -32000: keep the size, drop the position.
        let off = sanitize_geom(WindowGeom { x: Some(-32000.0), ..g }, min).unwrap();
        assert_eq!((off.x, off.y, off.w), (None, None, 900.0));
    }

    #[test]
    fn nav_target_skips_pseudo_rows_and_stops_at_the_ends() {
        let ids = [Some(1), None, Some(3), Some(4), None];
        assert_eq!(nav_target(&ids, Some(0), 1), Some(2), "skips the Files row");
        assert_eq!(nav_target(&ids, Some(3), 1), None, "no wrap at the end");
        assert_eq!(nav_target(&ids, Some(2), -1), Some(0));
        assert_eq!(nav_target(&ids, None, 1), Some(0), "nothing selected: first row");
        assert_eq!(nav_target(&ids, Some(ids.len()), -1), Some(3), "End");
        assert_eq!(nav_target(&ids, Some(0), 15), Some(3), "page moves clamp to the last node");
        assert_eq!(nav_target(&[], None, 1), None);
    }

    #[test]
    fn access_denied_errors_are_counted_by_os_code() {
        let e = |m: &str| scan::ScanError { path: PathBuf::from("x"), message: m.to_string() };
        let errs = [e("Accès refusé. (os error 5)"), e("Access is denied. (os error 5)"), e("The system cannot find the path (os error 3)")];
        assert_eq!(access_denied_count(&errs), 2);
        assert_eq!(access_denied_count(&[]), 0);
    }

    #[test]
    fn file_names_are_validated() {
        assert!(valid_file_name("new folder") && valid_file_name("a.b"));
        for bad in ["", ".", "..", "a/b", "a\\b", "x:y", "q?", "a|b"] {
            assert!(!valid_file_name(bad), "{bad}");
        }
    }

    #[test]
    fn expand_levels_follow_the_depth() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join("a/b/c")).unwrap();
        std::fs::write(d.path().join("a/b/c/f.bin"), [1u8; 10]).unwrap();
        std::fs::create_dir_all(d.path().join("z")).unwrap();
        let res = scan::scan_simple(d.path());
        let t = &res.tree;
        assert!(expand_levels(t, Some(0)).is_empty());
        assert_eq!(expand_levels(t, Some(1)).len(), 1, "root only");
        assert_eq!(expand_levels(t, Some(2)).len(), 2, "root + a");
        // Full: root, a, b, c (z is empty so there is nothing to expand).
        assert_eq!(expand_levels(t, None).len(), 4);
    }

    #[test]
    fn png_screenshots_are_written() {
        let d = tempfile::tempdir().unwrap();
        let img = egui::ColorImage::new([3, 2], vec![Color32::from_rgb(10, 20, 30); 6]);
        let p = d.path().join("sub/out.png");
        save_png(&img, &p).unwrap();
        let back = image::open(&p).unwrap().to_rgba8();
        assert_eq!(back.dimensions(), (3, 2));
        assert_eq!(back.get_pixel(0, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn files_row_is_aggregated_sorted_and_flagged() {
        use scan::model::Node;
        let n = |name: &str, parent, children: Vec<NodeId>, is_dir, size, modified| Node {
            name: name.into(),
            parent,
            children,
            size,
            alloc: size,
            files: 0,
            dirs: 0,
            modified,
            attrs: 0,
            is_dir,
            is_link: false,
            scanning: false,
        };
        // R -> [big dir (500), f1 (100), f2 (30)]
        let t = Tree {
            nodes: vec![
                n("R", NONE, vec![1, 2, 3], true, 630, 0),
                n("big", 0, vec![], true, 500, 5),
                n("f1", 0, vec![], false, 100, 9),
                n("f2", 0, vec![], false, 30, 7),
            ],
            ..Default::default()
        };
        let sib = build_sib(&t, 0, false, SortCol::Size, true);
        assert_eq!(sib.order, vec![RowKind::Node(1), RowKind::Files(0)], "files collapse into one pseudo-row");
        assert_eq!((sib.files.count, sib.files.size, sib.files.modified), (2, 130, 9));
        assert_eq!(sib.top, vec![RowKind::Node(1), RowKind::Files(0)]);
        let by_name = build_sib(&t, 0, false, SortCol::Name, false);
        assert_eq!(by_name.order[0], RowKind::Files(0), "[2 Files] sorts before 'big'");
        // filtering lists the files individually
        let f = build_sib(&t, 0, true, SortCol::Size, true);
        assert_eq!(f.order, vec![RowKind::Node(1), RowKind::Node(2), RowKind::Node(3)]);
        assert_eq!(files_label_with("[%d Files]", 30), "[30 Files]");
        assert!(expandable(&t, 0) && !expandable(&t, 2));
        // a live snapshot has no file nodes but still reports direct files
        let live = Tree::placeholder("R");
        assert!(!expandable(&live, 0));
    }
}

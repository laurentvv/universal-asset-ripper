mod chrome;
mod dialogs;

use self::chrome::{cmd_for, hint_text, pruned, shortcut_text, to_egui_shortcut, Cmd};
use super::assets::{self, Chevrons};
use super::views::{self, ListEvent};
use crate::analysis::duplicates::{self, DupGroup};
use crate::analysis::filter::{self, Filter};
use crate::analysis::types::{self, TypeStat};
use crate::dfm::{self, Item};
use crate::export;
use crate::i18n::{self, tr, tr_ctx};
use crate::scan::{self, format_bytes, format_time, model::normalize_root, NodeId, ScanHandle, ScanMsg, Tree, NONE};
use crate::settings::{self, SizeMode, Settings, SortKey as SortCol, Theme, ViewKind, WindowGeom};
use eframe::egui::{self, Color32, RichText, Sense};
use egui_extras::{Column, TableBuilder};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

enum Action {
    Toggle(NodeId),
    Select(NodeId),
    OpenExplorer(NodeId),
    CopyPath(NodeId),
    Properties(NodeId),
    Exclude(NodeId),
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
    largest_cache: Option<Vec<NodeId>>,
    oldest_cache: Option<Vec<NodeId>>,
    dup_run: Option<DupRun>,
    dup_result: Option<Vec<DupGroup>>,
    dup_min: String,
    path_text: String,
    drives: Vec<String>,
    handle: Option<ScanHandle>,
    loaded: Option<Loaded>,
    excludes: Vec<PathBuf>,
    expanded: HashSet<NodeId>,
    sort: SortCol,
    desc: bool,
    sorted: HashMap<NodeId, Vec<NodeId>>,
    rows: Vec<(NodeId, u16)>,
    rows_dirty: bool,
    selected: Option<NodeId>,
    props: Option<NodeId>,
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
    theme_applied: Option<Theme>,
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
}

/// Command-line options of the GUI.
#[derive(Debug, Default, PartialEq)]
pub struct RunOptions {
    pub start: Option<PathBuf>,
    pub screenshot: Option<PathBuf>,
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

fn visuals_for(t: Theme) -> egui::Visuals {
    match t {
        Theme::Dark => egui::Visuals::dark(),
        Theme::Light => egui::Visuals::light(),
    }
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
    let (w, h) = match (shot_mode, geom) {
        (true, _) => (1100.0, 700.0),
        (false, Some(g)) => (g.w, g.h),
        (false, None) => (spec.client_w, spec.client_h),
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
    let options = eframe::NativeOptions { viewport: vp, ..Default::default() };
    eframe::run_native(
        "treesize-clone",
        options,
        Box::new(move |cc| {
            let mut app = App::new(&cc.egui_ctx, st, &opts);
            if let Some(p) = &opts.start {
                let abs = std::path::absolute(p).unwrap_or_else(|_| p.clone());
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
        scan::set_units(st.units);
        ctx.set_visuals(visuals_for(st.theme));
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
            theme_applied: Some(st.theme),
            chevrons: Chevrons::load(ctx, st.theme == Theme::Dark),
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
            dup_run: None,
            dup_result: None,
            dup_min: "64KB".into(),
            drives,
            handle: None,
            loaded: None,
            expanded: HashSet::new(),
            sorted: HashMap::new(),
            rows: Vec::new(),
            rows_dirty: true,
            selected: None,
            props: None,
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
            }),
        }
    }

    fn start_scan(&mut self) {
        if let Some(h) = &self.handle {
            h.cancel();
        }
        let root = normalize_root(std::path::Path::new(self.path_text.trim()));
        self.status = format!("{} {} ...", tr("Scanning"), root.display());
        self.notice.clear();
        self.settings.last_path = root.to_string_lossy().into_owned();
        self.handle = Some(scan::spawn_scan_opts(root, self.excludes.clone(), self.fast_ntfs));
    }

    fn poll_scan(&mut self) {
        while let Some(msg) = self.handle.as_ref().and_then(|h| h.rx.try_recv().ok()) {
            let res = match msg {
                ScanMsg::Notice(m) => {
                    self.notice = m;
                    continue;
                }
                ScanMsg::Done(res) => *res,
            };
            self.handle = None;
            self.expanded.clear();
            self.expanded.insert(Tree::ROOT);
            self.invalidate();
            self.selected = None;
            self.props = None;
            self.view_root = Tree::ROOT;
            self.dup_result = None;
            self.status = if res.cancelled { tr("Scan cancelled") } else { tr("Scan complete") };
            self.loaded = Some(Loaded {
                tree: res.tree,
                root: res.root,
                elapsed: res.elapsed,
                error_list: res.errors,
                cancelled: res.cancelled,
            });
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
    }

    fn sort_key_cmp(&self, tree: &Tree, a: NodeId, b: NodeId) -> std::cmp::Ordering {
        let (na, nb) = (tree.get(a), tree.get(b));
        let o = match self.sort {
            SortCol::Name => na.name.to_lowercase().cmp(&nb.name.to_lowercase()),
            SortCol::Size | SortCol::Percent => na.size.cmp(&nb.size),
            SortCol::Alloc => na.alloc.cmp(&nb.alloc),
            SortCol::Files => na.files.cmp(&nb.files),
            SortCol::Folders => na.dirs.cmp(&nb.dirs),
            SortCol::Modified => na.modified.cmp(&nb.modified),
        };
        if self.desc { o.reverse() } else { o }
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
        if !tree.nodes.is_empty() {
            let mut stack: Vec<(NodeId, u16)> = vec![(Tree::ROOT, 0)];
            while let Some((id, depth)) = stack.pop() {
                self.rows.push((id, depth));
                if (fset.is_some() || self.expanded.contains(&id)) && !tree.get(id).children.is_empty() {
                    if !self.sorted.contains_key(&id) {
                        let mut kids = tree.get(id).children.clone();
                        kids.sort_by(|&a, &b| self.sort_key_cmp(tree, a, b));
                        self.sorted.insert(id, kids);
                    }
                    for &c in self.sorted[&id].iter().rev() {
                        if fset.is_none_or(|s| s.contains(&c)) {
                            stack.push((c, depth + 1));
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
            Cmd::Filter => self.show_filters = !self.show_filters,
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

    /// Toolbar buttons in the order of the original `MainToolBar`.
    fn toolbar(&mut self, ui: &mut egui::Ui) -> Option<Cmd> {
        let mut out = None;
        ui.horizontal_wrapped(|ui| {
            for it in &self.toolbar_items {
                if it.separator {
                    ui.separator();
                    continue;
                }
                let Some(cmd) = cmd_for(it) else { continue };
                let label = Self::item_label(it);
                let mut r = ui.add_enabled(self.cmd_enabled(cmd), egui::Button::new(label).selected(self.cmd_checked(cmd)));
                let hint = Self::item_hint(it);
                if !hint.is_empty() {
                    r = r.on_hover_text(hint);
                }
                if r.clicked() {
                    out = Some(cmd);
                }
            }
        });
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
        let w = &dfm::main_spec().status_panels;
        let pw = |i: usize, d: f32| w.get(i).copied().unwrap_or(d);
        let err_w = pw(3, 50.0).max(90.0);
        ui.horizontal(|ui| {
            if let Some(h) = &self.handle {
                let f = h.progress.files.load(Ordering::Relaxed);
                let d = h.progress.dirs.load(Ordering::Relaxed);
                let b = h.progress.bytes.load(Ordering::Relaxed);
                let cur = h.progress.current.lock().map(|c| c.clone()).unwrap_or_default();
                cell(ui, pw(0, 210.0), |ui| {
                    ui.spinner();
                    ui.add(egui::Label::new(tr("Scanning")).truncate());
                });
                cell(ui, pw(1, 120.0), |ui| {
                    ui.add(egui::Label::new(format_bytes(b)).truncate());
                });
                cell(ui, pw(2, 100.0), |ui| {
                    ui.add(egui::Label::new(format!("{f} {}", tr("Files"))).truncate());
                });
                cell(ui, err_w, |ui| {
                    ui.add(egui::Label::new(format!("{d} {}", tr("Folders"))).truncate());
                });
                ui.add(egui::Label::new(format!("{cur}{}", if self.notice.is_empty() { String::new() } else { format!(" | {}", self.notice) })).truncate());
            } else if let Some(l) = &self.loaded {
                let Some(r) = l.tree.root() else { return };
                let (size, alloc, files, dirs) = (r.size, r.alloc, r.files, r.dirs);
                cell(ui, pw(0, 210.0), |ui| {
                    ui.add(egui::Label::new(self.status.clone()).truncate());
                });
                cell(ui, pw(1, 120.0), |ui| {
                    ui.add(egui::Label::new(format_bytes(size)).truncate());
                });
                cell(ui, pw(2, 100.0), |ui| {
                    ui.add(egui::Label::new(format!("{files} {}", tr("Files"))).truncate());
                });
                cell(ui, err_w, |ui| {
                    if !l.error_list.is_empty() && ui.link(format!("{} {}", l.error_list.len(), tr("errors"))).clicked() {
                        self.show_errors = !self.show_errors;
                    }
                });
                ui.add(
                    egui::Label::new(format!(
                        "{} {}, {dirs} {}, {:.2?}{}{}",
                        format_bytes(alloc),
                        tr("on disk"),
                        tr("Folders"),
                        l.elapsed,
                        if l.cancelled { format!(" ({})", tr("partial")) } else { String::new() },
                        if self.notice.is_empty() { String::new() } else { format!(" | {}", self.notice) }
                    ))
                    .truncate(),
                );
            } else {
                cell(ui, pw(0, 210.0), |ui| {
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
        if self.loaded.is_none() {
            ui.centered_and_justified(|ui| {
                ui.label(tr("Pick a drive or type a path, then press Scan."));
            });
            return;
        }
        if self.rows_dirty {
            self.rebuild_rows();
        }
        let cols = self.tree_columns();
        let captions: Vec<String> = cols.iter().map(|&c| self.column_caption(c)).collect();
        let by_alloc = self.settings.size_mode == SizeMode::Allocated;
        let mut actions: Vec<Action> = Vec::new();
        let mut new_sort: Option<SortCol> = None;
        let (sort, desc) = (self.sort, self.desc);
        let Some(loaded) = &self.loaded else { return };
        let tree = &loaded.tree;
        let rows = &self.rows;
        let expanded = &self.expanded;
        let filtering = self.filter_set.is_some();
        let selected = self.selected;
        let chev = self.chevrons.as_ref();
        let row_h = 20.0;
        let pct_fill = if ui.visuals().dark_mode { Color32::from_rgb(70, 140, 70) } else { Color32::from_rgb(120, 190, 120) };

        let header_cell = |ui: &mut egui::Ui, label: &str, col: SortCol, new_sort: &mut Option<SortCol>| {
            let arrow = if sort == col { if desc { " v" } else { " ^" } } else { "" };
            if ui
                .add(egui::Label::new(RichText::new(format!("{label}{arrow}")).strong()).sense(Sense::click()).truncate())
                .clicked()
            {
                *new_sort = Some(col);
            }
        };

        let mut table = TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .sense(Sense::click())
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center));
        for (i, c) in cols.iter().enumerate() {
            let col = match c {
                SortCol::Name => Column::initial(380.0).at_least(120.0).clip(true),
                SortCol::Size | SortCol::Alloc => Column::initial(90.0).at_least(50.0).clip(true),
                SortCol::Percent => Column::initial(150.0).at_least(60.0).clip(true),
                SortCol::Files | SortCol::Folders => Column::initial(70.0).at_least(40.0).clip(true),
                SortCol::Modified => Column::initial(130.0).at_least(110.0).clip(true),
            };
            table = table.column(if i + 1 == cols.len() { Column::remainder().at_least(60.0).clip(true) } else { col });
        }
        table
            .header(22.0, |mut h| {
                for (c, cap) in cols.iter().zip(&captions) {
                    h.col(|ui| header_cell(ui, cap, *c, &mut new_sort));
                }
            })
            .body(|body| {
                // Virtualised: only the visible rows are laid out.
                body.rows(row_h, rows.len(), |mut row| {
                    let (id, depth) = rows[row.index()];
                    let n = tree.get(id);
                    row.set_selected(selected == Some(id));
                    for &c in &cols {
                        row.col(|ui| match c {
                            SortCol::Name => {
                                ui.add_space(depth as f32 * 14.0);
                                let expandable = n.is_dir && !n.children.is_empty();
                                if expandable {
                                    let open = filtering || expanded.contains(&id);
                                    let size = egui::vec2(11.0, 11.0);
                                    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
                                    if let Some(c) = chev {
                                        let tex = match (open, resp.hovered()) {
                                            (true, true) => &c.opened_hot,
                                            (true, false) => &c.opened,
                                            (false, true) => &c.closed_hot,
                                            (false, false) => &c.closed,
                                        };
                                        egui::Image::new(tex).paint_at(ui, rect);
                                    } else {
                                        ui.painter().text(
                                            rect.center(),
                                            egui::Align2::CENTER_CENTER,
                                            if open { "v" } else { ">" },
                                            egui::FontId::monospace(10.0),
                                            ui.visuals().text_color(),
                                        );
                                    }
                                    if resp.clicked() {
                                        actions.push(Action::Toggle(id));
                                    }
                                } else {
                                    ui.add_space(11.0 + ui.spacing().item_spacing.x);
                                }
                                let (r, _) = ui.allocate_exact_size(egui::vec2(10.0, 8.0), Sense::hover());
                                let col = if n.is_link {
                                    Color32::from_rgb(150, 150, 200)
                                } else if n.is_dir {
                                    Color32::from_rgb(240, 190, 60)
                                } else {
                                    Color32::from_rgb(170, 170, 170)
                                };
                                ui.painter().rect_filled(r, 1.0, col);
                                let mut t = RichText::new(&n.name);
                                if n.is_link {
                                    t = t.italics();
                                }
                                ui.add(egui::Label::new(t).truncate());
                            }
                            SortCol::Size => {
                                ui.label(format_bytes(n.size));
                            }
                            SortCol::Alloc => {
                                ui.label(format_bytes(n.alloc));
                            }
                            SortCol::Percent => {
                                let metric = |x: &scan::model::Node| if by_alloc { x.alloc } else { x.size };
                                let pct = if n.parent == NONE {
                                    1.0
                                } else {
                                    let ps = metric(tree.get(n.parent));
                                    if ps > 0 { metric(n) as f64 / ps as f64 } else { 0.0 }
                                };
                                let w = ui.available_width().max(10.0);
                                let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 14.0), Sense::hover());
                                ui.painter().rect_filled(rect, 1.0, ui.visuals().extreme_bg_color);
                                let mut fill = rect;
                                fill.set_width(rect.width() * pct as f32);
                                ui.painter().rect_filled(fill, 1.0, pct_fill);
                                ui.painter().text(
                                    rect.center(),
                                    egui::Align2::CENTER_CENTER,
                                    format!("{:.1}%", pct * 100.0),
                                    egui::FontId::proportional(11.0),
                                    ui.visuals().text_color(),
                                );
                            }
                            SortCol::Files => {
                                if n.is_dir {
                                    ui.label(n.files.to_string());
                                }
                            }
                            SortCol::Folders => {
                                if n.is_dir {
                                    ui.label(n.dirs.to_string());
                                }
                            }
                            SortCol::Modified => {
                                ui.label(format_time(n.modified));
                            }
                        });
                    }
                    let resp = row.response();
                    if resp.clicked() {
                        actions.push(Action::Select(id));
                    }
                    resp.context_menu(|ui| {
                        if ui.button(tr("Open in Explorer")).clicked() {
                            actions.push(Action::OpenExplorer(id));
                            ui.close();
                        }
                        if ui.button(tr("Copy path")).clicked() {
                            actions.push(Action::CopyPath(id));
                            ui.close();
                        }
                        if ui.button(tr("Properties")).clicked() {
                            actions.push(Action::Properties(id));
                            ui.close();
                        }
                        if id != Tree::ROOT && ui.button(tr("Exclude")).clicked() {
                            actions.push(Action::Exclude(id));
                            ui.close();
                        }
                    });
                });
            });

        if let Some(c) = new_sort {
            self.set_sort(c);
        }
        let ctx = ui.ctx().clone();
        self.apply(&ctx, actions);
    }

    fn toolbar_options(&mut self, ui: &mut egui::Ui) {
        ui.horizontal_wrapped(|ui| {
            ui.checkbox(&mut self.fast_ntfs, tr("Fast NTFS scan (admin)"))
                .on_hover_text(tr("Reads the MFT directly; needs an elevated process and a whole drive. Falls back to the normal scan otherwise."));
            ui.separator();
            ui.add_enabled_ui(self.loaded.is_some(), |ui| {
                ui.menu_button(tr("Export"), |ui| {
                    for (label, fmt) in [("CSV...", export::Format::Csv), ("HTML report...", export::Format::Html), ("JSON...", export::Format::Json)] {
                        if ui.button(tr(label)).clicked() {
                            ui.close();
                            self.export(fmt);
                        }
                    }
                });
            });
            ui.toggle_value(&mut self.show_filters, tr("Filters"));
            ui.separator();
            for (v, label) in [
                (ViewKind::Tree, "Tree"),
                (ViewKind::Treemap, "Treemap"),
                (ViewKind::Chart, "Chart"),
                (ViewKind::Types, "File types"),
                (ViewKind::Largest, "Top 100 files"),
                (ViewKind::Oldest, "Oldest files"),
                (ViewKind::Duplicates, "Duplicates"),
            ] {
                ui.selectable_value(&mut self.view, v, tr(label));
            }
        });
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
        let Some(groups) = &self.dup_result else {
            ui.label(tr("Groups files by size, then by a partial hash, then by a full BLAKE3 hash."));
            return;
        };
        let wasted: u64 = groups.iter().map(|g| g.wasted()).sum();
        ui.label(RichText::new(format!("{} {}, {} {}", groups.len(), tr("duplicate groups"), format_bytes(wasted), tr("wasted"))).strong());
        let mut open = None;
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
                            ui.label(p.display().to_string());
                        });
                    }
                });
            }
        });
        if let Some(p) = open {
            open_in_explorer(&p);
        }
    }

    fn central(&mut self, ui: &mut egui::Ui) {
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
        if self.types_cache.is_none() {
            self.types_cache = self.loaded.as_ref().map(|l| types::aggregate_by_extension(&l.tree, Tree::ROOT));
        }
        if self.largest_cache.is_none() {
            self.largest_cache = self.loaded.as_ref().map(|l| types::largest_files(&l.tree, Tree::ROOT, 100));
        }
        if self.oldest_cache.is_none() {
            self.oldest_cache = self.loaded.as_ref().map(|l| types::oldest_files(&l.tree, Tree::ROOT, 100));
        }
        let Some(l) = &self.loaded else { return };
        let tree = &l.tree;
        let mut ev = None;
        match self.view {
            ViewKind::Treemap => views::treemap_view(ui, tree, &mut self.view_root, &mut self.selected),
            ViewKind::Chart => views::chart_view(ui, tree, &mut self.view_root),
            ViewKind::Types => views::types_view(ui, self.types_cache.as_deref().unwrap_or(&[])),
            ViewKind::Largest => {
                ev = views::file_list_view(ui, tree, self.largest_cache.as_deref().unwrap_or(&[]), "largest", self.selected)
            }
            ViewKind::Oldest => {
                ev = views::file_list_view(ui, tree, self.oldest_cache.as_deref().unwrap_or(&[]), "oldest", self.selected)
            }
            ViewKind::Tree | ViewKind::Duplicates => {}
        }
        match ev {
            Some(ListEvent::Select(id)) => self.selected = Some(id),
            Some(ListEvent::Open(id)) => open_in_explorer(&tree.path_of(id)),
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
            self.lang_applied = self.settings.language.clone();
            self.status = if self.loaded.is_some() { tr("Scan complete") } else { tr("Ready") };
        }
        if self.theme_applied != Some(self.settings.theme) {
            ctx.set_visuals(visuals_for(self.settings.theme));
            self.chevrons = Chevrons::load(ctx, self.settings.theme == Theme::Dark);
            self.theme_applied = Some(self.settings.theme);
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
        ctx.input_mut(|i| {
            if i.consume_key(egui::Modifiers::NONE, egui::Key::F5) {
                cmds.push(Cmd::Refresh);
            }
            if i.consume_key(egui::Modifiers::NONE, egui::Key::Delete) {
                cmds.push(Cmd::ExcludeSelected);
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
        let ready = self.loaded.is_some() && self.handle.is_none() && (self.view != ViewKind::Duplicates || self.dup_result.is_some());
        if self.shot.is_none() {
            return;
        }
        ctx.request_repaint();
        if self.shot.as_ref().is_some_and(|s| s.started.elapsed() > Duration::from_secs(120)) {
            eprintln!("screenshot: timed out waiting for the scan");
            std::process::exit(2);
        }
        if self.loaded.is_some() && self.handle.is_none() && self.view == ViewKind::Duplicates && self.dup_result.is_none() && self.dup_run.is_none() {
            self.dup_min = "1".into();
            self.start_duplicates();
        }
        let mut expand: Vec<NodeId> = Vec::new();
        if ready && self.shot.as_ref().is_some_and(|s| !s.prepared) {
            if let Some(l) = &self.loaded {
                let mut kids: Vec<NodeId> = l.tree.get(Tree::ROOT).children.iter().copied().filter(|&c| l.tree.get(c).is_dir && !l.tree.get(c).children.is_empty()).collect();
                kids.sort_by_key(|&c| std::cmp::Reverse(l.tree.get(c).size));
                expand = kids.into_iter().take(3).collect();
            }
        }
        if !expand.is_empty() {
            self.expanded.extend(expand);
            self.rows_dirty = true;
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

    fn windows(&mut self, ctx: &egui::Context) {
        self.options_window(ctx);
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
        self.poll_duplicates();
        if self.handle.is_some() || self.dup_run.is_some() {
            ctx.request_repaint_after(Duration::from_millis(100));
        }
        self.handle_keys(&ctx);
        let mut cmd = None;
        egui::Panel::top("toolbar").show(ui, |ui| {
            cmd = cmd.or(self.menu_bar(ui));
            ui.add_space(2.0);
            cmd = cmd.or(self.toolbar(ui));
            self.path_row(ui);
            self.toolbar_options(ui);
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
}

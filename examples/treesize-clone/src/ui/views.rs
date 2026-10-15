//! Secondary views: treemap, folder chart, file types, ranked file lists.

use super::treemap::{pie_angles, Rect as TRect};
use crate::i18n::tr;
use crate::analysis::types::{top_children, Category, TypeStat};
use crate::scan::model::RankedFile;
use crate::scan::{format_bytes, format_time, NodeId, Tree, NONE};
use eframe::egui::{self, Color32, RichText, Sense};
use egui_extras::{Column, TableBuilder};

const MAX_TILES: usize = 4000;

/// Entries of the right-click menu of list rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuAct {
    OpenItem,
    Explorer,
    CopyPath,
    Properties,
    Delete,
    Reveal,
}

/// Right-click menu shared by the ranked lists and the clean-up list.
pub fn row_menu(resp: &egui::Response, id: NodeId) -> Option<ListEvent> {
    let mut out = None;
    resp.context_menu(|ui| {
        for (label, act) in [
            ("Open", MenuAct::OpenItem),
            ("Open in Explorer", MenuAct::Explorer),
            ("Show in tree", MenuAct::Reveal),
            ("Copy path", MenuAct::CopyPath),
            ("Windows properties", MenuAct::Properties),
            ("Delete (Recycle Bin)", MenuAct::Delete),
        ] {
            if ui.button(tr(label)).clicked() {
                out = Some(ListEvent::Menu(id, act));
                ui.close();
            }
        }
    });
    out
}

pub enum ListEvent {
    /// Select the node in the tree and scroll to it (map panel click).
    Reveal(NodeId),
    Menu(NodeId, MenuAct),
    Select(NodeId),
    Open(NodeId),
    OpenPath(String),
}

/// One line of the "largest" / "oldest" lists: a retained file node or a streamed live entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankedRow {
    pub path: String,
    pub size: u64,
    pub modified: i64,
    pub id: Option<NodeId>,
}

pub fn rows_from_ids(tree: &Tree, ids: &[NodeId]) -> Vec<RankedRow> {
    ids.iter()
        .map(|&id| {
            let n = tree.get(id);
            RankedRow { path: tree.path_of(id).to_string_lossy().into_owned(), size: n.size, modified: n.modified, id: Some(id) }
        })
        .collect()
}

pub fn rows_from_live(tree: &Tree, files: &[RankedFile]) -> Vec<RankedRow> {
    files
        .iter()
        .filter(|f| (f.dir as usize) < tree.nodes.len())
        .map(|f| RankedRow { path: tree.path_of(f.dir).join(&f.name).to_string_lossy().into_owned(), size: f.size, modified: f.modified, id: None })
        .collect()
}

pub fn category_color(c: Category) -> Color32 {
    let [r, g, b] = c.rgb();
    Color32::from_rgb(r, g, b)
}

fn palette(i: usize) -> Color32 {
    const P: [[u8; 3]; 12] = [
        [86, 140, 214],
        [96, 178, 110],
        [214, 160, 70],
        [200, 90, 90],
        [170, 110, 200],
        [70, 170, 180],
        [220, 120, 60],
        [150, 190, 80],
        [200, 120, 160],
        [120, 120, 210],
        [190, 170, 100],
        [140, 140, 150],
    ];
    let [r, g, b] = P[i % P.len()];
    Color32::from_rgb(r, g, b)
}

/// Clickable path from the scan root down to `root`; clicking a part navigates up to it.
pub fn breadcrumb(ui: &mut egui::Ui, tree: &Tree, root: &mut NodeId) {
    let mut chain = Vec::new();
    let mut cur = *root;
    while cur != NONE {
        chain.push(cur);
        cur = tree.get(cur).parent;
    }
    chain.reverse();
    ui.horizontal_wrapped(|ui| {
        for (i, &id) in chain.iter().enumerate() {
            if i > 0 {
                ui.label(">");
            }
            let last = i + 1 == chain.len();
            let name = tree.get(id).name.clone();
            if last {
                ui.label(RichText::new(name).strong());
            } else if ui.add(egui::Button::new(name).frame(false)).clicked() {
                *root = id;
            }
        }
    });
}

/// Level colours of the nested treemap (level 0 darkest), close to the original "Carte proportionnelle".
const LEVELS: [Color32; 5] = [Color32::from_rgb(18, 38, 88), Color32::from_rgb(32, 62, 128), Color32::from_rgb(52, 92, 164), Color32::from_rgb(78, 122, 192), Color32::from_rgb(110, 150, 215)];

/// Appearance of the proportional map (the "Options de graphique" of the original).
#[derive(Debug, Clone, Copy)]
pub struct MapStyle {
    /// Folder levels drawn below the shown folder (the legend shows one more entry).
    pub levels: u8,
    pub unique_files: bool,
    pub headers: bool,
    pub legend: bool,
    pub labels: bool,
    /// Free bytes of the drive, shown as an extra tile when the shown folder is a drive root.
    pub free_space: Option<u64>,
}

impl Default for MapStyle {
    fn default() -> Self {
        MapStyle { levels: 4, unique_files: false, headers: true, legend: true, labels: true, free_space: None }
    }
}

pub fn treemap_view(ui: &mut egui::Ui, tree: &Tree, root: &mut NodeId, selected: &mut Option<NodeId>, docked: bool, style: &MapStyle) -> Option<ListEvent> {
    use super::treemap::{nested_with, tile_at, NestOpts, TileKind, HEADER_H};
    if !docked {
        breadcrumb(ui, tree, root);
    }
    let legend_h = if style.legend { 24.0 } else { 0.0 };
    let avail = ui.available_size();
    let (resp, painter) = ui.allocate_painter(egui::vec2(avail.x, (avail.y - legend_h).max(40.0)), Sense::click());
    let area = resp.rect;
    painter.rect_filled(area, 0.0, ui.visuals().extreme_bg_color);
    let opts = NestOpts { max_depth: style.levels, unique_files: style.unique_files, headers: style.headers, max_tiles: MAX_TILES, free_space: style.free_space };
    let tiles = nested_with(tree, *root, TRect::new(0.0, 0.0, area.width(), area.height()), &opts);
    if tiles.is_empty() {
        painter.text(area.center(), egui::Align2::CENTER_CENTER, tr("Nothing to show"), egui::FontId::proportional(14.0), ui.visuals().text_color());
    }
    let menu_key = egui::Id::new("treemap_menu_node");
    let hit = resp.hover_pos().and_then(|p| tile_at(&tiles, p.x - area.min.x, p.y - area.min.y));
    let to_rect = |r: TRect| egui::Rect::from_min_size(area.min + egui::vec2(r.x, r.y), egui::vec2(r.w, r.h));
    let font = egui::FontId::proportional(11.0);
    for (i, t) in tiles.iter().enumerate() {
        let rect = to_rect(t.rect);
        let base = LEVELS[(t.depth as usize).min(LEVELS.len() - 1)];
        let mut fill = match t.kind {
            TileKind::Folder => base,
            TileKind::File | TileKind::FilesBlock => Color32::from_rgb(base.r().saturating_add(18), base.g().saturating_add(22), base.b().saturating_add(26)),
            TileKind::Free => Color32::from_rgb(70, 76, 90),
        };
        if hit == Some(i) {
            fill = fill.gamma_multiply(1.35);
        }
        painter.rect_filled(rect.shrink(0.5), 0.0, fill);
        let is_sel = matches!(t.kind, TileKind::Folder | TileKind::File) && *selected == Some(t.id);
        painter.rect_stroke(rect.shrink(0.5), 0.0, egui::Stroke::new(if is_sel { 2.0 } else { 1.0 }, if is_sel { Color32::from_rgb(255, 214, 90) } else { Color32::from_rgb(10, 22, 52) }), egui::StrokeKind::Inside);
        if !style.labels {
            continue;
        }
        let label = match t.kind {
            TileKind::FilesBlock => Some(format!("[{} {}] ({})", crate::fmt::group_int(t.files), tr("Files"), format_bytes(t.size))),
            TileKind::Free => Some(format!("{} ({})", tr("Free space"), format_bytes(t.size))),
            TileKind::File | TileKind::Folder if t.has_header || (t.rect.w > 56.0 && t.rect.h > HEADER_H) => {
                let n = tree.get(t.id);
                Some(if t.rect.w > 130.0 { format!("{} ({})", n.name, format_bytes(t.size)) } else { n.name.clone() })
            }
            _ => None,
        };
        if let Some(label) = label {
            if t.rect.h > 13.0 && t.rect.w > 24.0 {
                painter.with_clip_rect(rect).text(rect.min + egui::vec2(3.0, 1.0), egui::Align2::LEFT_TOP, label, font.clone(), Color32::WHITE);
            }
        }
    }
    if resp.secondary_clicked() {
        // Blocks and the free-space tile stand for no node of their own: no menu (offering Delete
        // on a files block would target the whole folder).
        match hit.filter(|&i| matches!(tiles[i].kind, TileKind::Folder | TileKind::File)) {
            Some(i) => {
                let node = tiles[i].id;
                ui.memory_mut(|m| m.data.insert_temp(menu_key, node));
                *selected = Some(node);
            }
            None => ui.memory_mut(|m| m.data.remove::<NodeId>(menu_key)),
        }
    }
    let mut event = None;
    if let Some(node) = ui.memory(|m| m.data.get_temp::<NodeId>(menu_key)) {
        if (node as usize) < tree.nodes.len() {
            event = row_menu(&resp, node);
        }
    }
    if let Some(i) = hit {
        let t = tiles[i];
        let n = tree.get(t.id);
        let what = match t.kind {
            TileKind::FilesBlock => format!("{} [{}]", tree.path_of(t.id).display(), tr("Files")),
            TileKind::Free => tr("Free space"),
            _ => tree.path_of(t.id).display().to_string(),
        };
        let total = if style.free_space.is_some() { tree.get(*root).size + style.free_space.unwrap_or(0) } else { tree.get(*root).size }.max(1);
        resp.clone().on_hover_text_at_pointer(format!("{}\n{} ({:.1}% {} {})", what, format_bytes(t.size), t.size as f64 * 100.0 / total as f64, tr("of"), tree.get(*root).name));
        let drillable = t.kind == TileKind::Folder && n.is_dir && !n.children.is_empty();
        if resp.double_clicked() && drillable && !docked {
            *root = t.id;
        } else if resp.clicked() && matches!(t.kind, TileKind::Folder | TileKind::File | TileKind::FilesBlock) {
            *selected = Some(t.id);
            if docked && event.is_none() {
                event = Some(ListEvent::Reveal(t.id));
            }
        }
    }
    if style.legend {
        let (lr, lp) = ui.allocate_painter(egui::vec2(avail.x, legend_h), Sense::hover());
        let count = (style.levels as usize + 1).min(LEVELS.len());
        let w = lr.rect.width() / count as f32;
        for (i, c) in LEVELS.iter().take(count).enumerate() {
            let r = egui::Rect::from_min_size(lr.rect.min + egui::vec2(w * i as f32 + 2.0, 3.0), egui::vec2(w - 4.0, legend_h - 6.0));
            lp.rect_filled(r, 0.0, *c);
            lp.text(r.left_center() + egui::vec2(6.0, 0.0), egui::Align2::LEFT_CENTER, format!("{} {}", tr("Level"), i), font.clone(), Color32::WHITE);
        }
    }
    event
}

pub fn chart_view(ui: &mut egui::Ui, tree: &Tree, root: &mut NodeId) {
    breadcrumb(ui, tree, root);
    let slices = top_children(tree, *root, 12);
    let (resp, painter) = ui.allocate_painter(ui.available_size(), Sense::click());
    let area = resp.rect;
    if slices.is_empty() {
        painter.text(area.center(), egui::Align2::CENTER_CENTER, tr("Nothing to show"), egui::FontId::proportional(14.0), ui.visuals().text_color());
        return;
    }
    let total: u64 = slices.iter().map(|s| s.size).sum();
    // Pie on the left.
    let radius = (area.height().min(area.width() * 0.4) / 2.0 - 12.0).max(20.0);
    let centre = area.min + egui::vec2(radius + 16.0, radius + 16.0);
    let angles = pie_angles(&slices.iter().map(|s| s.size).collect::<Vec<_>>());
    for (i, (a, b)) in angles.iter().enumerate() {
        let steps = (((b - a) / 0.05).ceil() as usize).max(1);
        for k in 0..steps {
            let a0 = a + (b - a) * k as f32 / steps as f32;
            let a1 = a + (b - a) * (k + 1) as f32 / steps as f32;
            let p = |ang: f32| centre + egui::vec2(ang.cos(), ang.sin()) * radius;
            painter.add(egui::Shape::convex_polygon(vec![centre, p(a0), p(a1)], palette(i), egui::Stroke::NONE));
        }
    }
    // Bars on the right.
    let bx = centre.x + radius + 32.0;
    let bar_w = (area.max.x - bx - 12.0).max(80.0);
    let row_h = 26.0;
    let max = slices.iter().map(|s| s.size).max().unwrap_or(1).max(1);
    for (i, s) in slices.iter().enumerate() {
        let top = area.min.y + 12.0 + i as f32 * row_h;
        let row = egui::Rect::from_min_size(egui::pos2(bx, top), egui::vec2(bar_w, row_h - 4.0));
        painter.rect_filled(row, 1.0, ui.visuals().extreme_bg_color);
        let mut fill = row;
        fill.set_width(row.width() * s.size as f32 / max as f32);
        painter.rect_filled(fill, 1.0, palette(i));
        let label = format!("{}  -  {} ({:.1}%)", s.name, format_bytes(s.size), s.size as f64 * 100.0 / total as f64);
        painter.with_clip_rect(row).text(
            row.min + egui::vec2(4.0, 3.0),
            egui::Align2::LEFT_TOP,
            label,
            egui::FontId::proportional(12.0),
            ui.visuals().strong_text_color(),
        );
        if let Some(id) = s.node {
            if resp.clicked() && resp.interact_pointer_pos().is_some_and(|p| row.contains(p)) && tree.get(id).is_dir {
                *root = id;
            }
        }
    }
}

pub fn types_view(ui: &mut egui::Ui, stats: &[TypeStat]) {
    ui.horizontal_wrapped(|ui| {
        for c in Category::ALL {
            let (r, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), Sense::hover());
            ui.painter().rect_filled(r, 1.0, category_color(c));
            ui.label(tr(c.label()));
        }
    });
    TableBuilder::new(ui)
        .striped(true)
        .resizable(true)
        .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
        .column(Column::initial(140.0).at_least(60.0))
        .column(Column::initial(110.0).at_least(60.0))
        .column(Column::initial(90.0).at_least(40.0))
        .column(Column::initial(100.0).at_least(60.0))
        .column(Column::initial(100.0).at_least(60.0))
        .column(Column::remainder().at_least(120.0))
        .header(22.0, |mut h| {
            for t in ["Extension", "Category", "Files", "Size", "Allocated", "% of total"] {
                h.col(|ui| {
                    ui.label(RichText::new(tr(t)).strong());
                });
            }
        })
        .body(|body| {
            body.rows(20.0, stats.len(), |mut row| {
                let s = &stats[row.index()];
                row.col(|ui| {
                    let (r, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), Sense::hover());
                    ui.painter().rect_filled(r, 1.0, category_color(s.category));
                    ui.label(if s.ext.is_empty() { tr("(none)") } else { format!(".{}", s.ext) });
                });
                row.col(|ui| {
                    ui.label(tr(s.category.label()));
                });
                row.col(|ui| {
                    ui.label(s.count.to_string());
                });
                row.col(|ui| {
                    ui.label(format_bytes(s.size));
                });
                row.col(|ui| {
                    ui.label(format_bytes(s.alloc));
                });
                row.col(|ui| {
                    let w = ui.available_width().max(10.0);
                    let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 14.0), Sense::hover());
                    ui.painter().rect_filled(rect, 1.0, ui.visuals().extreme_bg_color);
                    let mut fill = rect;
                    fill.set_width(rect.width() * (s.percent / 100.0) as f32);
                    ui.painter().rect_filled(fill, 1.0, category_color(s.category));
                    ui.painter().text(
                        rect.center(),
                        egui::Align2::CENTER_CENTER,
                        format!("{:.1}%", s.percent),
                        egui::FontId::proportional(11.0),
                        ui.visuals().text_color(),
                    );
                });
            });
        });
}

/// Ranked file list (largest / oldest). Click selects, double-click opens in Explorer.
pub fn file_list_view(ui: &mut egui::Ui, rows: &[RankedRow], salt: &str, selected: Option<NodeId>) -> Option<ListEvent> {
    let mut ev = None;
    ui.push_id(salt, |ui| {
        // Selectable labels would swallow the click that selects the row.
        ui.style_mut().interaction.selectable_labels = false;
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .sense(Sense::click())
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::initial(60.0).at_least(40.0))
            .column(Column::initial(520.0).at_least(120.0).clip(true))
            .column(Column::initial(100.0).at_least(60.0))
            .column(Column::remainder().at_least(110.0))
            .header(22.0, |mut h| {
                for t in ["#", "Path", "Size", "Last Modified"] {
                    h.col(|ui| {
                        ui.label(RichText::new(tr(t)).strong());
                    });
                }
            })
            .body(|body| {
                body.rows(20.0, rows.len(), |mut row| {
                    let i = row.index();
                    let r = &rows[i];
                    row.set_selected(r.id.is_some() && selected == r.id);
                    row.col(|ui| {
                        ui.label((i + 1).to_string());
                    });
                    row.col(|ui| {
                        ui.add(egui::Label::new(r.path.as_str()).truncate());
                    });
                    row.col(|ui| {
                        ui.label(format_bytes(r.size));
                    });
                    row.col(|ui| {
                        ui.label(format_time(r.modified));
                    });
                    let resp = row.response();
                    if let Some(id) = r.id {
                        if let Some(m) = row_menu(&resp, id) {
                            ev = Some(m);
                        }
                    }
                    if resp.double_clicked() {
                        ev = Some(match r.id {
                            Some(id) => ListEvent::Open(id),
                            None => ListEvent::OpenPath(r.path.clone()),
                        });
                    } else if resp.clicked() {
                        if let Some(id) = r.id {
                            ev = Some(ListEvent::Select(id));
                        }
                    }
                });
            });
    });
    ev
}

/// "Changes since an older scan": folders ranked by absolute size change. Returns a path to open.
pub fn compare_view(ui: &mut egui::Ui, cmp: Option<(&str, i64, &[crate::analysis::snapshot::DirDelta])>, history: &[crate::analysis::snapshot::HistoryPoint], pick: &mut Option<i64>, notice: &str, root: Option<&str>) -> Option<String> {
    use crate::analysis::snapshot::ChangeKind;
    if !notice.is_empty() {
        ui.label(notice);
    }
    if history.len() > 1 {
        size_history_chart(ui, history);
        ui.add_space(6.0);
        // Baseline picker: every earlier scan whose snapshot is still stored (the newest point is this scan).
        ui.horizontal(|ui| {
            ui.label(tr("Compare with"));
            egui::ComboBox::from_id_salt("baseline").selected_text(cmp.map(|c| c.0.to_string()).unwrap_or_default()).show_ui(ui, |ui| {
                for p in history[..history.len() - 1].iter().rev() {
                    let text = format!("{} - {}", format_time(p.taken), format_bytes(p.size));
                    if ui.selectable_label(cmp.is_some_and(|c| c.1 == p.taken), text).clicked() {
                        *pick = Some(p.taken);
                    }
                }
            });
        });
    }
    let Some((label, taken, changes)) = cmp else {
        ui.label(tr("No earlier scan of this folder to compare with yet. Scan it again later, or use Compare with snapshot."));
        return None;
    };
    let grown: i64 = changes.iter().filter(|c| c.path.is_empty()).map(|c| c.delta()).sum();
    ui.label(RichText::new(format!("{} {} ({}): {} {} - {}", tr("Compared with"), label, format_time(taken), changes.len(), tr("changed folders"), signed_bytes(grown))).strong());
    ui.add_space(4.0);
    let mut open = None;
    let root = root.unwrap_or("");
    let (up, down) = if ui.visuals().dark_mode { (Color32::from_rgb(255, 120, 110), Color32::from_rgb(110, 210, 120)) } else { (Color32::from_rgb(190, 40, 30), Color32::from_rgb(20, 130, 40)) };
    ui.style_mut().interaction.selectable_labels = false; // so a row can be double-clicked
    TableBuilder::new(ui)
        .striped(true)
        .resizable(true)
        .sense(Sense::click())
        .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
        .column(Column::initial(70.0).at_least(50.0))
        .column(Column::initial(460.0).at_least(120.0).clip(true))
        .column(Column::initial(100.0).at_least(60.0))
        .column(Column::initial(100.0).at_least(60.0))
        .column(Column::remainder().at_least(100.0))
        .header(22.0, |mut h| {
            for t in ["Trend", "Path", "Before", "After", "Difference"] {
                h.col(|ui| {
                    ui.label(RichText::new(tr(t)).strong());
                });
            }
        })
        .body(|body| {
            body.rows(20.0, changes.len().min(2000), |mut row| {
                let c = &changes[row.index()];
                let (kind, col) = match c.kind {
                    ChangeKind::Added => ("new", up),
                    ChangeKind::Removed => ("deleted", down),
                    ChangeKind::Changed => (if c.delta() >= 0 { "grew" } else { "shrank" }, if c.delta() >= 0 { up } else { down }),
                };
                row.col(|ui| {
                    ui.label(RichText::new(tr(kind)).color(col));
                });
                row.col(|ui| {
                    let p = if c.path.is_empty() { root.to_string() } else { c.path.replace('/', "\\") };
                    ui.add(egui::Label::new(p).truncate());
                });
                row.col(|ui| {
                    ui.label(format_bytes(c.old_size));
                });
                row.col(|ui| {
                    ui.label(format_bytes(c.new_size));
                });
                row.col(|ui| {
                    ui.label(RichText::new(signed_bytes(c.delta())).color(col));
                });
                if row.response().double_clicked() && c.kind != ChangeKind::Removed {
                    let rel = c.path.replace('/', "\\");
                    open = Some(if rel.is_empty() { root.to_string() } else { format!("{}\\{}", root.trim_end_matches('\\'), rel) });
                }
            });
        });
    open
}

/// `+1,5 Go` / `-300 Ko` / `0 Octets`.
pub fn signed_bytes(d: i64) -> String {
    match d.cmp(&0) {
        std::cmp::Ordering::Greater => format!("+{}", format_bytes(d as u64)),
        std::cmp::Ordering::Less => format!("-{}", format_bytes(d.unsigned_abs())),
        std::cmp::Ordering::Equal => format_bytes(0),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanRow {
    pub id: NodeId,
    pub kind: String,
    pub path: String,
    pub size: u64,
}

/// Table of clean-up candidates; single click selects, double click opens in Explorer.
pub fn cleanup_list(ui: &mut egui::Ui, rows: &[CleanRow], selected: Option<NodeId>) -> Option<ListEvent> {
    let mut ev = None;
    ui.push_id("cleanup", |ui| {
        // Selectable labels would swallow the click that selects the row.
        ui.style_mut().interaction.selectable_labels = false;
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .sense(Sense::click())
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::initial(190.0).at_least(80.0).clip(true))
            .column(Column::initial(520.0).at_least(120.0).clip(true))
            .column(Column::remainder().at_least(80.0))
            .header(22.0, |mut h| {
                for t in ["Category", "Path", "Size"] {
                    h.col(|ui| {
                        ui.label(RichText::new(tr(t)).strong());
                    });
                }
            })
            .body(|body| {
                body.rows(20.0, rows.len(), |mut row| {
                    let r = &rows[row.index()];
                    row.set_selected(selected == Some(r.id));
                    row.col(|ui| {
                        ui.label(&r.kind);
                    });
                    row.col(|ui| {
                        ui.add(egui::Label::new(r.path.as_str()).truncate());
                    });
                    row.col(|ui| {
                        ui.label(format_bytes(r.size));
                    });
                    let resp = row.response();
                    if let Some(m) = row_menu(&resp, r.id) {
                        ev = Some(m);
                    }
                    if resp.double_clicked() {
                        ev = Some(ListEvent::Open(r.id));
                    } else if resp.clicked() {
                        ev = Some(ListEvent::Select(r.id));
                    }
                });
            });
    });
    ev
}

/// Size per last-modified age, drawn as horizontal bars.
pub fn age_view(ui: &mut egui::Ui, buckets: &[crate::analysis::insights::AgeBucket]) {
    let total: u64 = buckets.iter().map(|b| b.size).sum::<u64>().max(1);
    let max = buckets.iter().map(|b| b.size).max().unwrap_or(1).max(1);
    ui.label(RichText::new(tr("Size by last modification")).strong());
    ui.add_space(6.0);
    let bar_col = Color32::from_rgb(90, 110, 220);
    for b in buckets {
        ui.horizontal(|ui| {
            ui.add_sized([170.0, 22.0], egui::Label::new(tr(b.label)));
            let w = (ui.available_width() - 330.0).max(60.0);
            let (rect, _) = ui.allocate_exact_size(egui::vec2(w, 18.0), Sense::hover());
            ui.painter().rect_filled(rect, 0.0, ui.visuals().extreme_bg_color);
            let mut fill = rect;
            fill.set_width(rect.width() * b.size as f32 / max as f32);
            ui.painter().rect_filled(fill, 0.0, bar_col);
            ui.add_sized([90.0, 22.0], egui::Label::new(format_bytes(b.size)));
            ui.add_sized([60.0, 22.0], egui::Label::new(format!("{:.1} %", b.size as f64 * 100.0 / total as f64)));
            ui.label(format!("{} {}", crate::fmt::group_int(b.files), tr("Files")));
        });
    }
}

/// Total size of the scanned folder at each recorded scan (newest on the right), as bars.
fn size_history_chart(ui: &mut egui::Ui, points: &[crate::analysis::snapshot::HistoryPoint]) {
    let pts = &points[points.len().saturating_sub(40)..];
    let max = pts.iter().map(|p| p.size).max().unwrap_or(1).max(1);
    let min = pts.iter().map(|p| p.size).min().unwrap_or(0);
    ui.label(RichText::new(tr("Size over time")).strong());
    let (resp, painter) = ui.allocate_painter(egui::vec2(ui.available_width().min(900.0), 90.0), Sense::hover());
    let area = resp.rect;
    painter.rect_filled(area, 2.0, ui.visuals().extreme_bg_color);
    let slot = area.width() / pts.len() as f32;
    // Bars start at 60 % of the smallest value so small drifts stay visible.
    let floor = (min as f64 * 0.6) as u64;
    let span = (max - floor).max(1) as f64;
    let hover = resp.hover_pos();
    let mut tip = None;
    for (i, p) in pts.iter().enumerate() {
        let h = ((p.size - floor) as f64 / span) as f32 * (area.height() - 8.0);
        let r = egui::Rect::from_min_max(egui::pos2(area.min.x + i as f32 * slot + 1.0, area.max.y - h - 2.0), egui::pos2(area.min.x + (i + 1) as f32 * slot - 1.0, area.max.y - 2.0));
        let latest = i + 1 == pts.len();
        painter.rect_filled(r, 1.0, if latest { Color32::from_rgb(110, 130, 240) } else { Color32::from_rgb(70, 88, 190) });
        if hover.is_some_and(|h| h.x >= r.min.x - 1.0 && h.x <= r.max.x + 1.0) {
            tip = Some(*p);
        }
    }
    if let Some(p) = tip {
        resp.on_hover_text_at_pointer(format!("{}\n{} - {} {}", format_time(p.taken), format_bytes(p.size), crate::fmt::group_int(p.files), tr("Files")));
    }
}

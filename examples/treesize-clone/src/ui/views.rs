//! Secondary views: treemap, folder chart, file types, ranked file lists.

use super::treemap::{hit_test, pie_angles, squarify, Rect as TRect};
use crate::i18n::tr;
use crate::analysis::types::{category_of_name, top_children, Category, TypeStat};
use crate::scan::model::RankedFile;
use crate::scan::{format_bytes, format_time, NodeId, Tree, NONE};
use eframe::egui::{self, Color32, RichText, Sense};
use egui_extras::{Column, TableBuilder};

const MAX_TILES: usize = 4000;

pub enum ListEvent {
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

/// Folder tiles get a stable, name-derived pastel colour; files use their category colour.
fn tile_color(tree: &Tree, id: NodeId) -> Color32 {
    let n = tree.get(id);
    if n.is_link {
        return Color32::from_rgb(150, 150, 200);
    }
    if n.is_dir {
        let h = n.name.bytes().fold(7u32, |a, b| a.wrapping_mul(31).wrapping_add(b as u32));
        let hue = (h % 360) as f32 / 360.0;
        return Color32::from(egui::ecolor::Hsva::new(hue, 0.35, 0.85, 1.0));
    }
    category_color(category_of_name(&n.name))
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

pub fn treemap_view(ui: &mut egui::Ui, tree: &Tree, root: &mut NodeId, selected: &mut Option<NodeId>) {
    breadcrumb(ui, tree, root);
    let mut kids: Vec<NodeId> = tree.get(*root).children.iter().copied().filter(|&c| tree.get(c).size > 0).collect();
    kids.sort_by(|&a, &b| tree.get(b).size.cmp(&tree.get(a).size).then(a.cmp(&b)));
    kids.truncate(MAX_TILES);
    let (resp, painter) = ui.allocate_painter(ui.available_size(), Sense::click());
    let area = resp.rect;
    painter.rect_filled(area, 0.0, ui.visuals().extreme_bg_color);
    if kids.is_empty() {
        painter.text(area.center(), egui::Align2::CENTER_CENTER, tr("Nothing to show"), egui::FontId::proportional(14.0), ui.visuals().text_color());
        return;
    }
    let sizes: Vec<u64> = kids.iter().map(|&k| tree.get(k).size).collect();
    let rects = squarify(&sizes, TRect::new(0.0, 0.0, area.width(), area.height()));
    let hit = resp.hover_pos().and_then(|p| hit_test(&rects, p.x - area.min.x, p.y - area.min.y));
    for (i, r) in rects.iter().enumerate() {
        if r.w <= 0.0 || r.h <= 0.0 {
            continue;
        }
        let rect = egui::Rect::from_min_size(area.min + egui::vec2(r.x, r.y), egui::vec2(r.w, r.h));
        let mut fill = tile_color(tree, kids[i]);
        if hit == Some(i) {
            fill = fill.gamma_multiply(1.25);
        }
        painter.rect_filled(rect.shrink(0.5), 0.0, fill);
        if r.w > 56.0 && r.h > 16.0 {
            let label = if r.h > 32.0 {
                format!("{}
{}", tree.get(kids[i]).name, format_bytes(tree.get(kids[i]).size))
            } else {
                tree.get(kids[i]).name.clone()
            };
            painter.with_clip_rect(rect).text(
                rect.min + egui::vec2(3.0, 2.0),
                egui::Align2::LEFT_TOP,
                label,
                egui::FontId::proportional(11.0),
                Color32::BLACK,
            );
        }
    }
    if let Some(i) = hit {
        let id = kids[i];
        let n = tree.get(id);
        let total = tree.get(*root).size.max(1);
        resp.clone().on_hover_text_at_pointer(format!(
            "{}\n{} ({:.1}% {} {})",
            tree.path_of(id).display(),
            format_bytes(n.size),
            n.size as f64 * 100.0 / total as f64,
            tr("of"),
            tree.get(*root).name
        ));
        if resp.clicked() {
            *selected = Some(id);
            if n.is_dir && !n.children.is_empty() {
                *root = id;
            }
        }
    }
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
pub fn compare_view(ui: &mut egui::Ui, cmp: Option<(&str, i64, &[crate::analysis::snapshot::DirDelta])>, notice: &str, root: Option<&str>) -> Option<String> {
    use crate::analysis::snapshot::ChangeKind;
    if !notice.is_empty() {
        ui.label(notice);
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
            for t in ["Change", "Path", "Before", "After", "Difference"] {
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

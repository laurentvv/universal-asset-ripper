//! Small vector glyphs drawn with the egui painter (no bitmap artwork needed): folder, file page,
//! ribbon icons, sort arrow, error badge and the blue/violet gradient bars.

use eframe::egui::{self, pos2, vec2, Color32, Painter, Pos2, Rect, Shape, Stroke, StrokeKind};

/// Yellow folder (links are drawn violet-grey).
pub fn folder(p: &Painter, r: Rect, link: bool) {
    let (body, tab) = if link {
        (Color32::from_rgb(150, 150, 205), Color32::from_rgb(120, 120, 175))
    } else {
        (Color32::from_rgb(250, 200, 60), Color32::from_rgb(222, 164, 30))
    };
    let tab_r = Rect::from_min_size(r.min + vec2(0.0, r.height() * 0.1), vec2(r.width() * 0.45, r.height() * 0.3));
    p.rect_filled(tab_r, 1.5, tab);
    let body_r = Rect::from_min_max(r.min + vec2(0.0, r.height() * 0.28), r.max);
    p.rect_filled(body_r, 1.5, body);
    p.line_segment([body_r.left_top() + vec2(1.0, 1.0), body_r.right_top() + vec2(-1.0, 1.0)], Stroke::new(1.0, Color32::from_rgb(255, 232, 140)));
}

/// White page with a folded corner and text lines: the "[N Files]" pseudo-row.
pub fn page(p: &Painter, r: Rect, lines: bool) {
    let fold = r.width() * 0.35;
    let pts = vec![r.left_top(), pos2(r.right() - fold, r.top()), pos2(r.right(), r.top() + fold), r.right_bottom(), r.left_bottom()];
    p.add(Shape::convex_polygon(pts, Color32::from_rgb(245, 245, 245), Stroke::new(1.0, Color32::from_rgb(120, 120, 120))));
    p.add(Shape::convex_polygon(
        vec![pos2(r.right() - fold, r.top()), pos2(r.right(), r.top() + fold), pos2(r.right() - fold, r.top() + fold)],
        Color32::from_rgb(200, 200, 200),
        Stroke::NONE,
    ));
    if lines {
        for i in 0..3 {
            let y = r.top() + r.height() * (0.5 + 0.17 * i as f32);
            p.line_segment([pos2(r.left() + 2.5, y), pos2(r.right() - 2.5, y)], Stroke::new(1.0, Color32::from_rgb(140, 140, 140)));
        }
    }
}

/// Horizontal left-to-right colour ramp.
pub fn gradient(p: &Painter, r: Rect, left: Color32, right: Color32) {
    if r.width() <= 0.5 || r.height() <= 0.5 {
        return;
    }
    let mut m = egui::Mesh::default();
    m.colored_vertex(r.left_top(), left);
    m.colored_vertex(r.right_top(), right);
    m.colored_vertex(r.right_bottom(), right);
    m.colored_vertex(r.left_bottom(), left);
    m.add_triangle(0, 1, 2);
    m.add_triangle(0, 2, 3);
    p.add(Shape::mesh(m));
}

/// Small filled triangle: sort direction (`desc` points down).
pub fn sort_arrow(p: &Painter, c: Pos2, desc: bool, col: Color32) {
    let (w, h) = (4.5, 3.0);
    let pts = if desc {
        vec![pos2(c.x - w, c.y - h), pos2(c.x + w, c.y - h), pos2(c.x, c.y + h)]
    } else {
        vec![pos2(c.x - w, c.y + h), pos2(c.x + w, c.y + h), pos2(c.x, c.y - h)]
    };
    p.add(Shape::convex_polygon(pts, col, Stroke::NONE));
}

/// Red round badge with a white cross (scan errors).
pub fn error_badge(p: &Painter, c: Pos2, r: f32) {
    p.circle_filled(c, r, Color32::from_rgb(222, 70, 40));
    let k = r * 0.42;
    let s = Stroke::new(1.5, Color32::WHITE);
    p.line_segment([c + vec2(-k, -k), c + vec2(k, k)], s);
    p.line_segment([c + vec2(-k, k), c + vec2(k, -k)], s);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Folder,
    Stop,
    Refresh,
    Bars,
    Drive,
    Percent,
    Files,
    Up,
    Filter,
    Export,
    Expand,
    Tree,
    Treemap,
    Chart,
    Types,
    Top,
    Oldest,
    Dupes,
    Options,
    About,
    Details,
    Bolt,
    Units,
    Open,
    Exclude,
}

/// Draw `icon` inside `r` (about 28 px). `enabled` greys the glyph out.
pub fn icon(p: &Painter, r: Rect, ic: Icon, enabled: bool) {
    let g = |c: Color32| if enabled { c } else { c.gamma_multiply(0.35) };
    let blue = g(Color32::from_rgb(70, 160, 235));
    let grey = g(Color32::from_rgb(160, 160, 165));
    let dark = g(Color32::from_rgb(90, 90, 100));
    let white = g(Color32::from_rgb(240, 240, 240));
    let c = r.center();
    let s = r.width().min(r.height());
    let u = s / 28.0;
    let st = |w: f32, col: Color32| Stroke::new(w * u.max(0.8), col);
    match ic {
        Icon::Folder | Icon::Open => {
            let rr = Rect::from_center_size(c, vec2(s * 0.95, s * 0.75));
            if enabled {
                folder(p, rr, false);
            } else {
                p.rect_filled(rr, 2.0, grey);
            }
        }
        Icon::Stop => {
            p.circle_filled(c, s * 0.42, grey);
            p.rect_filled(Rect::from_center_size(c, vec2(s * 0.28, s * 0.28)), 1.0, dark);
        }
        Icon::Refresh => {
            p.circle_filled(c, s * 0.46, grey);
            let n = 18;
            let pts: Vec<Pos2> = (0..=n)
                .map(|i| {
                    let a = -0.4 + 4.6 * i as f32 / n as f32;
                    c + vec2(a.cos(), a.sin()) * s * 0.26
                })
                .collect();
            p.add(Shape::line(pts, st(2.4, white)));
            let tip = c + vec2((-0.4f32).cos(), (-0.4f32).sin()) * s * 0.26;
            p.add(Shape::convex_polygon(vec![tip + vec2(-4.0 * u, -4.0 * u), tip + vec2(5.0 * u, -u), tip + vec2(-3.0 * u, 5.0 * u)], white, Stroke::NONE));
        }
        Icon::Bars | Icon::Top => {
            let w = s * 0.2;
            for (i, h) in [0.85f32, 0.6, 0.38].iter().enumerate() {
                let x = r.left() + s * 0.12 + i as f32 * (w + s * 0.06);
                let col = if i == 0 { blue } else { grey };
                p.rect_filled(Rect::from_min_max(pos2(x, r.bottom() - s * h), pos2(x + w, r.bottom() - s * 0.08)), 1.0, col);
            }
        }
        Icon::Drive => {
            let rr = Rect::from_center_size(c, vec2(s * 0.95, s * 0.5));
            p.rect_filled(rr, 3.0, grey);
            p.rect_filled(Rect::from_min_max(rr.left_top() + vec2(0.0, rr.height() * 0.15), rr.right_top() + vec2(0.0, rr.height() * 0.45)), 2.0, white);
            p.circle_filled(rr.right_bottom() + vec2(-5.0 * u, -4.0 * u), 1.6 * u, blue);
        }
        Icon::Percent => {
            p.text(c, egui::Align2::CENTER_CENTER, "%", egui::FontId::proportional(s * 1.0), blue);
        }
        Icon::Files | Icon::Dupes | Icon::Types => {
            let rr = Rect::from_center_size(c, vec2(s * 0.62, s * 0.85));
            if ic == Icon::Dupes {
                page(p, rr.translate(vec2(-s * 0.12, -s * 0.06)), false);
                page(p, rr.translate(vec2(s * 0.12, s * 0.06)), true);
            } else {
                page(p, rr, true);
                if ic == Icon::Types {
                    p.rect_filled(Rect::from_center_size(rr.center_bottom() + vec2(0.0, -2.0 * u), vec2(s * 0.5, s * 0.2)), 2.0, blue);
                }
            }
        }
        Icon::Up => {
            p.add(Shape::convex_polygon(vec![pos2(c.x, c.y - s * 0.4), pos2(c.x + s * 0.4, c.y + s * 0.05), pos2(c.x + s * 0.14, c.y + s * 0.05), pos2(c.x + s * 0.14, c.y + s * 0.4), pos2(c.x - s * 0.14, c.y + s * 0.4), pos2(c.x - s * 0.14, c.y + s * 0.05), pos2(c.x - s * 0.4, c.y + s * 0.05)], blue, Stroke::NONE));
        }
        Icon::Filter => {
            p.add(Shape::convex_polygon(vec![pos2(c.x - s * 0.42, c.y - s * 0.38), pos2(c.x + s * 0.42, c.y - s * 0.38), pos2(c.x + s * 0.07, c.y + s * 0.02), pos2(c.x + s * 0.07, c.y + s * 0.4), pos2(c.x - s * 0.07, c.y + s * 0.3), pos2(c.x - s * 0.07, c.y + s * 0.02)], blue, Stroke::NONE));
        }
        Icon::Export => {
            page(p, Rect::from_center_size(c + vec2(-s * 0.06, 0.0), vec2(s * 0.58, s * 0.82)), false);
            p.add(Shape::convex_polygon(vec![pos2(c.x + s * 0.1, c.y - s * 0.1), pos2(c.x + s * 0.45, c.y + s * 0.15), pos2(c.x + s * 0.1, c.y + s * 0.4)], blue, Stroke::NONE));
        }
        Icon::Expand => {
            let rr = Rect::from_center_size(c, vec2(s * 0.7, s * 0.7));
            p.rect_stroke(rr, 2.0, st(1.6, grey), StrokeKind::Inside);
            p.line_segment([c + vec2(-s * 0.2, 0.0), c + vec2(s * 0.2, 0.0)], st(2.0, blue));
            p.line_segment([c + vec2(0.0, -s * 0.2), c + vec2(0.0, s * 0.2)], st(2.0, blue));
        }
        Icon::Tree | Icon::Details => {
            for i in 0..4 {
                let y = r.top() + s * (0.18 + 0.2 * i as f32);
                let x0 = if ic == Icon::Tree { r.left() + s * 0.1 + if i % 2 == 1 { s * 0.2 } else { 0.0 } } else { r.left() + s * 0.1 };
                p.line_segment([pos2(x0, y), pos2(r.right() - s * 0.1, y)], st(2.0, if i == 0 { blue } else { grey }));
            }
        }
        Icon::Treemap => {
            let rr = Rect::from_center_size(c, vec2(s * 0.9, s * 0.8));
            let cols = [blue, grey, g(Color32::from_rgb(220, 170, 60)), g(Color32::from_rgb(110, 190, 120))];
            let mid = rr.center();
            p.rect_filled(Rect::from_min_max(rr.min, mid + vec2(-1.0, s * 0.1)), 1.0, cols[0]);
            p.rect_filled(Rect::from_min_max(pos2(mid.x + 1.0, rr.top()), pos2(rr.right(), mid.y + s * 0.1)), 1.0, cols[1]);
            p.rect_filled(Rect::from_min_max(pos2(rr.left(), mid.y + s * 0.1 + 2.0), pos2(mid.x - s * 0.1, rr.bottom())), 1.0, cols[2]);
            p.rect_filled(Rect::from_min_max(pos2(mid.x - s * 0.1 + 2.0, mid.y + s * 0.1 + 2.0), rr.max), 1.0, cols[3]);
        }
        Icon::Chart => {
            p.circle_filled(c, s * 0.42, grey);
            p.add(Shape::convex_polygon(vec![c, c + vec2(0.0, -s * 0.42), c + vec2(s * 0.3, -s * 0.3), c + vec2(s * 0.42, 0.0)], blue, Stroke::NONE));
        }
        Icon::Oldest => {
            p.circle_stroke(c, s * 0.4, st(2.0, grey));
            p.line_segment([c, c + vec2(0.0, -s * 0.26)], st(2.0, blue));
            p.line_segment([c, c + vec2(s * 0.18, s * 0.08)], st(2.0, blue));
        }
        Icon::Options => {
            for i in 0..8 {
                let a = i as f32 * std::f32::consts::TAU / 8.0;
                p.line_segment([c + vec2(a.cos(), a.sin()) * s * 0.3, c + vec2(a.cos(), a.sin()) * s * 0.46], st(3.0, grey));
            }
            p.circle_filled(c, s * 0.34, grey);
            p.circle_filled(c, s * 0.14, g(Color32::from_rgb(40, 40, 45)));
        }
        Icon::About => {
            p.circle_filled(c, s * 0.44, blue);
            p.text(c, egui::Align2::CENTER_CENTER, "i", egui::FontId::proportional(s * 0.7), white);
        }
        Icon::Bolt => {
            p.add(Shape::convex_polygon(vec![pos2(c.x + s * 0.1, c.y - s * 0.45), pos2(c.x - s * 0.3, c.y + s * 0.08), pos2(c.x - s * 0.02, c.y + s * 0.08), pos2(c.x - s * 0.12, c.y + s * 0.45), pos2(c.x + s * 0.32, c.y - s * 0.12), pos2(c.x + s * 0.03, c.y - s * 0.12)], g(Color32::from_rgb(240, 190, 50)), Stroke::NONE));
        }
        Icon::Units => {
            p.text(c, egui::Align2::CENTER_CENTER, "KB", egui::FontId::proportional(s * 0.5), blue);
        }
        Icon::Exclude => {
            p.circle_filled(c, s * 0.42, g(Color32::from_rgb(200, 70, 60)));
            p.line_segment([c + vec2(-s * 0.22, 0.0), c + vec2(s * 0.22, 0.0)], st(3.0, white));
        }
    }
}

//! Pure layout maths for the treemap (squarified, nested) and the pie chart. No egui types.

use crate::scan::{NodeId, Tree};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const ZERO: Rect = Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 };

    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub fn area(&self) -> f32 {
        self.w * self.h
    }

    pub fn contains(&self, px: f32, py: f32) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }
}

/// Worst aspect ratio of a row with total area `sum`, extreme areas `rmin`/`rmax`,
/// laid along a side of length `side`.
fn worst(sum: f64, rmin: f64, rmax: f64, side: f64) -> f64 {
    let s2 = sum * sum;
    let w2 = side * side;
    (w2 * rmax / s2).max(s2 / (w2 * rmin))
}

/// Squarified treemap (Bruls, Huizing, van Wijk). `sizes` should be sorted descending for the
/// best aspect ratios; the result has one rectangle per input, in the same order.
/// Zero-sized items get `Rect::ZERO`. Rectangle areas are proportional to the sizes and tile `bounds`.
pub fn squarify(sizes: &[u64], bounds: Rect) -> Vec<Rect> {
    let mut out = vec![Rect::ZERO; sizes.len()];
    let idx: Vec<usize> = (0..sizes.len()).filter(|&i| sizes[i] > 0).collect();
    let total: f64 = idx.iter().map(|&i| sizes[i] as f64).sum();
    if idx.is_empty() || bounds.w <= 0.0 || bounds.h <= 0.0 {
        return out;
    }
    let scale = bounds.area() as f64 / total;
    let area = |i: usize| sizes[i] as f64 * scale;
    let mut rem = bounds;
    let mut i = 0;
    while i < idx.len() {
        let short = rem.w.min(rem.h) as f64;
        let mut sum = 0.0;
        let (mut rmin, mut rmax) = (f64::MAX, 0.0f64);
        let mut best = f64::MAX;
        let mut j = i;
        while j < idx.len() {
            let a = area(idx[j]);
            let (nmin, nmax, nsum) = (rmin.min(a), rmax.max(a), sum + a);
            let w = worst(nsum, nmin, nmax, short);
            if j > i && w > best {
                break;
            }
            best = w;
            rmin = nmin;
            rmax = nmax;
            sum = nsum;
            j += 1;
        }
        // Lay out idx[i..j] as a strip along the short side.
        let last_row = j >= idx.len();
        if rem.w >= rem.h {
            // vertical strip on the left
            let sw = if last_row { rem.w } else { (sum / rem.h as f64) as f32 };
            let mut y = rem.y;
            for (k, &ii) in idx[i..j].iter().enumerate() {
                let h = if k + 1 == j - i { rem.y + rem.h - y } else { (area(ii) / sw as f64) as f32 };
                out[ii] = Rect::new(rem.x, y, sw, h);
                y += h;
            }
            rem = Rect::new(rem.x + sw, rem.y, (rem.w - sw).max(0.0), rem.h);
        } else {
            // horizontal strip on top
            let sh = if last_row { rem.h } else { (sum / rem.w as f64) as f32 };
            let mut x = rem.x;
            for (k, &ii) in idx[i..j].iter().enumerate() {
                let wd = if k + 1 == j - i { rem.x + rem.w - x } else { (area(ii) / sh as f64) as f32 };
                out[ii] = Rect::new(x, rem.y, wd, sh);
                x += wd;
            }
            rem = Rect::new(rem.x, rem.y + sh, rem.w, (rem.h - sh).max(0.0));
        }
        i = j;
    }
    out
}

/// Pie slices as `(start, end)` angles in radians, starting at `-PI/2` (12 o'clock), clockwise.
pub fn pie_angles(values: &[u64]) -> Vec<(f32, f32)> {
    let total: f64 = values.iter().map(|&v| v as f64).sum();
    let start = -std::f32::consts::FRAC_PI_2;
    if total <= 0.0 {
        return vec![(start, start); values.len()];
    }
    let mut acc = 0.0f64;
    values
        .iter()
        .map(|&v| {
            let a = start + (acc / total * std::f64::consts::TAU) as f32;
            acc += v as f64;
            let b = start + (acc / total * std::f64::consts::TAU) as f32;
            (a, b)
        })
        .collect()
}

/// Height of the caption strip of a folder tile.
pub const HEADER_H: f32 = 15.0;
const PAD: f32 = 2.0;

/// One tile of the nested treemap.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tile {
    /// Folder (or file) shown; for a `[N Files]` tile the folder that owns those files.
    pub id: NodeId,
    pub rect: Rect,
    /// Nesting level (0 = the folder being shown).
    pub depth: u8,
    /// The tile stands for the direct files of folder `id` (one aggregated block).
    pub files_of: bool,
    /// Children are laid out inside this tile, below a caption strip.
    pub has_header: bool,
}

/// Nested squarified layout: every folder holds its sub-folders and one aggregated tile for its
/// direct files, down to `max_depth` levels. Parents come before their children. Tiles smaller
/// than a few pixels are dropped and the total is capped at `max_tiles`.
pub fn nested(tree: &Tree, root: NodeId, area: Rect, max_depth: u8, max_tiles: usize) -> Vec<Tile> {
    let mut out = Vec::new();
    if tree.nodes.is_empty() || area.w < 4.0 || area.h < 4.0 || tree.get(root).size == 0 {
        return out;
    }
    place_dir(tree, root, area, 0, max_depth, max_tiles, &mut out);
    out
}

fn place_dir(tree: &Tree, id: NodeId, rect: Rect, depth: u8, max_depth: u8, max_tiles: usize, out: &mut Vec<Tile>) {
    let node = tree.get(id);
    let can_nest = depth < max_depth && rect.w > 36.0 && rect.h > HEADER_H + 14.0 && node.is_dir && !node.children.is_empty();
    out.push(Tile { id, rect, depth, files_of: false, has_header: can_nest });
    if !can_nest {
        return;
    }
    let inner = Rect::new(rect.x + PAD, rect.y + HEADER_H, (rect.w - 2.0 * PAD).max(0.0), (rect.h - HEADER_H - PAD).max(0.0));
    // Children: folders by size, then the aggregated files block.
    let mut items: Vec<(NodeId, u64, bool)> = node.children.iter().copied().filter(|&c| tree.get(c).is_dir && tree.get(c).size > 0).map(|c| (c, tree.get(c).size, false)).collect();
    let files = tree.direct_files(id);
    if files.size > 0 {
        items.push((id, files.size, true));
    }
    items.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    items.truncate(400);
    let sizes: Vec<u64> = items.iter().map(|i| i.1).collect();
    let rects = squarify(&sizes, inner);
    for (item, r) in items.iter().zip(rects) {
        if r.w < 3.0 || r.h < 3.0 || out.len() >= max_tiles {
            continue;
        }
        if item.2 {
            out.push(Tile { id: item.0, rect: r, depth: depth + 1, files_of: true, has_header: false });
        } else {
            place_dir(tree, item.0, r, depth + 1, max_depth, max_tiles, out);
        }
    }
}

/// Topmost (deepest) tile under the point.
pub fn tile_at(tiles: &[Tile], px: f32, py: f32) -> Option<usize> {
    tiles.iter().rposition(|t| t.rect.contains(px, py))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_tiles_stay_inside_their_parent_and_siblings_do_not_overlap() {
        let d = tempfile::tempdir().unwrap();
        for (p, n) in [("a/x/f1.bin", 4000), ("a/y/f2.bin", 2000), ("a/top.bin", 1000), ("b/f3.bin", 3000), ("b/z/f4.bin", 500)] {
            let path = d.path().join(p);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, vec![0u8; n]).unwrap();
        }
        let tree = crate::scan::scan_simple(d.path()).tree;
        let area = Rect::new(0.0, 0.0, 800.0, 500.0);
        let tiles = nested(&tree, Tree::ROOT, area, 3, 1000);
        assert_eq!(tiles[0].depth, 0);
        assert_eq!(tiles[0].rect, area);
        // Every tile is inside the root and inside the nearest preceding shallower tile.
        for (i, t) in tiles.iter().enumerate().skip(1) {
            let parent = tiles[..i].iter().rev().find(|p| p.depth + 1 == t.depth).expect("parent before child");
            let (pr, r) = (parent.rect, t.rect);
            assert!(r.x >= pr.x - 0.01 && r.y >= pr.y + HEADER_H - 0.01 && r.x + r.w <= pr.x + pr.w + 0.01 && r.y + r.h <= pr.y + pr.h + 0.01, "tile {i} escapes its parent");
        }
        // Siblings (same parent) never overlap.
        for i in 0..tiles.len() {
            for j in i + 1..tiles.len() {
                if tiles[i].depth == tiles[j].depth && tiles[i].depth > 0 {
                    let (a, b) = (tiles[i].rect, tiles[j].rect);
                    let eps = 1e-2;
                    let ov = a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
                    assert!(!ov, "tiles {i} and {j} overlap");
                }
            }
        }
        // Folder a (7000 bytes) is bigger than b (3500): bigger tile.
        let area_of = |name: &str| tiles.iter().find(|t| !t.files_of && t.depth == 1 && tree.get(t.id).name == name).map(|t| t.rect.area()).unwrap();
        assert!(area_of("a") > area_of("b") * 1.8 && area_of("a") < area_of("b") * 2.2, "areas follow sizes (7000 vs 3500)");
        // The aggregated files tile of `a` exists with the owning folder id.
        assert!(tiles.iter().any(|t| t.files_of && tree.get(t.id).name == "a"));
        assert!(tile_at(&tiles, 400.0, 250.0).is_some());
        assert!(nested(&tree, Tree::ROOT, Rect::new(0.0, 0.0, 2.0, 2.0), 3, 100).is_empty());
    }

    #[test]
    fn nested_respects_depth_and_tile_cap() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..30 {
            let path = d.path().join(format!("dir{i}/sub/f.bin"));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, vec![0u8; 100 + i]).unwrap();
        }
        let tree = crate::scan::scan_simple(d.path()).tree;
        let area = Rect::new(0.0, 0.0, 900.0, 600.0);
        assert!(nested(&tree, Tree::ROOT, area, 0, 1000).len() == 1, "depth 0: just the root");
        assert!(nested(&tree, Tree::ROOT, area, 3, 10).len() <= 10 + 1);
        assert!(nested(&tree, Tree::ROOT, area, 3, 1000).iter().all(|t| t.depth <= 3));
    }

    fn overlap(a: &Rect, b: &Rect) -> bool {
        let eps = 1e-2;
        a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps
    }

    fn check_tiling(sizes: &[u64], bounds: Rect) -> Vec<Rect> {
        let rs = squarify(sizes, bounds);
        assert_eq!(rs.len(), sizes.len());
        let total: u64 = sizes.iter().sum();
        let mut sum_area = 0.0f64;
        for (i, r) in rs.iter().enumerate() {
            if sizes[i] == 0 {
                assert_eq!(*r, Rect::ZERO);
                continue;
            }
            assert!(r.x >= bounds.x - 1e-2 && r.y >= bounds.y - 1e-2);
            assert!(r.x + r.w <= bounds.x + bounds.w + 1e-2 && r.y + r.h <= bounds.y + bounds.h + 1e-2);
            let expect = bounds.area() as f64 * sizes[i] as f64 / total as f64;
            let tol = expect * 1e-3 + 0.5;
            assert!((r.area() as f64 - expect).abs() < tol, "item {i}: {} vs {expect}", r.area());
            sum_area += r.area() as f64;
        }
        assert!((sum_area - bounds.area() as f64).abs() < bounds.area() as f64 * 1e-3);
        for i in 0..rs.len() {
            for j in i + 1..rs.len() {
                assert!(!overlap(&rs[i], &rs[j]), "rects {i} and {j} overlap: {:?} {:?}", rs[i], rs[j]);
            }
        }
        rs
    }

    #[test]
    fn tiles_bounds_without_overlap() {
        let b = Rect::new(10.0, 20.0, 600.0, 400.0);
        check_tiling(&[6, 6, 4, 3, 2, 2, 1], b);
        check_tiling(&[1000, 500, 250, 125, 60, 30, 15, 7, 3, 1], b);
        check_tiling(&[5, 5, 5, 5], b);
        check_tiling(&[1], b);
        check_tiling(&[9, 0, 3, 0], b);
        check_tiling(&[100; 50], Rect::new(0.0, 0.0, 300.0, 900.0)); // portrait
    }

    #[test]
    fn single_item_fills_bounds() {
        let b = Rect::new(0.0, 0.0, 100.0, 50.0);
        assert_eq!(squarify(&[42], b)[0], b);
    }

    #[test]
    fn aspect_ratios_are_reasonable() {
        let b = Rect::new(0.0, 0.0, 800.0, 600.0);
        let sizes: Vec<u64> = (1..=40).rev().map(|v| v * v).collect();
        let rs = check_tiling(&sizes, b);
        for (r, s) in rs.iter().zip(&sizes) {
            if *s > 50 {
                let ar = (r.w / r.h).max(r.h / r.w);
                assert!(ar < 6.0, "aspect {ar} for size {s}");
            }
        }
    }

    #[test]
    fn degenerate_inputs() {
        assert!(squarify(&[], Rect::new(0.0, 0.0, 10.0, 10.0)).is_empty());
        assert_eq!(squarify(&[0, 0], Rect::new(0.0, 0.0, 10.0, 10.0)), vec![Rect::ZERO; 2]);
        assert_eq!(squarify(&[5], Rect::new(0.0, 0.0, 0.0, 10.0)), vec![Rect::ZERO]);
    }

    #[test]
    fn pie_angles_cover_full_circle() {
        let a = pie_angles(&[1, 1, 2]);
        let tau = std::f32::consts::TAU;
        assert!((a[0].1 - a[0].0 - tau / 4.0).abs() < 1e-5);
        assert!((a[2].1 - a[2].0 - tau / 2.0).abs() < 1e-5);
        assert!((a[2].1 - a[0].0 - tau).abs() < 1e-5);
        assert_eq!(a[0].1, a[1].0);
        assert!(pie_angles(&[0, 0]).iter().all(|(s, e)| s == e));
    }
}

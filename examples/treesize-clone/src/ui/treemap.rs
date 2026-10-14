//! Pure layout maths for the treemap (squarified) and the pie chart. No egui types.

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

/// Index of the rectangle under the point, if any.
pub fn hit_test(rects: &[Rect], px: f32, py: f32) -> Option<usize> {
    rects.iter().position(|r| r.w > 0.0 && r.h > 0.0 && r.contains(px, py))
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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn hit_testing() {
        let b = Rect::new(0.0, 0.0, 100.0, 100.0);
        let rs = squarify(&[75, 25], b);
        assert_eq!(hit_test(&rs, 1.0, 1.0), Some(0));
        assert_eq!(hit_test(&rs, 99.0, 99.0), Some(1));
        assert_eq!(hit_test(&rs, 150.0, 5.0), None);
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

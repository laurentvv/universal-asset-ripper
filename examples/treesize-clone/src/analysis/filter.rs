//! Tree filters: name substring/glob, size range, modified range, extension list.

use crate::scan::{NodeId, Tree};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Filter {
    /// Substring (case-insensitive) or glob (`*`, `?`) when it contains a wildcard.
    pub name: String,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    /// Unix seconds; keep files modified at or after this instant.
    pub modified_after: Option<i64>,
    /// Unix seconds; keep files modified strictly before this instant.
    pub modified_before: Option<i64>,
    /// Lower-case extensions without dot.
    pub exts: Vec<String>,
}

impl Filter {
    pub fn is_empty(&self) -> bool {
        self.name.trim().is_empty()
            && self.min_size.is_none()
            && self.max_size.is_none()
            && self.modified_after.is_none()
            && self.modified_before.is_none()
            && self.exts.is_empty()
    }

    /// Does a file with these properties pass the filter?
    pub fn matches_file(&self, name: &str, size: u64, modified: i64) -> bool {
        let pat = self.name.trim();
        if !pat.is_empty() {
            let ok = if pat.contains(['*', '?']) {
                glob_match(pat, name)
            } else {
                name.to_lowercase().contains(&pat.to_lowercase())
            };
            if !ok {
                return false;
            }
        }
        if self.min_size.is_some_and(|m| size < m) || self.max_size.is_some_and(|m| size > m) {
            return false;
        }
        if self.modified_after.is_some_and(|t| modified < t) || self.modified_before.is_some_and(|t| modified >= t) {
            return false;
        }
        if !self.exts.is_empty() {
            let e = super::types::ext_of(name);
            if !self.exts.contains(&e) {
                return false;
            }
        }
        true
    }
}

/// Case-insensitive glob with `*` (any run) and `?` (one char).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            mark = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Parse "1024", "10KB", "1.5 MB", "2g" (binary multiples). Empty -> `Ok(None)`.
pub fn parse_size(s: &str) -> Result<Option<u64>, String> {
    let s = s.trim().to_ascii_lowercase();
    if s.is_empty() {
        return Ok(None);
    }
    let split = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: f64 = num.parse().map_err(|_| format!("bad size: {s}"))?;
    let mult: f64 = match unit.trim() {
        "" | "b" => 1.0,
        "k" | "kb" => 1024.0,
        "m" | "mb" => 1024.0 * 1024.0,
        "g" | "gb" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" => 1024.0_f64.powi(4),
        u => return Err(format!("unknown unit: {u}")),
    };
    Ok(Some((n * mult) as u64))
}

/// Parse `YYYY-MM-DD` as local midnight, returned as Unix seconds. Empty -> `Ok(None)`.
pub fn parse_date(s: &str) -> Result<Option<i64>, String> {
    use chrono::{NaiveDate, TimeZone};
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let d = NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("bad date (YYYY-MM-DD): {s}"))?;
    let dt = d.and_hms_opt(0, 0, 0).ok_or("bad date")?;
    chrono::Local
        .from_local_datetime(&dt)
        .earliest()
        .map(|t| Some(t.timestamp()))
        .ok_or_else(|| "date does not exist in local time".into())
}

/// "jpg, .PNG;gif" -> ["jpg","png","gif"].
pub fn parse_exts(s: &str) -> Vec<String> {
    s.split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .map(|e| e.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .collect()
}

/// Nodes to display under a filter: every matching file plus all its ancestors.
/// Directories themselves are never matched; they appear only as paths to matches.
pub fn matching_set(tree: &Tree, filter: &Filter) -> HashSet<NodeId> {
    let mut set = HashSet::new();
    if tree.nodes.is_empty() {
        return set;
    }
    // Iterative post-order over children (detached subtrees are never reached).
    let mut order: Vec<NodeId> = Vec::new();
    let mut stack = vec![Tree::ROOT];
    while let Some(id) = stack.pop() {
        order.push(id);
        stack.extend(tree.get(id).children.iter().copied());
    }
    for &id in order.iter().rev() {
        let n = tree.get(id);
        if n.is_dir {
            if n.children.iter().any(|c| set.contains(c)) {
                set.insert(id);
            }
        } else if filter.matches_file(&n.name, n.size, n.modified) {
            set.insert(id);
        }
    }
    set
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::types::testutil::tree_of;

    #[test]
    fn glob() {
        assert!(glob_match("*.JPG", "photo.jpg"));
        assert!(glob_match("a?c*", "abcdef"));
        assert!(!glob_match("a?c", "abcd"));
        assert!(glob_match("*", ""));
        assert!(!glob_match("*.png", "x.jpg"));
        assert!(glob_match("*a*b*", "xxaYYbZZ"));
    }

    #[test]
    fn size_and_exts_parsing() {
        assert_eq!(parse_size("").unwrap(), None);
        assert_eq!(parse_size("1024").unwrap(), Some(1024));
        assert_eq!(parse_size("1.5 MB").unwrap(), Some(1_572_864));
        assert_eq!(parse_size("2g").unwrap(), Some(2 << 30));
        assert!(parse_size("12 parsecs").is_err());
        assert!(parse_size("abc").is_err());
        assert_eq!(parse_exts("jpg, .PNG;gif  "), vec!["jpg", "png", "gif"]);
    }

    #[test]
    fn date_parsing() {
        let a = parse_date("2024-03-10").unwrap().unwrap();
        let b = parse_date("2024-03-11").unwrap().unwrap();
        let day = b - a;
        assert!((82_800..=90_000).contains(&day), "day length {day}"); // DST-tolerant
        assert!(parse_date("10/03/2024").is_err());
        assert_eq!(parse_date(" ").unwrap(), None);
    }

    #[test]
    fn matches_file_criteria() {
        let f = Filter { name: "img".into(), min_size: Some(100), max_size: Some(500), ..Default::default() };
        assert!(f.matches_file("MyIMG.png", 100, 0));
        assert!(!f.matches_file("MyIMG.png", 99, 0));
        assert!(!f.matches_file("MyIMG.png", 501, 0));
        assert!(!f.matches_file("other.png", 200, 0));
        let g = Filter { modified_after: Some(100), modified_before: Some(200), ..Default::default() };
        assert!(g.matches_file("a", 1, 100));
        assert!(g.matches_file("a", 1, 199));
        assert!(!g.matches_file("a", 1, 200));
        assert!(!g.matches_file("a", 1, 99));
        let e = Filter { exts: vec!["jpg".into()], ..Default::default() };
        assert!(e.matches_file("A.JPG", 1, 0));
        assert!(!e.matches_file("A.png", 1, 0));
        assert!(Filter::default().is_empty());
        assert!(!e.is_empty());
    }

    #[test]
    fn matching_set_includes_ancestors() {
        let t = tree_of(&[("a/x.jpg", 10, 1), ("a/y.txt", 20, 1), ("b/z.txt", 30, 1)]);
        let f = Filter { exts: vec!["jpg".into()], ..Default::default() };
        let s = matching_set(&t, &f);
        let a = t.find_child(0, "a").unwrap();
        let b = t.find_child(0, "b").unwrap();
        let x = t.find_child(a, "x.jpg").unwrap();
        let y = t.find_child(a, "y.txt").unwrap();
        assert!(s.contains(&0) && s.contains(&a) && s.contains(&x));
        assert!(!s.contains(&b) && !s.contains(&y));
    }

    #[test]
    fn empty_filter_matches_everything() {
        let t = tree_of(&[("a/x.jpg", 10, 1), ("b/z.txt", 30, 1)]);
        let s = matching_set(&t, &Filter::default());
        assert_eq!(s.len(), t.nodes.len());
    }
}

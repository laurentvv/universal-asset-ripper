//! In-memory tree model: an arena of nodes addressed by `u32` indices.

use crate::settings::Units;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

pub type NodeId = u32;
pub const NONE: NodeId = u32::MAX;

#[derive(Debug, Clone)]
pub struct Node {
    pub name: String,
    pub parent: NodeId,
    pub children: Vec<NodeId>,
    /// Logical size in bytes (aggregated for directories).
    pub size: u64,
    /// Size allocated on disk in bytes (aggregated for directories).
    pub alloc: u64,
    /// Number of files below (directories only; 0 for a file node).
    pub files: u64,
    /// Number of sub-directories below.
    pub dirs: u64,
    /// Last modified, seconds since Unix epoch (0 when unknown).
    pub modified: i64,
    /// Raw file attributes (Windows attribute bits; 0 elsewhere).
    pub attrs: u32,
    pub is_dir: bool,
    /// Symlink / junction / reparse point: listed but never followed.
    pub is_link: bool,
    /// Live-scan snapshots only: the directory is still being read (its totals are still growing).
    pub scanning: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
}

impl Tree {
    pub const ROOT: NodeId = 0;

    pub fn root(&self) -> Option<&Node> {
        self.nodes.first()
    }

    pub fn get(&self, id: NodeId) -> &Node {
        &self.nodes[id as usize]
    }

    /// Full path of a node; the root node's name is the scanned root path.
    pub fn path_of(&self, id: NodeId) -> PathBuf {
        let mut parts = Vec::new();
        let mut cur = id;
        while cur != NONE {
            let n = self.get(cur);
            parts.push(n.name.as_str());
            cur = n.parent;
        }
        let mut p = PathBuf::new();
        for part in parts.iter().rev() {
            p.push(part);
        }
        p
    }

    /// Names from the root's first child down to `id` (the root itself is the empty path).
    pub fn name_path(&self, id: NodeId) -> Vec<&str> {
        let mut parts = Vec::new();
        let mut cur = id;
        while cur != NONE && cur != Self::ROOT {
            let n = self.get(cur);
            parts.push(n.name.as_str());
            cur = n.parent;
        }
        parts.reverse();
        parts
    }

    /// Node reached by following `path` (names below the root); the inverse of `name_path`.
    pub fn resolve_path(&self, path: &[&str]) -> Option<NodeId> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut cur = Self::ROOT;
        for name in path {
            cur = self.find_child(cur, name)?;
        }
        Some(cur)
    }

    /// Detach a subtree from its parent and subtract its totals from all ancestors.
    pub fn remove_subtree(&mut self, id: NodeId) {
        if id == Self::ROOT || id as usize >= self.nodes.len() {
            return;
        }
        let (parent, size, alloc, files, dirs, is_dir) = {
            let n = self.get(id);
            (n.parent, n.size, n.alloc, n.files, n.dirs, n.is_dir)
        };
        if parent == NONE {
            return;
        }
        self.nodes[parent as usize].children.retain(|&c| c != id);
        self.nodes[id as usize].parent = NONE;
        let (df, dd) = if is_dir { (files, dirs + 1) } else { (1, 0) };
        let mut cur = parent;
        while cur != NONE {
            let a = &mut self.nodes[cur as usize];
            a.size = a.size.saturating_sub(size);
            a.alloc = a.alloc.saturating_sub(alloc);
            a.files = a.files.saturating_sub(df);
            a.dirs = a.dirs.saturating_sub(dd);
            cur = a.parent;
        }
    }

    #[allow(dead_code)]
    pub fn find_child(&self, parent: NodeId, name: &str) -> Option<NodeId> {
        self.get(parent)
            .children
            .iter()
            .copied()
            .find(|&c| self.get(c).name == name)
    }
}

/// Translate node ids of `old` into the equivalent ids of `new` by path (snapshots rebuild indices);
/// nodes that no longer exist are dropped.
pub fn remap_ids(old: &Tree, new: &Tree, ids: &HashSet<NodeId>) -> HashSet<NodeId> {
    ids.iter()
        .filter(|&&id| (id as usize) < old.nodes.len())
        .filter_map(|&id| new.resolve_path(&old.name_path(id)))
        .collect()
}

/// Normalise a bare drive such as "C:" to "C:\".
pub fn normalize_root(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.len() == 2 && s.ends_with(':') {
        PathBuf::from(format!("{}\\", s))
    } else {
        p.to_path_buf()
    }
}

static CURRENT_UNITS: AtomicU8 = AtomicU8::new(0);

/// Global display unit used by `format_bytes` (set by the GUI from the settings).
pub fn set_units(u: Units) {
    CURRENT_UNITS.store(u.to_u8(), Ordering::Relaxed);
}

pub fn current_units() -> Units {
    Units::from_u8(CURRENT_UNITS.load(Ordering::Relaxed))
}

/// Format a size with the globally selected unit.
pub fn format_bytes(bytes: u64) -> String {
    format_bytes_in(bytes, current_units())
}

/// Format a size in an explicit unit (`Auto` picks the largest unit that keeps the value >= 1).
pub fn format_bytes_in(bytes: u64, units: Units) -> String {
    const NAMES: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let fixed = match units {
        Units::Auto => None,
        Units::Bytes => return format!("{bytes} B"),
        Units::KB => Some(1),
        Units::MB => Some(2),
        Units::GB => Some(3),
    };
    match fixed {
        Some(i) => format!("{:.2} {}", bytes as f64 / 1024f64.powi(i), NAMES[i as usize]),
        None => {
            if bytes < 1024 {
                return format!("{bytes} B");
            }
            let mut v = bytes as f64;
            let mut i = 0;
            while v >= 1024.0 && i < NAMES.len() - 1 {
                v /= 1024.0;
                i += 1;
            }
            format!("{:.2} {}", v, NAMES[i])
        }
    }
}

/// Format Unix seconds as "YYYY-MM-DD HH:MM" in the machine's local time zone.
pub fn format_time(secs: i64) -> String {
    if secs == 0 {
        return String::new();
    }
    format_time_in(secs, &chrono::Local)
}

/// Same, in an explicit time zone (UTC in tests).
pub fn format_time_in<Tz: chrono::TimeZone>(secs: i64, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    match tz.timestamp_opt(secs, 0).single() {
        Some(t) => t.format("%Y-%m-%d %H:%M").to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_format() {
        assert_eq!(format_time_in(86400 * 365, &chrono::Utc), "1971-01-01 00:00");
        assert_eq!(format_time_in(1_700_000_000, &chrono::Utc), "2023-11-14 22:13");
        assert_eq!(format_time(0), "");
        // local rendering agrees with chrono's own local conversion
        use chrono::TimeZone;
        let want = chrono::Local.timestamp_opt(1_700_000_000, 0).unwrap().format("%Y-%m-%d %H:%M").to_string();
        assert_eq!(format_time(1_700_000_000), want);
    }

    #[test]
    fn bytes_format() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.50 KB");
        assert_eq!(format_bytes_in(1536, Units::Auto), "1.50 KB");
        assert_eq!(format_bytes_in(1536, Units::Bytes), "1536 B");
        assert_eq!(format_bytes_in(1536, Units::KB), "1.50 KB");
        assert_eq!(format_bytes_in(3 * 1024 * 1024, Units::KB), "3072.00 KB");
        assert_eq!(format_bytes_in(1024 * 1024 * 1024, Units::MB), "1024.00 MB");
        assert_eq!(format_bytes_in(1536 * 1024 * 1024, Units::GB), "1.50 GB");
        assert_eq!(format_bytes_in(10, Units::MB), "0.00 MB");
    }

    fn dir(name: &str, parent: NodeId, children: Vec<NodeId>) -> Node {
        Node {
            name: name.into(),
            parent,
            children,
            size: 0,
            alloc: 0,
            files: 0,
            dirs: 0,
            modified: 0,
            attrs: 0,
            is_dir: true,
            is_link: false,
            scanning: false,
        }
    }

    #[test]
    fn expanded_state_is_mapped_by_path_not_index() {
        // old: root -> [a -> [b], c]
        let old = Tree { nodes: vec![dir("R", NONE, vec![1, 3]), dir("a", 0, vec![2]), dir("b", 1, vec![]), dir("c", 0, vec![])] };
        // new snapshot rebuilt in another order, with an extra directory: root -> [z, c, a -> [b]]
        let new = Tree {
            nodes: vec![dir("R", NONE, vec![1, 2, 3]), dir("z", 0, vec![]), dir("c", 0, vec![]), dir("a", 0, vec![4]), dir("b", 3, vec![])],
        };
        let expanded: HashSet<NodeId> = [0, 1, 2].into_iter().collect(); // R, a, b
        let mapped = remap_ids(&old, &new, &expanded);
        let want: HashSet<NodeId> = [0, 3, 4].into_iter().collect();
        assert_eq!(mapped, want);
        // a vanished directory is dropped instead of aliasing another node
        let gone = Tree { nodes: vec![dir("R", NONE, vec![1]), dir("c", 0, vec![])] };
        let mapped = remap_ids(&old, &gone, &expanded);
        assert_eq!(mapped, [0].into_iter().collect());
        assert_eq!(old.name_path(2), vec!["a", "b"]);
    }
}

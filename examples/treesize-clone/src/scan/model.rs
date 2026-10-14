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

/// Direct (non-recursive) files of one directory, shown as the "[N Files]" pseudo-row.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DirectFiles {
    pub count: u64,
    pub size: u64,
    pub alloc: u64,
    pub modified: i64,
}

/// A ranked file of a live snapshot (file nodes are not part of snapshots).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankedFile {
    /// Directory (node id of the same snapshot) holding the file.
    pub dir: NodeId,
    pub name: String,
    pub size: u64,
    pub modified: i64,
}

/// Per-extension aggregate of a live snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtAgg {
    pub ext: String,
    pub count: u64,
    pub size: u64,
    pub alloc: u64,
}

/// File-level data streamed with a partial snapshot: bounded in size whatever the file count
/// (aggregates + top-N lists), so a snapshot never clones millions of nodes.
#[derive(Debug, Clone, Default)]
pub struct LiveStats {
    /// Indexed by node id of the snapshot.
    pub direct: Vec<DirectFiles>,
    pub types: Vec<ExtAgg>,
    pub largest: Vec<RankedFile>,
    pub oldest: Vec<RankedFile>,
}

#[derive(Debug, Clone, Default)]
pub struct Tree {
    pub nodes: Vec<Node>,
    /// Present on live-scan snapshots only (the final tree retains its file nodes instead).
    pub live: Option<Box<LiveStats>>,
}

impl Tree {
    pub const ROOT: NodeId = 0;

    /// One-node tree shown from the very first frame of a scan (counters are patched in live).
    pub fn placeholder(root_name: &str) -> Tree {
        Tree {
            nodes: vec![Node {
                name: root_name.to_string(),
                parent: NONE,
                children: Vec::new(),
                size: 0,
                alloc: 0,
                files: 0,
                dirs: 0,
                modified: 0,
                attrs: 0,
                is_dir: true,
                is_link: false,
                scanning: true,
            }],
            live: Some(Box::default()),
        }
    }

    /// Files held directly by a directory: from the stream during a scan, from the retained file
    /// nodes afterwards.
    pub fn direct_files(&self, id: NodeId) -> DirectFiles {
        if let Some(l) = &self.live {
            return l.direct.get(id as usize).copied().unwrap_or_default();
        }
        let mut d = DirectFiles::default();
        for &c in &self.get(id).children {
            let n = self.get(c);
            if !n.is_dir {
                d.count += 1;
                d.size += n.size;
                d.alloc += n.alloc;
                d.modified = d.modified.max(n.modified);
            }
        }
        d
    }

    /// Individual file nodes can be listed (false for live snapshots).
    pub fn has_file_nodes(&self) -> bool {
        self.live.is_none()
    }

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

/// Format a size with the globally selected unit and language.
pub fn format_bytes(bytes: u64) -> String {
    crate::fmt::format_bytes_in(bytes, current_units(), crate::fmt::loc())
}

/// Format Unix seconds as date and time in the machine's local time zone (language-aware).
pub fn format_time(secs: i64) -> String {
    crate::fmt::format_datetime_in(secs, &chrono::Local, crate::fmt::loc())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_files_from_nodes_and_placeholder() {
        let mut t = Tree::placeholder("R");
        assert_eq!(t.direct_files(0), DirectFiles::default());
        assert!(!t.has_file_nodes() && t.nodes[0].scanning);
        let mut ls = LiveStats::default();
        ls.direct.push(DirectFiles { count: 3, size: 30, alloc: 40, modified: 0 });
        t.live = Some(Box::new(ls));
        assert_eq!(t.direct_files(0).count, 3);
        // final tree: derived from the retained file children (links to files count, dirs do not)
        let file = |name: &str, parent, size, modified| Node { is_dir: false, size, alloc: size, modified, ..dir(name, parent, vec![]) };
        let f = Tree { nodes: vec![dir("R", NONE, vec![1, 2, 3]), file("a", 0, 5, 7), file("b", 0, 6, 9), dir("d", 0, vec![])], ..Default::default() };
        assert!(f.has_file_nodes());
        assert_eq!(f.direct_files(0), DirectFiles { count: 2, size: 11, alloc: 11, modified: 9 });
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
        let old = Tree { nodes: vec![dir("R", NONE, vec![1, 3]), dir("a", 0, vec![2]), dir("b", 1, vec![]), dir("c", 0, vec![])], ..Default::default() };
        // new snapshot rebuilt in another order, with an extra directory: root -> [z, c, a -> [b]]
        let new = Tree {
            nodes: vec![dir("R", NONE, vec![1, 2, 3]), dir("z", 0, vec![]), dir("c", 0, vec![]), dir("a", 0, vec![4]), dir("b", 3, vec![])],
            ..Default::default()
        };
        let expanded: HashSet<NodeId> = [0, 1, 2].into_iter().collect(); // R, a, b
        let mapped = remap_ids(&old, &new, &expanded);
        let want: HashSet<NodeId> = [0, 3, 4].into_iter().collect();
        assert_eq!(mapped, want);
        // a vanished directory is dropped instead of aliasing another node
        let gone = Tree { nodes: vec![dir("R", NONE, vec![1]), dir("c", 0, vec![])], ..Default::default() };
        let mapped = remap_ids(&old, &gone, &expanded);
        assert_eq!(mapped, [0].into_iter().collect());
        assert_eq!(old.name_path(2), vec!["a", "b"]);
    }
}

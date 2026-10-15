//! Scan snapshots (directory totals only) and the comparison of two of them: what grew, shrank,
//! appeared or vanished between two scans of the same root.

use crate::scan::{NodeId, Tree};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapDir {
    /// Path below the scan root with `/` separators; empty for the root itself.
    pub path: String,
    pub size: u64,
    pub alloc: u64,
    pub files: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub version: u32,
    pub root: String,
    /// Seconds since the Unix epoch.
    pub taken: i64,
    pub dirs: Vec<SnapDir>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Removed,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirDelta {
    pub path: String,
    pub old_size: u64,
    pub new_size: u64,
    pub old_files: u64,
    pub new_files: u64,
    pub kind: ChangeKind,
}

impl DirDelta {
    pub fn delta(&self) -> i64 {
        self.new_size as i64 - self.old_size as i64
    }
}

impl Snapshot {
    /// Capture every directory of a finished scan.
    pub fn from_tree(tree: &Tree, taken: i64) -> Snapshot {
        let mut dirs = Vec::new();
        let mut stack: Vec<(NodeId, String)> = vec![(Tree::ROOT, String::new())];
        while let Some((id, rel)) = stack.pop() {
            let n = tree.get(id);
            if !n.is_dir {
                continue;
            }
            dirs.push(SnapDir { path: rel.clone(), size: n.size, alloc: n.alloc, files: n.files });
            for &c in &n.children {
                let child = tree.get(c);
                if child.is_dir && !child.is_link {
                    let p = if rel.is_empty() { child.name.clone() } else { format!("{rel}/{}", child.name) };
                    stack.push((c, p));
                }
            }
        }
        dirs.sort_by(|a, b| a.path.cmp(&b.path));
        Snapshot { version: 1, root: tree.get(Tree::ROOT).name.clone(), taken, dirs }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    pub fn load(path: &Path) -> Result<Snapshot, String> {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let s: Snapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if s.version != 1 {
            return Err(format!("unsupported snapshot version {}", s.version));
        }
        Ok(s)
    }
}

/// Differences between two snapshots, biggest absolute change first. Unchanged folders are
/// omitted. A folder is reported with its own cumulative totals, so a growing leaf also shows up
/// through each of its ancestors.
pub fn diff(old: &Snapshot, new: &Snapshot) -> Vec<DirDelta> {
    let old_map: HashMap<&str, &SnapDir> = old.dirs.iter().map(|d| (d.path.as_str(), d)).collect();
    let new_map: HashMap<&str, &SnapDir> = new.dirs.iter().map(|d| (d.path.as_str(), d)).collect();
    let mut out = Vec::new();
    for d in &new.dirs {
        match old_map.get(d.path.as_str()) {
            None => out.push(DirDelta { path: d.path.clone(), old_size: 0, new_size: d.size, old_files: 0, new_files: d.files, kind: ChangeKind::Added }),
            Some(o) if o.size != d.size || o.files != d.files => out.push(DirDelta {
                path: d.path.clone(),
                old_size: o.size,
                new_size: d.size,
                old_files: o.files,
                new_files: d.files,
                kind: ChangeKind::Changed,
            }),
            _ => {}
        }
    }
    for d in &old.dirs {
        if !new_map.contains_key(d.path.as_str()) {
            out.push(DirDelta { path: d.path.clone(), old_size: d.size, new_size: 0, old_files: d.files, new_files: 0, kind: ChangeKind::Removed });
        }
    }
    out.sort_by(|a, b| b.delta().unsigned_abs().cmp(&a.delta().unsigned_abs()).then_with(|| a.path.cmp(&b.path)));
    out
}

/// Folder holding automatic snapshots (`%APPDATA%/treesize-clone/snapshots`).
pub fn history_dir() -> Option<PathBuf> {
    crate::settings::config_dir().map(|d| d.join("snapshots"))
}

fn root_key(root: &str) -> String {
    root.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).collect()
}

/// Path of the snapshot file for `root` taken at `taken`.
pub fn history_file(dir: &Path, root: &str, taken: i64) -> PathBuf {
    dir.join(format!("{}__{taken}.json", root_key(root)))
}

/// Existing snapshot files for `root`, oldest first.
pub fn history_for(dir: &Path, root: &str) -> Vec<PathBuf> {
    let prefix = format!("{}__", root_key(root));
    let mut v: Vec<(i64, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let ts = name.strip_prefix(&prefix)?.strip_suffix(".json")?.parse::<i64>().ok()?;
            Some((ts, e.path()))
        })
        .collect();
    v.sort();
    v.into_iter().map(|(_, p)| p).collect()
}

/// Keep only the `keep` newest snapshots of `root`.
pub fn prune_history(dir: &Path, root: &str, keep: usize) {
    let all = history_for(dir, root);
    for p in all.iter().take(all.len().saturating_sub(keep)) {
        let _ = std::fs::remove_file(p);
    }
}

/// Compare `tree` with the newest stored snapshot of its root (if any), then store `tree` as a
/// new snapshot and keep the history to 20 files. Returns the old snapshot time and the changes.
pub fn record_and_compare(dir: &Path, tree: &Tree, now: i64) -> Option<(i64, Vec<DirDelta>)> {
    let root = tree.get(Tree::ROOT).name.clone();
    let new = Snapshot::from_tree(tree, now);
    let previous = history_for(dir, &root).into_iter().rev().find_map(|p| Snapshot::load(&p).ok());
    let result = previous.map(|old| (old.taken, diff(&old, &new)));
    if new.save(&history_file(dir, &root, now)).is_ok() {
        prune_history(dir, &root, 20);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_simple;

    fn write(p: &Path, n: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![b'x'; n]).unwrap();
    }

    #[test]
    fn diff_reports_added_removed_and_changed_biggest_first() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(&r.join("keep/a.bin"), 100);
        write(&r.join("gone/b.bin"), 5000);
        write(&r.join("grow/c.bin"), 10);
        let old = Snapshot::from_tree(&scan_simple(r).tree, 1);
        std::fs::remove_dir_all(r.join("gone")).unwrap();
        write(&r.join("grow/more.bin"), 20_000);
        write(&r.join("fresh/n.bin"), 300);
        let new = Snapshot::from_tree(&scan_simple(r).tree, 2);

        let changes = diff(&old, &new);
        let get = |p: &str| changes.iter().find(|c| c.path == p).unwrap_or_else(|| panic!("{p} missing"));
        assert_eq!(get("gone").kind, ChangeKind::Removed);
        assert_eq!(get("gone").delta(), -5000);
        assert_eq!(get("fresh").kind, ChangeKind::Added);
        assert_eq!(get("grow").kind, ChangeKind::Changed);
        assert_eq!(get("grow").delta(), 20_000);
        assert!(changes.iter().all(|c| c.path != "keep"), "unchanged folder omitted");
        assert_eq!(get("").delta(), 20_000 + 300 - 5000, "root totals");
        let deltas: Vec<u64> = changes.iter().map(|c| c.delta().unsigned_abs()).collect();
        assert!(deltas.windows(2).all(|w| w[0] >= w[1]), "biggest absolute change first");
    }

    #[test]
    fn snapshot_roundtrips_and_rejects_bad_files() {
        let d = tempfile::tempdir().unwrap();
        write(&d.path().join("x/f.bin"), 42);
        let s = Snapshot::from_tree(&scan_simple(d.path()).tree, 7);
        let file = d.path().join("snap.json");
        s.save(&file).unwrap();
        assert_eq!(Snapshot::load(&file).unwrap(), s);
        std::fs::write(&file, b"{not json").unwrap();
        assert!(Snapshot::load(&file).is_err());
        std::fs::write(&file, br#"{"version":9,"root":"r","taken":0,"dirs":[]}"#).unwrap();
        assert!(Snapshot::load(&file).unwrap_err().contains("version"));
    }

    #[test]
    fn record_and_compare_uses_the_previous_scan() {
        let data = tempfile::tempdir().unwrap();
        let hist = tempfile::tempdir().unwrap();
        write(&data.path().join("a/f.bin"), 1000);
        let t1 = scan_simple(data.path()).tree;
        assert!(record_and_compare(hist.path(), &t1, 100).is_none(), "first scan has nothing to compare");
        write(&data.path().join("a/g.bin"), 500);
        let t2 = scan_simple(data.path()).tree;
        let (taken, changes) = record_and_compare(hist.path(), &t2, 200).expect("second scan compares");
        assert_eq!(taken, 100);
        assert_eq!(changes.iter().find(|c| c.path == "a").unwrap().delta(), 500);
        assert_eq!(history_for(hist.path(), &t2.get(Tree::ROOT).name).len(), 2);
        // A third identical scan reports no change.
        let t3 = scan_simple(data.path()).tree;
        assert!(record_and_compare(hist.path(), &t3, 300).unwrap().1.is_empty());
    }

    #[test]
    fn history_is_ordered_and_pruned() {
        let d = tempfile::tempdir().unwrap();
        let snap = Snapshot { version: 1, root: r"C:\Data".into(), taken: 0, dirs: vec![] };
        for t in [30, 10, 20, 40] {
            snap.save(&history_file(d.path(), r"C:\Data", t)).unwrap();
        }
        snap.save(&history_file(d.path(), r"D:\Other", 5)).unwrap();
        let names = |v: Vec<PathBuf>| v.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(names(history_for(d.path(), r"C:\Data")), ["c__data__10.json", "c__data__20.json", "c__data__30.json", "c__data__40.json"]);
        prune_history(d.path(), r"C:\Data", 2);
        assert_eq!(names(history_for(d.path(), r"C:\Data")), ["c__data__30.json", "c__data__40.json"]);
        assert_eq!(history_for(d.path(), r"D:\Other").len(), 1);
    }
}

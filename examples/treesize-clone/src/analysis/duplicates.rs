//! Duplicate finder: group by size, then partial hash, then full hash (blake3), in parallel.

use crate::analysis::types::files_below;
use crate::scan::{NodeId, Tree};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Bytes hashed in the cheap first pass.
pub const PARTIAL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct DupGroup {
    pub size: u64,
    pub paths: Vec<PathBuf>,
}

impl DupGroup {
    /// Space that would be freed by keeping a single copy.
    pub fn wasted(&self) -> u64 {
        self.size * (self.paths.len() as u64).saturating_sub(1)
    }
}

/// Files of identical size (only sizes shared by at least two files), as paths.
/// Cheap and done on the caller's thread; hashing is the slow part.
pub fn size_candidates(tree: &Tree, root: NodeId, min_size: u64) -> Vec<(u64, Vec<PathBuf>)> {
    let mut by_size: HashMap<u64, Vec<NodeId>> = HashMap::new();
    for id in files_below(tree, root) {
        let s = tree.get(id).size;
        if s > 0 && s >= min_size {
            by_size.entry(s).or_default().push(id);
        }
    }
    let mut v: Vec<(u64, Vec<PathBuf>)> = by_size
        .into_iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(s, ids)| (s, ids.into_iter().map(|i| tree.path_of(i)).collect()))
        .collect();
    v.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
    v
}

fn hash_file(path: &Path, limit: Option<u64>) -> std::io::Result<[u8; 32]> {
    let f = File::open(path)?;
    let mut r: Box<dyn Read> = match limit {
        Some(n) => Box::new(f.take(n)),
        None => Box::new(f),
    };
    let mut h = blake3::Hasher::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(*h.finalize().as_bytes())
}

/// Split `paths` into groups of equal hash (limit = bytes to hash, `None` = whole file).
/// Unreadable files are dropped. Returns `None` if cancelled.
fn regroup(paths: Vec<PathBuf>, limit: Option<u64>, cancel: &AtomicBool, done: &AtomicU64) -> Option<Vec<Vec<PathBuf>>> {
    let hashed: Vec<Option<([u8; 32], PathBuf)>> = paths
        .into_par_iter()
        .map(|p| {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let h = hash_file(&p, limit).ok();
            done.fetch_add(1, Ordering::Relaxed);
            h.map(|h| (h, p))
        })
        .collect();
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let mut map: HashMap<[u8; 32], Vec<PathBuf>> = HashMap::new();
    for (h, p) in hashed.into_iter().flatten() {
        map.entry(h).or_default().push(p);
    }
    Some(map.into_values().filter(|g| g.len() > 1).collect())
}

/// Refine same-size candidates into true duplicate groups, sorted by wasted space (desc).
/// `done` counts files hashed (for progress); returns `None` when cancelled.
pub fn find_duplicates_in(
    candidates: Vec<(u64, Vec<PathBuf>)>,
    cancel: &AtomicBool,
    done: &AtomicU64,
) -> Option<Vec<DupGroup>> {
    let mut out = Vec::new();
    for (size, paths) in candidates {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        // Files that fit the partial window need only one (full) pass.
        let stage1 = if size <= PARTIAL_BYTES { vec![paths] } else { regroup(paths, Some(PARTIAL_BYTES), cancel, done)? };
        for g in stage1 {
            for full in regroup(g, None, cancel, done)? {
                let mut paths = full;
                paths.sort();
                out.push(DupGroup { size, paths });
            }
        }
    }
    out.sort_by(|a, b| b.wasted().cmp(&a.wasted()).then_with(|| a.paths.cmp(&b.paths)));
    Some(out)
}

/// Convenience: candidates + hashing in one call (used by tests; the UI splits the two steps).
#[cfg(test)]
pub fn find_duplicates(
    tree: &Tree,
    root: NodeId,
    min_size: u64,
    cancel: &AtomicBool,
    done: &AtomicU64,
) -> Option<Vec<DupGroup>> {
    find_duplicates_in(size_candidates(tree, root, min_size), cancel, done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_simple;
    use std::fs;

    fn w(p: &Path, data: &[u8]) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, data).unwrap();
    }

    #[test]
    fn finds_duplicates_and_rejects_lookalikes() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        w(&r.join("a/one.txt"), b"hello world");
        w(&r.join("b/two.txt"), b"hello world");
        w(&r.join("c/three.txt"), b"hello w0rld"); // same size, different content
        w(&r.join("unique.txt"), b"unique-content");
        // Large files equal in the first 64 KiB but different at the very end.
        let mut big1 = vec![7u8; 100_000];
        let mut big2 = big1.clone();
        big1[99_999] = 9;
        big2[99_999] = 8;
        w(&r.join("big1.bin"), &big1);
        w(&r.join("big2.bin"), &big2);
        w(&r.join("big3.bin"), &vec![7u8; 100_000]);
        w(&r.join("big4.bin"), &vec![7u8; 100_000]);

        let res = scan_simple(r);
        let done = AtomicU64::new(0);
        let groups = find_duplicates(&res.tree, 0, 1, &AtomicBool::new(false), &done).unwrap();
        assert_eq!(groups.len(), 2, "{groups:?}");
        // big pair has larger waste and comes first
        assert_eq!(groups[0].size, 100_000);
        let names: Vec<_> = groups[0].paths.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["big3.bin", "big4.bin"]);
        assert_eq!(groups[0].wasted(), 100_000);
        assert_eq!(groups[1].paths.len(), 2);
        assert_eq!(groups[1].wasted(), 11);
        assert!(done.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn min_size_and_empty_files_are_skipped() {
        let d = tempfile::tempdir().unwrap();
        w(&d.path().join("e1"), b"");
        w(&d.path().join("e2"), b"");
        w(&d.path().join("s1"), b"abc");
        w(&d.path().join("s2"), b"abc");
        let res = scan_simple(d.path());
        let c = AtomicBool::new(false);
        let n = AtomicU64::new(0);
        assert_eq!(find_duplicates(&res.tree, 0, 1, &c, &n).unwrap().len(), 1);
        assert!(find_duplicates(&res.tree, 0, 10, &c, &n).unwrap().is_empty());
    }

    #[test]
    fn cancellation_returns_none() {
        let d = tempfile::tempdir().unwrap();
        w(&d.path().join("s1"), b"abc");
        w(&d.path().join("s2"), b"abc");
        let res = scan_simple(d.path());
        let cancel = AtomicBool::new(true);
        assert!(find_duplicates(&res.tree, 0, 1, &cancel, &AtomicU64::new(0)).is_none());
    }
}

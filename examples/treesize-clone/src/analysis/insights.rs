//! Clean-up insights over a finished scan: well-known reclaimable folders, empty folders and a
//! size-by-age breakdown. Everything here is read-only; deleting stays an explicit user action.

use crate::scan::{NodeId, Tree};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reclaimable {
    pub id: NodeId,
    /// Short reason shown next to the folder (for example "Node.js dependencies").
    pub kind: &'static str,
    pub size: u64,
}

/// Folder names that are safe to regenerate. `needs_sibling` is a file that must sit next to the
/// folder for the match to count (a bare `target` folder is not necessarily a Rust build).
struct Rule {
    name: &'static str,
    kind: &'static str,
    needs_sibling: Option<&'static str>,
}

const RULES: &[Rule] = &[
    Rule { name: "node_modules", kind: "Node.js dependencies", needs_sibling: None },
    Rule { name: "target", kind: "Rust build output", needs_sibling: Some("Cargo.toml") },
    Rule { name: "__pycache__", kind: "Python bytecode cache", needs_sibling: None },
    Rule { name: ".pytest_cache", kind: "pytest cache", needs_sibling: None },
    Rule { name: ".mypy_cache", kind: "mypy cache", needs_sibling: None },
    Rule { name: ".gradle", kind: "Gradle cache", needs_sibling: None },
    Rule { name: ".next", kind: "Next.js build cache", needs_sibling: Some("package.json") },
    Rule { name: ".parcel-cache", kind: "Parcel cache", needs_sibling: None },
    Rule { name: ".nuget", kind: "NuGet cache", needs_sibling: None },
    Rule { name: "$recycle.bin", kind: "Recycle Bin", needs_sibling: None },
    Rule { name: "windows.old", kind: "Previous Windows installation", needs_sibling: None },
    Rule { name: "$windows.~bt", kind: "Windows upgrade leftovers", needs_sibling: None },
    Rule { name: "$windows.~ws", kind: "Windows upgrade leftovers", needs_sibling: None },
];

fn rule_for(tree: &Tree, id: NodeId) -> Option<&'static Rule> {
    let n = tree.get(id);
    let lower = n.name.to_lowercase();
    let rule = RULES.iter().find(|r| r.name == lower)?;
    if let Some(sib) = rule.needs_sibling {
        let parent = tree.get(n.parent.min(tree.nodes.len() as u32 - 1));
        if n.parent == crate::scan::NONE || !parent.children.iter().any(|&c| tree.get(c).name.eq_ignore_ascii_case(sib)) {
            return None;
        }
    }
    Some(rule)
}

/// Reclaimable folders, biggest first. A match is not searched further (its contents are already
/// counted in it).
pub fn reclaimable(tree: &Tree) -> Vec<Reclaimable> {
    let mut out = Vec::new();
    if tree.nodes.is_empty() {
        return out;
    }
    let mut stack = vec![Tree::ROOT];
    while let Some(id) = stack.pop() {
        let n = tree.get(id);
        if !n.is_dir || n.is_link {
            continue;
        }
        if id != Tree::ROOT {
            if let Some(rule) = rule_for(tree, id) {
                if n.size > 0 {
                    out.push(Reclaimable { id, kind: rule.kind, size: n.size });
                }
                continue;
            }
        }
        stack.extend(n.children.iter().copied());
    }
    out.sort_by(|a, b| b.size.cmp(&a.size).then(a.id.cmp(&b.id)));
    out
}

/// Folders that hold nothing at all (no files, no sub-folders), in tree order. Links and the
/// insides of reclaimable folders are skipped.
pub fn empty_dirs(tree: &Tree) -> Vec<NodeId> {
    let mut out = Vec::new();
    if tree.nodes.is_empty() {
        return out;
    }
    let mut stack = vec![Tree::ROOT];
    while let Some(id) = stack.pop() {
        let n = tree.get(id);
        if !n.is_dir || n.is_link {
            continue;
        }
        if id != Tree::ROOT && rule_for(tree, id).is_some() {
            continue; // already offered as a whole by `reclaimable`
        }
        if id != Tree::ROOT && n.children.is_empty() {
            out.push(id);
        }
        stack.extend(n.children.iter().copied());
    }
    out.sort_unstable();
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgeBucket {
    pub label: &'static str,
    pub files: u64,
    pub size: u64,
}

/// Bucket upper bounds in days, oldest bucket last (`u64::MAX`).
const AGE_BOUNDS: &[(&str, u64)] = &[
    ("Last 30 days", 30),
    ("1 to 6 months", 182),
    ("6 months to 1 year", 365),
    ("1 to 2 years", 730),
    ("2 to 5 years", 1826),
    ("More than 5 years", u64::MAX),
];

/// Size and file count per last-modified age. Files with an unknown date (0) are counted as the
/// oldest bucket.
pub fn age_buckets(tree: &Tree, now_secs: i64) -> Vec<AgeBucket> {
    let mut out: Vec<AgeBucket> = AGE_BOUNDS.iter().map(|(l, _)| AgeBucket { label: l, files: 0, size: 0 }).collect();
    for n in &tree.nodes {
        if n.is_dir {
            continue;
        }
        let days = if n.modified <= 0 { u64::MAX } else { (now_secs - n.modified).max(0) as u64 / 86_400 };
        let i = AGE_BOUNDS.iter().position(|(_, max)| days <= *max).unwrap_or(AGE_BOUNDS.len() - 1);
        out[i].files += 1;
        out[i].size += n.size;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scan::scan_simple;
    use std::path::Path;

    fn write(p: &Path, n: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![b'x'; n]).unwrap();
    }

    #[test]
    fn finds_known_folders_and_respects_sibling_rules() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        write(&r.join("web/package.json"), 10);
        write(&r.join("web/node_modules/dep/index.js"), 5000);
        write(&r.join("web/node_modules/dep/node_modules/inner/x.js"), 900);
        write(&r.join("crate/Cargo.toml"), 10);
        write(&r.join("crate/target/debug/a.bin"), 3000);
        write(&r.join("plain/target/b.bin"), 7000); // no Cargo.toml: not a Rust build dir
        write(&r.join("py/__pycache__/m.pyc"), 100);
        std::fs::create_dir_all(r.join("web/node_modules_empty")).unwrap();
        let tree = scan_simple(r).tree;
        let found = reclaimable(&tree);
        let names: Vec<(&str, u64)> = found.iter().map(|f| (f.kind, f.size)).collect();
        assert_eq!(names, [("Node.js dependencies", 5900), ("Rust build output", 3000), ("Python bytecode cache", 100)]);
        assert!(found.iter().all(|f| tree.get(f.id).name != "target" || tree.get(tree.get(f.id).parent).name == "crate"));
    }

    #[test]
    fn lists_only_truly_empty_folders() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("empty")).unwrap();
        std::fs::create_dir_all(r.join("parent/child")).unwrap();
        write(&r.join("full/f.bin"), 1);
        write(&r.join("app/package.json"), 1);
        std::fs::create_dir_all(r.join("app/node_modules/pkg/empty_inside")).unwrap();
        let tree = scan_simple(r).tree;
        let names: Vec<&str> = empty_dirs(&tree).iter().map(|&i| tree.get(i).name.as_str()).collect();
        assert!(names.contains(&"empty") && names.contains(&"child"));
        assert!(!names.contains(&"parent") && !names.contains(&"full"));
        assert!(!names.contains(&"empty_inside"), "inside a reclaimable folder");
    }

    #[test]
    fn age_buckets_split_by_modified_time() {
        let d = tempfile::tempdir().unwrap();
        write(&d.path().join("a.bin"), 100);
        write(&d.path().join("b.bin"), 50);
        let mut tree = scan_simple(d.path()).tree;
        let now = 1_000_000_000i64;
        let day = 86_400;
        let set = |tree: &mut Tree, name: &str, modified: i64| {
            let id = tree.resolve_path(&[name]).unwrap();
            tree.nodes[id as usize].modified = modified;
        };
        set(&mut tree, "a.bin", now - 3 * day); // last 30 days
        set(&mut tree, "b.bin", now - 3000 * day); // > 5 years
        let b = age_buckets(&tree, now);
        assert_eq!((b[0].files, b[0].size), (1, 100));
        assert_eq!((b[5].files, b[5].size), (1, 50));
        assert_eq!(b.iter().map(|x| x.files).sum::<u64>(), 2);
    }
}

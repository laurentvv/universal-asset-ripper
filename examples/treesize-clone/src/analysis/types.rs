//! File-type aggregation and rankings computed from the arena.

use crate::scan::{NodeId, Tree};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    Documents,
    Images,
    Video,
    Audio,
    Archives,
    Code,
    Executables,
    Other,
}

impl Category {
    pub const ALL: [Category; 8] = [
        Category::Documents,
        Category::Images,
        Category::Video,
        Category::Audio,
        Category::Archives,
        Category::Code,
        Category::Executables,
        Category::Other,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Category::Documents => "Documents",
            Category::Images => "Images",
            Category::Video => "Video",
            Category::Audio => "Audio",
            Category::Archives => "Archives",
            Category::Code => "Code",
            Category::Executables => "Executables",
            Category::Other => "Other",
        }
    }

    pub fn rgb(self) -> [u8; 3] {
        match self {
            Category::Documents => [86, 140, 214],
            Category::Images => [96, 178, 110],
            Category::Video => [200, 90, 90],
            Category::Audio => [170, 110, 200],
            Category::Archives => [214, 160, 70],
            Category::Code => [70, 170, 180],
            Category::Executables => [220, 120, 60],
            Category::Other => [140, 140, 150],
        }
    }
}

/// Lower-case extension without the dot; empty string when there is none.
pub fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 && i + 1 < name.len() => name[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

pub fn category_of(ext: &str) -> Category {
    match ext {
        "txt" | "md" | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "rtf" | "csv"
        | "epub" => Category::Documents,
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "ico" | "webp" | "tif" | "tiff" | "svg" | "psd" | "raw" | "heic"
        | "dds" | "tga" => Category::Images,
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "webm" | "flv" | "m4v" | "mpg" | "mpeg" => Category::Video,
        "mp3" | "wav" | "flac" | "ogg" | "aac" | "m4a" | "wma" | "opus" | "mid" => Category::Audio,
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" | "cab" | "zst" | "pak" => Category::Archives,
        "rs" | "py" | "js" | "ts" | "c" | "h" | "cpp" | "hpp" | "cs" | "java" | "go" | "html" | "css" | "json"
        | "xml" | "toml" | "yml" | "yaml" | "lua" | "sh" | "bat" | "ps1" | "sql" | "php" | "rb" => Category::Code,
        "exe" | "dll" | "sys" | "msi" | "so" | "lib" | "obj" | "pdb" | "bin" | "com" | "scr" | "o" | "rlib" => {
            Category::Executables
        }
        _ => Category::Other,
    }
}

pub fn category_of_name(name: &str) -> Category {
    category_of(&ext_of(name))
}

#[derive(Debug, Clone, PartialEq)]
pub struct TypeStat {
    /// Lower-case extension; empty for files without one.
    pub ext: String,
    pub category: Category,
    pub count: u64,
    pub size: u64,
    pub alloc: u64,
    /// Share of the total size of the analysed subtree, 0..=100.
    pub percent: f64,
}

/// All non-directory nodes below `root` (links excluded), found by walking children
/// so detached (excluded) subtrees are not counted.
pub fn files_below(tree: &Tree, root: NodeId) -> Vec<NodeId> {
    let mut out = Vec::new();
    if tree.nodes.is_empty() {
        return out;
    }
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let n = tree.get(id);
        if n.is_dir {
            stack.extend(n.children.iter().copied());
        } else if !n.is_link {
            out.push(id);
        }
    }
    out
}

/// Aggregate by extension (count, size, %), sorted by size descending.
pub fn aggregate_by_extension(tree: &Tree, root: NodeId) -> Vec<TypeStat> {
    let mut map: HashMap<String, (u64, u64, u64)> = HashMap::new();
    let mut total = 0u64;
    for id in files_below(tree, root) {
        let n = tree.get(id);
        let e = map.entry(ext_of(&n.name)).or_default();
        e.0 += 1;
        e.1 += n.size;
        e.2 += n.alloc;
        total += n.size;
    }
    let mut v: Vec<TypeStat> = map
        .into_iter()
        .map(|(ext, (count, size, alloc))| TypeStat {
            category: category_of(&ext),
            percent: if total > 0 { size as f64 * 100.0 / total as f64 } else { 0.0 },
            ext,
            count,
            size,
            alloc,
        })
        .collect();
    v.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.ext.cmp(&b.ext)));
    v
}

/// The `n` largest files below `root`.
pub fn largest_files(tree: &Tree, root: NodeId, n: usize) -> Vec<NodeId> {
    let mut v = files_below(tree, root);
    v.sort_by(|&a, &b| tree.get(b).size.cmp(&tree.get(a).size).then(a.cmp(&b)));
    v.truncate(n);
    v
}

/// The `n` oldest files (smallest modification time, unknown times skipped).
pub fn oldest_files(tree: &Tree, root: NodeId, n: usize) -> Vec<NodeId> {
    let mut v: Vec<NodeId> = files_below(tree, root).into_iter().filter(|&i| tree.get(i).modified > 0).collect();
    v.sort_by(|&a, &b| tree.get(a).modified.cmp(&tree.get(b).modified).then(a.cmp(&b)));
    v.truncate(n);
    v
}

#[derive(Debug, Clone, PartialEq)]
pub struct Slice {
    pub name: String,
    pub size: u64,
    /// `None` for the aggregated "Other" slice.
    pub node: Option<NodeId>,
}

/// Direct children of `id` ordered by size, at most `n` slices plus one "Other" remainder.
pub fn top_children(tree: &Tree, id: NodeId, n: usize) -> Vec<Slice> {
    let mut kids: Vec<NodeId> = tree.get(id).children.iter().copied().filter(|&c| tree.get(c).size > 0).collect();
    kids.sort_by(|&a, &b| tree.get(b).size.cmp(&tree.get(a).size).then(a.cmp(&b)));
    let mut out: Vec<Slice> = kids
        .iter()
        .take(n)
        .map(|&c| Slice { name: tree.get(c).name.clone(), size: tree.get(c).size, node: Some(c) })
        .collect();
    let rest: u64 = kids.iter().skip(n).map(|&c| tree.get(c).size).sum();
    if rest > 0 {
        out.push(Slice { name: "Other".into(), size: rest, node: None });
    }
    out
}

#[cfg(test)]
pub mod testutil {
    use crate::scan::model::{Node, Tree, NONE};

    /// Build a tree from `(path, size, mtime)`; parents are created as needed.
    pub fn tree_of(files: &[(&str, u64, i64)]) -> Tree {
        let mut t = Tree::default();
        let mk = |name: &str, parent, is_dir, size, modified| Node {
            name: name.into(),
            parent,
            children: vec![],
            size,
            alloc: size,
            files: 0,
            dirs: 0,
            modified,
            attrs: 0,
            is_dir,
            is_link: false,
        };
        t.nodes.push(mk("root", NONE, true, 0, 0));
        for (path, size, mtime) in files {
            let parts: Vec<&str> = path.split('/').collect();
            let mut cur = 0u32;
            for (i, p) in parts.iter().enumerate() {
                let last = i + 1 == parts.len();
                cur = match t.find_child(cur, p) {
                    Some(c) => c,
                    None => {
                        let id = t.nodes.len() as u32;
                        t.nodes.push(mk(p, cur, !last, if last { *size } else { 0 }, if last { *mtime } else { 0 }));
                        t.nodes[cur as usize].children.push(id);
                        id
                    }
                };
            }
            let mut a = t.nodes[cur as usize].parent;
            while a != NONE {
                let n = &mut t.nodes[a as usize];
                n.size += size;
                n.alloc += size;
                n.files += 1;
                a = n.parent;
            }
        }
        t
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::tree_of;
    use super::*;

    fn sample() -> Tree {
        tree_of(&[
            ("a/x.JPG", 100, 50),
            ("a/y.jpg", 300, 10),
            ("b/z.mp4", 1000, 70),
            ("b/deep/n.txt", 40, 5),
            ("README", 10, 0),
        ])
    }

    #[test]
    fn ext_and_category() {
        assert_eq!(ext_of("Photo.JPG"), "jpg");
        assert_eq!(ext_of("README"), "");
        assert_eq!(ext_of(".gitignore"), "");
        assert_eq!(ext_of("trailing."), "");
        assert_eq!(category_of("mp4"), Category::Video);
        assert_eq!(category_of("zzz"), Category::Other);
        assert_eq!(category_of_name("a.tar.gz"), Category::Archives);
    }

    #[test]
    fn aggregates_by_extension() {
        let t = sample();
        let v = aggregate_by_extension(&t, 0);
        assert_eq!(v[0].ext, "mp4");
        assert_eq!(v[0].size, 1000);
        let jpg = v.iter().find(|s| s.ext == "jpg").unwrap();
        assert_eq!((jpg.count, jpg.size), (2, 400));
        assert!(v.iter().any(|s| s.ext.is_empty() && s.count == 1));
        let pct: f64 = v.iter().map(|s| s.percent).sum();
        assert!((pct - 100.0).abs() < 1e-9);
        let total: u64 = v.iter().map(|s| s.size).sum();
        assert_eq!(total, t.get(0).size);
    }

    #[test]
    fn rankings() {
        let t = sample();
        let big = largest_files(&t, 0, 2);
        assert_eq!(t.get(big[0]).name, "z.mp4");
        assert_eq!(t.get(big[1]).name, "y.jpg");
        let old = oldest_files(&t, 0, 2);
        assert_eq!(t.get(old[0]).name, "n.txt"); // mtime 5; README (0 = unknown) skipped
        assert_eq!(t.get(old[1]).name, "y.jpg");
    }

    #[test]
    fn detached_subtree_not_counted() {
        let mut t = sample();
        let b = t.find_child(0, "b").unwrap();
        t.remove_subtree(b);
        let v = aggregate_by_extension(&t, 0);
        assert!(v.iter().all(|s| s.ext != "mp4"));
    }

    #[test]
    fn top_children_with_other() {
        let t = sample();
        let s = top_children(&t, 0, 1);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "b");
        assert_eq!(s[1].name, "Other");
        assert_eq!(s[1].node, None);
        assert_eq!(s[0].size + s[1].size, t.get(0).size);
    }
}

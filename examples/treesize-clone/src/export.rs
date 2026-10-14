//! Export the arena to CSV, JSON and a self-contained HTML report.

use crate::scan::{format_bytes, format_time, NodeId, Tree};
use std::io::{self, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Json,
    Html,
}

impl Format {
    pub fn ext(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Json => "json",
            Format::Html => "html",
        }
    }
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Pre-order list of `(node, depth)` below `root`, children by size descending.
fn walk_sorted(tree: &Tree, root: NodeId, max_depth: usize, dirs_only: bool) -> Vec<(NodeId, usize)> {
    let mut out = Vec::new();
    if tree.nodes.is_empty() {
        return out;
    }
    let mut stack = vec![(root, 0usize)];
    while let Some((id, depth)) = stack.pop() {
        out.push((id, depth));
        if depth >= max_depth {
            continue;
        }
        let mut kids: Vec<NodeId> =
            tree.get(id).children.iter().copied().filter(|&c| !dirs_only || tree.get(c).is_dir).collect();
        kids.sort_by(|&a, &b| tree.get(b).size.cmp(&tree.get(a).size).then(a.cmp(&b)));
        for &c in kids.iter().rev() {
            stack.push((c, depth + 1));
        }
    }
    out
}

fn kind(tree: &Tree, id: NodeId) -> &'static str {
    let n = tree.get(id);
    if n.is_link {
        "link"
    } else if n.is_dir {
        "folder"
    } else {
        "file"
    }
}

/// CSV with one row per node: path,type,size,allocated,files,folders,modified.
pub fn write_csv<W: Write>(tree: &Tree, root: NodeId, mut w: W) -> io::Result<()> {
    writeln!(w, "path,type,size_bytes,allocated_bytes,files,folders,modified")?;
    for (id, _) in walk_sorted(tree, root, usize::MAX, false) {
        let n = tree.get(id);
        writeln!(
            w,
            "{},{},{},{},{},{},{}",
            csv_field(&tree.path_of(id).to_string_lossy()),
            kind(tree, id),
            n.size,
            n.alloc,
            n.files,
            n.dirs,
            format_time(n.modified)
        )?;
    }
    Ok(())
}

fn json_node(tree: &Tree, id: NodeId, depth: usize, max_depth: usize) -> serde_json::Value {
    let n = tree.get(id);
    let mut o = serde_json::json!({
        "name": n.name,
        "type": kind(tree, id),
        "size": n.size,
        "allocated": n.alloc,
        "files": n.files,
        "folders": n.dirs,
        "modified": n.modified,
    });
    if n.is_dir && depth < max_depth {
        let mut kids = n.children.clone();
        kids.sort_by(|&a, &b| tree.get(b).size.cmp(&tree.get(a).size).then(a.cmp(&b)));
        o["children"] = kids.into_iter().map(|c| json_node(tree, c, depth + 1, max_depth)).collect();
    }
    o
}

/// Nested JSON document; `max_depth` limits nesting (use `usize::MAX` for everything).
pub fn write_json<W: Write>(tree: &Tree, root: NodeId, max_depth: usize, w: W) -> io::Result<()> {
    if tree.nodes.is_empty() {
        return serde_json::to_writer_pretty(w, &serde_json::Value::Null).map_err(io::Error::other);
    }
    // Recursion depth equals the directory depth, bounded by max_depth.
    let v = json_node(tree, root, 0, max_depth.min(200));
    serde_json::to_writer_pretty(w, &v).map_err(io::Error::other)
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

const CSS: &str = "body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#222}\
h1{font-size:20px}table{border-collapse:collapse;width:100%}\
th,td{padding:4px 8px;border-bottom:1px solid #ddd;text-align:right;font-size:13px}\
th{background:#f0f0f0;position:sticky;top:0}td.n,th.n{text-align:left}\
.bar{display:inline-block;height:10px;background:#78be78;vertical-align:middle}\
.box{display:inline-block;width:110px;background:#eee;margin-right:6px}";

/// Self-contained HTML report with the folder table (no external resources).
pub fn write_html<W: Write>(tree: &Tree, root: NodeId, max_depth: usize, mut w: W) -> io::Result<()> {
    let r = tree.get(root);
    writeln!(w, "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Disk usage report</title><style>{CSS}</style></head><body>")?;
    writeln!(w, "<h1>Disk usage: {}</h1>", esc(&tree.path_of(root).to_string_lossy()))?;
    writeln!(
        w,
        "<p>{} ({} on disk), {} files, {} folders. Generated {}.</p>",
        format_bytes(r.size),
        format_bytes(r.alloc),
        r.files,
        r.dirs,
        esc(&chrono::Local::now().format("%Y-%m-%d %H:%M").to_string())
    )?;
    writeln!(w, "<table><tr><th class=\"n\">Folder</th><th>Size</th><th>Allocated</th><th class=\"n\">% of parent</th><th>Files</th><th>Folders</th><th>Last modified</th></tr>")?;
    for (id, depth) in walk_sorted(tree, root, max_depth, true) {
        let n = tree.get(id);
        let pct = if n.parent == crate::scan::NONE || id == root {
            100.0
        } else {
            let ps = tree.get(n.parent).size;
            if ps > 0 { n.size as f64 * 100.0 / ps as f64 } else { 0.0 }
        };
        writeln!(
            w,
            "<tr><td class=\"n\" style=\"padding-left:{}px\">{}</td><td>{}</td><td>{}</td><td class=\"n\"><span class=\"box\"><span class=\"bar\" style=\"width:{:.0}%\"></span></span>{:.1}%</td><td>{}</td><td>{}</td><td>{}</td></tr>",
            8 + depth * 16,
            esc(&n.name),
            format_bytes(n.size),
            format_bytes(n.alloc),
            pct.clamp(0.0, 100.0),
            pct,
            n.files,
            n.dirs,
            esc(&format_time(n.modified)),
        )?;
    }
    writeln!(w, "</table></body></html>")
}

/// Write `fmt` to `path` (HTML/JSON limited to `max_depth` levels).
pub fn export_to_file(tree: &Tree, root: NodeId, fmt: Format, max_depth: usize, path: &std::path::Path) -> io::Result<()> {
    let f = std::io::BufWriter::new(std::fs::File::create(path)?);
    match fmt {
        Format::Csv => write_csv(tree, root, f),
        Format::Json => write_json(tree, root, max_depth, f),
        Format::Html => write_html(tree, root, max_depth, f),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::types::testutil::tree_of;

    fn sample() -> Tree {
        tree_of(&[("a/x,\"q\".txt", 100, 0), ("a/y.txt", 300, 0), ("b/<z>.bin", 1000, 0)])
    }

    #[test]
    fn csv_has_header_rows_and_escaping() {
        let t = sample();
        let mut buf = Vec::new();
        write_csv(&t, 0, &mut buf).unwrap();
        let s = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines[0], "path,type,size_bytes,allocated_bytes,files,folders,modified");
        assert_eq!(lines.len(), 1 + t.nodes.len());
        assert!(lines[1].starts_with("root,folder,1400,"));
        assert!(s.contains("\"root") && s.contains("\"\"q\"\"")); // quoted field with doubled quotes
    }

    #[test]
    fn json_is_valid_nested_and_depth_limited() {
        let t = sample();
        let mut buf = Vec::new();
        write_json(&t, 0, usize::MAX, &mut buf).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&buf).unwrap();
        assert_eq!(v["size"], 1400);
        assert_eq!(v["children"][0]["name"], "b"); // largest first
        assert_eq!(v["children"][1]["children"][0]["name"], "y.txt");
        let mut buf2 = Vec::new();
        write_json(&t, 0, 0, &mut buf2).unwrap();
        let v2: serde_json::Value = serde_json::from_slice(&buf2).unwrap();
        assert!(v2.get("children").is_none());
    }

    #[test]
    fn html_is_self_contained_and_escaped() {
        let t = sample();
        let mut buf = Vec::new();
        write_html(&t, 0, 5, &mut buf).unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert!(s.starts_with("<!DOCTYPE html>") && s.trim_end().ends_with("</html>"));
        assert!(!s.contains("http://") && !s.contains("https://") && !s.contains("<script"));
        assert!(s.contains("<td class=\"n\" style=\"padding-left:8px\">root</td>"));
        // folder table lists directories only
        assert!(!s.contains("&lt;z&gt;.bin"));
        assert_eq!(s.matches("<tr><td").count(), 3); // root, a, b
        assert!(s.contains("100.0%"));
    }

    #[test]
    fn export_to_file_roundtrip() {
        let t = sample();
        let d = tempfile::tempdir().unwrap();
        for fmt in [Format::Csv, Format::Json, Format::Html] {
            let p = d.path().join(format!("out.{}", fmt.ext()));
            export_to_file(&t, 0, fmt, 10, &p).unwrap();
            assert!(std::fs::metadata(&p).unwrap().len() > 50);
        }
    }
}

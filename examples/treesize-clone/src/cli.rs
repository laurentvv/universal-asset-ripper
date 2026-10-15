//! Headless CLI mode (`--cli <path> [--depth N]`): prints the scanned tree.

use crate::scan::{format_bytes, model::normalize_root, scan_simple, NodeId, Tree};
use colored::*;
use std::path::PathBuf;

fn print_node(tree: &Tree, id: NodeId, prefix: &str, is_last: bool, max_depth: usize, depth: usize) {
    if depth > max_depth {
        return;
    }
    let n = tree.get(id);
    let parent_size = if n.parent == crate::scan::NONE { n.size } else { tree.get(n.parent).size };
    let percent = if parent_size > 0 { n.size as f64 / parent_size as f64 * 100.0 } else { 100.0 };
    let bar_width = 15usize;
    let filled = (((percent / 100.0) * bar_width as f64).round() as usize).min(bar_width);
    let bar = format!("[{}{}]", "█".repeat(filled).yellow(), "░".repeat(bar_width - filled).dimmed());
    let branch = if depth == 0 { "" } else if is_last { "└── " } else { "├── " };
    println!(
        "{}{}{} {:>10}  {} {:>6}  ({:>4} files, {:>3} dirs)",
        prefix.dimmed(),
        branch.dimmed(),
        n.name.bold().green(),
        format_bytes(n.size).bold().white(),
        bar,
        format!("{:>5.1}%", percent).cyan(),
        n.files,
        n.dirs
    );
    let next_prefix = if depth == 0 {
        String::new()
    } else if is_last {
        format!("{}    ", prefix)
    } else {
        format!("{}│   ", prefix)
    };
    // Directories only, largest first (as the original CLI did).
    let mut kids: Vec<NodeId> = n.children.iter().copied().filter(|&c| tree.get(c).is_dir).collect();
    kids.sort_by_key(|&c| std::cmp::Reverse(tree.get(c).size));
    let last = kids.len().saturating_sub(1);
    for (i, c) in kids.into_iter().enumerate() {
        print_node(tree, c, &next_prefix, i == last, max_depth, depth + 1);
    }
}

/// Parsed `--cli` arguments.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CliOptions {
    pub target: PathBuf,
    pub max_depth: usize,
    /// `--export FILE` (csv / json / html chosen by extension).
    pub export: Option<PathBuf>,
    /// `--changes`: compare with the previous stored scan of the same root and store this one.
    pub changes: bool,
    /// `--cleanup`: list reclaimable folders (node_modules, build output, ...).
    pub cleanup: bool,
}

pub fn parse_args(args: &[String]) -> Result<CliOptions, String> {
    let mut o = CliOptions { target: PathBuf::from("."), max_depth: 3, ..Default::default() };
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-d" | "--depth" => {
                i += 1;
                o.max_depth = args.get(i).and_then(|v| v.parse().ok()).ok_or("--depth needs a number")?;
            }
            "--export" => {
                i += 1;
                let p = PathBuf::from(args.get(i).ok_or("--export needs a file name")?);
                if crate::export::Format::from_path(&p).is_none() {
                    return Err(format!("--export: unknown format for {} (use .csv, .json or .html)", p.display()));
                }
                o.export = Some(p);
            }
            "--changes" => o.changes = true,
            "--cleanup" => o.cleanup = true,
            other if !other.starts_with('-') => o.target = PathBuf::from(other),
            other => return Err(format!("unknown option {other}")),
        }
        i += 1;
    }
    Ok(o)
}

fn print_changes(tree: &Tree) {
    use crate::analysis::snapshot;
    let Some(dir) = snapshot::history_dir() else {
        println!("  No settings folder available for the scan history.");
        return;
    };
    match snapshot::record_and_compare(&dir, tree, chrono::Utc::now().timestamp()) {
        None => println!("  First scan of this folder recorded; run again later to see changes."),
        Some((taken, changes)) => {
            println!("  Changes since the scan of {} ({} folders changed):", crate::scan::format_time(taken), changes.len());
            for c in changes.iter().take(25) {
                let d = c.delta();
                let sign = if d >= 0 { "+" } else { "-" };
                let path = if c.path.is_empty() { ".".to_string() } else { c.path.clone() };
                println!("  {sign}{:>10}  {}", format_bytes(d.unsigned_abs()), path);
            }
        }
    }
}

fn print_cleanup(tree: &Tree) {
    use crate::analysis::insights;
    let found = insights::reclaimable(tree);
    let total: u64 = found.iter().map(|f| f.size).sum();
    println!("  Reclaimable: {} in {} folders", format_bytes(total), found.len());
    for f in found.iter().take(50) {
        println!("  {:>10}  {:<28} {}", format_bytes(f.size), f.kind, tree.path_of(f.id).display());
    }
    println!("  Empty folders: {}", insights::empty_dirs(tree).len());
}

pub fn run(args: &[String]) {
    let opts = match parse_args(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    let target = opts.target.clone();
    let max_depth = opts.max_depth;
    let canon = std::fs::canonicalize(&target).unwrap_or(target);
    let canon = PathBuf::from(crate::scan::model::strip_verbatim(&canon.to_string_lossy()));
    let abs = normalize_root(&canon);
    println!("\n  {} - {}", "TreeSize Rust Clone".bold().yellow(), "CLI mode".white());
    println!("  Target: {}\n", abs.display().to_string().cyan());
    let res = scan_simple(&abs);
    print_node(&res.tree, 0, "", true, max_depth, 0);
    let root = res.tree.root().expect("root");
    println!(
        "\n  Scanned: {} ({} on disk) in {} files across {} directories; {} errors",
        format_bytes(root.size).bold().white(),
        format_bytes(root.alloc),
        root.files.to_string().cyan(),
        root.dirs.to_string().cyan(),
        res.errors.len()
    );
    println!("  Time elapsed: {}\n", format!("{:.2?}", res.elapsed).bold().green());
    if opts.cleanup {
        print_cleanup(&res.tree);
        println!();
    }
    if opts.changes {
        print_changes(&res.tree);
        println!();
    }
    if let Some(path) = &opts.export {
        let fmt = crate::export::Format::from_path(path).expect("validated by parse_args");
        match crate::export::export_to_file(&res.tree, Tree::ROOT, fmt, 8, path) {
            Ok(()) => println!("  Exported to {}\n", path.display()),
            Err(e) => {
                eprintln!("error: cannot write {}: {e}", path.display());
                std::process::exit(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_flags_and_rejects_bad_ones() {
        let o = parse_args(&a(&["C:\\data", "-d", "5", "--export", "out.CSV", "--changes", "--cleanup"])).unwrap();
        assert_eq!((o.max_depth, o.changes, o.cleanup), (5, true, true));
        assert_eq!(o.target, PathBuf::from("C:\\data"));
        assert_eq!(o.export, Some(PathBuf::from("out.CSV")));
        assert_eq!(parse_args(&a(&[])).unwrap().max_depth, 3);
        assert!(parse_args(&a(&["--export", "x.txt"])).unwrap_err().contains("unknown format"));
        assert!(parse_args(&a(&["--export"])).is_err());
        assert!(parse_args(&a(&["-d", "many"])).is_err());
        assert!(parse_args(&a(&["--nope"])).unwrap_err().contains("--nope"));
    }

    #[test]
    fn export_format_follows_the_extension() {
        use crate::export::Format;
        assert_eq!(Format::from_path(std::path::Path::new("r.htm")), Some(Format::Html));
        assert_eq!(Format::from_path(std::path::Path::new("r.JSON")), Some(Format::Json));
        assert_eq!(Format::from_path(std::path::Path::new("noext")), None);
    }
}

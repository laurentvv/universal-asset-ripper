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

pub fn run(args: &[String]) {
    let mut target = PathBuf::from(".");
    let mut max_depth = 3usize;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-d" | "--depth" => {
                if i + 1 < args.len() {
                    max_depth = args[i + 1].parse().unwrap_or(3);
                    i += 1;
                }
            }
            other if !other.starts_with('-') => target = PathBuf::from(other),
            _ => {}
        }
        i += 1;
    }
    let canon = std::fs::canonicalize(&target).unwrap_or(target);
    let canon = PathBuf::from(canon.to_string_lossy().trim_start_matches(r"\\?\").to_string());
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
}

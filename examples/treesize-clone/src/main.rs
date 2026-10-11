use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use colored::*;
use rayon::prelude::*;

#[derive(Debug, Clone)]
struct EntryNode {
    path: PathBuf,
    name: String,
    size: u64,
    file_count: u64,
    dir_count: u64,
    children: Vec<EntryNode>,
}

impl EntryNode {
    fn scan(path: &Path) -> Self {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path.to_str().unwrap_or("?"))
            .to_string();

        let entries: Vec<PathBuf> = match fs::read_dir(path) {
            Ok(read_dir) => read_dir.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(_) => return Self {
                path: path.to_path_buf(),
                name,
                size: 0,
                file_count: 0,
                dir_count: 0,
                children: Vec::new(),
            },
        };

        let (dirs, files): (Vec<PathBuf>, Vec<PathBuf>) = entries
            .into_iter()
            .partition(|p| p.is_dir());

        // Process direct files
        let mut file_size = 0u64;
        let mut file_count = 0u64;
        for f in &files {
            if let Ok(meta) = fs::symlink_metadata(f) {
                file_size += meta.len();
                file_count += 1;
            }
        }

        // Process subdirectories in parallel with Rayon
        let mut children: Vec<EntryNode> = dirs
            .par_iter()
            .map(|dir| EntryNode::scan(dir))
            .collect();

        // Sort children by size descending (like TreeSize)
        children.sort_by(|a, b| b.size.cmp(&a.size));

        let mut total_size = file_size;
        let mut total_files = file_count;
        let mut total_dirs = children.len() as u64;

        for child in &children {
            total_size += child.size;
            total_files += child.file_count;
            total_dirs += child.dir_count;
        }

        Self {
            path: path.to_path_buf(),
            name,
            size: total_size,
            file_count: total_files,
            dir_count: total_dirs,
            children,
        }
    }

    fn print_tree(&self, prefix: &str, is_last: bool, parent_size: u64, max_depth: usize, current_depth: usize) {
        if current_depth > max_depth {
            return;
        }

        let percent = if parent_size > 0 {
            (self.size as f64 / parent_size as f64) * 100.0
        } else {
            100.0
        };

        let bar_width = 15;
        let filled = ((percent / 100.0) * bar_width as f64).round() as usize;
        let filled = filled.min(bar_width);
        let empty = bar_width.saturating_sub(filled);

        let bar = format!(
            "[{}{}]",
            "█".repeat(filled).yellow(),
            "░".repeat(empty).dimmed()
        );

        let size_formatted = format_bytes(self.size);
        let percent_str = format!("{:>5.1}%", percent).cyan();

        let branch = if current_depth == 0 {
            ""
        } else if is_last {
            "└── "
        } else {
            "├── "
        };

        println!(
            "{}{}{} {:>10}  {} {:>6}  ({:>4} files, {:>3} dirs)",
            prefix.dimmed(),
            branch.dimmed(),
            self.name.bold().green(),
            size_formatted.bold().white(),
            bar,
            percent_str,
            self.file_count,
            self.dir_count
        );

        let next_prefix = if current_depth == 0 {
            "".to_string()
        } else if is_last {
            format!("{}    ", prefix)
        } else {
            format!("{}│   ", prefix)
        };

        for (idx, child) in self.children.iter().enumerate() {
            let last_child = idx == self.children.len() - 1;
            child.print_tree(&next_prefix, last_child, self.size, max_depth, current_depth + 1);
        }
    }
}

fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    const TB: u64 = 1024 * GB;

    if bytes >= TB {
        format!("{:.2} TB", bytes as f64 / TB as f64)
    } else if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut target_dir = PathBuf::from(".");
    let mut max_depth = 3usize;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-d" | "--depth" => {
                if i + 1 < args.len() {
                    max_depth = args[i + 1].parse().unwrap_or(3);
                    i += 1;
                }
            }
            "-h" | "--help" => {
                println!("{}", "TreeSize Clone in Rust (using extracted assets)".bold().cyan());
                println!("Usage: treesize-clone [PATH] [--depth <N>]");
                println!();
                println!("Options:");
                println!("  -d, --depth <N>   Maximum display depth (default: 3)");
                println!("  -h, --help        Show this help message");
                return;
            }
            other => {
                if !other.starts_with('-') {
                    target_dir = PathBuf::from(other);
                }
            }
        }
        i += 1;
    }

    let abs_target = match fs::canonicalize(&target_dir) {
        Ok(p) => p,
        Err(_) => target_dir.clone(),
    };

    println!();
    println!("{}", "═══════════════════════════════════════════════════════════════════".cyan());
    println!("  {} - {}", "TreeSize Rust Clone".bold().yellow(), "High-Performance Disk Scanner".white());
    println!("  Target: {}", abs_target.display().to_string().cyan());
    println!("{}", "═══════════════════════════════════════════════════════════════════".cyan());
    println!();

    let start = Instant::now();
    let root = EntryNode::scan(&abs_target);
    let duration = start.elapsed();

    root.print_tree("", true, root.size, max_depth, 0);

    println!();
    println!("{}", "───────────────────────────────────────────────────────────────────".dimmed());
    println!(
        "  Scanned: {} in {} files across {} directories",
        format_bytes(root.size).bold().white(),
        root.file_count.to_string().cyan(),
        root.dir_count.to_string().cyan()
    );
    println!("  Time elapsed: {}", format!("{:.2?}", duration).bold().green());
    println!("{}", "───────────────────────────────────────────────────────────────────".dimmed());
    println!();
}

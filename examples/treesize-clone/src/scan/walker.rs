//! Parallel directory walker. Builds a temporary owned tree with rayon,
//! then flattens it into the arena `Tree`.

use super::model::{Node, NodeId, Tree, NONE};
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Instant, UNIX_EPOCH};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
#[cfg(windows)]
const FILE_ATTRIBUTE_SPARSE_FILE: u32 = 0x200;
#[cfg(windows)]
const FILE_ATTRIBUTE_COMPRESSED: u32 = 0x800;
#[cfg(windows)]
const CLUSTER: u64 = 4096;

/// Live counters shared with the UI.
#[derive(Default)]
pub struct Progress {
    pub files: AtomicU64,
    pub dirs: AtomicU64,
    pub bytes: AtomicU64,
    pub errors: AtomicU64,
    pub current: Mutex<String>,
}

#[derive(Debug, Clone)]
pub struct ScanError {
    pub path: PathBuf,
    pub message: String,
}

pub struct ScanResult {
    pub root: PathBuf,
    pub tree: Tree,
    pub errors: Vec<ScanError>,
    pub cancelled: bool,
    pub elapsed: std::time::Duration,
}

struct TNode {
    name: String,
    size: u64,
    alloc: u64,
    files: u64,
    dirs: u64,
    modified: i64,
    attrs: u32,
    is_dir: bool,
    is_link: bool,
    children: Vec<TNode>,
}

struct Ctx<'a> {
    progress: &'a Progress,
    cancel: &'a AtomicBool,
    excludes: &'a [PathBuf],
    errors: Mutex<Vec<ScanError>>,
}

impl Ctx<'_> {
    fn err(&self, path: &Path, e: &std::io::Error) {
        self.progress.errors.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut v) = self.errors.lock() {
            if v.len() < 10_000 {
                v.push(ScanError { path: path.to_path_buf(), message: e.to_string() });
            }
        }
    }
}

fn mtime(meta: &fs::Metadata) -> i64 {
    match meta.modified() {
        Ok(t) => match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_secs() as i64,
            Err(e) => -(e.duration().as_secs() as i64),
        },
        Err(_) => 0,
    }
}

#[cfg(windows)]
fn attrs_of(meta: &fs::Metadata) -> u32 {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes()
}
#[cfg(not(windows))]
fn attrs_of(_meta: &fs::Metadata) -> u32 {
    0
}

/// Allocated size on disk. Windows: GetCompressedFileSize for compressed/sparse
/// files, otherwise logical size rounded up to a 4 KiB cluster. Unix: st_blocks.
#[cfg(windows)]
fn allocated(path: &Path, _meta: &fs::Metadata, logical: u64, attrs: u32) -> u64 {
    if logical == 0 {
        return 0;
    }
    if attrs & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE) != 0 {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut high: u32 = 0;
        // SAFETY: `wide` is a valid NUL-terminated UTF-16 string; `high` is a valid out pointer.
        let low = unsafe { windows_sys::Win32::Storage::FileSystem::GetCompressedFileSizeW(wide.as_ptr(), &mut high) };
        // SAFETY: plain thread-local error query.
        if low != u32::MAX || unsafe { windows_sys::Win32::Foundation::GetLastError() } == 0 {
            return ((high as u64) << 32) | low as u64;
        }
    }
    logical.div_ceil(CLUSTER) * CLUSTER
}
#[cfg(not(windows))]
fn allocated(_path: &Path, meta: &fs::Metadata, _logical: u64, _attrs: u32) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.blocks() * 512
}

fn walk(path: &Path, name: String, meta: Option<&fs::Metadata>, ctx: &Ctx) -> TNode {
    let mut node = TNode {
        name,
        size: 0,
        alloc: 0,
        files: 0,
        dirs: 0,
        modified: meta.map(mtime).unwrap_or(0),
        attrs: meta.map(attrs_of).unwrap_or(0),
        is_dir: true,
        is_link: false,
        children: Vec::new(),
    };
    if ctx.cancel.load(Ordering::Relaxed) {
        return node;
    }
    ctx.progress.dirs.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut cur) = ctx.progress.current.try_lock() {
        cur.clear();
        cur.push_str(&path.to_string_lossy());
    }
    let rd = match fs::read_dir(path) {
        Ok(rd) => rd,
        Err(e) => {
            ctx.err(path, &e);
            return node;
        }
    };
    let mut subdirs: Vec<(PathBuf, String, fs::Metadata)> = Vec::new();
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                ctx.err(path, &e);
                continue;
            }
        };
        let epath = entry.path();
        if ctx.excludes.iter().any(|x| x == &epath) {
            continue;
        }
        let ename = entry.file_name().to_string_lossy().into_owned();
        // `DirEntry::metadata` does not follow links (and is free on Windows).
        let emeta = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                ctx.err(&epath, &e);
                continue;
            }
        };
        let attrs = attrs_of(&emeta);
        let ft = emeta.file_type();
        let is_link = ft.is_symlink() || (attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 && ft.is_dir());
        if is_link {
            // Symlinks / junctions: record the entry, never descend (no loops).
            node.children.push(TNode {
                name: ename,
                size: 0,
                alloc: 0,
                files: 0,
                dirs: 0,
                modified: mtime(&emeta),
                attrs,
                is_dir: ft.is_dir(),
                is_link: true,
                children: Vec::new(),
            });
        } else if ft.is_dir() {
            subdirs.push((epath, ename, emeta));
        } else {
            let logical = emeta.len();
            let alloc = allocated(&epath, &emeta, logical, attrs);
            ctx.progress.files.fetch_add(1, Ordering::Relaxed);
            ctx.progress.bytes.fetch_add(logical, Ordering::Relaxed);
            node.children.push(TNode {
                name: ename,
                size: logical,
                alloc,
                files: 0,
                dirs: 0,
                modified: mtime(&emeta),
                attrs,
                is_dir: false,
                is_link: false,
                children: Vec::new(),
            });
        }
    }
    let sub: Vec<TNode> = subdirs
        .par_iter()
        .map(|(p, n, m)| walk(p, n.clone(), Some(m), ctx))
        .collect();
    node.children.extend(sub);
    for c in &node.children {
        node.size += c.size;
        node.alloc += c.alloc;
        if c.is_dir {
            node.dirs += 1 + c.dirs;
            node.files += c.files;
        } else {
            node.files += 1;
        }
    }
    node
}

fn flatten(t: TNode, parent: NodeId, out: &mut Vec<Node>) -> NodeId {
    let id = out.len() as NodeId;
    out.push(Node {
        name: t.name,
        parent,
        children: Vec::with_capacity(t.children.len()),
        size: t.size,
        alloc: t.alloc,
        files: t.files,
        dirs: t.dirs,
        modified: t.modified,
        attrs: t.attrs,
        is_dir: t.is_dir,
        is_link: t.is_link,
    });
    for c in t.children {
        let cid = flatten(c, id, out);
        out[id as usize].children.push(cid);
    }
    id
}

/// Scan `root` synchronously (blocks the calling thread). Cancel via `cancel`.
pub fn scan_blocking(root: &Path, progress: &Progress, cancel: &AtomicBool, excludes: &[PathBuf]) -> ScanResult {
    let start = Instant::now();
    let ctx = Ctx { progress, cancel, excludes, errors: Mutex::new(Vec::new()) };
    let root_name = root.to_string_lossy().into_owned();
    let meta = fs::metadata(root).ok();
    let pool = rayon::ThreadPoolBuilder::new().stack_size(32 << 20).build();
    let troot = match &pool {
        Ok(p) => p.install(|| walk(root, root_name, meta.as_ref(), &ctx)),
        Err(_) => walk(root, root_name, meta.as_ref(), &ctx),
    };
    let mut nodes = Vec::new();
    flatten(troot, NONE, &mut nodes);
    ScanResult {
        root: root.to_path_buf(),
        tree: Tree { nodes },
        errors: ctx.errors.into_inner().unwrap_or_default(),
        cancelled: cancel.load(Ordering::Relaxed),
        elapsed: start.elapsed(),
    }
}

/// Convenience used by the CLI and tests: scan without progress/cancel plumbing.
pub fn scan_simple(root: &Path) -> ScanResult {
    scan_blocking(root, &Progress::default(), &AtomicBool::new(false), &[])
}

//! Parallel directory walker. Builds a temporary owned tree with rayon,
//! then flattens it into the arena `Tree`.

use super::model::{DirectFiles, ExtAgg, LiveStats, Node, NodeId, RankedFile, Tree, NONE};
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

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

/// A directory of the live arena: created the moment it is discovered, direct totals filled in
/// once its entries have been read.
struct LDir {
    name: String,
    parent: NodeId,
    kids: Vec<NodeId>,
    size: u64,
    alloc: u64,
    files: u64,
    dir_links: u64,
    modified: i64,
    attrs: u32,
    done: bool,
}

/// Shared, lock-protected directory skeleton that the ticker turns into partial `Tree` snapshots.
/// Children always have a larger index than their parent.
struct Live {
    dirs: Mutex<Vec<LDir>>,
    /// extension -> (count, size, alloc) of every file seen so far.
    types: Mutex<HashMap<String, (u64, u64, u64)>>,
    top: Mutex<Top>,
    /// Smallest size currently kept in the (full) largest list: smaller files are not offered.
    largest_floor: AtomicU64,
    /// Newest mtime currently kept in the (full) oldest list: newer files are not offered.
    oldest_ceil: AtomicI64,
}

impl Default for Live {
    fn default() -> Self {
        Live {
            dirs: Mutex::default(),
            types: Mutex::default(),
            top: Mutex::default(),
            largest_floor: AtomicU64::new(0),
            oldest_ceil: AtomicI64::new(i64::MAX),
        }
    }
}

/// Size of the streamed "Top N" lists.
pub const TOP_N: usize = 100;

#[derive(Default)]
struct Top {
    largest: Vec<RankedFile>,
    oldest: Vec<RankedFile>,
}

fn trim_largest(v: &mut Vec<RankedFile>) {
    v.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.name.cmp(&b.name)));
    v.truncate(TOP_N);
}

fn trim_oldest(v: &mut Vec<RankedFile>) {
    v.sort_by(|a, b| a.modified.cmp(&b.modified).then_with(|| a.name.cmp(&b.name)));
    v.truncate(TOP_N);
}

impl Live {
    fn add(&self, name: String, parent: NodeId, modified: i64, attrs: u32) -> NodeId {
        let mut d = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
        let id = d.len() as NodeId;
        d.push(LDir { name, parent, kids: Vec::new(), size: 0, alloc: 0, files: 0, dir_links: 0, modified, attrs, done: false });
        if parent != NONE {
            d[parent as usize].kids.push(id);
        }
        id
    }

    fn set_direct(&self, id: NodeId, size: u64, alloc: u64, files: u64, dir_links: u64) {
        let mut d = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
        let n = &mut d[id as usize];
        (n.size, n.alloc, n.files, n.dir_links) = (size, alloc, files, dir_links);
    }

    /// Fold the files of one directory into the live aggregates and the bounded top lists.
    fn record_files(&self, lid: NodeId, entries: &[TNode]) {
        let mut local: HashMap<String, (u64, u64, u64)> = HashMap::new();
        let floor = self.largest_floor.load(Ordering::Relaxed);
        let ceil = self.oldest_ceil.load(Ordering::Relaxed);
        let (mut big, mut old): (Vec<&TNode>, Vec<&TNode>) = (Vec::new(), Vec::new());
        for f in entries.iter().filter(|f| !f.is_dir && !f.is_link) {
            let e = local.entry(crate::analysis::types::ext_of(&f.name)).or_default();
            e.0 += 1;
            e.1 += f.size;
            e.2 += f.alloc;
            if f.size > floor || floor == 0 {
                big.push(f);
            }
            if f.modified != 0 && f.modified < ceil {
                old.push(f);
            }
        }
        big.sort_by_key(|f| std::cmp::Reverse(f.size));
        big.truncate(TOP_N);
        old.sort_by_key(|f| f.modified);
        old.truncate(TOP_N);
        let rank = |f: &&TNode| RankedFile { dir: lid, name: f.name.clone(), size: f.size, modified: f.modified };
        {
            let mut t = self.types.lock().unwrap_or_else(|e| e.into_inner());
            for (k, v) in local {
                let e = t.entry(k).or_default();
                e.0 += v.0;
                e.1 += v.1;
                e.2 += v.2;
            }
        }
        if big.is_empty() && old.is_empty() {
            return;
        }
        let mut top = self.top.lock().unwrap_or_else(|e| e.into_inner());
        top.largest.extend(big.iter().map(rank));
        top.oldest.extend(old.iter().map(rank));
        if top.largest.len() > TOP_N * 4 {
            trim_largest(&mut top.largest);
            if top.largest.len() >= TOP_N {
                self.largest_floor.store(top.largest[TOP_N - 1].size, Ordering::Relaxed);
            }
        }
        if top.oldest.len() > TOP_N * 4 {
            trim_oldest(&mut top.oldest);
            if top.oldest.len() >= TOP_N {
                self.oldest_ceil.store(top.oldest[TOP_N - 1].modified, Ordering::Relaxed);
            }
        }
    }

    fn finish(&self, id: NodeId) {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner())[id as usize].done = true;
    }

    /// Consistent snapshot: directories only, totals aggregated up to the root, unfinished
    /// directories flagged `scanning`. Sizes only ever grow from one snapshot to the next.
    fn snapshot(&self) -> Tree {
        let mut nodes: Vec<Node> = {
            let d = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
            d.iter()
                .map(|n| Node {
                    name: n.name.clone(),
                    parent: n.parent,
                    children: n.kids.clone(),
                    size: n.size,
                    alloc: n.alloc,
                    files: n.files,
                    dirs: n.dir_links,
                    modified: n.modified,
                    attrs: n.attrs,
                    is_dir: true,
                    is_link: false,
                    scanning: !n.done,
                })
                .collect()
        };
        let direct: Vec<DirectFiles> = nodes.iter().map(|n| DirectFiles { count: n.files, size: n.size, alloc: n.alloc, modified: 0 }).collect();
        for i in (1..nodes.len()).rev() {
            let (size, alloc, files, dirs, parent) = {
                let n = &nodes[i];
                (n.size, n.alloc, n.files, n.dirs, n.parent as usize)
            };
            let p = &mut nodes[parent];
            p.size += size;
            p.alloc += alloc;
            p.files += files;
            p.dirs += 1 + dirs;
        }
        let mut types: Vec<ExtAgg> = {
            let t = self.types.lock().unwrap_or_else(|e| e.into_inner());
            t.iter().map(|(k, v)| ExtAgg { ext: k.clone(), count: v.0, size: v.1, alloc: v.2 }).collect()
        };
        types.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.ext.cmp(&b.ext)));
        let (mut largest, mut oldest) = {
            let t = self.top.lock().unwrap_or_else(|e| e.into_inner());
            (t.largest.clone(), t.oldest.clone())
        };
        trim_largest(&mut largest);
        trim_oldest(&mut oldest);
        Tree { nodes, live: Some(Box::new(LiveStats { direct, types, largest, oldest })) }
    }
}

/// Receives partial snapshots while a scan runs.
pub type Sink<'a> = &'a (dyn Fn(Tree) + Sync);

const FIRST_SNAPSHOT: Duration = Duration::from_millis(150);
const MIN_SNAPSHOT_GAP: Duration = Duration::from_millis(200);

struct Ctx<'a> {
    live: &'a Live,
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

fn walk(path: &Path, name: String, meta: Option<&fs::Metadata>, ctx: &Ctx, lid: NodeId) -> TNode {
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
            ctx.live.finish(lid);
            return node;
        }
    };
    let mut subdirs: Vec<(PathBuf, String, fs::Metadata, NodeId)> = Vec::new();
    let (mut d_size, mut d_alloc, mut d_files, mut d_links) = (0u64, 0u64, 0u64, 0u64);
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
            if ft.is_dir() {
                d_links += 1;
            } else {
                d_files += 1;
            }
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
            // Registered immediately so the folder shows up in the live tree before it is read.
            let id = ctx.live.add(ename.clone(), lid, mtime(&emeta), attrs);
            subdirs.push((epath, ename, emeta, id));
        } else {
            let logical = emeta.len();
            let alloc = allocated(&epath, &emeta, logical, attrs);
            ctx.progress.files.fetch_add(1, Ordering::Relaxed);
            ctx.progress.bytes.fetch_add(logical, Ordering::Relaxed);
            d_size += logical;
            d_alloc += alloc;
            d_files += 1;
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
    ctx.live.record_files(lid, &node.children);
    ctx.live.set_direct(lid, d_size, d_alloc, d_files, d_links);
    let sub: Vec<TNode> = subdirs
        .par_iter()
        .map(|(p, n, m, id)| walk(p, n.clone(), Some(m), ctx, *id))
        .collect();
    node.children.extend(sub);
    ctx.live.finish(lid);
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
        scanning: false,
    });
    for c in t.children {
        let cid = flatten(c, id, out);
        out[id as usize].children.push(cid);
    }
    id
}

/// Scan `root` synchronously (blocks the calling thread). Cancel via `cancel`.
pub fn scan_blocking(root: &Path, progress: &Progress, cancel: &AtomicBool, excludes: &[PathBuf]) -> ScanResult {
    scan_live(root, progress, cancel, excludes, None)
}

/// Like `scan_blocking`; with a `sink`, partial snapshots (directories only, aggregated totals,
/// unfinished directories flagged `scanning`) are delivered every ~200 ms from a helper thread,
/// plus a last one when the walk ends. The sink must never block the scan.
pub fn scan_live(root: &Path, progress: &Progress, cancel: &AtomicBool, excludes: &[PathBuf], sink: Option<Sink>) -> ScanResult {
    let start = Instant::now();
    let live = Live::default();
    let ctx = Ctx { live: &live, progress, cancel, excludes, errors: Mutex::new(Vec::new()) };
    let root_name = root.to_string_lossy().into_owned();
    let meta = fs::metadata(root).ok();
    let rid = live.add(root_name.clone(), NONE, meta.as_ref().map(mtime).unwrap_or(0), meta.as_ref().map(attrs_of).unwrap_or(0));
    let pool = rayon::ThreadPoolBuilder::new().stack_size(32 << 20).build();
    let finished = AtomicBool::new(false);
    let troot = std::thread::scope(|s| {
        if let Some(sink) = sink {
            s.spawn(|| {
                let mut wait = FIRST_SNAPSHOT;
                'outer: loop {
                    let until = Instant::now() + wait;
                    while Instant::now() < until {
                        if finished.load(Ordering::Relaxed) {
                            break 'outer;
                        }
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    let t = Instant::now();
                    sink(live.snapshot());
                    // Back off when snapshots get expensive so they never steal the scan's time.
                    wait = MIN_SNAPSHOT_GAP.max(t.elapsed() * 4);
                }
            });
        }
        let troot = match &pool {
            Ok(p) => p.install(|| walk(root, root_name.clone(), meta.as_ref(), &ctx, rid)),
            Err(_) => walk(root, root_name.clone(), meta.as_ref(), &ctx, rid),
        };
        finished.store(true, Ordering::Relaxed);
        troot
    });
    if let Some(sink) = sink {
        sink(live.snapshot());
    }
    // Exact reservation: growing by doubling would transiently need twice the arena (hundreds of MB on a big drive).
    let mut nodes = Vec::with_capacity((troot.files + troot.dirs) as usize + 1);
    flatten(troot, NONE, &mut nodes);
    ScanResult {
        root: root.to_path_buf(),
        tree: Tree { nodes, live: None },
        errors: ctx.errors.into_inner().unwrap_or_default(),
        cancelled: cancel.load(Ordering::Relaxed),
        elapsed: start.elapsed(),
    }
}

/// Convenience used by the CLI and tests: scan without progress/cancel plumbing.
pub fn scan_simple(root: &Path) -> ScanResult {
    scan_blocking(root, &Progress::default(), &AtomicBool::new(false), &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_aggregates_and_flags_unfinished_dirs() {
        let live = Live::default();
        let root = live.add("R".into(), NONE, 0, 0);
        let a = live.add("a".into(), root, 0, 0);
        let b = live.add("b".into(), a, 0, 0);
        live.set_direct(root, 1, 4096, 1, 0);
        live.set_direct(a, 10, 4096, 2, 0);
        live.set_direct(b, 100, 4096, 3, 1);
        live.finish(root);
        live.finish(b);
        let t = live.snapshot();
        let n = |i: NodeId| t.get(i);
        assert_eq!((n(root).size, n(root).files, n(root).dirs), (111, 6, 3));
        assert_eq!((n(a).size, n(a).files, n(a).dirs), (110, 5, 2));
        assert_eq!((n(b).size, n(b).files, n(b).dirs), (100, 3, 1));
        assert!(!n(root).scanning && n(a).scanning && !n(b).scanning);
        // growing a directory later never shrinks any total
        live.set_direct(b, 150, 4096, 4, 1);
        live.finish(a);
        let t2 = live.snapshot();
        assert!(t2.get(root).size >= t.get(root).size && !t2.get(a).scanning);
        // direct files are reported per directory, before aggregation
        let l = t2.live.as_ref().unwrap();
        assert_eq!((l.direct[root as usize].count, l.direct[root as usize].size), (1, 1));
        assert_eq!((l.direct[b as usize].count, l.direct[b as usize].size), (4, 150));
    }

    fn file(name: &str, size: u64, modified: i64) -> TNode {
        TNode { name: name.into(), size, alloc: size, files: 0, dirs: 0, modified, attrs: 0, is_dir: false, is_link: false, children: Vec::new() }
    }

    #[test]
    fn live_stats_aggregate_and_stay_bounded() {
        let live = Live::default();
        let root = live.add("R".into(), NONE, 0, 0);
        // 3 batches of 150 files each: far more than TOP_N in total
        for batch in 0..3u64 {
            let files: Vec<TNode> = (0..150u64).map(|i| file(&format!("f{batch}_{i}.dat"), batch * 1000 + i, 1000 + (batch * 150 + i) as i64)).collect();
            live.record_files(root, &files);
        }
        live.record_files(root, &[file("Readme.TXT", 5, 1), file("noext", 7, 2), file("junction.dat", 0, 3)]);
        live.set_direct(root, 0, 0, 0, 0);
        let t = live.snapshot();
        let l = t.live.as_ref().unwrap();
        assert_eq!(l.largest.len(), TOP_N);
        assert_eq!(l.oldest.len(), TOP_N);
        assert!(l.largest.windows(2).all(|w| w[0].size >= w[1].size), "largest sorted descending");
        assert!(l.oldest.windows(2).all(|w| w[0].modified <= w[1].modified), "oldest sorted ascending");
        assert_eq!(l.largest[0].size, 2149);
        assert_eq!(l.oldest[0].modified, 1);
        let dat = l.types.iter().find(|e| e.ext == "dat").unwrap();
        assert_eq!(dat.count, 451);
        assert!(l.types.iter().any(|e| e.ext == "txt" && e.count == 1), "extensions are lower-cased");
        assert!(l.types.iter().any(|e| e.ext.is_empty() && e.size == 7));
        assert_eq!(l.types.iter().map(|e| e.count).sum::<u64>(), 453);
        assert!(l.types.windows(2).all(|w| w[0].size >= w[1].size));
    }
}

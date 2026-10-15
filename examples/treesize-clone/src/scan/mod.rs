//! Scan engine: parallel walker + arena tree model, run on a background thread.

pub mod mft;
pub mod model;
pub mod walker;

pub use model::{format_bytes, format_time, set_units, NodeId, Tree, NONE};
#[allow(unused_imports)]
pub use walker::{scan_blocking, scan_live, scan_simple, Progress, ScanError, ScanResult};

use crossbeam_channel::{bounded, Receiver};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub enum ScanMsg {
    /// Informational message for the status bar (for example the fast-scan fallback reason).
    Notice(String),
    /// Live snapshot of the tree built so far (directories only, aggregated totals, unfinished
    /// directories flagged `scanning`). Dropped when the UI is busy, so it never slows the scan.
    Partial(Tree),
    Done(Box<ScanResult>),
}

/// Handle to a running background scan.
pub struct ScanHandle {
    pub progress: Arc<Progress>,
    pub cancel: Arc<AtomicBool>,
    pub rx: Receiver<ScanMsg>,
}

impl ScanHandle {
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// Used bytes of the volume holding `root`, only when `root` is a drive root (for a progress estimate).
#[cfg(windows)]
pub fn drive_used_bytes(root: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let s = root.to_string_lossy();
    let t = s.trim_end_matches(['\\', '/']);
    if t.len() != 2 || !t.ends_with(':') {
        return None;
    }
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut _free, mut total, mut total_free) = (0u64, 0u64, 0u64);
    // SAFETY: `wide` is NUL-terminated; the three out pointers are valid for the call.
    let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut _free, &mut total, &mut total_free) };
    (ok != 0 && total >= total_free).then_some(total - total_free)
}

/// Free / total space, cluster size and file system of the volume holding a scanned path.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DiskInfo {
    pub free: u64,
    pub total: u64,
    pub cluster: u32,
    pub fs: String,
}

/// `C:\Windows\System32` -> `C:\` (first prefix + root components).
pub fn volume_root(p: &std::path::Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Prefix(_) | Component::RootDir => out.push(c.as_os_str()),
            _ => break,
        }
    }
    out
}

#[cfg(windows)]
pub fn disk_info(path: &std::path::Path) -> Option<DiskInfo> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetVolumeInformationW};
    let root = volume_root(path);
    if root.as_os_str().is_empty() {
        return None;
    }
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut free_user, mut total, mut free) = (0u64, 0u64, 0u64);
    // SAFETY: `wide` is NUL-terminated; the out pointers are valid for the call.
    if unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_user, &mut total, &mut free) } == 0 {
        return None;
    }
    let (mut spc, mut bps, mut fc, mut tc) = (0u32, 0u32, 0u32, 0u32);
    // SAFETY: as above.
    let cluster = if unsafe { GetDiskFreeSpaceW(wide.as_ptr(), &mut spc, &mut bps, &mut fc, &mut tc) } != 0 { spc * bps } else { 0 };
    let mut fsbuf = [0u16; 32];
    // SAFETY: only the file-system name buffer is requested; the other out pointers are null.
    let ok = unsafe {
        GetVolumeInformationW(wide.as_ptr(), std::ptr::null_mut(), 0, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), fsbuf.as_mut_ptr(), fsbuf.len() as u32)
    };
    let fs = if ok != 0 { String::from_utf16_lossy(&fsbuf[..fsbuf.iter().position(|&c| c == 0).unwrap_or(0)]) } else { String::new() };
    Some(DiskInfo { free, total, cluster, fs })
}

#[cfg(not(windows))]
pub fn disk_info(_path: &std::path::Path) -> Option<DiskInfo> {
    None
}

#[cfg(not(windows))]
pub fn drive_used_bytes(_root: &std::path::Path) -> Option<u64> {
    None
}

/// Start a scan on a background thread; the result arrives on `rx`.
#[allow(dead_code)]
pub fn spawn_scan(root: PathBuf, excludes: Vec<PathBuf>) -> ScanHandle {
    spawn_scan_opts(root, excludes, false)
}

/// Like `spawn_scan`; with `fast` the NTFS MFT reader is tried first and the walker is the fallback.
pub fn spawn_scan_opts(root: PathBuf, excludes: Vec<PathBuf>, fast: bool) -> ScanHandle {
    let progress = Arc::new(Progress::default());
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = bounded(2);
    let (p, c) = (progress.clone(), cancel.clone());
    std::thread::spawn(move || {
        let mut fast_res = None;
        if fast {
            match mft::try_fast_scan(&root, &p, &c, &excludes) {
                Ok(r) => fast_res = Some(r),
                Err(msg) => {
                    let _ = tx.send(ScanMsg::Notice(msg));
                }
            }
        }
        let sink = |t: Tree| {
            let _ = tx.try_send(ScanMsg::Partial(t));
        };
        let res = fast_res.unwrap_or_else(|| scan_live(&root, &p, &c, &excludes, Some(&sink)));
        let _ = tx.send(ScanMsg::Done(Box::new(res)));
    });
    ScanHandle { progress, cancel, rx }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(p: &std::path::Path, n: usize) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, vec![b'x'; n]).unwrap();
    }

    #[test]
    fn unicode_and_spaced_names_are_kept() {
        let d = tempfile::tempdir().unwrap();
        for name in ["dossier é à", "日本語 フォルダ", "emoji 😀"] {
            write(&d.path().join(name).join("fichier ü.txt"), 10);
        }
        let res = scan_simple(d.path());
        let root = res.tree.get(Tree::ROOT);
        assert_eq!((root.files, root.dirs, root.size), (3, 3, 30));
        let mut names: Vec<&str> = root.children.iter().map(|&c| res.tree.get(c).name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["dossier é à", "emoji 😀", "日本語 フォルダ"]);
        assert!(res.errors.is_empty());
    }

    #[test]
    fn paths_beyond_max_path_are_scanned() {
        let d = tempfile::tempdir().unwrap();
        let mut deep = d.path().to_path_buf();
        for _ in 0..30 {
            deep.push("abcdefghi"); // 30 x 10 chars: well past the 260 limit of legacy Win32 paths
        }
        write(&deep.join("deep.bin"), 1234);
        assert!(deep.as_os_str().len() > 280);
        let res = scan_simple(d.path());
        let root = res.tree.get(Tree::ROOT);
        assert_eq!((root.files, root.size), (1, 1234));
        assert_eq!(root.dirs, 30);
        assert!(res.errors.is_empty(), "{:?}", res.errors.len());
    }

    #[test]
    fn volume_root_is_the_drive() {
        if cfg!(windows) {
            assert_eq!(volume_root(std::path::Path::new("C:\\Windows\\System32")), PathBuf::from("C:\\"));
            assert_eq!(volume_root(std::path::Path::new("D:\\")), PathBuf::from("D:\\"));
            let d = disk_info(std::path::Path::new("C:\\Windows")).expect("C: volume info");
            assert!(d.total > d.free && d.free > 0 && d.cluster >= 512 && !d.fs.is_empty());
        } else {
            assert_eq!(volume_root(std::path::Path::new("/usr/lib")), PathBuf::from("/"));
        }
    }

    #[test]
    fn sizes_and_counts() {
        let d = tempfile::tempdir().unwrap();
        write(&d.path().join("a.txt"), 100);
        write(&d.path().join("sub/b.txt"), 2000);
        write(&d.path().join("sub/deep/c.txt"), 30);
        fs::create_dir_all(d.path().join("empty")).unwrap();
        let r = scan_simple(d.path());
        let root = r.tree.root().unwrap();
        assert_eq!(root.size, 2130);
        assert_eq!(root.files, 3);
        assert_eq!(root.dirs, 3); // sub, deep, empty
        assert!(root.alloc >= root.size || cfg!(not(windows)));
        let sub = r.tree.find_child(0, "sub").unwrap();
        assert_eq!(r.tree.get(sub).size, 2030);
        assert_eq!(r.tree.get(sub).files, 2);
        assert_eq!(r.tree.get(sub).dirs, 1);
        assert_eq!(r.tree.get(sub).parent, 0);
        let deep = r.tree.find_child(sub, "deep").unwrap();
        let c = r.tree.find_child(deep, "c.txt").unwrap();
        let expect = d.path().join("sub").join("deep").join("c.txt");
        assert_eq!(r.tree.path_of(c), expect);
        assert!(!r.cancelled);
    }

    #[test]
    fn cancel_stops_scan() {
        let d = tempfile::tempdir().unwrap();
        for i in 0..20 {
            write(&d.path().join(format!("d{i}/f.txt")), 10);
        }
        let cancel = AtomicBool::new(true);
        let r = scan_blocking(d.path(), &Progress::default(), &cancel, &[]);
        assert!(r.cancelled);
        assert_eq!(r.tree.root().unwrap().files, 0);
    }

    #[test]
    fn exclude_and_remove_subtree() {
        let d = tempfile::tempdir().unwrap();
        write(&d.path().join("keep/a"), 10);
        write(&d.path().join("skip/b"), 50);
        let ex = [d.path().join("skip")];
        let r = scan_blocking(d.path(), &Progress::default(), &AtomicBool::new(false), &ex);
        assert_eq!(r.tree.root().unwrap().size, 10);
        let mut r2 = scan_simple(d.path());
        let skip = r2.tree.find_child(0, "skip").unwrap();
        r2.tree.remove_subtree(skip);
        let root = r2.tree.root().unwrap();
        assert_eq!((root.size, root.files, root.dirs), (10, 1, 1));
    }

    #[test]
    fn symlink_loop_guard() {
        let d = tempfile::tempdir().unwrap();
        write(&d.path().join("real/f"), 5);
        let link = d.path().join("real/loop");
        #[cfg(unix)]
        let ok = std::os::unix::fs::symlink(d.path(), &link).is_ok();
        #[cfg(windows)]
        let ok = std::os::windows::fs::symlink_dir(d.path(), &link).is_ok()
            || std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(d.path())
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
        if !ok {
            eprintln!("cannot create link on this machine; skipping");
            return;
        }
        let r = scan_simple(d.path()); // must terminate
        let root = r.tree.root().unwrap();
        assert_eq!(root.size, 5);
        let real = r.tree.find_child(0, "real").unwrap();
        let l = r.tree.find_child(real, "loop").unwrap();
        assert!(r.tree.get(l).is_link);
        assert!(r.tree.get(l).children.is_empty());
    }

    #[test]
    fn background_scan_delivers_result() {
        let d = tempfile::tempdir().unwrap();
        write(&d.path().join("x/y"), 7);
        let h = spawn_scan(d.path().to_path_buf(), vec![]);
        match h.rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap() {
            ScanMsg::Done(r) => assert_eq!(r.tree.root().unwrap().size, 7),
            ScanMsg::Notice(m) => panic!("unexpected notice: {m}"),
            ScanMsg::Partial(_) => {
                // Snapshots may precede the result; the result must still arrive.
                loop {
                    match h.rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap() {
                        ScanMsg::Done(r) => {
                            assert_eq!(r.tree.root().unwrap().size, 7);
                            break;
                        }
                        ScanMsg::Partial(_) => {}
                        ScanMsg::Notice(m) => panic!("unexpected notice: {m}"),
                    }
                }
            }
        }
        assert_eq!(h.progress.files.load(Ordering::Relaxed), 1);
    }

    fn tree_of(depth: usize, fan: usize, files: usize) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        fn rec(p: &std::path::Path, depth: usize, fan: usize, files: usize) {
            for f in 0..files {
                write(&p.join(format!("f{f}.bin")), 100 + f);
            }
            if depth > 0 {
                for i in 0..fan {
                    rec(&p.join(format!("d{i}")), depth - 1, fan, files);
                }
            }
        }
        rec(d.path(), depth, fan, files);
        d
    }

    #[test]
    fn partial_snapshots_are_monotonic_and_final_matches() {
        use std::sync::Mutex;
        let d = tree_of(4, 4, 6); // 341 directories
        let snaps: Mutex<Vec<Tree>> = Mutex::new(Vec::new());
        let sink = |t: Tree| snaps.lock().unwrap().push(t);
        let r = scan_live(d.path(), &Progress::default(), &AtomicBool::new(false), &[], Some(&sink));
        let snaps = snaps.into_inner().unwrap();
        assert!(!snaps.is_empty(), "at least the final snapshot is delivered");
        let mut last = (0u64, 0u64, 0u64);
        for t in &snaps {
            let root = t.root().unwrap();
            let cur = (root.size, root.files, root.dirs);
            assert!(cur.0 >= last.0 && cur.1 >= last.1 && cur.2 >= last.2, "{cur:?} < {last:?}");
            last = cur;
            // totals are consistent: every directory equals its direct part plus its children
            for (i, n) in t.nodes.iter().enumerate() {
                assert!(n.is_dir);
                let kids: u64 = n.children.iter().map(|&c| t.get(c).size).sum();
                assert!(n.size >= kids, "node {i} smaller than its children");
                for &c in &n.children {
                    assert_eq!(t.get(c).parent as usize, i);
                    assert!(c as usize > i);
                }
            }
        }
        let fin = snaps.last().unwrap();
        let (a, b) = (fin.root().unwrap(), r.tree.root().unwrap());
        assert_eq!((a.size, a.alloc, a.files, a.dirs), (b.size, b.alloc, b.files, b.dirs));
        assert_eq!(fin.nodes.len(), r.tree.nodes.iter().filter(|n| n.is_dir).count());
        assert!(fin.nodes.iter().all(|n| !n.scanning), "everything is done in the final snapshot");
        assert!(r.tree.nodes.iter().all(|n| !n.scanning));
        // the blocking scan agrees
        let plain = scan_simple(d.path());
        assert_eq!(plain.tree.root().unwrap().size, b.size);
    }

    #[test]
    fn cancel_keeps_the_partial_tree() {
        let d = tree_of(3, 4, 3);
        let cancel = std::sync::Arc::new(AtomicBool::new(false));
        let seen = std::sync::atomic::AtomicUsize::new(0);
        let c2 = cancel.clone();
        // Cancel as soon as the first snapshot arrives.
        let sink = |t: Tree| {
            seen.fetch_add(t.nodes.len(), Ordering::Relaxed);
            c2.store(true, Ordering::Relaxed);
        };
        let r = scan_live(d.path(), &Progress::default(), &cancel, &[], Some(&sink));
        assert!(seen.load(Ordering::Relaxed) > 0);
        // the result is a usable (possibly smaller) tree, never empty or panicking
        assert!(r.tree.root().is_some());
        let full = scan_simple(d.path());
        assert!(r.tree.root().unwrap().size <= full.tree.root().unwrap().size);
    }

    #[test]
    fn unreadable_root_is_not_fatal() {
        let r = scan_simple(std::path::Path::new("this/path/does/not/exist"));
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.tree.nodes.len(), 1);
    }
}

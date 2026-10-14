//! Scan engine: parallel walker + arena tree model, run on a background thread.

pub mod mft;
pub mod model;
pub mod walker;

pub use model::{format_bytes, format_time, set_units, NodeId, Tree, NONE};
pub use walker::{scan_blocking, scan_simple, Progress, ScanError, ScanResult};

use crossbeam_channel::{unbounded, Receiver};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub enum ScanMsg {
    /// Informational message for the status bar (for example the fast-scan fallback reason).
    Notice(String),
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

/// Start a scan on a background thread; the result arrives on `rx`.
#[allow(dead_code)]
pub fn spawn_scan(root: PathBuf, excludes: Vec<PathBuf>) -> ScanHandle {
    spawn_scan_opts(root, excludes, false)
}

/// Like `spawn_scan`; with `fast` the NTFS MFT reader is tried first and the walker is the fallback.
pub fn spawn_scan_opts(root: PathBuf, excludes: Vec<PathBuf>, fast: bool) -> ScanHandle {
    let progress = Arc::new(Progress::default());
    let cancel = Arc::new(AtomicBool::new(false));
    let (tx, rx) = unbounded();
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
        let res = fast_res.unwrap_or_else(|| scan_blocking(&root, &p, &c, &excludes));
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
        }
        assert_eq!(h.progress.files.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn unreadable_root_is_not_fatal() {
        let r = scan_simple(std::path::Path::new("this/path/does/not/exist"));
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.tree.nodes.len(), 1);
    }
}

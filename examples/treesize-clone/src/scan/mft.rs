//! NTFS fast scan: read the Master File Table of a whole volume directly instead of walking it.
//!
//! The record parser and the tree builder are pure and unit-tested on synthetic records.
//! The raw volume reader (`\\.\X:`) needs an elevated process and has NOT been exercised against a
//! real volume in CI (no elevation there): treat it as untested on real volumes. When the process is
//! not elevated, or anything fails, the caller falls back to the regular walker.
//!
//! Known limits: hard links show under their first name only; sizes held only in `$ATTRIBUTE_LIST`
//! extension records are merged when the extension record is found, otherwise reported as 0;
//! allocated size for resident data equals the logical size; reparse points are listed, never followed.

use super::model::{Node, NodeId, Tree, NONE};
use super::walker::{Progress, ScanError, ScanResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const SECTOR: usize = 512;
const ATTR_STD_INFO: u32 = 0x10;
const ATTR_FILE_NAME: u32 = 0x30;
const ATTR_DATA: u32 = 0x80;
const ATTR_END: u32 = 0xFFFF_FFFF;
const FLAG_IN_USE: u16 = 0x0001;
const FLAG_DIR: u16 = 0x0002;
const ROOT_RECORD: u64 = 5;
const FIRST_USER_RECORD: u64 = 24;
const REPARSE: u32 = 0x400;

fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(o..o + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
}

/// FILETIME (100 ns since 1601) to Unix seconds.
pub fn filetime_to_unix(ft: u64) -> i64 {
    if ft == 0 {
        return 0;
    }
    (ft / 10_000_000) as i64 - 11_644_473_600
}

/// One run of the `$DATA` run list: `lcn == None` for a sparse hole.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub lcn: Option<u64>,
    pub len: u64,
}

/// Decode an NTFS mapping-pairs run list.
pub fn parse_runs(b: &[u8]) -> Vec<Run> {
    let mut runs = Vec::new();
    let (mut i, mut lcn) = (0usize, 0i64);
    while i < b.len() && b[i] != 0 {
        let (ls, os) = ((b[i] & 0x0F) as usize, (b[i] >> 4) as usize);
        i += 1;
        if ls == 0 || ls > 8 || os > 8 || i + ls + os > b.len() {
            break;
        }
        let mut len = 0u64;
        for k in 0..ls {
            len |= (b[i + k] as u64) << (8 * k);
        }
        i += ls;
        if os == 0 {
            runs.push(Run { lcn: None, len });
        } else {
            let mut off = 0u64;
            for k in 0..os {
                off |= (b[i + k] as u64) << (8 * k);
            }
            if b[i + os - 1] & 0x80 != 0 && os < 8 {
                off |= u64::MAX << (8 * os); // sign-extend
            }
            i += os;
            lcn = lcn.wrapping_add(off as i64);
            runs.push(Run { lcn: Some(lcn as u64), len });
        }
    }
    runs
}

/// Parsed fields of one MFT record. Fields from extension records are merged by the builder.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Record {
    pub in_use: bool,
    pub is_dir: bool,
    /// Record number of the base record, 0 for a base record itself.
    pub base: u64,
    pub parent: Option<u64>,
    pub name: Option<String>,
    pub size: Option<u64>,
    pub alloc: Option<u64>,
    pub modified: Option<i64>,
    pub attrs: Option<u32>,
    /// Run list of the unnamed `$DATA` (only when requested; used to locate the MFT itself).
    pub runs: Vec<Run>,
}

/// Undo the update-sequence-array protection. `None` when the record is torn/corrupt.
fn apply_fixups(buf: &mut [u8], record_size: usize) -> Option<()> {
    if buf.len() < record_size || !record_size.is_multiple_of(SECTOR) || buf.get(0..4)? != b"FILE" {
        return None;
    }
    let usa_off = u16_at(buf, 4)? as usize;
    let usa_cnt = u16_at(buf, 6)? as usize;
    if usa_cnt != record_size / SECTOR + 1 || usa_off + usa_cnt * 2 > record_size {
        return None;
    }
    let check = [buf[usa_off], buf[usa_off + 1]];
    for i in 1..usa_cnt {
        let end = i * SECTOR;
        if buf[end - 2..end] != check {
            return None;
        }
        let (a, b) = (buf[usa_off + 2 * i], buf[usa_off + 2 * i + 1]);
        buf[end - 2] = a;
        buf[end - 1] = b;
    }
    Some(())
}

/// Parse one record (modifies `buf` to undo fixups). `None` for non-FILE/corrupt records.
pub fn parse_record(buf: &mut [u8], record_size: usize, want_runs: bool) -> Option<Record> {
    apply_fixups(buf, record_size)?;
    let flags = u16_at(buf, 0x16)?;
    let mut rec = Record {
        in_use: flags & FLAG_IN_USE != 0,
        is_dir: flags & FLAG_DIR != 0,
        base: u64_at(buf, 0x20)? & 0x0000_FFFF_FFFF_FFFF,
        ..Default::default()
    };
    if !rec.in_use {
        return Some(rec);
    }
    let used = (u32_at(buf, 0x18)? as usize).min(record_size);
    let mut off = u16_at(buf, 0x14)? as usize;
    let mut best_ns: i32 = -1;
    while off + 16 <= used {
        let ty = u32_at(buf, off)?;
        if ty == ATTR_END {
            break;
        }
        let len = u32_at(buf, off + 4)? as usize;
        if len < 16 || off + len > used {
            break;
        }
        let attr = &buf[off..off + len];
        let nonres = attr[8] != 0;
        let name_len = attr[9];
        match ty {
            ATTR_STD_INFO if !nonres => {
                let co = u16_at(attr, 20)? as usize;
                let c = attr.get(co..)?;
                rec.modified = Some(filetime_to_unix(u64_at(c, 8)?));
                rec.attrs = Some(u32_at(c, 32)?);
            }
            ATTR_FILE_NAME if !nonres => {
                let co = u16_at(attr, 20)? as usize;
                let c = attr.get(co..)?;
                let ns = *c.get(0x41)? as i32;
                // Skip DOS-only (2) names; prefer Win32 (1) / Win32+DOS (3) over POSIX (0).
                let rank = match ns {
                    2 => -1,
                    0 => 0,
                    _ => 1,
                };
                if rank > best_ns {
                    let n = *c.get(0x40)? as usize;
                    let raw = c.get(0x42..0x42 + n * 2)?;
                    let u: Vec<u16> = raw.as_chunks::<2>().0.iter().map(|p| u16::from_le_bytes(*p)).collect();
                    rec.name = Some(String::from_utf16_lossy(&u));
                    rec.parent = Some(u64_at(c, 0)? & 0x0000_FFFF_FFFF_FFFF);
                    best_ns = rank;
                }
            }
            ATTR_DATA if name_len == 0 => {
                if nonres {
                    let start_vcn = u64_at(attr, 16)?;
                    if start_vcn == 0 {
                        let compressed = u16_at(attr, 12)? & 1 != 0 && attr.len() >= 0x48;
                        rec.alloc = Some(if compressed { u64_at(attr, 0x40)? } else { u64_at(attr, 0x28)? });
                        rec.size = Some(u64_at(attr, 0x30)?);
                    }
                    if want_runs {
                        let mo = u16_at(attr, 0x20)? as usize;
                        rec.runs.extend(parse_runs(attr.get(mo..)?));
                    }
                } else {
                    let cl = u32_at(attr, 16)? as u64;
                    rec.size = Some(cl);
                    rec.alloc = Some(cl);
                }
            }
            _ => {}
        }
        off += len;
    }
    Some(rec)
}

/// Volume geometry from the NTFS boot sector.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Boot {
    pub bytes_per_cluster: u64,
    pub mft_lcn: u64,
    pub record_size: usize,
}

pub fn parse_boot(b: &[u8]) -> Option<Boot> {
    if b.len() < 0x48 || b.get(3..11)? != b"NTFS    " {
        return None;
    }
    let bps = u16_at(b, 0x0B)? as u64;
    let spc = *b.get(0x0D)? as u64;
    if bps == 0 || spc == 0 {
        return None;
    }
    let bpc = bps * spc;
    let c = b[0x40] as i8;
    let record_size = if c > 0 { c as u64 * bpc } else { 1u64 << (-(c as i32)) } as usize;
    if record_size < SECTOR || !record_size.is_multiple_of(SECTOR) || record_size > 64 * 1024 {
        return None;
    }
    Some(Boot { bytes_per_cluster: bpc, mft_lcn: u64_at(b, 0x30)?, record_size })
}

/// Build the arena tree from parsed records (index = record number). `volume_root` names node 0.
/// Metadata files (records below 24) are skipped, and so are orphans whose parent chain is broken.
pub fn build_tree(records: Vec<Option<Record>>, volume_root: &str) -> Tree {
    let mut recs = records;
    // Merge extension records into their base record.
    let exts: Vec<(usize, Record)> = recs
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.as_ref().filter(|r| r.in_use && r.base != 0).map(|r| (i, r.clone())))
        .collect();
    for (i, e) in exts {
        recs[i] = None;
        if let Some(Some(b)) = recs.get_mut(e.base as usize) {
            b.size = b.size.or(e.size);
            b.alloc = b.alloc.or(e.alloc);
            b.name = b.name.take().or(e.name);
            b.parent = b.parent.or(e.parent);
            b.modified = b.modified.or(e.modified);
            b.attrs = b.attrs.or(e.attrs);
        }
    }
    let mut kids: HashMap<u64, Vec<u64>> = HashMap::new();
    for (i, r) in recs.iter().enumerate() {
        let i = i as u64;
        let Some(r) = r else { continue };
        if !r.in_use || i == ROOT_RECORD || i < FIRST_USER_RECORD {
            continue;
        }
        if let (Some(p), Some(_)) = (r.parent, &r.name) {
            if p != i {
                kids.entry(p).or_default().push(i);
            }
        }
    }
    let mut tree = Tree::default();
    let root_rec = recs.get(ROOT_RECORD as usize).and_then(|r| r.as_ref());
    tree.nodes.push(Node {
        name: volume_root.to_string(),
        parent: NONE,
        children: vec![],
        size: 0,
        alloc: 0,
        files: 0,
        dirs: 0,
        modified: root_rec.and_then(|r| r.modified).unwrap_or(0),
        attrs: root_rec.and_then(|r| r.attrs).unwrap_or(0),
        is_dir: true,
        is_link: false,
        scanning: false,
    });
    let mut visited = vec![false; recs.len()];
    let mut stack: Vec<(u64, NodeId)> = vec![(ROOT_RECORD, 0)];
    while let Some((rn, nid)) = stack.pop() {
        let Some(list) = kids.get(&rn) else { continue };
        for &c in list {
            let Some(Some(r)) = recs.get(c as usize) else { continue };
            if std::mem::replace(&mut visited[c as usize], true) {
                continue; // hard link or cycle: keep the first placement only
            }
            let attrs = r.attrs.unwrap_or(0);
            let is_link = attrs & REPARSE != 0 && r.is_dir;
            let id = tree.nodes.len() as NodeId;
            let n = Node {
                name: r.name.clone().unwrap_or_default(),
                parent: nid,
                children: vec![],
                size: if r.is_dir { 0 } else { r.size.unwrap_or(0) },
                alloc: if r.is_dir { 0 } else { r.alloc.unwrap_or(0) },
                files: 0,
                dirs: 0,
                modified: r.modified.unwrap_or(0),
                attrs,
                is_dir: r.is_dir,
                is_link,
                scanning: false,
            };
            tree.nodes.push(n);
            tree.nodes[nid as usize].children.push(id);
            if r.is_dir && !is_link {
                stack.push((c, id));
            }
        }
    }
    // Aggregate bottom-up: parents always have a smaller index than their children.
    for i in (1..tree.nodes.len()).rev() {
        let (p, size, alloc, files, dirs, is_dir) = {
            let n = &tree.nodes[i];
            (n.parent as usize, n.size, n.alloc, n.files, n.dirs, n.is_dir)
        };
        let pn = &mut tree.nodes[p];
        pn.size += size;
        pn.alloc += alloc;
        if is_dir {
            pn.files += files;
            pn.dirs += dirs + 1;
        } else {
            pn.files += 1;
        }
    }
    tree
}

/// Is the current process elevated (Windows token elevation)? Always false elsewhere.
pub fn is_elevated() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        // SAFETY: standard token query; all out pointers reference valid locals and the handle is closed.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut e = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut ret = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut e as *mut _ as *mut _,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret,
            );
            CloseHandle(token);
            ok != 0 && e.TokenIsElevated != 0
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Drive letter of a volume root such as `C:\` or `c:`; `None` for any other path.
pub fn volume_letter(root: &Path) -> Option<char> {
    let s = root.to_string_lossy();
    let b = s.as_bytes();
    let ok = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && s[2..].chars().all(|c| c == '\\' || c == '/');
    ok.then(|| (b[0] as char).to_ascii_uppercase())
}

/// Why the fast path cannot be used (`Err`) or the scan result (`Ok`).
/// Callers fall back to the walker on `Err` and show the message.
pub fn try_fast_scan(root: &Path, progress: &Progress, cancel: &AtomicBool, excludes: &[PathBuf]) -> Result<ScanResult, String> {
    if !cfg!(windows) {
        return Err("Fast NTFS scan is only available on Windows; using the regular scan".into());
    }
    let Some(letter) = volume_letter(root) else {
        return Err("Fast NTFS scan needs a whole drive (for example C:\\); using the regular scan".into());
    };
    if !is_elevated() {
        return Err("Fast NTFS scan needs administrator rights; using the regular scan".into());
    }
    #[cfg(windows)]
    {
        scan_volume(letter, root, progress, cancel, excludes).map_err(|e| format!("Fast NTFS scan failed ({e}); using the regular scan"))
    }
    #[cfg(not(windows))]
    {
        let _ = (letter, progress, cancel, excludes);
        unreachable!()
    }
}

#[cfg(windows)]
fn scan_volume(letter: char, root: &Path, progress: &Progress, cancel: &AtomicBool, excludes: &[PathBuf]) -> Result<ScanResult, String> {
    use std::io::{Read, Seek, SeekFrom};
    let start = std::time::Instant::now();
    let mut vol = std::fs::File::open(format!("\\\\.\\{letter}:")).map_err(|e| e.to_string())?;
    let mut sector0 = vec![0u8; SECTOR];
    vol.read_exact(&mut sector0).map_err(|e| e.to_string())?;
    let boot = parse_boot(&sector0).ok_or("not an NTFS volume")?;
    let rs = boot.record_size;
    // Record 0 describes the MFT itself.
    let mut buf = vec![0u8; rs.max(SECTOR)];
    vol.seek(SeekFrom::Start(boot.mft_lcn * boot.bytes_per_cluster)).map_err(|e| e.to_string())?;
    vol.read_exact(&mut buf[..rs]).map_err(|e| e.to_string())?;
    let mft = parse_record(&mut buf[..rs], rs, true).ok_or("cannot parse $MFT record")?;
    let total_records = (mft.size.ok_or("$MFT has no data size")? as usize) / rs;
    if mft.runs.is_empty() {
        return Err("$MFT has no data runs".into());
    }
    let mut records: Vec<Option<Record>> = Vec::with_capacity(total_records);
    let chunk: usize = 4 << 20; // multiple of every legal record size
    let mut chunk_buf = vec![0u8; chunk];
    'outer: for run in &mft.runs {
        let bytes = run.len * boot.bytes_per_cluster;
        let Some(lcn) = run.lcn else {
            records.resize((records.len() + (bytes as usize) / rs).min(total_records), None);
            continue;
        };
        let mut done = 0u64;
        while done < bytes {
            if cancel.load(Ordering::Relaxed) || records.len() >= total_records {
                break 'outer;
            }
            let n = ((bytes - done) as usize).min(chunk);
            let pos = lcn * boot.bytes_per_cluster + done;
            vol.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
            vol.read_exact(&mut chunk_buf[..n]).map_err(|e| e.to_string())?;
            for rec in chunk_buf[..n].chunks_exact_mut(rs) {
                if records.len() >= total_records {
                    break;
                }
                let r = parse_record(rec, rs, false);
                if let Some(r) = &r {
                    if r.in_use && r.base == 0 {
                        if r.is_dir {
                            progress.dirs.fetch_add(1, Ordering::Relaxed);
                        } else {
                            progress.files.fetch_add(1, Ordering::Relaxed);
                            progress.bytes.fetch_add(r.size.unwrap_or(0), Ordering::Relaxed);
                        }
                    }
                }
                records.push(r);
            }
            done += n as u64;
        }
    }
    let cancelled = cancel.load(Ordering::Relaxed);
    let mut tree = build_tree(records, &root.to_string_lossy());
    for ex in excludes {
        if let Ok(rel) = ex.strip_prefix(root) {
            let mut cur = Some(Tree::ROOT);
            for comp in rel.components() {
                cur = cur.and_then(|c| tree.find_child(c, &comp.as_os_str().to_string_lossy()));
            }
            if let Some(id) = cur {
                tree.remove_subtree(id);
            }
        }
    }
    let errors: Vec<ScanError> = Vec::new();
    Ok(ScanResult { root: root.to_path_buf(), tree, errors, cancelled, elapsed: start.elapsed() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const RS: usize = 1024;

    fn attr_resident(ty: u32, content: &[u8]) -> Vec<u8> {
        let len = (24 + content.len()).div_ceil(8) * 8;
        let mut a = vec![0u8; len];
        a[0..4].copy_from_slice(&ty.to_le_bytes());
        a[4..8].copy_from_slice(&(len as u32).to_le_bytes());
        a[16..20].copy_from_slice(&(content.len() as u32).to_le_bytes());
        a[20..22].copy_from_slice(&24u16.to_le_bytes());
        a[24..24 + content.len()].copy_from_slice(content);
        a
    }

    fn attr_data_nonres(alloc: u64, size: u64, runs: &[u8]) -> Vec<u8> {
        let len = (0x48 + runs.len()).div_ceil(8) * 8;
        let mut a = vec![0u8; len];
        a[0..4].copy_from_slice(&ATTR_DATA.to_le_bytes());
        a[4..8].copy_from_slice(&(len as u32).to_le_bytes());
        a[8] = 1;
        a[0x20..0x22].copy_from_slice(&0x40u16.to_le_bytes());
        a[0x28..0x30].copy_from_slice(&alloc.to_le_bytes());
        a[0x30..0x38].copy_from_slice(&size.to_le_bytes());
        a[0x40..0x40 + runs.len()].copy_from_slice(runs);
        a
    }

    fn std_info(unix: i64, attrs: u32) -> Vec<u8> {
        let mut c = vec![0u8; 72];
        let ft = (unix as u64 + 11_644_473_600) * 10_000_000;
        c[8..16].copy_from_slice(&ft.to_le_bytes());
        c[32..36].copy_from_slice(&attrs.to_le_bytes());
        attr_resident(ATTR_STD_INFO, &c)
    }

    fn file_name(parent: u64, name: &str, ns: u8) -> Vec<u8> {
        let u: Vec<u16> = name.encode_utf16().collect();
        let mut c = vec![0u8; 0x42 + u.len() * 2];
        c[0..8].copy_from_slice(&(parent | (1 << 48)).to_le_bytes()); // sequence number in high bits
        c[0x40] = u.len() as u8;
        c[0x41] = ns;
        for (i, w) in u.iter().enumerate() {
            c[0x42 + 2 * i..0x44 + 2 * i].copy_from_slice(&w.to_le_bytes());
        }
        attr_resident(ATTR_FILE_NAME, &c)
    }

    /// Build a record with a valid update sequence array (fixups applied "on disk").
    fn record(flags: u16, base: u64, attrs: Vec<Vec<u8>>) -> Vec<u8> {
        let mut r = vec![0u8; RS];
        r[0..4].copy_from_slice(b"FILE");
        r[4..6].copy_from_slice(&0x30u16.to_le_bytes());
        r[6..8].copy_from_slice(&3u16.to_le_bytes());
        r[0x14..0x16].copy_from_slice(&0x38u16.to_le_bytes());
        r[0x16..0x18].copy_from_slice(&flags.to_le_bytes());
        r[0x20..0x28].copy_from_slice(&base.to_le_bytes());
        let mut off = 0x38;
        for a in attrs {
            r[off..off + a.len()].copy_from_slice(&a);
            off += a.len();
        }
        r[off..off + 4].copy_from_slice(&ATTR_END.to_le_bytes());
        r[0x18..0x1C].copy_from_slice(&((off + 8) as u32).to_le_bytes());
        // fixups: stash the real last two bytes of each sector in the USA, put the check value on disk
        let check = [0x34u8, 0x12];
        r[0x30..0x32].copy_from_slice(&check);
        for i in 1..3 {
            let end = i * SECTOR;
            let (a, b) = (r[end - 2], r[end - 1]);
            r[0x30 + 2 * i] = a;
            r[0x30 + 2 * i + 1] = b;
            r[end - 2..end].copy_from_slice(&check);
        }
        r
    }

    fn file_rec(parent: u64, name: &str, size: u64, mtime: i64) -> Vec<u8> {
        record(1, 0, vec![std_info(mtime, 0x20), file_name(parent, name, 1), attr_data_nonres(size.div_ceil(4096) * 4096, size, &[0x11, 0x01, 0x10, 0])])
    }

    fn dir_rec(parent: u64, name: &str) -> Vec<u8> {
        record(3, 0, vec![std_info(1_000, 0x10), file_name(parent, name, 1)])
    }

    #[test]
    fn runlist_decoding() {
        // 0x21: len 1 byte, offset 2 bytes; then a negative relative offset; then a sparse run.
        let r = parse_runs(&[0x21, 0x18, 0x34, 0x12, 0x11, 0x08, 0xF0, 0x01, 0x05, 0x00]);
        assert_eq!(r[0], Run { lcn: Some(0x1234), len: 0x18 });
        assert_eq!(r[1], Run { lcn: Some(0x1234 - 16), len: 8 });
        assert_eq!(r[2], Run { lcn: None, len: 5 });
        assert_eq!(r.len(), 3);
        assert!(parse_runs(&[]).is_empty());
        assert!(parse_runs(&[0x41, 1, 2]).len() <= 1); // truncated: no panic
    }

    #[test]
    fn filetime_conversion() {
        assert_eq!(filetime_to_unix(0), 0);
        assert_eq!(filetime_to_unix(116_444_736_000_000_000), 0);
        assert_eq!(filetime_to_unix((1_700_000_000u64 + 11_644_473_600) * 10_000_000), 1_700_000_000);
    }

    #[test]
    fn parses_file_record_with_fixups() {
        let mut r = file_rec(5, "report.pdf", 5000, 1_700_000_000);
        let rec = parse_record(&mut r, RS, true).unwrap();
        assert!(rec.in_use && !rec.is_dir);
        assert_eq!(rec.name.as_deref(), Some("report.pdf"));
        assert_eq!(rec.parent, Some(5));
        assert_eq!((rec.size, rec.alloc), (Some(5000), Some(8192)));
        assert_eq!(rec.modified, Some(1_700_000_000));
        assert_eq!(rec.attrs, Some(0x20));
        assert_eq!(rec.runs, vec![Run { lcn: Some(16), len: 1 }]);
    }

    #[test]
    fn corrupt_and_free_records() {
        let mut r = file_rec(5, "a", 1, 0);
        r[510] ^= 0xFF; // torn write: check value no longer matches
        assert!(parse_record(&mut r, RS, false).is_none());
        let mut junk = vec![0u8; RS];
        assert!(parse_record(&mut junk, RS, false).is_none());
        let mut free = record(0, 0, vec![]);
        let rec = parse_record(&mut free, RS, false).unwrap();
        assert!(!rec.in_use);
    }

    #[test]
    fn prefers_win32_name_over_dos_name() {
        let mut r = record(1, 0, vec![file_name(5, "LONGFI~1.TXT", 2), file_name(5, "long file name.txt", 1)]);
        let rec = parse_record(&mut r, RS, false).unwrap();
        assert_eq!(rec.name.as_deref(), Some("long file name.txt"));
    }

    #[test]
    fn boot_sector() {
        let mut b = vec![0u8; 512];
        b[3..11].copy_from_slice(b"NTFS    ");
        b[0x0B..0x0D].copy_from_slice(&512u16.to_le_bytes());
        b[0x0D] = 8;
        b[0x30..0x38].copy_from_slice(&786_432u64.to_le_bytes());
        b[0x40] = 0xF6; // -10 => 1024-byte records
        let boot = parse_boot(&b).unwrap();
        assert_eq!(boot, Boot { bytes_per_cluster: 4096, mft_lcn: 786_432, record_size: 1024 });
        b[0x40] = 1; // 1 cluster per record => 4096
        assert_eq!(parse_boot(&b).unwrap().record_size, 4096);
        b[3] = b'X';
        assert!(parse_boot(&b).is_none());
    }

    fn parsed(mut raw: Vec<u8>) -> Option<Record> {
        parse_record(&mut raw, RS, false)
    }

    #[test]
    fn builds_tree_with_aggregation() {
        // 5 root, 24 docs (dir in root), 25 a.txt in docs, 26 b.bin in root, 27 sub in docs, 28 c in sub, 29 orphan
        let mut recs: Vec<Option<Record>> = vec![None; 40];
        recs[5] = parsed(dir_rec(5, "."));
        recs[24] = parsed(dir_rec(5, "docs"));
        recs[25] = parsed(file_rec(24, "a.txt", 100, 10));
        recs[26] = parsed(file_rec(5, "b.bin", 4000, 20));
        recs[27] = parsed(dir_rec(24, "sub"));
        recs[28] = parsed(file_rec(27, "c", 7, 30));
        recs[29] = parsed(file_rec(999, "orphan", 55, 0));
        recs[3] = parsed(file_rec(5, "$Volume", 77, 0)); // metadata: skipped
        let t = build_tree(recs, "C:\\");
        let root = t.root().unwrap();
        assert_eq!(root.name, "C:\\");
        assert_eq!((root.size, root.files, root.dirs), (4107, 3, 2));
        let docs = t.find_child(0, "docs").unwrap();
        assert_eq!((t.get(docs).size, t.get(docs).files, t.get(docs).dirs), (107, 2, 1));
        let sub = t.find_child(docs, "sub").unwrap();
        let c = t.find_child(sub, "c").unwrap();
        assert_eq!(t.path_of(c), PathBuf::from("C:\\").join("docs").join("sub").join("c"));
        assert_eq!(t.get(c).alloc, 4096);
        assert!(t.find_child(0, "orphan").is_none());
        assert!(t.find_child(0, "$Volume").is_none());
        assert_eq!(t.get(docs).modified, 1_000);
    }

    #[test]
    fn extension_record_data_is_merged() {
        let mut recs: Vec<Option<Record>> = vec![None; 40];
        recs[5] = parsed(dir_rec(5, "."));
        // base record without $DATA, extension record (base=30) carries it
        recs[30] = parsed(record(1, 0, vec![std_info(1, 0x20), file_name(5, "big.iso", 1)]));
        recs[31] = parsed(record(1, 30, vec![attr_data_nonres(8192, 8000, &[0x11, 0x02, 0x10, 0])]));
        let t = build_tree(recs, "D:\\");
        let f = t.find_child(0, "big.iso").unwrap();
        assert_eq!((t.get(f).size, t.get(f).alloc), (8000, 8192));
        assert_eq!(t.root().unwrap().files, 1);
    }

    #[test]
    fn cycles_do_not_hang() {
        let mut recs: Vec<Option<Record>> = vec![None; 40];
        recs[5] = parsed(dir_rec(5, "."));
        recs[24] = parsed(dir_rec(25, "a"));
        recs[25] = parsed(dir_rec(24, "b"));
        let t = build_tree(recs, "E:\\");
        assert_eq!(t.nodes.len(), 1); // detached cycle is not reachable from the root
    }

    #[test]
    fn volume_letter_detection() {
        assert_eq!(volume_letter(Path::new("c:\\")), Some('C'));
        assert_eq!(volume_letter(Path::new("D:")), Some('D'));
        assert_eq!(volume_letter(Path::new("C:\\Users")), None);
        assert_eq!(volume_letter(Path::new("/tmp")), None);
    }

    #[test]
    fn fallback_when_not_usable() {
        let p = Progress::default();
        let c = AtomicBool::new(false);
        let err = try_fast_scan(Path::new("C:\\Users"), &p, &c, &[]).err().unwrap();
        assert!(err.contains("whole drive") || err.contains("only available"));
        if !is_elevated() {
            let err = try_fast_scan(Path::new("C:\\"), &p, &c, &[]).err().unwrap();
            assert!(err.contains("administrator") || err.contains("only available"));
        }
    }
}

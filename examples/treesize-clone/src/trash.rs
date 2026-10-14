//! Move a file or folder to the Recycle Bin (Windows); other platforms report "unsupported".

#[cfg(windows)]
pub fn recycle(path: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE, SHFILEOPSTRUCTW};
    // The source list is double-NUL terminated.
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.extend([0, 0]);
    // SAFETY: SHFILEOPSTRUCTW is plain data (zero is a valid empty value); `from` outlives the call.
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16;
    // SAFETY: `op` is fully initialised and `pFrom` points to a valid double-NUL terminated list.
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 {
        return Err(format!("code 0x{rc:X}"));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("aborted".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn recycle(_path: &std::path::Path) -> Result<(), String> {
    Err("Recycle Bin is only supported on Windows".into())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn recycles_a_folder() {
        let d = tempfile::tempdir().unwrap();
        let victim = d.path().join("victim");
        std::fs::create_dir_all(victim.join("sub")).unwrap();
        std::fs::write(victim.join("sub").join("a.txt"), b"x").unwrap();
        super::recycle(&victim).unwrap();
        assert!(!victim.exists());
    }
}

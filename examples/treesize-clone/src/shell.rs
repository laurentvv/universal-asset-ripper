//! Windows shell helpers behind the context menu: open, terminal, native Properties dialog.

use std::path::Path;

/// Open a file or folder with its default handler.
pub fn open(path: &Path) {
    #[cfg(windows)]
    shell_execute("open", path.as_os_str(), None, None);
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}

/// Open a terminal in `dir` (Windows Terminal when installed, else a console window).
pub fn open_terminal(dir: &Path) {
    #[cfg(windows)]
    {
        if std::process::Command::new("wt").arg("-d").arg(dir).spawn().is_err() {
            let _ = std::process::Command::new("cmd").args(["/c", "start", "cmd", "/k"]).current_dir(dir).spawn();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("x-terminal-emulator").current_dir(dir).spawn();
    }
}

/// The Windows Properties dialog of the shell (security, versions, ...).
pub fn properties(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW};
        let wide = |s: &std::ffi::OsStr| -> Vec<u16> { s.encode_wide().chain(std::iter::once(0)).collect() };
        let verb = wide(std::ffi::OsStr::new("properties"));
        let file = wide(path.as_os_str());
        // SAFETY: zeroed SHELLEXECUTEINFOW is a valid empty value; strings outlive the call.
        let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_INVOKEIDLIST;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.nShow = 1;
        // SAFETY: `info` is fully initialised.
        unsafe { ShellExecuteExW(&mut info) };
    }
    #[cfg(not(windows))]
    let _ = path;
}

#[cfg(windows)]
fn shell_execute(verb: &str, file: &std::ffi::OsStr, params: Option<&str>, dir: Option<&Path>) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let wide = |s: &std::ffi::OsStr| -> Vec<u16> { s.encode_wide().chain(std::iter::once(0)).collect() };
    let v = wide(std::ffi::OsStr::new(verb));
    let f = wide(file);
    let p = params.map(|p| wide(std::ffi::OsStr::new(p)));
    let d = dir.map(|d| wide(d.as_os_str()));
    // SAFETY: all strings are NUL-terminated and outlive the call; null pointers are allowed.
    let rc = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            v.as_ptr(),
            f.as_ptr(),
            p.as_ref().map_or(std::ptr::null(), |p| p.as_ptr()),
            d.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            1,
        )
    } as usize;
    rc > 32
}

#[cfg(windows)]
fn main() {
    let mut res = winres::WindowsResource::new();
    res.set_icon("assets/icons/icon_MAINICON.ico");
    // Ignore compile error if rc.exe is not in PATH
    let _ = res.compile();
}

#[cfg(not(windows))]
fn main() {}

// Release builds on Windows are GUI-subsystem programs (no console window); `--cli` and `--help`
// re-attach to the parent console at start-up.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod analysis;
mod cli;
mod dfm;
mod export;
mod i18n;
mod scan;
mod settings;
mod ui;

/// Re-attach stdout/stderr to the console of the parent process (needed with the GUI subsystem).
#[cfg(windows)]
fn attach_parent_console() {
    use std::os::windows::io::IntoRawHandle;
    use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, SetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
    // SAFETY: plain Win32 calls; the handles passed to SetStdHandle stay open for the process lifetime.
    unsafe {
        if AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
            return;
        }
        for (std_handle, name) in [(STD_OUTPUT_HANDLE, "CONOUT$"), (STD_ERROR_HANDLE, "CONOUT$")] {
            let cur = GetStdHandle(std_handle);
            // Keep redirected handles (pipes, files); only fix missing ones.
            if cur.is_null() || cur as isize == -1 {
                if let Ok(f) = std::fs::OpenOptions::new().write(true).open(name) {
                    SetStdHandle(std_handle, f.into_raw_handle() as _);
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}

const USAGE: &str = "TreeSize Clone in Rust (egui)

Usage: treesize-clone [PATH]                launch the GUI (PATH is scanned at startup)
       treesize-clone --cli [PATH] [-d N]   headless scan, print the tree
       treesize-clone --screenshot FILE.png [--view tree|treemap|chart|types|largest|oldest|duplicates]
                      [--lang CODE] [PATH]  developer flag: scan PATH, render one frame, save a PNG, exit";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let help = args.iter().any(|a| a == "-h" || a == "--help");
    let cli_mode = args.iter().any(|a| a == "--cli");
    if help || cli_mode {
        attach_parent_console();
    }
    if help {
        println!("{USAGE}");
        return;
    }
    if let Some(pos) = args.iter().position(|a| a == "--cli") {
        cli::run(&args[pos + 1..]);
        return;
    }
    let opts = match ui::parse_args(&args) {
        Ok(o) => o,
        Err(e) => {
            attach_parent_console();
            eprintln!("{e}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    if let Err(e) = ui::run(opts) {
        attach_parent_console();
        eprintln!("GUI error: {e}");
        std::process::exit(1);
    }
}

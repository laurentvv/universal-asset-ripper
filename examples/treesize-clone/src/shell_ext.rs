//! "Analyze with TreeSize" entry in the Explorer context menu of folders, folder backgrounds and
//! drives. Written under `HKCU\Software\Classes` only (no admin rights, removed by `uninstall`).

use std::path::Path;

/// Default registry key name of the entry.
pub const KEY_NAME: &str = "TreeSizeRustClone";

/// (registry class, argument placeholder) pairs: folders and drives get `%1`, the background of an
/// open folder gets `%V`.
const TARGETS: [(&str, &str); 3] = [("Directory", "%1"), ("Directory\\Background", "%V"), ("Drive", "%1")];

fn root_key(class: &str, key: &str) -> String {
    format!("HKCU\\Software\\Classes\\{class}\\shell\\{key}")
}

/// The command line stored for `exe`: `"C:\path\treesize-clone.exe" "%1"`.
pub fn command_line(exe: &Path, placeholder: &str) -> String {
    format!("\"{}\" \"{placeholder}\"", exe.display())
}

#[cfg(windows)]
fn reg(args: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg").args(args).creation_flags(CREATE_NO_WINDOW).output().is_ok_and(|o| o.status.success())
}

#[cfg(windows)]
pub fn install(exe: &Path, key: &str, label: &str) -> bool {
    TARGETS.iter().all(|(class, ph)| {
        let root = root_key(class, key);
        reg(&["add", &root, "/ve", "/d", label, "/f"])
            && reg(&["add", &root, "/v", "Icon", "/d", &exe.display().to_string(), "/f"])
            && reg(&["add", &format!("{root}\\command"), "/ve", "/d", &command_line(exe, ph), "/f"])
    })
}

#[cfg(windows)]
pub fn uninstall(key: &str) -> bool {
    // `reg delete` fails for a missing key, which already is the state we want.
    TARGETS.iter().fold(true, |ok, (class, _)| {
        let root = root_key(class, key);
        let existed = reg(&["query", &root]);
        (!existed || reg(&["delete", &root, "/f"])) && ok
    })
}

#[cfg(windows)]
pub fn is_installed(key: &str) -> bool {
    reg(&["query", &root_key("Directory", key)])
}

#[cfg(not(windows))]
pub fn install(_exe: &Path, _key: &str, _label: &str) -> bool {
    false
}

#[cfg(not(windows))]
pub fn uninstall(_key: &str) -> bool {
    true
}

#[cfg(not(windows))]
pub fn is_installed(_key: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_lines_quote_the_exe_and_the_argument() {
        let c = command_line(Path::new(r"C:\Program Files\TS\treesize-clone.exe"), "%1");
        assert_eq!(c, r#""C:\Program Files\TS\treesize-clone.exe" "%1""#);
        assert_eq!(root_key("Directory\\Background", "K"), r"HKCU\Software\Classes\Directory\Background\shell\K");
    }

    /// Real registry round trip under a throw-away key (HKCU only; removed at the end).
    #[cfg(windows)]
    #[test]
    fn install_and_uninstall_round_trip() {
        let key = format!("TreeSizeRustCloneTest{}", std::process::id());
        let exe = std::env::current_exe().unwrap();
        assert!(!is_installed(&key));
        assert!(install(&exe, &key, "Test entry"), "install writes the keys");
        assert!(is_installed(&key));
        assert!(uninstall(&key));
        assert!(!is_installed(&key), "uninstall removes everything");
        assert!(uninstall(&key), "uninstalling twice is fine");
    }
}

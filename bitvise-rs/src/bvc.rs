//! Bitvise command-line compatibility layer.
//!
//! `sftpc`, `stermc` and `sexec` use single-dash `-option=value` arguments.
//! This module pre-scans the process arguments, extracts the Bitvise-style
//! options we support, rejects the ones we do not (with a clear message
//! instead of silent misparsing), and leaves the rest to the native CLI.
//!
//! Source of truth for the option surface: the usage text of Bitvise SSH
//! Client 9.66's `sftpc`/`stermc`/`sexec` (their built-in `-help` output).

use std::collections::BTreeMap;

use anyhow::{Result, anyhow, bail};

/// Bitvise-style options extracted from the command line.
#[derive(Debug, Default)]
pub struct BvcOpts {
    raw: BTreeMap<String, String>,
    /// Synthetic `[user@]host[:port]` from `-host=`/`-user=`/`-port=`.
    pub dest_override: Option<String>,
}

/// Options that carry secrets: never echoed back in error messages.
const SECRET_OPTS: [&str; 4] = ["pw", "pwKbdi", "keypairPass", "proxyPass"];

/// Bitvise options bvrs understands and maps onto native behavior.
const SUPPORTED: &[&str] = &[
    "user",
    "host",
    "port",
    "pw",
    "keypairFile",
    "keypairPass",
    "hostKeyFp",
    "hostKeyFile",
    "noRegistry",
    "progress",
    "cmd",
    "cmdFile",
    "ce",
];

/// Remove Bitvise-style `-option=value` tokens from `args` and parse them.
///
/// Returns the remaining arguments (for the native CLI) plus the parsed
/// options. Unknown Bitvise-style options are a hard error naming the option
/// (value redacted for secret-looking options).
pub fn extract(args: &[String]) -> Result<(Vec<String>, BvcOpts)> {
    let mut rest = Vec::new();
    let mut opts = BvcOpts::default();

    for arg in args {
        if arg == "-ce" {
            // Bare flag in sftpc usage: `[[-ce] commands OR -cmd=...]`.
            opts.raw.insert("ce".to_owned(), "y".to_owned());
        } else if let Some((name, value)) = bitvise_option(arg) {
            if !SUPPORTED.contains(&name.as_str()) {
                if SECRET_OPTS.contains(&name.as_str()) {
                    bail!("Bitvise option -{name}= is not supported by bvrs");
                }
                bail!(
                    "Bitvise option -{name}={value} is not supported by bvrs \
                     (supported: {})",
                    SUPPORTED.join(", ")
                );
            }
            opts.raw.insert(name, value);
        } else {
            rest.push(arg.clone());
        }
    }

    // Synthesize a destination from -host=/-user=/-port= when provided.
    if let Some(host) = opts.raw.get("host").cloned() {
        let user = opts.raw.get("user").cloned();
        let port = opts.raw.get("port").cloned();
        let mut dest = String::new();
        if let Some(u) = user {
            dest.push_str(&u);
            dest.push('@');
        }
        dest.push_str(&host);
        if let Some(p) = port {
            dest.push(':');
            dest.push_str(&p);
        }
        opts.dest_override = Some(dest);
    }

    Ok((rest, opts))
}

/// Recognize `-option=value` (single dash, `=`, no leading digit).
fn bitvise_option(arg: &str) -> Option<(String, String)> {
    let body = arg.strip_prefix('-')?;
    if body.starts_with('-') || body.starts_with('=') {
        return None; // our `--long` flags and bare dashes
    }
    let (name, value) = body.split_once('=')?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some((name.to_owned(), value.to_owned()))
}

impl BvcOpts {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.raw.get(name).map(String::as_str)
    }

    pub fn flag(&self, name: &str) -> bool {
        self.get(name)
            .is_some_and(|v| v != "n" && v != "no" && v != "0")
    }

    /// Password from `-pw=` (plaintext; parity with sftpc, prefer
    /// `--password-env` in scripts).
    pub fn password(&self) -> Option<String> {
        self.get("pw").map(str::to_owned)
    }

    /// Identity file from `-keypairFile=`.
    pub fn keypair_file(&self) -> Option<String> {
        self.get("keypairFile").map(str::to_owned)
    }

    /// Passphrase for the identity, from `-keypairPass=`.
    pub fn keypair_pass(&self) -> Option<String> {
        self.get("keypairPass").map(str::to_owned)
    }

    /// Host key pin fingerprints, from `-hostKeyFp=` (comma-separated)
    /// and/or `-hostKeyFile=` (one fingerprint per line, `#` comments).
    pub fn pinned_fingerprints(&self) -> Result<Vec<String>> {
        let mut list: Vec<String> = self
            .get("hostKeyFp")
            .map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()))
            .map(|parts| parts.map(str::to_owned).collect())
            .unwrap_or_default();

        if let Some(path) = self.get("hostKeyFile") {
            let content = std::fs::read_to_string(path)
                .map_err(|e| anyhow!("reading -hostKeyFile={path}: {e}"))?;
            for line in content.lines() {
                let line = line.split('#').next().unwrap_or_default().trim();
                if !line.is_empty() {
                    list.push(line.to_owned());
                }
            }
        }

        for fp in &list {
            if !fp.starts_with("SHA256:") {
                bail!("-hostKeyFp expects SHA256:... fingerprints, got {fp:?}");
            }
        }
        list.dedup();
        Ok(list)
    }

    /// SFTP commands from `-cmd=` (`;`-separated), `-cmdFile=` (one per line),
    /// plus the bare `-ce` continue-on-error marker.
    pub fn batch_commands(&self) -> Result<(Vec<String>, bool)> {
        let mut commands = Vec::new();
        if let Some(cmd) = self.get("cmd") {
            commands.extend(
                cmd.split(';')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        }
        if let Some(path) = self.get("cmdFile") {
            let content = std::fs::read_to_string(path)
                .map_err(|e| anyhow!("reading -cmdFile={path}: {e}"))?;
            for line in content.lines() {
                let line = line.split('#').next().unwrap_or_default().trim();
                if !line.is_empty() {
                    commands.push(line.to_owned());
                }
            }
        }
        Ok((commands, self.flag("ce")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn extracts_supported_and_passes_rest() {
        let (rest, opts) = extract(&args(&[
            "sftp",
            "-pw=secret",
            "-port=2222",
            "user@host",
            "put",
            "f.txt",
        ]))
        .unwrap();
        assert_eq!(rest, args(&["sftp", "user@host", "put", "f.txt"]));
        assert_eq!(opts.get("pw"), Some("secret"));
        assert_eq!(opts.get("port"), Some("2222"));
    }

    #[test]
    fn synthesizes_dest_from_host_user_port() {
        let (_, opts) = extract(&args(&["-user=root", "-host=example.com", "-port=2222"])).unwrap();
        assert_eq!(opts.dest_override.as_deref(), Some("root@example.com:2222"));
    }

    #[test]
    fn rejects_unsupported_without_leaking_secrets() {
        let err = extract(&args(&["-proxyServer=10.0.0.1"])).unwrap_err();
        assert!(err.to_string().contains("-proxyServer="));
        let err = extract(&args(&["-proxyPass=hunter2"])).unwrap_err();
        assert!(!err.to_string().contains("hunter2"));
    }

    #[test]
    fn native_flags_untouched() {
        let (rest, _) = extract(&args(&["--host-key", "strict", "-p", "22"])).unwrap();
        assert_eq!(rest, args(&["--host-key", "strict", "-p", "22"]));
    }

    #[test]
    fn batch_from_cmd_and_cmdfile() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("cmds.txt");
        std::fs::write(&f, "cd /tmp  # go\n\nput a.txt\n").unwrap();
        let (_, opts) = extract(&args(&["-cmd=ls; get x", "-cmdFile"])).unwrap();
        // cmdFile without =value cannot appear in this form; use the map directly
        let mut raw = opts;
        raw.raw
            .insert("cmdFile".into(), f.to_string_lossy().into_owned());
        let (cmds, _) = raw.batch_commands().unwrap();
        assert_eq!(cmds, vec!["ls", "get x", "cd /tmp", "put a.txt"]);
    }

    #[test]
    fn fingerprints_validated() {
        let (_, opts) = extract(&args(&["-hostKeyFp=SHA256:abc,SHA256:def"])).unwrap();
        assert_eq!(opts.pinned_fingerprints().unwrap().len(), 2);
        let (_, opts) = extract(&args(&["-hostKeyFp=SHA256:xyz,deadbeef"])).unwrap();
        assert!(opts.pinned_fingerprints().is_err());
    }
}

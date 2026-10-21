//! Host key verification against an OpenSSH-format `known_hosts` file.
//!
//! Only plain (non-hashed, non-wildcard) entries are matched; hashed or
//! pattern entries written by other tools are ignored for comparison but
//! never modified. New keys are recorded with trust-on-first-use under the
//! `accept-new` policy, matching OpenSSH semantics.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use russh::keys::ssh_key::PublicKey;

/// Policy applied when the server host key is not already known.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum HostKeyPolicy {
    /// Refuse unknown hosts; known-but-different keys always fail.
    Strict,
    /// Trust on first use: record new keys, fail on mismatch (default).
    AcceptNew,
    /// Accept any key (testing only; disables protection).
    AcceptAny,
}

/// Outcome of verifying a server host key.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Accept,
    AcceptAndRecord,
    Reject(String),
}

/// Verify `key` for `host:port` against `known_hosts` and decide.
pub fn verify(
    policy: HostKeyPolicy,
    known_hosts: &Path,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> Verdict {
    let expected = key_line(key);
    let hostfield = host_field(host, port);
    let entries = load_entries(known_hosts);

    for (hosts, keytype, blob) in &entries {
        if !hosts_field_matches(hosts, &hostfield, host, port) {
            continue;
        }
        if *keytype == expected.0 && *blob == expected.1 {
            return Verdict::Accept;
        }
        return Verdict::Reject(format!(
            "host key mismatch for {hostfield}: known_hosts has a different key \
             ({} {}…), server presents {} (fingerprint {}). \
             If you are sure the change is legitimate, remove the old entry from {}",
            keytype,
            &blob[..blob.len().min(16)],
            expected.0,
            fingerprint(key),
            known_hosts.display(),
        ));
    }

    match policy {
        HostKeyPolicy::Strict => Verdict::Reject(format!(
            "no known_hosts entry for {hostfield} and --host-key strict was requested"
        )),
        HostKeyPolicy::AcceptAny => Verdict::Accept,
        HostKeyPolicy::AcceptNew => Verdict::AcceptAndRecord,
    }
}

/// Append a newly trusted key to the known_hosts file.
pub fn record(known_hosts: &Path, host: &str, port: u16, key: &PublicKey) -> Result<()> {
    if let Some(parent) = known_hosts.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let (keytype, blob) = key_line(key);
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(known_hosts)
        .with_context(|| format!("opening {}", known_hosts.display()))?;
    writeln!(f, "{} {} {}", host_field(host, port), keytype, blob)
        .with_context(|| format!("writing to {}", known_hosts.display()))?;
    Ok(())
}

/// Default known_hosts path: `~/.ssh/known_hosts`.
pub fn default_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".ssh").join("known_hosts")
}

/// OpenSSH-style fingerprint `SHA256:…` of a public key.
pub fn fingerprint(key: &PublicKey) -> String {
    use russh::keys::ssh_key::HashAlg;
    key.fingerprint(HashAlg::Sha256).to_string()
}

/// `(keytype, base64 blob)` pair as used in known_hosts / authorized_keys.
fn key_line(key: &PublicKey) -> (String, String) {
    let openssh = key.to_openssh().unwrap_or_default();
    let mut fields = openssh.split_whitespace();
    let keytype = fields.next().unwrap_or_default().to_owned();
    let blob = fields.next().unwrap_or_default().to_owned();
    (keytype, blob)
}

fn host_field(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    }
}

fn hosts_field_matches(field: &str, hostfield: &str, _host: &str, _port: u16) -> bool {
    // Exact match only; hashed (|1|…) and wildcard entries are skipped.
    field.split(',').any(|h| h == hostfield)
}

type Entry = (String, String, String);

fn load_entries(path: &Path) -> Vec<Entry> {
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(parse_line)
        .filter(|(hosts, _, _)| !hosts.starts_with('|'))
        .collect()
}

fn parse_line(line: &str) -> Option<Entry> {
    let mut fields = line.split_whitespace();
    let hosts = fields.next()?.to_owned();
    let keytype = fields.next()?.to_owned();
    let blob = fields.next()?.to_owned();
    Some((hosts, keytype, blob))
}

/// Interactively or automatically confirm and record a new host key.
/// Returns `Ok(())` when the connection may proceed.
pub fn confirm_and_record(
    policy: HostKeyPolicy,
    known_hosts: &Path,
    host: &str,
    port: u16,
    key: &PublicKey,
) -> Result<()> {
    match verify(policy, known_hosts, host, port, key) {
        Verdict::Accept => Ok(()),
        Verdict::AcceptAndRecord => {
            eprintln!(
                "bvrs: warning: host key for {} is not known; recording {} ({})",
                host_field(host, port),
                fingerprint(key),
                known_hosts.display()
            );
            record(known_hosts, host, port, key)
        }
        Verdict::Reject(msg) => {
            bail!("{msg}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_key() -> PublicKey {
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .unwrap()
            .public_key()
            .clone()
    }

    #[test]
    fn tofu_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let kh = dir.path().join("known_hosts");
        let key = sample_key();

        // Unknown + strict -> reject.
        assert!(matches!(
            verify(HostKeyPolicy::Strict, &kh, "h", 22, &key),
            Verdict::Reject(_)
        ));

        // Unknown + accept-new -> record.
        assert_eq!(
            verify(HostKeyPolicy::AcceptNew, &kh, "h", 22, &key),
            Verdict::AcceptAndRecord
        );
        record(&kh, "h", 22, &key).unwrap();

        // Now known: accept, whatever the policy; and a different key fails.
        assert_eq!(
            verify(HostKeyPolicy::Strict, &kh, "h", 22, &key),
            Verdict::Accept
        );
        let other = sample_key();
        assert!(matches!(
            verify(HostKeyPolicy::AcceptNew, &kh, "h", 22, &other),
            Verdict::Reject(_)
        ));

        // Port discipline: a key recorded for port 2222 does not match port 22.
        let kh2 = dir.path().join("kh2");
        record(&kh2, "h", 2222, &key).unwrap();
        assert!(matches!(
            verify(HostKeyPolicy::Strict, &kh2, "h", 22, &key),
            Verdict::Reject(_)
        ));
        assert_eq!(
            verify(HostKeyPolicy::Strict, &kh2, "h", 2222, &key),
            Verdict::Accept
        );
    }
}

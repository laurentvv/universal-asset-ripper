//! SFTP operations (`bvrs sftp`, replaces sftpc single-shot usage).

use std::path::Path;

use anyhow::{Context, Result, bail};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::cli::SftpOp;
use crate::conn::ClientHandler;
use crate::progress::Progress;

const CHUNK: usize = 64 * 1024;

/// Open the SFTP subsystem and run one operation.
pub async fn run(handle: &mut Handle<ClientHandler>, op: &SftpOp) -> Result<()> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| anyhow::anyhow!("opening session channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| anyhow::anyhow!("requesting sftp subsystem: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow::anyhow!("starting SFTP session: {e}"))?;

    let result = dispatch(&sftp, op).await;
    let _ = sftp.close().await;
    result
}

async fn dispatch(sftp: &SftpSession, op: &SftpOp) -> Result<()> {
    match op {
        SftpOp::Ls { path } => list(sftp, path.as_deref().unwrap_or(".")).await,
        SftpOp::Pwd => {
            let cwd = sftp
                .canonicalize(".")
                .await
                .map_err(|e| anyhow::anyhow!("resolving working directory: {e}"))?;
            println!("{cwd}");
            Ok(())
        }
        SftpOp::Get { remote, local } => get(sftp, remote, local.as_deref()).await,
        SftpOp::Put { local, remote } => put(sftp, local, remote.as_deref()).await,
        SftpOp::Rm { path } => sftp
            .remove_file(path.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("removing {path}: {e}")),
        SftpOp::Mkdir { path } => sftp
            .create_dir(path.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("creating directory {path}: {e}")),
        SftpOp::Rmdir { path } => sftp
            .remove_dir(path.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("removing directory {path}: {e}")),
        SftpOp::Mv { from, to } => sftp
            .rename(from.as_str(), to.as_str())
            .await
            .map_err(|e| anyhow::anyhow!("renaming {from} to {to}: {e}")),
        SftpOp::Stat { path } => stat(sftp, path).await,
    }
}

fn mtime_secs(md: &russh_sftp::client::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn list(sftp: &SftpSession, path: &str) -> Result<()> {
    let mut entries: Vec<_> = sftp
        .read_dir(path)
        .await
        .map_err(|e| anyhow::anyhow!("reading directory {path}: {e}"))?
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let md = entry.metadata();
        let kind = if md.is_dir() { 'd' } else { '-' };
        println!(
            "{kind}{}  {:>12}  mtime={}  {}",
            md.permissions(),
            md.len(),
            mtime_secs(&md),
            entry.file_name(),
        );
    }
    Ok(())
}

async fn stat(sftp: &SftpSession, path: &str) -> Result<()> {
    let md = sftp
        .metadata(path)
        .await
        .map_err(|e| anyhow::anyhow!("stat {path}: {e}"))?;
    let kind = if md.is_dir() { "directory" } else { "file" };
    let octal = md.permissions.unwrap_or(0) & 0o7777;
    println!(
        "  kind: {kind}\n  size: {}\n  perms: {} (0o{octal:04o})\n  mtime: {}",
        md.len(),
        md.permissions(),
        mtime_secs(&md),
    );
    Ok(())
}

async fn get(sftp: &SftpSession, remote: &str, local: Option<&Path>) -> Result<()> {
    let target = local.map_or_else(
        || Path::new(remote.rsplit('/').next().unwrap_or(remote)).to_path_buf(),
        std::borrow::ToOwned::to_owned,
    );
    let md = sftp
        .metadata(remote)
        .await
        .map_err(|e| anyhow::anyhow!("stat {remote}: {e}"))?;
    let mut remote_file = sftp
        .open(remote)
        .await
        .map_err(|e| anyhow::anyhow!("opening remote {remote}: {e}"))?;
    let mut local_file = tokio::fs::File::create(&target)
        .await
        .with_context(|| format!("creating {}", target.display()))?;

    let mut progress = Progress::new(md.len());
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| anyhow::anyhow!("reading remote {remote}: {e}"))?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buf[..n])
            .await
            .with_context(|| format!("writing {}", target.display()))?;
        progress.advance(n as u64);
    }
    remote_file
        .shutdown()
        .await
        .map_err(|e| anyhow::anyhow!("closing remote {remote}: {e}"))?;
    progress.finish();
    Ok(())
}

async fn put(sftp: &SftpSession, local: &Path, remote: Option<&str>) -> Result<()> {
    let target = remote.map_or_else(
        || {
            local
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        },
        std::borrow::ToOwned::to_owned,
    );
    if target.is_empty() {
        bail!("cannot derive a remote name from {}", local.display());
    }
    let mut local_file = tokio::fs::File::open(local)
        .await
        .with_context(|| format!("opening {}", local.display()))?;
    let len = local_file
        .metadata()
        .await
        .with_context(|| format!("stat {}", local.display()))?
        .len();
    let mut remote_file = sftp
        .create(&target)
        .await
        .map_err(|e| anyhow::anyhow!("creating remote {target}: {e}"))?;

    let mut progress = Progress::new(len);
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = local_file
            .read(&mut buf)
            .await
            .with_context(|| format!("reading {}", local.display()))?;
        if n == 0 {
            break;
        }
        remote_file
            .write_all(&buf[..n])
            .await
            .map_err(|e| anyhow::anyhow!("writing remote {target}: {e}"))?;
        progress.advance(n as u64);
    }
    remote_file
        .shutdown()
        .await
        .map_err(|e| anyhow::anyhow!("closing remote {target}: {e}"))?;
    progress.finish();
    Ok(())
}

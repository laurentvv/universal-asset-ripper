//! bvrs — a Rust reimplementation of the Bitvise SSH Client command-line tools.
//!
//! `bvrs` provides the three command-line capabilities of the Bitvise SSH
//! Client suite: an interactive shell (`stermc`), one-shot command execution
//! (`sexec`), and SFTP file transfers (`sftpc`) — including a Bitvise-style
//! `-option=value` compatibility layer ([`bvc`]). The SSH protocol is
//! implemented by [russh](https://crates.io/crates/russh) with the `ring`
//! crypto backend; this crate wires it into a small, scriptable CLI.

pub mod bvc;
pub mod cli;
pub mod conn;
pub mod dest;
pub mod exec;
pub mod hostkeys;
pub mod progress;
pub mod sftp_cmd;
pub mod shell;

use anyhow::Result;

/// Entry point shared by the binary and the integration tests.
///
/// Returns the process exit code: the remote command's exit status for
/// `exec`/`shell`, `0` on success, `1` on error.
pub async fn run(cli: cli::Cli, bvc: bvc::BvcOpts) -> Result<i32> {
    let (auth, dest, command) = cli.split(&bvc)?;
    let mut handle = conn::connect(&auth, &dest).await?;
    let code: i32 = match command {
        cli::Command::Shell { .. } => shell::run(&mut handle).await? as i32,
        cli::Command::Exec { argv, .. } => exec::run(&mut handle, &argv).await? as i32,
        cli::Command::Sftp { words, .. } => sftp_cmd::run(&mut handle, words, &bvc).await,
    };
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    Ok(code as i32)
}

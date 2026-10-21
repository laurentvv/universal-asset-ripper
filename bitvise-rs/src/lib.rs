//! bvrs — a Rust reimplementation of the Bitvise SSH Client command-line tools.
//!
//! `bvrs` provides the three command-line capabilities of the Bitvise SSH
//! Client suite: an interactive shell (`stermc`), one-shot command execution
//! (`sexec`), and SFTP file transfers (`sftpc`). The SSH protocol is
//! implemented by [russh](https://crates.io/crates/russh) with the `ring`
//! crypto backend; this crate wires it into a small, scriptable CLI.

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
pub async fn run(cli: cli::Cli) -> Result<i32> {
    let (auth, dest, command) = cli.split()?;
    let mut handle = conn::connect(&auth, &dest).await?;
    let code = match command {
        cli::Command::Shell { .. } => shell::run(&mut handle).await?,
        cli::Command::Exec { argv, .. } => exec::run(&mut handle, &argv).await?,
        cli::Command::Sftp { op, .. } => {
            sftp_cmd::run(&mut handle, &op).await?;
            0
        }
    };
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    Ok(code as i32)
}

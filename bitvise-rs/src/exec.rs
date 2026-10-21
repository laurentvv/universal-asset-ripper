//! One-shot remote command execution (`bvrs exec`, replaces sexec).

use anyhow::{Result, bail};
use russh::client::Handle;
use russh::{ChannelMsg, Disconnect};
use tokio::io::{AsyncWriteExt, BufWriter};

use crate::conn::ClientHandler;

/// Run `argv` on the remote host; returns the remote exit status.
///
/// Arguments are joined with spaces, exactly like OpenSSH `ssh`;
/// quoting for the remote shell is the caller's responsibility.
pub async fn run(handle: &mut Handle<ClientHandler>, argv: &[String]) -> Result<u32> {
    let command = argv.join(" ");
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| anyhow::anyhow!("opening session channel: {e}"))?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| anyhow::anyhow!("sending exec request: {e}"))?;

    let mut stdout = BufWriter::new(tokio::io::stdout());
    let mut stderr = BufWriter::new(tokio::io::stderr());
    let mut exit_status = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                stdout.write_all(data).await?;
                stdout.flush().await?;
            }
            ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                stderr.write_all(data).await?;
                stderr.flush().await?;
            }
            ChannelMsg::ExitStatus { exit_status: code } => {
                exit_status = Some(code);
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }

    match exit_status {
        Some(code) => Ok(code),
        None => {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "", "English")
                .await;
            bail!("remote command terminated without reporting an exit status")
        }
    }
}

//! Interactive shell with a PTY (`bvrs shell`, replaces stermc).

use std::time::Duration;

use anyhow::{Context, Result};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use russh::client::Handle;
use russh::{Channel, ChannelMsg, Disconnect};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::conn::ClientHandler;

/// Escape sequence: `~.` on a fresh line closes the session (like OpenSSH).
const ESCAPE: (u8, u8) = (b'~', b'.');

/// Re-enables the cooked terminal mode when dropped.
struct RawMode;

impl RawMode {
    fn enable() -> Result<Self> {
        enable_raw_mode().context("entering terminal raw mode")?;
        Ok(Self)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
    }
}

/// Open a session channel and request a PTY sized to the current terminal.
pub async fn attach(handle: &mut Handle<ClientHandler>) -> Result<Channel<russh::client::Msg>> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| anyhow::anyhow!("opening session channel: {e}"))?;
    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    let term = std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".to_owned());
    channel
        .request_pty(false, &term, cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| anyhow::anyhow!("requesting PTY: {e}"))?;
    channel
        .request_shell(false)
        .await
        .map_err(|e| anyhow::anyhow!("requesting shell: {e}"))?;
    Ok(channel)
}

/// Run an interactive shell over `handle`. Returns the remote exit status.
pub async fn run(handle: &mut Handle<ClientHandler>) -> Result<u32> {
    let mut channel = attach(handle).await?;
    let _raw = RawMode::enable()?;
    eprintln!(
        "\r\nbvrs: connected — type '{}{}' on a new line to disconnect\r",
        ESCAPE.0 as char, ESCAPE.1 as char
    );

    // stdin is read from a blocking thread (raw mode disables line buffering).
    let (tx, rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin().lock();
        let mut buf = [0u8; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    pump(&mut channel, rx, tokio::io::stdout(), tokio::io::stderr()).await
}

/// Core event loop: stdin -> channel, channel -> stdout, resize -> window_change.
///
/// Split out from [`run`] so tests can drive it with synthetic input/output.
pub async fn pump<W1, W2>(
    channel: &mut Channel<russh::client::Msg>,
    mut stdin: mpsc::Receiver<Vec<u8>>,
    mut stdout: W1,
    mut stderr: W2,
) -> Result<u32>
where
    W1: tokio::io::AsyncWrite + Unpin,
    W2: tokio::io::AsyncWrite + Unpin,
{
    let mut exit_status = None;
    let mut stdin_open = true;
    let mut esc_pending = false;
    let mut at_line_start = true;
    let mut resize_tick = tokio::time::interval(Duration::from_millis(500));
    resize_tick.tick().await; // first tick fires immediately
    let mut last_size = crossterm::terminal::size().ok();

    loop {
        tokio::select! {
            maybe = stdin.recv(), if stdin_open => {
                match maybe {
                    Some(bytes) => {
                        // Forward bytes, honouring the ~. escape on fresh lines.
                        let mut out = Vec::with_capacity(bytes.len());
                        let mut quit = false;
                        for &b in &bytes {
                            if esc_pending {
                                esc_pending = false;
                                if b == ESCAPE.1 {
                                    quit = true;
                                    break;
                                }
                                out.push(ESCAPE.0);
                            }
                            if at_line_start && b == ESCAPE.0 {
                                esc_pending = true;
                                continue;
                            }
                            out.push(b);
                            at_line_start = b == b'\n' || b == b'\r';
                        }
                        if !out.is_empty() {
                            channel
                                .data(&out[..])
                                .await
                                .map_err(|e| anyhow::anyhow!("sending input: {e}"))?;
                        }
                        if quit {
                            channel.eof().await.ok();
                            channel.close().await.ok();
                            break;
                        }
                    }
                    None => {
                        stdin_open = false;
                        channel
                            .eof()
                            .await
                            .map_err(|e| anyhow::anyhow!("closing stdin: {e}"))?;
                    },
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        stdout.write_all(data).await?;
                        stdout.flush().await?;
                    }
                    Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                        stderr.write_all(data).await?;
                        stderr.flush().await?;
                    }
                    Some(ChannelMsg::ExitStatus { exit_status: code }) => {
                        exit_status = Some(code);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            _ = resize_tick.tick() => {
                if let Ok(size) = crossterm::terminal::size()
                    && Some(size) != last_size
                {
                    last_size = Some(size);
                    channel
                        .window_change(size.0 as u32, size.1 as u32, 0, 0)
                        .await
                        .ok();
                }
            }
        }
    }

    Ok(exit_status.unwrap_or(0))
}

/// Best-effort disconnect before dropping a shell session.
pub async fn disconnect(handle: &mut Handle<ClientHandler>) {
    let _ = handle
        .disconnect(Disconnect::ByApplication, "", "English")
        .await;
}

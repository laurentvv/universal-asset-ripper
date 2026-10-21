//! Network thread: owns the tokio runtime, the SSH connection, the shell
//! channel and the SFTP session. Communicates with the egui loop through
//! channels and triggers repaints on every message.

use std::path::PathBuf;
use std::sync::mpsc::Sender;

use anyhow::Result;
use eframe::egui;
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::{Receiver, Sender as TkSender};

use crate::ansi;
use crate::gui_msg::GuiMsg;
use crate::net_cmd::NetCmd;

const CHUNK: usize = 64 * 1024;

/// Send a message to the GUI thread and request a repaint.
fn push(gui: &Sender<GuiMsg>, ctx: &egui::Context, msg: GuiMsg) {
    let _ = gui.send(msg);
    ctx.request_repaint();
}

/// Spawn the network thread. Returns the GUI-side handles.
pub fn spawn(ctx: egui::Context) -> (TkSender<NetCmd>, std::sync::mpsc::Receiver<GuiMsg>) {
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel(64);
    let (gui_tx, gui_rx) = std::sync::mpsc::channel::<GuiMsg>();

    std::thread::Builder::new()
        .name("bvrs-net".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("network runtime");
            rt.block_on(run_loop(cmd_rx, gui_tx, ctx));
        })
        .expect("spawning network thread");

    (cmd_tx, gui_rx)
}

async fn run_loop(mut cmd_rx: Receiver<NetCmd>, gui_tx: Sender<GuiMsg>, ctx: egui::Context) {
    let mut state = NetState::new(gui_tx.clone(), ctx.clone());

    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            NetCmd::Connect {
                dest,
                password,
                keyfile,
                strict,
            } => state.connect(dest, password, keyfile, strict).await,
            NetCmd::TermInput(bytes) => {
                if let Some(tx) = &state.term_input {
                    let _ = tx.send(bytes).await;
                }
            }
            NetCmd::SftpList(path) => state.sftp_list(&path).await,
            NetCmd::SftpUpload { local, remote_dir } => {
                state.sftp_upload(&local, &remote_dir).await
            }
            NetCmd::SftpDownload {
                remote_path,
                local_dir,
            } => state.sftp_download(&remote_path, &local_dir).await,
            NetCmd::Disconnect => {
                state.shutdown("disconnected by user").await;
                return;
            }
        }
    }
    state.shutdown("closed").await;
}

struct NetState {
    gui: Sender<GuiMsg>,
    ctx: egui::Context,
    handle: Option<Handle<bvrs::conn::ClientHandler>>,
    term_input: Option<TkSender<Vec<u8>>>,
    sftp: Option<SftpSession>,
    remote_cwd: String,
}

impl NetState {
    fn new(gui: Sender<GuiMsg>, ctx: egui::Context) -> Self {
        Self {
            gui,
            ctx,
            handle: None,
            term_input: None,
            sftp: None,
            remote_cwd: String::new(),
        }
    }

    fn send(&self, msg: GuiMsg) {
        push(&self.gui, &self.ctx, msg);
    }

    fn error(&self, e: anyhow::Error) {
        self.send(GuiMsg::Error(format!("{e:#}")));
    }

    async fn connect(
        &mut self,
        dest: String,
        password: Option<String>,
        keyfile: Option<String>,
        strict: bool,
    ) {
        self.send(GuiMsg::Connecting(dest.clone()));
        let Ok(parsed) = bvrs::dest::Destination::parse(&dest) else {
            self.error(anyhow::anyhow!("invalid destination {dest:?}"));
            return;
        };
        let opts = bvrs::cli::AuthOpts {
            port: None,
            identities: keyfile.map(PathBuf::from).into_iter().collect(),
            identity_passphrase: None,
            password,
            password_env: None,
            host_key_policy: if strict {
                bvrs::hostkeys::HostKeyPolicy::Strict
            } else {
                bvrs::hostkeys::HostKeyPolicy::AcceptNew
            },
            pinned_fingerprints: vec![],
            known_hosts: bvrs::hostkeys::default_path(),
            connect_timeout: 15,
        };

        let handle = match bvrs::conn::connect(&opts, &parsed).await {
            Ok(h) => h,
            Err(e) => {
                self.error(e);
                self.send(GuiMsg::Disconnected("connection failed".into()));
                return;
            }
        };

        let fingerprint = format!(
            "connected as {}@{}:{} (host key recorded in {})",
            parsed.user,
            parsed.host,
            parsed.port.unwrap_or(22),
            opts.known_hosts.display()
        );
        let mut handle = handle;
        if let Err(e) = self.start_shell(&mut handle).await {
            self.error(e);
        }
        self.handle = Some(handle);
        self.send(GuiMsg::Connected { label: fingerprint });
    }

    async fn start_shell(&mut self, handle: &mut Handle<bvrs::conn::ClientHandler>) -> Result<()> {
        let mut channel = bvrs::shell::attach(handle).await?;
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
        let sink = TermSink {
            gui: self.gui.clone(),
            ctx: self.ctx.clone(),
            buf: Vec::new(),
        };
        let gui = self.gui.clone();
        let ctx = self.ctx.clone();
        tokio::spawn(async move {
            let code = bvrs::shell::pump(&mut channel, rx, sink, tokio::io::sink())
                .await
                .unwrap_or(0);
            let _ = gui.send(GuiMsg::TermExit(code as i32));
            let _ = gui.send(GuiMsg::Disconnected(format!("shell closed (exit {code})")));
            ctx.request_repaint();
        });
        self.term_input = Some(tx);
        Ok(())
    }

    async fn ensure_sftp(&mut self) -> Result<&SftpSession> {
        if self.sftp.is_none() {
            let Some(handle) = self.handle.as_mut() else {
                anyhow::bail!("not connected");
            };
            let sftp = bvrs::sftp_cmd::open_session(handle).await?;
            self.remote_cwd = sftp
                .canonicalize(".")
                .await
                .unwrap_or_else(|_| "/".to_owned());
            self.sftp = Some(sftp);
        }
        Ok(self.sftp.as_ref().expect("just set"))
    }

    fn resolve_remote(&self, path: &str) -> String {
        if path.starts_with('/') || self.remote_cwd.is_empty() {
            path.to_owned()
        } else {
            format!("{}/{}", self.remote_cwd.trim_end_matches('/'), path)
        }
    }

    async fn sftp_list(&mut self, path: &str) {
        let listing = async {
            let target = if path.is_empty() {
                self.remote_cwd.clone()
            } else {
                self.resolve_remote(path)
            };
            let sftp = self.ensure_sftp().await?;
            let resolved = sftp.canonicalize(&target).await?;
            let mut entries: Vec<(String, bool, u64)> = sftp
                .read_dir(&resolved)
                .await?
                .map(|e| {
                    let md = e.metadata();
                    (e.file_name(), md.is_dir(), md.len())
                })
                .collect();
            entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            Ok::<_, anyhow::Error>((resolved, entries))
        }
        .await;

        match listing {
            Ok((resolved, entries)) => {
                self.remote_cwd = resolved;
                self.send(GuiMsg::SftpCwd(self.remote_cwd.clone()));
                self.send(GuiMsg::SftpListing(entries));
            }
            Err(e) => self.error(e),
        }
    }

    async fn sftp_upload(&mut self, local: &str, remote_dir: &str) {
        let local_path = PathBuf::from(local);
        let name = local_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "upload.bin".to_owned());
        let remote_path = format!("{}/{}", remote_dir.trim_end_matches('/'), name);

        let progress = |done: u64, total: u64, finished: bool| GuiMsg::Transfer {
            label: format!("↑ {name}"),
            done,
            total,
            finished,
        };

        let gui = self.gui.clone();
        let ctx = self.ctx.clone();
        let result = async {
            let mut local_file = tokio::fs::File::open(&local_path).await?;
            let total = local_file.metadata().await?.len();
            let sftp = self.ensure_sftp().await?;
            let mut remote_file = sftp.create(&remote_path).await?;
            let mut buf = vec![0u8; CHUNK];
            let mut done = 0u64;
            loop {
                let n = local_file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                remote_file.write_all(&buf[..n]).await?;
                done += n as u64;
                push(&gui, &ctx, progress(done, total, false));
            }
            remote_file.shutdown().await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;

        match result {
            Ok(()) => {
                self.send(progress(1, 1, true));
                self.sftp_list("").await;
            }
            Err(e) => self.error(e),
        }
    }

    async fn sftp_download(&mut self, remote_path: &str, local_dir: &str) {
        let name = remote_path.rsplit('/').next().unwrap_or("download.bin");
        let local_path = PathBuf::from(local_dir).join(name);

        let progress = |done: u64, total: u64, finished: bool| GuiMsg::Transfer {
            label: format!("↓ {name}"),
            done,
            total,
            finished,
        };

        let gui = self.gui.clone();
        let ctx = self.ctx.clone();
        let result = async {
            let sftp = self.ensure_sftp().await?;
            let total = sftp.metadata(remote_path).await?.len();
            let mut remote_file = sftp.open(remote_path).await?;
            let mut local_file = tokio::fs::File::create(&local_path).await?;
            let mut buf = vec![0u8; CHUNK];
            let mut done = 0u64;
            loop {
                let n = remote_file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                local_file.write_all(&buf[..n]).await?;
                done += n as u64;
                push(&gui, &ctx, progress(done, total, false));
            }
            remote_file.shutdown().await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;

        match result {
            Ok(()) => self.send(progress(1, 1, true)),
            Err(e) => self.error(e),
        }
    }

    async fn shutdown(&mut self, reason: &str) {
        self.term_input = None;
        self.sftp = None;
        if let Some(handle) = self.handle.take() {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
        }
        self.send(GuiMsg::Disconnected(reason.to_owned()));
    }
}

/// AsyncWrite sink that strips ANSI and forwards text to the GUI thread.
struct TermSink {
    gui: Sender<GuiMsg>,
    ctx: egui::Context,
    buf: Vec<u8>,
}

impl tokio::io::AsyncWrite for TermSink {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        self.buf.extend_from_slice(buf);
        std::task::Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        if !self.buf.is_empty() {
            let text = ansi::strip(&self.buf);
            self.buf.clear();
            let _ = self.gui.send(GuiMsg::TermOut(text));
            self.ctx.request_repaint();
        }
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        self.poll_flush(cx)
    }
}

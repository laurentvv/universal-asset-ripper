//! In-process SSH + SFTP test server (integration tests only).
//!
//! Auth: user `test`, password `secret`, any public key.
//! Exec: canned commands `echo hello`, `fail 3`, `cat` (echoes stdin).
//! SFTP: real filesystem operations rooted at a temp directory.
//!
//! Also included by `examples/mock-sshd.rs`, where most helpers are
//! unused — hence the file-wide allow.
#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use anyhow::Result;
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{Auth, ChannelOpenHandle, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    Attrs, Data, File, FileAttributes, Handle as SftpHandle, Name, OpenFlags, Status, StatusCode,
    Version,
};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

/// Credentials accepted by the test server.
pub const USER: &str = "test";
pub const PASSWORD: &str = "secret";

/// Recorded server-side events, shared with the test process.
#[derive(Clone, Default)]
pub struct Events {
    inner: Arc<Mutex<Vec<String>>>,
}

impl Events {
    async fn push(&self, event: String) {
        self.inner.lock().await.push(event);
    }

    /// True if an event matching `needle` was recorded.
    pub async fn saw(&self, needle: &str) -> bool {
        self.inner.lock().await.iter().any(|e| e.contains(needle))
    }

    /// Wait up to `millis` for an event containing `needle`.
    pub async fn wait_for(&self, needle: &str, millis: u64) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(millis);
        while tokio::time::Instant::now() < deadline {
            if self.saw(needle).await {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }
}

/// A running test server: stop by dropping it.
pub struct TestServer {
    pub addr: SocketAddr,
    pub events: Events,
    /// Root directory exposed over SFTP.
    pub root: PathBuf,
    /// SHA256 fingerprint of the server host key (for -hostKeyFp tests).
    pub fingerprint: String,
}

/// Start a test server on 127.0.0.1 with a random port.
pub async fn start() -> Result<TestServer> {
    let root = tempfile::tempdir()?.keep();
    let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
    start_on(addr, root).await
}

/// Start the test server bound to `addr` with SFTP rooted at `root`
/// (used by tests via `start` and by `examples/mock-sshd.rs`).
pub async fn start_on(addr: SocketAddr, root: PathBuf) -> Result<TestServer> {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
    let fingerprint = key
        .public_key()
        .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        .to_string();
    let config = Arc::new(russh::server::Config {
        auth_rejection_time: Duration::from_millis(100),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        keys: vec![key],
        ..Default::default()
    });

    let socket = TcpListener::bind(addr).await?;
    let addr = socket.local_addr()?;

    let events = Events::default();
    let mut server = Supervisor {
        events: events.clone(),
        root: root.clone(),
    };
    tokio::spawn(async move {
        if let Err(e) = server.run_on_socket(config, &socket).await {
            eprintln!("test server stopped: {e}");
        }
    });

    Ok(TestServer {
        addr,
        events,
        root,
        fingerprint,
    })
}

#[derive(Clone)]
struct Supervisor {
    events: Events,
    root: PathBuf,
}

impl russh::server::Server for Supervisor {
    type Handler = TestSession;

    fn new_client(&mut self, _addr: Option<SocketAddr>) -> Self::Handler {
        TestSession {
            events: self.events.clone(),
            root: self.root.clone(),
            channels: Arc::new(Mutex::new(HashMap::new())),
            cat_channels: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

struct TestSession {
    events: Events,
    root: PathBuf,
    channels: Arc<Mutex<HashMap<ChannelId, Channel<Msg>>>>,
    /// Channels running `exec cat`; only these echo data back.
    cat_channels: Arc<Mutex<Vec<ChannelId>>>,
}

impl TestSession {
    async fn take_channel(&self, id: ChannelId) -> Option<Channel<Msg>> {
        self.channels.lock().await.remove(&id)
    }
}

impl russh::server::Handler for TestSession {
    type Error = anyhow::Error;

    async fn auth_none(&mut self, user: &str) -> Result<Auth, Self::Error> {
        self.events.push(format!("auth_none({user})")).await;
        Ok(Auth::Reject {
            proceed_with_methods: None,
            partial_success: false,
        })
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        let ok = user == USER && password == PASSWORD;
        self.events
            .push(format!(
                "auth_password({user})={}",
                if ok { "accept" } else { "reject" }
            ))
            .await;
        if ok {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        self.events
            .push(format!(
                "auth_publickey({user})={}",
                public_key.to_openssh()?
            ))
            .await;
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.events
            .push(format!(
                "pty_request(term={term}, {col_width}x{row_height})"
            ))
            .await;
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.events.push("shell_request".to_owned()).await;
        // The test server's shell behaves like `cat`: input is echoed back.
        self.cat_channels.lock().await.push(channel);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).into_owned();
        self.events.push(format!("exec_request({command})")).await;
        session.channel_success(channel)?;
        match command.as_str() {
            "echo hello" => {
                session.data(channel, b"hello\n".to_vec())?;
                session.exit_status_request(channel, 0)?;
                session.close(channel)?;
            }
            "fail 3" => {
                session.extended_data(channel, 1, b"boom\n".to_vec())?;
                session.exit_status_request(channel, 3)?;
                session.close(channel)?;
            }
            "cat" => {
                self.cat_channels.lock().await.push(channel);
            }
            other => {
                session.data(channel, format!("unhandled: {other}\n").into_bytes())?;
                session.exit_status_request(channel, 127)?;
                session.close(channel)?;
            }
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.events
            .push(format!("data({})", String::from_utf8_lossy(data)))
            .await;
        let echo = self.cat_channels.lock().await.contains(&channel);
        if echo {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel_id)?;
            return Ok(());
        }
        self.events.push("subsystem(sftp)".to_owned()).await;
        let Some(channel) = self.take_channel(channel_id).await else {
            return Ok(());
        };
        session.channel_success(channel_id)?;
        let fs = SftpFs::new(&self.root);
        russh_sftp::server::run(channel.into_stream(), fs).await;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Minimal filesystem-backed SFTP server handler.
// ---------------------------------------------------------------------------

struct SftpFs {
    root: PathBuf,
    files: HashMap<String, std::fs::File>,
    dirs: HashMap<String, Vec<(String, FileAttributes)>>,
    counter: u64,
}

impl SftpFs {
    fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            files: HashMap::new(),
            dirs: HashMap::new(),
            counter: 0,
        }
    }

    fn resolve(&self, sftp_path: &str) -> PathBuf {
        let rel = sftp_path
            .replace('\\', "/")
            .trim_start_matches('/')
            .trim_start_matches("./")
            .trim_start_matches('/')
            .to_owned();
        if rel.is_empty() {
            self.root.clone()
        } else {
            self.root.join(rel)
        }
    }

    fn next_handle(&mut self) -> String {
        self.counter += 1;
        format!("h{}", self.counter)
    }

    fn io_status(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_owned(),
            language_tag: "en-US".to_owned(),
        }
    }
}

fn io_err(e: std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn attrs_of(md: &std::fs::Metadata) -> FileAttributes {
    let perms = if md.is_dir() {
        0o755 | 0o040000
    } else {
        0o644 | 0o100000
    };
    FileAttributes {
        size: Some(md.len()),
        uid: None,
        user: None,
        gid: None,
        group: None,
        permissions: Some(perms),
        atime: None,
        mtime: md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as u32),
    }
}

impl russh_sftp::server::Handler for SftpFs {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        let _ = version;
        Ok(Version::new())
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<SftpHandle, Self::Error> {
        let path = self.resolve(&filename);
        let mut opts = std::fs::OpenOptions::new();
        opts.read(pflags.contains(OpenFlags::READ) || !pflags.contains(OpenFlags::WRITE));
        opts.write(pflags.contains(OpenFlags::WRITE));
        opts.create(pflags.contains(OpenFlags::CREATE));
        opts.truncate(pflags.contains(OpenFlags::TRUNCATE));
        opts.append(pflags.contains(OpenFlags::APPEND));
        let f = opts.open(&path).map_err(io_err)?;
        let h = self.next_handle();
        self.files.insert(h.clone(), f);
        Ok(SftpHandle { id, handle: h })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.files.remove(&handle);
        self.dirs.remove(&handle);
        Ok(Self::io_status(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        use std::io::{Read, Seek, SeekFrom};
        let f = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        f.seek(SeekFrom::Start(offset)).map_err(io_err)?;
        let mut buf = vec![0u8; len as usize];
        let n = f.read(&mut buf).map_err(io_err)?;
        buf.truncate(n);
        Ok(Data { id, data: buf })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        use std::io::{Seek, SeekFrom, Write};
        let f = self.files.get_mut(&handle).ok_or(StatusCode::Failure)?;
        f.seek(SeekFrom::Start(offset)).map_err(io_err)?;
        f.write_all(&data).map_err(io_err)?;
        Ok(Self::io_status(id))
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<SftpHandle, Self::Error> {
        let full = self.resolve(&path);
        let entries = std::fs::read_dir(&full)
            .map_err(io_err)?
            .filter_map(|e| e.ok())
            .map(|e| {
                let attrs = e.metadata().map(|m| attrs_of(&m)).unwrap_or_default();
                (e.file_name().to_string_lossy().into_owned(), attrs)
            })
            .collect::<Vec<_>>();
        let h = self.next_handle();
        self.dirs.insert(h.clone(), entries);
        Ok(SftpHandle { id, handle: h })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let entries = self.dirs.get_mut(&handle).ok_or(StatusCode::Failure)?;
        if entries.is_empty() {
            return Err(StatusCode::Eof);
        }
        let drained: Vec<File> = entries
            .drain(..)
            .map(|(name, attrs)| File::new(name, attrs))
            .collect();
        Ok(Name { id, files: drained })
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.resolve(&filename)).map_err(io_err)?;
        Ok(Self::io_status(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        std::fs::create_dir(self.resolve(&path)).map_err(io_err)?;
        Ok(Self::io_status(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        std::fs::remove_dir(self.resolve(&path)).map_err(io_err)?;
        Ok(Self::io_status(id))
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let md = std::fs::metadata(self.resolve(&path)).map_err(io_err)?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&md),
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let md = std::fs::metadata(self.resolve(&path)).map_err(io_err)?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&md),
        })
    }

    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        let f = self.files.get(&handle).ok_or(StatusCode::Failure)?;
        let md = f.metadata().map_err(io_err)?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&md),
        })
    }

    async fn setstat(
        &mut self,
        id: u32,
        _path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        Ok(Self::io_status(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        std::fs::rename(self.resolve(&oldpath), self.resolve(&newpath)).map_err(io_err)?;
        Ok(Self::io_status(id))
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        // Report a unix-style path rooted at the SFTP root directory.
        let resolved = self.resolve(&path);
        let rel = resolved
            .strip_prefix(&self.root)
            .unwrap_or(&resolved)
            .to_string_lossy()
            .replace('\\', "/");
        let shown = if rel.is_empty() {
            "/".to_owned()
        } else {
            format!("/{}", rel.trim_start_matches('/'))
        };
        let trimmed = shown.trim_end_matches('/');
        let name = if trimmed.is_empty() { "/" } else { trimmed };
        Ok(Name {
            id,
            files: vec![File::dummy(name.to_owned())],
        })
    }
}

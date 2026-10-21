//! SFTP session commands (`bvrs sftp`, replaces sftpc).
//!
//! Commands come from positional arguments (one sftpc command line each),
//! `-cmd=` (`;`-separated), `-cmdFile=` (one per line, `#` comments), or
//! stdin when nothing else is given. The command set mirrors sftpc's
//! `-help-shell` for the operations that map onto SFTP v3 and local fs.

use std::io::{BufRead, IsTerminal, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::bvc::BvcOpts;
use crate::conn::ClientHandler;
use crate::progress::Progress;

const CHUNK: usize = 64 * 1024;

/// One SFTP session with tracked remote and local working directories.
pub struct SftpShell {
    sftp: SftpSession,
    remote_cwd: String,
    local_cwd: PathBuf,
    show_progress: bool,
}

/// Open a raw SFTP session on a new channel (shared by the CLI shell and
/// the bvrs-gui front-end).
pub async fn open_session(
    handle: &mut Handle<ClientHandler>,
) -> Result<SftpSession> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| anyhow!("opening session channel: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| anyhow!("requesting sftp subsystem: {e}"))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| anyhow!("starting SFTP session: {e}"))
}

/// Open the SFTP subsystem and resolve the starting directories.
pub async fn open_shell(handle: &mut Handle<ClientHandler>, bvc: &BvcOpts) -> Result<SftpShell> {
    let sftp = open_session(handle).await?;
    let remote_cwd = sftp
        .canonicalize(".")
        .await
        .map_err(|e| anyhow!("resolving remote working directory: {e}"))?;
    let show_progress = bvc.get("progress") != Some("none");
    Ok(SftpShell {
        sftp,
        remote_cwd,
        local_cwd: std::env::current_dir().context("resolving local working directory")?,
        show_progress,
    })
}

/// Run SFTP commands. Returns the process exit code (0 ok, 1 any failure).
pub async fn run(handle: &mut Handle<ClientHandler>, words: Vec<String>, bvc: &BvcOpts) -> i32 {
    let (mut commands, continue_on_error) = match bvc.batch_commands() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("bvrs: {e:#}");
            return 1;
        }
    };
    commands.extend(words);

    let mut shell = match open_shell(handle, bvc).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("bvrs: {e:#}");
            return 1;
        }
    };

    let interactive = commands.is_empty() && std::io::stdin().is_terminal();
    let mut failed = false;

    if !commands.is_empty() {
        for command in &commands {
            match shell.execute(command).await {
                Ok(true) => break,
                Ok(false) => {}
                Err(e) => {
                    eprintln!("bvrs: {command}: {e:#}");
                    failed = true;
                    if !continue_on_error {
                        break;
                    }
                }
            }
        }
    } else {
        // Batch/interactive mode: one command per stdin line.
        let stdin = std::io::stdin();
        let mut lines = stdin.lock().lines();
        loop {
            if interactive {
                print!("sftp> ");
                let _ = std::io::stdout().flush();
            }
            let Some(line) = lines.next() else { break };
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("bvrs: reading stdin: {e}");
                    failed = true;
                    break;
                }
            };
            let trimmed = line.split('#').next().unwrap_or_default().trim().to_owned();
            if trimmed.is_empty() {
                continue;
            }
            match shell.execute(&trimmed).await {
                Ok(true) => break,
                Ok(false) => {}
                Err(e) => {
                    eprintln!("bvrs: {trimmed}: {e:#}");
                    failed = true;
                    if !continue_on_error {
                        break;
                    }
                }
            }
        }
    }

    let _ = shell.sftp.close().await;
    i32::from(failed)
}

impl SftpShell {
    /// Execute one command line. `Ok(true)` = session should stop (exit).
    pub async fn execute(&mut self, line: &str) -> Result<bool> {
        let mut parts = line.split_whitespace();
        let Some(cmd) = parts.next() else {
            return Ok(false);
        };
        let args: Vec<&str> = parts.collect();
        match cmd {
            "exit" | "quit" | "bye" => return Ok(true),
            "help" | "?" => self.help(),
            "cd" => self.cd(arg(&args, 0, "cd <remote-dir>")?).await?,
            "pwd" => println!("{}", self.remote_cwd),
            "lcd" => self.lcd(arg(&args, 0, "lcd <local-dir>")?)?,
            "lpwd" => println!("{}", self.local_cwd.display()),
            "ls" | "dir" => self.ls(args.first().copied()).await?,
            "lls" | "ldir" => self.lls(args.first().copied())?,
            "get" => {
                let remote = arg(&args, 0, "get <remote> [local]")?;
                self.get(remote, args.get(1).copied()).await?;
            }
            "put" => {
                let local = arg(&args, 0, "put <local> [remote]")?;
                self.put(local, args.get(1).copied()).await?;
            }
            "mkdir" | "md" => self
                .sftp
                .create_dir(self.remote(arg(&args, 0, "mkdir <remote-dir>")?)?)
                .await
                .map_err(sftp_err("mkdir"))?,
            "lmkdir" | "lmd" => {
                std::fs::create_dir(self.local(arg(&args, 0, "lmkdir <local-dir>")?)?)
                    .map_err(local_err("lmkdir"))?
            }
            "rmdir" | "rd" => self
                .sftp
                .remove_dir(self.remote(arg(&args, 0, "rmdir <remote-dir>")?)?)
                .await
                .map_err(sftp_err("rmdir"))?,
            "lrmdir" | "lrd" => {
                std::fs::remove_dir(self.local(arg(&args, 0, "lrmdir <local-dir>")?)?)
                    .map_err(local_err("lrmdir"))?
            }
            "mv" | "move" => {
                let from = arg(&args, 0, "mv <from> <to>")?;
                let to = arg(&args, 1, "mv <from> <to>")?;
                self.sftp
                    .rename(self.remote(from)?, self.remote(to)?)
                    .await
                    .map_err(sftp_err("mv"))?;
            }
            "lmv" | "lmove" => {
                let from = arg(&args, 0, "lmv <from> <to>")?;
                let to = arg(&args, 1, "lmv <from> <to>")?;
                std::fs::rename(self.local(from)?, self.local(to)?).map_err(local_err("lmv"))?;
            }
            "del" | "rm" => self
                .sftp
                .remove_file(self.remote(arg(&args, 0, "rm <remote-file>")?)?)
                .await
                .map_err(sftp_err("rm"))?,
            "ldel" | "lrm" => {
                std::fs::remove_file(self.local(arg(&args, 0, "lrm <local-file>")?)?)
                    .map_err(local_err("lrm"))?
            }
            "stat" => self.stat(arg(&args, 0, "stat <remote>")?).await?,
            "realpath" => {
                let resolved = self
                    .sftp
                    .canonicalize(self.remote(arg(&args, 0, "realpath <remote>")?)?)
                    .await
                    .map_err(sftp_err("realpath"))?;
                println!("{resolved}");
            }
            other => bail!("unknown command {other:?} (type 'help')"),
        }
        Ok(false)
    }

    fn help(&self) {
        println!(
            "bvrs sftp commands:\n\
               cd, pwd, ls/dir        remote directory navigation and listing\n\
               lcd, lpwd, lls/ldir    local directory navigation and listing\n\
               get <r> [l]            download      put <l> [r]   upload\n\
               mkdir/md, rmdir/rd     remote directories\n\
               lmkdir/lmd, lrmdir/lrd local directories\n\
               mv/move, del/rm        remote move and delete\n\
               lmv/lmove, ldel/lrm    local move and delete\n\
               stat, realpath         remote metadata / path resolution\n\
               exit, quit, bye        end the session"
        );
    }

    async fn cd(&mut self, path: &str) -> Result<()> {
        let resolved = self
            .sftp
            .canonicalize(self.remote(path)?)
            .await
            .map_err(|e| anyhow!("cd {path}: {e}"))?;
        let md = self
            .sftp
            .metadata(&resolved)
            .await
            .map_err(|e| anyhow!("cd {path}: {e}"))?;
        if !md.is_dir() {
            bail!("cd {path}: not a directory");
        }
        self.remote_cwd = resolved;
        Ok(())
    }

    fn lcd(&mut self, path: &str) -> Result<()> {
        let target = self.local(path)?;
        let md = std::fs::metadata(&target).map_err(local_err("lcd"))?;
        if !md.is_dir() {
            bail!("lcd {path}: not a directory");
        }
        self.local_cwd = std::fs::canonicalize(&target).unwrap_or(target);
        Ok(())
    }

    async fn ls(&self, path: Option<&str>) -> Result<()> {
        let target = self.remote(path.unwrap_or("."))?;
        let mut entries: Vec<_> = self
            .sftp
            .read_dir(&target)
            .await
            .map_err(|e| anyhow!("ls {target}: {e}"))?
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

    fn lls(&self, path: Option<&str>) -> Result<()> {
        let target = self.local(path.unwrap_or("."))?;
        let mut entries: Vec<_> = std::fs::read_dir(&target)
            .map_err(|e| anyhow!("lls {}: {e}", target.display()))?
            .flatten()
            .collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let md = entry.metadata().ok();
            let (kind, len) = md
                .map(|m| (if m.is_dir() { 'd' } else { '-' }, m.len()))
                .unwrap_or(('?', 0));
            println!("{kind}  {len:>12}  {}", entry.file_name().to_string_lossy());
        }
        Ok(())
    }

    async fn stat(&self, path: &str) -> Result<()> {
        let target = self.remote(path)?;
        let md = self
            .sftp
            .metadata(&target)
            .await
            .map_err(|e| anyhow!("stat {target}: {e}"))?;
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

    async fn get(&self, remote: &str, local: Option<&str>) -> Result<()> {
        let remote_path = self.remote(remote)?;
        let target = match local {
            Some(l) => self.local(l)?,
            None => self.local_cwd.join(basename(&remote_path)),
        };
        let md = self
            .sftp
            .metadata(&remote_path)
            .await
            .map_err(|e| anyhow!("stat {remote_path}: {e}"))?;
        let mut remote_file = self
            .sftp
            .open(&remote_path)
            .await
            .map_err(|e| anyhow!("opening remote {remote_path}: {e}"))?;
        let mut local_file = tokio::fs::File::create(&target)
            .await
            .with_context(|| format!("creating {}", target.display()))?;

        let mut progress = Progress::new(md.len());
        progress.set_enabled(self.show_progress);
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = remote_file
                .read(&mut buf)
                .await
                .map_err(|e| anyhow!("reading remote {remote_path}: {e}"))?;
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
            .map_err(|e| anyhow!("closing remote {remote_path}: {e}"))?;
        progress.finish();
        Ok(())
    }

    async fn put(&self, local: &str, remote: Option<&str>) -> Result<()> {
        let source = self.local(local)?;
        let remote_path = match remote {
            Some(r) => self.remote(r)?,
            None => {
                let name = source
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .context("deriving remote name from local path")?;
                self.remote(&name)?
            }
        };
        let mut local_file = tokio::fs::File::open(&source)
            .await
            .with_context(|| format!("opening {}", source.display()))?;
        let len = local_file
            .metadata()
            .await
            .with_context(|| format!("stat {}", source.display()))?
            .len();
        let mut remote_file = self
            .sftp
            .create(&remote_path)
            .await
            .map_err(|e| anyhow!("creating remote {remote_path}: {e}"))?;

        let mut progress = Progress::new(len);
        progress.set_enabled(self.show_progress);
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = local_file
                .read(&mut buf)
                .await
                .with_context(|| format!("reading {}", source.display()))?;
            if n == 0 {
                break;
            }
            remote_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| anyhow!("writing remote {remote_path}: {e}"))?;
            progress.advance(n as u64);
        }
        remote_file
            .shutdown()
            .await
            .map_err(|e| anyhow!("closing remote {remote_path}: {e}"))?;
        progress.finish();
        Ok(())
    }

    /// Resolve a remote path against the tracked remote working directory.
    fn remote(&self, path: &str) -> Result<String> {
        if path.starts_with('/')
            || (path.len() >= 2
                && path.as_bytes()[1] == b':'
                && path.as_bytes()[0].is_ascii_alphabetic())
        {
            Ok(path.to_owned())
        } else if self.remote_cwd == "/" {
            Ok(format!("/{path}"))
        } else {
            Ok(format!(
                "{}/{}",
                self.remote_cwd.trim_end_matches('/'),
                path
            ))
        }
    }

    /// Resolve a local path against the tracked local working directory.
    fn local(&self, path: &str) -> Result<PathBuf> {
        let p = Path::new(path);
        Ok(if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.local_cwd.join(p)
        })
    }
}

fn arg<'a>(args: &[&'a str], i: usize, usage: &str) -> Result<&'a str> {
    args.get(i)
        .copied()
        .with_context(|| format!("usage: {usage}"))
}

fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn mtime_secs(md: &russh_sftp::client::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sftp_err(what: &str) -> impl Fn(russh_sftp::client::error::Error) -> anyhow::Error + '_ {
    move |e| anyhow!("{what}: {e}")
}

fn local_err(what: &str) -> impl Fn(std::io::Error) -> anyhow::Error + '_ {
    move |e| anyhow!("{what}: {e}")
}

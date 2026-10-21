//! Command-line interface (clap derive).

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use crate::dest::Destination;
use crate::hostkeys::{self, HostKeyPolicy};

/// Rust reimplementation of the Bitvise SSH Client command-line tools.
///
/// Covers `stermc` (interactive shell), `sexec` (remote execution) and
/// `sftpc` (SFTP transfers) as subcommands of a single binary.
#[derive(Parser, Debug)]
#[command(
    name = "bvrs",
    version,
    about = "Bitvise-style SSH client tools in a single binary",
    subcommand_help_heading = "Commands"
)]
pub struct Cli {
    /// TCP port (also settable as user@host:port)
    #[arg(short = 'p', long, global = true)]
    pub port: Option<u16>,

    /// Private key file (OpenSSH/PEM format); repeatable
    #[arg(short = 'i', long, global = true, value_name = "FILE")]
    pub identity: Vec<PathBuf>,

    /// Read the password from this environment variable instead of prompting
    #[arg(long, global = true, value_name = "VAR")]
    pub password_env: Option<String>,

    /// Host key policy
    #[arg(long, global = true, value_enum, default_value_t = HostKeyPolicy::AcceptNew)]
    pub host_key: HostKeyPolicy,

    /// known_hosts file to use
    #[arg(short = 'k', long, global = true, value_name = "FILE")]
    pub known_hosts: Option<PathBuf>,

    /// Connection timeout in seconds
    #[arg(long, global = true, default_value_t = 15)]
    pub connect_timeout: u64,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Open an interactive shell with a PTY (replaces stermc).
    Shell {
        /// Destination: [user@]host[:port]
        dest: String,
    },
    /// Run a remote command and exit with its status (replaces sexec).
    Exec {
        /// Destination: [user@]host[:port]
        dest: String,
        /// Command and arguments, joined with spaces for the remote shell
        #[arg(trailing_var_arg = true, required = true)]
        argv: Vec<String>,
    },
    /// Perform one SFTP operation (replaces sftpc).
    Sftp {
        /// Destination: [user@]host[:port]
        dest: String,
        #[command(subcommand)]
        op: SftpOp,
    },
}

#[derive(Subcommand, Debug)]
pub enum SftpOp {
    /// List a remote directory (long form)
    Ls {
        /// Remote path (default ".")
        path: Option<String>,
    },
    /// Print the remote working directory
    Pwd,
    /// Download a remote file
    Get {
        remote: String,
        /// Local destination (default: same file name)
        local: Option<PathBuf>,
    },
    /// Upload a local file
    Put {
        local: PathBuf,
        /// Remote destination (default: same file name)
        remote: Option<String>,
    },
    /// Delete a remote file
    Rm { path: String },
    /// Create a remote directory
    Mkdir { path: String },
    /// Remove a remote directory
    Rmdir { path: String },
    /// Rename or move a remote file
    Mv { from: String, to: String },
    /// Show remote file metadata
    Stat { path: String },
}

/// Connection/authentication options resolved from the CLI.
#[derive(Debug)]
pub struct AuthOpts {
    pub port: Option<u16>,
    pub identities: Vec<PathBuf>,
    pub password_env: Option<String>,
    pub host_key_policy: HostKeyPolicy,
    pub known_hosts: PathBuf,
    pub connect_timeout: u64,
}

impl Cli {
    /// Split the CLI into auth options, resolved destination and command.
    pub fn split(self) -> Result<(AuthOpts, Destination, Command)> {
        let (dest_str, rest) = match self.command {
            Command::Shell { dest } => (
                dest,
                Command::Shell {
                    dest: String::new(),
                },
            ),
            Command::Exec { dest, argv } => (
                dest,
                Command::Exec {
                    dest: String::new(),
                    argv,
                },
            ),
            Command::Sftp { dest, op } => (
                dest,
                Command::Sftp {
                    dest: String::new(),
                    op,
                },
            ),
        };
        let mut dest = Destination::parse(&dest_str)
            .context(format!("cannot parse destination {dest_str:?}"))?;
        if dest.port.is_none() {
            dest.port = self.port;
        }
        let auth = AuthOpts {
            port: self.port,
            identities: self.identity,
            password_env: self.password_env,
            host_key_policy: self.host_key,
            known_hosts: self
                .known_hosts
                .clone()
                .unwrap_or_else(hostkeys::default_path),
            connect_timeout: self.connect_timeout,
        };
        Ok((auth, dest, rest))
    }
}

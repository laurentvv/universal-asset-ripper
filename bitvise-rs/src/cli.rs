//! Command-line interface (clap derive) for the native bvrs interface.
//!
//! Bitvise-style `-option=value` arguments are extracted beforehand by
//! [`crate::bvc`] and never reach clap.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};

use crate::bvc::BvcOpts;
use crate::dest::Destination;
use crate::hostkeys::{self, HostKeyPolicy};

/// Rust reimplementation of the Bitvise SSH Client command-line tools.
///
/// Covers `stermc` (interactive shell), `sexec` (remote execution) and
/// `sftpc` (SFTP transfers) as subcommands of a single binary, including
/// Bitvise-style `-option=value` arguments.
#[derive(Parser, Debug)]
#[command(
    name = "bvrs",
    version,
    about = "Bitvise-style SSH client tools in a single binary",
    subcommand_help_heading = "Commands"
)]
pub struct Cli {
    /// TCP port (also settable as user@host:port or -port=)
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
        /// Destination: [user@]host[:port] (or -host=/-user=/-port=)
        dest: Option<String>,
    },
    /// Run a remote command and exit with its status (replaces sexec).
    Exec {
        /// Destination: [user@]host[:port] (or -host=/-user=/-port=)
        dest: Option<String>,
        /// Command and arguments, joined with spaces for the remote shell
        #[arg(trailing_var_arg = true)]
        argv: Vec<String>,
    },
    /// Run SFTP commands: positional args, -cmd=, -cmdFile= or stdin
    /// (replaces sftpc). Examples: `bvrs sftp dest "ls" "put f.txt"`,
    /// `bvrs sftp dest -cmd="cd /tmp; get x"`.
    Sftp {
        /// Destination: [user@]host[:port] (or -host=/-user=/-port=)
        dest: Option<String>,
        /// Commands to run in order (one command per argument, sftpc-style)
        #[arg(trailing_var_arg = true)]
        words: Vec<String>,
    },
}

/// Connection/authentication options resolved from the native CLI and the
/// Bitvise compatibility layer.
#[derive(Debug)]
pub struct AuthOpts {
    pub port: Option<u16>,
    pub identities: Vec<PathBuf>,
    pub identity_passphrase: Option<String>,
    pub password: Option<String>,
    pub password_env: Option<String>,
    pub host_key_policy: HostKeyPolicy,
    pub pinned_fingerprints: Vec<String>,
    pub known_hosts: PathBuf,
    pub connect_timeout: u64,
}

impl Cli {
    /// Split the CLI into auth options, resolved destination and command.
    pub fn split(self, bvc: &BvcOpts) -> Result<(AuthOpts, Destination, Command)> {
        let mut command = self.command;

        // Destination: positional, else synthesized from -host=/-user=/-port=.
        // When -host= is given it wins (Bitvise semantics) and any positional
        // that clap captured as the destination is really the first command
        // word — push it back.
        let override_dest = |dest: &mut Option<String>, first_word: &mut Vec<String>| match bvc
            .dest_override
            .clone()
        {
            Some(over) => {
                if let Some(d) = dest.take() {
                    first_word.insert(0, d);
                }
                over
            }
            None => dest.take().unwrap_or_default(),
        };
        let dest_str = match &mut command {
            Command::Shell { dest } => match bvc.dest_override.clone() {
                Some(over) => over,
                None => dest.take().unwrap_or_default(),
            },
            Command::Exec { dest, argv } => override_dest(dest, argv),
            Command::Sftp { dest, words } => override_dest(dest, words),
        };
        if dest_str.is_empty() {
            bail!("missing destination: give [user@]host[:port] or -host= (with -user=/-port=)");
        }
        if let Command::Exec { argv, .. } = &command
            && argv.is_empty()
        {
            bail!("missing remote command: bvrs exec [user@]host[:port] -- cmd [args...]");
        }
        let mut dest = Destination::parse(&dest_str)
            .with_context(|| format!("cannot parse destination {dest_str:?}"))?;
        if dest.port.is_none() {
            dest.port = self.port;
        }

        let mut identities = self.identity;
        if let Some(file) = bvc.keypair_file() {
            identities.push(PathBuf::from(file));
        }

        let auth = AuthOpts {
            port: self.port,
            identities,
            identity_passphrase: bvc.keypair_pass(),
            password: bvc.password(),
            password_env: self.password_env,
            host_key_policy: self.host_key,
            pinned_fingerprints: bvc.pinned_fingerprints()?,
            known_hosts: self
                .known_hosts
                .clone()
                .unwrap_or_else(hostkeys::default_path),
            connect_timeout: self.connect_timeout,
        };
        Ok((auth, dest, command))
    }
}

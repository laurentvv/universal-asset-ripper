# bvrs — Bitvise SSH Client command-line tools, reimplemented in Rust

`bvrs` is a single-binary, scriptable SSH client covering the command-line
half of the [Bitvise SSH Client] suite. This is a clean-room reimplementation
against the SSH protocol — no Bitvise code is used or shipped. The SSH
transport is [russh] 0.63 (pure Rust, `ring` crypto backend) with
[russh-sftp] 3.x for the SFTP subsystem.

## Tool mapping

| Bitvise executable        | Purpose                              | bvrs equivalent                          |
|---------------------------|--------------------------------------|------------------------------------------|
| `stermc.exe`              | Scriptable SSH terminal              | `bvrs shell [user@]host[:port]`          |
| `sexec.exe`               | One-shot remote command execution    | `bvrs exec [user@]host[:port] -- cmd …`  |
| `sftpc.exe`               | Scriptable SFTP client               | `bvrs sftp [user@]host[:port] <op> …`    |
| `BvSsh.exe` (GUI)         | Graphical client, profiles, FTP-to-SFTP gateway | **not implemented** (CLI only) |
| `bvtermc.exe` / `totermc.exe` | Bitvise/VT100 terminal clients  | covered by `bvrs shell` (raw byte PTY)   |
| `stnlc.exe`               | Scriptable telnet client             | **not implemented** (SSH only)           |

## Bitvise command-line compatibility

`bvrs` accepts the Bitvise single-dash `-option=value` syntax on all
subcommands (source of truth: the built-in usage text of `sftpc`/`stermc`/
`sexec` 9.66). Supported options:

| Bitvise option | bvrs behavior |
|---|---|
| `[user@]host[:port]` or `-host=` + `-user=` + `-port=` | destination (`-host=` wins over a positional, which then becomes the first command word) |
| `-pw=password` | password authentication (prefer `--password-env` in scripts) |
| `-keypairFile=file` + `-keypairPass=pass` | public key authentication |
| `-hostKeyFp=SHA256:...` / `-hostKeyFile=file` | pin the server host key by SHA256 fingerprint (replaces known_hosts checking, mismatch is fatal) |
| `-cmd="a; b"` / `-cmdFile=file` (`#` comments) | SFTP command batch (`;`-separated / one per line) |
| `-ce` | continue an SFTP batch on error (exit code still reports failure) |
| `-progress=none` | disable transfer progress (other values: enabled) |
| `-noRegistry=` | accepted, ignored (bvrs never reads the registry) |

Any other Bitvise option (proxies, jump hosts, algorithm negotiation,
keyboard-interactive, …) is rejected with an explicit `not supported` error
instead of being silently misparsed.

`bvrs sftp` runs sftpc-style commands from positional arguments (one
command per argument), `-cmd=`/`-cmdFile=`, or stdin:

```
bvrs sftp deploy@web1 "mkdir release" "put app.tar.gz release/"
echo -e "cd /srv
ls
get app.log" | bvrs sftp deploy@web1
bvrs sftp deploy@web1 -cmdFile=deploy.cmds -ce
```

Implemented commands: `cd`, `pwd`, `ls`/`dir`, `lcd`, `lpwd`, `lls`/`ldir`,
`get`, `put`, `mkdir`/`md`, `rmdir`/`rd`, `mv`/`move`, `del`/`rm`,
`lmkdir`/`lmd`, `lrmdir`/`lrd`, `lmv`/`lmove`, `ldel`/`lrm`, `stat`,
`realpath`, `help`, `exit`/`quit`/`bye`. Not implemented from sftpc:
`queue`, `symlink`/`ln`, `chmod`/`chown`/`chgrp`, `attrib`, `type`,
checksum commands, `df`, `exec`, `!`.

## Usage

```text
bvrs [OPTIONS] <COMMAND>

Commands:
  shell  Open an interactive shell with a PTY
  exec   Run a remote command and exit with its status
  sftp   Perform one SFTP operation (ls, pwd, get, put, rm, mkdir, rmdir, mv, stat)
```

Examples:

```bash
# Interactive shell (PTY + raw terminal; "~." on a fresh line disconnects)
bvrs shell admin@router.lan

# Run a command; exit code = remote exit status
bvrs exec deploy@web1 -- systemctl status nginx

# SFTP one-shot operations
bvrs sftp deploy@web1 put release.tar.gz
bvrs sftp deploy@web1 ls /srv/www
bvrs sftp deploy@web1 get /var/log/app.log app.log
```

Connection options (accepted before or after the subcommand):

| Option | Description |
|--------|-------------|
| `-p, --port <PORT>` | Server port (default 22; also `[user@]host:port`) |
| `-i, --identity <FILE>` | Private key (OpenSSH/PEM); repeatable, tried in order |
| `--password-env <VAR>` | Read the password from an environment variable instead of prompting |
| `--host-key <POLICY>` | `accept-new` (default, OpenSSH-style TOFU), `strict`, `accept-any` |
| `-k, --known-hosts <FILE>` | known_hosts file (default `~/.ssh/known_hosts`) |
| `--connect-timeout <SECS>` | Connection timeout (default 15 s) |

Authentication order: each `-i` identity first, then password (prompted
without echo, or taken from `--password-env`).

Exit codes: `exec`/`shell` return the remote command's exit status;
`0` on success; `1` on error; `2` on CLI usage errors (clap default).

## Host key verification

Host keys are verified against an OpenSSH-format `known_hosts` file
(default `~/.ssh/known_hosts`; new entries are appended, existing content
is never rewritten). Plain (non-hashed, non-wildcard) entries are matched;
hashed (`|1|…`) or pattern entries written by other tools are ignored for
comparison but left untouched. A key mismatch is always a hard failure.

## Not implemented (vs. the Bitvise suite)

- GUI client, saved profiles, FTP-to-SFTP bridge, remote desktop (RDP) tunneling
- Port forwarding (local/remote/dynamic/SOCKS)
- SSH agent / Pageant integration for authentication (russh supports Pageant;
  not wired up yet), PuTTY `.ppk` keys (convert with `puttygen` first)
- Keyboard-interactive authentication (2FA)
- Interactive SFTP session (sftpc's `ls`/`cd`/`get` loop) — only one-shot ops
- Recursive `get`/`put` of directory trees, resume, permission preservation
- `bvterm` terminal emulation (raw bytes are forwarded; rendering is the
  local terminal's job, like OpenSSH)
- `stnlc` (telnet), `spksc`, WinFsp mounts

## Development

```bash
cargo test                        # unit + end-to-end tests
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The integration tests spin up an in-process SSH + SFTP server (russh server
side, backed by a temp directory) and drive the **real `bvrs` binary**
against it: password auth, publickey auth, TOFU known_hosts persistence,
exec stdout/stderr/exit codes, SFTP put/get/ls/mkdir/mv/rm/rmdir round-trips,
and the shell PTY + `~.` escape sequence.

[Bitvise SSH Client]: https://bitvise.com/ssh-client
[russh]: https://crates.io/crates/russh
[russh-sftp]: https://crates.io/crates/russh-sftp

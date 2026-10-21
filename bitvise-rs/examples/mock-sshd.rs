//! Standalone mock SSH/SFTP server for trying out `bvrs` locally.
//!
//! Usage: `cargo run --example mock-sshd [port]` (default 2222).
//!
//! Credentials: user `test`, password `secret`, any public key.
//! Exec commands: `echo hello`, `fail 3` (stderr + exit 3), `cat` (echo).
//! The shell behaves like `cat` (echoes input). SFTP is backed by a real
//! directory under %TEMP%\bvrs-mock-<port>.

#[path = "../tests/support/mod.rs"]
mod support;

use std::net::SocketAddr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port: u16 = std::env::args()
        .nth(1)
        .and_then(|p| p.parse().ok())
        .unwrap_or(2222);

    let root = std::env::temp_dir().join(format!("bvrs-mock-{port}"));
    std::fs::create_dir_all(root.join("docs"))?;
    std::fs::write(root.join("readme.txt"), b"bvrs mock server demo file\n")?;
    std::fs::write(
        root.join("docs").join("notes.md"),
        b"# notes\nseeded by mock-sshd\n",
    )?;

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let server = support::start_on(addr, root.clone()).await?;

    eprintln!("mock SSH/SFTP server listening on 127.0.0.1:{port}");
    eprintln!("  user=test  password=secret (any public key accepted)");
    eprintln!("  host key fingerprint: {}", server.fingerprint);
    eprintln!("  SFTP root: {}", root.display());
    eprintln!("  exec: 'echo hello' | 'fail 3' | 'cat'   shell: echoes input");
    eprintln!("try: ./target/debug/bvrs.exe sftp test@127.0.0.1:{port} ls");

    std::future::pending::<Result<(), anyhow::Error>>().await
}

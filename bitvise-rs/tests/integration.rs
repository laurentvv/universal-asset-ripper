//! End-to-end integration tests: the real `bvrs` binary against an
//! in-process SSH/SFTP server (see `support/`).

mod support;

use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

use support::{TestServer, USER, start};

/// Credentials are passed through the environment, never the command line.
struct Bvrs<'a> {
    server: &'a TestServer,
    known_hosts: &'a Path,
}

impl Bvrs<'_> {
    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_bvrs"));
        cmd.env("BVRS_TEST_PASSWORD", "secret")
            .env_remove("TERM")
            .arg("--host-key")
            .arg("accept-new")
            .arg("--known-hosts")
            .arg(self.known_hosts)
            .arg("--password-env")
            .arg("BVRS_TEST_PASSWORD")
            .args(args);
        cmd
    }

    fn dest(&self) -> String {
        format!("{USER}@127.0.0.1:{}", self.server.addr.port())
    }

    async fn run(&self, args: &[&str]) -> (i32, String, String) {
        let out = self
            .command(args)
            .output()
            .await
            .expect("running bvrs binary");
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }
}

async fn setup() -> (TestServer, tempfile::TempDir) {
    let server = start().await.expect("starting test server");
    let dir = tempfile::tempdir().expect("tempdir");
    (server, dir)
}

#[tokio::test(flavor = "multi_thread")]
async fn exec_echo_hello_full_binary() {
    let (server, dir) = setup().await;
    let bvrs = Bvrs {
        server: &server,
        known_hosts: &dir.path().join("known_hosts"),
    };

    let (code, stdout, stderr) = bvrs.run(&["exec", &bvrs.dest(), "echo", "hello"]).await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "hello\n");
    assert!(
        server
            .events
            .wait_for("exec_request(echo hello)", 5000)
            .await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn exec_exit_code_and_stderr() {
    let (server, dir) = setup().await;
    let bvrs = Bvrs {
        server: &server,
        known_hosts: &dir.path().join("known_hosts"),
    };

    let (code, stdout, stderr) = bvrs.run(&["exec", &bvrs.dest(), "fail", "3"]).await;
    assert_eq!(code, 3, "stderr: {stderr}");
    assert_eq!(stdout, "");
    assert!(stderr.trim_end().ends_with("boom"), "stderr: {stderr}");
}

#[tokio::test(flavor = "multi_thread")]
async fn auth_rejects_wrong_password() {
    let (server, dir) = setup().await;
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bvrs"));
    cmd.env("WRONG", "nope")
        .arg("--known-hosts")
        .arg(dir.path().join("known_hosts"))
        .arg("--host-key")
        .arg("accept-any")
        .arg("--password-env")
        .arg("WRONG")
        .args([
            "exec",
            &format!("{USER}@127.0.0.1:{}", server.addr.port()),
            "echo",
            "hello",
        ]);
    let out = cmd.output().await.expect("running bvrs");
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("permission denied"));
    assert!(
        server
            .events
            .wait_for("auth_password(test)=reject", 5000)
            .await
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn host_key_strict_rejects_unknown_then_accept_new_persists() {
    let (server, dir) = setup().await;
    let known_hosts = dir.path().join("kh");
    let bvrs = Bvrs {
        server: &server,
        known_hosts: &known_hosts,
    };
    let dest = bvrs.dest();

    // strict + empty known_hosts -> refused.
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_bvrs"));
    cmd.env("P", "secret")
        .arg("--known-hosts")
        .arg(&known_hosts)
        .arg("--host-key")
        .arg("strict")
        .arg("--password-env")
        .arg("P")
        .args(["exec", &dest, "echo", "hello"]);
    let out = cmd.output().await.expect("running bvrs");
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("strict"));

    // accept-new records the key and succeeds.
    let (code, stdout, stderr) = bvrs.run(&["exec", &dest, "echo", "hello"]).await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(stdout, "hello\n");
    assert!(known_hosts.exists(), "known_hosts entry must be recorded");

    // A second run now passes under strict policy (same known_hosts file).
    let mut cmd2 = Command::new(env!("CARGO_BIN_EXE_bvrs"));
    cmd2.env("P", "secret")
        .arg("--known-hosts")
        .arg(&known_hosts)
        .arg("--host-key")
        .arg("strict")
        .arg("--password-env")
        .arg("P")
        .args(["exec", &dest, "echo", "hello"]);
    let out2 = cmd2.output().await.expect("running bvrs");
    assert_eq!(out2.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&out2.stdout), "hello\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_put_get_ls_roundtrip() {
    let (server, dir) = setup().await;
    let bvrs = Bvrs {
        server: &server,
        known_hosts: &dir.path().join("known_hosts"),
    };
    let dest = bvrs.dest();

    // Local file to upload.
    let local = dir.path().join("upload.txt");
    std::fs::write(&local, b"bvrs payload\n").unwrap();

    let (code, _, stderr) = bvrs
        .run(&["sftp", &dest, "put", local.to_str().unwrap()])
        .await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(
        std::fs::read(server.root.join("upload.txt")).unwrap(),
        b"bvrs payload\n"
    );

    // Directory listing shows the uploaded file.
    let (code, stdout, stderr) = bvrs.run(&["sftp", &dest, "ls", "."]).await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("upload.txt"), "ls output: {stdout}");

    // Download to a different name and compare.
    let down = dir.path().join("download.txt");
    let (code, _, stderr) = bvrs
        .run(&["sftp", &dest, "get", "upload.txt", down.to_str().unwrap()])
        .await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert_eq!(std::fs::read(&down).unwrap(), b"bvrs payload\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn sftp_mkdir_mv_rm_rmdir() {
    let (server, dir) = setup().await;
    let bvrs = Bvrs {
        server: &server,
        known_hosts: &dir.path().join("known_hosts"),
    };
    let dest = bvrs.dest();

    let local = dir.path().join("f.txt");
    std::fs::write(&local, b"x").unwrap();

    let (code, _, stderr) = bvrs.run(&["sftp", &dest, "mkdir", "subdir"]).await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(server.root.join("subdir").is_dir());

    let (code, _, stderr) = bvrs
        .run(&[
            "sftp",
            &dest,
            "put",
            local.to_str().unwrap(),
            "subdir/a.txt",
        ])
        .await;
    assert_eq!(code, 0, "stderr: {stderr}");

    let (code, _, stderr) = bvrs
        .run(&["sftp", &dest, "mv", "subdir/a.txt", "subdir/b.txt"])
        .await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(server.root.join("subdir").join("b.txt").is_file());

    let (code, stdout, stderr) = bvrs.run(&["sftp", &dest, "ls", "subdir"]).await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(stdout.contains("b.txt"), "ls: {stdout}");

    let (code, _, stderr) = bvrs.run(&["sftp", &dest, "rm", "subdir/b.txt"]).await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(!server.root.join("subdir").join("b.txt").exists());

    let (code, _, stderr) = bvrs.run(&["sftp", &dest, "rmdir", "subdir"]).await;
    assert_eq!(code, 0, "stderr: {stderr}");
    assert!(!server.root.join("subdir").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn shell_pty_escape_and_exit_status() {
    use tokio::io::AsyncReadExt;

    let (server, dir) = setup().await;
    let known_hosts = dir.path().join("kh");

    // Library-level test: drive the shell pump with synthetic input so we
    // can assert PTY negotiation, echo and the ~. escape.
    let auth = bvrs::cli::AuthOpts {
        port: None,
        identities: vec![],
        password_env: Some("BVRS_SHELL_PW".to_owned()),
        host_key_policy: bvrs::hostkeys::HostKeyPolicy::AcceptNew,
        known_hosts: known_hosts.clone(),
        connect_timeout: 15,
    };
    // Edition 2024: env mutation is unsafe; the process is single test.
    unsafe { std::env::set_var("BVRS_SHELL_PW", "secret") };
    let dest = bvrs::dest::Destination::parse(&format!("{USER}@127.0.0.1:{}", server.addr.port()))
        .unwrap();

    let mut handle = bvrs::conn::connect(&auth, &dest).await.expect("connect");
    let mut channel = bvrs::shell::attach(&mut handle).await.expect("attach");

    let (client_out, mut captured) = tokio::io::duplex(8192);
    let (tx, rx) = tokio::sync::mpsc::channel(8);
    let pump = tokio::spawn(async move {
        bvrs::shell::pump(&mut channel, rx, client_out, tokio::io::sink()).await
    });

    // The test server's shell echoes input back (cat mode).
    tx.send(b"ping\n".to_vec()).await.unwrap();
    let mut echo = vec![0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(5), captured.read(&mut echo))
        .await
        .expect("echo timeout")
        .unwrap_or(0);
    assert_eq!(&echo[..n], b"ping\n");

    // ~. escape terminates the pump.
    tx.send(b"\n~.".to_vec()).await.unwrap();
    let status = tokio::time::timeout(Duration::from_secs(5), pump)
        .await
        .expect("pump must exit after escape")
        .expect("join")
        .expect("pump ok");
    assert_eq!(status, 0);

    assert!(server.events.wait_for("pty_request(", 5000).await);
    assert!(server.events.wait_for("shell_request", 5000).await);
}

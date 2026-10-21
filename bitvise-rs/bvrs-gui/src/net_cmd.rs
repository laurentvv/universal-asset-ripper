//! Commands from the egui loop to the network thread.

#[derive(Debug, Clone)]
pub enum NetCmd {
    Connect {
        dest: String,
        password: Option<String>,
        keyfile: Option<String>,
        strict: bool,
    },
    /// Bytes to send to the remote shell (the pump applies the ~. escape).
    TermInput(Vec<u8>),
    /// List a remote directory ("" = refresh the current one).
    SftpList(String),
    /// Upload a local file into a remote directory.
    SftpUpload {
        local: String,
        remote_dir: String,
    },
    /// Download a remote file into a local directory.
    SftpDownload {
        remote_path: String,
        local_dir: String,
    },
    Disconnect,
}

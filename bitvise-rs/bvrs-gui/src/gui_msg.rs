//! Messages from the network thread to the egui loop.

/// One remote directory entry: `(name, is_dir, size)`.
pub type Entry = (String, bool, u64);

#[derive(Debug, Clone)]
pub enum GuiMsg {
    Connecting(String),
    Connected {
        label: String,
    },
    Disconnected(String),
    /// ANSI-stripped terminal output chunk.
    TermOut(String),
    /// Remote shell exit status.
    TermExit(i32),
    SftpCwd(String),
    SftpListing(Vec<Entry>),
    Transfer {
        label: String,
        done: u64,
        total: u64,
        finished: bool,
    },
    Error(String),
}

//! bvrs-gui — egui front-end over the bvrs library: the BvSsh.exe-shaped
//! client (connection bar, Terminal tab, SFTP tab, status bar).
//!
//! Demo/test mode: `bvrs-gui --dest=user@host:port [--pw=password]`
//! auto-connects at startup (e.g. against `cargo run -p bvrs --example
//! mock-sshd`).

mod ansi;
mod gui_msg;
mod net;
mod net_cmd;

use std::sync::mpsc::Receiver;

use eframe::egui;
use egui::{Color32, Layout, RichText, ScrollArea, TextEdit};
use gui_msg::GuiMsg;
use net_cmd::NetCmd;
use tokio::sync::mpsc::Sender as TkSender;

const TERM_MAX: usize = 128 * 1024;

fn main() -> Result<(), eframe::Error> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| {
        args.iter()
            .find_map(|a| a.strip_prefix(name))
            .map(str::to_owned)
    };

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1020.0, 680.0])
            .with_title("bvrs — Bitvise-style SSH client"),
        ..Default::default()
    };

    eframe::run_native(
        "bvrs",
        options,
        Box::new(move |cc| {
            Ok(Box::new(App::new(
                cc,
                get("--dest="),
                get("--pw="),
                get("--key="),
            )))
        }),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Terminal,
    Sftp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Status {
    Idle,
    Connecting(String),
    Connected(String),
    Disconnected(String),
}

struct App {
    net: TkSender<NetCmd>,
    rx: Receiver<GuiMsg>,
    // Login form
    host: String,
    port: String,
    user: String,
    password: String,
    keyfile: String,
    strict: bool,
    // Runtime
    status: Status,
    tab: Tab,
    term: String,
    term_input: String,
    term_exit: Option<i32>,
    sftp_cwd: String,
    sftp_entries: Vec<gui_msg::Entry>,
    sftp_selected: Option<String>,
    local_cwd: String,
    local_entries: Vec<gui_msg::Entry>,
    local_selected: Option<String>,
    transfer: Option<(String, f32)>,
}

impl App {
    fn new(
        _cc: &eframe::CreationContext<'_>,
        dest: Option<String>,
        pw: Option<String>,
        key: Option<String>,
    ) -> Self {
        _cc.egui_ctx.set_visuals(egui::Visuals::dark());
        let (net, rx) = net::spawn(_cc.egui_ctx.clone());

        let (host, port, user) = match &dest {
            Some(d) => match bvrs::dest::Destination::parse(d) {
                Ok(parsed) => (
                    parsed.host,
                    parsed.port.map(|p| p.to_string()).unwrap_or_default(),
                    parsed.user,
                ),
                Err(_) => (d.clone(), String::new(), String::new()),
            },
            None => (String::new(), String::new(), String::new()),
        };
        let app = Self {
            net,
            rx,
            host,
            port,
            user,
            password: pw.unwrap_or_default(),
            keyfile: key.unwrap_or_default(),
            strict: false,
            status: Status::Idle,
            tab: Tab::Terminal,
            term: String::new(),
            term_input: String::new(),
            term_exit: None,
            sftp_cwd: String::new(),
            sftp_entries: Vec::new(),
            sftp_selected: None,
            local_cwd: std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
            local_entries: Vec::new(),
            local_selected: None,
            transfer: None,
        };

        if dest.is_some() {
            app.connect();
        }
        app
    }

    fn connected(&self) -> bool {
        matches!(self.status, Status::Connected(_))
    }

    fn connect(&self) {
        let dest = if self.port.is_empty() {
            format!("{}@{}", self.user, self.host)
        } else {
            format!("{}@{}:{}", self.user, self.host, self.port)
        };
        let _ = self.net.blocking_send(NetCmd::Connect {
            dest,
            password: (!self.password.is_empty()).then(|| self.password.clone()),
            keyfile: (!self.keyfile.is_empty()).then(|| self.keyfile.clone()),
            strict: self.strict,
        });
    }

    fn drain(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            match msg {
                GuiMsg::Connecting(dest) => self.status = Status::Connecting(dest),
                GuiMsg::Connected { label } => {
                    self.status = Status::Connected(label);
                    self.refresh_local();
                    let _ = self.net.blocking_send(NetCmd::SftpList(String::new()));
                }
                GuiMsg::Disconnected(reason) => {
                    self.status = Status::Disconnected(reason);
                    self.sftp_entries.clear();
                    self.sftp_cwd.clear();
                }
                GuiMsg::TermOut(text) => {
                    self.term.push_str(&text);
                    if self.term.len() > TERM_MAX {
                        let cut = self.term.len() - TERM_MAX;
                        let boundary = self.term[cut..]
                            .find('\n')
                            .map(|i| cut + i + 1)
                            .unwrap_or(self.term.len());
                        self.term.drain(..boundary);
                    }
                }
                GuiMsg::TermExit(code) => self.term_exit = Some(code),
                GuiMsg::SftpCwd(cwd) => self.sftp_cwd = cwd,
                GuiMsg::SftpListing(entries) => self.sftp_entries = entries,
                GuiMsg::Transfer {
                    label,
                    done,
                    total,
                    finished,
                } => {
                    self.transfer = if finished {
                        None
                    } else {
                        let frac = if total > 0 {
                            done as f32 / total as f32
                        } else {
                            0.0
                        };
                        Some((format!("{label} {} / {}", human(done), human(total)), frac))
                    };
                }
                GuiMsg::Error(e) => {
                    self.term.push_str(&format!("\r\n[bvrs] {e}\r\n"));
                }
            }
        }
    }

    fn refresh_local(&mut self) {
        let Ok(path) = std::fs::canonicalize(&self.local_cwd) else {
            return;
        };
        self.local_cwd = path.display().to_string();
        let mut entries: Vec<gui_msg::Entry> = std::fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| {
                let md = e.metadata().ok();
                (
                    e.file_name().to_string_lossy().into_owned(),
                    md.as_ref().is_some_and(|m| m.is_dir()),
                    md.map(|m| m.len()).unwrap_or(0),
                )
            })
            .collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        self.local_entries = entries;
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain();

        egui::TopBottomPanel::top("connection").show(ctx, |ui| {
            ui.add_space(4.0);
            egui::Grid::new("login").num_columns(7).show(ui, |ui| {
                ui.label("Host:");
                ui.text_edit_singleline(&mut self.host);
                ui.label("Port:");
                ui.text_edit_singleline(&mut self.port);
                ui.label("User:");
                ui.text_edit_singleline(&mut self.user);
                ui.end_row();

                ui.label("Password:");
                ui.add(TextEdit::singleline(&mut self.password).password(true));
                ui.label("Key file:");
                ui.with_layout(Layout::left_to_right(egui::Align::Center), |ui| {
                    ui.add(
                        TextEdit::singleline(&mut self.keyfile).hint_text("optional OpenSSH key"),
                    );
                });
                ui.end_row();
            });
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.strict, "strict host key");
                if self.connected() {
                    if ui.button("Disconnect").clicked() {
                        let _ = self.net.blocking_send(NetCmd::Disconnect);
                    }
                } else if ui
                    .add_enabled(
                        !self.host.is_empty() && !self.user.is_empty(),
                        egui::Button::new("Login"),
                    )
                    .clicked()
                {
                    self.connect();
                }
            });
            ui.add_space(4.0);
        });

        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            ui.horizontal(|ui| {
                let (text, color) = match &self.status {
                    Status::Idle => ("not connected".to_owned(), Color32::GRAY),
                    Status::Connecting(d) => (format!("connecting to {d}…"), Color32::YELLOW),
                    Status::Connected(l) => (l.clone(), Color32::LIGHT_GREEN),
                    Status::Disconnected(r) => (format!("disconnected ({r})"), Color32::RED),
                };
                ui.colored_label(color, text);
                if let Some((label, frac)) = &self.transfer {
                    ui.separator();
                    ui.label(label);
                    ui.add(egui::ProgressBar::new(*frac).show_percentage());
                }
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.tab, Tab::Terminal, "Terminal");
                ui.selectable_value(&mut self.tab, Tab::Sftp, "SFTP");
                ui.separator();
                if let Some(code) = self.term_exit {
                    ui.label(RichText::new(format!("exit code: {code}")).weak());
                }
            });
            ui.separator();

            match self.tab {
                Tab::Terminal => self.term_view(ui),
                Tab::Sftp => self.sftp_view(ui),
            }
        });

        ctx.request_repaint_after(std::time::Duration::from_millis(250));
    }
}

impl App {
    fn term_view(&mut self, ui: &mut egui::Ui) {
        egui::Frame::dark_canvas(ui.style())
            .inner_margin(egui::Margin::same(8))
            .show(ui, |ui| {
                ScrollArea::vertical()
                    .stick_to_bottom(true)
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        let mut view = self.term.clone();
                        ui.add(
                            TextEdit::multiline(&mut view)
                                .font(egui::TextStyle::Monospace)
                                .desired_width(f32::INFINITY)
                                .desired_rows(22)
                                .interactive(false),
                        );
                    });
            });

        ui.horizontal(|ui| {
            let enabled = self.connected();
            let hint = if enabled {
                "type a command, Enter to send — '~.' on an empty line disconnects"
            } else {
                "not connected"
            };
            let response = ui.add_enabled(
                enabled,
                TextEdit::singleline(&mut self.term_input)
                    .hint_text(hint)
                    .font(egui::TextStyle::Monospace)
                    .desired_width(f32::INFINITY),
            );
            if response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && enabled {
                let mut line = std::mem::take(&mut self.term_input);
                line.push('\n');
                let _ = self.net.blocking_send(NetCmd::TermInput(line.into_bytes()));
                response.request_focus();
            }
        });
    }

    fn sftp_view(&mut self, ui: &mut egui::Ui) {
        if !self.connected() {
            ui.label("Connect first (Login).");
            return;
        }
        ui.columns(2, |columns| {
            Self::local_panel(&mut columns[0], self);
            Self::remote_panel(&mut columns[1], self);
        });
    }

    fn local_panel(ui: &mut egui::Ui, app: &mut App) {
        egui::Frame::group(ui.style())
            .inner_margin(egui::Margin::same(6))
            .show(ui, |ui| {
                ui.label(RichText::new("Local").strong());
                ui.horizontal(|ui| {
                    if ui.button("↰ up").clicked()
                        && let Some(parent) = std::path::Path::new(&app.local_cwd).parent()
                    {
                        app.local_cwd = parent.display().to_string();
                        app.refresh_local();
                    }
                    if ui.button("refresh").clicked() {
                        app.refresh_local();
                    }
                });
                ui.monospace(&app.local_cwd);
                ui.separator();
                ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
                    for (name, is_dir, size) in &app.local_entries {
                        let selected = app.local_selected.as_deref() == Some(name.as_str());
                        let label = if *is_dir {
                            format!("[DIR]  {name}")
                        } else {
                            format!("{:>9}  {name}", human(*size))
                        };
                        if ui
                            .selectable_label(selected, RichText::new(label).monospace())
                            .clicked()
                            && !*is_dir
                        {
                            app.local_selected = Some(name.clone());
                        }
                    }
                });
                ui.with_layout(Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add_enabled(app.local_selected.is_some(), egui::Button::new("Upload →"))
                        .clicked()
                        && let (Some(name), remote) =
                            (app.local_selected.clone(), app.sftp_cwd.clone())
                    {
                        let local =
                            format!("{}/{}", app.local_cwd.trim_end_matches(['\\', '/']), name);
                        let _ = app.net.blocking_send(NetCmd::SftpUpload {
                            local,
                            remote_dir: remote,
                        });
                    }
                });
            });
    }

    fn remote_panel(ui: &mut egui::Ui, app: &mut App) {
        egui::Frame::group(ui.style())
            .inner_margin(egui::Margin::same(6))
            .show(ui, |ui| {
                ui.label(RichText::new("Remote (SFTP)").strong());
                ui.horizontal(|ui| {
                    if ui.button("↰ up").clicked() {
                        let _ = app.net.blocking_send(NetCmd::SftpList("..".to_owned()));
                    }
                    if ui.button("refresh").clicked() {
                        let _ = app.net.blocking_send(NetCmd::SftpList(String::new()));
                    }
                });
                ui.monospace(&app.sftp_cwd);
                ui.separator();
                ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
                    for (name, is_dir, size) in &app.sftp_entries {
                        let selected = app.sftp_selected.as_deref() == Some(name.as_str());
                        let label = if *is_dir {
                            format!("[DIR]  {name}")
                        } else {
                            format!("{:>9}  {name}", human(*size))
                        };
                        if ui
                            .selectable_label(selected, RichText::new(label).monospace())
                            .clicked()
                        {
                            if *is_dir {
                                let _ = app.net.blocking_send(NetCmd::SftpList(name.clone()));
                            } else {
                                app.sftp_selected = Some(name.clone());
                            }
                        }
                    }
                });
                ui.with_layout(Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add_enabled(app.sftp_selected.is_some(), egui::Button::new("← Download"))
                        .clicked()
                        && let (Some(name), cwd) =
                            (app.sftp_selected.clone(), app.local_cwd.clone())
                    {
                        let remote = format!("{}/{}", app.sftp_cwd.trim_end_matches('/'), name);
                        let _ = app.net.blocking_send(NetCmd::SftpDownload {
                            remote_path: remote,
                            local_dir: cwd,
                        });
                    }
                });
            });
    }
}

fn human(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

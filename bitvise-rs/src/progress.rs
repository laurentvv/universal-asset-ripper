//! Transfer progress rendering for SFTP get/put.

use std::io::IsTerminal;
use std::time::Instant;

/// Renders a single-line progress report on stderr (TTY only).
pub struct Progress {
    total: u64,
    done: u64,
    start: Instant,
    enabled: bool,
    last_render: Option<Instant>,
}

impl Progress {
    pub fn new(total: u64) -> Self {
        Self {
            total,
            done: 0,
            start: Instant::now(),
            enabled: std::io::stderr().is_terminal(),
            last_render: None,
        }
    }

    pub fn advance(&mut self, n: u64) {
        self.done += n;
        let now = Instant::now();
        let due = self
            .last_render
            .is_none_or(|t| now.duration_since(t).as_millis() > 100);
        if self.enabled && due {
            self.last_render = Some(now);
            eprint!("\r{}", self.render());
        }
    }

    pub fn finish(&mut self) {
        if self.enabled {
            eprintln!("\r{}", self.render());
        }
    }

    fn render(&self) -> String {
        let pct = if self.total > 0 {
            (self.done as f64 / self.total as f64 * 100.0).min(100.0)
        } else {
            0.0
        };
        let elapsed = self.start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            self.done as f64 / elapsed
        } else {
            0.0
        };
        format!(
            "  {:>10} / {:<10} bytes {:>5.1}%  {:>9}/s",
            self.done,
            if self.total > 0 {
                self.total.to_string()
            } else {
                "?".to_owned()
            },
            pct,
            human_bytes(speed),
        )
    }
}

fn human_bytes(n: f64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = n;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{value:.0} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

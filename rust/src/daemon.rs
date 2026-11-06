//! Droid CLI daemon lifecycle.
//!
//! The app spawns the vendor CLI in IPC daemon mode and waits for the ready
//! message the vendor lifecycle expects. The CLI binary is never bundled; the
//! caller supplies a verified path.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

pub const READY_TYPE: &str = "factory.daemon.ready";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonEvent {
    Ready,
    Other(String),
}

/// Classify one line of daemon output.
///
/// The vendor emits one JSON object per line. Only the `type` field matters
/// here; a line that is not a JSON object with a string `type` is `Other`.
pub fn parse_event(line: &str) -> DaemonEvent {
    let trimmed = line.trim();
    if let Some(kind) = json_string_field(trimmed, "type") {
        if kind == READY_TYPE {
            return DaemonEvent::Ready;
        }
        return DaemonEvent::Other(kind);
    }
    DaemonEvent::Other(trimmed.to_string())
}

/// Extract a top-level string field from a JSON object.
///
/// The daemon's messages are flat, so a full JSON parser would be a
/// dependency for one field. Only depth-zero keys count, so a nested
/// `type` never matches.
fn json_string_field(source: &str, field: &str) -> Option<String> {
    let body = source.strip_prefix('{')?.strip_suffix('}')?;
    let bytes = body.as_bytes();
    let mut index = 0;
    let mut depth = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => {
                depth += 1;
                index += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                index += 1;
            }
            b'"' => {
                let (key, next) = read_string(body, index)?;
                index = next;
                if depth != 0 || key != field {
                    continue;
                }
                let rest = body[index..].trim_start();
                let rest = rest.strip_prefix(':')?.trim_start();
                if !rest.starts_with('"') {
                    return None;
                }
                let offset = body.len() - rest.len();
                let (value, _) = read_string(body, offset)?;
                return Some(value);
            }
            _ => index += 1,
        }
    }
    None
}

/// Read a JSON string starting at the opening quote; return it and the index
/// just past the closing quote.
fn read_string(source: &str, start: usize) -> Option<(String, usize)> {
    let bytes = source.as_bytes();
    let mut index = start + 1;
    let mut value = String::new();
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => {
                index += 2;
            }
            b'"' => return Some((value, index + 1)),
            _ => {
                let ch = source[index..].chars().next()?;
                value.push(ch);
                index += ch.len_utf8();
            }
        }
    }
    None
}

pub struct Daemon {
    child: Child,
    pub home: PathBuf,
}

impl Daemon {
    /// Spawn the CLI in daemon mode under an isolated home.
    pub fn spawn(binary: &Path, home: &Path) -> std::io::Result<Self> {
        let child = Command::new(binary)
            .arg("daemon")
            .env("FACTORY_HOME_OVERRIDE", home)
            .env("HOME", home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Self {
            child,
            home: home.to_path_buf(),
        })
    }

    /// Block until the ready message arrives or the stream ends.
    pub fn wait_ready(&mut self) -> std::io::Result<bool> {
        let Some(stdout) = self.child.stdout.take() else {
            return Ok(false);
        };
        for line in BufReader::new(stdout).lines() {
            let line = line?;
            if parse_event(&line) == DaemonEvent::Ready {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Ask the daemon to stop and reap it.
    pub fn shutdown(mut self) -> std::io::Result<std::process::ExitStatus> {
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        self.child.wait()
    }
}

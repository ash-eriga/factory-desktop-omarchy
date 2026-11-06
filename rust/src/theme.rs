//! Read-only reader for Omarchy's active palette.
//!
//! Mirrors `runtime/theme-bridge.cjs`: a data-only subset of `colors.toml`,
//! the `theme.generation` marker, and the window-mode toggle files. It never
//! executes Lua and never writes anything.

use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const MAX_COLORS_BYTES: u64 = 16 * 1024;
const MAX_GENERATION_BYTES: u64 = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Light,
    Dark,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub fn from_hex(value: &str) -> Option<Self> {
        let hex = value.strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        Some(Self {
            r: u8::from_str_radix(&hex[0..2], 16).ok()?,
            g: u8::from_str_radix(&hex[2..4], 16).ok()?,
            b: u8::from_str_radix(&hex[4..6], 16).ok()?,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub mode: Mode,
    pub background: Rgb,
    pub foreground: Rgb,
    pub accent: Rgb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowMode {
    Opaque,
    Glassy,
    Transparent,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub palette: Option<Palette>,
    pub revision: Option<String>,
    pub window_mode: Option<WindowMode>,
    /// True when the read landed mid-switch and a retry may succeed.
    pub transient: bool,
}

impl Snapshot {
    pub fn available(&self) -> bool {
        self.palette.is_some()
    }
}

/// Parse the top-level keys of an Omarchy `colors.toml`.
///
/// Keys inside a `[table]` are ignored, a repeated key is rejected, and the
/// three colors must be `#rrggbb`. Anything else yields `None`, so a partial
/// or malformed palette never reaches the window.
pub fn parse_colors_toml(source: &str) -> Option<Palette> {
    if source.len() as u64 > MAX_COLORS_BYTES {
        return None;
    }

    let mut mode = None;
    let mut background = None;
    let mut foreground = None;
    let mut accent = None;
    let mut in_table = false;

    for line in source.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim_start().starts_with('[') {
            in_table = true;
            continue;
        }
        if in_table {
            continue;
        }
        let Some((key, value)) = parse_assignment(line) else {
            continue;
        };
        let slot = match key {
            "mode" => &mut mode,
            "background" => &mut background,
            "foreground" => &mut foreground,
            "accent" => &mut accent,
            _ => continue,
        };
        if slot.is_some() {
            return None;
        }
        *slot = Some(value);
    }

    let mode = match mode?.as_str() {
        "light" => Mode::Light,
        "dark" => Mode::Dark,
        _ => return None,
    };
    Some(Palette {
        mode,
        background: Rgb::from_hex(&background?)?,
        foreground: Rgb::from_hex(&foreground?)?,
        accent: Rgb::from_hex(&accent?)?,
    })
}

/// Match `key = "value"` with an optional trailing comment.
fn parse_assignment(line: &str) -> Option<(&str, String)> {
    let (key, rest) = line.split_once('=')?;
    let key = key.trim();
    if !matches!(key, "mode" | "background" | "foreground" | "accent") {
        return None;
    }
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let value = &rest[..end];
    if value.contains('\\') || value.contains('\r') || value.contains('\n') {
        return None;
    }
    let tail = rest[end + 1..].trim();
    if !tail.is_empty() && !tail.starts_with('#') {
        return None;
    }
    Some((key, value.to_string()))
}

fn is_real_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn is_directory(path: &Path) -> bool {
    std::fs::metadata(path).map(|meta| meta.is_dir()).unwrap_or(false)
}

/// Read a regular file without following a symlink and without blocking on a
/// FIFO. Returns `None` for anything that is not a bounded regular file.
fn read_regular_file(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > max_bytes {
        return None;
    }
    let mut buffer = Vec::with_capacity(meta.len() as usize);
    file.by_ref().take(max_bytes + 1).read_to_end(&mut buffer).ok()?;
    if buffer.len() as u64 > max_bytes {
        return None;
    }
    String::from_utf8(buffer).ok()
}

fn valid_generation(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn toggle_state(path: &Path) -> ToggleState {
    match std::fs::symlink_metadata(path) {
        Err(_) => ToggleState::Absent,
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => ToggleState::Unsafe,
        Ok(_) => ToggleState::Present,
    }
}

enum ToggleState {
    Absent,
    Present,
    Unsafe,
}

fn read_window_mode(state_root: &Path) -> Option<WindowMode> {
    let toggles = state_root.join("omarchy").join("toggles").join("hypr");
    for dir in [
        state_root.to_path_buf(),
        state_root.join("omarchy"),
        state_root.join("omarchy").join("toggles"),
        toggles.clone(),
    ] {
        match std::fs::symlink_metadata(&dir) {
            Err(_) => return Some(WindowMode::Transparent),
            Ok(meta) if !meta.is_dir() || meta.file_type().is_symlink() => return None,
            Ok(_) => {}
        }
    }
    match toggle_state(&toggles.join("window-opaque.lua")) {
        ToggleState::Present => return Some(WindowMode::Opaque),
        ToggleState::Unsafe => return None,
        ToggleState::Absent => {}
    }
    match toggle_state(&toggles.join("window-glassy.lua")) {
        ToggleState::Present => Some(WindowMode::Glassy),
        ToggleState::Unsafe => None,
        ToggleState::Absent => Some(WindowMode::Transparent),
    }
}

/// Read the current Omarchy snapshot for `home`.
///
/// `state_home` overrides the toggles root only; the palette always comes
/// from `home`. An invalid override fails the window mode closed.
pub fn read_snapshot(home: &Path, state_home: Option<&Path>) -> Snapshot {
    let unavailable = |transient| Snapshot {
        transient,
        ..Snapshot::default()
    };

    if !home.is_absolute() {
        return unavailable(false);
    }
    let state = home.join(".local").join("state");
    let omarchy = state.join("omarchy");
    let current = omarchy.join("current");
    let theme = current.join("theme");
    let colors = theme.join("colors.toml");
    let generation = current.join("theme.generation");

    if !is_directory(home)
        || !is_directory(&home.join(".local"))
        || !is_directory(&state)
        || !is_directory(&omarchy)
        || !is_real_directory(&current)
    {
        return unavailable(false);
    }

    let Some(before) = read_regular_file(&generation, MAX_GENERATION_BYTES) else {
        return unavailable(true);
    };
    let before = before.trim().to_string();
    if before.is_empty() {
        return unavailable(true);
    }
    if !valid_generation(&before) {
        return unavailable(false);
    }
    if !is_real_directory(&theme) {
        return unavailable(true);
    }
    let Some(source) = read_regular_file(&colors, MAX_COLORS_BYTES) else {
        return unavailable(true);
    };
    let Some(after) = read_regular_file(&generation, MAX_GENERATION_BYTES) else {
        return unavailable(true);
    };
    if after.trim() != before {
        return unavailable(true);
    }
    let Some(palette) = parse_colors_toml(&source) else {
        return unavailable(false);
    };

    let state_root: Option<PathBuf> = match state_home {
        None => Some(state),
        Some(path) if path.is_absolute() => Some(path.to_path_buf()),
        Some(_) => None,
    };
    Snapshot {
        palette: Some(palette),
        revision: Some(before),
        window_mode: state_root.as_deref().and_then(read_window_mode),
        transient: false,
    }
}

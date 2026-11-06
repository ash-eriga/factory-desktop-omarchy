use std::fs;
use std::path::PathBuf;

use factory_droid_desktop::theme::{
    parse_colors_toml, read_snapshot, Mode, Rgb, WindowMode,
};

const VALID: &str = r##"
mode = "dark"
background = "#101019"
foreground = "#E4E4EF"
accent = "#7aa2f7"
"##;

#[test]
fn parses_a_valid_palette() {
    let palette = parse_colors_toml(VALID).expect("valid palette");
    assert_eq!(palette.mode, Mode::Dark);
    assert_eq!(palette.background, Rgb { r: 0x10, g: 0x10, b: 0x19 });
    assert_eq!(palette.foreground, Rgb { r: 0xe4, g: 0xe4, b: 0xef });
    assert_eq!(palette.accent, Rgb { r: 0x7a, g: 0xa2, b: 0xf7 });
}

#[test]
fn ignores_keys_inside_a_table() {
    let source = format!("{VALID}\n[extra]\nbackground = \"#000000\"\n");
    let palette = parse_colors_toml(&source).expect("table keys are ignored");
    assert_eq!(palette.background, Rgb { r: 0x10, g: 0x10, b: 0x19 });
}

#[test]
fn rejects_a_repeated_key() {
    let source = format!("{VALID}\naccent = \"#ffffff\"\n");
    assert!(parse_colors_toml(&source).is_none());
}

#[test]
fn rejects_a_malformed_color() {
    let source = VALID.replace("#7aa2f7", "#7aa2f");
    assert!(parse_colors_toml(&source).is_none());
}

#[test]
fn rejects_an_unknown_mode() {
    let source = VALID.replace("\"dark\"", "\"dim\"");
    assert!(parse_colors_toml(&source).is_none());
}

fn fixture(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("factory-theme-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let theme = root.join(".local/state/omarchy/current/theme");
    fs::create_dir_all(&theme).expect("create fixture");
    fs::write(theme.join("colors.toml"), VALID).expect("write colors");
    fs::write(
        root.join(".local/state/omarchy/current/theme.generation"),
        "gen-42\n",
    )
    .expect("write generation");
    root
}

#[test]
fn reads_a_snapshot_with_the_revision() {
    let root = fixture("snapshot");
    let snapshot = read_snapshot(&root, None);
    assert!(snapshot.available());
    assert_eq!(snapshot.revision.as_deref(), Some("gen-42"));
    assert_eq!(snapshot.window_mode, Some(WindowMode::Transparent));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn reports_unavailable_without_a_generation_marker() {
    let root = fixture("no-generation");
    fs::remove_file(root.join(".local/state/omarchy/current/theme.generation"))
        .expect("remove marker");
    let snapshot = read_snapshot(&root, None);
    assert!(!snapshot.available());
    assert!(snapshot.transient);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn reads_the_opaque_toggle() {
    let root = fixture("opaque");
    let toggles = root.join(".local/state/omarchy/toggles/hypr");
    fs::create_dir_all(&toggles).expect("create toggles");
    fs::write(toggles.join("window-opaque.lua"), "").expect("write toggle");
    let snapshot = read_snapshot(&root, None);
    assert_eq!(snapshot.window_mode, Some(WindowMode::Opaque));
    let _ = fs::remove_dir_all(&root);
}

use std::path::PathBuf;

use factory_droid_desktop::theme::{read_snapshot, Mode, Palette, Rgb};
use factory_droid_desktop::ui::SignedOut;
use gpui::{
    App, AppContext, Application, Bounds, WindowBounds, WindowOptions, px, size,
};

/// Fallback palette when Omarchy is not present, matching the port's
/// signed-out light shell.
const FALLBACK: Palette = Palette {
    mode: Mode::Light,
    background: Rgb { r: 0xff, g: 0xff, b: 0xff },
    foreground: Rgb { r: 0x1a, g: 0x1a, b: 0x1a },
    accent: Rgb { r: 0x2f, g: 0x6f, b: 0xed },
};

fn main() {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let snapshot = home
        .as_deref()
        .map(|home| read_snapshot(home, None))
        .unwrap_or_default();
    let palette = snapshot.palette.unwrap_or(FALLBACK);
    let status = if snapshot.available() {
        format!(
            "Omarchy theme {}",
            snapshot.revision.as_deref().unwrap_or("current")
        )
    } else {
        "Omarchy theme unavailable".to_string()
    };

    Application::new().run(move |cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(900.0), px(600.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            move |_, cx| cx.new(|_| SignedOut::new(palette, status.clone())),
        )
        .expect("open the signed-out window");
        cx.activate(true);
    });
}

//! Signed-out window.

use gpui::{
    div, prelude::*, rgb, Context, IntoElement, Render, SharedString, Window,
};

use crate::theme::{Mode, Palette, Rgb};

pub struct SignedOut {
    palette: Palette,
    status: SharedString,
}

impl SignedOut {
    pub fn new(palette: Palette, status: impl Into<SharedString>) -> Self {
        Self {
            palette,
            status: status.into(),
        }
    }
}

fn color(value: Rgb) -> gpui::Rgba {
    rgb(((value.r as u32) << 16) | ((value.g as u32) << 8) | value.b as u32)
}

impl Render for SignedOut {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let palette = self.palette;
        let muted = match palette.mode {
            Mode::Dark => 0x9a9aa5,
            Mode::Light => 0x5a5a66,
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .justify_center()
            .items_center()
            .gap_4()
            .bg(color(palette.background))
            .text_color(color(palette.foreground))
            .child(div().text_2xl().child("Factory Droid Desktop"))
            .child(
                div()
                    .text_sm()
                    .text_color(rgb(muted))
                    .child("Sign in to continue"),
            )
            .child(
                div()
                    .flex()
                    .gap_2()
                    .child(button("Sign up", palette))
                    .child(button("Log in", palette))
                    .child(button("Sign in to Factory Private", palette)),
            )
            .child(div().text_xs().text_color(rgb(muted)).child(self.status.clone()))
    }
}

fn button(label: &'static str, palette: Palette) -> impl IntoElement {
    div()
        .px_4()
        .py_2()
        .rounded_md()
        .bg(color(palette.accent))
        .text_color(color(palette.background))
        .child(label)
}

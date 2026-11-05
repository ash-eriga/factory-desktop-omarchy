# Feature verification map

One file per user-facing feature of the port, from the user's point of view.
Each file answers: what the feature is, how to reach it, how to drive it with
the harness, and what observable end state proves it works. Drive order for a
full pass: `launch-signed-out-window.md` first (everything else needs a
launching app), then any of the others.

Covered here (unauthenticated scope only; the authenticated relay, billing
display, and sign-in are Layer 4 manual checks per `docs/validation.md`):

1. [Launch: signed-out window](launch-signed-out-window.md)
2. [Droid daemon over IPC](droid-daemon-ipc.md)
3. [Omarchy theme follow](omarchy-theme-follow.md)
4. [Appearance menu layout](appearance-menu-layout.md)
5. [Startup performance profile](startup-performance-profile.md)

Shared gotchas live in the parent `SKILL.md` (Playwright ESM shim, Arch build
gate, Xvfb on headless hosts).

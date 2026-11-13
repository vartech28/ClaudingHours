# ClaudingHours

A small macOS menu bar app for tracking how long you spend in AI coding sessions with Claude Code.

Start a timer when you sit down to work, label the session, and ClaudingHours keeps a log, a daily goal, a weekly chart and your streak. The running time shows live in the menu bar. If Claude Code stops running for 5 minutes, the timer pauses itself, so forgotten timers don't pad your hours.

> **macOS only.** ClaudingHours is built for and tested on macOS (12 Monterey or later). It does not support Windows or Linux, and there are no plans to.

## Features

- **Menu bar timer.** Lives in the menu bar with no Dock icon. The elapsed time updates live in the menu bar.
- **Start, pause, resume, end.** Each session gets a label and optional notes.
- **Auto-pause.** If the `claude` process is absent for 5 minutes while the timer runs, the timer pauses and you get a macOS notification. When Claude Code comes back, the app prompts you to resume. It never resumes on its own.
- **Crash-safe sessions.** An in-progress session is saved as a draft and restored (paused) if the app quits or crashes.
- **Daily goal.** Set a goal in hours and track progress with a bar.
- **Session log.** View past sessions, see a weekly chart and your day streak, and export everything to CSV.
- **Fullscreen timer.** A large floating timer window that can go fullscreen.
- **Launch at Login.** Toggle from the menu bar icon's right-click menu.

## Keyboard shortcuts

**Global (work from any app)**

| Shortcut | Action |
|---|---|
| `⌘ ⌥ C` | Show / hide the ClaudingHours window |
| `⌘ ⌥ S` | Start / pause the timer |
| `⌘ ⌥ R` | Re-centre the window on the screen under your cursor (if it ends up off-screen) |

**In the timer window** (when you're not typing in a field)

| Key | Action |
|---|---|
| `Space` | Start / pause / resume |
| `E` | End the session |
| `N` | Jump to the label field |
| `Esc` | Leave the current field |

**In the fullscreen timer**

| Key | Action |
|---|---|
| `Esc` | Exit fullscreen; press again to close the timer window |

**Menu bar icon:** left-click toggles the window; right-click shows **Launch at Login** and **Quit**.

## Install (build from source)

There is no pre-built download. You build the app yourself, which takes a few minutes the first time.

### Requirements

- macOS 12 or later (Apple Silicon or Intel)
- Xcode Command Line Tools: `xcode-select --install`
- Rust: install from [rustup.rs](https://rustup.rs)
- Node.js 18 or later

### Build

Clone this repository, or download it with **Code → Download ZIP** and unzip it. Then, in Terminal, inside the project folder:

```bash
npm install
npm run build
```

The finished app is at `src-tauri/target/release/bundle/macos/ClaudingHours.app`, and a disk image is in `src-tauri/target/release/bundle/dmg/`. Copy the app to your Applications folder:

```bash
cp -R src-tauri/target/release/bundle/macos/ClaudingHours.app /Applications/
open /Applications/ClaudingHours.app
```

The first time a notification fires, macOS asks whether ClaudingHours may send notifications. Allow it if you want auto-pause alerts.

### Development mode

```bash
npm run dev
```

This runs the app with live reload for the HTML/CSS/JS, and recompiles the Rust side when it changes.

## Where your data lives

Everything stays on your Mac. The app makes no network requests and has no accounts or analytics.

| File | Contents |
|---|---|
| `~/.clauding-hours/sessions.json` | Your session history |
| `~/.clauding-hours/config.json` | Settings (daily goal) |
| `~/.clauding-hours/draft.json` | The in-progress session; removed when you end or reset it |

To back up your history, copy that folder. To remove all data, delete it.

## Browser mode (optional)

```bash
npm start
```

This runs a small web version at `http://localhost:3333` without the native app. Two things to know:

- It saves to `sessions.json` in the project folder, **not** to `~/.clauding-hours/`, so its data is separate from the app's.
- It listens on all network interfaces, so other devices on your network can reach it at `http://<your-mac-ip>:3333`. Only use it on a network you trust.

## How auto-pause works

A background thread checks every 10 seconds whether a process named exactly `claude` is running (`pgrep -x claude`). After 5 minutes without it, the timer pauses. If you start Claude Code through a wrapper or alias with a different process name, auto-pause will treat it as not running. You can change the check in `is_claude_running()` in `src-tauri/src/lib.rs`.

## Built with

- [Tauri 2](https://tauri.app) (Rust backend, native macOS WebView)
- Plain HTML, CSS and JavaScript, with no framework or bundler
- Express, for the optional browser mode only

## Reporting a security issue

Please don't open a public issue for security problems. Use the repository's **Security → Report a vulnerability** form instead.

## Disclaimer

ClaudingHours is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## Licence

This repository does not have an open-source licence. All rights reserved.

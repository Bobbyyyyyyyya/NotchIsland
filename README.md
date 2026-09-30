# Notch Island

A macOS Dynamic Island for the MacBook camera housing: a media player, sound and
microphone control, Bluetooth accessories, clipboard history and system status —
all in the notch, with F7–F12 working the way they do on Apple hardware.

## What it does

**Compact island** — small widgets sit in two arms that hug the camera housing
(there is no screen inside the notch, so nothing is drawn or clicked there):

| Widget | Shows |
| --- | --- |
| Music | artwork and progress while something is playing |
| Bluetooth | battery of connected AirPods, Magic Mouse, Keyboard or Trackpad |
| Volume | level, or `Mute` when muted |
| Mic | `Live` while an app is recording, `Off` when muted |
| Battery | percentage, a bolt while charging, red below 20 % |
| Meeting | red pulse while a microphone is in use |
| Clipboard | the snippet you just copied |
| Clock | time |
| CPU | load |

The island grows with the number of widgets, up to 560 pt; only when even that
is not enough are widgets dropped from the outside in, the way the real island
throws away detail to stay the size it is. Resting the pointer on it makes it
swell a little, and a volume or microphone change gives it the same squash the
system volume HUD does.

Everything in the island is drawn with inline SVG icons — there are no emoji or
system glyphs anywhere, so it keeps one look on every macOS version.

**Live activities** — the island reacts on its own. When something happens it
opens by itself with a small animation, holds for a few seconds and folds back to
the idle pill. Right now it reacts to:

- music starting (artwork plus a progress bar)
- an AirPods or Magic accessory connecting or running low
- an app starting to use the microphone (the red pulse)
- plugging in or unplugging the charger
- the battery filling up, and reaching 100 %
- a countdown timer you start from the island
- a file transfer to an AirDropped device

A Bluetooth widget sits next to the housing and stays put even with nothing
paired, so the island always has something on it. The moment an AirPods, Magic
Mouse or Magic Keyboard connects, the widget gives a little hello — the icon
ripples outward once, the way a device acknowledges a pairing.

Two or more of those at once **split the island into two bubbles** that sit side
by side on either side of the housing, and either one can be **swiped sideways to
dismiss**. A **long press** on the island slides up the extra controls: output
device, microphone, Bluetooth, the player, Clipboard and the Settings panel, plus
the timer presets.

**Charging** — as soon as the charger goes in, the battery opens as an activity:
the battery itself fills from the left, tinted from amber through yellow to green
as the level climbs, with a bolt flickering in the middle. The edge of the island
breathes in the same colour. At 100 % the bolt becomes a check, the battery fills
solid green and reads *Fully charged* for a moment before the island folds away.
Unplugging, or the level dropping below full, resets it so the next charge starts
over.

**Transfers** — pick *Show an AirDrop transfer* from the tray menu (or from the
long-press controls) to watch a send play out. The AirDrop logo ripples while a
bar beneath it fills, two dots chasing each other along the bar until they meet;
the bar turns blue, a check settles over the logo and it reads *Sent to…* for a
second before the island folds away. Swipe the island sideways to call it off.
This one is a simulation — macOS has no public feed for AirDrop events, so there
is nothing to watch for. It is driven from the main process (`transfer.start` /
`transfer.cancel`) and is the same path a real sender would use.

The island sizes itself to whatever is on it: the compact pill grows to fit the
widgets or the activity bubbles flanking the housing, and the activity panels open
tall enough for the battery and the AirDrop bar to sit centred, the way the real
island makes room for what it is showing. A chevron in the top-right corner of an
open island folds it back to the pill, the same as dragging it down or tapping it.

**Expanded panels**

- **Player** — artwork, title, artist, scrubber, transport, and the current
  output device. Every app that publishes a now-playing session (Music, Spotify,
  Chrome, …) is controlled through the system media session. When nothing is
  playing the transport keys have nowhere to go, so the panel says so and offers
  to open a player instead of showing three buttons that do nothing.
- **Sound** — output volume slider, mute, and a device list to switch output.
- **Microphone** — input volume, mute, device list, and a live indicator for
  apps that are recording.
- **Bluetooth** — paired accessories with battery level, connect/disconnect.
- **Clipboard** — the last 25 snippets, click to copy one back.
- **Settings** — shape, hover behaviour, media-key claim, widget toggles, live
  hotkey status and system facts.

The panel that opens for an activity has its own controls: pause and cancel for
a timer, disconnect for an accessory, open the microphone or the player for the
rest.

## Hotkeys

| Key | Action |
| --- | --- |
| `F7` / `F8` / `F9` | previous · play/pause · next |
| `F10` / `F11` / `F12` | volume down · up · mute |
| `⌘⌥Space` | expand / collapse the island |
| `⌘⌥C` `⌘⌥V` `⌘⌥M` `⌘⌥P` | clipboard · sound · microphone · player |

Function keys are registered through `globalShortcut`, so they work while any
other app is focused. If macOS hands a key to something else first, the settings
panel shows `unavailable` for that action and the panel falls back to the next
candidate (`⌘`/`⌥` variants, then the system `Media*` keys, which can be claimed
from the settings panel).

## How the notch is found

macOS does not hand out the camera housing through public screen APIs, but
AppKit exposes it indirectly since macOS 12:

```
notchWidth  = frame.width - auxiliaryTopLeftArea.width - auxiliaryTopRightArea.width
notchHeight = safeAreaInsets.top
```

`NSScreen.auxiliaryTopLeftArea` / `auxiliaryTopRightArea` are only present on
displays with a housing, which makes them a reliable presence check. The values
are read in points of the current display mode, so the island follows the
"scaled resolution" setting for free. Electron cannot call AppKit, so the read
happens once through `osascript -l JavaScript` and is cached until the display
layout changes.

## The system bridge

Electron cannot reach CoreAudio or MediaPlayer's remote command centre, so the
app compiles a small Objective-C helper (`tools/helper/NotchHelper.m`) with the
system `clang` on first launch and talks newline-delimited JSON to it over
stdio. The helper provides:

- the system now-playing session and remote commands (play, pause, next,
  previous, seek)
- CoreAudio output/input volume, mute and device enumeration/switching
- which input devices are currently in use
- paired Bluetooth devices plus their HID battery levels and connect state
- the internal battery through IOKit power sources

If the helper cannot be built (no Xcode Command Line Tools), the app still runs:
the island, hotkeys and clipboard keep working and the settings panel says
which part is unavailable.

## Development

```bash
npm install
npm start            # run it
npm run dev          # run it with renderer logging and a frame counter
npm test             # unit tests for the notch maths and the animation
npm run selftest     # notch, hotkeys, system bridge and the drag gesture
npm run dev -- --shot  # write a PNG of every panel to the user data folder
npm run package      # build Notch Island.app and a zip
```

`npm run selftest` prints a checklist and exits non-zero on failure:

```
PASS  notch detected  (220x38 pt)
PASS  Play / pause is F8  (F8)
PASS  system bridge  (ok)
PASS  drag down collapses  (-> 64)
…13/13 checks passed
```

`npm run dev -- --shot` is the fastest way to review the UI; it writes
`compact.png`, `player.png`, `volume.png`, `mic.png`, `bluetooth.png`,
`clipboard.png`, `settings.png` and `state.json` next to the app's preferences.

## Notes and limits

- The island is a click-through overlay: clicks land on the app underneath
  everywhere except on the island itself, and never on the housing.
- Dragging the island down collapses it, dragging up opens it; the transition is
  a spring, the compact widgets dissolve into the panel, and the island pushes
  itself down for a moment whenever its content changes.
- Volume, mute and microphone state are watched rather than assumed: CoreAudio
  has no callback for them, so the bridge samples them and only reports a change,
  which means the volume keys, Control Center and other apps all keep the island
  up to date.
- The app is a menu bar app (`LSUIElement`), so it has no Dock icon; the tray
  icon opens the settings panel.
- Display brightness control is not included: the private CoreGraphics entry
  points Apple used to expose (`IOFFramebufferGetLight`) are gone on current
  macOS, and `F1`/`F2` already work system wide.

## Layout

```
src/main/index.js      app lifecycle, actions, tray, polling
src/main/island.js     overlay window, notch anchoring, spring animation
src/main/notch.js      camera housing detection through AppKit
src/main/hotkeys.js    F7–F12 and the fallback chains
src/main/activities.js live activities: timers, media, mic, Bluetooth, charging
src/main/helper.js     builds and supervises the Objective-C bridge
src/main/prefs.js      persisted preferences
src/renderer/app.js    island state machine, widgets, panels
src/renderer/styles.css
tools/helper/NotchHelper.m
tools/make-icon.js     generates the app and tray icons without dependencies
```

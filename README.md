# Notch Island

A macOS Dynamic Island for the MacBook camera housing: a media player, sound and
microphone control, Bluetooth accessories, clipboard history and system status —
all in the notch, with F7–F12 working the way they do on Apple hardware.

## Install

1. Download `Notch.Island-<version>-arm64.dmg` from the
   [latest GitHub release](https://github.com/Bobbyyyyyyyya/NotchIsland/releases/latest)
   (Apple Silicon; macOS 13.0 or newer).
2. Open it and drag *Notch Island* into *Applications*.
3. On the first launch Gatekeeper may note the developer cannot be verified —
   the build is signed ad hoc and not notarised. Right-click the app and choose
   *Open*, then *Open* again; it starts normally from then on.
4. Nothing else to do: the island appears in the notch at once and lives in the
   tray menu bar for everything else.

The music widgets, volume, battery and microphone are handled by a small system
bridge that ships compiled with the app — nothing to install on your Mac. A
build made without the toolchain present would fall back to compiling the same
bridge on first run with the Xcode Command Line Tools, so older builds may ask
for those once.

## What it does

**Compact island** — small widgets sit in two arms that hug the camera housing
(there is no screen inside the notch, so nothing is drawn or clicked there):

| Widget | Shows |
| --- | --- |
| Music | artwork and progress while something is playing, big or small |
| Bluetooth | battery of connected AirPods, Magic Mouse, Keyboard or Trackpad, and the name of whatever just connected |
| Volume | level, or `Mute` when muted |
| Mic | `Live` while an app is recording, `Off` when muted |
| Battery | percentage, a bolt while charging, red below 20 % |
| Charging | the charger, with the level walking amber to green — take it out and the island stops opening for it too |
| Meeting | red pulse while a microphone is in use |
| Clipboard | the snippet you just copied |
| Clock | the time; clicking it opens the island on a large clock with seconds |
| AirDrop | only while AirDrop's wireless link is up |
| CPU | load |

Every widget in that row is yours to move, add or remove: the row is drawn as two
named sides either side of the housing — *Left* and *Right* — and widgets are dragged
onto the side you want them on, or into a gap between two others to put them
somewhere in the middle. Both sides are always there, so moving something across is
one drag whether or not either side has anything on it yet. The Arrange panel
(`⌘⌥L`) does the same for the quick controls and the order of the Settings
sections.

A side holds **three** widgets and no more. It is a rule rather than a setting: a
row that can grow without end is a row that ends up carrying things nobody looks at,
and the island was already shedding widgets from the outside in once it ran out of
width — so what the arrangement said and what actually fitted would stop agreeing.
The count is in the Arrange panel's title bar, amber as a side fills and red when it
is full, and a full side stops being a place to aim at. What does not fit is in the
palette, one drag away, never deleted. A
widget that can be more than one size — music is — says so with a badge, and a tap
steps it through. A profile is a whole set of those at once, so "office" and
"evening" are one click apart in the tray.

The charger is in that list too, which is the only way to turn it off: take
*Charging* out and the island stops opening for the plug, stops breathing at the
edge, and the row loses the level walking amber to green.

The island grows with the number of widgets, up to 560 pt; only when even that
is not enough are widgets dropped from the outside in, the way the real island
throws away detail to stay the size it is. A greeting from a device that just
connected is the last thing to go, since the row is full because of it. Resting
the pointer on it makes it swell a little, and a volume or microphone change
gives it the same squash the system volume HUD does.

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
- a new version of Notch Island: its progress, and then the restart

An event never takes the row over on its own: the charging ring sits beside the
clock and the player, and it is always a widget that is dropped first when the
island runs out of room — an activity is never the thing that goes.

A Bluetooth widget sits next to the housing and stays put even with nothing
paired, so the island always has something on it. The moment an AirPods, Magic
Mouse or Magic Keyboard connects, the widget gives a little hello — the icon
ripples outward once, the way a device acknowledges a pairing, and the pill
names the device for a couple of seconds. The row makes room for it: it is the
thing that just happened, so it is the last widget the island gives up.

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
This one is a simulation — macOS publishes no feed for AirDrop events, so there
is nothing to watch for. It is driven from the main process (`transfer.start` /
`transfer.cancel`) and is the same path a real sender would use. What the island
*can* see is whether AirDrop's wireless link is up, and when it is, the AirDrop
widget says so: `awdl0` exists whenever AirDrop is switched on, which proves
reachability and nothing more, so no transfer is ever invented out of it.

The island sizes itself to whatever is on it: the compact pill grows to fit the
widgets and the activity bubbles flanking the housing, and the activity panels
open tall enough for the battery and the AirDrop bar to sit centred, the way the
real island makes room for what it is showing. A chevron in the top-right corner of an
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
- **Battery** — the charge level as a big bar, whether it is charging, and how
  long is left. It opens straight from the battery widget.
- **Quick controls** — output, microphone, Bluetooth, player, clipboard,
  settings and the timers, all on one screen: what a long press on the island
  slides up.
- **Clipboard** — the last 25 snippets, click to copy one back.
- **Clock** — the time in large digits with the seconds running along, plus the
  date.
- **Settings** — shape, hover behaviour, media-key claim, update checks, live
  hotkey status and system facts.
- **Arrange** — the editor: what is in the island row, which side of the housing it
  sits on, how big a widget is drawn, whether the charger says anything at all, what
  a long press reaches for, the order of the Settings sections, and the profiles
  these are arranged into.

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
| `⌘⌥L` | arrange the island |

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
app talks to a small Objective-C helper (`tools/helper/NotchHelper.m`) over
newline-delimited JSON on stdio. The helper provides:

- the system now-playing session and remote commands (play, pause, next,
  previous, seek)
- CoreAudio output/input volume, mute and device enumeration/switching
- which input devices are currently in use
- paired Bluetooth devices plus their HID battery levels and connect state
- the internal battery through IOKit power sources

A released build ships the helper and the MediaRemote adapter already compiled
(see `tools/build-native.js`): the machine that made the release has clang, so
the user's Mac needs nothing. When a build was made without the toolchain — or
while developing — the app compiles the same sources with the system `clang` on
first run instead. If even that is not possible (no Xcode Command Line Tools),
the app still runs: the island, hotkeys and clipboard keep working and the
settings panel says which part is unavailable.

## Development

```bash
npm install
npm start            # run it
npm run dev          # run it with renderer logging
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

`npm run dev -- --shot` is the fastest way to review the UI; it writes a PNG of
every state — `compact`, `player`, `volume`, `mic`, `bluetooth`, `battery`,
`clipboard`, `clock`, `settings`, `quick`, the activity states and `state.json` —
next to the app's preferences. `airdrop-live`, `bt-hello` and `compact-bubbles`
stage the cases that are hard to catch on their own: a live AirDrop link, a
device that just connected, and three activities at once.

## Updates

A built copy checks GitHub for a newer release once per launch and downloads it
in the background. The island says so the way it says everything else: a small
pill in the row while the island is folded away, and the full panel the moment
there is something new — a progress bar while it downloads, then *Restart now* and
*Later*. Quitting normally installs it too, so the update is never more than one
restart away. A check that fails or finds nothing stays out of the island; the
settings panel and the tray menu say what happened.

```bash
npm run dist           # make, then publish a GitHub release
GITHUB_TOKEN=… npm run dist
```

`npm run dist` builds the app, writes `latest-mac.yml` next to the zip, and
uploads the DMG, the zip and that file to a release tagged with the version in
`package.json`. Bump the version first; the updater compares it against the one in
the feed. Pushing a tag (`git tag v1.0.0 && git push origin v1.0.0`) does the
same through the release workflow, which also runs the tests first.

Two details that Forge does not do on its own, both handled by the
`update-feed` plugin in `tools/`:

- `app-update.yml` is written into `Contents/Resources` before the bundle is
  finished, because that is the only place a packaged app can be told which
  repository to ask.
- `latest-mac.yml` is written in a `postMake` hook rather than by a maker, because
  Forge runs makers concurrently — no maker can count on the zip already existing —
  and the digest has to be of the file that is actually uploaded.

## For other apps

Anything that can open a URL can drive the island — a script, a shortcut, a
browser — with no dependency. Three links, each answered the way a click would
be (a locked island stays shut for links too):

```bash
open 'notch-island://open/player'          # open the island on a panel
open 'notch-island://toast?message=Backup%20done'
open 'notch-island://timer?minutes=25'     # start a countdown
```

Panels are `quick`, `player`, `volume`, `mic`, `bluetooth`, `battery`,
`clipboard`, `clock`, `settings`, `layout` and `compact` (`close` folds), plus
`mod:<id>` for a mod's own panel. Anything else — another scheme, an unknown
panel, a number outside its range — is ignored.

Anything deeper than a link belongs in a mod. A mod is a `.js` file in
`~/Library/Application Support/Notch Island/mods/` — which is exactly how an
external app ships a widget or a panel: write the file and the island picks it
up without restarting (deleted files unload the same way; write big ones
temp-and-renamed). A fresh install finds `example.js` there to copy from:

```js
islandMod.register({
  id: 'myapp',
  name: 'My App',
  widgets: [{
    id: 'myapp', label: 'My App',
    render: (state) => {
      const node = document.createElement('button');
      node.className = 'widget readout';
      node.dataset.panelOpen = 'mod:myapp'; // click opens the panel below
      node.textContent = 'Hi';
      return node; // or null to leave the slot empty
    },
  }],
  panels: [{
    id: 'myapp', label: 'My App',
    render: (state, el) => { el.textContent = 'Hello.'; },
  }],
});
```

A mod runs in the island's page: no Node, no files, no network. It reads the
state it is handed (`islandMod.state()`), draws with it, and fires the actions
the island already has (`islandMod.action(name, args)`). Widgets wait in the
palette until arranged like any other widget; panels open from
`notch-island://open/mod:myapp` too. It runs as you, so only files you — or an
app you trust with your folder — put there ever run.

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
  icon opens a menu that lists every panel — quick controls, battery, clock and
  the rest — alongside the demo actions and the preferences.
- A side of the row holds three widgets and no more, so a row is six. Live
  activities are not counted against it and are never dropped; when the row still
  cannot fit, `requestSize` sheds widgets from whichever arm is widest. Which arm a
  widget sits on and in what order is yours to decide and is never changed for you —
  except that a widget taken out of the arrangement stays out, and one that will not
  fit goes back to the palette rather than being deleted.
- Album art comes from MediaRemote, which loads a cover only for the application
  it has in front: a player running in the background behind a browser may never
  get one at all. MediaRemote also unloads the image and loads it again a moment
  later, so a frame arriving without a cover says nothing about the song and the
  one on screen is kept until a *different* song arrives. Only the next song is
  allowed to take it away, since a stale sleeve under a new title is worse than
  no sleeve.
- Display brightness control is not included: the private CoreGraphics entry
  points Apple used to expose (`IOFFramebufferGetLight`) are gone on current
  macOS, and `F1`/`F2` already work system wide.

## Mods

A mod is a JavaScript file in the mods folder — `~/Library/Application Support/notch-island/mods/`.
It registers what it brings and the island draws it:

```js
islandMod.register({
  id: 'example',
  name: 'Example',

  widgets: [
    {
      id: 'example',
      label: 'Example',
      panel: 'mod:example',          // opened when the widget is clicked
      render: (state) => {          // a node, or null to leave the slot empty
        const node = document.createElement('button');
        node.className = 'widget readout';
        node.dataset.panelOpen = 'mod:example';
        node.textContent = `Battery ${Math.round(state.battery.level * 100)}%`;
        return node;
      },
    },
  ],

  panels: [
    {
      id: 'example',
      label: 'Example',
      render: (state, el) => { el.textContent = 'Drawn by a mod.'; },
    },
  ],
});
```

A mod widget is an item in the island row like any other: it appears in the Arrange
palette once the mod is loaded, and it counts against the three a side. A mod panel
opens the way any panel does — from its widget, or by name.

**The boundary.** Mod code runs in the island's page, which has no Node, no files and
no network. It can draw, read the state it is handed, and fire the actions the island
already has — and nothing else. It cannot read a file, open a socket, or reach the
main process except through `window.islandMod`. A mod that throws while loading is
left out and logged; a mod that throws while drawing gets a panel that says so. What
is behind the boundary cannot take the island down.

Each mod has a switch in Settings → Mods. Switching one off takes its widgets back out
of the row.

## Layout

```
src/main/index.js      app lifecycle, actions, tray, polling
src/main/island.js     overlay window, notch anchoring, spring animation
src/main/notch.js      camera housing detection through AppKit
src/main/hotkeys.js    F7–F12 and the fallback chains
src/main/activities.js live activities: timers, media, mic, Bluetooth, charging, updates
src/main/layout.js     the surfaces, what can go in them, and the profiles over them
src/main/mods.js       the mods folder, and what the loaded mods may put in the row
src/main/artwork.js    which song the cover on screen belongs to
src/main/helper.js     builds and supervises the Objective-C bridge
src/main/updater.js    electron-updater behind one plain status object
src/main/snapshot.js   the payload the renderer is handed, and what a trim may cost
src/main/prefs.js      persisted preferences
src/renderer/app.js    island state machine, widgets, panels
src/renderer/styles.css
tools/helper/NotchHelper.m
tools/make-icon.js     generates the app and tray icons without dependencies
tools/update-feed.js   the two manifests an update needs
tools/forge-plugin-update-feed.js  writes them into the build and the release
```

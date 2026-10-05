'use strict';

const path = require('node:path');
const { BrowserWindow, screen, nativeTheme } = require('electron');
const { spring } = require('./anim');
const notch = require('./notch');

/**
 * The island window: a transparent, click-through overlay that lives on top of
 * the camera housing and animates between a compact pill and a full panel.
 *
 * The main process owns the geometry. The renderer asks for the size its content
 * needs, the main process clamps that to sane bounds and tweens the window while
 * streaming the interpolated frame back to the renderer, so both stay in sync
 * without a second animation loop.
 */

const MIN_PILL_HEIGHT = 30;
/** How much taller the compact island gets while the pointer rests on it. */
const HOVER_GROW = 7;
const EXPANDED_RADIUS = 20;
/** Room below the island for its drop shadow; the window is taller than the island. */
const SHADOW_ROOM = 26;
/** A tween never runs longer than this, whatever it has been asked to do. */
const TWEEN_LIMIT_MS = 1400;
/**
 * Opening a panel is the one move that reads as staged: the frame starts at the
 * compact pill's height, so the panel's copy is clipped until the window catches
 * up and the eye sees the header alone before the rest of the panel. Growing
 * hard here keeps that moment short. Every other move — collapsing, dragging,
 * hopping between panels — keeps the slower spring.
 */
const OPEN_SPRING = { stiffness: 520, damping: 36 };

class Island {
  constructor (prefs) {
    this.prefs = prefs;
    this.window = null;
    this.notch = { x: 0, y: 0, width: 0, height: 0, detected: false };
    this.display = null;
    this.state = 'compact';
    /** Called whenever `state` changes, so the tray radio items can follow. */
    this.onStateChange = null;
    this.frame = { x: 0, y: 0, width: 220, height: 32 };
    this.pointerInside = false;
    this.hovering = false;
    this.requestedWidth = 0;
    /** How far the window sits off the housing centre, so an asymmetric row
        keeps its middle on the housing. The renderer owns it. */
    this._shift = 0;
    this._tween = null;
    this._springs = null;
    this._tweenTarget = null;
    this._tweenDeadline = 0;
    this._lastSent = null;
  }

  create () {
    nativeTheme.themeSource = 'dark';

    this.window = new BrowserWindow({
      ...this._bounds(this.frame.width, this.frame.height),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // A click on the island must not pull focus away from whatever you were doing.
      focusable: false,
      acceptFirstMouse: true,
      skipTaskbar: true,
      show: false,
      roundedCorners: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });

    if (process.argv.includes('--dev')) {
      // Electron still delivers the deprecated positional form here.
      this.window.webContents.on('console-message', (...args) => {
        const details = typeof args[1] === 'object' && args[1] !== null
          ? args[1]
          : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
        const where = String(details.sourceId ?? '').split('/').pop();
        console.log(`[renderer:${details.level}] ${details.message} (${where}:${details.lineNumber})`);
      });
    }

    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    this.window.once('ready-to-show', () => {
      this.window.show();
      this.window.setAlwaysOnTop(true, 'screen-saver');
    });

    return this.window;
  }

  /** Recomputes the notch rectangle and re-anchors the island. */
  async syncDisplays () {
    const display = screen.getPrimaryDisplay();
    this.display = display;
    notch.invalidate();
    this.notch = await notch.detectNotch(screen, display);
    return this.notch;
  }

  get maxWidth () {
    const { maxWidth } = this.prefs.get('island');
    return Math.max(maxWidth, this.notch.width + 24);
  }

  /** Notch-sized when the user wants the compact island to stay in the cutout. */
  get usesNotchShape () {
    return this.prefs.get('island.style') === 'notch' && this.notch.detected;
  }

  get compactHeight () {
    const base = this.usesNotchShape
      ? this.notch.height
      : Math.max(MIN_PILL_HEIGHT, this.notch.height, this.prefs.get('island.compactHeight') ?? 0);
    // Resting on the island lifts it a little, the way a control responds to a
    // finger landing on it.
    return this.hovering && this.state === 'compact' ? base + HOVER_GROW : base;
  }

  get expandedHeight () {
    return this.compactHeight + Math.max(120, this.prefs.get('island.expandedHeight'));
  }

  get panelMaxHeight () {
    return Math.max(160, this.prefs.get('island.expandedHeight') + 120);
  }

  /** Horizontal centre of the housing, or of the display when there is none. */
  _centreX () {
    const bounds = this.display?.bounds ?? screen.getPrimaryDisplay().bounds;
    return this.notch.detected
      ? this.notch.x + this.notch.width / 2
      : bounds.x + bounds.width / 2;
  }

  /** Window origin for a given island size: centred on the camera housing,
      plus the row's shift, so an asymmetric row keeps its middle there. */
  _bounds (width, height) {
    const centre = this._centreX();
    return {
      x: Math.round(centre - width / 2 + (this._shift ?? 0)),
      y: (this.display?.bounds ?? screen.getPrimaryDisplay().bounds).y,
      width: Math.round(width),
      height: Math.round(height + SHADOW_ROOM),
    };
  }

  /**
   * The frame for a size mid-tween. `x` is derived from the width that is being
   * sprung, so the island grows outwards from the notch on every frame instead
   * of snapping to its final edge on the first one. The shift rides along, so
   * the row's middle stays on the housing while the width springs.
   */
  _centered (width, height, radius, y) {
    return {
      x: Math.round(this._centreX() - width / 2 + (this._shift ?? 0)),
      y,
      width: Math.round(width),
      height: Math.round(height),
      radius,
    };
  }

  /**
   * Resizes the island. The requested size is what the content needs; it gets
   * clamped between the physical housing and the configured maximums.
   */
  // Dynamic max width: screen width minus margins, capped at reasonable bounds
  get dynamicMaxWidth () {
    const screen = require('electron').screen;
    const primaryDisplay = screen.getPrimaryDisplay();
    const workArea = primaryDisplay.workAreaSize;
    // Max 90% of screen width, capped at 1200px, minimum 400px
    return Math.min(Math.max(workArea.width * 0.9, 400), 1200);
  }

  resize (requestedWidth, { height, animate = true, shift } = {}) {
    if (requestedWidth) this.requestedWidth = requestedWidth;
    const expanded = this.state !== 'compact';
    // An open panel is centred; only the compact row ever shifts. Anything that
    // resizes without saying (hover, drag) keeps the shift it already has.
    if (expanded) this._shift = 0;
    else if (shift !== undefined) this._shift = shift;
    const minimum = this.notch.detected ? this.notch.width : 200;
    const fallback = expanded ? this.dynamicMaxWidth : minimum;
    const width = Math.round(Math.min(Math.max(this.requestedWidth || fallback, minimum), this.dynamicMaxWidth));

    let islandHeight = this.compactHeight;
    if (expanded) {
      const wanted = Number.isFinite(height) ? height : this.expandedHeight;
      islandHeight = this.compactHeight
        + Math.min(Math.max(wanted - this.compactHeight, 96), this.panelMaxHeight);
    }
    const target = this._bounds(width, islandHeight);

    if (!animate) {
      // A tween still running would fight the frame it is being handed.
      this._stopTween();
      this._applyFrame(target);
      return;
    }
    this._tweenTo(target);
  }

  /**
   * Glide the island into the camera housing for goodbye: fold to the compact
   * pill and shrink it to the notch (or a small pill where there is none), so
   * quitting reads as the island sinking away rather than blinking out. Resolves
   * once the glide lands — or stops mattering, because quitting must not wait
   * out the spring's long tail.
   */
  foldForQuit () {
    if (!this.window || this.window.isDestroyed()) return Promise.resolve();
    this._stopTween();
    // Direct assignment, not setState: there is no one left to tell, and the
    // tray must not be rebuilt on the way out.
    this.state = 'compact';
    this._shift = 0;
    const width = this.notch.detected ? this.notch.width : 140;
    this.requestedWidth = width;
    this._tweenTo({ ...this._bounds(width, this.compactHeight) });
    const started = Date.now();
    return new Promise((resolve) => {
      const wait = () => {
        if (!this._springs || Date.now() - started > 900) resolve();
        else setTimeout(wait, 40);
      };
      wait();
    });
  }

  /** Corner radius the island should have right now, in points. */
  get targetRadius () {
    if (this.state === 'compact') {
      if (this.usesNotchShape) return 0;
      return Math.round(this.compactHeight / 2);
    }
    return this.usesNotchShape ? [0, 0, EXPANDED_RADIUS, EXPANDED_RADIUS] : EXPANDED_RADIUS;
  }

  /**
   * Springs the island to a new size. The width overshoots a touch and settles,
   * which is what makes the transition feel physical rather than mechanical.
   *
   * A request that arrives while the island is already moving retargets the
   * springs instead of replacing them: restarting would throw the velocity away
   * and the growth would visibly stutter halfway.
   *
   * The horizontal origin rides its own spring rather than being derived from
   * the width mid-flight: deriving it snaps the island sideways the moment the
   * row's shift changes, while the width is still gliding there.
   */
  _tweenTo (target) {
    const radius = this.targetRadius;
    const near = (a, b) => Math.abs(a - b) < 0.5;

    if (this._springs) {
      const wanted = this._tweenTarget;
      if (near(wanted.width, target.width) && near(wanted.height, target.height) && near(wanted.radius, radius) && near(wanted.x, target.x)) return;
      this._springs.x.retarget(target.x);
      this._springs.width.retarget(target.width);
      this._springs.height.retarget(target.height);
      this._springs.radius.retarget(radius);
      this._tweenTarget = { ...target, radius };
      // The island has further to go now, so it gets the full run-up again.
      this._tweenDeadline = Date.now() + TWEEN_LIMIT_MS;
      return;
    }

    const from = { ...this.frame, radius: this.frame.radius ?? radius };
    // Animating to the size we already have means resizing the window on every
    // frame for nothing, which is exactly the kind of thing that makes an
    // always-on-top overlay stutter.
    if (near(from.width, target.width) && near(from.height, target.height) && near(from.radius, radius) && near(from.x, target.x)) {
      this._applyFrame(this._centered(target.width, target.height, radius, target.y));
      return;
    }

    const start = Date.now();
    // The island is opening rather than merely moving: see `OPEN_SPRING`.
    const opening = this.state !== 'compact' && target.height > from.height + 8;
    const feel = opening ? OPEN_SPRING : undefined;
    this._springs = {
      x: spring(from.x, target.x, feel),
      width: spring(from.width, target.width, feel),
      height: spring(from.height, target.height, feel),
      radius: spring(from.radius, radius, feel),
    };
    this._tweenTarget = { ...target, radius };
    this._tweenDeadline = start + TWEEN_LIMIT_MS;

    const step = () => {
      const frameStart = Date.now();
      const gap = this._lastStepAt ? frameStart - this._lastStepAt : 0;
      this._lastStepAt = frameStart;
      const elapsed = frameStart - start;
      const wanted = this._tweenTarget;
      const nextX = this._springs.x(elapsed);
      const nextWidth = this._springs.width(elapsed);
      const nextHeight = this._springs.height(elapsed);
      const nextRadius = this._springs.radius(elapsed);
      const done = nextX === null && nextWidth === null && nextHeight === null && nextRadius === null;

      this._applyFrame({
        x: Math.round(nextX ?? wanted.x),
        y: wanted.y,
        width: Math.round(nextWidth ?? wanted.width),
        height: Math.round(nextHeight ?? wanted.height),
        radius: Math.round((nextRadius ?? wanted.radius) * 100) / 100,
      });

      if (done || Date.now() > this._tweenDeadline) {
        this._applyFrame({
          x: wanted.x,
          y: wanted.y,
          width: wanted.width,
          height: wanted.height,
          radius: wanted.radius,
        });
        this._stopTween();
        return;
      }
      // Scheduled against the frame's own start so the loop lands on the
      // display's cadence instead of drifting by the work each frame does.
      const work = Date.now() - frameStart;
      // The work itself is cheap; the delay a `setTimeout` actually serves is
      // not, and a busy main process can run several milliseconds late. That
      // lateness is measured from one frame to the next and subtracted, so the
      // island holds the display's cadence instead of settling for whatever the
      // timer happens to give it.
      if (gap > 0 && this._lastDelay !== undefined) {
        const late = gap - this._lastWork - this._lastDelay;
        this._late = this._late === undefined ? late : this._late * 0.7 + late * 0.3;
      }
      const slop = Math.min(Math.max(this._late ?? 0, 0), 12);
      const delay = Math.max(0, 1000 / 60 - work - slop);
      this._lastWork = work;
      this._lastDelay = delay;
      this._tween = setTimeout(step, delay);
    };
    step();
  }

  _stopTween () {
    clearTimeout(this._tween);
    this._tween = null;
    this._springs = null;
    this._tweenTarget = null;
    this._tweenDeadline = 0;
  }

  _applyFrame (frame) {
    // Resizing an always-on-top window is the expensive part of every frame, so
    // a frame the window server would not be able to tell apart is skipped. The
    // spring's tail sits inside one pixel for a surprisingly long time. The
    // state is part of the comparison: it is the one thing the renderer must be
    // told about even when the geometry has not moved.
    const sent = this._lastSent;
    const identical = Boolean(sent)
      && sent.x === frame.x && sent.y === frame.y
      && sent.width === frame.width && sent.height === frame.height
      && sent.radius === frame.radius && sent.state === this.state;
    this.frame = frame;
    if (identical) return;
    if (!this.window || this.window.isDestroyed()) return;
    this._lastSent = {
      x: frame.x, y: frame.y, width: frame.width, height: frame.height,
      radius: frame.radius, state: this.state,
    };
    this.window.setBounds(frame, false);
    this.window.webContents.send('island:frame', {
      ...frame,
      // The renderer only uses the top part of the window; the rest is shadow.
      islandHeight: frame.height - SHADOW_ROOM,
      radius: frame.radius ?? this.targetRadius,
      state: this.state,
      notch: this.notch,
    });
  }

  setState (state) {
    if (state === this.state) return;
    this.state = state;
    this.onStateChange?.(state);
    this._applyFrame({ ...this.frame, radius: this.frame.radius ?? this.targetRadius });
  }

  // ------------------------------------------------------------ dragging

  /**
   * Dragging the island down shrinks it, dragging up opens it — the rubber band
   * gesture from the iPhone, which is the single biggest difference between a
   * window that changes size and an island that feels alive.
   */
  beginDrag () {
    this._stopTween();
    this._drag = { base: { ...this.frame }, last: 0 };
  }

  drag (deltaY) {
    if (!this._drag) return;
    this._drag.last = deltaY;
    const { base } = this._drag;
    const compact = this.compactHeight;
    const open = this.expandedHeight + SHADOW_ROOM;

    if (deltaY > 0) {
      // Pulled down: shrink towards the compact pill with resistance.
      const room = Math.max(base.height - compact, 0);
      const pull = Math.min(deltaY * 0.55, room);
      this._applyFrame({
        ...base,
        height: Math.round(base.height - pull),
        width: Math.round(base.width - pull * 0.45),
      });
    } else {
      // Pulled up: stretch towards the open island, again with resistance.
      const pull = Math.min(-deltaY * 0.4, Math.max(open - base.height, 0));
      this._applyFrame({ ...base, height: Math.round(base.height + pull) });
    }
  }

  endDrag () {
    if (!this._drag) return;
    const { base, last } = this._drag;
    this._drag = null;

    if (this.state === 'compact' && last < -18) {
      // Locked means compact: an upward drag folds nothing open.
      if (this.prefs.get('island.locked') !== true) {
        this.state = this.lastPanel ?? 'player';
        this.onStateChange?.(this.state);
        // Through `_applyFrame` so the renderer and the skip check agree on what
        // it has already been told.
        this._applyFrame({ ...this.frame });
        this.resize(null, { height: this.expandedHeight });
        return;
      }
    }
    if (this.state !== 'compact' && last > 26) {
      this.state = 'compact';
      this.onStateChange?.(this.state);
      this._applyFrame({ ...this.frame });
      this.resize();
      return;
    }
    this.resize(null, { height: this.state === 'compact' ? undefined : this.expandedHeight });
  }

  /** Called on every pointer move; grows the island while it is hovered. */
  setHovering (hovering) {
    // Locked means compact: hovering neither lifts the pill nor, through the
    // renderer, opens what was last looked at.
    if (hovering && this.prefs.get('island.locked') === true) hovering = false;
    if (hovering === this.hovering) return;
    this.hovering = hovering;
    if (this.state === 'compact') this.resize(null, { height: this.compactHeight });
  }

  /** Only let clicks through when the pointer is away from the island. */
  setInteractive (interactive) {
    if (!this.window || this.window.isDestroyed()) return;
    if (interactive === this.pointerInside) return;
    this.pointerInside = interactive;
    this.window.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  send (channel, payload) {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send(channel, payload);
  }

  geometry () {
    return { notch: this.notch, frame: this.frame, state: this.state };
  }

  destroy () {
    this._stopTween();
    this.window?.destroy();
  }
}

module.exports = { Island, SHADOW_ROOM, EXPANDED_RADIUS, HOVER_GROW };

'use strict';

/** Animation helpers, free of Electron imports so they can be unit tested. */

function lerp (from, to, progress) {
  return from + (to - from) * progress;
}

function easeOutQuint (progress) {
  return 1 - Math.pow(1 - progress, 4);
}

/** Frame at time `elapsed` for a tween of `duration` between two rects. */
function interpolateRect (from, to, elapsed, duration) {
  const progress = Math.min(Math.max(elapsed / duration, 0), 1);
  const eased = easeOutQuint(progress);
  return {
    x: Math.round(lerp(from.x, to.x, eased)),
    y: to.y,
    width: Math.round(lerp(from.width, to.width, eased)),
    height: Math.round(lerp(from.height, to.height, eased)),
  };
}

/**
 * A damped spring, which is what gives the real Dynamic Island its snap: the
 * island slightly overshoots and settles instead of sliding to a stop.
 *
 * Returns a stepper: call it with the elapsed milliseconds since the start and
 * it reports the next value, or `null` once it has come to rest. `retarget`
 * moves the goal without restarting the integration, so a second request while
 * the spring is already moving keeps its momentum instead of stuttering.
 */
function spring (from, to, options = {}) {
  const { stiffness = 420, damping = 34, mass = 1, precision = 0.4 } = options;
  const step = 1 / 240; // fixed timestep keeps the integration stable
  let value = from;
  let velocity = 0;
  let time = 0;
  let target = to;

  const advance = (elapsed) => {
    // The caller counts in milliseconds; the integration runs in seconds, which
    // is the unit the stiffness and damping were chosen in.
    const until = elapsed / 1000;
    let guard = 0;
    while (time < until && guard++ < 600) {
      const dt = Math.min(step, until - time);
      const acceleration = (-stiffness * (value - target) - damping * velocity) / mass;
      velocity += acceleration * dt;
      value += velocity * dt;
      time += dt;
    }
    if (Math.abs(value - target) < precision && Math.abs(velocity) < precision) {
      value = target;
      velocity = 0;
      return null;
    }
    return value;
  };

  advance.retarget = (next) => {
    target = next;
  };

  return advance;
}

module.exports = { lerp, easeOutQuint, interpolateRect, spring };

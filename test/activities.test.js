'use strict';

const test = require('node:test');
const assert = require('node:assert');
const activities = require('../src/main/activities');

const base = {
  media: { title: '', artist: '', artwork: null, duration: 0, elapsed: 0, rate: 0 },
  input: { muted: false, active: [] },
  battery: { level: 0.5, charging: false },
  bluetooth: { devices: [] },
};

test('nothing is happening means no activities', () => {
  assert.deepStrictEqual(activities.derive(base), []);
});

test('playing music becomes an activity with progress', () => {
  const list = activities.derive({
    ...base,
    media: { title: 'Hey Jude', artist: 'The Beatles', artwork: null, duration: 200, elapsed: 50, rate: 1 },
  });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].kind, 'media');
  assert.strictEqual(list[0].progress, 0.25);
  assert.strictEqual(list[0].dismissible, true);
});

test('a paused track is not an activity', () => {
  const list = activities.derive({ ...base, media: { ...base.media, title: 'Hey Jude', rate: 0 } });
  assert.deepStrictEqual(list, []);
});

test('a song the compact row already shows stands down', () => {
  const list = activities.derive({
    ...base,
    media: { title: 'Hey Jude', artist: 'The Beatles', artwork: null, duration: 200, elapsed: 50, rate: 1 },
    compact: { right: ['media', 'volume'], left: [] },
  }, ['media', 'volume']);
  assert.deepStrictEqual(list, []);
  // Nothing arranged: the bubble is the only place the song shows.
  assert.strictEqual(activities.derive({
    ...base,
    media: { title: 'Hey Jude', artist: 'The Beatles', artwork: null, duration: 200, elapsed: 50, rate: 1 },
  }).length, 1);
});

test('a connected accessory with a battery is reported', () => {
  const list = activities.derive({
    ...base,
    bluetooth: { devices: [{ address: 'AA-BB', name: 'AirPods Pro', connected: true, battery: 0.42, charging: false }] },
  });
  assert.strictEqual(list[0].kind, 'bluetooth');
  assert.strictEqual(list[0].subtitle, '42%');
});

test('the lowest battery wins when several accessories are connected', () => {
  const list = activities.derive({
    ...base,
    bluetooth: { devices: [
      { address: 'AA', name: 'Magic Mouse', connected: true, battery: 0.8, charging: false },
      { address: 'BB', name: 'AirPods', connected: true, battery: 0.2, charging: false },
    ] },
  });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].title, 'AirPods');
});

test('a microphone in use is not dismissible', () => {
  const list = activities.derive({ ...base, input: { muted: false, active: ['Zoom'] } });
  assert.strictEqual(list[0].kind, 'mic');
  assert.strictEqual(list[0].dismissible, false);
});

test('charging is an activity, a full battery on cable is too', () => {
  const list = activities.derive({ ...base, battery: { level: 0.8, charging: true } });
  assert.strictEqual(list[0].kind, 'battery');
  assert.strictEqual(list[0].progress, 0.8);
  assert.strictEqual(list[0].full, false, 'not full yet');
});

test('a full battery announces itself, holds, then retires', (t) => {
  // The hold is measured in wall clock time, so the clock is what gets faked.
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const full = { ...base, battery: { level: 1, charging: true } };

  const first = activities.derive(full).find((activity) => activity.id === 'charging');
  assert.strictEqual(first.full, true);
  assert.strictEqual(first.title, 'Fully charged');

  t.mock.timers.tick(activities.CHARGE_FULL_HOLD_MS - 10);
  assert.ok(activities.derive(full).some((activity) => activity.id === 'charging'),
    'it stays up long enough for the bar to snap green and be read');

  t.mock.timers.tick(20);
  assert.ok(!activities.derive(full).some((activity) => activity.id === 'charging'),
    'then the island has nothing left to show and folds away');
  t.mock.timers.reset();
});

test('a full battery comes back when it is unplugged and plugged in again', () => {
  const charging = { ...base, battery: { level: 1, charging: true } };
  activities.derive(charging);
  activities.derive(charging);
  activities.derive(charging);
  assert.ok(!activities.derive({ ...base, battery: { level: 1, charging: false } })
    .some((activity) => activity.id === 'charging'));
  assert.ok(activities.derive(charging).some((activity) => activity.id === 'charging'),
    'a fresh plug-in is an event again');
});

test('a transfer reports itself, counts bytes and finishes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const id = activities.startTransfer({ name: 'iPad', bytes: 4_000_000, durationMs: 1000 });
  // The transfer is module state, so it has to be cleaned up even if an
  // assertion below throws.
  t.after(() => activities.cancelTransfer(id));

  const running = activities.derive(base).find((activity) => activity.id === id);
  assert.strictEqual(running.kind, 'transfer');
  assert.strictEqual(running.title, 'Sending to iPad');
  assert.strictEqual(running.done, false);
  assert.strictEqual(running.dismissible, true, 'a transfer in flight can be called off');
  assert.match(running.subtitle, /of 4\.0 MB$/);

  // Part way through, the numbers on screen are the ones that moved.
  t.mock.timers.tick(500);
  const part = activities.derive(base).find((activity) => activity.id === id);
  assert.ok(part.progress > 0.1 && part.progress < 1, `${Math.round(part.progress * 100)}%`);
  assert.match(part.subtitle, /of 4\.0 MB$/);
  assert.strictEqual(part.done, false);

  // Past the end it reports done, and holds just long enough for the check.
  t.mock.timers.tick(600);
  const done = activities.derive(base).find((activity) => activity.id === id);
  assert.strictEqual(done.progress, 1);
  assert.strictEqual(done.done, true);
  assert.strictEqual(done.subtitle, 'Sent');
  assert.strictEqual(done.dismissible, false, 'a finished transfer cannot be called off');

  t.mock.timers.tick(activities.TRANSFER_DONE_HOLD_MS + 10);
  assert.ok(!activities.derive(base).some((activity) => activity.id === id),
    'then it is gone and the island folds back to the pill');
  t.mock.timers.reset();
});

test('a transfer sprints away and then crawls', () => {
  const at = (ms) => activities.transferState({
    name: 'x', bytes: 1000, durationMs: 1000, startedAt: Date.now() - ms, doneAt: 0,
  }).progress;
  const firstTenth = at(100);
  const lastTenth = at(900) - at(800);
  assert.ok(firstTenth > lastTenth * 3,
    `the first tenth covers ${Math.round(firstTenth * 100)}%, the last tenth ${Math.round(lastTenth * 100)}%`);
  assert.ok(at(1000 - 1) < 1, 'and it never reaches 1 before the clock says so');
});

test('formatBytes reads like a file size', () => {
  assert.strictEqual(activities.formatBytes(2_400_000), '2.4 MB');
  assert.strictEqual(activities.formatBytes(1_500_000_000), '1.5 GB');
});

test('timers count down and clean themselves up', () => {
  const id = activities.startTimer(5);
  let list = activities.derive(base);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].kind, 'timer');
  assert.match(list[0].subtitle, /4:5\d|5:00/);

  activities.pauseTimer(id);
  list = activities.derive(base);
  assert.strictEqual(list[0].progress < 0.01, true, 'a fresh timer is barely spent');

  activities.cancelTimer(id);
  assert.deepStrictEqual(activities.derive(base), []);
});

test('resuming a paused timer keeps the time it had left', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const id = activities.startTimer(5);
  // Spend two minutes, pause for ten seconds, then resume: the timer must still
  // have about three minutes left, not restart the full five.
  t.mock.timers.tick(2 * 60_000);
  activities.pauseTimer(id);
  t.mock.timers.tick(10_000);
  activities.resumeTimer(id);
  const list = activities.derive(base);
  const remaining = list[0] ? list[0].subtitle : '';
  assert.match(remaining, /2:5\d|3:0\d/, `expected ~3 min left, got ${remaining}`);
  activities.cancelTimer(id);
  t.mock.timers.reset();
});

test('freshIds only reports what is new', () => {
  const previous = [{ id: 'media' }, { id: 'charging' }];
  const next = [{ id: 'media' }, { id: 'charging' }, { id: 'timer-9' }];
  assert.deepStrictEqual(activities.freshIds(previous, next), ['timer-9']);
});

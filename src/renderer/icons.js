/**
 * Inline SVG icons. Inline keeps the island crisp at any size and themeable. */
const wrap = (paths, size = 16, extra = '') =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

const fillWrap = (paths, size = 16) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">${paths}</svg>`;

const solid = {
  volumeLow: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/>',
  volumeHigh: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/><path d="M18.5 5.5a9 9 0 0 1 0 13" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
  volumeMute: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  play: '<path d="M8 5.5v13l11-6.5-11-6.5Z"/>',
  pause: '<path d="M8.5 5.5h3.2v13H8.5zM13.3 5.5h3.2v13h-3.2z"/>',
  next: '<path d="M6 5.5v13l9-6.5-9-6.5Z"/><rect x="16.5" y="5.5" width="2.6" height="13" rx="1.1"/>',
  previous: '<path d="M18 5.5v13L9 12l9-6.5Z"/><rect x="4.9" y="5.5" width="2.6" height="13" rx="1.1"/>',
  mic: '<path d="M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5a2.6 2.6 0 0 1-5.2 0v-5A2.6 2.6 0 0 1 12 3.5Z"/><path d="M6.5 11.2a5.5 5.5 0 0 0 11 0M12 16.7v3.8"/>',
  micOff: '<path d="M9.5 6.1A2.6 2.6 0 0 1 14.6 6v5c0 .6-.2 1.2-.5 1.6M14.6 15.1a2.6 2.6 0 0 1-5.2-1v-4"/><path d="M6.5 11.2a5.5 5.5 0 0 0 8.4 4.7M17.5 11.2v.6M12 16.7v3.8"/><path d="m4 3 16 18" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round"/>',
  battery: '<rect x="2.5" y="7.5" width="16" height="9" rx="2.6"/><path d="M21 10.5v3"/>',
  batteryBolt: '<path d="M13.5 1.5 4.5 13.5h6l-1.5 9 9-12h-6l1.5-9Z" fill="currentColor" stroke="none"/>',
  clipboard: '<rect x="6.5" y="4.5" width="11" height="16" rx="2.4"/><path d="M9.8 4.5a2.2 2.2 0 0 1 4.4 0"/><path d="M9.6 11.5h4.8M9.6 15h3.2"/>',
  clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3 1.8"/>',
  music: '<path d="M9.5 17.4V6.6l9-1.8v10.8"/><circle cx="7" cy="17.6" r="2.6"/><circle cx="16" cy="15.8" r="2.6"/>',
  gear: '<circle cx="12" cy="12" r="3.1"/><path d="M19.3 14.2a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1v.2a1.9 1.9 0 1 1-3.7 0v-.1a1.5 1.5 0 0 0-2.6-1l-.1.1a1.9 1.9 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.6h-.2a1.9 1.9 0 1 1 0-3.7h.1a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.9 1.9 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 2.6-1v-.2a1.9 1.9 0 1 1 3.7 0v.1a1.5 1.5 0 0 0 2.6 1l.1-.1a1.9 1.9 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.6h.2a1.9 1.9 0 1 1 0 3.7h-.1a1.5 1.5 0 0 0-1.3.9Z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.4"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/>',
  contrast: '<circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8Z" fill="currentColor" stroke="none"/>',
  check: '<path d="m5 12.6 4.6 4.4L19 6.6"/>',
  // Closed shape, so it fills cleanly when it is used as the "done" flash.
  checkFill: '<path d="M20.4 6.5a1.4 1.4 0 0 1 0 2L10.4 18.5a1.4 1.4 0 0 1-2 0l-4.8-4.8a1.4 1.4 0 0 1 2-2l3.8 3.8 8.8-8.8a1.4 1.4 0 0 1 2 0Z"/>',
  link: '<path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"/><path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>',
  text: '<path d="M5 6.5h14M5 12h14M5 17.5h9"/>',
  camera: '<rect x="3" y="6.5" width="12" height="11" rx="2.6"/><path d="m15 10.5 5.2-2.8v8.6L15 13.5"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.2v3.6M14 3.2v3.6M10 17.2v3.6M14 17.2v3.6M3.2 10h3.6M3.2 14h3.6M17.2 10h3.6M17.2 14h3.6"/>',
  keyboard: '<rect x="2.5" y="6.5" width="19" height="11" rx="2.4"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5"/>',
  sparkle: '<path d="M12 4.5 13.4 9l4.5 1.4-4.5 1.4L12 16.3l-1.4-4.5L6.1 10.4 10.6 9 12 4.5Z"/>',
  display: '<rect x="3" y="5" width="18" height="12" rx="2.2"/><path d="M9 20.5h6"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.8M9.5 2.5h5"/>',
  musicNote: '<path d="M9.5 17.4V6.6l9-1.8v10.8"/><circle cx="7" cy="17.6" r="2.6"/><circle cx="16" cy="15.8" r="2.6"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  thermal: '<path d="M12 3.5v2.5"/><rect x="9.8" y="6" width="4.4" height="12" rx="2.2" fill="currentColor"/>',
  // An arrow landing on a line: something arriving from above. Used for the
  // update download, so it never has to mean "sync" or "refresh" as well.
  download: '<path d="M12 3.5v11"/><path d="m7.4 10.4 4.6 4.6 4.6-4.6"/><path d="M4 19.4h16"/>',
  // The same arrow again, one turn round: the version is already on disk and all
  // that is left is starting it.
  restart: '<path d="M20.2 12a8.2 8.2 0 1 1-2.7-6.1"/><path d="M20.6 3.4v4.7h-4.7"/>',
};

const stroke = {
  volumeLow: '<path d="M11 5 6.5 9H3.5v6h3l4.5 4V5Z"/>',
  volumeHigh: '<path d="M11 5 6.5 9H3.5v6h3l4.5 4V5Z"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6M18 6.4a8 8 0 0 1 0 11.2"/>',
  volumeMute: '<path d="M11 5 6.5 9H3.5v6h3l4.5 4V5Z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>',
  play: '<path d="M8 5.8v12.4L18.5 12 8 5.8Z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  next: '<path d="M6 6v12l8.5-6L6 6Z"/><path d="M17.5 6v12"/>',
  previous: '<path d="M18 6v12L9.5 12 18 6Z"/><path d="M6.5 6v12"/>',
  mic: '<rect x="9.2" y="3" width="5.6" height="10.5" rx="2.8"/><path d="M6 11.2a6 6 0 0 0 12 0M12 17.2v3.8"/>',
  micOff: '<rect x="9.2" y="3" width="5.6" height="10.5" rx="2.8"/><path d="M6 11.2a6 6 0 0 0 9 5.2M18 11.2a6 6 0 0 1-.6 2.6M12 17.2v3.8"/><path d="m4 3.2 16 17.6"/>',
  chevron: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  close: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',  // AirDrop: a circle of concentric arcs with a device in the middle. Deliberately
  // not the wifi glyph — the arcs sit *inside* the ring and open downward.
  airdrop: '<circle cx="12" cy="13.5" r="8.8"/><path d="M6.8 13.5a5.2 5.2 0 0 1 10.4 0"/><path d="M9.4 13.5a2.6 2.6 0 0 1 5.2 0"/><rect x="10.9" y="12.4" width="2.2" height="2.2" rx="0.3"/>',
  thermal: '<path d="M12 3.5v2.5M9 3.5h6"/><rect x="9.8" y="6" width="4.4" height="12" rx="2.2"/><path d="M12 11v4"/>',
  link: '<path d="M10.4 13.6a3.6 3.6 0 0 0 5.1 0l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2"/><path d="M13.6 10.4a3.6 3.6 0 0 0-5.1 0l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2"/>',
  text: '<path d="M5 6.5h14M5 12h14M5 17.5h9"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5"/>',
};

/**
 * Icon lookup. `filled` picks the filled variant, which is what the transport
 * buttons use so they read at a glance.
 */
function icon (name, { size = 16, filled = false } = {}) {
  const markup = solid[name] ?? stroke[name] ?? '';
  if (!markup) return '';
  return filled && solid[name] ? fillWrap(markup, size) : wrap(markup, size);
}

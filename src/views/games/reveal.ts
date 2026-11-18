// Reveal of a newly added game in the Games hub: a short synthesized fanfare and the cover
// dissolving in tile by tile from the centre. Runs once per game (see catalog.ts, revealed list).
// No flashes: everything is opacity, motion and pixels appearing.

/** Two to three seconds of fanfare: a rising arpeggio into a held, gently shimmering chord. */
export function playFanfare(volume = 0.8): void {
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  let ac: AudioContext;
  try { ac = new AC(); } catch { return; }
  const out = ac.createGain();
  out.gain.value = 0.32 * volume;
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 4;
  out.connect(comp); comp.connect(ac.destination);
  const t0 = ac.currentTime + 0.05;

  const note = (freq: number, at: number, dur: number, type: OscillatorType, vol: number, vibrato = 0) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (vibrato) {
      const lfo = ac.createOscillator(), depth = ac.createGain();
      lfo.frequency.value = 5.5; depth.gain.value = freq * vibrato;
      lfo.connect(depth); depth.connect(o.frequency);
      lfo.start(at); lfo.stop(at + dur + 0.1);
    }
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.015);
    g.gain.exponentialRampToValueAtTime(vol * 0.6, at + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(out);
    o.start(at); o.stop(at + dur + 0.05);
  };

  // drum-like lift-off under the first note
  const kick = ac.createOscillator(), kg = ac.createGain();
  kick.type = "sine";
  kick.frequency.setValueAtTime(180, t0);
  kick.frequency.exponentialRampToValueAtTime(55, t0 + 0.18);
  kg.gain.setValueAtTime(0.0001, t0);
  kg.gain.exponentialRampToValueAtTime(0.7, t0 + 0.01);
  kg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
  kick.connect(kg); kg.connect(out); kick.start(t0); kick.stop(t0 + 0.35);

  const arp = [523.25, 659.25, 783.99, 1046.5, 1318.5];
  arp.forEach((f, i) => {
    note(f, t0 + i * 0.11, 0.22, "square", 0.16);
    note(f * 2, t0 + i * 0.11, 0.26, "triangle", 0.1);
  });
  const chordAt = t0 + arp.length * 0.11 + 0.05;
  for (const f of [523.25, 659.25, 783.99, 1046.5]) {
    note(f, chordAt, 1.6, "triangle", 0.16, 0.006);
    note(f, chordAt, 1.1, "square", 0.05, 0.006);
  }
  // soft sparkle on top
  [2093, 2637, 3136, 2637, 3520].forEach((f, i) => note(f, chordAt + 0.08 + i * 0.09, 0.18, "triangle", 0.05));

  window.setTimeout(() => { void ac.close().catch(() => {}); }, 3200);
}

/** Dissolve `cover` (already painted, same size as `target`) into `target`, tile by tile from
 *  the centre, over `ms` milliseconds. Returns a cancel function. */
export function dissolveIn(target: HTMLCanvasElement, cover: HTMLCanvasElement, ms: number, onDone: () => void): () => void {
  const g = target.getContext("2d");
  if (!g) { onDone(); return () => {}; }
  target.width = cover.width;
  target.height = cover.height;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, target.width, target.height);
  const T = 8;
  const cols = Math.ceil(cover.width / T), rows = Math.ceil(cover.height / T);
  const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
  const tiles: { x: number; y: number; at: number }[] = [];
  let maxD = 0;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const d = Math.hypot((x - cx) / cols, (y - cy) / rows) + Math.random() * 0.12;
    maxD = Math.max(maxD, d);
    tiles.push({ x, y, at: d });
  }
  tiles.sort((a, b) => a.at - b.at);
  let drawn = 0, raf = 0, dead = false;
  const start = performance.now();
  const frame = (now: number) => {
    if (dead) return;
    const k = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - k, 2);
    const want = Math.floor(eased * tiles.length);
    for (; drawn < want; drawn++) {
      const t = tiles[drawn];
      g.drawImage(cover, t.x * T, t.y * T, T, T, t.x * T, t.y * T, T, T);
    }
    if (k < 1) raf = requestAnimationFrame(frame);
    else { g.drawImage(cover, 0, 0); onDone(); }
  };
  raf = requestAnimationFrame(frame);
  return () => { dead = true; cancelAnimationFrame(raf); };
}

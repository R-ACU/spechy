// Sounds of the leaderboard join, synthesised with the helpers of economy/sfx.ts so they share
// its output, mute and volume (call configureSfx first). Subtle on purpose: a soft tick per data
// packet arriving at the servers, a two-note chime on success, a short falling tone on failure.
import { sfxKit } from "../economy/sfx";

const { tone, noise, bell, midi } = sfxKit;

export const joinSfx = {
  /** One data packet reaching the servers. */
  packet(i: number) {
    tone({ f: 1500 + (i % 4) * 120, type: "sine", d: 0.035, v: 0.035 });
    noise({ type: "bandpass", f: 3200, q: 8, d: 0.012, v: 0.04 });
  },
  /** Joined. */
  chime() {
    bell(midi(79), 0, 0.08, 0.9);
    bell(midi(86), 0.09, 0.07, 1.1);
  },
  /** The join failed. */
  fail() {
    tone({ f: 330, to: 196, type: "triangle", d: 0.32, v: 0.06 });
  },
};

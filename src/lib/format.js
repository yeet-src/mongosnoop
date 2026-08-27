// Pure presentation helpers — strings and color, no signals or BPF.
// Imported by the components through the `@/` alias (resolved at bundle time).
import { idx } from "yeet:tui";

export const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
export const lpad = (s, n) => (" ".repeat(n) + s).slice(-n);

// A switch rate as a short human string: 12, 4.2K, 1.1M (per second).
export const fmtRate = (perSec) => {
  if (perSec < 1000) return `${Math.round(perSec)}`;
  if (perSec < 1e6) return `${(perSec / 1e3).toFixed(1)}K`;
  return `${(perSec / 1e6).toFixed(1)}M`;
};

// A nanosecond duration as µs / ms / s.
export const fmtDuration = (ns) => {
  if (ns < 1e3) return `${ns}ns`;
  if (ns < 1e6) return `${(ns / 1e3).toFixed(0)}µs`;
  if (ns < 1e9) return `${(ns / 1e6).toFixed(1)}ms`;
  return `${(ns / 1e9).toFixed(1)}s`;
};

// Cold -> hot "inferno" ramp for a 0..1 fraction: a near-black floor rising
// through deep purple and magenta into orange, gold, and white-hot. It's the
// matplotlib-style heatmap gradient, approximated in the xterm-256 cube, and
// reads as genuinely thermal — quiet cores sit dark, hot ones glow white.
// Index 0 is a visible charcoal so idle cells still show on screen.
const RAMP = [
  234, 17, 54, 55, 91, 127, 163, 199, 205, 203, 209, 215, 221, 227, 229, 231,
].map(idx);
export const heat = (frac) =>
  RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(frac * RAMP.length)))];

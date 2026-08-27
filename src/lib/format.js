// Pure presentation helpers — strings and color, no signals or BPF.
// Imported by the components through the `@/` alias (resolved at bundle time).
import { rgb } from "yeet:tui";

// ── palette ─────────────────────────────────────────────────────────────────
//
// House idiom (pktscope): truecolor rgb() constants named by ROLE, not by hue,
// so a re-theme is one block. Structure and the dim tier match the other snoops
// so the series reads as one product; the accent hue is mongosnoop's own —
// leaf/spring green against pktscope's sky-blue and violet — so four database
// snoops don't look interchangeable in a lineup.
//
// Restraint, per the taste checklist: ~80% of the screen is neutral or dim, one
// accent leads the eye, red means a real problem and nothing else, bold is a
// few percent of cells. Strip the color and the layout still reads.
export const C_BRAND = rgb(126, 217, 87); // mongosnoop leaf green — the identity
export const C_TITLE = rgb(240, 246, 252); // headline values
export const C_TEXT = rgb(214, 222, 230); // ordinary foreground
export const C_DIM = rgb(120, 130, 140); // labels, units, separators
export const C_FAINT = rgb(80, 88, 98); // rules, inactive chrome

export const C_CMD = rgb(126, 217, 87); // command verb — the accent
export const C_NS = rgb(125, 211, 252); // db.collection — sky
export const C_SHAPE = rgb(199, 168, 255); // query shape — violet
export const C_VALUE = rgb(250, 204, 21); // bound values on the ↳ line — gold
export const C_FIELD = rgb(148, 163, 184); // field names on the ↳ line

export const C_READ = rgb(94, 234, 212); // read commands — teal
export const C_WRITE = rgb(251, 146, 60); // write commands — orange
export const C_BAD = rgb(248, 113, 113); // footguns / errors — red
export const C_WARN = rgb(253, 186, 116); // caveats (truncated, inferred)
export const C_TLS = rgb(167, 243, 208); // encrypted-source marker — mint

export const C_SEL_BG = rgb(38, 66, 104); // selection bar
export const C_SEL_FG = rgb(255, 255, 255);
export const C_MATCH_BG = rgb(96, 74, 20); // fuzzy-match highlight (gold-brown)
export const C_RAIL = rgb(28, 32, 38); // title/footer rail background
export const C_CAP = rgb(52, 58, 66); // footer key-cap tile

// ── strings ─────────────────────────────────────────────────────────────────
export const pad = (s, n) => (`${s}` + " ".repeat(n)).slice(0, n);
export const lpad = (s, n) => (" ".repeat(n) + `${s}`).slice(-n);
export const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// A per-second rate as a short human string: 12, 4.2K, 1.1M.
export const fmtRate = (perSec) => {
  if (perSec < 1000) return `${Math.round(perSec)}`;
  if (perSec < 1e6) return `${(perSec / 1e3).toFixed(1)}K`;
  return `${(perSec / 1e6).toFixed(1)}M`;
};

// A microsecond duration as µs / ms / s. The kernel gives us microseconds, so
// unlike sqlitefeed's nanosecond version this starts one unit up.
export const fmtDuration = (us) => {
  if (us <= 0) return "0";
  if (us < 1000) return `${Math.round(us)}µs`;
  if (us < 1e6) return `${(us / 1e3).toFixed(1)}ms`;
  return `${(us / 1e6).toFixed(2)}s`;
};

// Byte counts, short form.
export const fmtBytes = (b) => {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}K`;
  return `${(b / 1048576).toFixed(1)}M`;
};

// Nearest-rank percentile (p in 0..1) of a numeric array. Empty → 0.
export const pctl = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
};

// ── latency heat ────────────────────────────────────────────────────────────
//
// Map a command latency to 0..1 on a log scale: ~100µs cool, ~1s hot. Mongo is
// a networked database, so even a fast command carries a round trip — the floor
// sits a decade above sqlitefeed's in-process one, or every row would look hot.
export const latFrac = (us) => {
  if (us <= 0) return 0;
  const f = (Math.log10(us) - 2) / 4; // 10^2µs=100µs → 0, 10^6µs=1s → 1
  return Math.max(0, Math.min(1, f));
};

// Cold → hot ramp. Deliberately NOT the inferno ramp sqlitefeed uses: this one
// runs green → teal → gold → orange → red so it sits inside mongosnoop's own
// palette, and so "hot" reads as the same red used for footguns.
const RAMP = [
  rgb(63, 92, 74), rgb(74, 133, 92), rgb(94, 176, 110), rgb(126, 217, 87),
  rgb(148, 224, 140), rgb(94, 234, 212), rgb(190, 227, 130), rgb(233, 220, 110),
  rgb(250, 204, 21), rgb(253, 186, 116), rgb(251, 146, 60), rgb(248, 113, 113),
];
export const heat = (frac) =>
  RAMP[Math.min(RAMP.length - 1, Math.max(0, Math.floor(frac * RAMP.length)))];

// A sparkline glyph for a 0..1 fraction.
const BARS = "▁▂▃▄▅▆▇█";
export const spark = (frac) => BARS[Math.min(7, Math.max(0, Math.floor(frac * 7.99)))];
export const sparkline = (vals, peak) => {
  const p = peak || Math.max(...vals, 1);
  return vals.map((v) => spark(v / p)).join("");
};

// ── row geometry ────────────────────────────────────────────────────────────
//
// Terminal rows one command occupies: the command line, plus the ↳ values line
// when it has bound values, plus the ⚠ line when it tripped a footgun. Shared
// by the feed (rendering + height budgeting) and main.jsx's scroll math, so
// both agree on how tall a row is.
export const rowHeight = (c) => 1 + (c.values?.length ? 1 : 0) + (c.footgun ? 1 : 0);

// The ↳ line: field=value pairs, already formatted by the probe.
export const fmtValues = (list) => list.map((v) => `${v.field}=${v.text}`).join("  ");

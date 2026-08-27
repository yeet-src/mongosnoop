// Responsive layout model. Pure: given the terminal {cols, rows}, it picks a
// breakpoint and hands every panel the exact extent the flex tree will give
// it — so a component never has to guess its own width again. main.jsx renders
// the returned descriptor mechanically; each panel just fills in the numbers.
//
// Shape: { mode, rows: [{ h, cells: [{ kind, w, ...dims }] }] }. Rows are laid
// out top-to-bottom with a 1-row rule between them; cells fill a row left-to-
// right. Heights/widths sum exactly to the viewport so nothing clips or gaps.

const LABEL_W = 9; // heatmap row label: "▸ cpu NN "
const MIN_GRID = 8; // fewest heatmap time columns worth drawing
const GRID_MAX = 256; // matches the per-CPU history the probe keeps
const HIST_W = 34; // runqueue-latency panel width
const HIST_H = 17; // its 16 buckets + header — shown whole or dropped
const MIN_SIDE = 34; // a side panel narrower than this isn't worth showing

const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

const heatCell = (w, h) => ({
  kind: "heatmap",
  w,
  gridCols: clamp(MIN_GRID, w - LABEL_W, GRID_MAX),
  maxRows: Math.max(1, h - 1), // minus the header row
});
const procsCell = (w, h) => ({ kind: "procs", w, maxRows: Math.max(1, h - 1) });
const detailCell = (w, h) => ({ kind: "detail", w, rows: Math.max(1, h - 1) });
const histCell = (w, h) => ({ kind: "histogram", w, maxRows: h });

export const layoutFor = ({ cols, rows }) => {
  const body = Math.max(1, rows - 2); // between the 1-row title and footer

  // Wide: the 2×2 grid — heatmap | procs over detail | histogram.
  if (cols >= 96 && rows >= 16) {
    const topH = Math.max(2, (body - 1) >> 1); // -1 for the rule between bands
    const botH = body - 1 - topH;
    let leftW = clamp(LABEL_W + MIN_GRID, Math.round(cols * 0.6), cols - MIN_SIDE);
    const grid = clamp(MIN_GRID, leftW - LABEL_W, GRID_MAX);
    leftW = LABEL_W + grid; // trim dead space to the actual grid width
    return {
      mode: "wide",
      rows: [
        { h: topH, cells: [heatCell(leftW, topH), procsCell(cols - leftW, topH)] },
        { h: botH, cells: [detailCell(cols - HIST_W, botH), histCell(HIST_W, botH)] },
      ],
    };
  }

  // Stack: one column. Include panels by priority while they fit; the leftover
  // height goes to the heatmap and detail feed (the two that scale with it).
  const order = [
    { make: (h) => heatCell(cols, h), min: 3, grow: true },
    { make: (h) => detailCell(cols, h), min: 3, grow: true },
    { make: (h) => procsCell(cols, h), min: 3, grow: true },
    { make: (h) => histCell(cols, h), min: HIST_H, grow: false }, // fixed buckets
  ];
  const inc = [];
  for (const p of order) {
    const need = inc.reduce((s, q) => s + q.min, p.min) + inc.length; // +rules
    if (need <= body) inc.push(p);
  }
  if (!inc.length) inc.push(order[0]); // always at least the heatmap

  // Leftover height is shared round-robin among the growable panels (every
  // panel but the fixed-height histogram, whose extra rows would be blank).
  let extra = body - (inc.length - 1) - inc.reduce((s, p) => s + p.min, 0);
  const bump = inc.map(() => 0);
  let growers = inc.map((p, i) => (p.grow ? i : -1)).filter((i) => i >= 0);
  if (!growers.length) growers = inc.map((_, i) => i);
  for (let i = 0; extra > 0; i = (i + 1) % growers.length, extra--) bump[growers[i]]++;

  return {
    mode: "stack",
    rows: inc.map((p, i) => {
      const h = Math.max(1, p.min + bump[i]);
      return { h, cells: [p.make(h)] };
    }),
  };
};

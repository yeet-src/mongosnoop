// Pure fuzzy-filter helpers — no signals, no BPF.

// Subsequence match: every char of `q` appears in `text`, in order,
// case-insensitive. Empty query matches everything. This is the classic
// fuzzy-finder test ("shord" matches "shop.orders").
export const fuzzyMatch = (q, text) => {
  if (!q) return true;
  const query = q.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < query.length; j++) {
    if (t[j] === query[i]) i++;
  }
  return i === query.length;
};

// The character indices of `text` that a greedy subsequence match of `q`
// consumes, or null if `text` doesn't contain the whole query. Same algorithm
// as fuzzyMatch, but it records where each query char landed — so the UI can
// highlight exactly the matched characters. Empty query → no positions.
export const fuzzyPositions = (q, text) => {
  if (!q) return null;
  const query = q.toLowerCase();
  const t = text.toLowerCase();
  const pos = [];
  let i = 0;
  for (let j = 0; j < t.length && i < query.length; j++) {
    if (t[j] === query[i]) {
      pos.push(j);
      i++;
    }
  }
  return i === query.length ? pos : null;
};

// The text a command is matched against: process, verb, namespace, shape, and
// the concrete bound values. Including the values is what lets you type an
// ObjectId or a customer id and see every command that touched that document,
// regardless of which query shape it was.
export const haystack = (c) =>
  `${c.comm} ${c.cmd} ${c.ns} ${c.shape} ${(c.values ?? []).map((v) => `${v.field} ${v.text}`).join(" ")}`;

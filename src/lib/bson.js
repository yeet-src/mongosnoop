// BSON decoding and query-shape extraction. Pure functions over a byte window
// — no signals, no BPF. This is the half of the parser the kernel deliberately
// refuses to do: BSON elements are typed and variable-length, so walking one
// means loops the verifier won't accept. Here it's just a cursor.
//
// Everything is best-effort by construction: the kernel hands us a fixed
// window (BODY_LEN bytes) off the front of the message, so a large command is
// TRUNCATED mid-document. Every reader below is bounds-checked and returns
// what it managed to read rather than throwing, and `truncated` is surfaced so
// the UI can say so instead of implying it saw the whole document.

// BSON element type bytes we care about. The rest are read for their length
// (so the cursor can step over them) but not decoded into values.
export const T = {
  DOUBLE: 0x01,
  STRING: 0x02,
  DOC: 0x03,
  ARRAY: 0x04,
  BINARY: 0x05,
  UNDEFINED: 0x06,
  OID: 0x07,
  BOOL: 0x08,
  DATE: 0x09,
  NULL: 0x0a,
  REGEX: 0x0b,
  DBPOINTER: 0x0c,
  CODE: 0x0d,
  SYMBOL: 0x0e,
  CODEWS: 0x0f,
  INT32: 0x10,
  TIMESTAMP: 0x11,
  INT64: 0x12,
  DECIMAL128: 0x13,
  MINKEY: 0xff,
  MAXKEY: 0x7f,
};

const HEX = "0123456789abcdef";

// A cursor over the window. `ok` goes false the moment a read would run past
// the end, and every subsequent read is a no-op — so a truncated document
// degrades into "everything up to the cut" instead of an exception.
class Cur {
  constructor(buf, pos = 0) {
    this.b = buf;
    this.p = pos;
    this.ok = true;
  }
  has(n) {
    if (!this.ok) return false;
    if (this.p + n > this.b.length) {
      this.ok = false;
      return false;
    }
    return true;
  }
  u8() {
    if (!this.has(1)) return 0;
    return this.b[this.p++];
  }
  i32() {
    if (!this.has(4)) return 0;
    const b = this.b;
    const p = this.p;
    this.p += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) | 0;
  }
  u32() {
    return this.i32() >>> 0;
  }
  i64() {
    // Assembled as a BigInt: Mongo's int64s (counts, cursor ids, timestamps)
    // routinely exceed 2^53, so Number here would silently corrupt them.
    if (!this.has(8)) return 0n;
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(this.b[this.p + i]);
    this.p += 8;
    // Two's complement.
    return v >= 0x8000000000000000n ? v - 0x10000000000000000n : v;
  }
  f64() {
    if (!this.has(8)) return 0;
    const dv = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8);
    this.p += 8;
    return dv.getFloat64(0, true);
  }
  // NUL-terminated key name.
  cstr() {
    let s = "";
    while (this.ok) {
      if (!this.has(1)) return s;
      const c = this.b[this.p++];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  // int32-length-prefixed string (the length includes the trailing NUL).
  str() {
    const n = this.i32();
    if (n <= 0 || !this.has(n)) {
      this.ok = false;
      return "";
    }
    let s = "";
    for (let i = 0; i < n - 1; i++) s += String.fromCharCode(this.b[this.p + i]);
    this.p += n;
    return s;
  }
  bytes(n) {
    if (!this.has(n)) return new Uint8Array(0);
    const out = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return out;
  }
}

const oidHex = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  return s;
};

// Read one element's value, given its type byte. Returns a plain JS value, or
// a tagged object for the BSON types that have no JS equivalent (ObjectId,
// regex, binary) so the formatter can render them faithfully rather than as
// "[object Object]".
function readValue(c, type, depth) {
  switch (type) {
    case T.DOUBLE:
      return c.f64();
    case T.STRING:
    case T.SYMBOL:
      return c.str();
    case T.DOC:
      return readDoc(c, depth + 1);
    case T.ARRAY: {
      const d = readDoc(c, depth + 1);
      // BSON arrays are documents with "0","1","2" keys.
      return d && typeof d === "object" ? Object.values(d) : [];
    }
    case T.BINARY: {
      const n = c.i32();
      const sub = c.u8();
      const raw = c.bytes(n < 0 ? 0 : n);
      return { $binary: raw, $subtype: sub };
    }
    case T.UNDEFINED:
      return undefined;
    case T.OID:
      return { $oid: oidHex(c.bytes(12)) };
    case T.BOOL:
      return c.u8() !== 0;
    case T.DATE:
      return { $date: c.i64() };
    case T.NULL:
      return null;
    case T.REGEX:
      return { $regex: c.cstr(), $options: c.cstr() };
    case T.DBPOINTER: {
      c.str();
      c.bytes(12);
      return { $dbpointer: true };
    }
    case T.CODE:
      return { $code: c.str() };
    case T.CODEWS: {
      c.i32();
      const code = c.str();
      readDoc(c, depth + 1);
      return { $code: code };
    }
    case T.INT32:
      return c.i32();
    case T.TIMESTAMP:
      return { $timestamp: c.i64() };
    case T.INT64:
      return c.i64();
    case T.DECIMAL128:
      return { $decimal: oidHex(c.bytes(16)) };
    case T.MINKEY:
      return { $minKey: 1 };
    case T.MAXKEY:
      return { $maxKey: 1 };
    default:
      // Unknown type byte: we no longer know this element's length, so the
      // cursor can't be trusted past here. Stop cleanly.
      c.ok = false;
      return undefined;
  }
}

// Depth cap: a hand-built document can nest arbitrarily, and this runs on
// every captured command. 12 is far past anything a real query uses.
const MAX_DEPTH = 12;

// Read a whole BSON document into a plain object. The caller's cursor is left
// just past the document.
export function readDoc(c, depth = 0) {
  if (depth > MAX_DEPTH) {
    c.ok = false;
    return {};
  }
  const start = c.p;
  const len = c.i32();
  const out = {};
  if (len < 5) {
    c.ok = false;
    return out;
  }
  const end = start + len;
  while (c.ok && c.p < end - 1) {
    const type = c.u8();
    if (type === 0) break; // document terminator
    const key = c.cstr();
    if (!key) break;
    const val = readValue(c, type, depth);
    // KEEP a partially-read value. When the kernel's window cuts through a
    // nested document the sub-read sets `ok` false and returns what it got —
    // discarding that here would lose the whole `filter` on exactly the large
    // commands most worth looking at. A partial filter still yields a usable
    // shape, and `truncated` tells the UI not to claim it saw everything.
    if (val !== undefined) out[key] = val;
    if (!c.ok) break;
  }
  // Jump to the recorded end so a partially-read subdocument doesn't desync
  // the parent's cursor — but only if the window actually reaches that far.
  if (end <= c.b.length) c.p = end;
  else c.ok = false;
  return out;
}

// Parse the OP_MSG body window the kernel captured.
//
// Returns { cmd, coll, db, doc, truncated, kind }, where `doc` is as much of
// the command document as the window held. `cmd` is the first key, which by
// the command protocol names the operation; `coll` is its value when that
// value is a string.
export function parseOpMsg(body, bodyLen) {
  const buf = body.subarray(0, Math.min(bodyLen, body.length));
  const out = { cmd: "", coll: "", db: "", doc: {}, truncated: false, kind: 0 };
  if (buf.length < 21) {
    out.truncated = true;
    return out;
  }

  const c = new Cur(buf, 16); // skip the wire header
  c.i32(); // flagBits
  out.kind = c.u8();
  if (out.kind !== 0) {
    // Section kind 1 is a document sequence (bulk insert/update payloads).
    // The command body is a separate kind-0 section that the window may not
    // reach; report what we know rather than guessing.
    out.truncated = true;
    return out;
  }

  const doc = readDoc(c, 0);
  out.doc = doc;
  out.truncated = !c.ok;

  const keys = Object.keys(doc);
  if (keys.length) {
    out.cmd = keys[0];
    const v = doc[keys[0]];
    if (typeof v === "string") out.coll = v;
  }
  // `$db` is a top-level field the driver appends to every command. It sits
  // after the operation's own fields, so it's the first thing lost to
  // truncation on a big query — hence best-effort.
  if (typeof doc.$db === "string") out.db = doc.$db;
  // getMore and a few others name their collection in a dedicated field.
  if (!out.coll && typeof doc.collection === "string") out.coll = doc.collection;

  return out;
}

// The filter document for a given command, or null when the command has no
// meaningful predicate. This is what shape extraction runs on.
export function filterOf(cmd, doc) {
  if (!doc) return null;
  switch (cmd) {
    case "find":
    case "count":
    case "distinct":
      return doc.filter ?? doc.query ?? null;
    case "delete": {
      const d = Array.isArray(doc.deletes) ? doc.deletes[0] : null;
      return d?.q ?? null;
    }
    case "update": {
      const u = Array.isArray(doc.updates) ? doc.updates[0] : null;
      return u?.q ?? null;
    }
    case "findAndModify":
      return doc.query ?? null;
    case "aggregate": {
      // A pipeline's shape is its stage list; if it opens with $match, that
      // predicate is the closest thing to a filter and the part that decides
      // whether an index is used.
      const p = Array.isArray(doc.pipeline) ? doc.pipeline : null;
      if (!p || !p.length) return null;
      const first = p[0];
      return first && typeof first === "object" ? (first.$match ?? null) : null;
    }
    default:
      return null;
  }
}

// Tagged BSON scalars carry a single $-prefixed marker key; they're leaf
// values, not operator documents, and must not be walked into.
const TAGS = ["$oid", "$date", "$binary", "$regex", "$timestamp", "$code", "$decimal", "$minKey", "$maxKey"];
const isTagged = (v) => TAGS.some((t) => t in v);

// Mongo query operators that take a nested predicate rather than a value.
const LOGICAL = new Set(["$and", "$or", "$nor"]);

// Collapse a filter document into its SHAPE: the field names it constrains,
// with every concrete value stripped. `{user_id: ObjectId(...), status: "new"}`
// and `{user_id: ObjectId(...), status: "done"}` both become `{status, user_id}`.
//
// Sorted, so two logically identical filters written in different key orders
// produce the same shape string and aggregate together. Operators are kept
// where they change the index story: a field constrained by `$regex` or `$ne`
// behaves very differently from an equality match, and flattening that away
// would hide the reason a shape is slow.
export function shapeOf(filter, depth = 0) {
  if (!filter || typeof filter !== "object" || depth > 6) return [];
  const parts = [];
  for (const [k, v] of Object.entries(filter)) {
    if (LOGICAL.has(k)) {
      // $and/$or take an array of sub-filters; splice their fields in under
      // the operator so the grouping stays visible.
      const subs = (Array.isArray(v) ? v : []).flatMap((s) => shapeOf(s, depth + 1));
      if (subs.length) parts.push(`${k}(${[...new Set(subs)].sort().join(",")})`);
      continue;
    }
    if (k.startsWith("$")) {
      parts.push(k);
      continue;
    }
    // A value that is itself an operator document ({$gt: 5}) contributes the
    // operator; a plain value is an equality match and contributes just the key.
    // A tagged BSON scalar (ObjectId, Date, regex...) is a VALUE, not an
    // operator document. Without this guard an equality match on an _id reads
    // as "_id $oid" and every ObjectId-keyed query fragments into its own
    // shape — which would defeat the aggregation the shape exists for.
    if (v && typeof v === "object" && !Array.isArray(v) && !isTagged(v)) {
      const ops = Object.keys(v).filter((o) => o.startsWith("$"));
      if (ops.length) {
        parts.push(`${k} ${ops.sort().join(" ")}`);
        continue;
      }
    }
    parts.push(k);
  }
  return parts;
}

// The shape as a display string: `{customer_id, status $in}`. Empty filter
// renders as `{}`, which is itself meaningful — an unfiltered collection scan.
export function shapeString(filter) {
  const parts = shapeOf(filter);
  if (!parts.length) return "{}";
  return `{${[...new Set(parts)].sort().join(", ")}}`;
}

// Flatten a filter into the concrete leaf values, for the `↳` line under a row.
// This is the whole "the bug is usually in the ?" argument: the shape tells you
// which query ran, the values tell you why this run was slow.
export function valuesOf(filter, depth = 0, prefix = "") {
  if (!filter || typeof filter !== "object" || depth > 6) return [];
  const out = [];
  for (const [k, v] of Object.entries(filter)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (LOGICAL.has(k) && Array.isArray(v)) {
      for (const s of v) out.push(...valuesOf(s, depth + 1, prefix));
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !isTagged(v)) {
      const ops = Object.keys(v);
      if (ops.length && ops.every((o) => o.startsWith("$"))) {
        for (const o of ops) out.push({ field: `${path} ${o}`, value: v[o] });
        continue;
      }
      out.push(...valuesOf(v, depth + 1, path));
      continue;
    }
    out.push({ field: path, value: v });
  }
  return out;
}

// Render one BSON value for display, clipped. Faithful to type: an ObjectId
// reads as an ObjectId, not as a hex blob that could be anything.
export function fmtValue(v, max = 28) {
  const clip = (s) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return clip(JSON.stringify(v));
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return String(v);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return clip(`[${v.map((x) => fmtValue(x, 12)).join(", ")}]`);
  }
  if (typeof v === "object") {
    if ("$oid" in v) return `ObjectId(${v.$oid.slice(0, 8)}…${v.$oid.slice(-4)})`;
    if ("$date" in v) return `Date(${v.$date})`;
    if ("$regex" in v) return clip(`/${v.$regex}/${v.$options ?? ""}`);
    if ("$binary" in v) return `Binary(${v.$binary.length}B)`;
    if ("$timestamp" in v) return `Timestamp(${v.$timestamp})`;
    if ("$code" in v) return clip(`Code(${v.$code})`);
    if ("$decimal" in v) return `Decimal128(…)`;
    if ("$minKey" in v) return "MinKey";
    if ("$maxKey" in v) return "MaxKey";
    const keys = Object.keys(v);
    if (!keys.length) return "{}";
    return clip(`{${keys.map((k) => `${k}: ${fmtValue(v[k], 10)}`).join(", ")}}`);
  }
  return String(v);
}

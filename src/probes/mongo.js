// BPF data layer for mongosnoop — the only BPF-aware module.
//
// It loads bin/probe.bpf.o, attaches the tcp_sendmsg / tcp_recvmsg kprobes,
// and folds the raw event stream into an append-only log of completed
// commands. The UI reads three plain signals:
//   commands — array of finished commands { cmd, ns, shape, values, latUs, … },
//              newest first, each frozen once it lands (never mutates)
//   stats    — rolling totals + per-second rates for the title bar
//   status   — attach state, surfaced in the title bar instead of thrown
//
// Run standalone to eyeball the raw events (needs the daemon; BPF load is
// privileged and handled by yeetd):
//   yeet run src/probes/mongo.js
// then generate traffic, e.g. from any app or:  mongosh --eval 'db.t.find({a:1})'
import { BpfObject, RingBuf } from "yeet:bpf";
import { from, signal } from "yeet:tui";

// Relative, not `@/`: the alias is bundle-time only, and this module must also
// run standalone via `yeet run src/probes/mongo.js` (AGENTS.md gotcha 7).
import { parseOpMsg, filterOf, shapeString, valuesOf, fmtValue } from "../lib/bson.js";
import { footgunOf, isNoise, isRealCmd, isWrite, batchOf, limitOf } from "../lib/classify.js";

// ── constants shared with mongo.bpf.c ───────────────────────────────────────
const OP = { MSG: 2013, COMPRESSED: 2012, QUERY: 2004 };

const CAP = 2000; // most-recent commands retained (scrollback depth)
const WINDOW_MS = 250; // snapshot cadence — one re-render per window, not per event

// exe path is relative to the *running module's* dir. Bundled (the default
// `yeet run`, entry src/main.jsx) that's src/ → ../bin. Standalone
// (`yeet run src/probes/mongo.js`, import.meta.main true) it's src/probes/ →
// ../../bin. esbuild rewrites import.meta.main to false in the bundle, so this
// picks the right depth in both cases.
const OBJ = {
  exe: import.meta.main ? "../../bin/probe.bpf.o" : "../bin/probe.bpf.o",
  base: import.meta.dirname,
};

const load = () =>
  new BpfObject(OBJ)
    .bind("mongo_events", { kind: "ringbuf", btf_struct: "mongo_event" })
    .bind("probe.data", { kind: "data" })
    .start();

// Decode a NUL-terminated char[] (or already-a-string) to JS text. No
// TextDecoder in bare V8 — hand-roll it, stopping at the first NUL.
const cstr = (v) => {
  if (typeof v === "string") return v.replace(/\0.*$/s, "");
  if (!v) return "";
  let s = "";
  for (const b of v) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
};

// A char[]/u8[] field arrives as an array-like; normalise to Uint8Array so the
// BSON cursor can subarray it.
const bytes = (v) => {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  return Uint8Array.from(v);
};

const unwrap = (w) => w?.mongo_event ?? w; // ring-buffer events wrap the struct

// Last `$db` seen per (pid, collection).
//
// `$db` is a top-level field the driver appends AFTER the operation's own
// fields, so on a command with a large payload — an insert carrying its
// documents, a bulk update — it falls outside the kernel's fixed body window
// and is simply not there. Widening the window can't fix that: the payload is
// unbounded, and the whole point of the fixed window is a bounded per-event
// cost.
//
// But `$db` is effectively constant for a given collection in a given process:
// an app talking to `shop.orders` sends `$db: "shop"` on every command against
// it. So we learn it from the commands where it IS visible (a find's filter is
// small) and reuse it for the ones where it isn't. That turns "ns=orders" into
// "ns=shop.orders" for the truncated majority.
//
// This is an INFERENCE, not an observation, and it's marked as such on the
// record (`dbInferred`) so the UI can render it differently rather than
// claiming to have read something it didn't.
const dbByColl = new Map();
const DB_CACHE_CAP = 4096;

const rememberDb = (pid, coll, db) => {
  if (!db || !coll) return;
  if (dbByColl.size > DB_CACHE_CAP) dbByColl.clear(); // crude bound; refills fast
  dbByColl.set(`${pid}\u0000${coll}`, db);
};
const recallDb = (pid, coll) => (coll ? dbByColl.get(`${pid}\u0000${coll}`) : undefined);

export const stats = signal({ tracked: 0, cmdRate: 0, readRate: 0, writeRate: 0, slowest: 0 });
export const status = signal("starting…");

// Kernel-side slow-command floor, in microseconds. Patched live into the BPF
// program's .data so filtering happens before the ring buffer, not after.
export const minLatency = signal(0);

// Decode one raw event into the display-ready record the UI consumes. All the
// BSON work happens here, once per command, not per frame.
export function decode(ev) {
  const opcode = ev.opcode;
  const body = bytes(ev.body);
  const bodyLen = ev.body_len;

  // Only OP_MSG has a body we can read. The others are tracked so their
  // latency and existence are visible, labelled rather than silently dropped.
  let parsed = { cmd: cstr(ev.cmd), coll: cstr(ev.ns), db: "", doc: {}, truncated: false };
  if (opcode === OP.MSG) {
    const p = parseOpMsg(body, bodyLen);
    // Trust the kernel's verb/collection when the JS walk came up empty
    // (a body window that got cut before the first element completed).
    parsed = {
      cmd: p.cmd || cstr(ev.cmd),
      coll: p.coll || cstr(ev.ns),
      db: p.db,
      doc: p.doc,
      truncated: p.truncated,
    };
  }

  const cmd = parsed.cmd;
  const filter = filterOf(cmd, parsed.doc);

  // Resolve the database: observed if the window reached `$db`, otherwise
  // recalled from a previous command on the same collection in this process.
  let db = parsed.db;
  let dbInferred = false;
  if (db) {
    rememberDb(ev.pid, parsed.coll, db);
  } else {
    const seen = recallDb(ev.pid, parsed.coll);
    if (seen) {
      db = seen;
      dbInferred = true;
    }
  }
  const ns = db && parsed.coll ? `${db}.${parsed.coll}` : parsed.coll || db || "";

  return {
    pid: ev.pid,
    tid: ev.tid,
    comm: cstr(ev.comm),
    cmd,
    ns,
    db,
    dbInferred, // true when `$db` was recalled, not read off this command
    coll: parsed.coll,
    opcode,
    // The label the UI shows when there's no decodable body.
    opLabel: opcode === OP.COMPRESSED ? "compressed" : opcode === OP.QUERY ? "legacy" : "",
    shape: opcode === OP.MSG ? shapeString(filter) : "",
    values: opcode === OP.MSG ? valuesOf(filter).map((v) => ({ field: v.field, text: fmtValue(v.value) })) : [],
    footgun: opcode === OP.MSG ? footgunOf(cmd, parsed.doc, filter) : null,
    truncated: parsed.truncated,
    isWrite: isWrite(cmd),
    isNoise: isNoise(cmd),
    latUs: ev.lat_us,
    reqBytes: ev.req_bytes,
    respBytes: ev.resp_bytes,
    requestId: ev.request_id,
    limit: limitOf(parsed.doc),
    batch: batchOf(parsed.doc),
    doc: parsed.doc,
  };
}

// The reactive model is an append-only LOG of completed commands, not a
// mutable per-shape aggregate. Each command is frozen the moment its reply
// pairs and is never touched again — so a row already on screen never changes
// or jumps, and re-running the same shape APPENDS rather than updating. That
// is what makes an N+1 visible as literal repetition down the feed.
export const commands = from((state) => {
  const log = []; // completed commands, newest first — immutable once pushed
  let logId = 0; // monotonic row id
  let total = 0; // cumulative commands seen (title-bar counter)
  let dirty = false; // did the log change since the last publish?
  const win = { cmds: 0, reads: 0, writes: 0, slowest: 0 }; // reset each window

  const sub = load()
    .then((ctl) => {
      status.set("tracing");
      return new RingBuf(ctl, "mongo_events").subscribe((w) => {
        const ev = unwrap(w);
        const rec = decode(ev);

        // Drop anything whose verb we couldn't name — an empty row is worse
        // than no row. Driver chatter is kept in the log but tagged, so the
        // UI can toggle it rather than losing it.
        if (!isRealCmd(rec.cmd)) return;

        log.unshift({ id: ++logId, ...rec });
        if (log.length > CAP) log.length = CAP; // bound scrollback
        total++;
        dirty = true;

        if (!rec.isNoise) {
          win.cmds++;
          if (rec.isWrite) win.writes++;
          else win.reads++;
          if (rec.latUs > win.slowest) win.slowest = rec.latUs;
        }
      });
    })
    .catch((e) => status.set(`probe failed: ${e?.message ?? e}`));

  const secs = WINDOW_MS / 1000;
  const publish = () => {
    if (dirty) {
      state.set(log.slice(0, CAP)); // immutable rows, newest first
      dirty = false;
    }
    stats.set({
      tracked: total,
      cmdRate: win.cmds / secs,
      readRate: win.reads / secs,
      writeRate: win.writes / secs,
      slowest: win.slowest,
    });
    win.cmds = win.reads = win.writes = win.slowest = 0;
  };
  const h = setInterval(publish, WINDOW_MS);

  return () => {
    clearInterval(h);
    sub.then((s) => s?.unsubscribe());
  };
}, []);

// Standalone correctness probe: dump raw events so field names/types are
// verifiable before any UI exists (AGENTS.md "get the data right first").
if (import.meta.main) {
  const ctl = await load();
  const rb = new RingBuf(ctl, "mongo_events");
  const opName = { 2013: "OP_MSG", 2012: "OP_COMPRESSED", 2004: "OP_QUERY" };
  console.log("[mongo] attached tcp_sendmsg/tcp_recvmsg — waiting for MongoDB traffic…");
  rb.subscribe((w) => {
    const ev = unwrap(w);
    const r = decode(ev);
    const head = `[${opName[r.opcode] ?? r.opcode}] ${r.comm}/${r.pid} req=${r.requestId}`;
    const lat = `${(r.latUs / 1000).toFixed(2)}ms`;
    console.log(
      `${head} ${r.cmd || "?"} ns=${r.ns || "?"}${r.dbInferred ? "~" : ""} shape=${r.shape || "-"} lat=${lat} ` +
        `req=${r.reqBytes}B resp=${r.respBytes}B${r.truncated ? " TRUNC" : ""}${r.isNoise ? " noise" : ""}`,
    );
    if (r.values.length) {
      console.log(`   ↳ ${r.values.map((v) => `${v.field}=${v.text}`).join("  ")}`);
    }
    if (r.footgun) console.log(`   ⚠ ${r.footgun}`);
  });
  await new Promise(() => {});
}

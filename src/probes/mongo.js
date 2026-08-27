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

// The exe path is relative to the *running module's* dir, and that dir differs
// between the two ways this module runs:
//
//   bundled     `yeet run .`                  → src/index.jsx   → ../bin
//   standalone  `yeet run src/probes/mongo.js` → src/probes/    → ../../bin
//
// sqlitefeed picks between them with `import.meta.main`, on the assumption that
// esbuild rewrites it to false in the bundle. It does NOT in this yeet version
// — the bundle keeps the expression live, so it stays truthy and the bundled
// run looks for bin/ one directory too high. Rather than depend on that, try
// both depths and keep whichever opens.
const CANDIDATES = ["../bin/probe.bpf.o", "../../bin/probe.bpf.o"];

// ── TLS attach targets ──────────────────────────────────────────────────────
//
// The socket probes see nothing once a connection is encrypted, so the TLS
// programs hook the crypto library on the application's side of the boundary.
// There are two shapes of target and we try both:
//
//   1. The SYSTEM OpenSSL. One attach to `libssl.so` covers every client that
//      links it dynamically — Python's _ssl, distro-packaged Node, .NET.
//
//   2. STATICALLY-LINKED binaries. Node's official builds bundle BoringSSL, so
//      there is no libssl to hook. BoringSSL keeps the OpenSSL symbol names and
//      the Node binary is not stripped, so `SSL_write` is a global text symbol
//      in the executable itself and a uprobe attaches to it by name. Each such
//      binary is a distinct target, so these are discovered and attached
//      per-path rather than once.
//
// Not covered, and stated as a limit rather than worked around: Go clients
// (crypto/tls is pure Go — no C symbol exists to hook) and Java (JSSE lives
// inside the JVM). A Go or Java app talking to Mongo over TLS shows nothing.
export const tlsTargets = signal([]);

// Binaries worth trying for a static-TLS attach. Discovered from the running
// process list rather than hardcoded, so a nvm build, a bundled mongosh, or an
// Electron app is found the same way /usr/bin/node is.
const discoverStaticTlsBinaries = async () => {
  const found = new Map(); // exe path → true, deduped so one attach per binary
  try {
    // `exe` is a top-level Process field (the resolved binary path); `comm` is
    // under stat. One query gets both.
    const { data } = await yeet.graph.query(`{ procs { exe stat { comm } } }`);
    for (const p of data?.procs ?? []) {
      const comm = p?.stat?.comm ?? "";
      const exe = p?.exe ?? "";
      if (!exe) continue;
      // Node-family runtimes are the ones that bundle their own TLS. Match on
      // either the process name or the binary path, since a bundled tool often
      // reports its own name (mongosh) rather than node.
      if (!/(^|\/)(node|mongosh|electron|bun|deno)/i.test(comm) &&
          !/(^|\/)(node|mongosh|electron|bun|deno)/i.test(exe)) continue;
      found.set(exe, true);
    }
  } catch {
    // No graph, no discovery — the libssl attach still covers dynamic clients.
  }
  return [...found.keys()];
};

const load = async () => {
  let lastErr;
  for (const exe of CANDIDATES) {
    try {
      let b = new BpfObject({ exe, base: import.meta.dirname })
        .bind("mongo_events", { kind: "ringbuf", btf_struct: "mongo_event" })
        .bind("probe.data", { kind: "data" });

      // A BPF program can be attached ONCE, so the three TLS programs get one
      // target each — not one per binary. That makes target choice the whole
      // problem: `libssl.so` covers every dynamically-linked client at once,
      // while a statically-linked runtime (Node's official builds, and the
      // mongosh bundled from one) needs its own binary named explicitly.
      //
      // Default is libssl, which is the broadest single choice. Point it at a
      // static binary instead with `--tls-binary /path/to/node`, and use
      // `--tls-binary auto` to let discovery pick the first Node-family binary
      // it finds running.
      // The arg parser normalises dashes to underscores, so `--tls-binary`
      // arrives as `tls_binary`. Accept both spellings.
      let tlsTarget = yeet.args?.tls_binary ?? yeet.args?.["tls-binary"] ?? "libssl.so";
      if (tlsTarget === "auto") {
        const found = await discoverStaticTlsBinaries();
        tlsTarget = found[0] ?? "libssl.so";
      }

      const attached = [];
      try {
        b = b
          .attach("on_ssl_write", { kind: "uprobe", binary: tlsTarget, symbol: "SSL_write" })
          // kind is always "uprobe"; the program's SEC() name decides entry vs
          // return, so on_ssl_read_ret shares this spec shape.
          .attach("on_ssl_read", { kind: "uprobe", binary: tlsTarget, symbol: "SSL_read" })
          .attach("on_ssl_read_ret", { kind: "uprobe", binary: tlsTarget, symbol: "SSL_read" });
        attached.push(tlsTarget);
      } catch {
        // No SSL symbols there (stripped build, or no libssl on the box). The
        // plaintext path still works, so degrade to wire-only rather than
        // failing the load.
      }

      const ctl = await b.start();
      tlsTargets.set(attached);
      return ctl;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
};

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

export const stats = signal({ tracked: 0, cmdRate: 0, readRate: 0, writeRate: 0, slowest: 0, tlsRate: 0, wireRate: 0 });
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
    // SRC_WIRE (0) = read off the socket in plaintext; SRC_TLS (1) = read
    // inside an encrypted connection at the TLS boundary.
    isTls: ev.source === 1,
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
  const win = { cmds: 0, reads: 0, writes: 0, slowest: 0, tls: 0, wire: 0 }; // reset each window

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
          if (rec.isTls) win.tls++;
          else win.wire++;
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
      tlsRate: win.tls / secs,
      wireRate: win.wire / secs,
    });
    win.cmds = win.reads = win.writes = win.slowest = win.tls = win.wire = 0;
  };
  const h = setInterval(publish, WINDOW_MS);

  return () => {
    clearInterval(h);
    sub.then((s) => s?.unsubscribe());
  };
}, []);

// Standalone correctness probe: dump raw events so field names/types are
// verifiable before any UI exists (AGENTS.md "get the data right first").
//
// Guarded on this module being the entry BY PATH, not on `import.meta.main`.
// The bundle inlines this module into src/index.jsx, and there `import.meta`
// belongs to the bundle — which IS the entry — so an `import.meta.main` guard
// is true in the bundled app too and the dump loop runs instead of the TUI.
// Checking the filename keeps the self-test to the standalone invocation.
const isEntry = /probes\/mongo\.js$/.test(import.meta.url ?? "");

if (isEntry) {
  const ctl = await load();
  const rb = new RingBuf(ctl, "mongo_events");
  const opName = { 2013: "OP_MSG", 2012: "OP_COMPRESSED", 2004: "OP_QUERY" };
  console.log("[mongo] attached tcp_sendmsg/tcp_recvmsg — waiting for MongoDB traffic…");
  rb.subscribe((w) => {
    const ev = unwrap(w);
    const r = decode(ev);
    const head = `[${opName[r.opcode] ?? r.opcode}] ${r.isTls ? "TLS " : "wire"} ${r.comm}/${r.pid} req=${r.requestId}`;
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

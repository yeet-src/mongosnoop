// Command classification: what's application traffic vs driver chatter, what
// reads vs writes, and what deserves a warning. Pure functions over the parsed
// command — no signals, no BPF.
//
// The footgun list is held to the same bar as redissnoop's: a false alarm
// erodes trust faster than a missed one. Every entry below is a property of
// the command as captured, not a guess about the server's execution plan. We
// cannot see whether an index was used (that's `explain`, server-side), so
// nothing here claims to.

// Handshake, monitoring and session upkeep the driver does on its own. These
// dominate raw event counts on an idle connection pool and say nothing about
// what the application is doing, so they're filtered out of the feed by
// default. `hello`/`isMaster` in particular fire every few seconds per pooled
// connection as the driver's server-monitoring heartbeat.
export const NOISE = new Set([
  "hello",
  "ismaster",
  "isMaster",
  "ping",
  "buildInfo",
  "getLastError",
  "saslStart",
  "saslContinue",
  "authenticate",
  "logout",
  "endSessions",
  "refreshSessions",
  "killCursors",
  "getParameter",
  "hostInfo",
  "connectionStatus",
  "whatsmyuri",
  "listDatabases",
  "listCollections",
  "listIndexes",
  "serverStatus",
  "replSetGetStatus",
  "topology",
]);

// Commands that modify data. Everything else captured is treated as a read.
export const WRITES = new Set([
  "insert",
  "update",
  "delete",
  "findAndModify",
  "bulkWrite",
  "createIndexes",
  "dropIndexes",
  "create",
  "drop",
  "dropDatabase",
  "renameCollection",
  "collMod",
]);

export const isWrite = (cmd) => WRITES.has(cmd);
export const isNoise = (cmd) => NOISE.has(cmd);

// A command is worth showing if it names a collection and isn't driver
// chatter. Anything the parser couldn't name is dropped rather than shown as
// an empty row.
export const isRealCmd = (cmd) => !!cmd && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(cmd);

// How many documents a command was told to touch, when it says so. Used for
// the "unbounded" checks below and for the batch column.
const limitOf = (doc) => (typeof doc?.limit === "number" ? doc.limit : null);
const batchOf = (doc) =>
  typeof doc?.batchSize === "number" ? doc.batchSize : typeof doc?.cursor?.batchSize === "number" ? doc.cursor.batchSize : null;

// Walk a filter looking for a predicate matching `pred`, at any depth.
function findIn(filter, pred, depth = 0) {
  if (!filter || typeof filter !== "object" || depth > 6) return null;
  for (const [k, v] of Object.entries(filter)) {
    const hit = pred(k, v);
    if (hit) return hit;
    if (v && typeof v === "object") {
      const sub = Array.isArray(v)
        ? v.map((s) => findIn(s, pred, depth + 1)).find(Boolean)
        : findIn(v, pred, depth + 1);
      if (sub) return sub;
    }
  }
  return null;
}

// Footguns: things visible in the command itself that reliably cause pain.
// Each returns a short note shown next to the row. Ordered by severity — the
// first hit wins, so the worst thing about a command is what gets surfaced.
//
// Deliberately NOT included: "this query has no index". We can't see indexes
// from the wire, and claiming it would be the kind of overreach that makes an
// engineer stop believing the other flags.
export function footgunOf(cmd, doc, filter) {
  // $where runs server-side JavaScript per document. It cannot use an index
  // and it is a documented injection surface.
  if (findIn(filter, (k) => (k === "$where" ? true : null))) {
    return "$where runs JS per document and can't use an index";
  }
  if (doc && "$where" in doc) {
    return "$where runs JS per document and can't use an index";
  }

  // An unanchored regex scans every document; an anchored one (/^foo/) can use
  // an index prefix. The distinction is the whole point of flagging it.
  const rx = findIn(filter, (k, v) => {
    if (v && typeof v === "object" && "$regex" in v) {
      const pat = typeof v.$regex === "string" ? v.$regex : v.$regex?.$regex;
      if (typeof pat === "string" && !pat.startsWith("^")) return pat;
    }
    return null;
  });
  if (rx) return "unanchored $regex scans the collection";

  // A large $in list expands into that many index lookups.
  const big = findIn(filter, (k, v) => {
    if (v && typeof v === "object" && Array.isArray(v.$in) && v.$in.length > 200) return v.$in.length;
    return null;
  });
  if (big) return `$in with ${big} values`;

  // An empty filter with no limit reads the whole collection.
  const empty = !filter || Object.keys(filter).length === 0;
  if ((cmd === "find" || cmd === "count") && empty && !limitOf(doc)) {
    return "no filter and no limit — reads the whole collection";
  }

  // A multi-document delete or update with an empty predicate hits everything.
  if (cmd === "delete" && empty) return "delete with an empty filter matches every document";
  if (cmd === "update" && empty) {
    const u = Array.isArray(doc?.updates) ? doc.updates[0] : null;
    if (u?.multi) return "multi-update with an empty filter matches every document";
  }

  // allowDiskUse means the pipeline is expected to exceed the 100MB in-memory
  // limit — worth knowing, not necessarily wrong.
  if (cmd === "aggregate" && doc?.allowDiskUse === true) {
    return "aggregate spilling to disk (allowDiskUse)";
  }

  // $lookup is a per-document join; without a pipeline-side match it's O(n·m).
  if (cmd === "aggregate" && Array.isArray(doc?.pipeline)) {
    if (doc.pipeline.some((s) => s && typeof s === "object" && "$lookup" in s)) {
      return "$lookup joins per input document";
    }
  }

  return null;
}

export { limitOf, batchOf };

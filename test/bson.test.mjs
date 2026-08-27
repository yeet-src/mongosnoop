// Round-trip test for lib/bson.js.
//
// There is no MongoDB on this machine, so instead of trusting a hand-written
// hex blob this builds real OP_MSG messages with a from-scratch BSON ENCODER
// (independent of the decoder) and checks the decoder recovers what went in.
// An encoder bug and a decoder bug would have to be exactly inverse to cancel.
import { parseOpMsg, filterOf, shapeString, valuesOf, fmtValue } from "../src/lib/bson.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);

// ── a minimal, independent BSON encoder ────────────────────────────────────
const cstr = (s) => { const b = [...Buffer.from(s, "utf8")]; b.push(0); return b; };
const i32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];
const i64 = (n) => { const out = []; let v = BigInt(n); for (let i = 0; i < 8; i++) { out.push(Number(v & 255n)); v >>= 8n; } return out; };
const str = (s) => { const b = [...Buffer.from(s, "utf8")]; return [...i32(b.length + 1), ...b, 0]; };

class OID { constructor(hex) { this.hex = hex; } }
class Rx { constructor(p, o = "") { this.p = p; this.o = o; } }

function elem(key, v) {
  if (v === null) return [0x0a, ...cstr(key)];
  if (typeof v === "boolean") return [0x08, ...cstr(key), v ? 1 : 0];
  if (typeof v === "string") return [0x02, ...cstr(key), ...str(v)];
  if (typeof v === "bigint") return [0x12, ...cstr(key), ...i64(v)];
  if (typeof v === "number") {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) return [0x10, ...cstr(key), ...i32(v)];
    const b = Buffer.alloc(8); b.writeDoubleLE(v); return [0x01, ...cstr(key), ...b];
  }
  if (v instanceof OID) return [0x07, ...cstr(key), ...Buffer.from(v.hex, "hex")];
  if (v instanceof Rx) return [0x0b, ...cstr(key), ...cstr(v.p), ...cstr(v.o)];
  if (Array.isArray(v)) { const d = {}; v.forEach((x, i) => (d[i] = x)); return [0x04, ...cstr(key), ...doc(d)]; }
  if (typeof v === "object") return [0x03, ...cstr(key), ...doc(v)];
  throw new Error("unencodable " + typeof v);
}
function doc(o) {
  const body = Object.entries(o).flatMap(([k, v]) => elem(k, v));
  const len = body.length + 5;
  return [...i32(len), ...body, 0];
}
// Wrap a command document as a full OP_MSG wire message.
function opmsg(o, requestId = 7) {
  const section = [0, ...doc(o)];          // flagBits handled below
  const payload = [...i32(0), ...section]; // flagBits=0, kind=0, body
  const total = 16 + payload.length;
  return Uint8Array.from([...i32(total), ...i32(requestId), ...i32(0), ...i32(2013), ...payload]);
}

console.log("\nOP_MSG decode");
{
  const m = opmsg({ find: "orders", filter: { customer_id: new OID("65f1a2b3c4d5e6f708192a3b"), status: "pending" }, limit: 20, $db: "shop" });
  const p = parseOpMsg(m, m.length);
  eq("cmd", p.cmd, "find");
  eq("coll", p.coll, "orders");
  eq("db", p.db, "shop");
  eq("not truncated", p.truncated, false);
  eq("limit survives", p.doc.limit, 20);
  const f = filterOf("find", p.doc);
  eq("shape", shapeString(f), "{customer_id, status}");
  const vals = valuesOf(f).map((v) => `${v.field}=${fmtValue(v.value)}`);
  eq("values", vals, ['customer_id=ObjectId(65f1a2b3…2a3b)', 'status="pending"']);
}

console.log("\nshape is order-independent");
{
  const a = opmsg({ find: "orders", filter: { status: "x", customer_id: 1 }, $db: "shop" });
  const b = opmsg({ find: "orders", filter: { customer_id: 2, status: "y" }, $db: "shop" });
  const sa = shapeString(filterOf("find", parseOpMsg(a, a.length).doc));
  const sb = shapeString(filterOf("find", parseOpMsg(b, b.length).doc));
  eq("same shape, different key order", sa, sb);
  eq("shape text", sa, "{customer_id, status}");
}

console.log("\noperators are kept in the shape");
{
  const m = opmsg({ find: "events", filter: { ts: { $gt: 100, $lt: 200 }, kind: { $in: [1, 2, 3] } }, $db: "log" });
  const f = filterOf("find", parseOpMsg(m, m.length).doc);
  eq("operator shape", shapeString(f), "{kind $in, ts $gt $lt}");
}

console.log("\nnested $and / $or");
{
  const m = opmsg({ find: "u", filter: { $or: [{ a: 1 }, { b: { $gte: 2 } }] }, $db: "d" });
  const f = filterOf("find", parseOpMsg(m, m.length).doc);
  eq("logical shape", shapeString(f), "{$or(a,b $gte)}");
}

console.log("\nother command forms");
{
  const u = opmsg({ update: "users", updates: [{ q: { _id: new OID("65f1a2b3c4d5e6f708192a3b") }, u: { $set: { n: 1 } }, multi: false }], $db: "app" });
  const pu = parseOpMsg(u, u.length);
  eq("update cmd", pu.cmd, "update");
  eq("update shape", shapeString(filterOf("update", pu.doc)), "{_id}");

  const a = opmsg({ aggregate: "sales", pipeline: [{ $match: { region: "eu" } }, { $group: { _id: "$k" } }], cursor: {}, $db: "app" });
  const pa = parseOpMsg(a, a.length);
  eq("aggregate cmd", pa.cmd, "aggregate");
  eq("aggregate $match shape", shapeString(filterOf("aggregate", pa.doc)), "{region}");

  const i = opmsg({ insert: "logs", documents: [{ a: 1 }], $db: "app" });
  eq("insert cmd", parseOpMsg(i, i.length).cmd, "insert");
}

console.log("\nempty filter is a scan, and says so");
{
  const m = opmsg({ find: "big", filter: {}, $db: "d" });
  eq("empty shape", shapeString(filterOf("find", parseOpMsg(m, m.length).doc)), "{}");
}

console.log("\nTRUNCATION — the kernel window cuts mid-document");
{
  const big = {};
  for (let i = 0; i < 40; i++) big[`field_${i}`] = `value_${i}_padding_padding`;
  const m = opmsg({ find: "wide", filter: big, $db: "shop" });
  ok("message exceeds the 192B window", m.length > 192);
  const win = m.subarray(0, 192);
  const p = parseOpMsg(win, 192);
  eq("verb still recovered", p.cmd, "find");
  eq("collection still recovered", p.coll, "wide");
  eq("flagged truncated", p.truncated, true);
  ok("partial filter fields recovered", Object.keys(p.doc.filter ?? {}).length > 0);
  ok("no throw on truncated read", true);
}

console.log("\nfuzz: random truncation never throws");
{
  const m = opmsg({ find: "orders", filter: { a: 1, b: "two", c: new OID("65f1a2b3c4d5e6f708192a3b"), d: [1, 2, 3], e: { $gt: 9 } }, $db: "shop" });
  let threw = 0;
  for (let n = 0; n <= m.length; n++) {
    try { const p = parseOpMsg(m.subarray(0, n), n); shapeString(filterOf(p.cmd, p.doc)); valuesOf(filterOf(p.cmd, p.doc)); }
    catch (e) { threw++; if (threw === 1) console.log(`       first throw at n=${n}: ${e.message}`); }
  }
  eq("throws across every prefix length", threw, 0);
}

console.log("\nfuzz: random bytes never throw");
{
  let threw = 0;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0; t < 400; t++) {
    const n = 16 + Math.floor(rnd() * 200);
    const b = Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
    try { const p = parseOpMsg(b, n); shapeString(filterOf(p.cmd, p.doc)); valuesOf(filterOf(p.cmd, p.doc)); }
    catch (e) { threw++; if (threw === 1) console.log(`       first throw: ${e.message}`); }
  }
  eq("throws on random input", threw, 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

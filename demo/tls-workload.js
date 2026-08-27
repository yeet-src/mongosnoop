// TLS-side workload: a payments service reading an encrypted cluster.
//
// Produces the three things mongosnoop exists to show — an N+1 loop, a few
// distinct query shapes, and each of the footguns — all inside TLS, so the
// socket probes see none of it and the 🔒 rows prove the uprobe path is live.
//
// Driven by demo/tls-run.sh; not meant to be run directly.
const d = db.getSiblingDB("payments");

if (d.charges.countDocuments({}) < 300) {
  d.charges.drop();
  const docs = [];
  for (let i = 0; i < 300; i++) {
    docs.push({
      tenant_id: i % 25,
      status: i % 4 ? "settled" : "pending",
      amount: (i * 17) % 5000,
      memo: "charge " + i,
    });
  }
  d.charges.insertMany(docs);
}

// The N+1: one query per tenant, in a loop. This is the pattern the feed
// renders as literal repetition — shape constant, only the value moving.
for (let t = 0; t < 25; t++) {
  d.charges.find({ tenant_id: t, status: "pending" }).toArray();
  sleep(40);
}

// A range query, for shape variety against the N+1.
d.charges.find({ amount: { $gt: 1000, $lt: 3000 } }).toArray();
sleep(120);

// The footguns, spaced so they don't dominate the feed.
d.charges.find({}).toArray();                                  // whole collection
sleep(150);
d.charges.find({ memo: { $regex: "charge 1" } }).toArray();    // unanchored regex
sleep(150);
d.charges.find({ $where: "this.amount > 4500" }).toArray();    // server-side JS
sleep(200);

d.charges.updateOne({ tenant_id: 3 }, { $set: { status: "settled" } });

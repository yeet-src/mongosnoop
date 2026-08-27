// Traffic generator for the mongosnoop TUI. Runs against a throwaway `shop`
// database and produces the shapes the tool is built to surface — an N+1 loop,
// point lookups, range queries, writes, an aggregation, and each of the
// footguns — so the feed has something honest to show.
//
// Driven by demo/run.sh; not meant to be run directly.
const d = db.getSiblingDB("shop");

const CUSTOMERS = 40;
const ORDERS = 400;

if (d.orders.countDocuments({}) < ORDERS) {
  d.orders.drop();
  const docs = [];
  for (let i = 0; i < ORDERS; i++) {
    docs.push({
      customer_id: i % CUSTOMERS,
      status: i % 3 ? "pending" : "shipped",
      total: (i * 37) % 900,
      note: "order " + i,
      created: new Date(),
    });
  }
  d.orders.insertMany(docs);
  print("[demo] seeded " + ORDERS + " orders");
}

const ids = d.orders.find({}, { _id: 1 }).limit(20).toArray().map((o) => o._id);

print("[demo] generating traffic — Ctrl-C to stop");
while (true) {
  // The N+1: the same shape over and over, only the value changing. This is
  // the pattern the feed makes visible as literal repetition.
  for (let i = 0; i < CUSTOMERS; i++) {
    d.orders.find({ customer_id: i, status: "pending" }).toArray();
    sleep(15);
  }

  // Point lookups by _id — a different shape, correctly kept separate.
  for (const id of ids) {
    d.orders.find({ _id: id }).toArray();
    sleep(10);
  }

  // Range query: an operator shape.
  d.orders.find({ total: { $gt: 100, $lt: 500 } }).toArray();

  // Writes.
  d.orders.updateOne({ customer_id: 3 }, { $set: { status: "shipped" } });
  d.orders.insertOne({ customer_id: 7, status: "pending", total: 42, note: "fresh" });
  d.orders.deleteOne({ note: "fresh" });

  // An aggregation with a $match stage.
  d.orders.aggregate([
    { $match: { status: "pending" } },
    { $group: { _id: "$customer_id", n: { $sum: 1 } } },
  ]).toArray();

  // The footguns, one of each, spaced out so they don't dominate.
  sleep(300);
  d.orders.find({}).toArray();                              // no filter, no limit
  sleep(300);
  d.orders.find({ note: { $regex: "order 1" } }).toArray(); // unanchored regex
  sleep(300);
  d.orders.find({ $where: "this.total > 800" }).toArray();  // server-side JS
  sleep(700);
}

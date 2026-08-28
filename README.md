<!-- yeet:user-friendly-title: Watch MongoDB queries -->
# `mongosnoop`

> **`tcpdump` for your MongoDB queries.** Every command your applications send — the verb, the collection, the *query shape*, the concrete filter values, and the real round-trip latency — read off the wire with eBPF, and read **inside TLS** where the wire is encrypted. No profiler to enable, no driver instrumentation, no cooperation from the app or the database.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20%2B%20eBPF-8A2BE2" alt="yeet + eBPF">
  <img src="https://img.shields.io/badge/license-Dual%20BSD%2FGPL-3DA639" alt="Dual BSD/GPL">
  <a href="https://discord.gg/JxVseaAVAU"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

**`mongosnoop` shows what your application is actually doing to MongoDB.** Each row is one command with its **query shape** — the filter with every value stripped, so `{customer_id: ObjectId(…), status: "pending"}` becomes `{customer_id, status}` — and the concrete values on the line beneath it. When the same shape repeats, the rows collapse into a single block with a continuation rail, so a query running inside a loop reads as *one thing happening twenty-five times* instead of twenty-five rows you have to notice are identical.

> [!TIP]
> **The shape is the point.** MongoDB's slow-query log tells you a query was slow. It can't easily tell you the same query ran two hundred times in one request. Grouping by shape is what turns a wall of `find` calls into "this is an N+1", and keeping the values beside it is what tells you *which* documents it was chasing when it got slow.

## Quick start

```sh
curl -fsSL https://yeet.cx | sh              # install the yeet daemon (one time)
yeet run github:yeet-src/mongosnoop          # run the dashboard (the daemon does the privileged BPF load)
```
<sub>[Manual install guide](https://yeet.cx/docs/manual-installation) | Linux only</sub>

Nothing to configure for plaintext traffic — start your app and rows land at the top. For a **TLS** cluster, point it at the client's crypto library or binary; see [Reading encrypted traffic](#reading-encrypted-traffic).

No MongoDB handy? [The bundled demo](#try-it-without-real-traffic) stands one up and drives it.

## Controls

The feed follows the newest command by default; move the cursor off the top row and the view **holds**, so history stays still while commands keep arriving underneath.

| key | action |
| --- | ------ |
| `↑`/`↓`, `k`/`j` | move the cursor (holds the view once you leave the newest row) |
| `Enter` | open the detail overlay for the selected command |
| `f` | show only commands that tripped a [footgun](#what-gets-flagged) |
| `n` | show driver chatter (`hello`, `ping`, handshakes) — hidden by default |
| `/` | fuzzy filter — matches process, verb, namespace, shape, and the filter values |
| `p` | pause; `g` jumps back to the newest and resumes following |
| `q` / `Esc` | quit (`Esc` closes the overlay or clears the filter first) |

## What you're looking at

```
src process      command       namespace                 query shape           resp  latency
tls mongosh/8875 find          payments.charges        ├{status, tenant_id}   383B    1.3ms
                                                         tenant_id=14  status="pending"
tls mongosh/8875 find          payments.charges        │                      383B    1.4ms
                                                       │ tenant_id=13  status="pending"
tls mongosh/8875 find          payments.charges        │                      383B    917µs
                                                       │ tenant_id=12  status="pending"
    node/4471    find          payments.charges        ├{$where}              2.8K   65.6ms
                                                         $where="this.amount > 4500"
                                                         ⚠ $where runs JS per document and can't use an index
```

| column | meaning |
| --- | --- |
| `src` | `tls` when the command was read inside an encrypted connection; blank when it was read off the socket in plaintext |
| `process` | the client process — several apps sharing one cluster stay distinguishable |
| `command` | the MongoDB verb (`find`, `insert`, `aggregate`, `update`, …), coloured by read/write and red when flagged |
| `namespace` | `db.collection`. A trailing `~` means the database was [inferred](#honest-caveats), not read off this command |
| `query shape` | the filter with values stripped. `{}` is a real answer: no predicate at all |
| `resp` | bytes the server sent back — the cheapest proxy for "how much did this actually return" |
| `latency` | request → reply round trip, heat-coloured on a log scale |

The `├` and `│` rail is the repeat marker. A run of the same verb + shape + namespace **within one process** states its shape once and then draws a rail, so the block's height is the repeat count. The `↳` line carries the concrete filter values; a red `⚠` line names the problem when a command trips a footgun.

### The detail overlay

`Enter` opens one command in full, and adds the thing the feed can't show — every other run of that same shape:

- **This command**: verb, namespace, shape, process, latency, bytes sent and received, `requestID`, `limit`/`batchSize`.
- **Every filter value** in full, unclipped.
- **Across every run of this shape against this namespace**: the run count, the processes issuing it, **p50 / p95 / p99 / max** latency, how many runs tripped a footgun, and a sparkline of the most recent runs oldest → newest.
- **The command document** as captured, nested, with BSON scalars in their tagged form.

The command you opened is a frozen snapshot, but the cross-run panel reads the live log — so a hot shape's percentiles keep moving while you watch. That's what separates "this shape is always slow" from "that one run was unlucky".

## What gets flagged

A footgun is something visible **in the command itself** that reliably causes pain:

| flag | why |
| --- | --- |
| `$where` | runs server-side JavaScript per document and cannot use an index |
| unanchored `$regex` | scans the collection; an anchored `/^foo/` can use an index prefix, and is deliberately *not* flagged |
| `find`/`count` with no filter and no limit | reads the whole collection |
| `delete`, or multi-`update`, with an empty filter | matches every document |
| `aggregate` with `allowDiskUse` | the pipeline expects to exceed the 100 MB in-memory limit |
| `$lookup` in a pipeline | joins per input document |

> [!IMPORTANT]
> **"This query has no index" is deliberately absent.** Index usage is a property of the server's execution plan, which the wire does not carry — that's what `explain` is for. Every flag above is a fact about the command as sent. A false alarm erodes trust faster than a missed one.

## Reading encrypted traffic

The socket probes see nothing once a connection is encrypted, so a second pair of probes reads the same bytes at the TLS boundary — `SSL_write` before encryption, `SSL_read` after decryption. Same parser, same correlation, same analysis; the rows are tagged `tls` and the title bar shows the split.

A BPF program attaches **once**, so there is one target, chosen with `--tls-binary`:

```sh
yeet run . -- --tls-binary libssl.so            # the default: every dynamically-linked client at once
yeet run . -- --tls-binary "$(command -v node)" # a statically-linked runtime, by path
yeet run . -- --tls-binary auto                 # discover a running Node-family binary and use it
```

| client | how it's covered |
| --- | --- |
| Python (`pymongo`), distro-packaged Node, .NET | the system OpenSSL — `libssl.so`, the default |
| Node's official builds, and `mongosh` | their own binary. They statically link BoringSSL, which keeps the OpenSSL symbol names and is not stripped, so `SSL_write` is a global symbol in the executable itself |
| **Go** (`mongo-driver`) | **not covered.** `crypto/tls` is pure Go — there is no C symbol to hook |
| **Java** | **not covered.** JSSE lives inside the JVM |

> [!WARNING]
> A uprobe only fires for processes that start **after** it attaches. Start `mongosnoop` first, then your workload — a client already running when you attach is invisible.

## How it works

The core is [`src/bpf/mongo.bpf.c`](src/bpf/mongo.bpf.c) (kernel) and [`src/probes/mongo.js`](src/probes/mongo.js) (userspace), correlated by the wire protocol's own request id.

### Correlating on `requestID`, not on the socket

Every MongoDB message opens with a 16-byte header: `messageLength`, `requestID`, `responseTo`, `opCode`. A request carries a fresh `requestID`; the reply echoes it back in `responseTo`.

That matters because drivers **pipeline** several in-flight commands over one pooled connection. Pairing "the next reply on this socket" mismatches under exactly the concurrency you care about, so a request is stashed under `(pid, requestID)` and the reply looks it up — correct even with four commands outstanding on one socket, and correct across two clients whose request ids both start at 1.

### The BPF side

Five programs, one ring buffer, each event tagged with the source it came from:

| Program | Attached to | What it captures |
|---|---|---|
| `on_sendmsg` | `tcp_sendmsg` | a command going out in plaintext: header, verb, collection, and a raw window of the BSON body |
| `on_recvmsg` / return | `tcp_recvmsg` | the reply; reads `responseTo` and pairs it for the round-trip latency |
| `on_ssl_write` | `SSL_write` | the same, read from the app's own buffer **before** encryption |
| `on_ssl_read` / return | `SSL_read` | the reply **after** decryption, so TLS rows carry real latency rather than none |

### Keeping the kernel dumb

BSON is a binary format of typed, variable-length elements. Walking one properly means unbounded loops the verifier rejects, so the kernel does the minimum: it lifts the command verb and collection, which sit at a shallow near-fixed offset, validates the header against the write size, and copies a fixed **192-byte window** of the body. Every typed-element walk, shape extraction, value decode and footgun check happens in JS in [`src/lib/bson.js`](src/lib/bson.js), where a cursor is just a cursor.

The header validation is load-bearing: `messageLength` must match the write and `responseTo` must be zero on a request. Without it a TCP segment that split mid-message, or an HTTPS call from the same process, parses into a garbage verb and pollutes the feed.

### The JS side

| file | responsibility |
|---|---|
| [`src/probes/probe.js`](src/probes/probe.js) | loads `bin/probe.bpf.o`, binds the maps |
| [`src/probes/mongo.js`](src/probes/mongo.js) | the only BPF-aware module: chooses the TLS target, folds the ring buffer into an append-only log of completed commands, exposes the `commands`, `stats` and `status` signals |
| [`src/main.jsx`](src/main.jsx) | composition root: view state, input, `mount` |
| [`src/components/commands.jsx`](src/components/commands.jsx) | the feed — shape, values, footguns, and the repeat rail |
| [`src/components/detail.jsx`](src/components/detail.jsx) | the overlay — this command, and cross-run percentiles for its shape |
| [`src/components/titlebar.jsx`](src/components/titlebar.jsx) | totals, rates, the read/write and encrypted/plaintext splits, footgun count |
| [`src/lib/bson.js`](src/lib/bson.js) | the BSON cursor, shape extraction, value formatting |
| [`src/lib/classify.js`](src/lib/classify.js) | reads vs writes, driver chatter, the footgun rules |
| [`src/lib/format.js`](src/lib/format.js) | the palette and pure formatters |
| [`src/lib/fuzzy.js`](src/lib/fuzzy.js) | subsequence match over process, verb, namespace, shape and values |

The model is an append-only **log of completed commands**, not a mutable per-shape aggregate. A command is frozen the instant its reply pairs and is never touched again, so a row on screen never changes or jumps, and re-running a shape *appends* rather than updating — which is what makes a loop visible as repetition. A 250 ms window timer publishes one snapshot per frame, so a busy ring buffer costs one re-render rather than thousands.

### Why the wire, not the profiler

MongoDB's database profiler is server-side, off by default, samples at a threshold, and needs write access to the database you're debugging. It also can't see the client: which process issued a query, or that one request produced two hundred of them.

The socket and the TLS boundary are the seams where *every* client hands a command to the database, before any of that. One run covers every process on the host with no per-app setup, no restarts, and nothing asked of the server.

## Testing across kernels

A program that loads on your laptop can be rejected by an older kernel's verifier. [`.github/workflows/kernel-matrix.yml`](.github/workflows/kernel-matrix.yml) guards against that: for each kernel in its matrix it builds the object, boots that kernel in a VM ([cilium's little-vm-helper](https://github.com/cilium/little-vm-helper), images from `quay.io/lvh-images`), and runs a vendored static **veristat** against it — failing the job if the verifier rejects any program. The in-VM gate is [`build/verify-kernel.sh`](build/verify-kernel.sh), and [`build/kernel-matrix.sh`](build/kernel-matrix.sh) drives the same boot locally.

## Requirements

> [!IMPORTANT]
> - **A Linux kernel with BTF** (`CONFIG_DEBUG_INFO_BTF`) for CO-RE — `bpftool` generates `src/bpf/include/vmlinux.h` from it. Default on current Arch, Fedora, Ubuntu, and Debian.
> - **The yeet daemon**, which performs the privileged BPF load. `curl -fsSL https://yeet.cx | sh` installs it.
>
> To build from source you also need `clang` and `bpftool` — the vendored static toolchain supplies them, so no system C/BPF toolchain is needed. No node/npm: esbuild is vendored and the project has no third-party deps.

## Honest caveats

> [!NOTE]
> `mongosnoop` is observability, not enforcement. It shows you what was sent; it does not block, delay, or alter any command.

- **Go and Java clients over TLS are invisible.** Their TLS lives in pure Go and in the JVM respectively, with no C symbol to hook. Plaintext connections from those clients are captured normally. This is the biggest gap, and it means a Go service against Atlas shows nothing.
- **Large commands are truncated.** The kernel copies a fixed 192-byte window, so a bulk insert carrying documents is cut off. The verb, collection and latency are always right; the shape may be partial, and those commands are marked in the overlay. Widening the window can't fix the general case, since a payload is unbounded.
- **The database name is often inferred.** `$db` is appended *after* the operation's own fields, so on a large command it falls outside the window. It's learned from earlier commands on the same collection in the same process and marked with a trailing `~` — an inference, flagged as one, never presented as read.
- **Index usage is not visible.** Nothing here claims a query did or didn't use an index; the wire doesn't carry the plan. Use `explain` for that.
- **Compressed connections aren't decoded.** Drivers can negotiate zstd/snappy; those commands are labelled `«compressed»` rather than silently dropped.
- **A uprobe only sees processes that start after it attaches.** Clients already running are invisible until they restart.
- **No retention.** The most recent 2000 commands, on one host, gone when you quit. This is a live-debugging instrument, not an APM — reach for it when the APM has told you the database is slow and you need to see the actual queries.
- **`comm` is 16 bytes.** Long process names are truncated by the kernel, not by mongosnoop.

## Community questions

**Does it slow the application or the database down?**
No meaningful overhead, and nothing is asked of the server. The probes are passive; the cost is a bounded ring-buffer write per command, and the ring buffer drops rather than blocks if userspace falls behind.

**Do I need to change my application, or enable the profiler?**
Neither. It reads the socket and the TLS boundary, so the app and the database both run exactly as they would if the tool weren't there.

**Is it safe to run against production?**
The capture path is read-only and passive. Treat the *output* the way you'd treat query metadata: it shows the concrete values your application filters on, which for some collections is sensitive.

**Will it work against MongoDB Atlas?**
Only for clients whose TLS is hookable — Python, .NET, and Node via its binary. Atlas is TLS-always, so a Go or Java service against Atlas shows nothing.

**Can I export the feed?**
Not built in. The `RingBuf.subscribe` callback in `probes/mongo.js` holds every decoded record, so a JSON/HTTP/Kafka sink is a branch there. To set up a managed pipeline, [contact us](https://yeet.cx/).

## Try it without real traffic

Two demos, each standing up its own throwaway MongoDB in Docker:

```sh
demo/run.sh        # plaintext on :27017
demo/tls-run.sh    # requireTLS on :27018, with a generated self-signed cert
```

Both drive a workload that produces an N+1 loop, a few distinct query shapes, and each of the footguns. The TLS one prints the exact `--tls-binary` invocation to pair with it. Start the dashboard **first**, then the demo.

## Building from source

```sh
make          # clang + bpftool → bin/probe.bpf.o ; esbuild → src/index.jsx
make bpf      # just the BPF object
make bundle   # just the JS bundle
make clean    # remove build artifacts
```

Then `yeet run .` runs the local build. `make` runs two independent compilers: **clang + bpftool** link `src/bpf/*.bpf.c` into `bin/probe.bpf.o`; **esbuild** bundles `src/main.jsx` into `src/index.jsx`, resolving the `@/` (source root) and `#/` (project root) **bundle-time aliases** via tsconfig `paths` and leaving `yeet:*` builtins external. Both come from a vendored static toolchain. The generated `vmlinux.h`, `src/index.jsx`, and `bin/*.bpf.o` are build artifacts.

The BSON decoder has its own round-trip tests, which need no kernel and no database:

```sh
node test/bson.test.mjs
```

Because the aliases are bundle-time only, the runtime locates the BPF object with `import.meta.dirname` rather than an alias. See [`AGENTS.md`](AGENTS.md) (aka `CLAUDE.md`) for the yeet dashboard-authoring guide.

## License

Dual BSD/GPL. The BPF program declares `char LICENSE[] SEC("license") = "Dual BSD/GPL"` in [`src/bpf/mongo.bpf.c`](src/bpf/mongo.bpf.c), which the kernel requires for the helpers it uses.

---

Built with [yeet](https://yeet.cx/docs/), a JS runtime for writing eBPF programs on Linux. Join us on [Discord](https://discord.gg/JxVseaAVAU).

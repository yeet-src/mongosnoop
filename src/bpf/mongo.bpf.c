// mongosnoop — a live trace of MongoDB commands, read off the wire.
//
// MongoDB is a networked server, so there is no library seam to uprobe the way
// sqlitefeed hooks libsqlite3. The seam here is the socket, and the protocol
// hands us something better than a socket pointer to correlate on.
//
// The wire protocol (OP_MSG, the only opcode modern drivers send for commands)
// frames every message with a 16-byte header:
//
//   int32 messageLength | int32 requestID | int32 responseTo | int32 opCode
//
// A request carries a fresh `requestID` and `responseTo == 0`. The server's
// reply echoes that value back in `responseTo`. That is a real correlation id
// built into the protocol, and it is why this tool does NOT key on `sock *`
// the way a Redis snoop does: drivers pipeline several in-flight commands over
// one pooled connection, so "pair the next reply on this socket" mismatches
// under exactly the concurrency you care about. Keying on requestID is correct
// even when four commands are outstanding on the same socket.
//
//   tcp_sendmsg(sk, msg, size)      — a command goes out. Parse the header,
//                                     lift the command verb + collection out
//                                     of the leading BSON, stash {ts, ...}
//                                     keyed by requestID.
//   tcp_recvmsg(sk, msg, len, ...)  — entry only records where the reply buffer
//                                     will land; the bytes are not there yet.
//   tcp_recvmsg return              — the reply has been copied. Read the
//                                     header, take `responseTo`, look up the
//                                     stashed request, emit one event with the
//                                     true round trip.
//
// THE KERNEL STAYS DUMB. BSON is a length-prefixed binary format with typed,
// variable-length elements; walking it properly means unbounded loops the
// verifier will reject. So we lift only what sits at a shallow, near-fixed
// offset (the command verb and its collection, which are the first element of
// the body document) and copy a raw window of the body for userspace to parse.
// Shape extraction, value decoding and footgun analysis all happen in JS, in
// lib/bson.js, where a real BSON walker is straightforward.
//
// The runtime knob `min_latency_us` is the kernel-side slow-command floor:
// userspace patches it live (via DataSec) and we only emit commands at least
// that slow, so raising the bar on a busy cluster keeps the ring buffer calm
// instead of filtering after the fact in JS.
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "Dual BSD/GPL";

#define TASK_COMM_LEN 16
#define CMD_LEN       24  // longest command verb we keep ("findAndModify" fits)
#define NS_LEN        48  // "db.collection", truncated
#define BODY_LEN      192 // raw BSON window handed to userspace to parse

// MongoDB wire opcodes. OP_MSG is everything modern; the others are recognised
// only so we can label traffic we deliberately don't decode rather than drop it
// silently and look like we missed it.
// How a command was observed. The plaintext socket path and the TLS path feed
// the same ring buffer and the same analysis; only the tag differs, so the UI
// can show the split and an engineer can tell at a glance that encrypted
// traffic is actually being read.
#define SRC_WIRE 0 // tcp_sendmsg/tcp_recvmsg — plaintext on the wire
#define SRC_TLS  1 // SSL_write/SSL_read — read INSIDE encrypted connections

#define OP_MSG        2013
#define OP_COMPRESSED 2012
#define OP_QUERY      2004 // legacy, pre-3.6 and the initial handshake
#define OP_REPLY      1

// Slow-command floor in microseconds, patched live from the UI. Default 0:
// emit everything until the user raises the bar. Kept in .data (volatile,
// referenced) so the bound section stays `<obj>.data`. Must match
// `minLatency`'s initial value in probes/mongo.js.
volatile __u64 min_latency_us = 0;

// One observed MongoDB command, streamed to userspace once its reply lands.
struct mongo_event {
	__u32 pid;
	__u32 tid;
	__u32 lat_us;             // request -> reply round trip
	__u32 req_bytes;          // request message length, per the header
	__u32 resp_bytes;         // reply message length, per the header
	__u32 request_id;         // the protocol's own correlation id
	__u32 opcode;             // OP_MSG | OP_COMPRESSED | OP_QUERY
	__u32 body_len;           // valid bytes in `body`
	__u32 source;             // SRC_WIRE | SRC_TLS
	char comm[TASK_COMM_LEN]; // client process
	char cmd[CMD_LEN];        // command verb: find, insert, aggregate, ...
	char ns[NS_LEN];          // "db.collection", assembled in userspace-friendly form
	__u8 body[BODY_LEN];      // raw BSON window — parsed in JS, never here
};

// Force BTF emission so the daemon resolves btf_struct: "mongo_event".
struct mongo_event *_unused_event __attribute__((unused));

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 512 * 1024);
} mongo_events SEC(".maps");

// A command that has been sent and is awaiting its reply, keyed by requestID.
struct inflight {
	__u64 ts;
	__u32 pid;
	__u32 tid;
	__u32 req_bytes;
	__u32 opcode;
	__u32 body_len;
	char comm[TASK_COMM_LEN];
	char cmd[CMD_LEN];
	char ns[NS_LEN];
	__u8 body[BODY_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	// Keyed by (pid << 32 | requestID), NOT requestID alone. Drivers restart
	// requestID at 1 per connection, so two short-lived clients collide and a
	// reply pairs against the wrong process's request — which shows up as an
	// absurd latency (a reply "answering" a request from seconds earlier).
	__type(key, __u64);
	__type(value, struct inflight);
} inflight SEC(".maps");

// Where a pending tcp_recvmsg will deposit its bytes, keyed by pid_tgid. The
// entry probe sees the buffer pointer but not the data; the return probe sees
// the length but no longer has the msghdr. One slot per thread, matching
// sqlitefeed's deliberate choice: a missed pairing costs one command and
// self-corrects, whereas a depth-counting stack drifts permanently once the
// kernel silently drops a return probe past maxactive.
struct recv_scratch {
	__u64 base; // user address the reply lands at
};

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, __u64); // pid_tgid
	__type(value, struct recv_scratch);
} recv_scratch SEC(".maps");

// The SSL_read equivalent of recv_scratch. Kept separate from the wire path's
// map so a process doing both plaintext and TLS on the same thread can't have
// one path clobber the other's pending buffer.
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 8192);
	__type(key, __u64); // pid_tgid
	__type(value, struct recv_scratch);
} ssl_recv_scratch SEC(".maps");

// The event we're building, kept in a per-CPU array rather than on the stack.
// `struct mongo_event` is well over the 512-byte BPF stack limit once the BSON
// window is in it, so it cannot be a local.
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct mongo_event);
} event_scratch SEC(".maps");

// Same reason: a scratch inflight for the send path.
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct inflight);
} fl_scratch SEC(".maps");

// Pull the user-buffer base out of a msghdr's iov_iter. Modern kernels store a
// single user buffer inline as ITER_UBUF (ptr in `ubuf`); a classic iovec array
// is ITER_IOVEC (ptr in `__iov->iov_base`). Driver writes land as either
// depending on kernel version and how the driver issues the write, so both are
// handled. This is the one fragile read here, and it is the same read
// redissnoop makes.
// A local mirror of the parts of `struct iov_iter` we read, declared with BOTH
// spellings of the iovec pointer. vmlinux.h is generated from the running
// kernel's BTF and carries only the name THAT kernel has, so naming the other
// one directly is a compile error rather than something CO-RE can resolve at
// load time. Declaring our own struct gives clang both names to compile
// against, and `preserve_access_index` lets CO-RE relocate whichever one the
// target kernel actually has.
//
// The rename landed in 6.4: `iov_iter.iov` became `__iov` when the union gained
// an anonymous wrapper. Without this, the object builds on 6.4+ and fails to
// compile on 6.1 — which is exactly what the kernel matrix caught.
struct iov_iter___compat {
	__u8 iter_type;
	union {
		void *ubuf;
		const struct iovec *iov;   // <= 6.3
		const struct iovec *__iov; // >= 6.4
	};
} __attribute__((preserve_access_index));

struct msghdr___compat {
	struct iov_iter___compat msg_iter;
} __attribute__((preserve_access_index));

static __always_inline const void *iter_base(struct msghdr *msg)
{
	struct msghdr___compat *m = (void *)msg;

	__u8 itype = BPF_CORE_READ(m, msg_iter.iter_type);
	if (itype == ITER_UBUF)
		return BPF_CORE_READ(m, msg_iter.ubuf);
	if (itype != ITER_IOVEC)
		return NULL;

	const struct iovec *iov = NULL;
	if (bpf_core_field_exists(m->msg_iter.__iov))
		iov = BPF_CORE_READ(m, msg_iter.__iov);
	else
		iov = BPF_CORE_READ(m, msg_iter.iov);

	if (!iov)
		return NULL;
	return BPF_CORE_READ(iov, iov_base);
}

// Little-endian int32 out of a byte window. The wire protocol is LE on every
// platform Mongo supports, so this is not an endianness guess.
static __always_inline __u32 le32(const __u8 *p)
{
	return (__u32)p[0] | ((__u32)p[1] << 8) | ((__u32)p[2] << 16) | ((__u32)p[3] << 24);
}

// Lift the command verb and its collection out of the front of an OP_MSG body.
//
// Layout we're walking, all at fixed offsets until the first cstring:
//
//   [0..3]   flagBits          (uint32)
//   [4]      section kind      (0 = body)
//   [5..8]   document length   (int32)
//   [9]      element type      (0x02 string = the common command form)
//   [10..]   element name      cstring  ← the command VERB ("find")
//   then     int32 strlen, then the string  ← the COLLECTION
//
// The verb is the first element's *name* and the collection is its *value*.
// That holds for find/insert/update/delete/aggregate/findAndModify/count/
// distinct — every command whose first field names a collection. Commands whose
// first element is not a string (e.g. `getMore`, an int64) still yield a correct
// verb; the collection is left empty and userspace fills it from the body window
// (getMore carries its collection in a later `collection` field).
//
// `db` is not in this prefix at all — it arrives as a `$db` field later in the
// document, which is exactly the kind of variable-offset walk we refuse to do in
// the kernel. Userspace stitches "db.collection" from the body window.
static __always_inline void parse_op_msg(const __u8 *buf, int len, struct inflight *fl)
{
	int i = 16;    // skip the wire header
	if (i + 6 > len) return;

	i += 4;        // flagBits
	__u8 kind = buf[i];
	i += 1;
	if (kind != 0) return; // section kind 1 = document sequence; verb isn't here

	i += 4;        // body document length
	if (i >= len) return;

	__u8 etype = buf[i];
	i += 1;

	// The element name is the command verb, NUL-terminated.
	int vi = 0;
	#pragma unroll
	for (int j = 0; j < CMD_LEN - 1; j++) {
		if (i >= len) return;
		__u8 c = buf[i];
		i++;
		if (c == 0) break;
		fl->cmd[vi] = (char)c;
		vi++;
	}

	// Only a string-valued first element carries the collection name.
	if (etype != 0x02) return;
	if (i + 4 > len) return;
	i += 4; // the string's own length prefix

	#pragma unroll
	for (int j = 0; j < NS_LEN - 1; j++) {
		if (i >= len) return;
		__u8 c = buf[i];
		i++;
		if (c == 0) break;
		fl->ns[j] = (char)c;
	}
}

SEC("kprobe/tcp_sendmsg")
int BPF_KPROBE(on_sendmsg, struct sock *sk, struct msghdr *msg, size_t size)
{
	// A wire header is 16 bytes; nothing smaller can be a command.
	if (size < 16)
		return 0;

	const void *base = iter_base(msg);
	if (!base)
		return 0;

	__u32 zero = 0;
	struct inflight *fl = bpf_map_lookup_elem(&fl_scratch, &zero);
	if (!fl)
		return 0;
	__builtin_memset(fl, 0, sizeof(*fl));

	if (bpf_probe_read_user(fl->body, BODY_LEN, base) != 0)
		return 0;

	// Validate this really is a Mongo message before believing any of it: the
	// header's messageLength must match the write, and responseTo must be 0 on
	// a request. Together these reject a TCP segment that split mid-message
	// and any non-Mongo traffic on the socket. Without this guard a stray
	// write parses into a garbage verb and pollutes the feed — the same class
	// of bug redissnoop's leading-'*' check exists to prevent.
	__u32 msg_len = le32(fl->body);
	if (msg_len != (__u32)size)
		return 0;

	__u32 request_id  = le32(fl->body + 4);
	__u32 response_to = le32(fl->body + 8);
	__u32 opcode      = le32(fl->body + 12);
	if (response_to != 0)
		return 0;
	if (request_id == 0)
		return 0;
	if (opcode != OP_MSG && opcode != OP_COMPRESSED && opcode != OP_QUERY)
		return 0;

	fl->ts        = bpf_ktime_get_ns();
	__u64 id      = bpf_get_current_pid_tgid();
	fl->pid       = id >> 32;
	fl->tid       = (__u32)id;
	fl->req_bytes = msg_len;
	fl->opcode    = opcode;
	fl->body_len  = size < BODY_LEN ? (__u32)size : BODY_LEN;
	bpf_get_current_comm(&fl->comm, sizeof(fl->comm));

	// Only OP_MSG has a body we can read. Compressed payloads are opaque here
	// (that's the point of the opcode) and legacy OP_QUERY has a different
	// layout; both are still tracked so their latency and their existence show
	// up, labelled by opcode in the UI rather than silently dropped.
	if (opcode == OP_MSG)
		parse_op_msg(fl->body, fl->body_len, fl);

	__u64 ikey = ((__u64)fl->pid << 32) | request_id;
	bpf_map_update_elem(&inflight, &ikey, fl, BPF_ANY);
	return 0;
}

// Entry: remember where the reply will be written. The bytes aren't there yet,
// so there is nothing to parse until the return probe.
SEC("kprobe/tcp_recvmsg")
int BPF_KPROBE(on_recvmsg, struct sock *sk, struct msghdr *msg, size_t len)
{
	const void *base = iter_base(msg);
	if (!base)
		return 0;

	struct recv_scratch rs = { .base = (__u64)base };
	__u64 key = bpf_get_current_pid_tgid();
	bpf_map_update_elem(&recv_scratch, &key, &rs, BPF_ANY);
	return 0;
}

// Return: the reply has been copied into the user buffer. Read its header,
// take `responseTo`, and pair it with the request that carried that requestID.
SEC("kretprobe/tcp_recvmsg")
int BPF_KRETPROBE(on_recvmsg_ret, int ret)
{
	__u64 key = bpf_get_current_pid_tgid();
	struct recv_scratch *rs = bpf_map_lookup_elem(&recv_scratch, &key);
	if (!rs)
		return 0;
	__u64 base = rs->base;
	bpf_map_delete_elem(&recv_scratch, &key);

	if (ret < 16) // no payload, or too short to be a wire header
		return 0;

	__u8 hdr[16];
	if (bpf_probe_read_user(hdr, sizeof(hdr), (const void *)base) != 0)
		return 0;

	__u32 resp_len    = le32(hdr);
	__u32 response_to = le32(hdr + 8);
	if (response_to == 0)
		return 0; // not a reply to anything we tracked

	__u64 ikey = ((__u64)(bpf_get_current_pid_tgid() >> 32) << 32) | response_to;
	struct inflight *fl = bpf_map_lookup_elem(&inflight, &ikey);
	if (!fl)
		return 0; // reply to a request sent before we attached

	__u64 lat_us = (bpf_ktime_get_ns() - fl->ts) / 1000;
	if (lat_us < min_latency_us) { // kernel-side slow-command floor
		bpf_map_delete_elem(&inflight, &ikey);
		return 0;
	}

	__u32 zero = 0;
	struct mongo_event *e = bpf_map_lookup_elem(&event_scratch, &zero);
	if (!e) {
		bpf_map_delete_elem(&inflight, &ikey);
		return 0;
	}

	e->pid        = fl->pid;
	e->tid        = fl->tid;
	e->lat_us     = (__u32)lat_us;
	e->req_bytes  = fl->req_bytes;
	e->resp_bytes = resp_len;
	e->request_id = response_to;
	e->opcode     = fl->opcode;
	e->body_len   = fl->body_len;
	e->source     = SRC_WIRE;
	__builtin_memcpy(e->comm, fl->comm, TASK_COMM_LEN);
	__builtin_memcpy(e->cmd, fl->cmd, CMD_LEN);
	__builtin_memcpy(e->ns, fl->ns, NS_LEN);
	__builtin_memcpy(e->body, fl->body, BODY_LEN);

	bpf_ringbuf_output(&mongo_events, e, sizeof(*e), 0);
	bpf_map_delete_elem(&inflight, &ikey);
	return 0;
}

// ─── TLS path ───────────────────────────────────────────────────────────────
//
// Everything above reads the socket, which means it sees nothing at all once
// the connection is encrypted. These two programs hook the TLS library instead,
// on the application's side of the encryption boundary: SSL_write is called
// with the plaintext the app wants to send, SSL_read returns the plaintext the
// app just received. Same OP_MSG bytes, same parser, same requestID pairing —
// the only difference is where the buffer comes from.
//
// Attaching is the interesting part, and it is handled in probes/mongo.js:
//
//   - Clients using the SYSTEM OpenSSL (Python's _ssl, distro Node, .NET) are
//     covered by one attach to libssl.so.
//   - Node's OFFICIAL builds statically link BoringSSL, so there is no libssl
//     to hook. BoringSSL keeps the OpenSSL symbol names, though, and the Node
//     binary is not stripped — `SSL_write` is a global text symbol in the
//     executable itself. So we attach per-binary instead. Verified against
//     mongosh 2.10.0: SSL_write at 0x1acf654, 1653 SSL symbols exported.
//
// Not covered: Go (crypto/tls is pure Go, no C symbol to hook) and Java (JSSE
// lives inside the JVM). Those are stated as limits, not worked around.
//
// Both programs pair through the SAME `inflight` map as the wire path, so a
// TLS command gets a real round-trip latency rather than the zero redissnoop's
// TLS rows carry — SSL_read is what makes that possible.

// int SSL_write(SSL *ssl, const void *buf, int num)
SEC("uprobe/SSL_write")
int BPF_UPROBE(on_ssl_write, void *ssl, const void *buf, int num)
{
	if (!buf || num < 16)
		return 0;

	__u32 zero = 0;
	struct inflight *fl = bpf_map_lookup_elem(&fl_scratch, &zero);
	if (!fl)
		return 0;
	__builtin_memset(fl, 0, sizeof(*fl));

	if (bpf_probe_read_user(fl->body, BODY_LEN, buf) != 0)
		return 0;

	// Same validation as the wire path: the header's messageLength must match
	// the write and responseTo must be zero on a request. This is what keeps
	// non-Mongo TLS traffic (an HTTPS call from the same process) out of the
	// feed — the uprobe fires for every TLS write the binary makes, not just
	// the database ones.
	__u32 msg_len = le32(fl->body);
	if (msg_len != (__u32)num)
		return 0;

	__u32 request_id  = le32(fl->body + 4);
	__u32 response_to = le32(fl->body + 8);
	__u32 opcode      = le32(fl->body + 12);
	if (response_to != 0 || request_id == 0)
		return 0;
	if (opcode != OP_MSG && opcode != OP_COMPRESSED && opcode != OP_QUERY)
		return 0;

	fl->ts        = bpf_ktime_get_ns();
	__u64 id      = bpf_get_current_pid_tgid();
	fl->pid       = id >> 32;
	fl->tid       = (__u32)id;
	fl->req_bytes = msg_len;
	fl->opcode    = opcode;
	fl->body_len  = (__u32)num < BODY_LEN ? (__u32)num : BODY_LEN;
	bpf_get_current_comm(&fl->comm, sizeof(fl->comm));

	if (opcode == OP_MSG)
		parse_op_msg(fl->body, fl->body_len, fl);

	// No separate "this was TLS" marker is needed: each emit path knows its own
	// source, because a request written through SSL_write is answered through
	// SSL_read and emitted by that retprobe as SRC_TLS.
	__u64 ikey = ((__u64)fl->pid << 32) | request_id;
	bpf_map_update_elem(&inflight, &ikey, fl, BPF_ANY);
	return 0;
}

// int SSL_read(SSL *ssl, void *buf, int num) — the buffer is filled on RETURN,
// so the entry probe only records where it will land.
SEC("uprobe/SSL_read")
int BPF_UPROBE(on_ssl_read, void *ssl, void *buf, int num)
{
	struct recv_scratch rs = { .base = (__u64)buf };
	__u64 key = bpf_get_current_pid_tgid();
	bpf_map_update_elem(&ssl_recv_scratch, &key, &rs, BPF_ANY);
	return 0;
}

SEC("uretprobe/SSL_read")
int BPF_URETPROBE(on_ssl_read_ret, int ret)
{
	__u64 key = bpf_get_current_pid_tgid();
	struct recv_scratch *rs = bpf_map_lookup_elem(&ssl_recv_scratch, &key);
	if (!rs)
		return 0;
	__u64 base = rs->base;
	bpf_map_delete_elem(&ssl_recv_scratch, &key);

	if (ret < 16)
		return 0;

	__u8 hdr[16];
	if (bpf_probe_read_user(hdr, sizeof(hdr), (const void *)base) != 0)
		return 0;

	__u32 resp_len    = le32(hdr);
	__u32 response_to = le32(hdr + 8);
	if (response_to == 0)
		return 0;

	__u64 ikey = ((__u64)(bpf_get_current_pid_tgid() >> 32) << 32) | response_to;
	struct inflight *fl = bpf_map_lookup_elem(&inflight, &ikey);
	if (!fl)
		return 0;

	__u64 lat_us = (bpf_ktime_get_ns() - fl->ts) / 1000;
	if (lat_us < min_latency_us) {
		bpf_map_delete_elem(&inflight, &ikey);
		return 0;
	}

	__u32 zero = 0;
	struct mongo_event *e = bpf_map_lookup_elem(&event_scratch, &zero);
	if (!e) {
		bpf_map_delete_elem(&inflight, &ikey);
		return 0;
	}

	e->pid        = fl->pid;
	e->tid        = fl->tid;
	e->lat_us     = (__u32)lat_us;
	e->req_bytes  = fl->req_bytes;
	e->resp_bytes = resp_len;
	e->request_id = response_to;
	e->opcode     = fl->opcode;
	e->body_len   = fl->body_len;
	e->source     = SRC_TLS;
	__builtin_memcpy(e->comm, fl->comm, TASK_COMM_LEN);
	__builtin_memcpy(e->cmd, fl->cmd, CMD_LEN);
	__builtin_memcpy(e->ns, fl->ns, NS_LEN);
	__builtin_memcpy(e->body, fl->body, BODY_LEN);

	bpf_ringbuf_output(&mongo_events, e, sizeof(*e), 0);
	bpf_map_delete_elem(&inflight, &ikey);
	return 0;
}

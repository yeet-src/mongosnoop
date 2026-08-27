// Shared BPF object. `src/bpf/mongo.bpf.c` is compiled to bin/probe.bpf.o and
// loaded once here; probes/mongo.js imports this `control` and subscribes to
// the ring buffer. All binds must happen before the single start(), so they
// live together in this file.
import { BpfObject } from "yeet:bpf";

// `base: import.meta.dirname` resolves against the running bundle.
const probe = new BpfObject({ exe: "../bin/probe.bpf.o", base: import.meta.dirname });

export const control = await probe
  .bind("mongo_events", { kind: "ringbuf", btf_struct: "mongo_event" }) // command stream
  .bind("probe.data", { kind: "data" }) // min_latency_us knob (.data section)
  .start(); // the kprobes auto-attach

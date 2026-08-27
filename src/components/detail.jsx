// Detail overlay for one command, opened with Enter on the selected row and
// dismissed with Esc. Four blocks: the command's identity, every filter value
// in full (the feed clips them), the full command document, and the cross-run
// panel aggregating every logged run of the same SHAPE against the same
// namespace.
//
// That last block is the reason the overlay exists. The feed answers "what is
// running"; this answers "is this shape always slow, or was this run unlucky",
// which is the question you actually have once you've spotted a repeated shape.
//
// Pure UI. The command `c` is a frozen snapshot passed in, so it never changes
// under you; the cross-run panel reads the live `commands` log, so a hot
// shape's percentiles keep moving while the overlay is open.
import { Box, Text } from "yeet:tui";
import {
  C_BAD, C_BRAND, C_DIM, C_FAINT, C_FIELD, C_NS, C_READ, C_SHAPE, C_TEXT,
  C_TITLE, C_VALUE, C_WARN, C_WRITE,
  fmtBytes, fmtDuration, heat, latFrac, pctl, sparkline,
} from "@/lib/format.js";

const kv = (label, value, fg = C_TEXT) => (
  <Text height="1" break="none">
    <Text fg={C_DIM}>{`${label}`.padEnd(14)}</Text>
    {typeof value === "string" ? <Text fg={fg}>{value}</Text> : value}
  </Text>
);

const section = (title) => <Text height="1" break="none" bold fg={C_BRAND}>{title}</Text>;
const blank = () => <Text height="1">{" "}</Text>;

// Render a command document as indented lines. This is a debugging view, so it
// favours completeness over polish: every field the window captured, nested,
// with BSON scalars shown in their tagged form.
function docLines(v, indent = 0, key = null, out = [], depth = 0) {
  const pad = "  ".repeat(indent);
  const label = key === null ? "" : `${key}: `;
  if (depth > 8) {
    out.push(`${pad}${label}…`);
    return out;
  }
  if (v === null) out.push(`${pad}${label}null`);
  else if (Array.isArray(v)) {
    if (!v.length) out.push(`${pad}${label}[]`);
    else {
      out.push(`${pad}${label}[`);
      v.slice(0, 20).forEach((x) => docLines(x, indent + 1, null, out, depth + 1));
      if (v.length > 20) out.push(`${pad}  … ${v.length - 20} more`);
      out.push(`${pad}]`);
    }
  } else if (v && typeof v === "object") {
    const keys = Object.keys(v);
    // A tagged BSON scalar prints inline rather than as a nested object.
    const TAGS = ["$oid", "$date", "$binary", "$regex", "$timestamp", "$code", "$decimal"];
    const tag = TAGS.find((t) => t in v);
    if (tag) {
      const inner = tag === "$binary" ? `${v.$binary.length}B` : `${v[tag]}`;
      out.push(`${pad}${label}${tag}(${inner})`);
    } else if (!keys.length) out.push(`${pad}${label}{}`);
    else {
      out.push(`${pad}${label}{`);
      keys.slice(0, 40).forEach((k) => docLines(v[k], indent + 1, k, out, depth + 1));
      if (keys.length > 40) out.push(`${pad}  … ${keys.length - 40} more`);
      out.push(`${pad}}`);
    }
  } else if (typeof v === "string") out.push(`${pad}${label}"${v}"`);
  else out.push(`${pad}${label}${v}`);
  return out;
}

export default function Detail({ c, commands, scroll }) {
  return (
    <Box height="1fr" direction="column" overflow="hidden" padding={1}>
      {() => {
        // Cross-run: every logged command with this shape against this ns.
        // Keying on both is what makes the aggregate meaningful — the same
        // shape against a different collection is a different query.
        const runs = commands.get().filter((r) => r.shape === c.shape && r.ns === c.ns);
        const lats = runs.map((r) => r.latUs).filter((n) => n > 0);
        const procs = [...new Set(runs.map((r) => r.comm))];
        const guns = runs.filter((r) => r.footgun).length;
        // Oldest → newest of the most recent runs.
        const recent = runs.slice(0, 48).reverse().map((r) => r.latUs);

        const out = [];

        out.push(section("command"));
        out.push(kv("verb", c.cmd, c.isWrite ? C_WRITE : C_READ));
        out.push(
          kv(
            "namespace",
            <Text fg={C_NS}>
              {c.ns || "?"}
              {c.dbInferred ? <Text fg={C_WARN}>{"   (database inferred from an earlier command)"}</Text> : ""}
            </Text>,
          ),
        );
        out.push(kv("shape", c.shape || "—", C_SHAPE));
        out.push(kv("process", `${c.comm}/${c.pid}`, C_DIM));
        out.push(
          kv("latency", <Text bold fg={heat(latFrac(c.latUs))}>{fmtDuration(c.latUs)}</Text>),
        );
        out.push(kv("sizes", `${fmtBytes(c.reqBytes)} sent  ·  ${fmtBytes(c.respBytes)} received`, C_DIM));
        out.push(kv("requestID", `${c.requestId}`, C_DIM));
        if (c.limit != null) out.push(kv("limit", `${c.limit}`, C_DIM));
        if (c.batch != null) out.push(kv("batchSize", `${c.batch}`, C_DIM));

        if (c.footgun) {
          out.push(blank());
          out.push(<Text height="1" break="none" bold fg={C_BAD}>{`⚠  ${c.footgun}`}</Text>);
        }
        if (c.truncated) {
          out.push(blank());
          out.push(
            <Text height="1" break="none" fg={C_WARN}>
              {"⋯  this command exceeded the capture window — the fields below are what fit, not the whole document"}
            </Text>,
          );
        }

        if (c.values?.length) {
          out.push(blank());
          out.push(section("filter values"));
          for (const v of c.values) {
            out.push(
              <Text height="1" break="none" overflow="ellipsis">
                <Text fg={C_FIELD}>{`  ${v.field}`.padEnd(30)}</Text>
                <Text fg={C_VALUE}>{v.text}</Text>
              </Text>,
            );
          }
        }

        out.push(blank());
        out.push(section(`every run of this shape against ${c.ns || "?"}`));
        out.push(kv("runs", `${runs.length}`, C_TITLE));
        out.push(kv("processes", procs.join(", ") || "—", C_DIM));
        if (lats.length) {
          out.push(
            kv(
              "latency",
              <Text>
                <Text fg={C_DIM}>{"p50 "}</Text>
                <Text fg={heat(latFrac(pctl(lats, 0.5)))}>{fmtDuration(pctl(lats, 0.5))}</Text>
                <Text fg={C_DIM}>{"   p95 "}</Text>
                <Text fg={heat(latFrac(pctl(lats, 0.95)))}>{fmtDuration(pctl(lats, 0.95))}</Text>
                <Text fg={C_DIM}>{"   p99 "}</Text>
                <Text fg={heat(latFrac(pctl(lats, 0.99)))}>{fmtDuration(pctl(lats, 0.99))}</Text>
                <Text fg={C_DIM}>{"   max "}</Text>
                <Text fg={heat(latFrac(Math.max(...lats)))}>{fmtDuration(Math.max(...lats))}</Text>
              </Text>,
            ),
          );
        }
        if (guns) out.push(kv("footguns", `${guns} of ${runs.length} runs`, C_BAD));
        if (recent.length > 1) {
          out.push(kv("recent", <Text fg={C_BRAND}>{sparkline(recent)}</Text>));
          out.push(kv("", <Text fg={C_FAINT}>{"oldest → newest"}</Text>));
        }

        // A repeated shape is the N+1 signal, so say it in words rather than
        // leaving the engineer to count rows.
        if (runs.length >= 10) {
          out.push(blank());
          out.push(
            <Text height="1" break="none" fg={C_WARN}>
              {`↻  this shape ran ${runs.length} times in the retained window — check for a query inside a loop`}
            </Text>,
          );
        }

        out.push(blank());
        out.push(section("command document"));
        const lines = docLines(c.doc);
        for (const ln of lines.slice(0, 200)) {
          out.push(<Text height="1" break="none" overflow="ellipsis" fg={C_TEXT}>{`  ${ln}`}</Text>);
        }

        // The overlay scrolls as one block; `scroll` is the first visible line.
        const off = Math.min(scroll.get(), Math.max(0, out.length - 1));
        return out.slice(off);
      }}
    </Box>
  );
}

// The main panel: a live, newest-first feed of MongoDB commands. Each command
// is one row — process, verb, namespace, query shape, then documents returned,
// latency (heat-colored) and size — with a dim `↳` line of the concrete filter
// values beneath it, and a red `⚠` line when it tripped a footgun.
//
// Pure UI: it reads the signals it's handed and nothing else.
//
// The shape is the display object, and the values live underneath it. That
// split is the whole point: a feed showing `{customer_id, status}` twenty-five
// times in a row with only the value changing IS an N+1, visible as literal
// repetition rather than something you'd infer from a counter.
import { Box, Text } from "yeet:tui";
import {
  C_BAD, C_CMD, C_DIM, C_FAINT, C_FIELD, C_MATCH_BG, C_NS, C_READ, C_SEL_BG, C_SHAPE,
  C_TEXT, C_TLS, C_VALUE, C_WARN, C_WRITE,
  clip, fmtBytes, fmtDuration, fmtValues, heat, latFrac, lpad, pad, rowHeight,
} from "@/lib/format.js";
import { fuzzyPositions } from "@/lib/fuzzy.js";

// Split text into spans so the columns a fuzzy query matched render on a
// highlight background. Returns plain text when there's no query or no match.
const hl = (text, fg, q) => {
  if (!q) return <Text fg={fg}>{text}</Text>;
  const pos = fuzzyPositions(q, text);
  if (!pos) return <Text fg={fg}>{text}</Text>;
  const hits = new Set(pos);
  const out = [];
  let run = "";
  let runHit = null;
  const flush = () => {
    if (!run) return;
    out.push(runHit ? <Text fg={fg} bold bg={C_MATCH_BG}>{run}</Text> : <Text fg={fg}>{run}</Text>);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    if (runHit !== null && hit !== runHit) flush();
    run += text[i];
    runHit = hit;
  }
  flush();
  return out;
};

function CmdRow({ c, sel, q, repeat }) {
  const lat = heat(latFrac(c.latUs));
  const verbColor = c.footgun ? C_BAD : c.isWrite ? C_WRITE : C_CMD;

  // A command with no decodable body (compressed, legacy) says so in the shape
  // column rather than showing a misleading empty `{}`.
  const shapeText = c.opLabel ? `«${c.opLabel}»` : c.shape;
  const shapeColor = c.opLabel ? C_WARN : C_SHAPE;

  // `~` marks a namespace whose database was recalled from an earlier command
  // rather than read off this one — an inference, flagged as one.
  const nsText = `${c.ns || "?"}${c.dbInferred ? "~" : ""}`;

  // Source marker. A text glyph, not an emoji: emoji are double-width and
  // shift every following column by a cell, which broke the alignment of the
  // whole feed. `tls` also reads as itself with no legend needed.
  const src = c.isTls ? "tls" : "";

  // The repeat rail. When this row's shape+namespace matches the row above it,
  // draw a continuation bar instead of restating the shape. That turns an N+1
  // from "twenty-five rows a reader must notice are identical" into one
  // visually contiguous block — the pattern becomes a shape on screen rather
  // than something to infer.
  const bar = repeat ? "│" : "├";

  return (
    <Box direction="column" bg={sel ? C_SEL_BG : undefined}>
      <Box direction="row" height="1">
        <Text width="4" break="none" fg={C_TLS}>{pad(src, 4)}</Text>
        <Box width="13" overflow="hidden">
          {/* comm often carries a second word ("mongosh mongodb", "node
              server"); the first token is the identity, the rest is noise in a
              13-column gutter. */}
          <Text break="none" fg={C_DIM}>{pad(clip(`${c.comm.split(" ")[0]}/${c.pid}`, 12), 13)}</Text>
        </Box>
        <Box width="14" overflow="hidden">
          <Text break="none" overflow="ellipsis" bold fg={verbColor}>{hl(c.cmd, verbColor, q)}</Text>
        </Box>
        <Box width="24" overflow="hidden">
          <Text break="none" overflow="ellipsis" fg={C_NS}>{hl(nsText, C_NS, q)}</Text>
        </Box>
        <Text width="2" break="none" fg={repeat ? C_FAINT : C_DIM}>{bar}</Text>
        <Box width="34" overflow="hidden">
          {/* A continuation row shows NO shape text at all — only the rail.
              Dimming still asks the eye to parse twenty-five copies of the same
              string; blanking collapses them into one visual block, so what you
              read is "this query, twenty-five times" rather than a wall. The
              shape is restated whenever the run breaks. */}
          <Text break="none" overflow="ellipsis" fg={shapeColor}>
            {repeat ? "" : hl(shapeText, shapeColor, q)}
          </Text>
        </Box>
        <Text width="8" break="none" fg={C_DIM}>{lpad(fmtBytes(c.respBytes), 8)}</Text>
        <Text width="9" break="none" bold fg={lat}>{lpad(fmtDuration(c.latUs), 9)}</Text>
        <Box width="1fr" />
      </Box>

      {c.values?.length ? (
        <Text height="1" break="none" overflow="ellipsis" fg={C_FIELD}>
          {/* Indent to the shape column: src(4) + process(13) + command(14) +
              namespace(24) = 55, then the 2-col rail. */}
          {`${" ".repeat(55)}`}
          <Text fg={C_FAINT}>{repeat ? "│ " : "  "}</Text>
          <Text fg={C_VALUE}>{clip(fmtValues(c.values), 120)}</Text>
        </Text>
      ) : null}

      {c.footgun ? (
        <Text height="1" break="none" overflow="ellipsis">
          <Text fg={C_FAINT}>{`${" ".repeat(55)}${repeat ? "│ " : "  "}`}</Text>
          <Text fg={C_BAD}>{`⚠ ${c.footgun}`}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

export default function Commands({ visible, size, scroll, selected, filter, footgunsOnly }) {
  return (
    <Box height="1fr" overflow="hidden">
      {() => {
        const list = visible.get();
        if (!list.length) {
          const q = filter.get();
          const fo = footgunsOnly.get();
          const msg = q
            ? `   no commands match “${q}”`
            : fo
              ? "   no footguns yet  —  press f to show every command"
              : "   waiting for MongoDB traffic…  start your app, or run demo/run.sh";
          return <Text height="1" fg={C_DIM}>{msg}</Text>;
        }
        // Start at the scroll offset (0 = newest) and emit commands while any
        // row of body height remains. The last one may not fully fit; the
        // panel's overflow:hidden clips it rather than leaving a blank gap.
        const budget = Math.max(1, size.get().rows - 3); // minus title + header + footer
        const offset = Math.min(scroll.get(), Math.max(0, list.length - 1));
        const cur = selected.get();
        const q = filter.get();
        const out = [];
        let used = 0;
        for (let i = offset; i < list.length && used < budget; i++) {
          const c = list[i];
          // Newest-first, so the row rendered ABOVE this one is i-1. Same shape
          // against the same namespace means this is a continuation.
          const prev = list[i - 1];
          const repeat =
            !!prev &&
            prev.pid === c.pid && // a run is within ONE process — two clients
            prev.shape === c.shape && // issuing the same query are not a loop
            prev.ns === c.ns &&
            prev.cmd === c.cmd;
          out.push(<CmdRow c={c} sel={i === cur} q={q} repeat={repeat} />);
          used += rowHeight(c);
        }
        return out;
      }}
    </Box>
  );
}

// The column header, a separate one-line strip above the feed so the feed
// itself stays pure rows.
export function CommandsHeader() {
  return (
    <Box direction="row" height="1">
      <Text width="4" fg={C_DIM}>{pad("src", 4)}</Text>
      <Text width="13" fg={C_DIM}>{pad("process", 13)}</Text>
      <Text width="14" fg={C_DIM}>{pad("command", 14)}</Text>
      <Text width="24" fg={C_DIM}>{pad("namespace", 24)}</Text>
      <Text width="2" fg={C_DIM}>{"  "}</Text>
      <Text width="34" fg={C_DIM}>{pad("query shape", 34)}</Text>
      <Text width="8" fg={C_DIM}>{lpad("resp", 8)}</Text>
      <Text width="9" fg={C_DIM}>{lpad("latency", 9)}</Text>
      <Box width="1fr" />
    </Box>
  );
}

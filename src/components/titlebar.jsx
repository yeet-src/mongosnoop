// Status rail: brand, live counters, the read/write split, and the probe
// state. One row, bg-tinted via the container.
import { Box, Text } from "yeet:tui";
import { commands, stats, status } from "@/probes/mongo.js";
import {
  C_BAD, C_BRAND, C_DIM, C_RAIL, C_READ, C_TITLE, C_TLS, C_WARN, C_WRITE,
  fmtDuration, fmtRate,
} from "@/lib/format.js";

const sep = () => <Text fg={C_DIM}>{"  ▏ "}</Text>;

export default function TitleBar({ frozen, pinned, filter }) {
  return (
    <Box height="1" direction="row" bg={C_RAIL}>
      <Text break="none">
        {() => {
          const s = stats.get();
          const st = status.get();
          const out = [<Text bold fg={C_BRAND}>{" ◉ mongosnoop "}</Text>];

          // A probe that failed to attach says so here instead of throwing a
          // stack over the UI (CLAUDE.md crash-handling boundary 1).
          if (st !== "tracing") {
            out.push(sep(), <Text fg={C_WARN}>{st}</Text>);
            return out;
          }

          out.push(
            sep(),
            <Text bold fg={C_TITLE}>{`${s.tracked}`}</Text>,
            <Text fg={C_DIM}>{" commands "}</Text>,
            sep(),
            <Text fg={C_TITLE}>{`${fmtRate(s.cmdRate)}/s`}</Text>,
            <Text fg={C_DIM}>{"  "}</Text>,
            <Text fg={C_READ}>{`▼${fmtRate(s.readRate)}`}</Text>,
            <Text fg={C_DIM}>{" read "}</Text>,
            <Text fg={C_WRITE}>{`▲${fmtRate(s.writeRate)}`}</Text>,
            <Text fg={C_DIM}>{" write"}</Text>,
          );

          // The plaintext/encrypted split. This is the proof that the TLS path
          // is live: an encrypted count above zero means the tool is reading
          // inside connections the socket probes cannot see at all.
          if (s.tlsRate > 0 || s.wireRate > 0) {
            out.push(
              sep(),
              <Text fg={C_TLS}>{`🔒${fmtRate(s.tlsRate)}`}</Text>,
              <Text fg={C_DIM}>{" tls "}</Text>,
              <Text fg={C_DIM}>{`${fmtRate(s.wireRate)} plain`}</Text>,
            );
          }

          // The slowest command in the last window — the number you actually
          // watch when you're chasing a latency spike.
          if (s.slowest > 0) {
            out.push(
              sep(),
              <Text fg={C_DIM}>{"peak "}</Text>,
              <Text bold fg={C_TITLE}>{fmtDuration(s.slowest)}</Text>,
            );
          }

          // Footgun count across the retained log, so a problem that scrolled
          // past is still visible in the rail.
          const guns = commands.get().filter((c) => c.footgun).length;
          if (guns) {
            out.push(sep(), <Text bold fg={C_BAD}>{`⚠ ${guns}`}</Text>, <Text fg={C_DIM}>{" footguns"}</Text>);
          }

          if (pinned.get()) out.push(sep(), <Text bold fg={C_WARN}>{"⏸ PAUSED"}</Text>);
          else if (frozen.get()) out.push(sep(), <Text bold fg={C_WARN}>{"⏸ HOLD"}</Text>);

          const q = filter.get();
          if (q) out.push(sep(), <Text fg={C_DIM}>{"/"}</Text>, <Text fg={C_TITLE}>{q}</Text>);

          return out;
        }}
      </Text>
    </Box>
  );
}

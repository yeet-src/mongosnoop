// The selected CPU's recent context switches, streamed live: prev -> next
// with the outgoing task's on-CPU slice. Reads `cpus` + `selected`.
import { Box, Text, idx } from "yeet:tui";
import { fmtDuration, lpad, pad } from "@/lib/format.js";

export default ({ cpus, selected, rows }) => (
  <Box>
    <Text height="1" bold fg={idx(214)}>
      {() => ` ▸ CPU ${selected.get()}`}
    </Text>
    <Box>
      {() => {
        const cpu = cpus.get()[selected.get()];
        const recent = cpu ? cpu.recent : [];
        const n = Math.max(1, rows);
        if (!recent.length) return [<Text height="1" fg={idx(240)}>{"   (idle — no switches in window)"}</Text>];
        return recent.slice(0, n).map((s) => (
          <Text height="1" break="none">
            <Text fg={idx(252)}>{`   ${pad(s.prev, 16)}`}</Text>
            <Text fg={idx(240)}>{" → "}</Text>
            <Text fg={idx(45)}>{pad(s.next, 16)}</Text>
            <Text fg={idx(244)}>{lpad(fmtDuration(s.slice), 8)}</Text>
          </Text>
        ));
      }}
    </Box>
  </Box>
);

// Status rail: brand, total switch rate across all CPUs, and the live
// min-slice knob value (what +/- patches into the kernel). A one-row Box
// tinted as the rail via the container's own bg — full width, no fragile
// space-fill.
import { Box, Text, idx } from "yeet:tui";
import { fmtDuration, fmtRate } from "@/lib/format.js";

const RAIL = idx(235);
const sep = () => <Text fg={idx(240)}>{"  ▏  "}</Text>;

export default ({ cpus, minSlice }) => (
  <Box height="1" direction="row" bg={RAIL}>
    <Text break="none">
      {() => {
        const total = cpus.get().reduce((s, c) => s + c.rate, 0);
        return [
          <Text bold fg={idx(214)}>{" ● cpusched "}</Text>, sep(),
          <Text bold>{fmtRate(total)}</Text>, <Text fg={idx(245)}>{" switches/s"}</Text>, sep(),
          <Text fg={idx(245)}>{"min-slice ≥ "}</Text>, <Text bold>{fmtDuration(minSlice.get() * 1000)}</Text>, <Text fg={idx(240)}>{"  [ +/- ]"}</Text>,
        ];
      }}
    </Text>
  </Box>
);

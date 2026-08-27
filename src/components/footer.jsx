// Key hints, or the live filter prompt while you're typing one. Keys render as
// small tinted caps so the hint row reads as controls rather than prose.
import { Box, Text } from "yeet:tui";
import { C_CAP, C_DIM, C_RAIL, C_TEXT, C_TITLE } from "@/lib/format.js";

const Cap = ({ k }) => <Text bg={C_CAP} fg={C_TITLE}>{` ${k} `}</Text>;

const Hint = ({ k, label }) => (
  <Text break="none">
    <Cap k={k} />
    <Text fg={C_DIM}>{` ${label}   `}</Text>
  </Text>
);

export default function Footer({ mode, filter, visible, detail }) {
  return (
    <Box height="1" direction="row" bg={C_RAIL}>
      <Text break="none" overflow="ellipsis">
        {() => {
          // While capturing a filter the footer becomes the prompt — the
          // cursor block is the only thing that needs to be obvious.
          if (mode.get() === "filter") {
            return [
              <Text fg={C_DIM}>{" filter "}</Text>,
              <Text fg={C_TITLE}>{filter.get()}</Text>,
              <Text bg={C_TITLE}>{" "}</Text>,
              <Text fg={C_DIM}>{`   ${visible.get().length} matching   `}</Text>,
              <Cap k="esc" />,
              <Text fg={C_DIM}>{" clear"}</Text>,
            ];
          }

          // The overlay owns a smaller key set; showing the feed's keys there
          // would advertise controls that do nothing.
          if (detail.get()) {
            return [
              <Text fg={C_DIM}>{" "}</Text>,
              <Hint k="↑↓" label="scroll" />,
              <Hint k="enter" label="back to feed" />,
              <Hint k="esc" label="close" />,
            ];
          }

          return [
            <Text fg={C_DIM}>{" "}</Text>,
            <Hint k="↑↓" label="select" />,
            <Hint k="enter" label="detail" />,
            <Hint k="f" label="footguns" />,
            <Hint k="/" label="filter" />,
            <Hint k="p" label="pause" />,
            <Hint k="g" label="newest" />,
            <Hint k="q" label="quit" />,
          ];
        }}
      </Text>
    </Box>
  );
}

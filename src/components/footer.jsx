// Key-hint rail. A one-row Box tinted as the rail (the container's own bg —
// reliable full width, unlike a fill of plain spaces, which the text engine
// strips as trailing break-whitespace). Each shortcut is a raised key-cap —
// the key glyph in bold gold on a tile a shade lighter than the rail —
// followed by a dimmed label, so the keys pop out of the line.
import { Box, Text, idx } from "yeet:tui";

const RAIL = idx(235); // hint-rail background
const CAP = idx(238); // key-cap tile, a shade lighter than the rail
const GLYPH = idx(222); // bright gold key text
const LABEL = idx(247); // dimmed description

const hint = (keys, label) => [
  <Text bg={CAP} bold fg={GLYPH}>{` ${keys} `}</Text>,
  <Text fg={LABEL}>{` ${label}   `}</Text>,
];

export default () => (
  <Box height="1" direction="row" bg={RAIL}>
    <Text break="none">
      {["  ", ...hint("←/↑/→/↓", "select CPU"), ...hint("+/-", "min-slice"), ...hint("q", "quit")]}
    </Text>
  </Box>
);

/* mongosnoop — a live trace of MongoDB commands, read off the wire.
 *
 * It watches the socket layer with eBPF and shows, per command, the verb, the
 * namespace, the query SHAPE (the filter with values stripped), the concrete
 * filter values, and the round-trip latency — across every process on the
 * host, with no cooperation from the applications and nothing asked of the
 * database.
 *
 *   kernel → user : probes/mongo.js attaches the tcp_sendmsg/tcp_recvmsg
 *                   kprobes, pairs requests to replies on OP_MSG's own
 *                   requestID, and folds the stream into the `commands`,
 *                   `stats` and `status` signals.
 *
 * Layout: probes/ (BPF-aware) → components/ (pure UI) → lib/ (pure helpers),
 * imported through the `@/` source alias and composed here. This file also owns
 * the view state (scroll offset, cursor, filter) and all keyboard input.
 */
import { Box, computed, mount, signal } from "yeet:tui";
import { commands, stats, status } from "@/probes/mongo.js";
import { fuzzyMatch, haystack } from "@/lib/fuzzy.js";
import { rowHeight } from "@/lib/format.js";
import { isNoise } from "@/lib/classify.js";
import TitleBar from "@/components/titlebar.jsx";
import Commands, { CommandsHeader } from "@/components/commands.jsx";
import Detail from "@/components/detail.jsx";
import Footer from "@/components/footer.jsx";

// ── view state ───────────────────────────────────────────────────────────────
const scroll = signal(0); // index of the first visible command (0 = newest)
const selected = signal(0); // index of the highlighted command (the cursor)
const detail = signal(null); // a command snapshot when the detail overlay is open
const detailScroll = signal(0); // first visible line inside the overlay
const filter = signal(""); // fuzzy query; "" = show everything
const footgunsOnly = signal(false); // show only commands that tripped a footgun
const showNoise = signal(false); // include driver chatter (hello, ping, ...)
const mode = signal("normal"); // "normal" | "filter" (capturing the query)
const pinned = signal(false); // explicit pause via `p`
// While "frozen" the view reads this snapshot of the full list instead of the
// live one, so scrolling into history holds still as new commands arrive
// underneath. null = live/following. We freeze on scroll-away and on pause.
const frozenList = signal(null);
const frozen = computed(() => frozenList.get() !== null);

const enterFrozen = () => {
  if (!frozenList.get()) frozenList.set(commands.get());
};
const exitFrozen = () => frozenList.set(null);

// The list actually shown: the frozen snapshot (if any) else the live list,
// then the noise and footgun toggles, then the fuzzy filter.
//
// Driver chatter is hidden by DEFAULT. An idle connection pool heartbeats
// `hello` every few seconds per connection, which would otherwise dominate the
// feed and bury the application's own traffic. It's a toggle, not a drop —
// the events are in the log either way.
const visible = computed(() => {
  const q = filter.get();
  let base = frozenList.get() ?? commands.get();
  if (!showNoise.get()) base = base.filter((c) => !c.isNoise);
  if (footgunsOnly.get()) base = base.filter((c) => c.footgun);
  return q ? base.filter((c) => fuzzyMatch(q, haystack(c))) : base;
});

// Scroll the viewport so the selected (cursor) row is fully visible. Body
// height is the terminal rows minus title + header + footer; rows are
// variable-height (the ↳ and ⚠ lines), so we sum real heights — matching how
// the panel itself budgets rows — and raise the top until the cursor fits.
const keepVisible = () => {
  const list = visible.get();
  const sel = selected.get();
  if (!list.length) return;
  const body = Math.max(1, tty.size().rows - 3);
  let top = Math.min(scroll.get(), sel); // cursor above viewport → reveal it
  let used = 0;
  for (let i = top; i <= sel; i++) used += rowHeight(list[i]);
  while (used > body && top < sel) used -= rowHeight(list[top++]);
  scroll.set(top);
};

// Move the cursor by d rows; freeze the view once it leaves the newest row so
// history holds still as new commands arrive, resume live back at the top.
const move = (d) => {
  const list = visible.get();
  if (!list.length) return;
  const next = Math.max(0, Math.min(list.length - 1, selected.get() + d));
  selected.set(next);
  if (next > 0) enterFrozen();
  else if (!pinned.get()) exitFrozen();
  keepVisible();
};

// Jump back to the newest command and resume following.
const toNewest = () => {
  selected.set(0);
  scroll.set(0);
  if (!pinned.get()) exitFrozen();
};

// Any change to the visible set resets the cursor to the top.
const resetCursor = () => {
  selected.set(0);
  scroll.set(0);
};

const toggleFootguns = () => {
  footgunsOnly.update((v) => !v);
  resetCursor();
};

const toggleNoise = () => {
  showNoise.update((v) => !v);
  resetCursor();
};

// The daemon reports the return key as either "Enter" or "Return" depending on
// the input path, so accept both (pktscope does the same).
const isEnter = (code) => code === "Enter" || code === "Return";

const togglePause = () => {
  pinned.update((v) => !v);
  if (pinned.get()) enterFrozen();
  else if (selected.get() === 0) exitFrozen(); // unpinned at the top → resume live
};

// ── input ────────────────────────────────────────────────────────────────────
tty.enableMouse();

tty.on("keydown", (e) => {
  const code = e.code;
  const key = e.key ?? "";

  // Detail overlay is modal: Esc/Enter return to the feed; q still quits.
  if (detail.get()) {
    if (code === "Escape" || isEnter(code)) return (detail.set(null), detailScroll.set(0));
    if (code === "ArrowDown" || key.toLowerCase() === "j") return detailScroll.update((v) => v + 1);
    if (code === "ArrowUp" || key.toLowerCase() === "k") return detailScroll.update((v) => Math.max(0, v - 1));
    if (code === "PageDown") return detailScroll.update((v) => v + 10);
    if (code === "PageUp") return detailScroll.update((v) => Math.max(0, v - 10));
    if (key.toLowerCase() === "q") return yeet.exit();
    return;
  }

  // Filter mode: keystrokes build the query; arrows still move the cursor.
  if (mode.get() === "filter") {
    if (code === "Escape") return (filter.set(""), mode.set("normal"), resetCursor());
    if (isEnter(code)) return mode.set("normal"); // accept: keep filter, stop typing
    if (code === "Backspace") return (filter.set(filter.get().slice(0, -1)), resetCursor());
    if (code === "ArrowDown") return move(1);
    if (code === "ArrowUp") return move(-1);
    if (key.length === 1 && !e.ctrlKey && !e.altKey) {
      filter.set(filter.get() + key); // printable → append
      resetCursor();
    }
    return;
  }

  // Normal mode: navigation, drill-in, entering filter.
  const k = key.toLowerCase();
  if (code === "Escape" || k === "q") return yeet.exit();
  if (isEnter(code)) {
    const c = visible.get()[selected.get()];
    // Note: detailScroll is reset on CLOSE, not here. Writing two signals the
    // render path is about to read in one handler trips the set-during-render
    // guard (AGENTS.md gotcha 3), and the overlay renders empty.
    if (c) detail.set(c); // open the detail overlay for the cursor row
    return;
  }
  if (k === "/") return mode.set("filter");
  if (k === "f") return toggleFootguns();
  if (k === "n") return toggleNoise();
  if (k === "p") return togglePause();
  if (code === "ArrowDown" || k === "j") return move(1);
  if (code === "ArrowUp" || k === "k") return move(-1);
  if (code === "PageDown") return move(10);
  if (code === "PageUp") return move(-10);
  if (k === "g") return toNewest();
});

tty.on("wheel", (e) => {
  if (detail.get()) {
    return e.deltaY > 0
      ? detailScroll.update((v) => v + 3)
      : detailScroll.update((v) => Math.max(0, v - 3));
  }
  move(e.deltaY > 0 ? 3 : -3);
});

// `size` is the terminal's reactive size signal; the body reads it to reflow
// (and to budget how many command rows fit above the footer).
const Root = (size) => (
  <Box>
    <TitleBar frozen={frozen} pinned={pinned} filter={filter} />
    <Box height="1fr" overflow="hidden">
      {() =>
        detail.get() ? (
          <Detail c={detail.get()} commands={commands} scroll={detailScroll} />
        ) : (
          <Box height="1fr" overflow="hidden">
            <CommandsHeader />
            <Commands
              visible={visible}
              size={size}
              scroll={scroll}
              selected={selected}
              filter={filter}
              footgunsOnly={footgunsOnly}
            />
          </Box>
        )
      }
    </Box>
    <Footer mode={mode} filter={filter} visible={visible} detail={detail} />
  </Box>
);

mount(Root);
await new Promise(() => {}); // keep the script alive; the TUI owns the screen

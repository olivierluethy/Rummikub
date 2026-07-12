# Rummikub — Casino Edition

A polished, browser-based **Rummikub** with single-player (up to **7 AI
opponents**, 4 difficulties) and local pass-and-play for up to **8 players** with
shareable **room codes**. No build step, no dependencies, no server —
**double-click `index.html`** and play. Works on desktop, tablet, and mobile.

> Note: the directory was empty at the start of this project, so this is a
> ground-up implementation rather than a refactor of existing code.

---

## Running it

Just open `index.html` in any modern browser (Chrome, Firefox, Safari, Edge).
Tailwind loads from its Play CDN; **all sound is synthesized** in the browser
(Web Audio), so there are no asset files and the game works fully offline once
the Tailwind script is cached.

---

## What's implemented

**Rules (official):** 106 tiles (1–13 in four colours ×2 + 2 jokers), 14-tile
racks, runs & groups with joker wildcards, the **30-point opening meld**, the
"no table manipulation before your opening meld" rule, correct joker valuation,
tile-conservation enforcement, and optional **60-second turn timer** (off by
default, per your casual-play preference).

**Custom end-game (as requested):** play does **not** stop when the first player
empties their rack. Finishers are ranked 1st, 2nd, 3rd… in the order they go
out; the last player holding tiles is automatically last. A final 🥇🥈🥉 ranking
screen is shown. (A stall — everyone passing with an empty draw pile — ranks the
remaining players by fewest points left.)

**Board surface + snap grid:** a framed felt board (bevelled rail + inner
vignette) that reads as a real Rummikub board even when empty. Every meld resolves
to a `{row, col}` grid anchor, so a set dropped below another lands **flush in the
same column**, never diagonally offset. Dragging a tile over the board reveals the
grid raster and lights up the target cell; on drop the tile snaps to it, or merges
into a flush-adjacent set to build a run. Still pannable/zoomable (drag felt to
pan, wheel/pinch to zoom); drag a meld's background to move it, and it snaps too.

**Two-row rack:** the flat hand is laid over stacked, shelved rows (two minimum,
more only on overflow) like a physical tray. Drag tiles freely within and between
rows with a live insertion caret; one-tap **Sort 1–13** and **Sort by colour**. In
hotseat mode only the active player's rack is shown.

**Tile conservation:** the game snapshots every tile id at deal time and asserts,
after every render and every drop, that the draw pile + all racks + the board
always equal that ledger — a tile can never be duplicated or lost.

**Drag & drop:** custom pointer-based engine (not HTML5 DnD) so mouse and touch
behave identically. Live validation colours every set green/red as you build,
with a golden drop-target highlight and a **live insertion caret** showing the
exact slot a tile will land in (in the rack and in melds).

### Learning mode & UX

- **Physical rack tray** — a raised two-row holder with a front ledge and slot
  grooves, clearly separated from the felt.
- **Scannable melds** — each set is a spaced pill with a `RUN · pts` / `GROUP · pts`
  badge; sort buttons are labelled **Runs** / **Groups** with tooltips.
- **Guided Best move** — instead of dumping the solution, it first tells you *how
  many plays* are possible, then reveals them one at a time: the source tile(s)
  ring cyan, a green ghost shows the destination, and a tile flies to it. Step
  with **Next hint**, apply with **Place this**, or skip the lesson with
  **Auto-solve**. In **easy mode** the source/destination/resulting-set colours
  are called out with an on-screen legend.
- **Tile selection** — tap to mark tiles; marked tiles float matching plays to the
  front of the guided hint.
- **Easy-mode coaching** — the step-by-step guide auto-opens on your turn (and the
  Best-move button pulses), each guided placement flashes green with a plain
  "what changed" line, and invalid sets explain themselves on the board (e.g.
  "A set needs at least 3 tiles").
- **Pre-placement** — while an opponent is thinking (single-player), a non-blocking
  banner invites you to drag tiles onto the board to stage them as amber ghosts;
  they auto-play when your turn starts. If an opponent's move invalidates a staged
  append, only those tiles return to your rack.
- **Move history** — a docked, chess-style panel lists every move (yours and
  opponents') as it happens; click any entry or step with the panel's controls to
  replay the board at that point. Opponent placements animate onto the board.

**Assumptions made** (per "choose a sensible default and note it"): a "play" is
one atomic placement (a new set, or one tile appended to a set); the guided hint
decomposes the best move into individually-legal plays so each step is safe to
apply. Pre-placement is single-player only — a hotseat opponent shares the screen,
so staging tiles for them makes no sense.

**AI:** see below.

**Audio:** looping lounge ambient pad + tactile SFX (place, shuffle, draw,
invalid, victory, button), each toggleable in Settings.

---

## Architecture

Plain ES5-style modules attached to a global `RK` namespace, loaded as ordinary
`<script>` tags (so it runs from `file://` with no bundler). Strict separation:

| File | Responsibility |
|------|----------------|
| `js/tiles.js` | Tile model, deck creation, shuffle, sorting, scoring |
| `js/rules.js` | **Pure** rules engine: `validateSet`, `validateBoard`, meld points |
| `js/solver.js` | Combinatorial engine (jokers as wildcards) |
| `js/ai.js` | Opponent decisions, difficulty scaling |
| `js/game.js` | State machine: turns, snapshots, commit/undo, ranking, timer |
| `js/audio.js` | Web Audio synthesis (music + SFX) |
| `js/ui.js` | Rendering, pan/zoom, pointer drag-and-drop |
| `js/main.js` | Menu, bootstrapping, timer, AI scheduling, controls |

**Single source of truth.** The UI mutates `game.board` / the current rack
directly while you stage a move; `commitTurn()` validates the result against a
snapshot taken at turn start (tile conservation, board legality, opening-meld
rules) and only then advances. `Reset turn` restores the snapshot.

### The solver (the hard part)

Rummikub move-finding is NP-hard. The engine offers three tools, all
counts-based with memoization and a node budget so the UI can never hang:

- `solveFull(tiles)` — partition **every** tile into valid sets, or `null`.
- `solveMax(tiles)` / `layRackSets(tiles)` — place as many tiles as possible
  (optimal for small racks; a fast greedy extractor for large ones).
- `solveManipulation(table, rack)` — a **mandatory-aware** search: keep all table
  tiles on the board while adding as many rack tiles as possible, in one pass.

A key correctness subtlety handled here: when a table tile and a rack tile share
the same colour+number, concretization assigns the **table** copy first so a
table tile is never orphaned (which would leak a tile).

### AI difficulty

The AI never moves randomly. It scales *how hard it searches* and *whether it
manipulates the table*:

- **Easy** — opening melds only when comfortably over 30; lays new rack sets; no
  table manipulation; occasionally plays lazily so it's beatable.
- **Medium** — also appends tiles to existing sets.
- **Hard** — local board manipulation: absorbs rack tiles into existing melds
  meld-by-meld, then lays new sets.
- **Expert** — Hard's local manipulation **plus** a bounded full-board re-solve
  while the board is still small, to catch cross-meld tile "steals".

Performance note: the AI deliberately **never re-solves the whole board late-game**
(that's the NP-hard blow-up). It manipulates locally — feeding the solver one
meld plus its handful of *related* rack tiles at a time — which keeps every
Expert move at ~1–7 ms even on a 90-tile board. The human **✨ Best move** button
uses the exact same engine.

---

## Multiplayer / room codes

Local multiplayer is **pass-and-play** for up to 8 players on one device. The host
generates a **room code** (Copy / New in the lobby); the code seeds the shuffle, so
any device that enters the same code deals the **identical table** — the join-by-
code contract without a server. Large tables (needing more than a single 106-tile
set) automatically deal from a **double set** (212 tiles) so everyone still gets a
full 14-tile hand with a real draw pile.

True online multiplayer (playing from different devices with live sync) still
requires a server (signalling + authoritative state + reconnection), which a
static file can't provide. The engine is deliberately structured so an online
transport drops in cleanly:

- `game.js` is a pure state machine; a turn is applied by exactly one method.
- `main.js` already isolates the turn/AI boundary behind `config.mode`.

To add online play, implement a `Transport` that (1) broadcasts the committing
player's resulting board + rack diffs and (2) calls the same commit path on
remote clients. A small WebSocket relay (or WebRTC data channel) with the host
as state authority is enough; reconnection replays the last committed snapshot.

---

## Testing

The pure engine is exercised by a Node harness (rules edge cases, joker runs,
solver partitioning, deck sizing / seeded-deal reproducibility, and full AI games
including 8-player double-deck tables verifying tile conservation every turn,
always-valid committed boards, and unique final rankings).

The browser UI is verified headlessly (Chrome), driving real pointer events:
tiles never vanish when dropped on a hint/ghost pill (conservation holds),
vertical placement snaps directly below in the same column, the rack renders and
rearranges across two rows, pre-placement stages and auto-commits, the move panel
steps through history, easy-mode coaching/reason badges appear, and a full
real-`main.js` game plays to completion with zero console errors and zero
conservation violations.

---

## Ideas to reach "premium commercial" polish

- Online multiplayer via a WebSocket relay (as above) + lobby/room codes.
- Tile-move animations (FLIP) and a subtle deal animation at game start.
- Persistent stats, achievements, and an ELO-style rating vs the AI.
- Undo-move (not just full turn reset) and a move history / replay.
- Accessibility pass: keyboard tile navigation, colour-blind tile glyphs.
- "Time bank" tournament timer and configurable house rules.

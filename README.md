# Rummikub — Casino Edition

A polished, browser-based **Rummikub** with single-player (4 AI difficulties) and
local pass-and-play multiplayer. No build step, no dependencies, no server —
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

**Infinite board:** a pannable/zoomable world (drag empty felt to pan, wheel or
pinch to zoom, +/−/reset buttons). Melds auto-flow into tidy rows and the world
always keeps a screenful of empty space below, so it never feels "full". Drag a
meld's background to pin it anywhere.

**Rack:** drag to reorder, drag tiles to/from the board, one-tap **Sort 1–13**
and **Sort by colour**. In hotseat mode only the active player's rack is shown.

**Drag & drop:** custom pointer-based engine (not HTML5 DnD) so mouse and touch
behave identically. Live validation colours every set green/red as you build,
with a golden drop-target highlight and a **live insertion caret** showing the
exact slot a tile will land in (in the rack and in melds).

### Learning mode & UX

- **Physical rack tray** — a raised holder with a front ledge and slot grooves,
  clearly separated from the felt; wraps to a second row.
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
- **Pre-placement** — while an opponent is thinking (single-player), drag tiles
  onto the board to stage them as amber ghosts; they auto-play when your turn
  starts. If an opponent's move invalidates a staged append, only those tiles
  return to your rack.
- **Move history & replay** — opponent placements animate onto the board; a
  History modal lists every move and lets you step back/forward through a
  read-only replay of the board at any point.

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

## Multiplayer / networking

Online multiplayer requires a server (signalling + authoritative state +
reconnection), which a static file can't provide. Rather than ship something
broken, the game ships robust **local pass-and-play** with strict turn
enforcement today, and the engine is deliberately structured so an online
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
solver partitioning, and full AI-vs-AI games for all four difficulties verifying
tile conservation, always-valid committed boards, and unique final rankings).
The browser UI was smoke-tested headlessly (boot with zero JS errors, correct
deal, sort, Best move, and a synthetic rack→board drag).

---

## Ideas to reach "premium commercial" polish

- Online multiplayer via a WebSocket relay (as above) + lobby/room codes.
- Tile-move animations (FLIP) and a subtle deal animation at game start.
- Persistent stats, achievements, and an ELO-style rating vs the AI.
- Undo-move (not just full turn reset) and a move history / replay.
- Accessibility pass: keyboard tile navigation, colour-blind tile glyphs.
- "Time bank" tournament timer and configurable house rules.

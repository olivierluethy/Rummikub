/* ui.js — rendering + pointer-based drag/drop + infinite pan/zoom board.
 * Renders from the game model (single source of truth); every human action
 * mutates the model then re-renders. Works with mouse and touch. */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  const flat = (board) => board.reduce((a, m) => a.concat(m), []);
  const $ = (id) => document.getElementById(id);
  const cssVar = (name) => parseInt(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

  const UI = {
    game: null, scale: 1, tx: 20, ty: 20,
    gesture: null,        // active pointer gesture
    pointers: new Map(),  // for pinch
    lastPinchDist: 0,
    selected: new Set(),  // marked tile ids (Task 6)
    hint: { active: false, plan: [], step: -1 }, // guided hint (Task 5)
    review: { active: false, index: 0 }, // move-history replay (Task 8)
    pending: [], _nextGid: 1,            // pre-placements staged out of turn (Task 7)
    caret: null, _flyTimers: [], _pendingAnim: null,
  };

  const meldKeyUI = (m) => m.map(t => t.id).sort().join(',');
  UI.humanPlayer = () => UI.game.players.find(p => !p.isAI);
  // Pre-placing is a single-player convenience (a hotseat opponent is a person at
  // the same screen). Active only while it's an opponent's turn.
  UI.isStaging = () => UI.game && UI.game.mode === 'single' && UI.game.phase === 'playing' &&
    !UI.game.isHumanTurn() && !UI.review.active;
  // The player currently acting through the rack (the human, whether it's their
  // turn or they're pre-placing during an opponent's turn).
  UI.actor = () => (UI.isStaging() ? UI.humanPlayer() : UI.game.currentPlayer());

  // ---- Tile & meld DOM ------------------------------------------------------
  function jokerSVG(color) {
    const c = RK.COLOR_HEX[color] || '#2b2f38';
    return '<svg class="joker-face" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="2">' +
      '<circle cx="12" cy="12" r="9"/>' +
      '<circle cx="9" cy="10" r="1.3" fill="' + c + '" stroke="none"/>' +
      '<circle cx="15" cy="10" r="1.3" fill="' + c + '" stroke="none"/>' +
      '<path d="M8 14.2c1.6 2.1 6.4 2.1 8 0" stroke-linecap="round"/></svg>';
  }

  function tileEl(tile) {
    const el = document.createElement('div');
    el.className = 'tile' + (UI.selected.has(tile.id) ? ' selected' : '');
    el.dataset.tileId = tile.id;
    if (tile.isJoker) {
      el.innerHTML = jokerSVG(tile.color);
    } else {
      const span = document.createElement('span');
      span.className = 'num';
      span.style.color = RK.COLOR_HEX[tile.color];
      span.textContent = tile.number;
      el.appendChild(span);
    }
    return el;
  }

  // ---- Rendering ------------------------------------------------------------
  function render() {
    renderHUD();
    if (UI.review.active) { renderReview(); applyTransform(); updateControls(); return; }
    $('board-viewport').classList.remove('board-review');
    $('review-bar').classList.add('hidden');
    layoutBoard(UI.game.board);
    renderBoard(UI.game.board);
    renderPending();
    renderRack();
    applyTransform();
    updateControls();
    renderHintHighlights();
    updateHintBar();
    runPendingAnim();
    UI.game.assertConservation('render');
  }
  UI.render = render;

  function renderHUD() {
    const g = UI.game;
    const bar = $('players-bar');
    bar.innerHTML = '';
    g.players.forEach((p, i) => {
      const active = i === g.turnIndex && g.phase === 'playing';
      const chip = document.createElement('div');
      chip.className = 'flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm ' +
        (active ? 'bg-amber-400/20 ring-1 ring-amber-400 turn-active' : 'bg-white/5') +
        (p.finished ? ' opacity-50' : '');
      const dot = p.isAI ? '🤖' : '🧑';
      const rankBadge = p.rank ? ' <span class="text-amber-300">#' + p.rank + '</span>' : '';
      chip.innerHTML =
        '<span>' + dot + '</span>' +
        '<span class="font-semibold text-white/90">' + escapeHtml(p.name) + '</span>' +
        '<span class="text-white/50">🁢 ' + p.rack.length + '</span>' +
        '<span title="Initial meld">' + (p.melded ? '✅' : '⛔') + '</span>' + rankBadge;
      bar.appendChild(chip);
    });

    $('deck-count').textContent = g.deckCount();
    $('status-text').textContent = g.status || '';

    // Initial-meld progress for the human whose turn it is.
    const p = g.currentPlayer();
    const prog = $('meld-progress');
    if (g.isHumanTurn() && !p.melded) {
      const beforeKeys = (g._snapshot ? g._snapshot.board : []).map(m => m.map(t => t.id).sort().join(','));
      const newMelds = g.board.filter(m => !beforeKeys.includes(m.map(t => t.id).sort().join(',')));
      const pts = RK.sumMeldPoints(newMelds).total;
      prog.classList.remove('hidden');
      prog.innerHTML = 'Opening meld: <b class="' + (pts >= 30 ? 'text-emerald-400' : 'text-amber-300') + '">' +
        pts + '</b> / 30';
    } else {
      prog.classList.add('hidden');
    }
    $('ai-overlay').classList.toggle('hidden', g.isHumanTurn() || g.phase === 'over');
  }

  function layoutBoard(board) {
    if (!board) board = UI.review.active ? UI.game.history[UI.review.index].board : UI.game.board;
    const vp = $('board-viewport');
    const tileW = cssVar('--tile-w'), tileH = cssVar('--tile-h'), gap = 3;
    const flowWidth = Math.max(vp.clientWidth / UI.scale - 40, 700);
    const GAP = 28, PILL = 22;            // generous gaps so melds read at a glance
    let x = 24, y = 26, rowH = 0, maxY = 0, maxX = flowWidth;

    for (const meld of board) {
      if (meld._pinned && meld._x != null) {
        maxY = Math.max(maxY, meld._y + tileH + 40);
        maxX = Math.max(maxX, meld._x + meld.length * (tileW + gap) + 40);
        continue;
      }
      const w = meld.length * (tileW + gap) + PILL;
      if (x > 24 && x + w > flowWidth) { x = 24; y += rowH + GAP; rowH = 0; }
      meld._x = x; meld._y = y;
      x += w + GAP; rowH = Math.max(rowH, tileH + PILL);
      maxY = Math.max(maxY, y + rowH);
    }
    const world = $('board-world');
    world.style.width = Math.max(flowWidth + 60, maxX + 60) + 'px';
    // Always leave a screen of empty space below so it never feels "full".
    world.style.height = Math.max(vp.clientHeight / UI.scale, maxY + 500) + 'px';
  }

  function renderBoard(board) {
    const world = $('board-world');
    world.innerHTML = '';
    const results = RK.validateBoard(board).results;
    board.forEach((meld, i) => {
      const el = document.createElement('div');
      const r = results[i];
      const ok = r.valid;
      el.className = 'meld absolute flex items-center gap-[3px] rounded-xl px-2.5 py-2 bg-black/30 ring-1 ring-white/5 ' +
        (ok ? 'valid' : 'invalid');
      el.style.left = meld._x + 'px';
      el.style.top = meld._y + 'px';
      el.dataset.meldIndex = i;
      // Scannable badge: type + points, or a warning when the set isn't legal.
      const badge = document.createElement('div');
      badge.className = 'meld-badge ' + (ok ? 'ok' : 'bad');
      badge.textContent = ok ? (r.type === 'run' ? 'RUN' : 'GROUP') + ' · ' + r.points : '✗ invalid';
      el.appendChild(badge);
      meld.forEach(t => el.appendChild(tileEl(t)));
      world.appendChild(el);
    });
  }

  function renderRack() {
    const g = UI.game;
    const rack = $('rack');
    rack.innerHTML = '';
    const staging = UI.isStaging();

    if (g.isHumanTurn() || staging) {
      const p = UI.actor();
      $('rack-owner').textContent = staging
        ? p.name + ' — pre-placing (auto-plays on your turn)'
        : p.name + "'s rack";
      const pend = new Set(UI.pending.map(x => x.id));   // pending tiles show as ghosts on the board
      p.rack.forEach(t => { if (!pend.has(t.id)) rack.appendChild(tileEl(t)); });
      return;
    }

    // Local hotseat during someone else's turn, or game over.
    $('rack-owner').textContent = g.phase === 'over' ? 'Game over' : g.currentPlayer().name + ' is playing…';
    if (g.phase !== 'over') {
      const hint = document.createElement('div');
      hint.className = 'text-white/40 text-sm px-3 py-4';
      hint.textContent = 'Pass the device when it’s your turn.';
      rack.appendChild(hint);
    }
  }

  // ---- Pre-placement overlays (Task 7) -------------------------------------
  function renderPending() {
    if (!UI.pending.length) return;
    const g = UI.game, human = UI.humanPlayer();
    const find = (id) => human.rack.find(t => t.id === id);
    const byGid = {}, bySig = {};
    UI.pending.forEach(p => {
      const tile = find(p.id); if (!tile) return;
      if (p.kind === 'new') (byGid[p.gid] = byGid[p.gid] || []).push(tile);
      else (bySig[p.sig] = bySig[p.sig] || []).push(tile);
    });
    // Appends: ghost tiles attached to their target committed meld.
    Object.keys(bySig).forEach(sig => {
      const idx = g.board.findIndex(m => meldKeyUI(m) === sig);
      const meldEl = idx >= 0 && boardMeldElByIndex(idx);
      if (!meldEl) return;
      bySig[sig].forEach(t => { const gt = tileEl(t); gt.classList.add('tile-pending'); meldEl.appendChild(gt); });
    });
    // New pending melds: amber ghost pills stacked in a staging zone.
    let spot = freeBoardSpot();
    Object.keys(byGid).forEach(gid => {
      const pill = document.createElement('div');
      pill.className = 'meld absolute flex items-center gap-[3px] rounded-xl px-2.5 py-2 pending-pill';
      pill.dataset.pendingGid = gid;
      pill.style.left = spot.x + 'px'; pill.style.top = spot.y + 'px';
      const badge = document.createElement('div'); badge.className = 'meld-badge'; badge.textContent = 'STAGED';
      pill.appendChild(badge);
      byGid[gid].forEach(t => { const gt = tileEl(t); gt.classList.add('tile-pending'); pill.appendChild(gt); });
      $('board-world').appendChild(pill);
      spot = { x: spot.x, y: spot.y + cssVar('--tile-h') + 30 };
    });
  }
  function removePending(id) { UI.pending = UI.pending.filter(p => p.id !== id); }

  function stageDrop(id, tile, meldEl, inRack, inBoard) {
    removePending(id);
    if (meldEl && meldEl.dataset.meldIndex !== undefined) {
      UI.pending.push({ id, kind: 'meld', sig: meldKeyUI(UI.game.board[+meldEl.dataset.meldIndex]) });
    } else if (meldEl && meldEl.dataset.pendingGid !== undefined) {
      UI.pending.push({ id, kind: 'new', gid: +meldEl.dataset.pendingGid });
    } else if (inBoard && !inRack) {
      UI.pending.push({ id, kind: 'new', gid: UI._nextGid++ });
    }   // dropped back on the rack -> simply unstaged
    RK.audio.play('place');
    render();
  }

  // After an opponent move, revert ONLY the pending appends that no longer form a
  // legal set (their target meld changed/vanished). Self-contained pending sets
  // built from your own tiles are never affected.
  function reconcilePending() {
    if (!UI.pending.length) return;
    const g = UI.game, human = UI.humanPlayer();
    const bySig = {}, keep = [];
    let reverted = 0;
    UI.pending.forEach(p => { if (p.kind !== 'meld') keep.push(p); else (bySig[p.sig] = bySig[p.sig] || []).push(p); });
    Object.keys(bySig).forEach(sig => {
      const items = bySig[sig];
      const idx = g.board.findIndex(m => meldKeyUI(m) === sig);
      const tiles = items.map(it => human.rack.find(t => t.id === it.id)).filter(Boolean);
      if (idx >= 0 && RK.validateSet(g.board[idx].concat(tiles)).valid) items.forEach(it => keep.push(it));
      else reverted += items.length;
    });
    if (reverted) {
      UI.pending = keep;
      g.status = '⚠ ' + reverted + ' pre-placed tile' + (reverted === 1 ? '' : 's') +
        ' no longer fit and returned to your rack.';
      RK.audio.play('invalid');
    }
  }

  // On the human's turn: commit every still-valid pending placement, then let them
  // keep playing. (Runs after beginTurn's snapshot, so these count as normal plays.)
  UI.commitPending = function () {
    const g = UI.game;
    if (!UI.pending.length) return;
    const p = g.currentPlayer();
    if (p.isAI) return;
    const byGid = {}, bySig = {};
    UI.pending.forEach(pp => {
      const tile = p.rack.find(t => t.id === pp.id); if (!tile) return;
      if (pp.kind === 'new') (byGid[pp.gid] = byGid[pp.gid] || []).push(tile);
      else (bySig[pp.sig] = bySig[pp.sig] || []).push(tile);
    });
    let placed = 0, reverted = 0;
    Object.keys(bySig).forEach(sig => {
      const idx = g.board.findIndex(m => meldKeyUI(m) === sig);
      const tiles = bySig[sig];
      if (idx < 0 || !p.melded || !RK.validateSet(g.board[idx].concat(tiles)).valid) { reverted += tiles.length; return; }
      g.board[idx].push.apply(g.board[idx], tiles);
      const ids = new Set(tiles.map(t => t.id)); p.rack = p.rack.filter(t => !ids.has(t.id));
      placed += tiles.length;
    });
    Object.keys(byGid).forEach(gid => {
      const tiles = byGid[gid];
      g.board.push(tiles.slice());
      const ids = new Set(tiles.map(t => t.id)); p.rack = p.rack.filter(t => !ids.has(t.id));
      placed += tiles.length;
    });
    UI.pending = [];
    let msg = '';
    if (placed) msg = 'Placed ' + placed + ' pre-staged tile' + (placed === 1 ? '' : 's') + ' — keep playing or End turn.';
    if (reverted) msg += (msg ? ' ' : '') + reverted + ' didn’t fit and stayed in your rack.';
    if (msg) g.status = msg;
    render();
  };

  function updateControls() {
    const g = UI.game;
    const human = g.isHumanTurn() && !UI.review.active;
    ['btn-sort-num', 'btn-sort-color', 'btn-draw', 'btn-reset', 'btn-end', 'btn-best'].forEach(id => {
      const b = $(id); if (b) b.disabled = !human;
      if (b) b.classList.toggle('opacity-40', !human);
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- Move history & replay (Task 8) --------------------------------------
  function renderReview() {
    const h = UI.game.history;
    const entry = h[UI.review.index];
    $('board-viewport').classList.add('board-review');
    if (!entry) { $('board-world').innerHTML = ''; return; }
    const melds = entry.board.map(m => m.slice());
    layoutBoard(melds);
    renderBoard(melds);
    entry.placed.forEach(id => {
      const el = $('board-world').querySelector('.tile[data-tile-id="' + id + '"]');
      if (el) el.classList.add('just-placed');
    });
    $('review-bar').classList.remove('hidden');
    $('review-text').innerHTML = 'Move ' + entry.n + '/' + h.length + ' — <b>' + escapeHtml(entry.by) + '</b> ' + escapeHtml(entry.text);
    $('review-prev').disabled = UI.review.index <= 0;
    $('review-next').disabled = UI.review.index >= h.length - 1;
    hintBar(false);
  }

  // Fly an opponent's freshly placed tiles from their HUD chip to the board.
  function runPendingAnim() {
    const a = UI._pendingAnim; if (!a) return; UI._pendingAnim = null;
    const chip = $('players-bar').children[a.byIndex];
    const src = chip ? chip.getBoundingClientRect() : null;
    a.placed.forEach(id => {
      const el = $('board-world').querySelector('.tile[data-tile-id="' + id + '"]');
      if (!el) return;
      el.classList.add('just-placed');
      const rm = setTimeout(() => el.classList.remove('just-placed'), 700); UI._flyTimers.push(rm);
      if (!src) return;
      const d = el.getBoundingClientRect();
      const clone = el.cloneNode(true); clone.className = 'tile hint-fly';
      Object.assign(clone.style, { position: 'fixed', left: src.left + 'px', top: src.top + 'px',
        width: d.width + 'px', height: d.height + 'px', margin: '0', zIndex: 71,
        transition: 'transform .42s cubic-bezier(.2,.7,.3,1)' });
      $('hint-layer').appendChild(clone);
      requestAnimationFrame(() => { clone.style.transform = 'translate(' + (d.left - src.left) + 'px,' + (d.top - src.top) + 'px)'; });
      const tm = setTimeout(() => clone.remove(), 600); UI._flyTimers.push(tm);
    });
  }

  UI.notifyMove = function (entry) {
    if (entry.isAI && !UI.review.active) UI._pendingAnim = { byIndex: entry.byIndex, placed: entry.placed };
  };
  UI.openHistory = function () {
    const list = $('history-list'); list.innerHTML = '';
    const h = UI.game.history;
    if (!h.length) { list.innerHTML = '<div class="text-white/50 text-sm">No moves yet.</div>'; }
    h.forEach((e, i) => {
      const row = document.createElement('button');
      row.className = 'w-full text-left rounded-lg px-3 py-2 text-sm bg-white/5 hover:bg-white/10 flex gap-2 items-center';
      row.innerHTML = '<span class="text-white/40 w-6">' + e.n + '.</span>' +
        '<span>' + (e.isAI ? '🤖' : '🧑') + '</span>' +
        '<span class="font-semibold ' + (e.isAI ? 'text-sky-300' : 'text-emerald-300') + '">' + escapeHtml(e.by) + '</span>' +
        '<span class="text-white/70">' + escapeHtml(e.text) + '</span>';
      row.onclick = () => { $('history-modal').classList.add('hidden'); UI.enterReview(i); };
      list.appendChild(row);
    });
    $('history-modal').classList.remove('hidden');
  };
  UI.enterReview = function (i) { UI.review = { active: true, index: i }; render(); };
  UI.reviewStep = function (d) {
    if (!UI.review.active) return;
    UI.review.index = Math.max(0, Math.min(UI.game.history.length - 1, UI.review.index + d));
    render();
  };
  UI.exitReview = function () { UI.review.active = false; $('board-viewport').classList.remove('board-review'); render(); };

  // ---- Transform / pan / zoom ----------------------------------------------
  function applyTransform() {
    const world = $('board-world');
    world.style.transformOrigin = '0 0';
    world.style.transform = 'translate(' + UI.tx + 'px,' + UI.ty + 'px) scale(' + UI.scale + ')';
  }
  function zoomAround(cx, cy, factor) {
    const vp = $('board-viewport').getBoundingClientRect();
    const px = cx - vp.left, py = cy - vp.top;
    const wx = (px - UI.tx) / UI.scale, wy = (py - UI.ty) / UI.scale;
    UI.scale = Math.min(1.8, Math.max(0.4, UI.scale * factor));
    UI.tx = px - wx * UI.scale; UI.ty = py - wy * UI.scale;
    layoutBoard(); applyTransform();
  }
  function resetView() { UI.scale = 1; UI.tx = 20; UI.ty = 20; layoutBoard(); applyTransform(); }

  function screenToWorld(cx, cy) {
    const vp = $('board-viewport').getBoundingClientRect();
    return { x: (cx - vp.left - UI.tx) / UI.scale, y: (cy - vp.top - UI.ty) / UI.scale };
  }

  // ---- Snap grid (P2) -------------------------------------------------------
  // The board is a coordinate grid: one column per tile, one row per meld line.
  // Melds carry a { _row, _col } anchor; screen position derives from it, so a
  // tile dropped below another lands flush in the same column, never offset.
  const GRID = { ox: 24, oy: 26 };
  function gridCellW() { return cssVar('--tile-w') + 3; }
  function gridRowH() { return cssVar('--tile-h') + 50; }
  function colToX(c) { return GRID.ox + c * gridCellW(); }
  function rowToY(r) { return GRID.oy + r * gridRowH(); }
  function worldToCell(wx, wy) {
    return {
      col: Math.max(0, Math.round((wx - GRID.ox) / gridCellW())),
      row: Math.max(0, Math.round((wy - GRID.oy) / gridRowH())),
    };
  }

  // Placeholder overlay hooks — the visible grid + cell highlight are wired in P2.
  function hideGridOverlay() { const el = $('grid-overlay'); if (el) el.classList.add('hidden'); }

  // Drop onto open felt: snap to the grid. If the target cell sits flush against
  // an existing meld on the same row, extend that meld (build a run); otherwise
  // start a new set anchored at the snapped cell.
  function placeOnBoard(src, e) {
    const w = screenToWorld(e.clientX, e.clientY);
    const cell = worldToCell(w.x, w.y);
    const neighbour = adjacentMeld(cell);
    if (neighbour) {
      safeMove(src, neighbour.meld, neighbour.side === 'left' ? 0 : neighbour.meld.length);
      return;
    }
    const [tile] = src.arr.splice(src.index, 1);
    const meld = [tile];
    meld._row = cell.row; meld._col = cell.col; meld._pinned = true;
    meld._x = colToX(cell.col); meld._y = rowToY(cell.row);
    UI.game.board.push(meld);
  }

  // A committed meld the snapped cell is flush-adjacent to (same row, immediately
  // left of the first tile or right of the last), so dropping there grows it.
  function adjacentMeld(cell) {
    for (const m of UI.game.board) {
      if (m._row == null || m._row !== cell.row) continue;
      const start = m._col, end = m._col + m.length - 1;
      if (cell.col === start - 1) return { meld: m, side: 'left' };
      if (cell.col === end + 1) return { meld: m, side: 'right' };
    }
    return null;
  }

  // ---- Model helpers --------------------------------------------------------
  function locate(id) {
    const g = UI.game, p = UI.actor();
    let idx = p.rack.findIndex(t => t.id === id);
    if (idx >= 0) return { arr: p.rack, index: idx, isRack: true };
    for (const meld of g.board) {
      idx = meld.findIndex(t => t.id === id);
      if (idx >= 0) return { arr: meld, index: idx, isRack: false };
    }
    return null;
  }
  function computeIndex(containerEl, x, draggedEl) {
    const tiles = [...containerEl.querySelectorAll('.tile')]
      .filter(t => t !== draggedEl && !t.classList.contains('tile-ghost-dest') && !t.classList.contains('tile-pending'));
    for (let i = 0; i < tiles.length; i++) {
      const r = tiles[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return tiles.length;
  }

  // Flat rack index for a pointer position. P3 makes this row-aware; for now it
  // reads the rack as one wrapped sequence.
  function rackInsertIndex(x, y, draggedEl) {
    return computeIndex($('rack'), x, draggedEl);
  }

  // ---- Insertion caret (Task 2) --------------------------------------------
  function getCaret() {
    if (!UI.caret) { UI.caret = document.createElement('div'); UI.caret.className = 'insert-caret'; }
    return UI.caret;
  }
  function hideCaret() { if (UI.caret && UI.caret.parentNode) UI.caret.parentNode.removeChild(UI.caret); }
  function showCaretAt(container, index, draggedEl) {
    hideCaret();
    const caret = getCaret();
    const tiles = [...container.children].filter(c => c.classList.contains('tile') && c !== draggedEl);
    if (index >= tiles.length) container.appendChild(caret);
    else container.insertBefore(caret, tiles[index]);
  }

  // ---- Drag & drop ----------------------------------------------------------
  function startTileDrag(tileEl0, e) {
    // A manual move supersedes an active guided hint (clear without re-rendering,
    // which would invalidate the captured drag element).
    if (UI.hint.active) { UI.hint = { active: false, plan: [], step: -1 }; clearHintOverlay(); hintBar(false); }
    const id = tileEl0.dataset.tileId;
    UI.gesture = { type: 'tile', id, startX: e.clientX, startY: e.clientY, el: tileEl0, ghost: null, active: false };
  }

  function rackTileElById(id) { return $('rack').querySelector('.tile[data-tile-id="' + id + '"]'); }
  function boardMeldElByIndex(i) { return $('board-world').querySelector('.meld[data-meld-index="' + i + '"]'); }

  function moveTileDrag(e) {
    const g = UI.gesture;
    if (!g.active) {
      if (Math.hypot(e.clientX - g.startX, e.clientY - g.startY) < 6) return;
      g.active = true;
      const ghost = g.el.cloneNode(true);
      ghost.classList.add('tile-ghost');
      document.body.appendChild(ghost);
      g.ghost = ghost;
      g.el.classList.add('dragging');
      RK.audio.play('button');
    }
    g.ghost.style.left = e.clientX + 'px';
    g.ghost.style.top = e.clientY + 'px';
    // Highlight the meld under the pointer + show the exact insertion slot.
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    hideCaret();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const meld = under && under.closest('.meld');
    const rack = under && under.closest('#rack');
    if (meld) {
      meld.classList.add('drop-target');
      showCaretAt(meld, computeIndex(meld, e.clientX, g.el), g.el);
    } else if (rack) {
      showCaretAt(rack, computeIndex(rack, e.clientX, g.el), g.el);
    }
    // (Over empty felt the pointer ghost itself indicates a new set.)
  }

  function clearDropCues() {
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    hideCaret();
    hideGridOverlay();
  }

  // The ONLY function that moves a tile between arrays. It removes from the source
  // and inserts into the destination as a single step, so a tile can never be
  // left "on the floor". Never call splice on a tile's home array anywhere else.
  function safeMove(src, destArr, insertIdx) {
    const [tile] = src.arr.splice(src.index, 1);
    if (destArr === src.arr && src.index < insertIdx) insertIdx--;
    destArr.splice(insertIdx, 0, tile);
    return tile;
  }

  // Drop a tile back into the rack at the pointer's slot (P3 maps this across rows).
  function rackDrop(src, draggedEl, e) {
    const dest = UI.actor().rack;
    safeMove(src, dest, rackInsertIndex(e.clientX, e.clientY, draggedEl));
  }

  function endTileDrag(e) {
    const g = UI.gesture;
    clearDropCues();
    if (!g.active) {                       // a tap, not a drag -> toggle selection (Task 6)
      UI.gesture = null;
      if (UI.selected.has(g.id)) UI.selected.delete(g.id); else UI.selected.add(g.id);
      render();
      return;
    }
    g.el.classList.remove('dragging');
    if (g.ghost) g.ghost.remove();

    const under = document.elementFromPoint(e.clientX, e.clientY);
    const src = locate(g.id);
    if (!src) { UI.gesture = null; render(); return; }
    const tile = src.arr[src.index];

    // Only *committed* melds are real drop targets. Ghost/pending pills carry the
    // `.meld` class too; matching the data attribute (and pointer-events:none on
    // ghosts) prevents dropping onto a set that doesn't exist — the old code path
    // that removed a tile from the rack and then destroyed it.
    const meldEl = under && under.closest('.meld[data-meld-index]');
    const inRack = under && under.closest('#rack');
    const inBoard = under && under.closest('#board-viewport');

    // Pre-placement mode (opponent's turn): update the pending list, not the board.
    if (UI.isStaging()) { stageDrop(g.id, tile, meldEl, inRack, inBoard); UI.gesture = null; return; }

    // Resolve the destination first; only then move the tile. If the drop lands
    // nowhere valid, the tile simply stays where it was.
    if (meldEl) {
      const dest = UI.game.board[+meldEl.dataset.meldIndex];
      safeMove(src, dest, computeIndex(meldEl, e.clientX, g.el));
    } else if (inRack) {
      rackDrop(src, g.el, e);
    } else if (inBoard) {
      placeOnBoard(src, e);              // grid-snapped new set / merge with a neighbour (P2)
    } else {
      UI.gesture = null; render(); return;   // dropped off-table — tile stays put
    }
    UI.game.pruneEmptyMelds();
    RK.audio.play('place');
    UI.gesture = null;
    UI.game.assertConservation('endTileDrag');
    render();
  }

  function startMeldDrag(meldEl, e) {
    const meld = UI.game.board[+meldEl.dataset.meldIndex];
    UI.gesture = { type: 'meld', meld, el: meldEl, startX: e.clientX, startY: e.clientY, ox: meld._x, oy: meld._y };
  }
  function moveMeldDrag(e) {
    const g = UI.gesture;
    g.meld._x = g.ox + (e.clientX - g.startX) / UI.scale;
    g.meld._y = g.oy + (e.clientY - g.startY) / UI.scale;
    g.meld._pinned = true;
    g.el.style.left = g.meld._x + 'px';
    g.el.style.top = g.meld._y + 'px';
  }

  function startPan(e) { UI.gesture = { type: 'pan', startX: e.clientX, startY: e.clientY, ox: UI.tx, oy: UI.ty }; }
  function movePan(e) {
    UI.tx = UI.gesture.ox + (e.clientX - UI.gesture.startX);
    UI.ty = UI.gesture.oy + (e.clientY - UI.gesture.startY);
    applyTransform();
  }

  // ---- Pointer routing ------------------------------------------------------
  function onPointerDown(e) {
    if (UI.review.active) return;           // board is read-only while reviewing history
    UI.pointers.set(e.pointerId, e);
    if (UI.pointers.size === 2) { beginPinch(); return; }
    const human = UI.game.isHumanTurn(), staging = UI.isStaging();
    if (!human && !staging) return;
    const t = e.target;
    const tile = t.closest && t.closest('.tile');
    // Tiles can be dragged on your turn OR while pre-placing during an opponent's turn.
    if (tile && (t.closest('#rack') || t.closest('#board-world'))) { startTileDrag(tile, e); return; }
    // Only rearrange committed melds on your own turn.
    const meld = t.closest && t.closest('.meld');
    if (human && meld && meld.dataset.meldIndex !== undefined && t.closest('#board-viewport')) { startMeldDrag(meld, e); return; }
    if (t.closest && t.closest('#board-viewport')) startPan(e);
  }
  function onPointerMove(e) {
    if (UI.pointers.has(e.pointerId)) UI.pointers.set(e.pointerId, e);
    if (UI.pointers.size === 2) { doPinch(); return; }
    const g = UI.gesture; if (!g) return;
    if (g.type === 'tile') moveTileDrag(e);
    else if (g.type === 'meld') moveMeldDrag(e);
    else if (g.type === 'pan') movePan(e);
  }
  function onPointerUp(e) {
    UI.pointers.delete(e.pointerId);
    const g = UI.gesture;
    if (g && g.type === 'tile') endTileDrag(e);
    else if (g && g.type === 'meld') { UI.gesture = null; render(); }
    else UI.gesture = null;
    UI.lastPinchDist = 0;
  }
  function beginPinch() { UI.gesture = null; UI.lastPinchDist = 0; }
  function doPinch() {
    const pts = [...UI.pointers.values()];
    const dist = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
    const mx = (pts[0].clientX + pts[1].clientX) / 2, my = (pts[0].clientY + pts[1].clientY) / 2;
    if (UI.lastPinchDist) zoomAround(mx, my, dist / UI.lastPinchDist);
    UI.lastPinchDist = dist;
  }

  // ---- Public actions (wired to buttons in main.js) ------------------------
  // 'runs'  -> group by colour then ascending number (runs sit together)
  // 'groups'-> group by number then colour (groups sit together)
  UI.sortRack = function (mode) {
    const p = UI.game.currentPlayer();
    p.rack.sort(mode === 'groups' ? RK.sortByNumber : RK.sortByColor);
    RK.audio.play('shuffle');
    render();
  };
  // ---- Guided learning hint (Tasks 5 & 9) ---------------------------------
  // Decompose the best move into ATOMIC, individually-valid plays so the player
  // can step through them one at a time.
  function computeHintPlan() {
    const g = UI.game, p = g.currentPlayer();
    if (!p.melded) {
      const melds = RK.findMelds(p.rack);
      const pts = RK.sumMeldPoints(melds).total;
      const ok = melds.length && pts >= RK.INITIAL_MELD_MIN;
      return { plays: ok ? melds.map(m => ({ type: 'new', tiles: m })) : [], opening: true, openingPts: pts, openingOk: ok };
    }
    const plays = [];
    let remaining = p.rack.slice();
    g.board.forEach((meld, idx) => {
      for (let i = 0; i < remaining.length; i++) {
        if (RK.validateSet(meld.concat([remaining[i]])).valid) {
          plays.push({ type: 'append', tile: remaining[i], meldIndex: idx });
          remaining.splice(i, 1); i--;
        }
      }
    });
    RK.findMelds(remaining).forEach(m => plays.push({ type: 'new', tiles: m }));
    // Selected tiles express intent — float plays that use them to the front (Task 6).
    if (UI.selected.size) {
      const uses = (pl) => (pl.type === 'new' ? pl.tiles : [pl.tile]).some(t => UI.selected.has(t.id));
      plays.sort((a, b) => (uses(b) ? 1 : 0) - (uses(a) ? 1 : 0));
    }
    return { plays, opening: false };
  }

  const colorName = { red: 'red', blue: 'blue', orange: 'orange', black: 'black' };
  function tileName(t) { return t.isJoker ? 'Joker' : (colorName[t.color] + ' ' + t.number); }
  function describePlay(pl) {
    return pl.type === 'new'
      ? 'Lay a new set: ' + pl.tiles.map(tileName).join(', ')
      : 'Add ' + tileName(pl.tile) + ' to a set already on the table';
  }

  function applyHintPlay(pl) {
    const g = UI.game, p = g.currentPlayer();
    if (pl.type === 'new') {
      const ids = new Set(pl.tiles.map(t => t.id));
      p.rack = p.rack.filter(t => !ids.has(t.id));
      ids.forEach(id => UI.selected.delete(id));
      g.board.push(pl.tiles.slice());
    } else {
      p.rack = p.rack.filter(t => t.id !== pl.tile.id);
      UI.selected.delete(pl.tile.id);
      g.board[pl.meldIndex].push(pl.tile);
    }
  }

  function freeBoardSpot() {
    const g = UI.game, tileH = cssVar('--tile-h');
    let maxBottom = 20;
    g.board.forEach(m => { if (m._y != null) maxBottom = Math.max(maxBottom, m._y + tileH + 24); });
    return { x: 24, y: maxBottom + 12 };
  }

  function flyTo(srcEl, destEl) {
    if (!srcEl || !destEl) return;
    const s = srcEl.getBoundingClientRect(), d = destEl.getBoundingClientRect();
    const clone = srcEl.cloneNode(true);
    clone.className = 'tile hint-fly';
    Object.assign(clone.style, { position: 'fixed', left: s.left + 'px', top: s.top + 'px',
      width: s.width + 'px', height: s.height + 'px', margin: '0', zIndex: 71,
      transition: 'transform .38s cubic-bezier(.2,.7,.3,1)' });
    $('hint-layer').appendChild(clone);
    requestAnimationFrame(() => { clone.style.transform = 'translate(' + (d.left - s.left) + 'px,' + (d.top - s.top) + 'px)'; });
    const tm = setTimeout(() => clone.remove(), 520);
    UI._flyTimers.push(tm);
  }

  function clearHintOverlay() {
    UI._flyTimers.forEach(clearTimeout); UI._flyTimers = [];
    const layer = $('hint-layer'); if (layer) layer.innerHTML = '';
    document.querySelectorAll('.hint-source,.hint-strong,.hint-target-meld')
      .forEach(el => el.classList.remove('hint-source', 'hint-strong', 'hint-target-meld'));
  }

  // Idempotent: (re)apply source rings + destination ghosts. Called every render
  // because the board/rack DOM is rebuilt each time. No animation here.
  function renderHintHighlights() {
    if (!UI.hint.active || UI.hint.step < 0) return;
    const pl = UI.hint.plan[UI.hint.step];
    if (!pl) return;
    const easy = UI.game.difficulty === 'easy';
    const srcTiles = pl.type === 'new' ? pl.tiles : [pl.tile];
    srcTiles.forEach(t => {
      const el = rackTileElById(t.id);
      if (el) { el.classList.add('hint-source'); if (easy) el.classList.add('hint-strong'); }
    });
    if (pl.type === 'append') {
      const meldEl = boardMeldElByIndex(pl.meldIndex);
      if (meldEl) {
        meldEl.classList.add('hint-target-meld');
        const ghost = tileEl(pl.tile); ghost.classList.add('tile-ghost-dest');
        meldEl.appendChild(ghost);
      }
    } else {
      const pill = document.createElement('div');
      pill.className = 'meld absolute flex items-center gap-[3px] rounded-xl px-2.5 py-2 hint-ghost-pill';
      const pos = freeBoardSpot();
      pill.style.left = pos.x + 'px'; pill.style.top = pos.y + 'px';
      pl.tiles.forEach(t => { const gt = tileEl(t); gt.classList.add('tile-ghost-dest'); pill.appendChild(gt); });
      $('board-world').appendChild(pill);
    }
  }

  // Animate source -> destination once, when the step changes.
  function flyForStep() {
    const layer = $('hint-layer'); layer.innerHTML = '';
    UI._flyTimers.forEach(clearTimeout); UI._flyTimers = [];
    if (!UI.hint.active || UI.hint.step < 0) return;
    const pl = UI.hint.plan[UI.hint.step]; if (!pl) return;
    const srcId = (pl.type === 'new' ? pl.tiles[0] : pl.tile).id;
    flyTo(rackTileElById(srcId), document.querySelector('.tile-ghost-dest'));
  }

  function hintBar(show) { $('hint-bar').classList.toggle('hidden', !show); }
  function updateHintBar() {
    const h = UI.hint;
    if (!h.active) { hintBar(false); return; }
    const total = h.plan.length;
    $('hint-legend').classList.toggle('hidden', UI.game.difficulty !== 'easy');
    if (h.step >= 0 && h.plan[h.step]) {
      $('hint-msg').innerHTML = '<b>Step ' + (h.step + 1) + ' of ' + total + '.</b> ' + describePlay(h.plan[h.step]);
    }
    $('hint-next').disabled = h.step >= total - 1;
    $('hint-next').classList.toggle('opacity-40', h.step >= total - 1);
    $('hint-accept').disabled = h.step < 0;
  }

  UI.startGuidedHint = function () {
    if (!UI.game.isHumanTurn()) return;
    const res = computeHintPlan();
    UI.hint = { active: true, plan: res.plays, step: -1, opening: res.opening };
    hintBar(true);
    if (!res.plays.length) {
      $('hint-msg').textContent = res.opening
        ? 'No opening meld reaches 30 points yet — draw a tile (you have ' + (res.openingPts || 0) + ').'
        : 'No plays available from your rack — draw a tile.';
      $('hint-legend').classList.add('hidden');
      $('hint-next').disabled = true; $('hint-accept').disabled = true;
      return;
    }
    const n = res.plays.length;
    const openInfo = res.opening
      ? ' They form a ' + RK.sumMeldPoints(res.plays.map(p => p.tiles)).total + '-point opening meld — place all of them.'
      : '';
    // Show the COUNT first; reveal the actual steps only on Next hint.
    $('hint-msg').innerHTML = '<b>' + n + ' possible play' + (n === 1 ? '' : 's') + ' this turn.</b>'
      + openInfo + ' Press <b>Next hint →</b> to reveal them one at a time.';
    updateHintBar();
  };
  UI.nextHint = function () {
    if (!UI.hint.active) return;
    UI.hint.step = Math.min(UI.hint.step + 1, UI.hint.plan.length - 1);
    render(); flyForStep();
  };
  UI.acceptHint = function () {
    if (!UI.hint.active || UI.hint.step < 0) return;
    const pl = UI.hint.plan[UI.hint.step];
    if (!pl) return;
    applyHintPlay(pl);
    RK.audio.play('place');
    const res = computeHintPlan();
    UI.hint.plan = res.plays; UI.hint.opening = res.opening;
    UI.hint.step = res.plays.length ? 0 : -1;
    if (!res.plays.length) UI.game.status = 'All suggested tiles placed — press End Turn.';
    render(); flyForStep();
  };
  UI.autoSolveHint = function () { UI.endGuidedHint(); UI.suggest(); };
  UI.endGuidedHint = function () { UI.hint = { active: false, plan: [], step: -1 }; clearHintOverlay(); hintBar(false); render(); };

  UI.suggest = function () {
    const g = UI.game, p = g.currentPlayer();
    if (!p.melded) {
      const melds = RK.findMelds(p.rack);
      const pts = RK.sumMeldPoints(melds).total;
      if (pts >= RK.INITIAL_MELD_MIN && melds.length) {
        const ids = new Set(); melds.forEach(m => m.forEach(t => ids.add(t.id)));
        melds.forEach(m => g.board.push(m));
        p.rack = p.rack.filter(t => !ids.has(t.id));
        g.notify('Suggested opening meld placed — press End Turn to confirm, or Reset.');
      } else { g.notify('No 30-point opening meld available — draw a tile.'); }
      RK.audio.play('place'); render(); return;
    }
    const nb = RK.ai.bestBoard(g.board, p.rack, 'expert');
    if (nb) {
      const placed = flat(nb).filter(t => p.rack.some(r => r.id === t.id));
      g.board = nb;
      const ids = new Set(placed.map(t => t.id));
      p.rack = p.rack.filter(t => !ids.has(t.id));
      g.notify('Suggested move placed (' + placed.length + ' tiles) — End Turn or Reset.');
      RK.audio.play('place');
    } else { g.notify('No move found — draw a tile.'); }
    render();
  };
  UI.zoomAround = zoomAround; UI.resetView = resetView;

  // ---- Mount ----------------------------------------------------------------
  UI.mount = function (game) {
    UI.game = game;
    const vp = $('board-viewport');
    vp.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    $('rack').addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('wheel', (e) => { e.preventDefault(); zoomAround(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 0.9); }, { passive: false });

    game.on('change', render);
    game.on('move', (entry) => { UI.notifyMove(entry); reconcilePending(); });
    game.on('turnstart', (p) => { if (!p.isAI) UI.commitPending(); });
    resetView();
    render();
  };

  RK.ui = UI;
})(window.RK);

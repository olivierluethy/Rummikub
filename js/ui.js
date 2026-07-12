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
  };

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
    el.className = 'tile';
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
    layoutBoard();
    renderBoard();
    renderRack();
    applyTransform();
    updateControls();
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

  function layoutBoard() {
    const g = UI.game;
    const vp = $('board-viewport');
    const tileW = cssVar('--tile-w'), tileH = cssVar('--tile-h'), gap = 3;
    const flowWidth = Math.max(vp.clientWidth / UI.scale - 40, 700);
    let x = 20, y = 20, rowH = 0, maxY = 0, maxX = flowWidth;

    for (const meld of g.board) {
      if (meld._pinned && meld._x != null) {
        maxY = Math.max(maxY, meld._y + tileH + 40);
        maxX = Math.max(maxX, meld._x + meld.length * (tileW + gap) + 40);
        continue;
      }
      const w = meld.length * (tileW + gap) + 16;
      if (x > 20 && x + w > flowWidth) { x = 20; y += rowH + 20; rowH = 0; }
      meld._x = x; meld._y = y;
      x += w + 20; rowH = Math.max(rowH, tileH + 16);
      maxY = Math.max(maxY, y + rowH);
    }
    const world = $('board-world');
    world.style.width = Math.max(flowWidth + 60, maxX + 60) + 'px';
    // Always leave a screen of empty space below so it never feels "full".
    world.style.height = Math.max(vp.clientHeight / UI.scale, maxY + 500) + 'px';
  }

  function renderBoard() {
    const g = UI.game;
    const world = $('board-world');
    world.innerHTML = '';
    const results = RK.validateBoard(g.board).results;
    g.board.forEach((meld, i) => {
      const el = document.createElement('div');
      const ok = results[i].valid;
      el.className = 'meld absolute flex items-center gap-[3px] rounded-xl p-2 bg-black/25 ' +
        (ok ? 'valid' : 'invalid');
      el.style.left = meld._x + 'px';
      el.style.top = meld._y + 'px';
      el.dataset.meldIndex = i;
      meld.forEach(t => el.appendChild(tileEl(t)));
      world.appendChild(el);
    });
  }

  function renderRack() {
    const g = UI.game;
    const p = g.currentPlayer();
    const rack = $('rack');
    rack.innerHTML = '';
    $('rack-owner').textContent = g.isHumanTurn() ? p.name + "'s rack" :
      (g.phase === 'over' ? 'Game over' : p.name + ' is playing…');
    // Only show the rack of the human whose turn it is (hotseat privacy + clarity).
    const showTiles = g.isHumanTurn() ? p.rack : (g.phase === 'over' ? [] : []);
    showTiles.forEach(t => rack.appendChild(tileEl(t)));
    if (!g.isHumanTurn() && g.phase !== 'over') {
      const hint = document.createElement('div');
      hint.className = 'text-white/40 text-sm px-3 py-4';
      hint.textContent = g.mode === 'local' ? 'Pass the device when it’s your turn.' : 'Thinking…';
      rack.appendChild(hint);
    }
  }

  function updateControls() {
    const g = UI.game;
    const human = g.isHumanTurn();
    ['btn-sort-num', 'btn-sort-color', 'btn-draw', 'btn-reset', 'btn-end', 'btn-best'].forEach(id => {
      const b = $(id); if (b) b.disabled = !human;
      if (b) b.classList.toggle('opacity-40', !human);
    });
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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

  // ---- Model helpers --------------------------------------------------------
  function locate(id) {
    const g = UI.game, p = g.currentPlayer();
    let idx = p.rack.findIndex(t => t.id === id);
    if (idx >= 0) return { arr: p.rack, index: idx, isRack: true };
    for (const meld of g.board) {
      idx = meld.findIndex(t => t.id === id);
      if (idx >= 0) return { arr: meld, index: idx, isRack: false };
    }
    return null;
  }
  function computeIndex(containerEl, x, draggedEl) {
    const tiles = [...containerEl.querySelectorAll('.tile')].filter(t => t !== draggedEl);
    for (let i = 0; i < tiles.length; i++) {
      const r = tiles[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return tiles.length;
  }

  // ---- Drag & drop ----------------------------------------------------------
  function startTileDrag(tileEl0, e) {
    const id = tileEl0.dataset.tileId;
    UI.gesture = { type: 'tile', id, startX: e.clientX, startY: e.clientY, el: tileEl0, ghost: null, active: false };
  }

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
    // Highlight the meld under the pointer.
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const meld = under && under.closest('.meld');
    if (meld) meld.classList.add('drop-target');
  }

  function endTileDrag(e) {
    const g = UI.gesture;
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
    if (!g.active) { UI.gesture = null; return; }
    g.el.classList.remove('dragging');
    if (g.ghost) g.ghost.remove();

    const under = document.elementFromPoint(e.clientX, e.clientY);
    const src = locate(g.id);
    if (!src) { UI.gesture = null; render(); return; }
    const tile = src.arr[src.index];

    const meldEl = under && under.closest('.meld');
    const inRack = under && under.closest('#rack');
    const inBoard = under && under.closest('#board-viewport');

    let dest = null, insertIdx = 0, newMeldPos = null;
    if (meldEl) {
      dest = UI.game.board[+meldEl.dataset.meldIndex];
      insertIdx = computeIndex(meldEl, e.clientX, g.el);
    } else if (inRack) {
      dest = UI.game.currentPlayer().rack;
      insertIdx = computeIndex($('rack'), e.clientX, g.el);
    } else if (inBoard) {
      newMeldPos = screenToWorld(e.clientX, e.clientY);
    } else {
      UI.gesture = null; render(); return;   // dropped outside — no change
    }

    // Mutate model
    src.arr.splice(src.index, 1);
    if (newMeldPos) {
      const meld = [tile]; meld._x = newMeldPos.x; meld._y = newMeldPos.y; meld._pinned = true;
      UI.game.board.push(meld);
    } else {
      if (dest === src.arr && src.index < insertIdx) insertIdx--;
      dest.splice(insertIdx, 0, tile);
    }
    UI.game.pruneEmptyMelds();
    RK.audio.play('place');
    UI.gesture = null;
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
    UI.pointers.set(e.pointerId, e);
    if (UI.pointers.size === 2) { beginPinch(); return; }
    if (!UI.game.isHumanTurn()) return;
    const t = e.target;
    const tile = t.closest && t.closest('.tile');
    if (tile && (t.closest('#rack') || t.closest('#board-world'))) { startTileDrag(tile, e); return; }
    const meld = t.closest && t.closest('.meld');
    if (meld && t.closest('#board-viewport')) { startMeldDrag(meld, e); return; }
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
  UI.sortRack = function (mode) {
    const p = UI.game.currentPlayer();
    p.rack.sort(mode === 'color' ? RK.sortByColor : RK.sortByNumber);
    RK.audio.play('shuffle');
    render();
  };
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
    resetView();
    render();
  };

  RK.ui = UI;
})(window.RK);

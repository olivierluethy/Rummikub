/* game.js — authoritative game state & turn machine.
 * The UI mutates game.board / currentPlayer.rack in place while staging a move,
 * then calls commitTurn(); the machine validates against a snapshot taken at
 * turn start. One source of truth, validated at the boundary. */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  const flat = (board) => board.reduce((a, m) => a.concat(m), []);
  const meldKey = (m) => m.map(t => t.id).sort().join(',');
  const idSet = (tiles) => new Set(tiles.map(t => t.id));

  function Emitter() { this._l = {}; }
  Emitter.prototype.on = function (e, cb) { (this._l[e] = this._l[e] || []).push(cb); return this; };
  Emitter.prototype.emit = function (e, p) { (this._l[e] || []).forEach(cb => cb(p)); };

  RK.Game = function (config) {
    Emitter.call(this);
    this.mode = config.mode;                       // 'single' | 'local'
    this.difficulty = config.difficulty || 'medium';
    this.timerSeconds = config.timerSeconds || 0;  // 0 = no timer
    this.rng = config.rng || Math.random;

    RK.resetIds();
    // Larger tables need more tiles than a single 106-tile set holds
    // (8 players × 14 = 112). Deal from as many identical sets as required so
    // everyone still gets a full 14-tile hand with a healthy draw pile left.
    const sets = RK.deckSetsFor(config.players.length);
    this.deckSets = sets;
    this.deck = RK.createDeck(this.rng, sets);
    // The complete set of tile ids that exist in this game. Nothing may ever be
    // created or destroyed after the deal — see assertConservation().
    this._ledger = new Set(this.deck.map(t => t.id));
    this.players = config.players.map((p, i) => ({
      id: i, name: p.name, isAI: !!p.isAI,
      rack: this.deck.splice(0, 14),
      melded: false, finished: false, rank: null,
    }));

    this.board = [];              // committed melds
    this.history = [];            // committed moves, for review/replay (Task 8)
    this.turnIndex = 0;
    this.phase = 'playing';       // 'playing' | 'over'
    this.finishedCount = 0;
    this.passStreak = 0;
    this.status = '';
    this._snapshot = null;
    this.beginTurn();
  };
  RK.Game.prototype = Object.create(Emitter.prototype);

  const P = RK.Game.prototype;

  P.currentPlayer = function () { return this.players[this.turnIndex]; };
  P.isHumanTurn = function () { return this.phase === 'playing' && !this.currentPlayer().isAI; };
  P.activePlayers = function () { return this.players.filter(p => !p.finished); };
  P.deckCount = function () { return this.deck.length; };
  P.notify = function (msg) { if (msg !== undefined) this.status = msg; this.emit('change'); };

  // Snapshot the committed state so the working turn can be validated / undone.
  P.beginTurn = function () {
    const p = this.currentPlayer();
    this._snapshot = { board: this.board.map(m => m.slice()), rack: p.rack.slice() };
    this.emit('turnstart', p);
  };

  P.undoTurn = function () {
    const p = this.currentPlayer();
    this.board = this._snapshot.board.map(m => m.slice());
    p.rack = this._snapshot.rack.slice();
    this.notify();
  };

  // Drop any now-empty melds (used after the UI removes the last tile from a meld).
  P.pruneEmptyMelds = function () { this.board = this.board.filter(m => m.length > 0); };

  // Every tile id currently accounted for across the draw pile, all racks and the
  // board. This must always equal the ledger captured at deal time.
  P.tileCensus = function () {
    const ids = [];
    this.deck.forEach(t => ids.push(t.id));
    this.players.forEach(p => p.rack.forEach(t => ids.push(t.id)));
    this.board.forEach(m => m.forEach(t => ids.push(t.id)));
    return ids;
  };

  // Hard invariant guard. Returns true when tiles are conserved; otherwise warns
  // with a precise diff so a tile-dropping bug is caught the instant it happens.
  P.assertConservation = function (where) {
    const ids = this.tileCensus();
    const seen = new Set();
    let dup = null;
    for (const id of ids) { if (seen.has(id)) dup = id; seen.add(id); }
    const missing = [...this._ledger].filter(id => !seen.has(id));
    const extra = ids.filter(id => !this._ledger.has(id));
    const ok = !dup && missing.length === 0 && extra.length === 0 && ids.length === this._ledger.size;
    if (!ok) {
      console.warn('[Rummikub] TILE CONSERVATION VIOLATED @ ' + (where || '?'), {
        counted: ids.length, expected: this._ledger.size,
        duplicated: dup, missing: missing, unknown: extra,
      });
    }
    return ok;
  };

  // Record a committed move as a full board snapshot for the history/replay UI.
  P._recordMove = function (player, text, placedIds) {
    const snap = this.board.map(m => m.map(t => ({ id: t.id, color: t.color, number: t.number, isJoker: t.isJoker })));
    const entry = { n: this.history.length + 1, by: player.name, byIndex: player.id,
      isAI: player.isAI, text, placed: (placedIds || []).slice(), board: snap };
    this.history.push(entry);
    this.emit('move', entry);
  };

  // ---- Committing a human turn ---------------------------------------------
  // Returns { ok:true } or { ok:false, reason, mustDraw? }.
  P.commitTurn = function () {
    const player = this.currentPlayer();
    this.pruneEmptyMelds();
    const snap = this._snapshot;

    // Tile conservation: nothing invented or lost.
    const before = new Set([...idSet(flat(snap.board)), ...idSet(snap.rack)]);
    const after = new Set([...idSet(flat(this.board)), ...idSet(player.rack)]);
    if (before.size !== after.size || [...after].some(id => !before.has(id))) {
      return { ok: false, reason: 'Tile mismatch — please reset your turn.' };
    }

    const beforeRackIds = idSet(snap.rack);
    const placed = flat(this.board).filter(t => beforeRackIds.has(t.id));

    if (placed.length === 0) return { ok: false, mustDraw: true, reason: 'You haven’t placed any tiles.' };

    const bv = RK.validateBoard(this.board);
    if (!bv.valid) return { ok: false, reason: 'Some sets on the table aren’t valid runs or groups.' };

    if (!player.melded) {
      // Before the initial meld: existing table sets must be untouched, and the
      // new sets (rack tiles only) must total >= 30.
      const curKeys = this.board.map(meldKey);
      const beforeKeys = snap.board.map(meldKey);
      for (const k of beforeKeys) {
        if (!curKeys.includes(k)) {
          return { ok: false, reason: 'You can’t rearrange the table until you’ve made your first 30-point meld.' };
        }
      }
      const newMelds = this.board.filter(m => !beforeKeys.includes(meldKey(m)));
      const pts = RK.sumMeldPoints(newMelds).total;
      if (pts < RK.INITIAL_MELD_MIN) {
        return { ok: false, reason: 'Your first meld must total at least 30 points (currently ' + pts + ').' };
      }
      player.melded = true;
    }

    this._recordMove(player, 'played ' + placed.length + ' tile' + (placed.length === 1 ? '' : 's'), placed.map(t => t.id));
    this._endTurn(player, /*placedTiles*/true);
    return { ok: true };
  };

  // ---- AI turn --------------------------------------------------------------
  P.applyAIMove = function () {
    const player = this.currentPlayer();
    const move = RK.ai.decideMove(this, player);
    if (move.type === 'play') {
      this.board = move.newBoard;
      const placed = new Set(move.placedIds);
      player.rack = player.rack.filter(t => !placed.has(t.id));
      if (move.didMeld) player.melded = true;
      this.status = player.name + ' played ' + move.placedIds.length + ' tile' + (move.placedIds.length === 1 ? '' : 's') + '.';
      this._recordMove(player, 'played ' + move.placedIds.length + ' tile' + (move.placedIds.length === 1 ? '' : 's'), move.placedIds);
      this._endTurn(player, true);
    } else {
      this._drawAndPass(player);
    }
  };

  // ---- Drawing (revert any staging, take one tile, pass) --------------------
  P.drawTile = function () {
    const player = this.currentPlayer();
    // Revert any partial staging first — you may only draw if you didn't play.
    this.board = this._snapshot.board.map(m => m.slice());
    player.rack = this._snapshot.rack.slice();
    this._drawAndPass(player);
  };

  P._drawAndPass = function (player) {
    let drew = false;
    if (this.deck.length > 0) { player.rack.push(this.deck.pop()); drew = true; }
    this.status = player.name + (drew ? ' drew a tile.' : ' passed (draw pile empty).');
    this._recordMove(player, drew ? 'drew a tile' : 'passed', []);
    this._endTurn(player, false, /*drew*/drew);
  };

  // ---- Shared turn resolution ----------------------------------------------
  P._endTurn = function (player, placedTiles, drew) {
    if (placedTiles) this.passStreak = 0;
    else if (!drew) this.passStreak++;      // couldn't even draw -> real pass
    else this.passStreak = 0;               // drawing counts as progress

    if (player.rack.length === 0 && !player.finished) this._finish(player);

    // Stall: everyone still in the game passed with an empty pile.
    if (this.phase === 'playing' && this.passStreak >= this.activePlayers().length && this.deck.length === 0) {
      this._endByStall();
      return;
    }
    if (this.phase === 'playing') this._advance();
  };

  P._finish = function (player) {
    player.finished = true;
    player.rank = ++this.finishedCount;
    this.emit('finish', player);
    const remaining = this.activePlayers();
    if (remaining.length === 1) {
      remaining[0].finished = true;
      remaining[0].rank = ++this.finishedCount;
      this._gameOver();
    } else if (remaining.length === 0) {
      this._gameOver();
    }
  };

  P._endByStall = function () {
    // Rank everyone still holding tiles by ascending penalty (fewest points left is best).
    const remaining = this.activePlayers()
      .map(p => ({ p, pen: p.rack.reduce((s, t) => s + RK.tilePenalty(t), 0) }))
      .sort((a, b) => a.pen - b.pen);
    for (const { p } of remaining) { p.finished = true; p.rank = ++this.finishedCount; }
    this._gameOver();
  };

  P._gameOver = function () {
    this.phase = 'over';
    this.ranking = this.players.slice().sort((a, b) => a.rank - b.rank);
    this.emit('gameover', this.ranking);
    this.notify();
  };

  P._advance = function () {
    let i = this.turnIndex;
    for (let step = 0; step < this.players.length; step++) {
      i = (i + 1) % this.players.length;
      if (!this.players[i].finished) { this.turnIndex = i; break; }
    }
    this.beginTurn();
    this.notify();
  };

  // Called by the timer. Try to commit; if that's not possible, draw.
  P.onTimeout = function () {
    const res = this.commitTurn();
    if (!res.ok) this.drawTile();
    return res;
  };
})(window.RK);

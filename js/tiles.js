/* tiles.js — tile model, deck creation, colors, sorting.
 * Everything hangs off the global RK namespace so the app runs from file://
 * without a bundler or module server. */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  // Official Rummikub: 4 colors, numbers 1..13, two copies each = 104, + 2 jokers = 106.
  RK.COLORS = ['red', 'blue', 'orange', 'black'];
  RK.MIN_NUMBER = 1;
  RK.MAX_NUMBER = 13;

  // Tailwind-friendly color tokens for tile faces (kept here so rendering stays declarative).
  RK.COLOR_HEX = {
    red: '#e23b47',
    blue: '#2f7fd1',
    orange: '#f0872b',
    black: '#2b2f38',
  };

  let _idCounter = 0;
  RK.resetIds = function () { _idCounter = 0; };

  RK.makeTile = function (color, number, isJoker) {
    return {
      id: 't' + (_idCounter++),
      color: color || null,     // for jokers this is null until "assigned" by validation
      number: number || null,   // face number; null for jokers
      isJoker: !!isJoker,
    };
  };

  // One physical Rummikub set = 106 tiles (104 numbered + 2 jokers).
  RK.TILES_PER_SET = 106;

  // How many identical sets to deal from, given the player count. A single set
  // comfortably serves up to 4 players (4×14 = 56, leaving 50 to draw). Beyond
  // that we add sets so everyone gets a full hand with a real draw pile — the
  // same way physical Rummikub combines two boxes for big groups.
  RK.deckSetsFor = function (playerCount) {
    const needed = playerCount * 14 + 20;            // hands + a minimum draw pile
    return Math.max(1, Math.ceil(needed / RK.TILES_PER_SET));
  };

  // Build a full, shuffled deck of `sets` identical Rummikub sets (default 1).
  RK.createDeck = function (rng, sets) {
    sets = Math.max(1, sets || 1);
    const deck = [];
    for (let s = 0; s < sets; s++) {
      for (const color of RK.COLORS) {
        for (let n = RK.MIN_NUMBER; n <= RK.MAX_NUMBER; n++) {
          deck.push(RK.makeTile(color, n, false));
          deck.push(RK.makeTile(color, n, false));
        }
      }
      // Two jokers per set, color-tagged only for the printed face.
      deck.push(RK.makeTile('black', null, true));
      deck.push(RK.makeTile('red', null, true));
    }
    return RK.shuffle(deck, rng);
  };

  // Fisher–Yates. Accepts an optional deterministic rng() in [0,1) for reproducible games.
  RK.shuffle = function (arr, rng) {
    const r = rng || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  // Point value of a tile as it sits (used for scoring penalties at game end).
  // A joker penalty is 30; otherwise the face number.
  RK.tilePenalty = function (tile) {
    if (tile.isJoker) return 30;
    return tile.number;
  };

  RK.cloneTile = function (t) { return Object.assign({}, t); };

  // Sort comparators for the rack.
  RK.sortByNumber = function (a, b) {
    if (a.isJoker !== b.isJoker) return a.isJoker ? 1 : -1;
    if (a.number !== b.number) return (a.number || 0) - (b.number || 0);
    return RK.COLORS.indexOf(a.color) - RK.COLORS.indexOf(b.color);
  };
  RK.sortByColor = function (a, b) {
    if (a.isJoker !== b.isJoker) return a.isJoker ? 1 : -1;
    const ca = RK.COLORS.indexOf(a.color), cb = RK.COLORS.indexOf(b.color);
    if (ca !== cb) return ca - cb;
    return (a.number || 0) - (b.number || 0);
  };
})(window.RK);

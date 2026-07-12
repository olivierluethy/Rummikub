/* rules.js — the authoritative rules engine.
 * Pure functions only: given tiles, decide validity / points. No UI, no state. */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  const MIN = RK.MIN_NUMBER, MAX = RK.MAX_NUMBER;

  // ---- Set validation -------------------------------------------------------
  // A "set" is an ordered array of tiles the player laid down as one meld.
  // Returns { valid, type: 'run'|'group'|null, points, reason }.
  // Jokers are resolved to the value that makes the set legal; points reflect
  // the resolved values (a joker in a run of 7-8-J counts the 9 it represents).

  RK.validateSet = function (tiles) {
    if (!tiles || tiles.length < 3) {
      return { valid: false, type: null, points: 0, reason: 'A set needs at least 3 tiles' };
    }
    if (tiles.length > 13) {
      return { valid: false, type: null, points: 0, reason: 'Too many tiles' };
    }
    const asGroup = validateGroup(tiles);
    if (asGroup.valid) return asGroup;
    const asRun = validateRun(tiles);
    if (asRun.valid) return asRun;
    // Prefer the more informative reason.
    return { valid: false, type: null, points: 0,
      reason: asRun.reason || asGroup.reason || 'Not a valid run or group' };
  };

  // GROUP: 3 or 4 tiles, all the SAME number, all DIFFERENT colors.
  function validateGroup(tiles) {
    if (tiles.length < 3 || tiles.length > 4) {
      return { valid: false, reason: 'A group is 3 or 4 tiles' };
    }
    const naturals = tiles.filter(t => !t.isJoker);
    const jokers = tiles.length - naturals.length;
    if (naturals.length === 0) return { valid: false, reason: 'Group needs real tiles' };

    const number = naturals[0].number;
    for (const t of naturals) {
      if (t.number !== number) return { valid: false, reason: 'Group tiles must share a number' };
    }
    const colors = new Set(naturals.map(t => t.color));
    if (colors.size !== naturals.length) {
      return { valid: false, reason: 'Group colors must all differ' };
    }
    // Enough distinct colors remain for the jokers?
    const freeColors = RK.COLORS.filter(c => !colors.has(c)).length;
    if (jokers > freeColors) return { valid: false, reason: 'No color left for a joker' };

    const points = number * tiles.length;
    // Canonical order: naturals by the standard colour order, jokers last.
    const order = naturals.slice().sort((a, b) => RK.COLORS.indexOf(a.color) - RK.COLORS.indexOf(b.color))
      .concat(tiles.filter(t => t.isJoker));
    return { valid: true, type: 'group', points, order, reason: '' };
  }

  // RUN: 3+ tiles, SAME color, CONSECUTIVE numbers. Jokers fill gaps/ends.
  function validateRun(tiles) {
    if (tiles.length < 3) return { valid: false, reason: 'A run is at least 3 tiles' };
    const naturals = tiles.filter(t => !t.isJoker);
    const jokers = tiles.length - naturals.length;
    if (naturals.length === 0) return { valid: false, reason: 'Run needs real tiles' };

    const color = naturals[0].color;
    for (const t of naturals) {
      if (t.color !== color) return { valid: false, reason: 'Run tiles must share a color' };
    }
    const nums = naturals.map(t => t.number).sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) {
      if (nums[i] === nums[i - 1]) return { valid: false, reason: 'Run cannot repeat a number' };
    }
    const span = nums[nums.length - 1] - nums[0] + 1;
    // We may place jokers before the low end, after the high end, and in interior gaps.
    // Interior gaps needed:
    let interiorGaps = 0;
    for (let i = 1; i < nums.length; i++) interiorGaps += (nums[i] - nums[i - 1] - 1);
    if (interiorGaps > jokers) return { valid: false, reason: 'Run has a gap no joker can fill' };

    const jokersLeft = jokers - interiorGaps;
    // Total length after using interior jokers is `span`; remaining jokers extend the ends.
    const totalLen = span + jokersLeft;
    if (span + jokersLeft !== tiles.length) {
      // Sanity: length must line up (shouldn't happen given counts, but guard anyway).
    }
    // The run must fit within 1..13 for *some* placement of the end jokers.
    const lowMost = nums[0] - jokersLeft;         // all leftover jokers below
    const highMost = nums[nums.length - 1] + jokersLeft; // all above
    if (lowMost < MIN && highMost > MAX) {
      return { valid: false, reason: 'Run does not fit within 1–13' };
    }
    if (totalLen < 3) return { valid: false, reason: 'Run too short' };
    if (totalLen > 13) return { valid: false, reason: 'Run too long' };

    // Points: sum of represented values. Choose a valid placement of end jokers.
    // Prefer placing leftover jokers on whichever side keeps things in-range; if both
    // sides fit, extend upward (higher points) — a reasonable, rules-consistent choice.
    let lowStart = nums[0];
    let jl = jokersLeft;
    // First push down as far as legal isn't required; keep the natural anchor and add ends.
    // Compute the concrete sequence of represented numbers.
    let startCandidate = nums[0];
    // If placing all leftover above overflows 13, shift start down.
    let overflow = (nums[nums.length - 1] + jl) - MAX;
    if (overflow > 0) startCandidate = nums[0] - overflow;
    if (startCandidate < MIN) startCandidate = MIN;
    const end = startCandidate + totalLen - 1;
    let points = 0;
    for (let v = startCandidate; v <= end; v++) points += v;

    // Canonical display order: ascending by number, each joker slotted into its
    // logical position (start..end, naturals in place, jokers fill the gaps/ends).
    const byNum = {};
    naturals.forEach(t => { byNum[t.number] = t; });
    const jokerTiles = tiles.filter(t => t.isJoker);
    const order = [];
    let jk = 0;
    for (let v = startCandidate; v <= end; v++) order.push(byNum[v] || jokerTiles[jk++]);

    return { valid: true, type: 'run', points, order, reason: '' };
  }

  // ---- Canonical ordering ---------------------------------------------------
  // Rearrange a meld's tiles into canonical display order *in place*, preserving
  // the array's identity and any layout props (_row/_col/_pinned) hung on it.
  // Invalid melds (e.g. mid-build) are left untouched so nothing jumps around
  // until it's actually a legal set.
  RK.sortMeldInPlace = function (meld) {
    const r = RK.validateSet(meld);
    if (r.valid && r.order && r.order.length === meld.length) {
      meld.splice.apply(meld, [0, meld.length].concat(r.order));
    }
    return meld;
  };

  // The index at which `tile` belongs once added to `meld`, per canonical order
  // (e.g. adding red 12 to 8-9-10-11 returns 4; a joker slots by its value).
  // Falls back to the end if the result wouldn't be a legal set.
  RK.sortedInsertIndex = function (meld, tile) {
    const r = RK.validateSet(meld.concat([tile]));
    if (r.valid && r.order) {
      const idx = r.order.findIndex(t => t.id === tile.id);
      if (idx >= 0) return idx;
    }
    return meld.length;
  };

  // ---- Board / turn validation ---------------------------------------------

  // A board is an array of melds; each meld is an array of tiles. The whole board
  // is valid iff every meld is a valid set.
  RK.validateBoard = function (board) {
    const results = board.map(m => RK.validateSet(m));
    return {
      valid: results.every(r => r.valid),
      results,
    };
  };

  // Points a player would score toward their initial meld from a specific list of
  // NEW melds they just laid (initial meld must total >= 30, own tiles only).
  RK.sumMeldPoints = function (melds) {
    let total = 0;
    for (const m of melds) {
      const r = RK.validateSet(m);
      if (!r.valid) return { valid: false, total: 0 };
      total += r.points;
    }
    return { valid: true, total };
  };

  RK.INITIAL_MELD_MIN = 30;
})(window.RK);

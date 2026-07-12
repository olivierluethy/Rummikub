/* solver.js — combinatorial engine.
 *   RK.solveFull(tiles)  -> array of melds covering EVERY tile, or null.
 *   RK.solveMax(tiles)   -> { melds, used, leftover } maximizing tiles placed.
 * Both handle jokers as wildcards. Counts-based with memoization + a node budget
 * so the AI can never hang the UI. */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  const MIN = RK.MIN_NUMBER, MAX = RK.MAX_NUMBER, JK = 'J';
  const keyNat = (c, n) => c + ':' + n;

  function combinations(arr, k) {
    const res = [];
    (function rec(start, acc) {
      if (acc.length === k) { res.push(acc.slice()); return; }
      for (let i = start; i < arr.length; i++) { acc.push(arr[i]); rec(i + 1, acc); acc.pop(); }
    })(0, []);
    return res;
  }

  function buildCounts(tiles) {
    const counts = Object.create(null);
    const pool = Object.create(null);
    for (const t of tiles) {
      const k = t.isJoker ? JK : keyNat(t.color, t.number);
      counts[k] = (counts[k] || 0) + 1;
      (pool[k] = pool[k] || []).push(t);
    }
    return { counts, pool };
  }

  const serialize = (counts) => Object.keys(counts).sort().map(k => counts[k] ? k + counts[k] : '').join('|');

  function firstNaturalKey(counts) {
    for (const c of RK.COLORS) {
      for (let n = MIN; n <= MAX; n++) {
        const k = keyNat(c, n);
        if (counts[k] > 0) return { key: k, color: c, number: n };
      }
    }
    return null;
  }

  function subtract(counts, cand) {
    const c2 = Object.assign(Object.create(null), counts);
    for (const k of cand) { c2[k] = (c2[k] || 0) - 1; if (c2[k] <= 0) delete c2[k]; }
    return c2;
  }

  // All valid sets (as key-arrays) that contain the anchor natural tile.
  function candidateSets(counts, anchor) {
    const cands = [];
    const J = counts[JK] || 0;
    const { color: ca, number: n } = anchor;

    // --- Groups (same number n) ---
    const availColors = RK.COLORS.filter(c => (counts[keyNat(c, n)] || 0) > 0);
    const others = availColors.filter(c => c !== ca);
    for (let size = 3; size <= 4; size++) {
      for (let jUsed = 0; jUsed <= Math.min(J, size - 1); jUsed++) {
        const needNat = size - jUsed;
        if (needNat < 1 || needNat - 1 > others.length) continue;
        for (const combo of combinations(others, needNat - 1)) {
          const cand = [ca].concat(combo).map(c => keyNat(c, n));
          for (let j = 0; j < jUsed; j++) cand.push(JK);
          cands.push(cand);
        }
      }
    }

    // --- Runs (same color ca, spanning the anchor number) ---
    for (let lo = MIN; lo <= n; lo++) {
      for (let hi = n; hi <= MAX; hi++) {
        const len = hi - lo + 1;
        if (len < 3) continue;
        let missing = 0; const cand = [];
        for (let v = lo; v <= hi; v++) {
          const k = keyNat(ca, v);
          if ((counts[k] || 0) > 0) cand.push(k);
          else { cand.push(JK); missing++; }
        }
        if (missing <= J) cands.push(cand);
      }
    }
    return cands;
  }

  function toConcrete(abstractMelds, pool) {
    // Clone the pool arrays so we can pop without mutating the caller's tiles.
    const p = Object.create(null);
    for (const k in pool) p[k] = pool[k].slice();
    return abstractMelds.map(cand => cand.map(k => p[k].pop()));
  }

  const NODE_BUDGET = 30000;

  // Full partition: every tile ends up in a valid set, or null.
  RK.solveFull = function (tiles) {
    if (tiles.length === 0) return [];
    const { counts, pool } = buildCounts(tiles);
    const memo = Object.create(null);
    let nodes = 0;

    function rec(counts) {
      if (++nodes > NODE_BUDGET) return null;
      const s = serialize(counts);
      if (s in memo) return memo[s];
      const anchor = firstNaturalKey(counts);
      if (!anchor) { const r = (counts[JK] > 0) ? null : []; memo[s] = r; return r; }
      for (const cand of candidateSets(counts, anchor)) {
        // Ensure availability of every key in the candidate.
        let ok = true; const need = Object.create(null);
        for (const k of cand) { need[k] = (need[k] || 0) + 1; if (need[k] > (counts[k] || 0)) { ok = false; break; } }
        if (!ok) continue;
        const sub = rec(subtract(counts, cand));
        if (sub !== null) { const r = [cand].concat(sub); memo[s] = r; return r; }
      }
      memo[s] = null; return null;
    }

    const abstract = rec(counts);
    return abstract ? toConcrete(abstract, pool) : null;
  };

  // Maximize tiles placed; leftover tiles are allowed (returned in `leftover`).
  RK.solveMax = function (tiles) {
    if (tiles.length === 0) return { melds: [], used: 0, leftover: [] };
    const { counts, pool } = buildCounts(tiles);
    const memo = Object.create(null);
    let nodes = 0;

    function rec(counts) {
      if (++nodes > NODE_BUDGET) return { used: 0, melds: [] };
      const s = serialize(counts);
      if (s in memo) return memo[s];
      const anchor = firstNaturalKey(counts);
      if (!anchor) { const r = { used: 0, melds: [] }; memo[s] = r; return r; }

      // Option 1: leave the anchor unplaced (leftover).
      let best = rec(subtract(counts, [anchor.key]));

      // Option 2: place the anchor inside some set.
      for (const cand of candidateSets(counts, anchor)) {
        let ok = true; const need = Object.create(null);
        for (const k of cand) { need[k] = (need[k] || 0) + 1; if (need[k] > (counts[k] || 0)) { ok = false; break; } }
        if (!ok) continue;
        const sub = rec(subtract(counts, cand));
        const used = cand.length + sub.used;
        if (used > best.used) best = { used, melds: [cand].concat(sub.melds) };
      }
      memo[s] = best; return best;
    }

    const r = rec(counts);
    const melds = toConcrete(r.melds, pool);
    const usedIds = new Set();
    melds.forEach(m => m.forEach(t => usedIds.add(t.id)));
    const leftover = tiles.filter(t => !usedIds.has(t.id));
    return { melds, used: r.used, leftover };
  };

  function canTake(counts, cand) {
    const need = Object.create(null);
    for (const k of cand) { need[k] = (need[k] || 0) + 1; if (need[k] > (counts[k] || 0)) return false; }
    return true;
  }

  // Greedy set extraction — robust and fast even for very large racks (where the
  // exponential solveMax bails). Repeatedly pulls the longest available set.
  RK.layRackSets = function (tiles) {
    let { counts, pool } = buildCounts(tiles);
    const melds = [];
    let progress = true;
    while (progress) {
      progress = false;
      let bestCand = null;
      for (const c of RK.COLORS) {
        for (let n = MIN; n <= MAX; n++) {
          const k = keyNat(c, n);
          if (!(counts[k] > 0)) continue;
          for (const cand of candidateSets(counts, { key: k, color: c, number: n })) {
            if (canTake(counts, cand) && (!bestCand || cand.length > bestCand.length)) bestCand = cand;
          }
        }
      }
      if (bestCand) { counts = subtract(counts, bestCand); melds.push(bestCand); progress = true; }
    }
    return toConcrete(melds, pool);
  };

  // Unified "lay the best sets from a rack": optimal for small racks, greedy for big.
  RK.findMelds = function (tiles) {
    if (tiles.length <= 15) return RK.solveMax(tiles).melds;
    return RK.layRackSets(tiles);
  };

  // Manipulation: every TABLE tile must stay on the board; place as many RACK
  // tiles as possible. Single memoized search (not 42 re-solves) so an Expert
  // turn stays well under ~half a second even on a full board.
  // Returns { melds (concrete), placedRack } or null if no rack tile fits.
  RK.solveManipulation = function (tableTiles, rackTiles, budget) {
    const all = tableTiles.concat(rackTiles);
    if (all.length === 0) return null;
    const { counts, pool } = buildCounts(all);
    const optional = buildCounts(rackTiles).counts;   // how many of each key may be left in the rack
    const memo = Object.create(null);
    let nodes = 0;
    const LIMIT = budget || 200000;

    const serSkip = (skip) => { let s = ''; for (const k in skip) if (skip[k]) s += k + skip[k]; return s; };

    function rec(counts, skip) {
      if (++nodes > LIMIT) return null;                // bail -> caller falls back
      const key = serialize(counts) + '#' + serSkip(skip);
      if (key in memo) return memo[key];

      const anchor = firstNaturalKey(counts);
      if (!anchor) {
        // Only jokers (or nothing) remain. A leftover joker is legal iff it's a rack joker.
        const jk = counts[JK] || 0;
        const r = (jk === 0 || (skip[JK] || 0) >= jk) ? { used: 0, melds: [] } : null;
        memo[key] = r; return r;
      }

      let best = null;
      // Option A: leave the anchor in the rack (only if budget allows).
      if ((skip[anchor.key] || 0) > 0) {
        const s2 = Object.assign(Object.create(null), skip); s2[anchor.key]--;
        const sub = rec(subtract(counts, [anchor.key]), s2);
        if (sub) best = sub;                            // used unchanged (anchor not placed)
      }
      // Option B: place the anchor inside a set.
      for (const cand of candidateSets(counts, anchor)) {
        let ok = true; const need = Object.create(null);
        for (const k of cand) { need[k] = (need[k] || 0) + 1; if (need[k] > (counts[k] || 0)) { ok = false; break; } }
        if (!ok) continue;
        const sub = rec(subtract(counts, cand), skip);
        if (sub) {
          const used = cand.length + sub.used;
          if (!best || used > best.used) best = { used, melds: [cand].concat(sub.melds) };
        }
      }
      memo[key] = best; return best;
    }

    const r = rec(counts, optional);
    if (!r) return null;
    // Concretize TABLE-first (pool has table tiles before rack tiles for each key,
    // and we shift from the front) so every mandatory tile lands on the board and
    // only rack tiles can ever be left over. Prevents orphaning a table tile when
    // a rack tile shares its color+number.
    const p = Object.create(null);
    for (const k in pool) p[k] = pool[k].slice();
    const melds = r.melds.map(cand => cand.map(k => p[k].shift()));
    const rackIds = new Set(rackTiles.map(t => t.id));
    const placedRack = [];
    melds.forEach(m => m.forEach(t => { if (rackIds.has(t.id)) placedRack.push(t); }));
    if (placedRack.length === 0) return null;           // nothing gained
    return { melds, placedRack };
  };
})(window.RK);

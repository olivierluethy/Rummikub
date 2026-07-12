/* ai.js — opponent decision making.
 * decideMove() returns:
 *   { type:'play', newBoard, placedIds, didMeld }  // lay/rearrange, then end turn
 *   { type:'draw' }                                 // couldn't/won't play; draw
 *
 * Performance principle: NEVER re-solve the whole board (NP-hard, blows up past
 * ~25 tiles). Manipulate LOCALLY — feed the solver one meld plus its handful of
 * "related" rack tiles at a time (tiny inputs, sub-millisecond) and loop until
 * stable, then lay new rack-only sets. Expert also gets a single bounded global
 * pass, but only while the board is still small enough to solve quickly. */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  RK.ai = RK.ai || {};

  const flat = (board) => board.reduce((a, m) => a.concat(m), []);
  const byValueDesc = (a, b) => RK.tilePenalty(b) - RK.tilePenalty(a);
  const idsIn = (board) => new Set(flat(board).map(t => t.id));
  const placedFrom = (rack, newBoard) => {
    const b = idsIn(newBoard);
    return rack.filter(t => b.has(t.id)).map(t => t.id);
  };

  // Rack tiles that could plausibly extend a given meld (keeps solver inputs tiny).
  function relatedCandidates(meld, rack) {
    const r = RK.validateSet(meld);
    const jokers = rack.filter(t => t.isJoker).slice(0, 2);
    let cands = [];
    const anchor = meld.find(t => !t.isJoker);
    if (!anchor) return jokers;
    if (r.type === 'run') {
      const nums = meld.filter(t => !t.isJoker).map(t => t.number);
      const lo = Math.min(...nums), hi = Math.max(...nums);
      cands = rack.filter(t => !t.isJoker && t.color === anchor.color && t.number >= lo - 3 && t.number <= hi + 3);
    } else if (r.type === 'group') {
      const have = new Set(meld.filter(t => !t.isJoker).map(t => t.color));
      cands = rack.filter(t => !t.isJoker && t.number === anchor.number && !have.has(t.color));
    }
    return cands.slice(0, 6).concat(jokers);
  }

  // Fast local manipulation: absorb rack tiles meld-by-meld, then lay new sets.
  function planLocalManip(board, rack) {
    let work = board.map(m => m.slice());
    let remaining = rack.slice();
    let changed = true, guard = 0;
    while (changed && guard++ < 40) {
      changed = false;
      for (let i = 0; i < work.length; i++) {
        const cand = relatedCandidates(work[i], remaining);
        if (!cand.length) continue;
        const res = RK.solveManipulation(work[i], cand, 20000);
        if (res && res.placedRack.length) {
          const placed = new Set(res.placedRack.map(t => t.id));
          remaining = remaining.filter(t => !placed.has(t.id));
          work.splice(i, 1, ...res.melds);
          changed = true; break;
        }
      }
    }
    // Lay brand-new sets built purely from what's left in the rack.
    for (const m of RK.findMelds(remaining)) work.push(m);
    return work;
  }

  // Easy/Medium: only simple appends + new rack sets (Easy skips appends).
  function planSimple(board, rack, allowAppends) {
    let work = board.map(m => m.slice());
    let remaining = rack.slice();
    if (allowAppends) {
      let changed = true;
      while (changed) {
        changed = false;
        for (const meld of work) {
          for (let i = 0; i < remaining.length; i++) {
            if (RK.validateSet(meld.concat([remaining[i]])).valid) {
              meld.push(remaining[i]); remaining.splice(i, 1); changed = true; break;
            }
          }
        }
      }
    }
    for (const m of RK.findMelds(remaining)) work.push(m);
    return work;
  }

  // Best legal board that places >0 rack tiles, or null. Shared by AI + human hint.
  RK.ai.bestBoard = function (board, rack, difficulty) {
    let candidates = [];
    if (difficulty === 'hard' || difficulty === 'expert') {
      candidates.push(planLocalManip(board, rack));
      // Expert bonus: one bounded global re-solve while the board is still small,
      // to catch cross-meld tile "steals" the local pass misses.
      if (difficulty === 'expert' && flat(board).length <= 18) {
        const g = RK.solveManipulation(flat(board), rack, 120000);
        if (g) candidates.push(g.melds);
      }
    } else {
      candidates.push(planSimple(board, rack, difficulty !== 'easy'));
    }
    const tableIds = idsIn(board);
    let best = null, bestCount = 0;
    for (const nb of candidates) {
      if (!nb) continue;
      const placed = placedFrom(rack, nb);
      const legal = RK.validateBoard(nb).valid;
      const keptTable = [...tableIds].every(id => idsIn(nb).has(id));
      if (placed.length > bestCount && legal && keptTable) { best = nb; bestCount = placed.length; }
    }
    return best;
  };

  RK.ai.decideMove = function (game, player) {
    const diff = game.difficulty;

    // Not melded yet: need >=30 points from the rack alone (no table manipulation).
    if (!player.melded) {
      const meldable = RK.findMelds(player.rack);
      const pts = RK.sumMeldPoints(meldable).total;
      const willMeld = pts >= RK.INITIAL_MELD_MIN && !(diff === 'easy' && Math.random() < 0.25);
      if (willMeld && meldable.length) {
        const newBoard = game.board.concat(meldable);
        return { type: 'play', newBoard, placedIds: placedFrom(player.rack, newBoard), didMeld: true };
      }
      return { type: 'draw' };
    }

    // Already melded: place as much as possible.
    const nb = RK.ai.bestBoard(game.board, player.rack, diff);
    if (nb) return { type: 'play', newBoard: nb, placedIds: placedFrom(player.rack, nb), didMeld: false };
    return { type: 'draw' };
  };
})(window.RK);

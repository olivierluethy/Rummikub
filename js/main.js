/* main.js — menu, game bootstrapping, turn timer, AI scheduling, controls.
 * The networking boundary lives behind config.mode; a future 'online' mode can
 * reuse the exact same Game + UI by feeding remote moves through applyRemote(). */
window.RK = window.RK || {};

(function (RK) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let game = null, timerInt = null, remaining = 0;

  // ---- Menu -----------------------------------------------------------------
  const menuState = { mode: 'single', aiCount: 1, localCount: 2 };

  function setMode(mode) {
    menuState.mode = mode;
    $('tab-single').className = tabClass(mode === 'single');
    $('tab-local').className = tabClass(mode === 'local');
    $('single-opts').classList.toggle('hidden', mode !== 'single');
    $('local-opts').classList.toggle('hidden', mode !== 'local');
    RK.audio.play('button');
  }
  const tabClass = (on) =>
    'flex-1 py-2.5 rounded-xl font-semibold transition ' +
    (on ? 'bg-amber-400 text-slate-900' : 'bg-white/5 text-white/70 hover:bg-white/10');

  function renderLocalNames() {
    const wrap = $('local-names');
    wrap.innerHTML = '';
    for (let i = 0; i < menuState.localCount; i++) {
      const inp = document.createElement('input');
      inp.className = 'w-full rounded-lg bg-white/5 px-3 py-2 outline-none ring-1 ring-white/10 focus:ring-amber-400';
      inp.placeholder = 'Player ' + (i + 1);
      inp.value = 'Player ' + (i + 1);
      inp.dataset.localName = i;
      wrap.appendChild(inp);
    }
  }

  function buildConfig() {
    const timer = $('opt-timer').checked ? 60 : 0;
    if (menuState.mode === 'single') {
      const name = ($('single-name').value || 'You').trim();
      const diff = $('single-diff').value;
      const n = parseInt($('single-ai').value, 10);
      const players = [{ name, isAI: false }];
      const bots = ['Ruby', 'Sapphire', 'Onyx'];
      for (let i = 0; i < n; i++) players.push({ name: bots[i] + ' (AI)', isAI: true });
      return { mode: 'single', difficulty: diff, timerSeconds: timer, players };
    }
    const players = [...document.querySelectorAll('[data-local-name]')]
      .map((inp, i) => ({ name: (inp.value || 'Player ' + (i + 1)).trim(), isAI: false }));
    return { mode: 'local', difficulty: 'medium', timerSeconds: timer, players };
  }

  // ---- Timer ----------------------------------------------------------------
  function stopTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } }
  function resetTimer() {
    stopTimer();
    const box = $('timer-box');
    if (game.timerSeconds > 0 && game.isHumanTurn() && game.phase === 'playing') {
      remaining = game.timerSeconds;
      box.classList.remove('hidden');
      $('timer-text').textContent = remaining + 's';
      timerInt = setInterval(() => {
        remaining--;
        $('timer-text').textContent = remaining + 's';
        $('timer-text').className = remaining <= 10 ? 'text-red-400 font-bold' : 'font-bold';
        if (remaining <= 0) { stopTimer(); game.onTimeout(); }
      }, 1000);
    } else {
      box.classList.add('hidden');
    }
  }

  // ---- Turn/AI orchestration ------------------------------------------------
  function wireGame() {
    game.on('turnstart', (p) => {
      resetTimer();
      if (p.isAI && game.phase === 'playing') {
        setTimeout(() => {
          if (game.currentPlayer() === p && game.phase === 'playing') {
            RK.audio.play('shuffle');
            game.applyAIMove();
          }
        }, 750);
      }
    });
    game.on('finish', (p) => { RK.audio.play('victory'); });
    game.on('gameover', (ranking) => { stopTimer(); showGameOver(ranking); RK.audio.play('victory'); });
  }

  // ---- Controls -------------------------------------------------------------
  function endTurn() {
    const res = game.commitTurn();
    if (res.ok) { RK.audio.play('place'); }
    else if (res.mustDraw) { game.notify('You haven’t placed any tiles — make a move or press Draw.'); RK.audio.play('invalid'); }
    else { game.notify(res.reason); RK.audio.play('invalid'); }
  }

  function wireControls() {
    $('btn-end').onclick = endTurn;
    $('btn-draw').onclick = () => { game.drawTile(); RK.audio.play('draw'); };
    $('btn-reset').onclick = () => { game.undoTurn(); RK.audio.play('button'); };
    $('btn-sort-num').onclick = () => RK.ui.sortRack('number');
    $('btn-sort-color').onclick = () => RK.ui.sortRack('color');
    $('btn-best').onclick = () => RK.ui.suggest();
    $('zoom-in').onclick = () => { const r = $('board-viewport').getBoundingClientRect(); RK.ui.zoomAround(r.left + r.width / 2, r.top + r.height / 2, 1.15); };
    $('zoom-out').onclick = () => { const r = $('board-viewport').getBoundingClientRect(); RK.ui.zoomAround(r.left + r.width / 2, r.top + r.height / 2, 0.87); };
    $('zoom-reset').onclick = () => RK.ui.resetView();

    // Settings
    $('btn-settings').onclick = () => $('settings-modal').classList.remove('hidden');
    $('settings-close').onclick = () => $('settings-modal').classList.add('hidden');
    $('opt-music').onchange = (e) => RK.audio.setMusic(e.target.checked);
    $('opt-sfx').onchange = (e) => RK.audio.setSfx(e.target.checked);
    $('btn-newgame').onclick = () => { stopTimer(); $('game').classList.add('hidden'); $('menu').classList.remove('hidden'); };
    $('gameover-again').onclick = () => { $('gameover-modal').classList.add('hidden'); $('game').classList.add('hidden'); $('menu').classList.remove('hidden'); };
  }

  // ---- Game over ------------------------------------------------------------
  function showGameOver(ranking) {
    const medals = ['🥇', '🥈', '🥉', '4️⃣'];
    const list = $('gameover-list');
    list.innerHTML = '';
    ranking.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between rounded-xl px-4 py-3 ' +
        (i === 0 ? 'bg-amber-400/20 ring-1 ring-amber-400' : 'bg-white/5');
      row.innerHTML = '<span class="text-2xl">' + (medals[i] || (i + 1) + '.') + '</span>' +
        '<span class="font-semibold flex-1 ml-3">' + p.name + '</span>' +
        '<span class="text-white/60">' + (i === ranking.length - 1 ? 'Last place' : ordinal(p.rank) + ' place') + '</span>';
      list.appendChild(row);
    });
    $('gameover-modal').classList.remove('hidden');
  }
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n] || 'th');

  // ---- Start ----------------------------------------------------------------
  function startGame() {
    RK.audio.init();
    RK.audio.play('shuffle');
    const config = buildConfig();
    if (config.players.length < 2) { alert('Need at least 2 players.'); return; }
    game = new RK.Game(config);
    wireGame();
    $('menu').classList.add('hidden');
    $('game').classList.remove('hidden');
    RK.ui.mount(game);
    resetTimer();
  }

  // ---- Init -----------------------------------------------------------------
  window.addEventListener('DOMContentLoaded', () => {
    $('tab-single').textContent = 'Single Player';
    $('tab-local').textContent = 'Local Multiplayer';
    $('tab-single').onclick = () => setMode('single');
    $('tab-local').onclick = () => setMode('local');
    $('single-ai').onchange = (e) => { menuState.aiCount = +e.target.value; };
    $('local-count').onchange = (e) => { menuState.localCount = +e.target.value; renderLocalNames(); };
    $('btn-start').onclick = startGame;
    renderLocalNames();
    setMode('single');
    wireControls();
  });
})(window.RK);

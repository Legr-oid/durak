'use strict';
/*
 * ui.js — всё, что видно на экране: отрисовка, тапы по картам, кнопки, статистика,
 * а также экраны сетевой игры: имя, создание стола, лобби.
 *
 * Правила игры сюда не заезжают: за них отвечает game.js (объект Durak).
 * Сеть сюда тоже не заезжает: за неё отвечает net.js (объект DurakNet).
 * Здесь мы только спрашиваем «что сейчас можно» и показываем это.
 *
 * Два режима, один и тот же экран игры:
 *
 *   офлайн — состояние партии живёт прямо здесь, боты ходят по таймеру;
 *   сеть   — состояние считает создатель стола, сюда приходит только СРЕЗ
 *            (своя рука + публичный стол), а ходы уезжают как намерения.
 *
 * Место местного человека — переменная `me`: в офлайне это всегда 0,
 * в сети — то место, которое выдал создатель стола.
 */

(function () {

  var D = Durak;
  var N = (typeof DurakNet !== 'undefined') ? DurakNet : null;
  var me = 0;                       // место локального человека
  function $(id) { return document.getElementById(id); }

  /* ======================================================================
     ХРАНИЛИЩЕ: настройки, имя и статистика в localStorage
     Один ключ, версионированный JSON — формат {v:1, ...} не меняем.
     ====================================================================== */

  var KEY = 'durak_v1';
  var MODE_KEYS = ['plain', 'podkidnoy', 'perevodnoy', 'both'];
  var PLAYER_KEYS = ['2', '3', '4', '5', '6'];

  function emptyRow() {
    return { games: 0, wins: 0, losses: 0, draws: 0, streak: 0, best: 0 };
  }

  function copyRow(r) {
    return {
      games: r.games | 0, wins: r.wins | 0, losses: r.losses | 0,
      draws: r.draws | 0, streak: r.streak | 0, best: r.best | 0
    };
  }

  function emptyRows(keys) {
    var o = {}, i;
    for (i = 0; i < keys.length; i++) o[keys[i]] = emptyRow();
    return o;
  }

  function freshStore() {
    return {
      v: 1,
      playerId: 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
      nick: '',              // имя для игры с друзьями; в офлайне не нужно
      createdAt: new Date().toISOString(),
      updatedAt: null,
      settings: { podkidnoy: true, perevodnoy: false, players: 2 },
      stats: { modes: emptyRows(MODE_KEYS), players: emptyRows(PLAYER_KEYS), total: emptyRow() },
      history: []            // последние 50 партий
    };
  }

  var store = loadStore();

  function loadStore() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.v === 1 && o.stats && o.stats.modes) {
          var i;
          // добиваем недостающие поля, если формат чуть старее
          for (i = 0; i < MODE_KEYS.length; i++) {
            if (!o.stats.modes[MODE_KEYS[i]]) o.stats.modes[MODE_KEYS[i]] = emptyRow();
          }
          if (!o.stats.total) o.stats.total = emptyRow();

          // Записи прошлой версии: разреза по числу игроков ещё не было.
          // Все те партии игрались один на один — переносим их в строку «2», не затирая.
          if (!o.stats.players) {
            o.stats.players = emptyRows(PLAYER_KEYS);
            o.stats.players['2'] = copyRow(o.stats.total);
            o.migratedAt = new Date().toISOString();
          } else {
            for (i = 0; i < PLAYER_KEYS.length; i++) {
              if (!o.stats.players[PLAYER_KEYS[i]]) o.stats.players[PLAYER_KEYS[i]] = emptyRow();
            }
          }

          if (!o.settings) o.settings = { podkidnoy: true, perevodnoy: false, players: 2 };
          if (!o.settings.players) o.settings.players = 2;
          if (!o.history) o.history = [];
          for (i = 0; i < o.history.length; i++) {
            if (!o.history[i].players) o.history[i].players = 2;
          }
          if (!o.playerId) o.playerId = freshStore().playerId;
          if (typeof o.nick !== 'string') o.nick = '';    // новое поле, старые записи не ломает
          return o;
        }
      }
    } catch (e) { /* повреждённые данные — начинаем с чистого листа */ }
    return freshStore();
  }

  function saveStore() {
    try {
      store.updatedAt = new Date().toISOString();
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch (e) { /* приватный режим браузера — просто не сохраняем */ }
  }

  function bump(row, outcome) {
    row.games++;
    if (outcome === 'win') {
      row.wins++;
      row.streak++;
      if (row.streak > row.best) row.best = row.streak;
    } else if (outcome === 'loss') {
      row.losses++;
      row.streak = 0;
    } else {
      row.draws++;        // ничья серию не ломает, но и не продолжает
    }
  }

  function recordResult(modeKey, players, outcome) {
    var pk = String(players);
    if (!store.stats.players[pk]) store.stats.players[pk] = emptyRow();
    bump(store.stats.modes[modeKey], outcome);
    bump(store.stats.players[pk], outcome);
    bump(store.stats.total, outcome);
    store.history.push({ mode: modeKey, players: players, outcome: outcome, ts: Date.now() });
    if (store.history.length > 50) store.history.shift();
    saveStore();
  }

  /* ======================================================================
     ЭКРАНЫ
     ====================================================================== */

  var screens = {
    menu: $('scr-menu'), nick: $('scr-nick'), friends: $('scr-friends'),
    lobby: $('scr-lobby'), stats: $('scr-stats'), game: $('scr-game')
  };

  function show(name) {
    for (var k in screens) screens[k].classList.toggle('hidden', k !== name);
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ======================================================================
     ИГРОВОЕ СОСТОЯНИЕ ИНТЕРФЕЙСА
     ====================================================================== */

  var state = null;        // состояние партии (в сети — собранное из среза)
  var botTimer = null;     // таймер «бот думает» (только офлайн)
  var transferMode = false;// игрок нажал «Перевести» и выбирает карту
  var recorded = false;    // результат партии уже записан в статистику
  var moveGuard = 0;       // страховка от бесконечного цикла
  var seen = {};           // id карт, которые уже были на экране (для анимации новых)

  var net = null;          // соединение со столом или null в офлайне
  var netLegal = null;     // что мне можно — считает создатель стола
  var netLobby = null;     // последний снимок лобби
  var netStatus = 'idle';
  var netGen = -1;         // номер партии за столом
  var findT = null;        // сторож: столько ждём ответа от создателя стола
  var FIND_MS = 12000;
  var pending = false;     // ход отправлен, ответа ещё нет
  var pendingT = null;

  var handEl = $('hand'), tableEl = $('table'), deckEl = $('deckbox'), seatsEl = $('seats');
  var statusMainEl = $('status-main'), statusLogEl = $('status-log'), controlsEl = $('controls');
  var gameScreenEl = $('scr-game');

  var EMPTY_LEGAL = {
    actor: null, play: [], transfer: [], canTake: false, canDone: false,
    doneLabel: '', isMainAttacker: false, transferTo: -1
  };

  function myLegal() {
    if (!state) return EMPTY_LEGAL;
    if (net) return netLegal || EMPTY_LEGAL;
    return D.legal(state, me);
  }

  /* ======================================================================
     СТАРТ ОФЛАЙН-ПАРТИИ
     ====================================================================== */

  function newGame() {
    stopBot();
    closeNet();
    me = 0;
    netLegal = null;
    var n = store.settings.players || 2;
    // Места раздаём здесь, а не в движке: движку всё равно, кто чем управляет.
    var seats = D.defaultSeats(n);
    seats[me].kind = 'human';
    state = D.create({
      players: n,
      podkidnoy: store.settings.podkidnoy,
      perevodnoy: store.settings.perevodnoy,
      seats: seats
    });
    transferMode = false;
    recorded = false;
    moveGuard = 0;
    seen = {};
    $('overlay').classList.add('hidden');
    enterGameScreen();
    render();
    scheduleBot();          // вдруг первым ходит не человек
  }

  function enterGameScreen() {
    var n = state.opts.players;
    gameScreenEl.setAttribute('data-players', String(n));
    var label = D.MODE_NAME[D.modeKey(state.opts)] + ' · ' + n;
    if (net) label += ' · ' + net.code;
    $('game-mode').textContent = label;
    $('btn-new').classList.toggle('hidden', !!net && !net.isHost);
    show('game');
  }

  function stopBot() {
    if (botTimer) { clearTimeout(botTimer); botTimer = null; }
  }

  /* ======================================================================
     ХОД БОТА (только офлайн; в сети ботов двигает создатель стола)
     ====================================================================== */

  var BOT_DELAY = { 2: 700, 3: 580, 4: 470, 5: 390, 6: 330 };

  function scheduleBot() {
    stopBot();
    render();
    if (!state) return;
    if (state.over) { finishGame(); return; }
    if (net) return;
    var actor = D.actorOf(state);
    if (actor === null || state.seats[actor].kind !== 'bot') return;   // сейчас ходит человек
    var base = BOT_DELAY[state.opts.players] || 500;
    botTimer = setTimeout(botStep, base + Math.random() * (base * 0.25));
  }

  function botStep() {
    botTimer = null;
    if (!state || state.over) { scheduleBot(); return; }

    if (++moveGuard > 4000) {                        // теоретический тупик — не зацикливаемся
      statusMainEl.textContent = 'Что-то пошло не так. Начни новую партию.';
      return;
    }

    var actor = D.actorOf(state);
    var act = D.botMove(state, actor);
    var ok = act ? D.apply(state, act) : false;
    if (!ok) {
      // страховка: если бот почему-то предложил недопустимый ход, закрываем ход сами
      ok = D.apply(state, { type: 'take', p: actor }) || D.apply(state, { type: 'done', p: actor });
      if (!ok) {
        statusMainEl.textContent = 'Ход невозможен. Начни новую партию.';
        return;
      }
    }
    scheduleBot();
  }

  /* ======================================================================
     ХОД ЧЕЛОВЕКА
     ====================================================================== */

  function doAction(action) {
    if (!state || state.over) return;
    if (D.actorOf(state) !== me) return;             // не наш ход — игнорируем тапы

    if (net) {
      if (pending) return;                           // ход уже отправлен, ждём ответа
      pending = true;
      clearTimeout(pendingT);
      pendingT = setTimeout(function () { pending = false; render(); }, 2500);
      transferMode = false;
      net.act({ type: action.type, cardId: action.cardId });
      render();
      return;
    }

    action.p = me;
    if (!D.apply(state, action)) return;
    transferMode = false;
    moveGuard = 0;
    scheduleBot();
  }

  handEl.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('.card') : null;
    if (!el || !state || state.over) return;
    if (D.actorOf(state) !== me) return;

    var id = el.getAttribute('data-id');
    var L = myLegal();

    if (transferMode) {
      if (L.transfer.indexOf(id) >= 0) doAction({ type: 'transfer', cardId: id });
      return;
    }
    if (L.play.indexOf(id) < 0) return;              // этой картой сейчас нельзя
    doAction({ type: state.phase === 'defend' ? 'defend' : 'attack', cardId: id });
  });

  /* ======================================================================
     ОТРИСОВКА
     ====================================================================== */

  function render() {
    if (!state) return;
    var L = myLegal();
    renderSeats();
    renderDeck();
    renderTable();
    renderHand(L);
    renderStatus(L);
    renderControls(L);
    renderNetbar();
    layoutHand();
  }

  /* ---------- Соперники по краю стола ---------- */

  function renderSeats() {
    var n = state.opts.players, h = '', k;
    seatsEl.className = 'seats n' + n;
    // соседей показываем по кругу начиная со следующего за мной
    for (k = 1; k < n; k++) h += seatHtml((me + k) % n);
    seatsEl.innerHTML = h;
  }

  // Роль игрока прямо сейчас: важно видеть, кто атакует, кто отбивается, кто вышел
  function seatRole(i) {
    if (state.out[i]) return { cls: 'out', txt: 'вышел' };
    if (state.over) return { cls: '', txt: '' };
    if (state.defender === i) return { cls: 'def', txt: 'отбивается' };
    if (state.attacker === i) return { cls: 'atk', txt: 'атакует' };
    if ((state.phase === 'attack' || state.phase === 'take') && state.thrower === i) {
      return { cls: 'thr', txt: 'подкидывает' };
    }
    return { cls: '', txt: '' };
  }

  function seatHtml(i) {
    var cnt = state.hands[i].length;
    var role = seatRole(i);
    var seat = state.seats[i];
    var turn = (!state.over && D.actorOf(state) === i) ? ' turn' : '';
    var cls = 'seat' + (role.cls ? ' ' + role.cls : '') + turn;

    if (state.opts.players === 2) {
      // Стол на двоих — как в первой версии: веер рубашек и подпись под ним
      var backs = '', k;
      for (k = 0; k < cnt; k++) backs += '<div class="card back"></div>';
      return '<div class="' + cls + ' wide">' +
               '<div class="opp-hand">' + backs + '</div>' +
               '<div class="opp-info">' + esc(seat.name) + ' · ' + cnt + ' ' +
                 D.plural(cnt, 'карта', 'карты', 'карт') + '</div>' +
             '</div>';
    }

    var mini = '', shown = Math.min(cnt, 5), j;
    for (j = 0; j < shown; j++) mini += '<i></i>';
    if (!cnt) mini = '<i class="none"></i>';
    return '<div class="' + cls + '">' +
             '<div class="s-cards">' + mini + '</div>' +
             '<div class="s-name">' + esc(seat.name) + ' <b>' + cnt + '</b></div>' +
             '<div class="s-role">' + role.txt + '</div>' +
           '</div>';
  }

  /* ---------- Колода и стол ---------- */

  function renderDeck() {
    var n = state.deck.length, tc = state.trumpCard, h = '';
    if (n > 1) {
      h = '<div class="deck">' + card(tc, 'trump-card') + '<div class="card back"></div>' +
          '<span class="cnt">' + n + '</span></div>';
    } else if (n === 1) {
      h = '<div class="deck last">' + card(tc, 'trump-card') + '<span class="cnt">1</span></div>';
    } else {
      var red = (state.trump === 'H' || state.trump === 'D');
      h = '<div class="deck-empty' + (red ? ' red-suit' : '') + '">' + D.SUIT_SYM[state.trump] +
          '<small>козырь</small></div>';
    }
    h += '<div class="pile">Бито<b>' + state.discard + '</b></div>';
    deckEl.innerHTML = h;
  }

  function renderTable() {
    if (!state.table.length) {
      tableEl.innerHTML = '<span class="empty-hint">Стол пуст</span>';
      return;
    }
    var h = '', i;
    for (i = 0; i < state.table.length; i++) {
      var p = state.table[i];
      h += '<div class="pair">' + card(p.a) + (p.d ? card(p.d, 'def') : '') + '</div>';
    }
    tableEl.innerHTML = h;
  }

  function renderHand(L) {
    var hand = state.hands[me], h = '', i;
    var active = transferMode ? L.transfer : L.play;
    var myTurn = D.actorOf(state) === me && !state.over && !pending;

    for (i = 0; i < hand.length; i++) {
      var c = hand[i];
      var cls = '';
      if (myTurn) {
        if (active.indexOf(c.id) >= 0) cls = 'playable' + (transferMode ? ' tr-mode' : '');
        else cls = 'dim';
      }
      h += card(c, cls);
    }
    handEl.innerHTML = h;
  }

  // Обёртка вокруг разметки карты + отметка «новая» для лёгкой анимации
  function card(c, extra) {
    var red = (c.s === 'H' || c.s === 'D');
    var fresh = seen[c.id] ? '' : ' fresh';
    seen[c.id] = true;
    var lab = D.RANK_LABEL[c.r], sym = D.SUIT_SYM[c.s];
    return '<div class="card' + (red ? ' red' : '') + (extra ? ' ' + extra : '') + fresh +
           '" data-id="' + c.id + '">' +
             '<span class="c-top">' + lab + '<i>' + sym + '</i></span>' +
             '<span class="c-mid">' + sym + '</span>' +
             '<span class="c-bot">' + lab + '<i>' + sym + '</i></span>' +
           '</div>';
  }

  /* ---------- Подсказка ---------- */

  function renderStatus(L) {
    statusMainEl.textContent = mainHint(L);
    var last = state.log.length ? state.log[state.log.length - 1] : '';
    statusLogEl.innerHTML = colorSuits(last);
  }

  function nameOf(p) { return state.seats[p].name; }

  // В офлайне на двоих соперник зовётся просто «бот» — как в первой версии.
  // В сети за столом живые люди, там всегда по имени.
  function soloBot() { return !net && state.opts.players === 2; }

  function mainHint(L) {
    if (state.over) {
      if (state.result.draw) {
        return state.result.stalemate ? 'Ничья — побить уже нечем' : 'Ничья';
      }
      if (state.result.loser === me) return 'Ты дурак';
      if (soloBot()) return 'Бот дурак — ты выиграл';
      return nameOf(state.result.loser) + ' — дурак, ты выиграл';
    }
    var actor = D.actorOf(state);
    if (actor !== me) {
      return soloBot() ? 'Ход бота…' : ('Ходит ' + nameOf(actor) + '…');
    }
    if (pending) return 'Ход отправлен…';
    if (transferMode) {
      return state.opts.players === 2 ? 'Выбери карту для перевода'
        : ('Выбери карту для перевода на ' + D.accName(state, L.transferTo));
    }

    if (state.phase === 'defend') {
      return L.play.length ? 'Твой ход — отбивайся или бери' : 'Отбиться нечем — придётся взять';
    }
    if (state.phase === 'attack') {
      if (!state.table.length) return 'Твой ход — заходи любой картой';
      if (!L.play.length) return 'Подкинуть нечего — жми «' + (L.doneLabel || 'Бито') + '»';
      return L.doneLabel === 'Бито' ? 'Можешь подкинуть или сказать «Бито»'
                                    : 'Можешь подкинуть или пасовать';
    }
    if (state.phase === 'take') {
      var who = soloBot() ? 'Бот' : nameOf(state.defender);
      return L.play.length ? (who + ' берёт — можешь ещё подкинуть')
                           : (who + ' берёт — жми «Пас»');
    }
    return '';
  }

  // Красим красные масти в тексте подсказки
  function colorSuits(s) {
    if (!s) return '';
    s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return s.replace(/[♥♦]︎?/g, function (m) { return '<span class="rd">' + m + '</span>'; });
  }

  /* ---------- Кнопки хода ---------- */

  function renderControls(L) {
    controlsEl.innerHTML = '';
    if (!state || state.over || D.actorOf(state) !== me || pending) return;

    if (L.canTake) addBtn('Взять', 'warn', function () { doAction({ type: 'take' }); });

    if (L.transfer.length) {
      var lab = transferMode ? 'Отмена'
        : (state.opts.players === 2 ? 'Перевести' : 'Перевести на ' + D.accName(state, L.transferTo));
      addBtn(lab, 'ghost', function () {
        transferMode = !transferMode;
        render();
      });
    }
    if (L.canDone) {
      addBtn(L.doneLabel, 'primary', function () { doAction({ type: 'done' }); });
    }
  }

  function addBtn(text, cls, fn) {
    var b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.textContent = text;
    b.addEventListener('click', fn);
    controlsEl.appendChild(b);
  }

  /* ---------- Раскладка руки веером ---------- */
  /* Карты сдвигаем друг на друга ровно настолько, чтобы вся рука влезла в экран.
     Если карт очень много — дополнительно уменьшаем их. */

  function layoutHand() {
    var cards = handEl.children, n = cards.length;
    handEl.style.removeProperty('--cw');
    handEl.style.removeProperty('--ch');
    if (!n) return;

    var cw = cards[0].offsetWidth;
    var mid = (n - 1) / 2;
    var spread = Math.min(3.2, 26 / n);                  // угол веера: чем больше карт, тем мельче
    // Крайние карты наклонены и потому вылезают вбок. Точка вращения ниже карты,
    // поэтому сдвиг примерно равен sin(угла) на половину высоты. Закладываем этот запас,
    // иначе на узком экране появляется горизонтальная прокрутка.
    var lean = Math.ceil(Math.sin(mid * spread * Math.PI / 180) * cw * 1.45 * 0.6) + 2;
    var avail = Math.max(140, handEl.clientWidth - 6 - 2 * lean);
    var MAX_OV = 0.62;                                   // сильнее чем на 62% не перекрываем

    var needed = n * cw - (n - 1) * cw * MAX_OV;
    if (needed > avail) {                                // не влезает даже внахлёст — мельчим карты
      cw = Math.max(32, Math.floor(avail / (n - (n - 1) * MAX_OV)));
      handEl.style.setProperty('--cw', cw + 'px');
      handEl.style.setProperty('--ch', Math.round(cw * 1.45) + 'px');
    }

    var ov = (n > 1 && n * cw > avail) ? Math.ceil((n * cw - avail) / (n - 1)) : 0;
    ov = Math.max(0, Math.min(ov, Math.round(cw * MAX_OV)));
    handEl.style.setProperty('--ov', ov + 'px');

    for (var i = 0; i < n; i++) {
      cards[i].style.setProperty('--rot', ((i - mid) * spread).toFixed(2) + 'deg');
    }
  }

  window.addEventListener('resize', function () { if (state) layoutHand(); });

  /* ======================================================================
     ИТОГ ПАРТИИ
     ====================================================================== */

  function finishGame() {
    if (!state || !state.over) return;
    render();
    if (recorded) return;
    recorded = true;

    var outcome = state.result.draw ? 'draw' : (state.result.loser === me ? 'loss' : 'win');
    var mk = D.modeKey(state.opts);
    var np = state.opts.players;
    recordResult(mk, np, outcome);

    var row = store.stats.modes[mk];
    $('ov-emoji').textContent = outcome === 'win' ? '🏆' : (outcome === 'draw' ? '🤝' : '🃏');
    $('ov-title').textContent = outcome === 'win' ? 'Ты выиграл!'
                              : outcome === 'draw' ? 'Ничья'
                              : 'Ты дурак';

    var head = '';
    if (outcome === 'win' && np > 2 && state.result.loser !== null) {
      head = 'Дурак — ' + nameOf(state.result.loser) + '. ';
    } else if (outcome === 'draw' && state.result.stalemate) {
      head = 'Тупик: побить уже нечем. ';
    }
    var tail = outcome === 'win' && row.streak > 1 ? ' Серия побед: ' + row.streak + '.' : '';
    $('ov-text').textContent = head + D.MODE_NAME[mk] + ', ' + np + ' ' +
      D.plural(np, 'игрок', 'игрока', 'игроков') +
      ' · побед ' + row.wins + ' из ' + row.games + '.' + tail;

    // Новую партию за сетевым столом начинает только его создатель
    var guest = !!net && !net.isHost;
    $('ov-again').classList.toggle('hidden', guest);
    $('ov-again').textContent = 'Ещё партия';
    $('ov-menu').textContent = guest ? 'Выйти из стола' : 'В меню';
    $('overlay').classList.remove('hidden');
  }

  /* ======================================================================
     ЭКРАН СТАТИСТИКИ
     ====================================================================== */

  // В таблице названия покороче — иначе не влезает в узкий экран
  var MODE_SHORT = {
    plain: 'Простой', podkidnoy: 'Подкидной',
    perevodnoy: 'Переводной', both: 'Оба режима'
  };

  function renderStats() {
    var h = '', i;
    for (i = 0; i < MODE_KEYS.length; i++) {
      h += statRow(MODE_SHORT[MODE_KEYS[i]], store.stats.modes[MODE_KEYS[i]], '');
    }
    h += statRow('Всего', store.stats.total, 'total');
    $('stats-body').innerHTML = h;

    h = '';
    for (i = 0; i < PLAYER_KEYS.length; i++) {
      var np = +PLAYER_KEYS[i];
      h += statRow(np + ' ' + D.plural(np, 'игрок', 'игрока', 'игроков'),
                   store.stats.players[PLAYER_KEYS[i]], '');
    }
    h += statRow('Всего', store.stats.total, 'total');
    $('stats-players-body').innerHTML = h;

    $('stats-hint').textContent = store.stats.total.games
      ? 'В колонке «Серия» — текущая серия побед и рекорд. Считается только доведённая до конца партия: выход в меню посреди игры не засчитывается. Партии с друзьями считаются наравне с партиями против ботов.'
      : 'Пока пусто — сыграй первую партию.';
    resetArmed = false;
    $('btn-reset').textContent = 'Сбросить статистику';
  }

  // В колонке «Серия» показываем две цифры: текущая серия побед и рекорд
  function statRow(name, r, cls) {
    if (!r) r = emptyRow();
    return '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + name + '</td><td>' + r.games +
           '</td><td>' + r.wins + '</td><td>' + r.losses + '</td><td>' + r.draws +
           '</td><td>' + r.streak + ' <span class="dimmed">/ ' + r.best + '</span></td></tr>';
  }

  /* Сброс в два нажатия — надёжнее системного окна и не блокируется браузером */
  var resetArmed = false, resetTimer = null;

  $('btn-reset').addEventListener('click', function () {
    var b = $('btn-reset');
    if (!resetArmed) {
      resetArmed = true;
      b.textContent = 'Точно сбросить? Нажми ещё раз';
      clearTimeout(resetTimer);
      resetTimer = setTimeout(function () {
        resetArmed = false;
        b.textContent = 'Сбросить статистику';
      }, 4000);
      return;
    }
    clearTimeout(resetTimer);
    var keep = store.settings, id = store.playerId, nk = store.nick;
    store = freshStore();
    store.settings = keep;
    store.playerId = id;
    store.nick = nk;
    saveStore();
    renderStats();
  });

  /* ======================================================================
     МЕНЮ И НАСТРОЙКИ
     ====================================================================== */

  var optPod = $('opt-pod'), optPer = $('opt-per'), segEl = $('seg-players');
  var frPod = $('fr-pod'), frPer = $('fr-per');

  function syncModeName() {
    var mk = D.modeKey(store.settings);
    $('mode-name').textContent = D.MODE_NAME[mk];
    $('fr-mode').textContent = D.MODE_NAME[mk];
  }

  // Число игроков — только для офлайна: в сетевом лобби состав живой
  function syncPlayers() {
    var n = store.settings.players, bots = n - 1, btns = segEl.children, i;
    for (i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', +btns[i].getAttribute('data-n') === n);
    }
    var num = bots === 1 ? 'один' : String(bots);
    $('players-hint').textContent = 'Ты и ' + num + ' ' + D.plural(bots, 'бот', 'бота', 'ботов');
    // «против» требует родительного падежа: против бота / против 5 ботов
    $('sub').textContent = (bots === 1 ? 'Ты против бота.' : 'Ты против ' + bots + ' ботов.') +
      ' Русская колода, 36 карт.';
  }

  function syncOpts() {
    optPod.checked = !!store.settings.podkidnoy;
    optPer.checked = !!store.settings.perevodnoy;
    frPod.checked = !!store.settings.podkidnoy;
    frPer.checked = !!store.settings.perevodnoy;
  }

  function onOptChange(e) {
    var src = e.target;
    if (src === optPod || src === frPod) store.settings.podkidnoy = src.checked;
    if (src === optPer || src === frPer) store.settings.perevodnoy = src.checked;
    saveStore();
    syncOpts();
    syncModeName();
  }

  optPod.addEventListener('change', onOptChange);
  optPer.addEventListener('change', onOptChange);
  frPod.addEventListener('change', onOptChange);
  frPer.addEventListener('change', onOptChange);

  segEl.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.seg-b') : null;
    if (!b) return;
    store.settings.players = +b.getAttribute('data-n');
    saveStore();
    syncPlayers();
  });

  $('btn-play').addEventListener('click', newGame);
  $('btn-stats').addEventListener('click', function () { renderStats(); show('stats'); });
  $('btn-back').addEventListener('click', function () { show('menu'); });
  $('btn-new').addEventListener('click', function () {
    if (net) { if (net.isHost) net.restart(); return; }
    newGame();
  });
  $('btn-menu').addEventListener('click', toMenu);
  $('ov-again').addEventListener('click', function () {
    if (net) { if (net.isHost) { $('overlay').classList.add('hidden'); net.restart(); } return; }
    newGame();
  });
  $('ov-menu').addEventListener('click', toMenu);

  function toMenu() {
    stopBot();
    closeNet();
    state = null;
    netLegal = null;
    $('overlay').classList.add('hidden');
    if (N) N.setHash('');
    show('menu');
    syncWhoami();
  }

  /* ======================================================================
     ИМЯ ИГРОКА
     ====================================================================== */

  var nickNext = null;      // что сделать после сохранения имени
  var nickBack = 'menu';    // куда вернуться по «Отмена»

  function nickIsSet() { return N ? !N.nickError(store.nick) : false; }

  function syncWhoami() {
    var el = $('whoami');
    if (!N || !N.available()) { el.textContent = ''; return; }
    if (nickIsSet()) {
      el.innerHTML = 'За столом ты — <b>' + esc(store.nick) + '</b>' +
        '<button type="button" id="whoami-edit">сменить</button>';
    } else {
      el.innerHTML = 'Имя для игры с друзьями не задано' +
        '<button type="button" id="whoami-edit">задать</button>';
    }
    var b = $('whoami-edit');
    if (b) b.addEventListener('click', function () { askNick(null, 'menu'); });
  }

  function askNick(next, backTo) {
    nickNext = next || null;
    nickBack = backTo || 'menu';
    $('nick-input').value = store.nick || '';
    $('nick-err').textContent = '';
    $('nick-cancel').classList.toggle('hidden', !nickIsSet());
    show('nick');
    setTimeout(function () { try { $('nick-input').focus(); } catch (e) { } }, 30);
  }

  function saveNick() {
    var v = $('nick-input').value;
    var err = N ? N.nickError(v) : '';
    if (err) { $('nick-err').textContent = err; return; }
    store.nick = N.cleanNick(v);
    saveStore();
    syncWhoami();
    if (net) net.setNick(store.nick);
    var next = nickNext; nickNext = null;
    if (next) next(); else show(nickBack);
  }

  $('nick-ok').addEventListener('click', saveNick);
  $('nick-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); saveNick(); }
  });
  $('nick-cancel').addEventListener('click', function () { nickNext = null; show(nickBack); });

  function withNick(fn) {
    if (nickIsSet()) { fn(); return; }
    askNick(fn, 'menu');
  }

  /* ======================================================================
     ИГРА С ДРУЗЬЯМИ: создание стола и вход по коду
     ====================================================================== */

  // Игра, открытая двойным кликом, живёт по адресу file://. Сеть оттуда работает,
  // а вот ссылка-приглашение — нет: у друга такого файла по этому пути не окажется.
  var IS_FILE = location.protocol === 'file:';

  function netReady() {
    if (!N || !N.available()) return 'Сетевая часть не загрузилась. Проверь, что рядом с index.html лежит файл supabase.js.';
    return '';
  }

  function frNote() {
    var bad = netReady();
    var el = $('fr-err');
    if (bad) { el.className = 'err'; el.textContent = bad; return; }
    if (IS_FILE) {
      el.className = 'err note';
      el.textContent = 'Игра открыта файлом с диска: приглашать друзей ссылкой не получится, ' +
        'только кодом стола. Чтобы работала ссылка — выложи игру на GitHub Pages (см. README).';
      return;
    }
    el.className = 'err';
    el.textContent = '';
  }

  $('btn-friends').addEventListener('click', function () {
    frNote();
    withNick(function () { show('friends'); });
  });
  $('fr-back').addEventListener('click', function () { show('menu'); });

  function frFail(text) {
    var el = $('fr-err');
    el.className = 'err';
    el.textContent = text;
  }

  $('fr-create').addEventListener('click', function () {
    var bad = netReady();
    if (bad) { frFail(bad); return; }
    startNet({ host: true, code: N.makeCode() });
  });

  $('fr-join').addEventListener('click', function () {
    var bad = netReady();
    if (bad) { frFail(bad); return; }
    var code = N.normCode($('fr-code').value);
    if (code.length < 4) { frFail('Код стола — 5 знаков, как в ссылке от друга.'); return; }
    startNet({ host: false, code: code });
  });

  $('fr-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('fr-join').click(); }
  });

  /* ---------- Соединение ---------- */

  function startNet(opt) {
    closeNet();
    netLobby = null; netLegal = null; netGen = -1; state = null;
    netStatus = 'connecting'; pending = false;
    $('overlay').classList.add('hidden');

    net = N.create({
      url: SUPABASE_URL,
      key: SUPABASE_PUBLISHABLE_KEY,
      code: opt.code,
      pid: store.playerId,
      nick: store.nick,
      host: !!opt.host,
      rules: { podkidnoy: store.settings.podkidnoy, perevodnoy: store.settings.perevodnoy },
      on: {
        lobby: onNetLobby,
        view: onNetView,
        status: onNetStatus,
        ended: onNetEnded,
        trouble: onNetTrouble
      }
    });

    N.setHash(opt.code);
    showLobbyWaiting(opt.code, !!opt.host);
    net.start();

    // Гость: если создатель стола не отозвался — значит, стола уже нет.
    // Так бывает, когда хост закрыл вкладку или в коде опечатка.
    clearTimeout(findT);
    if (!opt.host) {
      findT = setTimeout(function () {
        if (net && !netLobby) onNetEnded({ reason: 'notfound' });
      }, FIND_MS);
    }
  }

  function closeNet() {
    clearTimeout(findT);
    clearTimeout(pendingT);
    if (!net) return;
    var n = net;
    net = null;
    try { if (n.isHost) n.close('host-left'); else n.leave(); } catch (e) { }
    netLobby = null; netLegal = null; netStatus = 'idle'; netGen = -1;
    pending = false;
  }

  function onNetStatus(s) {
    netStatus = s.status;
    if (screens.lobby && !screens.lobby.classList.contains('hidden')) renderLobbyMsg();
    if (state) renderNetbar();
  }

  function onNetLobby(l) {
    netLobby = l;
    clearTimeout(findT);
    if (!l.started) renderLobby(l);
    else if (state) renderNetbar();
  }

  function onNetView(v) {
    pending = false;
    clearTimeout(pendingT);
    clearTimeout(findT);
    netLegal = v.legal;
    me = v.me;
    if (v.gen !== netGen) {           // за столом началась новая партия
      netGen = v.gen;
      recorded = false;
      seen = {};
      transferMode = false;
      $('overlay').classList.add('hidden');
    }
    state = N.stateFromView(v);
    if (screens.game.classList.contains('hidden')) enterGameScreen();
    render();
    if (state.over) finishGame();
  }

  function onNetTrouble() {
    if (state) renderNetbar();
    else if (netLobby) renderLobby(netLobby);
  }

  var END_TEXT = {
    'host-left': 'Создатель стола вышел — партия окончена.',
    'host-silent': 'Создатель стола перестал отвечать — партия окончена.',
    'closed': 'Создатель закрыл стол.',
    'kicked': 'Создатель стола убрал тебя из партии.',
    'started': 'За этим столом уже играют. Попроси создателя позвать тебя в следующую партию.',
    'full': 'За этим столом нет свободных мест.',
    'denied': 'Стол не пустил.',
    'notfound': 'Стол не найден. Проверь код в ссылке — или создатель уже закрыл вкладку, и стола больше нет.',
    'no-lib': 'Сетевая часть не загрузилась: рядом с index.html должен лежать файл supabase.js.',
    'no-engine': 'Не загрузился движок игры.',
    'no-client': 'Не получилось подключиться к серверу. Проверь интернет и попробуй ещё раз.'
  };

  function onNetEnded(e) {
    var msg = END_TEXT[e && e.reason] || 'Стол закрыт.';
    var n = net;
    net = null;
    clearTimeout(findT);
    try { if (n) n.leave(); } catch (err) { }
    netLegal = null;
    pending = false;
    $('ov-emoji').textContent = '🔌';
    $('ov-title').textContent = 'Стол закрыт';
    $('ov-text').textContent = msg;
    $('ov-again').classList.add('hidden');
    $('ov-menu').textContent = 'В меню';
    $('overlay').classList.remove('hidden');
  }

  /* ---------- Лобби ---------- */

  function showLobbyWaiting(code, isHost) {
    $('lb-code').textContent = code;
    $('lb-mode').textContent = isHost ? 'Создаём стол…' : 'Ищем стол…';
    $('lb-link').value = N.linkFor(code);
    $('lb-linkbox').classList.toggle('hidden', IS_FILE);
    $('lb-filenote').classList.toggle('hidden', !IS_FILE);
    $('lb-seats').innerHTML = '';
    $('lb-botrow').classList.add('hidden');
    $('lb-start').classList.add('hidden');
    $('lb-msg').className = 'netmsg';
    $('lb-msg').textContent = 'Подключаемся…';
    show('lobby');
  }

  var SEAT_TAG = { host: 'создатель', remote: 'игрок', bot: 'бот' };

  function renderLobby(l) {
    if (!l) return;
    var members = l.members || [], n = members.length, max = l.max || 6, i;

    $('lb-code').textContent = l.code;
    $('lb-mode').textContent = D.MODE_NAME[D.modeKey(l.rules)] + ' · ' + n + ' ' +
      D.plural(n, 'участник', 'участника', 'участников') + ' из ' + max;
    $('lb-link').value = N.linkFor(l.code);
    $('lb-linkbox').classList.toggle('hidden', IS_FILE);
    $('lb-filenote').classList.toggle('hidden', !IS_FILE);

    var h = '', m, link, cls, tag, who;
    for (i = 0; i < n; i++) {
      m = members[i];
      link = (l.links && l.links[i]) || '';
      cls = 'seat-row';
      tag = SEAT_TAG[m.kind] || '';
      who = esc(m.nick || 'Игрок');
      if (m.pid && m.pid === l.mePid) { cls += ' me'; who = '<b>' + who + '</b> (ты)'; }
      if (link === 'weak') { cls += ' weak'; tag = 'теряет связь'; }
      if (link === 'lost') { cls += ' lost'; tag = 'не отвечает'; }
      h += '<div class="' + cls + '"><span class="num">' + (i + 1) + '</span>' +
           '<span class="who">' + who + '</span><span class="tag">' + tag + '</span></div>';
    }
    for (i = n; i < max; i++) {
      h += '<div class="seat-row free"><span class="num">' + (i + 1) + '</span>' +
           '<span class="who">свободно</span><span class="tag">ждём</span></div>';
    }
    $('lb-seats').innerHTML = h;

    var bots = 0;
    for (i = 0; i < n; i++) if (members[i].kind === 'bot') bots++;

    $('lb-botrow').classList.toggle('hidden', !l.isHost);
    $('lb-bot-add').disabled = n >= max;
    $('lb-bot-del').disabled = bots === 0;
    $('lb-start').classList.toggle('hidden', !l.isHost);
    $('lb-start').disabled = !(l.isHost && n >= (l.minStart || 2));
    $('lb-leave').textContent = l.isHost ? 'Закрыть стол' : 'Выйти из стола';

    renderLobbyMsg(l);
  }

  function renderLobbyMsg(l) {
    l = l || netLobby;
    var el = $('lb-msg');
    el.className = 'netmsg';
    if (netStatus === 'connecting') { el.textContent = 'Подключаемся…'; return; }
    if (netStatus === 'reconnecting') {
      el.className = 'netmsg warn';
      el.textContent = 'Связь потеряна, пробуем восстановить…';
      return;
    }
    if (!l || !l.members) { el.textContent = 'Ищем стол…'; return; }

    var n = l.members.length, max = l.max || 6, min = l.minStart || 2;
    if (!l.isHost) { el.textContent = 'Ты за столом. Ждём, когда создатель начнёт партию.'; return; }
    if (n < min) {
      el.className = 'netmsg warn';
      el.textContent = 'Отправь другу ссылку или добавь бота — вдвоём уже можно играть.';
      return;
    }
    el.textContent = n >= max
      ? 'Стол полон. Жми «Начать партию».'
      : 'Можно начинать: сыграют все, кто сейчас в списке.';
  }

  $('lb-bot-add').addEventListener('click', function () { if (net) net.addBot(); });
  $('lb-bot-del').addEventListener('click', function () { if (net) net.removeBot(); });

  $('lb-start').addEventListener('click', function () {
    if (net && net.isHost) net.startGame();
  });

  $('lb-leave').addEventListener('click', toMenu);

  $('lb-copy').addEventListener('click', function () {
    var b = $('lb-copy'), link = $('lb-link').value;
    function done(ok) {
      b.textContent = ok ? 'Ссылка скопирована ✓' : 'Скопируй ссылку вручную';
      setTimeout(function () { b.textContent = 'Скопировать ссылку'; }, 2200);
    }
    var input = $('lb-link');
    try { input.focus(); input.setSelectionRange(0, link.length); } catch (e) { }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(function () { done(true); }, function () { done(legacyCopy()); });
      return;
    }
    done(legacyCopy());
  });

  function legacyCopy() {
    try { return document.execCommand('copy'); } catch (e) { return false; }
  }

  /* ---------- Полоска связи на игровом экране ---------- */

  function renderNetbar() {
    var bar = $('netbar'), txt = $('netbar-txt'), btns = $('netbar-btns');
    btns.innerHTML = '';
    if (!net) { bar.classList.add('hidden'); return; }

    var msg = '', bad = false, i, s, l, weak = [], lost = [];

    if (netLobby && netLobby.members) {
      for (i = 0; i < netLobby.members.length; i++) {
        s = netLobby.members[i];
        l = netLobby.links ? netLobby.links[i] : '';
        if (!s || s.kind !== 'remote') continue;
        if (s.pid === netLobby.mePid) continue;
        if (l === 'lost') lost.push(s); else if (l === 'weak') weak.push(s);
      }
    }

    // Со стороны гостя не различить, кто именно замолчал — он сам или создатель стола.
    // Поэтому пишем нейтрально, без обвинений.
    if (netStatus === 'reconnecting') { msg = 'Связь потеряна, восстанавливаем…'; bad = true; }
    else if (netStatus === 'weak' && !net.isHost) { msg = 'Связь со столом пропадает…'; bad = true; }

    if (lost.length) {
      bad = true;
      msg = names(lost) + (lost.length > 1 ? ' не отвечают' : ' не отвечает');
      if (net.isHost) {
        msg += '. Заменить ботом или закрыть стол?';
        for (i = 0; i < lost.length; i++) addNetBtn(btns, 'Заменить: ' + lost[i].nick, lost[i].pid);
        var close = document.createElement('button');
        close.className = 'btn ghost';
        close.textContent = 'Закрыть стол';
        close.addEventListener('click', toMenu);
        btns.appendChild(close);
      } else {
        msg += '. Ждём решения создателя стола.';
      }
    } else if (weak.length && !msg) {
      msg = names(weak) + (weak.length > 1 ? ' теряют связь…' : ' теряет связь…');
    }

    if (!msg) { bar.classList.add('hidden'); return; }
    txt.textContent = msg;
    bar.classList.toggle('bad', bad);
    bar.classList.remove('hidden');
  }

  function addNetBtn(box, label, pid) {
    var b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = label;
    b.addEventListener('click', function () { if (net) net.kick(pid); });
    box.appendChild(b);
  }

  function names(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(arr[i].nick || 'Игрок');
    return out.join(', ');
  }

  /* ======================================================================
     ЖИЗНЬ ВКЛАДКИ
     ====================================================================== */

  document.addEventListener('visibilitychange', function () {
    // На телефонах сокет часто умирает молча, пока вкладка свёрнута
    if (!document.hidden && net) net.wake();
  });

  window.addEventListener('beforeunload', function () {
    if (!net) return;
    try { if (net.isHost) net.close('host-left'); else net.leave(); } catch (e) { }
  });

  /* ======================================================================
     ЗАПУСК
     ====================================================================== */

  syncOpts();
  syncModeName();
  syncPlayers();
  syncWhoami();
  show('menu');

  // Пришли по ссылке-приглашению — сразу за нужный стол
  (function () {
    if (!N) return;
    var code = N.roomFromHash();
    if (!code) return;
    var bad = netReady();
    if (bad) { frFail(bad); show('friends'); return; }
    withNick(function () { startNet({ host: false, code: code }); });
  })();

  // Наружу — только для автотестов интерфейса; на игру не влияет.
  window.DurakUI = {
    get state() { return state; },
    get me() { return me; },
    get net() { return net; },
    get lobby() { return netLobby; },
    newGame: newGame,
    store: function () { return store; },
    setNick: function (v) { store.nick = N.cleanNick(v); saveStore(); syncWhoami(); },
    startNet: startNet
  };

})();

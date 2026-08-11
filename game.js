'use strict';
/*
 * game.js — движок игры «Дурак» (36 карт, от 2 до 6 игроков).
 *
 * Здесь только правила и бот. Никакого DOM: движок ничего не знает про экран.
 * Так к нему можно прикрутить сетевой режим, не трогая логику.
 *
 * Игроки — это места за столом (seats), пронумерованные 0..N-1 по кругу.
 * Кто управляет местом, движку безразлично: у места есть поле kind
 * ('human' | 'bot' | 'remote'), и оно задаётся при создании партии.
 * Место 0 — по умолчанию локальный человек, но это лишь настройка по умолчанию.
 *
 * Всё состояние партии лежит в одном простом объекте state (см. create()):
 * ни функций, ни дат, ни ссылок наружу — значит, оно целиком переживает
 * JSON.stringify / JSON.parse (см. serialize/deserialize).
 *
 * Любой ход — это одно сериализуемое действие вида
 *   { type:'attack'|'defend'|'transfer'|'take'|'done', p: индекс игрока, cardId: '9S' }
 * которое применяется функцией apply(state, action).
 */

var Durak = (function () {

  /* ---------- Карты и константы ---------- */

  var RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14];   // 11=валет, 12=дама, 13=король, 14=туз
  var SUITS = ['S', 'H', 'D', 'C'];               // пики, черви, бубны, трефы

  // ︎ — «текстовый» вариант символа: без него телефоны рисуют ♥ как цветное эмодзи
  var SUIT_SYM = { S: '♠︎', H: '♥︎', D: '♦︎', C: '♣︎' };
  var RANK_LABEL = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };

  // Названия достоинств для сообщений: винительный («подкинул семёрку») и творительный («отбился королём»)
  var RANK_ACC = { 6: 'шестёрку', 7: 'семёрку', 8: 'восьмёрку', 9: 'девятку', 10: 'десятку', 11: 'валета', 12: 'даму', 13: 'короля', 14: 'туза' };
  var RANK_INS = { 6: 'шестёркой', 7: 'семёркой', 8: 'восьмёркой', 9: 'девяткой', 10: 'десяткой', 11: 'валетом', 12: 'дамой', 13: 'королём', 14: 'тузом' };

  var HAND_SIZE = 6;      // до скольки карт добираем
  var MAX_PAIRS = 6;      // больше шести пар на столе не бывает никогда
  var MIN_PLAYERS = 2;
  var MAX_PLAYERS = 6;    // 6 × 6 карт = вся колода, больше физически некуда

  // Имена ботов для стола на 3+ игроков. Для стола на двоих соперник зовётся «Бот» —
  // так же, как в первой версии игры.
  var BOT_NAMES = ['Пётр', 'Анна', 'Игорь', 'Лиза', 'Марк'];
  var BOT_GENDER = ['m', 'f', 'm', 'f', 'm'];
  var BOT_ACC = ['Петра', 'Анну', 'Игоря', 'Лизу', 'Марка'];   // «перевёл на Петра»

  // Глаголы в двух родах: «Анна взяла», «Пётр взял»
  var VERBS = {
    enter: ['зашёл', 'зашла'],
    add: ['подкинул', 'подкинула'],
    beat: ['отбился', 'отбилась'],
    trans: ['перевёл', 'перевела'],
    took: ['забрал', 'забрала'],
    gone: ['вышел', 'вышла'],
    stay: ['остался', 'осталась']
  };

  /* ---------- Случайность с зерном ---------- */
  /* mulberry32: короткий и стабильный генератор. Одно и то же зерно даёт
     одну и ту же раздачу — партию можно воспроизвести и проверить. */

  function rndFrom(box) {
    box.rng = (box.rng + 0x6D2B79F5) >>> 0;
    var t = box.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Псевдослучайность для бота — чистая функция от (зерно, номер хода, игрок).
  // Не меняет состояние: сколько раз ни спроси, ответ один и тот же.
  function botRnd(st, me, salt) {
    var box = { rng: (st.seed + Math.imul(st.seq + 1, 2654435761) + Math.imul(me + 1, 40503) + (salt || 0) * 97) >>> 0 };
    rndFrom(box);
    return rndFrom(box);
  }

  /* ---------- Мелкие помощники ---------- */

  function buildDeck() {
    var d = [], i, j;
    for (i = 0; i < SUITS.length; i++) {
      for (j = 0; j < RANKS.length; j++) {
        d.push({ r: RANKS[j], s: SUITS[i], id: RANKS[j] + SUITS[i] });
      }
    }
    return d;
  }

  function shuffle(a, box) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rndFrom(box) * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // Бьёт ли карта def карту atk
  function beats(def, atk, trump) {
    if (def.s === atk.s) return def.r > atk.r;      // та же масть — только старше
    return def.s === trump;                          // козырь бьёт любую некозырную
  }

  // «Цена» карты для сортировки бота: козырь всегда дороже любой некозырной
  function power(c, trump) { return c.r + (c.s === trump ? 100 : 0); }

  function short(c) { return RANK_LABEL[c.r] + SUIT_SYM[c.s]; }
  function acc(c) { return RANK_ACC[c.r] + ' ' + SUIT_SYM[c.s]; }
  function ins(c) { return RANK_INS[c.r] + ' ' + SUIT_SYM[c.s]; }

  function nm(st, p) { return st.seats[p].name; }
  function vb(st, p, key) { return VERBS[key][st.seats[p].g === 'f' ? 1 : 0]; }

  function plural(n, one, few, many) {
    var n10 = n % 10, n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    return many;
  }

  // Рука человека всегда отсортирована: по мастям, козыри в конце — так удобнее играть
  function sortHand(h, trump) {
    h.sort(function (a, b) {
      var at = a.s === trump ? 1 : 0, bt = b.s === trump ? 1 : 0;
      if (at !== bt) return at - bt;
      if (a.s !== b.s) return SUITS.indexOf(a.s) - SUITS.indexOf(b.s);
      return a.r - b.r;
    });
  }

  function say(st, msg) { st.log.push(msg); if (st.log.length > 40) st.log.shift(); }

  // Общий хвост любого действия: прибрать руки людей — и местных, и сетевых.
  // Ботам сортировка не нужна, они смотрят не глазами.
  function after(st) {
    for (var i = 0; i < st.opts.players; i++) {
      var k = st.seats[i].kind;
      if (k === 'human' || k === 'remote') sortHand(st.hands[i], st.trump);
    }
  }

  function indexOfCard(hand, id) {
    for (var i = 0; i < hand.length; i++) if (hand[i].id === id) return i;
    return -1;
  }

  /* ---------- Круг игроков ---------- */

  // Следующий живой по кругу после p (сам p не считается)
  function nextAlive(st, p) {
    var n = st.opts.players, i, q;
    for (i = 1; i <= n; i++) { q = (p + i) % n; if (!st.out[q]) return q; }
    return p;
  }

  // Первый живой начиная с p (сам p считается)
  function aliveFrom(st, p) {
    var n = st.opts.players, i, q;
    for (i = 0; i < n; i++) { q = (p + i) % n; if (!st.out[q]) return q; }
    return p;
  }

  function aliveCount(st) {
    var n = 0;
    for (var i = 0; i < st.opts.players; i++) if (!st.out[i]) n++;
    return n;
  }

  /* ---------- Разбор стола ---------- */

  function tableRanks(st) {
    var set = {}, i;
    for (i = 0; i < st.table.length; i++) {
      set[st.table[i].a.r] = true;
      if (st.table[i].d) set[st.table[i].d.r] = true;
    }
    return set;
  }

  function undefendedIndex(st) {
    for (var i = 0; i < st.table.length; i++) if (!st.table[i].d) return i;
    return -1;
  }

  function tableCardCount(st) {
    var n = 0;
    for (var i = 0; i < st.table.length; i++) { n++; if (st.table[i].d) n++; }
    return n;
  }

  // Сколько всего карт в партии — для самопроверки (должно быть ровно 36)
  function totalCards(st) {
    var n = st.deck.length + st.discard + tableCardCount(st), i;
    for (i = 0; i < st.opts.players; i++) n += st.hands[i].length;
    return n;
  }

  /* ---------- Лимит карт в раунде ---------- */

  // Сколько пар максимум может оказаться на столе.
  // Подкидной: не больше, чем карт в руке защищающегося на момент начала раунда, и не больше 6.
  // Без подкидного: сколько уже лежит (то есть добавлять нельзя), минимум 1.
  function roundLimit(st) {
    if (!st.opts.podkidnoy) return Math.max(1, st.table.length);
    return Math.min(MAX_PAIRS, Math.max(1, st.hands[st.defender].length));
  }

  /* ---------- Места за столом ---------- */

  function defaultSeats(n) {
    var seats = [{ name: 'Ты', acc: 'тебя', kind: 'human', g: 'm' }], i;
    if (n === 2) { seats.push({ name: 'Бот', acc: 'бота', kind: 'bot', g: 'm' }); return seats; }
    for (i = 0; i < n - 1; i++) {
      seats.push({ name: BOT_NAMES[i], acc: BOT_ACC[i], kind: 'bot', g: BOT_GENDER[i] });
    }
    return seats;
  }

  function normSeats(n, given) {
    var base = defaultSeats(n), i, s;
    if (!given) return base;
    for (i = 0; i < n; i++) {
      s = given[i];
      if (!s) continue;
      if (s.name) { base[i].name = String(s.name); base[i].acc = String(s.name); }
      if (s.acc) base[i].acc = String(s.acc);
      if (s.kind) base[i].kind = String(s.kind);
      if (s.g) base[i].g = (s.g === 'f' ? 'f' : 'm');
      if (s.id !== undefined && s.id !== null) base[i].id = String(s.id);  // для сети: кто это на сервере
    }
    return base;
  }

  /* ---------- Создание партии ---------- */

  function create(opts) {
    opts = opts || {};
    var n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, opts.players || 2));
    var o = { podkidnoy: !!opts.podkidnoy, perevodnoy: !!opts.perevodnoy, players: n };
    var seed = (typeof opts.seed === 'number' && isFinite(opts.seed))
      ? (opts.seed >>> 0)
      : ((Math.random() * 4294967296) >>> 0);

    var box = { rng: seed };
    var deck = shuffle(buildDeck(), box);
    var bottom = deck[deck.length - 1];             // козырь определяет нижняя карта колоды
    var trumpCard = { r: bottom.r, s: bottom.s, id: bottom.id };

    var hands = [], out = [], passed = [], i;
    for (i = 0; i < n; i++) { hands.push(deck.splice(0, HAND_SIZE)); out.push(false); passed.push(false); }

    var st = {
      v: 2,
      opts: o,
      seats: normSeats(n, opts.seats),
      seed: seed,
      rng: box.rng,                                 // состояние генератора (пригодится дальше)
      seq: 0,                                       // номер применённого действия — для сети и бота
      trump: trumpCard.s,
      trumpCard: trumpCard,
      deck: deck,                                   // берём с начала: deck.shift()
      hands: hands,
      table: [],                                    // [{a: карта атаки, d: карта защиты или null}]
      discard: 0,                                   // сколько карт ушло в бито
      attacker: 0,
      defender: 1,
      thrower: 0,                                   // кто сейчас подкидывает (или основной атакующий)
      passed: passed,                               // кто уже сказал «пас» в текущем окне подкидывания
      out: out,                                     // кто вышел из игры
      finished: [],                                 // порядок выхода — кто раньше избавился от карт
      phase: 'attack',                              // attack | defend | take | over
      limit: 1,
      idle: 0,                                      // раундов подряд без единой карты в бито
      beaten: false,                                // отбита ли хоть одна карта в этом раунде (важно для перевода)
      over: false,
      result: null,                                 // {draw: bool, loser: индекс или null}
      reason: '',                                   // почему первым ходит именно этот игрок
      log: []
    };

    var first = firstAttacker(st);
    st.attacker = first;
    st.defender = nextAlive(st, first);
    st.limit = roundLimit(st);
    openWindow(st);

    after(st);
    say(st, 'Козырь: ' + short(st.trumpCard) + '. ' + st.reason);
    return st;
  }

  // Первым ходит тот, у кого младший козырь; если козырей нет ни у кого — у кого младшая карта.
  function firstAttacker(st) {
    var n = st.opts.players, best = -1, bestCard = null, i, c;
    for (i = 0; i < n; i++) {
      c = lowestOf(st.hands[i], st.trump);
      if (c && (!bestCard || c.r < bestCard.r)) { bestCard = c; best = i; }
    }
    if (best >= 0) {
      st.reason = (best === 0 ? 'Ты ходишь первым' : ('Первым ходит ' + nm(st, best))) +
        ' — младший козырь ' + short(bestCard) + '.';
      return best;
    }
    for (i = 0; i < n; i++) {
      c = lowestOf(st.hands[i], null);
      if (c && (!bestCard || c.r < bestCard.r)) { bestCard = c; best = i; }
    }
    if (best < 0) { st.reason = 'Ходит первый игрок.'; return 0; }
    st.reason = 'Козырей нет ни у кого — ' +
      (best === 0 ? 'ты ходишь первым' : (nm(st, best) + ' ходит первым')) +
      ' с младшей картой ' + short(bestCard) + '.';
    return best;
  }

  // Младшая карта в руке; если указана масть — только этой масти (иначе null)
  function lowestOf(hand, suit) {
    var best = null;
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      if (suit && c.s !== suit) continue;
      if (!best || c.r < best.r) best = c;
    }
    return best;
  }

  /* ---------- Кто сейчас ходит ---------- */

  function actorOf(st) {
    if (st.over) return null;
    if (st.phase === 'defend') return st.defender;
    return st.thrower;                               // attack и take — действует подкидывающий
  }

  /* ---------- Подкидывание: кто может и в каком порядке ---------- */

  // Защищающийся не подкидывает, выбывшие тоже
  function canThrow(st, p) {
    return !st.out[p] && p !== st.defender;
  }

  // Можно ли игроку p положить эту карту в атаку (первый заход или подкидывание)
  function canAddFor(st, p, card, phase) {
    phase = phase || st.phase;
    if (!canThrow(st, p)) return false;

    if (phase === 'attack') {
      if (st.table.length === 0) return p === st.attacker;           // первый заход — только основной атакующий
      if (!st.opts.podkidnoy) return false;                          // без подкидного добавлять нечего
      if (st.table.length >= st.limit) return false;
      if (st.hands[st.defender].length === 0) return false;          // отбиваться уже нечем — раунд закрывается
      return !!tableRanks(st)[card.r];
    }
    if (phase === 'take') {                                          // защищающийся берёт — можно догрузить
      if (!st.opts.podkidnoy) return false;
      if (st.table.length >= st.limit) return false;
      return !!tableRanks(st)[card.r];
    }
    return false;
  }

  function hasAnyAddFor(st, p, phase) {
    if (!canThrow(st, p)) return false;
    var h = st.hands[p];
    for (var i = 0; i < h.length; i++) if (canAddFor(st, p, h[i], phase)) return true;
    return false;
  }

  // Может ли хоть кто-нибудь подкинуть (в указанной фазе)
  function anyCanAdd(st, phase) {
    for (var p = 0; p < st.opts.players; p++) if (hasAnyAddFor(st, p, phase)) return true;
    return false;
  }

  // Следующий подкидывающий, начиная с места from и дальше по кругу.
  // Тех, кому подкидывать нечем, помечаем «пас» на месте — чтобы интерфейс
  // не заставлял их жать кнопку впустую. Вернёт -1, если подкинуть некому.
  function nextThrower(st, from) {
    var n = st.opts.players, i, p;
    for (i = 0; i < n; i++) {
      p = (from + i) % n;
      if (!canThrow(st, p)) continue;
      if (st.passed[p]) continue;
      if (!hasAnyAddFor(st, p)) { st.passed[p] = true; continue; }
      return p;
    }
    return -1;
  }

  // Открыть новое окно подкидывания: все «пасы» сбрасываются, очередь начинается
  // с основного атакующего. Возвращает false, если подкинуть некому.
  function openWindow(st) {
    var n = st.opts.players, i;
    st.passed = [];
    for (i = 0; i < n; i++) st.passed.push(false);
    var t = nextThrower(st, st.attacker);
    if (t < 0) { st.thrower = st.attacker; return false; }  // слово за атакующим — ему говорить «Бито»
    st.thrower = t;
    return true;
  }

  // Закроет ли раунд «пас» этого игрока (тогда кнопка называется «Бито», а не «Пас»)
  function lastThrower(st, p) {
    for (var q = 0; q < st.opts.players; q++) {
      if (q === p) continue;
      if (st.passed[q]) continue;
      if (hasAnyAddFor(st, q)) return false;
    }
    return true;
  }

  /* ---------- Перевод ---------- */

  // На кого переводится ход — на следующего по кругу за защищающимся
  function transferTarget(st) { return nextAlive(st, st.defender); }

  function canTransferNow(st) {
    if (!st.opts.perevodnoy) return false;
    if (st.phase !== 'defend') return false;
    if (st.beaten) return false;                        // уже отбил карту — переводить поздно
    if (!st.table.length) return false;
    var need = st.table.length + 1;                     // столько карт станет на столе
    if (need > MAX_PAIRS) return false;
    var t = transferTarget(st);
    if (t === st.defender) return false;
    return st.hands[t].length >= need;                  // у нового защищающегося карт не меньше
  }

  /* ---------- Действия ---------- */

  function doAttack(st, p, cardId) {
    if (st.phase !== 'attack' && st.phase !== 'take') return false;
    if (p !== st.thrower) return false;
    var hand = st.hands[p];
    var i = indexOfCard(hand, cardId);
    if (i < 0) return false;
    if (!canAddFor(st, p, hand[i])) return false;

    var first = st.table.length === 0;
    var card = hand.splice(i, 1)[0];
    st.table.push({ a: card, d: null });
    say(st, nm(st, p) + ' ' + (first ? vb(st, p, 'enter') + ' ' + ins(card)
                                     : vb(st, p, 'add') + ' ' + acc(card)));

    if (st.phase === 'attack') {
      st.phase = 'defend';
    } else {
      var t = nextThrower(st, p);                       // этот же игрок может подкинуть ещё
      if (t < 0) finishRound(st, true);                 // подкидывать больше нечего — забирает
      else st.thrower = t;
    }
    after(st);
    return true;
  }

  function doDefend(st, p, cardId) {
    if (st.phase !== 'defend') return false;
    if (p !== st.defender) return false;
    var idx = undefendedIndex(st);
    if (idx < 0) return false;
    var hand = st.hands[p];
    var i = indexOfCard(hand, cardId);
    if (i < 0) return false;
    if (!beats(hand[i], st.table[idx].a, st.trump)) return false;

    var card = hand.splice(i, 1)[0];
    st.table[idx].d = card;
    st.beaten = true;
    say(st, nm(st, p) + ' ' + vb(st, p, 'beat') + ' ' + ins(card));
    if (undefendedIndex(st) < 0) {                      // всё отбито — снова можно подкидывать
      st.phase = 'attack';
      openWindow(st);
    }
    after(st);
    return true;
  }

  function doTransfer(st, p, cardId) {
    if (p !== st.defender) return false;
    if (!canTransferNow(st)) return false;
    var hand = st.hands[p];
    var i = indexOfCard(hand, cardId);
    if (i < 0) return false;
    if (hand[i].r !== st.table[0].a.r) return false;    // переводить можно только тем же достоинством

    var target = transferTarget(st);
    var card = hand.splice(i, 1)[0];
    st.table.push({ a: card, d: null });
    st.attacker = p;                                    // переведший становится атакующим
    st.defender = target;                               // отбивается следующий по кругу
    st.limit = roundLimit(st);
    // За столом на двоих переводить некому, кроме соперника, — лишнего не пишем
    say(st, nm(st, p) + ' ' + vb(st, p, 'trans') + ' ' + ins(card) +
      (st.opts.players > 2 ? ' на ' + accName(st, target) : ''));
    after(st);
    return true;
  }

  // «перевёл на Анну» / «перевёл на тебя»
  function accName(st, p) { return st.seats[p].acc || st.seats[p].name; }

  function doTake(st, p) {
    if (st.phase !== 'defend') return false;
    if (p !== st.defender) return false;
    if (st.opts.podkidnoy && anyCanAdd(st, 'take')) {
      st.phase = 'take';
      say(st, nm(st, p) + ' берёт карты');
      if (!openWindow(st)) finishRound(st, true);
    } else {
      finishRound(st, true);
    }
    after(st);
    return true;
  }

  // «Бито» (всё отбито) или «Пас» (закончил подкидывать тому, кто берёт)
  function doDone(st, p) {
    if (p !== st.thrower) return false;
    var n = st.opts.players, t;

    if (st.phase === 'attack') {
      if (!st.table.length || undefendedIndex(st) >= 0) return false;
      st.passed[p] = true;
      t = nextThrower(st, (p + 1) % n);
      if (t < 0) finishRound(st, false);
      else { st.thrower = t; say(st, nm(st, p) + ' пас'); }
      after(st);
      return true;
    }
    if (st.phase === 'take') {
      st.passed[p] = true;
      t = nextThrower(st, (p + 1) % n);
      if (t < 0) finishRound(st, true);
      else { st.thrower = t; say(st, nm(st, p) + ' пас'); }
      after(st);
      return true;
    }
    return false;
  }

  /* ---------- Конец раунда ---------- */

  function finishRound(st, taken) {
    var att = st.attacker, def = st.defender, n = st.opts.players, i, got;

    if (taken) {
      got = [];
      for (i = 0; i < st.table.length; i++) {
        got.push(st.table[i].a);
        if (st.table[i].d) got.push(st.table[i].d);
      }
      for (i = 0; i < got.length; i++) st.hands[def].push(got[i]);
      say(st, nm(st, def) + ' ' + vb(st, def, 'took') + ' ' + got.length + ' ' +
        plural(got.length, 'карту', 'карты', 'карт'));
    } else {
      st.discard += tableCardCount(st);
      say(st, 'Бито');
    }

    st.table = [];
    st.beaten = false;

    // Добор: сначала основной атакующий, дальше по кругу, защищающийся — последним
    var order = drawOrder(st, att, def);
    for (i = 0; i < order.length; i++) draw(st, order[i]);

    var gone = markOut(st);

    // Раунд «вхолостую»: колода пуста, в бито ничего не ушло — карты просто
    // перекладываются из рук в руки. Считаем такие раунды подряд.
    if (st.deck.length === 0 && taken) st.idle++; else st.idle = 0;

    // Отбился — атакует он же. Взял — атака переходит к следующему за взявшим.
    st.attacker = taken ? aliveFrom(st, (def + 1) % n) : aliveFrom(st, def);
    st.defender = nextAlive(st, st.attacker);

    if (checkOver(st)) { after(st); return; }

    for (i = 0; i < gone.length; i++) {
      say(st, nm(st, gone[i]) + ' ' + vb(st, gone[i], 'gone') + ' из игры');
    }

    if (stalemate(st)) { after(st); return; }

    st.phase = 'attack';
    st.limit = roundLimit(st);
    openWindow(st);
    after(st);
  }

  /* ---------- Тупик ---------- */
  /*
   * За столом от трёх игроков возможна вечная партия: колода пуста, и ни одна
   * оставшаяся карта не бьёт ни одну другую. Тогда каждый раунд защищающийся
   * забирает карту, круг замыкается, и так до бесконечности. Такую партию
   * закрываем ничьей.
   *
   * За столом на двоих этого не бывает: после «взял» атакует тот же игрок и
   * теряет по карте за раунд, так что партия всегда доигрывается. Поэтому на
   * двоих правило не включается вовсе — игра на двоих идёт ровно как раньше.
   */

  var IDLE_LIMIT = 40;   // страховка: столько холостых раундов подряд — тоже ничья

  function noBeatsPossible(st) {
    var cards = [], p, i, j;
    for (p = 0; p < st.opts.players; p++) {
      if (st.out[p]) continue;
      for (i = 0; i < st.hands[p].length; i++) cards.push(st.hands[p][i]);
    }
    for (i = 0; i < cards.length; i++) {
      for (j = 0; j < cards.length; j++) {
        if (i !== j && beats(cards[i], cards[j], st.trump)) return false;
      }
    }
    return true;
  }

  function stalemate(st) {
    if (st.opts.players <= 2) return false;
    if (st.deck.length > 0) return false;
    var dead = noBeatsPossible(st);
    if (!dead && st.idle < IDLE_LIMIT) return false;

    st.over = true;
    st.phase = 'over';
    st.result = { draw: true, loser: null, stalemate: true };
    say(st, dead ? 'Ничья — тупик: побить уже нечем' : 'Ничья — карты пошли по кругу');
    return true;
  }

  // Порядок добора: атакующий, дальше по кругу, защищающийся в самом конце
  function drawOrder(st, att, def) {
    var n = st.opts.players, order = [], i, p;
    for (i = 0; i < n; i++) {
      p = (att + i) % n;
      if (st.out[p] || p === def) continue;
      order.push(p);
    }
    if (!st.out[def]) order.push(def);
    return order;
  }

  function draw(st, p) {
    while (st.hands[p].length < HAND_SIZE && st.deck.length > 0) {
      st.hands[p].push(st.deck.shift());
    }
  }

  // Остался без карт при пустой колоде — вышел из игры, круг смыкается
  function markOut(st) {
    var gone = [], p;
    if (st.deck.length > 0) return gone;
    for (p = 0; p < st.opts.players; p++) {
      if (st.out[p]) continue;
      if (st.hands[p].length === 0) {
        st.out[p] = true;
        st.finished.push(p);
        gone.push(p);
      }
    }
    return gone;
  }

  // Партия кончилась, когда с картами остался максимум один игрок
  function checkOver(st) {
    var n = st.opts.players, alive = [], p;
    for (p = 0; p < n; p++) if (!st.out[p]) alive.push(p);
    if (alive.length > 1) return false;

    st.over = true;
    st.phase = 'over';
    if (alive.length === 0) {
      st.result = { draw: true, loser: null };
      say(st, 'Ничья — ' + (n === 2 ? 'оба' : 'все') + ' вышли в ноль');
    } else {
      p = alive[0];
      st.result = { draw: false, loser: p };
      say(st, nm(st, p) + ' ' + vb(st, p, 'stay') + ' с картами — дурак');
    }
    return true;
  }

  /* ---------- Единая точка входа для хода ---------- */
  /*
   * apply(state, action) — единственный способ изменить партию.
   * action.p — индекс автора хода; если он указан и не совпадает с тем, чей сейчас
   * ход, действие отклоняется. Это же правило защитит партию в сетевом режиме.
   */

  function apply(st, action) {
    if (!action || st.over) return false;
    var actor = actorOf(st);
    if (actor === null) return false;
    if (typeof action.p === 'number' && action.p !== actor) return false;

    var p = actor, ok = false;
    switch (action.type) {
      case 'attack': ok = doAttack(st, p, action.cardId); break;
      case 'defend': ok = doDefend(st, p, action.cardId); break;
      case 'transfer': ok = doTransfer(st, p, action.cardId); break;
      case 'take': ok = doTake(st, p); break;
      case 'done': ok = doDone(st, p); break;
      default: ok = false;
    }
    if (ok) st.seq++;
    return ok;
  }

  /* ---------- Сериализация ---------- */
  /*
   * Состояние — обычные числа, строки, массивы и объекты. Поэтому цикл
   * «сериализовал → восстановил» возвращает ровно то же самое, и партию
   * можно передать по сети или восстановить после переподключения.
   */

  function serialize(st) { return JSON.stringify(st); }

  function deserialize(data) {
    return typeof data === 'string' ? JSON.parse(data) : JSON.parse(JSON.stringify(data));
  }

  function clone(st) { return deserialize(serialize(st)); }

  /* ---------- Что игроку можно сделать прямо сейчас (для интерфейса) ---------- */

  function legal(st, p) {
    var res = {
      actor: actorOf(st), play: [], transfer: [],
      canTake: false, canDone: false, doneLabel: '',
      isMainAttacker: p === st.attacker, transferTo: -1
    };
    if (st.over || actorOf(st) !== p) return res;

    var hand = st.hands[p], i;

    if (st.phase === 'defend') {
      var atk = st.table[undefendedIndex(st)].a;
      for (i = 0; i < hand.length; i++) if (beats(hand[i], atk, st.trump)) res.play.push(hand[i].id);
      if (canTransferNow(st)) {
        res.transferTo = transferTarget(st);
        for (i = 0; i < hand.length; i++) if (hand[i].r === st.table[0].a.r) res.transfer.push(hand[i].id);
      }
      res.canTake = true;
    } else if (st.phase === 'attack') {
      for (i = 0; i < hand.length; i++) if (canAddFor(st, p, hand[i])) res.play.push(hand[i].id);
      if (st.table.length && undefendedIndex(st) < 0) {
        res.canDone = true;
        // «Бито» говорит только основной атакующий и только когда раунд на нём и закроется.
        // Все остальные подкидывающие просто пасуют.
        res.doneLabel = (p === st.attacker && lastThrower(st, p)) ? 'Бито' : 'Пас';
      }
    } else if (st.phase === 'take') {
      for (i = 0; i < hand.length; i++) if (canAddFor(st, p, hand[i])) res.play.push(hand[i].id);
      res.canDone = true;
      res.doneLabel = 'Пас';
    }
    return res;
  }

  /* ---------- Бот ---------- */
  /*
   * Эвристика, а не идеальная игра: бот бережёт козыри, сливает мелочь,
   * ближе к концу колоды играет жаднее, иногда ошибается намеренно.
   * Случайность берётся из зерна партии — значит, партия воспроизводима.
   */

  // me — за какое место играем. По умолчанию за то, чей сейчас ход:
  // тем же кодом можно прогонять бота против бота при проверке баланса.
  function botMove(st, me) {
    if (st.over) return null;
    var actor = actorOf(st);
    if (actor === null) return null;
    if (me === undefined) me = actor;
    if (actor !== me) return null;

    var a = (st.phase === 'defend') ? botDefend(st, me) : botAttack(st, me);
    if (a) a.p = me;
    return a;
  }

  function botAttack(st, me) {
    var hand = st.hands[me], tr = st.trump, i, legalCards = [];
    for (i = 0; i < hand.length; i++) if (canAddFor(st, me, hand[i])) legalCards.push(hand[i]);
    if (!legalCards.length) return { type: 'done' };

    var plain = legalCards.filter(function (c) { return c.s !== tr; })
      .sort(function (a, b) { return a.r - b.r; });

    // Первый заход в раунде: младшая некозырная, козырь — только если некозырных нет
    if (st.table.length === 0) {
      if (plain.length) return { type: 'attack', cardId: plain[0].id };
      var trumps = legalCards.slice().sort(function (a, b) { return a.r - b.r; });
      return { type: 'attack', cardId: trumps[0].id };
    }

    // Подкидывание. Козырями не подкидываем никогда — это подарок сопернику.
    if (!plain.length) return { type: 'done' };

    if (st.phase === 'take') return { type: 'attack', cardId: plain[0].id };  // соперник берёт — грузим по полной

    var oppLeft = st.hands[st.defender].length;
    // Колода кончилась, у защищающегося мало карт — лишняя карта поможет ему сбросить остатки
    if (st.deck.length === 0 && oppLeft <= 2) return { type: 'done' };
    // Пока колода жива, дорогие карты не разбрасываем
    if (plain[0].r >= 12 && st.deck.length > 0) return { type: 'done' };
    return { type: 'attack', cardId: plain[0].id };
  }

  function botDefend(st, me) {
    var hand = st.hands[me], tr = st.trump;
    var idx = undefendedIndex(st);
    var atk = st.table[idx].a;

    var opts = hand.filter(function (c) { return beats(c, atk, tr); })
      .sort(function (a, b) { return power(a, tr) - power(b, tr); });

    // Перевод — если есть подходящее достоинство и это не козырь
    if (canTransferNow(st)) {
      var cands = hand.filter(function (c) { return c.r === st.table[0].a.r && c.s !== tr; })
        .sort(function (a, b) { return a.r - b.r; });
      if (cands.length) {
        var mustTrump = !opts.length || opts[0].s === tr;   // иначе пришлось бы брать или тратить козырь
        if (mustTrump || atk.r <= 9 || botRnd(st, me, 1) < 0.45) {
          return { type: 'transfer', cardId: cands[0].id };
        }
      }
    }

    if (!opts.length) return { type: 'take' };

    var best = opts[0];                                     // минимально возможная карта
    if (best.s === tr && atk.s !== tr) {
      // Считаем цену отбоя: стоит ли дорогой козырь того, что придётся забрать
      var takeSize = tableCardCount(st);
      var endgame = st.deck.length <= 4;                    // к концу колоды козыри тратим смелее
      if (!endgame && takeSize <= 2 && best.r >= 12 && atk.r <= 9) return { type: 'take' };
      if (st.deck.length >= 10 && takeSize <= 1 && best.r >= 11 && atk.r <= 8) return { type: 'take' };
    }
    return { type: 'defend', cardId: best.id };
  }

  /* ---------- Названия режимов ---------- */

  function modeKey(o) {
    if (o.podkidnoy) return o.perevodnoy ? 'both' : 'podkidnoy';
    return o.perevodnoy ? 'perevodnoy' : 'plain';
  }

  var MODE_NAME = {
    plain: 'Простой',
    podkidnoy: 'Подкидной',
    perevodnoy: 'Переводной',
    both: 'Подкидной + переводной'
  };

  /* ---------- Что отдаём наружу ---------- */

  return {
    RANKS: RANKS, SUITS: SUITS, SUIT_SYM: SUIT_SYM, RANK_LABEL: RANK_LABEL,
    MODE_NAME: MODE_NAME,
    MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS, HAND_SIZE: HAND_SIZE,
    create: create,
    apply: apply,
    legal: legal,
    botMove: botMove,
    actorOf: actorOf,
    beats: beats,
    modeKey: modeKey,
    short: short,
    plural: plural,
    name: nm,
    accName: accName,
    defaultSeats: defaultSeats,
    serialize: serialize,
    deserialize: deserialize,
    clone: clone,
    undefendedIndex: undefendedIndex,
    tableCardCount: tableCardCount,
    totalCards: totalCards,
    aliveCount: aliveCount,
    canTransferNow: canTransferNow,
    transferTarget: transferTarget,
    canThrow: canThrow,
    canAddFor: canAddFor,
    roundLimit: roundLimit
  };
})();

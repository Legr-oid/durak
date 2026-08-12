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

  // Уровень игры бота. Лежит в состоянии партии (st.opts.diff), поэтому
  // переживает сериализацию и одинаков у хоста и у гостей в сетевой игре.
  // Отдельному месту можно задать свой уровень (seats[i].diff) — так за одним
  // столом собирается смешанный состав.
  var DIFF_EASY = 0, DIFF_MED = 1, DIFF_HARD = 2;
  var DIFF_NAME = { 0: 'Лёгкий', 1: 'Средний', 2: 'Сложный' };
  var DIFF_ALIAS = { easy: 0, med: 1, medium: 1, hard: 2, 'лёгкий': 0, 'средний': 1, 'сложный': 2 };

  function normDiff(v) {
    if (v === 0 || v === 1 || v === 2) return v;
    if (typeof v === 'string' && DIFF_ALIAS[v] !== undefined) return DIFF_ALIAS[v];
    var n = +v;
    if (n === 0 || n === 1 || n === 2) return n;
    return DIFF_MED;                                 // всё непонятное — средний
  }

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

  /* ---------- Что видно всем за столом ---------- */
  /*
   * Две записи, которые ведёт сам движок: какие карты ушли в бито (st.gone)
   * и какие карты игрок на глазах у всех забрал себе со стола (st.held[p]).
   *
   * Это НЕ подглядывание в чужие руки: человек, сидящий за столом, видит ровно
   * то же самое — карту клали на стол в открытую, и было видно, кто её забрал.
   * Пользуется этой памятью только сложный бот; остальные уровни в неё не
   * заглядывают и играют «на глазок».
   */

  function memPlay(st, p, card) {                    // карта ушла из руки на стол
    var a = st.held && st.held[p];
    if (!a) return;
    var i = a.indexOf(card.id);
    if (i >= 0) a.splice(i, 1);
  }

  function memTake(st, p, cards) {                   // игрок забрал стол себе
    var a = st.held && st.held[p], i;
    if (!a) return;
    for (i = 0; i < cards.length; i++) a.push(cards[i].id);
  }

  function memBeaten(st) {                           // стол ушёл в бито
    if (!st.gone) return;
    for (var i = 0; i < st.table.length; i++) {
      st.gone.push(st.table[i].a.id);
      if (st.table[i].d) st.gone.push(st.table[i].d.id);
    }
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
      if (s.diff !== undefined && s.diff !== null) base[i].diff = normDiff(s.diff);  // свой уровень у места
    }
    return base;
  }

  /* ---------- Создание партии ---------- */

  function create(opts) {
    opts = opts || {};
    var n = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, opts.players || 2));
    var o = {
      podkidnoy: !!opts.podkidnoy, perevodnoy: !!opts.perevodnoy, players: n,
      diff: normDiff(opts.diff)                     // уровень ботов за этим столом
    };
    var seed = (typeof opts.seed === 'number' && isFinite(opts.seed))
      ? (opts.seed >>> 0)
      : ((Math.random() * 4294967296) >>> 0);

    var box = { rng: seed };
    var deck = shuffle(buildDeck(), box);
    var bottom = deck[deck.length - 1];             // козырь определяет нижняя карта колоды
    var trumpCard = { r: bottom.r, s: bottom.s, id: bottom.id };

    var hands = [], out = [], passed = [], held = [], i;
    for (i = 0; i < n; i++) {
      hands.push(deck.splice(0, HAND_SIZE)); out.push(false); passed.push(false); held.push([]);
    }

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
      // Открытая память стола — то, что видел каждый сидящий (см. раздел «Что видно всем»)
      gone: [],                                     // id карт, ушедших в бито
      held: held,                                   // id карт, которые игрок на глазах у всех забрал себе
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
    memPlay(st, p, card);
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
    memPlay(st, p, card);
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
    memPlay(st, p, card);
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
      memTake(st, def, got);
      say(st, nm(st, def) + ' ' + vb(st, def, 'took') + ' ' + got.length + ' ' +
        plural(got.length, 'карту', 'карты', 'карт'));
    } else {
      memBeaten(st);
      st.discard += tableCardCount(st);
      say(st, 'Бито');
    }

    st.table = [];
    st.beaten = false;

    // Добор: сначала основной атакующий, дальше по кругу, защищающийся — последним
    var deckBefore = st.deck.length;
    var order = drawOrder(st, att, def);
    for (i = 0; i < order.length; i++) draw(st, order[i]);

    var gone = markOut(st);

    // Раунд «вхолостую»: в бито ничего не ушло и колода не убыла — карты просто
    // переложились из рук в руки, партия не сдвинулась. Считаем такие раунды подряд.
    if (taken && st.deck.length === deckBefore) st.idle++; else st.idle = 0;

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
   * Вечная партия возможна в двух видах.
   *
   * 1. Мёртвый расклад (от трёх игроков): колода пуста, и ни одна оставшаяся
   *    карта не бьёт ни одну другую. Каждый раунд защищающийся забирает карту,
   *    круг замыкается, и так до бесконечности.
   *
   * 2. Карты пошли по кругу: раунд за раундом ничего не уходит в бито и колода
   *    не убывает — соперники просто перекладывают одни и те же карты. Это
   *    возможно и за столом на двоих: в переводном режиме двое могут вечно
   *    перекидывать друг другу одно и то же достоинство (найдено автотестом
   *    12.08.2026 на 12 800 партиях). Раньше страховка на двоих не работала,
   *    потому что считала только раунды при пустой колоде.
   *
   * И то и другое закрываем ничьей.
   */

  var IDLE_LIMIT = 40;   // столько холостых раундов подряд — карты пошли по кругу

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
    var dead = false;
    if (st.idle < IDLE_LIMIT) {
      if (st.opts.players <= 2) return false;
      if (st.deck.length > 0) return false;
      dead = noBeatsPossible(st);
      if (!dead) return false;
    }

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
      var c = st.deck.shift();
      // Последняя карта колоды — открытый козырь: все видят, кому он достался
      if (st.deck.length === 0 && st.held && st.held[p]) st.held[p].push(c.id);
      st.hands[p].push(c);
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

  /* ======================================================================
     БОТ
     ======================================================================

     Три уровня игры. Рамка у всех одна: бот перебирает свои возможные ходы,
     оценивает каждый в условных очках и берёт лучший. Отличаются уровни тем,
     ЧТО бот видит и насколько аккуратно считает:

       0 «Лёгкий»  — короткая эвристика первой версии игры плюс живые ошибки.
                     Играет разумно, но карт не считает, за столом смотрит
                     только на того, кто отбивается, и иногда мажет.
       1 «Средний» — полная оценка с оглядкой на весь стол: кому подкидываем,
                     кто близок к выходу, чем кончится раунд, что довесят
                     после меня. Память короткая: бито и чужие взятки не
                     помнит, вероятности прикидывает «по всему, чего не видел».
       2 «Сложный» — то же самое плюс честный счёт вышедших карт: помнит бито,
                     помнит, кто что забрал со стола, знает, кому достался
                     козырь из-под колоды. Оттого вероятности у него точные.

     Чужие руки и колода боту недоступны НА ЛЮБОМ УРОВНЕ. Из состояния он
     берёт только открытую информацию: свою руку, стол, козырь, ДЛИНЫ чужих
     рук, длину колоды и открытую память стола (st.gone / st.held). Проверено
     тестом: если подменить содержимое чужих рук и колоды, сохранив длины,
     ни одно решение бота не меняется.

     Случайность — только botRnd(state, игрок, соль): чистая функция от зерна,
     номера хода и места, состояние не трогает. Партия с одним зерном всегда
     проигрывается одинаково.
     ====================================================================== */

  var ALL_CARDS = buildDeck();
  var CARD_BY_ID = {};
  (function () { for (var i = 0; i < ALL_CARDS.length; i++) CARD_BY_ID[ALL_CARDS[i].id] = ALL_CARDS[i]; })();

  function botLevel(st, p) {
    var s = st.seats && st.seats[p];
    if (s && (s.diff === 0 || s.diff === 1 || s.diff === 2)) return s.diff;
    return normDiff(st.opts && st.opts.diff);
  }

  /* ---------- Что бот знает о ненайденных картах ---------- */

  // Карты, местоположение которых боту известно честно, «глазами».
  function seenBy(st, me, lvl) {
    var seen = {}, i, p, h = st.hands[me], t = st.table;
    for (i = 0; i < h.length; i++) seen[h[i].id] = 1;                 // своя рука
    for (i = 0; i < t.length; i++) {                                   // стол
      seen[t[i].a.id] = 1;
      if (t[i].d) seen[t[i].d.id] = 1;
    }
    if (st.deck.length > 0) seen[st.trumpCard.id] = 1;                 // козырь лежит открыто под колодой
    if (lvl >= DIFF_HARD) {                                            // счёт карт — только на сложном
      if (st.gone) for (i = 0; i < st.gone.length; i++) seen[st.gone[i]] = 1;
      if (st.held) {
        for (p = 0; p < st.held.length; p++) {
          for (i = 0; i < st.held[p].length; i++) seen[st.held[p][i]] = 1;
        }
      }
    }
    return seen;
  }

  /*
   * info — рабочая картина мира для одного решения.
   *   pool  — карты, о которых бот не знает ничего (у кого-то на руках или в колоде);
   *   unk[q]— сколько карт игрока q боту неизвестны (длина руки минус то, что он видел);
   *   known[q] — id карт, про которые точно известно, что они у q.
   * Средний уровень кладёт в pool и бито тоже — потому и ошибается в оценках.
   */
  function makeInfo(st, me, lvl) {
    var seen = seenBy(st, me, lvl), n = st.opts.players, i, k, c, s;
    var pool = [], rank = {}, suit = {}, above = {};

    for (i = 0; i < RANKS.length; i++) rank[RANKS[i]] = 0;
    for (i = 0; i < SUITS.length; i++) {
      s = SUITS[i]; suit[s] = 0; above[s] = {};
      for (k = 0; k < RANKS.length; k++) above[s][RANKS[k]] = 0;
    }
    for (i = 0; i < ALL_CARDS.length; i++) {
      c = ALL_CARDS[i];
      if (seen[c.id]) continue;
      pool.push(c); rank[c.r]++; suit[c.s]++;
      for (k = 0; k < RANKS.length; k++) if (RANKS[k] < c.r) above[c.s][RANKS[k]]++;
    }

    var unk = [], known = [], a;
    for (i = 0; i < n; i++) {
      a = (lvl >= DIFF_HARD && st.held && st.held[i]) ? st.held[i] : [];
      known.push(a);
      // st.hands[i].length — это открытая величина: сколько карт у соседа, видно всем
      unk.push(i === me ? 0 : Math.max(0, st.hands[i].length - a.length));
    }

    return {
      lvl: lvl, me: me, trump: st.trump, end: st.deck.length === 0,
      pool: pool, M: pool.length, rank: rank, suit: suit, above: above,
      unk: unk, known: known, avg: -1
    };
  }

  // Вероятность вытянуть хотя бы одну «нужную» карту: k карт из мешка на M,
  // нужных в мешке b штук. Обычная гипергеометрия.
  function pAtLeastOne(M, b, k) {
    if (k <= 0 || b <= 0 || M <= 0) return 0;
    if (b >= M || k > M - b) return 1;
    var p = 1, i;
    for (i = 0; i < k; i++) p *= (M - b - i) / (M - i);
    return 1 - p;
  }

  function nBeat(info, atk) {                        // сколько в пуле карт, бьющих atk
    var n = info.above[atk.s][atk.r];
    if (atk.s !== info.trump) n += info.suit[info.trump];
    return n;
  }

  function nRanks(info, rset) {                      // сколько в пуле карт нужных достоинств
    var n = 0, r;
    for (r in rset) if (rset[r]) n += info.rank[r] || 0;
    return n;
  }

  // Вероятность, что у игрока q найдётся чем побить atk
  function pBeat(st, info, q, atk) {
    if (st.out[q] || q === info.me) return 0;
    var a = info.known[q], i, c;
    for (i = 0; i < a.length; i++) {
      c = CARD_BY_ID[a[i]];
      if (c && beats(c, atk, info.trump)) return 1;  // видели своими глазами
    }
    return pAtLeastOne(info.M, nBeat(info, atk), info.unk[q]);
  }

  // Вероятность, что у q есть карта одного из достоинств rset (то есть ему есть чем подкинуть)
  function pRank(st, info, q, rset) {
    if (st.out[q] || q === info.me) return 0;
    var a = info.known[q], i, c;
    for (i = 0; i < a.length; i++) {
      c = CARD_BY_ID[a[i]];
      if (c && rset[c.r]) return 1;
    }
    return pAtLeastOne(info.M, nRanks(info, rset), info.unk[q]);
  }

  // Сколько примерно карт нужных достоинств у q на руках
  function expRank(st, info, q, rset) {
    if (st.out[q] || q === info.me) return 0;
    var a = info.known[q], i, c, n = 0;
    for (i = 0; i < a.length; i++) { c = CARD_BY_ID[a[i]]; if (c && rset[c.r]) n++; }
    if (info.M > 0) n += info.unk[q] * nRanks(info, rset) / info.M;
    return n;
  }

  /* ---------- Цена карт и положение за столом ---------- */

  // Насколько жалко расставаться с картой. Козырь дорог всегда; простая карта
  // дорожает к концу колоды — там её бьёт только козырь.
  function keepVal(st, c) {
    if (c.s === st.trump) {
      return st.deck.length ? (W.trBase + (c.r - 6) * W.trStep) : (W.trBaseE + (c.r - 6) * W.trStepE);
    }
    return (c.r - 6) * (st.deck.length ? W.plStep : W.plStepE);
  }

  // Средняя цена карты из пула — во что примерно обменяется сброс, пока колода жива
  function poolAvg(st, info) {
    if (info.avg >= 0) return info.avg;
    var s = 0, i;
    for (i = 0; i < info.pool.length; i++) s += keepVal(st, info.pool[i]);
    info.avg = info.M ? s / info.M : 0;
    return info.avg;
  }

  // Насколько игрок близок к выходу из игры: 1 — вот-вот выйдет, 0 — завален.
  // Пока колода жива, все всё равно доберут до шести, поэтому вес мал.
  function threat(st, q) {
    if (st.out[q]) return 0;
    var t = 1 - (st.hands[q].length - 1) / 7;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return st.deck.length > 0 ? t * 0.3 : t;
  }

  // Сколько карт ещё довесят на стол, если раунд продолжится.
  // Это и есть многопользовательская специфика: подкидывает не один человек.
  function moreCards(st, info, me, extraRank) {
    if (!st.opts.podkidnoy) return 0;
    if (info.lvl < DIFF_HARD) return 0;              // средний вперёд не заглядывает
    var room = Math.min(MAX_PAIRS, st.limit || 1) - st.table.length;
    if (room <= 0) return 0;
    if (st.hands[st.defender].length === 0) return 0;
    var rs = tableRanks(st), q, exp = 0;
    if (extraRank) rs[extraRank] = true;
    for (q = 0; q < st.opts.players; q++) {
      if (st.out[q] || q === me || q === st.defender) continue;
      exp += expRank(st, info, q, rs);
    }
    exp *= W.guess;                                  // не всё, что есть, соперник выложит
    return exp > room ? room : exp;
  }

  // Кому я открываю окно своей картой: не выйдет ли на ней тот, кто и так рядом с выходом
  function windowRisk(st, info, me, r) {
    var rs = {}, q, w = 0;
    if (!st.opts.podkidnoy) return 0;                // подкидывать некому — окна нет
    if (info.lvl < DIFF_HARD) return 0;              // средний за чужими руками не следит
    rs[r] = true;
    for (q = 0; q < st.opts.players; q++) {
      if (st.out[q] || q === me || q === st.defender) continue;
      var t = threat(st, q);
      if (t > 0) w += t * pRank(st, info, q, rs);
    }
    return w;
  }

  function rankCounts(hand) {
    var m = {}, i;
    for (i = 0; i < hand.length; i++) m[hand[i].r] = (m[hand[i].r] || 0) + 1;
    return m;
  }

  /* ---------- Веса ---------- */
  /*
   * Числа подобраны прогоном турниров бот-против-бота (12.08.2026). Объект
   * отдаётся наружу как Durak.botWeights, чтобы автотесты могли крутить веса
   * по одному и мерить результат. На саму игру это не влияет: в интерфейсе
   * веса никто не трогает.
   */

  var W = {
    /* Цена карты в руке */
    trBase: 18, trStep: 6,       // козырь, пока колода жива:   18 … 66
    trBaseE: 26, trStepE: 4,     // козырь при пустой колоде:   26 … 58
    plStep: 1.7,                 // простая карта, колода жива:  0 … 13,6
    plStepE: 1.6,                // простая карта, колоды нет:   0 … 12,8

    /* Защита: отбиться, перевести или взять */
    tempo: 10,       // отбился или перевёл — ходишь дальше сам, а это в дураке много
    spend: 0.75,     // во что обходится отданная карта
    trade: 0.5,      // …за вычетом того, что чужую карту снял со стола навсегда
    takeCard: 5.5,   // цена каждой карты, которую пришлось забрать
    takeCardEnd: 15, // то же, когда колода кончилась и карты уже не разменять
    takeBase: 12,    // взял — инициатива осталась у соперника, он заходит снова
    takeBaseEnd: 12,
    excess: 4.5,     // карты сверх шести уже не разменять: добора на них не будет
    riskCard: 4.2,   // цена каждой карты, которую довесят, если я отобьюсь
    riskCardEnd: 20, // при пустой колоде такой довесок особенно тяжёл
    backfire: 25,    // соперник переведёт мою карту дальше — стопка вернётся больше
    tight: 8,        // перевод тому, у кого карт в обрез
    transfer: 0,     // общая охота до перевода: плюс — переводит чаще

    /* Атака и подкидывание */
    kill: 2,         // соперник не побьёт — заберёт стол; считаем ЗА КАЖДУЮ карту стола
    killEnd: 3,
    dumpEnd: 16,     // сброс карты при пустой колоде — прямой шаг к выходу из игры
    dumpExtra: 5,    // карт больше шести: лишнее всё равно сливать
    redraw: 0.5,     // пока колода жива, сброс — это обмен на среднюю карту из колоды
    pair: 7,         // заход достоинством, которого у меня несколько (подкидной)
    pairEnd: 8,
    arm: 3.5,        // отдавать козыри тому, кто берёт, — вооружать его
    armBase: 8,
    throwBar: 0,     // планка «стоит ли вообще подкидывать»: выше — подкидывает реже

    /* Оглядка на остальной стол */
    helped: 8,       // помог сопернику сбросить карту
    window: 11,      // открыл окно тому, кто рядом с выходом
    load: 10,        // догрузить того, кто вот-вот выйдет
    lastCard: 15,    // у соперника последняя карта: заходить тем, что он не побьёт
    feed: 15,        // подкинул то, что он побьёт последней картой, — сам его выпустил
    exit: 400,       // ход, который выводит из игры меня самого — важнее всего
    guess: 0.62,     // какую долю подходящих карт соперники и правда выложат

    slip: 0.08       // как часто средний берёт второй по счёту ход вместо лучшего
  };

  // Из чего выбирать. Сложный всегда берёт лучшее; средний иногда, по зерну,
  // берёт второе по счёту — это его «не досмотрел». Случайность чистая:
  // botRnd зависит только от зерна, номера хода и места.
  function choose(st, me, lvl, list, salt) {
    if (!list.length) return null;
    var b = 0, s = -1, i;
    for (i = 1; i < list.length; i++) if (list[i].sc > list[b].sc) b = i;
    if (lvl >= DIFF_HARD || list.length < 2) return list[b].act;
    for (i = 0; i < list.length; i++) if (i !== b && (s < 0 || list[i].sc > list[s].sc)) s = i;
    if (s >= 0 && botRnd(st, me, salt) < W.slip) return list[s].act;
    return list[b].act;
  }

  /* ---------- Точка входа ---------- */

  // me — за какое место играем. По умолчанию за то, чей сейчас ход:
  // тем же кодом можно прогонять бота против бота при проверке баланса.
  function botMove(st, me) {
    if (st.over) return null;
    var actor = actorOf(st);
    if (actor === null) return null;
    if (me === undefined) me = actor;
    if (actor !== me) return null;

    var lvl = botLevel(st, me);
    var a = (st.phase === 'defend') ? botDefend(st, me, lvl) : botAttack(st, me, lvl);
    if (a) a.p = me;
    return a;
  }

  /* ---------- Атака и подкидывание ---------- */

  function botAttack(st, me, lvl) {
    var hand = st.hands[me], i, cards = [];
    for (i = 0; i < hand.length; i++) if (canAddFor(st, me, hand[i])) cards.push(hand[i]);
    if (!cards.length) return { type: 'done' };
    if (lvl === DIFF_EASY) return easyAttack(st, me, cards);

    var info = makeInfo(st, me, lvl);
    return st.table.length === 0 ? botLead(st, me, lvl, info, cards)
                                 : botThrow(st, me, lvl, info, cards);
  }

  // Первый заход в раунде
  function botLead(st, me, lvl, info, cards) {
    var def = st.defender, end = info.end, dup = rankCounts(st.hands[me]);
    var room = Math.min(MAX_PAIRS, st.limit || 1);
    var killW = end ? W.killEnd : W.kill;
    var list = [], i, c, sc, pb, extra, pile;

    for (i = 0; i < cards.length; i++) {
      c = cards[i];
      pb = pBeat(st, info, def, c);
      extra = 0;

      // Подкидной: заходить выгоднее тем достоинством, которого у меня несколько —
      // добьём защищающегося своими же картами, да и остальные добавят
      if (st.opts.podkidnoy) extra = Math.min((dup[c.r] || 1) - 1, room - 1);

      sc = -keepVal(st, c);
      if (extra > 0) sc += extra * (end ? W.pairEnd : W.pair);

      // Не побьёт — заберёт весь стол. Сколько это карт, столько и выгода:
      // в простом дураке всего одна, в подкидном — вся стопка.
      pile = 1 + (st.opts.podkidnoy ? Math.min(room - 1, extra + moreCards(st, info, me, c.r)) : 0);
      sc += (1 - pb) * killW * pile;

      // У соперника последняя карта: отобьётся — выйдет из игры. Заходим тем,
      // что он не побьёт, — тогда заберёт стол и останется играть.
      if (end && st.hands[def].length === 1) sc += (1 - pb) * W.lastCard;
      sc -= pb * threat(st, def) * W.helped;
      sc -= windowRisk(st, info, me, c.r) * W.window;

      // Заход последней картой при пустой колоде — это выход из игры
      if (end && st.hands[me].length === 1) sc += W.exit;

      list.push({ sc: sc, act: { type: 'attack', cardId: c.id } });
    }
    return choose(st, me, lvl, list, 12);
  }

  // Подкидывание: и пока защищающийся отбивается, и пока он берёт
  function botThrow(st, me, lvl, info, cards) {
    var def = st.defender, end = info.end, taking = st.phase === 'take';
    var mine = st.hands[me].length, avg = poolAvg(st, info);
    var thr = threat(st, def);
    var list = [{ sc: W.throwBar, act: { type: 'done' } }], i, c, sc, pb;

    for (i = 0; i < cards.length; i++) {
      c = cards[i];

      // 1. Сама по себе отдача карты
      if (end) sc = W.dumpEnd;
      else {
        sc = (avg - keepVal(st, c)) * W.redraw;
        if (mine > HAND_SIZE) sc += W.dumpExtra;
      }
      if (end && mine === 1) sc += W.exit;            // подкинул последнюю — вышел из игры

      if (taking) {
        // 2а. Соперник берёт: карта уедет ему в руку насовсем
        sc += W.load * thr;
        if (c.s === st.trump) sc -= W.armBase + (c.r - 6) * W.arm;   // козырями не вооружаем
        else if (c.r >= 13) sc -= (c.r - 12) * 3;
      } else {
        // 2б. Соперник отбивается: считаем, чем это кончится.
        // Не побьёт — заберёт весь стол вместе с моей картой, а он уже не маленький.
        pb = pBeat(st, info, def, c);
        sc += (1 - pb) * (end ? W.killEnd : W.kill) *
              (tableCardCount(st) + 1 + moreCards(st, info, me, c.r));
        sc -= pb * thr * W.helped;
        // У него последняя карта. Подкинуть то, что он побьёт, — значит своей
        // рукой вывести его из игры; лучше вообще промолчать.
        if (end && st.hands[def].length === 1) sc += (1 - pb) * W.lastCard - pb * W.feed;
        sc -= windowRisk(st, info, me, c.r) * W.window;
      }

      list.push({ sc: sc, act: { type: 'attack', cardId: c.id } });
    }
    return choose(st, me, lvl, list, 13);
  }

  /* ---------- Защита ---------- */

  function botDefend(st, me, lvl) {
    if (lvl === DIFF_EASY) return easyDefend(st, me);

    var hand = st.hands[me], tr = st.trump, i, c, sc;
    var idx = undefendedIndex(st), atk = st.table[idx].a;
    var info = makeInfo(st, me, lvl), end = info.end;
    var pile = tableCardCount(st);

    var list = [];

    // --- Взять
    var addWhileTaking = moreCards(st, info, me, 0);
    var grab = pile + addWhileTaking;
    // Карты сверх шести добором уже не разменять — они осядут в руке
    var excess = Math.max(0, hand.length + grab - HAND_SIZE);
    sc = -(grab * (end ? W.takeCardEnd : W.takeCard) + excess * W.excess +
           (end ? W.takeBaseEnd : W.takeBase));
    list.push({ sc: sc, act: { type: 'take' } });

    // --- Отбиться
    // Козырем по мелочи — перебор, козырем по крупной карте — честный размен:
    // чужую карту я со стола снимаю навсегда, и это часть выгоды.
    var atkVal = keepVal(st, atk) * W.trade;
    for (i = 0; i < hand.length; i++) {
      c = hand[i];
      if (!beats(c, atk, tr)) continue;
      var risk = moreCards(st, info, me, c.r);
      sc = -(keepVal(st, c) * W.spend - atkVal) - risk * (end ? W.riskCardEnd : W.riskCard) + W.tempo;
      if (end) sc += W.dumpEnd;                       // отбился — карт стало меньше
      // Отбился последней картой — стол закрывается, добавить уже нечем: выход из игры
      if (end && hand.length === 1) sc += W.exit;
      list.push({ sc: sc, act: { type: 'defend', cardId: c.id } });
    }

    // --- Перевести
    if (canTransferNow(st)) {
      var tgt = transferTarget(st), need = st.table.length + 1, rs;
      for (i = 0; i < hand.length; i++) {
        c = hand[i];
        if (c.r !== st.table[0].a.r) continue;
        sc = -keepVal(st, c) * W.spend + W.tempo + W.transfer;
        if (end) sc += W.dumpEnd; else sc += (poolAvg(st, info) - keepVal(st, c)) * W.redraw;
        // Перевод грузит следующего: чем ближе он к выходу, тем это ценнее
        sc += threat(st, tgt) * W.load;
        // Ему придётся отбивать всю стопку — если карт у него в обрез, тем лучше
        if (st.hands[tgt].length <= need + 1) sc += W.tight;
        // Но если у него есть такое же достоинство, он переведёт дальше — и за
        // столом на двоих стопка вернётся ко мне, только больше
        if (lvl >= DIFF_HARD) {
          rs = {}; rs[c.r] = true;
          sc -= pRank(st, info, tgt, rs) * W.backfire * (st.opts.players === 2 ? 1 : 0.4);
        }
        if (end && hand.length === 1) sc += W.exit;   // перевёл последней — вышел
        list.push({ sc: sc, act: { type: 'transfer', cardId: c.id } });
      }
    }

    return choose(st, me, lvl, list, 14);
  }

  /* ---------- Лёгкий уровень ---------- */
  /*
   * Эвристика первой версии игры: бережёт козыри, сливает мелочь, ближе к концу
   * колоды играет жаднее. Сверху — живые ошибки: иногда зайдёт не с той карты,
   * иногда не подкинет, иногда отобьётся картой покрупнее нужного.
   * Карт не считает, на остальной стол не смотрит.
   */

  function pick(st, me, salt, arr) {
    var i = Math.floor(botRnd(st, me, salt) * arr.length);
    if (i < 0) i = 0; else if (i >= arr.length) i = arr.length - 1;
    return arr[i];
  }

  function easyAttack(st, me, cards) {
    var tr = st.trump;
    var plain = cards.filter(function (c) { return c.s !== tr; })
      .sort(function (a, b) { return a.r - b.r; });

    if (st.table.length === 0) {
      var lead;
      if (plain.length) lead = plain[0];
      else lead = cards.slice().sort(function (a, b) { return a.r - b.r; })[0];
      if (botRnd(st, me, 3) < 0.16) lead = pick(st, me, 4, cards);      // зашёл не с той
      return { type: 'attack', cardId: lead.id };
    }

    if (!plain.length) return { type: 'done' };                          // козырями не подкидываем
    if (st.phase === 'take') return { type: 'attack', cardId: plain[0].id };

    var oppLeft = st.hands[st.defender].length;
    if (st.deck.length === 0 && oppLeft <= 2) return { type: 'done' };
    if (plain[0].r >= 12 && st.deck.length > 0) return { type: 'done' };
    if (botRnd(st, me, 5) < 0.12) return { type: 'done' };                // просто не заметил
    return { type: 'attack', cardId: plain[0].id };
  }

  function easyDefend(st, me) {
    var hand = st.hands[me], tr = st.trump;
    var idx = undefendedIndex(st);
    var atk = st.table[idx].a;

    var opts = hand.filter(function (c) { return beats(c, atk, tr); })
      .sort(function (a, b) { return power(a, tr) - power(b, tr); });

    if (canTransferNow(st)) {
      var cands = hand.filter(function (c) { return c.r === st.table[0].a.r && c.s !== tr; })
        .sort(function (a, b) { return a.r - b.r; });
      if (cands.length) {
        var mustTrump = !opts.length || opts[0].s === tr;
        if (mustTrump || atk.r <= 9 || botRnd(st, me, 1) < 0.45) {
          return { type: 'transfer', cardId: cands[0].id };
        }
      }
    }

    if (!opts.length) return { type: 'take' };

    var best = opts[0];
    if (opts.length > 1 && botRnd(st, me, 6) < 0.15) best = opts[1];      // отбился крупнее, чем надо

    if (best.s === tr && atk.s !== tr) {
      var takeSize = tableCardCount(st);
      var endgame = st.deck.length <= 4;
      if (!endgame && takeSize <= 2 && best.r >= 12 && atk.r <= 9) return { type: 'take' };
      if (st.deck.length >= 10 && takeSize <= 1 && best.r >= 11 && atk.r <= 8) return { type: 'take' };
    }
    if (botRnd(st, me, 7) < 0.07 && tableCardCount(st) <= 2) return { type: 'take' };  // сдался раньше времени
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
    DIFF_NAME: DIFF_NAME, DIFF_EASY: DIFF_EASY, DIFF_MED: DIFF_MED, DIFF_HARD: DIFF_HARD,
    normDiff: normDiff, botLevel: botLevel,
    botWeights: W,               // веса эвристики — крючок для автотестов, игрой не используется
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

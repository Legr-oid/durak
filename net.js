'use strict';
/*
 * net.js — сетевой режим «Дурака»: стол по ссылке-приглашению.
 *
 * Правил игры здесь нет ни строчки: партию считает game.js (объект Durak),
 * а game.js про сеть не знает вовсе. Здесь только транспорт и договорённости
 * о том, кто кому что шлёт.
 *
 * Экрана здесь тоже нет: модуль не трогает DOM и общается с интерфейсом
 * через колбэки (on.lobby, on.view, on.status, on.ended, on.trouble).
 * Благодаря этому его можно гонять автотестами: несколько независимых
 * клиентов в одной вкладке.
 *
 * ── Как всё устроено ──────────────────────────────────────────────────────
 *
 * Авторитет у создателя стола (хоста). Он держит полное состояние партии,
 * применяет к нему ходы через Durak.apply() и рассылает каждому игроку
 * ЕГО СРЕЗ состояния — свою руку, публичный стол, козырь, размер колоды и
 * количество карт у остальных. Чужих карт в срезе нет (см. viewFor).
 *
 * Число мест заранее не задаётся: в лобби живой список участников. Хост
 * жмёт «Начать» — партия стартует с тем составом, который сейчас в лобби.
 * Потолок — 6 участников, минимум для старта — 2. Боты добавляются вручную.
 *
 * Каналы Supabase Realtime:
 *
 *   durak:<КОД>              — общий канал стола. Presence + служебные сообщения.
 *   durak:<КОД>:p:<pid>      — личный «почтовый ящик» игрока: только туда хост
 *                              шлёт срез состояния этого игрока.
 *
 * Сообщения общего канала (событие 'm', тип в payload.t):
 *
 *   hello   гость → всем     {pid, nick}         «я здесь, посадите меня»
 *   lobby   хост  → всем     {lobby}             полный снимок лобби и связи
 *   intent  гость → хосту    {pid, act}          «хочу сходить вот так»
 *   resync  гость → хосту    {pid}               «я отстал, пришли снимок»
 *   ping    все   → всем     {pid, gen, seq}     пульс раз в 3 секунды
 *   nick    гость → хосту    {pid, nick}         сменил имя
 *   bye     любой → всем     {pid}               ухожу осознанно
 *   kick    хост  → всем     {pid}               игрок исключён
 *   end     хост  → всем     {reason}            стол закрыт
 *
 * Сообщения личного канала:
 *
 *   view    хост → игроку    {n, view}           срез состояния + номер сообщения
 *   deny    хост → игроку    {reason}            «нельзя сесть»: full | started
 *
 * ── Надёжность ────────────────────────────────────────────────────────────
 *
 * Доставка broadcast — at-most-once, сообщение может пропасть. Поэтому:
 *   • шлём не дельты, а полный срез + номер state.seq — потерянное само чинится
 *     следующим сообщением;
 *   • у каждого личного сообщения сквозной номер n: разрыв в нумерации →
 *     клиент просит resync;
 *   • свой пульс раз в 3 с. В пульсе хоста едет его state.seq: если клиент
 *     отстал, он это заметит даже когда ходов больше не будет;
 *   • presence используем только как быстрый сигнал «вкладку закрыли»;
 *   • статусы подписки обрабатываем и переподписываемся заново;
 *   • при возврате на вкладку (visibilitychange) сразу просим ресинк —
 *     на мобильных сокет часто умирает молча.
 */

var DurakNet = (function () {

  /* ---------- Константы ---------- */

  // Буквы и цифры, которые не путаются между собой: без 0/O, 1/I/L, 5/S, Q
  var CODE_ABC = 'ABCDEFGHJKMNPRTUVWXYZ2346789';
  var CODE_LEN = 5;

  var MAX_SEATS = 6;       // потолок стола, жёстко: седьмому — «стол полон»
  var MIN_START = 2;       // меньше двух играть не с кем

  var PING_MS   = 3000;    // свой пульс
  var TICK_MS   = 1000;    // как часто пересматриваем, кого не слышно
  var WEAK_MS   = 10000;   // не слышно столько — «теряет связь»
  var LOST_MS   = 45000;   // не слышно столько — пора решать
  var RESYNC_MS = 1200;    // чаще этого ресинк не просим
  var BOT_DELAY = { 2: 700, 3: 580, 4: 470, 5: 390, 6: 330 };
  var BACKOFF   = [1000, 2000, 5000, 10000];
  var GUARD_MAX = 4000;    // страховка от бесконечного цикла ботов

  function now() { return Date.now(); }
  function lib() {
    // ЛОВУШКА: библиотека кладёт в глобальную область переменную ровно `supabase`.
    // Свой клиент так называть нельзя — затрём библиотеку.
    return (typeof supabase !== 'undefined' && supabase && supabase.createClient) ? supabase : null;
  }
  function engine() { return (typeof Durak !== 'undefined') ? Durak : null; }

  /* ---------- Ник ---------- */

  function cleanNick(s) {
    s = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (s.length > 20) s = s.slice(0, 20).replace(/ $/, '');
    return s;
  }
  function nickError(s) {
    var v = cleanNick(s);
    if (!v.length) return 'Введи имя — соперники увидят именно его.';
    if (v.length < 2) return 'Слишком коротко: нужно хотя бы 2 символа.';
    return '';
  }
  // Грубая, но обычно верная догадка о роде: «Лена забрала», «Пётр забрал»
  function guessG(nick) {
    var s = cleanNick(nick).toLowerCase();
    return (s.length > 2 && /[ая]$/.test(s)) ? 'f' : 'm';
  }

  /* ---------- Код стола и ссылка ---------- */

  function makeCode() {
    var s = '', i, a = null;
    try {
      if (window.crypto && window.crypto.getRandomValues) {
        a = new Uint32Array(CODE_LEN);
        window.crypto.getRandomValues(a);
      }
    } catch (e) { a = null; }
    for (i = 0; i < CODE_LEN; i++) {
      var r = a ? a[i] : Math.floor(Math.random() * 4294967296);
      s += CODE_ABC.charAt(r % CODE_ABC.length);
    }
    return s;
  }

  function normCode(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  // Код из адреса: #стол=K7QX2, #room=K7QX2 или просто #K7QX2
  function roomFromHash() {
    var h = String(location.hash || '');
    if (!h) return '';
    try { h = decodeURIComponent(h); } catch (e) { /* кривая ссылка — читаем как есть */ }
    h = h.replace(/^#/, '');
    var m = /(?:^|[&?])(?:стол|room|table)=([^&]+)/i.exec(h);
    if (m) return normCode(m[1]);
    if (/^[A-Za-z0-9]{4,8}$/.test(h)) return normCode(h);
    return '';
  }

  function linkFor(code) {
    return String(location.href).split('#')[0] + '#стол=' + code;
  }

  function setHash(code) {
    try {
      if (code) {
        if (roomFromHash() !== code) location.hash = 'стол=' + code;
      } else if (location.hash) {
        history.replaceState(null, '', String(location.href).split('#')[0]);
      }
    } catch (e) { /* file:// иногда не даёт менять адрес — не страшно */ }
  }

  /* ---------- Срез состояния ---------- */

  function cardCopy(c) { return { r: c.r, s: c.s, id: c.id }; }

  /*
   * viewFor(st, p) — то единственное, что уходит игроку p.
   * Здесь нет ни колоды, ни чужих рук: только своя рука, публичный стол,
   * козырь, сколько карт осталось в колоде и по скольку карт у остальных.
   */
  function viewFor(st, p) {
    var D = engine(), i, s, h;
    var v = {
      gen: st.gen || 0,          // номер партии за столом: после «ещё партии» seq снова с нуля
      seq: st.seq,
      me: p,
      opts: {
        podkidnoy: !!st.opts.podkidnoy,
        perevodnoy: !!st.opts.perevodnoy,
        players: st.opts.players
      },
      seats: [],
      counts: [],
      trump: st.trump,
      trumpCard: cardCopy(st.trumpCard),
      deckLeft: st.deck.length,
      discard: st.discard,
      table: [],
      attacker: st.attacker,
      defender: st.defender,
      thrower: st.thrower,
      phase: st.phase,
      limit: st.limit,
      passed: st.passed.slice(),
      out: st.out.slice(),
      finished: st.finished.slice(),
      over: !!st.over,
      result: st.result ? {
        draw: !!st.result.draw,
        loser: (st.result.loser === null || st.result.loser === undefined) ? null : st.result.loser,
        stalemate: !!st.result.stalemate
      } : null,
      log: st.log.slice(-8),
      hand: [],
      legal: null
    };
    for (i = 0; i < st.opts.players; i++) {
      s = st.seats[i];
      // id места (оно же pid игрока) наружу не отдаём — он тут не нужен
      v.seats.push({ name: s.name, acc: s.acc || s.name, kind: s.kind, g: s.g || 'm' });
      v.counts.push(st.hands[i].length);
    }
    for (i = 0; i < st.table.length; i++) {
      v.table.push({
        a: cardCopy(st.table[i].a),
        d: st.table[i].d ? cardCopy(st.table[i].d) : null
      });
    }
    h = st.hands[p];
    for (i = 0; i < h.length; i++) v.hand.push(cardCopy(h[i]));
    v.legal = D.legal(st, p);      // права считает хост: клиенту чужие руки для этого не нужны
    return v;
  }

  /*
   * Обратная сборка: из среза делаем объект, похожий на состояние партии,
   * чтобы отрисовка работала одним и тем же кодом в офлайне и в сети.
   * Чужие руки заменены пустышками — у них верна только длина.
   */
  function stateFromView(v) {
    var i, k, hands = [], deck = [], arr;
    for (i = 0; i < v.opts.players; i++) {
      if (i === v.me) { hands.push(v.hand.slice()); continue; }
      arr = [];
      for (k = 0; k < v.counts[i]; k++) arr.push({ r: 0, s: '?', id: 'x' + i + '_' + k });
      hands.push(arr);
    }
    for (i = 0; i < v.deckLeft; i++) deck.push({ r: 0, s: '?', id: 'd' + i });
    return {
      v: 2, opts: v.opts, seats: v.seats, seed: 0, rng: 0, seq: v.seq, gen: v.gen || 0,
      trump: v.trump, trumpCard: v.trumpCard,
      deck: deck, hands: hands, table: v.table, discard: v.discard,
      attacker: v.attacker, defender: v.defender, thrower: v.thrower,
      passed: v.passed, out: v.out, finished: v.finished,
      phase: v.phase, limit: v.limit, idle: 0, beaten: false,
      over: v.over, result: v.result, reason: '', log: v.log
    };
  }

  /* ======================================================================
     ЭКЗЕМПЛЯР СОЕДИНЕНИЯ
     ====================================================================== */

  function create(o) {
    var D = engine();
    var on = o.on || {};
    var code = normCode(o.code);
    var pid = String(o.pid);
    var nick = cleanNick(o.nick);
    var isHost = !!o.host;

    var sb = null;
    var room = null;            // общий канал стола
    var roomReady = false;
    var boxes = {};             // pid -> {ch, ready, q} — личные каналы (у хоста по одному на игрока)
    var myBox = null;           // мой личный канал (все, кроме хоста, слушают его)
    var msgN = {};              // pid -> номер последнего отправленного личного сообщения
    var lastN = 0;              // номер последнего принятого личного сообщения
    var seen = {};              // pid -> когда последний раз слышали
    var linkNow = [];           // место -> 'ok' | 'weak' | 'lost'
    var troubleKey = '';        // кого сейчас считаем пропавшим — чтобы не дёргать интерфейс зря

    var stopped = false;
    var status = 'idle';
    var tries = 0;
    var rejoinT = null, pingT = null, tickT = null, botT = null;
    var lastResync = 0;
    var guard = 0;
    var ended = false;
    var gen = 0;                // номер партии за столом

    var game = null;            // полное состояние партии — только у хоста
    var myView = null;          // мой срез — у всех
    var hostPid = isHost ? pid : '';

    // Лобби: живой список участников. Число мест заранее не фиксируется.
    var lobby = {
      code: code,
      hostPid: isHost ? pid : '',
      rules: {
        podkidnoy: !!(o.rules && o.rules.podkidnoy),
        perevodnoy: !!(o.rules && o.rules.perevodnoy),
        // уровень ботов выбирает хост; гостям он приезжает вместе с лобби
        diff: D.normDiff(o.rules && o.rules.diff)
      },
      started: false,
      members: [],              // [{pid, nick, kind:'host'|'remote'|'bot'}]
      links: []
    };

    var self = {
      code: code,
      pid: pid,
      isHost: isHost,
      // Крючки для автотестов. На игру не влияют, в интерфейсе не используются.
      debug: { dropViews: 0, dropMyTurn: false, dropped: 0, gaps: 0, resyncs: 0, mute: false, keepRaw: false, raw: [] }
    };

    /* ---------- Мелочи ---------- */

    function fire(name, arg) {
      if (typeof on[name] === 'function') { try { on[name](arg); } catch (e) { logErr(e); } }
    }
    function logErr(e) { if (typeof console !== 'undefined' && console.warn) console.warn('[net]', e); }

    function setStatus(s) {
      if (status === s) return;
      status = s;
      fire('status', { status: s, isHost: isHost, code: code });
    }

    function seatOfPid(p) {
      if (!p) return -1;
      for (var i = 0; i < lobby.members.length; i++) if (lobby.members[i].pid === p) return i;
      return -1;
    }

    // Свободные имена ботов: Пётр, Анна, Игорь, Лиза, Марк (с родом и падежом)
    function botPool() { return D.defaultSeats(MAX_SEATS).slice(1); }
    function freeBot() {
      var pool = botPool(), i, j, busy;
      for (i = 0; i < pool.length; i++) {
        busy = false;
        for (j = 0; j < lobby.members.length; j++) {
          if (lobby.members[j].nick === pool[i].name) { busy = true; break; }
        }
        if (!busy) return pool[i];
      }
      return pool[0];
    }

    /* ---------- Отправка ---------- */

    function say(payload) {
      if (!room || stopped || !roomReady) return;
      if (self.debug.mute) return;    // крючок автотеста: «замолчали, но сокет ещё жив»
      try { room.send({ type: 'broadcast', event: 'm', payload: payload }); } catch (e) { logErr(e); }
    }

    /*
     * Личный канал подписывается не мгновенно, а слать в неподписанный нельзя.
     * Поэтому до готовности складываем в очередь. Срез состояния держим в очереди
     * только последний: он полный, старые всё равно не нужны.
     */
    function sayTo(p, payload) {
      var rec = boxes[p];
      if (!rec || stopped) return;
      if (!rec.ready) {
        if (payload.t === 'view') {
          rec.q = rec.q.filter(function (m) { return m.t !== 'view'; });
        }
        rec.q.push(payload);
        if (rec.q.length > 6) rec.q.shift();
        return;
      }
      try { rec.ch.send({ type: 'broadcast', event: 'm', payload: payload }); } catch (e) { logErr(e); }
    }

    function flushBox(p) {
      var rec = boxes[p];
      if (!rec || !rec.ready) return;
      var q = rec.q; rec.q = [];
      for (var i = 0; i < q.length; i++) {
        try { rec.ch.send({ type: 'broadcast', event: 'm', payload: q[i] }); } catch (e) { logErr(e); }
      }
    }

    /* ---------- Подключение ---------- */

    function connect() {
      var L = lib();
      if (!L) { fail('no-lib'); return; }
      if (!D) { fail('no-engine'); return; }
      try {
        sb = L.createClient(o.url, o.key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          realtime: { params: { eventsPerSecond: 40 } }   // хост шлёт до 6 срезов на один ход
        });
      } catch (e) { logErr(e); fail('no-client'); return; }

      if (isHost) lobby.members = [{ pid: pid, nick: nick, kind: 'host' }];
      seen[pid] = now();
      joinRoom();
      openMyBox();
      pingT = setInterval(pingTick, PING_MS);
      tickT = setInterval(watchTick, TICK_MS);
    }

    function fail(reason) {
      setStatus('failed');
      if (!ended) { ended = true; fire('ended', { reason: reason }); }
    }

    function joinRoom() {
      if (stopped) return;
      setStatus(tries ? 'reconnecting' : 'connecting');
      room = sb.channel('durak:' + code, {
        config: { broadcast: { self: false, ack: false }, presence: { key: pid } }
      });
      room.on('broadcast', { event: 'm' }, function (m) { onRoomMsg(m && m.payload); });
      room.on('presence', { event: 'leave' }, function (e) { onLeave(e); });
      room.subscribe(function (st) { onSub(st); });
    }

    function onSub(st) {
      if (stopped) return;
      if (st === 'SUBSCRIBED') {
        tries = 0;
        roomReady = true;
        // Пока мы сами были в отключке, чужого пульса не слышал никто — это не значит,
        // что все пропали. Заводим счётчики тишины заново.
        var k;
        for (k in seen) if (seen.hasOwnProperty(k)) seen[k] = now();
        setStatus('online');
        try { room.track({ pid: pid, nick: nick }); } catch (e) { logErr(e); }
        if (isHost) { lobbyChanged(); pushAll(); }   // хосту тоже нужно показать своё лобби
        else { say({ t: 'hello', pid: pid, nick: nick }); askResync(true); }
        pingTick();
        return;
      }
      if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
        roomReady = false;
        setStatus('reconnecting');
        scheduleRejoin();
      }
    }

    function scheduleRejoin() {
      if (stopped || rejoinT) return;
      var wait = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
      tries++;
      rejoinT = setTimeout(function () {
        rejoinT = null;
        if (stopped) return;
        dropChannel(room); room = null;
        dropChannel(myBox); myBox = null;
        joinRoom();
        openMyBox();
      }, wait);
    }

    function dropChannel(ch) {
      if (!ch || !sb) return;
      try { sb.removeChannel(ch); } catch (e) { logErr(e); }
    }

    // Личный ящик: сюда хост шлёт срез состояния именно этого игрока
    function boxName(p) { return 'durak:' + code + ':p:' + p; }

    function openMyBox() {
      if (isHost || stopped || myBox) return;
      myBox = sb.channel(boxName(pid), { config: { broadcast: { self: false, ack: false } } });
      myBox.on('broadcast', { event: 'm' }, function (m) { onBoxMsg(m && m.payload); });
      myBox.subscribe(function (st) {
        if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') scheduleRejoin();
      });
    }

    // Хост держит по каналу на каждого гостя, чтобы было куда слать срез
    function ensureBox(p) {
      if (!isHost || boxes[p] || stopped) return;
      var rec = { ch: null, ready: false, q: [] };
      boxes[p] = rec;
      rec.ch = sb.channel(boxName(p), { config: { broadcast: { self: false, ack: false } } });
      rec.ch.subscribe(function (st) {
        if (st === 'SUBSCRIBED') { rec.ready = true; flushBox(p); }
        else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') rec.ready = false;
      });
    }

    function closeBox(p) {
      if (!boxes[p]) return;
      dropChannel(boxes[p].ch);
      delete boxes[p];
      delete msgN[p];
    }

    /* ---------- Пульс и наблюдение за связью ---------- */

    function pingTick() {
      if (stopped) return;
      if (isHost) { say({ t: 'ping', pid: pid, gen: gen, seq: game ? game.seq : -1, started: lobby.started }); return; }
      say({ t: 'ping', pid: pid });
      // Ответа от создателя стола ещё не было: может, наш «hello» или его «lobby»
      // потерялись по дороге. Напоминаем о себе, пока нас не посадят.
      if (!lobby.members.length) say({ t: 'hello', pid: pid, nick: nick });
    }

    function linkOf(p) {
      var age = now() - (seen[p] || 0);
      if (age > LOST_MS) return 'lost';
      if (age > WEAK_MS) return 'weak';
      return 'ok';
    }

    function watchTick() {
      if (stopped) return;
      if (isHost) hostWatch(); else guestWatch();
    }

    function hostWatch() {
      var i, m, changed = false, links = [], troubled = [];
      for (i = 0; i < lobby.members.length; i++) {
        m = lobby.members[i];
        var l = (m.kind === 'host') ? 'me' : (m.kind === 'remote' ? linkOf(m.pid) : 'bot');
        links.push(l);
        if (linkNow[i] !== l) { linkNow[i] = l; changed = true; }
        if (m.kind === 'remote' && l === 'lost') troubled.push({ seat: i, pid: m.pid, nick: m.nick });
      }
      linkNow.length = links.length;
      lobby.links = links;
      if (changed) { sendLobby(); fire('lobby', publicLobby()); }
      // Сообщаем только когда список пропавших изменился: иначе интерфейс каждую
      // секунду перерисовывал бы кнопку «заменить ботом» прямо под пальцем.
      var key = troubled.map(function (t) { return t.pid; }).join(',');
      if (key !== troubleKey) {
        troubleKey = key;
        if (troubled.length) fire('trouble', { players: troubled });
      }
    }

    function guestWatch() {
      if (!hostPid) return;
      // Если отвалились мы сами, молчание хоста ни о чём не говорит — не хороним партию
      if (!roomReady) { setStatus('reconnecting'); return; }
      var l = linkOf(hostPid);
      if (l === 'lost' && !ended) { ended = true; fire('ended', { reason: 'host-silent' }); return; }
      setStatus(l === 'ok' ? 'online' : 'weak');
    }

    function onLeave(e) {
      // Presence не гарантирует точность: во время sync прилетают ложные leave.
      // Поэтому не выкидываем игрока, а просто «состариваем» его пульс —
      // если он жив, ближайший ping через 3 секунды всё вернёт назад.
      var arr = (e && e.leftPresences) || [];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i] && arr[i].pid;
        if (!p || p === pid) continue;
        if (seen[p] && now() - seen[p] < WEAK_MS) seen[p] = now() - WEAK_MS - 1;
      }
    }

    /* ---------- Приём сообщений общего канала ---------- */

    function onRoomMsg(m) {
      if (!m || !m.t || stopped) return;
      if (m.pid) seen[m.pid] = now();
      if (self.debug.keepRaw) self.debug.raw.push({ ch: 'room', p: m });

      switch (m.t) {
        case 'ping':
          if (!isHost && m.pid && m.pid === hostPid) hostPingSeen(m);
          break;
        case 'hello':   if (isHost) hostHello(m); break;
        case 'intent':  if (isHost) hostIntent(m); break;
        case 'resync':  if (isHost) hostResync(m.pid); break;
        case 'nick':    if (isHost) hostNick(m); break;
        case 'bye':     if (isHost) hostBye(m.pid); break;
        case 'lobby':   if (!isHost) guestLobby(m.lobby); break;
        case 'kick':
          if (!isHost && m.pid === pid && !ended) { ended = true; fire('ended', { reason: 'kicked' }); }
          break;
        case 'end':
          if (!isHost && !ended) { ended = true; fire('ended', { reason: m.reason || 'closed' }); }
          break;
      }
    }

    function hostPingSeen(m) {
      // Хост говорит, на каком он ходу. Отстали — просим снимок. Так чинится
      // потеря последнего сообщения, после которой других уже не будет.
      if (!m.started) return;
      if (!myView) { askResync(); return; }
      var g = m.gen || 0, mg = myView.gen || 0;
      if (g > mg) { askResync(); return; }
      if (g === mg && typeof m.seq === 'number' && m.seq >= 0 && m.seq > myView.seq) askResync();
    }

    /* ---------- Приём личных сообщений ---------- */

    function onBoxMsg(m) {
      if (!m || stopped) return;
      if (m.t === 'view') {
        // Крючки автотеста: искусственно теряем сообщение
        if (self.debug.dropMyTurn && m.view && m.view.legal && m.view.legal.actor === m.view.me) {
          self.debug.dropMyTurn = false; self.debug.dropped++; return;
        }
        if (self.debug.dropViews > 0) { self.debug.dropViews--; self.debug.dropped++; return; }

        if (self.debug.keepRaw) self.debug.raw.push({ ch: 'box', p: m });
        if (lastN && m.n > lastN + 1) { self.debug.gaps++; askResync(); }
        if (m.n) lastN = m.n;
        applyView(m.view);
        return;
      }
      if (m.t === 'deny' && !ended) { ended = true; fire('ended', { reason: m.reason || 'denied' }); }
    }

    function applyView(v) {
      if (!v) return;
      // Порядок broadcast не гарантирован: отставший снимок мог прилететь позже свежего
      if (myView && (v.gen || 0) < (myView.gen || 0)) return;
      if (myView && (v.gen || 0) === (myView.gen || 0) && v.seq < myView.seq && !v.over) return;
      myView = v;
      lobby.started = true;
      fire('view', v);
    }

    function askResync(force) {
      if (isHost || stopped) return;
      var t = now();
      if (!force && t - lastResync < RESYNC_MS) return;
      lastResync = t;
      self.debug.resyncs++;
      say({ t: 'resync', pid: pid });
    }

    /* ---------- Лобби ---------- */

    function publicLobby() {
      return {
        code: code, hostPid: lobby.hostPid, rules: lobby.rules, started: lobby.started,
        members: lobby.members.map(function (m) { return { pid: m.pid, nick: m.nick, kind: m.kind }; }),
        links: lobby.links.slice(),
        max: MAX_SEATS, minStart: MIN_START,
        isHost: isHost, mePid: pid, mySeat: seatOfPid(pid)
      };
    }

    function sendLobby() {
      if (!isHost) return;
      say({ t: 'lobby', pid: pid, lobby: publicLobby() });
    }

    function lobbyChanged() { sendLobby(); fire('lobby', publicLobby()); }

    function guestLobby(l) {
      if (!l) return;
      hostPid = l.hostPid || hostPid;
      if (hostPid) seen[hostPid] = now();
      lobby.rules = l.rules || lobby.rules;
      lobby.rules.diff = D.normDiff(lobby.rules.diff);
      lobby.members = l.members;
      lobby.links = l.links || [];
      lobby.hostPid = l.hostPid;
      var wasStarted = lobby.started;
      lobby.started = l.started;
      l.isHost = false; l.mePid = pid; l.mySeat = seatOfPid(pid);
      fire('lobby', l);
      if (lobby.started && !myView && !wasStarted) askResync(true);
    }

    /* ---------- Хост: приём игроков ---------- */

    function hostHello(m) {
      var i = seatOfPid(m.pid);
      if (i >= 0) {                       // уже за столом — значит, вернулся после обрыва
        if (cleanNick(m.nick)) lobby.members[i].nick = cleanNick(m.nick);
        ensureBox(m.pid);
        sendLobby();
        if (game) sendViewTo(m.pid);
        return;
      }
      ensureBox(m.pid);
      if (lobby.started) { sayTo(m.pid, { t: 'deny', reason: 'started' }); return; }
      if (lobby.members.length >= MAX_SEATS) { sayTo(m.pid, { t: 'deny', reason: 'full' }); return; }
      lobby.members.push({ pid: m.pid, nick: cleanNick(m.nick) || 'Гость', kind: 'remote' });
      seen[m.pid] = now();
      lobbyChanged();
    }

    function hostNick(m) {
      var i = seatOfPid(m.pid);
      if (i < 0 || !cleanNick(m.nick)) return;
      lobby.members[i].nick = cleanNick(m.nick);
      if (game && game.seats[i]) {
        game.seats[i].name = lobby.members[i].nick;
        game.seats[i].acc = lobby.members[i].nick;
      }
      lobbyChanged();
      if (game) pushAll();
    }

    function hostBye(p) {
      var i = seatOfPid(p);
      if (i < 0) return;
      if (!lobby.started) {                       // ещё не начали — просто уходит из списка
        lobby.members.splice(i, 1);
        linkNow = [];
        closeBox(p);
        lobbyChanged();
        return;
      }
      seen[p] = now() - LOST_MS - 1;              // партия идёт — сразу «потерян», хост решает
      hostWatch();
    }

    function hostResync(p) {
      if (!game) { sendLobby(); return; }
      sendViewTo(p);
    }

    /* ---------- Хост: боты и старт ---------- */

    function addBot() {
      if (!isHost || lobby.started) return false;
      if (lobby.members.length >= MAX_SEATS) return false;
      var b = freeBot();
      lobby.members.push({ pid: '', nick: b.name, kind: 'bot', acc: b.acc, g: b.g });
      lobbyChanged();
      return true;
    }

    function removeBot() {
      if (!isHost || lobby.started) return false;
      for (var i = lobby.members.length - 1; i >= 0; i--) {
        if (lobby.members[i].kind === 'bot') {
          lobby.members.splice(i, 1);
          linkNow = [];
          lobbyChanged();
          return true;
        }
      }
      return false;
    }

    function canStart() {
      return isHost && !lobby.started && lobby.members.length >= MIN_START;
    }

    function startGame() {
      if (!canStart()) return false;
      var n = lobby.members.length, i, m, seats = [];
      for (i = 0; i < n; i++) {
        m = lobby.members[i];
        if (m.kind === 'host') seats.push({ name: nick, acc: nick, kind: 'human', g: guessG(nick), id: pid });
        else if (m.kind === 'remote') seats.push({ name: m.nick, acc: m.nick, kind: 'remote', g: guessG(m.nick), id: m.pid });
        else seats.push({ name: m.nick, acc: m.acc || m.nick, kind: 'bot', g: m.g || 'm' });
      }
      game = D.create({
        players: n,
        podkidnoy: lobby.rules.podkidnoy,
        perevodnoy: lobby.rules.perevodnoy,
        diff: lobby.rules.diff,
        seats: seats
      });
      game.gen = ++gen;
      lobby.started = true;
      guard = 0;
      lobbyChanged();
      pushAll();
      scheduleBots();
      return true;
    }

    function restart() {
      if (!isHost || !game) return false;
      var seats = game.seats.map(function (s) {
        return { name: s.name, acc: s.acc, kind: s.kind, g: s.g, id: s.id };
      });
      game = D.create({
        players: game.opts.players,
        podkidnoy: lobby.rules.podkidnoy,
        perevodnoy: lobby.rules.perevodnoy,
        diff: lobby.rules.diff,
        seats: seats
      });
      game.gen = ++gen;
      guard = 0;
      pushAll();
      scheduleBots();
      return true;
    }

    /* ---------- Хост: рассылка срезов ---------- */

    function sendViewTo(p) {
      var i = seatOfPid(p);
      if (i < 0 || !game) return;
      msgN[p] = (msgN[p] || 0) + 1;
      sayTo(p, { t: 'view', n: msgN[p], view: viewFor(game, i) });
    }

    function pushAll() {
      if (!isHost || !game) return;
      for (var i = 0; i < lobby.members.length; i++) {
        var m = lobby.members[i];
        if (m.kind === 'host') { myView = viewFor(game, i); fire('view', myView); }
        else if (m.kind === 'remote' && m.pid) sendViewTo(m.pid);
      }
    }

    function afterChange() {
      pushAll();
      if (game && game.over) { stopBots(); return; }
      scheduleBots();
    }

    /*
     * Намерение приходит без названия карты: только её НОМЕР в руке отправителя
     * и номер состояния, на которое он смотрел. Так в общем канале не мелькает
     * ни одной карты, а хост сам достаёт её из своей копии руки.
     * Разошлись номера состояний — намерение устарело, отвечаем свежим срезом.
     */
    function hostIntent(m) {
      if (!game) return;
      var seat = seatOfPid(m.pid);
      if (seat < 0) return;
      if (game.over) { sendViewTo(m.pid); return; }
      var a = m.act || {}, cardId = null;
      if (typeof a.i === 'number' && a.i >= 0) {
        var hand = game.hands[seat];
        if ((a.gen || 0) !== gen || a.seq !== game.seq || a.i >= hand.length) { sendViewTo(m.pid); return; }
        cardId = hand[a.i].id;
      }
      var ok = D.apply(game, { type: a.type, cardId: cardId, p: seat });
      if (ok) { guard = 0; afterChange(); }
      else sendViewTo(m.pid);          // ход отклонён — вернём человеку правду о столе
    }

    /* ---------- Хост: боты в партии ---------- */

    function stopBots() { if (botT) { clearTimeout(botT); botT = null; } }

    function scheduleBots() {
      stopBots();
      if (!game || game.over || stopped) return;
      var actor = D.actorOf(game);
      if (actor === null || game.seats[actor].kind !== 'bot') return;
      var base = BOT_DELAY[game.opts.players] || 500;
      botT = setTimeout(botStep, base + Math.random() * base * 0.25);
    }

    function botStep() {
      botT = null;
      if (!game || game.over || stopped) return;
      if (++guard > GUARD_MAX) return;
      var actor = D.actorOf(game);
      if (actor === null || game.seats[actor].kind !== 'bot') return;
      var a = D.botMove(game, actor);
      var ok = a ? D.apply(game, a) : false;
      if (!ok) ok = D.apply(game, { type: 'take', p: actor }) || D.apply(game, { type: 'done', p: actor });
      if (!ok) return;
      afterChange();
    }

    /* ---------- Публичные методы ---------- */

    self.start = function () { if (!stopped && !sb) connect(); };

    self.lobby = function () { return publicLobby(); };
    self.view = function () { return myView; };
    self.status = function () { return status; };

    self.setNick = function (v) {
      var s = cleanNick(v);
      if (!s) return;
      nick = s;
      if (isHost) {
        var i = seatOfPid(pid);
        if (i >= 0) lobby.members[i].nick = s;
        if (game && game.seats[i]) { game.seats[i].name = s; game.seats[i].acc = s; }
        lobbyChanged();
        if (game) pushAll();
      } else {
        say({ t: 'nick', pid: pid, nick: s });
      }
      try { if (room) room.track({ pid: pid, nick: s }); } catch (e) { logErr(e); }
    };

    self.addBot = addBot;
    self.removeBot = removeBot;
    self.canStart = canStart;
    self.startGame = startGame;
    self.restart = restart;

    // Ход человека: хост применяет сразу, гость шлёт намерение.
    // Карта уезжает номером в руке, а не названием — см. hostIntent.
    self.act = function (action) {
      if (stopped || !action) return;
      if (isHost) {
        if (!game || game.over) return;
        var i = seatOfPid(pid);
        if (i < 0) return;
        if (D.apply(game, { type: action.type, cardId: action.cardId, p: i })) { guard = 0; afterChange(); }
        return;
      }
      var idx = -1, k;
      if (action.cardId && myView) {
        for (k = 0; k < myView.hand.length; k++) {
          if (myView.hand[k].id === action.cardId) { idx = k; break; }
        }
        if (idx < 0) return;                       // карты уже нет в руке — ход бессмысленный
      }
      say({
        t: 'intent', pid: pid,
        act: { type: action.type, i: idx, seq: myView ? myView.seq : -1, gen: myView ? myView.gen : 0 }
      });
    };

    self.kick = function (p) {
      if (!isHost) return;
      var i = seatOfPid(p);
      if (i < 0) return;
      var name = lobby.members[i].nick;
      say({ t: 'kick', pid: p });
      closeBox(p);
      if (lobby.started && game) {
        // Место занимает бот — партия не встаёт
        var b = freeBot();
        lobby.members[i] = { pid: '', nick: b.name, kind: 'bot', acc: b.acc, g: b.g };
        game.seats[i].kind = 'bot';
        game.seats[i].name = b.name;
        game.seats[i].acc = b.acc;
        game.seats[i].g = b.g;
        game.log.push(name + ' вышел, за него доигрывает бот ' + b.name);
        lobbyChanged();
        pushAll();
        scheduleBots();
      } else {
        lobby.members.splice(i, 1);
        linkNow = [];
        lobbyChanged();
      }
    };

    self.close = function (reason) { teardown(true, reason || 'closed'); };

    function teardown(sayBye, endReason) {
      if (stopped) return;
      if (sayBye && room && roomReady) {
        // Хост уходит — стол умирает вместе с ним, честно скажем об этом остальным
        try {
          if (isHost) room.send({ type: 'broadcast', event: 'm', payload: { t: 'end', reason: endReason || 'host-left' } });
          room.send({ type: 'broadcast', event: 'm', payload: { t: 'bye', pid: pid } });
        } catch (e) { }
      }
      stopped = true;
      roomReady = false;
      stopBots();
      if (pingT) { clearInterval(pingT); pingT = null; }
      if (tickT) { clearInterval(tickT); tickT = null; }
      if (rejoinT) { clearTimeout(rejoinT); rejoinT = null; }
      var k;
      for (k in boxes) if (boxes.hasOwnProperty(k)) dropChannel(boxes[k].ch);
      boxes = {};
      dropChannel(myBox); myBox = null;
      dropChannel(room); room = null;
      setStatus('closed');
    }

    self.leave = function () { teardown(true); };

    // Жёсткий обрыв без прощания — так выглядит закрытая вкладка. Нужен автотестам.
    self.crash = function () { teardown(false); };

    // Вернулись на вкладку: на мобильных сокет часто умирает молча
    self.wake = function () {
      if (stopped) return;
      if (isHost) { sendLobby(); pushAll(); }
      else askResync(true);
      pingTick();
    };

    self.gameState = function () { return game; };   // только у хоста, для автотестов

    return self;
  }

  /* ---------- Что отдаём наружу ---------- */

  return {
    available: function () { return !!lib() && typeof SUPABASE_URL === 'string'; },
    create: create,
    makeCode: makeCode,
    normCode: normCode,
    roomFromHash: roomFromHash,
    linkFor: linkFor,
    setHash: setHash,
    cleanNick: cleanNick,
    nickError: nickError,
    viewFor: viewFor,
    stateFromView: stateFromView,
    MAX_SEATS: MAX_SEATS,
    MIN_START: MIN_START,
    WEAK_MS: WEAK_MS,
    LOST_MS: LOST_MS
  };
})();

// Fixball Sunucusu - Asama 3: SERVER-AUTHORITATIVE
// Sunucu fizigi oda basina 60Hz calistirir; client'lar girdi gonderir + state'i cizer.
// Calistirma: node index.js

const http = require('http');
const { WebSocketServer } = require('ws');
const physics = require('./physics.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const TICK_MS = 1000 / 60;
const GRACE_MS = 20000; // beklenmedik kopmada reconnect icin bekleme suresi (ms)

// Kanonik saha (sabit). Client'lar bunu kendi ekranina olceklendirir.
const FIELD = { w: 820, h: 480, goalSize: 480 * 0.4, goalOnSides: true };

// === HTTP (health) ===
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'fixball-server', uptime: process.uptime(), rooms: rooms.size }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => {
  console.log(`Fixball sunucusu basladi: port ${PORT}`);
});

// === Veri yapilari ===
// rooms: code -> { host, guest, code, game }
const rooms = new Map();
let nextClientId = 1;

function generateRoomCode() {
  for (let i = 0; i < 100; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

// Reconnect icin slot kimligi (her oyuncuya verilir, kopunca bununla geri doner)
function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Acik (rakip bekleyen) odalarin listesi
function buildRoomList() {
  const list = [];
  for (const [code, room] of rooms) {
    if (room.host && room.guest === null && !(room.game && room.game.waitingReconnect)) {
      list.push({ code, host: (room.host.nickname || 'Oyuncu') });
    }
  }
  return list;
}

// Listeyi "bekleme/bosta" (odada olmayan) tum istemcilere yayinla
function broadcastRoomList() {
  const payload = { type: 'room_list', rooms: buildRoomList() };
  wss.clients.forEach((c) => {
    if (c.readyState === c.OPEN && !getRoomOfClient(c)) send(c, payload);
  });
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function getRoomOfClient(ws) {
  for (const [code, room] of rooms.entries()) {
    if (room.host === ws || room.guest === ws) return { code, room };
  }
  return null;
}

// ws'in rolu: host -> 'p1', guest -> 'p2'
function roleOf(room, ws) {
  if (room.host === ws) return 'p1';
  if (room.guest === ws) return 'p2';
  return null;
}

// === Oyun durumu ===
function newGame() {
  return {
    field: FIELD,
    p1: { x: 0, y: 0, vx: 0, vy: 0 },
    p2: { x: 0, y: 0, vx: 0, vy: 0 },
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    inputs: { p1: { dx: 0, dy: 0, kick: false }, p2: { dx: 0, dy: 0, kick: false } },
    score: { p1: 0, p2: 0 },
    phase: 'waiting', // waiting | playing | paused | over
    pausedBy: null,
    matchType: 'score',
    goalLimit: 5,
    timeLimit: 120,
    timeLeft: 0,
    timeAccum: 0,
    winner: null, // 'p1' | 'p2' | 'draw'
    ready: { p1: false, p2: false },
    countdown: 0,        // lobi sonrasi 3-2-1 geri sayim (0 = yok)
    countdownAccum: 0,   // geri sayim ms biriktirici
    ballHitPost: false,
    kickedP1: false,
    kickedP2: false,
    pressedP1: false, // butona basti (topa degse de degmese de) -> halka
    pressedP2: false,
    waitingReconnect: null, // 'p1'|'p2' kopuksa oyun donar, reconnect beklenir
    loop: null,
  };
}

function resetPositions(g) {
  // Kanonik = landscape (goalOnSides). p1 sagda, p2 solda, top ortada.
  g.p1.x = FIELD.w - 80; g.p1.y = FIELD.h / 2; g.p1.vx = 0; g.p1.vy = 0;
  g.p2.x = 80;           g.p2.y = FIELD.h / 2; g.p2.vx = 0; g.p2.vy = 0;
  g.ball.x = FIELD.w / 2; g.ball.y = FIELD.h / 2; g.ball.vx = 0; g.ball.vy = 0;
}

function startMatch(g) {
  g.score = { p1: 0, p2: 0 };
  g.winner = null;
  g.pausedBy = null;
  g.ready = { p1: false, p2: false };
  g.countdown = 0;
  g.countdownAccum = 0;
  g.timeAccum = 0;
  g.timeLeft = g.matchType === 'time' ? g.timeLimit : 0;
  resetPositions(g);
  g.phase = 'playing';
}

// Ikisi de Hazir olunca: 3-2-1 geri sayim baslat (tick isler, bitince startMatch)
function startCountdown(g) {
  g.phase = 'countdown';
  g.countdown = 3;
  g.countdownAccum = 0;
  resetPositions(g); // saha kickoff pozisyonunda gorunsun
}

function broadcast(room) {
  const g = room.game;
  const msg = {
    type: 'state',
    field: g.field,
    p1: g.p1, p2: g.p2, ball: g.ball,
    score: g.score,
    phase: g.phase,
    pausedBy: g.pausedBy,
    winner: g.winner,
    matchType: g.matchType,
    goalLimit: g.goalLimit,
    timeLimit: g.timeLimit,
    timeLeft: g.timeLeft,
    countdown: g.countdown,
    ready: g.ready,
    ballHitPost: g.ballHitPost,
    kickedP1: g.kickedP1,
    kickedP2: g.kickedP2,
    pressedP1: g.pressedP1,
    pressedP2: g.pressedP2,
    waitingReconnect: g.waitingReconnect,
  };
  send(room.host, msg);
  send(room.guest, msg);
  g.ballHitPost = false; // transient
  g.kickedP1 = false;
  g.kickedP2 = false;
  g.pressedP1 = false;
  g.pressedP2 = false;
}

function tick(room) {
  const g = room.game;

  if (g.waitingReconnect) {
    // bir oyuncu kopuk -> oyunu dondur, sadece durumu yayinla (grace suresi)
    broadcast(room);
    return;
  }

  if (g.phase === 'playing') {
    // Butona basis (topa degse de degmese de) -> halka icin, kick tuketilmeden once
    g.pressedP1 = g.inputs.p1.kick;
    g.pressedP2 = g.inputs.p2.kick;
    const ev = physics.simulate(
      { p1: g.p1, p2: g.p2, ball: g.ball },
      g.inputs.p1, g.inputs.p2, g.field
    );
    // kick edge: bir kez kullan
    g.inputs.p1.kick = false;
    g.inputs.p2.kick = false;
    g.ballHitPost = ev.ballHitPost;
    g.kickedP1 = ev.p1Kicked; // topa degdi -> ses
    g.kickedP2 = ev.p2Kicked;

    if (ev.scored) {
      g.score[ev.scored] += 1;
      resetPositions(g);
      // Skor limitli mac: kazanma kontrolu
      if (g.matchType === 'score') {
        if (g.score.p1 >= g.goalLimit) { g.phase = 'over'; g.winner = 'p1'; }
        else if (g.score.p2 >= g.goalLimit) { g.phase = 'over'; g.winner = 'p2'; }
      }
    }

    // Sureli mac: geri sayim
    if (g.phase === 'playing' && g.matchType === 'time') {
      g.timeAccum += TICK_MS;
      while (g.timeAccum >= 1000 && g.timeLeft > 0) {
        g.timeAccum -= 1000;
        g.timeLeft -= 1;
      }
      if (g.timeLeft <= 0) {
        g.phase = 'over';
        if (g.score.p1 > g.score.p2) g.winner = 'p1';
        else if (g.score.p2 > g.score.p1) g.winner = 'p2';
        else g.winner = 'draw';
      }
    }
  } else if (g.phase === 'countdown') {
    // 3-2-1 geri sayim: her saniye azalt, 0'a inince maci baslat
    g.countdownAccum += TICK_MS;
    if (g.countdownAccum >= 1000) {
      g.countdownAccum -= 1000;
      g.countdown -= 1;
      if (g.countdown <= 0) startMatch(g); // faz -> playing
    }
  }

  broadcast(room);
}

function startLoop(room) {
  if (room.game.loop) return;
  room.game.loop = setInterval(() => tick(room), TICK_MS);
}

function stopLoop(room) {
  if (room && room.game && room.game.loop) {
    clearInterval(room.game.loop);
    room.game.loop = null;
  }
}

function leaveRoom(ws) {
  const found = getRoomOfClient(ws);
  if (!found) return;
  const { code, room } = found;
  if (room.discTimer) { clearTimeout(room.discTimer); room.discTimer = null; }
  const wasHost = room.host === ws;
  const peer = wasHost ? room.guest : room.host;
  if (peer) send(peer, { type: 'peer_left' });

  if (wasHost) {
    stopLoop(room);
    rooms.delete(code);
    console.log(`[oda] ${code} kapandi (host ayrildi)`);
  } else {
    room.guest = null;
    stopLoop(room);
    room.game = newGame();
    console.log(`[oda] ${code} guest ayrildi, bekleme moduna dondu`);
  }
  broadcastRoomList();
}

// Beklenmedik kopma: slotu tut, oyunu dondur, grace sayaci basla
function handleDisconnect(code, room, slot) {
  if (!slot) return;
  // Host tek basinaysa (lobi/mac yok) -> reconnect'e gerek yok, direkt kapat
  if (slot === 'p1' && !room.guest) {
    if (room.discTimer) { clearTimeout(room.discTimer); room.discTimer = null; }
    stopLoop(room);
    rooms.delete(code);
    console.log(`[oda] ${code} kapandi (host ayrildi, bos oda)`);
    broadcastRoomList();
    return;
  }
  // Slotu bosalt ama oda+token dursun; oyunu dondur, rakibe bildir
  if (slot === 'p1') room.host = null; else room.guest = null;
  room.game.waitingReconnect = slot;
  console.log(`[oda] ${code} ${slot} koptu, ${GRACE_MS / 1000}sn reconnect bekleniyor`);
  if (room.discTimer) clearTimeout(room.discTimer);
  room.discTimer = setTimeout(() => {
    room.discTimer = null;
    finalizeLeave(code, room, slot);
  }, GRACE_MS);
}

// Grace doldu: kalici ayrilma
function finalizeLeave(code, room, slot) {
  if (!rooms.has(code)) return;
  const peer = slot === 'p1' ? room.guest : room.host;
  if (peer) send(peer, { type: 'peer_left' });
  if (slot === 'p1') {
    stopLoop(room);
    rooms.delete(code);
    console.log(`[oda] ${code} kapandi (reconnect olmadi)`);
  } else {
    room.guest = null;
    stopLoop(room);
    room.game = newGame();
    console.log(`[oda] ${code} guest reconnect olmadi, bekleme moduna`);
  }
  broadcastRoomList();
}

// === Baglanti ===
wss.on('connection', (ws, req) => {
  const clientId = 'c' + (nextClientId++);
  ws.clientId = clientId;
  console.log(`[+] Baglanti: ${clientId}`);
  try { if (req.socket && req.socket.setNoDelay) req.socket.setNoDelay(true); } catch (e) {}

  send(ws, { type: 'hello', clientId, serverTime: Date.now() });
  send(ws, { type: 'room_list', rooms: buildRoomList() }); // mevcut acik odalar

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {

      // Takma ad: oyuncuyu listede tanitmak icin (Stage 2/3 kullanir)
      case 'set_nick': {
        let n = String(msg.name || '').trim().slice(0, 12);
        if (!n) n = 'Oyuncu' + String(ws.clientId).replace(/\D/g, '');
        ws.nickname = n;
        break;
      }

      case 'create_room': {
        if (getRoomOfClient(ws)) { send(ws, { type: 'error', message: 'Zaten bir odadasin' }); return; }
        const code = generateRoomCode();
        if (!code) { send(ws, { type: 'error', message: 'Oda olusturulamadi' }); return; }
        rooms.set(code, { host: ws, guest: null, code, game: newGame() });
        console.log(`[oda] ${code} olusturuldu`);
        send(ws, { type: 'room_created', code });
        broadcastRoomList(); // yeni acik oda
        break;
      }

      case 'join_room': {
        const code = String(msg.code || '').trim();
        if (!code) { send(ws, { type: 'join_failed', reason: 'Kod bos' }); return; }
        if (getRoomOfClient(ws)) { send(ws, { type: 'join_failed', reason: 'Zaten bir odadasin' }); return; }
        const room = rooms.get(code);
        if (!room) { send(ws, { type: 'join_failed', reason: 'Oda bulunamadi' }); return; }
        if (room.guest) { send(ws, { type: 'join_failed', reason: 'Oda dolu' }); return; }
        if (room.host === ws) { send(ws, { type: 'join_failed', reason: 'Kendi odana katilamazsin' }); return; }

        room.guest = ws;
        room.game = newGame();
        room.tokens = { p1: genToken(), p2: genToken() }; // reconnect tokenlari
        resetPositions(room.game); // bekleme aninda da saha dolu gorunsun
        console.log(`[oda] ${code} guest katildi, eslesme`);
        room.game.phase = 'lobby'; // otomatik baslatma yok; lobide bekle
        send(room.host, { type: 'match_start', role: 'host', code, token: room.tokens.p1 });
        send(room.guest, { type: 'match_start', role: 'guest', code, token: room.tokens.p2 });
        startLoop(room); // state yayini baslar (faz: lobby)
        broadcastRoomList(); // oda doldu -> listeden cikar
        break;
      }

      // Acik oda listesini iste (manuel yenileme)
      case 'request_rooms': {
        send(ws, { type: 'room_list', rooms: buildRoomList() });
        break;
      }

      // Reconnect: kopan oyuncu token ile geri doner
      case 'rejoin': {
        const code = String(msg.code || '').trim();
        const token = String(msg.token || '');
        const room = rooms.get(code);
        if (!room || !room.tokens) { send(ws, { type: 'rejoin_failed', reason: 'Oda yok' }); return; }
        let slot = null;
        if (room.tokens.p1 === token && room.host === null) slot = 'p1';
        else if (room.tokens.p2 === token && room.guest === null) slot = 'p2';
        if (!slot) { send(ws, { type: 'rejoin_failed', reason: 'Gecersiz' }); return; }
        // Slotu yeni baglantiya bagla, oyunu coz
        if (slot === 'p1') room.host = ws; else room.guest = ws;
        if (room.discTimer) { clearTimeout(room.discTimer); room.discTimer = null; }
        room.game.waitingReconnect = null;
        console.log(`[oda] ${code} ${slot} geri baglandi`);
        send(ws, { type: 'match_start', role: slot === 'p1' ? 'host' : 'guest', code, token });
        // loop zaten calisiyor; sonraki tick state yollar
        break;
      }

      // Host mac ayarlarini gonderir -> mac baslar
      case 'config': {
        const found = getRoomOfClient(ws);
        if (!found || roleOf(found.room, ws) !== 'p1') return;
        const g = found.room.game;
        if (msg.matchType === 'time' || msg.matchType === 'score') g.matchType = msg.matchType;
        if (typeof msg.goalLimit === 'number') g.goalLimit = msg.goalLimit;
        if (typeof msg.timeLimit === 'number') g.timeLimit = msg.timeLimit;
        // Lobi: ayar guncellenir, broadcast'te yayinlanir; mac READY ile baslar.
        // Ayar degisince hazir bayraklarini sifirla (yeniden onay gereksin)
        if (g.phase === 'lobby') g.ready = { p1: false, p2: false };
        break;
      }

      // Her client kendi girdisini yollar (~60Hz)
      case 'input': {
        const found = getRoomOfClient(ws);
        if (!found) return;
        const role = roleOf(found.room, ws);
        if (!role) return;
        const inp = found.room.game.inputs[role];
        inp.dx = typeof msg.dx === 'number' ? msg.dx : 0;
        inp.dy = typeof msg.dy === 'number' ? msg.dy : 0;
        if (msg.kick) inp.kick = true; // edge: tick'te bir kez kullanilir
        break;
      }

      // Pause: ikisi de pause edebilir, sadece BASLATAN resume eder
      case 'pause': {
        const found = getRoomOfClient(ws);
        if (!found) return;
        const role = roleOf(found.room, ws);
        const g = found.room.game;
        if (g.phase === 'over') return;
        if (g.phase === 'playing') {
          g.phase = 'paused';
          g.pausedBy = role;
        } else if (g.phase === 'paused' && g.pausedBy === role) {
          g.phase = 'playing';
          g.pausedBy = null;
        }
        break;
      }

      // Hazir: lobi (ilk mac) veya over (rematch). Ikisi de hazirsa 3-2-1 geri sayim.
      case 'ready': {
        const found = getRoomOfClient(ws);
        if (!found) return;
        const role = roleOf(found.room, ws);
        const g = found.room.game;
        if (g.phase !== 'lobby' && g.phase !== 'over') return;
        g.ready[role] = true;
        if (g.ready.p1 && g.ready.p2) startCountdown(g); // 3-2-1 sonra startMatch
        break;
      }

      case 'leave_room': {
        leaveRoom(ws);
        send(ws, { type: 'left_room' });
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong', t: msg.t });
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[-] Baglanti kapandi: ${clientId}`);
    const found = getRoomOfClient(ws);
    if (!found) return; // odada degil (ya da kasitli leave_room ile cikmis)
    handleDisconnect(found.code, found.room, roleOf(found.room, ws));
  });
  ws.on('error', () => {});
});

wss.on('error', (err) => console.error('Sunucu hatasi:', err.message));

setInterval(() => {
  if (rooms.size > 0) console.log(`[durum] aktif oda: ${rooms.size}`);
}, 30000);

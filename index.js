// Fixball Sunucusu - Asama 2: Oda sistemi
// Calistirma: node index.js
// Durdurma: Ctrl+C

const { WebSocketServer } = require('ws');

// Render gibi cloud servisleri PORT'u env variable olarak verir.
// Yerelde calistirirken 3000 fallback.
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const wss = new WebSocketServer({ port: PORT });

console.log(`Fixball sunucusu basladi: port ${PORT}`);
console.log(`Baglanti icin: ws://<bilgisayar-ip>:${PORT}`);
console.log(`Durdurmak icin: Ctrl+C\n`);

// === Veri yapilari ===

// Tum odalar: { "837241": { host: ws, guest: ws | null, state: "waiting" | "playing" } }
const rooms = new Map();

// Her istemciye atanan unique ID
let nextClientId = 1;

// === Yardimci fonksiyonlar ===

function generateRoomCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      console.log('[!] Gonderim hatasi:', e.message);
    }
  }
}

function getRoomOfClient(ws) {
  for (const [code, room] of rooms.entries()) {
    if (room.host === ws || room.guest === ws) {
      return { code, room };
    }
  }
  return null;
}

function leaveRoom(ws) {
  const found = getRoomOfClient(ws);
  if (!found) return;
  const { code, room } = found;
  const wasHost = room.host === ws;
  const peer = wasHost ? room.guest : room.host;

  if (peer) {
    send(peer, { type: 'peer_left' });
  }

  if (wasHost) {
    rooms.delete(code);
    console.log(`[oda] ${code} kapandi (host ayrildi)`);
  } else {
    room.guest = null;
    room.state = 'waiting';
    console.log(`[oda] ${code} guest ayrildi, bekleme moduna dondu`);
  }
}

// === Baglanti yonetimi ===

wss.on('connection', (ws, req) => {
  const clientId = 'c' + (nextClientId++);
  ws.clientId = clientId;
  const clientIP = req.socket.remoteAddress;
  console.log(`[+] Baglanti: ${clientId} (${clientIP})`);

  send(ws, {
    type: 'hello',
    clientId,
    serverTime: Date.now(),
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      send(ws, { type: 'error', message: 'Gecersiz JSON' });
      return;
    }

    if (!msg || typeof msg.type !== 'string') {
      send(ws, { type: 'error', message: 'type alani eksik' });
      return;
    }

    switch (msg.type) {

      case 'create_room': {
        if (getRoomOfClient(ws)) {
          send(ws, { type: 'error', message: 'Zaten bir odadasin' });
          return;
        }
        const code = generateRoomCode();
        if (!code) {
          send(ws, { type: 'error', message: 'Oda olusturulamadi' });
          return;
        }
        rooms.set(code, { host: ws, guest: null, state: 'waiting' });
        console.log(`[oda] ${code} olusturuldu (host: ${clientId})`);
        send(ws, { type: 'room_created', code });
        break;
      }

      case 'join_room': {
        const code = String(msg.code || '').trim();
        if (!code) {
          send(ws, { type: 'join_failed', reason: 'Kod bos' });
          return;
        }
        if (getRoomOfClient(ws)) {
          send(ws, { type: 'join_failed', reason: 'Zaten bir odadasin' });
          return;
        }
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: 'join_failed', reason: 'Oda bulunamadi' });
          return;
        }
        if (room.guest) {
          send(ws, { type: 'join_failed', reason: 'Oda dolu' });
          return;
        }
        if (room.host === ws) {
          send(ws, { type: 'join_failed', reason: 'Kendi odana katilamazsin' });
          return;
        }

        room.guest = ws;
        room.state = 'playing';
        console.log(`[oda] ${code} guest katildi (${clientId}), mac basliyor`);

        send(room.host, { type: 'match_start', role: 'host' });
        send(room.guest, { type: 'match_start', role: 'guest' });
        break;
      }

      case 'leave_room': {
        leaveRoom(ws);
        send(ws, { type: 'left_room' });
        break;
      }

      case 'relay': {
        const found = getRoomOfClient(ws);
        if (!found) {
          send(ws, { type: 'error', message: 'Bir odada degilsin' });
          return;
        }
        const peer = found.room.host === ws ? found.room.guest : found.room.host;
        if (peer) {
          send(peer, { type: 'relay', payload: msg.payload });
        }
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong', t: msg.t });
        break;
      }

      default: {
        send(ws, { type: 'error', message: 'Bilinmeyen tip: ' + msg.type });
      }
    }
  });

  ws.on('close', () => {
    console.log(`[-] Baglanti kapandi: ${clientId}`);
    leaveRoom(ws);
  });

  ws.on('error', (err) => {
    console.log(`[!] Hata (${clientId}):`, err.message);
  });
});

wss.on('error', (err) => {
  console.error('Sunucu hatasi:', err.message);
});

setInterval(() => {
  if (rooms.size > 0) {
    console.log(`[durum] aktif oda sayisi: ${rooms.size}`);
  }
}, 30000);

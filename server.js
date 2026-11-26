const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('ok'));

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 20;
const NIGHT_TIMEOUT_MS = 3 * 60 * 1000; // gece en fazla 3 dk (uyuyakalan olursa)
const VOTE_TIMEOUT_MS = 2 * 60 * 1000; // oylama en fazla 2 dk
const RESULT_TIMEOUT_MS = 20 * 1000; // oylama sonucu ekranı en fazla 20 sn

function setEvent(room, type, victimId = null, savedId = null) {
  room.event = { id: ++room.eventCounter, type, victimId, savedId };
}

const rooms = new Map();

const ROLE_NAMES = { vampire: 'Vampir', villager: 'Köylü', doctor: 'Doktor', seer: 'Kâhin' };

function newCode() {
  const letters = 'ABCDEFGHJKLMNPRSTUVYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(c)) return c;
  }
}
const uid = () => crypto.randomBytes(8).toString('hex');
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const alive = (room) => [...room.players.values()].filter((p) => p.alive);

function createRoom() {
  const code = newCode();
  const room = {
    code,
    hostId: null,
    players: new Map(),
    settings: { vampires: 1, doctor: true, seer: true, discussionSec: 300 },
    phase: 'lobby',
    day: 0,
    actions: {}, // gece: playerId -> targetId
    votes: {}, // gün oylaması
    skipVotes: new Set(),
    announcement: null,
    event: null, // son olay: animasyonları tetikler { id, type, victimId }
    eventCounter: 0,
    voteResult: null,
    ready: new Set(),
    pendingWin: null,
    history: [],
    winner: null,
    deadline: null,
    timer: null,
    lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function maxVampires(n) {
  // vampirler köylülerin yarısından azı olmalı ki oyun başlar başlamaz bitmesin
  return Math.max(1, Math.ceil(n / 2) - 1);
}

function clampSettings(room) {
  const n = room.players.size;
  const s = room.settings;
  s.vampires = Math.max(1, Math.min(Math.floor(s.vampires) || 1, maxVampires(Math.max(n, MIN_PLAYERS))));
}

function validateStart(room) {
  const n = room.players.size;
  const s = room.settings;
  if (n < MIN_PLAYERS) return `En az ${MIN_PLAYERS} oyuncu gerekli.`;
  if (s.vampires > maxVampires(n)) return `${n} kişiyle en fazla ${maxVampires(n)} vampir olabilir.`;
  const special = s.vampires + (s.doctor ? 1 : 0) + (s.seer ? 1 : 0);
  if (special > n) return 'Rol sayısı oyuncu sayısından fazla.';
  return null;
}

function clearTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.deadline = null;
}
function setTimer(room, ms, fn) {
  clearTimer(room);
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(fn, ms);
}

function startGame(room) {
  const ids = shuffle([...room.players.keys()]);
  const s = room.settings;
  const roles = [];
  for (let i = 0; i < s.vampires; i++) roles.push('vampire');
  if (s.doctor) roles.push('doctor');
  if (s.seer) roles.push('seer');
  while (roles.length < ids.length) roles.push('villager');
  ids.forEach((id, i) => {
    const p = room.players.get(id);
    p.role = roles[i];
    p.alive = true;
    p.revealed = false;
    p.seerResults = [];
    p.lastProtected = null;
  });
  room.day = 0;
  room.winner = null;
  room.history = [];
  room.announcement = null;
  room.event = null;
  room.voteResult = null;
  startNight(room);
}

function startNight(room) {
  room.day += 1;
  room.phase = 'night';
  room.actions = {};
  room.votes = {};
  room.skipVotes = new Set();
  setTimer(room, NIGHT_TIMEOUT_MS, () => resolveNight(room));
  broadcast(room);
}

function checkWin(room) {
  const a = alive(room);
  const vamps = a.filter((p) => p.role === 'vampire').length;
  const others = a.length - vamps;
  if (vamps === 0) return 'village';
  if (vamps >= others) return 'vampire';
  return null;
}

function endGame(room, winner) {
  clearTimer(room);
  room.phase = 'over';
  room.winner = winner;
  for (const p of room.players.values()) p.revealed = true;
  broadcast(room);
}

function resolveNight(room) {
  if (room.phase !== 'night') return;
  const a = alive(room);

  // vampir hedefi: oy çokluğu, eşitlikte rastgele
  const tally = {};
  for (const p of a.filter((x) => x.role === 'vampire')) {
    const t = room.actions[p.id];
    if (t && room.players.get(t)?.alive) tally[t] = (tally[t] || 0) + 1;
  }
  let target = null;
  const entries = Object.entries(tally);
  if (entries.length) {
    const max = Math.max(...entries.map(([, c]) => c));
    const top = entries.filter(([, c]) => c === max).map(([id]) => id);
    target = top[crypto.randomInt(top.length)];
  }

  const doctor = a.find((p) => p.role === 'doctor');
  const protectedId = doctor ? room.actions[doctor.id] : null;
  if (doctor) doctor.lastProtected = protectedId || null;

  // kâhin sonucu
  const seer = a.find((p) => p.role === 'seer');
  if (seer) {
    const t = room.players.get(room.actions[seer.id]);
    if (t) seer.seerResults.push({ name: t.name, vampire: t.role === 'vampire', day: room.day });
  }

  let text;
  if (target && target !== protectedId) {
    const v = room.players.get(target);
    v.alive = false;
    v.revealed = true;
    text = `Sabah oldu. ${v.name} gece vampirler tarafından öldürüldü. Rolü: ${ROLE_NAMES[v.role]}.`;
    setEvent(room, 'kill', v.id);
  } else if (target) {
    text = 'Sabah oldu. Vampirler saldırdı ama Doktor kurbanı kurtardı. Kimse ölmedi.';
    setEvent(room, 'saved', null, target);
  } else {
    text = 'Sabah oldu. Gece kimse ölmedi.';
    setEvent(room, 'quiet');
  }
  room.announcement = text;
  room.history.push(`Gece ${room.day}: ${text.replace('Sabah oldu. ', '')}`);

  const w = checkWin(room);
  if (w) return endGame(room, w);

  room.phase = 'day';
  room.skipVotes = new Set();
  setTimer(room, room.settings.discussionSec * 1000, () => startVote(room));
  broadcast(room);
}

function startVote(room) {
  if (room.phase !== 'day') return;
  room.phase = 'vote';
  room.votes = {};
  setTimer(room, VOTE_TIMEOUT_MS, () => resolveVote(room));
  broadcast(room);
}

function resolveVote(room) {
  if (room.phase !== 'vote') return;
  const tally = {};
  const skipVoters = [];
  for (const p of alive(room)) {
    const v = room.votes[p.id];
    if (!v || v === 'skip') skipVoters.push(p.name);
    else (tally[v] = tally[v] || []).push(p.name);
  }
  const rows = Object.entries(tally)
    .map(([id, voters]) => ({ id, name: room.players.get(id).name, voters }))
    .sort((a, b) => b.voters.length - a.voters.length);
  const max = rows.length ? rows[0].voters.length : 0;
  const top = rows.filter((r) => r.voters.length === max);

  let text;
  let victimId = null;
  if (max === 0 || top.length > 1 || skipVoters.length >= max) {
    text = top.length > 1 ? 'Oylar eşit çıktı, kimse elenmedi.' : 'Köy kimseyi elemeye karar vermedi.';
    setEvent(room, 'vote-none');
  } else {
    const v = room.players.get(top[0].id);
    v.alive = false;
    v.revealed = true;
    victimId = v.id;
    text = `Köy oylamasıyla ${v.name} elendi. Rolü: ${ROLE_NAMES[v.role]}.`;
    setEvent(room, 'vote-out', v.id);
  }
  room.voteResult = { rows, skipVoters, victimId, text };
  room.announcement = text;
  const summary = rows.map((r) => `${r.name} ${r.voters.length}`).join(', ');
  room.history.push(`Gün ${room.day}: ${text}${summary ? ` (Oylar: ${summary})` : ''}`);

  room.pendingWin = checkWin(room);
  room.phase = 'result';
  room.ready = new Set();
  setTimer(room, RESULT_TIMEOUT_MS, () => finishResult(room));
  broadcast(room);
}

function finishResult(room) {
  if (room.phase !== 'result') return;
  if (room.pendingWin) return endGame(room, room.pendingWin);
  startNight(room);
}

function maybeAdvance(room) {
  if (room.phase === 'night') {
    if (alive(room).every((p) => room.actions[p.id])) resolveNight(room);
  } else if (room.phase === 'day') {
    if (room.skipVotes.size > alive(room).length / 2) startVote(room);
  } else if (room.phase === 'vote') {
    if (alive(room).every((p) => room.votes[p.id])) resolveVote(room);
  } else if (room.phase === 'result') {
    if (alive(room).every((p) => room.ready.has(p.id))) finishResult(room);
  }
}

function viewFor(room, me) {
  const isVamp = me.role === 'vampire';
  const over = room.phase === 'over';
  const canSeeAll = over || (!me.alive && room.phase !== 'lobby');
  const v = {
    code: room.code,
    phase: room.phase,
    day: room.day,
    deadline: room.deadline,
    settings: room.settings,
    maxVampires: maxVampires(Math.max(room.players.size, MIN_PLAYERS)),
    minPlayers: MIN_PLAYERS,
    announcement: room.announcement,
    event: room.event
      ? { id: room.event.id, type: room.event.type, victimId: room.event.victimId, savedMe: room.event.savedId === me.id }
      : null,
    history: room.history,
    winner: room.winner,
    me: {
      id: me.id,
      name: me.name,
      isHost: room.hostId === me.id,
      role: room.phase === 'lobby' ? null : me.role,
      roleName: room.phase === 'lobby' ? null : ROLE_NAMES[me.role],
      alive: me.alive,
      seerResults: me.role === 'seer' ? me.seerResults : undefined,
      lastProtected: me.role === 'doctor' ? me.lastProtected : undefined,
    },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      role: p.revealed || canSeeAll || (isVamp && p.role === 'vampire') ? p.role : undefined,
      roleName:
        p.revealed || canSeeAll || (isVamp && p.role === 'vampire') ? ROLE_NAMES[p.role] : undefined,
    })),
  };
  if (room.phase === 'night' && me.alive) {
    v.night = { done: !!room.actions[me.id], choice: room.actions[me.id] || null };
    if (isVamp) {
      v.night.vampVotes = alive(room)
        .filter((p) => p.role === 'vampire' && room.actions[p.id])
        .map((p) => ({ by: p.name, target: room.actions[p.id] }));
    }
  }
  if (room.phase === 'day') {
    v.skipCount = room.skipVotes.size;
    v.skippedByMe = room.skipVotes.has(me.id);
    v.needed = Math.floor(alive(room).length / 2) + 1;
  }
  if (room.phase === 'result') {
    v.voteResult = room.voteResult;
    v.ready = { count: room.ready.size, total: alive(room).length, mine: room.ready.has(me.id) };
  }
  if (room.phase === 'vote') {
    v.vote = {
      mine: room.votes[me.id] || null,
      count: Object.keys(room.votes).length,
      total: alive(room).length,
    };
  }
  return v;
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', viewFor(room, p));
  }
}

function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 14);
}

io.on('connection', (socket) => {
  let room = null;
  let player = null;

  const err = (m) => socket.emit('err', m);
  const attach = (r, p) => {
    room = r;
    player = p;
    p.socketId = socket.id;
    p.connected = true;
    socket.emit('joined', { token: p.id, code: r.code });
    broadcast(r);
  };

  socket.on('create', ({ name }) => {
    name = cleanName(name);
    if (!name) return err('İsim gir.');
    const r = createRoom();
    const p = { id: uid(), name, role: null, alive: true, connected: true, revealed: false, seerResults: [] };
    r.players.set(p.id, p);
    r.hostId = p.id;
    attach(r, p);
  });

  socket.on('join', ({ name, code }) => {
    name = cleanName(name);
    code = String(code || '').toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return err('Oda bulunamadı.');
    if (r.phase !== 'lobby') return err('Oyun başladı, katılamazsın.');
    if (!name) return err('İsim gir.');
    if (r.players.size >= MAX_PLAYERS) return err('Oda dolu.');
    if ([...r.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return err('Bu isim kullanılıyor.');
    const p = { id: uid(), name, role: null, alive: true, connected: true, revealed: false, seerResults: [] };
    r.players.set(p.id, p);
    clampSettings(r);
    attach(r, p);
  });

  // sayfa yenilenince / bağlantı kopunca geri dön
  socket.on('rejoin', ({ token, code }) => {
    const r = rooms.get(String(code || '').toUpperCase());
    const p = r && r.players.get(token);
    if (!p) return socket.emit('rejoin-failed');
    attach(r, p);
  });

  socket.on('settings', (s) => {
    if (!room || room.hostId !== player.id || room.phase !== 'lobby') return;
    if (typeof s.vampires === 'number') room.settings.vampires = s.vampires;
    if (typeof s.doctor === 'boolean') room.settings.doctor = s.doctor;
    if (typeof s.seer === 'boolean') room.settings.seer = s.seer;
    if (typeof s.discussionSec === 'number')
      room.settings.discussionSec = Math.max(60, Math.min(900, Math.round(s.discussionSec)));
    clampSettings(room);
    broadcast(room);
  });

  socket.on('start', () => {
    if (!room || room.hostId !== player.id || room.phase !== 'lobby') return;
    const e = validateStart(room);
    if (e) return err(e);
    startGame(room);
  });

  socket.on('night-action', ({ target }) => {
    if (!room || room.phase !== 'night' || !player.alive || room.actions[player.id]) return;
    const t = room.players.get(target);
    if (!t || !t.alive) return;
    if (player.role === 'vampire' && t.role === 'vampire') return err('Vampir arkadaşını seçemezsin.');
    if (player.role === 'seer' && t.id === player.id) return err('Kendine bakamazsın.');
    if (player.role === 'doctor' && t.id === player.lastProtected) return err('Aynı kişiyi üst üste iki gece koruyamazsın.');
    room.actions[player.id] = t.id; // köylülerde sadece "sahte" seçim, etkisi yok
    broadcast(room);
    maybeAdvance(room);
  });

  socket.on('skip-discussion', () => {
    if (!room || room.phase !== 'day' || !player.alive) return;
    room.skipVotes.add(player.id);
    broadcast(room);
    maybeAdvance(room);
  });

  socket.on('vote', ({ target }) => {
    if (!room || room.phase !== 'vote' || !player.alive || room.votes[player.id]) return;
    if (target !== 'skip') {
      const t = room.players.get(target);
      if (!t || !t.alive || t.id === player.id) return;
    }
    room.votes[player.id] = target;
    broadcast(room);
    maybeAdvance(room);
  });

  socket.on('continue', () => {
    if (!room || room.phase !== 'result' || !player.alive) return;
    room.ready.add(player.id);
    broadcast(room);
    maybeAdvance(room);
  });

  socket.on('play-again', () => {
    if (!room || room.hostId !== player.id || room.phase !== 'over') return;
    room.phase = 'lobby';
    room.day = 0;
    room.winner = null;
    room.announcement = null;
    room.event = null;
    room.voteResult = null;
    room.history = [];
    for (const p of room.players.values()) {
      p.role = null;
      p.alive = true;
      p.revealed = false;
      p.seerResults = [];
      p.lastProtected = null;
    }
    clampSettings(room);
    broadcast(room);
  });

  socket.on('leave', () => {
    if (!room || room.phase !== 'lobby') return;
    room.players.delete(player.id);
    if (room.hostId === player.id) {
      const next = [...room.players.values()].find((p) => p.connected) || [...room.players.values()][0];
      room.hostId = next ? next.id : null;
    }
    const r = room;
    room = null;
    player = null;
    if (!r.players.size) rooms.delete(r.code);
    else broadcast(r);
  });

  socket.on('disconnect', () => {
    if (!room || !player) return;
    if (player.socketId === socket.id) {
      player.connected = false;
      player.socketId = null;
    }
    // lobide kopan kişiyi hemen düşürme: telefon ekranı kapanınca da kopar; rejoin ile dönebilir
    broadcast(room);
  });
});

// terk edilmiş odaları temizle
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const anyConnected = [...r.players.values()].some((p) => p.connected);
    if (!anyConnected && now - r.lastActive > 30 * 60 * 1000) {
      clearTimer(r);
      rooms.delete(code);
    }
  }
}, 5 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Vampir Köylü ${PORT} portunda çalışıyor`));
}
module.exports = { server, io, rooms };

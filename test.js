// 6 oyuncuyla uçtan uca oyun simülasyonu
const { io: ioc } = require('socket.io-client');
const { server } = require('./server');
const assert = require('assert');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const names = ['Ali', 'Ayse', 'Can', 'Deniz', 'Ece', 'Fatih'];
  const cl = names.map((name) => {
    const s = ioc(url);
    const c = { name, s, st: null };
    s.on('state', (st) => (c.st = st));
    return c;
  });
  await wait(200);

  cl[0].s.emit('create', { name: 'Ali' });
  await wait(100);
  const code = cl[0].st.code;
  for (const c of cl.slice(1)) c.s.emit('join', { name: c.name, code });
  await wait(200);
  assert.equal(cl[0].st.players.length, 6);
  assert.equal(cl[0].st.settings.vampires, 1);

  // vampir sayısı ayarı: 6 kişide en fazla 2
  cl[0].s.emit('settings', { vampires: 5 });
  await wait(100);
  assert.equal(cl[0].st.settings.vampires, 2);
  cl[1].s.emit('settings', { vampires: 1 }); // kurucu değil, etkisiz
  await wait(100);
  assert.equal(cl[0].st.settings.vampires, 2);
  cl[0].s.emit('settings', { vampires: 1 });
  await wait(100);

  cl[0].s.emit('start');
  await wait(200);
  const roles = cl.map((c) => c.st.me.role);
  assert.equal(roles.filter((r) => r === 'vampire').length, 1);
  assert.equal(roles.filter((r) => r === 'doctor').length, 1);
  assert.equal(roles.filter((r) => r === 'seer').length, 1);
  assert.equal(roles.filter((r) => r === 'villager').length, 3);
  // başkasının rolü sızmıyor
  for (const c of cl) for (const p of c.st.players) if (p.id !== c.st.me.id) assert.equal(p.role, undefined);

  let round = 0;
  while (cl[0].st.phase !== 'over') {
    round++;
    assert(round < 10, 'oyun bitmedi');
    const aliveC = cl.filter((c) => c.st.me.alive);
    const vamp = cl.find((c) => c.st.me.role === 'vampire');
    const victimC = aliveC.find((c) => c.st.me.role !== 'vampire' && c.st.me.role !== 'doctor') || aliveC.find((c) => c.st.me.role !== 'vampire');
    assert.equal(cl[0].st.phase, 'night');
    for (const c of aliveC) {
      const target = c === vamp ? victimC.st.me.id : c.st.me.id === vamp.st.me.id ? victimC.st.me.id : (c.st.me.role === 'seer' ? vamp.st.me.id : victimC.st.me.id === c.st.me.id ? vamp.st.me.id : victimC.st.me.id);
      c.s.emit('night-action', { target });
    }
    await wait(200);
    if (cl[0].st.phase === 'over') break;
    assert.equal(cl[0].st.phase, 'day');
    console.log('sabah:', cl[0].st.announcement);
    const seer = cl.find((c) => c.st.me.role === 'seer');
    if (seer.st.me.alive) assert(seer.st.me.seerResults.length >= 1);
    // çoğunluk oylamaya geçmek ister
    for (const c of cl.filter((c) => c.st.me.alive)) c.s.emit('skip-discussion');
    await wait(150);
    assert.equal(cl[0].st.phase, 'vote');
    const alive2 = cl.filter((c) => c.st.me.alive);
    for (const c of alive2) c.s.emit('vote', { target: c === vamp ? alive2.find((x) => x !== vamp).st.me.id : vamp.st.me.id });
    await wait(200);
    console.log('oylama:', cl[0].st.announcement);
  }
  assert.equal(cl[0].st.phase, 'over');
  console.log('kazanan:', cl[0].st.winner);
  assert.equal(cl[0].st.winner, 'village');
  assert(cl[0].st.players.every((p) => p.role)); // bitişte herkesin rolü açık

  cl[0].s.emit('play-again');
  await wait(150);
  assert.equal(cl[0].st.phase, 'lobby');

  // 2 vampirle başlat
  cl[0].s.emit('settings', { vampires: 2 });
  await wait(100);
  cl[0].s.emit('start');
  await wait(150);
  assert.equal(cl.filter((c) => c.st.me.role === 'vampire').length, 2);
  const v = cl.filter((c) => c.st.me.role === 'vampire')[0];
  assert.equal(v.st.players.filter((p) => p.role === 'vampire').length, 2); // vampirler birbirini görür

  console.log('TÜM TESTLER GEÇTİ');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

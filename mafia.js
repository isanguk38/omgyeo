'use strict';
/* 마피아 게임 — 서버가 사회자
 * 방마다 게임 하나. 역할 배정, 밤(마피아·의사·경찰 행동) → 아침 발표 → 낮 투표 → 처형 → 승패 판정을 서버가 진행합니다.
 * 역할은 본인에게만 보내고, 모든 행동은 서버가 검사합니다(화면에서 조작해도 규칙을 어길 수 없음).
 * 게임 정보는 서버 메모리에만 있고, 게임이 끝나거나 방이 비면 사라집니다.
 */
const crypto = require('crypto');

const NIGHT_MS = 40000;          // 밤: 마피아·의사·경찰이 고르는 시간
const DAY_MS = 120000;           // 낮: 토론과 투표 시간
const RESULT_MS = 4000;          // 발표 뒤 다음 단계까지 잠깐 쉼
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 16;
const ROLE_NAME = { mafia: '마피아', doctor: '의사', police: '경찰', citizen: '시민' };

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function rolesFor(n) {
  const mafia = n >= 9 ? 3 : n >= 6 ? 2 : 1;
  const r = Array(mafia).fill('mafia');
  r.push('doctor', 'police');
  while (r.length < n) r.push('citizen');
  return shuffle(r);
}

module.exports = function createMafia(sendJSON) {
  const out = (ws, obj) => sendJSON(ws, { type: 'mafia', ...obj });
  const everyone = (g, obj) => { for (const ws of g.room.peers.values()) out(ws, obj); };
  const say = (g, text, tone = 'info') => everyone(g, { ev: 'say', text, tone });
  const living = g => [...g.players.values()].filter(p => p.alive);
  const nameOf = (g, id) => (g.players.get(id) || {}).name || '?';

  // 사람마다 보이는 게임 화면 (내 역할, 마피아는 동료, 끝나면 모두의 역할)
  function view(g, id) {
    const me = g.players.get(id);
    const over = g.phase === 'over';
    const mateView = me && me.role === 'mafia';
    const tally = {};
    if (g.phase === 'day') for (const t of g.votes.values()) if (t) tally[t] = (tally[t] || 0) + 1;
    return {
      ev: 'state', phase: g.phase, day: g.day, deadline: g.deadline, starter: g.starter, winner: g.winner || null,
      players: g.order.map(pid => {
        const p = g.players.get(pid);
        // 끝났거나, 나 자신이거나, 내가 마피아이고 상대도 마피아면 진짜 역할. 처형된 사람은 마피아였는지만 공개
        const known = over || pid === id || (mateView && p.role === 'mafia');
        return { id: pid, name: p.name, alive: p.alive, left: !!p.left, role: known ? p.role : p.revealed || null, votes: tally[pid] || 0 };
      }),
      you: me ? { role: me.role, alive: me.alive } : null,
      pick: me ? (g.phase === 'night' ? g.acts.get(id) || null : g.phase === 'day' ? (g.votes.has(id) ? g.votes.get(id) : undefined) : null) : null,
      mafiaPicks: mateView && g.phase === 'night' ? [...g.acts].filter(([pid]) => g.players.get(pid).role === 'mafia').map(([pid, t]) => ({ by: nameOf(g, pid), target: t })) : [],
      checked: me && me.role === 'police' ? g.checked : undefined,
    };
  }
  const push = g => { for (const ws of g.room.peers.values()) out(ws, view(g, ws.id)); };
  const setTimer = (g, ms, fn) => { clearTimeout(g.timer); g.deadline = Date.now() + ms; g.timer = setTimeout(fn, ms); };

  function start(room, ws) {
    if (room.game && room.game.phase !== 'over') return out(ws, { ev: 'error', text: '이미 게임이 진행 중이에요.' });
    const peers = [...room.peers.values()];
    if (peers.length < MIN_PLAYERS) return out(ws, { ev: 'error', text: `마피아 게임은 ${MIN_PLAYERS}명 이상이어야 해요. 지금 연결된 기기는 ${peers.length}대예요.` });
    if (peers.length > MAX_PLAYERS) return out(ws, { ev: 'error', text: `마피아 게임은 ${MAX_PLAYERS}명까지 할 수 있어요.` });
    if (room.game) clearTimeout(room.game.timer);
    const roles = rolesFor(peers.length);
    const g = room.game = { room, players: new Map(), order: [], phase: 'night', day: 1, deadline: 0, timer: null, acts: new Map(), votes: new Map(), starter: ws.name, checked: [] };
    peers.forEach((p, i) => { g.players.set(p.id, { id: p.id, name: p.name, role: roles[i], alive: true, ws: p }); g.order.push(p.id); });
    const n = roles.filter(r => r === 'mafia').length;
    say(g, `${ws.name}님이 마피아 게임을 시작했어요. 참가자 ${peers.length}명 · 마피아 ${n}명 · 의사 1명 · 경찰 1명`, 'start');
    for (const p of g.players.values()) {
      const mates = p.role === 'mafia' ? [...g.players.values()].filter(q => q.role === 'mafia' && q !== p).map(q => q.name) : [];
      out(p.ws, { ev: 'secret', text: `당신은 ${ROLE_NAME[p.role]}입니다.${mates.length ? ` 동료 마피아: ${mates.join(', ')}` : ''}` });
    }
    night(g);
  }

  function night(g) {
    g.phase = 'night'; g.acts.clear(); g.votes.clear();
    say(g, `${g.day}일째 밤이 되었습니다. 모두 눈을 감아 주세요. 마피아는 없앨 사람을, 의사는 살릴 사람을, 경찰은 조사할 사람을 골라 주세요.`, 'night');
    setTimer(g, NIGHT_MS, () => dawn(g));
    push(g);
  }
  const nightActors = g => living(g).filter(p => p.role !== 'citizen');
  function maybeEndNight(g) {
    if (nightActors(g).every(p => g.acts.has(p.id))) { clearTimeout(g.timer); dawn(g); }
  }

  function dawn(g) {
    if (g.phase !== 'night') return;
    // 마피아가 고른 대상: 가장 많이 고른 사람 (같으면 그중 무작위)
    const counts = new Map();
    for (const [pid, t] of g.acts) {
      const p = g.players.get(pid);
      if (p && p.alive && p.role === 'mafia' && t) counts.set(t, (counts.get(t) || 0) + 1);
    }
    let target = null;
    if (counts.size) {
      const max = Math.max(...counts.values());
      const top = [...counts].filter(([, c]) => c === max).map(([t]) => t);
      target = top[crypto.randomInt(0, top.length)];
    }
    const doctor = living(g).find(p => p.role === 'doctor');
    const saved = doctor ? g.acts.get(doctor.id) : null;
    const police = living(g).find(p => p.role === 'police');
    const checkT = police ? g.acts.get(police.id) : null;
    if (police && checkT && g.players.get(checkT)) {
      const isMafia = g.players.get(checkT).role === 'mafia';
      g.checked.push({ id: checkT, mafia: isMafia });
      out(police.ws, { ev: 'secret', text: `조사 결과: ${nameOf(g, checkT)}님은 ${isMafia ? '마피아입니다.' : '마피아가 아닙니다.'}` });
    }
    g.phase = 'morning';
    if (target && target !== saved) {
      g.players.get(target).alive = false;
      say(g, `아침이 밝았습니다. 지난밤 ${nameOf(g, target)}님이 마피아에게 당했습니다.`, 'day');
    } else if (target) say(g, '아침이 밝았습니다. 지난밤 마피아가 누군가를 노렸지만, 의사가 살려 냈습니다.', 'day');
    else say(g, '아침이 밝았습니다. 지난밤에는 아무 일도 없었습니다.', 'day');
    if (checkWin(g)) return;
    g.phase = 'day'; g.votes.clear();
    say(g, `토론한 뒤 마피아로 의심되는 사람에게 투표해 주세요. 제한 시간 ${DAY_MS / 60000}분.`, 'day');
    setTimer(g, DAY_MS, () => execute(g));
    push(g);
  }

  function execute(g) {
    if (g.phase !== 'day') return;
    const counts = new Map();
    for (const [pid, t] of g.votes) if (t && g.players.get(pid).alive) counts.set(t, (counts.get(t) || 0) + 1);
    let target = null;
    if (counts.size) {
      const max = Math.max(...counts.values());
      const top = [...counts].filter(([, c]) => c === max);
      if (top.length === 1) target = top[0][0];
    }
    g.phase = 'result';
    if (target) {
      const p = g.players.get(target);
      p.alive = false;
      p.revealed = p.role === 'mafia' ? 'mafia' : 'citizen';
      say(g, `투표 결과 ${p.name}님이 처형되었습니다. ${p.name}님은 ${p.role === 'mafia' ? '마피아였습니다!' : '마피아가 아니었습니다.'}`, p.role === 'mafia' ? 'good' : 'bad');
    } else say(g, counts.size ? '투표가 동점이라 아무도 처형되지 않았습니다.' : '아무도 투표하지 않아 처형이 없습니다.', 'info');
    push(g);
    if (checkWin(g)) return;
    g.day++;
    setTimer(g, RESULT_MS, () => night(g));
  }

  function checkWin(g) {
    const alive = living(g);
    const mafia = alive.filter(p => p.role === 'mafia').length;
    let winner = null;
    if (mafia === 0) winner = 'citizen';
    else if (mafia >= alive.length - mafia) winner = 'mafia';
    if (!winner) return false;
    clearTimeout(g.timer);
    g.phase = 'over'; g.winner = winner; g.deadline = 0;
    const roles = g.order.map(id => `${nameOf(g, id)}(${ROLE_NAME[g.players.get(id).role]})`).join(', ');
    say(g, `${winner === 'mafia' ? '마피아' : '시민'} 팀이 이겼습니다! 역할 공개: ${roles}`, 'end');
    push(g);
    return true;
  }

  function act(g, ws, target) {
    const me = g.players.get(ws.id);
    const t = g.players.get(target);
    if (!me || !me.alive || !t || !t.alive) return;
    if (g.phase === 'night') {
      if (me.role === 'citizen') return;
      if (me.role === 'mafia' && t.role === 'mafia') return out(ws, { ev: 'error', text: '동료 마피아는 고를 수 없어요.' });
      if (me.role === 'police' && t.id === me.id) return;
      g.acts.set(me.id, t.id);
      push(g);
      maybeEndNight(g);
    } else if (g.phase === 'day') {
      if (t.id === me.id) return out(ws, { ev: 'error', text: '자기 자신에게는 투표할 수 없어요.' });
      g.votes.set(me.id, t.id);
      push(g);
      if (living(g).every(p => g.votes.has(p.id))) { clearTimeout(g.timer); execute(g); }
    }
  }
  function abstain(g, ws) {
    const me = g.players.get(ws.id);
    if (!me || !me.alive || g.phase !== 'day') return;
    g.votes.set(me.id, null);
    push(g);
    if (living(g).every(p => g.votes.has(p.id))) { clearTimeout(g.timer); execute(g); }
  }

  return {
    onMsg(room, ws, m) {
      if (!room) return;
      const g = room.game;
      switch (m.op) {
        case 'start': return start(room, ws);
        case 'act': if (g) act(g, ws, String(m.target || '')); return;
        case 'abstain': if (g) abstain(g, ws); return;
        case 'chat': {   // 밤에 마피아끼리만 보는 대화
          const me = g && g.players.get(ws.id);
          if (!me || !me.alive || me.role !== 'mafia' || g.phase !== 'night') return;
          const text = String(m.text || '').slice(0, 300);
          if (!text.trim()) return;
          for (const p of living(g)) if (p.role === 'mafia') out(p.ws, { ev: 'mchat', from: me.name, text });
          return;
        }
        case 'stop':
          if (!g || g.phase === 'over') { if (g) { room.game = null; everyone(g, { ev: 'closed' }); } return; }
          clearTimeout(g.timer);
          g.phase = 'over'; g.winner = null; g.deadline = 0;
          say(g, `${ws.name}님이 게임을 중단했습니다. 역할 공개: ${g.order.map(id => `${nameOf(g, id)}(${ROLE_NAME[g.players.get(id).role]})`).join(', ')}`, 'end');
          push(g);
          return;
      }
    },
    // 게임 중에 들어온 기기는 구경만 (지금 상황을 보여 줌)
    onJoin(room, ws) {
      const g = room.game;
      if (!g) return;
      out(ws, view(g, ws.id));
      if (g.phase !== 'over') out(ws, { ev: 'say', text: '마피아 게임이 진행 중이에요. 이번 판은 구경만 할 수 있어요.', tone: 'info' });
    },
    onLeave(room, ws) {
      const g = room.game;
      if (!g) return;
      const p = g.players.get(ws.id);
      if (!p || !p.alive || g.phase === 'over') return;
      p.alive = false; p.left = true;
      g.acts.delete(p.id); g.votes.delete(p.id);
      say(g, `${p.name}님이 연결을 끊어서 게임에서 빠졌습니다.`, 'info');
      if (checkWin(g)) return;
      push(g);
      if (g.phase === 'night') maybeEndNight(g);
      if (g.phase === 'day' && living(g).every(q => g.votes.has(q.id))) { clearTimeout(g.timer); execute(g); }
    },
    stop(room) { if (room.game) { clearTimeout(room.game.timer); room.game = null; } },
  };
};

'use strict';
/* 마피아 게임 화면
 * 진행(역할 배정, 밤·낮, 판정)은 서버가 사회자로 맡고, 여기서는 서버가 보내 준 상황을 그리고 고른 것을 보냅니다.
 * 사회자의 말은 대화 목록 가운데에 안내로 올라오며, 기록에는 저장하지 않습니다.
 */
const Mafia = { g: null, mlog: [], tick: null, notes: [] };
const M_ROLE = {
  mafia: { name: '마피아', tip: '밤마다 동료와 함께 없앨 사람을 고르세요. 낮에는 들키지 않게 시민인 척하세요.' },
  doctor: { name: '의사', tip: '밤마다 살릴 사람 한 명을 고르세요. 자신도 고를 수 있어요.' },
  police: { name: '경찰', tip: '밤마다 한 명을 조사해서 마피아인지 알아낼 수 있어요.' },
  citizen: { name: '시민', tip: '밤에는 할 일이 없어요. 낮에 대화로 마피아를 찾아 투표하세요.' },
};
const M_ACT = { mafia: '없앨 사람', doctor: '살릴 사람', police: '조사할 사람' };
const mSend = obj => sendServer({ type: 'mafia', ...obj });

Mafia.onServer = m => {
  switch (m.ev) {
    case 'state': Mafia.g = m; if (m.phase !== 'night') Mafia.mlog = []; mRender(); break;
    case 'say':
      if (m.tone === 'start') Mafia.notes = [];
      mNotice(m.text, m.tone);
      if (['start', 'night', 'end'].includes(m.tone)) announce('마피아 게임', m.text.slice(0, 90));
      break;
    case 'secret': mNotice(m.text, 'secret'); break;
    case 'mchat': Mafia.mlog.push({ from: m.from, text: m.text }); mRender(); break;
    case 'error': toast(m.text, 3500); break;
    case 'closed': Mafia.reset(); break;
  }
};
// 방을 나가거나 다른 방으로 가면 게임 화면을 치움
Mafia.reset = () => { Mafia.g = null; Mafia.mlog = []; Mafia.notes = []; mRender(); };
// 대화 기록을 다시 그리면(이전 기록 불러오기 등) 목록이 비워지므로, 이번 게임의 안내를 다시 붙임
Mafia.replayNotes = () => { for (const n of Mafia.notes) mNotice(n.text, n.tone, n.time); };
// 기록 지우기: 그 시각까지의 사회자 안내를 화면과 기억에서 지움
Mafia.clearNotes = until => {
  Mafia.notes = Mafia.notes.filter(n => n.time > until);
  for (const li of feedBox().querySelectorAll('.narr')) if (Number(li.dataset.t) <= until) li.remove();
  if (!feedBox().querySelector('li:not(.day):not(.more)')) $('#feedEmpty').hidden = false;
};

// 사회자 안내: 대화 목록 가운데에 한 줄 (저장하지 않음)
// replay: 다시 붙일 때 원래 시각 (없으면 새 안내)
function mNotice(text, tone, replay) {
  const time = replay || Date.now();
  if (!replay) Mafia.notes.push({ text, tone, time });
  const box = feedBox();
  const wasBottom = nearBottom();
  const li = document.createElement('li');
  li.className = `narr ${tone || 'info'}`;
  li.dataset.t = time;
  li.innerHTML = `<span class="narr-who">${tone === 'secret' ? '사회자 · 나에게만' : '사회자'}</span><span class="narr-txt"></span>`;
  li.querySelector('.narr-txt').textContent = text;
  box.appendChild(li);
  $('#feedEmpty').hidden = true;
  if (replay) return;
  if (wasBottom) nextFrame(scrollBottom); else $('#newMsg').hidden = false;
}

const mMe = () => Mafia.g && Mafia.g.players.find(p => p.id === S.id);
function mCanPick(p) {
  const g = Mafia.g, you = g.you;
  if (!you || !you.alive || !p.alive) return false;
  if (g.phase === 'night') {
    if (you.role === 'citizen') return false;
    if (you.role === 'mafia' && p.role === 'mafia') return false;
    if (you.role === 'police' && p.id === S.id) return false;
    return true;
  }
  if (g.phase === 'day') return p.id !== S.id;
  return false;
}
function mClock() {
  const g = Mafia.g;
  const el = $('#mafiaClock');
  if (!el) return;
  if (!g || !g.deadline || g.phase === 'over') { el.textContent = ''; return; }
  const s = Math.max(0, Math.ceil((g.deadline - Date.now()) / 1000));
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function mRender() {
  const box = $('#mafiaBox');
  const g = Mafia.g;
  $('#mafiaBtn').textContent = g && g.phase !== 'over' ? '마피아 게임 진행 중' : '마피아 게임';
  if (!g) { box.hidden = true; clearInterval(Mafia.tick); Mafia.tick = null; return; }
  box.hidden = false;
  const you = g.you;
  const phase = { intro: `${g.day}일째 낮 · 인사 시간`, night: `${g.day}일째 밤`, morning: `${g.day}일째 아침`, day: `${g.day}일째 낮 · 토론과 투표`, result: '투표 결과', over: '게임 끝' }[g.phase] || '';
  box.className = `mf-box ${g.phase}`;

  // 나의 역할과 지금 할 일
  let role = '', todo = '';
  if (!you) role = '<b>구경 중</b> · 이번 판에는 참가하지 않았어요.';
  else {
    role = `나는 <b class="mf-role ${you.role}">${M_ROLE[you.role].name}</b>${you.alive ? '' : ' · <span class="mf-dead">탈락</span>'}`;
    if (g.phase === 'over') todo = g.winner ? `${g.winner === 'mafia' ? '마피아' : '시민'} 팀 승리${(g.winner === 'mafia') === (you.role === 'mafia') ? ' · 이겼어요!' : ''}` : '게임이 중단됐어요.';
    else if (!you.alive) todo = '탈락했어요. 끝날 때까지 구경할 수 있어요.';
    else if (g.phase === 'intro') todo = `대화로 서로 인사를 나누세요. 첫날은 투표 없이 밤이 돼요.${g.ready ? ` (준비 ${g.ready.n}/${g.ready.of})` : ''}`;
    else if (g.phase === 'night') todo = you.role === 'citizen' ? '밤에는 할 일이 없어요. 아침을 기다리세요.' : `${M_ACT[you.role]}을 고르세요.${g.pick ? ` 고른 사람: <b>${esc((g.players.find(p => p.id === g.pick) || {}).name)}</b>` : ''}`;
    else if (g.phase === 'day') todo = g.pick === undefined ? '대화로 토론하고 마피아로 의심되는 사람에게 투표하세요.' : g.pick === null ? '기권했어요. 다른 사람을 눌러 바꿀 수 있어요.' : `<b>${esc((g.players.find(p => p.id === g.pick) || {}).name)}</b>에게 투표했어요. 바꿀 수 있어요.`;
    else todo = '잠시 뒤 다음 순서로 넘어가요.';
  }
  const tip = you && g.phase !== 'over' ? `<small class="mf-tip">${M_ROLE[you.role].tip}</small>` : '';

  // 참가자 (누르면 고르기·투표)
  const checked = new Map((g.checked || []).map(c => [c.id, c.mafia]));
  const players = g.players.map(p => {
    const can = mCanPick(p);
    const picked = g.pick === p.id;
    const badge = p.role && (p.id !== S.id || g.phase === 'over') ? `<span class="mf-badge ${p.role}">${M_ROLE[p.role].name}</span>` : '';
    const chk = checked.has(p.id) ? `<span class="mf-badge ${checked.get(p.id) ? 'mafia' : 'citizen'}">조사: ${checked.get(p.id) ? '마피아' : '아님'}</span>` : '';
    const votes = g.phase === 'day' && p.votes ? `<span class="mf-votes">${p.votes}표</span>` : '';
    return `<button type="button" class="mf-p${p.alive ? '' : ' dead'}${picked ? ' picked' : ''}${p.id === S.id ? ' me' : ''}" data-mf="${esc(p.id)}" ${can ? '' : 'disabled'}>
      <span class="mf-name">${esc(p.name)}${p.id === S.id ? ' (나)' : ''}</span>${badge}${chk}${votes}${p.alive ? '' : `<span class="mf-out">${p.left ? '나감' : '탈락'}</span>`}</button>`;
  }).join('');

  // 마피아끼리: 동료가 고른 사람과 밤 대화
  let mafiaSide = '';
  if (you && you.role === 'mafia' && you.alive && g.phase === 'night') {
    const picks = g.mafiaPicks.map(x => `${esc(x.by)} → ${esc((g.players.find(p => p.id === x.target) || {}).name || '?')}`).join(' · ');
    const log = Mafia.mlog.map(x => `<li><b>${esc(x.from)}</b> ${esc(x.text)}</li>`).join('');
    mafiaSide = `<div class="mf-secret"><small>마피아끼리만 보여요${picks ? ` · 고른 사람: ${picks}` : ''}</small>
      ${log ? `<ul class="mf-log">${log}</ul>` : ''}
      <form class="mf-chat" id="mafiaChat"><input id="mafiaChatInput" maxlength="300" placeholder="동료에게만 보내기" aria-label="마피아끼리 대화" autocomplete="off"><button type="submit">보내기</button></form></div>`;
  }

  const ctl = g.phase === 'over'
    ? '<button type="button" class="solid" data-mfa="again">다시 하기</button><button type="button" data-mfa="close">닫기</button>'
    : `${you && you.alive && g.phase === 'intro' ? (g.ready && g.ready.me ? '<button type="button" disabled>준비 완료 · 다른 사람을 기다려요</button>' : '<button type="button" class="solid" data-mfa="ready">준비 완료 · 밤으로</button>') : ''}${you && you.alive && g.phase === 'day' ? '<button type="button" data-mfa="abstain">기권</button>' : ''}<button type="button" class="link muted" data-mfa="stop">게임 중단</button>`;

  // 입력 중인 마피아 대화는 다시 그려도 지워지지 않게
  const draft = $('#mafiaChatInput') ? $('#mafiaChatInput').value : '';
  const focused = document.activeElement && document.activeElement.id === 'mafiaChatInput';
  box.innerHTML = `<div class="mf-head"><span class="mf-phase">${phase}</span><span class="mf-clock" id="mafiaClock"></span></div>
    <div class="mf-me"><span>${role}</span><span class="mf-todo">${todo}</span>${tip}</div>
    <div class="mf-players">${players}</div>
    ${mafiaSide}
    <div class="mf-ctl">${ctl}</div>`;
  if ($('#mafiaChatInput')) { $('#mafiaChatInput').value = draft; if (focused) $('#mafiaChatInput').focus(); }
  mClock();
  if (!Mafia.tick) Mafia.tick = setInterval(mClock, 1000);
}

$('#mafiaBtn').onclick = () => {
  const g = Mafia.g;
  selectTab('chat');
  if (g && g.phase !== 'over') { $('#mafiaBox').scrollIntoView({ block: 'nearest' }); return; }
  mSend({ op: 'start' });
};
$('#mafiaBox').addEventListener('click', e => {
  const p = e.target.closest('[data-mf]');
  if (p && !p.disabled) return mSend({ op: 'act', target: p.dataset.mf });
  const b = e.target.closest('[data-mfa]');
  if (!b) return;
  switch (b.dataset.mfa) {
    case 'abstain': return mSend({ op: 'abstain' });
    case 'ready': return mSend({ op: 'ready' });
    case 'again': return mSend({ op: 'start' });
    case 'close': return mSend({ op: 'stop' });
    case 'stop': if (confirm('게임을 중단할까요? 모두의 역할이 공개돼요.')) mSend({ op: 'stop' }); return;
  }
});
$('#mafiaBox').addEventListener('submit', e => {
  if (e.target.id !== 'mafiaChat') return;
  e.preventDefault();
  const input = $('#mafiaChatInput');
  const text = input.value.trim();
  if (!text) return;
  mSend({ op: 'chat', text });
  input.value = '';
});

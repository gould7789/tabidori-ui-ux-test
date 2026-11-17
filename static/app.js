/* 타비도리 일정 화면 클라이언트 — 입력 → 검증 → 결과를 한 화면의 상태로 바꾼다(UI/UX 설계노트 6-21절).
   - stage: 'input'(스팟 담기) → 'verifying'(검증 연출) → 'result'(패턴 비교·편집·확정)
   - 일정 계산(도착시각·마감 위반·종료 예상)과 다른 순서 패턴 계산은 서버(/api/verify, /api/schedule)가 한다.
   - 지도는 Google Maps JavaScript API(AdvancedMarkerElement + Polyline).
   - 큐레이션 그리드와 채팅 응답은 htmx로 서버 조각을 받아 끼운다. */
'use strict';

const BOOT = JSON.parse(document.getElementById('boot').textContent);
const SPOTS = BOOT.spots;
const MODE_LABEL = BOOT.modeLabel, MODE_ICON = BOOT.modeIcon;
const BADGES = BOOT.badges;
const SRC_LABEL = { routes_api: '실측', fallback: '고정값', estimate: '추정' };   // 구간 이동시간 출처(설계노트 13-3)
const isLive = (t) => t && t.source === 'routes_api';
const ROUTE_COLOR = '#233D6B';   // 藍 700 — 경로선
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pairKey = (a, b) => [a, b].sort().join('|');
const leg = (a, b, mode) => BOOT.travel[pairKey(a, b)][mode];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 한국어 조사: 마지막 글자에 받침이 있으면 a(을/은), 없으면 b(를/는)
const josa = (w, a, b) => { const c = String(w).charCodeAt(String(w).length - 1); return w + ((c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28) ? a : b); };
const DOW_PY = ['월', '화', '수', '목', '금', '토', '일'];   // 서버의 Python weekday(월=0) 기준
function violText(v) {
  if (!v) return '';
  switch (v.type) {
    case 'tempClosed': return `🔴 임시 휴관 — 임시휴무 확인 결과${v.quote ? ` 「${v.quote}」` : ''}`;
    case 'closedDay': return `${DOW_PY[v.dow]}요일 정기 휴무`;
    case 'partialClosed': return `🟠 일부 휴관 — 보고 싶은 곳이 닫혔는지 확인이 필요해요${v.quote ? ` 「${v.quote}」` : ''}`;
    case 'closeAfter': return `마감(${v.close})보다 ${v.over_by}분 늦게 도착`;
    case 'rainOutdoor': return `☔ ${v.hour}시 강수확률 ${v.prob}% — 실외 스팟`;
    case 'overTime': return `마감 시각 ${v.limit}보다 ${v.over_by}분 늦게 끝나요(종료 예상 ${v.end})`;
  }
  return '제약 위반';
}
function violShort(v) {
  return { tempClosed: '임시 휴관', closedDay: `${DOW_PY[v.dow]}요일 휴무`, partialClosed: '일부 휴관',
    closeAfter: '마감 후 도착', rainOutdoor: `☔ 비 ${v.prob}%` }[v.type] || '위반';
}
// 확정 확인창에서 위반 종류마다 다르게 붙이는 한 줄(설계노트 17-6: 사용자가 알고도 갈 수 있다)
function violHint(v) {
  return { tempClosed: '외관만 보러 가는 경우 등이라면 그대로 둬도 돼요.', closedDay: '외관만 보러 가는 경우 등이라면 그대로 둬도 돼요.',
    closeAfter: '외관만 보러 가는 경우 등이라면 그대로 둬도 돼요.', partialClosed: '보고 싶은 곳이 닫힌 구역인지 공식 공지를 확인해 보세요.',
    rainOutdoor: '우산을 챙기거나 실내 스팟과 순서를 바꿔 보세요.', overTime: '마감 시각을 늦추거나 스팟을 줄여 보세요.' }[v.type] || '';
}
// 일정 전체 위반(마감 시각 초과)까지 포함한 목록 — [id 또는 null, 위반]
function allViolations(s) {
  const v = Object.entries(s.violations);
  if (s.over_time) v.push([null, s.over_time]);
  return v;
}
const kindIcon = (id, cls = 'tc-kind') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#k-${SPOTS[id].kind || 'street'}"/></svg>`;

/* ===================== 상태 ===================== */
let stage = 'input';
let tray = [];                // 입력 상태: 담은 스팟 순서
let patterns = null;          // 결과 상태: key -> {label, order, modes}
let schedules = {};           // key -> 서버 계산 결과
let active = 'mine';
let dwell = {};               // 체류시간은 패턴 공통
let selected = null;
let undoStack = [];           // 되돌리기 — 1단계(개발설계노트 9-9·9-11: 서버 plans.undo_snapshot 한 칸과 같은 규칙). 되돌린 뒤·단계가 바뀌면 비움
let addedCount = 0;
let reveal = null;            // 검증 연출 중: {seg} = 시각이 드러난 구간 수
let skipReveal = false;
let advisedOnce = false;      // 검증 직후 어드바이저 코멘트는 1회(설계노트 17-9절)
let justAdded = null;         // 방금 담은 스팟 — 카드를 잠깐 강조
let popPin = null;            // 방금 담은 스팟 — 지도 핀에 스프링 한 번(동작 기준표)
let lastVerified = null;
let allowedModes = ['walk', 'transit'];   // 쓸 수 있는 이동수단(11/17 현우: 여러 개 선택, 기본 도보+전철)
let weatherStatus = null;     // 비 판정 상태: ok | too_far | error | nodate
let verifyMemo = {};          // 서버 메모: removed(순서로 안 풀려 뺀 스팟) · alt_skipped(스팟이 많아 대안 계산 생략)
let recommendWarned = false;  // 권장 개수(6곳) 안내는 한 번만
let cmSession = [];           // 큐레이션 모달을 연 동안 담은 스팟 — 닫을 때 채팅에 한 번에 알린다

/* ---------- 쓸 수 있는 이동수단(입력 상태 필터) ---------- */
function renderModeChips() {
  const box = $('modeChips');
  box.innerHTML = '<span class="mc-label">이동</span>' + ['walk', 'bike', 'transit', 'car'].map(m =>
    `<button type="button" class="modechip" data-mode="${m}" aria-pressed="${allowedModes.includes(m)}">${MODE_ICON[m]} ${MODE_LABEL[m]}</button>`).join('');
  box.querySelectorAll('.modechip').forEach(b => b.onclick = () => {
    const m = b.dataset.mode;
    if (allowedModes.includes(m)) {
      if (allowedModes.length === 1) { toast('이동수단은 하나 이상 골라야 해요'); return; }
      allowedModes = allowedModes.filter(x => x !== m);
    } else {
      allowedModes = ['walk', 'bike', 'transit', 'car'].filter(x => x === m || allowedModes.includes(x));
    }
    renderModeChips();
    onConditionChange(true);
  });
}

function setStage(s) { stage = s; document.body.dataset.stage = s; if (typeof syncUndo === 'function') syncUndo(); }
function startTime() { return $('startInput').value || BOOT.trip.start; }
function endTime() { return $('endInput').value || ''; }      // 마감 시각(선택) — 비어 있으면 총 소요시간 판정 안 함
// 날짜가 비면 기본값으로 몰래 채우지 않는다 — 휴무 판정도 하지 않는다(설계노트 16-1, 11/17 점검 #2)
function tripDate() { return $('dateInput').value || ''; }
function dateProblem() {
  const d = tripDate();
  if (!d) return '날짜를 먼저 선택해주세요';
  if (d < BOOT.today) return '지난 날짜는 검증할 수 없어요';
  return '';
}
// 고른 날짜가 그 스팟의 정기 휴무일인지(입력 단계 표시용. 판정은 검증 때 서버가 다시 한다)
function closedOnDate(id, date = tripDate()) {
  if (!date) return false;
  const js = new Date(date + 'T00:00').getDay();             // 일=0
  return (SPOTS[id].closed_dow || []).includes((js + 6) % 7); // → 월=0
}
function dateLabel(v = tripDate()) {
  if (!v) return '날짜 미정';
  const d = new Date(v + 'T00:00');
  return `${d.getMonth() + 1}월 ${d.getDate()}일(${'일월화수목금토'[d.getDay()]})`;
}
const dowOf = (v = tripDate()) => v ? '일월화수목금토'[new Date(v + 'T00:00').getDay()] : '';

/* ---------- 임시휴무 확인(Loop A) — 시연용. 담을 때·[지금 확인]·검증 직전에 서버에 묻는다 ---------- */
// 상태: pending(⏳ 확인 중) · done(배지) · later(날짜를 바꿔서 아직 안 함 → 검증할 때 확인) · nodate(날짜 없음)
const loopa = {};             // `${id}|${date}` → {status, res, promise}
const LOOPA_TIMEOUT_MS = 90000;
function loopaState(id) {
  const d = tripDate();
  if (!d || d < BOOT.today) return { status: 'nodate' };
  return loopa[`${id}|${d}`] || { status: 'later' };
}
function checkLoopa(id, force = false) {
  const date = tripDate();
  if (!date || date < BOOT.today) return Promise.resolve();
  const k = `${id}|${date}`, cur = loopa[k];
  if (cur && !force && (cur.status === 'pending' || (cur.status === 'done' && cur.res.badge !== 'gray'))) return cur.promise;
  const promise = fetch('/api/loopa', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spot: id, date, force }),
  }).then(r => r.ok ? r.json() : Promise.reject(new Error('loopa ' + r.status)))
    .then(res => { loopa[k] = { status: 'done', res, promise }; onLoopaDone(id, date, res); })
    .catch(e => { console.error(e); loopa[k] = { status: 'done', res: grayResult('서버에 연결하지 못했어요'), promise }; })
    .finally(() => { if (stage === 'input') render(); });   // 카드 배지·핀 ⚠·팝오버 출처를 함께 갱신
  loopa[k] = { status: 'pending', promise };
  if (stage === 'input') renderTray();
  return promise;
}
function grayResult(note) { return { kind: 'unknown', path: 'search', badge: 'gray', quote: '', url: '', note, badge_info: BADGES.gray }; }
function onLoopaDone(id, date, res) {
  if (stage !== 'input' || date !== tripDate() || !tray.includes(id)) return;
  const nm = esc(SPOTS[id].name);
  // 판정이 바뀌는 결과만 채팅에 알린다(정해진 문장 — LLM이 쓰지 않음)
  if (res.badge === 'red' || res.badge === 'orange') {
    openPanel();
    appendAdvisor(`<b>${nm}</b> — 임시휴무 확인 결과 ${dateLabel(date)}에 <b>${res.badge === 'red' ? '🔴 휴관' : '🟠 일부 휴관'}</b>이에요. 담아둔 채로 두면 검증에서 위반으로 표시돼요. <i>(${esc(res.note)})</i>`);
  } else if (res.badge === 'blue') {
    appendAdvisor(`<b>${nm}</b> — ${dateLabel(date)}에 <b>🔵 특별 개관</b>이 있어요${res.close_override ? ` (마감 ${res.close_override}까지)` : ''}. 공식 페이지에서 확인된 내용이라 검증에 반영해요. <i>(${esc(res.note)})</i>`);
  }
}
// 검증 직전: 담은 스팟의 확인이 모두 끝날 때까지 기다린다(⚪는 다시 확인). 90초가 넘으면 ⚪로 보고 진행
async function waitLoopa(ids) {
  const date = tripDate();
  const jobs = ids.map(id => {
    const st = loopa[`${id}|${date}`];
    return (st && st.status === 'done' && st.res.badge !== 'gray') ? null : checkLoopa(id, !!st && st.status === 'done');
  }).filter(Boolean);
  if (!jobs.length) return;
  const update = () => {
    const left = ids.filter(id => (loopa[`${id}|${date}`] || {}).status === 'pending').length;
    $('verifyText').textContent = `⏳ 임시휴무 확인을 기다리는 중 — ${ids.length - left}/${ids.length}곳 끝남`;
    return left;
  };
  update();
  const timer = setInterval(update, 300);
  await Promise.race([Promise.allSettled(jobs), sleep(LOOPA_TIMEOUT_MS)]);
  clearInterval(timer);
  ids.forEach(id => { const k = `${id}|${date}`; if (loopa[k] && loopa[k].status === 'pending') loopa[k] = { status: 'done', res: grayResult('90초 안에 확인하지 못했어요') }; });
}
function loopaRes(id) { const st = loopaState(id); return st.status === 'done' ? st.res : null; }

/* ===================== 서버 계산 ===================== */
async function fetchSchedule(order, modes) {
  const r = await fetch('/api/schedule', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order, modes, allowed: allowedModes, dwell, start: startTime(), end: endTime(), date: tripDate() }),
  });
  if (!r.ok) throw new Error('schedule ' + r.status);
  const j = await r.json();
  weatherStatus = j.weather;
  return j;
}
async function recomputeAll() {
  const keys = Object.keys(patterns);
  const results = await Promise.all(keys.map(k => fetchSchedule(patterns[k].order, patterns[k].modes)));
  keys.forEach((k, i) => { schedules[k] = results[i]; patterns[k].modes = results[i].modes; });
  render();
}
async function recomputeActive() {
  const p = patterns[active];
  const s = await fetchSchedule(p.order, p.modes);
  schedules[active] = s; p.modes = s.modes;
  // 체류시간은 공통이라 다른 패턴의 종료 시각·위반도 바뀔 수 있음 → 탭 배지용으로 나머지도 갱신
  await Promise.all(Object.keys(patterns).filter(k => k !== active).map(async k => {
    schedules[k] = await fetchSchedule(patterns[k].order, patterns[k].modes);
  }));
  render();
}

/* ===================== 렌더링 ===================== */
function currentOrder() {
  if (stage === 'input') return tray;
  return patterns ? patterns[stage === 'verifying' ? 'mine' : active].order : [];
}
function currentSchedule() {
  if (stage === 'result') return schedules[active];
  if (stage === 'verifying') return schedules.mine;
  return null;
}

function render() {
  if (stage === 'result') { renderMeta(schedules[active]); renderTabs(); }
  renderGate(); renderHint(); renderTray(); renderMap(); renderPopover();
}

function renderGate() {
  const n = tray.length;
  const dp = dateProblem();
  $('verifyBtn').disabled = n < 2 || !!dp;
  $('gateHint').textContent = n < 2 ? '스팟을 2곳 이상 담으면 검증할 수 있어요' : dp;
  $('dateInput').closest('.fchip').classList.toggle('bad', !!dp);
  // 마감 시각 칩: 비어 있으면 "마감 없음", 정했으면 지우기 ✕
  $('endNone').hidden = !!endTime(); $('endClear').hidden = !endTime();
}
function renderHint() {
  $('mapHint').textContent = stage === 'input' ? '흐린 핀 = 추천 후보(눌러서 담기) · 번호 핀 = 담은 스팟'
    : stage === 'result' ? '핀 클릭 → 정보·체류시간·이동수단 편집 · 라벨 = 구간 이동시간 (점선 = 실측 아님)' : '';
  $('mapHint').hidden = stage === 'verifying';
}
// 이번 일정에 쓰인 구간의 출처를 세어서 보여준다(예전: 서버 시작 때 고정 문구 — 11/17 점검 #7)
function renderSrc(s) {
  const n = { routes_api: 0, fallback: 0, estimate: 0 };
  s.rows.forEach(r => { if (r.to_next) n[r.to_next.source] = (n[r.to_next.source] || 0) + 1; });
  const parts = Object.keys(n).filter(k => n[k]).map(k => `${SRC_LABEL[k]} ${n[k]}`);
  $('ttSrc').textContent = '이동시간: ' + (parts.join(' · ') || '—');
  $('ttSrc').classList.toggle('live', n.routes_api > 0 && !n.fallback && !n.estimate);
  $('ttSrc').title = '실측 = Google Routes API · 고정값 = 팀이 정해 둔 값 · 추정 = 직선거리로 어림한 값';
}
const WEATHER_TEXT = { ok: '☔ 비 판정함', too_far: '☔ 비 판정 안 함 — 16일 넘게 남은 날짜', error: '☔ 날씨를 불러오지 못해 비 판정 건너뜀', nodate: '' };

function renderMeta(s) {
  if (!s) return;
  const p = patterns[active];
  const vc = s.violation_count;
  let html = `🔒 ${dateLabel()} · ${p.order.length}곳 · <span class="tt-meta-end">종료 예상 ${s.end}</span>`;
  if (vc) html += ` · <span class="tt-meta-viol">⚠ 위반 ${vc}건</span>`;
  if (weatherStatus && WEATHER_TEXT[weatherStatus]) html += ` · <span class="tt-meta-wx ${weatherStatus}">${WEATHER_TEXT[weatherStatus]}</span>`;
  $('tripmeta').innerHTML = html;
  renderSrc(s);
}

function renderTabs() {
  const bar = $('headerTabs');
  bar.innerHTML = Object.keys(patterns).map(k => {
    const vc = schedules[k] ? schedules[k].violation_count : 0;
    return `<button class="pattab ${k === active ? 'active' : ''}${vc ? ' has-viol' : ''}" data-k="${k}">${esc(patterns[k].label)}<span class="pattab-viol ${vc ? 'bad' : 'ok'}">${vc ? '⚠' + vc : '✓'}</span></button>`;
  }).join('');
  bar.querySelectorAll('.pattab').forEach(b => b.onclick = () => switchPattern(b.dataset.k));
}

function switchPattern(k) {
  if (!patterns || !patterns[k]) return;
  active = k; selected = null; render();
}

/* ---------- 하단 카드형 트레이(입력·결과 공통 부품) ---------- */
let dragIndex = null;
function renderTray() {
  const box = $('trayCards');
  const order = currentOrder();
  const s = currentSchedule();
  const shown = (i) => stage === 'result' || (stage === 'verifying' && reveal && i <= reveal.seg);

  // 요약 칩: 접혀 있어도 지금 무엇을 담았는지 한눈에(11/17 점검 #11)
  const sum = `<span class="tray-sum">${esc(BOOT.trip.title.split(' ')[0])} · ${order.length}곳 · ${esc(dateLabel())}</span>`;
  if (stage === 'input') {
    $('trayTitle').innerHTML = `담은 스팟 ${sum}`;
    $('traySub').textContent = order.length > 1 ? '카드를 끌어서 순서를 바꿀 수 있어요' : '';
  } else if (s) {
    $('trayTitle').innerHTML = stage === 'verifying' ? '일정 검증 중' : `${esc(patterns[active].label)} 일정 ${sum}`;
    $('traySub').innerHTML = stage === 'result' ? `${startTime()} 시작 · 종료 예상 ${s.end}${s.over_time ? ` <span class="tc-viol">⚠ 마감 ${s.over_time.limit} 초과</span>` : ''}` : '';
  }

  if (!order.length) {
    box.innerHTML = `<div class="tray-empty"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#k-shrine"/></svg>
      <p>아직 담은 스팟이 없어요. 지도의 흐린 핀을 누르거나, 어드바이저에게 물어보거나, <b>＋ 스팟 추가</b>를 눌러 보세요.</p>
      <button class="tcard-add" type="button">＋ 스팟 추가</button></div>`;
    box.querySelector('.tcard-add').onclick = (e) => { e.stopPropagation(); openCuration(); };
    return;
  }

  let html = '';
  order.forEach((id, i) => {
    const sp = SPOTS[id];
    if (i > 0) {
      const prev = s && s.rows[i - 1];
      if (prev && shown(i)) {
        const t = prev.to_next;
        html += `<div class="tconn on${isLive(t) ? '' : ' est'}" title="이동시간 출처: ${SRC_LABEL[t.source]}"><span>${MODE_ICON[t.mode]} ${t.min}분${isLive(t) ? '' : `<em>${SRC_LABEL[t.source]}</em>`}</span></div>`;
      } else {
        html += `<div class="tconn"><span></span></div>`;
      }
    }
    const row = s && s.rows[i];
    const viol = s && shown(i) && s.violations[id];
    let sub;
    if (stage === 'input') {
      sub = loopaChip(id) + (closedOnDate(id) ? `<span class="tc-closed">⚠ ${dowOf()}요일 휴무</span>` : '');
    } else if (row && shown(i)) {
      const lr = loopaRes(id);
      const mark = lr && lr.badge !== 'green' ? `<span class="tc-lmark" title="${esc(lr.badge_info.label)}">${lr.badge_info.emoji}</span>` : '';
      sub = `${mark}<span class="tc-time">${row.arrive}–${row.depart}</span>${viol ? `<span class="tc-viol">⚠ ${violShort(viol)}</span>` : row.lifted ? `<span class="tc-lifted">특별 개관</span>` : ''}`;
    } else {
      sub = `<span class="tc-pending">확인 대기</span>`;
    }
    const just = (stage === 'verifying' && reveal && i === reveal.seg) || justAdded === id ? ' just' : '';
    // 카드 전체를 끌어 순서를 바꾼다(11/17 현우: 손잡이 전용 → 카드 전체로). ⠿는 끌 수 있다는 표시로만 남김
    // 입력 상태의 휴무는 작은 태그로만(카드 전체 빨강은 '투머치' — UIUX 6-20, 9/29 현우). 결과 상태 위반은 카드 강조
    html += `<div class="tcard${viol ? ' violating' : ''}${selected === id ? ' selected' : ''}${just}" data-i="${i}" data-id="${id}" draggable="${stage !== 'verifying'}">
      <div class="tc-top">${stage !== 'verifying' && order.length > 1 ? `<span class="tc-handle" aria-hidden="true">⠿</span>` : ''}<span class="tc-num">${i + 1}</span>${kindIcon(id)}<span class="tc-name">${esc(sp.name)}</span>${stage === 'input' ? `<button class="tc-x" type="button" title="빼기" aria-label="${esc(sp.name)} 빼기">✕</button>` : ''}</div>
      <div class="tc-sub">${sub}</div></div>`;
  });
  if (stage !== 'verifying') html += `<button class="tcard-add" type="button">＋ 스팟 추가</button>`;
  box.innerHTML = html;

  box.querySelectorAll('.tcard').forEach(card => {
    const i = +card.dataset.i, id = card.dataset.id;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.tc-x')) { e.stopPropagation(); removeFromTray(id); return; }
      if (e.target.closest('.tc-recheck')) { e.stopPropagation(); checkLoopa(id, true); return; }
      e.stopPropagation(); if (stage !== 'verifying') selectPin(id);
    });
    card.addEventListener('dragstart', () => { dragIndex = i; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dragover-target'); });
    card.addEventListener('dragleave', () => card.classList.remove('dragover-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault(); card.classList.remove('dragover-target');
      if (dragIndex === null || dragIndex === i) return;
      moveInOrder(dragIndex, i); dragIndex = null;
    });
  });
  const add = box.querySelector('.tcard-add');
  if (add) add.onclick = (e) => { e.stopPropagation(); openCuration(); };
  if (justAdded) {
    const card = box.querySelector(`.tcard[data-id="${justAdded}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    justAdded = null;
  }
}

// 입력 상태 카드의 임시휴무 확인 표시
function loopaChip(id) {
  const st = loopaState(id);
  if (st.status === 'nodate') return `<span class="tc-badge none">날짜를 정하면 확인해요</span>`;
  if (st.status === 'pending') return `<span class="tc-badge pending">⏳ 임시휴무 확인 중</span>`;
  if (st.status === 'later') return `<span class="tc-badge none">검증할 때 확인</span><button type="button" class="tc-recheck">지금 확인</button>`;
  const b = st.res.badge_info;
  return `<span class="tc-badge ${st.res.badge}" title="${esc(b.label)}">${b.emoji} ${esc(b.short)}</span>${st.res.badge === 'gray' ? `<button type="button" class="tc-recheck">다시 확인</button>` : ''}`;
}

function moveInOrder(from, to) {
  if (stage === 'input') {
    saveUndo();
    const moved = tray.splice(from, 1)[0]; tray.splice(to, 0, moved);
    selected = null; render(); return;
  }
  saveUndo();
  const ord = patterns[active].order;
  const moved = ord.splice(from, 1)[0]; ord.splice(to, 0, moved);
  patterns[active].modes = null;   // 재정렬 시 이동수단은 서버가 구간별로 다시 배정
  selected = null;
  recomputeActive();
}

$('trayFold').onclick = (e) => {
  e.stopPropagation();
  const folded = $('floatPanel').classList.toggle('folded');   // CSS가 카드 영역 높이를 0으로 접는다
  $('trayFold').textContent = folded ? '펼치기 ▴' : '접기 ▾';
  $('trayFold').setAttribute('aria-expanded', String(!folded));
};

/* ---------- 담기·빼기(입력 상태) ---------- */
function addToTray(id, quiet) {
  if (tray.includes(id)) { if (!quiet) toast(`${josa(SPOTS[id].name, '은', '는')} 이미 담겨 있어요`); return false; }
  // 10곳이 하드 상한(서버도 400) — 권장은 6곳(설계노트 16-3)
  if (tray.length >= BOOT.maxSpots) { toast(`스팟은 ${BOOT.maxSpots}곳까지 담을 수 있어요`); return false; }
  saveUndo();
  tray.push(id);
  justAdded = id; popPin = id;
  if ($('floatPanel').classList.contains('folded')) $('trayFold').click();   // 접혀 있으면 펼쳐서 보여줌
  if (tray.length > BOOT.recommendedSpots && !recommendWarned) {
    recommendWarned = true;
    toast(`하루 일정은 ${BOOT.recommendedSpots}곳 안팎을 권해요 — 더 담을 수는 있어요(최대 ${BOOT.maxSpots}곳)`);
  } else if (!quiet) toast(`＋ ${josa(SPOTS[id].name, '을', '를')} 담았어요 — 아래 목록 ${tray.length}번`);
  checkLoopa(id);
  render(); fitToOrder();
  return true;
}
function removeFromTray(id) {
  saveUndo();
  tray = tray.filter(x => x !== id);
  if (selected === id) selected = null;
  toast(`${josa(SPOTS[id].name, '을', '를')} 뺐어요`);
  render();
}

/* ===================== 지도 ===================== */
let map = null, overlayHelper = null;
const mapObjs = { markers: [], lines: [], pills: [] };

window.mapUnavailable = function (msg) {
  $('map').innerHTML = `<div class="mapfail">🗺 지도를 불러오지 못했어요<br>${esc(msg)}</div>`;
};
window.gm_authFailure = function () {   // 키가 틀렸거나 리퍼러 제한에 걸리면 Google이 호출
  map = null;
  const HINT = {
    ApiNotActivatedMapError: '이 프로젝트에서 Maps JavaScript API가 사용 설정되지 않았어요',
    ApiTargetBlockedMapError: '키의 "API 제한"에 Maps JavaScript API가 빠져 있어요',
    RefererNotAllowedMapError: '키의 HTTP 리퍼러 제한에 http://localhost:8000/* 이 없어요',
    InvalidKeyMapError: '키 값이 올바르지 않아요',
    BillingNotEnabledMapError: '프로젝트에 결제 계정이 연결되지 않았어요',
  };
  // 콘솔 오류는 이 콜백보다 살짝 늦게 찍힐 수 있어 잠깐 기다렸다가 표시
  setTimeout(() => {
    const code = window.TABIDORI_MAP_ERROR;
    window.mapUnavailable('Google Maps 인증 실패' + (code ? ` (${code}) — ${HINT[code] || '콘솔 오류를 확인하세요'}` : ' — 브라우저 콘솔의 …MapError 이름을 확인하세요'));
  }, 300);
};

window.initMap = async function () {
  try {
    const { Map } = await google.maps.importLibrary('maps');
    await google.maps.importLibrary('marker');
    map = new Map($('map'), {
      mapId: window.TABIDORI_MAP_ID || 'DEMO_MAP_ID',
      center: { lat: 35.0005, lng: 135.779 }, zoom: 15,
      disableDefaultUI: true, zoomControl: true, clickableIcons: false, gestureHandling: 'greedy',
    });
    // 핀 팝오버 위치 계산용(위경도 → 화면 좌표)
    overlayHelper = new google.maps.OverlayView();
    overlayHelper.onAdd = () => {}; overlayHelper.draw = () => {}; overlayHelper.onRemove = () => {};
    overlayHelper.setMap(map);
    fitToIds(BOOT.demoOrder);
    console.info('[tabidori] 지도 ID:', window.TABIDORI_MAP_ID || '(비어 있음 → DEMO_MAP_ID)');
    map.addListener('click', () => { if (selected && Date.now() - lastPinSelect > 150) { selected = null; render(); } });
    map.addListener('idle', () => renderPopover());
    renderMap();
  } catch (e) {
    console.error(e);
    window.mapUnavailable(String(e.message || e));
  }
};

function fitToIds(ids) {
  if (!map || !ids.length) return;
  const bounds = new google.maps.LatLngBounds();
  ids.forEach(id => bounds.extend({ lat: SPOTS[id].lat, lng: SPOTS[id].lng }));
  const panelOpen = $('advisorPanel').classList.contains('open');
  map.fitBounds(bounds, { top: 60, bottom: 170, left: 60, right: panelOpen ? 400 : 140 });
}
function fitToOrder() {
  // 담은 스팟이 2곳 이상이면 그 범위로, 아니면 추천 후보까지 보이게
  fitToIds(tray.length >= 2 ? tray : [...new Set([...BOOT.demoOrder, ...tray])]);
}

function clearMapObjs() {
  mapObjs.lines.forEach(l => l.setMap(null));
  mapObjs.pills.forEach(p => { p.map = null; });
  mapObjs.markers.forEach(m => { m.map = null; });
  mapObjs.lines = []; mapObjs.pills = []; mapObjs.markers = [];
}

const toLL = (p) => (typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : p);
function pathFor(a, b, mode) {
  const l = leg(a, b, mode);
  if (l.polyline && google.maps.geometry) {
    let path = google.maps.geometry.encoding.decodePath(l.polyline).map(toLL);
    // 캐시는 정렬된 a→b 방향 하나만 있으므로, 반대 방향이면 뒤집어서 그린다(모양은 같음)
    if ([a, b].sort()[0] !== a) path = path.slice().reverse();
    if (path.length >= 2) return { path, real: true };
  }
  return { path: [{ lat: SPOTS[a].lat, lng: SPOTS[a].lng }, { lat: SPOTS[b].lat, lng: SPOTS[b].lng }], real: false };
}

function drawLeg(a, b, t, violNext) {
  const { AdvancedMarkerElement } = google.maps.marker;
  const { path, real } = pathFor(a, b, t.mode);
  const line = new google.maps.Polyline({
    map, path, strokeColor: ROUTE_COLOR, strokeOpacity: real ? 0.75 : 0, strokeWeight: 4,
    icons: real ? [] : [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.75, strokeColor: ROUTE_COLOR, scale: 3 }, offset: '0', repeat: '12px' }],
  });
  mapObjs.lines.push(line);
  const midLL = real ? path[Math.floor(path.length / 2)] : { lat: (SPOTS[a].lat + SPOTS[b].lat) / 2, lng: (SPOTS[a].lng + SPOTS[b].lng) / 2 };
  const el = document.createElement('div');
  el.className = 'gpill' + (isLive(t) ? '' : ' fallback') + (violNext ? ' viol' : '');
  el.textContent = `${MODE_ICON[t.mode]}${t.min}분`;
  el.title = `이동시간 출처: ${SRC_LABEL[t.source]}`;
  mapObjs.pills.push(new AdvancedMarkerElement({ map, position: midLL, content: el, zIndex: 1 }));
}

function addPin(id, label, opts = {}) {
  const { AdvancedMarkerElement } = google.maps.marker;
  const sp = SPOTS[id];
  const el = document.createElement('div');
  el.className = 'gpin' + (opts.ghost ? ' ghost' : '') + (selected === id ? ' selected' : '') + (opts.pop ? ' pop' : '');
  el.innerHTML = `<span class="gpin-ring">${label}</span><span class="gpin-name">${esc(sp.name)}</span>${opts.viol ? `<span class="gpin-viol">⚠</span>` : ''}${opts.ok ? `<span class="gpin-ok${opts.pop ? ' draw' : ''}" aria-label="통과"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 8.4l2.4 2.4 5.2-5.4"/></svg></span>` : ''}`;
  const m = new AdvancedMarkerElement({ map, position: { lat: sp.lat, lng: sp.lng }, content: el, zIndex: opts.ghost ? 5 : 10, title: sp.name, gmpClickable: true });
  // 최신 Maps는 'gmp-click' 이벤트, 구버전·테스트 스텁은 addListener('click')
  if (typeof m.addEventListener === 'function') m.addEventListener('gmp-click', () => selectPin(id));
  else m.addListener('click', () => selectPin(id));
  mapObjs.markers.push(m);
}

function renderMap() {
  if (!map || !google.maps.marker) return;
  clearMapObjs();
  const order = currentOrder();
  const s = currentSchedule();

  if (stage === 'input') {
    // 담는 단계: 번호 핀만, 경로선 없음(설계노트 13-1절). 담지 않은 스팟은 흐린 후보 핀
    BOOT.demoOrder.filter(id => !order.includes(id)).forEach(id => addPin(id, '+', { ghost: true }));
    order.forEach((id, i) => { const lr = loopaRes(id); addPin(id, i + 1, { viol: closedOnDate(id) || (lr && ['red', 'orange'].includes(lr.badge)), pop: id === popPin }); });
    popPin = null;
    return;
  }
  const segs = stage === 'result' ? order.length - 1 : (reveal ? reveal.seg : 0);
  s.rows.forEach((row, i) => {
    if (!row.to_next || i >= segs) return;
    drawLeg(row.id, order[i + 1], row.to_next, s.violations[order[i + 1]]);
  });
  order.forEach((id, i) => {
    const visible = stage === 'result' || (reveal && i <= reveal.seg);
    // 통과 ✓는 검증 연출 중에만 — 결과 화면 지도에는 위반 ⚠만 남긴다(11/16 현우)
    const ok = stage === 'verifying' && visible && !s.violations[id];
    addPin(id, i + 1, { viol: visible && s.violations[id], ok, pop: stage === 'verifying' && reveal && i === reveal.seg });
  });
}

/* ---------- 검증 연출: 실제 결과가 나온 구간을 이동수단 아이콘이 따라가며 그린다 ---------- */
function animateLeg(a, b, mode, ms) {
  return new Promise((resolve) => {
    if (!map || skipReveal) return resolve();
    const { AdvancedMarkerElement } = google.maps.marker;
    const pts = pathFor(a, b, mode).path;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const dx = (pts[i].lng - pts[i - 1].lng) * Math.cos(pts[i].lat * Math.PI / 180), dy = pts[i].lat - pts[i - 1].lat;
      cum.push(cum[i - 1] + Math.hypot(dx, dy));
    }
    const total = cum[cum.length - 1] || 1;
    const line = new google.maps.Polyline({ map, path: [pts[0]], strokeColor: ROUTE_COLOR, strokeOpacity: 0.75, strokeWeight: 4, zIndex: 3 });
    const el = document.createElement('div'); el.className = 'gmover'; el.textContent = MODE_ICON[mode];
    const mover = new AdvancedMarkerElement({ map, position: pts[0], content: el, zIndex: 30 });
    const ease = (f) => (f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2);
    const t0 = performance.now();
    const step = (now) => {
      const f = skipReveal ? 1 : ease(Math.min(1, (now - t0) / ms));
      const d = f * total;
      let k = 1; while (k < cum.length - 1 && cum[k] < d) k++;
      const seg = (cum[k] - cum[k - 1]) || 1, r = Math.max(0, Math.min(1, (d - cum[k - 1]) / seg));
      const head = { lat: pts[k - 1].lat + (pts[k].lat - pts[k - 1].lat) * r, lng: pts[k - 1].lng + (pts[k].lng - pts[k - 1].lng) * r };
      line.setPath(pts.slice(0, k).concat([head]));
      mover.position = head;
      if (f < 1) requestAnimationFrame(step);
      else { line.setMap(null); mover.map = null; resolve(); }
    };
    requestAnimationFrame(step);
  });
}

// fromSeg: 이미 보여준 구간 수. 결과 화면에서 스팟을 더하면 새로 생긴 마지막 구간만 연출한다(재검증은 바뀐 구간만)
// 편집으로 돌아갔다가 다시 검증할 때: 조건(시작·날짜·체류)이 같으면 앞에서부터 같은 구간은 연출하지 않는다
function unchangedSegs() {
  const v = lastVerified;
  if (!v || v.start !== startTime() || v.end !== endTime() || v.date !== tripDate() || v.dwell !== JSON.stringify(dwell) || v.allowed !== allowedModes.join()) return 0;
  let k = 0;
  while (k < tray.length && k < v.order.length && tray[k] === v.order[k]) k++;
  return Math.max(0, k - 1);
}

async function runVerify(fromSeg = 0) {
  if (tray.length < 2 || stage === 'verifying') return;
  const dp = dateProblem();
  if (dp) { toast(dp); return; }
  const prevStage = stage;
  setStage('verifying'); skipReveal = false; selected = null;
  closePanel();
  $('verifyBar').hidden = false;
  await waitLoopa(tray);       // 임시휴무 확인이 끝나야 그 결과로 판정할 수 있다(⏳ → 배지)
  $('verifyText').textContent = '이동시간·영업시간·날씨를 확인하고 있어요';
  let data;
  try {
    const r = await fetch('/api/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: tray, allowed: allowedModes, dwell, start: startTime(), end: endTime(), date: tripDate() }),
    });
    if (!r.ok) {
      let msg = '검증 서버에 연결하지 못했어요';
      try { msg = (await r.json()).detail || msg; } catch (_) { /* 본문 없음 */ }
      throw new Error(msg);
    }
    data = await r.json();
  } catch (e) {
    console.error(e);
    if (prevStage === 'result') tray = patterns[active].order.slice();
    setStage(prevStage); $('verifyBar').hidden = true; render();
    toast(e.message && !e.message.startsWith('Failed') ? e.message : '검증 서버에 연결하지 못했어요'); return;
  }
  weatherStatus = data.weather;
  verifyMemo = { removed: data.removed || [], alt_skipped: !!data.alt_skipped };
  Object.assign(BOOT.travel, data.travel);   // 새로 계산된 구간(큐레이션에서 담은 스팟)을 합친다
  patterns = {}; schedules = {};
  Object.entries(data.patterns).forEach(([k, p]) => {
    patterns[k] = { label: p.label, order: p.order, modes: p.modes };
    schedules[k] = p.schedule;
  });
  active = 'mine';
  lastVerified = { order: patterns.mine.order.slice(), start: startTime(), end: endTime(), date: tripDate(), dwell: JSON.stringify(dwell), allowed: allowedModes.join() };
  reveal = { seg: fromSeg };
  render();

  const ord = patterns.mine.order, s = schedules.mine;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 연출 시간 상한 2초(11/16 현우): 구간이 많으면 구간당 시간을 줄여 총 2초를 넘지 않게 한다.
  // 지금은 서버가 결과를 한 번에 주므로 재생 시간만 조절. 백엔드 스트리밍 연결 후에는 구간 결과 도착에 맞춰 그린다.
  const REVEAL_MAX_MS = 2000;
  const legMs = [];
  for (let i = fromSeg; i < ord.length - 1; i++) legMs.push(map ? 450 + Math.min(s.rows[i].to_next.min * 22, 450) : 320);
  const sumMs = legMs.reduce((a, b) => a + b, 0);
  const scale = sumMs > REVEAL_MAX_MS ? REVEAL_MAX_MS / sumMs : 1;
  for (let i = fromSeg; i < ord.length - 1 && !skipReveal && !reduce; i++) {
    const t = s.rows[i].to_next;
    $('verifyText').textContent = `${i + 1}/${ord.length - 1} 구간 · ${SPOTS[ord[i]].name} → ${SPOTS[ord[i + 1]].name} ${MODE_ICON[t.mode]} ${t.min}분`;
    const ms = Math.round(legMs[i - fromSeg] * scale);
    if (map) await animateLeg(ord[i], ord[i + 1], t.mode, ms);
    else await sleep(ms);   // 지도가 없으면 카드만 차례로 채운다
    reveal.seg = i + 1;
    renderTray(); renderMap();
  }
  finishVerify();
}
$('verifyBtn').onclick = () => runVerify(unchangedSegs());
// 연출 중 지도나 트레이를 누르면 바로 최종 화면(동작 기준표 안전장치)
['map', 'floatPanel'].forEach(id => $(id).addEventListener('pointerdown', () => { if (stage === 'verifying') skipReveal = true; }));
$('verifySkip').onclick = (e) => { e.stopPropagation(); skipReveal = true; };

function finishVerify() {
  reveal = null; undoStack = [];   // 입력 단계의 되돌리기 기록은 결과 화면으로 넘어가지 않는다
  setStage('result');
  $('verifyBar').hidden = true;
  $('cmDateLocked').textContent = dateLabel();
  render();
  fitToIds(patterns[active].order);
  if (!advisedOnce) { advisedOnce = true; adviseAfterVerify(); }
}

// 위반 한 건을 한 문장으로(정해진 문장 — LLM 없이)
function violSentence(id, x) {
  const nm = id ? esc(SPOTS[id].name) : '';
  const eun = id ? esc(josa(SPOTS[id].name, '은', '는').slice(SPOTS[id].name.length)) : '';
  switch (x.type) {
    case 'closedDay': return `${nm}${eun} ${dateLabel()}에 정기 휴무예요.`;
    case 'tempClosed': return `${nm}${eun} ${dateLabel()}에 임시 휴관이에요(🔴).`;
    case 'partialClosed': return `${nm}${eun} ${dateLabel()}에 일부 휴관이에요(🟠).`;
    case 'closeAfter': return `${nm} 도착이 마감(${x.close})보다 ${x.over_by}분 늦어요.`;
    case 'rainOutdoor': return `${nm}에 있을 ${x.hour}시 무렵 강수확률이 ${x.prob}%예요(실외).`;
    case 'overTime': return `일정이 마감 시각 ${x.limit}보다 ${x.over_by}분 늦게 끝나요.`;
  }
  return '';
}
function adviseAfterVerify() {
  const s = schedules.mine;
  const v = allViolations(s);
  const alts = Object.keys(patterns).filter(k => k !== 'mine');
  const wx = weatherStatus === 'too_far' ? ' 날짜가 16일 넘게 남아서 비 판정은 하지 않았어요.'
    : weatherStatus === 'error' ? ' 날씨를 불러오지 못해 비 판정은 건너뛰었어요.' : '';
  if (!v.length) {
    appendAdvisor(`검증을 통과했어요. 종료 예상은 <b>${s.end}</b>이에요.${wx} <b>핀을 누르면</b> 머무는 시간이나 다음 구간 이동수단을 바꿀 수 있고, <b>아래 카드</b>는 끌어서 순서를 바꿀 수 있어요.`);
    return;
  }
  const [id, x] = v[0];
  const what = violSentence(id, x) + (v.length > 1 ? ` 그 밖에 위반 ${v.length - 1}건이 더 있어요.` : '');
  const removed = verifyMemo.removed || [];
  const removedNames = removed.map(i => SPOTS[i].name).join(', ');
  if (!alts.length) {
    let how;
    if (verifyMemo.alt_skipped) how = `스팟이 ${tray.length}곳이라 다른 순서는 계산하지 않았어요(7곳까지 비교해요). 카드를 끌어 순서를 바꿔 보거나 스팟을 줄여 보세요.`;
    else if (removed.length) {
      const obj = `${esc(removedNames)}${removed.length > 1 ? '를' : esc(josa(removedNames, '을', '를').slice(removedNames.length))}`;
      how = tray.length - removed.length < 2
        ? `휴무는 순서를 바꿔도 풀리지 않고, ${obj} 빼면 1곳만 남아서 다른 순서를 만들 수 없어요. 이 스팟을 빼거나, 편집으로 돌아가 날짜를 바꿔 보세요.`
        : `휴무는 순서를 바꿔도 풀리지 않아서 ${obj} 뺀 순서도 찾아봤지만, 위반 없는 순서가 없었어요. 스팟을 빼거나 날짜·시각을 바꿔 보세요.`;
    } else how = '담은 스팟으로는 위반 없는 순서를 찾지 못했어요. 스팟을 빼거나 출발 시각을 앞당겨 보세요.';
    appendAdvisor(`<b>${what}</b> ${how} 그대로 확정할 수도 있어요.${wx}`);
    openPanel(); return;
  }
  const chips = alts.map(k => ({
    label: `${patterns[k].label}: ${patterns[k].order.map(i => SPOTS[i].name).join('→')}`,
    sub: `총 이동 ${schedules[k].total_travel}분 · 위반 없음 · 종료 ${schedules[k].end}${removed.length ? ` · ${removedNames} 뺌` : ''}`,
    action: () => switchPattern(k),
  }));
  const lead = removed.length ? `순서로는 풀리지 않는 <b>${esc(removedNames)}</b>${removed.length > 1 ? '를' : esc(josa(removedNames, '을', '를').slice(removedNames.length))} 뺀` : '위반 없는';
  appendAdvisor(`${x.type === 'closeAfter' ? '지금 순서로는 ' : ''}<b>${what}</b> ${lead} 다른 순서를 ${alts.length}개 찾았어요. 위쪽 <b>패턴 탭</b>에서 비교할 수 있고, 눌러봐도 원래 내 패턴은 사라지지 않아요.${wx}`, chips);
}

/* ===================== 핀 팝오버 ===================== */
let lastPinSelect = 0;   // 핀 클릭 직후 지도 클릭 이벤트가 같이 와서 선택이 풀리는 것을 막음
function selectPin(id) {
  if (stage === 'verifying') return;
  lastPinSelect = Date.now();
  selected = (selected === id) ? null : id;
  render();
}

function renderPopover() {
  const el = $('pinpop');
  if (!selected || stage === 'verifying') { el.hidden = true; return; }
  const sp = SPOTS[selected];
  const cite = citeHtml(selected);

  if (stage === 'input') {
    const inTray = tray.includes(selected);
    el.innerHTML = `
      <div class="pinpop-top"><span class="pinpop-name">${kindIcon(selected, 'pp-kind')}${inTray ? (tray.indexOf(selected) + 1) + '. ' : ''}${esc(sp.name)}</span><button class="pinpop-x" title="닫기">✕</button></div>
      ${cite}
      <div class="pinpop-desc">${esc(sp.desc)} · 머무는 시간 ${dwell[selected] ?? sp.dwell}분(기본값)</div>
      ${closedOnDate(selected) ? `<div class="pinpop-violation">⚠ ${dateLabel()}은 정기 휴무예요. 담을 수는 있고, 검증 결과에 위반으로 표시돼요.</div>` : ''}
      ${!tripDate() ? `<div class="pinpop-note">날짜를 정하면 휴무를 확인해요.</div>` : ''}
      <button class="pp-action ${inTray ? 'remove' : 'add'}">${inTray ? '빼기' : '＋ 담기'}</button>`;
    el.querySelector('.pp-action').onclick = (e) => {
      e.stopPropagation();
      const id = selected; selected = null;
      inTray ? removeFromTray(id) : addToTray(id);
    };
  } else {
    const s = schedules[active];
    const order = patterns[active].order;
    const idx = order.indexOf(selected);
    if (idx < 0 || !s) { selected = null; el.hidden = true; return; }
    const row = s.rows[idx];
    const viol = s.violations[selected];
    let modeHtml = '<div class="pinpop-endnote">마지막 방문지 — 다음 구간 없음</div>';
    if (idx < order.length - 1) {
      const next = order[idx + 1];
      modeHtml = `<div class="pinpop-field"><div class="pinpop-field-label">다음 구간(→ ${esc(SPOTS[next].name)}) 이동수단</div><div class="modeselect">` +
        ['walk', 'bike', 'transit', 'car'].map(m => {
          const l = leg(selected, next, m);
          return `<button data-mode="${m}" class="${m === row.to_next.mode ? 'active' : ''}${allowedModes.includes(m) ? '' : ' off'}" title="${allowedModes.includes(m) ? '' : '쓸 수 있는 이동수단에서 뺀 수단 — 직접 고를 수는 있어요'}">${MODE_ICON[m]} ${MODE_LABEL[m]}<br>${l.min}분${l.source === 'routes_api' ? '' : `<span class="est"> ${SRC_LABEL[l.source]}</span>`}</button>`;
        }).join('') + '</div></div>';
    }
    el.innerHTML = `
      <div class="pinpop-top"><span class="pinpop-name">${kindIcon(selected, 'pp-kind')}${idx + 1}. ${esc(sp.name)}</span><button class="pinpop-x" title="닫기">✕</button></div>
      ${cite}
      <div class="pinpop-desc">${esc(sp.desc)} · 도착 ${row.arrive} → 출발 ${row.depart}</div>
      ${viol ? `<div class="pinpop-violation">⚠ ${esc(violText(viol))}</div>` : row.lifted ? `<div class="pinpop-lifted">🔵 특별 개관 — 이날은 마감 ${esc(String(row.lifted))}로 판정했어요(공식 페이지 확인)</div>` : ''}
      <div class="pinpop-field"><div class="pinpop-field-label">머무는 시간</div>
        <div class="dwellstepper"><button data-d="-5">−</button><span class="dw-val">${row.dwell}분</span><button data-d="5">+</button></div></div>
      ${modeHtml}`;
    el.querySelectorAll('.dwellstepper button').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); saveUndo();
      dwell[selected] = Math.max(0, row.dwell + parseInt(b.dataset.d, 10));
      recomputeActive();
    });
    el.querySelectorAll('.modeselect button').forEach(b => b.onclick = (e) => {
      e.stopPropagation(); saveUndo();
      patterns[active].modes[idx] = b.dataset.mode;
      recomputeActive();
    });
  }
  el.querySelector('.pinpop-x').onclick = (e) => { e.stopPropagation(); selected = null; render(); };
  el.onclick = (e) => e.stopPropagation();
  el.hidden = false;
  positionPopover(el, sp);
}

// 출처 칩: 정기 정보(영업시간·휴무일)의 출처 + 임시휴무 확인 결과(배지·경로·원문)
function citeHtml(id) {
  const sp = SPOTS[id];
  const st = loopaState(id);
  let head, body = `<div class="cp-line"><b>정기 정보</b> ${esc(sp.source)}${sp.close ? ` · 마감 ${sp.close}` : ''}</div>`;
  if (st.status === 'done') {
    const r = st.res, b = r.badge_info;
    head = `${b.emoji} ${esc(b.short)}`;
    body += `<div class="cp-line"><b>임시휴무 확인</b> ${b.emoji} ${esc(b.label)} · ${r.path === 'official' ? '공식 페이지' : '웹 검색'} 기준</div>`;
    if (r.quote) body += `<blockquote class="cp-quote">${esc(r.quote)}</blockquote>`;
    if (r.url) body += `<div class="cp-line"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url.replace(/^https?:\/\//, ''))}</a></div>`;
    body += `<div class="cp-note">${esc(r.note || '')}</div>`;
  } else {
    head = st.status === 'pending' ? '⏳ 확인 중' : '정기 정보';
    body += `<div class="cp-note">${st.status === 'pending' ? '임시휴무를 확인하고 있어요' : st.status === 'nodate' ? '날짜를 정하면 임시휴무를 확인해요' : '임시휴무는 검증할 때 확인해요'}</div>`;
  }
  const badge = st.status === 'done' ? st.res.badge : 'none';
  return `<details class="citechip-wrap"><summary class="citechip ${badge}">${head} <span class="citemark">[출처]</span></summary><div class="citepop">${body}</div></details>`;
}

function positionPopover(el, sp) {
  const stageEl = $('stage');
  const W = stageEl.clientWidth, H = stageEl.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
  let x = 16, y = 48;   // 지도가 없으면 왼쪽 위 고정
  const proj = overlayHelper && overlayHelper.getProjection();
  if (map && proj) {
    const p = proj.fromLatLngToContainerPixel(new google.maps.LatLng(sp.lat, sp.lng));
    x = p.x + 24; y = p.y - h / 2;
    const rightReserve = $('advisorPanel').classList.contains('open') ? 380 : 110;
    if (x + w > W - rightReserve) x = p.x - w - 24;   // 어드바이저 패널·캐릭터 영역을 피함
  }
  const bottomReserve = $('floatPanel').offsetHeight + 10;
  x = Math.max(8, Math.min(x, W - w - 8));
  y = Math.max(40, Math.min(y, H - h - bottomReserve));   // 아래 트레이를 피함
  el.style.left = x + 'px'; el.style.top = y + 'px';
}

/* ===================== 되돌리기 ===================== */
function saveUndo() {
  undoStack.push(stage === 'input'
    ? { stage: 'input', tray: tray.slice(), dwell: { ...dwell } }
    : { stage: 'result', active, order: patterns[active].order.slice(), modes: patterns[active].modes ? patterns[active].modes.slice() : null, dwell: { ...dwell } });
  if (undoStack.length > 1) undoStack.shift();   // 직전 한 번만 — 실서비스는 DB 한 칸(undo_snapshot)이라 여러 단계를 두지 않는다
  syncUndo();
}
function clearUndo() { undoStack = []; syncUndo(); }
function syncUndo() {
  const on = undoStack.length > 0 && stage !== 'verifying';
  $('rsUndo').classList.toggle('enabled', on);
  $('rsUndo').hidden = !on;   // 되돌릴 게 있을 때만 표시(9-9절)
}
function doUndo() {
  const u = undoStack.pop();
  if (!u || stage === 'verifying' || u.stage !== (stage === 'input' ? 'input' : 'result')) { syncUndo(); return; }
  selected = null; dwell = u.dwell;
  if (u.stage === 'input') {
    tray = u.tray; render(); fitToOrder(); toast('↶ 직전 상태로 되돌렸어요');
  } else {
    active = u.active; patterns[active].order = u.order; patterns[active].modes = u.modes;
    recomputeAll().then(() => toast('↶ 직전 상태로 되돌렸어요'));
  }
  syncUndo();
}
$('rsUndo').onclick = (e) => { e.stopPropagation(); doUndo(); };
// Cmd/Ctrl+Z — 입력칸에 글을 쓰는 중에는 브라우저 기본 동작(글자 되돌리기)을 그대로 둔다
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  if (e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]')) return;
  if (!undoStack.length) return;
  e.preventDefault(); doUndo();
});

/* ===================== 토스트·모달 ===================== */
let toastTimer = null;
function toast(t) {
  const el = $('toast'); el.textContent = t; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function openConfirm(html) { $('confirmPop').innerHTML = html; $('confirmBackdrop').hidden = false; }
function closeConfirm() { $('confirmBackdrop').hidden = true; }
$('confirmBackdrop').onclick = (e) => { if (e.target.id === 'confirmBackdrop') closeConfirm(); };

$('confirmBtn').onclick = () => {
  const s = schedules[active];
  const v = allViolations(s);
  if (v.length) {
    openConfirm(`<div class="cp-warn">아직 <b>${v.length}건</b>의 위반이 남아 있어요.</div>` +
      v.map(([id, x]) => `<button class="cp-vrow" ${id ? `data-id="${id}"` : 'disabled'}><span>⚠</span><span><b>${id ? esc(SPOTS[id].name) : '일정 전체'}</b><span class="cp-vwhy">${esc(violText(x))}</span><span class="cp-vhint">${violHint(x)}</span></span></button>`).join('') +
      `<div class="cp-hint">스팟을 누르면 그 핀으로 이동해요. 알고 가는 거라면 그대로 확정해도 돼요.</div>
       <div class="cp-row"><button class="cp-cancel">돌아가서 고치기</button><button class="cp-go">그래도 확정</button></div>`);
  } else {
    openConfirm(`<div class="cp-ok">위반 없이 검증을 통과했어요. <b>${esc(patterns[active].label)}</b>으로 확정할까요?</div>
      <div class="cp-row"><button class="cp-cancel">닫기</button><button class="cp-go">확정하기</button></div>`);
  }
  const pop = $('confirmPop');
  pop.querySelectorAll('.cp-vrow[data-id]').forEach(r => r.onclick = () => { closeConfirm(); selected = r.dataset.id; render(); });
  pop.querySelector('.cp-cancel').onclick = closeConfirm;
  pop.querySelector('.cp-go').onclick = () => { closeConfirm(); toast('✓ 확정 — OAuth·캘린더 연동은 아직 연결 전이에요'); };
};

$('backToEdit').onclick = () => {
  openConfirm(`<div class="cp-title">편집으로 돌아갈까요?</div>
    <div class="cp-ok">날짜와 담은 스팟은 검증하고 나면 잠겨요(시작·마감 시각과 이동수단은 여기서도 바꿀 수 있어요). 바꾸려면 검증 전 상태로 돌아가야 해요.<br><br>지금 보고 있는 <b>${esc(patterns[active].label)}</b>의 순서가 그대로 담긴 목록으로 돌아가요.</div>
    <div class="cp-row"><button class="cp-cancel">취소</button><button class="cp-go neutral">편집으로 돌아가기</button></div>`);
  $('confirmPop').querySelector('.cp-cancel').onclick = closeConfirm;
  $('confirmPop').querySelector('.cp-go').onclick = () => {
    closeConfirm();
    tray = patterns[active].order.slice();   // 결과화면에서 편집한 순서를 이어받음(개발노트 7-3)
    patterns = null; schedules = {}; active = 'mine'; selected = null; advisedOnce = false;
    undoStack = [];
    setStage('input'); openPanel(); render(); fitToOrder();
    appendAdvisor('편집 상태로 돌아왔어요 — 담은 순서는 그대로예요. 날짜를 바꾼 뒤 다시 <b>검증하기</b>를 눌러 주세요.');
  };
};

/* ===================== 어드바이저 패널 ===================== */
function openPanel() { $('advisorPanel').classList.add('open'); document.body.classList.add('advisor-open'); }
function closePanel() { $('advisorPanel').classList.remove('open'); document.body.classList.remove('advisor-open'); }
$('advisorChar').onclick = (e) => { e.stopPropagation(); $('advisorPanel').classList.contains('open') ? closePanel() : openPanel(); };
$('advisorPeek').onclick = (e) => { e.stopPropagation(); openPanel(); };
$('apClose').onclick = closePanel;
$('apReset').onclick = () => {
  if (!confirm('대화 내용을 초기화할까요? (지도·일정 편집 내용은 그대로 유지돼요)')) return;
  $('advisorLog').innerHTML = ''; toast('🗑 대화 내역을 초기화했어요');
};

function appendAdvisor(html, chips) {
  const row = document.createElement('div');
  row.className = 'msgrow advisor';
  row.innerHTML = `<span class="advatar">🧭</span><div class="bubble">${html}${chips ? `<div class="msgchips">${chips.map((c, i) => `<button class="msgchip" data-i="${i}">${esc(c.label)}<span class="mc-sub">${esc(c.sub)}</span></button>`).join('')}</div>` : ''}</div>`;
  if (chips) row.querySelectorAll('.msgchip').forEach(b => b.onclick = () => chips[+b.dataset.i].action());
  $('advisorLog').appendChild(row);
  return row;
}
function appendUser(text) {
  const row = document.createElement('div');
  row.className = 'msgrow user';
  row.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  $('advisorLog').appendChild(row);
}

// 패널이 닫혀 있어도 최신 메시지 한 줄은 캐릭터 옆 말풍선으로 보여준다
function updatePeek() {
  const log = $('advisorLog');
  log.scrollTop = log.scrollHeight;
  const last = log.lastElementChild;
  const peek = $('advisorPeek');
  if (!last) { peek.hidden = true; return; }
  const who = last.classList.contains('user') ? '나' : '어드바이저';
  const text = (last.querySelector('.bubble, .steplist') || last).textContent.trim();
  peek.innerHTML = `<span class="ap-peek-who">${who}</span><span class="ap-peek-text">${esc(text)}</span>`;
  peek.hidden = false;
}
new MutationObserver(updatePeek).observe($('advisorLog'), { childList: true, subtree: true, characterData: true });

// 입력 상태 예시 대화(데모 응답 — LangGraph Agent 연결 전)
document.querySelectorAll('#inputExamples .ap-ex-chip').forEach(b => b.onclick = () => {
  appendUser(b.textContent);
  if (b.dataset.ex === 'evening') {
    const ids = BOOT.demoOrder;
    // 저녁 코스라서 시작 시각을 16:00으로 바꾼다 — 청수사 마감(17:10) 위반이 나오는 시연 흐름(11/17 현우: 기본은 09:00 유지)
    $('startInput').value = '16:00'; onConditionChange(false);
    appendAdvisor(`저녁 산책이니 시작 시각을 <b>16:00</b>으로 바꿔뒀어요(위쪽 ⏰ 칩에서 바꿀 수 있어요). 기온 쪽이라면 이 ${ids.length}곳을 묶어볼 수 있어요. 지도에 흐린 핀으로 띄워뒀으니 하나씩 눌러 담거나, 한 번에 담을 수 있어요. <i>(시연 응답 — 에이전트 연결 전)</i>`, [
      { label: `${ids.length}곳 모두 담기`, sub: ids.map(i => SPOTS[i].name).join(' · '), action: () => { ids.forEach(i => addToTray(i, true)); toast(`＋ ${ids.length}곳을 담았어요`); } },
    ]);
  } else if (b.dataset.ex === 'cheong') {
    const added = addToTray('cheong', true);
    appendAdvisor(`${added ? '청수사를 담았어요.' : '청수사는 이미 담겨 있어요.'} 정기 마감이 17:10(Google 장소 정보 기준)이라 늦은 오후 일정이면 순서에 주의해야 해요. 고른 날짜에 특별 개관이 있는지는 임시휴무 확인에서 같이 봐요. <b>검증하기</b>를 누르면 같이 확인해 드릴게요. <i>(시연 응답)</i>`);
  }
});

// "+" 메뉴
$('ibAdd').onclick = (e) => { e.stopPropagation(); $('ibAddMenu').hidden = !$('ibAddMenu').hidden; };
document.querySelectorAll('.iam-item').forEach(b => b.onclick = (e) => {
  e.stopPropagation(); $('ibAddMenu').hidden = true;
  if (b.dataset.act === 'spot') openCuration();
  else toast('📎 일정 파일 첨부는 준비 중이에요');
});
document.addEventListener('click', (e) => {
  if (!$('ibAddMenu').hidden && !$('ibAddMenu').contains(e.target)) $('ibAddMenu').hidden = true;
  const ac = $('cmAutocomplete');
  if (!ac.hidden && !ac.contains(e.target) && e.target.id !== 'cmSearchInput') ac.hidden = true;
});

/* ===================== 스팟 추가 데모(큐레이션 목록 밖·좌표 없는 스팟) ===================== */
function runAddSpotDemo(name, closed) {
  openPanel();
  const labels = ['장소 정보 확인 중', '기존 일정과 이동 경로 재계산 중', '마감·휴관일 등 제약 재검증 중'];
  const row = document.createElement('div');
  row.className = 'msgrow advisor';
  $('advisorLog').appendChild(row);
  let done = 0;
  const draw = () => {
    row.innerHTML = `<span class="advatar">🧭</span><div class="steplist">${labels.map((l, i) =>
      `<div class="step ${i < done ? 'done' : i === done ? 'active' : ''}"><span class="step-mark">${i < done ? '✓' : ''}</span><span>${l}</span></div>`).join('')}</div>`;
  };
  draw();
  const tick = () => setTimeout(() => {
    done++; draw();
    if (done < labels.length) return tick();
    appendAdvisor(`"${esc(name)}"${josa(name, "을", "를").slice(name.length)} 담았어요. <i>(이 스팟은 데모 데이터에 좌표·이동시간이 없어 지도·순서 반영은 스팟 추가 API 연결 후 동작해요)</i>`);
    if (closed) appendAdvisor(`참고로 <b>"${esc(name)}"</b>${josa(name, "은", "는").slice(name.length)} ${dateLabel()}에 휴무예요. 그래도 담았고, 확정하기 전에 한 번 더 알려드릴게요.`);
  }, 650);
  tick();
}

/* ---------- 큐레이션 목록에서 담기 ---------- */
function addFromCuration(id, closed) {
  const sp = SPOTS[id];
  if (stage === 'input') {
    // 입력 상태: 모달을 닫지 않고 이어서 고른다. 채팅 안내는 모달을 닫을 때 한 번에(11/17 점검 #12)
    if (!addToTray(id, true)) return;
    cmSession.push({ id, closed });
    $('cmCount').textContent = `지금 ${tray.length}곳 담음`;
    htmx.trigger(document.body, 'cm-refresh');
    return;
  }
  // 결과 화면: 지금 보고 있는 패턴 끝에 붙여 다시 검증하고, 새로 생긴 마지막 구간만 연출한다
  const base = patterns[active].order;
  if (base.includes(id)) { toast(`${sp.name}은(는) 이미 일정에 있어요`); return; }
  tray = base.concat(id);
  justAdded = id; advisedOnce = false;
  toast(`＋ ${josa(sp.name, '을', '를')} 더해서 다시 검증할게요`);
  runVerify(tray.length - 2);
}

/* ===================== 큐레이션 모달 ===================== */
function openCuration() {
  $('cmSearchInput').value = '';
  cmSession = [];
  $('cmDate').value = $('dateInput').value;
  $('cmDateLocked').textContent = dateLabel();
  $('cmCount').textContent = stage === 'input' ? `지금 ${tray.length}곳 담음` : '';
  $('curationBackdrop').hidden = false;
  htmx.trigger(document.body, 'cm-refresh');
}
function closeCuration() {
  if ($('curationBackdrop').hidden) return;
  $('curationBackdrop').hidden = true; $('cmAutocomplete').hidden = true;
  if (!cmSession.length) return;
  const names = cmSession.map(c => SPOTS[c.id].name);
  const closed = cmSession.filter(c => c.closed).map(c => SPOTS[c.id].name);
  cmSession = [];
  openPanel();
  appendAdvisor(`큐레이션 목록에서 <b>${names.length}곳</b>을 담았어요 — ${esc(names.join(', '))}.` +
    (closed.length ? ` 이 중 <b>${esc(closed.join(', '))}</b>${closed.length > 1 ? '는' : esc(josa(closed[0], '은', '는').slice(closed[0].length))} ${dateLabel()}에 정기 휴무예요. 그래도 담았고, 카드에 휴무 표시를 남겨둘게요.` : ''));
}
$('cmClose').onclick = closeCuration;
$('curationBackdrop').onclick = (e) => { if (e.target.id === 'curationBackdrop') closeCuration(); };
$('cmChatBtn').onclick = () => { closeCuration(); openPanel(); $('chatInput').focus(); appendAdvisor('어디를 추가하고 싶으신가요? 장소명을 입력해주세요.'); };

// 모달 안에서 날짜를 바꾸면 위쪽 조건 칩과 같은 값으로 맞춘다(같은 상태)
$('cmDate').addEventListener('change', () => {
  $('dateInput').value = $('cmDate').value;
  $('dateInput').dispatchEvent(new Event('change', { bubbles: true }));
});
// 날짜를 바꾸면 카드·핀의 휴무 표시를 다시 판정한다(예전: 모달만 새로 고침 — 11/17 점검 #1)
let prevDate = null;
$('dateInput').addEventListener('change', () => {
  const d = tripDate();
  if (d && d < BOOT.today) toast('지난 날짜는 검증할 수 없어요');
  $('cmDate').value = d;
  if (!$('curationBackdrop').hidden) htmx.trigger(document.body, 'cm-refresh');
  // 새로 휴무가 된 담은 스팟만 정해진 문장으로 알린다
  const newly = tray.filter(id => closedOnDate(id, d) && !closedOnDate(id, prevDate));
  if (newly.length) {
    const names = newly.map(i => SPOTS[i].name).join(', ');
    openPanel();
    appendAdvisor(`날짜를 ${dateLabel()}로 바꿨더니 <b>${esc(names)}</b>${newly.length > 1 ? '가' : esc(josa(names, '이', '가').slice(names.length))} 그날 정기 휴무예요. 빼거나 날짜를 다시 바꿔 보세요. 그대로 두면 검증에서 위반으로 표시돼요.`);
  }
  prevDate = d;
  render();
});
// 시작·마감·이동수단: 입력 상태에서는 화면만 다시 그리고, 결과 상태에서는 바로 다시 계산한다(11/17 현우: 결과 화면에서도 바꿈)
function onConditionChange(modesChanged) {
  renderGate();
  if (stage !== 'result') { render(); return; }
  if (modesChanged) Object.values(patterns).forEach(p => { p.modes = null; });   // 서버가 구간별로 다시 배정
  recomputeAll().catch(e => { console.error(e); toast('다시 계산하지 못했어요'); });
}
$('startInput').addEventListener('change', () => onConditionChange(false));
$('endInput').addEventListener('change', () => onConditionChange(false));
$('endClear').onclick = (e) => { e.stopPropagation(); $('endInput').value = ''; onConditionChange(false); };

// 서버에서 받은 그리드 안의 버튼들(태그 칩·담기)은 위임으로 처리
$('cmGridWrap').addEventListener('click', (e) => {
  const chip = e.target.closest('.cm-tagchip');
  const clear = e.target.closest('.cm-tagclear');
  const addBtn = e.target.closest('.cm-card-add');
  if (chip || clear) {
    const set = new Set($('cmTags').value.split(',').filter(Boolean));
    if (clear) set.clear();
    else set.has(chip.dataset.t) ? set.delete(chip.dataset.t) : set.add(chip.dataset.t);
    $('cmTags').value = [...set].join(',');
    htmx.trigger(document.body, 'cm-refresh');
  } else if (addBtn && !addBtn.disabled) {
    addedCount++;
    const id = addBtn.dataset.id;
    if (id && SPOTS[id] && stage === 'input') { addFromCuration(id, !!addBtn.dataset.closed); return; }
    closeCuration();
    if (id && SPOTS[id]) addFromCuration(id, !!addBtn.dataset.closed);
    else runAddSpotDemo(addBtn.dataset.name, !!addBtn.dataset.closed);
  }
});

// 식당·카페 자유검색: 입력값을 그대로 "직접 검색해서 추가" 후보로 보여줌(Places Autocomplete 연결 전)
$('cmSearchInput').addEventListener('input', (e) => {
  const q = e.target.value.trim(); const box = $('cmAutocomplete');
  if (!q) { box.hidden = true; return; }
  box.innerHTML = `<div class="cm-ac-item">🍽 "${esc(q)}" 직접 검색해서 추가 <span style="color:var(--faint);font-size:10.5px">(Places 자동완성 연결 전)</span></div>`;
  box.hidden = false;
  box.firstElementChild.onclick = () => { closeCuration(); runAddSpotDemo(q, false); };
});
document.querySelectorAll('.cm-suggest-chip').forEach(c => c.onclick = () => {
  const inp = $('cmSearchInput'); inp.value = c.textContent; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeConfirm(); closeCuration(); $('ibAddMenu').hidden = true; }
});

document.body.addEventListener('htmx:configRequest', (e) => {
  if (!e.detail.path.startsWith('/partials/curation')) return;
  e.detail.parameters.added = (stage === 'input' ? tray : (patterns ? patterns[active].order : [])).join(',');
  e.detail.parameters.date = tripDate();
});

/* ===================== 시작 ===================== */
(function init() {
  prevDate = tripDate();
  renderModeChips();
  setStage('input');
  openPanel();
  render();
  appendAdvisor('안녕하세요! 교토에서 가고 싶은 곳을 말씀해 주세요. 지도에 <b>흐린 핀</b>으로 추천 후보를 띄워뒀어요 — 눌러서 담을 수 있어요. 2곳 이상 담으면 위의 <b>검증하기</b>로 순서·영업시간을 확인해 드려요.');
})();

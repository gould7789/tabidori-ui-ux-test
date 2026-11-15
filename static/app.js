/* 타비도리 결과화면 클라이언트.
   - 일정 계산(도착시각·마감 위반·종료 예상)은 서버 /api/schedule 이 한다. 여기서는 그리기와 조작만.
   - 지도는 Google Maps JavaScript API(AdvancedMarkerElement + Polyline).
   - 큐레이션 그리드와 채팅 응답은 htmx로 서버 조각을 받아 끼운다. */
'use strict';

const BOOT = JSON.parse(document.getElementById('boot').textContent);
const SPOTS = BOOT.spots;
const MODE_LABEL = BOOT.modeLabel, MODE_ICON = BOOT.modeIcon;
const VIOLATION_ICON = { closeAfter: '🕐', closedDay: '🚫', overTime: '⏱', rainOutdoor: '☔' };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pairKey = (a, b) => [a, b].sort().join('|');
const leg = (a, b, mode) => BOOT.travel[pairKey(a, b)][mode];
// 한국어 조사: 마지막 글자에 받침이 있으면 a(을/은), 없으면 b(를/는)
const josa = (w, a, b) => { const c = String(w).charCodeAt(String(w).length - 1); return w + ((c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28) ? a : b); };

/* ===================== 상태 ===================== */
const patterns = structuredClone(BOOT.patterns);   // key -> {label, order, modes}
let active = 'mine';
let dwell = {};                                     // 체류시간은 패턴 공통(v17과 같은 규칙)
const schedules = {};                               // key -> 서버 계산 결과
let selected = null;
let undo = null;
let addedCount = 0;

/* ===================== 서버 계산 ===================== */
async function fetchSchedule(order, modes) {
  const r = await fetch('/api/schedule', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order, modes, dwell }),
  });
  if (!r.ok) throw new Error('schedule ' + r.status);
  return r.json();
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
function render() {
  const s = schedules[active];
  if (!s) return;
  renderMeta(s); renderTabs(); renderStrip(s); renderMap(s); renderPopover(s);
}

function renderMeta(s) {
  const p = patterns[active];
  const vc = Object.keys(s.violations).length;
  let html = `🔒 ${BOOT.trip.date_label} · ${p.order.length}곳 · ${BOOT.trip.start} 시작 · <span class="tt-meta-end">종료 예상 ${s.end}</span>`;
  if (vc) html += ` · <span class="tt-meta-viol">위반 ${vc}건</span>`;
  $('tripmeta').innerHTML = html;
}

function renderTabs() {
  const bar = $('headerTabs');
  bar.innerHTML = Object.keys(patterns).map(k => {
    const vc = schedules[k] ? Object.keys(schedules[k].violations).length : 0;
    return `<button class="pattab ${k === active ? 'active' : ''}${vc ? ' has-viol' : ''}" data-k="${k}">${esc(patterns[k].label)}<span class="pattab-viol ${vc ? 'bad' : 'ok'}">${vc ? '⚠' + vc : '✓'}</span></button>`;
  }).join('');
  bar.querySelectorAll('.pattab').forEach(b => b.onclick = () => switchPattern(b.dataset.k));
}

function switchPattern(k) {
  if (!patterns[k]) return;
  active = k; selected = null; render();
}

let dragIndex = null;
function renderStrip(s) {
  const strip = $('reorderStrip');
  strip.querySelectorAll('.rschip, .rschip-add').forEach(el => el.remove());
  const order = patterns[active].order;
  order.forEach((id, i) => {
    const viol = s.violations[id];
    const chip = document.createElement('span');
    chip.className = 'rschip' + (viol ? ' violating' : '');
    chip.draggable = true;
    chip.innerHTML = `<span class="rs-handle">${'<i></i>'.repeat(6)}</span><span class="rs-num">${i + 1}</span>${esc(SPOTS[id].name)}${viol ? ' ' + VIOLATION_ICON[viol.type] : ''}`;
    chip.addEventListener('click', (e) => { e.stopPropagation(); selectPin(id); });
    chip.addEventListener('dragstart', () => { dragIndex = i; chip.classList.add('dragging'); });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    chip.addEventListener('dragover', (e) => { e.preventDefault(); chip.classList.add('dragover-target'); });
    chip.addEventListener('dragleave', () => chip.classList.remove('dragover-target'));
    chip.addEventListener('drop', (e) => {
      e.preventDefault(); chip.classList.remove('dragover-target');
      if (dragIndex === null || dragIndex === i) return;
      saveUndo();
      const ord = patterns[active].order;
      const moved = ord.splice(dragIndex, 1)[0];
      ord.splice(i, 0, moved);
      patterns[active].modes = null;   // 재정렬 시 이동수단은 서버가 구간별 최단 수단으로 다시 배정
      dragIndex = null; selected = null;
      recomputeActive();
    });
    strip.appendChild(chip);
  });
  const add = document.createElement('span');
  add.className = 'rschip-add';
  add.innerHTML = '<b>+</b> 스팟 추가';
  add.onclick = (e) => { e.stopPropagation(); openCuration(); };
  strip.appendChild(add);
}

/* ===================== 지도 ===================== */
let map = null, overlayHelper = null;
const mapObjs = { markers: {}, lines: [], pills: [] };

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
    const bounds = new google.maps.LatLngBounds();
    Object.values(SPOTS).forEach(s => bounds.extend({ lat: s.lat, lng: s.lng }));
    map.fitBounds(bounds, { top: 60, bottom: 110, left: 60, right: 140 });
    map.addListener('click', () => { if (selected && Date.now() - lastPinSelect > 150) { selected = null; render(); } });
    map.addListener('idle', () => renderPopover(schedules[active]));
    if (schedules[active]) renderMap(schedules[active]);
  } catch (e) {
    console.error(e);
    window.mapUnavailable(String(e.message || e));
  }
};

function clearMapObjs() {
  mapObjs.lines.forEach(l => l.setMap(null));
  mapObjs.pills.forEach(p => { p.map = null; });
  mapObjs.lines = []; mapObjs.pills = [];
}

function pathFor(a, b, mode) {
  const l = leg(a, b, mode);
  if (l.polyline && google.maps.geometry) {
    let path = google.maps.geometry.encoding.decodePath(l.polyline);
    // 캐시는 정렬된 a→b 방향 하나만 있으므로, 반대 방향이면 뒤집어서 그린다(모양은 같음)
    if ([a, b].sort()[0] !== a) path = path.slice().reverse();
    if (path.length >= 2) return { path, real: true };
  }
  return { path: [{ lat: SPOTS[a].lat, lng: SPOTS[a].lng }, { lat: SPOTS[b].lat, lng: SPOTS[b].lng }], real: false };
}

function renderMap(s) {
  if (!map || !google.maps.marker) return;
  const { AdvancedMarkerElement } = google.maps.marker;
  clearMapObjs();
  const order = patterns[active].order;

  // 경로선 + 구간 라벨
  s.rows.forEach((row, i) => {
    if (!row.to_next) return;
    const a = row.id, b = order[i + 1];
    const { path, real } = pathFor(a, b, row.to_next.mode);
    const line = new google.maps.Polyline({
      map, path, strokeColor: '#16140f', strokeOpacity: real ? 0.6 : 0, strokeWeight: 4,
      icons: real ? [] : [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.6, scale: 3 }, offset: '0', repeat: '12px' }],
    });
    mapObjs.lines.push(line);
    const mid = Array.isArray(path) ? path[Math.floor(path.length / 2)] : path;
    const midLL = real ? mid : { lat: (SPOTS[a].lat + SPOTS[b].lat) / 2, lng: (SPOTS[a].lng + SPOTS[b].lng) / 2 };
    const el = document.createElement('div');
    el.className = 'gpill' + (row.to_next.source === 'fallback' ? ' fallback' : '') + (s.violations[b] ? ' viol' : '');
    el.textContent = `${MODE_ICON[row.to_next.mode]}${row.to_next.min}분`;
    el.title = row.to_next.source === 'fallback' ? '고정값(실측 아님)' : 'Routes API 실측';
    mapObjs.pills.push(new AdvancedMarkerElement({ map, position: midLL, content: el, zIndex: 1 }));
  });

  // 핀: 순서 번호가 바뀌므로 매번 다시 만든다(4곳이라 비용 무시 가능)
  Object.values(mapObjs.markers).forEach(m => { m.map = null; });
  mapObjs.markers = {};
  order.forEach((id, i) => {
    const sp = SPOTS[id];
    const viol = s.violations[id];
    const el = document.createElement('div');
    el.className = 'gpin' + (selected === id ? ' selected' : '');
    el.innerHTML = `<span class="gpin-ring">${i + 1}</span><span class="gpin-name">${esc(sp.name)}</span>${viol ? `<span class="gpin-viol">${VIOLATION_ICON[viol.type]}</span>` : ''}`;
    const m = new AdvancedMarkerElement({ map, position: { lat: sp.lat, lng: sp.lng }, content: el, zIndex: 10, title: sp.name, gmpClickable: true });
    // 최신 Maps는 'gmp-click' 이벤트, 구버전·테스트 스텁은 addListener('click')
    if (typeof m.addEventListener === 'function') m.addEventListener('gmp-click', () => selectPin(id));
    else m.addListener('click', () => selectPin(id));
    mapObjs.markers[id] = m;
  });
}

/* ===================== 핀 팝오버(편집) ===================== */
let lastPinSelect = 0;   // 핀 클릭 직후 지도 클릭 이벤트가 같이 와서 선택이 풀리는 것을 막음
function selectPin(id) {
  lastPinSelect = Date.now();
  selected = (selected === id) ? null : id;
  render();
}

function renderPopover(s) {
  const el = $('pinpop');
  if (!selected || !s) { el.hidden = true; return; }
  const order = patterns[active].order;
  const idx = order.indexOf(selected);
  if (idx < 0) { selected = null; el.hidden = true; return; }
  const sp = SPOTS[selected];
  const row = s.rows[idx];
  const viol = s.violations[selected];
  let modeHtml = '<div class="pinpop-endnote">마지막 방문지 — 다음 구간 없음</div>';
  if (idx < order.length - 1) {
    const next = order[idx + 1];
    modeHtml = `<div class="pinpop-field"><div class="pinpop-field-label">다음 구간(→ ${esc(SPOTS[next].name)}) 이동수단</div><div class="modeselect">` +
      ['walk', 'bike', 'transit', 'car'].map(m => {
        const l = leg(selected, next, m);
        return `<button data-mode="${m}" class="${m === row.to_next.mode ? 'active' : ''}">${MODE_ICON[m]} ${MODE_LABEL[m]}<br>${l.min}분${l.source === 'fallback' ? '<span class="est"> 추정</span>' : ''}</button>`;
      }).join('') + '</div></div>';
  }
  el.innerHTML = `
    <div class="pinpop-top"><span class="pinpop-name">${idx + 1}. ${esc(sp.name)}</span><button class="pinpop-x" title="닫기">✕</button></div>
    <details class="citechip-wrap"><summary class="citechip ${sp.badge}">${esc(sp.badge_short)} <span class="citemark">[출처]</span></summary><div class="citepop">${esc(sp.badge_source)}</div></details>
    <div class="pinpop-desc">${esc(sp.desc)} · 도착 ${row.arrive} → 출발 ${row.depart}</div>
    ${viol ? `<div class="pinpop-violation">🕐 마감(${viol.close})보다 ${viol.over_by}분 늦게 도착해요.</div>` : ''}
    <div class="pinpop-field"><div class="pinpop-field-label">머무는 시간</div>
      <div class="dwellstepper"><button data-d="-5">−</button><span class="dw-val">${row.dwell}분</span><button data-d="5">+</button></div></div>
    ${modeHtml}`;
  el.querySelector('.pinpop-x').onclick = (e) => { e.stopPropagation(); selected = null; render(); };
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
  el.onclick = (e) => e.stopPropagation();
  el.hidden = false;
  positionPopover(el, sp);
}

function positionPopover(el, sp) {
  const stage = $('stage');
  const W = stage.clientWidth, H = stage.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
  let x = 16, y = 48;   // 지도가 없으면 왼쪽 위 고정
  const proj = overlayHelper && overlayHelper.getProjection();
  if (map && proj) {
    const p = proj.fromLatLngToContainerPixel(new google.maps.LatLng(sp.lat, sp.lng));
    x = p.x + 24; y = p.y - h / 2;
    if (x + w > W - 110) x = p.x - w - 24;            // 오른쪽 어드바이저 캐릭터 영역을 피함
  }
  x = Math.max(8, Math.min(x, W - w - 8));
  y = Math.max(40, Math.min(y, H - h - 70));          // 아래 순서 스트립을 피함
  el.style.left = x + 'px'; el.style.top = y + 'px';
}

/* ===================== 되돌리기 ===================== */
function saveUndo() {
  undo = { active, order: patterns[active].order.slice(), modes: patterns[active].modes.slice(), dwell: { ...dwell } };
  $('rsUndo').classList.add('enabled');
}
$('rsUndo').onclick = (e) => {
  e.stopPropagation();
  if (!undo) return;
  active = undo.active;
  patterns[active].order = undo.order; patterns[active].modes = undo.modes; dwell = undo.dwell;
  undo = null; selected = null;
  $('rsUndo').classList.remove('enabled');
  recomputeAll().then(() => toast('↺ 직전 상태로 되돌렸어요'));
};

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
  const v = Object.entries(s.violations);
  if (v.length) {
    openConfirm(`<div class="cp-warn">아직 <b>${v.length}건</b>의 위반이 남아 있어요.</div>` +
      v.map(([id, x]) => `<button class="cp-vrow" data-id="${id}"><span>🕐</span><span><b>${esc(SPOTS[id].name)}</b><span class="cp-vwhy">마감 ${x.close}보다 ${x.over_by}분 늦게 도착</span></span></button>`).join('') +
      `<div class="cp-hint">스팟을 누르면 그 핀으로 이동해요. 그대로 확정할 수도 있어요.</div>
       <div class="cp-row"><button class="cp-cancel">돌아가서 고치기</button><button class="cp-go">그래도 확정</button></div>`);
  } else {
    openConfirm(`<div class="cp-ok">위반 없이 검증을 통과했어요. <b>${esc(patterns[active].label)}</b>으로 확정할까요?</div>
      <div class="cp-row"><button class="cp-cancel">닫기</button><button class="cp-go">확정하기</button></div>`);
  }
  const pop = $('confirmPop');
  pop.querySelectorAll('.cp-vrow').forEach(r => r.onclick = () => { closeConfirm(); selected = r.dataset.id; render(); });
  pop.querySelector('.cp-cancel').onclick = closeConfirm;
  pop.querySelector('.cp-go').onclick = () => { closeConfirm(); toast('✓ 확정 — OAuth·캘린더 연동은 아직 연결 전이에요'); };
};

$('backToEdit').onclick = () => {
  openConfirm(`<div class="cp-title">편집으로 돌아갈까요?</div>
    <div class="cp-ok">날짜는 검증하고 나면 잠겨요. 바꾸려면 검증 전 상태로 돌아가야 해요.<br><br>지금 보고 있는 <b>${esc(patterns[active].label)}</b>의 순서가 그대로 목록에 담겨요.</div>
    <div class="cp-row"><button class="cp-cancel">취소</button><button class="cp-go neutral">편집으로 돌아가기</button></div>`);
  $('confirmPop').querySelector('.cp-cancel').onclick = closeConfirm;
  $('confirmPop').querySelector('.cp-go').onclick = () => { closeConfirm(); toast('↩ 입력화면은 아직 이 저장소에 없어요'); };
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

/* ===================== 스팟 추가 데모(무거운 재검증 로딩 연출) ===================== */
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
    appendAdvisor(`"${esc(name)}"${josa(name, "을", "를").slice(name.length)} 담았어요. <i>(지도·순서 반영은 스팟 추가 API 연결 후 동작해요)</i>`);
    if (closed) appendAdvisor(`참고로 <b>"${esc(name)}"</b>${josa(name, "은", "는").slice(name.length)} ${BOOT.trip.date_label}에 휴무예요. 그래도 담았고, 확정하기 전에 한 번 더 알려드릴게요.`);
  }, 650);
  tick();
}

/* ===================== 큐레이션 모달 ===================== */
function openCuration() {
  $('cmSearchInput').value = '';
  $('curationBackdrop').hidden = false;
  htmx.trigger(document.body, 'cm-refresh');
}
function closeCuration() { $('curationBackdrop').hidden = true; $('cmAutocomplete').hidden = true; }
$('cmClose').onclick = closeCuration;
$('curationBackdrop').onclick = (e) => { if (e.target.id === 'curationBackdrop') closeCuration(); };
$('cmChatBtn').onclick = () => { closeCuration(); openPanel(); $('chatInput').focus(); appendAdvisor('어디를 추가하고 싶으신가요? 장소명을 입력해주세요.'); };

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
  } else if (addBtn) {
    addedCount++; $('cmCount').textContent = `${addedCount}곳 담음`;
    closeCuration();
    runAddSpotDemo(addBtn.dataset.name, !!addBtn.dataset.closed);
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

/* ===================== 시작 ===================== */
(async function init() {
  await recomputeAll();
  appendAdvisor('이 순서로 검증해봤어요. <b>핀을 누르면</b> 머무는 시간이나 다음 구간 이동수단을 바꿀 수 있고, <b>아래 순서 칩</b>은 드래그하면 순서를 바꿀 수 있어요.');
  const s = schedules.mine;
  const v = Object.entries(s.violations);
  if (v.length) {
    const [id, x] = v[0];
    const chips = Object.keys(patterns).filter(k => k !== 'mine').map(k => ({
      label: `${patterns[k].label}: ${patterns[k].order.map(i => SPOTS[i].name).join('→')}`,
      sub: `총 이동 ${schedules[k].total_travel}분 · ${Object.keys(schedules[k].violations).length ? '위반 있음' : '위반 없음'} · 종료 ${schedules[k].end}`,
      action: () => switchPattern(k),
    }));
    appendAdvisor(`다만 지금 순서로는 <b>${esc(SPOTS[id].name)} 도착이 마감(${x.close})보다 ${x.over_by}분 늦어요.</b> ${esc(josa(SPOTS[id].name, "을", "를"))} 먼저 들르는 대안 순서를 준비했어요. 위쪽 <b>패턴 탭</b>에서 언제든 비교할 수 있고, 눌러봐도 원래 내 패턴은 사라지지 않아요.`, chips);
  }
})().catch(err => { console.error(err); toast('일정 계산 서버에 연결하지 못했어요'); });

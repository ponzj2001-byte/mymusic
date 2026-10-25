'use strict';
/* 내 음악 — 나만 쓰는 음악 재생기 (설치형 웹앱)
   곡은 이 폰의 IndexedDB에만 보관하고, 어떤 서버로도 보내지 않는다. */

const $ = id => document.getElementById(id);
const audio = $('audio');

/* ===================== 저장소 (IndexedDB) ===================== */
// meta: 목록용 정보(가벼움), blobs: 실제 음악 파일 — 목록을 읽을 때 파일까지 끌어오지 않도록 나눔
let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('my-music', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장 취소됨'));
  });
}
async function dbAllMeta() {
  const d = await openDB();
  return reqP(d.transaction('meta').objectStore('meta').getAll());
}
async function dbGetBlob(id) {
  const d = await openDB();
  return reqP(d.transaction('blobs').objectStore('blobs').get(id));
}
async function dbPut(meta, blob) {
  const d = await openDB();
  const t = d.transaction(['meta', 'blobs'], 'readwrite');
  t.objectStore('blobs').put(blob, meta.id);
  t.objectStore('meta').put(meta);
  return txDone(t);
}
async function dbDelete(ids) {
  const d = await openDB();
  const t = d.transaction(['meta', 'blobs'], 'readwrite');
  for (const id of ids) {
    t.objectStore('meta').delete(id);
    t.objectStore('blobs').delete(id);
  }
  return txDone(t);
}

/* ===================== 설정 (localStorage) ===================== */
const DEFAULTS = {
  sortKey: 'name', sortDir: 'asc',
  shuffle: false, repeatOne: false, repeatChecked: false, loopAll: true,
  startNo: 1,
  stopOn: false, stopTime: '23:00', fadeSec: 10,
  lastId: null, lastPos: 0,
  checked: []
};
const S = Object.assign({}, DEFAULTS, loadJSON('mm-settings'));
function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; }
}
function saveSettings() {
  S.checked = [...checked];
  try { localStorage.setItem('mm-settings', JSON.stringify(S)); } catch (e) { /* 저장 불가 환경 */ }
}

/* ===================== 상태 ===================== */
let tracks = [];            // 모든 곡의 meta
let sorted = [];            // 현재 정렬 순서
let byId = new Map();
const checked = new Set(S.checked);
let queue = [];             // 재생 순서(곡 id 배열)
let qi = -1;                // queue 안의 현재 위치 (-1: 현재 곡이 queue 밖)
let curId = null;           // 지금 불러온 곡
let curUrl = null;
let loadToken = 0;
let errStreak = 0;
let stopAt = null;          // 자동 멈춤 시각(ms)
let fading = false;
let seeking = false;
let lastSavedPos = 0;
let wantPlay = false;       // 재생 중이거나 다음 곡을 불러오는 중 (곡 사이 틈에도 true)

/* ===================== 도우미 ===================== */
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
function fmtBytes(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(2) + 'GB';
  if (b >= 1e6) return (b / 1e6).toFixed(1) + 'MB';
  return Math.round(b / 1e3) + 'KB';
}
function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function hasSrc() { return !!audio.getAttribute('src'); }

/* ===================== 불러오기 ===================== */
function readDuration(file) {
  // 재생 가능하면 길이(초), 이 폰에서 재생할 수 없는 형식이면 -1
  return new Promise(resolve => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = v => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = setTimeout(() => finish(0), 20000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (a.duration === Infinity) {
        // 일부 파일은 끝까지 가 봐야 길이를 앎
        a.ondurationchange = () => { if (isFinite(a.duration)) finish(a.duration); };
        a.currentTime = 1e9;
      } else {
        finish(isFinite(a.duration) ? a.duration : 0);
      }
    };
    a.onerror = () => finish(-1);
    a.src = url;
  });
}

async function importFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const known = new Set(tracks.map(t => t.name + '|' + t.size + '|' + t.lastModified));
  let added = 0, dup = 0, bad = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    toast(`불러오는 중 ${i + 1} / ${files.length}\n${f.name}`, 60000);
    const key = f.name + '|' + f.size + '|' + f.lastModified;
    if (known.has(key)) { dup++; continue; }
    const dur = await readDuration(f);
    if (dur < 0) { bad++; continue; }
    const meta = { id: newId(), name: f.name, size: f.size, type: f.type, lastModified: f.lastModified || Date.now(), duration: dur, addedAt: Date.now() };
    try {
      await dbPut(meta, f);
    } catch (e) {
      failed++;
      if (e && e.name === 'QuotaExceededError') {
        toast('폰 저장 공간이 부족해 더 불러올 수 없습니다', 4000);
        break;
      }
      continue;
    }
    known.add(key);
    tracks.push(meta);
    byId.set(meta.id, meta);
    added++;
    if (added % 5 === 0) refreshList();
  }
  refreshList();
  rebuildQueue();
  updateStorage();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  let msg = `${added}곡을 추가했습니다`;
  if (dup) msg += ` · 이미 있는 곡 ${dup}개 건너뜀`;
  if (bad) msg += ` · 재생할 수 없는 파일 ${bad}개 제외`;
  if (failed) msg += ` · 저장 실패 ${failed}개`;
  toast(msg, 4000);
}

/* ===================== 정렬 · 목록 그리기 ===================== */
const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
function sortTracks() {
  const dir = S.sortDir === 'asc' ? 1 : -1;
  const k = S.sortKey;
  sorted = [...tracks].sort((a, b) => {
    let c = k === 'date' ? a.lastModified - b.lastModified
          : k === 'dur' ? a.duration - b.duration
          : collator.compare(a.name, b.name);
    if (c === 0) c = collator.compare(a.name, b.name);
    return c * dir;
  });
}

function refreshList() {
  sortTracks();
  const html = sorted.map((t, i) => `
    <li data-id="${t.id}"${t.id === curId ? ' class="cur"' : ''}>
      <span class="no">${i + 1}</span>
      <input type="checkbox" class="ck" aria-label="체크"${checked.has(t.id) ? ' checked' : ''}>
      <div class="info">
        <div class="name">${esc(t.name)}</div>
        <div class="meta">${fmtTime(t.duration)} · ${fmtDate(t.lastModified)} · ${fmtBytes(t.size)}</div>
      </div>
      <button class="del" aria-label="삭제">🗑</button>
    </li>`).join('');
  $('list').innerHTML = html;
  $('emptyMsg').hidden = sorted.length > 0;
  $('startNo').max = Math.max(1, sorted.length);
  updateCounts();
  updateNow();
}

function markCurrent() {
  for (const li of $('list').querySelectorAll('li.cur')) li.classList.remove('cur');
  if (curId) {
    const li = $('list').querySelector(`li[data-id="${curId}"]`);
    if (li) li.classList.add('cur');
  }
}

function updateCounts() {
  const n = sorted.length, c = [...checked].filter(id => byId.has(id)).length;
  $('countInfo').textContent = c ? `${n}곡 · ${c}곡 체크` : `${n}곡`;
  const del = $('delChecked');
  del.disabled = c === 0;
  del.textContent = c ? `🗑 체크한 ${c}곡 삭제` : '🗑 체크한 곡 삭제';
  $('checkAll').checked = n > 0 && c === n;
  $('checkAll').indeterminate = c > 0 && c < n;
}

function updateStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  navigator.storage.estimate().then(e => {
    $('storageInfo').textContent = `앱 저장 공간 사용: ${fmtBytes(e.usage || 0)}`;
  }).catch(() => {});
}

/* ===================== 재생 순서(queue) ===================== */
function sourceList() {
  return S.repeatChecked ? sorted.filter(t => checked.has(t.id)) : sorted;
}
// startId 곡을 기준으로 재생 순서를 만든다
function buildQueue(startId) {
  const src = sourceList().map(t => t.id);
  const i = src.indexOf(startId);
  if (S.shuffle) {
    const rest = shuffleArr(src.filter(id => id !== startId));
    queue = i >= 0 ? [startId, ...rest] : rest;
    qi = i >= 0 ? 0 : -1;
  } else {
    queue = src;
    qi = i;
  }
}
// 정렬·체크·모드가 바뀌면 지금 곡은 그대로 두고 다음 순서만 다시 만든다
function rebuildQueue() {
  if (curId) buildQueue(curId);
  else { queue = []; qi = -1; }
}

function playId(id, opts) {
  buildQueue(id);
  playTrack(id, opts);
}

function startFromNumber(n) {
  if (!sorted.length) { toast('먼저 ‘➕ 불러오기’로 곡을 추가하세요'); return; }
  n = Math.min(Math.max(1, Math.floor(n) || 1), sorted.length);
  let t = sorted[n - 1];
  if (S.repeatChecked && !checked.has(t.id)) {
    // 체크곡 반복 중이면 그 번호부터 아래로 첫 번째 체크곡
    t = sorted.slice(n - 1).find(x => checked.has(x.id)) || sorted.find(x => checked.has(x.id));
  }
  if (t) playId(t.id);
}

function goNext(auto) {
  if (!queue.length) {
    if (!curId) return;
    buildQueue(curId);
    if (!queue.length) return;
  }
  let n = qi + 1;
  if (n >= queue.length) {
    if (auto && !(S.loopAll || S.repeatChecked)) {
      wantPlay = false;
      audio.pause();
      updatePlayBtn();
      toast('목록 끝까지 재생했습니다');
      return;
    }
    if (S.shuffle && queue.length > 1) {
      const last = queue[queue.length - 1];
      shuffleArr(queue);
      if (queue[0] === last) [queue[0], queue[1]] = [queue[1], queue[0]];
    }
    n = 0;
  }
  qi = n;
  playTrack(queue[n]);
}

function goPrev() {
  if (!queue.length) {
    if (!curId) return;
    buildQueue(curId);
    if (!queue.length) return;
  }
  let n = qi - 1;
  if (n < 0) n = queue.length - 1;
  qi = n;
  playTrack(queue[n]);
}

/* ===================== 재생 ===================== */
async function playTrack(id, { autoplay = true, at = 0 } = {}) {
  const meta = byId.get(id);
  if (!meta) return;
  if (autoplay) wantPlay = true;
  const token = ++loadToken;
  let blob;
  try { blob = await dbGetBlob(id); } catch (e) { blob = null; }
  if (token !== loadToken) return;            // 그 사이 다른 곡을 눌렀음
  if (!blob) { wantPlay = false; updatePlayBtn(); toast('파일을 찾을 수 없습니다: ' + meta.name); return; }

  const oldUrl = curUrl;
  curUrl = URL.createObjectURL(blob);
  curId = id;
  S.lastId = id;
  S.lastPos = at;
  lastSavedPos = at;
  saveSettings();
  if (!fading) audio.volume = 1;
  audio.src = curUrl;
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  if (at > 0) {
    audio.addEventListener('loadedmetadata', () => {
      if (token === loadToken) audio.currentTime = Math.min(at, Math.max(0, (audio.duration || at) - 1));
    }, { once: true });
  }
  updateNow();
  markCurrent();
  setMediaMeta(meta);
  if (autoplay) {
    if (S.stopOn && !stopAt) armStop();
    try { await audio.play(); }
    catch (e) {
      if (e.name !== 'AbortError') { if (token === loadToken) { wantPlay = false; updatePlayBtn(); } toast('재생 단추를 한 번 눌러 주세요'); }
    }
  }
}

function togglePlay() {
  if (wantPlay) {
    // 재생 중이거나 곡 사이(다음 곡 불러오는 중)면 멈춤
    wantPlay = false;
    ++loadToken;
    audio.pause();
    updatePlayBtn();
    return;
  }
  if (!hasSrc()) {
    if (curId && byId.has(curId)) playId(curId, { at: S.lastPos || 0 });
    else startFromNumber(S.startNo);
    return;
  }
  if (S.stopOn && !stopAt) armStop();
  wantPlay = true;
  audio.play().catch(e => { if (e.name !== 'AbortError') { wantPlay = false; updatePlayBtn(); toast('재생할 수 없습니다'); } });
}

function unloadAudio() {
  ++loadToken;
  wantPlay = false;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  }
  updatePlayBtn();
}

function updateNow() {
  const meta = curId && byId.get(curId);
  if (meta) {
    const no = sorted.findIndex(t => t.id === curId) + 1;
    $('npTitle').textContent = meta.name.replace(/\.[^.]+$/, '');
    let sub = `${no}번 / ${sorted.length}곡`;
    if (S.repeatChecked) sub += ' · 체크곡 반복';
    if (S.repeatOne) sub += ' · 한 곡 반복';
    if (S.shuffle) sub += ' · 랜덤';
    $('npSub').textContent = sub;
  } else {
    $('npTitle').textContent = tracks.length ? '재생할 곡을 고르세요' : '곡을 불러와 주세요';
    $('npSub').textContent = tracks.length ? '목록에서 곡 이름을 누르거나 ▶ 재생' : '아래 ‘➕ 불러오기’로 음악 파일을 추가';
    $('tCur').textContent = '0:00';
    $('tDur').textContent = '0:00';
    $('seek').max = 0;
    $('seek').value = 0;
  }
}

function updatePlayBtn() {
  const playing = wantPlay;
  $('icoPlay').hidden = playing;
  $('icoPause').hidden = !playing;
  $('playBtn').setAttribute('aria-label', playing ? '일시정지' : '재생');
  if ('mediaSession' in navigator && hasSrc()) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

/* 잠금 화면·알림창 조작 */
function setMediaMeta(meta) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.name.replace(/\.[^.]+$/, ''),
      artist: '내 음악',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  } catch (e) { /* 지원 안 함 */ }
}
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) { /* 지원 안 함 */ } };
  set('play', () => { if (!wantPlay) togglePlay(); });
  set('pause', () => { if (wantPlay) togglePlay(); });
  set('previoustrack', goPrev);
  set('nexttrack', () => goNext(false));
  set('seekto', d => { if (hasSrc() && isFinite(d.seekTime)) audio.currentTime = d.seekTime; });
}
let lastPosState = 0;
function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = Date.now();
  if (now - lastPosState < 1000) return;
  lastPosState = now;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: audio.playbackRate || 1 }); }
  catch (e) { /* 무시 */ }
}

/* ===================== 자동 멈춤 ===================== */
function nextOccurrence(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!isFinite(h) || !isFinite(m)) return null;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function armStop() {
  cancelFade();
  stopAt = S.stopOn ? nextOccurrence(S.stopTime) : null;
  renderStopInfo();
}
function cancelFade() {
  if (fading) { fading = false; audio.volume = 1; }
}
function stopTick() {
  if (!stopAt) return;
  const now = Date.now();
  const fadeMs = (Number(S.fadeSec) || 0) * 1000;
  if (now >= stopAt) {
    if (wantPlay) finishStop();
    else { stopAt = null; cancelFade(); renderStopInfo(); }   // 재생 중이 아니었으면 종료 화면 없이 해제
    return;
  }
  if (fadeMs > 0 && now >= stopAt - fadeMs && hasSrc() && !audio.paused) {
    fading = true;
    audio.volume = Math.max(0, Math.min(1, (stopAt - now) / fadeMs));
  }
}
function finishStop() {
  const when = S.stopTime;
  stopAt = null;
  const pos = hasSrc() ? audio.currentTime : S.lastPos;
  S.lastPos = pos || 0;
  saveSettings();
  unloadAudio();            // 소리 끄고 알림창의 재생 표시까지 내림
  fading = false;
  audio.volume = 1;
  renderStopInfo();
  $('endMsg').textContent = `${when} 자동 멈춤`;
  $('endResume').hidden = !curId;
  $('endScreen').hidden = false;
}
function renderStopInfo() {
  const info = $('stopInfo'), pill = $('timerPill');
  if (!S.stopOn) {
    info.innerHTML = '꺼짐 — 켜면 정한 시각에 소리를 줄이며 멈추고 재생을 끝냅니다.';
    pill.hidden = true;
    return;
  }
  if (!stopAt) {
    info.innerHTML = `재생을 시작하면 다음 <b>${esc(S.stopTime)}</b>에 멈춥니다.`;
    pill.hidden = true;
    return;
  }
  const left = Math.max(0, stopAt - Date.now()) / 1000;
  const d = new Date(stopAt);
  const today = d.toDateString() === new Date().toDateString();
  info.innerHTML = `<b>${today ? '오늘' : '내일'} ${esc(S.stopTime)}</b>에 멈춤 · 남은 시간 <b>${fmtTime(left)}</b>`;
  pill.hidden = false;
  pill.textContent = `⏰ ${S.stopTime} 멈춤 · ${fmtTime(left)} 남음`;
}

/* ===================== 모드 단추 ===================== */
function renderModes() {
  $('shuffleBtn').setAttribute('aria-pressed', S.shuffle);
  $('repOneBtn').setAttribute('aria-pressed', S.repeatOne);
  $('repChkBtn').setAttribute('aria-pressed', S.repeatChecked);
  for (const b of $('orderSeg').children) b.classList.toggle('on', (b.dataset.v === 'shuffle') === S.shuffle);
  $('loopAll').checked = S.loopAll;
  $('sortKey').value = S.sortKey;
  $('sortDir').textContent = S.sortDir === 'asc' ? '↑ 오름차순' : '↓ 내림차순';
  updateNow();
}
function setShuffle(on) {
  S.shuffle = on;
  saveSettings();
  rebuildQueue();
  renderModes();
  toast(on ? '랜덤 재생' : '순서대로 재생');
}

/* ===================== 삭제 ===================== */
async function deleteTracks(ids) {
  ids = ids.filter(id => byId.has(id));
  if (!ids.length) return;
  try { await dbDelete(ids); }
  catch (e) { toast('삭제하지 못했습니다'); return; }
  const gone = new Set(ids);
  if (curId && gone.has(curId)) {
    unloadAudio();
    curId = null;
    S.lastId = null;
    S.lastPos = 0;
  }
  tracks = tracks.filter(t => !gone.has(t.id));
  for (const id of ids) { byId.delete(id); checked.delete(id); }
  if (S.repeatChecked && checked.size === 0) S.repeatChecked = false;
  saveSettings();
  refreshList();
  rebuildQueue();
  renderModes();
  updateStorage();
  toast(`${ids.length}곡을 앱에서 삭제했습니다`);
}

/* ===================== 이벤트 연결 ===================== */
function bindEvents() {
  $('playBtn').onclick = togglePlay;
  $('nextBtn').onclick = () => goNext(false);
  $('prevBtn').onclick = goPrev;

  $('shuffleBtn').onclick = () => setShuffle(!S.shuffle);
  $('orderSeg').onclick = e => {
    const b = e.target.closest('button');
    if (b) setShuffle(b.dataset.v === 'shuffle');
  };
  $('repOneBtn').onclick = () => {
    S.repeatOne = !S.repeatOne;
    if (S.repeatOne && S.repeatChecked) { S.repeatChecked = false; rebuildQueue(); }
    saveSettings();
    renderModes();
    toast(S.repeatOne ? '지금 곡만 계속 반복' : '한 곡 반복 끔');
  };
  $('repChkBtn').onclick = () => {
    if (!S.repeatChecked && ![...checked].some(id => byId.has(id))) {
      toast('먼저 목록에서 반복할 곡을 체크하세요');
      return;
    }
    S.repeatChecked = !S.repeatChecked;
    if (S.repeatChecked) S.repeatOne = false;
    saveSettings();
    rebuildQueue();
    renderModes();
    toast(S.repeatChecked ? '체크한 곡만 반복' : '체크곡 반복 끔');
    // 지금 아무것도 안 나오면 체크곡 첫 곡부터 시작
    if (S.repeatChecked && (!hasSrc() || audio.paused) && !checked.has(curId)) {
      const first = sorted.find(t => checked.has(t.id));
      if (first) playId(first.id);
    }
  };
  $('loopAll').onchange = e => { S.loopAll = e.target.checked; saveSettings(); };

  $('startNo').value = S.startNo;
  $('startNo').onchange = e => {
    const v = Math.max(1, Math.floor(Number(e.target.value)) || 1);
    S.startNo = v;
    e.target.value = v;
    saveSettings();
  };
  $('startBtn').onclick = () => {
    const v = Math.max(1, Math.floor(Number($('startNo').value)) || 1);
    S.startNo = v;
    saveSettings();
    startFromNumber(v);
  };

  // 자동 멈춤
  $('stopTime').value = S.stopTime;
  $('stopOn').checked = S.stopOn;
  $('fadeSec').value = String(S.fadeSec);
  $('stopTime').onchange = e => {
    if (!e.target.value) { e.target.value = S.stopTime; return; }
    S.stopTime = e.target.value;
    saveSettings();
    if (S.stopOn) armStop(); else renderStopInfo();
  };
  $('stopOn').onchange = e => {
    S.stopOn = e.target.checked;
    saveSettings();
    if (S.stopOn) { armStop(); toast(`${S.stopTime}에 자동으로 멈춥니다`); }
    else { cancelFade(); stopAt = null; renderStopInfo(); toast('자동 멈춤 끔'); }
  };
  $('fadeSec').onchange = e => {
    S.fadeSec = Number(e.target.value) || 0;
    saveSettings();
    if (fading && S.fadeSec === 0) cancelFade();
  };

  // 정렬
  $('sortKey').onchange = e => { S.sortKey = e.target.value; saveSettings(); refreshList(); rebuildQueue(); };
  $('sortDir').onclick = () => {
    S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
    saveSettings();
    renderModes();
    refreshList();
    rebuildQueue();
  };

  // 불러오기
  $('importBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = async e => {
    const files = e.target.files;
    await importFiles(files);
    e.target.value = '';
  };

  // 체크 · 삭제
  $('checkAll').onchange = e => {
    if (e.target.checked) for (const t of sorted) checked.add(t.id);
    else checked.clear();
    if (S.repeatChecked && checked.size === 0) { S.repeatChecked = false; renderModes(); toast('체크한 곡이 없어 체크곡 반복을 껐습니다'); }
    saveSettings();
    for (const ck of $('list').querySelectorAll('.ck')) ck.checked = e.target.checked;
    updateCounts();
    if (S.repeatChecked) rebuildQueue();
  };
  $('delChecked').onclick = () => {
    const ids = [...checked].filter(id => byId.has(id));
    if (!ids.length) return;
    if (confirm(`체크한 ${ids.length}곡을 앱에서 삭제할까요?\n(폰에 있던 원본 파일은 그대로 남습니다)`)) deleteTracks(ids);
  };
  $('list').addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li) return;
    const id = li.dataset.id;
    if (e.target.classList.contains('ck')) {
      if (e.target.checked) checked.add(id); else checked.delete(id);
      if (S.repeatChecked && checked.size === 0) { S.repeatChecked = false; renderModes(); toast('체크한 곡이 없어 체크곡 반복을 껐습니다'); }
      saveSettings();
      updateCounts();
      if (S.repeatChecked) rebuildQueue();
      return;
    }
    if (e.target.closest('.del')) {
      const m = byId.get(id);
      if (m && confirm(`‘${m.name}’을(를) 앱에서 삭제할까요?\n(폰에 있던 원본 파일은 그대로 남습니다)`)) deleteTracks([id]);
      return;
    }
    if (e.target.closest('.info')) playId(id);
  });

  $('npBox').onclick = () => {
    const li = curId && $('list').querySelector(`li[data-id="${curId}"]`);
    if (li) li.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // 재생 위치
  const seek = $('seek');
  seek.addEventListener('input', () => { seeking = true; $('tCur').textContent = fmtTime(seek.value); });
  seek.addEventListener('change', () => {
    seeking = false;
    if (hasSrc()) audio.currentTime = Number(seek.value);
  });

  // 오디오
  audio.addEventListener('loadedmetadata', () => {
    $('seek').max = isFinite(audio.duration) ? audio.duration : 0;
    $('tDur').textContent = fmtTime(audio.duration);
  });
  audio.addEventListener('timeupdate', () => {
    if (!seeking) {
      $('seek').value = audio.currentTime;
      $('tCur').textContent = fmtTime(audio.currentTime);
    }
    updatePositionState();
    stopTick();
    if (Math.abs(audio.currentTime - lastSavedPos) >= 5) {
      lastSavedPos = audio.currentTime;
      S.lastPos = audio.currentTime;
      saveSettings();
    }
  });
  audio.addEventListener('play', () => { wantPlay = true; updatePlayBtn(); });
  audio.addEventListener('pause', () => {
    // 곡이 끝나서 멈춘 것은 다음 곡으로 넘어가는 중이므로 그대로 둠 (전화·이어폰 뽑힘 등은 멈춤으로 봄)
    if (!audio.ended) wantPlay = false;
    updatePlayBtn();
  });
  audio.addEventListener('playing', () => { errStreak = 0; });
  audio.addEventListener('ended', () => {
    if (S.repeatOne) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } else {
      goNext(true);
    }
  });
  audio.addEventListener('error', () => {
    if (!hasSrc()) return;
    const m = byId.get(curId);
    errStreak++;
    toast('재생할 수 없는 파일: ' + (m ? m.name : ''));
    if (errStreak < Math.max(1, queue.length)) setTimeout(() => goNext(true), 800);
    else { unloadAudio(); errStreak = 0; }
  });

  // 종료 화면
  $('endClose').onclick = () => { $('endScreen').hidden = true; };
  $('endResume').onclick = () => {
    $('endScreen').hidden = true;
    if (curId && byId.has(curId)) playId(curId, { at: S.lastPos || 0 });
  };

  // 화면으로 돌아왔을 때 시각이 이미 지났는지 확인
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { stopTick(); renderStopInfo(); } });
  window.addEventListener('pagehide', () => {
    if (hasSrc()) S.lastPos = audio.currentTime;
    saveSettings();
  });
}

/* ===================== 앱 설치 단추 ===================== */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvt = e;
  if (!matchMedia('(display-mode: standalone)').matches) $('installBtn').hidden = false;
});
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; installEvt = null; });

/* ===================== 시작 ===================== */
async function init() {
  bindEvents();
  setupMediaSession();
  $('installBtn').onclick = async () => {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch (e) { /* 무시 */ }
    installEvt = null;
    $('installBtn').hidden = true;
  };

  try {
    tracks = await dbAllMeta();
  } catch (e) {
    tracks = [];
    toast('저장소를 열 수 없습니다. 브라우저의 사이트 데이터 설정을 확인하세요.', 5000);
  }
  byId = new Map(tracks.map(t => [t.id, t]));
  for (const id of [...checked]) if (!byId.has(id)) checked.delete(id);
  if (S.repeatChecked && checked.size === 0) S.repeatChecked = false;

  renderModes();
  refreshList();
  renderStopInfo();          // 자동 멈춤은 재생을 시작할 때 다음 그 시각으로 맞춤
  updatePlayBtn();
  updateStorage();

  // 지난번 듣던 곡을 불러 둠(자동 재생은 하지 않음)
  if (S.lastId && byId.has(S.lastId)) playId(S.lastId, { autoplay: false, at: S.lastPos || 0 });

  setInterval(() => { stopTick(); if (S.stopOn) renderStopInfo(); }, 500);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();

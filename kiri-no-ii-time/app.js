'use strict';

const TICK_MS = 250;
const STEP_MIN = 5; // 5 分刻み。アナログ時計の数字 12 個の位置とちょうど一致する
const STEPS = 60 / STEP_MIN;
const SOUND_KEY = 'timer:kiri-no-ii-time:sound'; // localStorage はドメイン全体で共有されるので、このタイマー専用のキーにする
// 押した瞬間より先にある時刻だけを終点にする。ちょうどその分に入っている時は次の時間へ送るが、
// 境目を 0 秒にすると「17:40 に 40 分の目盛を押したら 1 秒後に終わる」が起きるので少し余裕を取る
const LEAD_MS = 10000;
const IDLE_MS = 2500; // 操作が途切れてから操作を隠すまで (countdown と同じ間)
// 扇の半径。縁の内側ぎりぎりまで。終わりの時刻は扇の終端がそのまま示すので、別の印は置かない。
// 目盛も数字も扇より後に描かれるので、扇の上に乗って読める
const WEDGE_R = 96.4;

const el = {
  kiri: document.getElementById('kiri'),
  wedge: document.getElementById('wedge'),
  wedgeEdge: document.getElementById('wedgeEdge'),
  ticks: document.getElementById('ticks'),
  labels: document.getElementById('labels'),
  hits: document.getElementById('hits'),
  aimLine: document.getElementById('aimLine'),
  hourHand: document.getElementById('hourHand'),
  minuteHand: document.getElementById('minuteHand'),
  leadMain: document.getElementById('leadMain'),
  leadSuffix: document.getElementById('leadSuffix'),
  remainValue: document.getElementById('remainValue'),
  noteLabel: document.getElementById('noteLabel'),
  resetBtn: document.getElementById('resetBtn'),
  soundToggle: document.getElementById('soundToggle'),
};

const state = {
  targetAt: 0, // 終わりの時刻 (epoch ms)。長さではなく時刻を持つのがこのタイマーの性格
  finished: false,
  soundOn: true,
};

let tickId = null;
let idleTimer = null;
let audioCtx = null;
// 読み上げ用のラベルを作り直した「分」。現在時刻ではなく LEAD_MS を足した時刻で数えるので、
// 行き先が次の時間へ送られる瞬間 (毎分 LEAD_MS 前) にちょうど作り直される。
// epoch からの通算分なので、時や日をまたいでも取り違えない
let labelKey = -1;
let aimingStep = null; // 指している目盛。境界をまたいだときに行き先を出し直すために覚えておく

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- 幾何 ----

// 角度は 12 時を 0 とした時計回りの度数で扱う (分がそのまま deg = 分 × 6 になる)。
// SVG の角度は 3 時が 0 なので、描くときだけ 90 度戻す
function pointAt(deg, r) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [100 + r * Math.cos(a), 100 + r * Math.sin(a)];
}

function line(el2, deg, r0, r1) {
  const [x0, y0] = pointAt(deg, r0);
  const [x1, y1] = pointAt(deg, r1);
  el2.setAttribute('x1', x0.toFixed(2));
  el2.setAttribute('y1', y0.toFixed(2));
  el2.setAttribute('x2', x1.toFixed(2));
  el2.setAttribute('y2', y1.toFixed(2));
}

// 中心から始まる扇。sweep が 360 度に届くと始点と終点が重なって何も描かれなくなるので、
// わずかに欠けさせる (最長でも 60 分 - LEAD なので実際には届かないが、丸め次第で触れうる)
function wedgePath(startDeg, sweepDeg, r) {
  if (sweepDeg <= 0.05) return '';
  const s = Math.min(sweepDeg, 359.9);
  const [x0, y0] = pointAt(startDeg, r);
  const [x1, y1] = pointAt(startDeg + s, r);
  return `M 100 100 L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${s > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

// 当たり判定用。目盛を中心にした 30 度の扇で、12 枚で盤面を隙間なく覆う
function sectorPath(centerDeg, halfDeg, r) {
  const [x0, y0] = pointAt(centerDeg - halfDeg, r);
  const [x1, y1] = pointAt(centerDeg + halfDeg, r);
  return `M 100 100 L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

// ---- 時刻 ----

function hhmm(date) {
  return date.getHours() + ':' + String(date.getMinutes()).padStart(2, '0');
}

// 残りは必ず 1 時間以内なので、時は持たない
function mmss(ms) {
  const total = Math.ceil(ms / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

// i 番目の目盛 (= i × 5 分) が指す、いま以降の最も近い時刻。
// 分針が 1 周しか無いので、どの目盛を押しても行き先は必ず 1 時間以内に決まる
function targetForStep(i) {
  const now = Date.now();
  const t = new Date(now);
  t.setMinutes(i * STEP_MIN, 0, 0);
  if (t.getTime() - now < LEAD_MS) t.setTime(t.getTime() + 3600000);
  return t.getTime();
}

// ---- 盤面を組む ----

function buildDial() {
  // 分目盛は 60 本。5 分ごと (= 押せる目盛) だけ長く太くして、選べる位置がひと目で分かるようにする。
  // 密に並ぶ細い線が、この盤面を「タイマーの目盛」ではなく「時計の文字盤」に見せる
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const tick = document.createElementNS(SVG_NS, 'line');
    tick.setAttribute('class', 'dial__tick' + (major ? ' dial__tick--major' : ''));
    line(tick, i * 6, major ? 80 : 82.5, 86);
    el.ticks.appendChild(tick);
  }

  // 数字は時 (1〜12)。分の数字ではないので「5 分の目盛を押す」ことは直接は言わないが、
  // 押せる位置には長い目盛が立っていて、押す前には行き先の時刻が盤面の下に出る。
  // ここを分 (00〜55) にすると 2 桁が 12 個並んで、文字盤としての品が出ない
  for (let h = 1; h <= 12; h++) {
    const [lx, ly] = pointAt(h * 30, 64);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('class', 'dial__label');
    label.setAttribute('x', lx.toFixed(2));
    label.setAttribute('y', ly.toFixed(2));
    label.textContent = String(h);
    el.labels.appendChild(label);
  }

  // 当たり判定は 5 分ごと。1 枚 30 度の扇が 12 枚で盤面を隙間なく覆う
  for (let i = 0; i < STEPS; i++) {
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('class', 'hit');
    hit.setAttribute('d', sectorPath(i * 30, 15, 97));
    hit.setAttribute('role', 'button');
    hit.setAttribute('tabindex', '0');
    hit.dataset.step = String(i);
    el.hits.appendChild(hit);
  }

  // 狙いの線を当たり判定の後ろへ回す。SVG は DOM の順で重なるので、これで最前面に出る
  el.hits.appendChild(el.aimLine);
}

// 読み上げ用のラベルは行き先の時刻そのものにする (「10 分の目盛」ではなく「18:10 まで」)。
// 分をまたいだときだけ作り直す
function refreshHitLabels() {
  const key = Math.floor((Date.now() + LEAD_MS) / 60000);
  if (key === labelKey) return;
  labelKey = key;
  // children には狙いの線も混ざっているので、当たり判定だけを拾う
  for (const hit of el.hits.querySelectorAll('.hit')) {
    const at = new Date(targetForStep(Number(hit.dataset.step)));
    hit.setAttribute('aria-label', hhmm(at) + ' まで');
  }
  // 指したまま境界をまたぐと、盤面の上の一行が古い行き先のまま残る
  if (aimingStep !== null && phase() === 'setting') {
    setLead(hhmm(new Date(targetForStep(aimingStep))), 'まで');
  }
}

// ---- 描画 ----

function phase() {
  if (el.kiri.classList.contains('is-running')) return 'running';
  if (el.kiri.classList.contains('is-finished')) return 'finished';
  return 'setting';
}

// 操作を出して、隠すまでの時計を張り直す。
// 隠すのは数えている間だけ。選ぶ場面と終わったあとは、操作そのものが用なので出したままにする
function revealControls() {
  el.kiri.classList.remove('is-idle');
  clearTimeout(idleTimer);
  if (phase() === 'running') {
    idleTimer = setTimeout(() => el.kiri.classList.add('is-idle'), IDLE_MS);
  }
}

function setPhase(name) {
  el.kiri.classList.remove('is-setting', 'is-running', 'is-finished');
  el.kiri.classList.add('is-' + name);
}

// 盤面の上の一行。時刻と「まで」で字の大きさが違うので、2 つに分けて入れる
function setLead(main, suffix) {
  el.leadMain.textContent = main;
  el.leadSuffix.textContent = suffix || '';
}

function setTitle(text) {
  document.title = text ? text + ' - キリのいい時間まで' : 'キリのいい時間まで';
}

function renderClock(now) {
  const m = now.getMinutes() + now.getSeconds() / 60;
  const h = (now.getHours() % 12) + m / 60;
  line(el.hourHand, h * 30, 0, 48);
  line(el.minuteHand, m * 6, 0, 72);
  return m;
}

function render() {
  const now = new Date();
  const minuteDeg = renderClock(now) * 6;

  if (phase() !== 'running') return;

  const remaining = Math.max(0, state.targetAt - now.getTime());
  // 扇の始まりは現在の分針、長さは残り時間ぶん。終わり側は選んだ時刻に釘付けになり、
  // 始まり側だけが進むので、扇は終点に向かって細くなっていく
  el.wedge.setAttribute('d', wedgePath(minuteDeg, (remaining / 3600000) * 360, WEDGE_R));

  const text = mmss(remaining);
  el.remainValue.textContent = text;
  setTitle(text);
}

// ---- 音 ----

function storedSound() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'; // 保存が無いときは鳴らす側を既定にする
  } catch {
    return true; // プライベートモードなどで localStorage が使えないことがある
  }
}

function applySound(on) {
  state.soundOn = on;
  el.soundToggle.setAttribute('aria-pressed', String(on));
}

function selectSound(on) {
  applySound(on);
  if (on) ensureAudio(); // 切り替えはユーザー操作なので、ここで音声を解錠しておく
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // 保存できなくても、このセッションの設定は切り替わる
  }
}

function ensureAudio() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!audioCtx) audioCtx = new AudioCtor();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// 下降する 2 音を 2 回。zen の鈴ほど余韻を引かず、countdown の 880Hz 三連ほど尖らせない。
// 話している人の声をまたいで届く必要があるので、減衰は短く、音程は会話の高さから外す
function playChime() {
  if (!state.soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const base = ctx.currentTime + 0.05;
  const notes = [
    { freq: 784, at: 0 },    // G5
    { freq: 523.25, at: 0.3 }, // C5
    { freq: 784, at: 0.75 },
    { freq: 523.25, at: 1.05 },
  ];
  for (const { freq, at } of notes) {
    const start = base + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.65);
  }
}

// ---- 進行 ----

function choose(step) {
  ensureAudio(); // 目盛を押すのはユーザー操作。ここで音声を解錠しておく
  state.targetAt = targetForStep(step);
  state.finished = false;

  const at = new Date(state.targetAt);
  // 扇の終わり側の境界を引く。始まり側は現在時刻とともに進むが、この辺は選んだ時刻に釘付けになる
  line(el.wedgeEdge, at.getMinutes() * 6, 0, WEDGE_R);
  // 終わりの時刻は選ぶ前も選んだ後も盤面の上。hover のプレビューがそのまま居座る形にして、
  // 押した瞬間に文字が下へ飛ばないようにする
  setLead(hhmm(at), 'まで');
  // 大きな数字は残り時間なので、その意味を一語だけ下に添える
  el.noteLabel.textContent = 'のこり';
  el.hits.classList.remove('is-aiming'); // 数え始めたら狙いの線は用済み
  aimingStep = null;
  setPhase('running');
  revealControls();
  // 目盛はこのあと画面から外れる。キーボードで選んだときにフォーカスが body へ落ちないよう、
  // この場面で唯一押せるものへ移す
  el.resetBtn.focus();
  render();
}

function finish() {
  state.finished = true;
  setPhase('finished');
  revealControls();
  // 上の「◯◯まで」は据え置き。下は 0:00 で止めて、添えの語だけを終わりの合図に差し替える
  el.remainValue.textContent = mmss(0);
  el.noteLabel.textContent = '時間になりました';
  el.wedge.setAttribute('d', '');
  setTitle();
  playChime();
}

function toSetting() {
  aimingStep = null;
  setPhase('setting');
  revealControls();
  state.targetAt = 0;
  state.finished = false;
  el.wedge.setAttribute('d', '');
  setLead('何分までやる？');
  el.noteLabel.textContent = '';
  setTitle();
  render();
}

function tick() {
  refreshHitLabels();
  if (phase() === 'running' && Date.now() >= state.targetAt) {
    finish();
    return;
  }
  render();
}

// ---- イベント ----

buildDial();

el.hits.addEventListener('click', (event) => {
  const hit = event.target.closest('.hit');
  if (hit) choose(Number(hit.dataset.step));
});

// 押す前に行き先を見せる。盤面の上の一行をその時刻に差し替え、
// 同時に扇を二等分する線でどの目盛に付くのかを盤面の上でも示す
function preview(hit) {
  if (phase() !== 'setting') return;
  const step = Number(hit.dataset.step);
  aimingStep = step;
  setLead(hhmm(new Date(targetForStep(step))), 'まで');
  line(el.aimLine, step * 30, 0, 96);
  el.hits.classList.add('is-aiming');
}

function clearPreview() {
  if (phase() !== 'setting') return;
  aimingStep = null;
  setLead('何分までやる？');
  el.hits.classList.remove('is-aiming');
}

el.hits.addEventListener('mouseover', (event) => {
  const hit = event.target.closest('.hit');
  if (hit) preview(hit);
});

el.hits.addEventListener('mouseout', (event) => {
  if (event.target.closest('.hit')) clearPreview();
});

el.hits.addEventListener('focusin', (event) => {
  const hit = event.target.closest('.hit');
  if (hit) preview(hit);
});

el.hits.addEventListener('focusout', clearPreview);

// SVG の path は button ではないので、Enter と Space は自分で拾う
el.hits.addEventListener('keydown', (event) => {
  const hit = event.target.closest('.hit');
  if (!hit) return;
  if (event.key !== 'Enter' && event.code !== 'Space') return;
  event.preventDefault();
  choose(Number(hit.dataset.step));
});

el.resetBtn.addEventListener('click', toSetting);

el.soundToggle.addEventListener('click', () => selectSound(!state.soundOn));

// 触っていれば出る。countdown と同じく、動かすか押すかで戻す
for (const type of ['mousemove', 'pointerdown']) {
  document.addEventListener(type, revealControls);
}

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    toSetting();
  }
});

// バックグラウンドで setInterval が間引かれても、復帰時に正しい状態へ揃える。
// 終わりが時刻で決まっているので、間引かれている間に過ぎていれば復帰した瞬間に終わる
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

applySound(storedSound());
refreshHitLabels();
render();
tickId = setInterval(tick, TICK_MS);

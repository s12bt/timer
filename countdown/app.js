'use strict';

const TICK_MS = 200;
const MAX_MINUTES = 999;
const MAX_SECONDS = MAX_MINUTES * 60 + 59; // 入力欄が表せる上限 999:59
const THEME_KEY = 'timer-theme';
const IDLE_MS = 2500;      // 操作が途切れてから UI を隠すまで
const FIT_WIDTH = 0.92;    // 数字が使ってよい画面幅の割合
const FIT_HEIGHT = 0.72;   // 同 高さ
const UI_GAP = 12;         // 数字と下部の操作 UI の間に最低限空ける距離

const el = {
  setupScreen: document.getElementById('setupScreen'),
  runScreen: document.getElementById('runScreen'),
  setup: document.getElementById('setup'),
  display: document.getElementById('display'),
  runStatus: document.getElementById('runStatus'),
  progress: document.getElementById('progress'),
  minutes: document.getElementById('minutes'),
  seconds: document.getElementById('seconds'),
  presets: document.getElementById('presets'),
  startBtn: document.getElementById('startBtn'),
  clearBtn: document.getElementById('clearBtn'),
  primaryBtn: document.getElementById('primaryBtn'),
  pauseOverlay: document.getElementById('pauseOverlay'),
  runUi: document.getElementById('runUi'),
  runHintAction: document.getElementById('runHintAction'),
  backBtn: document.getElementById('backBtn'),
  setupHint: document.getElementById('setupHint'),
  notifyToggle: document.getElementById('notifyToggle'),
  themeSwitch: document.getElementById('themeSwitch'),
};

const state = {
  durationMs: 0,   // 開始時に確定した合計時間
  remainingMs: 0,  // 停止中の残り時間
  endAt: 0,        // 実行中の終了時刻 (epoch ms)
  running: false,
  finished: false,
};

let tickId = null;
let idleTimer = null;
let audioCtx = null;
let lastTextLength = -1;

// ---- 時間の整形 ----

// 時の桁は持たない。60 分を超えたぶんは 70:00 のように分をそのまま増やして表す
function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s)}`;
}

function currentRemaining() {
  return state.running ? Math.max(0, state.endAt - Date.now()) : state.remainingMs;
}

// ---- 描画 ----

// 数字を画面いっぱいに拡大する。基準 font-size に対する倍率を transform で与える
function fitDisplay() {
  if (el.runScreen.hidden) return;
  el.display.style.transform = 'scale(1)';
  const rect = el.display.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // 数字は上下中央に置くので、下部の操作 UI が占める高さを上下両側から差し引く。
  // 横向きのスマホのように高さが低い画面で、数字とボタンが重ならないようにするため
  const uiReserve = window.innerHeight - el.runUi.getBoundingClientRect().top + UI_GAP;
  const maxHeight = Math.min(
    window.innerHeight * FIT_HEIGHT,
    window.innerHeight - uiReserve * 2
  );
  const scale = Math.min(
    (window.innerWidth * FIT_WIDTH) / rect.width,
    maxHeight / rect.height
  );
  el.display.style.transform = `scale(${scale})`;
}

function render() {
  const remaining = currentRemaining();
  const text = formatTime(remaining);

  // コロンだけ span で包み、CSS で視覚的な中心まで持ち上げる
  el.display.innerHTML = text.replace(/:/g, '<span class="display__colon">:</span>');
  if (text.length !== lastTextLength) {
    lastTextLength = text.length;
    fitDisplay(); // 桁数が変わったときだけ測り直す
  }

  const ratio = state.durationMs > 0 ? remaining / state.durationMs : 0;
  el.progress.style.transform = `scaleX(${ratio})`;

  if (state.running) document.title = `${text} - Timer`;
  else if (state.finished) document.title = 'Done - Timer';
  else document.title = 'Timer';
}

function setRunStatus(text) {
  el.runStatus.textContent = text;
}

// 主ボタンのラベルと Space キーの説明を揃える
function setPrimaryLabel(label) {
  el.primaryBtn.textContent = label;
  el.runHintAction.textContent = label;
}

// ---- 画面の切り替え ----

function showScreen(name) {
  const run = name === 'run';
  el.setupScreen.hidden = run;
  el.runScreen.hidden = !run;
  if (run) {
    lastTextLength = -1; // 表示直後は必ずフィットし直す
    render();
    revealControls();
  }
}

function revealControls() {
  el.runScreen.classList.remove('is-idle');
  clearTimeout(idleTimer);
  // 走っている間だけ隠す。一時停止中と終了後は出したままにする
  if (state.running) {
    idleTimer = setTimeout(() => el.runScreen.classList.add('is-idle'), IDLE_MS);
  }
}

// ---- 入力 ----

function clamp(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function inputMs() {
  return (
    clamp(el.minutes.value, 0, MAX_MINUTES) * 60000 +
    clamp(el.seconds.value, 0, 59) * 1000
  );
}

// 大きな数字を構成する 2 つの入力欄。分は 3 桁まで受け、60 分以上もそのまま持つ
const SEGMENTS = [
  { input: el.minutes, max: MAX_MINUTES, digits: 3 },
  { input: el.seconds, max: 59, digits: 2 },
];

// 桁数を CSS に渡し、入力欄の幅を中身に合わせる (2 桁未満でも 2 桁分は確保する)
function syncSegmentWidth(input) {
  input.style.setProperty('--seg-digits', Math.max(2, input.value.length));
}

function setSegment(input, n) {
  input.value = String(n).padStart(2, '0');
  syncSegmentWidth(input);
}

function normalizeSegment({ input, max }) {
  setSegment(input, clamp(input.value, 0, max));
}

function addSeconds(delta) {
  fillInputs(Math.min(inputMs() / 1000 + delta, MAX_SECONDS));
}

function fillInputs(totalSeconds) {
  setSegment(el.minutes, Math.floor(totalSeconds / 60));
  setSegment(el.seconds, totalSeconds % 60);
}

// ---- テーマ ----

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function storedTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null; // プライベートモードなどで localStorage が使えないことがある
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  for (const btn of el.themeSwitch.querySelectorAll('[data-theme-value]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeValue === theme));
  }
}

function selectTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 保存できなくても、このセッションの見た目は切り替わる
  }
}

// ---- 音と通知 ----

function ensureAudio() {
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!audioCtx) audioCtx = new AudioCtor();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playAlarm() {
  const ctx = ensureAudio();
  if (!ctx) return;
  const start = ctx.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const at = start + i * 0.6;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.5);
  }
}

function notifyFinished() {
  if (!el.notifyToggle.checked) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('Timer finished', {
    body: `${formatTime(state.durationMs)} has elapsed.`,
    tag: 'timer',
  });
}

// ---- タイマー制御 ----

function startCounting() {
  state.endAt = Date.now() + state.remainingMs;
  state.running = true;
  state.finished = false;

  el.runScreen.classList.remove('is-paused', 'is-finished');
  setPrimaryLabel('Pause');
  setRunStatus(''); // 通常進行中はラベルを出さず、数字だけを見せる

  clearInterval(tickId);
  tickId = setInterval(tick, TICK_MS);
  revealControls();
  render();
}

function resetSetupHint() {
  el.setupHint.innerHTML = '<kbd>Enter</kbd> to start';
}

function clearInputs() {
  fillInputs(0);
  resetSetupHint();
}

function startFromSetup() {
  const ms = inputMs();
  if (ms <= 0) {
    el.setupHint.textContent = 'Set at least 1 second';
    return;
  }
  resetSetupHint();

  ensureAudio(); // ユーザー操作のタイミングで音声を解錠しておく
  state.durationMs = ms;
  state.remainingMs = ms;
  showScreen('run');
  startCounting();
}

function pause() {
  if (!state.running) return;
  state.remainingMs = currentRemaining();
  state.running = false;
  clearInterval(tickId);
  tickId = null;

  el.runScreen.classList.add('is-paused');
  setPrimaryLabel('Resume');
  setRunStatus(''); // 一時停止はぼかしと再生アイコンで示す
  revealControls();
  render();
}

function restart() {
  state.remainingMs = state.durationMs;
  startCounting();
}

function finish() {
  state.running = false;
  state.finished = true;
  state.remainingMs = 0;
  clearInterval(tickId);
  tickId = null;

  el.runScreen.classList.remove('is-paused');
  el.runScreen.classList.add('is-finished');
  setPrimaryLabel('Restart');
  setRunStatus('Done');
  revealControls();
  render();

  playAlarm();
  notifyFinished();
}

function backToSetup() {
  state.running = false;
  state.finished = false;
  state.remainingMs = state.durationMs;
  clearInterval(tickId);
  tickId = null;
  clearTimeout(idleTimer);

  el.runScreen.classList.remove('is-paused', 'is-finished', 'is-idle');
  showScreen('setup');
  render();
}

function tick() {
  if (!state.running) return;
  if (Date.now() >= state.endAt) {
    finish();
    return;
  }
  render();
}

function primaryAction() {
  if (state.running) pause();
  else if (state.finished) restart();
  else startCounting();
}

// ---- イベント ----

el.startBtn.addEventListener('click', startFromSetup);
el.clearBtn.addEventListener('click', clearInputs);
el.setup.addEventListener('submit', (event) => {
  event.preventDefault(); // 開始は keydown 側で拾う。ここではリロードを止めるだけ
});

el.primaryBtn.addEventListener('click', primaryAction);
el.pauseOverlay.addEventListener('click', primaryAction);

// 画面のどこを押しても一時停止 / 再開できる。
// ボタンは自前のハンドラを持っているので二重発火させない。終了後は誤操作を避けて無効にする。
el.runScreen.addEventListener('click', (event) => {
  if (state.finished) return;
  if (event.target.closest('button')) return;
  primaryAction();
});
el.backBtn.addEventListener('click', backToSetup);

el.presets.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  addSeconds(Number(chip.dataset.add));
});

SEGMENTS.forEach((seg) => {
  const { input, max, digits: maxDigits } = seg;

  // クリックしただけで桁ごと選択され、そのまま上書き入力できる
  input.addEventListener('focus', () => input.select());
  input.addEventListener('pointerup', (event) => event.preventDefault());

  // 分は 3 桁まで伸びるので、桁が埋まっても次の欄へは送らない
  // (送ると 0500 と打ったときに 050 で確定してしまう)。移動は Tab / クリックで行う
  input.addEventListener('input', () => {
    const typed = input.value.replace(/\D/g, '').slice(0, maxDigits);
    input.value = typed;
    syncSegmentWidth(input);
    if (typed.length === maxDigits && Number(typed) > max) setSegment(input, max);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const step = event.key === 'ArrowUp' ? 1 : -1;
    const wrap = max + 1;
    setSegment(input, (clamp(input.value, 0, max) + step + wrap) % wrap);
    input.select();
  });

  input.addEventListener('blur', () => {
    normalizeSegment(seg);
    input.setSelectionRange(0, 0); // 選択範囲が残るとフォーカスが 2 箇所あるように見える
  });
});

el.themeSwitch.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-theme-value]');
  if (btn) selectTheme(btn.dataset.themeValue);
});

// 自分で選ぶまでは OS 側の設定に追従する
darkQuery.addEventListener('change', () => {
  if (!storedTheme()) applyTheme(darkQuery.matches ? 'dark' : 'light');
});

el.notifyToggle.addEventListener('change', async () => {
  if (!el.notifyToggle.checked) return;
  if (!('Notification' in window)) {
    el.notifyToggle.checked = false;
    el.setupHint.textContent = 'This browser does not support notifications';
    return;
  }
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') {
    el.notifyToggle.checked = false;
    el.setupHint.textContent = 'Notification permission was denied';
  }
});

for (const type of ['mousemove', 'pointerdown']) {
  el.runScreen.addEventListener(type, revealControls);
}

window.addEventListener('resize', fitDisplay);

// バックグラウンドで setInterval が間引かれても、復帰時に正しい状態へ揃える
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (el.runScreen.hidden) {
    if (event.key === 'Enter') {
      event.preventDefault();
      startFromSetup();
    }
    return;
  }

  revealControls();

  if (event.code === 'Space') {
    // ボタンにフォーカスがある間はネイティブのクリックに任せる (二重発火の防止)
    if (target instanceof Element && target.matches('button')) return;
    event.preventDefault();
    primaryAction();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    backToSetup();
  }
});

applyTheme(storedTheme() || (darkQuery.matches ? 'dark' : 'light'));
SEGMENTS.forEach(normalizeSegment);
render();

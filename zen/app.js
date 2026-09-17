'use strict';

const TICK_MS = 200;
const MAX_MINUTES = 999;
const MAX_SECONDS = MAX_MINUTES * 60 + 59;
const SOUND_KEY = 'timer:zen:sound'; // localStorage はドメイン全体で共有されるので、このタイマー専用のキーにする
const DROP_MS = 15000; // 水滴の間隔。残り時間には連動させない (連動させると滴の数を数えられてしまう)
// 円の下の一行が消えるまでの時間。style.css の .whisper の transition と揃えること
const WHISPER_FADE_MS = 800;

const el = {
  zen: document.getElementById('zen'),
  ripples: document.getElementById('ripples'),
  ringLine: document.getElementById('ringLine'),
  minutes: document.getElementById('minutes'),
  seconds: document.getElementById('seconds'),
  presets: document.getElementById('presets'),
  clearBtn: document.getElementById('clearBtn'),
  beginBtn: document.getElementById('beginBtn'),
  hint: document.getElementById('hint'),
  whisper: document.getElementById('whisper'),
  whisperText: document.getElementById('whisperText'),
  resetBtn: document.getElementById('resetBtn'),
  soundCheck: document.getElementById('soundCheck'),
  notifyToggle: document.getElementById('notifyToggle'),
};

const state = {
  durationMs: 0,
  remainingMs: 0,
  endAt: 0,
  running: false,
  finished: false,
  soundOn: true,
};

let tickId = null;
let setupMs = 0; // 設定画面で組み立て中の時間
let lastDropIndex = 0; // 残りが下りきった格子の番号。開始位置は resetDropGrid() で済んだ扱いにする
let teachId = null;
let whisperClearId = null;
let audioCtx = null;

const RING_LENGTH = 2 * Math.PI * el.ringLine.r.baseVal.value;

// ---- 状態 ----

function phase() {
  if (el.zen.classList.contains('is-running')) return 'running';
  if (el.zen.classList.contains('is-paused')) return 'paused';
  if (el.zen.classList.contains('is-finished')) return 'finished';
  return 'setting';
}

// 数字は同じ要素のまま、編集できるかどうかだけが変わる
function setPhase(name) {
  el.zen.classList.remove('is-setting', 'is-running', 'is-paused', 'is-finished');
  el.zen.classList.add('is-' + name);
  // 終了後は操作が戻るので数字も編集できるようにする。触れないのは計測中と一時停止中だけ
}

// ---- 描画 ----

function currentRemaining() {
  return state.running ? Math.max(0, state.endAt - Date.now()) : state.remainingMs;
}



// 表示専用。分は 3 桁まで伸びる
function showTime(totalSeconds) {
  el.minutes.textContent = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  el.seconds.textContent = String(totalSeconds % 60).padStart(2, '0');
}

function render() {
  const remaining = currentRemaining();
  showTime(Math.ceil(remaining / 1000));
  // 残りが減るほど円周の線が短くなる
  const ratio = state.durationMs > 0 ? remaining / state.durationMs : 0;
  el.ringLine.style.strokeDashoffset = String(RING_LENGTH * (1 - ratio));
}

// 円の下の一行。常設の操作を置かずに、必要な場面だけ言葉を出す
function whisper(text, withReset) {
  clearTimeout(whisperClearId);
  if (text) {
    el.whisperText.textContent = text;
    el.whisper.classList.toggle('has-reset', Boolean(withReset));
    el.zen.classList.add('has-whisper');
    return;
  }
  // 文言は残したまま薄れさせ、消えきってから空にする。
  // 同時に空にすると、フェードする対象が無くなって一瞬で消えたように見える
  el.zen.classList.remove('has-whisper');
  whisperClearId = setTimeout(() => {
    el.whisperText.textContent = '';
    el.whisper.classList.remove('has-reset');
  }, WHISPER_FADE_MS);
}

function resetHint() {
  el.hint.innerHTML = '<kbd>Enter</kbd> to begin';
}

// ---- 水滴 ----

// 1 滴につき複数の輪を少しずつ遅らせて出す。実際の水面と同じく、1 滴は 1 本の輪では終わらない
// 波紋は 1 種類。形も速さも共通で、濃さだけ呼び出し側で弱められる (strength)
function drop(strength = 1) {
  for (let i = 0; i < 3; i++) {
    const ring = document.createElement('span');
    ring.className = 'ripple';
    // 輪の間隔は「速度 × 遅延」で決まる。速度を変えたら遅延も同じ比率で割り、間隔の見え方を保つ
    ring.style.animationDelay = (i * 0.95) + 's';
    // 進む距離は同じで時間だけを変えることで、先頭の輪が一番速く、後ろほど遅くなる。
    // 実際の水面と同じく、輪と輪の間隔は時間とともに開いていく
    ring.style.animationDuration = (9 + i * 2.2) + 's';
    ring.style.setProperty('--a', String(0.08 * strength * (1 - i * 0.2)));
    ring.addEventListener('animationend', () => ring.remove());
    el.ripples.appendChild(ring);
  }
}

// 格子は開始側ではなく終了側に合わせる。残りが 15 秒の倍数を下るたびに打つので、
// どんな長さでも最後の通常の滴は必ず終わりの 15 秒前に来る (終わり際に重なる心配が要らない)。
// ちょうど 15 の倍数の長さ (1 分など) で開始と同時に打たないよう、開始位置は ceil - 1 で済んだ扱いにする
function resetDropGrid() {
  lastDropIndex = Math.ceil(state.durationMs / DROP_MS) - 1;
}

// 残りからの判定なので、一時停止しても再開直後に余分な一滴は落ちず、背面タブでの間引きにも影響されない。
// 格子をまたいで戻ってきたときも、溜めずに 1 滴だけ打つ
function dropIfDue() {
  const index = Math.floor(currentRemaining() / DROP_MS);
  if (index >= lastDropIndex) return;
  lastDropIndex = index;
  drop();
}

// ---- 入力 ----

function clamp(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}




function addSeconds(delta) {
  setupMs = Math.min(setupMs + delta * 1000, MAX_SECONDS * 1000);
  showTime(Math.round(setupMs / 1000));
}

// URL の ?t= で初期時間を受け取る。書式は countdown と揃える
function timeFromQuery() {
  const t = new URLSearchParams(window.location.search).get('t');
  const match = t && /^(?:m(\d+))?(?:s(\d+))?$/i.exec(t);
  if (!match) return null;
  const total = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  return total > 0 ? Math.min(total, MAX_SECONDS) : null;
}

// ---- 音と通知 ----

function storedSound() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off'; // 保存が無いときは鳴らす側を既定にする
  } catch {
    return true; // プライベートモードなどで localStorage が使えないことがある
  }
}

function applySound(on) {
  state.soundOn = on;
  el.soundCheck.checked = on;
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

// ラ (A3 = 220Hz) を基音に、1:2:3 の倍音を重ねて長く減衰させ、鈴に寄せる
// (countdown の 880Hz 三連はこの画面には硬すぎる)
function playBell() {
  if (!state.soundOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const at = ctx.currentTime + 0.05;
  const partials = [
    { freq: 220, gain: 0.20, decay: 6.0 },
    { freq: 440, gain: 0.10, decay: 4.2 },
    { freq: 660, gain: 0.045, decay: 2.8 },
  ];
  for (const { freq, gain: peak, decay } of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + decay + 0.1);
  }
}

function notifyFinished() {
  if (!el.notifyToggle.checked) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const total = Math.round(state.durationMs / 1000);
  new Notification('Zen', {
    body: String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0') + ' has elapsed.',
    tag: 'zen',
  });
}

// ---- 進行 ----

function startCounting() {
  state.endAt = Date.now() + state.remainingMs;
  state.running = true;
  state.finished = false;
  setPhase('running');
  resetHint();
  whisper('');

  clearInterval(tickId);
  tickId = setInterval(tick, TICK_MS);
  render();
}

function begin() {
  const ms = setupMs;
  if (ms <= 0) {
    el.hint.textContent = 'Set at least 1 second';
    return;
  }
  if (state.soundOn) ensureAudio(); // ユーザー操作のタイミングで音声を解錠しておく
  state.durationMs = ms;
  state.remainingMs = ms;
  resetDropGrid();
  startCounting();

  // 操作の手がかりは常設せず、始まりの数秒だけ出して消す。再開のときは繰り返さない
  whisper('Tap anywhere to pause');
  clearTimeout(teachId);
  teachId = setTimeout(() => {
    if (phase() === 'running') whisper('');
  }, 4000);
}

function pause() {
  if (!state.running) return;
  state.remainingMs = currentRemaining();
  state.running = false;
  clearInterval(tickId);
  tickId = null;
  clearTimeout(teachId);
  setPhase('paused');
  whisper('Tap to resume', true);
  render();
}

function finish() {
  state.running = false;
  state.finished = true;
  state.remainingMs = 0;
  clearInterval(tickId);
  tickId = null;
  resetDropGrid();

  clearTimeout(teachId);
  setPhase('finished');
  whisper('');
  render();
  drop(); // 終わりの一滴
  playBell();
  notifyFinished();
  resetHint(); // 終わりは数字と最後の一滴が示す。文言は足さない
}

// 設定へ戻る。画面の入れ替えは無く、操作が戻って数字がまた編集できるようになるだけ
function toSetting() {
  state.running = false;
  state.finished = false;
  clearInterval(tickId);
  tickId = null;
  resetDropGrid();

  clearTimeout(teachId);
  state.remainingMs = state.durationMs;
  setPhase('setting');
  whisper('');
  setupMs = state.durationMs;
  showTime(Math.round(state.durationMs / 1000));
  el.ringLine.style.strokeDashoffset = String(RING_LENGTH);
  resetHint();
}

function tick() {
  if (!state.running) return;
  if (Date.now() >= state.endAt) {
    finish();
    return;
  }
  dropIfDue();
  render();
}

function toggleRun() {
  if (state.running) pause();
  else if (phase() === 'paused') startCounting();
}

// ---- イベント ----

el.beginBtn.addEventListener('click', begin);
el.resetBtn.addEventListener('click', toSetting);

el.clearBtn.addEventListener('click', () => {
  setupMs = 0;
  showTime(0);
  resetHint();
});

el.presets.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip || !chip.dataset.add) return;
  addSeconds(Number(chip.dataset.add));
});

// 計測中は操作が引いているので、面のどこを押しても止められる
el.zen.addEventListener('click', (event) => {
  if (phase() === 'setting' || phase() === 'finished') return;
  if (event.target.closest('button, input, label')) return;
  toggleRun();
});


el.soundCheck.addEventListener('change', () => selectSound(el.soundCheck.checked));

el.notifyToggle.addEventListener('change', async () => {
  if (!el.notifyToggle.checked) return;
  if (!('Notification' in window)) {
    el.notifyToggle.checked = false;
    el.hint.textContent = 'This browser does not support notifications';
    return;
  }
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') {
    el.notifyToggle.checked = false;
    el.hint.textContent = 'Notification permission was denied';
  }
});

// バックグラウンドで setInterval が間引かれても、復帰時に正しい状態へ揃える
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;

  if (event.key === 'Enter') {
    event.preventDefault();
    if (phase() === 'setting') begin();
    else if (phase() === 'finished') {
      state.remainingMs = state.durationMs;
      resetDropGrid();
      startCounting();
    }
    return;
  }

  if (event.code === 'Space') {
    if (target instanceof Element && target.matches('button')) return; // ネイティブのクリックに任せる
    if (phase() === 'setting') return;
    event.preventDefault();
    toggleRun();
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    toSetting();
  }
});

// 円は初期状態では空にしておく (計測が始まってから満ちた状態で現れる)
el.ringLine.style.strokeDasharray = String(RING_LENGTH);
el.ringLine.style.strokeDashoffset = String(RING_LENGTH);
applySound(storedSound());
const queryTime = timeFromQuery();
if (queryTime) setupMs = queryTime * 1000;
showTime(Math.round(setupMs / 1000));

// 読み込み直後に一度だけ水面を動かす。画面が生きていることを言葉ではなく波紋で伝える。
// 即時だと書体の読み込みと重なって演出に見えないので、少し置いてから落とす。
// 設定の操作を邪魔しないよう、この一滴だけ濃さを半分にする
setTimeout(() => drop(0.5), 500);

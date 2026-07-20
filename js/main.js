// エントリーポイント：ゲームループとステージ管理
import { STAGES } from './stages.js';
import * as ui from './ui.js';
import { stepPackets } from './packet.js';

const gameState = {
  stageIndex: 0,
  stageDef: null,
  stageRuntime: {},
  devices: [],
  edges: [],
  packets: [],
  selectedPacketId: null,
  playing: true,
  speed: 1,
  unlockedCount: 1,
  completed: false,
};

function render() {
  ui.renderNetwork(gameState, { onPacketClick, onEdgeClick });
  ui.renderPacketDetail(gameState);
  ui.renderTables(gameState);
}

// パケットのアニメーションだけを進める軽量更新（配線・ボタン・デバイスは再構築しない）。
// render() で毎フレーム svg.innerHTML を丸ごと作り直すと、ユーザーがボタンを
// クリックしている最中（mousedown〜click の間）に要素ごと消えてしまい、
// クリックが反応しないことがあったため分離した。
function renderPacketsOnly() {
  ui.renderPacketsOnly(gameState, { onPacketClick });
  ui.renderPacketDetail(gameState);
}

function onPacketClick(packetId) {
  gameState.selectedPacketId = packetId;
  render();
}

function onEdgeClick(edgeId) {
  const edge = gameState.edges.find((e) => e.id === edgeId);
  edge.connected = !edge.connected;
  ui.appendLog(edge.connected ? '配線を接続しました。' : '配線を抜きました。', edge.connected ? 'ok' : 'err');
  render();
}

const API = {
  log(message, cls) { ui.appendLog(message, cls); },
  render,
  refreshActions() {
    ui.renderStageActions(document.getElementById('stage-actions'), gameState.stageDef, gameState, API);
  },
  setStatus(text, cls) { ui.setMissionStatus(text, cls); },
  completeStage() {
    if (gameState.completed) return;
    gameState.completed = true;
    gameState.unlockedCount = Math.max(gameState.unlockedCount, gameState.stageIndex + 2);
    ui.renderStageNav(STAGES, gameState, loadStage);
  },
};

function loadStage(index) {
  if (index > gameState.unlockedCount - 1) return;
  const def = STAGES[index];
  const built = def.build();

  gameState.stageIndex = index;
  gameState.stageDef = def;
  gameState.devices = built.devices;
  gameState.edges = built.edges;
  gameState.stageRuntime = built.runtime;
  gameState.packets = [];
  gameState.selectedPacketId = null;
  gameState.completed = false;

  ui.clearLog();
  ui.renderDialogue(def);
  ui.renderMissionBanner(def);
  ui.renderStageNav(STAGES, gameState, loadStage);
  ui.renderStageActions(document.getElementById('stage-actions'), def, gameState, API);
  render();
}

document.getElementById('btn-play').addEventListener('click', () => { gameState.playing = true; });
document.getElementById('btn-pause').addEventListener('click', () => { gameState.playing = false; });
document.getElementById('btn-step').addEventListener('click', () => {
  if (gameState.packets.length === 0) {
    ui.appendLog('今は動いているパケットがありません。まず操作パネルのボタンでパケットを送ってみましょう。', 'err');
    return;
  }
  // 「1ステップ」＝今動いているパケットのうち、どれか1つが次の出来事
  // （到着・落下）を迎えるまで進める。固定の短い時間だけ進めると変化が
  // 小さすぎて分かりにくいため、細かく進め続けて変化を検知する。
  // 到着後すぐ次のホップへ中継されるケース（スイッチ経由など）でも
  // 正しく「1回分」で止められるよう、個数ではなく元のパケットIDで判定する。
  const startIds = new Set(gameState.packets.map((p) => p.id));
  for (let i = 0; i < 120; i += 1) {
    stepPackets(gameState, 0.05, gameState.speed);
    renderPacketsOnly();
    const anyOriginalGone = [...startIds].some((id) => !gameState.packets.some((p) => p.id === id));
    if (anyOriginalGone) break;
  }
});
document.getElementById('speed-slider').addEventListener('input', (ev) => {
  gameState.speed = parseFloat(ev.target.value);
});
document.getElementById('btn-reset').addEventListener('click', () => {
  loadStage(gameState.stageIndex);
});
function toggleSidebar() {
  document.getElementById('app-shell').classList.toggle('side-collapsed');
}
document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
document.getElementById('head-nav-toggle').addEventListener('click', toggleSidebar);
document.getElementById('side-backdrop').addEventListener('click', () => {
  document.getElementById('app-shell').classList.add('side-collapsed');
});

// 非表示タブでのスロットリングを避けるため setInterval を使用（rAFはバックグラウンドで停止しうる）。
// 画面のリフレッシュレート(60Hz)に対して更新が33ms(約30fps)おきだと、同じ位置が
// 2フレーム続けて描画されてから次の位置へ飛ぶため、動きが「カクカク」して見える。
// 16ms(約60fps)にして滑らかにする。
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - lastTick) / 1000, 0.25);
  lastTick = now;
  if (gameState.playing) {
    stepPackets(gameState, dt, gameState.speed);
    renderPacketsOnly();
  }
}, 16);

loadStage(0);
ui.renderBookRecommend();

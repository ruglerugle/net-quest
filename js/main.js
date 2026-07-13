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
  stepPackets(gameState, 0.2, gameState.speed);
  renderPacketsOnly();
});
document.getElementById('speed-slider').addEventListener('input', (ev) => {
  gameState.speed = parseFloat(ev.target.value);
});
document.getElementById('btn-reset').addEventListener('click', () => {
  loadStage(gameState.stageIndex);
});

// 非表示タブでのスロットリングを避けるため setInterval を使用（rAFはバックグラウンドで停止しうる）
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min((now - lastTick) / 1000, 0.25);
  lastTick = now;
  if (gameState.playing) {
    stepPackets(gameState, dt, gameState.speed);
    renderPacketsOnly();
  }
}, 33);

loadStage(0);

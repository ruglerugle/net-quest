// 画面描画（SVGネットワーク図・詳細パネル・テーブル・ログ・ミッションバナー・ステージナビ）
import { packetDetailRows } from './packet.js';
import { subnetColor } from './network.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const DEVICE_SIZE = {
  pc: { w: 78, h: 58 },
  server: { w: 92, h: 66 },
  switch: { w: 84, h: 50 },
  router: { w: 72, h: 72 },
  firewall: { w: 72, h: 72 },
};

/** デバイス種別ごとの簡易ラインアートアイコンを (cx, cy) を中心に描画する */
function appendDeviceIcon(g, type, cx, cy) {
  const icon = (tag, attrs) => g.appendChild(svgEl(tag, { class: 'device-icon', ...attrs }));
  if (type === 'pc') {
    icon('rect', { x: cx - 13, y: cy - 10, width: 26, height: 16, rx: 2 });
    icon('line', { x1: cx, y1: cy + 6, x2: cx, y2: cy + 10 });
    icon('line', { x1: cx - 8, y1: cy + 10, x2: cx + 8, y2: cy + 10 });
  } else if (type === 'switch') {
    icon('rect', { x: cx - 15, y: cy - 8, width: 30, height: 14, rx: 2 });
    for (let i = 0; i < 4; i += 1) {
      icon('rect', { x: cx - 11.5 + i * 7.3, y: cy + 1.5, width: 4, height: 3.5, class: 'device-icon filled' });
    }
  } else if (type === 'router') {
    icon('circle', { cx, cy: cy + 8, r: 1.8, class: 'device-icon filled' });
    icon('path', { d: `M ${cx - 3} ${cy + 3} A 5 5 0 0 1 ${cx + 3} ${cy + 3}` });
    icon('path', { d: `M ${cx - 6.5} ${cy - 1} A 10 10 0 0 1 ${cx + 6.5} ${cy - 1}` });
    icon('path', { d: `M ${cx - 10} ${cy - 5} A 15 15 0 0 1 ${cx + 10} ${cy - 5}` });
  } else if (type === 'firewall') {
    icon('rect', { x: cx - 13, y: cy - 9, width: 12, height: 7 });
    icon('rect', { x: cx + 1, y: cy - 9, width: 12, height: 7 });
    icon('rect', { x: cx - 13, y: cy - 1, width: 5, height: 7 });
    icon('rect', { x: cx - 7, y: cy - 1, width: 12, height: 7 });
    icon('rect', { x: cx + 8, y: cy - 1, width: 5, height: 7 });
  } else {
    // server / dhcp / dns 等
    icon('rect', { x: cx - 13, y: cy - 11, width: 26, height: 22, rx: 2 });
    icon('line', { x1: cx - 13, y1: cy - 3.7, x2: cx + 13, y2: cy - 3.7 });
    icon('line', { x1: cx - 13, y1: cy + 3.7, x2: cx + 13, y2: cy + 3.7 });
    icon('circle', { cx: cx - 9, cy: cy - 7.3, r: 1.1, class: 'device-icon filled' });
    icon('circle', { cx: cx - 9, cy: cy, r: 1.1, class: 'device-icon filled' });
    icon('circle', { cx: cx - 9, cy: cy + 7.3, r: 1.1, class: 'device-icon filled' });
  }
}

function deviceLabelSub(device, revealFields) {
  if (!revealFields.ip) return [];
  if (device.interfaces) return device.interfaces.map((i) => i.ip);
  if (device.ip) return [device.ip];
  return [];
}

export function resolveLabel(state, deviceId) {
  const d = state.devices.find((x) => x.id === deviceId);
  return d ? d.label : deviceId;
}

export function renderNetwork(state, handlers) {
  const svg = document.getElementById('network-svg');
  svg.innerHTML = '';
  const reveal = state.stageDef.revealFields;

  // 1. サブネットゾーン背景
  for (const zone of state.stageDef.zones ?? []) {
    const rect = svgEl('rect', {
      x: zone.x, y: zone.y, width: zone.w, height: zone.h,
      class: 'subnet-zone',
      fill: zone.color === 'blue' ? 'var(--blue-zone)' : 'var(--red-zone)',
    });
    svg.appendChild(rect);
    if (zone.label) {
      svg.appendChild(svgEl('text', {
        x: zone.x + 10, y: zone.y + 18, class: 'device-sub', 'text-anchor': 'start', fill: '#7d8bb0',
      })).textContent = zone.label;
    }
  }

  // 2. 配線（エッジ）
  for (const edge of state.edges) {
    const a = state.devices.find((d) => d.id === edge.a);
    const b = state.devices.find((d) => d.id === edge.b);
    const line = svgEl('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: `edge-line${edge.connected ? '' : ' disconnected'}`,
    });
    svg.appendChild(line);
    if (!edge.connected) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const brk = svgEl('text', { x: mx, y: my + 5, class: 'edge-break' });
      brk.textContent = '✕';
      svg.appendChild(brk);
    }
    if (state.stageDef.editableCables) {
      // 見た目の線（3px）はクリックしにくいので、太い透明な当たり判定を一番上に重ねる
      const hitArea = svgEl('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        class: 'edge-hit-area',
      });
      hitArea.addEventListener('click', () => handlers.onEdgeClick(edge.id));
      svg.appendChild(hitArea);
    }
  }

  // 3. パケット層（アニメーション中は毎フレーム更新されるので、配線やボタンとは
  //    独立したグループにしておく。svg.innerHTML='' で全体を作り直すと、
  //    クリック操作の途中（mousedown〜click）で当該要素ごと消えてしまい、
  //    クリックが反応しないことがあるため。
  const packetsLayer = svgEl('g', { id: 'packets-layer' });
  svg.appendChild(packetsLayer);
  renderPacketsInto(packetsLayer, state, handlers);

  // 4. デバイス
  for (const device of state.devices) {
    const size = DEVICE_SIZE[device.type] ?? DEVICE_SIZE.pc;
    const x0 = device.x - size.w / 2;
    const y0 = device.y - size.h / 2;
    const g = svgEl('g', {});

    let shape;
    if (device.type === 'router' || device.type === 'firewall') {
      shape = svgEl('circle', { cx: device.x, cy: device.y, r: size.w / 2, class: 'device-box' });
    } else {
      shape = svgEl('rect', {
        x: x0, y: y0, width: size.w, height: size.h, rx: 10, class: 'device-box',
      });
    }
    const zoneColor = device.ip ? subnetColor(device.ip) : null;
    if (zoneColor === 'blue' || zoneColor === 'red') {
      shape.setAttribute('stroke', zoneColor === 'blue' ? 'var(--accent)' : 'var(--danger)');
      shape.setAttribute('stroke-width', '2.5');
    }
    g.appendChild(shape);

    const iconOffset = device.type === 'router' || device.type === 'firewall' ? 0.16 : 0.22;
    appendDeviceIcon(g, device.type, device.x, device.y - size.h * iconOffset);

    const labelY = device.y + size.h * 0.16;
    const label = svgEl('text', { x: device.x, y: labelY, class: 'device-label' });
    label.textContent = device.label;
    g.appendChild(label);

    const subLines = deviceLabelSub(device, reveal);
    subLines.forEach((line, i) => {
      const t = svgEl('text', { x: device.x, y: labelY + 12 + i * 12, class: 'device-sub' });
      t.textContent = line;
      g.appendChild(t);
    });

    svg.appendChild(g);
  }
}

function renderPacketsInto(layer, state, handlers) {
  layer.innerHTML = '';
  for (const packet of state.packets) {
    const a = state.devices.find((d) => d.id === packet.fromId);
    const b = state.devices.find((d) => d.id === packet.toId);
    const x = a.x + (b.x - a.x) * packet.progress;
    const y = a.y + (b.y - a.y) * packet.progress;
    const selected = state.selectedPacketId === packet.id;
    const onClick = (ev) => {
      ev.stopPropagation();
      handlers.onPacketClick(packet.id);
    };
    // 見た目のドット（半径9px）は動いていると狙ってクリックしづらいので、
    // 太い透明な当たり判定を下に重ねてクリックしやすくする（配線のときと同じ考え方）。
    const hitArea = svgEl('circle', { cx: x, cy: y, r: 18, class: 'packet-hit-area' });
    hitArea.addEventListener('click', onClick);
    layer.appendChild(hitArea);
    const dot = svgEl('circle', {
      cx: x, cy: y, r: 9,
      class: `packet-dot type-${packet.type}${selected ? ' selected' : ''}`,
    });
    layer.appendChild(dot);
  }
}

/** アニメーションフレームごとの軽量更新。パケット層だけを差し替え、配線・ボタン・デバイスは触らない。 */
export function renderPacketsOnly(state, handlers) {
  const layer = document.getElementById('packets-layer');
  if (!layer) return;
  renderPacketsInto(layer, state, handlers);
}

export function renderPacketDetail(state) {
  const box = document.getElementById('packet-detail');
  const packet = state.packets.find((p) => p.id === state.selectedPacketId);
  if (!packet) {
    box.innerHTML = '<p class="hint">一時停止してパケットをクリックすると中身が見られます</p>';
    return;
  }
  const rows = packetDetailRows(packet, state.stageDef.revealFields, (id) => resolveLabel(state, id));
  box.innerHTML = '';
  for (const row of rows) {
    const div = document.createElement('div');
    div.className = 'detail-row' + (row.tag ? ` highlight-${row.tag}` : '');
    div.innerHTML = `<span class="k">${row.k}</span><span class="v">${escapeHtml(String(row.v))}</span>`;
    box.appendChild(div);
  }
}

export function renderTables(state) {
  const box = document.getElementById('table-views');
  box.innerHTML = '';
  const specs = state.stageDef.tablesToShow ?? [];
  if (specs.length === 0) {
    box.innerHTML = '<p class="hint" style="color:var(--text-dim);font-size:12px;">このステージでは表なし</p>';
    return;
  }
  for (const spec of specs) {
    const device = state.devices.find((d) => d.id === spec.deviceId);
    if (!device) continue;
    const h = document.createElement('h4');
    h.textContent = spec.title;
    box.appendChild(h);
    const table = document.createElement('table');
    table.className = 'mini-table';
    if (spec.kind === 'mac') {
      const entries = Object.entries(device.macTable ?? {});
      table.innerHTML = '<tr><th>MACアドレス</th><th>ポート(隣接先)</th></tr>' +
        (entries.length
          ? entries.map(([mac, port]) => `<tr><td>${escapeHtml(mac)}</td><td>${escapeHtml(resolveLabel(state, port))}</td></tr>`).join('')
          : '<tr><td colspan="2" style="color:var(--text-dim)">まだ何も学習していません</td></tr>');
    } else if (spec.kind === 'arp') {
      const entries = Object.entries(device.arpTable ?? {});
      table.innerHTML = '<tr><th>IPアドレス</th><th>MACアドレス</th></tr>' +
        (entries.length
          ? entries.map(([ip, mac]) => `<tr><td>${escapeHtml(ip)}</td><td>${escapeHtml(mac)}</td></tr>`).join('')
          : '<tr><td colspan="2" style="color:var(--text-dim)">まだ解決していません</td></tr>');
    } else if (spec.kind === 'dns') {
      const entries = Object.entries(device.dnsCache ?? {});
      table.innerHTML = '<tr><th>ドメイン名</th><th>IPアドレス</th></tr>' +
        (entries.length
          ? entries.map(([domain, ip]) => `<tr><td>${escapeHtml(domain)}</td><td>${escapeHtml(ip)}</td></tr>`).join('')
          : '<tr><td colspan="2" style="color:var(--text-dim)">まだキャッシュがありません</td></tr>');
    } else if (spec.kind === 'nat') {
      const entries = Object.entries(device.natTable ?? {});
      table.innerHTML = '<tr><th>内部(IP:ポート)</th><th>グローバル(IP:ポート)</th></tr>' +
        (entries.length
          ? entries.map(([inside, port]) => `<tr><td>${escapeHtml(inside)}</td><td>${escapeHtml(device.interfaces.find((i) => i.side === 'public').ip)}:${port}</td></tr>`).join('')
          : '<tr><td colspan="2" style="color:var(--text-dim)">まだ変換していません</td></tr>');
    } else if (spec.kind === 'firewall') {
      const entries = Object.entries(device.rules ?? {});
      table.innerHTML = '<tr><th>ポート</th><th>ルール</th></tr>' +
        entries.map(([port, allow]) => `<tr><td>${escapeHtml(port)}</td><td>${allow ? '許可' : '<span style="color:var(--danger)">遮断</span>'}</td></tr>`).join('');
    }
    box.appendChild(table);
  }
}

export function renderMissionBanner(stageDef) {
  document.getElementById('mission-title').textContent = stageDef.title;
  document.getElementById('mission-text').textContent = stageDef.missionText;
  setMissionStatus('', '');
}

const CHAR_IMAGES = {
  cat: 'images/cat.png',
  catThink: 'images/catThink.png',
  rabbit: 'images/rabbit.png',
  rabbitThink: 'images/rabbitThink.png',
};

function characterCard(who, variant) {
  const isCat = who === 'cat';
  const src = isCat
    ? (variant === 'think' ? CHAR_IMAGES.catThink : CHAR_IMAGES.cat)
    : (variant === 'think' ? CHAR_IMAGES.rabbitThink : CHAR_IMAGES.rabbit);
  const name = isCat ? 'ねこ先生' : 'うさ美（生徒）';
  const cls = isCat ? 'cat' : 'rabbit';
  return `<div class="dialog-character"><img src="${src}" alt="${name}"><div class="dialog-name ${cls}">${name}</div></div>`;
}

function dialogueLine(who, text, variant) {
  const side = who === 'rabbit' ? ' right' : '';
  return `<div class="dialog-row${side}">${characterCard(who, variant)}<div class="dialog-bubble">${text}</div></div>`;
}

export function renderDialogue(stageDef) {
  const box = document.getElementById('dialogue-panel');
  const lines = stageDef.dialogue ?? [];
  box.innerHTML = lines.length
    ? `<div class="dialog-scene">${lines.map((l) => dialogueLine(l.who, l.text, l.variant ?? '')).join('')}</div>`
    : '';
}

export function setMissionStatus(text, cls) {
  const el = document.getElementById('mission-status');
  el.textContent = text;
  el.className = cls ?? '';
}

export function renderStageNav(stages, state, onSelect) {
  const nav = document.getElementById('stage-nav');
  nav.innerHTML = '';
  stages.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.textContent = s.navLabel;
    if (i === state.stageIndex) btn.classList.add('active');
    if (i > state.unlockedCount - 1) btn.disabled = true;
    btn.addEventListener('click', () => onSelect(i));
    nav.appendChild(btn);
  });
}

let liveBuffer = [];
let lastLogTime = 0;
const LIVE_BATCH_GAP_MS = 200; // これより間が空いたら新しいまとまりとして扱う
const LIVE_MAX_LINES = 5;

export function clearLog() {
  document.getElementById('log-list').innerHTML = '';
  liveBuffer = [];
  lastLogTime = 0;
  const live = document.getElementById('live-status');
  live.innerHTML = '';
  live.className = '';
}

export function appendLog(message, cls) {
  const list = document.getElementById('log-list');
  const li = document.createElement('li');
  li.textContent = message;
  if (cls) li.className = cls;
  list.appendChild(li);
  const panel = document.getElementById('log-panel');
  panel.scrollTop = panel.scrollHeight;

  // アニメーション枠内にも、同時に起きた出来事はまとめてリアルタイム表示する。
  // 1回の描画更新の中で複数のログが同時に発生することがある（例：フラッディングで
  // 複数のPCが同時に受信/破棄する）ため、最後の1行だけに上書きしてしまわないよう、
  // 短い間隔（LIVE_BATCH_GAP_MS）で連続しているログはまとめてバッファに積む。
  const now = performance.now();
  if (now - lastLogTime > LIVE_BATCH_GAP_MS) {
    liveBuffer = [];
  }
  lastLogTime = now;
  liveBuffer.push({ message, cls });
  if (liveBuffer.length > LIVE_MAX_LINES) liveBuffer.shift();

  const live = document.getElementById('live-status');
  live.innerHTML = liveBuffer
    .map((l) => `<div class="live-line${l.cls ? ` ${l.cls}` : ''}">${escapeHtml(l.message)}</div>`)
    .join('');
  live.className = 'show';
}

export function renderStageActions(container, stageDef, state, api) {
  container.innerHTML = '';
  stageDef.renderActions(container, state, api);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

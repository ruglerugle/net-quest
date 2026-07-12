// 各ステージのトポロジー定義とゲームロジック
import { edgesOf, otherEnd, switchForwardTargets, sameSubnet, matchInterface } from './network.js';
import { createPacket } from './packet.js';

const DROP_MESSAGE = '通信失敗：ケーブルが接続されていないため、パケットが途中で失われました。';

function labeledWrap(text, el) {
  const wrap = document.createElement('span');
  wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim);';
  const label = document.createElement('label');
  label.textContent = text;
  wrap.appendChild(label);
  wrap.appendChild(el);
  return wrap;
}

/** switchへ向けて1ホップ分のパケットを送る共通ヘルパー */
function sendFrameToSwitch(state, api, sw, fromId, frame, thenRelay) {
  const packet = createPacket({
    ...frame,
    fromId,
    toId: sw.id,
    onArrive: (s) => thenRelay(s),
    onDrop: () => { api.log(DROP_MESSAGE, 'err'); api.render(); },
  });
  state.packets.push(packet);
  api.render();
}

/** switchが学習・転送判断を行い、対象デバイスへパケットを配送する共通ヘルパー */
function relayThroughSwitch(state, api, sw, fromId, frame, deliverCallback) {
  const neighbors = edgesOf(state, sw.id).map((e) => otherEnd(e, sw.id));
  const others = neighbors.filter((n) => n !== fromId);
  const { targets, flooded } = switchForwardTargets(sw, fromId, frame.srcMac, frame.dstMac, neighbors);
  if (others.length > 1) {
    api.log(
      flooded
        ? `${sw.label}はMACアドレステーブルに宛先が無いため、全ポートへフラッディングしました。`
        : `${sw.label}はMACアドレステーブルを参照し、該当ポートへのみ転送しました（ユニキャスト）。`,
      flooded ? 'arp' : 'ok'
    );
  }
  for (const targetId of targets) {
    const packet = createPacket({
      ...frame,
      fromId: sw.id,
      toId: targetId,
      onArrive: (s) => {
        const device = s.devices.find((d) => d.id === targetId);
        deliverCallback(s, device);
      },
      onDrop: () => { api.log(DROP_MESSAGE, 'err'); api.render(); },
    });
    state.packets.push(packet);
  }
  api.render();
  return flooded;
}

/** ARP解決（ブロードキャスト要求→該当デバイスのみ応答）の共通フロー */
function resolveArpOverSwitch(state, api, sw, requester, targetIp, onResolved) {
  api.log(`${requester.label}が問いかけました：「${targetIp}さんは誰ですか？MACアドレスを教えてください！」`, 'arp');
  const reqFrame = {
    type: 'ARP-REQUEST', srcMac: requester.mac, dstMac: 'FF:FF:FF:FF:FF:FF',
    srcIp: requester.ip ?? null, arpQueryIp: targetIp,
  };
  sendFrameToSwitch(state, api, sw, requester.id, reqFrame, () => {
    relayThroughSwitch(state, api, sw, requester.id, reqFrame, (s2, device) => {
      const iface = matchInterface(device, targetIp);
      if (!iface) {
        api.log(`${device.label}は自分宛てではないため無視しました。`);
        api.render();
        return;
      }
      api.log(`${device.label}「私です。MACアドレスは${iface.mac}です。」`, 'arp');
      const replyFrame = {
        type: 'ARP-REPLY', srcMac: iface.mac, dstMac: requester.mac,
        srcIp: targetIp, dstIp: requester.ip ?? null,
      };
      sendFrameToSwitch(s2, api, sw, device.id, replyFrame, () => {
        relayThroughSwitch(s2, api, sw, device.id, replyFrame, (s3, target) => {
          if (target.id !== requester.id) return;
          api.log(`${requester.label}がARP応答を受信し、ARPテーブルに登録しました。`, 'ok');
          onResolved(iface.mac);
        });
      });
    });
  });
}

/** 同一ネットワーク内でのARP解決付きping（ステージ4用） */
function runSimplePing(state, api, { client, sw, server, onSuccess }) {
  function sendEcho(dstMac) {
    api.log(`${client.label}がICMP Echo Request（ping）を送信しました。`);
    const frame = { type: 'ICMP-ECHO', srcMac: client.mac, dstMac, srcIp: client.ip, dstIp: server.ip, ttl: 64 };
    sendFrameToSwitch(state, api, sw, client.id, frame, () => {
      relayThroughSwitch(state, api, sw, client.id, frame, (s2, device) => {
        if (device.id !== server.id) {
          api.log(`${device.label}は自分宛てではないため破棄しました。`);
          api.render();
          return;
        }
        api.log(`${device.label}がpingを受信し、応答します。`, 'ok');
        const replyFrame = { type: 'ICMP-REPLY', srcMac: server.mac, dstMac: client.mac, srcIp: server.ip, dstIp: client.ip, ttl: 64 };
        sendFrameToSwitch(s2, api, sw, server.id, replyFrame, () => {
          relayThroughSwitch(s2, api, sw, server.id, replyFrame, (s3, target) => {
            if (target.id !== client.id) return;
            api.log(`${client.label}がping応答を受信しました。通信成功！`, 'ok');
            onSuccess(s3);
          });
        });
      });
    });
  }
  if (client.arpTable[server.ip]) {
    api.log('ARPテーブルにキャッシュ済みのため、ARPをスキップします。');
    sendEcho(client.arpTable[server.ip]);
  } else {
    resolveArpOverSwitch(state, api, sw, client, server.ip, (mac) => {
      client.arpTable[server.ip] = mac;
      sendEcho(mac);
    });
  }
}

/** 別ネットワークへのルーター経由ping（ステージ5・最終ミッション共通） */
function runRouterPing(state, api, { client, sw1, rt, sw2, server, onSuccess }) {
  const blueIface = rt.interfaces.find((i) => i.side === 'blue');
  const redIface = rt.interfaces.find((i) => i.side === 'red');

  function sendForward() {
    if (!client.arpTable[client.gateway]) {
      api.log(`${client.label}は宛先が別ネットワークだと判断し、デフォルトゲートウェイ(${client.gateway})のMACアドレスを調べます。`, 'arp');
      resolveArpOverSwitch(state, api, sw1, client, client.gateway, (mac) => {
        client.arpTable[client.gateway] = mac;
        sendForward();
      });
      return;
    }
    const gwMac = client.arpTable[client.gateway];
    api.log(`${client.label}：IPの宛先は${server.ip}のまま、MACの宛先はルーターの${gwMac}に変更して送信します（次の中継地点へ）。`);
    const frame = {
      type: 'ICMP-ECHO', srcMac: client.mac, dstMac: gwMac, srcIp: client.ip, dstIp: server.ip, ttl: 64,
      dstMacTag: 'change', dstIpTag: 'same',
    };
    sendFrameToSwitch(state, api, sw1, client.id, frame, () => {
      relayThroughSwitch(state, api, sw1, client.id, frame, (s2, device) => {
        if (device.id !== rt.id) return;
        routerRelayToServer(s2, 64);
      });
    });
  }

  function routerRelayToServer(state2, ttlIn) {
    const ttl = ttlIn - 1;
    api.log(`${rt.label}がフレームを受信し、TTLを${ttlIn}→${ttl}に減算しました。`, 'ok');
    if (ttl <= 0) {
      api.log('TTLが0になったためパケットは破棄されました。', 'err');
      api.render();
      return;
    }
    const forward = (dstMac) => {
      api.log(`${rt.label}：送信元MACを${redIface.mac}、宛先MACを${dstMac}に付け替えて転送します（IPアドレスは変わりません）。`);
      const frame = {
        type: 'ICMP-ECHO', srcMac: redIface.mac, dstMac, srcIp: client.ip, dstIp: server.ip, ttl,
        dstMacTag: 'change', dstIpTag: 'same',
      };
      sendFrameToSwitch(state2, api, sw2, rt.id, frame, () => {
        relayThroughSwitch(state2, api, sw2, rt.id, frame, (s3, device) => {
          if (device.id !== server.id) {
            api.log(`${device.label}は自分宛てではないため破棄しました。`);
            api.render();
            return;
          }
          api.log(`${server.label}がpingを受信し、応答します。`, 'ok');
          sendReturn(s3, 64);
        });
      });
    };
    if (rt.arpTable[server.ip]) {
      forward(rt.arpTable[server.ip]);
    } else {
      resolveArpOverSwitch(state2, api, sw2,
        { id: rt.id, mac: redIface.mac, ip: redIface.ip, label: rt.label },
        server.ip,
        (mac) => { rt.arpTable[server.ip] = mac; forward(mac); });
    }
  }

  function sendReturn(state3, ttlIn) {
    const frame1 = { type: 'ICMP-REPLY', srcMac: server.mac, dstMac: redIface.mac, srcIp: server.ip, dstIp: client.ip, ttl: 64 };
    sendFrameToSwitch(state3, api, sw2, server.id, frame1, () => {
      relayThroughSwitch(state3, api, sw2, server.id, frame1, (s4, device) => {
        if (device.id !== rt.id) return;
        const ttl = ttlIn - 1;
        api.log(`${rt.label}が復路のフレームを受信し、TTLを${ttlIn}→${ttl}に減算しました。`, 'ok');
        const dstMac = rt.arpTable[client.ip] ?? client.mac;
        const frame2 = { type: 'ICMP-REPLY', srcMac: blueIface.mac, dstMac, srcIp: server.ip, dstIp: client.ip, ttl };
        sendFrameToSwitch(s4, api, sw1, rt.id, frame2, () => {
          relayThroughSwitch(s4, api, sw1, rt.id, frame2, (s5, target) => {
            if (target.id !== client.id) return;
            api.log(`${client.label}がping応答を受信しました。通信成功！`, 'ok');
            onSuccess(s5);
          });
        });
      });
    });
  }

  sendForward();
}

// ===================== ステージ1：ケーブルをつなげ =====================

const stage1 = {
  id: 'stage1',
  navLabel: '1. ケーブル',
  title: 'ステージ1：ケーブルをつなげ',
  missionText: 'PC-AからPC-Bへメッセージを送ろう。通信するにはまず物理的な経路（ケーブル）が必要だ。\n配線をクリックすると抜き差しできる。',
  revealFields: { ip: false, mac: false, ttl: false },
  zones: [],
  editableCables: true,
  tablesToShow: [],
  build() {
    return {
      devices: [
        { id: 'pcA', type: 'pc', label: 'PC-A', x: 220, y: 240 },
        { id: 'pcB', type: 'pc', label: 'PC-B', x: 680, y: 240 },
      ],
      edges: [{ id: 'e1', a: 'pcA', b: 'pcB', connected: true }],
      runtime: { delivered: false },
    };
  },
  renderActions(container, state, api) {
    const btn = document.createElement('button');
    btn.textContent = 'メッセージを送信';
    btn.addEventListener('click', () => {
      api.log('PC-Aがメッセージを送信しました。');
      const packet = createPacket({
        type: 'DATA', fromId: 'pcA', toId: 'pcB', data: 'Hello, PC-B!',
        onArrive: (s, p) => {
          state.stageRuntime.delivered = true;
          api.log('PC-BがPC-Aからのメッセージを受信しました。', 'ok');
          api.setStatus('通信成功！物理的な経路がつながっていることが通信の第一歩です。', 'success');
          api.completeStage();
          api.render();
        },
        onDrop: (s, p) => {
          api.log('通信失敗：第1層を確認してください。ケーブルが接続されていません。', 'err');
          api.setStatus('通信失敗：ケーブルを接続してからもう一度送信してください。', 'fail');
          api.render();
        },
      });
      state.packets.push(packet);
      api.render();
    });
    container.appendChild(btn);
  },
};

// ===================== ステージ2：スイッチの配送センター =====================

const stage2 = {
  id: 'stage2',
  navLabel: '2. スイッチ',
  title: 'ステージ2：スイッチの配送センター',
  missionText: '4台のPCがスイッチにつながっている。送信元と宛先を選んで送信してみよう。\n最初は宛先を知らないので全ポートへ配送（フラッディング）するが、一度覚えると必要な方向にだけ届くようになる。',
  revealFields: { ip: false, mac: true, ttl: false },
  zones: [],
  editableCables: false,
  tablesToShow: [{ deviceId: 'sw1', kind: 'mac', title: 'スイッチのMACアドレステーブル' }],
  build() {
    return {
      devices: [
        { id: 'pcA', type: 'pc', label: 'PC-A', x: 130, y: 130, mac: 'AA:AA:AA:AA:AA:01' },
        { id: 'pcB', type: 'pc', label: 'PC-B', x: 130, y: 350, mac: 'AA:AA:AA:AA:AA:02' },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 450, y: 240, macTable: {} },
        { id: 'pcC', type: 'pc', label: 'PC-C', x: 770, y: 130, mac: 'AA:AA:AA:AA:AA:03' },
        { id: 'pcD', type: 'pc', label: 'PC-D', x: 770, y: 350, mac: 'AA:AA:AA:AA:AA:04' },
      ],
      edges: [
        { id: 'eA', a: 'pcA', b: 'sw1', connected: true },
        { id: 'eB', a: 'pcB', b: 'sw1', connected: true },
        { id: 'eC', a: 'pcC', b: 'sw1', connected: true },
        { id: 'eD', a: 'pcD', b: 'sw1', connected: true },
      ],
      runtime: { hadFlood: false, hadUnicast: false },
    };
  },
  renderActions(container, state, api) {
    const pcs = state.devices.filter((d) => d.type === 'pc');
    const srcSelect = document.createElement('select');
    const dstSelect = document.createElement('select');
    for (const pc of pcs) {
      srcSelect.appendChild(new Option(pc.label, pc.id));
      dstSelect.appendChild(new Option(pc.label, pc.id));
    }
    dstSelect.selectedIndex = 1;
    container.appendChild(labeledWrap('送信元', srcSelect));
    container.appendChild(labeledWrap('宛先', dstSelect));
    const btn = document.createElement('button');
    btn.textContent = '送信';
    btn.addEventListener('click', () => {
      if (srcSelect.value === dstSelect.value) {
        api.log('送信元と宛先が同じです。', 'err');
        return;
      }
      const src = state.devices.find((d) => d.id === srcSelect.value);
      const dst = state.devices.find((d) => d.id === dstSelect.value);
      const sw = state.devices.find((d) => d.type === 'switch');
      api.log(`${src.label}が${dst.label}宛てのフレームを送信しました（宛先MAC: ${dst.mac}）。`);
      const frame = { type: 'DATA', srcMac: src.mac, dstMac: dst.mac };
      sendFrameToSwitch(state, api, sw, src.id, frame, () => {
        const flooded = relayThroughSwitch(state, api, sw, src.id, frame, (s2, device) => {
          if (device.mac === dst.mac) {
            api.log(`${device.label}がフレームを受信しました（宛先MAC一致）。`, 'ok');
          } else {
            api.log(`${device.label}は自分宛てではないため破棄しました。`);
          }
          api.render();
        });
        if (flooded) state.stageRuntime.hadFlood = true; else state.stageRuntime.hadUnicast = true;
        if (state.stageRuntime.hadFlood && state.stageRuntime.hadUnicast) {
          api.setStatus('フラッディングとユニキャスト、両方の動きを確認できました！', 'success');
          api.completeStage();
        }
      });
    });
    container.appendChild(btn);
  },
};

// ===================== ステージ3：IP住所を設定せよ =====================

const stage3 = {
  id: 'stage3',
  navLabel: '3. IP',
  title: 'ステージ3：IP住所を設定せよ',
  missionText: 'PC-AとPC-Bに正しくIPアドレスを設定してpingを通そう。\nその後、PC-Bを別ネットワーク（192.168.2.20など）に変更し、何が起きるか確認しよう。',
  revealFields: { ip: true, mac: true, ttl: false },
  zones: [],
  editableCables: false,
  tablesToShow: [],
  build() {
    return {
      devices: [
        { id: 'pcA', type: 'pc', label: 'PC-A', x: 220, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10' },
        { id: 'pcB', type: 'pc', label: 'PC-B', x: 680, y: 240, ip: '192.168.1.20', mac: 'BB:BB:BB:BB:BB:20' },
      ],
      edges: [{ id: 'e1', a: 'pcA', b: 'pcB', connected: true }],
      runtime: { success1: false, quizPassed: false, showQuiz: false },
    };
  },
  renderActions(container, state, api) {
    const pcA = state.devices.find((d) => d.id === 'pcA');
    const pcB = state.devices.find((d) => d.id === 'pcB');

    const mkIpInput = (device) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = device.ip ?? '';
      input.size = 14;
      input.addEventListener('change', () => {
        device.ip = input.value.trim();
        api.render();
      });
      return labeledWrap(`${device.label}のIP`, input);
    };
    container.appendChild(mkIpInput(pcA));
    container.appendChild(mkIpInput(pcB));

    const pingBtn = document.createElement('button');
    pingBtn.textContent = 'pingを送る';
    pingBtn.addEventListener('click', () => {
      if (!pcA.ip || !pcB.ip) {
        api.log('先に両方のPCにIPアドレスを設定してください。', 'err');
        return;
      }
      if (sameSubnet(pcA.ip, pcB.ip)) {
        api.log(`${pcA.label}が${pcB.label}へpingを送信しました（同一ネットワーク）。`);
        const packet = createPacket({
          type: 'ICMP-ECHO', fromId: 'pcA', toId: 'pcB', srcIp: pcA.ip, dstIp: pcB.ip,
          onArrive: () => {
            api.log(`${pcB.label}がpingに応答しました。同じ町内（ネットワーク）なので直接通信できました。`, 'ok');
            state.stageRuntime.success1 = true;
            if (state.stageRuntime.success1 && state.stageRuntime.quizPassed) {
              api.setStatus('同一ネットワークかどうかで通信経路が変わることを理解しました！', 'success');
              api.completeStage();
            }
            api.render();
          },
        });
        state.packets.push(packet);
      } else {
        api.log(`${pcA.label}と${pcB.label}は別ネットワークです。ルーターが無いため直接は届きません。`, 'err');
        state.stageRuntime.showQuiz = true;
        api.refreshActions();
      }
      api.render();
    });
    container.appendChild(pingBtn);

    if (state.stageRuntime.showQuiz) {
      const quizRow = document.createElement('div');
      quizRow.className = 'quiz-row';
      const q = document.createElement('span');
      q.textContent = 'なぜ届かない？';
      quizRow.appendChild(q);
      const choices = [
        { key: 'A', text: 'ケーブルが接続されていない' },
        { key: 'B', text: '別のネットワークにいるためルーターが必要' },
        { key: 'C', text: 'MACアドレスが重複している' },
      ];
      for (const c of choices) {
        const b = document.createElement('button');
        b.className = 'secondary';
        b.textContent = `${c.key}. ${c.text}`;
        b.addEventListener('click', () => {
          if (c.key === 'B') {
            api.log('正解！別ネットワークにいる場合はルーターが必要です。', 'ok');
            state.stageRuntime.quizPassed = true;
            state.stageRuntime.showQuiz = false;
            if (state.stageRuntime.success1 && state.stageRuntime.quizPassed) {
              api.setStatus('同一ネットワークかどうかで通信経路が変わることを理解しました！', 'success');
              api.completeStage();
            }
          } else {
            api.log('不正解。もう一度考えてみよう。', 'err');
          }
          api.refreshActions();
        });
        quizRow.appendChild(b);
      }
      container.appendChild(quizRow);
    }
  },
};

// ===================== ステージ4：ARPで隣人を探せ =====================

const stage4 = {
  id: 'stage4',
  navLabel: '4. ARP',
  title: 'ステージ4：ARPで隣人を探せ',
  missionText: 'PC-AはPC-BのIPアドレスを知っているが、MACアドレスを知らない。\nARPで問い合わせて、pingを届けよう。PC-Cは無関係の傍観者だ。',
  revealFields: { ip: true, mac: true, ttl: false },
  zones: [],
  editableCables: false,
  tablesToShow: [
    { deviceId: 'sw1', kind: 'mac', title: 'スイッチのMACアドレステーブル' },
    { deviceId: 'pcA', kind: 'arp', title: 'PC-AのARPテーブル' },
  ],
  build() {
    return {
      devices: [
        { id: 'pcA', type: 'pc', label: 'PC-A', x: 150, y: 150, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10', arpTable: {} },
        { id: 'pcB', type: 'pc', label: 'PC-B', x: 750, y: 150, ip: '192.168.1.20', mac: 'BB:BB:BB:BB:BB:20', arpTable: {} },
        { id: 'pcC', type: 'pc', label: 'PC-C', x: 450, y: 400, ip: '192.168.1.30', mac: 'CC:CC:CC:CC:CC:30', arpTable: {} },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 450, y: 200, macTable: {} },
      ],
      edges: [
        { id: 'eA', a: 'pcA', b: 'sw1', connected: true },
        { id: 'eB', a: 'pcB', b: 'sw1', connected: true },
        { id: 'eC', a: 'pcC', b: 'sw1', connected: true },
      ],
      runtime: { success: false },
    };
  },
  renderActions(container, state, api) {
    const btn = document.createElement('button');
    btn.textContent = 'pingを送る（PC-A → PC-B）';
    btn.addEventListener('click', () => {
      const dev = (id) => state.devices.find((d) => d.id === id);
      runSimplePing(state, api, {
        client: dev('pcA'), sw: dev('sw1'), server: dev('pcB'),
        onSuccess: () => {
          state.stageRuntime.success = true;
          api.setStatus('ARPで隣人のMACアドレスを調べ、pingを届けることができました！', 'success');
          api.completeStage();
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

// ===================== ステージ5：ルーターで町をつなぐ =====================

const stage5 = {
  id: 'stage5',
  navLabel: '5. ルーター',
  title: 'ステージ5：ルーターで町をつなぐ',
  missionText: 'PC-A（青地区 192.168.1.0/24）からPC-B（赤地区 192.168.2.0/24）へpingを送ろう。\nIPの宛先は最終目的地のまま変わらないが、MACの宛先は中継地点ごとに変わることに注目。',
  revealFields: { ip: true, mac: true, ttl: true },
  zones: [
    { x: 30, y: 170, w: 430, h: 150, color: 'blue', label: '192.168.1.0/24' },
    { x: 460, y: 170, w: 430, h: 150, color: 'red', label: '192.168.2.0/24' },
  ],
  editableCables: false,
  tablesToShow: [
    { deviceId: 'pcA', kind: 'arp', title: 'PC-AのARPテーブル' },
    { deviceId: 'rt1', kind: 'arp', title: 'ルーターのARPテーブル' },
  ],
  build() {
    return {
      devices: [
        { id: 'pcA', type: 'pc', label: 'PC-A', x: 100, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10', gateway: '192.168.1.1', arpTable: {} },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 270, y: 240, macTable: {} },
        {
          id: 'rt1', type: 'router', label: 'RT1', x: 450, y: 240, arpTable: {},
          interfaces: [
            { ip: '192.168.1.1', mac: '11:11:11:11:11:01', side: 'blue' },
            { ip: '192.168.2.1', mac: '11:11:11:11:11:02', side: 'red' },
          ],
        },
        { id: 'sw2', type: 'switch', label: 'SW2', x: 630, y: 240, macTable: {} },
        { id: 'pcB', type: 'pc', label: 'PC-B', x: 800, y: 240, ip: '192.168.2.20', mac: 'BB:BB:BB:BB:BB:20', gateway: '192.168.2.1', arpTable: {} },
      ],
      edges: [
        { id: 'e1', a: 'pcA', b: 'sw1', connected: true },
        { id: 'e2', a: 'sw1', b: 'rt1', connected: true },
        { id: 'e3', a: 'rt1', b: 'sw2', connected: true },
        { id: 'e4', a: 'sw2', b: 'pcB', connected: true },
      ],
      runtime: { success: false },
    };
  },
  renderActions(container, state, api) {
    const btn = document.createElement('button');
    btn.textContent = 'pingを送る（PC-A → PC-B）';
    btn.addEventListener('click', () => {
      const dev = (id) => state.devices.find((d) => d.id === id);
      runRouterPing(state, api, {
        client: dev('pcA'), sw1: dev('sw1'), rt: dev('rt1'), sw2: dev('sw2'), server: dev('pcB'),
        onSuccess: () => {
          state.stageRuntime.success = true;
          api.setStatus('ルーターがMACアドレスを付け替えながら、別ネットワークまでpingを届けました！', 'success');
          api.completeStage();
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

// ===================== 最終ミッション =====================

const finalStage = {
  id: 'final',
  navLabel: '6. 最終ミッション',
  title: '最終ミッション：PCから別ネットワークのWebサーバーへpingを届けろ',
  missionText: '社内PCから、インターネット上のWebサーバー(203.0.113.20)へpingを届けよう。\nどこかの配線が切れているようだ……まず物理層から確認しよう。',
  revealFields: { ip: true, mac: true, ttl: true },
  zones: [
    { x: 20, y: 170, w: 390, h: 150, color: 'blue', label: '社内LAN 192.168.1.0/24' },
    { x: 440, y: 170, w: 400, h: 150, color: 'red', label: 'インターネット側 203.0.113.0/24' },
  ],
  editableCables: true,
  tablesToShow: [
    { deviceId: 'pcA', kind: 'arp', title: 'PCのARPテーブル' },
    { deviceId: 'rt1', kind: 'arp', title: 'ルーターのARPテーブル' },
  ],
  build() {
    return {
      devices: [
        { id: 'pcA', type: 'pc', label: 'PC', x: 90, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10', gateway: '192.168.1.1', arpTable: {} },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 260, y: 240, macTable: {} },
        {
          id: 'rt1', type: 'router', label: 'RT1', x: 430, y: 240, arpTable: {},
          interfaces: [
            { ip: '192.168.1.1', mac: '22:22:22:22:22:01', side: 'blue' },
            { ip: '203.0.113.1', mac: '22:22:22:22:22:02', side: 'red' },
          ],
        },
        { id: 'sw2', type: 'switch', label: 'SW2', x: 600, y: 240, macTable: {} },
        { id: 'srv', type: 'server', label: 'Web Server', x: 800, y: 240, ip: '203.0.113.20', mac: 'CC:CC:CC:CC:CC:99' },
      ],
      edges: [
        { id: 'e1', a: 'pcA', b: 'sw1', connected: true },
        { id: 'e2', a: 'sw1', b: 'rt1', connected: false },
        { id: 'e3', a: 'rt1', b: 'sw2', connected: true },
        { id: 'e4', a: 'sw2', b: 'srv', connected: true },
      ],
      runtime: { success: false },
    };
  },
  renderActions(container, state, api) {
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:12px;color:var(--text-dim);align-self:center;';
    hint.textContent = '配線が切れている箇所がないか確認してから実行しよう（配線はクリックで抜き差しできる）。';
    container.appendChild(hint);
    const btn = document.createElement('button');
    btn.textContent = 'ping実行（PC → Web Server）';
    btn.addEventListener('click', () => {
      const dev = (id) => state.devices.find((d) => d.id === id);
      runRouterPing(state, api, {
        client: dev('pcA'), sw1: dev('sw1'), rt: dev('rt1'), sw2: dev('sw2'), server: dev('srv'),
        onSuccess: () => {
          state.stageRuntime.success = true;
          api.setStatus('到達成功！経路: PC → Switch1 → Router → Switch2 → Server', 'success');
          api.completeStage();
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

export const STAGES = [stage1, stage2, stage3, stage4, stage5, finalStage];

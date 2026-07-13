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
  const blueIface = rt.interfaces.find((i) => sameSubnet(i.ip, client.ip));
  const redIface = rt.interfaces.find((i) => sameSubnet(i.ip, server.ip));

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

/** ルーターの片方向の中継（TTL減算＋ARP解決＋MAC付け替え）。往復が複数回発生する場面（第2版の最終ミッション）向けの汎用版 */
function relayAcrossRouter(state, api, { rt, nearSw, farSw, farIface, srcDevice, dstDevice, frame, onDelivered }) {
  sendFrameToSwitch(state, api, nearSw, srcDevice.id, frame, () => {
    relayThroughSwitch(state, api, nearSw, srcDevice.id, frame, (s2, device) => {
      if (device.id !== rt.id) {
        api.log(`${device.label}は自分宛てではないため破棄しました。`);
        api.render();
        return;
      }
      const ttlIn = frame.ttl ?? 64;
      const ttl = ttlIn - 1;
      api.log(`${rt.label}がフレームを受信し、TTLを${ttlIn}→${ttl}に減算しました。`, 'ok');
      if (ttl <= 0) {
        api.log('TTLが0になったためパケットは破棄されました。', 'err');
        api.render();
        return;
      }
      const forward = (dstMac) => {
        const outFrame = { ...frame, srcMac: farIface.mac, dstMac, ttl, dstMacTag: 'change', dstIpTag: 'same' };
        api.log(`${rt.label}：送信元MACを${farIface.mac}、宛先MACを${dstMac}に付け替えて転送します（IPアドレスは変わりません）。`);
        sendFrameToSwitch(s2, api, farSw, rt.id, outFrame, () => {
          relayThroughSwitch(s2, api, farSw, rt.id, outFrame, (s3, target) => {
            if (target.id !== dstDevice.id) {
              api.log(`${target.label}は自分宛てではないため破棄しました。`);
              api.render();
              return;
            }
            onDelivered(s3, outFrame);
          });
        });
      };
      if (rt.arpTable[dstDevice.ip]) {
        forward(rt.arpTable[dstDevice.ip]);
      } else {
        resolveArpOverSwitch(s2, api, farSw,
          { id: rt.id, mac: farIface.mac, ip: farIface.ip, label: rt.label },
          dstDevice.ip,
          (mac) => { rt.arpTable[dstDevice.ip] = mac; forward(mac); });
      }
    });
  });
}

/** DHCP Discover→Offer→Request→ACKの一連の流れ */
function runDhcp(state, api, { client, sw, dhcp, onSuccess }) {
  api.log(`${client.label}「誰かIPアドレスをください！」（DHCP Discover）`, 'arp');
  const discover = { type: 'DHCP-DISCOVER', srcMac: client.mac, dstMac: 'FF:FF:FF:FF:FF:FF' };
  sendFrameToSwitch(state, api, sw, client.id, discover, () => {
    relayThroughSwitch(state, api, sw, client.id, discover, (s2, device) => {
      if (device.id !== dhcp.id) {
        api.log(`${device.label}は自分宛てではないため無視しました。`);
        api.render();
        return;
      }
      api.log(`${dhcp.label}「${dhcp.pool}はどうですか？」（DHCP Offer）`, 'arp');
      const offer = { type: 'DHCP-OFFER', srcMac: dhcp.mac, dstMac: client.mac, srcIp: dhcp.ip, data: dhcp.pool };
      sendFrameToSwitch(s2, api, sw, dhcp.id, offer, () => {
        relayThroughSwitch(s2, api, sw, dhcp.id, offer, (s3, target) => {
          if (target.id !== client.id) return;
          api.log(`${client.label}「それを使います！」（DHCP Request）`, 'arp');
          const request = { type: 'DHCP-REQUEST', srcMac: client.mac, dstMac: dhcp.mac, data: dhcp.pool };
          sendFrameToSwitch(s3, api, sw, client.id, request, () => {
            relayThroughSwitch(s3, api, sw, client.id, request, (s4, device2) => {
              if (device2.id !== dhcp.id) return;
              api.log(`${dhcp.label}「使用を許可します！」（DHCP ACK）`, 'ok');
              const ack = {
                type: 'DHCP-ACK', srcMac: dhcp.mac, dstMac: client.mac,
                data: `IP:${dhcp.pool} マスク:${dhcp.mask} GW:${dhcp.gateway} DNS:${dhcp.dns || 'なし'} リース:${dhcp.lease}分`,
              };
              sendFrameToSwitch(s4, api, sw, dhcp.id, ack, () => {
                relayThroughSwitch(s4, api, sw, dhcp.id, ack, (s5, target2) => {
                  if (target2.id !== client.id) return;
                  client.ip = dhcp.pool;
                  client.gateway = dhcp.gateway;
                  client.dns = dhcp.dns || null;
                  api.log(`${client.label}がIPアドレス${dhcp.pool}を取得しました。`, 'ok');
                  if (!dhcp.dns) {
                    api.log('DNSサーバーが設定されていません。ドメイン名でのアクセスはできません（次のステージで確認します）。', 'err');
                  }
                  onSuccess(s5);
                });
              });
            });
          });
        });
      });
    });
  });
}

/** ドメイン名解決（DNSキャッシュがあれば即応答、無ければ問い合わせ） */
function runDnsQuery(state, api, { client, sw, dns, domain, onResolved }) {
  if (client.dnsCache[domain]) {
    api.log(`${client.label}：DNSキャッシュに${domain}の情報があるため、すぐに${client.dnsCache[domain]}だと分かりました。`, 'ok');
    onResolved(state, client.dnsCache[domain], true);
    return;
  }
  api.log(`${client.label}「${domain}のIPアドレスを教えてください」`);
  const query = { type: 'DNS-QUERY', srcMac: client.mac, dstMac: dns.mac, srcIp: client.ip, dstIp: dns.ip, queryDomain: domain };
  sendFrameToSwitch(state, api, sw, client.id, query, () => {
    relayThroughSwitch(state, api, sw, client.id, query, (s2, device) => {
      if (device.id !== dns.id) return;
      const ip = dns.records[domain];
      if (!ip) {
        api.log(`${dns.label}：${domain}は登録されていません（NXDOMAIN）。`, 'err');
        api.render();
        return;
      }
      api.log(`${dns.label}「${domain}は${ip}です」`, 'arp');
      const response = { type: 'DNS-RESPONSE', srcMac: dns.mac, dstMac: client.mac, srcIp: dns.ip, dstIp: client.ip, queryDomain: domain, data: ip };
      sendFrameToSwitch(s2, api, sw, dns.id, response, () => {
        relayThroughSwitch(s2, api, sw, dns.id, response, (s3, target) => {
          if (target.id !== client.id) return;
          client.dnsCache[domain] = ip;
          api.log(`${client.label}がDNS応答を受信しました（${domain} → ${ip}）。`, 'ok');
          onResolved(s3, ip, false);
        });
      });
    });
  });
}

// ===================== ステージ1：ケーブルをつなげ =====================

const stage1 = {
  id: 'stage1',
  navLabel: '1. ケーブル',
  title: 'ステージ1：ケーブルをつなげ',
  missionText: 'PC-AからPC-Bへメッセージを送ろう。通信するにはまず物理的な経路（ケーブル）が必要だ。\n配線をクリックすると抜き差しできる。',
  dialogue: [
    { who: 'cat', text: 'うさ美ちゃん、ネットワークの基本は「物理的につながっていること」だよ。ケーブルが抜けていたら、どんなに賢いコンピューターでも何も送れないんだ。' },
    { who: 'rabbit', text: 'そんな当たり前のこと…と思ったけど、意外と忘れがちですね。' },
    { who: 'cat', text: 'これがOSI参照モデルでいう<strong>第1層（物理層）</strong>だよ。まずはPC-AとPC-Bをケーブルでつないで、メッセージを送ってみよう。' },
    { who: 'rabbit', text: 'ケーブルを抜いてみたら本当に届かなくなるか、試してみます！', variant: 'think' },
  ],
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
  missionText: '4台のPCがスイッチにつながっている。送信元と宛先を選んで送信してみよう。\n①まずPC-A→PC-Bで送信（宛先を知らないので全ポートへフラッディングされる）\n②次にPC-B→PC-A（逆方向）で送信（PC-Aの場所はもう覚えているのでユニキャストになる）\nスイッチは「送信元」の場所だけを覚える点がポイント。',
  dialogue: [
    { who: 'cat', text: 'PCが増えてきたら、1本のケーブルじゃ足りないよね。そこで登場するのが<strong>スイッチ</strong>。館内の配送センターみたいなものだよ。' },
    { who: 'rabbit', text: '配送センター？宛先を全部知ってるんですか？' },
    { who: 'cat', text: '最初は何も知らないんだ。だから宛先が分からないフレームは、とりあえず全部の部屋（ポート）に配ってしまう。これを<strong>フラッディング</strong>というよ。' },
    { who: 'rabbit', text: 'それじゃ効率悪くないですか？', variant: 'think' },
    { who: 'cat', text: '大丈夫、届いた相手が返事をすると、スイッチはその相手の場所を覚えるんだ。次からは必要な方向にだけ届く。<strong>MACアドレステーブル</strong>の学習だよ。' },
  ],
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
        api.refreshActions();
      });
    });
    container.appendChild(btn);

    const swapBtn = document.createElement('button');
    swapBtn.className = 'secondary';
    swapBtn.textContent = '送信元⇔宛先を入れ替え';
    swapBtn.addEventListener('click', () => {
      const tmp = srcSelect.value;
      srcSelect.value = dstSelect.value;
      dstSelect.value = tmp;
    });
    container.appendChild(swapBtn);

    const checklist = document.createElement('div');
    checklist.style.cssText = 'width:100%;font-size:12px;color:var(--text-dim);';
    checklist.innerHTML =
      `<span style="color:${state.stageRuntime.hadFlood ? 'var(--ok)' : 'var(--text-dim)'}">${state.stageRuntime.hadFlood ? '☑' : '☐'} フラッディングを確認</span>`
      + '&nbsp;&nbsp;'
      + `<span style="color:${state.stageRuntime.hadUnicast ? 'var(--ok)' : 'var(--text-dim)'}">${state.stageRuntime.hadUnicast ? '☑' : '☐'} ユニキャストを確認</span>`;
    container.appendChild(checklist);
  },
};

// ===================== ステージ3：IP住所を設定せよ =====================

const stage3 = {
  id: 'stage3',
  navLabel: '3. IP',
  title: 'ステージ3：IP住所を設定せよ',
  missionText: 'PC-AとPC-Bに正しくIPアドレスを設定してpingを通そう。\nその後、PC-Bを別ネットワーク（192.168.2.20など）に変更し、何が起きるか確認しよう。',
  dialogue: [
    { who: 'cat', text: 'MACアドレスは機器ごとの名札。でも同じ町の中でしか使えないんだ。遠くの相手と話すには<strong>IPアドレス</strong>という「住所」が必要になる。' },
    { who: 'rabbit', text: '住所があれば、どこへでも届くんですか？' },
    { who: 'cat', text: '実は届くかどうかは、相手が「同じ町内（同一ネットワーク）」かどうかで変わるんだ。PC-AとPC-BのIPを見比べて確かめてみよう。' },
    { who: 'rabbit', text: '町内なら普通に届いて、町外だと届かない…？', variant: 'think' },
    { who: 'cat', text: '町外に届けるには、道案内をしてくれる<strong>ルーター</strong>が必要になる。それはまた次のステージでね。' },
  ],
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
  dialogue: [
    { who: 'cat', text: 'PC-AはPC-BのIPアドレスを知っているけど、実際にフレームを届けるにはMACアドレスが要る。IPだけじゃ荷物は届かないんだ。' },
    { who: 'rabbit', text: 'じゃあどうやってMACアドレスを調べるんですか？' },
    { who: 'cat', text: '大声で聞くのさ。<strong>ARP</strong>だよ。「192.168.1.20さんは誰ですか？」ってLAN全体に呼びかけるんだ。' },
    { who: 'rabbit', text: 'みんな返事するんですか？うるさそう…', variant: 'think' },
    { who: 'cat', text: '返事をするのは本人だけ。他のPCは「自分じゃない」と黙って無視するんだよ。教えてもらったMACアドレスは<strong>ARPテーブル</strong>に記録して、次からは聞かなくて済むようにする。' },
  ],
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
  dialogue: [
    { who: 'cat', text: 'いよいよ別の町（別ネットワーク）へ届ける番だ。PC-AとPC-Bは違うネットワークにいるから、直接は届かない。' },
    { who: 'rabbit', text: 'さっき教わった「町外にはルーターが必要」ってやつですね！' },
    { who: 'cat', text: 'その通り。大事なポイントがある。IPアドレスの宛先はPC-Bのまま、<strong>最後まで変わらない</strong>。でもMACアドレスの宛先は中継地点（ルーター）ごとに書き換えられるんだ。' },
    { who: 'rabbit', text: 'IPは最終目的地、MACは次の中継地点…宅配便の伝票と、配達員が持つ地図の違いみたいですね！', variant: 'think' },
    { who: 'cat', text: 'いい例えだね。実際にPC-AからPC-Bへpingを送って、その様子を確かめてみよう。' },
  ],
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
  dialogue: [
    { who: 'cat', text: 'ここまで学んだことを全部使う総まとめだよ。ケーブル、スイッチ、IP、ARP、ルーター…すべてが1つの通信の中で動いている。' },
    { who: 'rabbit', text: 'でも社内PCからWebサーバーへpingが通らないって聞きました…', variant: 'think' },
    { who: 'cat', text: 'うん、どこかに障害が起きているみたいだ。ネットワーク図をよく見て、配線が切れている箇所を見つけて直してから、もう一度届けてみよう。' },
    { who: 'rabbit', text: '探偵うさ美、出動します！' },
  ],
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

// ===================== ステージ7：DHCP局を作れ =====================

const stage7 = {
  id: 'stage7',
  navLabel: '7. DHCP',
  title: 'ステージ7：DHCP局を作れ',
  missionText: '新しいPCにはまだIPアドレスが無い。DHCPサーバーの設定を確認し、「IPアドレスをもらう」を押してDiscover→Offer→Request→ACKの流れを見てみよう。\nDNSサーバー欄を空のままにすると、次のステージで何が起きるか確認できる。',
  dialogue: [
    { who: 'cat', text: '新しいPCがネットワークに参加したよ。でもまだIPアドレスを持っていない。' },
    { who: 'rabbit', text: 'じゃあ、自分でIPアドレスを決めればいいんじゃ…？' },
    { who: 'cat', text: 'それだと他のPCと重複してしまうかもしれない。そこで<strong>DHCP</strong>サーバーが自動で配ってくれるんだ。Discover→Offer→Request→ACKの4段階のやり取りだよ。' },
    { who: 'rabbit', text: '「誰かIPアドレスください！」って叫んで、サーバーが「これはどう？」って提案してくれるんですね。', variant: 'think' },
    { who: 'cat', text: 'そのとおり。IPアドレスだけじゃなく、ゲートウェイやDNSサーバーの情報も一緒に配られる。もしDNSサーバーの設定を忘れたら…次のステージで困ることになるよ。' },
  ],
  revealFields: { ip: true, mac: true, ttl: false, port: false },
  zones: [],
  editableCables: false,
  tablesToShow: [],
  build() {
    return {
      devices: [
        { id: 'pc', type: 'pc', label: '新しいPC', x: 150, y: 240, ip: null, mac: 'AA:AA:AA:AA:AA:99', gateway: null, dns: null },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 450, y: 240, macTable: {} },
        {
          id: 'dhcp', type: 'server', label: 'DHCPサーバー', x: 750, y: 240,
          ip: '192.168.1.5', mac: 'DD:DD:DD:DD:DD:05',
          pool: '192.168.1.100', mask: '255.255.255.0', gateway: '192.168.1.1', dns: '192.168.1.53', lease: 60,
        },
      ],
      edges: [
        { id: 'e1', a: 'pc', b: 'sw1', connected: true },
        { id: 'e2', a: 'sw1', b: 'dhcp', connected: true },
      ],
      runtime: { success: false },
    };
  },
  renderActions(container, state, api) {
    const dhcp = state.devices.find((d) => d.id === 'dhcp');
    const mkInput = (labelText, key, size) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = dhcp[key] ?? '';
      input.size = size ?? 12;
      input.addEventListener('change', () => { dhcp[key] = input.value.trim(); });
      return labeledWrap(labelText, input);
    };
    container.appendChild(mkInput('配布するIP', 'pool'));
    container.appendChild(mkInput('ゲートウェイ', 'gateway'));
    container.appendChild(mkInput('DNSサーバー(空欄可)', 'dns'));
    container.appendChild(mkInput('リース(分)', 'lease', 4));

    const btn = document.createElement('button');
    btn.textContent = 'IPアドレスをもらう';
    btn.addEventListener('click', () => {
      const dev = (id) => state.devices.find((d) => d.id === id);
      runDhcp(state, api, {
        client: dev('pc'), sw: dev('sw1'), dhcp: dev('dhcp'),
        onSuccess: () => {
          state.stageRuntime.success = true;
          api.setStatus('DHCPでIPアドレス一式を自動取得できました！', 'success');
          api.completeStage();
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

// ===================== ステージ8：DNS探偵団 =====================

const stage8 = {
  id: 'stage8',
  navLabel: '8. DNS',
  title: 'ステージ8：DNS探偵団',
  missionText: 'ドメイン名ではネットワーク上に荷物を届けられない。DNSサーバーに問い合わせてIPアドレスを教えてもらおう。\n同じドメインにもう一度アクセスすると、キャッシュにより即座に解決できることも確認しよう。',
  dialogue: [
    { who: 'cat', text: 'うさ美ちゃん、example.comにアクセスしたいとき、ネットワークの世界では名前のままでは配達できないんだ。' },
    { who: 'rabbit', text: 'あ、DHCPで「DNSサーバーが無いと困る」って言ってましたね！', variant: 'think' },
    { who: 'cat', text: 'そう。<strong>DNS</strong>サーバーに「example.comのIPアドレスを教えて」と問い合わせて、初めて配達できるようになる。' },
    { who: 'rabbit', text: '毎回問い合わせるのは大変そう…' },
    { who: 'cat', text: '一度調べた結果は<strong>キャッシュ</strong>に残るから、次からは瞬時に分かるようになるよ。試してみよう。' },
  ],
  revealFields: { ip: true, mac: true, ttl: false, port: false },
  zones: [],
  editableCables: false,
  tablesToShow: [{ deviceId: 'pc', kind: 'dns', title: 'PCのDNSキャッシュ' }],
  build() {
    return {
      devices: [
        { id: 'pc', type: 'pc', label: 'PC', x: 150, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10', dnsCache: {} },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 450, y: 240, macTable: {} },
        {
          id: 'dns', type: 'server', label: 'DNSサーバー', x: 750, y: 240,
          ip: '192.168.1.53', mac: 'DD:DD:DD:DD:DD:53',
          records: { 'example.com': '203.0.113.20', 'shop.example.com': '203.0.113.21' },
        },
      ],
      edges: [
        { id: 'e1', a: 'pc', b: 'sw1', connected: true },
        { id: 'e2', a: 'sw1', b: 'dns', connected: true },
      ],
      runtime: { resolvedOnce: false, cacheHit: false },
    };
  },
  renderActions(container, state, api) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'example.com';
    input.size = 20;
    container.appendChild(labeledWrap('ドメイン名', input));

    const btn = document.createElement('button');
    btn.textContent = 'アクセスする';
    btn.addEventListener('click', () => {
      const dev = (id) => state.devices.find((d) => d.id === id);
      const domain = input.value.trim();
      if (!domain) return;
      runDnsQuery(state, api, {
        client: dev('pc'), sw: dev('sw1'), dns: dev('dns'), domain,
        onResolved: (s, ip, fromCache) => {
          state.stageRuntime.resolvedOnce = true;
          if (fromCache) state.stageRuntime.cacheHit = true;
          if (state.stageRuntime.resolvedOnce && state.stageRuntime.cacheHit) {
            api.setStatus('名前解決とDNSキャッシュの働きを確認できました！', 'success');
            api.completeStage();
          }
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

// ===================== ステージ9：ポート番号のマンション =====================

const SERVICE_NAMES = { 22: 'SSH', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 443: 'HTTPS' };

const stage9 = {
  id: 'stage9',
  navLabel: '9. ポート',
  title: 'ステージ9：ポート番号のマンション',
  missionText: 'IPアドレスは建物の住所、ポート番号は部屋番号だ。同じサーバーでも、宛先ポートが違うと目的のサービスにはたどり着けない。\nWebページを見るための正しいポートへ接続してみよう。',
  dialogue: [
    { who: 'cat', text: 'IPアドレスは建物の住所。でも同じ建物には色んな部屋（サービス）があるよね。' },
    { who: 'rabbit', text: '郵便配達員が住所だけ知ってても、部屋番号が分からないと届かないってことですか？' },
    { who: 'cat', text: 'まさにそれ。その部屋番号にあたるのが<strong>ポート番号</strong>だよ。80番はHTTP、443番はHTTPS、25番はメール…部屋ごとに担当が違うんだ。' },
    { who: 'rabbit', text: '間違った部屋番号を指定したらどうなるんですか？', variant: 'think' },
    { who: 'cat', text: 'その部屋には誰もいないから、応答してもらえない。実際にいくつかのポートへ接続してみて、確かめてみよう。' },
  ],
  revealFields: { ip: true, mac: true, ttl: false, port: true },
  zones: [],
  editableCables: false,
  tablesToShow: [],
  build() {
    return {
      devices: [
        { id: 'pc', type: 'pc', label: 'PC', x: 200, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10' },
        {
          id: 'srv', type: 'server', label: 'Webサーバー', x: 700, y: 240,
          ip: '203.0.113.20', mac: 'CC:CC:CC:CC:CC:80',
          services: { 22: true, 25: false, 53: true, 80: true, 443: false },
        },
      ],
      edges: [{ id: 'e1', a: 'pc', b: 'srv', connected: true }],
      runtime: { success: false },
    };
  },
  renderActions(container, state, api) {
    const select = document.createElement('select');
    for (const port of [22, 25, 53, 80, 443]) {
      select.appendChild(new Option(`${port} (${SERVICE_NAMES[port]})`, String(port)));
    }
    select.value = '25';
    container.appendChild(labeledWrap('宛先ポート', select));

    const btn = document.createElement('button');
    btn.textContent = '接続する';
    btn.addEventListener('click', () => {
      const pc = state.devices.find((d) => d.id === 'pc');
      const srv = state.devices.find((d) => d.id === 'srv');
      const port = Number(select.value);
      api.log(`${pc.label}が${srv.ip}の${port}番ポート（${SERVICE_NAMES[port]}）へ接続を試みます。`);
      const packet = createPacket({
        type: 'TCP-SYN', fromId: pc.id, toId: srv.id,
        srcMac: pc.mac, dstMac: srv.mac, srcIp: pc.ip, dstIp: srv.ip,
        srcPort: 51000, dstPort: port,
        onArrive: () => {
          if (srv.services[port]) {
            api.log(`${srv.label}：${port}番ポート（${SERVICE_NAMES[port]}）が応答しました。接続成功！`, 'ok');
            if (port === 80) {
              state.stageRuntime.success = true;
              api.setStatus('正しいポート番号でWebサービスに接続できました！', 'success');
              api.completeStage();
            }
          } else {
            api.log(`${srv.label}：${port}番ポートは開いていません。接続を拒否されました。`, 'err');
          }
          api.render();
        },
      });
      state.packets.push(packet);
      api.render();
    });
    container.appendChild(btn);
  },
};

// ===================== ステージ10：TCPハンドシェイク =====================

function runTcpHandshake(state, api, { client, server, onDone }) {
  api.log(`${client.label}「通信していい？」（SYN seq=100）`);
  const syn = { type: 'TCP-SYN', srcMac: client.mac, dstMac: server.mac, srcPort: 50000, dstPort: 80, seq: 100 };
  const p1 = createPacket({
    ...syn, fromId: client.id, toId: server.id,
    onArrive: (s) => {
      api.log(`${server.label}「いいよ。そっちは？」（SYN/ACK seq=200, ack=101）`, 'ok');
      const synack = { type: 'TCP-SYNACK', srcMac: server.mac, dstMac: client.mac, srcPort: 80, dstPort: 50000, seq: 200, ack: 101 };
      const p2 = createPacket({
        ...synack, fromId: server.id, toId: client.id,
        onArrive: (s2) => {
          api.log(`${client.label}「こちらも準備完了」（ACK ack=201）`, 'ok');
          const ack = { type: 'TCP-ACK', srcMac: client.mac, dstMac: server.mac, srcPort: 50000, dstPort: 80, seq: 101, ack: 201 };
          const p3 = createPacket({
            ...ack, fromId: client.id, toId: server.id,
            onArrive: (s3) => {
              api.log('3ウェイハンドシェイク完了。コネクションが確立しました。', 'ok');
              onDone(s3);
            },
          });
          s2.packets.push(p3);
          api.render();
        },
      });
      s.packets.push(p2);
      api.render();
    },
  });
  state.packets.push(p1);
  api.render();
}

function sendTcpData(state, api, { client, server, lose, onAck }) {
  const seq = 101;
  const frame = { type: 'TCP-DATA', srcMac: client.mac, dstMac: server.mac, srcPort: 50000, dstPort: 80, seq, data: 'GET /index.html' };
  api.log(`${client.label}がデータを送信しました（seq=${seq}）。`);
  if (lose) {
    const lost = createPacket({
      ...frame, fromId: client.id, toId: server.id,
      onArrive: () => {
        api.log('（デモ）このパケットは途中で失われたことにします。', 'err');
        api.log(`${client.label}：一定時間ACKが返ってこないため、同じデータ（seq=${seq}）を再送します。`, 'arp');
        sendTcpData(state, api, { client, server, lose: false, onAck });
      },
    });
    state.packets.push(lost);
    api.render();
    return;
  }
  const packet = createPacket({
    ...frame, fromId: client.id, toId: server.id,
    onArrive: (s) => {
      api.log(`${server.label}がデータを受信し、ACKを返します。`, 'ok');
      const ackFrame = { type: 'TCP-DATA-ACK', srcMac: server.mac, dstMac: client.mac, srcPort: 80, dstPort: 50000, ack: seq + 1 };
      const ackPacket = createPacket({
        ...ackFrame, fromId: server.id, toId: client.id,
        onArrive: (s2) => {
          api.log(`${client.label}がACKを受信しました。送信成功！`, 'ok');
          onAck(s2);
        },
      });
      s.packets.push(ackPacket);
      api.render();
    },
  });
  state.packets.push(packet);
  api.render();
}

function sendUdpData(state, api, { client, server }) {
  api.log(`${client.label}がUDPでデータを送信しました（ハンドシェイクなし、応答不要）。`);
  const frame = { type: 'UDP-DATA', srcMac: client.mac, dstMac: server.mac, srcPort: 50001, dstPort: 53, data: 'query' };
  const packet = createPacket({
    ...frame, fromId: client.id, toId: server.id,
    onArrive: () => {
      api.log(`${server.label}がUDPデータを受信しました（ACKは返しません）。`, 'ok');
      api.render();
    },
  });
  state.packets.push(packet);
  api.render();
}

function checkStage10Win(state, api) {
  const r = state.stageRuntime;
  if (r.handshakeDone && r.dataAckReceived && r.retransmitObserved) {
    api.setStatus('3ウェイハンドシェイク・データ転送・再送、TCPの信頼性の仕組みを確認できました！', 'success');
    api.completeStage();
  }
}

const stage10 = {
  id: 'stage10',
  navLabel: '10. TCP',
  title: 'ステージ10：TCPハンドシェイク',
  missionText: 'クライアントとサーバーは通信前に3ウェイハンドシェイクで合図を交わす。まずは接続を開始しよう。\nその後「わざと紛失させる」でパケットロスと再送を、UDPボタンでハンドシェイク無しの通信も比べてみよう。',
  dialogue: [
    { who: 'cat', text: '本格的に通信を始める前に、TCPでは相手と3回の挨拶を交わすんだ。<strong>3ウェイハンドシェイク</strong>というよ。' },
    { who: 'rabbit', text: '3回も？律儀ですね。' },
    { who: 'cat', text: '「通信していい？」「いいよ、そっちは？」「こちらも準備完了」——これでお互いの準備が整ったことを確認するんだ。' },
    { who: 'rabbit', text: 'もし途中でパケットが消えちゃったら？', variant: 'think' },
    { who: 'cat', text: '安心して、TCPは一定時間反応がないと同じデータを<strong>再送</strong>してくれる。UDPだとそれが無いから、届かなくてもそのまま。両方試して違いを感じてみよう。' },
  ],
  revealFields: { ip: true, mac: true, ttl: false, port: true },
  zones: [],
  editableCables: false,
  tablesToShow: [],
  build() {
    return {
      devices: [
        { id: 'pc', type: 'pc', label: 'クライアント', x: 200, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10' },
        { id: 'srv', type: 'server', label: 'サーバー', x: 700, y: 240, ip: '203.0.113.20', mac: 'CC:CC:CC:CC:CC:80' },
      ],
      edges: [{ id: 'e1', a: 'pc', b: 'srv', connected: true }],
      runtime: { handshakeDone: false, dataAckReceived: false, retransmitObserved: false },
    };
  },
  renderActions(container, state, api) {
    const dev = (id) => state.devices.find((d) => d.id === id);

    const handshakeBtn = document.createElement('button');
    handshakeBtn.textContent = '接続を開始する（3ウェイハンドシェイク）';
    handshakeBtn.addEventListener('click', () => {
      runTcpHandshake(state, api, {
        client: dev('pc'), server: dev('srv'),
        onDone: () => { state.stageRuntime.handshakeDone = true; api.render(); },
      });
    });
    container.appendChild(handshakeBtn);

    const dataBtn = document.createElement('button');
    dataBtn.textContent = 'データを送信する';
    dataBtn.addEventListener('click', () => {
      if (!state.stageRuntime.handshakeDone) { api.log('先にハンドシェイクを完了してください。', 'err'); return; }
      sendTcpData(state, api, {
        client: dev('pc'), server: dev('srv'), lose: false,
        onAck: () => { state.stageRuntime.dataAckReceived = true; checkStage10Win(state, api); api.render(); },
      });
    });
    container.appendChild(dataBtn);

    const loseBtn = document.createElement('button');
    loseBtn.className = 'secondary';
    loseBtn.textContent = 'データを送信する（わざと紛失させて再送を見る）';
    loseBtn.addEventListener('click', () => {
      if (!state.stageRuntime.handshakeDone) { api.log('先にハンドシェイクを完了してください。', 'err'); return; }
      state.stageRuntime.retransmitObserved = true;
      sendTcpData(state, api, {
        client: dev('pc'), server: dev('srv'), lose: true,
        onAck: () => { state.stageRuntime.dataAckReceived = true; checkStage10Win(state, api); api.render(); },
      });
    });
    container.appendChild(loseBtn);

    const udpBtn = document.createElement('button');
    udpBtn.className = 'secondary';
    udpBtn.textContent = 'UDPで送ってみる（比較用）';
    udpBtn.addEventListener('click', () => sendUdpData(state, api, { client: dev('pc'), server: dev('srv') }));
    container.appendChild(udpBtn);
  },
};

// ===================== ステージ11：最終ミッション（Web編） =====================

function runWebMission(state, api, { client, sw1, dns, rt, sw2, server, domain, onSuccess }) {
  const blueIface = rt.interfaces.find((i) => i.side === 'blue');
  const redIface = rt.interfaces.find((i) => i.side === 'red');

  function stepGateway() {
    if (client.arpTable[client.gateway]) {
      stepSyn();
      return;
    }
    api.log(`${client.label}は宛先が別ネットワークだと判断し、デフォルトゲートウェイ(${client.gateway})のMACアドレスを調べます。`, 'arp');
    resolveArpOverSwitch(state, api, sw1, client, client.gateway, (mac) => {
      client.arpTable[client.gateway] = mac;
      stepSyn();
    });
  }

  function stepSyn() {
    const gwMac = client.arpTable[client.gateway];
    api.log(`${client.label}がWebサーバーへTCP接続を開始します（SYN）。`);
    const synFrame = { type: 'TCP-SYN', srcMac: client.mac, dstMac: gwMac, srcIp: client.ip, dstIp: server.ip, srcPort: 51000, dstPort: 80, seq: 100, ttl: 64 };
    relayAcrossRouter(state, api, {
      rt, nearSw: sw1, farSw: sw2, farIface: redIface, srcDevice: client, dstDevice: server, frame: synFrame,
      onDelivered: (s) => { api.log(`${server.label}がSYNを受信しました。`, 'ok'); stepSynAck(s); },
    });
  }

  function stepSynAck(state2) {
    api.log(`${server.label}がSYN/ACKを返します。`, 'ok');
    const synackFrame = { type: 'TCP-SYNACK', srcMac: server.mac, dstMac: redIface.mac, srcIp: server.ip, dstIp: client.ip, srcPort: 80, dstPort: 51000, seq: 200, ack: 101, ttl: 64 };
    relayAcrossRouter(state2, api, {
      rt, nearSw: sw2, farSw: sw1, farIface: blueIface, srcDevice: server, dstDevice: client, frame: synackFrame,
      onDelivered: (s) => { api.log(`${client.label}がSYN/ACKを受信しました。`, 'ok'); stepAck(s); },
    });
  }

  function stepAck(state3) {
    const gwMac = client.arpTable[client.gateway];
    const ackFrame = { type: 'TCP-ACK', srcMac: client.mac, dstMac: gwMac, srcIp: client.ip, dstIp: server.ip, srcPort: 51000, dstPort: 80, seq: 101, ack: 201, ttl: 64 };
    relayAcrossRouter(state3, api, {
      rt, nearSw: sw1, farSw: sw2, farIface: redIface, srcDevice: client, dstDevice: server, frame: ackFrame,
      onDelivered: (s) => { api.log('3ウェイハンドシェイク完了。コネクションが確立しました。', 'ok'); stepHttpGet(s); },
    });
  }

  function stepHttpGet(state4) {
    const gwMac = client.arpTable[client.gateway];
    api.log(`${client.label}「GET /index.html を送ります」`);
    const getFrame = { type: 'HTTP-GET', srcMac: client.mac, dstMac: gwMac, srcIp: client.ip, dstIp: server.ip, srcPort: 51000, dstPort: 80, data: 'GET /index.html HTTP/1.1', ttl: 64 };
    relayAcrossRouter(state4, api, {
      rt, nearSw: sw1, farSw: sw2, farIface: redIface, srcDevice: client, dstDevice: server, frame: getFrame,
      onDelivered: (s) => { api.log(`${server.label}がHTTPリクエストを受信しました。`, 'ok'); stepHttpResponse(s); },
    });
  }

  function stepHttpResponse(state5) {
    const respFrame = { type: 'HTTP-RESPONSE', srcMac: server.mac, dstMac: redIface.mac, srcIp: server.ip, dstIp: client.ip, srcPort: 80, dstPort: 51000, data: 'HTTP/1.1 200 OK', ttl: 64 };
    relayAcrossRouter(state5, api, {
      rt, nearSw: sw2, farSw: sw1, farIface: blueIface, srcDevice: server, dstDevice: client, frame: respFrame,
      onDelivered: (s) => { api.log(`${client.label}が200 OKを受信し、ページを表示しました！`, 'ok'); onSuccess(s); },
    });
  }

  runDnsQuery(state, api, {
    client, sw: sw1, dns, domain,
    onResolved: () => stepGateway(),
  });
}

const stage11 = {
  id: 'stage11',
  navLabel: '11. Web最終',
  title: '最終ミッション（Web編）：URLを入力してからページが表示されるまで',
  missionText: 'shop.example.com へアクセスしよう。DNS問い合わせ→ARP→ルーティング→TCP 3ウェイハンドシェイク→HTTPリクエスト/応答が、1本の通信としてつながる様子を見てみよう。',
  dialogue: [
    { who: 'cat', text: 'さあ、ブラウザにURLを打ち込んでからページが表示されるまでの全工程を体験してみよう。' },
    { who: 'rabbit', text: 'DNSで住所を調べて、ARPでMACを調べて、ルーターを経由して、TCPで挨拶して…やっとページが見られる。', variant: 'think' },
    { who: 'cat', text: 'そのとおり！今まで一つ一つ学んできたことが、実は全部同時に動いていたんだ。shop.example.comへのアクセスを最初から最後まで見届けよう。' },
    { who: 'rabbit', text: '感動の完結編ですね！' },
  ],
  revealFields: { ip: true, mac: true, ttl: true, port: true },
  zones: [
    { x: 20, y: 100, w: 390, h: 300, color: 'blue', label: '社内LAN 192.168.1.0/24' },
    { x: 440, y: 170, w: 400, h: 150, color: 'red', label: 'インターネット側 203.0.113.0/24' },
  ],
  editableCables: false,
  tablesToShow: [
    { deviceId: 'pc', kind: 'dns', title: 'PCのDNSキャッシュ' },
    { deviceId: 'pc', kind: 'arp', title: 'PCのARPテーブル' },
    { deviceId: 'rt1', kind: 'arp', title: 'ルーターのARPテーブル' },
  ],
  build() {
    return {
      devices: [
        { id: 'pc', type: 'pc', label: 'PC', x: 90, y: 150, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10', gateway: '192.168.1.1', arpTable: {}, dnsCache: {} },
        { id: 'dns', type: 'server', label: 'DNSサーバー', x: 90, y: 350, ip: '192.168.1.53', mac: 'DD:DD:DD:DD:DD:53', records: { 'shop.example.com': '203.0.113.21' } },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 280, y: 240, macTable: {} },
        {
          id: 'rt1', type: 'router', label: 'RT1', x: 450, y: 240, arpTable: {},
          interfaces: [
            { ip: '192.168.1.1', mac: '33:33:33:33:33:01', side: 'blue' },
            { ip: '203.0.113.1', mac: '33:33:33:33:33:02', side: 'red' },
          ],
        },
        { id: 'sw2', type: 'switch', label: 'SW2', x: 630, y: 240, macTable: {} },
        { id: 'srv', type: 'server', label: 'Web Server', x: 800, y: 240, ip: '203.0.113.21', mac: 'CC:CC:CC:CC:CC:21' },
      ],
      edges: [
        { id: 'e1', a: 'pc', b: 'sw1', connected: true },
        { id: 'e2', a: 'dns', b: 'sw1', connected: true },
        { id: 'e3', a: 'sw1', b: 'rt1', connected: true },
        { id: 'e4', a: 'rt1', b: 'sw2', connected: true },
        { id: 'e5', a: 'sw2', b: 'srv', connected: true },
      ],
      runtime: { success: false },
    };
  },
  renderActions(container, state, api) {
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:12px;color:var(--text-dim);align-self:center;';
    hint.textContent = 'https://shop.example.com/ にアクセスしてみよう。';
    container.appendChild(hint);
    const btn = document.createElement('button');
    btn.textContent = 'アクセスする';
    btn.addEventListener('click', () => {
      const dev = (id) => state.devices.find((d) => d.id === id);
      runWebMission(state, api, {
        client: dev('pc'), sw1: dev('sw1'), dns: dev('dns'), rt: dev('rt1'), sw2: dev('sw2'), server: dev('srv'),
        domain: 'shop.example.com',
        onSuccess: () => {
          state.stageRuntime.success = true;
          api.setStatus('DNS→ARP→ルーティング→TCP→HTTPが1本につながり、Webページが表示されました！', 'success');
          api.completeStage();
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

// ===================== ステージ12：TLS秘密通信 =====================

function runTlsHandshake(state, api, { client, server, scenario, onCertReceived }) {
  api.log(`${client.label}「対応できる暗号方式はどれですか？」（ClientHello）`);
  const hello1 = { type: 'TLS-CLIENTHELLO', srcMac: client.mac, dstMac: server.mac };
  const p1 = createPacket({
    ...hello1, fromId: client.id, toId: server.id,
    onArrive: (s) => {
      api.log(`${server.label}「この暗号方式にしましょう。こちらが証明書です」（ServerHello + 証明書）`, 'ok');
      const hello2 = {
        type: 'TLS-SERVERHELLO', srcMac: server.mac, dstMac: client.mac,
        certSubject: scenario.certSubject, certIssuer: scenario.certIssuer,
        certValidUntil: scenario.certValidUntil, requestedDomain: scenario.requestedDomain,
      };
      const p2 = createPacket({
        ...hello2, fromId: server.id, toId: client.id,
        onArrive: (s2) => {
          api.log(`${client.label}が証明書を受け取りました。内容を確認してください。`, 'arp');
          onCertReceived(s2, scenario);
        },
      });
      s.packets.push(p2);
      api.render();
    },
  });
  state.packets.push(p1);
  api.render();
}

function proceedTlsAfterTrust(state, api, { client, server, onEstablished }) {
  api.log(`${client.label}「この鍵を使って暗号化しましょう」（鍵交換）`, 'arp');
  const key = { type: 'TLS-KEYEXCHANGE', srcMac: client.mac, dstMac: server.mac };
  const p1 = createPacket({
    ...key, fromId: client.id, toId: server.id,
    onArrive: (s) => {
      api.log(`${server.label}「了解、これで暗号化通信を開始します」（Finished）`, 'ok');
      const fin = { type: 'TLS-FINISHED', srcMac: server.mac, dstMac: client.mac };
      const p2 = createPacket({
        ...fin, fromId: server.id, toId: client.id,
        onArrive: (s2) => {
          api.log('TLSハンドシェイク完了。ここから先は暗号化されます。', 'ok');
          const plain = 'password: network123';
          const cipher = plain.split('').map((c) => c.charCodeAt(0).toString(16)).join('');
          api.log(`暗号化前：${plain}`);
          api.log(`暗号化後：${cipher}`, 'ok');
          const appData = { type: 'TLS-APPDATA', srcMac: client.mac, dstMac: server.mac, data: cipher, note: `平文: ${plain}` };
          const p3 = createPacket({
            ...appData, fromId: client.id, toId: server.id,
            onArrive: (s3) => {
              api.log(`${server.label}が暗号化データを受信しました。`, 'ok');
              onEstablished(s3);
            },
          });
          s2.packets.push(p3);
          api.render();
        },
      });
      s.packets.push(p2);
      api.render();
    },
  });
  state.packets.push(p1);
  api.render();
}

const TLS_SCENARIOS = {
  legit: {
    certSubject: 'example.com', certIssuer: '信頼された認証局', certValidUntil: '2027-06-30',
    requestedDomain: 'example.com', legit: true,
  },
  fake: {
    certSubject: 'www.evil.example', certIssuer: '信頼された認証局', certValidUntil: '2027-06-30',
    requestedDomain: 'example.com', legit: false,
  },
};

const stage12 = {
  id: 'stage12',
  navLabel: '12. TLS',
  title: 'ステージ12：TLS秘密通信',
  missionText: 'HTTPSサーバーに接続すると、証明書が提示される。発行対象がアクセス先ドメインと一致しているかを確認してから信頼するかどうかを判断しよう。\n正規サーバーには「信頼する」、なりすましサーバーには「信頼しない」を選べるようになろう。',
  dialogue: [
    { who: 'cat', text: 'HTTPSで通信するときは、まず<strong>TLS</strong>で暗号化の準備をするんだ。相手が本物かどうかを確認する<strong>証明書</strong>もここでチェックする。' },
    { who: 'rabbit', text: '証明書があるなら信じて大丈夫なんじゃ…？' },
    { who: 'cat', text: '油断は禁物。証明書の「発行対象」が、アクセスしたいドメインと一致しているか必ず確認するんだよ。なりすましサーバーは、違うドメイン名の証明書を出してくることがある。' },
    { who: 'rabbit', text: '例えばexample.comにアクセスしたいのに、証明書の発行対象がwww.evil.exampleだったら…', variant: 'think' },
    { who: 'cat', text: 'それは危険信号！正規サーバーなら信頼して、怪しいサーバーはきっぱり拒否しよう。' },
  ],
  revealFields: { ip: true, mac: true, ttl: false, port: true },
  zones: [],
  editableCables: false,
  tablesToShow: [],
  build() {
    return {
      devices: [
        { id: 'pc', type: 'pc', label: 'PC', x: 200, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10' },
        { id: 'srv', type: 'server', label: 'HTTPSサーバー', x: 700, y: 240, ip: '203.0.113.20', mac: 'CC:CC:CC:CC:CC:43' },
      ],
      edges: [{ id: 'e1', a: 'pc', b: 'srv', connected: true }],
      runtime: { acceptedLegit: false, rejectedFake: false, pendingCert: null },
    };
  },
  renderActions(container, state, api) {
    const dev = (id) => state.devices.find((d) => d.id === id);
    const select = document.createElement('select');
    select.appendChild(new Option('正規サーバーに接続 (example.com)', 'legit'));
    select.appendChild(new Option('なりすましサーバーに接続', 'fake'));
    container.appendChild(labeledWrap('接続先', select));

    const btn = document.createElement('button');
    btn.textContent = 'HTTPS接続を開始する';
    btn.addEventListener('click', () => {
      const scenario = TLS_SCENARIOS[select.value];
      runTlsHandshake(state, api, {
        client: dev('pc'), server: dev('srv'), scenario,
        onCertReceived: (s, sc) => {
          state.stageRuntime.pendingCert = sc;
          api.refreshActions();
        },
      });
    });
    container.appendChild(btn);

    if (state.stageRuntime.pendingCert) {
      const cert = state.stageRuntime.pendingCert;
      const quizRow = document.createElement('div');
      quizRow.className = 'quiz-row';
      const info = document.createElement('span');
      info.style.cssText = 'font-family:Consolas,monospace;font-size:11px;white-space:pre-line;';
      info.textContent = `アクセス先: ${cert.requestedDomain}\n発行対象: ${cert.certSubject}\n発行者: ${cert.certIssuer}\n有効期限: ${cert.certValidUntil}\nこの証明書を信頼しますか？`;
      quizRow.appendChild(info);

      const trustBtn = document.createElement('button');
      trustBtn.textContent = '信頼する';
      trustBtn.addEventListener('click', () => {
        state.stageRuntime.pendingCert = null;
        if (cert.legit) {
          api.log('正しい判断です。証明書の発行対象がアクセス先と一致しています。', 'ok');
          proceedTlsAfterTrust(state, api, {
            client: dev('pc'), server: dev('srv'),
            onEstablished: () => {
              state.stageRuntime.acceptedLegit = true;
              if (state.stageRuntime.acceptedLegit && state.stageRuntime.rejectedFake) {
                api.setStatus('正規サーバーとの暗号化通信、なりすましの検知、両方できました！', 'success');
                api.completeStage();
              }
              api.render();
            },
          });
        } else {
          api.log('危険：証明書の発行対象がアクセス先ドメインと一致していません。なりすましを見逃してしまいました！', 'err');
        }
        api.refreshActions();
      });
      quizRow.appendChild(trustBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'secondary';
      rejectBtn.textContent = '信頼しない';
      rejectBtn.addEventListener('click', () => {
        state.stageRuntime.pendingCert = null;
        if (!cert.legit) {
          api.log('正しく検知できました！なりすましサーバーへの接続を拒否しました。', 'ok');
          state.stageRuntime.rejectedFake = true;
          if (state.stageRuntime.acceptedLegit && state.stageRuntime.rejectedFake) {
            api.setStatus('正規サーバーとの暗号化通信、なりすましの検知、両方できました！', 'success');
            api.completeStage();
          }
        } else {
          api.log('正しい証明書なのに拒否してしまいました。正規サーバーにも接続してみましょう。', 'err');
        }
        api.refreshActions();
        api.render();
      });
      quizRow.appendChild(rejectBtn);
      container.appendChild(quizRow);
    }
  },
};

// ===================== ステージ13：VLANで部署を分離 =====================

const stage13 = {
  id: 'stage13',
  navLabel: '13. VLAN',
  title: 'ステージ13：VLANで部署を分離',
  missionText: '同じスイッチにつながっていても、VLANが違えば別のネットワークとして分離される。\n同じVLAN同士は直接通信できるが、違うVLAN同士は壁にぶつかる。ルーターの助けを借りれば一部のVLAN間だけ通信できるようになる（来客VLANは他部署から隔離されたまま）。',
  dialogue: [
    { who: 'cat', text: '同じスイッチにつながっていても、部署ごとに通信を分けたいときがあるよね。そこで使うのが<strong>VLAN</strong>だよ。' },
    { who: 'rabbit', text: '配線を分けなくても、分離できるんですか？' },
    { who: 'cat', text: 'うん、論理的に壁を作るイメージだね。同じVLAN同士は普通に話せるけど、違うVLAN同士は届かない。' },
    { who: 'rabbit', text: 'でも部署をまたいで連絡したいこともありますよね？', variant: 'think' },
    { who: 'cat', text: 'そのときは<strong>ルーター（L3スイッチ）</strong>の出番。ただし、来客用Wi-FiのVLANだけは、セキュリティのために他の部署から完全に隔離されたままにしてあるよ。' },
  ],
  revealFields: { ip: true, mac: true, ttl: true, port: false },
  zones: [],
  editableCables: false,
  tablesToShow: [
    { deviceId: 'sw1', kind: 'mac', title: 'スイッチのMACアドレステーブル' },
    { deviceId: 'rt1', kind: 'arp', title: 'ルーターのARPテーブル' },
  ],
  build() {
    return {
      devices: [
        { id: 'salesA', type: 'pc', label: '営業部A (VLAN10)', x: 100, y: 130, ip: '10.0.10.10', mac: 'AA:10:00:00:00:01', gateway: '10.0.10.1', arpTable: {} },
        { id: 'salesB', type: 'pc', label: '営業部B (VLAN10)', x: 100, y: 350, ip: '10.0.10.20', mac: 'AA:10:00:00:00:02', gateway: '10.0.10.1', arpTable: {} },
        { id: 'dev', type: 'pc', label: '開発部 (VLAN20)', x: 350, y: 90, ip: '10.0.20.10', mac: 'AA:20:00:00:00:01', gateway: '10.0.20.1', arpTable: {} },
        { id: 'acc', type: 'pc', label: '経理部 (VLAN30)', x: 350, y: 390, ip: '10.0.30.10', mac: 'AA:30:00:00:00:01', gateway: '10.0.30.1', arpTable: {} },
        { id: 'guest', type: 'pc', label: '来客Wi-Fi (VLAN99)', x: 600, y: 130, ip: '10.0.99.10', mac: 'AA:99:00:00:00:01', gateway: null, arpTable: {} },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 450, y: 300, macTable: {} },
        {
          id: 'rt1', type: 'router', label: 'RT1(L3)', x: 650, y: 350, arpTable: {},
          interfaces: [
            { ip: '10.0.10.1', mac: 'FF:10:00:00:00:01', vlan: 10, side: '10' },
            { ip: '10.0.20.1', mac: 'FF:20:00:00:00:01', vlan: 20, side: '20' },
            { ip: '10.0.30.1', mac: 'FF:30:00:00:00:01', vlan: 30, side: '30' },
          ],
        },
      ],
      edges: [
        { id: 'e1', a: 'salesA', b: 'sw1', connected: true },
        { id: 'e2', a: 'salesB', b: 'sw1', connected: true },
        { id: 'e3', a: 'dev', b: 'sw1', connected: true },
        { id: 'e4', a: 'acc', b: 'sw1', connected: true },
        { id: 'e5', a: 'guest', b: 'sw1', connected: true },
        { id: 'e6', a: 'sw1', b: 'rt1', connected: true },
      ],
      runtime: { sameVlanOk: false, blockedObserved: false, crossVlanRouted: false },
    };
  },
  renderActions(container, state, api) {
    const dev = (id) => state.devices.find((d) => d.id === id);
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
    btn.textContent = '送信する';
    btn.addEventListener('click', () => {
      const src = dev(srcSelect.value);
      const dst = dev(dstSelect.value);
      if (src.id === dst.id) { api.log('送信元と宛先が同じです。', 'err'); return; }
      const sw = dev('sw1');
      const rt = dev('rt1');
      const srcVlanNum = vlanOf(src);
      const dstVlanNum = vlanOf(dst);

      if (srcVlanNum === dstVlanNum) {
        api.log(`${src.label}が${dst.label}（同じVLAN）へフレームを送信しました。`);
        const frame = { type: 'DATA', srcMac: src.mac, dstMac: dst.mac };
        sendFrameToSwitch(state, api, sw, src.id, frame, () => {
          relayThroughSwitch(state, api, sw, src.id, frame, (s2, device) => {
            if (device.id === dst.id) {
              api.log(`${device.label}が受信しました。`, 'ok');
              state.stageRuntime.sameVlanOk = true;
              checkStage13Win(state, api);
            } else if (device.id !== rt.id) {
              api.log(`${device.label}は自分宛てではないため破棄しました。`);
            }
            api.render();
          });
        });
        return;
      }

      const rtHasBoth = rt.interfaces.some((i) => i.vlan === srcVlanNum) && rt.interfaces.some((i) => i.vlan === dstVlanNum);
      if (!rtHasBoth) {
        api.log(`${src.label}（VLAN${srcVlanNum}）から${dst.label}（VLAN${dstVlanNum}）へは、透明な壁にぶつかりました。VLANが異なるため通信できません。`, 'err');
        state.stageRuntime.blockedObserved = true;
        checkStage13Win(state, api);
        return;
      }

      api.log(`${src.label}（VLAN${srcVlanNum}）は別VLANのため、ルーター（L3スイッチ）経由で送ります。`, 'arp');
      runRouterPing(state, api, {
        client: src, sw1: sw, rt, sw2: sw, server: dst,
        onSuccess: () => {
          state.stageRuntime.crossVlanRouted = true;
          checkStage13Win(state, api);
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

function vlanOf(device) {
  return Number(device.ip.split('.')[2]);
}

function checkStage13Win(state, api) {
  const r = state.stageRuntime;
  if (r.sameVlanOk && r.blockedObserved && r.crossVlanRouted) {
    api.setStatus('同一VLAN内通信、VLAN間の遮断、ルーター経由での許可、すべて確認できました！', 'success');
    api.completeStage();
  }
}

// ===================== ステージ14：NAT =====================

function runNatPing(state, api, { client, sw1, rt, sw2, server, onSuccess }) {
  const privateIface = rt.interfaces.find((i) => i.side === 'private');
  const publicIface = rt.interfaces.find((i) => i.side === 'public');
  const srcPort = 51000 + Math.floor(Math.random() * 900);

  function stepGateway() {
    if (client.arpTable[client.gateway]) { stepToRouter(); return; }
    resolveArpOverSwitch(state, api, sw1, client, client.gateway, (mac) => {
      client.arpTable[client.gateway] = mac;
      stepToRouter();
    });
  }

  function stepToRouter() {
    const gwMac = client.arpTable[client.gateway];
    api.log(`${client.label}が${server.ip}へpingを送信します（送信元 ${client.ip}:${srcPort}）。`);
    const frame = { type: 'ICMP-ECHO', srcMac: client.mac, dstMac: gwMac, srcIp: client.ip, dstIp: server.ip, srcPort, ttl: 64 };
    sendFrameToSwitch(state, api, sw1, client.id, frame, () => {
      relayThroughSwitch(state, api, sw1, client.id, frame, (s2, device) => {
        if (device.id !== rt.id) return;
        natTranslateOut(s2, frame);
      });
    });
  }

  function natTranslateOut(state2, frame) {
    const ttl = frame.ttl - 1;
    const key = `${frame.srcIp}:${frame.srcPort}`;
    let globalPort = rt.natTable[key];
    if (!globalPort) {
      globalPort = rt.nextPort;
      rt.nextPort += 1;
      rt.natTable[key] = globalPort;
      rt.natReverse[globalPort] = key;
      api.log(`${rt.label}（NAT）：${key} を ${publicIface.ip}:${globalPort} に変換し、対応表に登録しました。`, 'arp');
    } else {
      api.log(`${rt.label}（NAT）：${key} は既に ${publicIface.ip}:${globalPort} に対応付けられています。`, 'ok');
    }
    const forward = (dstMac) => {
      const outFrame = { type: 'ICMP-ECHO', srcMac: publicIface.mac, dstMac, srcIp: publicIface.ip, dstIp: frame.dstIp, srcPort: globalPort, ttl };
      sendFrameToSwitch(state2, api, sw2, rt.id, outFrame, () => {
        relayThroughSwitch(state2, api, sw2, rt.id, outFrame, (s3, device) => {
          if (device.id !== server.id) return;
          api.log(`${server.label}がpingを受信しました（送信元は${publicIface.ip}:${globalPort}にしか見えません）。`, 'ok');
          natReturnStep(s3, ttl, globalPort);
        });
      });
    };
    if (rt.arpTable[server.ip]) {
      forward(rt.arpTable[server.ip]);
    } else {
      resolveArpOverSwitch(state2, api, sw2, { id: rt.id, mac: publicIface.mac, ip: publicIface.ip, label: rt.label }, server.ip, (mac) => {
        rt.arpTable[server.ip] = mac;
        forward(mac);
      });
    }
  }

  function natReturnStep(state3, ttlIn, globalPort) {
    const replyFrame = { type: 'ICMP-REPLY', srcMac: server.mac, dstMac: publicIface.mac, srcIp: server.ip, dstIp: publicIface.ip, dstPort: globalPort, ttl: 64 };
    sendFrameToSwitch(state3, api, sw2, server.id, replyFrame, () => {
      relayThroughSwitch(state3, api, sw2, server.id, replyFrame, (s4, device) => {
        if (device.id !== rt.id) return;
        const ttl = ttlIn - 1;
        const key = rt.natReverse[globalPort];
        const [privateIp, privatePortStr] = key.split(':');
        api.log(`${rt.label}（NAT）：宛先 ${publicIface.ip}:${globalPort} を対応表から ${privateIp}:${privatePortStr} に戻します。`, 'arp');
        const backFrame = { type: 'ICMP-REPLY', srcMac: privateIface.mac, dstMac: client.mac, srcIp: server.ip, dstIp: privateIp, dstPort: Number(privatePortStr), ttl };
        sendFrameToSwitch(s4, api, sw1, rt.id, backFrame, () => {
          relayThroughSwitch(s4, api, sw1, rt.id, backFrame, (s5, target) => {
            if (target.id !== client.id) return;
            api.log(`${client.label}がping応答を受信しました。通信成功！（相手からは社内のプライベートIPは見えません）`, 'ok');
            onSuccess(s5);
          });
        });
      });
    });
  }

  stepGateway();
}

const stage14 = {
  id: 'stage14',
  navLabel: '14. NAT',
  title: 'ステージ14：NAT（アドレス変換）',
  missionText: '社内のプライベートIPアドレスは、インターネットにそのままでは出られない。ルーターがNATで送信元をグローバルIPアドレスに変換する。\nPC-AとPC-Bの両方からアクセスし、1つのグローバルIPを複数のPCで共有できることを確認しよう。',
  dialogue: [
    { who: 'cat', text: '社内で使っているプライベートIPアドレス、実はそのままではインターネットに出られないんだ。' },
    { who: 'rabbit', text: 'え、じゃあどうやって外部のサイトを見てるんですか？' },
    { who: 'cat', text: 'ルーターが<strong>NAT</strong>という仕組みで、送信元を会社の代表となるグローバルIPアドレスに変換してくれているんだよ。' },
    { who: 'rabbit', text: 'みんな同じグローバルIPになったら、返事はどうやって正しいPCに届くんですか？', variant: 'think' },
    { who: 'cat', text: 'ポート番号ごとに対応表を作って区別しているんだ。PC-AとPC-B、両方から試して対応表を見てみよう。' },
  ],
  revealFields: { ip: true, mac: true, ttl: true, port: true },
  zones: [
    { x: 20, y: 170, w: 390, h: 150, color: 'blue', label: '社内LAN（プライベートIP）192.168.1.0/24' },
    { x: 440, y: 170, w: 400, h: 150, color: 'red', label: 'インターネット側（グローバルIP）' },
  ],
  editableCables: false,
  tablesToShow: [{ deviceId: 'rt1', kind: 'nat', title: 'NAT対応表' }],
  build() {
    return {
      devices: [
        { id: 'pcA', type: 'pc', label: 'PC-A', x: 90, y: 170, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10', gateway: '192.168.1.1', arpTable: {} },
        { id: 'pcB', type: 'pc', label: 'PC-B', x: 90, y: 320, ip: '192.168.1.11', mac: 'AA:AA:AA:AA:AA:11', gateway: '192.168.1.1', arpTable: {} },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 260, y: 240, macTable: {} },
        {
          id: 'rt1', type: 'router', label: 'RT1(NAT)', x: 430, y: 240, arpTable: {}, natTable: {}, natReverse: {}, nextPort: 40001,
          interfaces: [
            { ip: '192.168.1.1', mac: '44:44:44:44:44:01', side: 'private' },
            { ip: '203.0.113.5', mac: '44:44:44:44:44:02', side: 'public' },
          ],
        },
        { id: 'sw2', type: 'switch', label: 'SW2', x: 600, y: 240, macTable: {} },
        { id: 'srv', type: 'server', label: '外部サーバー', x: 800, y: 240, ip: '8.8.8.8', mac: 'CC:CC:CC:CC:CC:88' },
      ],
      edges: [
        { id: 'e1', a: 'pcA', b: 'sw1', connected: true },
        { id: 'e2', a: 'pcB', b: 'sw1', connected: true },
        { id: 'e3', a: 'sw1', b: 'rt1', connected: true },
        { id: 'e4', a: 'rt1', b: 'sw2', connected: true },
        { id: 'e5', a: 'sw2', b: 'srv', connected: true },
      ],
      runtime: { pcASuccess: false, pcBSuccess: false },
    };
  },
  renderActions(container, state, api) {
    const dev = (id) => state.devices.find((d) => d.id === id);
    const mkBtn = (label, clientId, key) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        runNatPing(state, api, {
          client: dev(clientId), sw1: dev('sw1'), rt: dev('rt1'), sw2: dev('sw2'), server: dev('srv'),
          onSuccess: () => {
            state.stageRuntime[key] = true;
            if (state.stageRuntime.pcASuccess && state.stageRuntime.pcBSuccess) {
              api.setStatus('複数のPCが1つのグローバルIPを共有してインターネットに出られることを確認できました！', 'success');
              api.completeStage();
            }
            api.render();
          },
        });
      });
      return btn;
    };
    container.appendChild(mkBtn('PC-Aからpingを送る', 'pcA', 'pcASuccess'));
    container.appendChild(mkBtn('PC-Bからpingを送る', 'pcB', 'pcBSuccess'));
  },
};

// ===================== ステージ15：ファイアウォール =====================

const stage15 = {
  id: 'stage15',
  navLabel: '15. FW',
  title: 'ステージ15：ファイアウォール',
  missionText: 'ファイアウォールは、ポート番号ごとに通信を許可・遮断するルールを持つ。443番ポート（HTTPS）が遮断されているようだ。\nまず接続を試して失敗を確認し、ルールを直してからもう一度接続してみよう。',
  dialogue: [
    { who: 'cat', text: 'ネットワークの入り口には門番、<strong>ファイアウォール</strong>がいる。ポート番号ごとに通していいか、ダメかを判断するんだ。' },
    { who: 'rabbit', text: '443番ポートで接続できないって、利用者から苦情が来てます！', variant: 'think' },
    { who: 'cat', text: 'まずは実際に接続してみて、本当に遮断されているか確認しよう。原因が分かったら、ルールを直せばいい。' },
    { who: 'rabbit', text: '探偵うさ美、今度はファイアウォール担当です！' },
  ],
  revealFields: { ip: true, mac: true, ttl: false, port: true },
  zones: [],
  editableCables: false,
  tablesToShow: [{ deviceId: 'fw1', kind: 'firewall', title: 'ファイアウォールのルール' }],
  build() {
    return {
      devices: [
        { id: 'pc', type: 'pc', label: 'PC', x: 150, y: 240, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10' },
        { id: 'fw1', type: 'firewall', label: 'FW1', x: 450, y: 240, mac: 'EE:EE:EE:EE:EE:01', rules: { 80: true, 443: false } },
        { id: 'srv', type: 'server', label: 'Webサーバー', x: 750, y: 240, ip: '203.0.113.20', mac: 'CC:CC:CC:CC:CC:43' },
      ],
      edges: [
        { id: 'e1', a: 'pc', b: 'fw1', connected: true },
        { id: 'e2', a: 'fw1', b: 'srv', connected: true },
      ],
      runtime: { blockedObserved: false, fixedAndSucceeded: false },
    };
  },
  renderActions(container, state, api) {
    const dev = (id) => state.devices.find((d) => d.id === id);
    const select = document.createElement('select');
    select.appendChild(new Option('443 (HTTPS)', '443'));
    select.appendChild(new Option('80 (HTTP)', '80'));
    container.appendChild(labeledWrap('宛先ポート', select));

    const connectBtn = document.createElement('button');
    connectBtn.textContent = '接続する';
    connectBtn.addEventListener('click', () => {
      const client = dev('pc');
      const fw = dev('fw1');
      const server = dev('srv');
      const port = Number(select.value);
      api.log(`${client.label}が${server.ip}の${port}番ポートへ接続を試みます。`);
      const frame = { type: 'TCP-SYN', srcMac: client.mac, dstMac: fw.mac, srcIp: client.ip, dstIp: server.ip, srcPort: 51000, dstPort: port };
      const p1 = createPacket({
        ...frame, fromId: client.id, toId: fw.id,
        onArrive: (s) => {
          if (!fw.rules[port]) {
            api.log(`${fw.label}：${port}番ポート宛ての通信はルールで遮断されています。`, 'err');
            state.stageRuntime.blockedObserved = true;
            api.render();
            return;
          }
          api.log(`${fw.label}：${port}番ポートは許可されているため通過させます。`, 'ok');
          const p2 = createPacket({
            ...frame, srcMac: fw.mac, fromId: fw.id, toId: server.id,
            onArrive: (s2) => {
              api.log(`${server.label}が接続を受け付けました。`, 'ok');
              if (port === 443 && state.stageRuntime.blockedObserved) {
                state.stageRuntime.fixedAndSucceeded = true;
                api.setStatus('ファイアウォールのルールを直し、HTTPS接続を通せるようになりました！', 'success');
                api.completeStage();
              }
              api.render();
            },
          });
          s.packets.push(p2);
          api.render();
        },
      });
      state.packets.push(p1);
      api.render();
    });
    container.appendChild(connectBtn);

    const fixBtn = document.createElement('button');
    fixBtn.className = 'secondary';
    fixBtn.textContent = '443番ポートを許可するルールに直す';
    fixBtn.addEventListener('click', () => {
      dev('fw1').rules[443] = true;
      api.log('ファイアウォールのルールを修正しました：443番ポートを許可。', 'ok');
      api.render();
    });
    container.appendChild(fixBtn);
  },
};

// ===================== ステージ16：障害調査モード =====================

const stage16 = {
  id: 'stage16',
  navLabel: '16. 障害調査',
  title: '障害調査モード：社員「インターネットが壊れました！」',
  missionText: 'どこかの配線が切れているようだ。ネットワーク図をよく確認し、切れている配線を見つけて繋ぎ直してから「アクセスする」を押そう。\n（配線はクリックで抜き差しできる。ステージをリセットすると別の箇所が切れた状態になる）',
  dialogue: [
    { who: 'cat', text: '最後の仕上げだよ。社員さんから「インターネットが壊れました！」と連絡があった。' },
    { who: 'rabbit', text: '原因は毎回違うんですよね？' },
    { who: 'cat', text: 'そう。今まで学んだ知識を総動員して、ネットワーク図を見ながらどこがおかしいのか突き止めよう。焦らず、配線から順番に確認するといいよ。' },
    { who: 'rabbit', text: '今度こそ完璧に解決してみせます！', variant: 'think' },
  ],
  revealFields: { ip: true, mac: true, ttl: true, port: true },
  zones: [
    { x: 20, y: 100, w: 390, h: 300, color: 'blue', label: '社内LAN 192.168.1.0/24' },
    { x: 440, y: 170, w: 400, h: 150, color: 'red', label: 'インターネット側 203.0.113.0/24' },
  ],
  editableCables: true,
  tablesToShow: [
    { deviceId: 'pc', kind: 'dns', title: 'PCのDNSキャッシュ' },
    { deviceId: 'pc', kind: 'arp', title: 'PCのARPテーブル' },
    { deviceId: 'rt1', kind: 'arp', title: 'ルーターのARPテーブル' },
  ],
  build() {
    const edges = [
      { id: 'e1', a: 'pc', b: 'sw1', connected: true },
      { id: 'e2', a: 'dns', b: 'sw1', connected: true },
      { id: 'e3', a: 'sw1', b: 'rt1', connected: true },
      { id: 'e4', a: 'rt1', b: 'sw2', connected: true },
      { id: 'e5', a: 'sw2', b: 'srv', connected: true },
    ];
    const brokenIndex = Math.floor(Math.random() * edges.length);
    edges[brokenIndex].connected = false;
    return {
      devices: [
        { id: 'pc', type: 'pc', label: 'PC', x: 90, y: 150, ip: '192.168.1.10', mac: 'AA:AA:AA:AA:AA:10', gateway: '192.168.1.1', arpTable: {}, dnsCache: {} },
        { id: 'dns', type: 'server', label: 'DNSサーバー', x: 90, y: 350, ip: '192.168.1.53', mac: 'DD:DD:DD:DD:DD:53', records: { 'shop.example.com': '203.0.113.21' } },
        { id: 'sw1', type: 'switch', label: 'SW1', x: 280, y: 240, macTable: {} },
        {
          id: 'rt1', type: 'router', label: 'RT1', x: 450, y: 240, arpTable: {},
          interfaces: [
            { ip: '192.168.1.1', mac: '55:55:55:55:55:01', side: 'blue' },
            { ip: '203.0.113.1', mac: '55:55:55:55:55:02', side: 'red' },
          ],
        },
        { id: 'sw2', type: 'switch', label: 'SW2', x: 630, y: 240, macTable: {} },
        { id: 'srv', type: 'server', label: 'Web Server', x: 800, y: 240, ip: '203.0.113.21', mac: 'CC:CC:CC:CC:CC:21' },
      ],
      edges,
      runtime: { success: false },
    };
  },
  renderActions(container, state, api) {
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:12px;color:var(--text-dim);align-self:center;';
    hint.textContent = '社員「shop.example.com が見られません！」原因を調査して復旧させよう。';
    container.appendChild(hint);
    const btn = document.createElement('button');
    btn.textContent = 'アクセスする';
    btn.addEventListener('click', () => {
      const dev = (id) => state.devices.find((d) => d.id === id);
      runWebMission(state, api, {
        client: dev('pc'), sw1: dev('sw1'), dns: dev('dns'), rt: dev('rt1'), sw2: dev('sw2'), server: dev('srv'),
        domain: 'shop.example.com',
        onSuccess: () => {
          state.stageRuntime.success = true;
          api.setStatus('原因を特定して復旧し、無事にWebページが表示されました！', 'success');
          api.completeStage();
          api.render();
        },
      });
    });
    container.appendChild(btn);
  },
};

export const STAGES = [
  stage1, stage2, stage3, stage4, stage5, finalStage,
  stage7, stage8, stage9, stage10, stage11,
  stage12, stage13, stage14, stage15, stage16,
];

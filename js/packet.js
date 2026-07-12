// パケット（フレーム）の生成・移動・詳細表示
import { findEdgeBetween } from './network.js';

let counter = 0;

/**
 * @param {object} opts
 * @param {string} opts.type DATA | ARP-REQUEST | ARP-REPLY | ICMP-ECHO | ICMP-REPLY
 * @param {string} opts.fromId 出発デバイスID
 * @param {string} opts.toId   到着デバイスID（=辺のもう一方）
 * @param {function(object, object):void} opts.onArrive 到着時コールバック(state, packet)
 */
export function createPacket(opts) {
  counter += 1;
  return {
    id: `pkt-${counter}`,
    type: opts.type,
    srcMac: opts.srcMac ?? null,
    dstMac: opts.dstMac ?? null,
    srcIp: opts.srcIp ?? null,
    dstIp: opts.dstIp ?? null,
    ttl: opts.ttl ?? null,
    srcPort: opts.srcPort ?? null,
    dstPort: opts.dstPort ?? null,
    seq: opts.seq ?? null,
    ack: opts.ack ?? null,
    arpQueryIp: opts.arpQueryIp ?? null,
    queryDomain: opts.queryDomain ?? null,
    certSubject: opts.certSubject ?? null,
    certIssuer: opts.certIssuer ?? null,
    certValidUntil: opts.certValidUntil ?? null,
    requestedDomain: opts.requestedDomain ?? null,
    data: opts.data ?? null,
    note: opts.note ?? null,
    dstMacTag: opts.dstMacTag ?? null,
    dstIpTag: opts.dstIpTag ?? null,
    fromId: opts.fromId,
    toId: opts.toId,
    progress: 0,
    dropped: false,
    onArrive: opts.onArrive,
    onDrop: opts.onDrop ?? null,
  };
}

const BASE_SPEED = 0.55; // progress / 秒

/** アニメーションを1フレーム進める。到着・落下したパケットのコールバックを呼ぶ。 */
export function stepPackets(state, dtSeconds, speedMultiplier) {
  const finished = [];
  for (const packet of state.packets) {
    if (packet.dropped) continue;
    const edge = findEdgeBetween(state, packet.fromId, packet.toId);
    if (!edge || !edge.connected) {
      packet.dropped = true;
      finished.push({ kind: 'drop', packet });
      continue;
    }
    packet.progress += BASE_SPEED * dtSeconds * speedMultiplier;
    if (packet.progress >= 1) {
      packet.progress = 1;
      finished.push({ kind: 'arrive', packet });
    }
  }
  if (finished.length === 0) return;
  for (const f of finished) {
    state.packets = state.packets.filter((p) => p !== f.packet);
  }
  for (const f of finished) {
    if (f.kind === 'arrive' && f.packet.onArrive) f.packet.onArrive(state, f.packet);
    if (f.kind === 'drop' && f.packet.onDrop) f.packet.onDrop(state, f.packet);
  }
}

const TYPE_LABEL = {
  DATA: 'データフレーム',
  'ARP-REQUEST': 'ARP要求（ブロードキャスト）',
  'ARP-REPLY': 'ARP応答',
  'ICMP-ECHO': 'ICMP Echo Request（ping）',
  'ICMP-REPLY': 'ICMP Echo Reply（ping応答）',
  'DHCP-DISCOVER': 'DHCP Discover（ブロードキャスト）',
  'DHCP-OFFER': 'DHCP Offer',
  'DHCP-REQUEST': 'DHCP Request',
  'DHCP-ACK': 'DHCP ACK',
  'DNS-QUERY': 'DNS問い合わせ',
  'DNS-RESPONSE': 'DNS応答',
  'TCP-SYN': 'TCP SYN',
  'TCP-SYNACK': 'TCP SYN/ACK',
  'TCP-ACK': 'TCP ACK',
  'TCP-DATA': 'TCPデータ',
  'TCP-DATA-ACK': 'TCPデータ ACK',
  'UDP-DATA': 'UDPデータ',
  'HTTP-GET': 'HTTP GETリクエスト',
  'HTTP-RESPONSE': 'HTTP レスポンス',
  'TLS-CLIENTHELLO': 'TLS ClientHello',
  'TLS-SERVERHELLO': 'TLS ServerHello + 証明書',
  'TLS-KEYEXCHANGE': 'TLS 鍵交換',
  'TLS-FINISHED': 'TLS Finished',
  'TLS-APPDATA': 'TLS 暗号化データ',
};

/**
 * サイドパネル表示用に、ステージで解禁されている情報だけを整形して返す。
 * @param {{ip?:boolean, mac?:boolean, ttl?:boolean, port?:boolean}} reveal
 */
export function packetDetailRows(packet, reveal, resolveLabel) {
  const rows = [];
  rows.push({ k: '種類', v: TYPE_LABEL[packet.type] ?? packet.type });

  if (reveal.mac && packet.srcMac) rows.push({ k: '送信元MAC', v: packet.srcMac });
  if (reveal.mac && packet.dstMac) rows.push({ k: '宛先MAC', v: packet.dstMac, tag: packet.dstMacTag });

  if (reveal.ip && packet.srcIp) rows.push({ k: '送信元IP', v: packet.srcIp });
  if (reveal.ip && packet.dstIp) rows.push({ k: '宛先IP', v: packet.dstIp, tag: packet.dstIpTag });

  if (!reveal.ip && !reveal.mac) {
    rows.push({ k: '送信元', v: resolveLabel ? resolveLabel(packet.fromId) : packet.fromId });
    rows.push({ k: '宛先', v: resolveLabel ? resolveLabel(packet.toId) : packet.toId });
  }

  if (reveal.port && packet.srcPort != null) rows.push({ k: '送信元ポート', v: packet.srcPort });
  if (reveal.port && packet.dstPort != null) rows.push({ k: '宛先ポート', v: packet.dstPort });
  if (reveal.port && packet.seq != null) rows.push({ k: 'シーケンス番号', v: packet.seq });
  if (reveal.port && packet.ack != null) rows.push({ k: 'ACK番号', v: packet.ack });

  if (reveal.ttl && packet.ttl != null) rows.push({ k: 'TTL', v: packet.ttl });
  if (packet.arpQueryIp) rows.push({ k: '問い合わせ先IP', v: packet.arpQueryIp });
  if (packet.queryDomain) rows.push({ k: '問い合わせドメイン', v: packet.queryDomain });
  if (packet.requestedDomain) rows.push({ k: 'アクセス先ドメイン', v: packet.requestedDomain });
  if (packet.certSubject) rows.push({ k: '証明書の発行対象', v: packet.certSubject });
  if (packet.certIssuer) rows.push({ k: '証明書の発行者', v: packet.certIssuer });
  if (packet.certValidUntil) rows.push({ k: '証明書の有効期限', v: packet.certValidUntil });
  if (packet.data) rows.push({ k: 'データ', v: packet.data });
  if (packet.note) rows.push({ k: 'メモ', v: packet.note });
  return rows;
}

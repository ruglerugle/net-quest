// デバイス・トポロジーに関する純粋関数群

export function subnetOf(ip) {
  if (!ip) return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return parts.slice(0, 3).join('.');
}

export function sameSubnet(ipA, ipB) {
  const a = subnetOf(ipA);
  const b = subnetOf(ipB);
  return a !== null && a === b;
}

export function subnetColor(ip) {
  const s = subnetOf(ip);
  if (s === '192.168.1') return 'blue';
  if (s === '192.168.2') return 'red';
  return null;
}

export function edgesOf(state, deviceId) {
  return state.edges.filter((e) => e.a === deviceId || e.b === deviceId);
}

export function otherEnd(edge, deviceId) {
  return edge.a === deviceId ? edge.b : edge.a;
}

export function findEdgeBetween(state, idA, idB) {
  return state.edges.find(
    (e) => (e.a === idA && e.b === idB) || (e.a === idB && e.b === idA)
  );
}

/**
 * スイッチの転送先（隣接デバイスIDの配列）を決定する。
 * MACアドレステーブルの学習も同時に行う。
 * 宛先MACが既知ならユニキャスト1件、未知またはブロードキャストならフラッディングで複数件を返す。
 * @returns {{targets: string[], flooded: boolean}}
 */
export function switchForwardTargets(switchDevice, fromNeighborId, srcMac, dstMac, allNeighbors) {
  switchDevice.macTable[srcMac] = fromNeighborId;
  const others = allNeighbors.filter((n) => n !== fromNeighborId);
  const knownPort = switchDevice.macTable[dstMac];
  if (dstMac !== 'FF:FF:FF:FF:FF:FF' && knownPort && others.includes(knownPort)) {
    return { targets: [knownPort], flooded: false };
  }
  return { targets: others, flooded: others.length > 1 };
}

/**
 * デバイスが持つインターフェース（IP/MACの組）から、指定IPに一致するものを探す。
 * ルーターのような複数インターフェースを持つデバイスにも、単一IPのPC/サーバーにも対応する。
 */
export function matchInterface(device, ip) {
  const ifaces = device.interfaces ?? (device.ip ? [{ ip: device.ip, mac: device.mac }] : []);
  return ifaces.find((i) => i.ip === ip) ?? null;
}

/* ============================================================
   実験ウィジェット（ネットワーククエスト）
   - Ladder.mount(el, cfg)：やり取りの図（ラダー図）を1歩ずつ進める汎用部品
   - <div class="lab" data-lab="種類" data-id="課題ID">：個別の実験
   ============================================================ */
(function (global) {
  "use strict";
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function head(title) { return '<div class="lab-head"><span class="lab-badge">実験</span><span class="lab-title">' + title + "</span></div>"; }
  function prep(root, id) {
    id = id || root.getAttribute("data-id");
    if (id) root.setAttribute("data-task", id);
    return !!(id && global.QUEST && global.QUEST.isTaskDone(id));
  }
  function done(root, msg, id) {
    if (!root.classList.contains("solved")) {
      root.classList.add("solved");
      var b = root.querySelector(".lab-badge");
      if (b) b.textContent = "✓ 達成";
      id = id || root.getAttribute("data-id");
      if (id && global.QUEST) global.QUEST.taskDone(root, id);
    }
    if (msg) say(root, msg, true);
  }
  function say(root, msg, ok) {
    var s = root.querySelector(".lab-status");
    if (s) { s.innerHTML = msg; s.className = "lab-status" + (ok ? " ok" : ""); }
  }

  /* ---------- やり取りの図（汎用） ----------
     cfg = { id, title, actors: ["PC","サーバー"], steps: [ { from:0, to:1, label:"SYN", detail:"説明", lost:false, table:{見出し:[...行]} } ] }
     to が配列ならブロードキャスト（全員へ） */
  function ladder(root, cfg) {
    var already = prep(root, cfg.id);
    root.classList.add("lab");
    var k = -1;
    root.innerHTML = head(esc(cfg.title || "やり取りを1歩ずつ")) +
      '<div class="lad-wrap"><svg class="lad" role="img" aria-label="やり取りの図"></svg></div>' +
      '<div class="lad-table"></div>' +
      '<div class="row"><button type="button" class="btn lad-prev">◀ 戻る</button><span class="lad-prog"></span><button type="button" class="btn btn-primary lad-next">次へ ▶</button></div>' +
      '<p class="lab-status" aria-live="polite"></p>';
    var A = cfg.actors, W = Math.max(360, A.length * 130), colX = function (i) { return 60 + i * ((W - 120) / Math.max(1, A.length - 1)); };
    function draw() {
      var rowH = 34, H = 54 + cfg.steps.length * rowH + 10;
      var h = '<defs><marker id="ladA" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#1d6cc0"/></marker><marker id="ladX" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 z" fill="#c8433f"/></marker></defs>';
      A.forEach(function (a, i) {
        var x = colX(i);
        h += '<rect x="' + (x - 54) + '" y="6" width="108" height="30" rx="7" fill="#e9f1fb" stroke="#1d6cc0"/><text x="' + x + '" y="26" text-anchor="middle" font-size="12.5" font-weight="900">' + esc(a) + "</text>";
        h += '<line x1="' + x + '" y1="36" x2="' + x + '" y2="' + (H - 4) + '" stroke="#9fb6d3" stroke-dasharray="4 4"/>';
      });
      cfg.steps.forEach(function (s, i) {
        if (i > k) return;
        var y = 56 + i * rowH, x1 = colX(s.from);
        var tos = Array.isArray(s.to) ? s.to : [s.to];
        tos.forEach(function (t) {
          if (t === s.from) return; // 説明だけの段（自分自身）は線を引かない
          var x2 = colX(t), dir = x2 > x1 ? 1 : -1;
          var end = s.lost ? x1 + (x2 - x1) * 0.55 : x2 - dir * 4;
          h += '<line x1="' + (x1 + dir * 4) + '" y1="' + y + '" x2="' + end + '" y2="' + (y + 10) + '" stroke="' + (s.lost ? "#c8433f" : "#1d6cc0") + '" stroke-width="' + (i === k ? 3 : 2) + '" marker-end="url(#' + (s.lost ? "ladX" : "ladA") + ')"' + (s.lost ? ' stroke-dasharray="5 4"' : "") + "/>";
          if (s.lost) h += '<text x="' + (end + dir * 8) + '" y="' + (y + 15) + '" text-anchor="middle" font-size="14" fill="#c8433f" font-weight="900">✕</text>';
        });
        var lx = (x1 + colX(tos[0])) / 2;
        h += '<text x="' + lx + '" y="' + (y - 3) + '" text-anchor="middle" font-size="11.5" font-weight="' + (i === k ? 900 : 700) + '" fill="' + (i === k ? "#0d3560" : "#4a5f7a") + '">' + esc(s.label) + "</text>";
      });
      var svg = root.querySelector(".lad");
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      svg.setAttribute("width", W);
      svg.innerHTML = h;
      var t = null;
      for (var i = 0; i <= k; i++) if (cfg.steps[i].table) t = cfg.steps[i].table;
      root.querySelector(".lad-table").innerHTML = t ? Object.keys(t).map(function (title) {
        return '<div class="cpu-box"><h4>' + esc(title) + "</h4><table>" + t[title].map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + esc(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</table></div>";
      }).join("") : "";
      root.querySelector(".lad-prog").textContent = (k + 1) + " / " + cfg.steps.length;
      root.querySelector(".lad-prev").disabled = k < 0;
      root.querySelector(".lad-next").disabled = k >= cfg.steps.length - 1;
      if (k < 0) say(root, cfg.start || "「次へ」で1つずつ進める。");
      else if (k === cfg.steps.length - 1) done(root, cfg.steps[k].detail, cfg.id);
      else say(root, cfg.steps[k].detail);
    }
    root.querySelector(".lad-prev").addEventListener("click", function () { if (k >= 0) { k--; draw(); } });
    root.querySelector(".lad-next").addEventListener("click", function () { if (k < cfg.steps.length - 1) { k++; draw(); } });
    draw();
    if (already) done(root, null, cfg.id);
  }
  global.Ladder = { mount: ladder };

  /* ---------- スイッチの学習 ---------- */
  function switchlearn(root) {
    var already = prep(root);
    var PCS = { A: "aa:01", B: "bb:02", C: "cc:03", D: "dd:04" };
    var PORT = { A: 1, B: 2, C: 3, D: 4 };
    var table = {}, log = [], sent = 0, flooded = 0, direct = 0;
    root.innerHTML = head("スイッチがMACアドレスを覚える") +
      '<div class="row"><label>送り元 <select class="s-from"><option>A</option><option>B</option><option>C</option><option>D</option></select></label><label>あて先 <select class="s-to"><option>B</option><option>A</option><option>C</option><option>D</option></select></label><button type="button" class="btn btn-primary lab-send">フレームを送る</button><button type="button" class="btn lab-reset">表を空にする</button></div>' +
      '<div class="sw-wrap"><div class="cpu-box"><h4>スイッチのMACアドレス表</h4><table class="sw-t"></table></div><div class="cpu-log sw-log" aria-live="polite"></div></div><p class="lab-status"></p>';
    function draw() {
      var keys = Object.keys(table);
      root.querySelector(".sw-t").innerHTML = "<tr><td><b>MACアドレス</b></td><td><b>ポート</b></td></tr>" + (keys.length ? keys.map(function (m) { return "<tr><td>" + m + "</td><td>" + table[m] + "</td></tr>"; }).join("") : '<tr><td colspan="2">（まだ何も覚えていない）</td></tr>');
      root.querySelector(".sw-log").innerHTML = log.slice(-4).join("<br>");
    }
    root.querySelector(".lab-send").addEventListener("click", function () {
      var f = root.querySelector(".s-from").value, t = root.querySelector(".s-to").value;
      if (f === t) { say(root, "送り元とあて先を別にしよう。"); return; }
      sent++;
      var learned = !table[PCS[f]];
      table[PCS[f]] = PORT[f];
      var msg = f + "(" + PCS[f] + ") → " + t + "(" + PCS[t] + ")：" + (learned ? "送り元 " + PCS[f] + " はポート" + PORT[f] + " にいる、と覚えた。" : "");
      if (table[PCS[t]]) { direct++; msg += "あて先はポート" + table[PCS[t]] + " と分かっているので、そこだけに送った。"; }
      else { flooded++; msg += "あて先がまだ表に無いので、送り元以外の全ポートに送った（フラッディング）。"; }
      log.push(msg); draw();
      if ((flooded >= 1 && direct >= 1) || already) done(root, "最初は全員に配るしかないが、返事をもらうたびに覚えて、だんだん必要なポートだけに送れるようになる。");
      else say(root, "送った " + sent + " 回。あて先を覚えた後にもう一度送ってみよう（例：A→B のあと B→A、もう一度 A→B）。");
    });
    root.querySelector(".lab-reset").addEventListener("click", function () { table = {}; log = []; draw(); });
    draw();
    if (already) done(root, "この課題は達成済み"); else say(root, "A→B、B→A、A→B の順に送ってみよう。");
  }

  /* ---------- サブネットマスクの AND ---------- */
  function subnet(root) {
    var already = prep(root);
    var Q = [
      ["192.168.1.10", "192.168.1.200", 24, true],
      ["192.168.1.10", "192.168.2.10", 24, false],
      ["10.0.5.1", "10.0.9.7", 16, true]
    ];
    var ans = Q.map(function () { return null; });
    function ip(s) { return s.split(".").map(Number); }
    function bin(n) { return ("0000000" + n.toString(2)).slice(-8); }
    function mask(p) { var m = []; for (var i = 0; i < 4; i++) { var b = Math.max(0, Math.min(8, p - i * 8)); m.push(b ? (0xff << (8 - b)) & 0xff : 0); } return m; }
    root.innerHTML = head("同じネットワークか、マスクで判定する") + '<div class="sn"></div><p class="lab-status" aria-live="polite"></p>';
    function draw() {
      root.querySelector(".sn").innerHTML = Q.map(function (q, i) {
        var a = ip(q[0]), b = ip(q[1]), m = mask(q[2]);
        var na = a.map(function (x, j) { return x & m[j]; }), nb = b.map(function (x, j) { return x & m[j]; });
        var show = ans[i] !== null;
        return '<div class="sn-q"><p><b>' + (i + 1) + ".</b> " + q[0] + " と " + q[1] + "（/" + q[2] + "）は同じネットワーク？</p>" +
          '<div class="row"><button type="button" class="btn' + (ans[i] === true ? " btn-primary" : "") + '" data-i="' + i + '" data-v="1">同じ</button><button type="button" class="btn' + (ans[i] === false ? " btn-primary" : "") + '" data-i="' + i + '" data-v="0">違う</button></div>' +
          (show ? '<pre class="code">' + "  " + a.map(bin).join(".") + "  (" + q[0] + ")\nAND " + m.map(bin).join(".") + "  (/" + q[2] + ")\n= " + na.map(bin).join(".") + "  → " + na.join(".") + "\n\n  " + b.map(bin).join(".") + "  (" + q[1] + ")\nAND " + m.map(bin).join(".") + "\n= " + nb.map(bin).join(".") + "  → " + nb.join(".") + "</pre><p class=\"" + (ans[i] === q[3] ? "okc" : "ngc") + "\">" + (ans[i] === q[3] ? "✓ 正解" : "✗ もう一度") + "：ネットワーク部分は " + na.join(".") + " と " + nb.join(".") + "。" + (q[3] ? "同じなので、直接届けられる。" : "違うので、ルーターに頼む。") + "</p>" : "") + "</div>";
      }).join("");
      root.querySelectorAll(".sn-q .btn").forEach(function (b) {
        b.addEventListener("click", function () { ans[+b.getAttribute("data-i")] = b.getAttribute("data-v") === "1"; draw(); check(); });
      });
    }
    function check() {
      var right = Q.filter(function (q, i) { return ans[i] === q[3]; }).length;
      if (right === Q.length || already) done(root, "3問とも正解！ マスクの 1 の部分だけを取り出して比べれば判定できる。");
      else say(root, "正解 " + right + " / " + Q.length);
    }
    if (already) ans = Q.map(function (q) { return q[3]; });
    draw(); check();
  }

  /* ---------- ファイアウォールのルール ---------- */
  function firewall(root) {
    var already = prep(root);
    var RULES = [
      ["外 → Webサーバー", "443（HTTPS）", "許可"],
      ["外 → Webサーバー", "22（SSH）", "拒否"],
      ["社内 → どこでも", "すべて", "許可"],
      ["（上のどれにも当たらない）", "すべて", "拒否"]
    ];
    var PKT = [
      ["外から Webサーバーの 443 番へ", 0],
      ["外から Webサーバーの 22 番へ", 1],
      ["社内PCから 外のサーバーの 443 番へ", 2],
      ["外から 社内PCの 3389 番へ", 3]
    ];
    var ans = PKT.map(function () { return null; });
    root.innerHTML = head("ルールを上から順に当てはめる") +
      '<div class="cpu-box"><h4>ルール表（上から順に調べ、最初に当たったもので決める）</h4><table class="fw-r"></table></div><div class="fw-q"></div><p class="lab-status" aria-live="polite"></p>';
    root.querySelector(".fw-r").innerHTML = "<tr><td><b>番号</b></td><td><b>向き</b></td><td><b>ポート</b></td><td><b>結果</b></td></tr>" + RULES.map(function (r, i) { return "<tr><td>" + (i + 1) + "</td><td>" + r[0] + "</td><td>" + r[1] + "</td><td>" + r[2] + "</td></tr>"; }).join("");
    function draw() {
      root.querySelector(".fw-q").innerHTML = PKT.map(function (p, i) {
        return '<div class="sn-q"><p>' + p[0] + ' は、どのルールに当たる？</p><div class="row">' + RULES.map(function (r, j) {
          var cls = ans[i] === j ? (j === p[1] ? " btn-primary" : " ng") : "";
          return '<button type="button" class="btn' + cls + '" data-i="' + i + '" data-j="' + j + '">ルール' + (j + 1) + "</button>";
        }).join("") + "</div>" + (ans[i] === p[1] ? '<p class="okc">✓ ルール' + (p[1] + 1) + " → " + RULES[p[1]][2] + "</p>" : ans[i] !== null ? '<p class="ngc">✗ 上から順に見直そう</p>' : "") + "</div>";
      }).join("");
      root.querySelectorAll(".fw-q .btn").forEach(function (b) {
        b.addEventListener("click", function () { ans[+b.getAttribute("data-i")] = +b.getAttribute("data-j"); draw(); check(); });
      });
    }
    function check() {
      var right = PKT.filter(function (p, i) { return ans[i] === p[1]; }).length;
      if (right === PKT.length || already) done(root, "4つとも正解！ 最後の「どれにも当たらなければ拒否」があるので、許可したもの以外は通らない。");
      else say(root, "正解 " + right + " / " + PKT.length);
    }
    if (already) ans = PKT.map(function (p) { return p[1]; });
    draw(); check();
  }

  /* ---------- IPv6 の省略表記 ---------- */
  function ipv6(root) {
    var already = prep(root);
    var Q = [
      ["2001:0db8:0000:0000:0000:0000:0000:0001", ["2001:db8::1", "2001:db8:0:1", "2001::db8::1"], 0],
      ["fe80:0000:0000:0000:0a1b:00ff:fe00:0042", ["fe80::a1b:ff:fe00:42", "fe80:0:a1b:ff:fe:42", "fe8::a1b:ff:fe00:42"], 0],
      ["2001:0db8:0001:0000:0000:0abc:0000:0007", ["2001:db8:1::abc:0:7", "2001:db8:1:0::abc::7", "2001:db8:1::abc::7"], 0]
    ];
    var ans = Q.map(function () { return null; });
    root.innerHTML = head("IPv6 アドレスを短く書く") + '<div class="v6"></div><p class="lab-status" aria-live="polite"></p>';
    function draw() {
      root.querySelector(".v6").innerHTML = Q.map(function (q, i) {
        return '<div class="sn-q"><p><code>' + q[0] + '</code> の正しい省略は？</p><div class="row">' + q[1].map(function (c, j) {
          var cls = ans[i] === j ? (j === q[2] ? " btn-primary" : " ng") : "";
          return '<button type="button" class="btn' + cls + '" data-i="' + i + '" data-j="' + j + '"><code>' + c + "</code></button>";
        }).join("") + "</div>" + (ans[i] === q[2] ? '<p class="okc">✓ 各区切りの先頭の 0 を省き、0 だけが続く区切りを1か所だけ :: にまとめた</p>' : ans[i] !== null ? '<p class="ngc">✗ :: は1か所だけ。区切りの中の、頭の 0 しか省けない</p>' : "") + "</div>";
      }).join("");
      root.querySelectorAll(".v6 .btn").forEach(function (b) {
        b.addEventListener("click", function () { ans[+b.getAttribute("data-i")] = +b.getAttribute("data-j"); draw(); check(); });
      });
    }
    function check() {
      var right = Q.filter(function (q, i) { return ans[i] === q[2]; }).length;
      if (right === Q.length || already) done(root, "3問とも正解！");
      else say(root, "正解 " + right + " / " + Q.length);
    }
    if (already) ans = Q.map(function (q) { return q[2]; });
    draw(); check();
  }

  /* ---------- 障害の切り分け ---------- */
  function trouble(root) {
    var already = prep(root);
    var CASES = [
      { name: "Webページが開けない その1", fault: 1, sym: "「サーバーが見つかりません」と出る" },
      { name: "Webページが開けない その2", fault: 0, sym: "どのサイトも開けない。ネットワークのアイコンに×が付いている" },
      { name: "Webページが開けない その3", fault: 2, sym: "ほかのサイトは開けるが、このサイトだけ開けない" }
    ];
    var TESTS = [
      ["ケーブルと IP アドレスを確かめる（ipconfig／ifconfig）", "物理・ネットワーク"],
      ["名前を調べる（nslookup example.com）", "DNS（アプリケーション）"],
      ["相手まで届くか試す（ping 93.184.215.14）", "ネットワーク"]
    ];
    // RESULT[故障][検査] = 結果
    var RESULT = [
      ["✗ IP アドレスが割り当てられていない（169.254.x.x）", "✗ DNS サーバーに届かない", "✗ 届かない"],
      ["✓ IP アドレスもゲートウェイも正常", "✗ 名前が見つからない（DNS の応答が無い）", "✓ IP アドレスあてなら届く"],
      ["✓ 正常", "✓ IP アドレスが分かった", "✗ その IP アドレスにだけ届かない（相手側の故障）"]
    ];
    var CAUSE = ["自分のPCの接続（ケーブル・Wi-Fi・DHCP）", "名前の解決（DNS）", "相手のサーバー側"];
    var cur = 0, picked = [null, null, null], ranTests = [{}, {}, {}];
    root.innerHTML = head("どこが故障しているか、下の層から確かめる") +
      '<div class="row cases"></div><p class="readout sym"></p><div class="row tests"></div><div class="cpu-log tr-log" aria-live="polite"></div>' +
      '<p style="text-align:center;margin-top:8px">原因はどこ？</p><div class="row causes"></div><p class="lab-status" aria-live="polite"></p>';
    CASES.forEach(function (c, i) {
      root.querySelector(".cases").insertAdjacentHTML("beforeend", '<button type="button" class="btn" data-c="' + i + '">' + c.name + "</button>");
    });
    TESTS.forEach(function (t, j) {
      root.querySelector(".tests").insertAdjacentHTML("beforeend", '<button type="button" class="btn" data-t="' + j + '">' + t[0] + "</button>");
    });
    CAUSE.forEach(function (c, j) {
      root.querySelector(".causes").insertAdjacentHTML("beforeend", '<button type="button" class="btn" data-k="' + j + '">' + c + "</button>");
    });
    function draw() {
      root.querySelectorAll(".cases .btn").forEach(function (b, i) { b.classList.toggle("btn-primary", i === cur); b.textContent = CASES[i].name + (picked[i] === CASES[i].fault ? " ✓" : ""); });
      root.querySelector(".sym").innerHTML = "症状：" + CASES[cur].sym;
      root.querySelector(".tr-log").innerHTML = Object.keys(ranTests[cur]).map(function (j) { return TESTS[j][0] + " → " + RESULT[CASES[cur].fault][j]; }).join("<br>") || "まず確かめたい検査を選ぼう。";
    }
    root.querySelectorAll(".cases .btn").forEach(function (b) { b.addEventListener("click", function () { cur = +b.getAttribute("data-c"); draw(); }); });
    root.querySelectorAll(".tests .btn").forEach(function (b) { b.addEventListener("click", function () { ranTests[cur][b.getAttribute("data-t")] = true; draw(); }); });
    root.querySelectorAll(".causes .btn").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = +b.getAttribute("data-k");
        if (!Object.keys(ranTests[cur]).length) { say(root, "当てずっぽうではなく、検査をしてから選ぼう。"); return; }
        if (k === CASES[cur].fault) { picked[cur] = k; draw(); say(root, "正解。" + CAUSE[k] + "が原因だった。"); }
        else say(root, "検査の結果をもう一度見てみよう。");
        if (picked.every(function (p, i) { return p === CASES[i].fault; }) || already) done(root, "3つとも原因を突き止めた。下の層から順に確かめれば、当てずっぽうにならない。");
      });
    });
    draw();
    if (already) done(root, "この課題は達成済み"); else say(root, "3つの故障を、検査で確かめながら突き止めよう。");
  }

  var KINDS = { switchlearn: switchlearn, subnet: subnet, firewall: firewall, ipv6: ipv6, trouble: trouble };
  function boot() {
    document.querySelectorAll(".lab[data-lab]").forEach(function (root) {
      var f = KINDS[root.getAttribute("data-lab")];
      if (f) f(root);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);

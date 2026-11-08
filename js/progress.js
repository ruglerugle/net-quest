/* ============================================================
   情報系クエスト共通 進捗管理・クイズ判定（quantum-computer の progress.js が原型）
   - 進捗は「クリアしたステージ番号の配列」を localStorage に保存（学習記録 sync.js の union 規則）
   - ステージのクリア条件 = ページ内の確認クイズ（.quiz-card[data-quiz]）を全問正解
                          ＋ 実験の課題（[data-task]）を全部達成
   - サイトごとに違うのは下の CONFIG だけ
   ============================================================ */
(function (global) {
  "use strict";

  var CONFIG = {
    storageKey: "netQuestProgress_v2",
    taskKey: "netQuestTasks_v2",
    book: {
      title: "井上直也ほか『マスタリングTCP/IP 入門編 第6版』（オーム社）",
      url: "https://www.amazon.co.jp/dp/4274224473?tag=senjin-22"
    },
    // 旧版（1ページのゲーム）の進捗を引き継ぐ: 旧キー → 新しいステージ番号への対応
    legacy: function () {
      try {
        var raw = JSON.parse(localStorage.getItem("net-quest-progress") || "null");
        var k = raw && typeof raw.unlockedCount === "number" ? raw.unlockedCount - 1 : 0;
        if (k <= 0) return [];
        // 旧版（全17ステージ）で前から k 個クリア → 新しいステージに対応する旧ステージが全部クリアなら引き継ぐ
        var map = { 1: [1], 2: [2], 3: [3], 4: [4], 5: [5], 6: [7], 7: [8], 8: [9, 10], 9: [11], 10: [12], 11: [14], 13: [13], 14: [15], 15: [16, 17] };
        var got = [];
        Object.keys(map).forEach(function (n) { if (map[n].every(function (o) { return o <= k; })) got.push(parseInt(n, 10)); });
        return got;
      } catch (e) { return []; }
    }
  };

  var STAGES = global.QUEST_STAGES || [];
  var ANSWERS = global.QUEST_ANSWERS || {};

  function readJSON(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key) || "null");
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function getCleared() {
    var raw = readJSON(CONFIG.storageKey, null);
    if (raw === null) {
      var migrated = CONFIG.legacy ? CONFIG.legacy() : [];
      if (migrated.length) {
        try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(migrated)); } catch (e) { /* 保存できない環境では表示だけ */ }
      }
      return migrated;
    }
    return Array.isArray(raw) ? raw : [];
  }

  function setCleared(stageNum) {
    var cleared = getCleared();
    if (cleared.indexOf(stageNum) === -1) {
      cleared.push(stageNum);
      try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(cleared)); } catch (e) { /* 同上 */ }
    }
  }

  // 実験の課題（回路パズルなど）の達成記録。キーは課題ID
  function getTasks() {
    var raw = readJSON(CONFIG.taskKey, []);
    return Array.isArray(raw) ? raw : [];
  }
  function setTaskDone(id) {
    var t = getTasks();
    if (t.indexOf(id) === -1) {
      t.push(id);
      try { localStorage.setItem(CONFIG.taskKey, JSON.stringify(t)); } catch (e) { /* 同上 */ }
    }
  }

  function isUnlocked(stageNum, cleared) {
    if (stageNum === 1) return true;
    return cleared.indexOf(stageNum - 1) !== -1 || cleared.indexOf(stageNum) !== -1;
  }

  function renderSidebar(currentStage) {
    var list = document.getElementById("side-list");
    if (!list) return;
    var cleared = getCleared();
    list.innerHTML = "";
    STAGES.forEach(function (stage) {
      var unlocked = isUnlocked(stage.n, cleared) || stage.n === currentStage;
      var isCleared = cleared.indexOf(stage.n) !== -1;
      var item = document.createElement(unlocked ? "a" : "div");
      item.className = "side-item";
      if (stage.n === currentStage) item.className += " active";
      if (!unlocked) item.className += " locked";
      if (unlocked) {
        item.href = stage.file;
        item.setAttribute("aria-label", stage.title);
      } else {
        item.setAttribute("aria-disabled", "true");
      }
      var icon = isCleared ? "✅" : unlocked ? "🔓" : "🔒";
      item.innerHTML =
        '<span class="side-icon">' + icon + "</span>" +
        '<span class="side-text"><div class="side-main">STAGE' + stage.n + " " + stage.title + "</div>" +
        '<div class="side-sub">' + stage.sub + "</div></span>";
      list.appendChild(item);
    });
  }

  function coreClearedCount(cleared) {
    return cleared.filter(function (n) { return n >= 1 && n <= STAGES.length; }).length;
  }

  function updateHeaderProgress() {
    var cleared = coreClearedCount(getCleared());
    var total = STAGES.length;
    var label = document.getElementById("progress-label");
    var fill = document.getElementById("progress-fill");
    if (label) label.textContent = "クリア " + cleared + " / " + total;
    if (fill) {
      fill.style.width = Math.round((cleared / total) * 100) + "%";
      if (fill.parentNode && fill.parentNode.setAttribute) fill.parentNode.setAttribute("aria-valuenow", cleared);
    }
  }

  function markSolved(card) {
    card.setAttribute("data-solved", "true");
    var explain = card.querySelector(".quiz-explain");
    if (explain) explain.hidden = false;
  }

  function allDone(root) {
    var items = root.querySelectorAll(".quiz-card[data-quiz], [data-task]");
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute("data-solved") !== "true") return false;
    }
    return true;
  }

  function track(eventName, params) {
    if (typeof global.gtag === "function") global.gtag("event", eventName, params || {});
  }

  function setMissionAchieved() {
    var status = document.getElementById("mission-status");
    if (status) {
      status.textContent = "達成！";
      status.classList.add("ok");
    }
  }

  function showClearBanner() {
    if (document.querySelector(".stage-clear-banner")) return;
    var nav = document.querySelector(".stage-nav");
    if (!nav) return;
    var banner = document.createElement("div");
    banner.className = "stage-clear-banner";
    banner.setAttribute("role", "status");
    banner.textContent = "🎉 STAGE CLEAR!";
    nav.parentNode.insertBefore(banner, nav);
  }

  var currentStageNum = 0;

  function checkStageClear() {
    if (!currentStageNum || !allDone(document)) return;
    var nextBtn = document.getElementById("btn-next");
    if (nextBtn) nextBtn.disabled = false;
    setMissionAchieved();
    var first = getCleared().indexOf(currentStageNum) === -1;
    setCleared(currentStageNum);
    updateHeaderProgress();
    renderSidebar(currentStageNum);
    showClearBanner();
    if (first) {
      track("stage_clear", { stage: currentStageNum });
      if (coreClearedCount(getCleared()) === STAGES.length) track("all_clear");
    }
  }

  // 実験の課題が達成されたときに、各ウィジェットから呼ぶ
  function taskDone(el, id) {
    if (el) el.setAttribute("data-solved", "true");
    if (id) setTaskDone(id);
    checkStageClear();
  }
  function isTaskDone(id) {
    return getTasks().indexOf(id) !== -1;
  }

  function initQuiz(stageNum) {
    var answers = ANSWERS[stageNum] || [];
    var cards = document.querySelectorAll(".quiz-card[data-quiz]");
    if (answers.length !== cards.length && global.console && console.warn) {
      console.warn("[progress] STAGE" + stageNum + ": ANSWERS の件数(" + answers.length + ")がクイズ数(" + cards.length + ")と一致しません");
    }
    cards.forEach(function (card, cardIndex) {
      var live = document.createElement("p");
      live.className = "sr-only";
      live.setAttribute("aria-live", "polite");
      card.appendChild(live);
      var buttons = card.querySelectorAll(".choice-btn");
      buttons.forEach(function (btn, btnIndex) {
        btn.addEventListener("click", function () {
          if (card.getAttribute("data-solved") === "true") return;
          var correct = answers[cardIndex] === btnIndex;
          live.textContent = correct ? "正解です" : "不正解です。もう一度選んでください";
          if (correct) {
            buttons.forEach(function (b) { if (b !== btn) b.disabled = true; });
            btn.setAttribute("aria-disabled", "true");
            btn.classList.add("choice-ok");
            markSolved(card);
            checkStageClear();
          } else {
            btn.classList.add("choice-ng");
            track("quiz_wrong", { stage: stageNum, quiz: cardIndex + 1, choice: btnIndex + 1 });
          }
        });
      });
    });
  }

  function bindResetAll() {
    var btn = document.getElementById("btn-reset-all");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (global.confirm("進捗をすべてリセットして最初からやり直しますか？")) {
        try {
          localStorage.removeItem(CONFIG.storageKey);
          localStorage.removeItem(CONFIG.taskKey);
          localStorage.setItem(CONFIG.storageKey, "[]");
        } catch (e) { /* 保存できない環境 */ }
        global.location.href = "./";
      }
    });
  }

  function renderBookRecommend() {
    var el = document.getElementById("book-recommend");
    if (!el || !CONFIG.book) return;
    el.innerHTML =
      '<p class="book-recommend-label">参考文献［PR］</p>' +
      '<div class="book-recommend-body"><div>' +
      '<p class="book-recommend-lead">もっと深く学びたい方へ</p>' +
      '<a href="' + CONFIG.book.url + '" target="_blank" rel="sponsored noopener">' + CONFIG.book.title + "</a>" +
      "</div></div>" +
      '<p class="book-recommend-note pr-disclosure">※ Amazonのアソシエイトとして、当サイトは適格販売により収入を得ています。</p>';
  }

  function bindSidebarToggle() {
    var shell = document.getElementById("app-shell");
    if (!shell) return;
    function toggleSide() { shell.classList.toggle("side-collapsed"); }
    var t1 = document.getElementById("sidebar-toggle");
    var t2 = document.getElementById("head-nav-toggle");
    var backdrop = document.getElementById("side-backdrop");
    if (t1) t1.addEventListener("click", toggleSide);
    if (t2) t2.addEventListener("click", toggleSide);
    if (backdrop) backdrop.addEventListener("click", function () { shell.classList.add("side-collapsed"); });
  }

  function initStagePage(stageNum) {
    currentStageNum = stageNum;
    document.addEventListener("DOMContentLoaded", function () {
      var cleared = getCleared();
      renderSidebar(stageNum);
      updateHeaderProgress();
      bindResetAll();
      bindSidebarToggle();
      renderBookRecommend();

      var nextBtn = document.getElementById("btn-next");
      if (cleared.indexOf(stageNum) !== -1) {
        document.querySelectorAll(".quiz-card[data-quiz]").forEach(function (card) {
          markSolved(card);
          card.querySelectorAll(".choice-btn").forEach(function (b) { b.disabled = true; });
        });
        setMissionAchieved();
        if (nextBtn) nextBtn.disabled = false;
      } else if (nextBtn) {
        nextBtn.disabled = !allDone(document);
      }

      initQuiz(stageNum);

      if (nextBtn) {
        nextBtn.addEventListener("click", function () {
          var next = STAGES[stageNum]; // stageNum は1始まりなので STAGES[stageNum] が次
          global.location.href = next ? next.file : "complete.html";
        });
      }
    });
  }

  function initCompletePage() {
    if (coreClearedCount(getCleared()) < STAGES.length) {
      global.location.replace("./");
      return;
    }
    document.addEventListener("DOMContentLoaded", function () {
      bindResetAll();
      renderBookRecommend();
    });
  }

  function initCoverPage() {
    document.addEventListener("DOMContentLoaded", function () {
      var cleared = getCleared();
      var all = /[?&]all\b/.test(global.location.search); // 旧版から続く「全部開ける」確認用
      document.querySelectorAll(".quest-card[data-stage]").forEach(function (card) {
        var n = parseInt(card.getAttribute("data-stage"), 10);
        if (!all && !isUnlocked(n, cleared)) {
          card.classList.add("locked");
          card.removeAttribute("href");
        }
        if (cleared.indexOf(n) !== -1) {
          card.classList.add("cleared");
          var cta = card.querySelector(".q-cta");
          if (cta) cta.textContent = "クリア済み ✓";
        }
      });
      renderBookRecommend();
    });
  }

  global.QUEST = {
    STAGES: STAGES,
    getCleared: getCleared,
    taskDone: taskDone,
    isTaskDone: isTaskDone,
    initStagePage: initStagePage,
    initCoverPage: initCoverPage,
    initCompletePage: initCompletePage
  };
})(window);

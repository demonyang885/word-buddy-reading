(() => {
  "use strict";

  const STORAGE_KEY = "word-buddy-challenge-3-progress-v1";
  const LEGACY_STORAGE_KEY = "word-buddy-progress-v1";
  const SETTINGS_KEY = "word-buddy-settings-v1";
  const CHALLENGE_LENGTH = 10;
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

  const words = [...new Set((window.WORD_DATABASE || [])
    .map((word) => String(word).trim().toLowerCase())
    .filter(Boolean))];
  const meta = window.WORD_DATABASE_META || { label: "本地词库", note: "" };

  const defaultProgress = {
    version: 3,
    totalAttempts: 0,
    correctAttempts: 0,
    daily: {},
    mistakes: {},
    wordProgress: {},
    lastSession: { mode: "learn", word: "", updatedAt: 0 },
    updatedAt: 0
  };

  const defaultSettings = {
    autoSpeak: true,
    rate: 0.8,
    voiceURI: ""
  };

  const state = {
    ready: false,
    mode: "learn",
    learnOrder: [],
    learnIndex: 0,
    challengeOrder: [],
    challengeIndex: 0,
    challengeCorrect: 0,
    reviewQueue: [],
    reviewIndex: 0,
    listening: false,
    recognition: null,
    speechOutcome: null,
    audioUnlocked: false,
    recordFilter: "all",
    toastTimer: null,
    nextTimer: null,
    saveTimer: null,
    serverSyncAvailable: false
  };

  let progress = normalizeProgress(loadStored(STORAGE_KEY, defaultProgress));
  let settings = loadStored(SETTINGS_KEY, defaultSettings);
  let voices = [];

  const els = {
    panel: document.querySelector("#learningPanel"),
    modeTabs: [...document.querySelectorAll(".mode-tab")],
    wordCount: document.querySelector("#wordCount"),
    todayCount: document.querySelector("#todayCount"),
    mistakeBadge: document.querySelector("#mistakeBadge"),
    masteredStat: document.querySelector("#masteredStat"),
    answerStat: document.querySelector("#answerStat"),
    accuracyStat: document.querySelector("#accuracyStat"),
    mistakeStat: document.querySelector("#mistakeStat"),
    mistakeStrip: document.querySelector("#mistakeStrip"),
    clearMistakesButton: document.querySelector("#clearMistakesButton"),
    sourceNote: document.querySelector("#sourceNote"),
    syncStatus: document.querySelector("#syncStatus"),
    settingsButton: document.querySelector("#settingsButton"),
    settingsBackdrop: document.querySelector("#settingsBackdrop"),
    closeSettingsButton: document.querySelector("#closeSettingsButton"),
    autoSpeakInput: document.querySelector("#autoSpeakInput"),
    rateInput: document.querySelector("#rateInput"),
    rateOutput: document.querySelector("#rateOutput"),
    voiceSelect: document.querySelector("#voiceSelect"),
    testVoiceButton: document.querySelector("#testVoiceButton"),
    recordButton: document.querySelector("#recordButton"),
    openRecordsButton: document.querySelector("#openRecordsButton"),
    recordsBackdrop: document.querySelector("#recordsBackdrop"),
    closeRecordsButton: document.querySelector("#closeRecordsButton"),
    recordSummary: document.querySelector("#recordSummary"),
    recordList: document.querySelector("#recordList"),
    recordFilters: [...document.querySelectorAll(".record-filter")],
    exportRecordsButton: document.querySelector("#exportRecordsButton"),
    importRecordsInput: document.querySelector("#importRecordsInput"),
    toast: document.querySelector("#toast"),
    brand: document.querySelector(".brand")
  };

  function cloneData(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function loadStored(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key));
      return parsed && typeof parsed === "object"
        ? { ...cloneData(fallback), ...parsed }
        : cloneData(fallback);
    } catch {
      return cloneData(fallback);
    }
  }

  function normalizeProgress(value) {
    const normalized = { ...cloneData(defaultProgress), ...(value || {}) };
    normalized.daily = normalized.daily && typeof normalized.daily === "object" ? normalized.daily : {};
    normalized.mistakes = normalized.mistakes && typeof normalized.mistakes === "object" ? normalized.mistakes : {};
    normalized.wordProgress = normalized.wordProgress && typeof normalized.wordProgress === "object" ? normalized.wordProgress : {};
    normalized.lastSession = normalized.lastSession && typeof normalized.lastSession === "object"
      ? { ...defaultProgress.lastSession, ...normalized.lastSession }
      : cloneData(defaultProgress.lastSession);
    return normalized;
  }

  function migrateLegacyProgress() {
    if (localStorage.getItem(STORAGE_KEY)) return;
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
      if (!legacy || typeof legacy !== "object") return;
      progress.totalAttempts = Number(legacy.totalAnswers) || 0;
      progress.correctAttempts = Number(legacy.correctAnswers) || 0;
      progress.daily = legacy.daily || {};
      progress.mistakes = legacy.mistakes || {};
      Object.keys(progress.mistakes).forEach((word) => {
        progress.wordProgress[word] = {
          attempts: progress.mistakes[word].misses || 1,
          correct: 0,
          incorrect: progress.mistakes[word].misses || 1,
          mastered: false,
          consecutiveCorrect: 0,
          lastHeard: "",
          lastPracticed: progress.mistakes[word].lastSeen || Date.now()
        };
      });
      progress.updatedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch {
      // A damaged legacy record is ignored; the current record remains usable.
    }
  }

  function isLocalLearningServer() {
    return location.port === "8000" || location.port === "8443";
  }

  async function hydrateProgress() {
    migrateLegacyProgress();
    progress = normalizeProgress(loadStored(STORAGE_KEY, progress));

    if (isLocalLearningServer()) {
      try {
        const response = await fetch("/api/progress", { cache: "no-store" });
        if (response.ok) {
          const payload = await response.json();
          const serverProgress = normalizeProgress(payload.progress || {});
          state.serverSyncAvailable = true;
          if ((serverProgress.updatedAt || 0) > (progress.updatedAt || 0)) {
            progress = serverProgress;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
          } else if ((progress.updatedAt || 0) > 0) {
            await pushProgressToServer();
          }
        }
      } catch {
        state.serverSyncAvailable = false;
      }
    }

    const resumableMode = ["learn", "challenge", "review"].includes(progress.lastSession.mode)
      ? progress.lastSession.mode
      : "learn";
    state.mode = resumableMode;
    state.learnOrder = buildLearnOrder();
    resumeLastWord();
    if (state.mode === "challenge") startChallenge(progress.lastSession.word);
    if (state.mode === "review") startReview(progress.lastSession.word);
    state.ready = true;
    updateModeTabs();
    updateSyncStatus();
    render();
  }

  function updateSyncStatus(status) {
    els.syncStatus.classList.remove("is-saved", "is-local");
    if (status === "saving") {
      els.syncStatus.textContent = "正在保存";
      return;
    }
    if (state.serverSyncAvailable) {
      els.syncStatus.textContent = "电脑与 iPad 已保存";
      els.syncStatus.classList.add("is-saved");
    } else {
      els.syncStatus.textContent = "已保存在这台设备";
      els.syncStatus.classList.add("is-local");
    }
  }

  function saveProgress(options = {}) {
    progress.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    updateSyncStatus("saving");
    renderStats();
    if (els.recordsBackdrop && !els.recordsBackdrop.hidden) renderRecords();

    window.clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(async () => {
      if (state.serverSyncAvailable) await pushProgressToServer();
      updateSyncStatus();
    }, options.immediate ? 0 : 350);
  }

  async function pushProgressToServer() {
    try {
      const response = await fetch("/api/progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(progress),
        keepalive: true
      });
      state.serverSyncAvailable = response.ok;
    } catch {
      state.serverSyncAvailable = false;
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function shuffle(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
    }
    return result;
  }

  function buildLearnOrder() {
    const unfinished = words.filter((word) => !isMastered(word));
    const mastered = words.filter((word) => isMastered(word));
    return [...unfinished, ...mastered];
  }

  function resumeLastWord() {
    const lastWord = progress.lastSession.word;
    const index = state.learnOrder.indexOf(lastWord);
    state.learnIndex = index >= 0 ? index : 0;
  }

  function todayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const date = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${date}`;
  }

  function addDailyPoint() {
    const key = todayKey();
    progress.daily[key] = (progress.daily[key] || 0) + 1;
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeSpeech(value) {
    return String(value)
      .toLowerCase()
      .replace(/[^a-z'\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchesTarget(transcripts, target) {
    const wanted = normalizeSpeech(target);
    return transcripts.some((transcript) => {
      const heard = normalizeSpeech(transcript);
      if (heard === wanted) return true;
      const tokens = heard.split(" ");
      return !wanted.includes(" ") && tokens.length <= 3 && tokens.includes(wanted);
    });
  }

  function speak(word) {
    state.audioUnlocked = true;
    if (!("speechSynthesis" in window)) {
      showToast("这台设备暂不支持标准发音");
      return;
    }
    stopListening();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = Number(settings.rate) || 0.8;
    utterance.pitch = 1.03;
    const voice = voices.find((item) => item.voiceURI === settings.voiceURI)
      || voices.find((item) => item.lang === "en-US")
      || voices.find((item) => item.lang?.startsWith("en"));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  function autoSpeak(word) {
    if (settings.autoSpeak && state.audioUnlocked && state.mode !== "challenge" && !state.speechOutcome) {
      window.setTimeout(() => speak(word), 150);
    }
  }

  function recognitionIssue() {
    if (!window.isSecureContext) return "secure";
    if (!SpeechRecognitionAPI) return "unsupported";
    return "";
  }

  function recognitionWarning() {
    const issue = recognitionIssue();
    if (!issue) return "";
    if (issue === "secure") {
      return `<div class="secure-warning">这个地址不是安全的 HTTPS 页面，所以 Safari 不会开放语音识别。请使用发布后的 GitHub Pages HTTPS 地址。</div>`;
    }
    return `<div class="secure-warning">当前浏览器没有开放网页语音识别。请在 iPad 的 <strong>Safari</strong> 中打开，并确认 Siri 或听写已开启；不要使用应用内置浏览器。</div>`;
  }

  function startListening(target) {
    state.audioUnlocked = true;
    window.speechSynthesis?.cancel();
    window.clearTimeout(state.nextTimer);

    const issue = recognitionIssue();
    if (issue) {
      state.speechOutcome = { type: "error", message: issue === "secure" ? "请改用 HTTPS 学习地址" : "请使用 Safari 并开启 Siri 或听写" };
      render();
      return;
    }

    stopListening();
    const recognition = new SpeechRecognitionAPI();
    state.recognition = recognition;
    state.listening = true;
    state.speechOutcome = { type: "listening", message: "正在听，请清楚地读出单词…" };

    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 5;

    let receivedResult = false;
    recognition.onresult = (event) => {
      receivedResult = true;
      const result = event.results[event.resultIndex || 0];
      const transcripts = [];
      for (let index = 0; index < result.length; index += 1) {
        if (result[index]?.transcript) transcripts.push(result[index].transcript.trim());
      }
      finishSpokenAttempt(target, transcripts);
    };

    recognition.onerror = (event) => {
      state.listening = false;
      const messages = {
        "not-allowed": "需要允许 Safari 使用麦克风和语音识别",
        "service-not-allowed": "请在 iPad 设置中开启 Siri 或听写",
        "audio-capture": "没有找到可用的麦克风",
        "no-speech": "没有听到声音，请靠近一点再读一次",
        network: "语音服务暂时无法连接，请稍后再试",
        aborted: "已停止收音"
      };
      state.speechOutcome = { type: "error", message: messages[event.error] || "没有听清，请再读一次" };
      render();
    };

    recognition.onend = () => {
      state.listening = false;
      if (!receivedResult && state.speechOutcome?.type === "listening") {
        state.speechOutcome = { type: "error", message: "没有听清，请再读一次" };
        render();
      }
    };

    try {
      recognition.start();
      render();
    } catch {
      state.listening = false;
      state.speechOutcome = { type: "error", message: "麦克风还没准备好，请稍后再试" };
      render();
    }
  }

  function stopListening() {
    if (state.recognition) {
      state.recognition.onresult = null;
      state.recognition.onerror = null;
      state.recognition.onend = null;
      try { state.recognition.abort(); } catch { /* already stopped */ }
    }
    state.recognition = null;
    state.listening = false;
  }

  function currentWordRecord(word) {
    return progress.wordProgress[word] || {
      attempts: 0,
      correct: 0,
      incorrect: 0,
      mastered: false,
      consecutiveCorrect: 0,
      lastHeard: "",
      lastPracticed: 0
    };
  }

  function isMastered(word) {
    return Boolean(progress.wordProgress[word]?.mastered && !progress.mistakes[word]);
  }

  function recordSpokenAttempt(word, correct, heard) {
    const record = currentWordRecord(word);
    record.attempts += 1;
    record.lastHeard = heard;
    record.lastPracticed = Date.now();
    progress.totalAttempts += 1;
    addDailyPoint();

    if (correct) {
      record.correct += 1;
      record.consecutiveCorrect += 1;
      progress.correctAttempts += 1;
      if (state.mode !== "review") record.mastered = true;
    } else {
      record.incorrect += 1;
      record.consecutiveCorrect = 0;
      record.mastered = false;
      const mistake = progress.mistakes[word] || { misses: 0, correctStreak: 0, lastSeen: 0 };
      progress.mistakes[word] = { misses: mistake.misses + 1, correctStreak: 0, lastSeen: Date.now() };
    }

    if (state.mode === "review" && correct) {
      const mistake = progress.mistakes[word] || { misses: 1, correctStreak: 0, lastSeen: 0 };
      mistake.correctStreak = (mistake.correctStreak || 0) + 1;
      mistake.lastSeen = Date.now();
      if (mistake.correctStreak >= 2) {
        delete progress.mistakes[word];
        record.mastered = true;
      } else {
        progress.mistakes[word] = mistake;
      }
    }

    progress.wordProgress[word] = record;
    progress.lastSession = { mode: state.mode, word, updatedAt: Date.now() };
    saveProgress();
  }

  function finishSpokenAttempt(target, transcripts) {
    stopListening();
    const heard = transcripts[0] || "";
    const correct = matchesTarget(transcripts, target);
    recordSpokenAttempt(target, correct, heard);
    state.speechOutcome = {
      type: correct ? "correct" : "wrong",
      message: correct ? `读对了：${target}` : `系统听到：${heard || "没有识别到单词"}`,
      heard
    };

    if (correct && state.mode === "challenge") state.challengeCorrect += 1;
    render();

    if (correct) {
      state.nextTimer = window.setTimeout(() => {
        state.speechOutcome = null;
        if (state.mode === "learn") nextLearn();
        if (state.mode === "challenge") nextChallenge();
        if (state.mode === "review") nextReview(target);
      }, 1250);
    }
  }

  function updateModeTabs() {
    els.modeTabs.forEach((tab) => {
      const active = tab.dataset.mode === state.mode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-pressed", String(active));
    });
  }

  function setMode(mode, options = {}) {
    window.clearTimeout(state.nextTimer);
    stopListening();
    window.speechSynthesis?.cancel();
    state.mode = mode;
    state.speechOutcome = null;
    if (mode === "challenge" && !options.resume) startChallenge();
    if (mode === "review") startReview();
    progress.lastSession.mode = mode;
    progress.lastSession.updatedAt = Date.now();
    saveProgress();
    updateModeTabs();
    render();
  }

  function startChallenge(preferredWord = "") {
    const priority = words.filter((word) => !isMastered(word));
    const pool = [...shuffle(priority), ...shuffle(words.filter((word) => isMastered(word)))];
    const unique = [...new Set(pool)].slice(0, Math.min(CHALLENGE_LENGTH, words.length));
    if (preferredWord && unique.includes(preferredWord)) {
      state.challengeOrder = [preferredWord, ...unique.filter((word) => word !== preferredWord)];
    } else {
      state.challengeOrder = unique;
    }
    state.challengeIndex = 0;
    state.challengeCorrect = 0;
  }

  function startReview(preferredWord = "") {
    const queue = Object.entries(progress.mistakes)
      .filter(([word]) => words.includes(word))
      .sort((a, b) => (b[1].misses - a[1].misses) || (a[1].lastSeen - b[1].lastSeen))
      .map(([word]) => word);
    if (preferredWord && queue.includes(preferredWord)) {
      state.reviewQueue = [preferredWord, ...queue.filter((word) => word !== preferredWord)];
    } else {
      state.reviewQueue = queue;
    }
    state.reviewIndex = 0;
  }

  function render() {
    if (!state.ready) {
      els.panel.innerHTML = '<div class="empty-review"><div><div class="empty-number">…</div><h2>正在读取上次进度</h2></div></div>';
      return;
    }
    if (!words.length) {
      els.panel.innerHTML = '<div class="empty-review"><div><div class="empty-number">0</div><h2>词库还是空的</h2><p>请先加入英文单词。</p></div></div>';
      renderStats();
      return;
    }
    if (state.mode === "learn") renderLearn();
    if (state.mode === "challenge") renderChallenge();
    if (state.mode === "review") renderReview();
    renderStats();
  }

  function voiceOutcomeHTML(target) {
    const outcome = state.speechOutcome;
    if (!outcome) return '<p class="speech-feedback"></p>';
    if (outcome.type === "listening") return `<p class="speech-feedback try">${escapeHTML(outcome.message)}<small>看到红色脉冲时开始读</small></p>`;
    if (outcome.type === "correct") return `<p class="speech-feedback good">${escapeHTML(outcome.message)}<small>系统确认读音后才会记为“会读”</small></p>`;
    if (outcome.type === "wrong") return `<p class="speech-feedback try">${escapeHTML(outcome.message)}<small>目标单词是 ${escapeHTML(target)}，听标准发音后再试一次</small></p>`;
    return `<p class="speech-feedback try">${escapeHTML(outcome.message)}</p>`;
  }

  function voiceExerciseHTML({ target, instruction, allowModel = true }) {
    const issue = recognitionIssue();
    return `
      <div class="voice-stage">
        <div>
          <span class="word">${escapeHTML(target)}</span>
          <p class="voice-instruction">${escapeHTML(instruction)}</p>
          ${recognitionWarning()}
          ${issue ? "" : `<button class="mic-button ${state.listening ? "is-listening" : ""}" type="button" data-action="listen" ${state.listening ? "disabled" : ""}>${state.listening ? "正在听…" : "开始认读"}</button>`}
          ${voiceOutcomeHTML(target)}
          <div class="voice-actions">
            ${allowModel || state.speechOutcome?.type === "wrong" ? '<button class="sound-button" type="button" data-action="model-speak">听标准发音</button>' : ""}
            <button class="secondary-button" type="button" data-action="skip">暂时跳过</button>
          </div>
        </div>
      </div>`;
  }

  function renderLearn() {
    if (!state.learnOrder.length) state.learnOrder = buildLearnOrder();
    const target = state.learnOrder[state.learnIndex % state.learnOrder.length];
    const record = currentWordRecord(target);
    const displayIndex = (state.learnIndex % state.learnOrder.length) + 1;
    const percent = Math.round((displayIndex / state.learnOrder.length) * 100);
    els.panel.innerHTML = `
      <div class="panel-grid">
        <div class="study-stage">
          <div class="card-meta">
            <span>第 ${displayIndex} / ${state.learnOrder.length} 个 · 已尝试 ${record.attempts} 次</span>
            <div class="mini-progress" aria-label="认读进度 ${percent}%"><span style="width:${percent}%"></span></div>
          </div>
          ${voiceExerciseHTML({ target, instruction: "看清单词，点“开始认读”，然后由孩子自己读出来。", allowModel: true })}
        </div>
        <aside class="side-note">
          <div>
            <p class="eyebrow">认读判定</p>
            <h2>不是按按钮，是亲口读对。</h2>
            <p>按钮只负责打开麦克风。网页听到并识别为当前英文单词后，才会把它记录成“已经会读”。</p>
          </div>
          <span class="tip-index" aria-hidden="true">01</span>
        </aside>
      </div>`;
    bindVoiceActions(target);
  }

  function nextLearn() {
    state.learnIndex = (state.learnIndex + 1) % state.learnOrder.length;
    const target = state.learnOrder[state.learnIndex];
    progress.lastSession = { mode: "learn", word: target, updatedAt: Date.now() };
    saveProgress();
    renderLearn();
  }

  function renderChallenge() {
    if (!state.challengeOrder.length) startChallenge();
    if (state.challengeIndex >= state.challengeOrder.length) {
      renderChallengeFinish();
      return;
    }
    const target = state.challengeOrder[state.challengeIndex];
    const percent = Math.round((state.challengeIndex / state.challengeOrder.length) * 100);
    els.panel.innerHTML = `
      <div class="panel-grid">
        <div class="study-stage">
          <div class="challenge-meta">
            <span>挑战 ${state.challengeIndex + 1} / ${state.challengeOrder.length}</span>
            <div class="mini-progress" aria-label="挑战进度 ${percent}%"><span style="width:${percent}%"></span></div>
            <span>独立读对 ${state.challengeCorrect}</span>
          </div>
          ${voiceExerciseHTML({ target, instruction: "挑战模式不先播放发音。看到单词后，请孩子直接读出来。", allowModel: false })}
        </div>
        <aside class="side-note coral">
          <div>
            <p class="eyebrow">挑战规则</p>
            <h2>看见单词，独立读出。</h2>
            <p>系统只按麦克风实际听到的结果判定。第一次读错会进入错词本；读对后才进入下一题。</p>
          </div>
          <span class="tip-index" aria-hidden="true">02</span>
        </aside>
      </div>`;
    bindVoiceActions(target);
  }

  function nextChallenge() {
    state.challengeIndex += 1;
    if (state.challengeIndex < state.challengeOrder.length) {
      progress.lastSession = { mode: "challenge", word: state.challengeOrder[state.challengeIndex], updatedAt: Date.now() };
      saveProgress();
    }
    renderChallenge();
  }

  function renderChallengeFinish() {
    const total = state.challengeOrder.length;
    els.panel.innerHTML = `
      <div class="session-finish"><div>
        <div class="empty-number">${state.challengeCorrect}</div>
        <h2>开口挑战完成</h2>
        <p>这轮独立读对 ${state.challengeCorrect} / ${total} 个单词。所有结果都已经逐词保存。</p>
        <div class="action-row">
          <button class="secondary-button" type="button" data-action="go-review">去巩固错词</button>
          <button class="primary-button" type="button" data-action="restart-challenge">再挑战一次</button>
        </div>
      </div></div>`;
    els.panel.querySelector('[data-action="go-review"]')?.addEventListener("click", () => setMode("review"));
    els.panel.querySelector('[data-action="restart-challenge"]')?.addEventListener("click", () => setMode("challenge"));
  }

  function renderReview() {
    state.reviewQueue = state.reviewQueue.filter((word) => progress.mistakes[word]);
    if (!state.reviewQueue.length) {
      renderReviewEmpty();
      return;
    }
    if (state.reviewIndex >= state.reviewQueue.length) state.reviewIndex = 0;
    const target = state.reviewQueue[state.reviewIndex];
    const info = progress.mistakes[target] || { correctStreak: 0 };
    els.panel.innerHTML = `
      <div class="panel-grid">
        <div class="study-stage">
          <div class="review-meta">
            <span>还有 ${Object.keys(progress.mistakes).filter((word) => words.includes(word)).length} 个错词</span>
            <span>${escapeHTML(target)}：连续读对 ${info.correctStreak || 0} / 2 次</span>
          </div>
          ${voiceExerciseHTML({ target, instruction: "先听一次标准发音，再由孩子读出来；连续读对两次才完成巩固。", allowModel: true })}
        </div>
        <aside class="side-note sunny">
          <div>
            <p class="eyebrow">巩固规则</p>
            <h2>错一次，亲口读对两次。</h2>
            <p>错词不会因为点了按钮而消失。只有网页实际听到孩子连续两次读对，才会从错词本移除。</p>
          </div>
          <span class="tip-index" aria-hidden="true">03</span>
        </aside>
      </div>`;
    bindVoiceActions(target);
    autoSpeak(target);
  }

  function nextReview(target) {
    if (!progress.mistakes[target]) {
      state.reviewQueue = state.reviewQueue.filter((word) => word !== target);
    } else {
      state.reviewIndex = (state.reviewIndex + 1) % state.reviewQueue.length;
    }
    if (state.reviewQueue.length) {
      const next = state.reviewQueue[state.reviewIndex % state.reviewQueue.length];
      progress.lastSession = { mode: "review", word: next, updatedAt: Date.now() };
      saveProgress();
    }
    renderReview();
  }

  function renderReviewEmpty() {
    els.panel.innerHTML = `
      <div class="empty-review"><div>
        <div class="empty-number">✓</div>
        <h2>所有错词都读对了</h2>
        <p>这里没有可以点击跳过的“假完成”。只有孩子亲口读对的单词，才会离开错词本。</p>
        <button class="primary-button" type="button" data-action="start-challenge">开始开口挑战</button>
      </div></div>`;
    els.panel.querySelector('[data-action="start-challenge"]')?.addEventListener("click", () => setMode("challenge"));
  }

  function bindVoiceActions(target) {
    els.panel.querySelector('[data-action="listen"]')?.addEventListener("click", () => startListening(target));
    els.panel.querySelector('[data-action="model-speak"]')?.addEventListener("click", () => speak(target));
    els.panel.querySelector('[data-action="skip"]')?.addEventListener("click", () => {
      state.speechOutcome = null;
      if (state.mode === "learn") nextLearn();
      if (state.mode === "challenge") nextChallenge();
      if (state.mode === "review") {
        state.reviewIndex = (state.reviewIndex + 1) % state.reviewQueue.length;
        renderReview();
      }
    });
  }

  function renderStats() {
    const mistakeWords = Object.keys(progress.mistakes).filter((word) => words.includes(word));
    const mastered = words.filter((word) => isMastered(word)).length;
    const accuracy = progress.totalAttempts
      ? `${Math.round((progress.correctAttempts / progress.totalAttempts) * 100)}%`
      : "—";
    els.wordCount.textContent = words.length;
    els.todayCount.textContent = progress.daily[todayKey()] || 0;
    els.masteredStat.textContent = mastered;
    els.answerStat.textContent = progress.totalAttempts;
    els.accuracyStat.textContent = accuracy;
    els.mistakeStat.textContent = mistakeWords.length;
    els.mistakeBadge.textContent = mistakeWords.length;
    els.mistakeBadge.hidden = mistakeWords.length === 0;
    els.clearMistakesButton.disabled = mistakeWords.length === 0;
    els.mistakeStrip.innerHTML = mistakeWords.length
      ? mistakeWords.slice(0, 18).map((word) => `<span class="mistake-chip">${escapeHTML(word)}</span>`).join("")
      : '<span class="mistake-empty">还没有需要巩固的单词。</span>';
    els.sourceNote.textContent = `${meta.label} · ${meta.note}`;
  }

  function wordStatus(word) {
    const record = currentWordRecord(word);
    if (isMastered(word)) return "mastered";
    if (record.attempts > 0 || progress.mistakes[word]) return "learning";
    return "new";
  }

  function formatTime(timestamp) {
    if (!timestamp) return "还没有认读记录";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
    }).format(new Date(timestamp));
  }

  function openRecords() {
    state.recordFilter = "all";
    renderRecords();
    els.recordsBackdrop.hidden = false;
    els.closeRecordsButton.focus();
  }

  function closeRecords() {
    els.recordsBackdrop.hidden = true;
    els.recordButton.focus();
  }

  function renderRecords() {
    const counts = {
      mastered: words.filter((word) => wordStatus(word) === "mastered").length,
      learning: words.filter((word) => wordStatus(word) === "learning").length,
      new: words.filter((word) => wordStatus(word) === "new").length
    };
    const filtered = words.filter((word) => state.recordFilter === "all" || wordStatus(word) === state.recordFilter);
    const labels = { mastered: "已会读", learning: "练习中", new: "未开始" };

    els.recordFilters.forEach((button) => button.classList.toggle("is-active", button.dataset.recordFilter === state.recordFilter));
    els.recordSummary.textContent = `已会读 ${counts.mastered} · 练习中 ${counts.learning} · 未开始 ${counts.new} · 共 ${words.length} 个词`;
    els.recordList.innerHTML = filtered.map((word) => {
      const record = currentWordRecord(word);
      const status = wordStatus(word);
      const heard = record.lastHeard ? `上次听到“${escapeHTML(record.lastHeard)}”` : "还没有听取记录";
      return `<button class="record-row" type="button" data-record-word="${escapeHTML(word)}">
        <span class="record-word">${escapeHTML(word)}</span>
        <span class="record-detail">尝试 ${record.attempts} 次 · 读对 ${record.correct} 次 · ${heard}<br>${formatTime(record.lastPracticed)}</span>
        <span class="record-status ${status}">${labels[status]}</span>
      </button>`;
    }).join("") || '<p class="mistake-empty">这个分类里还没有单词。</p>';

    els.recordList.querySelectorAll("[data-record-word]").forEach((button) => {
      button.addEventListener("click", () => continueAtWord(button.dataset.recordWord));
    });
  }

  function continueAtWord(word) {
    closeRecords();
    state.mode = "learn";
    state.learnOrder = [word, ...buildLearnOrder().filter((item) => item !== word)];
    state.learnIndex = 0;
    state.speechOutcome = null;
    progress.lastSession = { mode: "learn", word, updatedAt: Date.now() };
    saveProgress();
    updateModeTabs();
    render();
  }

  function exportRecords() {
    const payload = {
      app: "Word Buddy",
      exportedAt: new Date().toISOString(),
      wordCount: words.length,
      progress
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `单词星球学习档案-${todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("学习档案已导出");
  }

  async function importRecords(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const incoming = normalizeProgress(payload.progress || payload);
      if (!incoming.wordProgress || typeof incoming.wordProgress !== "object") throw new Error("invalid");
      progress = incoming;
      saveProgress({ immediate: true });
      state.learnOrder = buildLearnOrder();
      resumeLastWord();
      renderRecords();
      render();
      showToast("学习档案已恢复");
    } catch {
      showToast("这个文件不是有效的学习档案");
    } finally {
      els.importRecordsInput.value = "";
    }
  }

  function showToast(message) {
    window.clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => { els.toast.hidden = true; }, 2300);
  }

  function openSettings() {
    els.settingsBackdrop.hidden = false;
    els.closeSettingsButton.focus();
  }

  function closeSettings() {
    els.settingsBackdrop.hidden = true;
    els.settingsButton.focus();
  }

  function updateRateLabel() {
    const rate = Number(settings.rate);
    els.rateOutput.value = rate <= 0.7 ? "慢速" : rate <= 0.9 ? "舒缓" : "自然";
  }

  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    voices = window.speechSynthesis.getVoices().filter((voice) => voice.lang?.startsWith("en"));
    els.voiceSelect.innerHTML = '<option value="">设备默认声音</option>'
      + voices.map((voice) => `<option value="${escapeHTML(voice.voiceURI)}">${escapeHTML(voice.name)} · ${escapeHTML(voice.lang)}</option>`).join("");
    els.voiceSelect.value = voices.some((voice) => voice.voiceURI === settings.voiceURI) ? settings.voiceURI : "";
  }

  els.modeTabs.forEach((tab) => tab.addEventListener("click", () => {
    state.audioUnlocked = true;
    setMode(tab.dataset.mode);
  }));

  els.brand.addEventListener("click", (event) => {
    event.preventDefault();
    setMode("learn");
  });

  els.settingsButton.addEventListener("click", openSettings);
  els.closeSettingsButton.addEventListener("click", closeSettings);
  els.settingsBackdrop.addEventListener("click", (event) => {
    if (event.target === els.settingsBackdrop) closeSettings();
  });

  els.recordButton.addEventListener("click", openRecords);
  els.openRecordsButton.addEventListener("click", openRecords);
  els.closeRecordsButton.addEventListener("click", closeRecords);
  els.recordsBackdrop.addEventListener("click", (event) => {
    if (event.target === els.recordsBackdrop) closeRecords();
  });
  els.recordFilters.forEach((button) => button.addEventListener("click", () => {
    state.recordFilter = button.dataset.recordFilter;
    renderRecords();
  }));
  els.exportRecordsButton.addEventListener("click", exportRecords);
  els.importRecordsInput.addEventListener("change", () => importRecords(els.importRecordsInput.files?.[0]));

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!els.settingsBackdrop.hidden) closeSettings();
    if (!els.recordsBackdrop.hidden) closeRecords();
  });

  els.clearMistakesButton.addEventListener("click", () => {
    if (!Object.keys(progress.mistakes).length) return;
    if (!window.confirm("只清空错词队列，不会删除逐词认读记录。确定继续吗？")) return;
    progress.mistakes = {};
    saveProgress();
    if (state.mode === "review") startReview();
    render();
    showToast("错词队列已清空，逐词记录仍保留");
  });

  els.autoSpeakInput.checked = Boolean(settings.autoSpeak);
  els.rateInput.value = String(settings.rate);
  updateRateLabel();
  els.autoSpeakInput.addEventListener("change", () => {
    settings.autoSpeak = els.autoSpeakInput.checked;
    saveSettings();
  });
  els.rateInput.addEventListener("input", () => {
    settings.rate = Number(els.rateInput.value);
    updateRateLabel();
    saveSettings();
  });
  els.voiceSelect.addEventListener("change", () => {
    settings.voiceURI = els.voiceSelect.value;
    saveSettings();
  });
  els.testVoiceButton.addEventListener("click", () => speak("Hello! Let's read together."));

  window.addEventListener("pagehide", () => {
    if (state.serverSyncAvailable && navigator.sendBeacon) {
      navigator.sendBeacon("/api/progress", new Blob([JSON.stringify(progress)], { type: "application/json" }));
    }
  });

  if ("speechSynthesis" in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  render();
  hydrateProgress();
})();

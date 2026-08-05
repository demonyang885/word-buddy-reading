(() => {
  "use strict";

  const course = {
    courseId: "en-challenge-3",
    courseName: "英文認詞",
    speechLang: "en-US",
    storageKey: "word-buddy-challenge-3-progress-v1",
    settingsKey: "word-buddy-settings-v1",
    legacyStorageKey: "word-buddy-progress-v1",
    progressVersion: 3,
    locale: "zh-HK",
    compactSpeech: false,
    itemLabel: "單詞",
    subjectLabel: "英文單詞",
    appName: "Word Buddy",
    exportFilePrefix: "英文單詞星球學習檔案",
    testPhrase: "Hello! Let's read together.",
    speechAliases: {},
    voiceLanguageFallbacks: [],
    enableLocalServerSync: true,
    ...window.WORD_BUDDY_CONFIG
  };

  const STORAGE_KEY = course.storageKey;
  const LEGACY_STORAGE_KEY = course.legacyStorageKey || "";
  const SETTINGS_KEY = course.settingsKey;
  const CHALLENGE_LENGTH = 10;
  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;

  const sections = Array.isArray(window.WORD_DATABASE_SECTIONS) ? window.WORD_DATABASE_SECTIONS : [];
  const meta = window.WORD_DATABASE_META || { label: "本機詞庫", note: "" };

  const defaultProgress = {
    version: course.progressVersion,
    totalAttempts: 0,
    correctAttempts: 0,
    daily: {},
    mistakes: {},
    wordProgress: {},
    sectionSessions: {},
    lastSession: { mode: "learn", word: "", updatedAt: 0 },
    updatedAt: 0
  };

  const defaultSettings = {
    autoSpeak: true,
    rate: 0.8,
    voiceURI: "",
    speechLang: course.speechLang,
    sectionId: "all"
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
    autoSpeakTimer: null,
    saveTimer: null,
    serverSyncAvailable: false
  };

  let settings = loadStored(SETTINGS_KEY, defaultSettings);
  let words = buildWordList();
  let progress = normalizeProgress(loadStored(STORAGE_KEY, defaultProgress));
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
    speechLangSelect: document.querySelector("#speechLangSelect"),
    sectionSelect: document.querySelector("#sectionSelect"),
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

  function cleanEntryText(value) {
    return String(value).normalize("NFC").trim().toLocaleLowerCase(course.locale);
  }

  function buildWordList() {
    const requestedSectionId = settings?.sectionId || "all";
    const sectionId = requestedSectionId === "all" || sections.some((section) => section.id === requestedSectionId)
      ? requestedSectionId
      : "all";
    if (settings && sectionId !== requestedSectionId) settings.sectionId = sectionId;
    const source = sections.length
      ? (sectionId === "all"
        ? sections.flatMap((section) => section.words || [])
        : sections.find((section) => section.id === sectionId)?.words || [])
      : (window.WORD_DATABASE || []);
    return [...new Set(source.map(cleanEntryText).filter(Boolean))];
  }

  function currentSectionId() {
    return sections.length ? (settings.sectionId || "all") : "default";
  }

  function currentSectionLabel() {
    if (!sections.length || currentSectionId() === "all") return "全部範圍";
    return sections.find((section) => section.id === currentSectionId())?.label || "目前範圍";
  }

  function currentSession() {
    if (sections.length) {
      return progress.sectionSessions?.[currentSectionId()] || cloneData(defaultProgress.lastSession);
    }
    return progress.lastSession;
  }

  function setLastSession(mode, word) {
    const session = { mode, word, updatedAt: Date.now() };
    if (mode === "challenge") {
      session.challengeOrder = [...state.challengeOrder];
      session.challengeIndex = state.challengeIndex;
      session.challengeCorrect = state.challengeCorrect;
    }
    progress.lastSession = session;
    if (sections.length) progress.sectionSessions[currentSectionId()] = session;
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
    normalized.sectionSessions = normalized.sectionSessions && typeof normalized.sectionSessions === "object" ? normalized.sectionSessions : {};
    normalized.lastSession = normalized.lastSession && typeof normalized.lastSession === "object"
      ? { ...defaultProgress.lastSession, ...normalized.lastSession }
      : cloneData(defaultProgress.lastSession);
    return normalized;
  }

  function migrateLegacyProgress() {
    if (!LEGACY_STORAGE_KEY || localStorage.getItem(STORAGE_KEY)) return;
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
    return course.enableLocalServerSync && (location.port === "8000" || location.port === "8443");
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

    const session = currentSession();
    const resumableMode = ["learn", "challenge", "review"].includes(session.mode)
      ? session.mode
      : "learn";
    state.mode = resumableMode;
    state.learnOrder = buildLearnOrder();
    resumeLastWord();
    if (state.mode === "challenge") startChallenge(session.word, session);
    if (state.mode === "review") startReview(session.word);
    state.ready = true;
    updateModeTabs();
    updateSyncStatus();
    render();
  }

  function updateSyncStatus(status) {
    els.syncStatus.classList.remove("is-saved", "is-local");
    if (status === "saving") {
      els.syncStatus.textContent = "正在儲存";
      return;
    }
    if (state.serverSyncAvailable) {
      els.syncStatus.textContent = "電腦與 iPad 已儲存";
      els.syncStatus.classList.add("is-saved");
    } else {
      els.syncStatus.textContent = "已儲存在這台裝置";
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

  function populateSectionSelect() {
    if (!els.sectionSelect || !sections.length) return;
    els.sectionSelect.innerHTML = [
      `<option value="all">全部範圍（${buildWordListForSection("all").length} 個）</option>`,
      ...sections.map((section) => {
        const count = buildWordListForSection(section.id).length;
        return `<option value="${escapeHTML(section.id)}">${escapeHTML(section.label)}（${count} 個）</option>`;
      })
    ].join("");
    els.sectionSelect.value = currentSectionId();
  }

  function buildWordListForSection(sectionId) {
    const source = sectionId === "all"
      ? sections.flatMap((section) => section.words || [])
      : sections.find((section) => section.id === sectionId)?.words || [];
    return [...new Set(source.map(cleanEntryText).filter(Boolean))];
  }

  function switchSection(sectionId) {
    window.clearTimeout(state.nextTimer);
    cancelAutoSpeak();
    stopListening();
    window.speechSynthesis?.cancel();
    settings.sectionId = sectionId;
    saveSettings();
    words = buildWordList();
    state.speechOutcome = null;
    state.learnOrder = buildLearnOrder();
    state.challengeOrder = [];
    state.challengeIndex = 0;
    state.challengeCorrect = 0;
    state.reviewQueue = [];
    state.reviewIndex = 0;

    const session = currentSession();
    state.mode = ["learn", "challenge", "review"].includes(session.mode) ? session.mode : "learn";
    resumeLastWord();
    if (state.mode === "challenge") startChallenge(session.word, session);
    if (state.mode === "review") startReview(session.word);
    updateModeTabs();
    render();
    showToast(`已切換至${currentSectionLabel()}`);
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
    const lastWord = currentSession().word;
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
    const normalized = String(value)
      .normalize("NFKC")
      .toLocaleLowerCase(course.locale)
      .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return course.compactSpeech ? normalized.replace(/[\s'-]+/g, "") : normalized;
  }

  function matchesTarget(transcripts, target) {
    const accepted = [target, ...(course.speechAliases?.[target] || [])]
      .map(normalizeSpeech)
      .filter(Boolean);
    return transcripts.some((transcript) => {
      const heard = normalizeSpeech(transcript);
      if (accepted.includes(heard)) return true;
      if (course.compactSpeech) return false;
      const tokens = heard.split(" ");
      return tokens.length <= 3 && accepted.some((candidate) => !candidate.includes(" ") && tokens.includes(candidate));
    });
  }

  function activeSpeechLang() {
    return settings.speechLang || course.speechLang;
  }

  function languageFamily(language) {
    return String(language || course.speechLang).split("-")[0].toLowerCase();
  }

  function speak(word) {
    state.audioUnlocked = true;
    cancelAutoSpeak();
    if (!("speechSynthesis" in window)) {
      showToast("這台裝置暫不支援標準發音");
      return;
    }
    stopListening();
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = activeSpeechLang();
    utterance.rate = Number(settings.rate) || 0.8;
    utterance.pitch = 1.03;
    const preferredLanguages = [...new Set([activeSpeechLang(), ...(course.voiceLanguageFallbacks || [])])]
      .map((language) => language.toLowerCase());
    const voice = voices.find((item) => item.voiceURI === settings.voiceURI)
      || preferredLanguages
        .map((language) => voices.find((item) => item.lang?.toLowerCase() === language))
        .find(Boolean)
      || voices.find((item) => item.lang?.toLowerCase().startsWith(languageFamily(activeSpeechLang())));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  function autoSpeak(word) {
    cancelAutoSpeak();
    if (settings.autoSpeak && state.audioUnlocked && state.mode !== "challenge" && !state.speechOutcome) {
      const scheduledMode = state.mode;
      state.autoSpeakTimer = window.setTimeout(() => {
        state.autoSpeakTimer = null;
        if (state.mode === scheduledMode && !state.listening && !state.speechOutcome) speak(word);
      }, 150);
    }
  }

  function cancelAutoSpeak() {
    window.clearTimeout(state.autoSpeakTimer);
    state.autoSpeakTimer = null;
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
      return `<div class="secure-warning">這個網址不是安全的 HTTPS 頁面，所以 Safari 不會開放語音識別。請使用發布後的 GitHub Pages HTTPS 網址。</div>`;
    }
    return `<div class="secure-warning">目前瀏覽器沒有開放網頁語音識別。請在 iPad 的 <strong>Safari</strong> 中開啟，並確認 Siri 或聽寫已啟用；不要使用應用程式內置瀏覽器。</div>`;
  }

  function startListening(target) {
    state.audioUnlocked = true;
    cancelAutoSpeak();
    window.speechSynthesis?.cancel();
    window.clearTimeout(state.nextTimer);

    const issue = recognitionIssue();
    if (issue) {
      state.speechOutcome = { type: "error", message: issue === "secure" ? "請改用 HTTPS 學習網址" : "請使用 Safari 並啟用 Siri 或聽寫" };
      render();
      return;
    }

    stopListening();
    const recognition = new SpeechRecognitionAPI();
    state.recognition = recognition;
    state.listening = true;
    state.speechOutcome = { type: "listening", message: `正在聽，請清楚地讀出${course.itemLabel}…` };

    recognition.lang = activeSpeechLang();
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
        "not-allowed": "需要允許 Safari 使用咪高峰和語音識別",
        "service-not-allowed": "請在 iPad 設定中啟用 Siri 或聽寫",
        "audio-capture": "找不到可用的咪高峰",
        "no-speech": "沒有聽到聲音，請靠近一點再讀一次",
        network: "語音服務暫時無法連線，請稍後再試",
        aborted: "已停止收音"
      };
      state.speechOutcome = { type: "error", message: messages[event.error] || "沒有聽清楚，請再讀一次" };
      render();
    };

    recognition.onend = () => {
      state.listening = false;
      if (!receivedResult && state.speechOutcome?.type === "listening") {
        state.speechOutcome = { type: "error", message: "沒有聽清楚，請再讀一次" };
        render();
      }
    };

    try {
      recognition.start();
      render();
    } catch {
      state.listening = false;
      state.speechOutcome = { type: "error", message: "咪高峰尚未準備好，請稍後再試" };
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
    setLastSession(state.mode, word);
    saveProgress();
  }

  function finishSpokenAttempt(target, transcripts) {
    stopListening();
    const heard = transcripts[0] || "";
    const correct = matchesTarget(transcripts, target);
    if (correct && state.mode === "challenge") state.challengeCorrect += 1;
    recordSpokenAttempt(target, correct, heard);
    state.speechOutcome = {
      type: correct ? "correct" : "wrong",
      message: correct ? `讀對了：${target}` : `系統聽到：${heard || `沒有識別到${course.itemLabel}`}`,
      heard
    };

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
    cancelAutoSpeak();
    stopListening();
    window.speechSynthesis?.cancel();
    state.mode = mode;
    state.speechOutcome = null;
    if (mode === "challenge" && !options.resume) startChallenge();
    if (mode === "review") startReview();
    const activeWord = mode === "challenge"
      ? state.challengeOrder[0]
      : mode === "review"
        ? state.reviewQueue[0]
        : state.learnOrder[state.learnIndex] || words[0];
    setLastSession(mode, activeWord || "");
    saveProgress();
    updateModeTabs();
    render();
  }

  function startChallenge(preferredWord = "", savedSession = null) {
    const savedOrder = Array.isArray(savedSession?.challengeOrder)
      ? savedSession.challengeOrder.filter((word, index, list) => words.includes(word) && list.indexOf(word) === index)
      : [];
    const savedIndex = Number(savedSession?.challengeIndex);
    const canResume = savedOrder.length > 0
      && savedOrder.length <= Math.min(CHALLENGE_LENGTH, words.length)
      && Number.isInteger(savedIndex)
      && savedIndex >= 0
      && savedIndex <= savedOrder.length;
    if (canResume) {
      state.challengeOrder = savedOrder;
      state.challengeIndex = savedIndex;
      state.challengeCorrect = Math.max(0, Math.min(Number(savedSession.challengeCorrect) || 0, savedOrder.length));
      return;
    }

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
      els.panel.innerHTML = '<div class="empty-review"><div><div class="empty-number">…</div><h2>正在讀取上次進度</h2></div></div>';
      return;
    }
    if (!words.length) {
      els.panel.innerHTML = `<div class="empty-review"><div><div class="empty-number">0</div><h2>詞庫還是空的</h2><p>請先加入${course.subjectLabel}。</p></div></div>`;
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
    if (outcome.type === "listening") return `<p class="speech-feedback try">${escapeHTML(outcome.message)}<small>看到紅色脈衝時開始讀</small></p>`;
    if (outcome.type === "correct") return `<p class="speech-feedback good">${escapeHTML(outcome.message)}<small>系統確認讀音後才會記為「會讀」</small></p>`;
    if (outcome.type === "wrong") return `<p class="speech-feedback try">${escapeHTML(outcome.message)}<small>目標${course.itemLabel}是 ${escapeHTML(target)}，聽標準發音後再試一次</small></p>`;
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
          ${issue ? "" : `<button class="mic-button ${state.listening ? "is-listening" : ""}" type="button" data-action="listen" ${state.listening ? "disabled" : ""}>${state.listening ? "正在聽…" : "開始認讀"}</button>`}
          ${voiceOutcomeHTML(target)}
          <div class="voice-actions">
            ${allowModel || state.speechOutcome?.type === "wrong" ? '<button class="sound-button" type="button" data-action="model-speak">聽標準發音</button>' : ""}
            <button class="secondary-button" type="button" data-action="skip">暫時跳過</button>
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
            <span>第 ${displayIndex} / ${state.learnOrder.length} 個 · 已嘗試 ${record.attempts} 次</span>
            <div class="mini-progress" aria-label="認讀進度 ${percent}%"><span style="width:${percent}%"></span></div>
          </div>
          ${voiceExerciseHTML({ target, instruction: `看清${course.itemLabel}，點「開始認讀」，然後由孩子自己讀出來。`, allowModel: true })}
        </div>
        <aside class="side-note">
          <div>
            <p class="eyebrow">認讀判定</p>
            <h2>不是按按鈕，是親口讀對。</h2>
            <p>按鈕只負責開啟咪高峰。網頁聽到並識別為目前${course.subjectLabel}後，才會把它記錄成「已經會讀」。</p>
          </div>
          <span class="tip-index" aria-hidden="true">01</span>
        </aside>
      </div>`;
    bindVoiceActions(target);
  }

  function nextLearn() {
    state.learnIndex = (state.learnIndex + 1) % state.learnOrder.length;
    const target = state.learnOrder[state.learnIndex];
    setLastSession("learn", target);
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
            <span>挑戰 ${state.challengeIndex + 1} / ${state.challengeOrder.length}</span>
            <div class="mini-progress" aria-label="挑戰進度 ${percent}%"><span style="width:${percent}%"></span></div>
            <span>獨立讀對 ${state.challengeCorrect}</span>
          </div>
          ${voiceExerciseHTML({ target, instruction: `挑戰模式不先播放發音。看到${course.itemLabel}後，請孩子直接讀出來。`, allowModel: false })}
        </div>
        <aside class="side-note coral">
          <div>
            <p class="eyebrow">挑戰規則</p>
            <h2>看見${course.itemLabel}，獨立讀出。</h2>
            <p>系統只按咪高峰實際聽到的結果判定。第一次讀錯會進入待鞏固清單；讀對後才進入下一題。</p>
          </div>
          <span class="tip-index" aria-hidden="true">02</span>
        </aside>
      </div>`;
    bindVoiceActions(target);
  }

  function nextChallenge() {
    state.challengeIndex += 1;
    setLastSession("challenge", state.challengeOrder[state.challengeIndex] || "");
    saveProgress();
    renderChallenge();
  }

  function renderChallengeFinish() {
    const total = state.challengeOrder.length;
    els.panel.innerHTML = `
      <div class="session-finish"><div>
        <div class="empty-number">${state.challengeCorrect}</div>
        <h2>開口挑戰完成</h2>
        <p>這輪獨立讀對 ${state.challengeCorrect} / ${total} 個${course.itemLabel}。所有結果都已經逐項儲存。</p>
        <div class="action-row">
          <button class="secondary-button" type="button" data-action="go-review">去鞏固錯誤項目</button>
          <button class="primary-button" type="button" data-action="restart-challenge">再挑戰一次</button>
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
            <span>還有 ${Object.keys(progress.mistakes).filter((word) => words.includes(word)).length} 個待鞏固${course.itemLabel}</span>
            <span>${escapeHTML(target)}：連續讀對 ${info.correctStreak || 0} / 2 次</span>
          </div>
          ${voiceExerciseHTML({ target, instruction: "先聽一次標準發音，再由孩子讀出來；連續讀對兩次才完成鞏固。", allowModel: true })}
        </div>
        <aside class="side-note sunny">
          <div>
            <p class="eyebrow">鞏固規則</p>
            <h2>錯一次，親口讀對兩次。</h2>
            <p>待鞏固項目不會因為按了按鈕而消失。只有網頁實際聽到孩子連續兩次讀對，才會移除。</p>
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
      setLastSession("review", next);
      saveProgress();
    }
    renderReview();
  }

  function renderReviewEmpty() {
    els.panel.innerHTML = `
      <div class="empty-review"><div>
        <div class="empty-number">✓</div>
        <h2>目前沒有待鞏固項目</h2>
        <p>只有孩子親口讀對的${course.itemLabel}，才會離開待鞏固清單。</p>
        <button class="primary-button" type="button" data-action="start-challenge">開始開口挑戰</button>
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
        const next = state.reviewQueue[state.reviewIndex];
        setLastSession("review", next || "");
        saveProgress();
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
      : `<span class="mistake-empty">目前沒有需要鞏固的${course.itemLabel}。</span>`;
    els.sourceNote.textContent = sections.length
      ? `${meta.label} · ${currentSectionLabel()} · ${meta.note}`
      : `${meta.label} · ${meta.note}`;
  }

  function wordStatus(word) {
    const record = currentWordRecord(word);
    if (isMastered(word)) return "mastered";
    if (record.attempts > 0 || progress.mistakes[word]) return "learning";
    return "new";
  }

  function formatTime(timestamp) {
    if (!timestamp) return "還沒有認讀記錄";
    return new Intl.DateTimeFormat(course.locale, {
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
    const labels = { mastered: "已會讀", learning: "練習中", new: "未開始" };

    els.recordFilters.forEach((button) => {
      const active = button.dataset.recordFilter === state.recordFilter;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    els.recordSummary.textContent = `已會讀 ${counts.mastered} · 練習中 ${counts.learning} · 未開始 ${counts.new} · 共 ${words.length} 個${course.itemLabel}`;
    els.recordList.innerHTML = filtered.map((word) => {
      const record = currentWordRecord(word);
      const status = wordStatus(word);
      const heard = record.lastHeard ? `上次聽到「${escapeHTML(record.lastHeard)}」` : "還沒有收音記錄";
      return `<button class="record-row" type="button" data-record-word="${escapeHTML(word)}">
        <span class="record-word">${escapeHTML(word)}</span>
        <span class="record-detail">嘗試 ${record.attempts} 次 · 讀對 ${record.correct} 次 · ${heard}<br>${formatTime(record.lastPracticed)}</span>
        <span class="record-status ${status}">${labels[status]}</span>
      </button>`;
    }).join("") || `<p class="mistake-empty">這個分類裏還沒有${course.itemLabel}。</p>`;

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
    setLastSession("learn", word);
    saveProgress();
    updateModeTabs();
    render();
  }

  function exportRecords() {
    const payload = {
      schemaVersion: 4,
      app: course.appName,
      courseId: course.courseId,
      courseName: course.courseName,
      locale: activeSpeechLang(),
      datasetVersion: course.datasetVersion || 1,
      exportedAt: new Date().toISOString(),
      wordCount: words.length,
      sectionId: currentSectionId(),
      progress
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${course.exportFilePrefix}-${todayKey()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("學習檔案已匯出");
  }

  async function importRecords(file) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("too-large");
      const payload = JSON.parse(await file.text());
      const legacyEnglish = course.courseId === "en-challenge-3" && payload?.app === "Word Buddy" && payload?.progress;
      if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("invalid");
      if (payload.courseId !== course.courseId && !legacyEnglish) throw new Error("wrong-course");
      if (!payload.progress || Array.isArray(payload.progress) || typeof payload.progress !== "object") throw new Error("invalid");
      if (!payload.progress.wordProgress || Array.isArray(payload.progress.wordProgress) || typeof payload.progress.wordProgress !== "object") throw new Error("invalid");
      const incoming = normalizeProgress(payload.progress);
      const recordsAreValid = Object.values(incoming.wordProgress).every((record) => record && !Array.isArray(record) && typeof record === "object");
      if (!recordsAreValid) throw new Error("invalid");
      if (!window.confirm(`這會以匯入檔案覆蓋目前的${course.courseName}記錄。確定繼續嗎？`)) return;
      localStorage.setItem(`${STORAGE_KEY}-backup`, JSON.stringify(progress));
      progress = incoming;
      saveProgress({ immediate: true });
      if (sections.length && payload.sectionId && (payload.sectionId === "all" || sections.some((section) => section.id === payload.sectionId))) {
        settings.sectionId = payload.sectionId;
        saveSettings();
        words = buildWordList();
        if (els.sectionSelect) els.sectionSelect.value = settings.sectionId;
      }
      state.learnOrder = buildLearnOrder();
      resumeLastWord();
      renderRecords();
      render();
      showToast("學習檔案已恢復");
    } catch {
      showToast(`這個檔案不是有效的${course.courseName}學習檔案`);
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
    els.rateOutput.value = rate <= 0.7 ? "慢速" : rate <= 0.9 ? "舒緩" : "自然";
  }

  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    const family = languageFamily(activeSpeechLang());
    voices = window.speechSynthesis.getVoices().filter((voice) => voice.lang?.toLowerCase().startsWith(family));
    els.voiceSelect.innerHTML = '<option value="">裝置預設聲音</option>'
      + voices.map((voice) => `<option value="${escapeHTML(voice.voiceURI)}">${escapeHTML(voice.name)} · ${escapeHTML(voice.lang)}</option>`).join("");
    els.voiceSelect.value = voices.some((voice) => voice.voiceURI === settings.voiceURI) ? settings.voiceURI : "";
  }

  function populateSpeechLanguageSelect() {
    if (!els.speechLangSelect) return;
    const options = course.speechLanguageOptions?.length
      ? course.speechLanguageOptions
      : [{ value: course.speechLang, label: course.speechLang }];
    els.speechLangSelect.innerHTML = options
      .map((option) => `<option value="${escapeHTML(option.value)}">${escapeHTML(option.label)}</option>`)
      .join("");
    if (!options.some((option) => option.value === settings.speechLang)) settings.speechLang = course.speechLang;
    els.speechLangSelect.value = settings.speechLang;
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
    const visibleMistakes = Object.keys(progress.mistakes).filter((word) => words.includes(word));
    if (!visibleMistakes.length) return;
    if (!window.confirm("只清空目前學習範圍的待鞏固清單，不會刪除逐項認讀記錄。確定繼續嗎？")) return;
    visibleMistakes.forEach((word) => { delete progress.mistakes[word]; });
    saveProgress();
    if (state.mode === "review") startReview();
    render();
    showToast("目前範圍的待鞏固清單已清空，逐項記錄仍保留");
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
  els.speechLangSelect?.addEventListener("change", () => {
    settings.speechLang = els.speechLangSelect.value;
    settings.voiceURI = "";
    saveSettings();
    loadVoices();
    showToast(`已切換朗讀語言`);
  });
  els.sectionSelect?.addEventListener("change", () => switchSection(els.sectionSelect.value));
  els.testVoiceButton.addEventListener("click", () => speak(course.testPhrase));

  window.addEventListener("pagehide", () => {
    if (state.serverSyncAvailable && navigator.sendBeacon) {
      navigator.sendBeacon("/api/progress", new Blob([JSON.stringify(progress)], { type: "application/json" }));
    }
  });

  if ("speechSynthesis" in window) {
    populateSpeechLanguageSelect();
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  populateSectionSelect();
  render();
  hydrateProgress();
})();

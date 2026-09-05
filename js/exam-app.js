import { auth, db, storage } from './exam-shared.js';
import { SecurityWrapper } from './security.js';
import { AIMonitor } from './ai-monitor.js';
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs, query, orderBy as orderByFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

let teamId, currentUser = null;
let memberName = '', memberRole = '';
let questions = [];
let answers = {};
let flagged = {};
let timerInterval, endTime, absoluteDeadline, examDocRef, pausedRemaining = null, questionOrder = [];
let camStream = null, screenStream = null;
let cameraActive = false, screenActive = false, fullscreenActive = false;
let examPaused = false, examSubmitted = false, pauseResolve = null, healthInterval = null, countdownInterval = null, autoSaveInterval = null, autoSnapshotTimers = [];
let _security = null, _aiMonitor = null;
let currentLang = localStorage.getItem('gaac_lang') || 'en';
const STORAGE_KEY = () => `gaac_exam_${teamId}_${currentUser ? currentUser.uid : 'anon'}`;
const AUTO_SNAPSHOT_KEY = () => `${STORAGE_KEY()}_auto_snapshot_count`;
const AUTO_SNAPSHOT_START_KEY = () => `${STORAGE_KEY()}_auto_snapshot_start`;
const AUTO_SNAPSHOT_MAX = 120;
const AUTO_SNAPSHOT_FIRST_DELAY_MS = 30 * 1000;
const AUTO_SNAPSHOT_INTERVAL_MS = 30 * 1000;
const AUTO_SNAPSHOT_SPREAD_MS = 10000;
const AUTO_SNAPSHOT_JITTER_MS = 4000;
const EVENT_SNAPSHOT_COOLDOWN_MS = 30000;

// Screen sharing should be requested whenever the browser supports it. Do not
// skip it just because the device is touch-first; some Android browsers expose
// getDisplayMedia. iOS/iPadOS still does not support real screen capture in the
// browser reliably, so it gets a clear unsupported state instead of hanging.
const USER_AGENT = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
const IS_TOUCH_DEVICE =
  (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || false;
const IS_IOS_DEVICE =
  /iPad|iPhone|iPod/.test(USER_AGENT) ||
  (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_ANDROID_DEVICE = /Android/i.test(USER_AGENT);
const IS_MOBILE_DEVICE = IS_TOUCH_DEVICE || IS_IOS_DEVICE || IS_ANDROID_DEVICE || /Mobi|Mobile/i.test(USER_AGENT);
const HAS_DISPLAY_MEDIA =
  (typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') || false;
const HAS_FULLSCREEN =
  typeof document !== 'undefined' && !!document.documentElement && typeof document.documentElement.requestFullscreen === 'function';
const SCREEN_REQUIRED = !IS_MOBILE_DEVICE && HAS_DISPLAY_MEDIA && !IS_IOS_DEVICE;
const FULLSCREEN_REQUIRED = !IS_MOBILE_DEVICE && HAS_FULLSCREEN && !IS_IOS_DEVICE;
const SHOULD_TRY_FULLSCREEN = IS_MOBILE_DEVICE && HAS_FULLSCREEN && !IS_IOS_DEVICE;
let fullscreenEnforced = FULLSCREEN_REQUIRED;
let ignorePromptTransitionUntil = 0;
const promptTransitionEvents = new Set(['tab-hidden', 'window-blur']);
const markPermissionPrompt = () => { ignorePromptTransitionUntil = Date.now() + 3500; };
const withPermissionPrompt = async (fn) => {
  markPermissionPrompt();
  try { return await fn(); }
  finally { markPermissionPrompt(); }
};

const getDeviceInfo = () => {
  const ua = USER_AGENT;
  const isAndroid = IS_ANDROID_DEVICE;
  const isTablet = /iPad/i.test(ua) || (isAndroid && !/Mobile/i.test(ua));
  const type = isTablet ? 'tablet' : (IS_MOBILE_DEVICE ? 'mobile' : 'desktop');
  return {
    deviceType: type,
    isMobile: type === 'mobile',
    isTablet: type === 'tablet',
    isDesktop: type === 'desktop',
    os: IS_IOS_DEVICE ? 'iOS' : (isAndroid ? 'Android' : 'Other'),
    userAgent: ua.slice(0, 180),
    screenShareRequired: SCREEN_REQUIRED,
    fullscreenRequired: FULLSCREEN_REQUIRED
  };
};

// Server-authoritative Round 1 window. The exam timer endTime is derived from a
// (serverNow + serverOffset) clock so candidates with a wrong device clock all
// start/end at the same real-world instant.
let r1ServerOffset = 0;          // ms to add to Date.now() to approximate server time
let r1Window = { openAt: 0, closeAt: 0, startAt: 0 };
const R1_DEFAULT = {
  openAt: Date.UTC(2026, 8, 5, 16, 0, 0),   // 7:00 PM GMT+3
  closeAt: Date.UTC(2026, 8, 5, 17, 0, 0),  // 8:00 PM GMT+3
  startAt: Date.UTC(2026, 8, 5, 16, 0, 0)   // 7:00 PM GMT+3
};
let r1ServerReady = false;

// Max absence (ms) tolerated before treating a leave as "closed tab/browser"
// and locking the attempt. A normal refresh returns well within this; closing
// the tab/browser and coming back later exceeds it.
const R1_RESUME_GRACE_MS = 15000;

// Fetch the authoritative window + server clock once. Never trust the local
// device clock for the gate — only for the running countdown after calibration.
const loadServerWindow = async () => {
  try {
    const getStatus = httpsCallable(getFunctions(), 'getRound1Status');
    const res = await getStatus();
    const s = res.data || {};
    if (typeof s.openAt === 'number') r1Window.openAt = s.openAt;
    if (typeof s.closeAt === 'number') r1Window.closeAt = s.closeAt;
    if (typeof s.startAt === 'number') r1Window.startAt = s.startAt;
    if (typeof s.now === 'number') r1ServerOffset = s.now - Date.now();
    r1ServerReady = true;
    console.log('[round1] server window loaded', {
      openAt: new Date(r1Window.openAt).toISOString(),
      closeAt: new Date(r1Window.closeAt).toISOString(),
      startAt: new Date(r1Window.startAt).toISOString(),
      serverOffsetMs: r1ServerOffset
    });
  } catch (e) {
    console.warn('[round1] Failed to load server window, using defaults:', e.message || e);
    r1Window = { ...R1_DEFAULT };
    r1ServerOffset = 0;
    r1ServerReady = true;
  }
};

const serverNow = () => Date.now() + r1ServerOffset;

const saveState = () => {
  try {
    localStorage.setItem(STORAGE_KEY(), JSON.stringify({ answers, flagged, endTime, absoluteDeadline, questionOrder }));
  } catch {}
};

const loadState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY());
    if (raw) {
      const data = JSON.parse(raw);
      answers = data.answers || {};
      flagged = data.flagged || {};
      if (data.absoluteDeadline) absoluteDeadline = data.absoluteDeadline;
      if (data.endTime) endTime = data.endTime;
      if (data.questionOrder && data.questionOrder.length > 0) questionOrder = data.questionOrder;
    }
  } catch {}
};

const clearState = () => {
  try { localStorage.removeItem(STORAGE_KEY()); } catch {}
  try { localStorage.removeItem(AUTO_SNAPSHOT_KEY()); } catch {}
  try { localStorage.removeItem(AUTO_SNAPSHOT_START_KEY()); } catch {}
  try { localStorage.removeItem(STORAGE_KEY() + '_leftAt'); } catch {}
  answers = {};
  flagged = {};
  questionOrder = [];
  endTime = null;
  absoluteDeadline = null;
  pausedRemaining = null;
};

const init = async () => {
  try {
    const params = new URLSearchParams(window.location.search);
    teamId = params.get('team');
    if (!teamId) { window.location.href = 'team-dashboard.html'; return; }

    const user = await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
    });
    if (!user) { window.location.href = 'team-dashboard.html'; return; }
    currentUser = user;

    // Must exist before any teams/ read — used by security rules to verify team membership
    await ensureTeamMembership();

    // Resolve member name and role from registration
    try {
      const regSnap = await getDoc(doc(db, 'registrations', teamId));
      if (regSnap.exists()) {
        const reg = regSnap.data();
        const members = [
          { ...reg.leader, role: 'leader' },
          reg.member2 ? { ...reg.member2, role: 'member2' } : null,
          reg.member3 ? { ...reg.member3, role: 'member3' } : null
        ].filter(Boolean);
        const me = members.find(m => m.email === currentUser.email || m.uid === currentUser.uid);
        if (me) { memberName = me.name || me.email || 'Unknown'; memberRole = me.role; }
        else { memberName = currentUser.email; memberRole = 'member'; }
      }
    } catch (e) { console.warn('Failed to resolve member info:', e); memberName = currentUser.email; memberRole = 'member'; }

    examDocRef = doc(db, 'teams', teamId, 'exam', currentUser.uid);

    const teamSnap = await getDoc(doc(db, 'teams', teamId));
    const teamData = teamSnap.exists() ? teamSnap.data() : {};
    const resetAt = teamData.resetAt || 0;

    const examSnap = await getDoc(examDocRef);
    const hasExamDoc = examSnap.exists();
    const examData = hasExamDoc ? examSnap.data() : null;

    if (hasExamDoc && examData.status === 'submitted') {
      document.getElementById('verify-modal').classList.add('hidden');
      document.getElementById('exam-submitted').classList.remove('hidden');
      return;
    }

    // Check if the team was reset or if no active in-progress exam doc exists in Firestore
    let isStaleAttempt = false;
    if (!hasExamDoc || examData.status !== 'in-progress' || teamData.status === 'registered' || teamData.examStatus === 'registered') {
      isStaleAttempt = true;
    } else if (resetAt > 0 && examData.startedAt) {
      const examStartedMs = examData.startedAt.toMillis ? examData.startedAt.toMillis() : new Date(examData.startedAt).getTime();
      if (examStartedMs < resetAt) {
        isStaleAttempt = true;
      }
    }

    if (isStaleAttempt) {
      console.log('[init] Resetting local exam state (admin reset or no active in-progress exam in Firestore)');
      clearState();
    } else {
      // Valid in-progress exam in Firestore: restore saved state
      loadState();
      if (examData.absoluteDeadline) {
        absoluteDeadline = typeof examData.absoluteDeadline === 'number'
          ? examData.absoluteDeadline
          : new Date(examData.absoluteDeadline).getTime();
        endTime = absoluteDeadline;
      } else if (examData.endTime) {
        endTime = typeof examData.endTime === 'number'
          ? examData.endTime
          : new Date(examData.endTime).getTime();
        absoluteDeadline = endTime;
      }
    }

    questions = await loadRoundQuestions();

    // Server-authoritative Round 1 window.
    await loadServerWindow();
    const sNow = serverNow();
    const alreadyInProgress = !isStaleAttempt && endTime && endTime > sNow;

    // Maintain exact LaTeX question order (1..40) strictly
    questionOrder = questions.map(q => q.id);

    renderQuestions();
    updateQuestionPalette();

    document.getElementById('btn-submit').addEventListener('click', confirmSubmit);
    document.getElementById('btn-confirm-submit').addEventListener('click', submitExam);
    document.getElementById('btn-cancel-submit').addEventListener('click', () => {
      document.getElementById('submit-modal').classList.add('hidden');
    });

    const langBtn = document.getElementById('btn-lang-toggle');
    if (langBtn) {
      const updateLangBtn = () => {
        langBtn.textContent = currentLang === 'ar' ? 'عربي' : 'EN';
        langBtn.classList.toggle('active', currentLang === 'ar');
      };
      updateLangBtn();
      langBtn.addEventListener('click', () => {
        currentLang = currentLang === 'en' ? 'ar' : 'en';
        localStorage.setItem('gaac_lang', currentLang);
        updateLangBtn();
        renderQuestions();
        updateQuestionPalette();
      });
    }

    const paletteToggleBtn = document.getElementById('btn-palette-toggle');
    const paletteEl = document.getElementById('question-palette');
    const constToggleBtn = document.getElementById('btn-constants-toggle');
    const constPanel = document.getElementById('sidebar-constants');

    if (paletteToggleBtn && paletteEl) {
      paletteToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = paletteEl.classList.toggle('open');
        paletteToggleBtn.classList.toggle('active', isOpen);
        paletteToggleBtn.setAttribute('aria-expanded', String(isOpen));
        const icon = paletteToggleBtn.querySelector('.toggle-icon');
        if (icon) icon.textContent = isOpen ? '▴' : '▾';
        if (isOpen && constPanel && constPanel.classList.contains('open')) {
          constPanel.classList.remove('open');
          constToggleBtn?.classList.remove('active');
          constToggleBtn?.setAttribute('aria-expanded', 'false');
          const cIcon = constToggleBtn?.querySelector('.toggle-icon');
          if (cIcon) cIcon.textContent = '▾';
        }
      });
    }

    if (constToggleBtn && constPanel) {
      constToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = constPanel.classList.toggle('open');
        constToggleBtn.classList.toggle('active', isOpen);
        constToggleBtn.setAttribute('aria-expanded', String(isOpen));
        const icon = constToggleBtn.querySelector('.toggle-icon');
        if (icon) icon.textContent = isOpen ? '▴' : '▾';
        if (isOpen && paletteEl && paletteEl.classList.contains('open')) {
          paletteEl.classList.remove('open');
          paletteToggleBtn?.classList.remove('active');
          paletteToggleBtn?.setAttribute('aria-expanded', 'false');
          const pIcon = paletteToggleBtn?.querySelector('.toggle-icon');
          if (pIcon) pIcon.textContent = '▾';
        }
      });
    }

    // Close mobile dropdowns when tapping outside
    document.addEventListener('click', (e) => {
      if (window.innerWidth <= 768) {
        if (!e.target.closest('#btn-palette-toggle') && !e.target.closest('#question-palette') && paletteEl?.classList.contains('open')) {
          paletteEl.classList.remove('open');
          paletteToggleBtn?.classList.remove('active');
          paletteToggleBtn?.setAttribute('aria-expanded', 'false');
          const pIcon = paletteToggleBtn?.querySelector('.toggle-icon');
          if (pIcon) pIcon.textContent = '▾';
        }
        if (!e.target.closest('#btn-constants-toggle') && !e.target.closest('#sidebar-constants') && constPanel?.classList.contains('open')) {
          constPanel.classList.remove('open');
          constToggleBtn?.classList.remove('active');
          constToggleBtn?.setAttribute('aria-expanded', 'false');
          const cIcon = constToggleBtn?.querySelector('.toggle-icon');
          if (cIcon) cIcon.textContent = '▾';
        }
      }
    });

    // If there's a saved exam in progress, check the leave-gate first: a normal
    // refresh returns within the grace window and is allowed to resume; closing
    // the tab/browser keeps it away longer and locks the attempt.
    if (endTime && endTime > serverNow()) {
      let leftAt = null;
      try { leftAt = parseInt(localStorage.getItem(STORAGE_KEY() + '_leftAt') || '', 10); } catch (e) { /* ignore */ }
      if (leftAt && Number.isFinite(leftAt) && serverNow() - leftAt > R1_RESUME_GRACE_MS) {
        const isAr = currentLang === 'ar';
        showMessage(
          isAr
            ? 'تم إغلاق محاولتك لأنك غادرت صفحة الامتحان لفترة طويلة. لا يمكنك العودة. تواصل مع المشرفين إذا كان ذلك خطأ.'
            : 'Your attempt was closed because you left the exam page for too long. You cannot return. Contact the organizers if this was a mistake.'
        );
        return;
      }
      document.getElementById('verify-modal').classList.add('hidden');
      document.getElementById('exam-content').classList.remove('hidden');
      startTimer(endTime);
      startAutoSave();
      startSecurity();
      return;
    }

    // "Start Exam" shows the fixed rules first; only after accepting we begin
    // the actual verification flow (which starts the camera/screen prompts).
    document.getElementById('btn-start-exam').addEventListener('click', () => {
      document.getElementById('rules-modal').classList.remove('hidden');
    });
    document.getElementById('btn-accept-rules').addEventListener('click', () => {
      document.getElementById('rules-modal').classList.add('hidden');
      startExam();
    });

    const updateRulesLabels = (isAr) => {
      const setText = (selector, text) => {
        const el = document.querySelector(selector);
        if (el) el.textContent = text;
      };
      document.getElementById('rules-modal').dir = isAr ? 'rtl' : 'ltr';
      document.getElementById('rules-list').style.paddingLeft = isAr ? '0' : '20px';
      document.getElementById('rules-list').style.paddingRight = isAr ? '20px' : '0';
      document.getElementById('rules-title').innerHTML = isAr
        ? 'قواعد <span class="text-blue">الامتحان</span>'
        : 'Exam <span class="text-blue">Rules</span>';
      setText('#rules-intro', isAr
        ? 'يرجى قراءة القواعد التالية بعناية قبل البدء. تُسجَّل كل مخالفة وقد تؤدي إلى الاستبعاد.'
        : 'Please read the following rules carefully before starting. Violations are recorded and may lead to disqualification.');
      const items = {
        tab: isAr ? 'غير مسموح بتبديل التبويبات أو فتح نوافذ أخرى أثناء الامتحان.' : 'No switching tabs or opening other windows during the exam.',
        fullscreen: isAr ? 'لا تخرج من وضع ملء الشاشة. يجب أن تبقى في ملء الشاشة طوال الامتحان.' : 'Do not exit fullscreen mode. You must stay in fullscreen for the whole exam.',
        camera: isAr ? 'لا توقف أو تغطِّ أو تحرّك الكاميرا.' : 'Do not disable, cover, or move the camera.',
        screenshare: isAr ? 'لا توقف مشاركة الشاشة أو تُخفِها على الأجهزة المكتبية.' : 'Do not stop or hide the screen share on desktop.',
        face: isAr ? 'يجب أن يظل وجهك ظاهرًا للكاميرا طوال الوقت أثناء الحل.' : 'Your face must remain visible in the camera at all times while solving.',
        warn: isAr ? 'أي مما سبق قد يوقف الامتحان مؤقتًا ويُسجَّل كمخالفة.' : 'Any of the above may pause the exam and is recorded as a violation.',
        paper: isAr ? 'ممنوع وجود كشكول معادلات أو ملاحظات أو مراجع على المكتب. وجود أي منها يُعتبر غشًا.' : 'No formula sheets, notes, or reference material on your desk. Being found with any is considered cheating.',
        translate: isAr ? 'الترجمة التلقائية للصفحة معطّلة. للتبديل إلى العربية استخدم الزر أعلى يمين الصفحة في شريط الامتحان.' : 'Automatic page translation is disabled. To switch to Arabic, use the button at the top-right of the exam.'
      };
      document.querySelectorAll('#rules-list li').forEach(li => {
        const key = li.dataset.i18n;
        if (key && items[key]) li.textContent = items[key];
      });
      document.getElementById('btn-accept-rules').textContent = isAr ? 'فهمت، أكمل' : 'I Understand, Continue';
    };
    updateRulesLabels(currentLang === 'ar');

const updateVerifyLabels = () => {
      const isAr = currentLang === 'ar';
      const setText = (selector, text) => {
        const el = document.querySelector(selector);
        if (el) el.textContent = text;
      };
      updateRulesLabels(isAr);
      document.getElementById('verify-modal').dir = isAr ? 'rtl' : 'ltr';
      document.getElementById('btn-verify-lang').textContent = isAr ? 'EN' : 'AR';
      document.getElementById('verify-instructions').textContent = isAr ? 'فعّل المتطلبات بالترتيب. وضع ملء الشاشة يكون في النهاية.' : 'Enable each requirement in order. Fullscreen comes last.';
      document.querySelector('#verify-modal h2').innerHTML = isAr ? 'متطلبات <span class="text-blue">الامتحان</span>' : 'Exam <span class="text-blue">Requirements</span>';
      document.getElementById('btn-start-exam').textContent = isAr ? 'ابدأ الامتحان' : 'Start Exam';
      setText('#v-camera .verify-label', isAr ? 'الوصول إلى الكاميرا' : 'Camera Access');
      setText('#v-camera .verify-note', isAr ? 'اسمح باستخدام الكاميرا للتحقق من الهوية.' : 'Allow your webcam for identity checks.');
      setText('#v-screenshare .verify-label', isAr ? 'مشاركة الشاشة' : 'Screen Sharing');
      setText('#v-screenshare .verify-note', isAr ? 'شارك الشاشة بالكامل للمراقبة.' : 'Share your full screen for monitoring.');
      setText('#v-fullscreen .verify-label', isAr ? 'وضع ملء الشاشة' : 'Fullscreen Mode');
      setText('#v-fullscreen .verify-note', isAr ? 'ادخل وضع ملء الشاشة بعد الكاميرا ومشاركة الشاشة.' : 'Enter fullscreen after camera and screen share.');
    };
    updateVerifyLabels();
    document.getElementById('btn-verify-lang').addEventListener('click', () => {
      currentLang = currentLang === 'en' ? 'ar' : 'en';
      localStorage.setItem('gaac_lang', currentLang);
      updateVerifyLabels();
      const langBtn = document.getElementById('btn-lang-toggle');
      if (langBtn) {
        langBtn.textContent = currentLang === 'ar' ? 'عربي' : 'EN';
        langBtn.classList.toggle('active', currentLang === 'ar');
      }
    });
  } catch (e) {
    console.error('Exam init failed:', e);
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:#ff6b6b;font-size:1.2rem;text-align:center;padding:40px;flex-direction:column;gap:12px;">
      <div style="font-weight:700;">Failed to load exam</div>
      <div style="font-size:0.85rem;color:var(--muted);">${e.message || e}</div>
    </div>`;
  }
};

const setIcon = (id, ok) => {
  const el = document.getElementById(id);
  if (el) el.style.background = ok ? '#22c55e' : '#ef4444';
};

const startExam = async () => {
  console.log('[startExam] clicked');
  const errEl = document.getElementById('verify-error');
  errEl.style.display = 'none';
  document.getElementById('btn-start-exam').disabled = true;

  let fullscreenOk = false, cameraOk = false, screenOk = false;
  const cleanupFailedRequirements = () => {
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    cameraActive = false;
    screenActive = false;
    fullscreenActive = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  try {
    console.log('[startExam] requesting camera...');
    camStream = await withPermissionPrompt(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } }));
    cameraOk = true;
    setIcon('v-cam-icon', true);
    console.log('[startExam] camera OK');
  } catch (e) { console.warn('[startExam] camera FAILED:', e); setIcon('v-cam-icon', false); }

  if (cameraOk) {
    if (SCREEN_REQUIRED) {
      try {
        console.log('[startExam] requesting screen share...');
        screenStream = await withPermissionPrompt(() => navigator.mediaDevices.getDisplayMedia({ video: true }));
        screenOk = true;
        setIcon('v-ss-icon', true);
        console.log('[startExam] screen share OK');
      } catch (e) { console.warn('[startExam] screen share FAILED:', e); setIcon('v-ss-icon', false); }
    } else {
      screenOk = true;
      setIcon('v-ss-icon', true);
      console.log('[startExam] screen share skipped on mobile/touch device');
    }
  } else {
    setIcon('v-ss-icon', false);
  }

  if (SCREEN_REQUIRED && !screenOk) {
    setIcon('v-ss-icon', false);
  }
  if (cameraOk && screenOk) {
    if (!FULLSCREEN_REQUIRED) {
      if (SHOULD_TRY_FULLSCREEN) {
        try {
          console.log('[startExam] requesting fullscreen on mobile (best effort)...');
          await document.documentElement.requestFullscreen();
          if (document.fullscreenElement) fullscreenEnforced = true;
        } catch (e) {
          fullscreenEnforced = false;
          console.warn('[startExam] mobile fullscreen best-effort failed:', e);
        }
      }
      fullscreenOk = true;
      setIcon('v-fs-icon', true);
      console.log('[startExam] fullscreen not blocking on mobile/unsupported browser');
    } else {
      try {
        console.log('[startExam] requesting fullscreen (user gesture)...');
        await document.documentElement.requestFullscreen();
        fullscreenEnforced = true;
        fullscreenOk = true;
        setIcon('v-fs-icon', true);
        console.log('[startExam] fullscreen OK');
      } catch (e) { console.warn('[startExam] fullscreen FAILED:', e); setIcon('v-fs-icon', false); }
    }
  } else {
    setIcon('v-fs-icon', false);
  }

  if ((FULLSCREEN_REQUIRED && !fullscreenOk) || !cameraOk || !screenOk) {
    console.log('[startExam] requirements NOT met: fullscreen=', fullscreenOk, 'camera=', cameraOk, 'screen=', screenOk);
    const isAr = currentLang === 'ar';
    errEl.textContent = isAr ? 'يرجى تفعيل جميع المتطلبات أعلاه لبدء الامتحان.' : 'Please enable all requirements above to start the exam.';
    errEl.style.display = 'block';
    cleanupFailedRequirements();
    document.getElementById('btn-start-exam').disabled = false;
    return;
  }

  console.log('[startExam] ALL requirements met, starting exam...');
  document.getElementById('verify-modal').classList.add('hidden');
  document.getElementById('exam-content').classList.remove('hidden');
  renderQuestions();
  updateQuestionPalette();

  const durationMs = 60 * 60 * 1000;
  // Use the server-calibrated clock so all candidates get exactly 60 minutes
  // and end at the same real-world instant regardless of their device clock.
  endTime = serverNow() + durationMs;
  absoluteDeadline = endTime;

  // Write status + endTime + absoluteDeadline to Firestore (server-authoritative timer)
  try {
      await setDoc(examDocRef, {
        status: 'in-progress',
        memberUid: currentUser.uid,
        memberEmail: currentUser.email,
        memberRole,
        startedAt: serverTimestamp(),
        endTime: new Date(endTime).toISOString(),
        absoluteDeadline: absoluteDeadline,
        deviceInfo: getDeviceInfo()
      }, { merge: true });
      // Mirror summary on the team parent doc so the admin dashboard can
      // render status with 2 queries instead of one read per team.
      await setDoc(doc(db, 'teams', teamId), {
        status: 'in-progress',
        startedAt: serverTimestamp()
      }, { merge: true });
      console.log('[startExam] status=in-progress written, endTime=', new Date(endTime).toISOString());
  } catch (e) {
    console.warn('Failed to write in-progress status:', e);
  }

  saveState();
  try { localStorage.removeItem(STORAGE_KEY() + '_leftAt'); } catch (e) {}
  try { localStorage.removeItem(AUTO_SNAPSHOT_KEY()); } catch (e) {}
  try { localStorage.removeItem(AUTO_SNAPSHOT_START_KEY()); } catch (e) {}

  startTimer(endTime);
  startAutoSave();
  startSecurity();
};

const ensureTeamMembership = async () => {
  try {
    const ref = doc(db, 'teamMembers', currentUser.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { teamId, email: currentUser.email });
    }
  } catch (e) {
    console.warn('Failed to create team membership doc:', e);
  }
};

const loadRoundQuestions = async () => {
  // Preferred: server function with in-memory cache (questions static for the
  // round → read once, reused for all students; answers never sent to client).
  try {
    const getQuestions = httpsCallable(getFunctions(), 'getRound1Questions');
    const res = await getQuestions();
    const qs = (res.data && res.data.questions) || [];
    if (Array.isArray(qs) && qs.length > 0) {
      return qs
        .map((q, i) => ({
          id: q.id || `q${i + 1}`,
          text: q.text,
          text_ar: q.text_ar || q.text,
          options: q.options,
          options_ar: q.options_ar || q.options
        }))
        .filter(q => q.text && Array.isArray(q.options));
    }
  } catch (e) {
    console.warn('[round1] Question function unavailable, falling back:', e.message || e);
  }

  // Fallback: static file for local/dev preview (dummy questions, no keys).
  try {
    const res = await fetch('./js/r1_dummy_questions.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        return data
          .map((q, i) => ({
            id: q.id || `q${i + 1}`,
            text: q.text,
            text_ar: q.text_ar || q.text,
            options: q.options,
            options_ar: q.options_ar || q.options
          }))
          .filter(q => q.text && Array.isArray(q.options));
      }
    }
  } catch (e) {
    console.warn('Static question file unavailable, falling back to Firestore:', e);
  }

  const qSnap = await getDocs(query(collection(db, 'round1', 'round1', 'questions'), orderByFirestore('order')));
  const fallbackQuestions = [];
  qSnap.forEach(doc => {
    const q = doc.data();
    fallbackQuestions.push({ id: doc.id, text: q.text, text_ar: q.text_ar || q.text, options: q.options, options_ar: q.options_ar || q.options });
  });
  return fallbackQuestions;
};
const _lastSnapshot = {};

let _lastSnapshotAt = 0;

const MAX_SNAPSHOTS = 50;

let _snapshotCount = 0;
const CAMERA_SNAPSHOT_TYPES = new Set([
  'no-face-20s',
  'multiple-faces',
  'camera-covered',
  'camera-disabled',
  'camera-stopped',
  'camera-init-failed',
  'camera-denied'
]);
const captureSnapshot = async (msg, eventType = msg) => {
  const now = Date.now();
  const snapshotKey = eventType || msg;
  if (_snapshotCount >= MAX_SNAPSHOTS) return;
  if (now - _lastSnapshotAt < 2000) return;
  if (_lastSnapshot[snapshotKey] && now - _lastSnapshot[snapshotKey] < EVENT_SNAPSHOT_COOLDOWN_MS) return;
  _lastSnapshotAt = now;
  _lastSnapshot[snapshotKey] = now;
  const safeName = (memberName || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
  const safeRole = (memberRole || 'member').replace(/[^a-zA-Z0-9]/g, '_');
  const safeViolation = String(snapshotKey).replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 40);
  const folderName = `${safeName}_${safeRole}`;
  const pathBase = `snapshots/round1/${teamId}/${folderName}/${safeViolation}_${Date.now()}`;

  try {
    const shouldUseCamera = CAMERA_SNAPSHOT_TYPES.has(eventType) || /face|camera/i.test(String(msg));
    let canvas = null;
    if (_aiMonitor && shouldUseCamera) canvas = _aiMonitor.captureWebcamFrame();
    if (_aiMonitor && !canvas) canvas = _aiMonitor.captureScreenFrame();
    if (!canvas) {
      console.warn('[captureSnapshot] No frame for', msg);
      return;
    }
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
    if (blob) {
      await uploadBytes(ref(storage, `${pathBase}.jpg`), blob);
      _snapshotCount++;
      console.log('[captureSnapshot] Uploaded:', msg, `(${_snapshotCount}/${MAX_SNAPSHOTS})`);
    }
  } catch (e) {
    console.warn('[captureSnapshot] Failed:', e);
  }
};


const hashString = (value) => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return Math.abs(h);
};

const uploadCanvasSnapshot = async (canvas, pathBase, label) => {
  if (!canvas || _snapshotCount >= MAX_SNAPSHOTS) return false;
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.78));
  if (!blob || _snapshotCount >= MAX_SNAPSHOTS) return false;
  await uploadBytes(ref(storage, `${pathBase}.jpg`), blob);
  _snapshotCount++;
  console.log('[snapshot] Uploaded:', label, `(${_snapshotCount}/${MAX_SNAPSHOTS})`);
  return true;
};

// Auto snapshots use their own separate counter and cap, independent from
// event snapshots, so periodic captures never crowd out violation captures.
let _autoSnapshotCount = 0;
const uploadAutoSnapshot = async (canvas, pathBase, label) => {
  if (!canvas || _autoSnapshotCount >= AUTO_SNAPSHOT_MAX) return false;
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.78));
  if (!blob || _autoSnapshotCount >= AUTO_SNAPSHOT_MAX) return false;
  await uploadBytes(ref(storage, `${pathBase}.jpg`), blob);
  _autoSnapshotCount++;
  console.log('[autoSnapshot] Uploaded:', label, `(${_autoSnapshotCount}/${AUTO_SNAPSHOT_MAX})`);
  return true;
};

const captureAutoSnapshot = async (index) => {
  if (examSubmitted || !_aiMonitor || _autoSnapshotCount >= AUTO_SNAPSHOT_MAX) return;
  try {
    // Full screen when screen sharing is active (desktop), otherwise the
    // camera (mobile / any device without screen sharing). Same pacing, same jitter.
    let canvas = null;
    const hasScreenTrack = screenStream && screenStream.getVideoTracks().length > 0;
    if (hasScreenTrack) canvas = _aiMonitor.captureScreenFrame();
    if (!canvas) canvas = _aiMonitor.captureWebcamFrame();
    if (!canvas) {
      console.warn('[autoSnapshot] No frame available for auto', index);
      return;
    }
    const safeName = (memberName || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const safeRole = (memberRole || 'member').replace(/[^a-zA-Z0-9]/g, '_');
    const folderName = `${safeName}_${safeRole}`;
    const autoName = `auto_${String(index).padStart(2, '0')}`;
    // Auto snapshots live in their own /auto/ subfolder, separate from event snapshots.
    const pathBase = `snapshots/round1/${teamId}/${folderName}/auto/${autoName}_${Date.now()}`;
    const uploaded = await uploadAutoSnapshot(canvas, pathBase, autoName);
    if (uploaded) localStorage.setItem(AUTO_SNAPSHOT_KEY(), String(index));
  } catch (e) {
    console.warn('[autoSnapshot] Failed:', e);
  }
};

const stopAutoSnapshots = () => {
  autoSnapshotTimers.forEach(t => clearTimeout(t));
  autoSnapshotTimers = [];
};

const startAutoSnapshots = () => {
  stopAutoSnapshots();
  if (!_aiMonitor || !camStream) return;
  let startAt = Number(localStorage.getItem(AUTO_SNAPSHOT_START_KEY()) || 0);
  if (!startAt || !Number.isFinite(startAt)) {
    startAt = Date.now();
    localStorage.setItem(AUTO_SNAPSHOT_START_KEY(), String(startAt));
  }
  const seed = `${teamId}:${currentUser?.uid || 'anon'}`;
  const spreadMs = hashString(seed) % AUTO_SNAPSHOT_SPREAD_MS;
  const captured = Number(localStorage.getItem(AUTO_SNAPSHOT_KEY()) || 0);
  const fallbackEnd = startAt + (60 * 60 * 1000);
  const plannedEnd = Math.max(startAt + AUTO_SNAPSHOT_FIRST_DELAY_MS, absoluteDeadline || fallbackEnd);
  const plannedTotal = Math.min(
    AUTO_SNAPSHOT_MAX,
    Math.max(0, Math.floor((plannedEnd - startAt - AUTO_SNAPSHOT_FIRST_DELAY_MS) / AUTO_SNAPSHOT_INTERVAL_MS) + 1)
  );
  for (let i = captured + 1; i <= plannedTotal; i++) {
    const wobbleMs = i === 1 ? 0 : (hashString(`${seed}:${i}`) % (AUTO_SNAPSHOT_JITTER_MS * 2)) - AUTO_SNAPSHOT_JITTER_MS;
    const targetAt = startAt + AUTO_SNAPSHOT_FIRST_DELAY_MS + spreadMs + ((i - 1) * AUTO_SNAPSHOT_INTERVAL_MS) + wobbleMs;
    const delayMs = Math.max(10000, targetAt - Date.now());
    autoSnapshotTimers.push(setTimeout(() => captureAutoSnapshot(i), delayMs));
  }
};
const showToast = (msg, severity = 'warning') => {
  const toast = document.getElementById('exam-toast');
  const msgEl = document.getElementById('toast-msg');
  if (!toast || !msgEl) return;
  msgEl.textContent = msg;
  toast.style.borderColor = severity === 'severe' ? 'rgba(255,107,107,0.5)' : 'rgba(255,183,77,0.4)';
  toast.style.color = severity === 'severe' ? '#ff6b6b' : '#ffb74d';
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 5000);
};

const startSecurity = () => {
  const handleSecurityNotice = (msg, severity, eventType = msg) => {
    showToast(msg, severity);
    if (severity === 'severe') captureSnapshot(msg, eventType);
    if (eventType === 'tab-hidden' || msg.includes('switched away')) pauseExam('tab-hidden');
    else if (eventType === 'window-blur' || msg.includes('lost focus')) return;
  };

  _security = new SecurityWrapper(teamId, currentUser.uid, db, handleSecurityNotice, {
    'fullscreen-exit': 15,
    'tab-hidden': 15,
    'window-blur': 15,
    'camera-stopped': 15,
    'screenshare-stopped': 15
  }, { requireFullscreen: fullscreenEnforced, ignoreEventsUntil: { 'window-blur': Date.now() + 60000, 'screen-change': Date.now() + 105000 } });
  _security.start();

_aiMonitor = new AIMonitor(_security, camStream, handleSecurityNotice);
  _aiMonitor.start();
  if (screenStream) _aiMonitor.setScreenStream(screenStream);

  // Periodic auto snapshots at ~30s with jitter. Uses the FULL SCREEN when
  // screen sharing is active (desktop), otherwise the camera (mobile/tablet or
  // any device without screen sharing). Only starts when a camera stream exists.
  startAutoSnapshots();

  if (camStream) cameraActive = true;
  if (screenStream) screenActive = true;
  screenActive = !SCREEN_REQUIRED || !!screenStream;
  fullscreenActive = !fullscreenEnforced || !!document.fullscreenElement;
  _monitorTracks();

  // On page reload / saved-state restore, if streams are gone, pause immediately
  const missing = checkRequirements();
  if (missing) {
    const isAr = currentLang === 'ar';
    const names = isAr ? { fullscreen: 'ملء الشاشة', camera: 'الكاميرا', screenshare: 'مشاركة الشاشة' } : { fullscreen: 'Fullscreen', camera: 'Camera', screenshare: 'Screen sharing' };
    showToast(`${names[missing] || missing}${isAr ? ' مطلوب. تم إيقاف الامتحان مؤقتًا.' : ' required. Exam paused.'}`, 'warning');
    pauseExam(missing);
  }

  // Poll track health every 3s — only pauses, does NOT log (onended handles logging)
  healthInterval = setInterval(() => {
    if (examSubmitted) return;
    // Absolute deadline check — even if paused/offline, time runs out
    if (absoluteDeadline && Date.now() >= absoluteDeadline && !examSubmitted) {
      console.log('[healthInterval] Absolute deadline reached, auto-submitting');
      submitExam();
      return;
    }
    if (examPaused) return;
    const camTrack = camStream?.getVideoTracks()[0];
    const ssTrack = screenStream?.getVideoTracks()[0];
    if (camStream && camTrack?.readyState !== 'live') {
      cameraActive = false;
      showToast('Camera disconnected. Exam paused.', 'severe');
      pauseExam('camera');
    }
    if (screenStream && ssTrack?.readyState !== 'live') {
      screenActive = false;
      showToast('Screen sharing stopped. Exam paused.', 'severe');
      pauseExam('screenshare');
    }
  }, 3000);

  // Auto-resume detection for transition events
  document.addEventListener('fullscreenchange', () => {
    if (examSubmitted || !fullscreenEnforced) return;
    fullscreenActive = !!document.fullscreenElement;
    if (!document.fullscreenElement && !examPaused) {
      pauseExam('fullscreen');
    } else if (document.fullscreenElement && examPaused) {
      autoResume();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (examSubmitted) return;
    if (!document.hidden && examPaused) autoResume();
  });
  window.addEventListener('focus', () => {
    if (examSubmitted) return;
    if (examPaused) autoResume();
  });

  window.addEventListener('offline', () => {
    if (examSubmitted) return;
    const content = document.getElementById('exam-content');
    if (content) content.style.filter = 'blur(15px)';
    showToast('Internet connection lost. Exam paused.', 'severe');
    pauseExam('offline');
    const btn = document.getElementById('btn-reenable');
    if (btn) btn.style.display = 'none';
  });
  
  window.addEventListener('online', () => {
    if (examSubmitted) return;
    const content = document.getElementById('exam-content');
    if (content) content.style.filter = 'none';
    const btn = document.getElementById('btn-reenable');
    if (btn) btn.style.display = 'block';
    autoResume();
  });

  window.addEventListener('beforeprint', () => {
    if (_security) _security.logEvent('print-attempt', 'warning');
  });

  // STRICT-ish Round 1 leave handling. pagehide fires on refresh AND close,
  // which the browser cannot distinguish. So we stamp the moment left and let a
  // short re-entry window (a normal refresh) resume, but block returning after
  // a longer absence (tab/browser closed).
  window.addEventListener('pagehide', () => {
    if (examSubmitted) return;
    try {
      localStorage.setItem(STORAGE_KEY() + '_leftAt', String(Date.now() + r1ServerOffset));
    } catch (e) { /* ignore */ }
    // Optimistically stamp server-side too, in case the page never returns.
    setDoc(examDocRef, { leftAt: serverTimestamp() }, { merge: true }).catch(() => {});
  });

  if (typeof renderMathInElement === 'function') {
    try {
      renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true }
        ],
        throwOnError: false
      });
    } catch (e) {
      console.warn('KaTeX render error:', e);
    }
  }
};

const _monitorTracks = () => {
  if (camStream) {
    const t = camStream.getVideoTracks()[0];
    if (t) {
      t.onended = () => {
        if (examSubmitted) return;
        cameraActive = false;
        if (_security && _security.logEvent('camera-stopped', 'severe')) captureSnapshot('camera-stopped', 'camera-stopped');
        showToast('Camera disconnected. Exam paused.', 'severe');
        pauseExam('camera');
      };
    }
  }
  if (screenStream) {
    const t = screenStream.getVideoTracks()[0];
    if (t) {
      t.onended = () => {
        if (examSubmitted) return;
        screenActive = false;
        if (_security && _security.logEvent('screenshare-stopped', 'severe')) captureSnapshot('screenshare-stopped', 'screenshare-stopped');
        showToast('Screen sharing stopped. Exam paused.', 'severe');
        pauseExam('screenshare');
      };
    }
  }
};

const pauseExam = (reason) => {
  if (examSubmitted) return;
  if (examPaused) return;
  examPaused = true;
  if (timerInterval) clearInterval(timerInterval);
  pausedRemaining = absoluteDeadline - Date.now();
  setDoc(examDocRef, { pausedRemaining }, { merge: true }).catch(() => {});
  showDisconnectModal(reason);
};

const resumeExam = () => {
  if (examSubmitted) return;
  if (!examPaused) return;
  if (!cameraActive || (SCREEN_REQUIRED && !screenActive) || (fullscreenEnforced && !fullscreenActive)) return;
  examPaused = false;
  document.getElementById('disconnect-modal').classList.add('hidden');
  // Use absoluteDeadline — NEVER recalculate from now
  endTime = absoluteDeadline;
  pausedRemaining = null;
  saveState();
  setDoc(examDocRef, { pausedRemaining: null }, { merge: true }).catch(() => {});
  // Check if deadline already passed while paused
  if (Date.now() >= absoluteDeadline) {
    submitExam();
    return;
  }
  startTimer(endTime);
};

const showDisconnectModal = (reason, countdownSecs = 15) => {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

  const labels = currentLang === 'ar' ? {
    fullscreen: { label: 'وضع ملء الشاشة', title: 'فقدان ملء الشاشة', msg: 'لقد غادرت وضع ملء الشاشة.', btn: 'العودة لملء الشاشة', autoLabel: 'عد لملء الشاشة خلال {s}s للمتابعة تلقائيًا.' },
    'tab-hidden': { label: 'تبويب الامتحان', title: 'تم التبديل', msg: 'لقد انتقلت بعيدًا عن تبويب الامتحان.', btn: 'المتابعة', autoLabel: 'عد لتبويب الامتحان خلال {s}s للمتابعة تلقائيًا.' },
    'window-blur': { label: 'نافذة الامتحان', title: 'فقدان التركيز', msg: 'فقدت نافذة الامتحان التركيز.', btn: 'المتابعة', autoLabel: 'عد لنافذة الامتحان خلال {s}s للمتابعة تقائيًا.' },
    camera: { label: 'الكاميرا', title: 'فقدان الكاميرا', msg: 'تم فصل الكاميرا.', btn: 'إعادة تنشيط الكاميرا', autoLabel: 'أعد تنشيط الكاميرا خلال {s}s.' },
    screenshare: { label: 'مشاركة الشاشة', title: 'فقدان مشاركة الشاشة', msg: 'تم إيقاف مشاركة الشاشة.', btn: 'إعادة تنشيط مشاركة الشاشة', autoLabel: 'أعد تنشيط مشاركة الشاشة خلال {s}s.' },
    offline: { label: 'الإنترنت', title: 'فقدان الاتصال', msg: 'انقطع اتصالك بالإنترنت.', btn: 'في الانتظار...', autoLabel: 'يرجى إعادة الاتصال بالإنترنت. متوقف مؤقتًا لمدة {s}s.' }
  } : {
    fullscreen: { label: 'Fullscreen Mode', title: 'Fullscreen Lost', msg: 'You exited fullscreen mode.', btn: 'Re-enter Fullscreen', autoLabel: 'Return to fullscreen within {s}s to auto-resume.' },
    'tab-hidden': { label: 'Exam Tab', title: 'Tab Switched', msg: 'You switched away from the exam tab.', btn: 'Resume', autoLabel: 'Return to the exam tab within {s}s to auto-resume.' },
    'window-blur': { label: 'Exam Window', title: 'Focus Lost', msg: 'Exam window lost focus.', btn: 'Resume', autoLabel: 'Return to the exam window within {s}s to auto-resume.' },
    camera: { label: 'Camera', title: 'Camera Lost', msg: 'Camera was disconnected.', btn: 'Re-enable Camera', autoLabel: 'Re-enable camera within {s}s.' },
    screenshare: { label: 'Screen Sharing', title: 'Screen Sharing Lost', msg: 'Screen sharing was stopped.', btn: 'Re-enable Screen Sharing', autoLabel: 'Re-enable screen sharing within {s}s.' },
    offline: { label: 'Internet', title: 'Connection Lost', msg: 'Your internet connection dropped.', btn: 'Waiting...', autoLabel: 'Please reconnect to the internet. Paused for {s}s.' }
  };
  const info = labels[reason] || labels.fullscreen;
  document.getElementById('d-icon').style.background = '#ef4444';
  document.getElementById('d-label').textContent = info.label;
  document.getElementById('disconnect-title').textContent = info.title;
  document.getElementById('disconnect-msg').textContent = info.msg;
  document.getElementById('btn-reenable').textContent = info.btn;
  document.getElementById('btn-reenable').onclick = () => reenable(reason);
  document.getElementById('disconnect-modal').classList.remove('hidden');

  // Countdown
  let remaining = countdownSecs;
  const msgEl = document.getElementById('disconnect-msg');
  msgEl.textContent = info.autoLabel.replace('{s}', remaining);
  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      countdownInterval = null;
      msgEl.textContent = `${info.msg} Click "${info.btn}" to continue.`;
    } else {
      msgEl.textContent = info.autoLabel.replace('{s}', remaining);
    }
  }, 1000);
};

const checkRequirements = () => {
  if (!camStream) return 'camera';
  if (SCREEN_REQUIRED && !screenStream) return 'screenshare';
  if (fullscreenEnforced && !document.fullscreenElement) return 'fullscreen';
  return null;
};

const autoResume = () => {
  if (examSubmitted) return;
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  const missing = checkRequirements();
  if (!missing && examPaused) {
    examPaused = false;
    document.getElementById('disconnect-modal').classList.add('hidden');
    // Use absoluteDeadline — NEVER recalculate from now
    endTime = absoluteDeadline;
    pausedRemaining = null;
    saveState();
    setDoc(examDocRef, { pausedRemaining: null }, { merge: true }).catch(() => {});
    // Check if deadline already passed while paused
    if (Date.now() >= absoluteDeadline) {
      submitExam();
      return;
    }
    startTimer(endTime);
  }
};

const reenable = async (reason) => {
  if (examSubmitted) return;
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  document.getElementById('disconnect-error').style.display = 'none';
  document.getElementById('disconnect-modal').classList.add('hidden');

  if (reason === 'camera') {
    try {
      const newStream = await withPermissionPrompt(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } }));
      const newTrack = newStream.getVideoTracks()[0];
      if (camStream) camStream.getTracks().forEach(t => t.stop());
      camStream = newStream;
      cameraActive = true;
      newTrack.onended = () => {
        cameraActive = false;
        if (_security) _security.logEvent('camera-stopped', 'severe');
        showToast('Camera disconnected. Exam paused.', 'severe');
        pauseExam('camera');
      };
      if (_security) _security.setInactive('camera-stopped');
      if (_aiMonitor && _aiMonitor.setStream) _aiMonitor.setStream(camStream);
    } catch (e) {
      console.warn('Camera re-enable failed:', e);
    }
  } else if (reason === 'screenshare') {
    try {
      const newStream = await withPermissionPrompt(() => navigator.mediaDevices.getDisplayMedia({ video: true }));
      const newTrack = newStream.getVideoTracks()[0];
      if (screenStream) screenStream.getTracks().forEach(t => t.stop());
      screenStream = newStream;
      screenActive = true;
      newTrack.onended = () => {
        screenActive = false;
        if (_security) _security.logEvent('screenshare-stopped', 'severe');
        showToast('Screen sharing stopped. Exam paused.', 'severe');
        pauseExam('screenshare');
      };
      if (_security) _security.setInactive('screenshare-stopped');
      if (_aiMonitor && _aiMonitor.setScreenStream) _aiMonitor.setScreenStream(screenStream);
    } catch (e) {
      console.warn('Screenshare re-enable failed:', e);
    }
  } else if (reason === 'fullscreen') {
    try { await document.documentElement.requestFullscreen(); } catch (e) { console.warn('Fullscreen re-entry failed:', e); }
  }

  // After re-acquisition, check if all requirements are now met
  const missing = checkRequirements();
  if (missing) {
    showDisconnectModal(missing);
  } else {
    autoResume();
  }
};

const escHtml = (s) => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };

const renderQuestions = () => {
  const container = document.getElementById('questions-container');
  const palette = document.getElementById('question-palette');
  container.innerHTML = '';
  palette.innerHTML = '';

  const isAr = currentLang === 'ar';

  questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.id = `q-${idx}`;
    if (isAr) card.style.direction = 'rtl';
    const qText = isAr ? (q.text_ar || q.text) : q.text;
    const qOpts = isAr ? (q.options_ar || q.options) : q.options;
    card.innerHTML = `
      <div class="q-header">
        <span class="q-number">${isAr ? 'سؤال' : 'Question'} ${idx + 1}</span>
        <button class="q-flag-btn ${flagged[idx] ? 'flagged' : ''}" data-idx="${idx}" title="${isAr ? 'تحديد للمراجعة' : 'Flag for review'}">&#9873;</button>
      </div>
      <p class="q-text">${escHtml(qText)}</p>
      <div class="q-options">
        ${['A', 'B', 'C', 'D'].map((letter, oi) => `
          <label class="q-option ${answers[idx] === letter ? 'selected' : ''}">
            <input type="radio" name="q-${idx}" value="${letter}"
              ${answers[idx] === letter ? 'checked' : ''}
              data-idx="${idx}">
            <span class="opt-letter">${letter}</span>
            <span class="opt-text">${escHtml(qOpts[oi])}</span>
          </label>
        `).join('')}
      </div>
    `;
    container.appendChild(card);

    const dot = document.createElement('button');
    dot.className = `palette-dot ${answers[idx] ? 'answered' : ''} ${flagged[idx] ? 'flagged' : ''}`;
    dot.textContent = idx + 1;
    dot.dataset.idx = idx;
    dot.addEventListener('click', () => {
      document.getElementById(`q-${idx}`).scrollIntoView({ behavior: 'smooth' });
      if (window.innerWidth <= 768) {
        const pEl = document.getElementById('question-palette');
        const pBtn = document.getElementById('btn-palette-toggle');
        if (pEl && pEl.classList.contains('open')) {
          pEl.classList.remove('open');
          pBtn?.classList.remove('active');
          pBtn?.setAttribute('aria-expanded', 'false');
          const pIcon = pBtn?.querySelector('.toggle-icon');
          if (pIcon) pIcon.textContent = '▾';
        }
      }
    });
    palette.appendChild(dot);

    card.querySelectorAll('input[type="radio"]').forEach(input => {
      input.addEventListener('change', (e) => {
        const i = parseInt(e.target.dataset.idx);
        answers[i] = e.target.value;
        card.querySelectorAll('.q-option').forEach(o => o.classList.remove('selected'));
        e.target.closest('.q-option').classList.add('selected');
        saveState();
        updateQuestionPalette();
      });
    });

    card.querySelector('.q-flag-btn').addEventListener('click', (e) => {
      const i = parseInt(e.target.dataset.idx);
      flagged[i] = !flagged[i];
      e.target.classList.toggle('flagged');
      saveState();
      updateQuestionPalette();
    });
  });

  // Render LaTeX math formulas in question texts and option labels
  if (typeof renderMathInElement === 'function') {
    try {
      renderMathInElement(container, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
          { left: '\\[', right: '\\]', display: true }
        ],
        throwOnError: false
      });
    } catch (e) {
      console.warn('KaTeX auto-render failed:', e);
    }
  }
};

const updateQuestionPalette = () => {
  const dots = document.querySelectorAll('.palette-dot');
  dots.forEach((dot, idx) => {
    dot.className = 'palette-dot';
    if (answers[idx]) dot.classList.add('answered');
    if (flagged[idx]) dot.classList.add('flagged');
  });
  const answered = Object.keys(answers).length;
  const totalEl = document.getElementById('total-count');
  const ansEl = document.getElementById('answered-count');
  if (ansEl) ansEl.textContent = answered;
  if (totalEl) totalEl.textContent = questions.length;
};

const startTimer = (end) => {
  if (timerInterval) clearInterval(timerInterval);
  const timerDisplay = document.getElementById('timer-display');
  const update = () => {
    const sNow = serverNow();
    const remaining = Math.max(0, end - sNow);
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    if (timerDisplay) {
      timerDisplay.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      if (remaining <= 5 * 60 * 1000) {
        timerDisplay.classList.add('warning');
      } else {
        timerDisplay.classList.remove('warning');
      }
    }
    if (remaining <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      submitExam();
    }
  };
  update();
  timerInterval = setInterval(update, 1000);
};

const startAutoSave = () => {
  autoSaveInterval = setInterval(() => saveState(), 10000);
};

const confirmSubmit = () => {
  const unanswered = questions.length - Object.keys(answers).length;
  const isAr = currentLang === 'ar';
  document.getElementById('unanswered-warning').textContent =
    unanswered > 0 ? (isAr ? `${unanswered} سؤال${unanswered > 1 ? 'ات' : ''} لم يتم الإجابة عليه.` : `${unanswered} question${unanswered > 1 ? 's' : ''} unanswered.`) : '';
  const modal = document.getElementById('submit-modal');
  modal.querySelector('h2').textContent = isAr ? 'تقديم الامتحان؟' : 'Submit Exam?';
  modal.querySelector('p').textContent = isAr ? 'بمجرد التقديم، لا يمكنك تغيير إجاباتك.' : 'Once submitted, you cannot change your answers.';
  modal.querySelector('#btn-cancel-submit').textContent = isAr ? 'إلغاء' : 'Cancel';
  modal.querySelector('#btn-confirm-submit').textContent = isAr ? 'تأكيد التقديم' : 'Confirm Submit';
  modal.classList.remove('hidden');
};

const submitExam = async () => {
  examSubmitted = true;

  document.getElementById('submit-modal').classList.add('hidden');
  document.getElementById('disconnect-modal').classList.add('hidden');

  if (_security) await _security.stop();
  if (_aiMonitor) _aiMonitor.stop();
  if (timerInterval) clearInterval(timerInterval);
  if (healthInterval) clearInterval(healthInterval);
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  stopAutoSnapshots();
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

  // Release camera & screen so requirements are fully cancelled
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }

  try {
    await setDoc(examDocRef, {
      status: 'submitted',
      memberUid: currentUser.uid,
      memberEmail: currentUser.email,
      memberRole,
      submittedAt: serverTimestamp(),
      answers,
      flagged,
      questionOrder,
      pausedRemaining: null
    }, { merge: true });
  } catch (e) {
    console.warn('Failed to save submission:', e);
  }

  clearState();

  // Full viewport takeover — no scroll, no leftover bars/sidebar
  document.body.style.overflow = 'hidden';
  document.querySelector('.exam-bar')?.classList.add('hidden');
  document.querySelector('.exam-layout')?.classList.add('hidden');
  document.querySelector('.exam-footer-bar')?.classList.add('hidden');
  document.getElementById('exam-submitted').classList.remove('hidden');
};

const showMessage = (msg) => {
  document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:var(--muted);font-size:1.2rem;">${msg}</div>`;
};

document.addEventListener('DOMContentLoaded', init);


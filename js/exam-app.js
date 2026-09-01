import { auth, db, storage } from './exam-shared.js';
import { SecurityWrapper } from './security.js';
import { AIMonitor } from './ai-monitor.js';
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs, query, orderBy as orderByFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let teamId, currentUser = null;
let memberName = '', memberRole = '';
let questions = [];
let answers = {};
let flagged = {};
let timerInterval, endTime, absoluteDeadline, examDocRef, pausedRemaining = null, questionOrder = [];
let camStream = null, screenStream = null;
let cameraActive = false, screenActive = false, fullscreenActive = false;
let examPaused = false, examSubmitted = false, pauseResolve = null, healthInterval = null, countdownInterval = null, autoSaveInterval = null;
let _security = null, _aiMonitor = null;
let currentLang = localStorage.getItem('gaac_lang') || 'en';
const STORAGE_KEY = () => `gaac_exam_${teamId}_${currentUser ? currentUser.uid : 'anon'}`;

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

    const existingExam = await getDoc(examDocRef);
    if (existingExam.exists() && existingExam.data().status === 'submitted') {
      document.getElementById('verify-modal').classList.add('hidden');
      document.getElementById('exam-submitted').classList.remove('hidden');
      return;
    }

    questions = await loadRoundQuestions();

    // Restore saved state FIRST (before shuffle), so we know if this is a resume
    loadState();

    if (questionOrder.length === 0) {
      // First session: shuffle questions and store order
      for (let i = questions.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [questions[i], questions[j]] = [questions[j], questions[i]];
      }
      questionOrder = questions.map(q => q.id);
    } else {
      // Resume session: reorder questions to match saved order
      const ordered = questionOrder.map(id => questions.find(q => q.id === id)).filter(Boolean);
      if (ordered.length === questions.length) questions = ordered;
    }

    // Fetch authoritative deadline from Firestore (server-side, absolute)
    try {
      const examSnap = await getDoc(examDocRef);
      if (examSnap.exists()) {
        const examData = examSnap.data();
        if (examData.absoluteDeadline) {
          absoluteDeadline = typeof examData.absoluteDeadline === 'number'
            ? examData.absoluteDeadline
            : new Date(examData.absoluteDeadline).getTime();
          endTime = absoluteDeadline;
          console.log('[init] Using absoluteDeadline from Firestore:', new Date(absoluteDeadline).toISOString());
        } else if (examData.endTime) {
          // Backwards compat: old exams without absoluteDeadline
          const storedEnd = typeof examData.endTime === 'number'
            ? examData.endTime
            : new Date(examData.endTime).getTime();
          if (examData.pausedRemaining) {
            endTime = storedEnd;
            absoluteDeadline = storedEnd;
          } else {
            endTime = storedEnd;
            absoluteDeadline = storedEnd;
          }
          console.log('[init] Using endTime from Firestore (legacy):', new Date(endTime).toISOString());
        }
      }
    } catch (e) {
      console.warn('Failed to fetch exam doc for timer:', e);
    }

    // Check if exam was reset by admin — clear stale localStorage
    try {
      const teamSnap = await getDoc(doc(db, 'teams', teamId));
      if (teamSnap.exists()) {
        const teamData = teamSnap.data();
        if (teamData.resetAt) {
          const saved = localStorage.getItem(STORAGE_KEY());
          if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed.endTime && parsed.endTime < teamData.resetAt) {
              console.log('[init] Clearing stale localStorage (resetAt > saved state)');
              clearState();
              endTime = null;
              absoluteDeadline = null;
              questionOrder = [];
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to check resetAt:', e);
    }

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

    // If there's a saved exam in progress, skip verification
    if (endTime && endTime > Date.now()) {
      document.getElementById('verify-modal').classList.add('hidden');
      document.getElementById('exam-content').classList.remove('hidden');
      startTimer(endTime);
      startAutoSave();
      startSecurity();
      return;
    }

    document.getElementById('btn-start-exam').addEventListener('click', startExam);

    const updateVerifyLabels = () => {
      const isAr = currentLang === 'ar';
      const setText = (selector, text) => {
        const el = document.querySelector(selector);
        if (el) el.textContent = text;
      };
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
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
    cameraOk = true;
    setIcon('v-cam-icon', true);
    console.log('[startExam] camera OK');
  } catch (e) { console.warn('[startExam] camera FAILED:', e); setIcon('v-cam-icon', false); }

  if (cameraOk) {
    try {
      console.log('[startExam] requesting screen share...');
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenOk = true;
      setIcon('v-ss-icon', true);
      console.log('[startExam] screen share OK');
    } catch (e) { console.warn('[startExam] screen share FAILED:', e); setIcon('v-ss-icon', false); }
  } else {
    setIcon('v-ss-icon', false);
  }

  if (cameraOk && screenOk) {
    try {
      console.log('[startExam] requesting fullscreen (user gesture)...');
      await document.documentElement.requestFullscreen();
      fullscreenOk = true;
      setIcon('v-fs-icon', true);
      console.log('[startExam] fullscreen OK');
    } catch (e) { console.warn('[startExam] fullscreen FAILED:', e); setIcon('v-fs-icon', false); }
  } else {
    setIcon('v-fs-icon', false);
  }

  if (!fullscreenOk || !cameraOk || !screenOk) {
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

  const durationMs = 60 * 60 * 1000;
  endTime = Date.now() + durationMs;
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
        absoluteDeadline: absoluteDeadline
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
  try {
    const res = await fetch('./js/r1_8f3kq_questions.json', { cache: 'no-store' });
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
  if (now - _lastSnapshotAt < 2000) return;
  if (_lastSnapshot[snapshotKey] && now - _lastSnapshot[snapshotKey] < 10000) return;
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
      console.log('[captureSnapshot] Uploaded:', msg);
    }
  } catch (e) {
    console.warn('[captureSnapshot] Failed:', e);
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
    else if (eventType === 'window-blur' || msg.includes('lost focus')) pauseExam('window-blur');
  };

  _security = new SecurityWrapper(teamId, currentUser.uid, db, handleSecurityNotice, {
    'fullscreen-exit': 15,
    'tab-hidden': 15,
    'window-blur': 15,
    'camera-stopped': 15,
    'screenshare-stopped': 15
  });
  _security.start();

  _aiMonitor = new AIMonitor(_security, camStream, handleSecurityNotice);
  _aiMonitor.start();
  if (screenStream) _aiMonitor.setScreenStream(screenStream);

  if (camStream) cameraActive = true;
  if (screenStream) screenActive = true;
  if (document.fullscreenElement) fullscreenActive = true;
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
    if (examSubmitted) return;
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
  if (!cameraActive || !screenActive || !fullscreenActive) return;
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
  if (!screenStream) return 'screenshare';
  if (!document.fullscreenElement) return 'fullscreen';
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
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
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
      const newStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
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
  const update = () => {
    const remaining = Math.max(0, end - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    document.getElementById('timer-display').textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    if (remaining <= 60000) document.getElementById('timer-display').classList.add('warning');
    if (remaining <= 0) { clearInterval(timerInterval); submitExam(); }
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

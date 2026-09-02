import { auth, db } from './exam-shared.js';
import { SecurityWrapper } from './security.js';
import { AIMonitor } from './ai-monitor.js';
import { doc, getDoc, setDoc, serverTimestamp, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let teamId = null;
let currentUser = null;
let memberRole = 'member';
let memberName = '';
let questions = [];
let answers = {};
let flagged = {};
let endTime = 0;
let timerInterval = null;
let submitted = false;
let camStream = null;
let screenStream = null;
let security = null;
let aiMonitor = null;
const durationMs = 60 * 60 * 1000;
let currentLang = localStorage.getItem('gaac_lang') || 'en';

// Mock test window (Cairo, GMT+3). The button/site opens at 6:58 PM only to
// let candidates approve the proctoring requirements; the exam itself may not
// start before 7:00 PM, and no new entires after 8:10 PM.
const MOCK_DEFAULT = {
  mockCountdownStart: Date.UTC(2026, 8, 2, 9, 0, 0),  // 12:00 PM
  mockOpenAt: Date.UTC(2026, 8, 2, 15, 58, 0),        // 6:58 PM
  mockStartAt: Date.UTC(2026, 8, 2, 16, 0, 0),        // 7:00 PM
  mockCloseAt: Date.UTC(2026, 8, 2, 17, 10, 0)        // 8:10 PM
};
let mSched = { ...MOCK_DEFAULT };

const loadMockSchedule = async () => {
  try {
    const snap = await getDoc(doc(db, 'settings', 'competition'));
    if (snap.exists()) {
      const data = snap.data();
      ['mockCountdownStart', 'mockOpenAt', 'mockStartAt', 'mockCloseAt'].forEach((k) => {
        if (typeof data[k] === 'number') mSched[k] = data[k];
      });
    }
  } catch (e) {
    console.warn('Failed to load mock schedule:', e);
  }
};

const setText = (selector, text) => {
  const el = document.querySelector(selector);
  if (el) el.textContent = text;
};
const isAr = () => currentLang === 'ar';

const applyUIStrings = () => {
  const ar = isAr();
  document.getElementById('verify-modal').dir = ar ? 'rtl' : 'ltr';
  document.getElementById('exam-view').dir = ar ? 'rtl' : 'ltr';
  const vLang = document.getElementById('btn-verify-lang');
  if (vLang) vLang.textContent = ar ? 'EN' : 'AR';
  const langBtn = document.getElementById('btn-lang-toggle');
  if (langBtn) {
    langBtn.textContent = ar ? 'عربي' : 'EN';
    langBtn.classList.toggle('active', ar);
  }
  const titleEl = document.getElementById('verify-title');
  if (titleEl) titleEl.innerHTML = ar ? 'اختبار تجريبي <span class="text-blue">متطلبات</span>' : 'Mock Test <span class="text-blue">Requirements</span>';
  const instrEl = document.getElementById('verify-instructions');
  if (instrEl) instrEl.textContent = ar ? 'فعّل المتطلبات بالترتيب لبدء الاختبار التجريبي.' : 'Enable each requirement in order to start the practice mock test.';
  setText('#btn-start-mock', ar ? 'ابدأ الاختبار التجريبي' : 'Start Mock Test');
  setText('#v-camera .verify-label', ar ? 'الوصول إلى الكاميرا' : 'Camera Access');
  setText('#v-camera .verify-note', ar ? 'اسمح باستخدام الكاميرا لفحص المراقبة التجريبية.' : 'Allow your webcam for the practice proctoring check.');
  setText('#v-screenshare .verify-label', ar ? 'مشاركة الشاشة' : 'Screen Sharing');
  setText('#v-screenshare .verify-note', ar ? 'شارك الشاشة بالكامل مثل الامتحان الحقيقي.' : 'Share your full screen, like the real exam.');
  setText('#v-fullscreen .verify-label', ar ? 'وضع ملء الشاشة' : 'Fullscreen Mode');
  setText('#v-fullscreen .verify-note', ar ? 'ادخل وضع ملء الشاشة بعد الكاميرا ومشاركة الشاشة.' : 'Enter fullscreen after camera and screen share.');
  setText('#palette-title', ar ? 'الأسئلة' : 'Mock');
  setText('#footer-note', ar ? 'اختبار GAAC التجريبي : مراقبة تدريبية' : 'GAAC Mock Test : Practice Proctoring');
  setText('#fs-title', ar ? 'ادخل وضع ملء الشاشة' : 'Enter Fullscreen');
  setText('#fs-copy', ar ? 'يرجى الدخول في وضع ملء الشاشة لمتابعة الاختبار التجريبي.' : 'Please enter fullscreen mode to continue the mock test.');
  setText('#btn-reenter-fullscreen', ar ? 'العودة لملء الشاشة' : 'Re-enter Fullscreen');
  setText('#submit-title', ar ? 'تقديم الاختبار التجريبي؟' : 'Submit Mock Test?');
  setText('#submit-copy', ar ? 'بمجرد التقديم، سيتم إغلاق محاولتك.' : 'Once submitted, your mock attempt will be closed.');
  setText('#btn-cancel-submit', ar ? 'إلغاء' : 'Cancel');
  setText('#btn-confirm-submit', ar ? 'تأكيد التقديم' : 'Confirm Submit');
  setText('#submitted-title', ar ? 'تم تقديم الاختبار التجريبي' : 'Mock Test Submitted');
  setText('#submitted-copy', ar ? 'تم تقديم اختبارك التجريبي بنجاح.' : 'Your mock test was submitted successfully.');
  setText('#btn-submit', ar ? 'تسليم' : 'Submit');
  const greet = document.getElementById('greeting');
  if (greet) greet.textContent = ar ? `أهلاً، ${memberName || ''}` : `Hello, ${memberName || ''}`;
  renderQuestions();
};

const letters = ['A', 'B', 'C', 'D'];
const storageKey = () => `gaac_mock_${teamId}_${currentUser ? currentUser.uid : 'anon'}`;

const fmtCountdown = (ms) => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(t / 3600)).padStart(2, '0');
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
  const s = String(t % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

// The exam may not start before mockStartAt (7:00 PM). Between mockOpenAt and
// mockStartAt the requirements can be approved; the Start button stays disabled
// with a live countdown until 7:00 PM.
const gateStartButton = () => {
  const btn = document.getElementById('btn-start-mock');
  if (!btn) return;
  const el = document.getElementById('verify-countdown');
  let iv = null;
  const tick = () => {
    const left = mSched.mockStartAt - Date.now();
    if (left > 0) {
      btn.disabled = true;
      if (el) { el.classList.remove('hidden'); el.textContent = fmtCountdown(left); }
    } else {
      btn.disabled = false;
      if (el) el.classList.add('hidden');
      if (iv) clearInterval(iv);
    }
  };
  tick();
  if (Date.now() < mSched.mockStartAt) iv = setInterval(tick, 1000);
};

const init = async () => {
  const params = new URLSearchParams(window.location.search);
  teamId = params.get('team');
  if (!teamId) {
    window.location.href = 'team-dashboard.html';
    return;
  }

  currentUser = await new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
  });
  if (!currentUser) {
    window.location.href = 'team-dashboard.html';
    return;
  }

  await resolveMemberRole();
  questions = await loadQuestions();
  restoreState();
  renderQuestions();
  await loadMockSchedule();

  // Window guard: new entries are only allowed between mockOpenAt (6:58 PM,
  // requirements approval) and mockCloseAt (8:10 PM). Anyone mid-exam keeps
  // going even across a refresh after the window closes.
  const now = Date.now();
  const inProgress = endTime > now;
  if (!inProgress && (now < mSched.mockOpenAt || now > mSched.mockCloseAt)) {
    window.location.href = 'team-dashboard.html';
    return;
  }
  gateStartButton();

  // Resume an in-progress mock after a refresh: keep the same endTime so the
  // timer never resets, and never pause it. If time already ran out, submit.
  if (endTime > Date.now() && !submitted) {
    document.getElementById('verify-modal').classList.add('hidden');
    document.getElementById('exam-view').classList.remove('hidden');
    await resumeMonitoring();
    startTimer(endTime);
  } else if (endTime > 0 && endTime <= Date.now()) {
    await submitMock();
  }
};

const setIcon = (id, ok, state) => {
  const el = document.getElementById(id);
  if (!el) return;
  if (state === 'n/a') { el.style.background = '#64748b'; el.style.opacity = '0.5'; return; }
  el.style.opacity = '1';
  el.style.background = ok ? '#22c55e' : '#ef4444';
};

const startMock = async () => {
  const errorEl = document.getElementById('verify-error');
  errorEl.classList.add('hidden');
  document.getElementById('btn-start-mock').disabled = true;

  // Mobile / tablet handling: getDisplayMedia (screen share) is not available
  // (Chrome Android/iOS Safari) and fullscreen is unreliable on iOS. On these
  // devices the camera remains the required proctoring signal; screen share
  // and fullscreen are best-effort only.
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.innerWidth < 1024)
    || typeof navigator.mediaDevices?.getDisplayMedia !== 'function';

  const mobNote = document.getElementById('verify-mobile-note');
  if (mobNote) {
    mobNote.textContent = isMobile
      ? (isAr() ? 'على الهاتف، الكاميرا فقط مطلوبة. مشاركة الشاشة وملء الشاشة اختيارية.' : 'On mobile, only the camera is required. Screen sharing and fullscreen are optional.')
      : '';
    mobNote.classList.toggle('hidden', !isMobile);
  }

  let cameraOk = false;
  let screenOk = false;
  let fullscreenOk = false;

  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
    cameraOk = true;
    setIcon('v-cam-icon', true);
  } catch (e) {
    console.warn('Mock camera failed:', e);
    setIcon('v-cam-icon', false);
  }

  if (cameraOk && !isMobile) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenOk = true;
      setIcon('v-ss-icon', true);
    } catch (e) {
      console.warn('Mock screen share failed:', e);
      setIcon('v-ss-icon', false);
    }
  } else {
    setIcon('v-ss-icon', false, isMobile ? 'n/a' : null);
  }

  if (!isMobile && cameraOk && screenOk) {
    try {
      await document.documentElement.requestFullscreen();
      fullscreenOk = true;
      setIcon('v-fs-icon', true);
    } catch (e) {
      console.warn('Mock fullscreen failed:', e);
      setIcon('v-fs-icon', false);
    }
  } else {
    setIcon('v-fs-icon', false, isMobile ? 'n/a' : null);
  }

  const requiredOk = isMobile ? cameraOk : (cameraOk && screenOk && fullscreenOk);
  if (!requiredOk) {
    cleanupStreams();
    errorEl.textContent = isMobile
      ? 'Please enable your camera to start the mock test.'
      : 'Please enable camera, screen sharing, and fullscreen to start the mock test.';
    errorEl.classList.remove('hidden');
    document.getElementById('btn-start-mock').disabled = false;
    return;
  }

  document.getElementById('verify-modal').classList.add('hidden');
  document.getElementById('exam-view').classList.remove('hidden');
  startLocalMonitoring();

  endTime = Date.now() + durationMs;
  saveState();
  startTimer(endTime);
};

const cleanupStreams = () => {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
};

const resumeMonitoring = async () => {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e) {
      console.warn('[mock] resume: screen share refused:', e);
    }
  } catch (e) {
    console.warn('[mock] resume: camera refused:', e);
  }
  startLocalMonitoring();
  reenterFullscreen();
};

// After a refresh the browser drops fullscreen (and usually blocks an automatic
// requestFullscreen outside a user gesture), so we retry and, if blocked, show a
// prompt with a button instead of silently staying out of fullscreen.
const showFsModal = () => { const m = document.getElementById('fullscreen-modal'); if (m) m.classList.remove('hidden'); };
const hideFsModal = () => { const m = document.getElementById('fullscreen-modal'); if (m) m.classList.add('hidden'); };

let fsModalBound = false;
const bindFullscreenModal = () => {
  if (fsModalBound) return;
  fsModalBound = true;
  document.addEventListener('fullscreenchange', () => {
    if (submitted) return;
    if (document.fullscreenElement) hideFsModal();
    else showFsModal();
  });
  const btn = document.getElementById('btn-reenter-fullscreen');
  if (btn) btn.addEventListener('click', async () => {
    try {
      await document.documentElement.requestFullscreen();
      if (document.fullscreenElement) hideFsModal();
    } catch (e) { console.warn('[mock] fullscreen request failed:', e); }
  });
};

const reenterFullscreen = () => {
  if (document.fullscreenElement) return;
  const enter = async () => {
    try { await document.documentElement.requestFullscreen(); }
    catch (e) { console.warn('[mock] fullscreen request failed:', e); }
  };
  enter();
  setTimeout(() => {
    if (!document.fullscreenElement && !submitted) showFsModal();
  }, 800);
};

// If the camera or the screen share stops, the candidate must re-enable it to
// continue, so show a simple prompt with a re-enable action for that requirement.
let reenableReq = null;

const showReenable = (reason) => {
  if (submitted) return;
  reenableReq = reason;
  const ar = isAr();
  if (reason === 'camera') {
    setText('#reenable-title', ar ? 'تم فصل الكاميرا' : 'Camera Disconnected');
    setText('#reenable-copy', ar ? 'أعد تفعيل الكاميرا للمتابعة.' : 'Re-enable your camera to continue.');
    setText('#btn-reenable', ar ? 'إعادة تفعيل الكاميرا' : 'Re-enable Camera');
  } else {
    setText('#reenable-title', ar ? 'تم إيقاف مشاركة الشاشة' : 'Screen Sharing Stopped');
    setText('#reenable-copy', ar ? 'أعد تفعيل مشاركة الشاشة للمتابعة.' : 'Re-enable screen sharing to continue.');
    setText('#btn-reenable', ar ? 'إعادة تفعيل مشاركة الشاشة' : 'Re-enable Screen Sharing');
  }
  const modal = document.getElementById('reenable-modal');
  if (modal) modal.classList.remove('hidden');
  const btn = document.getElementById('btn-reenable');
  if (btn) btn.onclick = reenableAndContinue;
};

const hideReenable = () => {
  const modal = document.getElementById('reenable-modal');
  if (modal) modal.classList.add('hidden');
  reenableReq = null;
};

const reenableAndContinue = async () => {
  const errEl = document.getElementById('reenable-error');
  const btn = document.getElementById('btn-reenable');
  if (btn) btn.disabled = true;
  try {
    if (reenableReq === 'camera') {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
      const t = newStream.getVideoTracks()[0];
      if (t) t.onended = () => setTimeout(() => showReenable('camera'), 200);
      if (camStream) camStream.getTracks().forEach(tr => tr.stop());
      camStream = newStream;
      if (security && security.setInactive) security.setInactive('camera-stopped');
      if (aiMonitor && aiMonitor.setStream) aiMonitor.setStream(camStream);
    } else if (reenableReq === 'screenshare') {
      const newStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const t = newStream.getVideoTracks()[0];
      if (t) t.onended = () => setTimeout(() => showReenable('screenshare'), 200);
      if (screenStream) screenStream.getTracks().forEach(tr => tr.stop());
      screenStream = newStream;
      if (security && security.setInactive) security.setInactive('screenshare-stopped');
      if (aiMonitor && aiMonitor.setScreenStream) aiMonitor.setScreenStream(screenStream);
    }
    hideReenable();
  } catch (e) {
    console.warn('[mock] re-enable failed:', reenableReq, e);
    if (errEl) {
      errEl.textContent = isAr() ? 'تعذرت إعادة التفعيل. يرجى السماح بالطلب في المتصفح.' : 'Could not re-enable. Please allow the permission in the browser.';
      errEl.classList.remove('hidden');
    }
  }
  if (btn) btn.disabled = false;
};

const startLocalMonitoring = () => {
  security = new SecurityWrapper(teamId, currentUser.uid, null, (msg, severity) => {
    showToast(msg, severity);
  }, {
    'fullscreen-exit': 15,
    'tab-hidden': 15,
    'window-blur': 15,
    'camera-stopped': 15,
    'screenshare-stopped': 15
  });
  security.start();
  bindFullscreenModal();

  aiMonitor = new AIMonitor(security, camStream, (msg, severity) => {
    showToast(msg, severity);
  });
  aiMonitor.start();
  aiMonitor.setScreenStream(screenStream);

  const camTrack = camStream?.getVideoTracks()[0];
  if (camTrack) camTrack.onended = () => setTimeout(() => showReenable('camera'), 200);
  const screenTrack = screenStream?.getVideoTracks()[0];
  if (screenTrack) screenTrack.onended = () => setTimeout(() => showReenable('screenshare'), 200);
};

const stopLocalMonitoring = async () => {
  if (aiMonitor) aiMonitor.stop();
  if (security) await security.stop();
  cleanupStreams();
};

const showToast = (msg, severity = 'warning') => {
  const toast = document.getElementById('exam-toast');
  const msgEl = document.getElementById('toast-msg');
  if (!toast || !msgEl) return;
  msgEl.textContent = msg;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 5000);
};

const resolveMemberRole = async () => {
  try {
    const regSnap = await getDoc(doc(db, 'registrations', teamId));
    if (!regSnap.exists()) return;
    const reg = regSnap.data();
    const members = [
      { ...reg.leader, role: 'leader' },
      reg.member2 ? { ...reg.member2, role: 'member2' } : null,
      reg.member3 ? { ...reg.member3, role: 'member3' } : null
    ].filter(Boolean);
    const me = members.find(m => (m.email || '').toLowerCase() === (currentUser.email || '').toLowerCase() || m.uid === currentUser.uid);
    if (me) {
      memberRole = me.role;
      memberName = me.name || me.email || currentUser.email || 'Candidate';
    } else {
      memberName = currentUser.email || 'Candidate';
    }
    const greet = document.getElementById('greeting');
    if (greet) greet.textContent = isAr() ? `أهلاً، ${memberName}` : `Hello, ${memberName}`;
  } catch (e) {
    console.warn('Failed to resolve member role:', e);
  }
};

const loadQuestions = async () => {
  const res = await fetch('./js/mock_questions.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Unable to load mock questions.');
  const data = await res.json();
  return data.map((q, i) => ({ id: q.id || `m${i + 1}`, ...q }));
};

const saveState = () => {
  if (submitted) return;
  localStorage.setItem(storageKey(), JSON.stringify({ answers, flagged, endTime }));
};

const restoreState = () => {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return;
    const data = JSON.parse(raw);
    answers = data.answers || {};
    flagged = data.flagged || {};
    if (typeof data.endTime === 'number') endTime = data.endTime;
  } catch {}
};

const renderQuestions = () => {
  document.getElementById('total-count').textContent = questions.length;
  const container = document.getElementById('questions-container');
  const palette = document.getElementById('question-palette');
  container.innerHTML = '';
  palette.innerHTML = '';

  questions.forEach((q, idx) => {
    const card = document.createElement('section');
    card.className = 'question-card';
    card.id = `q-${idx}`;
    if (isAr()) card.style.direction = 'rtl';
    const qText = isAr() ? (q.text_ar || q.text) : q.text;
    const qOpts = isAr() ? (q.options_ar || q.options) : q.options;
    card.innerHTML = `
      <div class="q-header">
        <div class="q-number">${isAr() ? 'سؤال' : 'Question'} ${idx + 1}</div>
        <button type="button" class="q-flag-btn ${flagged[idx] ? 'flagged' : ''}" data-idx="${idx}" title="${isAr() ? 'تحديد للمراجعة' : 'Flag for review'}">&#9873;</button>
      </div>
      <div class="q-text">${qText}</div>
      <div class="q-options">
        ${qOpts.map((opt, oi) => {
          const letter = letters[oi];
          return `<label class="q-option ${answers[idx] === letter ? 'selected' : ''}">
            <input type="radio" name="q${idx}" value="${letter}" ${answers[idx] === letter ? 'checked' : ''} />
            <span class="opt-letter">${letter}</span>
            <span>${opt}</span>
          </label>`;
        }).join('')}
      </div>
    `;
    container.appendChild(card);

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `palette-dot ${answers[idx] ? 'answered' : ''} ${flagged[idx] ? 'flagged' : ''}`;
    dot.textContent = idx + 1;
    dot.addEventListener('click', () => card.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    palette.appendChild(dot);
  });

  container.querySelectorAll('input[type="radio"]').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = Number(e.target.name.replace('q', ''));
      answers[idx] = e.target.value;
      renderQuestions();
      saveState();
    });
  });

  container.querySelectorAll('.q-flag-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = Number(e.target.dataset.idx);
      flagged[idx] = !flagged[idx];
      e.target.classList.toggle('flagged');
      saveState();
      updateQuestionPalette();
    });
  });
  updateAnswered();
};

const updateQuestionPalette = () => {
  const dots = document.querySelectorAll('.palette-dot');
  dots.forEach((dot, idx) => {
    dot.className = 'palette-dot';
    if (answers[idx]) dot.classList.add('answered');
    if (flagged[idx]) dot.classList.add('flagged');
  });
  updateAnswered();
};

const updateAnswered = () => {
  document.getElementById('answered-count').textContent = Object.keys(answers).length;
};

const startTimer = (end) => {
  const timerEl = document.getElementById('timer-display');
  const tick = () => {
    const remaining = Math.max(0, end - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    timerEl.classList.toggle('warning', remaining <= 60000);
    if (remaining <= 0) submitMock();
  };
  tick();
  timerInterval = setInterval(tick, 1000);
};

const submitMock = async () => {
  if (submitted) return;
  submitted = true;
  if (timerInterval) clearInterval(timerInterval);
  hideReenable();
  await stopLocalMonitoring();

  const answersCount = Object.keys(answers).length;
  const mockDocRef = doc(db, 'teams', teamId, 'mock', currentUser.uid);

  try {
    await setDoc(mockDocRef, {
      status: 'submitted',
      memberUid: currentUser.uid,
      memberEmail: currentUser.email,
      memberRole,
      answers,
      answersCount,
      submittedAt: serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('Failed to save mock answers:', e);
  }

  localStorage.removeItem(storageKey());
  document.getElementById('exam-view').classList.add('hidden');
  document.querySelector('.exam-bar').classList.add('hidden');
  document.getElementById('submit-modal').classList.add('hidden');
  showSubmittedView();
};

const showSubmittedView = (score, correctCount, totalQuestions) => {
  const view = document.getElementById('submitted-view');
  if (view) view.classList.remove('hidden');
};

document.getElementById('btn-submit').addEventListener('click', () => {
  document.getElementById('submit-modal').classList.remove('hidden');
});
document.getElementById('btn-cancel-submit').addEventListener('click', () => {
  document.getElementById('submit-modal').classList.add('hidden');
});
document.getElementById('btn-confirm-submit').addEventListener('click', submitMock);
document.getElementById('btn-start-mock').addEventListener('click', startMock);

const setLang = (lang) => {
  if (currentLang !== lang) {
    currentLang = lang;
    try { localStorage.setItem('gaac_lang', currentLang); } catch {}
    applyUIStrings();
  }
};
const langBtn = document.getElementById('btn-lang-toggle');
if (langBtn) langBtn.addEventListener('click', () => setLang(isAr() ? 'en' : 'ar'));
const verifyLangBtn = document.getElementById('btn-verify-lang');
if (verifyLangBtn) verifyLangBtn.addEventListener('click', () => setLang(isAr() ? 'en' : 'ar'));

document.addEventListener('DOMContentLoaded', () => {
  applyUIStrings();
  init();
});

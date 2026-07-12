import { auth, db, storage } from './exam-shared.js';
import { SecurityWrapper } from './security.js';
import { AIMonitor } from './ai-monitor.js';
import { doc, getDoc, setDoc, serverTimestamp, collection, getDocs, query, orderBy as orderByFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let teamId, examId = 'round1', currentUser = null;
let questions = [];
let answers = {};
let flagged = {};
let timerInterval, endTime, examDocRef, pausedRemaining = null, questionOrder = [];
let camStream = null, screenStream = null;
let cameraActive = false, screenActive = false, fullscreenActive = false;
let examPaused = false, examSubmitted = false, pauseResolve = null, healthInterval = null, countdownInterval = null;
const STORAGE_KEY = () => `gaac_exam_${teamId}`;

const saveState = () => {
  try {
    localStorage.setItem(STORAGE_KEY(), JSON.stringify({ answers, flagged, endTime, questionOrder }));
  } catch {}
};

const loadState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY());
    if (raw) {
      const data = JSON.parse(raw);
      answers = data.answers || {};
      flagged = data.flagged || {};
      if (data.endTime) endTime = data.endTime;
      // Restore question order so resume doesn't re-shuffle
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
    if (!teamId) { window.location.href = 'exam-login.html'; return; }

    const user = await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
    });
    if (!user) { window.location.href = 'exam-login.html'; return; }
    currentUser = user;

    // Must exist before any teams/ read — used by security rules to verify team membership
    await ensureTeamMembership();

    examDocRef = doc(db, 'teams', teamId, 'exam', examId);

    const existingExam = await getDoc(examDocRef);
    if (existingExam.exists() && existingExam.data().status === 'submitted') {
      document.getElementById('verify-modal').classList.add('hidden');
      document.getElementById('exam-submitted').classList.remove('hidden');
      return;
    }

    // Fetch all 40 questions from Firestore (ordered by seed order)
    const qSnap = await getDocs(query(collection(db, 'round1', 'round1', 'questions'), orderByFirestore('order')));
    questions = [];
    qSnap.forEach(doc => {
      const q = doc.data();
      questions.push({ id: doc.id, text: q.text, options: q.options });
    });

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

    // Override localStorage endTime with Firestore's authoritative value
    try {
      const examSnap = await getDoc(examDocRef);
      if (examSnap.exists()) {
        const examData = examSnap.data();
        // If exam was paused, use pausedRemaining so page reload doesn't lose time
        if (examData.pausedRemaining) {
          endTime = Date.now() + examData.pausedRemaining;
        } else if (examData.endTime) {
          endTime = examData.endTime;
        }
      }
    } catch (e) {
      console.warn('Failed to fetch exam doc for timer:', e);
    }

    renderQuestions();
    updateQuestionPalette();

    document.getElementById('btn-submit').addEventListener('click', confirmSubmit);
    document.getElementById('btn-confirm-submit').addEventListener('click', submitExam);
    document.getElementById('btn-cancel-submit').addEventListener('click', () => {
      document.getElementById('submit-modal').classList.add('hidden');
    });

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

  try {
    console.log('[startExam] requesting fullscreen...');
    await document.documentElement.requestFullscreen();
    fullscreenOk = true;
    setIcon('v-fs-icon', true);
    console.log('[startExam] fullscreen OK');
  } catch (e) { console.warn('[startExam] fullscreen FAILED:', e); setIcon('v-fs-icon', false); }

  try {
    console.log('[startExam] requesting camera...');
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
    cameraOk = true;
    setIcon('v-cam-icon', true);
    console.log('[startExam] camera OK');
  } catch (e) { console.warn('[startExam] camera FAILED:', e); setIcon('v-cam-icon', false); }

  try {
    console.log('[startExam] requesting screen share...');
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenOk = true;
    setIcon('v-ss-icon', true);
    console.log('[startExam] screen share OK');
  } catch (e) { console.warn('[startExam] screen share FAILED:', e); setIcon('v-ss-icon', false); }

  if (!fullscreenOk || !cameraOk || !screenOk) {
    console.log('[startExam] requirements NOT met: fullscreen=', fullscreenOk, 'camera=', cameraOk, 'screen=', screenOk);
    errEl.textContent = 'Please enable all requirements above to start the exam.';
    errEl.style.display = 'block';
    document.getElementById('btn-start-exam').disabled = false;
    return;
  }

  console.log('[startExam] ALL requirements met, starting exam...');
  document.getElementById('verify-modal').classList.add('hidden');
  document.getElementById('exam-content').classList.remove('hidden');

  const durationMs = 60 * 60 * 1000;
  endTime = Date.now() + durationMs;

  // Write status + endTime to Firestore immediately (server-authoritative timer)
  try {
      await setDoc(examDocRef, {
        status: 'in-progress',
        startedAt: serverTimestamp(),
        endTime: new Date(endTime).toISOString()
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

const _lastSnapshot = {};
const captureSnapshot = async (msg) => {
  const now = Date.now();
  if (_lastSnapshot[msg] && now - _lastSnapshot[msg] < 10000) return;
  _lastSnapshot[msg] = now;
  try {
    const eventType = msg;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00020a';
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#fff';
    ctx.font = '14px sans-serif';
    ctx.fillText(`Violation: ${eventType}`, 8, 20);
    ctx.fillText(`Time: ${new Date().toISOString()}`, 8, 40);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.5));
    if (!blob) return;
    const path = `snapshots/round1/${teamId}/${currentUser.uid}/${Date.now()}_${eventType}.jpg`;
    await uploadBytes(ref(storage, path), blob);
  } catch (e) {
    console.warn('Snapshot upload failed:', e);
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
  if (severity === 'severe') captureSnapshot(msg);
};

const startSecurity = () => {
  const security = new SecurityWrapper(teamId, db, (msg, severity) => {
    showToast(msg, severity);
    if (msg.includes('switched away')) pauseExam('tab-hidden');
    else if (msg.includes('lost focus')) pauseExam('window-blur');
  }, {
    'fullscreen-exit': 15,
    'tab-hidden': 15,
    'window-blur': 15,
    'camera-stopped': 15,
    'screenshare-stopped': 15
  });
  security.start();
  window.security = security;

  const aiMonitor = new AIMonitor(security, camStream, showToast);
  aiMonitor.start();
  window.aiMonitor = aiMonitor;

  if (camStream) cameraActive = true;
  if (screenStream) screenActive = true;
  if (document.fullscreenElement) fullscreenActive = true;
  _monitorTracks();

  // On page reload / saved-state restore, if streams are gone, pause immediately
  const missing = checkRequirements();
  if (missing) {
    showToast(`${missing === 'fullscreen' ? 'Fullscreen' : missing === 'camera' ? 'Camera' : 'Screen sharing'} required. Exam paused.`, 'warning');
    pauseExam(missing);
  }

  // Poll track health every 3s — only pauses, does NOT log (onended handles logging)
  healthInterval = setInterval(() => {
    if (examPaused || examSubmitted) return;
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
    if (window.security) window.security.logEvent('print-attempt', 'warning');
  });
};

const _monitorTracks = () => {
  if (camStream) {
    const t = camStream.getVideoTracks()[0];
    if (t) {
      t.onended = () => {
        if (examSubmitted) return;
        cameraActive = false;
        if (window.security) window.security.logEvent('camera-stopped', 'severe');
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
        if (window.security) window.security.logEvent('screenshare-stopped', 'severe');
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
  pausedRemaining = endTime - Date.now();
  setDoc(examDocRef, { pausedRemaining }, { merge: true }).catch(() => {});
  showDisconnectModal(reason);
};

const resumeExam = () => {
  if (examSubmitted) return;
  if (!examPaused) return;
  if (!cameraActive || !screenActive || !fullscreenActive) return;
  examPaused = false;
  document.getElementById('disconnect-modal').classList.add('hidden');
  if (pausedRemaining != null) {
    endTime = Date.now() + pausedRemaining;
    pausedRemaining = null;
    saveState();
    setDoc(examDocRef, { pausedRemaining: null }, { merge: true }).catch(() => {});
  }
  startTimer(endTime);
};

const showDisconnectModal = (reason, countdownSecs = 15) => {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

  const labels = {
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
    if (pausedRemaining != null) {
      endTime = Date.now() + pausedRemaining;
      pausedRemaining = null;
      saveState();
      setDoc(examDocRef, { pausedRemaining: null }, { merge: true }).catch(() => {});
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
        if (window.security) window.security.logEvent('camera-stopped', 'severe');
        showToast('Camera disconnected. Exam paused.', 'severe');
        pauseExam('camera');
      };
      if (window.security) window.security.setInactive('camera-stopped');
      if (window.aiMonitor && window.aiMonitor.setStream) window.aiMonitor.setStream(camStream);
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
        if (window.security) window.security.logEvent('screenshare-stopped', 'severe');
        showToast('Screen sharing stopped. Exam paused.', 'severe');
        pauseExam('screenshare');
      };
      if (window.security) window.security.setInactive('screenshare-stopped');
    } catch (e) {
      console.warn('Screenshare re-enable failed:', e);
    }
  } else if (reason === 'fullscreen') {
    fullscreenActive = true;
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

const renderQuestions = () => {
  const container = document.getElementById('questions-container');
  const palette = document.getElementById('question-palette');

  questions.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.id = `q-${idx}`;
    card.innerHTML = `
      <div class="q-header">
        <span class="q-number">Question ${idx + 1}</span>
        <button class="q-flag-btn ${flagged[idx] ? 'flagged' : ''}" data-idx="${idx}" title="Flag for review">&#9873;</button>
      </div>
      <p class="q-text">${q.text}</p>
      <div class="q-options">
        ${['A', 'B', 'C', 'D'].map((letter, oi) => `
          <label class="q-option ${answers[idx] === letter ? 'selected' : ''}">
            <input type="radio" name="q-${idx}" value="${letter}"
              ${answers[idx] === letter ? 'checked' : ''}
              data-idx="${idx}">
            <span class="opt-letter">${letter}</span>
            <span class="opt-text">${q.options[oi]}</span>
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
  setInterval(() => saveState(), 10000);
};

const confirmSubmit = () => {
  const unanswered = questions.length - Object.keys(answers).length;
  document.getElementById('unanswered-warning').textContent =
    unanswered > 0 ? `${unanswered} question${unanswered > 1 ? 's' : ''} unanswered.` : '';
  document.getElementById('submit-modal').classList.remove('hidden');
};

const submitExam = async () => {
  examSubmitted = true;

  document.getElementById('submit-modal').classList.add('hidden');
  document.getElementById('disconnect-modal').classList.add('hidden');

  if (window.security) await window.security.stop();
  if (window.aiMonitor) window.aiMonitor.stop();
  if (timerInterval) clearInterval(timerInterval);
  if (healthInterval) clearInterval(healthInterval);
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }

  // Release camera & screen so requirements are fully cancelled
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }

  try {
    await setDoc(examDocRef, {
      status: 'submitted',
      submittedAt: new Date().toISOString(),
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

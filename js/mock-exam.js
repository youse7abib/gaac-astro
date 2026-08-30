import { auth, db } from './exam-shared.js';
import { SecurityWrapper } from './security.js';
import { AIMonitor } from './ai-monitor.js';
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let teamId = null;
let currentUser = null;
let memberRole = 'member';
let questions = [];
let answers = {};
let timerInterval = null;
let submitted = false;
let camStream = null;
let screenStream = null;
let security = null;
let aiMonitor = null;
const durationMs = 20 * 60 * 1000;

const letters = ['A', 'B', 'C', 'D'];
const storageKey = () => `gaac_mock_${teamId}_${currentUser ? currentUser.uid : 'anon'}`;

const init = async () => {
  const params = new URLSearchParams(window.location.search);
  teamId = params.get('team');
  if (!teamId) {
    window.location.href = 'exam-login.html?mode=mock';
    return;
  }

  currentUser = await new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => { unsub(); resolve(user); });
  });
  if (!currentUser) {
    window.location.href = 'exam-login.html?mode=mock';
    return;
  }

  await resolveMemberRole();
  questions = await loadQuestions();
  restoreState();
  renderQuestions();
};

const setIcon = (id, ok) => {
  const el = document.getElementById(id);
  if (el) el.style.background = ok ? '#22c55e' : '#ef4444';
};

const startMock = async () => {
  const errorEl = document.getElementById('verify-error');
  errorEl.classList.add('hidden');
  document.getElementById('btn-start-mock').disabled = true;

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

  if (cameraOk) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      screenOk = true;
      setIcon('v-ss-icon', true);
    } catch (e) {
      console.warn('Mock screen share failed:', e);
      setIcon('v-ss-icon', false);
    }
  } else {
    setIcon('v-ss-icon', false);
  }

  if (cameraOk && screenOk) {
    try {
      await document.documentElement.requestFullscreen();
      fullscreenOk = true;
      setIcon('v-fs-icon', true);
    } catch (e) {
      console.warn('Mock fullscreen failed:', e);
      setIcon('v-fs-icon', false);
    }
  } else {
    setIcon('v-fs-icon', false);
  }

  if (!cameraOk || !screenOk || !fullscreenOk) {
    cleanupStreams();
    errorEl.textContent = 'Please enable camera, screen sharing, and fullscreen to start the mock test.';
    errorEl.classList.remove('hidden');
    document.getElementById('btn-start-mock').disabled = false;
    return;
  }

  document.getElementById('verify-modal').classList.add('hidden');
  document.getElementById('exam-view').classList.remove('hidden');
  startLocalMonitoring();
  startTimer();
};

const cleanupStreams = () => {
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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

  aiMonitor = new AIMonitor(security, camStream, (msg, severity) => showToast(msg, severity));
  aiMonitor.start();
  aiMonitor.setScreenStream(screenStream);

  const camTrack = camStream?.getVideoTracks()[0];
  if (camTrack) camTrack.onended = () => showToast('Camera disconnected. This would be recorded in the real exam.', 'severe');
  const screenTrack = screenStream?.getVideoTracks()[0];
  if (screenTrack) screenTrack.onended = () => showToast('Screen sharing stopped. This would pause the real exam.', 'severe');
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
  msgEl.textContent = severity === 'severe' ? `${msg} This is not saved in the mock test.` : msg;
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
    if (me) memberRole = me.role;
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
  if (!submitted) localStorage.setItem(storageKey(), JSON.stringify({ answers }));
};

const restoreState = () => {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) answers = JSON.parse(raw).answers || {};
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
    card.innerHTML = `
      <div class="q-number">Question ${idx + 1}</div>
      <div class="q-text">${escapeHtml(q.text)}</div>
      <div class="q-options">
        ${q.options.map((opt, oi) => {
          const letter = letters[oi];
          return `<label class="q-option ${answers[idx] === letter ? 'selected' : ''}">
            <input type="radio" name="q${idx}" value="${letter}" ${answers[idx] === letter ? 'checked' : ''} />
            <span class="opt-letter">${letter}</span>
            <span>${escapeHtml(opt)}</span>
          </label>`;
        }).join('')}
      </div>
    `;
    container.appendChild(card);

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `palette-dot ${answers[idx] ? 'answered' : ''}`;
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
  updateAnswered();
};

const updateAnswered = () => {
  document.getElementById('answered-count').textContent = Object.keys(answers).length;
};

const startTimer = () => {
  const end = Date.now() + durationMs;
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
  await stopLocalMonitoring();

  let correctCount = 0;
  questions.forEach((q, idx) => {
    if (answers[idx] === q.correctAnswer) correctCount++;
  });
  const totalQuestions = questions.length;
  const score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;

  try {
    await setDoc(doc(db, 'teams', teamId, 'mock', currentUser.uid), {
      status: 'submitted',
      memberUid: currentUser.uid,
      memberEmail: currentUser.email,
      memberRole,
      score,
      correctCount,
      totalQuestions,
      answersCount: Object.keys(answers).length,
      submittedAt: serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('Failed to save mock score:', e);
  }

  localStorage.removeItem(storageKey());
  document.getElementById('exam-view').classList.add('hidden');
  document.querySelector('.exam-bar').classList.add('hidden');
  document.getElementById('submit-modal').classList.add('hidden');
  document.getElementById('submitted-view').classList.remove('hidden');
};

const escapeHtml = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

document.getElementById('btn-submit').addEventListener('click', () => {
  document.getElementById('submit-modal').classList.remove('hidden');
});
document.getElementById('btn-cancel-submit').addEventListener('click', () => {
  document.getElementById('submit-modal').classList.add('hidden');
});
document.getElementById('btn-confirm-submit').addEventListener('click', submitMock);
document.getElementById('btn-start-mock').addEventListener('click', startMock);
document.addEventListener('DOMContentLoaded', init);

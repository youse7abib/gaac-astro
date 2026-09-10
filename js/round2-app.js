import { auth, db, storage } from './exam-shared.js';
import {
  doc, getDoc, setDoc, serverTimestamp,
  collection, query, orderBy as orderByFS, onSnapshot,
  where, limit as fsLimit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref as storageRef, getBytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

let teamId = null;
let currentUser = null;
let memberName = '';
let memberEmail = '';
let currentRound = null;
let r2Questions = [];
let answersMap = {};
let r2ServerOffset = 0;
let r2CloseAt = 0;
let r2OpenAt = 0;
let currentLang = localStorage.getItem('gaac_lang') || 'en';
let timerInterval = null;
let confirmResolve = null;

const functions = getFunctions();
const getRound2Status = httpsCallable(functions, 'getRound2Status');
const getRound2Exam = httpsCallable(functions, 'getRound2Exam');

const R2_DEFAULTS = {
  qf: { openAt: Date.UTC(2026, 8, 13, 10, 0, 0), closeAt: Date.UTC(2026, 8, 13, 11, 0, 0) },
  sf: { openAt: Date.UTC(2026, 8, 13, 11, 30, 0), closeAt: Date.UTC(2026, 8, 13, 12, 30, 0) },
  fin: { openAt: Date.UTC(2026, 8, 13, 13, 0, 0), closeAt: Date.UTC(2026, 8, 13, 14, 0, 0) }
};



const DEMO_QUESTIONS = [
  { id: 'demo1', round: 'qf', order: 1, unit: 'kg', tolerancePct: 1, note: 'Demo Q1 — Mass of the Sun in kilograms.' },
  { id: 'demo2', round: 'qf', order: 2, unit: 'm/s', tolerancePct: 2, note: 'Demo Q2 — Speed of light in vacuum.' },
  { id: 'demo3', round: 'qf', order: 3, unit: 'K', tolerancePct: 5, note: 'Demo Q3 — Surface temperature of Sirius A.' },
  { id: 'demo4', round: 'qf', order: 4, unit: 'years', tolerancePct: 0.1, note: 'Demo Q4 — Age of the universe in years.' },
  { id: 'demo5', round: 'qf', order: 5, unit: 'pc', tolerancePct: 3, note: 'Demo Q5 — Distance to Andromeda in parsecs.' },
  { id: 'demo6', round: 'qf', order: 6, unit: 'AU', tolerancePct: 2, note: 'Demo Q6 — Semi-major axis of Mars orbit.' },
  { id: 'demo7', round: 'qf', order: 7, unit: 'W', tolerancePct: 5, note: 'Demo Q7 — Luminosity of the Sun in watts.' },
  { id: 'demo8', round: 'qf', order: 8, unit: 'km', tolerancePct: 1, note: 'Demo Q8 — Radius of Earth in kilometers.' },
  { id: 'demo9', round: 'qf', order: 9, unit: 'm', tolerancePct: 2, note: 'Demo Q9 — Schwarzschild radius of a 10 solar mass BH.' },
  { id: 'demo10', round: 'qf', order: 10, unit: 'Hz', tolerancePct: 3, note: 'Demo Q10 — Hydrogen 21-cm line frequency.' }
];

const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';

const R2_LABELS = {
  qf: { en: 'QUARTER-FINAL', ar: 'ربع النهائي' },
  sf: { en: 'SEMI-FINAL', ar: 'نصف النهائي' },
  fin: { en: 'FINAL', ar: 'النهائي' }
};

const serverNow = () => Date.now() + r2ServerOffset;

const showToast = (msg, severity = 'warning') => {
  const toast = document.getElementById('toast');
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

const ensureTeamMembership = async () => {
  try {
    const ref = doc(db, 'teamMembers', currentUser.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { teamId, email: currentUser.email });
    }
  } catch (e) {
    console.warn('[round2] Failed to create team membership doc:', e);
  }
};

const parseValue = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[,\s]/g, '');
  if (!s) return null;
  s = s.replace(/[x×*]10\^/gi, 'e');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const init = async () => {
  try {
    const params = new URLSearchParams(window.location.search);
    teamId = params.get('team');
    if (isDemo) {
      teamId = teamId || 'demo-team';
      currentUser = { uid: 'demo-uid', email: 'demo@gaac.local', displayName: 'Demo' };
      memberName = 'Demo Tester';
      memberEmail = 'demo@gaac.local';
      document.getElementById('team-info').textContent = teamId;
      document.getElementById('round-badge').textContent = 'QUARTER-FINAL (DEMO)';
      blockInteractions();
      bindLang();
      currentRound = 'qf';
      r2OpenAt = 0;
      r2CloseAt = Date.now() + 60 * 60 * 1000;
      r2Questions = DEMO_QUESTIONS.map((q) => ({ ...q, id: q.id }));
      document.getElementById('total-count').textContent = r2Questions.length;
      startTimer();
      renderQuestions();
      // Demo mode: no Firestore listener, no PDF load — show placeholder
      document.getElementById('answered-count').textContent = '0';
      const pdfPanel = document.getElementById('pdf-panel');
      const pdfLoading = document.getElementById('pdf-loading');
      if (pdfLoading) pdfLoading.classList.add('hidden');
      if (pdfPanel) {
        const placeholder = document.createElement('div');
        placeholder.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:300px;color:#8b9bb4;font-size:1rem;text-align:center;padding:40px;border:1px dashed rgba(255,255,255,0.1);border-radius:12px;';
        placeholder.innerHTML = '<div><div style="font-size:2rem;margin-bottom:12px;">📄</div><div>Demo Mode — No PDF loaded.<br>In the real exam, the question paper will appear here.</div></div>';
        pdfPanel.appendChild(placeholder);
      }
      return;
    }

    if (!teamId) { window.location.href = 'team-dashboard.html'; return; }

    const user = await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
    });
    if (!user) { window.location.href = 'team-dashboard.html'; return; }
    currentUser = user;

    await ensureTeamMembership();

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
        if (me) { memberName = me.name || me.email || 'Unknown'; memberEmail = me.email || currentUser.email; }
        else { memberName = currentUser.email; memberEmail = currentUser.email; }
      }
    } catch (e) { memberName = currentUser.email; memberEmail = currentUser.email; }

    document.getElementById('team-info').textContent = teamId;

    blockInteractions();
    bindLang();
    await loadRound();
  } catch (e) {
    console.error('[round2] init failed:', e);
    document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:#ff6b6b;font-size:1.2rem;text-align:center;padding:40px;flex-direction:column;gap:12px;">
      <div style="font-weight:700;">Failed to load Round 2</div>
      <div style="font-size:0.85rem;color:#8b9bb4;">${e.message || e}</div>
    </div>`;
  }
};

const loadRound = async () => {
  let statusData = {};
  try {
    const res = await getRound2Status();
    statusData = res.data || {};
  } catch (e) {
    console.warn('[round2] getRound2Status failed:', e.message);
  }

  if (typeof statusData.now === 'number') r2ServerOffset = statusData.now - Date.now();

  const rounds = statusData.rounds || {};
  const active = statusData.currentRound;
  const isOpen = statusData.round2Open !== false;

  if (!active || !isOpen || !rounds[active]) {
    showGate('not-scheduled');
    return;
  }

  currentRound = active;
  const rd = rounds[active];
  r2OpenAt = rd.openAt || R2_DEFAULTS[active]?.openAt || 0;
  r2CloseAt = rd.closeAt || R2_DEFAULTS[active]?.closeAt || 0;

  const now = serverNow();
  if (now < r2OpenAt) {
    showGate('waiting', r2OpenAt);
    return;
  }
  if (r2CloseAt && now > r2CloseAt) {
    showGate('closed');
    return;
  }

  const badge = document.getElementById('round-badge');
  const langLabel = currentLang === 'ar' ? (R2_LABELS[active]?.ar || active) : (R2_LABELS[active]?.en || active);
  badge.textContent = langLabel;

  try {
    const res = await getRound2Exam();
    const examData = res.data || {};
    r2Questions = (examData.questions || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  } catch (e) {
    console.warn('[round2] getRound2Exam failed:', e.message);
    r2Questions = [];
  }

  document.getElementById('total-count').textContent = r2Questions.length;

  renderQuestions();
  startTimer();
  loadAnswersRealtime();
  loadPdf();
};

const showGate = (reason, waitUntil = 0) => {
  const gate = document.getElementById('gate-screen');
  gate.classList.remove('hidden');
  document.querySelector('.r2-layout')?.classList.add('hidden');
  document.querySelector('.r2-footer')?.classList.add('hidden');
  document.querySelector('.exam-bar').classList.add('hidden');

  const isAr = currentLang === 'ar';
  const title = document.getElementById('gate-title');
  const msg = document.getElementById('gate-msg');
  const timer = document.getElementById('gate-timer');
  const sub = document.getElementById('gate-sub');

  if (reason === 'waiting') {
    title.innerHTML = isAr ? 'الجولة لم <span class="text-blue">تبدأ بعد</span>' : 'Round Not <span class="text-blue">Started</span>';
    msg.textContent = isAr ? 'انتظر فتح الجولة...' : 'Waiting for the round to open...';
    if (waitUntil) updateGateTimer(waitUntil);
  } else if (reason === 'closed') {
    title.innerHTML = isAr ? 'انتهت <span class="text-blue">الجولة</span>' : 'Round <span class="text-blue">Ended</span>';
    msg.textContent = isAr ? 'انتهت هذه الجولة.' : 'This round has ended.';
    timer.textContent = '';
    sub.textContent = '';
  } else {
    title.innerHTML = isAr ? 'الجولة غير <span class="text-blue">متاحة</span>' : 'Round Not <span class="text-blue">Available</span>';
    msg.textContent = isAr ? 'الجولة الحالية لم تُفعّل بعد.' : 'The current round has not been activated yet.';
    timer.textContent = '';
    sub.textContent = '';
  }
};

const updateGateTimer = (targetAt) => {
  const timerEl = document.getElementById('gate-timer');
  if (!timerEl) return;
  const tick = () => {
    const diff = targetAt - serverNow();
    if (diff <= 0) { timerEl.textContent = currentLang === 'ar' ? 'جاري التحديث...' : 'Refreshing...'; setTimeout(() => location.reload(), 3000); return; }
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    timerEl.textContent = h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  };
  tick();
  setInterval(tick, 1000);
};

const startTimer = () => {
  if (timerInterval) clearInterval(timerInterval);
  const display = document.getElementById('timer-display');
  const tick = () => {
    const diff = r2CloseAt - serverNow();
    if (diff <= 0) {
      display.textContent = '0:00';
      display.classList.add('warning');
      document.querySelectorAll('.r2-q-input').forEach(i => i.disabled = true);
      document.querySelectorAll('.r2-q-submit').forEach(b => b.disabled = true);
      clearInterval(timerInterval);
      showToast(currentLang === 'ar' ? 'انتهت الجولة' : 'Round ended', 'severe');
      return;
    }
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    display.textContent = `${m}:${String(s).padStart(2, '0')}`;
    if (diff < 300000) display.classList.add('warning');
  };
  tick();
  timerInterval = setInterval(tick, 1000);
};

const renderQuestions = () => {
  const container = document.getElementById('questions-container');
  if (!container) return;
  container.innerHTML = '';
  r2Questions.forEach((q) => {
    const existing = answersMap[q.id];
    const isLocked = !!existing;
    const card = document.createElement('div');
    card.className = 'r2-q-card' + (isLocked ? ' locked' : '');
    card.id = `qcard-${q.id}`;

    const noteHtml = q.note ? `<div class="r2-q-note">${escapeHtml(q.note)}</div>` : '';

    card.innerHTML = `
      <div class="r2-q-header">
        <span class="r2-q-number">Q${q.order}</span>
        <div class="r2-q-badges">
          ${q.unit ? `<span class="r2-q-badge unit">${escapeHtml(q.unit)}</span>` : ''}
          ${q.tolerancePct ? `<span class="r2-q-badge tol">&plusmn;${q.tolerancePct}%</span>` : ''}
        </div>
      </div>
      ${noteHtml}
      <div class="r2-q-input-row">
        <input type="text" class="r2-q-input" id="input-${q.id}" placeholder="e.g. 2.333e-9" ${isLocked ? 'disabled' : ''} autocomplete="off" inputmode="decimal" spellcheck="false" />
        <button class="r2-q-submit" id="submit-${q.id}" ${isLocked ? 'disabled' : ''}>${isLocked ? (currentLang === 'ar' ? 'مقفول' : 'Locked') : (currentLang === 'ar' ? 'إرسال' : 'Submit')}</button>
      </div>
      ${isLocked ? `<div class="r2-q-locked-info"><span class="lock-icon">&#128274;</span>${currentLang === 'ar' ? 'أجاب:' : 'Answered by:'} ${escapeHtml(existing.memberName || existing.memberEmail || 'Member')} &mdash; <code>${escapeHtml(existing.value)}</code></div>` : ''}
    `;

    if (!isLocked) {
      const submitBtn = card.querySelector(`#submit-${q.id}`);
      const inputEl = card.querySelector(`#input-${q.id}`);
      submitBtn.addEventListener('click', () => submitAnswer(q.id, q, inputEl));
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitAnswer(q.id, q, inputEl);
      });
    }

    container.appendChild(card);
  });
};

const submitAnswer = async (qid, q, inputEl) => {
  const raw = inputEl.value.trim();
  if (!raw) { showToast(currentLang === 'ar' ? 'أدخل قيمة أولاً' : 'Enter a value first.', 'warning'); return; }
  const numericValue = parseValue(raw);
  if (numericValue === null) { showToast(currentLang === 'ar' ? 'قيمة غير صالحة (استخدم صيغة علمية)' : 'Invalid value (use scientific notation if needed).', 'warning'); return; }

  const confirmed = await showConfirm(qid, raw, numericValue, q);
  if (!confirmed) return;

  if (isDemo) {
    // Demo mode: store locally, skip Firestore
    answersMap[qid] = {
      questionId: qid,
      value: raw,
      numericValue,
      unit: q.unit || '',
      memberUid: 'demo-uid',
      memberName: 'Demo Tester',
      memberEmail: 'demo@gaac.local',
      submittedAt: new Date().toISOString(),
      locked: true
    };
    const count = Object.keys(answersMap).length;
    document.getElementById('answered-count').textContent = count;
    renderQuestions();
    showToast('Demo: Submitted & Locked (local only)', 'success');
    return;
  }

  const inputElRef = inputEl;
  const submitBtnRef = document.getElementById(`submit-${qid}`);

  try {
    await setDoc(doc(db, 'teams', teamId, 'round2', currentRound, 'answers', qid), {
      questionId: qid,
      lockKey: `${teamId}|${currentRound}|${qid}`,
      value: raw,
      numericValue,
      unit: q.unit || '',
      tolerancePct: q.tolerancePct || 0,
      memberUid: currentUser.uid,
      memberName,
      memberEmail,
      submittedAt: serverTimestamp(),
      locked: true
    });
    showToast(currentLang === 'ar' ? 'تم الإرسال والقفل' : 'Submitted & Locked', 'success');
  } catch (e) {
    console.error('[round2] submit failed:', e);
    if (e.code === 'permission-denied' || (e.message && e.message.includes('permission-denied'))) {
      showToast(currentLang === 'ar' ? 'هذا السؤال مقفول بالفعل' : 'This question is already locked.', 'severe');
    } else {
      showToast(currentLang === 'ar' ? 'خطأ في الإرسال' : 'Submission failed. Try again.', 'severe');
    }
  }
};

const showConfirm = (qid, raw, numVal, q) => {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const modal = document.getElementById('confirm-modal');
    const text = document.getElementById('confirm-text');
    const btn = document.getElementById('btn-confirm-yes');
    const isAr = currentLang === 'ar';

    text.innerHTML = isAr
      ? `تأكيد إرسال إجابة السؤال Q${q.order}: <code style="color:var(--blue-light)">${escapeHtml(raw)}</code> (${q.unit || ''}). لا يمكن التغيير بعد الإرسال.`
      : `Submit answer for Q${q.order}: <code style="color:var(--blue-light)">${escapeHtml(raw)}</code> (${q.unit || ''}). This cannot be changed after submission.`;

    btn.onclick = () => { modal.classList.add('hidden'); confirmResolve(true); };
    modal.classList.remove('hidden');
  });
};

const loadAnswersRealtime = () => {
  if (!currentRound || !teamId) return;
  const q = query(
    collection(db, 'teams', teamId, 'round2', currentRound, 'answers')
  );
  onSnapshot(q, (snap) => {
    let count = 0;
    snap.forEach((d) => {
      const data = d.data();
      answersMap[d.id] = data;
      count++;
    });
    document.getElementById('answered-count').textContent = count;
    renderQuestions();
  }, (err) => {
    console.warn('[round2] answers onSnapshot error:', err);
  });
};

const loadPdf = async () => {
  const panel = document.getElementById('pdf-panel');
  const loading = document.getElementById('pdf-loading');

  try {
    const pdfPath = `round2/${currentRound}/questions.pdf`;
    const pdfRef = storageRef(storage, pdfPath);
    const arrayBuffer = await getBytes(pdfRef);

    if (typeof pdfjsLib === 'undefined') {
      loading.textContent = 'PDF viewer library failed to load.';
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    loading.classList.add('hidden');

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const scale = 1.3;
      const viewport = page.getViewport({ scale });

      const pageDiv = document.createElement('div');
      pageDiv.className = 'r2-pdf-page';

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;

      const overlay = document.createElement('div');
      overlay.className = 'r2-pdf-lock-overlay';

      pageDiv.appendChild(canvas);
      pageDiv.appendChild(overlay);
      panel.appendChild(pageDiv);
    }
  } catch (e) {
    console.error('[round2] PDF load failed:', e);
    loading.textContent = currentLang === 'ar' ? 'تعذر تحميل ملف الأسئلة' : 'Failed to load question paper.';
  }
};

const blockInteractions = () => {
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('copy', (e) => e.preventDefault());
  document.addEventListener('cut', (e) => e.preventDefault());
  document.addEventListener('paste', (e) => e.preventDefault());
  document.addEventListener('selectstart', (e) => {
    if (e.target.closest('.r2-q-input')) return;
    e.preventDefault();
  });
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') { e.preventDefault(); return; }
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'c' || k === 'u' || k === 's' || k === 'p') { e.preventDefault(); return; }
      if (e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) { e.preventDefault(); return; }
    }
    if (e.key === 'PrintScreen') { e.preventDefault(); return; }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen') { e.preventDefault(); return; }
  });
  window.addEventListener('beforeprint', (e) => e.preventDefault());
};

const bindLang = () => {
  const btn = document.getElementById('btn-lang-toggle');
  if (!btn) return;
  const update = () => { btn.textContent = currentLang === 'ar' ? 'عربي' : 'EN'; };
  update();
  btn.addEventListener('click', () => {
    currentLang = currentLang === 'en' ? 'ar' : 'en';
    localStorage.setItem('gaac_lang', currentLang);
    update();
    if (currentRound) {
      const badge = document.getElementById('round-badge');
      badge.textContent = currentLang === 'ar' ? (R2_LABELS[currentRound]?.ar || currentRound) : (R2_LABELS[currentRound]?.en || currentRound);
    }
    renderQuestions();
  });
};

const escapeHtml = (str) => {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

init();

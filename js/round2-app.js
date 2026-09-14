import { auth, db, storage } from './exam-shared.js';
import {
  doc, getDoc, setDoc, serverTimestamp,
  collection, query, orderBy as orderByFS, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref as storageRef, getBytes } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let teamId = null;
let currentUser = null;
let memberName = '';
let memberEmail = '';
let answersMap = {};
let timerInterval = null;
let confirmResolve = null;
let examDurationSec = 60 * 60; // 1 Hour (60 minutes)
let examEndTime = 0;

const ROUND8_EMAILS = new Set([
  'jinenustegegn0@gmail.com',
  'basaksayan55@gmail.com',
  'shadenzanati1@gmail.com',
  'nagutavictoria@gmail.com',
  'adityarajsamantray446@gmail.com',
  'rofaydatarek13@gmail.com'
].map(e => e.toLowerCase().trim()));

const ADMIN_EMAILS = new Set([
  'astronomyclub64@gmail.com'
]);

const R8_QUESTIONS = [
  {
    id: "r8_q1",
    order: 1,
    title: "Question 1: The North That Moved",
    topic: "Observational Astronomy",
    unit: "degrees (°)",
    note: "Find the new maximum altitude of the simulated Polaris above the northern horizon in degrees.",
    placeholder: "e.g. 33.8"
  },
  {
    id: "r8_q2",
    order: 2,
    title: "Question 2: The Silent Eclipse",
    topic: "Observational Astronomy",
    unit: "Earth radii (R_Earth)",
    note: "Work out the radius of the transiting object in Earth radii (R⊕).",
    placeholder: "e.g. 11.77"
  },
  {
    id: "r8_q3",
    order: 3,
    title: "Question 3: The Courier at Periapsis",
    topic: "Orbital Mechanics",
    unit: "km/s",
    note: "Deduce the courier's orbital speed at periapsis in km s⁻¹.",
    placeholder: "e.g. 36.5"
  },
  {
    id: "r8_q4",
    order: 4,
    title: "Question 4: The Star Behind the Glass",
    topic: "Astrophysics",
    unit: "ratio (R2 / R1)",
    note: "What is the ratio of the new radius to the original radius (dimensionless)?",
    placeholder: "e.g. 1.60"
  },
  {
    id: "r8_q5",
    order: 5,
    title: "Question 5: The World That Fell Through",
    topic: "Planetology",
    unit: "m/s²",
    note: "Uncover the surface gravitational acceleration of the Fallen World in m s⁻².",
    placeholder: "e.g. 9.66"
  },
  {
    id: "r8_q6",
    order: 6,
    title: "Question 6: The Red Thread",
    topic: "Observational Astronomy",
    unit: "km/s",
    note: "Read off the source's radial recession speed in km s⁻¹.",
    placeholder: "e.g. 398"
  },
  {
    id: "r8_q7",
    order: 7,
    title: "Question 7: The Ledger of Two Suns",
    topic: "Astrophysics",
    unit: "Solar masses (M_Sun)",
    note: "Recover the total mass of the binary system in solar masses (M☉).",
    placeholder: "e.g. 5.69"
  },
  {
    id: "r8_q8",
    order: 8,
    title: "Question 8: The Radius of the Invisible Furnace",
    topic: "Astrophysics",
    unit: "Solar masses (M_Sun)",
    note: "Reconstruct the mass of the black hole in solar masses (M☉).",
    placeholder: "e.g. 10.1"
  },
  {
    id: "r8_q9",
    order: 9,
    title: "Question 9: The Age Written in Red",
    topic: "Cosmology",
    unit: "billion years (Gyr)",
    note: "How old was the universe, in billions of years (Gyr), when the light began its journey?",
    placeholder: "e.g. 3.49"
  },
  {
    id: "r8_q10",
    order: 10,
    title: "Question 10: The Clock with Two Histories",
    topic: "Cosmology",
    unit: "billion years (Gyr)",
    note: "Pin down the cosmic age, in billions of years (Gyr), at which the signal was emitted.",
    placeholder: "e.g. 0.510"
  }
];

let r2Questions = R8_QUESTIONS;
let activeQid = 'r8_q1';

const isDemo = new URLSearchParams(window.location.search).get('demo') === '1';

const showToast = (msg, severity = 'warning') => {
  const toast = document.getElementById('toast');
  const msgEl = document.getElementById('toast-msg');
  if (!toast || !msgEl) return;
  msgEl.textContent = msg;
  toast.classList.remove('show', 'success');
  void toast.offsetWidth;
  if (severity === 'success') toast.classList.add('success');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show', 'success'), 5000);
};

const ensureTeamMembership = async () => {
  try {
    const ref = doc(db, 'teamMembers', currentUser.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { teamId, email: currentUser.email });
    }
  } catch (e) {
    console.warn('[round2] Team membership doc creation note:', e);
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
      teamId = teamId || 'GAAC-2026-DEMO';
      currentUser = { uid: 'demo-uid', email: 'demo@gaac.local' };
      memberName = 'Demo Participant';
      memberEmail = 'demo@gaac.local';
      setupExamEnvironment();
      return;
    }

    if (!teamId) {
      window.location.href = 'team-dashboard.html';
      return;
    }

    const user = await new Promise((resolve) => {
      const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u); });
    });

    if (!user) {
      window.location.href = 'team-dashboard.html';
      return;
    }
    currentUser = user;

    const emailClean = (currentUser.email || '').toLowerCase().trim();
    const isAllowed = ROUND8_EMAILS.has(emailClean) || ADMIN_EMAILS.has(emailClean);

    if (!isAllowed) {
      showGate('unauthorized');
      return;
    }

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
        const me = members.find(m => m.email?.toLowerCase().trim() === emailClean || m.uid === currentUser.uid);
        if (me) {
          memberName = me.name || me.email || 'Participant';
          memberEmail = me.email || currentUser.email;
        } else {
          memberName = currentUser.email;
          memberEmail = currentUser.email;
        }
      }
    } catch (e) {
      memberName = currentUser.email;
      memberEmail = currentUser.email;
    }

    setupExamEnvironment();
  } catch (e) {
    console.error('[round2] Init error:', e);
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;color:#ff6b6b;font-size:1.2rem;text-align:center;padding:40px;flex-direction:column;gap:12px;">
        <div style="font-weight:700;">Failed to load Round 2</div>
        <div style="font-size:0.85rem;color:#8b9bb4;">${e.message || e}</div>
        <a href="team-dashboard.html" style="color:#26b7ff;text-decoration:none;margin-top:10px;">Back to Dashboard</a>
      </div>`;
  }
};

const setupExamEnvironment = () => {
  document.getElementById('team-info').textContent = `${teamId} · ${memberName}`;
  document.getElementById('round-badge').textContent = 'ROUND OF 8 (5th–8th)';
  document.getElementById('total-count').textContent = r2Questions.length;

  blockInteractions();
  showRulesGate();
};

const showRulesGate = () => {
  const rulesGate = document.getElementById('rules-gate');
  const gateScreen = document.getElementById('gate-screen');
  const examLayout = document.querySelector('.r2-layout');
  const examBar = document.querySelector('.exam-bar');

  if (gateScreen) gateScreen.classList.add('hidden');
  if (examLayout) examLayout.classList.add('hidden');
  if (examBar) examBar.classList.add('hidden');
  if (rulesGate) rulesGate.classList.remove('hidden');

  const cb = document.getElementById('rules-agree-cb');
  const startBtn = document.getElementById('btn-start-exam');

  if (cb && startBtn) {
    cb.checked = false;
    startBtn.disabled = true;
    startBtn.style.opacity = '0.4';
    startBtn.style.cursor = 'not-allowed';

    cb.addEventListener('change', () => {
      startBtn.disabled = !cb.checked;
      startBtn.style.opacity = cb.checked ? '1' : '0.4';
      startBtn.style.cursor = cb.checked ? 'pointer' : 'not-allowed';
    });

    startBtn.addEventListener('click', () => {
      if (!cb.checked) return;
      rulesGate.classList.add('hidden');
      startExam();
    });
  }
};

const startExam = () => {
  const examLayout = document.querySelector('.r2-layout');
  const examBar = document.querySelector('.exam-bar');

  if (examLayout) examLayout.classList.remove('hidden');
  if (examBar) examBar.classList.remove('hidden');

  // Check stored start time or set fresh 60-min timer
  const storageKey = `gaac_r8_start_${teamId}`;
  let storedStart = localStorage.getItem(storageKey);
  let startMs = storedStart ? Number(storedStart) : Date.now();
  if (!storedStart) {
    localStorage.setItem(storageKey, String(startMs));
  }

  examEndTime = startMs + (examDurationSec * 1000);

  startTimer();
  renderQuestions();
  loadPdf();
  if (!isDemo) {
    loadAnswersRealtime();
  }
};

const showGate = (reason) => {
  const gate = document.getElementById('gate-screen');
  const rulesGate = document.getElementById('rules-gate');
  const examLayout = document.querySelector('.r2-layout');
  const examBar = document.querySelector('.exam-bar');

  if (rulesGate) rulesGate.classList.add('hidden');
  if (examLayout) examLayout.classList.add('hidden');
  if (examBar) examBar.classList.add('hidden');
  if (gate) gate.classList.remove('hidden');

  const title = document.getElementById('gate-title');
  const msg = document.getElementById('gate-msg');
  const sub = document.getElementById('gate-sub');

  if (reason === 'unauthorized') {
    title.innerHTML = 'Access <span class="text-blue">Denied</span>';
    msg.textContent = 'This exam stage is reserved strictly for qualified Round of 8 teams.';
    sub.textContent = 'Please return to your team dashboard.';
  } else {
    title.innerHTML = 'Round Not <span class="text-blue">Available</span>';
    msg.textContent = 'The competition stage is currently inactive.';
    sub.textContent = '';
  }
};

const startTimer = () => {
  if (timerInterval) clearInterval(timerInterval);
  const display = document.getElementById('timer-display');

  const tick = () => {
    const diff = examEndTime - Date.now();
    if (diff <= 0) {
      display.textContent = '00:00';
      display.classList.add('warning');
      document.querySelectorAll('.r2-q-input').forEach(i => i.disabled = true);
      document.querySelectorAll('.r2-q-submit').forEach(b => b.disabled = true);
      clearInterval(timerInterval);
      showToast('Exam time has ended. Answers are locked.', 'warning');
      return;
    }
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (diff < 300000) display.classList.add('warning');
  };

  tick();
  timerInterval = setInterval(tick, 1000);
};

const updateProgressFill = () => {
  const total = r2Questions.length;
  const done = Object.keys(answersMap).length;
  const fill = document.getElementById('progress-fill');
  if (fill && total > 0) fill.style.width = `${Math.round((done / total) * 100)}%`;
  const answeredEl = document.getElementById('answered-count');
  if (answeredEl) answeredEl.textContent = done;
};

const renderQuestions = () => {
  const container = document.getElementById('questions-container');
  const tabBar = document.getElementById('tabs-header');
  if (!container) return;

  updateProgressFill();

  if (tabBar) {
    tabBar.innerHTML = '';
    r2Questions.forEach((q) => {
      const isDone = !!answersMap[q.id];
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'r2-tab-btn' + (isDone ? ' tab-done' : '') + (q.id === activeQid ? ' active' : '');
      tab.id = `tab-${q.id}`;
      tab.innerHTML = `<span class="tab-dot"></span>Q${q.order}`;
      tab.addEventListener('click', () => {
        if (activeQid === q.id) return;
        activeQid = q.id;
        renderQuestions();
      });
      tabBar.appendChild(tab);
    });
  }

  container.innerHTML = '';
  const q = r2Questions.find((qq) => qq.id === activeQid);
  if (!q) return;
  const existing = answersMap[q.id];
  const isLocked = !!existing;

  const card = document.createElement('div');
  card.className = 'r2-q-card active';
  card.id = `qcard-${q.id}`;

  const noteHtml = q.note ? `<div class="r2-q-note">${escapeHtml(q.note)}</div>` : '';

  card.innerHTML = `
    <div class="r2-q-header">
      <span class="r2-q-number">Q${q.order} · ${escapeHtml(q.title)}</span>
      <div class="r2-q-badges">
        ${q.topic ? `<span class="r2-q-badge tol">${escapeHtml(q.topic)}</span>` : ''}
        ${q.unit ? `<span class="r2-q-badge unit">Unit: ${escapeHtml(q.unit)}</span>` : ''}
      </div>
    </div>
    ${noteHtml}
    ${isLocked
      ? `<div class="r2-q-locked">
           <div class="r2-q-locked-label">Submitted &amp; Locked</div>
           <div class="r2-q-locked-value">${escapeHtml(existing.value)} <span style="font-size:0.8rem;color:#26b7ff;font-weight:600;">${escapeHtml(existing.unit || q.unit || '')}</span></div>
           <div class="r2-q-locked-by">Locked by ${escapeHtml(existing.memberName || existing.memberEmail || 'Team Member')}</div>
         </div>`
      : `<div style="display:flex;flex-direction:column;gap:8px;">
           <div style="font-size:0.75rem;color:#94a3b8;">Required submission unit: <strong style="color:#26b7ff;">${escapeHtml(q.unit || 'Standard')}</strong></div>
           <div class="r2-q-input-row">
             <input type="text" class="r2-q-input" id="input-${q.id}" placeholder="${escapeHtml(q.placeholder || 'e.g. 1.25')}" autocomplete="off" inputmode="decimal" spellcheck="false" />
             <button class="r2-q-submit" id="submit-${q.id}">Lock Answer</button>
           </div>
         </div>`
    }
  `;

  if (!isLocked) {
    const submitBtn = card.querySelector(`#submit-${q.id}`);
    const inputEl = card.querySelector(`#input-${q.id}`);
    if (submitBtn && inputEl) {
      submitBtn.addEventListener('click', () => submitAnswer(q.id, q, inputEl));
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitAnswer(q.id, q, inputEl);
      });
      requestAnimationFrame(() => inputEl.focus());
    }
  }

  container.appendChild(card);
};

const submitAnswer = async (qid, q, inputEl) => {
  const raw = inputEl.value.trim();
  if (!raw) {
    showToast('Please enter a numerical value first.', 'warning');
    return;
  }
  const numericValue = parseValue(raw);
  if (numericValue === null) {
    showToast('Invalid numerical value. Use standard decimal or scientific notation (e.g. 3.65e4).', 'warning');
    return;
  }

  const confirmed = await showConfirm(qid, raw, numericValue, q);
  if (!confirmed) return;

  if (isDemo) {
    answersMap[qid] = {
      questionId: qid,
      order: q.order,
      title: q.title,
      value: raw,
      numericValue,
      unit: q.unit || '',
      memberUid: 'demo-uid',
      memberName: 'Demo Participant',
      memberEmail: 'demo@gaac.local',
      submittedAt: new Date().toISOString(),
      locked: true
    };
    advanceToNextQuestion();
    renderQuestions();
    showToast('Answer locked successfully', 'success');
    return;
  }

  try {
    const answerData = {
      questionId: qid,
      order: q.order,
      title: q.title,
      value: raw,
      numericValue: numericValue,
      unit: q.unit || '',
      tolerancePct: 0,
      lockKey: `${teamId}|r8|${qid}`,
      memberUid: currentUser.uid,
      memberName: memberName,
      memberEmail: memberEmail,
      teamId: teamId,
      submittedAt: serverTimestamp(),
      locked: true
    };

    // 1. Save question doc in subcollection
    await setDoc(doc(db, 'teams', teamId, 'round2', 'r8', 'answers', qid), answerData);

    // 2. Also record in user exam doc for tracking
    await setDoc(doc(db, 'registrations', teamId, 'exam', `${currentUser.uid}_round2`), {
      examType: 'round2_r8',
      stage: 'r8',
      memberUid: currentUser.uid,
      memberEmail: memberEmail,
      memberName: memberName,
      status: (Object.keys(answersMap).length + 1 >= r2Questions.length) ? 'submitted' : 'in-progress',
      answersCount: Object.keys(answersMap).length + 1,
      lastSubmittedAt: serverTimestamp()
    }, { merge: true });

    answersMap[qid] = answerData;
    advanceToNextQuestion();
    renderQuestions();
    showToast('Answer submitted and permanently locked.', 'success');
  } catch (e) {
    console.error('[round2] Submit error:', e);
    showToast('Submission error. Please check your network and retry.', 'warning');
  }
};

const advanceToNextQuestion = () => {
  const nextOpen = r2Questions.find((qq) => !answersMap[qq.id]);
  if (nextOpen) {
    activeQid = nextOpen.id;
  }
};

const closeConfirm = () => {
  const modal = document.getElementById('confirm-modal');
  if (modal) modal.classList.remove('open');
};

const showConfirm = (qid, raw, numVal, q) => {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    const modal = document.getElementById('confirm-modal');
    const qnumEl = document.getElementById('confirm-qnum');
    const valueEl = document.getElementById('confirm-value');
    const unitEl = document.getElementById('confirm-unit');
    const yesBtn = document.getElementById('btn-confirm-yes');
    const noBtn = document.getElementById('btn-confirm-no');

    if (qnumEl) qnumEl.textContent = `Q${q.order}: ${q.title}`;
    if (valueEl) valueEl.textContent = raw;
    if (unitEl) unitEl.innerHTML = `Required Unit: <strong style="color:#26b7ff;">${escapeHtml(q.unit || 'Standard')}</strong>`;

    const newYes = yesBtn.cloneNode(true);
    const newNo = noBtn.cloneNode(true);
    yesBtn.replaceWith(newYes);
    noBtn.replaceWith(newNo);

    newYes.addEventListener('click', () => { closeConfirm(); confirmResolve(true); });
    newNo.addEventListener('click', () => { closeConfirm(); confirmResolve(false); });

    modal.classList.add('open');
  });
};

const loadAnswersRealtime = () => {
  if (!teamId) return;
  try {
    const q = query(
      collection(db, 'teams', teamId, 'round2', 'r8', 'answers')
    );
    onSnapshot(q, (snap) => {
      let count = 0;
      snap.forEach((d) => {
        const data = d.data();
        answersMap[d.id] = data;
        count++;
      });
      updateProgressFill();
      renderQuestions();
    }, (err) => {
      console.warn('[round2] Realtime listener notice:', err);
    });
  } catch (e) {
    console.warn('[round2] Realtime setup error:', e);
  }
};

const loadPdf = async () => {
  const panel = document.getElementById('pdf-panel');
  const loading = document.getElementById('pdf-loading');

  try {
    if (typeof pdfjsLib === 'undefined') {
      if (loading) loading.textContent = 'PDF viewer library failed to load.';
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    let pdfData = null;

    // Load from project PDF path
    try {
      const resp = await fetch('pdf/Round2_Stage1_Best5th_8th.pdf');
      if (resp.ok) {
        pdfData = await resp.arrayBuffer();
      }
    } catch (_) {}

    // Fallback to storage if needed
    if (!pdfData) {
      try {
        const pdfRef = storageRef(storage, 'round2/r8/questions.pdf');
        pdfData = await getBytes(pdfRef);
      } catch (_) {}
    }

    if (!pdfData) {
      if (loading) loading.textContent = 'Question paper could not be fetched.';
      return;
    }

    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    if (loading) loading.classList.add('hidden');

    panel.innerHTML = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const scale = 1.35;
      const viewport = page.getViewport({ scale });

      const pageDiv = document.createElement('div');
      pageDiv.className = 'r2-pdf-page';
      pageDiv.style.position = 'relative';

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: ctx, viewport }).promise;

      const overlay = document.createElement('div');
      overlay.className = 'r2-pdf-lock-overlay';
      overlay.style.cssText = 'position:absolute;inset:0;z-index:10;background:transparent;user-select:none;pointer-events:none;';

      pageDiv.appendChild(canvas);
      pageDiv.appendChild(overlay);
      panel.appendChild(pageDiv);
    }
  } catch (e) {
    console.error('[round2] PDF rendering error:', e);
    if (loading) loading.textContent = 'Failed to load question paper.';
  }
};

const blockInteractions = () => {
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('copy', (e) => e.preventDefault());
  document.addEventListener('cut', (e) => e.preventDefault());
  document.addEventListener('paste', (e) => {
    if (!e.target.closest('.r2-q-input')) e.preventDefault();
  });
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

const escapeHtml = (str) => {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

init();


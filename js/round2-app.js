import { auth, db, storage } from './exam-shared.js';
import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp,
  collection, query, orderBy as orderByFS, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { ref as storageRef, getBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

let teamId = null;
let stageKey = 'r8'; // 'r8' or 'sf'
let stageName = 'ROUND OF 8 (5th–8th)';
let pdfStoragePath = 'round2/r8/questions.pdf';
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

const SEMIFINAL_EMAILS = new Set([
  'mralbakk@gmail.com',
  'ramyramadan0120@gmail.com',
  'vlad.toncu224@gmail.com',
  'mihai.tesileanu2@gmail.com',
  'matei.butnaru@yahoo.com',
  'badr.e.h.edu@gmail.com'
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

const SF_QUESTIONS = [
  {
    id: "sf_q1",
    order: 1,
    title: "Question 11: The Photograph with No Distance",
    topic: "Observational Astronomy",
    unit: "parsecs (pc)",
    note: "Infer the distance to Sable One in parsecs.",
    placeholder: "e.g. 174"
  },
  {
    id: "sf_q2",
    order: 2,
    title: "Question 12: The Blue Line of the Prisoner",
    topic: "Observational Astronomy",
    unit: "km/s",
    note: "Separate the star's own motion: what is its radial recession velocity in km s⁻¹?",
    placeholder: "e.g. 91.7"
  },
  {
    id: "sf_q3",
    order: 3,
    title: "Question 13: The Road Between Worlds",
    topic: "Orbital Mechanics",
    unit: "km/s",
    note: "Determine the total Δv required for the transfer in km s⁻¹.",
    placeholder: "e.g. 10.41"
  },
  {
    id: "sf_q4",
    order: 4,
    title: "Question 14: The White Star's Hidden Weight",
    topic: "Astrophysics",
    unit: "nanometres (nm)",
    note: "Estimate the increase in wavelength, Δλ, in nanometres.",
    placeholder: "e.g. 0.106"
  },
  {
    id: "sf_q5",
    order: 5,
    title: "Question 15: The Furnace with No Flame",
    topic: "Astrophysics",
    unit: "Solar radii (R_Sun)",
    note: "Extract the star's radius in solar radii (R☉).",
    placeholder: "e.g. 2.00"
  },
  {
    id: "sf_q6",
    order: 6,
    title: "Question 16: The Engine Beneath Hades",
    topic: "Astrophysics",
    unit: "kg/s",
    note: "Resolve the corresponding mass accretion rate in kg s⁻¹.",
    placeholder: "e.g. 6.98e22"
  },
  {
    id: "sf_q7",
    order: 7,
    title: "Question 17: The Pulse that Spent a Century",
    topic: "Astrophysics",
    unit: "watts (W)",
    note: "Establish the average rotational energy loss rate in watts.",
    placeholder: "e.g. 1.23e31"
  },
  {
    id: "sf_q8",
    order: 8,
    title: "Question 18: The Moon that Refused the Dark",
    topic: "Planetology",
    unit: "kelvin (K)",
    note: "Assess the equilibrium temperature of the moon in kelvin.",
    placeholder: "e.g. 518"
  },
  {
    id: "sf_q9",
    order: 9,
    title: "Question 19: The Weight of the Empty Universe",
    topic: "Cosmology",
    unit: "kg/m³",
    note: "Weigh the present matter density in kg m⁻³.",
    placeholder: "e.g. 2.76e-27"
  },
  {
    id: "sf_q10",
    order: 10,
    title: "Question 20: The Hourglass at the Edge",
    topic: "Cosmology",
    unit: "billion years (Gyr)",
    note: "Find the time remaining from today until the Big Rip, in billions of years.",
    placeholder: "e.g. 18.6"
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
  setTimeout(() => toast.classList.remove('show', 'success'), 4000);
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
    const explicitStage = (params.get('stage') || '').toLowerCase().trim();

    if (isDemo) {
      teamId = teamId || 'GAAC-2026-DEMO';
      currentUser = { uid: 'demo-uid', email: 'demo@gaac.local' };
      memberName = 'Demo Participant';
      memberEmail = 'demo@gaac.local';
      setupStageEnvironment(explicitStage || 'sf');
      setupExamEnvironment();
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
    const isAdmin = ADMIN_EMAILS.has(emailClean);

    if (!teamId) {
      if (isAdmin) {
        teamId = 'GAAC-ADMIN';
      } else {
        window.location.href = 'team-dashboard.html';
        return;
      }
    }

    // Determine stage
    let chosenStage = explicitStage;
    if (!chosenStage) {
      if (SEMIFINAL_EMAILS.has(emailClean)) {
        chosenStage = 'sf';
      } else {
        chosenStage = 'r8';
      }
    }

    setupStageEnvironment(chosenStage);

    const isAllowed = (chosenStage === 'sf' ? SEMIFINAL_EMAILS.has(emailClean) : ROUND8_EMAILS.has(emailClean)) || isAdmin;

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

const setupStageEnvironment = (stage) => {
  if (stage === 'sf' || stage === 'semifinals' || stage === 'semis') {
    stageKey = 'sf';
    stageName = 'SEMI-FINALS';
    pdfStoragePath = 'round2/sf/questions.pdf';
    r2Questions = SF_QUESTIONS;
    activeQid = 'sf_q1';
  } else {
    stageKey = 'r8';
    stageName = 'ROUND OF 8 (5th–8th)';
    pdfStoragePath = 'round2/r8/questions.pdf';
    r2Questions = R8_QUESTIONS;
    activeQid = 'r8_q1';
  }
};

const setupExamEnvironment = () => {
  document.getElementById('team-info').textContent = `${teamId} · ${memberName}`;
  document.getElementById('round-badge').textContent = stageName;
  document.getElementById('total-count').textContent = r2Questions.length;

  blockInteractions();
  showRulesGate();

  const emailClean = (currentUser.email || '').toLowerCase().trim();
  if (ADMIN_EMAILS.has(emailClean) || isDemo) {
    setupAdminReset();
  }
};

const setupAdminReset = () => {
  const resetBtn = document.getElementById('btn-admin-reset');
  if (!resetBtn) return;
  resetBtn.style.display = 'inline-flex';

  resetBtn.addEventListener('click', async () => {
    const confirmReset = window.confirm('Reset this exam session? This will clear all submitted answers for this stage, reset the 1-hour timer, and unlock all questions.');
    if (!confirmReset) return;

    resetBtn.disabled = true;
    resetBtn.textContent = 'Resetting...';

    try {
      // 1. Clear localStorage timer
      const storageKey = `gaac_${stageKey}_start_${teamId}`;
      localStorage.removeItem(storageKey);

      // 2. Delete all answers from Firestore
      const deletePromises = [];
      r2Questions.forEach((q) => {
        deletePromises.push(deleteDoc(doc(db, 'registrations', teamId, 'round2', stageKey, 'answers', q.id)).catch(() => {}));
        deletePromises.push(deleteDoc(doc(db, 'teams', teamId, 'round2', stageKey, 'answers', q.id)).catch(() => {}));
      });
      deletePromises.push(deleteDoc(doc(db, 'registrations', teamId, 'exam', `${currentUser.uid}_round2`)).catch(() => {}));

      await Promise.all(deletePromises);

      // 3. Reset local state
      answersMap = {};
      const newStartMs = Date.now();
      localStorage.setItem(storageKey, String(newStartMs));
      examEndTime = newStartMs + (examDurationSec * 1000);

      activeQid = r2Questions[0].id;
      renderQuestions();
      startTimer();

      showToast('Exam reset successfully! You can test from the beginning.', 'success');
    } catch (err) {
      console.error('[round2] Reset error:', err);
      showToast('Reset completed with notice.', 'success');
    } finally {
      resetBtn.disabled = false;
      resetBtn.textContent = 'Reset Exam (Admin)';
    }
  });
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
  const storageKey = `gaac_${stageKey}_start_${teamId}`;
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

const startTimer = () => {
  const display = document.getElementById('timer-display');
  if (timerInterval) clearInterval(timerInterval);

  const update = () => {
    const now = Date.now();
    const remaining = Math.max(0, Math.floor((examEndTime - now) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    if (display) {
      display.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (remaining <= 300) display.classList.add('warning');
    }
    if (remaining <= 0) {
      clearInterval(timerInterval);
      finishExam();
    }
  };

  update();
  timerInterval = setInterval(update, 1000);
};

const finishExam = () => {
  document.querySelectorAll('.r2-q-input, .r2-q-submit').forEach((el) => {
    el.disabled = true;
  });
  showGate('finished');
};

const showGate = (mode) => {
  const gate = document.getElementById('gate-screen');
  const title = document.getElementById('gate-title');
  const msg = document.getElementById('gate-msg');
  const sub = document.getElementById('gate-sub');
  const timer = document.getElementById('gate-timer');
  const rulesGate = document.getElementById('rules-gate');
  const examLayout = document.querySelector('.r2-layout');
  const examBar = document.querySelector('.exam-bar');

  if (rulesGate) rulesGate.classList.add('hidden');
  if (examLayout) examLayout.classList.add('hidden');
  if (examBar) examBar.classList.add('hidden');
  if (gate) gate.classList.remove('hidden');

  if (mode === 'unauthorized') {
    if (title) title.innerHTML = 'Not <span class="text-blue">Authorized</span>';
    if (msg) msg.textContent = 'Your account is not registered for this stage of GAAC Round 2.';
    if (sub) sub.textContent = 'Please return to your team dashboard.';
    if (timer) timer.textContent = '';
  } else if (mode === 'finished') {
    if (title) title.innerHTML = 'Exam <span class="text-blue">Completed</span>';
    if (msg) msg.textContent = 'Your 1-hour exam session has ended and your answers have been recorded.';
    if (sub) sub.textContent = 'Thank you for participating! Results will be announced soon.';
    if (timer) timer.textContent = '00:00';
  }
};

const renderQuestions = () => {
  const tabsHeader = document.getElementById('tabs-header');
  const container = document.getElementById('questions-container');
  if (!tabsHeader || !container) return;

  tabsHeader.innerHTML = '';
  container.innerHTML = '';

  r2Questions.forEach((q) => {
    const isAnswered = Boolean(answersMap[q.id]);
    const isActive = q.id === activeQid;

    const tabBtn = document.createElement('button');
    tabBtn.className = `r2-tab-btn ${isActive ? 'active' : ''} ${isAnswered ? 'tab-done' : ''}`;
    tabBtn.innerHTML = `<span class="tab-dot"></span>Q${q.order}`;
    tabBtn.addEventListener('click', () => {
      activeQid = q.id;
      renderQuestions();
    });
    tabsHeader.appendChild(tabBtn);

    const card = document.createElement('div');
    card.className = `r2-q-card ${isActive ? 'active' : ''}`;
    card.id = `card-${q.id}`;

    let inputAreaHtml = '';
    if (isAnswered) {
      const a = answersMap[q.id];
      inputAreaHtml = `
        <div class="r2-q-locked">
          <span class="r2-q-locked-label">Submitted &amp; Locked</span>
          <span class="r2-q-locked-value">${escapeHtml(a.value)} <span style="font-size:0.75rem;color:#26b7ff;">${escapeHtml(a.unit || q.unit || '')}</span></span>
          <span class="r2-q-locked-by">Submitted by ${escapeHtml(a.memberName || 'team member')}</span>
        </div>
      `;
    } else {
      inputAreaHtml = `
        <div class="r2-q-input-row">
          <input type="text" class="r2-q-input" id="input-${q.id}" placeholder="${escapeHtml(q.placeholder || 'Enter value')}" autocomplete="off" spellcheck="false" />
          <button class="r2-q-submit" id="submit-${q.id}">Submit</button>
        </div>
      `;
    }

    card.innerHTML = `
      <div class="r2-q-header">
        <span class="r2-q-number">${escapeHtml(q.title)}</span>
        <div class="r2-q-badges">
          <span class="r2-q-badge unit">Unit: ${escapeHtml(q.unit || 'Standard')}</span>
          <span class="r2-q-badge tol">${escapeHtml(q.topic || '')}</span>
        </div>
      </div>
      <div class="r2-q-note">${escapeHtml(q.note || '')}</div>
      ${inputAreaHtml}
    `;

    container.appendChild(card);

    if (!isAnswered) {
      const btn = card.querySelector(`#submit-${q.id}`);
      const inp = card.querySelector(`#input-${q.id}`);
      if (btn && inp) {
        btn.addEventListener('click', () => submitAnswer(q.id, q, inp));
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitAnswer(q.id, q, inp);
          }
        });
      }
    }
  });

  updateProgressFill();
};

const updateProgressFill = () => {
  const answered = Object.keys(answersMap).length;
  const total = r2Questions.length;
  const fill = document.getElementById('progress-fill');
  const countEl = document.getElementById('answered-count');
  if (fill) fill.style.width = `${Math.min(100, Math.round((answered / total) * 100))}%`;
  if (countEl) countEl.textContent = answered;
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
      lockKey: `${teamId}|${stageKey}|${qid}`,
      memberUid: currentUser.uid,
      memberName: memberName,
      memberEmail: memberEmail,
      teamId: teamId,
      submittedAt: serverTimestamp(),
      locked: true
    };

    // 1. Write answer in registrations/{teamId}/round2/{stageKey}/answers/{qid}
    try {
      await setDoc(doc(db, 'registrations', teamId, 'round2', stageKey, 'answers', qid), answerData);
    } catch (e1) {
      console.warn('[round2] Primary answers write notice:', e1);
    }

    // 2. Also write in teams/{teamId}/round2/{stageKey}/answers/{qid}
    try {
      await setDoc(doc(db, 'teams', teamId, 'round2', stageKey, 'answers', qid), answerData);
    } catch (e2) {
      console.warn('[round2] Secondary answers write notice:', e2);
    }

    // 3. User exam progress doc
    try {
      await setDoc(doc(db, 'registrations', teamId, 'exam', `${currentUser.uid}_round2`), {
        examType: `round2_${stageKey}`,
        stage: stageKey,
        memberUid: currentUser.uid,
        memberEmail: memberEmail,
        memberName: memberName,
        status: (Object.keys(answersMap).length + 1 >= r2Questions.length) ? 'submitted' : 'in-progress',
        answersCount: Object.keys(answersMap).length + 1,
        lastSubmittedAt: serverTimestamp()
      }, { merge: true });
    } catch (e3) {
      console.warn('[round2] Exam progress doc notice:', e3);
    }

    answersMap[qid] = answerData;
    advanceToNextQuestion();
    renderQuestions();
    showToast('Answer submitted and locked successfully.', 'success');
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
      collection(db, 'registrations', teamId, 'round2', stageKey, 'answers')
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
      console.warn('[round2] Primary listener notice:', err);
    });

    // Also fallback listener
    const qFallback = query(
      collection(db, 'teams', teamId, 'round2', stageKey, 'answers')
    );
    onSnapshot(qFallback, (snap) => {
      snap.forEach((d) => {
        if (!answersMap[d.id]) {
          answersMap[d.id] = d.data();
        }
      });
      updateProgressFill();
      renderQuestions();
    }, () => {});
  } catch (e) {
    console.warn('[round2] Realtime setup error:', e);
  }
};

const loadPdf = async () => {
  const panel = document.getElementById('pdf-panel');
  const loading = document.getElementById('pdf-loading');

  try {
    if (typeof pdfjsLib === 'undefined') {
      if (loading) loading.textContent = 'PDF viewer library failed to load. Please refresh.';
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

    if (loading) loading.textContent = 'Fetching question paper...';

    let pdfData = null;
    const pdfRef = storageRef(storage, pdfStoragePath);

    // Attempt 1: getBytes
    try {
      pdfData = await getBytes(pdfRef);
    } catch (err) {
      console.warn('[round2] getBytes error, trying getDownloadURL fallback:', err);
    }

    // Attempt 2: getDownloadURL
    if (!pdfData) {
      try {
        const url = await getDownloadURL(pdfRef);
        const resp = await fetch(url);
        if (resp.ok) {
          pdfData = await resp.arrayBuffer();
        }
      } catch (err2) {
        console.warn('[round2] getDownloadURL fallback error:', err2);
      }
    }

    if (!pdfData) {
      if (loading) loading.innerHTML = 'Question paper could not be loaded from secure storage.<br><button onclick="window.location.reload()" style="margin-top:10px;padding:6px 14px;background:#26b7ff;border:none;border-radius:8px;color:#000;font-weight:700;cursor:pointer;">Retry</button>';
      return;
    }

    if (loading) loading.textContent = 'Rendering question paper in high resolution...';

    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    if (loading) loading.classList.add('hidden');

    panel.innerHTML = '';

    // Calculate ultra-crisp high-DPI resolution
    const dpr = window.devicePixelRatio || 1;
    const renderScale = Math.max(dpr * 1.5, 2.0);

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: renderScale });

      const pageDiv = document.createElement('div');
      pageDiv.className = 'r2-pdf-page';
      pageDiv.style.cssText = 'position:relative; width:100%; max-width:850px; display:flex; justify-content:center; margin-bottom:16px;';

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.cssText = 'width:100%; height:auto; display:block; border-radius:10px; box-shadow:0 4px 24px rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.06);';

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
    if (loading) loading.innerHTML = `Failed to render question paper (${e.message || 'error'}).<br><button onclick="window.location.reload()" style="margin-top:10px;padding:6px 14px;background:#26b7ff;border:none;border-radius:8px;color:#000;font-weight:700;cursor:pointer;">Retry</button>`;
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

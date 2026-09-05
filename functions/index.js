const functions = require('firebase-functions');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
admin.initializeApp();

const db = getFirestore();
const deleteField = () => FieldValue.delete();

/* ─────────────────────────────────────────────────────────────
   Roster / account helpers (admin cleanup + direct add-member)
   ───────────────────────────────────────────────────────────── */
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const crypto = require('crypto');

// Resolve a person's Firebase Auth uid from either the email index doc or,
// failing that, straight from Firebase Auth (handles FULL orphans whose
// Firestore records were already deleted).
async function resolveUidByEmail(email) {
  if (!email) return null;
  try {
    const snap = await db.collection('registeredEmails').doc(email).get();
    if (snap.exists && snap.data().uid) return snap.data().uid;
  } catch (e) { /* ignore */ }
  try {
    const user = await getAuth().getUserByEmail(email);
    return user.uid;
  } catch (e) { return null; }
}

// Recursively delete a collection (subcollections under a team doc).
async function deleteCollectionRecursive(path) {
  const snap = await db.collection(path).get();
  let batch = db.batch();
  let count = 0;
  snap.docs.forEach((d) => { batch.delete(d.ref); count++; });
  await batch.commit();
  if (count >= 400) await deleteCollectionRecursive(path);
}

// Remove a person from a registration doc by role. If that empties the team,
// tear the ghost registration down (team-name index + registrations + teams
// summary + exam/events subcollections).
async function clearPersonFromRegistration(registrationId, email, outcome) {
  const regSnap = await db.collection('registrations').doc(registrationId).get();
  if (!regSnap.exists) return;
  const reg = regSnap.data();

  const updates = {};
  if (reg.leader && normalizeEmail(reg.leader.email) === email) updates.leader = deleteField();
  if (reg.member2 && normalizeEmail(reg.member2.email) === email) updates.member2 = deleteField();
  if (reg.member3 && normalizeEmail(reg.member3.email) === email) updates.member3 = deleteField();
  if (Object.keys(updates).length === 0) return;

  await db.collection('registrations').doc(registrationId).update(updates);
  outcome.clearedFromTeams = outcome.clearedFromTeams || [];
  outcome.clearedFromTeams.push({ registrationId, teamName: reg.teamName || '', cleared: Object.keys(updates), clearedAll: false });

  const fresh = (await db.collection('registrations').doc(registrationId).get()).data() || {};
  const rosterCount = (fresh.leader ? 1 : 0) + (fresh.member2 ? 1 : 0) + (fresh.member3 ? 1 : 0);
  if (rosterCount > 0) return;

  // No members remain — the team is an empty ghost.
  outcome.deletedTeams = outcome.deletedTeams || [];
  outcome.deletedTeams.push(registrationId);
  try { await db.collection('registeredTeams').doc(String((reg.teamName || '').toLowerCase().replace(/[/\\]/g, '-'))).delete(); } catch (e) { /* ignore */ }
  try { await db.collection('registrations').doc(registrationId).delete(); } catch (e) { /* ignore */ }
  try { await db.collection('teams').doc(registrationId).delete(); } catch (e) { /* ignore */ }
  try { await deleteCollectionRecursive(`teams/${registrationId}/exam`); } catch (e) { /* ignore */ }
  try { await deleteCollectionRecursive(`teams/${registrationId}/events`); } catch (e) { /* ignore */ }
}

// Generate a shared team-login password (same charset/length as registration).
function genPassword() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
  const arr = new Uint32Array(16);
  crypto.randomFillSync(arr);
  const length = 12 + (arr[0] % 5);
  let pw = '';
  for (let i = 0; i < length; i++) pw += chars[arr[i] % chars.length];
  return pw;
}

// Branded credentials email body (mirrors the client-side add-member email).
function memberCredentialEmail({ name, email, teamName, regId, password, resetLink }) {
  return `<div style="background-color:#070b14;padding:40px 16px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#0e1526;border-radius:16px;overflow:hidden;border:1px solid #1b2540;">
    <div style="background:#0a0f1e;padding:28px 32px;text-align:center;border-bottom:1px solid #1b2540;">
      <img src="https://gaac.stemastronomyclub.org/images/GAAC_Final_logo_without_BG-removebg-preview.png" alt="GAAC" width="140" style="display:block;margin:0 auto;" />
      <p style="margin:14px 0 0;color:#7a9bb5;font-size:12px;letter-spacing:3px;text-transform:uppercase;">Team Member Invitation</p>
    </div>
    <div style="padding:32px;">
      <h1 style="margin:0 0 8px;color:#ffffff;font-size:22px;">Hi ${name},</h1>
      <p style="color:#aec8e0;font-size:14px;line-height:1.7;margin:0 0 20px;">
        The leader of <strong style="color:#e8f0f8;">${teamName}</strong> added you to their GAAC 2026 team. Use the details below to sign in to your team dashboard:
      </p>
      <div style="background:#0a0f1e;border:1px solid #1b2540;border-radius:10px;padding:18px 20px;margin-bottom:20px;">
        <p style="margin:0 0 10px;color:#7a9bb5;font-size:12px;letter-spacing:2px;text-transform:uppercase;">Sign-in details</p>
        <p style="margin:0 0 6px;color:#e8f0f8;font-size:14px;">Email: <strong style="color:#26b7ff;">${email}</strong></p>
        <p style="margin:0 0 6px;color:#e8f0f8;font-size:14px;">Password: <strong style="color:#26b7ff;">${password}</strong></p>
        <p style="margin:0;color:#e8f0f8;font-size:14px;">Team ID: <strong style="color:#26b7ff;">${regId}</strong></p>
      </div>
      ${resetLink ? `<p style="margin:0 0 20px;color:#aec8e0;font-size:14px;line-height:1.7;">Forgot your password or want to change it? <a href="${resetLink}" style="color:#26b7ff;text-decoration:underline;">Set a new one here</a>.</p>` : ''}
      <a href="https://gaac-registration-2026.web.app/team-dashboard" style="display:inline-block;background:linear-gradient(135deg,#26b7ff,#0878ff);color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:bold;font-size:14px;">Open Team Dashboard</a>
    </div>
    <div style="background:#0a0f1e;padding:20px 32px;text-align:center;border-top:1px solid #1b2540;">
      <p style="margin:0;color:#4a5a7a;font-size:11px;">Questions? Email us at <a href="mailto:astronomyclub64@gmail.com" style="color:#26b7ff;text-decoration:none;">astronomyclub64@gmail.com</a></p>
    </div>
  </div>
</div>`;
}

/**
 * Triggered when a team's exam status changes to 'submitted'.
 * Calculates score by comparing answers against the exam's answer keys.
 * Validates submission server-side to prevent score manipulation.
 */
exports.scoreExam = onDocumentWritten(
  'teams/{teamId}/exam/{examId}',
  async (event) => {
    if (!event.data) return;
    const { teamId, examId } = event.params;
    const data = event.data.after.data();
    if (!data || data.status !== 'submitted') return;
    if (data.scored) return;

    const answers = data.answers || {};

    try {
      // Server-side time validation: check if submission is within exam window
      if (data.startedAt) {
        const startedAt = data.startedAt.toMillis();
        const elapsedMs = Date.now() - startedAt;
        const maxDurationMs = 3 * 60 * 60 * 1000; // 3 hour safety window
        if (elapsedMs > maxDurationMs) {
          console.warn(`Team ${teamId} submission exceeds time window by ${Math.round((elapsedMs - maxDurationMs)/60000)} min`);
        }
      }

      let rawQuestions = [];
      try {
        rawQuestions = require('./r1_questions.json');
      } catch (e) {
        console.warn('Could not require r1_questions.json:', e);
      }

      const answerMap = {};
      if (rawQuestions && rawQuestions.length > 0) {
        rawQuestions.forEach((q) => {
          answerMap[q.id] = q.correctAnswer;
        });
      } else {
        const answerKeysSnap = await db
          .collection('round1')
          .doc('round1')
          .collection('answerKeys')
          .orderBy('order')
          .get();
        if (!answerKeysSnap.empty) {
          answerKeysSnap.forEach((q) => {
            answerMap[q.id] = q.data().correctAnswer;
          });
        }
      }

      const questionOrder = (data.questionOrder && data.questionOrder.length > 0)
        ? data.questionOrder
        : (rawQuestions.length > 0 ? rawQuestions.map(q => q.id) : Object.keys(answerMap));

      let correctCount = 0;
      let incorrectCount = 0;
      let unansweredCount = 0;
      const details = [];
      const totalQuestions = questionOrder.length || 40;

      questionOrder.forEach((qId, idx) => {
        const correctAnswer = answerMap[qId] || (rawQuestions[idx] ? rawQuestions[idx].correctAnswer : null);
        
        let userAnswer = null;
        if (answers[idx] !== undefined && answers[idx] !== null && answers[idx] !== '') {
          userAnswer = String(answers[idx]).trim().toUpperCase();
        } else if (answers[String(idx)] !== undefined && answers[String(idx)] !== null && answers[String(idx)] !== '') {
          userAnswer = String(answers[String(idx)]).trim().toUpperCase();
        } else if (answers[qId] !== undefined && answers[qId] !== null && answers[qId] !== '') {
          userAnswer = String(answers[qId]).trim().toUpperCase();
        }

        if (!userAnswer) {
          unansweredCount++;
          details.push({ questionId: qId, questionNumber: idx + 1, userAnswer: null, correctAnswer, result: 'unanswered' });
        } else if (userAnswer === correctAnswer) {
          correctCount++;
          details.push({ questionId: qId, questionNumber: idx + 1, userAnswer, correctAnswer, result: 'correct' });
        } else {
          incorrectCount++;
          details.push({ questionId: qId, questionNumber: idx + 1, userAnswer, correctAnswer, result: 'incorrect' });
        }
      });
      const score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
      const passed = score >= 40;

      await event.data.after.ref.update({
        scored: true,
        score,
        correctCount,
        incorrectCount,
        unansweredCount,
        totalQuestions,
        passed,
        details,
        scoredAt: FieldValue.serverTimestamp()
      });

      const submittedSnap = await db
        .collection('teams')
        .doc(teamId)
        .collection('exam')
        .where('status', '==', 'submitted')
        .get();

      let scoredCount = 0;
      let scoreSum = 0;
      let teamCorrectCount = 0;
      let teamTotalQuestions = 0;
      let teamEventCount = 0;
      let teamSevereEventCount = 0;
      let teamDisqualified = false;

      submittedSnap.forEach((doc) => {
        const examData = doc.id === examId
          ? { ...doc.data(), scored: true, score, correctCount, totalQuestions, eventCount: data.eventCount || 0, severeEventCount: data.severeEventCount || 0, disqualified: data.disqualified || false }
          : doc.data();

        if (examData.scored && typeof examData.score === 'number') {
          scoredCount++;
          scoreSum += examData.score;
          teamCorrectCount += examData.correctCount || 0;
          teamTotalQuestions += examData.totalQuestions || 0;
        }
        teamEventCount += examData.eventCount || 0;
        teamSevereEventCount += examData.severeEventCount || 0;
        teamDisqualified = teamDisqualified || examData.disqualified === true;
      });

      const teamScore = scoredCount > 0 ? Math.round(scoreSum / scoredCount) : score;
      await db.collection('teams').doc(teamId).set({
        examScore: teamScore,
        examPassed: teamScore >= 40,
        examStatus: scoredCount === submittedSnap.size ? 'scored' : 'scoring',
        submittedCount: submittedSnap.size,
        correctCount: teamCorrectCount || correctCount,
        totalQuestions: teamTotalQuestions || totalQuestions,
        eventCount: teamEventCount,
        severeEventCount: teamSevereEventCount,
        disqualified: teamDisqualified
      }, { merge: true });

      console.log(`Team ${teamId} scored ${score}% (${correctCount}/${totalQuestions})`);
    } catch (error) {
      console.error(`Scoring failed for team ${teamId}:`, error);
    }
  });

/**
 * Triggered when a team member's mock test status changes to 'submitted'.
 * Grades the mock server-side using the admin-only mock answer keys (mock
 * questions are read from the static file with no correct answers inside),
 * then writes the score back. Prevents students from reading or forging
 * their mock score.
 */
exports.scoreMock = onDocumentWritten(
  'teams/{teamId}/mock/{mockId}',
  async (event) => {
    if (!event.data) return;
    const { teamId, mockId } = event.params;
    const data = event.data.after.data();
    if (!data || data.status !== 'submitted') return;
    if (data.scored) return;

    const answers = data.answers || {};

    try {
      const keysSnap = await db
        .collection('mockExam')
        .doc('mock')
        .collection('answerKeys')
        .orderBy('order')
        .get();

      if (keysSnap.empty) {
        console.error(`No mock answer keys found`);
        return;
      }

      const correctAnswers = keysSnap.docs.map((q) => q.data().correctAnswer);
      const totalQuestions = correctAnswers.length;

      let correctCount = 0;
      let incorrectCount = 0;
      let unansweredCount = 0;
      const details = [];

      for (let i = 0; i < totalQuestions; i++) {
        const correctAnswer = correctAnswers[i];
        const userAnswer = answers[i];
        if (!userAnswer) {
          unansweredCount++;
          details.push({ questionNumber: i + 1, questionId: keysSnap.docs[i].id, userAnswer: null, result: 'unanswered' });
        } else if (userAnswer === correctAnswer) {
          correctCount++;
          details.push({ questionNumber: i + 1, questionId: keysSnap.docs[i].id, userAnswer, result: 'correct' });
        } else {
          incorrectCount++;
          details.push({ questionNumber: i + 1, questionId: keysSnap.docs[i].id, userAnswer, result: 'incorrect' });
        }
      }

      const score = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;

      await event.data.after.ref.update({
        scored: true,
        score,
        correctCount,
        incorrectCount,
        unansweredCount,
        totalQuestions,
        details,
        scoredAt: FieldValue.serverTimestamp()
      });

      await db.collection('teams').doc(teamId).set(
        { mockStatus: 'scored', mockScore: score },
        { merge: true }
      );

      console.log(`Mock ${teamId}/${mockId} scored ${score}% (${correctCount}/${totalQuestions})`);
    } catch (error) {
      console.error(`Mock scoring failed for ${teamId}/${mockId}:`, error);
    }
  });

/**
 * Admin: manually trigger re-scoring for a specific team.
 */
exports.rescoreTeam = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  const { teamId } = request.data;
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId required');

  const examSnap = await db.collection('teams').doc(teamId).collection('exam').where('status', '==', 'submitted').get();
  for (const doc of examSnap.docs) {
    await doc.ref.update({ scored: false, status: 'submitted' });
  }
  return { success: true };
});

/**
 * Admin: disqualify or reinstate a team.
 */
exports.toggleDisqualify = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  const { teamId } = request.data;
  if (!teamId) throw new HttpsError('invalid-argument', 'teamId required');

  const teamRef = db.collection('teams').doc(teamId);
  const teamSnap = await teamRef.get();

  const currentlyDisqualified = teamSnap.exists && teamSnap.data().disqualified === true;

  // Update both the team summary doc and the exam subcollection
  const batch = db.batch();
  batch.set(teamRef, { disqualified: !currentlyDisqualified }, { merge: true });
  const examSnap = await db.collection('teams').doc(teamId).collection('exam').get();
  for (const d of examSnap.docs) {
    batch.set(d.ref, { disqualified: !currentlyDisqualified }, { merge: true });
  }
  await batch.commit();

  return { success: true, disqualified: !currentlyDisqualified };
});

/**
 * Admin: update competition control flags.
 */
exports.updateCompetitionControl = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const allowedKeys = [
    'registrationOpen',
    'portalRegistrationOpen',
    'round1Open',
    'round2Open',
    'mockCountdownStart',
    'mockOpenAt',
    'mockStartAt',
    'mockCloseAt',
    'round1OpenAt',
    'round1CloseAt',
    'round1StartAt',
    'round1EndAt'
  ];
  const updates = {};
  for (const key of allowedKeys) {
    if (request.data[key] !== undefined) {
      updates[key] = request.data[key];
    }
  }
  if (Object.keys(updates).length === 0) {
    throw new HttpsError('invalid-argument', 'No valid flags provided.');
  }

  await db.collection('settings').doc('competition').set(updates, { merge: true });
  return { success: true, ...updates };
});

/**
 * Get competition status (public, no auth required).
 */
exports.getCompetitionStatus = onCall(async (request) => {
  const snap = await db.collection('settings').doc('competition').get();
  if (!snap.exists) {
    return {
      registrationOpen: false,
      portalRegistrationOpen: false,
      round1Open: false,
      round2Open: false
    };
  }
  return snap.data();
});

/**
 * Server-authoritative Round 1 status + server clock. The client uses this
 * (NOT its own Date.now()) to decide whether entry is open, so candidates with
 * a wrong device clock all see the same window. Returns the server timestamp
 * (ms) so the client can offset any client-side countdown drift.
 */
exports.getRound1Status = onCall(async (request) => {
  const snap = await db.collection('settings').doc('competition').get();
  const d = snap.exists ? snap.data() : {};
  return {
    now: Date.now(),
    openAt: typeof d.round1OpenAt === 'number' ? d.round1OpenAt : Date.UTC(2026, 8, 5, 16, 0, 0),  // 7:00 PM GMT+3
    closeAt: typeof d.round1CloseAt === 'number' ? d.round1CloseAt : Date.UTC(2026, 8, 5, 17, 0, 0), // 8:00 PM GMT+3
    startAt: typeof d.round1StartAt === 'number' ? d.round1StartAt : Date.UTC(2026, 8, 5, 16, 0, 0), // 7:00 PM GMT+3
    round1Open: d.round1Open !== false
  };
});

/* Round 1 questions, served server-side from a private JSON file with an in-memory cache.
 * Questions are loaded ONCE into memory and reused for every student/request — zero per-student Firestore reads.
 * Answer keys are NEVER returned to clients; scoring trigger uses Firestore answerKeys (or memory fallback).
 */
const round1QuestionsCache = { data: null };

function getPrivateRound1Questions() {
  if (round1QuestionsCache.data) return round1QuestionsCache.data;
  try {
    const raw = require('./r1_questions.json');
    round1QuestionsCache.data = raw.map(q => ({
      id: q.id,
      order: q.order,
      text: q.text,
      text_ar: q.text_ar || q.text,
      options: q.options,
      options_ar: q.options_ar || q.options,
      difficulty: q.difficulty || ''
    }));
  } catch (e) {
    console.error('[getRound1Questions] Failed to read r1_questions.json:', e);
    round1QuestionsCache.data = [];
  }
  return round1QuestionsCache.data;
}

exports.getRound1Questions = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const questions = getPrivateRound1Questions();
  return { questions, cached: true };
});

/**
 * Admin: sync Round 1 correct answers from private JSON into Firestore collection
 * (round1/round1/answerKeys) for scoring and auditing.
 */
exports.syncRound1AnswerKeys = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const rawQuestions = require('./r1_questions.json');
  const batch = db.batch();
  
  const examRef = db.collection('round1').doc('round1');
  batch.set(examRef, {
    title: 'GAAC Round 1 — Astronomy & Astrophysics',
    duration: 60,
    totalQuestions: rawQuestions.length,
    updatedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  rawQuestions.forEach((q) => {
    const aRef = db.collection('round1').doc('round1').collection('answerKeys').doc(q.id);
    batch.set(aRef, {
      correctAnswer: q.correctAnswer,
      order: q.order,
      difficulty: q.difficulty || ''
    }, { merge: true });
  });

  await batch.commit();
  console.log(`Synced ${rawQuestions.length} answer keys to round1/round1/answerKeys`);
  return { success: true, count: rawQuestions.length };
});

/**
 * Admin: upload Round 1 answer keys into Firestore (admin-only path used offline
 * via the console or a seed script). Not exposed via the web API.
 */


/**
 * Admin: summarize mock test submissions across all teams. Returns the number
 * of teams/members who submitted and the highest mock score. Admin only.
 */
exports.getMockResults = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const mocksSnap = await db.collectionGroup('mock').get();
  const submissions = [];
  let maxScore = null;

  for (const m of mocksSnap.docs) {
    const d = m.data();
    if (d.status !== 'submitted') continue;
    const teamId = m.ref.path.split('/')[1];
    const score = d.score != null ? d.score : (d.correctCount != null ? d.correctCount : null);
    if (score != null && (maxScore === null || score > maxScore)) maxScore = score;
    submissions.push({
      teamId,
      teamName: '',
      memberEmail: d.memberEmail || '',
      memberRole: d.memberRole || '',
      score: d.score != null ? d.score : null,
      correctCount: d.correctCount != null ? d.correctCount : null,
      totalQuestions: d.totalQuestions != null ? d.totalQuestions : null,
      answersCount: d.answersCount != null ? d.answersCount : (d.answers ? Object.keys(d.answers).length : null),
      answeredCount: d.answeredCount != null ? d.answeredCount : null,
      unansweredCount: d.unansweredCount != null ? d.unansweredCount : null,
      scored: !!d.scored,
      submittedAt: d.submittedAt && d.submittedAt.seconds ? new Date(d.submittedAt.seconds * 1000).toISOString() : null,
      details: Array.isArray(d.details) ? d.details : null
    });
  }

  const labels = await db.collection('registrations').get();
  const teamNameById = {};
  labels.forEach(d => teamNameById[d.id] = d.data().teamName || '');
  submissions.forEach(s => s.teamName = teamNameById[s.teamId] || '');
  submissions.sort((a, b) => (b.score || 0) - (a.score || 0));

  return { submittedCount: submissions.length, maxScore, submissions };
});

/**
 * Export leaderboard and team data to CSV string.
 * Admin only. Returns CSV text.
 */
exports.exportData = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const format = request.data.format || 'csv'; // csv, json
  const includeMonitoring = request.data.includeMonitoring === true;

  const registrationsSnap = await db.collection('registrations').get();

  const rows = [];
  for (const regDoc of registrationsSnap.docs) {
    const regData = regDoc.data();
    const teamId = regDoc.id;

    let examData = null;
    let eventCount = 0;
    let severeCount = 0;
    let teamData = null;
    try {
      const teamSnap = await db.collection('teams').doc(teamId).get();
      if (teamSnap.exists) {
        teamData = teamSnap.data();
        eventCount = teamData.eventCount || 0;
        severeCount = teamData.severeEventCount || 0;
      }
      const examSnap = await db.collection('teams').doc(teamId).collection('exam').where('status', '==', 'submitted').limit(1).get();
      if (!examSnap.empty) {
        examData = examSnap.docs[0].data();
      }
    } catch (e) { /* skip */ }

    const monitoringEvents = [];
    if (includeMonitoring) {
      try {
        const eventsSnap = await db.collection('teams').doc(teamId).collection('events')
          .orderBy('timestamp', 'desc')
          .limit(100)
          .get();
        eventsSnap.forEach(d => monitoringEvents.push(d.data()));
      } catch (e) { /* skip */ }
    }

    rows.push({
      teamId,
      teamName: regData.teamName || '',
      leaderName: regData.leader?.name || '',
      leaderEmail: regData.leader?.email || '',
      member2Name: regData.member2?.name || '',
      member2Email: regData.member2?.email || '',
      member3Name: regData.member3?.name || '',
      member3Email: regData.member3?.email || '',
      country: regData.leader?.country || '',
      status: examData?.status || 'registered',
      score: examData?.score != null ? examData.score : '',
      correctCount: examData?.correctCount != null ? examData.correctCount : '',
      totalQuestions: examData?.totalQuestions != null ? examData.totalQuestions : '',
      passed: examData?.passed != null ? examData.passed : '',
      disqualified: examData?.disqualified || false,
      eventCount,
      severeEventCount: severeCount,
      submittedAt: examData?.submittedAt || '',
      startedAt: examData?.startedAt || '',
      monitoringEvents: monitoringEvents.length > 0 ? JSON.stringify(monitoringEvents) : ''
    });
  }

  if (format === 'json') {
    return { data: rows, format: 'json' };
  }

  // Build CSV
  const headers = Object.keys(rows[0] || {});
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  let csv = headers.join(',') + '\n';
  for (const row of rows) {
    csv += headers.map(h => esc(row[h])).join(',') + '\n';
  }

  return { data: csv, format: 'csv', rowCount: rows.length };
});

/**
 * Backend-mediated password reset.
 * Verifies identity server-side, generates a secure one-time reset link
 * via the Admin SDK, and queues a branded email through the `mail`
 * collection (sent by the Trigger Email extension from the club Gmail).
 */
exports.sendPasswordReset = onCall({ region: 'africa-south1' }, async (request) => {
  const data = request.data || {};
  const email = (data.email || '').trim().toLowerCase();
  const registrationId = (data.registrationId || '').trim().toUpperCase();

  if (!email || !registrationId) {
    throw new HttpsError('invalid-argument', 'Email and Registration ID are required.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
  }

  // Server-side identity verification (never trust the client)
  const emailSnap = await db.collection('registeredEmails').doc(email).get();
  if (!emailSnap.exists) {
    throw new HttpsError('not-found', 'The information does not match our records.');
  }
  const rec = emailSnap.data() || {};
  if ((rec.registrationId || '').toUpperCase() !== registrationId) {
    throw new HttpsError('not-found', 'The information does not match our records.');
  }

  // Simple rate limit: one reset request per email per minute
  const rateRef = db.collection('passwordResetRequests').doc(email);
  const rateSnap = await rateRef.get();
  const now = Date.now();
  if (rateSnap.exists && now - (rateSnap.data().lastRequestAt || 0) < 60000) {
    throw new HttpsError('resource-exhausted', 'Please wait a minute before requesting another reset email.');
  }
  await rateRef.set({ lastRequestAt: now }, { merge: true });

  // Generate a secure, single-use reset link
  const link = await getAuth().generatePasswordResetLink(email, {
    url: 'https://gaac-registration-2026.web.app/team-dashboard',
    handleCodeInApp: false
  });

  const html = `
<div style="background-color:#070b14; padding:40px 16px; font-family:Arial, Helvetica, sans-serif;">
  <div style="max-width:560px; margin:0 auto; background:#0e1526; border-radius:16px; overflow:hidden; border:1px solid #1b2540;">

    <div style="background:#0a0f1e; padding:28px 32px; text-align:center; border-bottom:1px solid #1b2540;">
      <img src="https://gaac.stemastronomyclub.org/images/GAAC_Final_logo_without_BG-removebg-preview.png" alt="GAAC" width="140" style="display:block; margin:0 auto;" />
      <p style="margin:14px 0 0; color:#7a9bb5; font-size:12px; letter-spacing:3px; text-transform:uppercase;">Password Reset</p>
    </div>

    <div style="padding:32px;">
      <h1 style="margin:0 0 8px; color:#ffffff; font-size:22px;">Reset your password</h1>
      <p style="color:#aec8e0; font-size:14px; line-height:1.7; margin:0 0 20px;">
        Hello,<br />
        We received a request to reset the password for your <strong style="color:#e8f0f8;">GAAC</strong> account (<span style="color:#e8f0f8;">${email}</span>). Click the button below to choose a new password:
      </p>
      <div style="text-align:center; margin:28px 0;">
        <a href="${link}" style="background:linear-gradient(135deg,#26b7ff,#0878ff); color:#ffffff; text-decoration:none; padding:14px 32px; border-radius:8px; font-weight:bold; font-size:14px; display:inline-block;">Reset Password</a>
      </div>
      <p style="color:#7a9bb5; font-size:12px; line-height:1.6; margin:0 0 8px;">If the button doesn't work, copy and paste this link into your browser:</p>
      <p style="margin:0 0 24px;"><a href="${link}" style="color:#26b7ff; font-size:12px; word-break:break-all;">${link}</a></p>
      <p style="color:#7a9bb5; font-size:12px; line-height:1.6; margin:0; border-top:1px solid #1b2540; padding-top:20px;">
        This link is valid for a limited time and can only be used once. If you didn't request a password reset, you can safely ignore this email.
      </p>
    </div>

    <div style="background:#0a0f1e; padding:20px 32px; text-align:center; border-top:1px solid #1b2540;">
      <p style="margin:0 0 6px; color:#7a9bb5; font-size:11px; line-height:1.6;">
        Global Astronomy &amp; Astrophysics Challenge<br />
        Organized by STEM October Astronomy Club
      </p>
      <p style="margin:0; color:#4a5a7a; font-size:11px;">
        Questions? Email us at <a href="mailto:astronomyclub64@gmail.com" style="color:#26b7ff; text-decoration:none;">astronomyclub64@gmail.com</a>
      </p>
    </div>

  </div>
</div>`;

  await db.collection('mail').add({
    to: [email],
    message: {
      subject: 'Reset your password for GAAC 2026',
      html: html
    }
  });
  console.log(`Password reset email queued for ${email}`);

  return { success: true };
});

/**
 * Called during registration when a member's Firebase Auth account already
 * exists with a different password (orphaned from a deleted team). Uses Admin
 * SDK to reset their password so they can rejoin with the new team password.
 */
exports.reassignMember = onCall({ region: 'africa-south1' }, async (request) => {
  const data = request.data || {};
  const email = (data.email || '').trim().toLowerCase();
  const newPassword = (data.newPassword || '').trim();
  const newTeamId = (data.newTeamId || '').trim().toUpperCase();

  if (!email || !newPassword || !newTeamId) {
    throw new HttpsError('invalid-argument', 'Email, new password, and team ID are required.');
  }

  const emailSnap = await db.collection('registeredEmails').doc(email).get();
  if (!emailSnap.exists) {
    throw new HttpsError('not-found', 'Email not found in registeredEmails.');
  }

  const rec = emailSnap.data() || {};
  const uid = rec.uid;
  if (!uid) {
    throw new HttpsError('failed-precondition', 'No UID found for this email.');
  }

  await getAuth().updateUser(uid, { password: newPassword });
  console.log(`Password reset for ${email} (uid=${uid}) to join ${newTeamId}`);

  return { success: true, uid };
});

/**
 * Admin: Remove an orphaned Firebase Auth account + every Firestore trace
 * (email index, teamMembers, removal audits, roster slots) so the person can
 * be re-registered / re-added cleanly.
 *
 * Works for FULL orphans whose Firestore records are already gone (e.g. the
 * buyer of a deleted team), because the account is resolved straight from
 * Firebase Auth via getAuth().getUserByEmail(email).
 */
exports.removeOrphanedAccount = onCall({ region: 'africa-south1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in.');
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const data = request.data || {};
  const email = normalizeEmail(data.email);
  if (!email) throw new HttpsError('invalid-argument', 'Email required.');

  const outcome = {
    success: true,
    email,
    uid: null,
    authDeleted: false,
    teamMembersDeleted: false,
    registeredEmailsDeleted: false,
    removals: []
  };

  const uid = await resolveUidByEmail(email);
  outcome.uid = uid;

  if (uid) {
    try { await getAuth().deleteUser(uid); outcome.authDeleted = true; }
    catch (e) { console.warn(`Auth delete failed for ${uid} (${email}):`, e.message); }
    try { await db.collection('teamMembers').doc(uid).delete(); outcome.teamMembersDeleted = true; }
    catch (e) { console.warn(`teamMembers delete failed (${uid}):`, e.message); }
    try { await db.collection('removedMembers').doc(uid).delete(); outcome.removals.push(`removedMembers/${uid}`); }
    catch (e) { /* ignore */ }
  }

  try { await db.collection('registeredEmails').doc(email).delete(); outcome.registeredEmailsDeleted = true; }
  catch (e) { console.warn(`registeredEmails delete failed (${email}):`, e.message); }
  try { await db.collection('removedEmails').doc(email).delete(); outcome.removals.push(`removedEmails/${email}`); }
  catch (e) { /* ignore */ }

  // Strip the person from any registration they still belong to (leader /
  // member2 / member3), deleting the team as a ghost if it becomes empty.
  const roles = ['leader', 'member2', 'member3'];
  const seen = new Set();
  for (const role of roles) {
    const snaps = await db.collection('registrations').where(`${role}.email`, '==', email).get();
    for (const d of snaps.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      await clearPersonFromRegistration(d.id, email, outcome);
    }
  }

  console.log(`removeOrphanedAccount(${email}) ->`, outcome);
  return outcome;
});

/**
 * Admin: Look up EVERYTHING known about an email — Auth account, email index,
 * teamMembers, removal audits, and any team they still appear in. Works even
 * for FULL orphans (Firestore records already gone) by resolving the Auth
 * user via getAuth().getUserByEmail(email).
 */
exports.getRegistrationInfo = onCall({ region: 'africa-south1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in.');
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const data = request.data || {};
  const email = normalizeEmail(data.email);
  if (!email) throw new HttpsError('invalid-argument', 'Email required.');

  const out = { found: false, email, auth: { exists: false, uid: null } };

  try {
    const user = await getAuth().getUserByEmail(email);
    out.auth = { exists: true, uid: user.uid, email: user.email, disabled: user.disabled };
  } catch (e) { /* no Auth user for this email */ }

  // Email index + removal audits.
  try {
    const emailSnap = await db.collection('registeredEmails').doc(email).get();
    out.registeredEmails = emailSnap.exists ? emailSnap.data() : null;
  } catch (e) { out.registeredEmails = null; }
  try {
    const removedEmailSnap = await db.collection('removedEmails').doc(email).get();
    out.removedEmails = removedEmailSnap.exists ? removedEmailSnap.data() : null;
  } catch (e) { out.removedEmails = null; }

  const uid = out.auth.uid || (out.registeredEmails && out.registeredEmails.uid) || null;
  if (uid) {
    try {
      const tmSnap = await db.collection('teamMembers').doc(uid).get();
      out.teamMembers = tmSnap.exists ? tmSnap.data() : null;
    } catch (e) { out.teamMembers = null; }
    try {
      const rmSnap = await db.collection('removedMembers').doc(uid).get();
      out.removedMembers = rmSnap.exists ? rmSnap.data() : null;
    } catch (e) { out.removedMembers = null; }
  }

  // Any registration that still contains this email (leader / member2 / member3).
  out.teams = [];
  const seen = new Set();
  for (const role of ['leader', 'member2', 'member3']) {
    const snaps = await db.collection('registrations').where(`${role}.email`, '==', email).get();
    for (const d of snaps.docs) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      const reg = d.data();
      out.teams.push({
        registrationId: d.id,
        teamName: reg.teamName || '',
        status: reg.status || 'registered',
        role,
        matchingEmail: email,
        member: reg[role] || null
      });
    }
  }

  out.found = out.auth.exists || !!out.registeredEmails || out.teams.length > 0 || !!out.removedEmails;
  return out;
});

/**
 * Admin: Add a member DIRECTLY to a team (same atomic stamping the leader's
 * dashboard does: email index, teamMembers, roster slot, memberCount, and a
 * credential email). This is the tool used to place an orphaned person into a
 * team without depending on the leader's own add flow.
 *
 * If a Firebase Auth account already exists for the email (e.g. orphaned from
 * a deleted team) it is REUSED — the identity is kept and its password is
 * forced to the team's shared password so roster sign-in works. Otherwise a
 * brand-new Auth account is created with the team password.
 */
exports.adminAddMemberToTeam = onCall({ region: 'africa-south1' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in.');
  const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }

  const data = request.data || {};
  const email = normalizeEmail(data.email);
  const teamId = String(data.teamId || '').trim().toUpperCase();
  const member = {
    name: String(data.name || '').trim(),
    country: String(data.country || '').trim(),
    school: String(data.school || '').trim(),
    dob: String(data.dob || '').trim(),
    grade: String(data.grade || '').trim(),
    email
  };
  if (!email) throw new HttpsError('invalid-argument', 'Email required.');
  if (!teamId) throw new HttpsError('invalid-argument', 'Team ID required.');
  if (!member.name) throw new HttpsError('invalid-argument', 'Member name required.');

  const regSnap = await db.collection('registrations').doc(teamId).get();
  if (!regSnap.exists) throw new HttpsError('not-found', `Registration ${teamId} does not exist.`);
  const reg = regSnap.data();

  // Duplicate-email guard (global uniqueness, same rule the app enforces).
  const emailSnap = await db.collection('registeredEmails').doc(email).get();
  if (emailSnap.exists) {
    const rec = emailSnap.data();
    if (String(rec.registrationId || '').toUpperCase() === teamId) {
      throw new HttpsError('already-exists', 'This email already belongs to this team.');
    }
    throw new HttpsError('already-exists',
      `This email is already registered to ${rec.teamName || 'another team'} (${rec.registrationId}). ` +
      `Release it with the orphan tool first, or remove it from that team.`);
  }

  const slot = !reg.member2 ? 'member2' : (!reg.member3 ? 'member3' : null);
  if (!slot) throw new HttpsError('failed-precondition', 'This team already has the maximum of 3 members.');

  const teamPassword = reg.password || genPassword();

  // Reuse an existing (possibly orphaned) Auth account, resetting its password
  // to the team's; otherwise create a fresh account for the member.
  let uid = null;
  const authAdmin = getAuth();
  try {
    const user = await authAdmin.getUserByEmail(email);
    uid = user.uid;
    await authAdmin.updateUser(uid, { password: teamPassword });
  } catch (e) {
    const created = await authAdmin.createUser({ email, password: teamPassword, displayName: member.name });
    uid = created.uid;
  }

  const batch = db.batch();
  batch.set(db.collection('registeredEmails').doc(email), {
    teamName: reg.teamName,
    registrationId: teamId,
    uid
  });
  batch.set(db.collection('teamMembers').doc(uid), {
    teamId,
    email,
    role: slot,
    createdAt: FieldValue.serverTimestamp()
  });
  batch.update(regSnap.ref, { [slot]: member });

  const teamRef = db.collection('teams').doc(teamId);
  const teamSnap = await teamRef.get();
  if (teamSnap.exists) {
    batch.update(teamRef, { memberCount: FieldValue.increment(1) });
  } else {
    const rosterLen = (reg.leader ? 1 : 0) + (reg.member2 ? 1 : 0) + (reg.member3 ? 1 : 0);
    batch.set(teamRef, { memberCount: rosterLen + 1 });
  }

  batch.set(db.collection('mail').doc(`admin-add-${teamId}-${Date.now()}`), {
    to: [email],
    message: {
      subject: `GAAC 2026 — You have been added to Team ${reg.teamName}`,
      html: memberCredentialEmail({
        name: member.name,
        email,
        teamName: reg.teamName,
        regId: teamId,
        password: teamPassword
      })
    }
  });

  await batch.commit();
  console.log(`adminAddMemberToTeam: ${email} (uid=${uid}) added to ${teamId} as ${slot}`);
  return { success: true, uid, slot };
});

/**
 * Admin-only bulk credentials mailer.
 *
 * For each target team (registration ids given, or ALL teams when none are):
 *   1. ensures the leader + members each have a usable Auth account:
 *        - existing account  → password aligned to the shared team password
 *        - missing account   → created with the team password (repairs the
 *                              truly-no-account cases) and the
 *                              `registeredEmails` / `teamMembers` indexes rebuilt
 *   2. skips anyone with a `removedEmails` removal-audit record
 *   3. queues a branded credentials email to every member containing the team
 *      password AND a password-reset link (Trigger Email extension)
 *
 * Idempotent: mail docs use deterministic ids, so re-running refreshes the
 * same jobs instead of duplicating them.
 */
exports.sendCredentials = onCall(
  { region: 'africa-south1', timeoutSeconds: 540, memory: '1GiB' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be logged in.');
    const adminDoc = await db.collection('admins').doc(request.auth.uid).get();
    if (!adminDoc.exists || !adminDoc.data().isAdmin) {
      throw new HttpsError('permission-denied', 'Admin only.');
    }

    const data = request.data || {};
    let regIds = null;
    if (typeof data.regIds === 'string' && data.regIds.trim()) {
      regIds = data.regIds.split(/[\n,;]+/).map(s => s.trim().replace(/["'`]/g, '')).filter(Boolean);
    } else if (Array.isArray(data.regIds)) {
      regIds = data.regIds.map(s => String(s).trim()).filter(Boolean);
    }
    if (regIds && regIds.length > 500) throw new HttpsError('invalid-argument', 'Max 500 teams per run.');
    const maxTeams = Math.min(Number(data.limit) || 200, 500);

    const result = { teamsProcessed: 0, accountsCreated: 0, emailsQueued: 0, skipped: [], errors: [] };
    const removedMemo = {};

    const wasRemoved = async (email) => {
      if (removedMemo[email] !== undefined) return removedMemo[email];
      const snap = await db.collection('removedEmails').doc(email).get();
      removedMemo[email] = snap.exists;
      return snap.exists;
    };

    const collections = db.collection('registrations');
    const query = regIds && regIds.length
      ? collections.where(FieldPath.documentId(), 'in', regIds)
      : collections;

    const snap = await query.get();

    for (const doc of snap.docs) {
      if (result.teamsProcessed >= maxTeams) break;
      if (doc.id.indexOf('=') === 0) continue; // canary doc
      const reg = doc.data() || {};
      if (!reg.leader || !reg.leader.email) {
        result.skipped.push({ teamId: doc.id, reason: 'no leader' });
        continue;
      }

      const teamId = doc.id;
      const teamName = reg.teamName || teamId;
      const teamPassword = reg.password || '';
      if (!teamPassword) {
        result.skipped.push({ teamId, reason: 'no stored password' });
        continue;
      }

      let batch = db.batch();
      let writes = 0;
      let members = 0;

      for (const slot of ['leader', 'member2', 'member3']) {
        const m = reg[slot];
        if (!m || !m.email) continue;
        const email = normalizeEmail(m.email);
        const name = m.name || email;
        if ((await wasRemoved(email))) continue;

        let uid = null;
        try {
          const user = await getAuth().getUserByEmail(email);
          uid = user.uid;
          await getAuth().updateUser(uid, { password: teamPassword });
        } catch (err) {
          if (err.code !== 'auth/user-not-found') {
            result.errors.push({ team: teamId, email, error: err.message });
            continue;
          }
          const created = await getAuth().createUser({ email, password: teamPassword, displayName: name });
          uid = created.uid;
          result.accountsCreated += 1;
        }

        const reRef = db.collection('registeredEmails').doc(email);
        const reSnap = await reRef.get();
        if (!reSnap.exists) {
          batch.set(reRef, { teamName, registrationId: teamId, uid });
          writes++;
        }
        const tmRef = db.collection('teamMembers').doc(uid);
        const tmSnap = await tmRef.get();
        if (!tmSnap.exists) {
          batch.set(tmRef, {
            teamId, email, role: slot,
            createdAt: FieldValue.serverTimestamp()
          });
          writes++;
        }

        const resetLink = await getAuth().generatePasswordResetLink(email);
        batch.set(db.collection('mail').doc(`creds-${teamId}-${email}`), {
          to: [email],
          message: {
            subject: `GAAC 2026 — Your ${teamName} sign-in details`,
            html: memberCredentialEmail({
              name,
              email,
              teamName,
              regId: teamId,
              password: teamPassword,
              resetLink
            })
          }
        });
        writes++;
        members++;
        result.emailsQueued++;
      }

      if (writes > 0) { await batch.commit(); }
      if (members > 0) result.teamsProcessed++;
    }

    console.log(`sendCredentials: ${result.teamsProcessed} teams, ${result.emailsQueued} mails, ${result.accountsCreated} accounts created`);
    return result;
  }
);

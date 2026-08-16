const functions = require('firebase-functions');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();

/**
 * Triggered when a team's exam status changes to 'submitted'.
 * Calculates score by comparing answers against the exam's answer keys.
 * Validates submission server-side to prevent score manipulation.
 */
exports.scoreExam = functions.firestore
  .document('teams/{teamId}/exam/round1')
  .onWrite(async (change, context) => {
    const { teamId } = context.params;
    const data = change.after.data();
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

      const answerKeysSnap = await db
        .collection('round1')
        .doc('round1')
        .collection('answerKeys')
        .orderBy('order')
        .get();

      if (answerKeysSnap.empty) {
        console.error(`No answer keys found for round1 exam`);
        return;
      }

      // Build answer key map: questionId -> correctAnswer
      const answerMap = {};
      answerKeysSnap.forEach((q) => {
        answerMap[q.id] = q.data().correctAnswer;
      });

      const questionOrder = data.questionOrder || [];
      const hasShuffle = questionOrder.length > 0;

      let correctCount = 0;
      let incorrectCount = 0;
      let unansweredCount = 0;
      const details = [];
      let totalQuestions = 0;

      if (hasShuffle) {
        // Questions were shuffled: use questionOrder to map index->questionId->correctAnswer
        totalQuestions = questionOrder.length;
        questionOrder.forEach((qId, idx) => {
          const correctAnswer = answerMap[qId];
          const userAnswer = answers[idx];
          if (!userAnswer) {
            unansweredCount++;
            details.push({ questionId: qId, questionNumber: idx + 1, userAnswer: null, result: 'unanswered' });
          } else if (userAnswer === correctAnswer) {
            correctCount++;
            details.push({ questionId: qId, questionNumber: idx + 1, userAnswer, result: 'correct' });
          } else {
            incorrectCount++;
            details.push({ questionId: qId, questionNumber: idx + 1, userAnswer, result: 'incorrect' });
          }
        });
      } else {
        // Legacy: questions were not shuffled — use sequential order
        totalQuestions = answerKeysSnap.size;
        answerKeysSnap.forEach((q, idx) => {
          const correctAnswer = q.data().correctAnswer;
          const userAnswer = answers[idx];
          const qId = q.id;
          if (!userAnswer) {
            unansweredCount++;
            details.push({ questionId: qId, questionNumber: idx + 1, userAnswer: null, result: 'unanswered' });
          } else if (userAnswer === correctAnswer) {
            correctCount++;
            details.push({ questionId: qId, questionNumber: idx + 1, userAnswer, result: 'correct' });
          } else {
            incorrectCount++;
            details.push({ questionId: qId, questionNumber: idx + 1, userAnswer, result: 'incorrect' });
          }
        });
      }
      const score = Math.round((correctCount / totalQuestions) * 100);
      const passed = score >= 40;

      await change.after.ref.update({
        scored: true,
        score,
        correctCount,
        incorrectCount,
        unansweredCount,
        totalQuestions,
        passed,
        details,
        scoredAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await db.collection('teams').doc(teamId).set({
        examScore: score,
        examPassed: passed,
        examStatus: 'scored',
        correctCount,
        totalQuestions,
        eventCount: data.eventCount || 0,
        severeEventCount: data.severeEventCount || 0,
        disqualified: data.disqualified || false
      }, { merge: true });

      console.log(`Team ${teamId} scored ${score}% (${correctCount}/${totalQuestions})`);
    } catch (error) {
      console.error(`Scoring failed for team ${teamId}:`, error);
    }
  });

/**
 * Admin: manually trigger re-scoring for a specific team.
 */
exports.rescoreTeam = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin only.');
  }
  const { teamId } = data;
  if (!teamId) throw new functions.https.HttpsError('invalid-argument', 'teamId required');

  const examRef = db.collection('teams').doc(teamId).collection('exam').doc('round1');
  await examRef.update({ scored: false, status: 'submitted' });
  return { success: true };
});

/**
 * Admin: disqualify or reinstate a team.
 */
exports.toggleDisqualify = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin only.');
  }
  const { teamId } = data;
  if (!teamId) throw new functions.https.HttpsError('invalid-argument', 'teamId required');

  const teamRef = db.collection('teams').doc(teamId);
  const teamSnap = await teamRef.get();

  const currentlyDisqualified = teamSnap.exists && teamSnap.data().disqualified === true;

  // Update both the team summary doc and the exam subcollection
  const batch = db.batch();
  batch.set(teamRef, { disqualified: !currentlyDisqualified }, { merge: true });
  batch.set(teamRef.collection('exam').doc('round1'), { disqualified: !currentlyDisqualified }, { merge: true });
  await batch.commit();

  return { success: true, disqualified: !currentlyDisqualified };
});

/**
 * Admin: update competition control flags.
 */
exports.updateCompetitionControl = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin only.');
  }

  const allowedKeys = ['registrationOpen', 'portalRegistrationOpen', 'round1Open', 'round2Open'];
  const updates = {};
  for (const key of allowedKeys) {
    if (data[key] !== undefined) {
      updates[key] = data[key];
    }
  }
  if (Object.keys(updates).length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'No valid flags provided.');
  }

  await db.collection('settings').doc('competition').set(updates, { merge: true });
  return { success: true, ...updates };
});

/**
 * Get competition status (public, no auth required).
 */
exports.getCompetitionStatus = functions.https.onCall(async (data, context) => {
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
 * Export leaderboard and team data to CSV string.
 * Admin only. Returns CSV text.
 */
exports.exportData = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be logged in.');
  }
  const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
  if (!adminDoc.exists || !adminDoc.data().isAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Admin only.');
  }

  const format = data.format || 'csv'; // csv, json
  const includeMonitoring = data.includeMonitoring === true;

  const registrationsSnap = await db.collection('registrations').get();

  const rows = [];
  for (const regDoc of registrationsSnap.docs) {
    const regData = regDoc.data();
    const teamId = regDoc.id;

    let examData = null;
    let eventCount = 0;
    let severeCount = 0;
    try {
      const examSnap = await db.collection('teams').doc(teamId).collection('exam').doc('round1').get();
      if (examSnap.exists) {
        examData = examSnap.data();
        eventCount = examData.eventCount || 0;
        severeCount = examData.severeEventCount || 0;
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
  const link = await admin.auth().generatePasswordResetLink(email, {
    url: 'https://gaac-registration-2026.web.app/exam-login',
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

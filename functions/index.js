const functions = require('firebase-functions');
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

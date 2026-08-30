# GAAC 2026 — Platform & System Overview

This document is a complete technical reference for the **Global Astronomy & Astrophysics Challenge (GAAC) 2026** registration + exam platform. It is written for an AI assistant (or new developer) to understand the system without reading every file.

---

## 1. What This Platform Does

1. **Public marketing site** (`index.html`, `syllabus.html`, `timeline.html`, `partners.html`, `awards.html`, `ambassador.html`).
2. **Team registration** — teams of 1–3 students (leader + up to 2 members) register with a team name, member PII, and get a sequential Registration ID + a shared team password.
3. **Team dashboard** — leaders manage their roster (add/remove members); all members see the team roster and, later, the Competitions panel to open the exam.
4. **Exam portal** — each member takes the Round 1 exam **individually** (their own answers/doc), under proctoring (camera + screen share + fullscreen + AI face detection + event monitoring).
5. **Admin monitor** (`admin-exam.html`) — locked to the admin account's own team, showing per-member event logs + snapshots + score, and question seeding.
6. **Cloud Functions** — scoring, resets, DQ toggle, admin data export, password reset, member reassignment, orphan-account cleanup.

---

## 2. Tech Stack

- **Frontend:** Static HTML + vanilla JS (ES modules), no framework.
- **Hosting:**
  - **Live site (primary):** **Vercel** — deployed automatically from GitHub `main` (`github.com/youse7abib/gaac-astro`).
  - **Firebase Hosting:** `gaac-registration-2026.web.app` — used for direct/hot deployments that Vercel has not picked up yet.
  - Firebase Hosting + Firestore + Auth + Storage are the backend.
- **Backend:** Firebase (project id `gaac-registration-2026`).
  - Firestore (rules-based security), Firebase Auth (email/password accounts, one per member), Cloud Storage (snapshots), Cloud Functions (Node.js, some in `africa-south1` region), Trigger Email extension (`mail` collection → club Gmail).
- **AI proctoring:** MediaPipe Face Detection (CDN) with a canvas-based fallback skin-tone/brightness heuristic.
- **Users log in with:** the email they registered with **+ the shared team password** (all team members share ONE password).

### Firebase config (public, this is normal for Firebase web apps)

```js
apiKey: "AIzaSyDsYFFtEJ96yg0Rqw7EfCZFoiLIaeDk6zY",
authDomain: "gaac-registration-2026.firebaseapp.com",
projectId: "gaac-registration-2026",
storageBucket: "gaac-registration-2026.firebasestorage.app",
messagingSenderId: "542838311094",
appId: "1:542838311094:web:6104e2ed0d1cafa976be17",
measurementId: "G-CEB6Z0RF5E"
```

A **second** Firebase project `gaac-ambassador` (separate config in `registration.js`) holds ambassador referral data.

---

## 3. Firestore Data Model

### Top-level collections

| Collection | Key | Purpose |
|---|---|---|
| `settings/counter` | doc `counter` | `lastId` — sequential counter for registration IDs |
| `settings/competition` | doc `competition` | Control flags: `registrationOpen`, `portalRegistrationOpen`, `round1Open`, `round2Open` |
| `settings/referrals` | doc `referrals` | `pointsPerRegistration` (default 10) |
| `registeredTeams/{teamNameKey}` | lowercased team name | Duplicate-prevention: `{ originalName, registrationId, createdAt }` |
| `registeredEmails/{email}` | email (lowercase) | Duplicate-prevention + email→uid index: `{ teamName, registrationId, uid? }` |
| `registrations/{regId}` | e.g. `GAAC-2026-0605` | Full team registration: `{ registrationId, teamName, leader{name,email,country,school,dob,grade}, member2?, member3?, timestamp, status, password, referredBy?, referralCode? }` |
| `mail/{mailId}` | any id | Trigger Email queue: `{ to, message:{ subject, html } }` |
| `round1/round1/questions/{qN}` | `q1`…`q40` | `{ text, text_ar, options[], options_ar[], order }` — NO correct answer |
| `round1/round1/answerKeys/{qN}` | `q1`…`q40` | `{ correctAnswer, order }` — **admin-read only** |
| `teams/{teamId}` | same id as registrations | Team summary / exam aggregate: `{ status, examScore, examPassed, examStatus, submittedCount, memberCount, eventCount, severeEventCount, disqualified, resetAt, startedAt }` |
| `teams/{teamId}/exam/{uid}` | **one doc PER MEMBER** | Per-member exam: `{ status: 'in-progress'|'submitted', startedAt, endTime, absoluteDeadline, answers{}, flagged{}, questionOrder[], pausedRemaining, submittedAt, eventCount, severeEventCount, ... scoring fields }` |
| `teams/{teamId}/events/{autoId}` | auto | Proctoring events: `{ type, severity, timestamp, countdownSecs, actualSecs?, localId, memberUid }` |
| `admins/{uid}` | auth uid | `{ isAdmin: true }` |
| `teamMembers/{uid}` | auth uid | Membership map: `{ teamId, email, createdAt }` — required by rules for team access |
| `removedMembers/{uid}` | auth uid | Audit when leader removes a member: `{ email, teamId }` |
| `removedEmails/{email}` | email | Keeps email→uid so re-adding a member reuses their old Auth account: `{ uid, email, teamId }` |
| `passwordResetRequests/{email}` | email | Rate-limit for resets: `{ lastRequestAt }` |

### Snapshot storage (`firebase.storage`)

```
snapshots/round1/{teamId}/{memberFolder}/{violation}_{timestamp}.jpg
```

- `memberFolder` = `${safeName}_${safeRole}` where `safeName` = member name with non-alphanumeric → `_`, `safeRole` = `leader` | `member2` | `member3`.
- Each admin can read all (rules require just an authenticated user; admin UI further filters by folder).

---

## 4. Firestore Security Rules (summary)

File: `firestore.rules`. Helper functions:

- `isAuthenticated()` — signed in.
- `isRealUser()` — signed in AND has a non-null email token (blocks anonymous).
- `isAdmin()` — `admins/{uid}.isAdmin == true`.
- `isTeamMember(teamId)` — `teamMembers/{uid}.teamId == teamId` (must exist).
- `isLeader(teamId)` — the signed-in email == `registrations/{teamId}.leader.email`.
- `isSoloLeader(regId)` — leader of a team with no member2/member3 (can fully delete their team).
- `isOwnUser(userId)` — uid match.

Key points:
- `settings/counter` — only `+1` updates.
- `registeredEmails` — `get` is **public** (lets a forgot-password flow verify email without signing in, exposes only teamName+registrationId); `list` admin-only; update only allows stamping `uid` by the owner of that email.
- `registrations` — read: admin / the leader / any team member; update: admin, or the leader changing only `member2`/`member3`, only `password`, or a leadership transfer.
- `round1/round1/questions` — readable by real users; answerKeys admin-only; questions must NOT contain `correctAnswer`.
- `teams/{teamId}` — team members may only write non-scoring fields (`status`, `submittedCount` +1, `memberCount` ±1 for leader roster changes). Admin writes scoring fields.
- `teams/{teamId}/exam/{uid}` — member can read/write only their own doc, and only while not submitted; cannot write scoring fields (`scored`, `score`, `correctCount`, etc. are admin-only).
- `teamMembers/{uid}` — user can create their own mapping **only** if `registeredEmails/{theirEmail}.registrationId == requested teamId`; leader can create mappings for new members of their team.
- `removedMembers`, `removedEmails` — leader create/delete; admin read.
- Default **deny-all** (`match /{document=**} allow read, write: if false;`).

### Storage rules
- Anyone authenticated can create/read/delete `snapshots/round1/{teamId}/{memberFolder}/{fileName}`.
- Everything else public read (`allow read: if true;`) — this is a security consideration for a future fix.

---

## 5. Registration Flow

File: `register.html` + `registration.js`.

1. Page signs in **anonymously** to Firestore (rules allow this for these writes).
2. On submit: browser-validates the form (leader required; member2/member3 optional but required when shown).
3. Reads `settings/competition.registrationOpen` — if `false`, abort.
4. **Generates a random shared password** (12–16 chars from a broad charset, crypto-random).
5. Interaction with `settings/counter` to get next ID → `GAAC-2026-XXXX` (zero-padded 4 digits). Retries up to 3× on race (batch is atomic and rules enforce `+1` and uniqueness).
6. **Single atomic batch** writes:
   - `settings/counter` → `{ lastId }`
   - `registeredTeams/{lower(teamName)}` (duplicate check first)
   - `registeredEmails/{eachEmail}` (duplicate check first)
   - `registrations/{regId}` (incl. team shared `password`)
   - `mail/{regId}` → branded confirmation email to the leader (contains Registration ID + password)
7. After batch success, **creates Firebase Auth accounts** for each member with `createUserWithEmailAndPassword(email, loginPassword)`.
   - If `auth/email-already-in-use`: tries `signInWithEmailAndPassword` with the team password to reuse the existing account; if that fails, calls the Cloud Function **`reassignMember`** (resets that Auth account's password to the team password server-side), then signs in.
   - Stamps `teamMembers/{uid} = { teamId, email }` and `registeredEmails/{email}.uid = uid`.
8. On success: shows success state. If a valid `?ref=CODE` referral was given, awards ambassador points in the **gaac-ambassador** project.

Registration IDs are sequential; the admin team is `GAAC-2026-0605` (used as `MY_TEAM_ID` in the admin page for validation).

---

## 6. Exam Login & Portal

Files: `exam-login.html`, `exam.html`, `js/exam-shared.js`, `js/exam-app.js`.

1. User enters email + team password → `signInWithEmailAndPassword` → `finishLogin`:
   - Checks `settings/competition.portalRegistrationOpen !== false`.
   - Resolves teamId via `teamMembers/{uid}` (fallback: `registeredEmails/email`).
   - Ensures the `teamMembers` doc exists so the exam rules pass.
   - Redirects to `exam.html?team={teamId}`.
2. `exam-app.js` reads `?team=`, waits for auth, resolves member name/role from `registrations/{teamId}` (matching by email to `leader`/`member2`/`member3`), and:
   - Reads `teams/{teamId}/exam/{uid}` — if already `submitted`, shows the submitted screen and stops.
   - Loads 40 questions from `round1/round1/questions` ordered by `order`.
   - Loads/saves exam state to `localStorage` (`answers`, `flagged`, `endTime`, `absoluteDeadline`, `questionOrder`).
   - **Shuffles question order on first session** and stores `questionOrder` for grading.
   - Fetches server-authoritative `absoluteDeadline`/`endTime` from the exam doc.
   - Clears stale localStorage if admin reset the team (`teams/{teamId}.resetAt`).
   - If a saved in-progress session exists, resumes (skips the requirement modal).

### Exam UI (exam.html)
- Top exam bar: big logo, language toggle (EN/عربي), timer (center), submit button (right). **No site-wide RTL — RTL only inside question cards** when Arabic is selected.
- Question palette dots + flag-for-review.
- Verify modal (`#verify-modal`) with 3 requirements: **Camera Access, Screen Sharing, Fullscreen Mode** (each with a status dot), plus `Start Exam` and its own EN/AR toggle.

### Start requirements order — CURRENT (as of latest state)
The current committed `startExam()` in `js/exam-app.js` requests them in this order:

1. **Fullscreen** (`requestFullscreen`)
2. **Camera** (`getUserMedia` front camera 320×240)
3. **Screen share** (`getDisplayMedia`)

Then all three must be `true` or it shows "Please enable all requirements above to start the exam."

> NOTE: A requested improvement (user asked, then asked to revert; final desired state = camera → screen share → fullscreen LAST) was NOT finalized. **The code currently on disk is the ORIGINAL order (fullscreen first).** Verify `git status`/actual file before trusting either.

---

## 7. Proctoring / Monitoring System

### 7.1 `js/security.js` — `SecurityWrapper`

Responsible for transition/interaction violations. Per member (`constructor(teamId, memberUid, db, onNotify, countdownConfig)`).

**State machine:** each event type has a `state` (`active`/inactive). A Firestore event doc is created ONLY on idle→active transition (dedupes continuous violations). `setActive(type, severity)` → queues; `setInactive(type)` → sets `actualSecs` and updates the doc in place. `logEvent(type, severity)` is a backwards-compatible alias of `setActive`. Events flush every 10s or at 10 queued, in a dedicated batch (then counters increment in a second batch). Max 200 events per member.

**Watched violations (event `type`s):**

| Event type | Trigger | Severity |
|---|---|---|
| `fullscreen-exit` | left fullscreen (only if it was ever entered) | severe |
| `tab-hidden` | tab hidden via `visibilitychange` | severe |
| `window-blur` | window lost focus | severe |
| `camera-stopped` | camera stream ended (track `onended` — registered in exam-app, not security.js) | severe |
| `camera-disabled` | camera track exists but disabled (AI monitor) | severe |
| `camera-covered` | canvas detection: too dark frame | severe |
| `no-face-20s` | no face for ≥15s (MediaPipe or canvas fallback) | severe |
| `multiple-faces` | >1 face for ≥5s (MediaPipe) | severe |
| `right-click`, `copy-attempt`, `cut-attempt`, `paste-attempt`, `view-source-attempt`, `print-attempt`, `devtools-attempt` | context menu / Ctrl+C/V/U/S/P / F12 / Ctrl+Shift+I | warning |
| `screenshot-attempt` | PrintScreen | severe |

**Dedupe/cooldown currently in code:** a per-event-type `setActive` guard and a 500ms `_lastTabEvent` check before logging `window-blur` after a tab-hide. **There is NO cross-event cooldown grouping** — so exiting fullscreen can currently fire `fullscreen-exit` + `tab-hidden` + `window-blur` (three severe events, three snapshots). This is a known issue the user flagged (see Planned/Desired improvements).

`start()` also:
- attempts to re-request fullscreen 1s after load,
- `_blockInteractions()` prevents context menu / copy / cut / paste / view-source / print / devtools / screenshots,
- `stop()` resolves active events with `actualSecs` and does a final flush.

### 7.2 `js/ai-monitor.js` — `AIMonitor`

- Shows a fixed bottom-right **LIVE camera PiP widget** (click to enter/exit Picture-in-Picture).
- Attaches the existing `camStream` (or opens the camera itself) to a video element.
- **Face detection (two layers):**
  1. **MediaPipe** `FaceDetection` (CDN). If it produces results within 12s it becomes the primary detector. Tracks `no-face-20s` (≥15s no face) and `multiple-faces` (≥5s, >1 face).
  2. **Canvas fallback** every 3s: draws the video to an 80×60 canvas, computes skin/brightness pixel ratios. Triggers `camera-covered` (too dark), `camera-disabled` (track disabled / no track), and `no-face-20s`.
- **Screen monitoring** every 5s: hashes a 40×30 downscale of the screen stream; when it changes, sets `screen-change` active (warning) and clears after 2 stable checks. Cache of last good screen frame.
- Exposes `captureWebcamFrame()` and `captureScreenFrame()` (used for snapshots).

### 7.3 `js/exam-app.js` — proctoring wiring

- `startSecurity()`:
  - Creates `SecurityWrapper` with callback: on severe → `captureSnapshot(msg)`; adds `fullscreen-exit:15, tab-hidden:15, window-blur:15, camera-stopped:15, screenshare-stopped:15` to `countdownConfig`.
  - Starts `AIMonitor`, passes camera + screen streams.
  - On first run, if a requirement is missing → toast + `pauseExam(missing)`.
  - Health interval (3s): absolute-deadline check (auto-submits when passed), camera track `readyState !== 'live'` → pause(`camera`), screen track not live → pause(`screenshare`).
  - `fullscreenchange`, `visibilitychange`, `focus`, `offline`/`online`, `beforeprint` listeners.
- **Pause/resume:** `pauseExam(reason)` stops timer, stores `pausedRemaining`, shows disconnect modal with a 15s countdown. `resumeExam()`/`autoResume()`/`reenable(reason)` restore via `absoluteDeadline` (never recalculated) and re-acquire camera/screen/fullscreen as needed.
- **`captureSnapshot(msg)`** (current behavior):
  - Dedupes per-message within 10s (`_lastSnapshot` object keyed by `msg`).
  - Builds path `snapshots/round1/{teamId}/{folderName}/{safeViolation}_{ts}.jpg`.
  - Currently ALWAYS grabs `_aiMonitor.captureScreenFrame()` (the screen). **It does NOT use `captureWebcamFrame()` for face violations yet** — this is a known improvement request (see Planned/Desired).

### 7.4 Timer & submission

- 60 minutes (1 hour) exam; `endTime`/`absoluteDeadline` are `Date.now() + durationMs`, written to Firestore at start.
- Timer ticks 1s; at 0 → auto `submitExam()`.
- `submitExam()`: stops all monitors/intervals, releases camera+screen tracks, writes `{ status:'submitted', submittedAt, answers, flagged, questionOrder, pausedRemaining:null }` to `teams/{teamId}/exam/{uid}`, increments `teams/{teamId}.submittedCount` by 1, clears localStorage, shows the submitted screen.

---

## 8. Scoring

File: `functions/index.js`.

**`scoreExam`** — Firestore trigger on `teams/{teamId}/exam/{examId}`:
- Runs when doc status → `submitted` (and not already scored).
- Loads answers + `questionOrder` (shuffle map), compares against `round1/round1/answerKeys` (ordered by `order`).
- Reconstructs per-index → questionId → correctAnswer. Unanswered = wrong.
- Writes per-member: `scored, score (%), correctCount, incorrectCount, unansweredCount, totalQuestions, passed (score ≥ 40), details[], scoredAt`.
- Writes team summary: `examScore, examPassed, examStatus:'scored', correctCount, totalQuestions`.

**`rescoreTeam`** — admin only: marks all submitted exams unscored → re-triggers scoring.
**`toggleDisqualify`** — admin only: flips `disqualified` on the team + all member exam docs.
**`updateCompetitionControl`** — admin only: sets `registrationOpen`, `portalRegistrationOpen`, `round1Open`, `round2Open` on `settings/competition`.
**`getCompetitionStatus`** — public: returns those flags.
**`exportData`** — admin only: CSV/JSON export of all registrations + exam + monitoring events (`includeMonitoring` flag adds an events column, last 100 events/team as JSON).
**`sendPasswordReset`** (`africa-south1`) — public callable: verifies email + registrationId server-side against `registeredEmails`, rate-limits 1/min/email, generates a single-use reset link via Admin SDK, queues branded email via `mail` (Trigger Email). Needs BOTH email + registration ID (no other identity).
**`reassignMember`** (`africa-south1`) — callable: looks up email in `registeredEmails`, forces the Auth account's password to a new password via Admin SDK (used to re-adopt orphaned accounts during registration/add-member). Requires a `uid` already on the email doc.
**`removeOrphanedAccount`** (`africa-south1`) — admin only (gate: `admins/{uid}.isAdmin`): deletes the Auth user + `teamMembers/{uid}` + `registeredEmails/{email}` + `removedMembers`/`removedEmails` audits, then strips the person from any `registrations` they still appear in (leader/member2/member3). Works for **FULL orphans** whose Firestore trace is already gone — resolves the account directly via `admin.auth().getUserByEmail(email)` instead of depending on `registeredEmails`.
**`getRegistrationInfo`** (`africa-south1`) — admin only: dossier for an email — Auth account existence + uid, email index, removal audits, teamMembers mapping, and every registration (with matched role) the person still belongs to.
**`adminAddMemberToTeam`** (`africa-south1`) — admin only: adds a member DIRECTLY to a team (bypasses the leader add flow). Guards global email uniqueness, picks the first free slot (member2 → member3), REUSES an existing/orphaned Auth account (forcing its password to the team's shared password) or creates a fresh one, then commits one atomic batch: `registeredEmails` + `teamMembers/{uid}` + `registrations/{teamId}.{slot}` + `memberCount` increment + credential email via `mail`.

**Admin tools page** — `admin-tools.html`: signed-in-admin-only UI wrapping the three admin functions above (Lookup → Release orphaned account → Add member directly). The Firestore `isAdmin()` rule and the function gates both key off `admins/{uid}.isAdmin`.

---

## 9. Team Dashboard

File: `team-dashboard.html` (self-contained).

- Login (email + team password) → resolves team from `teamMembers/{uid}` → loads `registrations/{teamId}`.
- Shows team roster with per-member cards; each member's sign-in email shown; role badges (Leader/Member 2/Member 3).
- **Leader controls** (registrationOpen + not full):
  - `#btn-toggle-add` **+ Add Team Member** button toggles an `#add-member-sheet` form.
  - Add-member flow (server-assisted): checks `settings/competition.registrationOpen`, reads registration, verifies slot availability, offers a **team-password preview**, on submit:
    1. If email already exists in `registeredEmails` with a `uid` → checks whether the existing Auth account opens with the team password; if not, calls **`reassignMember`** to force the password. Removed-member records (`removedMembers`, `removedEmails`) are checked to restore the same uid.
    2. Creates/reuses the Auth account, then a **batch** writes: `registeredEmails/{email}`, `teamMembers/{uid}`, `registrations/{teamId}.{slot}`, increments `teams/{teamId}.memberCount` (or seeds the doc), and queues a credential email via `mail`.
  - Remove-member flow: deletes `teamMembers/{uid}`, `registeredEmails/{email}`, writes `removedMembers/{uid}` + `removedEmails/{email}`, decrements `memberCount`.
- **Competitions panel** (`#competitions-panel`): tabs for Mock Test, Round 1, Round 2, Round 3 (`#comp-list`, currently `display:none`) inside a placeholder "No active competitions yet." — the list will replace the placeholder when competitions become active. Clicking a tab navigates to the exam portal.
- Password change for the leader syncs the shared team `password` in `registrations`.
- `change-password.html` — forgot password using **email + registration ID only** → calls `sendPasswordReset`.

---

## 10. Admin Panel

File: `admin-exam.html` (self-contained ES module).

- **Login:** email must equal `astronomyclub64@gmail.com` (`ADMIN_EMAIL`) AND `signInWithEmailAndPassword` must succeed. `ADMIN_EMAIL` + `MY_TEAM_ID = 'GAAC-2026-0605'` are hardcoded — the panel shows ONLY the admin's own team.
- **Dashboard view:**
  - Stats summary (score %, status, submitted count, events).
  - Team card with DQ toggle + **Reset Exam** (deletes events + exam subdocs, resets team summary counters + `resetAt`, clears `snapshots/round1/{teamId}` storage).
  - Member tabs (`leader` / `member2` / `member3`) → per-member view with member info, exam submission status/score/answers, **Event Log filtered to that member** (`e.memberUid === m.uid`), and **Snapshots grid** filtered to that member's snapshot folder.
- Reads `teams/{teamId}/exam/{uid}` per member and `teams/{teamId}/events` (ordered desc, newest 30 shown), `registrations/{teamId}`.
- **Seed Questions button:** uploads the 40 static questions (`SEED_QUESTIONS` array, with Arabic translations) into `round1/round1/questions` + `round1/round1/answerKeys` via a Firestore batch. (The `correctAnswer` is only in `answerKeys`, never in questions — rules enforce this.)
- Event severity handling: `continuousTypes` (`fullscreen-exit`, `tab-hidden`, `window-blur`, `camera-disabled`, `camera-covered`, `no-face-20s`, `multiple-faces`) show "active" duration while the event is unresolved.
- Snapshot folder→member mapping: folder `{safeName}_{safeRole}` mapped to member index; also falls back to matching by `uid`.

> Note: The user plans to use a **standalone admin tool (read data once, even from Excel)** for the single Round 1 — the current admin page is a test harness; a richer per-round tool is a future task.

---

## 11. Known Issues / Desired Improvements (user-reported, not yet finalized)

The user asked for these changes, then asked to revert the working tree to the last commit. Treat the following as the **user's desired behavior** (design notes), NOT necessarily applied in the code right now:

1. **Requirement order at exam start** → should be **camera → screen share → fullscreen LAST** (avoid asking fullscreen before the user has granted camera/screen, which produces a confusing "enable all requirements" error).
2. **No-face snapshot source** → when `no-face-20s` (or other camera/face violations) fire, `captureSnapshot` should capture the **webcam frame** (`captureWebcamFrame()`), not a screen screenshot.
3. **Exit-screen triplication** → one user action (leaving fullscreen) currently produces three severe events + multiple screenshots (`fullscreen-exit`, `tab-hidden`, `window-blur`). Desired: collapse into ONE violation + ONE snapshot (e.g. a ~2s cross-event cooldown in `SecurityWrapper` + a global snapshot dedupe window in `captureSnapshot`).
4. **Admin per-member scoping** — event docs must carry `memberUid` (partially addressed — see note below), and the admin must filter event logs + snapshots per individual member. File: `security.js` (`setActive` event payload) + `admin-exam.html` (event table filter).

### Current code status vs. those items
- `SecurityWrapper` event payload: **does NOT include `memberUid`** in the flushed doc (the constructor stores it, but `setActive` only pushes `{localId,type,severity,timestamp,countdownSecs}`). The admin page filters events by `e.memberUid || e.uid` — so per-member event logs require adding `memberUid` to the event payload.
- Exam start order: original = fullscreen first (NOT yet changed).
- `captureSnapshot`: screen-only (NOT yet changed).
- Cascade dedupe: per-type only (NOT yet changed).

---

## 12. Deployment / Git / Ops Notes

- **Repo:** `github.com/youse7abib/gaac-astro`, branch `main`.
- **Deploys:** `firebase deploy --only hosting` pushes static files to Firebase Hosting. Vercel builds from GitHub `main` — so to update the live Vercel site you must `git push`. Firebase and Vercel can drift if you deploy only to Firebase.
- `functions/` deploys separately: `firebase deploy --only functions` (some functions use `region: 'africa-south1'`).
- Rules deploy: `firebase deploy --only firestore:rules,storage`.
- **Git hygiene:** the user wants **manual/asked pushes only** — never auto-push; committing locally is fine but confirm before pushing.
- Temp/secret files are git-ignored (`auth-export.json`, `all-registered-emails.txt`, `temp-reset.*`, `proctora-ref/`).
- Last known git state (before any pending working-tree changes): `HEAD` at `7ded5b5` "Hide competition blocks until active" (+ `1350b7d` before it). The three files `admin-exam.html`, `js/exam-app.js`, `js/security.js` were reverted to committed state — `git status` should show a clean tree.

---

## 13. Quick File Index

| File | Role |
|---|---|
| `index.html`, `syllabus.html`, `timeline.html`, `partners.html`, `awards.html` | Public pages |
| `register.html` + `registration.js` | Team registration (batch + auth creation + reassign) |
| `team-dashboard.html` | Login + roster + add/remove member + competitions panel |
| `exam-login.html` | Email+password login → `exam.html?team=` |
| `exam.html` + `js/exam-app.js` | Exam UI + proctoring wiring + timer + submit |
| `js/exam-shared.js` | Firebase app/auth/db/storage singleton |
| `js/security.js` | `SecurityWrapper` — violation events + dedupe + interaction blocking |
| `js/ai-monitor.js` | `AIMonitor` — face detection (MediaPipe + canvas), screen-change, frame capture |
| `admin-exam.html` | Single-team admin monitor + question seeder |
| `admin-tools.html` | Admin: lookup / release-orphaned-account / direct add-member (`getRegistrationInfo`, `removeOrphanedAccount`, `adminAddMemberToTeam`) |
| `reset-exam.html` | Admin-side exam reset helper |
| `change-password.html` | Forgot password (email + registration ID) |
| `ambassador*.html` | Ambassador referral pages |
| `functions/index.js` | All Cloud Functions (scoring, admin ops, resets, export, password/reassign) |
| `firestore.rules` | Firestore security rules |
| `storage.rules` | Storage rules |
| `firebase.json` | Hosting/functions/rules config |
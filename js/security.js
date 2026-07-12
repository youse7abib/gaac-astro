export class SecurityWrapper {
  constructor(teamId, db, onNotify = null, countdownConfig = {}) {
    this.teamId = teamId;
    this.db = db;
    this.eventQueue = [];
    this.flushTimer = null;
    this.active = true;
    this.onNotify = onNotify;
    this.eventCount = 0;
    this.maxEvents = 200;
    // State machine: { [type]: { state:'active', startTime, localId } }
    this.eventStates = {};
    // Baseline tracking: only log "bad" state if we've seen the "good" state first
    this.hasBeenFullscreen = !!document.fullscreenElement;
    this.hasBeenVisible = !document.hidden;
    this.hasBeenFocused = document.hasFocus();
    // Countdown duration per event type (seconds), for admin display
    this.countdownConfig = countdownConfig;
    // Unique local ID per event, used to match recovery updates to flushed docs
    this.nextLocalId = 0;
    // { localId: docRef } — set after flush, so recovery can update the doc in-place
    this.pendingFlush = {};
    // LocalIds currently being committed (to queue updates that arrive mid-commit)
    this._inFlight = new Set();
    // { localId: data } — updates that arrived while event was in-flight
    this._pendingUpdates = {};
  }

  start() {
    this._requestFullscreen();
    this._watchFullscreen();
    this._watchVisibility();
    this._watchFocus();
    this._blockInteractions();
    this._startFlushTimer();
  }

  async stop() {
    this.active = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    // Resolve all still-active events with their actual duration
    for (const [type, state] of Object.entries(this.eventStates)) {
      const actualSecs = (Date.now() - state.startTime) / 1000;
      const idx = this.eventQueue.findIndex(e => e.localId === state.localId);
      if (idx !== -1) {
        this.eventQueue[idx].actualSecs = actualSecs;
      }
      const ref = this.pendingFlush[state.localId];
      if (ref) {
        delete this.pendingFlush[state.localId];
        this._updateDoc(ref, { actualSecs });
      }
    }
    this.eventStates = {};
    // Flush remaining queue (final write)
    await this._flush();
  }

  /**
   * Mark an event as active (condition started).
   * Creates a Firestore document ONLY on idle→active transition.
   * Returns true if queued, false if suppressed (already active).
   */
  setActive(type, severity = 'warning') {
    if (!this.active) return false;
    if (this.eventCount >= this.maxEvents) return false;
    if (this.eventStates[type]?.state === 'active') return false;

    this.eventCount++;
    const localId = ++this.nextLocalId;
    this.eventStates[type] = { state: 'active', startTime: Date.now(), localId };

    this.eventQueue.push({
      localId,
      type,
      severity,
      timestamp: new Date().toISOString(),
      countdownSecs: this.countdownConfig[type] || 0
    });

    if (this.eventQueue.length >= 10) this._flush();
    return true;
  }

  /**
   * Mark an event as inactive (condition ended).
   * Resets to idle so the NEXT occurrence will create a new document.
   * While the condition remains ACTIVE, absolutely no new document is created.
   */
  setInactive(type) {
    if (!this.active) return;
    const state = this.eventStates[type];
    if (!state) return;
    const actualSecs = (Date.now() - state.startTime) / 1000;
    const localId = state.localId;
    delete this.eventStates[type];

    // If event still in the queue, update it there (no extra write)
    const idx = this.eventQueue.findIndex(e => e.localId === localId);
    if (idx !== -1) {
      this.eventQueue[idx].actualSecs = actualSecs;
      return;
    }

    // Already flushed — do a single extra write to update the doc
    const ref = this.pendingFlush[localId];
    if (ref) {
      delete this.pendingFlush[localId];
      this._updateDoc(ref, { actualSecs });
      return;
    }

    // Being committed right now — queue for after commit
    if (this._inFlight.has(localId)) {
      this._pendingUpdates[localId] = { actualSecs };
    }
  }

  async _updateDoc(ref, data) {
    if (!this._setDoc) return;
    try {
      await this._setDoc(ref, data, { merge: true });
    } catch (e) {
      console.warn('Failed to update event duration:', e);
    }
  }

  /** Backward-compatible wrapper — delegates to setActive */
  logEvent(type, severity = 'warning') {
    this.setActive(type, severity);
  }

  requestFullscreen() {
    if (!document.fullscreenElement && this.active) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  _requestFullscreen() {
    // One-time attempt to enter fullscreen on load
    setTimeout(() => this.requestFullscreen(), 1000);
  }

  _watchFullscreen() {
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        this.hasBeenFullscreen = true;
        this.setInactive('fullscreen-exit');
      } else if (this.active && this.hasBeenFullscreen) {
        this.setActive('fullscreen-exit', 'severe');
        if (this.onNotify) this.onNotify('You exited fullscreen mode. The exam has been paused.', 'severe');
      }
    });
  }

  _watchVisibility() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.hasBeenVisible = true;
        this.setInactive('tab-hidden');
      } else if (this.active && this.hasBeenVisible) {
        this.setActive('tab-hidden', 'severe');
        if (this.onNotify) this.onNotify('You switched away from the exam tab. This is being recorded.', 'severe');
      }
    });
  }

  _watchFocus() {
    window.addEventListener('blur', () => {
      if (this.active && this.hasBeenFocused) {
        this.setActive('window-blur', 'severe');
        if (this.onNotify) this.onNotify('Exam window lost focus. Please return to the exam.', 'severe');
      }
    });
    window.addEventListener('focus', () => {
      this.hasBeenFocused = true;
      this.setInactive('window-blur');
    });
  }

  _blockInteractions() {
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.setActive('right-click', 'warning');
    });
    document.addEventListener('copy', (e) => {
      e.preventDefault();
      this.setActive('copy-attempt', 'warning');
    });
    document.addEventListener('cut', (e) => {
      e.preventDefault();
      this.setActive('cut-attempt', 'warning');
    });
    document.addEventListener('paste', (e) => {
      e.preventDefault();
      this.setActive('paste-attempt', 'warning');
    });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 'c' || e.key === 'v' || e.key === 'u' || e.key === 's' || e.key === 'p')) {
        e.preventDefault();
        if (e.key === 'c') this.setActive('copy-attempt', 'warning');
        if (e.key === 'v') this.setActive('paste-attempt', 'warning');
        if (e.key === 'u') this.setActive('view-source-attempt', 'warning');
        if (e.key === 'p') this.setActive('print-attempt', 'warning');
      }
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        e.preventDefault();
        this.setActive('devtools-attempt', 'warning');
      }
      if (e.key === 'PrintScreen' || e.key === 'F13') {
        e.preventDefault();
        this.setActive('screenshot-attempt', 'severe');
      }
    });
    // Detect PrintScreen via clipboard change (some browsers)
    document.addEventListener('keyup', (e) => {
      if (e.key === 'PrintScreen') {
        this.setActive('screenshot-attempt', 'severe');
      }
    });
  }

  _startFlushTimer() {
    this.flushTimer = setInterval(() => this._flush(), 10000);
  }

  async _flush() {
    if (this.eventQueue.length === 0 || !this.db) return;
    const batch = this.eventQueue.splice(0, this.eventQueue.length);
    const localIds = batch.map(e => e.localId);
    this._inFlight = new Set([...this._inFlight, ...localIds]);
    try {
      const { writeBatch, doc, collection, increment, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      this._setDoc = setDoc;
      const b = writeBatch(this.db);

      // Count severe events in this batch
      let severeCount = 0;
      const refs = {};
      batch.forEach((evt) => {
        if (evt.severity === 'severe') severeCount++;
        const ref = doc(collection(this.db, 'teams', this.teamId, 'events'));
        refs[evt.localId] = ref;
        b.set(ref, evt);
      });

      // Atomically update counters on the exam doc
      const examRef = doc(this.db, 'teams', this.teamId, 'exam', 'round1');
      b.set(examRef, {
        eventCount: increment(batch.length),
        severeEventCount: increment(severeCount)
      }, { merge: true });

      await b.commit();

      // After commit succeeds, set pendingFlush for still-active events
      for (const [type, state] of Object.entries(this.eventStates)) {
        if (state.localId && refs[state.localId]) {
          this.pendingFlush[state.localId] = refs[state.localId];
        }
      }

      // Apply any updates that arrived while this batch was in-flight
      for (const localId of localIds) {
        if (this._pendingUpdates[localId]) {
          const ref = refs[localId];
          await this._updateDoc(ref, this._pendingUpdates[localId]);
          delete this._pendingUpdates[localId];
        }
        this._inFlight.delete(localId);
      }
    } catch (e) {
      console.warn('Failed to flush events:', e);
      this.eventQueue.push(...batch);
      localIds.forEach(id => this._inFlight.delete(id));
    }
  }
}

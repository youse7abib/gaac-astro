export class SecurityWrapper {
  constructor(teamId, memberUid, db, onNotify = null, countdownConfig = {}, options = {}) {
    this.teamId = teamId;
    this.memberUid = memberUid;
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
    this.requireFullscreen = options.requireFullscreen !== false;
    this.ignoreEventsUntil = options.ignoreEventsUntil || {};
    // Unique local ID per event, used to match recovery updates to flushed docs
    this.nextLocalId = 0;
    // { localId: docRef } — set after flush, so recovery can update the doc in-place
    this.pendingFlush = {};
    // LocalIds currently being committed (to queue updates that arrive mid-commit)
    this._inFlight = new Set();
    // { localId: data } — updates that arrived while event was in-flight
    this._pendingUpdates = {};
    this.transitionEventTypes = new Set(['fullscreen-exit', 'tab-hidden', 'window-blur']);
    this.transitionCooldownMs = 2000;
    this._lastTransitionEvent = null;
  }

  start() {
    if (this.requireFullscreen) this._requestFullscreen();
    if (this.requireFullscreen) this._watchFullscreen();
    this._watchVisibility();
    this._watchFocus();
    this._blockInteractions();
    this._startFlushTimer();
  }

  async stop() {
    this.active = false;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this._oneShotTimers) Object.values(this._oneShotTimers).forEach(t => clearTimeout(t));
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
    // Note: event counters are NOT written to Firestore during the exam or on
    // submission. Events are stored individually, so the admin can compute the
    // total/severe counts from the stored events after the exam. This avoids
    // redundant writes entirely.
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
    if (Date.now() < (this.ignoreEventsUntil[type] || 0)) return false;
    if (this.eventCount >= this.maxEvents) return false;
    if (this.eventStates[type]?.state === 'active') return false;

    if (this.transitionEventTypes.has(type)) {
      const now = Date.now();
      if (
        this._lastTransitionEvent &&
        this._lastTransitionEvent.type !== type &&
        now - this._lastTransitionEvent.at < this.transitionCooldownMs
      ) {
        return false;
      }
      this._lastTransitionEvent = { type, at: now };
    }

    this.eventCount++;
    const localId = ++this.nextLocalId;
    this.eventStates[type] = { state: 'active', startTime: Date.now(), localId };

    this.eventQueue.push({
      localId,
      memberUid: this.memberUid,
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
    return this.setActive(type, severity);
  }

  _resetOneShot(type, delayMs = 1000) {
    if (this._oneShotTimers?.[type]) clearTimeout(this._oneShotTimers[type]);
    if (!this._oneShotTimers) this._oneShotTimers = {};
    this._oneShotTimers[type] = setTimeout(() => this.setInactive(type), delayMs);
  }

  requestFullscreen() {
    if (this.requireFullscreen && !document.fullscreenElement && this.active) {
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
        if (this.setActive('fullscreen-exit', 'severe') && this.onNotify) {
          this.onNotify('You exited fullscreen mode. The exam has been paused.', 'severe', 'fullscreen-exit');
        }
      }
    });
  }

  _watchVisibility() {
    this._lastTabEvent = 0;
    const handleHidden = () => {
      if (this.active && this.hasBeenVisible) {
        this._lastTabEvent = Date.now();
        if (this.setActive('tab-hidden', 'severe') && this.onNotify) {
          this.onNotify('You switched away from the exam tab. This is being recorded.', 'severe', 'tab-hidden');
        }
      }
    };
    const handleVisible = () => {
      this.hasBeenVisible = true;
      this.setInactive('tab-hidden');
    };

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) handleHidden();
      else handleVisible();
    });
    window.addEventListener('pagehide', handleHidden);
    window.addEventListener('pageshow', handleVisible);
  }

  _watchFocus() {
    window.addEventListener('blur', () => {
      if (this.active && this.hasBeenFocused) {
        if (Date.now() - (this._lastTabEvent || 0) < 500) return;
        if (this.setActive('window-blur', 'severe') && this.onNotify) {
          this.onNotify('Exam window lost focus. Please return to the exam.', 'severe', 'window-blur');
        }
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
      if (this.setActive('right-click', 'warning')) this._resetOneShot('right-click');
    });
    document.addEventListener('copy', (e) => {
      e.preventDefault();
      if (this.setActive('copy-attempt', 'warning')) this._resetOneShot('copy-attempt');
    });
    document.addEventListener('cut', (e) => {
      e.preventDefault();
      if (this.setActive('cut-attempt', 'warning')) this._resetOneShot('cut-attempt');
    });
    document.addEventListener('paste', (e) => {
      e.preventDefault();
      if (this.setActive('paste-attempt', 'warning')) this._resetOneShot('paste-attempt');
    });
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 'c' || e.key === 'v' || e.key === 'u' || e.key === 's' || e.key === 'p')) {
        e.preventDefault();
        if (e.key === 'c') { if (this.setActive('copy-attempt', 'warning')) this._resetOneShot('copy-attempt'); }
        if (e.key === 'v') { if (this.setActive('paste-attempt', 'warning')) this._resetOneShot('paste-attempt'); }
        if (e.key === 'u') { if (this.setActive('view-source-attempt', 'warning')) this._resetOneShot('view-source-attempt'); }
        if (e.key === 'p') { if (this.setActive('print-attempt', 'warning')) this._resetOneShot('print-attempt'); }
      }
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        e.preventDefault();
        if (this.setActive('devtools-attempt', 'warning')) this._resetOneShot('devtools-attempt');
      }
      if (e.key === 'PrintScreen' || e.key === 'F13') {
        e.preventDefault();
        if (this.setActive('screenshot-attempt', 'severe')) this._resetOneShot('screenshot-attempt');
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'PrintScreen') {
        if (this.setActive('screenshot-attempt', 'severe')) this._resetOneShot('screenshot-attempt');
      }
    });
  }

  _startFlushTimer() {
    this.flushTimer = setInterval(() => this._flush(), 20000);
  }

  async _flush() {
    if (this.eventQueue.length === 0 || !this.db) return;
    const batch = this.eventQueue.splice(0, this.eventQueue.length);
    const localIds = batch.map(e => e.localId);
    this._inFlight = new Set([...this._inFlight, ...localIds]);
    try {
      const { writeBatch, doc, collection, increment, setDoc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
      this._setDoc = setDoc;

      // STEP 1: Write events in their OWN batch — no other operations.
      // This ensures events are always persisted even if counter updates fail.
      const eventBatch = writeBatch(this.db);
      const refs = {};
      this.flushedEvents = this.flushedEvents || [];
      batch.forEach((evt) => {
        const ref = doc(collection(this.db, 'teams', this.teamId, 'events'));
        refs[evt.localId] = ref;
        eventBatch.set(ref, evt);
        this.flushedEvents.push(evt);
      });
      await eventBatch.commit();
      console.log('[Security] Flushed', batch.length, 'events to Firestore');

      // NOTE: event counters are now written once at submit (in stop()),
      // eliminating ~360 writes/hour per student.


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
      console.error('[Security] Failed to flush events:', e);
      this.eventQueue.push(...batch);
      localIds.forEach(id => this._inFlight.delete(id));
    }
  }
}

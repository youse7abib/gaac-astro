export class AIMonitor {
  constructor(securityWrapper, existingStream = null, onNotify = null) {
    this.security = securityWrapper;
    this.onNotify = onNotify;
    this.faceDetection = null;
    this.video = null;
    this.stream = existingStream;
    this.faceInterval = null;
    this.screenInterval = null;
    this.lastScreenHash = null;
    this.noFaceStart = null;
    this.running = false;
    this.camContainer = null;
    this.faceState = 'unknown';
    this.noFaceDuration = 0;
    this.multipleFacesActive = false;
    this.multipleFacesDuration = 0;
    this.screenActive = false;
    this.screenStableChecks = 0;
    this.cameraDisabledActive = false;
  }

  async start() {
    console.log('[AIMonitor] start() called, stream=', !!this.stream);
    this.running = true;
    try {
      if (!this.stream) {
        await this._initCamera();
      } else {
        await this._initVideoFromStream();
      }
      console.log('[AIMonitor] video ready, calling _initFaceDetection...');
      this._initFaceDetection();
      this._initScreenMonitoring();
    } catch (e) {
      console.error('[AIMonitor] start() error:', e);
    }
  }

  _createCameraUI() {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.bottom = '10px';
    container.style.right = '10px';
    container.style.width = '144px';
    container.style.height = '108px';
    container.style.borderRadius = '12px';
    container.style.padding = '2px';
    container.style.background = 'linear-gradient(135deg, rgba(38,183,255,0.2), rgba(38,183,255,0.05))';
    container.style.border = '1px solid rgba(38,183,255,0.15)';
    container.style.boxShadow = '0 0 20px rgba(38,183,255,0.1), inset 0 0 20px rgba(38,183,255,0.03)';
    container.style.zIndex = '2147483647';
    container.style.pointerEvents = 'none';
    const label = document.createElement('div');
    label.textContent = '\u25CF LIVE';
    label.style.cssText = 'position:absolute;top:4px;left:6px;font-size:9px;color:#51cf66;letter-spacing:1px;font-weight:600;text-shadow:0 0 4px rgba(0,0,0,0.8);pointer-events:none;';
    container.appendChild(label);
    const vid = document.createElement('video');
    vid.width = 320;
    vid.height = 240;
    vid.style.width = '100%';
    vid.style.height = '100%';
    vid.style.display = 'block';
    vid.style.borderRadius = '10px';
    vid.style.objectFit = 'cover';
    vid.style.cursor = 'pointer';
    vid.style.pointerEvents = 'auto';
    vid.muted = true;
    vid.playsInline = true;
    vid.setAttribute('playsinline', '');
    vid.addEventListener('click', () => this._togglePiP());
    vid.addEventListener('enterpictureinpicture', () => { vid.style.display = 'none'; });
    vid.addEventListener('leavepictureinpicture', () => { vid.style.display = ''; });
    container.appendChild(vid);
    this.camContainer = container;
    return vid;
  }

  async _initVideoFromStream() {
    try {
      this.video = this._createCameraUI();
      document.body.appendChild(this.camContainer);
      this.video.srcObject = this.stream;
      await new Promise(r => { this.video.onloadedmetadata = r; setTimeout(r, 3000); });
      await this.video.play();
    } catch (e) {
      this.security.logEvent('camera-init-failed', 'severe');
    }
  }

  async _togglePiP() {
    try {
      if (document.pictureInPictureElement === this.video) {
        await document.exitPictureInPicture();
        this.video.style.display = '';
      } else if (document.pictureInPictureEnabled) {
        await this.video.requestPictureInPicture();
      }
    } catch (e) { /* ignore */ }
  }

  async setStream(newStream) {
    this.stream = newStream;
    if (this.video) {
      this.video.srcObject = newStream;
      try { await this.video.play(); } catch (e) { /* ignore */ }
    }
  }

  stop() {
    this.running = false;
    if (this.faceInterval) clearInterval(this.faceInterval);
    if (this.screenInterval) clearInterval(this.screenInterval);
    if (document.pictureInPictureElement === this.video) document.exitPictureInPicture();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.camContainer) this.camContainer.remove();
  }

  async _initCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
      this.video = this._createCameraUI();
      document.body.appendChild(this.camContainer);
      this.video.srcObject = this.stream;
      await new Promise(r => { this.video.onloadedmetadata = r; setTimeout(r, 3000); });
      await this.video.play();
    } catch (e) {
      this.security.logEvent('camera-denied', 'severe');
    }
  }

  _initFaceDetection() {
    console.log('[AIMonitor] _initFaceDetection, typeof FaceDetection =', typeof FaceDetection);
    if (typeof FaceDetection === 'undefined') {
      console.log('[AIMonitor] MediaPipe FaceDetection not loaded, using fallback');
      this._startCameraFallback();
      return;
    }

    console.log('[AIMonitor] Initializing MediaPipe FaceDetection');
    try {
      this.faceDetection = new FaceDetection({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
        minDetectionConfidence: 0.6
      });

      this.faceDetection.setOptions({ modelSelection: 0 });
      this.faceDetection.onResults((results) => {
        if (!this.running) return;
        const faces = results.detections || [];
        console.log('[AIMonitor] detection cycle:', faces.length, 'face(s)');

        if (faces.length === 0) {
          this.noFaceDuration += 3000;
          this.multipleFacesDuration = 0;
          if (this.faceState !== 'no-face' && this.noFaceDuration >= 20000) {
            this.faceState = 'no-face';
            console.log('[AIMonitor] TRIGGER: no-face-20s');
            this.security.setActive('no-face-20s', 'severe');
            if (this.onNotify) this.onNotify('No face detected for 20 seconds. Ensure your camera is on you.', 'severe');
          }
        } else {
          this.noFaceDuration = 0;
          if (this.faceState === 'no-face') {
            this.faceState = 'face';
            console.log('[AIMonitor] RESOLVE: no-face-20s');
            this.security.setInactive('no-face-20s');
          }
          if (faces.length > 1) {
            this.multipleFacesDuration += 3000;
            if (this.multipleFacesDuration >= 5000 && !this.multipleFacesActive) {
              this.multipleFacesActive = true;
              console.log('[AIMonitor] TRIGGER: multiple-faces');
              this.security.setActive('multiple-faces', 'severe');
              if (this.onNotify) this.onNotify('Multiple faces detected. Only you should be visible.', 'severe');
            }
          } else {
            this.multipleFacesDuration = 0;
            if (this.multipleFacesActive) {
              this.multipleFacesActive = false;
              console.log('[AIMonitor] RESOLVE: multiple-faces');
              this.security.setInactive('multiple-faces');
            }
          }
        }
      });

      this.faceInterval = setInterval(async () => {
        if (!this.running || !this.video || !this.video.videoWidth) return;
        try {
          await this.faceDetection.send({ image: this.video });
        } catch (e) { /* empty/transition frames */ }
      }, 3000);

    } catch (e) {
      console.warn('[AIMonitor] MediaPipe init failed, using fallback:', e);
      this._startCameraFallback();
    }
  }

  _startCameraFallback() {
    console.log('[AIMonitor] Starting camera-fallback monitoring');
    this.faceInterval = setInterval(() => {
      if (!this.running) return;
      const track = this.stream?.getVideoTracks()[0];
      if (track && !track.enabled) {
        if (!this.cameraDisabledActive) {
          this.cameraDisabledActive = true;
          console.log('[AIMonitor] TRIGGER: camera-disabled (fallback)');
          this.security.setActive('camera-disabled', 'severe');
        }
      } else {
        if (this.cameraDisabledActive) {
          this.cameraDisabledActive = false;
          console.log('[AIMonitor] RESOLVE: camera-disabled (fallback)');
          this.security.setInactive('camera-disabled');
        }
      }
    }, 3000);
  }

  _initScreenMonitoring() {
    this.screenInterval = setInterval(() => {
      if (!this.running) return;
      const hash = this._captureScreenHash();
      if (this.lastScreenHash && hash !== this.lastScreenHash) {
        this.screenStableChecks = 0;
        if (!this.screenActive) {
          this.screenActive = true;
          this.security.setActive('screen-change', 'warning');
        }
      } else {
        if (this.screenActive) {
          this.screenStableChecks++;
          if (this.screenStableChecks >= 2) {
            this.screenActive = false;
            this.screenStableChecks = 0;
            this.security.setInactive('screen-change');
          }
        }
      }
      this.lastScreenHash = hash;
    }, 5000);
  }

  _captureScreenHash() {
    try {
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 30;
      const ctx = c.getContext('2d');
      ctx.drawImage(this.video || document.body, 0, 0, 40, 30);
      const data = ctx.getImageData(0, 0, 40, 30).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) sum += data[i];
      return sum;
    } catch (e) {
      return 0;
    }
  }
}

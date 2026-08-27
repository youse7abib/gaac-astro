export class AIMonitor {
  constructor(securityWrapper, existingStream = null, onNotify = null) {
    this.security = securityWrapper;
    this.onNotify = onNotify;
    this.faceDetection = null;
    this.video = null;
    this.stream = existingStream;
    this.screenStream = null;
    this.faceInterval = null;
    this.screenInterval = null;
    this.lastScreenHash = null;
    this.running = false;
    this.camContainer = null;
    this.faceState = 'unknown';
    this.noFaceDuration = 0;
    this.multipleFacesActive = false;
    this.multipleFacesDuration = 0;
    this.screenActive = false;
    this.screenStableChecks = 0;
    this.cameraDisabledActive = false;
    this._faceCanvas = null;
    this._faceCtx = null;
    this._faceDetections = 0;
    this._faceCycles = 0;
    this._lastGoodCamCanvas = null;
    this._lastGoodScreenCanvas = null;
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
      console.log('[AIMonitor] video ready, starting face detection...');
      this._startFaceDetection();
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
      console.log('[AIMonitor] video playing, videoWidth=', this.video.videoWidth);
    } catch (e) {
      console.warn('[AIMonitor] _initVideoFromStream error:', e);
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

  setScreenStream(screenStream) {
    this.screenStream = screenStream;
    if (screenStream) {
      if (this._screenVideoEl) {
        this._screenVideoEl.srcObject = screenStream;
      } else {
        const vid = document.createElement('video');
        vid.muted = true;
        vid.playsInline = true;
        vid.style.display = 'none';
        vid.srcObject = screenStream;
        vid.play().catch(() => {});
        this._screenVideoEl = vid;
        document.body.appendChild(vid);
      }
      console.log('[AIMonitor] setScreenStream: screen monitoring source updated, tracks=', screenStream.getVideoTracks().length);
    } else {
      console.log('[AIMonitor] setScreenStream: screen stream cleared');
      if (this._screenVideoEl) {
        this._screenVideoEl.srcObject = null;
      }
    }
  }

  stop() {
    this.running = false;
    if (this.faceInterval) clearInterval(this.faceInterval);
    if (this.screenInterval) clearInterval(this.screenInterval);
    if (document.pictureInPictureElement === this.video) document.exitPictureInPicture();
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
    if (this._screenVideoEl) { this._screenVideoEl.srcObject = null; this._screenVideoEl.remove(); }
    if (this.camContainer) this.camContainer.remove();
  }

  captureWebcamFrame() {
    if (!this.video || !this.video.videoWidth) {
      return this._lastGoodCamCanvas;
    }
    try {
      const c = document.createElement('canvas');
      c.width = this.video.videoWidth;
      c.height = this.video.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(this.video, 0, 0);
      const data = ctx.getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 48)).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) sum += data[i] + data[i+1] + data[i+2];
      const avg = sum / (data.length / 16 * 3);
      if (avg > 8) {
        this._lastGoodCamCanvas = c;
        return c;
      }
      return this._lastGoodCamCanvas;
    } catch (e) {
      console.warn('[AIMonitor] captureWebcamFrame failed:', e);
      return this._lastGoodCamCanvas;
    }
  }

  captureScreenFrame() {
    if (!this._screenVideoEl || !this._screenVideoEl.videoWidth) {
      return this._lastGoodScreenCanvas;
    }
    try {
      const c = document.createElement('canvas');
      c.width = this._screenVideoEl.videoWidth;
      c.height = this._screenVideoEl.videoHeight;
      const ctx = c.getContext('2d');
      ctx.drawImage(this._screenVideoEl, 0, 0);
      const data = ctx.getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 48)).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) sum += data[i] + data[i+1] + data[i+2];
      const avg = sum / (data.length / 16 * 3);
      if (avg > 8) {
        this._lastGoodScreenCanvas = c;
        return c;
      }
      return this._lastGoodScreenCanvas;
    } catch (e) {
      console.warn('[AIMonitor] captureScreenFrame failed:', e);
      return this._lastGoodScreenCanvas;
    }
  }

  async _initCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 320, height: 240 } });
      this.video = this._createCameraUI();
      document.body.appendChild(this.camContainer);
      this.video.srcObject = this.stream;
      await new Promise(r => { this.video.onloadedmetadata = r; setTimeout(r, 3000); });
      await this.video.play();
      console.log('[AIMonitor] camera video playing, videoWidth=', this.video.videoWidth);
    } catch (e) {
      console.warn('[AIMonitor] _initCamera error:', e);
      this.security.logEvent('camera-denied', 'severe');
    }
  }

  _startFaceDetection() {
    this._faceCanvas = document.createElement('canvas');
    this._faceCanvas.width = 80;
    this._faceCanvas.height = 60;
    this._faceCtx = this._faceCanvas.getContext('2d', { willReadFrequently: true });
    this._useMediaPipe = false;

    if (typeof FaceDetection !== 'undefined') {
      console.log('[AIMonitor] MediaPipe available, attempting initialization...');
      this._initMediaPipe();
    } else {
      console.log('[AIMonitor] MediaPipe not available, using canvas-only detection');
    }

    this._startCanvasDetection();
  }

  _initMediaPipe() {
    try {
      const fd = new FaceDetection({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`,
        minDetectionConfidence: 0.6
      });
      fd.setOptions({ modelSelection: 0 });
      fd.onResults((results) => {
        if (!this.running) return;
        if (!this._useMediaPipe) {
          this._useMediaPipe = true;
          console.log('[AIMonitor] MediaPipe initialized successfully — using as primary');
        }
        const faces = results.detections || [];
        console.log('[AIMonitor] MediaPipe detection:', faces.length, 'face(s)');

        if (faces.length === 0) {
          this.noFaceDuration += 3000;
          this.multipleFacesDuration = 0;
          if (this.faceState !== 'no-face' && this.noFaceDuration >= 15000) {
            this.faceState = 'no-face';
            console.log('[AIMonitor] TRIGGER: no-face-20s (mediapipe)');
            this.security.setActive('no-face-20s', 'severe');
            if (this.onNotify) this.onNotify('No face detected for 15 seconds. Ensure your camera is on you.', 'severe');
          }
        } else {
          this.noFaceDuration = 0;
          this._faceDetections++;
          if (this.faceState === 'no-face') {
            this.faceState = 'face';
            console.log('[AIMonitor] RESOLVE: no-face-20s (mediapipe)');
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

      const mpInterval = setInterval(async () => {
        if (!this.running || this._useMediaPipe) return;
        try {
          await fd.send({ image: this.video });
        } catch (e) {
          console.warn('[AIMonitor] MediaPipe send() failed:', e.message || e);
        }
      }, 3000);

      setTimeout(() => {
        if (!this._useMediaPipe && this.running) {
          console.log('[AIMonitor] MediaPipe did not produce results in 12s — relying on canvas detection');
          clearInterval(mpInterval);
        }
      }, 12000);

    } catch (e) {
      console.warn('[AIMonitor] MediaPipe init failed:', e);
    }
  }

  _startCanvasDetection() {
    const checkInterval = 3000;
    let cycleCount = 0;
    let lastLogType = null;

    this.faceInterval = setInterval(() => {
      if (!this.running) return;
      cycleCount++;
      this._faceCycles = cycleCount;

      const track = this.stream?.getVideoTracks()[0];
      if (!track) {
        if (!this.cameraDisabledActive) {
          this.cameraDisabledActive = true;
          console.log('[AIMonitor] TRIGGER: camera-stopped (no track)');
          this.security.logEvent('camera-stopped', 'severe');
        }
        return;
      }
      if (!track.enabled) {
        if (!this.cameraDisabledActive) {
          this.cameraDisabledActive = true;
          console.log('[AIMonitor] TRIGGER: camera-disabled');
          this.security.setActive('camera-disabled', 'severe');
        }
        return;
      }
      if (this.cameraDisabledActive) {
        this.cameraDisabledActive = false;
        console.log('[AIMonitor] RESOLVE: camera-disabled');
        this.security.setInactive('camera-disabled');
      }

      if (!this.video) {
        console.warn('[AIMonitor] canvas detection: no video element');
        return;
      }

      try {
        if (this.video.videoWidth > 0) {
          this._faceCtx.drawImage(this.video, 0, 0, 80, 60);
          this.captureWebcamFrame();
        } else {
          if (cycleCount % 10 === 1) console.warn('[AIMonitor] videoWidth=0, canvas detection limited');
          return;
        }
        const data = this._faceCtx.getImageData(0, 0, 80, 60).data;
        let skinPixels = 0;
        let brightPixels = 0;
        let totalPixels = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          totalPixels++;
          if (r > 60 && g > 40 && b > 20 && r > g && r > b && (r - g) > 15) skinPixels++;
          if (r + g + b > 80) brightPixels++;
        }

        const skinRatio = skinPixels / totalPixels;
        const brightRatio = brightPixels / totalPixels;

        if (cycleCount % 5 === 0) {
          console.log('[AIMonitor] canvas check: skin=' + skinRatio.toFixed(3) + ' bright=' + brightRatio.toFixed(3) + ' cycle=' + cycleCount);
        }

        const tooDark = brightRatio < 0.05;
        const noFace = skinRatio < 0.01 && brightRatio > 0.2;

        if (tooDark) {
          if (lastLogType !== 'camera-covered') {
            lastLogType = 'camera-covered';
            console.log('[AIMonitor] TRIGGER: camera-covered (brightRatio=' + brightRatio.toFixed(3) + ')');
            this.security.logEvent('camera-covered', 'severe');
          }
          this.noFaceDuration = 0;
          return;
        }

        if (noFace) {
          this.noFaceDuration += checkInterval;
          if (this.faceState !== 'no-face' && this.noFaceDuration >= 15000) {
            this.faceState = 'no-face';
            console.log('[AIMonitor] TRIGGER: no-face-20s (canvas, skinRatio=' + skinRatio.toFixed(3) + ')');
            this.security.setActive('no-face-20s', 'severe');
            if (this.onNotify) this.onNotify('No face detected for 15 seconds. Ensure your camera shows your face.', 'severe');
          }
        } else {
          if (lastLogType === 'camera-covered') {
            console.log('[AIMonitor] RESOLVE: camera-covered (brightRatio=' + brightRatio.toFixed(3) + ')');
            this.security.setInactive('camera-covered');
          }
          lastLogType = 'face-ok';
          this.noFaceDuration = 0;
          if (this.faceState === 'no-face') {
            this.faceState = 'face';
            console.log('[AIMonitor] RESOLVE: no-face-20s (canvas)');
            this.security.setInactive('no-face-20s');
          }
          this._faceDetections++;
        }
      } catch (e) {
        console.warn('[AIMonitor] Canvas detection error:', e);
      }
    }, checkInterval);
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
      this.captureScreenFrame();
    }, 5000);
  }

  _captureScreenHash() {
    try {
      const hasScreenTrack = !!this.screenStream?.getVideoTracks()[0];
      const source = hasScreenTrack ? this._screenVideoEl : null;
      if (!source || !source.videoWidth) {
        if (hasScreenTrack) console.log('[AIMonitor] _captureScreenHash: screen stream exists but video element not ready');
        return this.lastScreenHash || 0;
      }
      const c = document.createElement('canvas');
      c.width = 40;
      c.height = 30;
      const ctx = c.getContext('2d');
      ctx.drawImage(source, 0, 0, 40, 30);
      const data = ctx.getImageData(0, 0, 40, 30).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) sum += data[i];
      return sum;
    } catch (e) {
      return 0;
    }
  }
}

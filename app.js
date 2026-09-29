// ==========================================================================
// AeroFlow App JavaScript Logic
// ==========================================================================

// Canvas roundRect Polyfill for Older Browser Compatibility
if (typeof CanvasRenderingContext2D.prototype.roundRect !== 'function') {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, radii) {
    if (!radii) radii = 0;
    if (typeof radii === 'number') {
      radii = [radii, radii, radii, radii];
    } else if (Array.isArray(radii)) {
      if (radii.length === 1) {
        radii = [radii[0], radii[0], radii[0], radii[0]];
      } else if (radii.length === 2) {
        radii = [radii[0], radii[1], radii[0], radii[1]];
      } else if (radii.length === 3) {
        radii = [radii[0], radii[1], radii[2], radii[1]];
      } else if (radii.length >= 4) {
        radii = [radii[0], radii[1], radii[2], radii[3]];
      }
    } else {
      radii = [0, 0, 0, 0];
    }
    const r = radii;
    this.moveTo(x + r[0], y);
    this.lineTo(x + w - r[1], y);
    this.quadraticCurveTo(x + w, y, x + w, y + r[1]);
    this.lineTo(x + w, y + h - r[2]);
    this.quadraticCurveTo(x + w, y + h, x + w - r[2], y + h);
    this.lineTo(x + r[3], y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r[3]);
    this.lineTo(x, y + r[0]);
    this.quadraticCurveTo(x, y, x + r[0], y);
  };
}

// --- App State ---
let trainingMode = 'exhale'; // 'inhale' | 'exhale' — exhale matches classic 3-ball exerciser
let difficulty = 'easy';     // 'easy' | 'medium' | 'hard'
let micReady = false;

// Real device flow targets (cc/s) per chamber
const CHAMBER_FLOWS = [600, 900, 1200];

// Audio Web API
let audioCtx = null;
let micStream = null;
let analyserNode = null;
let filterNode = null;
let analyserRawNode = null;
let highPassNode = null;
let audioSourceNode = null;
let animationFrameId = null;

// Noise cancellation state
let noiseCancellationEnabled = true;
let noiseSpectrumProfile = null;
let adaptiveNoiseFloor = 0.03;
let noiseProfileSnapshots = 0;

// Calibration Benchmarks
let calAmbient = 0.03;      // Noise floor gate
let calMaxInhale = 0.35;    // Peak inhale strength baseline
let calMaxExhale = 0.50;    // Peak exhale strength baseline
let isCalibrating = false;
let breathLikeness = 0;
let recentRmsSamples = [];

// Session & Pacer State
let sessionState = 'idle';  // 'idle' | 'prepare' | 'breath' | 'hold' | 'relax'
let currentRep = 0;
const totalReps = 5;
let pacerTimer = 0;
let pacerIntervalId = null;
let currentBreathSamples = []; // Raw intensity samples logged during active breath phase
let currentSessionScores = []; // Array of LPI scores from each rep of current session

// Dashboard History Logs
let historyLogs = [];

// ChartJS Instance
let historyChart = null;

// --- Ceaser App Host Integration (postMessage Bridge) ---
const isEmbeddedInHost = window.parent && window.parent !== window;

function emitToHost(type, payload = {}) {
  const message = {
    source: 'aeroflow',
    type,
    payload,
    timestamp: Date.now()
  };

  // Broadcast to parent window (iframe embedding in Ceaser app)
  if (window.parent && window.parent !== window) {
    try {
      window.parent.postMessage(message, '*');
    } catch (e) {
      console.warn('Failed to postMessage to parent:', e);
    }
  }

  // Broadcast to window opener (if launched via popup)
  if (window.opener) {
    try {
      window.opener.postMessage(message, '*');
    } catch (e) {}
  }

  // React Native WebView bridge support
  if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(message));
    } catch (e) {}
  }

  // Flutter / Custom WebView JavaScript channel support
  if (window.CeaserChannel && typeof window.CeaserChannel.postMessage === 'function') {
    try {
      window.CeaserChannel.postMessage(JSON.stringify(message));
    } catch (e) {}
  }
}

// Listen for incoming commands from Ceaser app
window.addEventListener('message', (event) => {
  let data = event.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) {}
  }
  if (!data || typeof data !== 'object') return;

  const action = data.type || data.action;

  // Show Ceaser Connected badge if host contacts us
  const badge = document.getElementById('ceaser-connected-badge');
  if (badge) badge.classList.remove('hidden');

  switch (action) {
    case 'AEROFLOW_SET_MODE':
    case 'SET_MODE':
      if (data.mode === 'inhale' || data.mode === 'exhale') {
        setMode(data.mode);
        emitToHost('AEROFLOW_ACK', { action, success: true, mode: data.mode });
      }
      break;

    case 'AEROFLOW_SET_DIFFICULTY':
    case 'SET_DIFFICULTY':
      if (['easy', 'medium', 'hard'].includes(data.difficulty)) {
        setDifficulty(data.difficulty);
        emitToHost('AEROFLOW_ACK', { action, success: true, difficulty: data.difficulty });
      }
      break;

    case 'AEROFLOW_START_SESSION':
    case 'START_SESSION':
      if (sessionState === 'idle') {
        toggleSession();
        emitToHost('AEROFLOW_ACK', { action, success: true, sessionState: 'started' });
      }
      break;

    case 'AEROFLOW_STOP_SESSION':
    case 'STOP_SESSION':
      if (sessionState !== 'idle') {
        toggleSession();
        emitToHost('AEROFLOW_ACK', { action, success: true, sessionState: 'stopped' });
      }
      break;

    case 'AEROFLOW_GET_STATS':
    case 'GET_STATS':
      emitToHost('AEROFLOW_STATS_RESPONSE', {
        logs: historyLogs,
        streak: calculateStreak(),
        lastSession: historyLogs[historyLogs.length - 1] || null
      });
      break;

    case 'AEROFLOW_PING':
    case 'PING':
      emitToHost('AEROFLOW_PONG', {
        version: '1.2.0',
        mode: trainingMode,
        difficulty,
        sessionState
      });
      break;
  }
});


// Physics Engine: Spirometer Balls Configuration
const canvas = document.getElementById('spirometer-canvas');
const ctx = canvas.getContext('2d');

const ballColors = {
  red: { fill: '#ff4757', glow: 'rgba(255, 71, 87, 0.4)' },
  yellow: { fill: '#ffa502', glow: 'rgba(255, 165, 2, 0.4)' },
  green: { fill: '#2ed573', glow: 'rgba(46, 213, 115, 0.4)' }
};

class Ball {
  constructor(x, colorObj, requiredLevel) {
    this.x = x;
    this.y = canvas.height - 40; // Starts near bottom
    this.radius = 24;
    this.color = colorObj.fill;
    this.glow = colorObj.glow;
    this.vy = 0;
    this.requiredLevel = requiredLevel; // Mic level threshold to start lifting (0.0 to 1.0)
    
    // Physical attributes
    this.mass = 1.0;
    this.elasticity = 0.35; // Bounce absorption
  }

  update(breathIntensity, dt) {
    const topLimit = 60 + this.radius;
    const bottomLimit = canvas.height - 40 - this.radius;
    const riseSpeed = 7.5;
    const fallSpeed = 10.0;

    if (breathIntensity <= this.requiredLevel) {
      // Balls drop immediately when airflow stops — like a real exerciser
      this.y += (bottomLimit - this.y) * Math.min(dt * fallSpeed, 1);
      if (this.y > bottomLimit) this.y = bottomLimit;
      this.vy = 0;
      return;
    }

    const intensityExceed = (breathIntensity - this.requiredLevel) / (1.0 - this.requiredLevel);
    const targetY = bottomLimit - intensityExceed * (bottomLimit - topLimit);
    this.y += (targetY - this.y) * Math.min(dt * riseSpeed, 1);
    this.vy = (targetY - this.y) * riseSpeed;
  }

  draw(ctx) {
    ctx.save();
    ctx.shadowBlur = 15;
    ctx.shadowColor = this.glow;
    
    // Draw ball shadow
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();

    // 3D Glass shine overlay
    const gradient = ctx.createRadialGradient(
      this.x - 6, this.y - 8, 2,
      this.x, this.y, this.radius
    );
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.2, this.color);
    gradient.addColorStop(1, '#000000');
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = gradient;
    ctx.globalAlpha = 0.85;
    ctx.fill();

    ctx.restore();
  }
}

// Particle Class for flowing air through chambers
class AirParticle {
  constructor(chamberIndex) {
    const xBase = 15 + chamberIndex * 120;
    this.x = xBase + 20 + Math.random() * 50;
    this.y = canvas.height - 55;
    this.chamberIndex = chamberIndex;
    this.radius = 1.5 + Math.random() * 2.5;
    this.speed = 80 + Math.random() * 120;
    this.alpha = 0.35 + Math.random() * 0.45;
    this.wobble = Math.random() * Math.PI * 2;
  }

  update(dt, breathIntensity) {
    this.y -= this.speed * dt * (0.6 + breathIntensity * 1.8);
    this.wobble += dt * 6;
    this.x += Math.sin(this.wobble) * 0.8;
    this.alpha -= dt * 0.9;
  }

  draw(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(186, 230, 253, ${this.alpha})`;
    ctx.fill();
    ctx.restore();
  }
}

// Particle Class for flowing air bubbles (legacy mist in hose)
class Bubble {
  constructor(xRange) {
    this.x = xRange[0] + Math.random() * (xRange[1] - xRange[0]);
    this.y = canvas.height - 35;
    this.radius = 1 + Math.random() * 3;
    this.vy = 1 + Math.random() * 3;
    this.alpha = 0.3 + Math.random() * 0.5;
  }
  update(breathIntensity) {
    this.y -= this.vy * (1 + breathIntensity * 4);
    this.alpha -= 0.005;
  }
  draw(ctx) {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${this.alpha})`;
    ctx.fill();
  }
}

// Instantiate 3 balls in center of 3 columns
// Canvas width is 360, 3 columns:
// Col 1: 0 - 120 (center 60)
// Col 2: 120 - 240 (center 180)
// Col 3: 240 - 360 (center 300)
// Ball required thresholds: Red (low pressure), Yellow (mid), Green (high)
const balls = [
  new Ball(60, ballColors.red, 0.15),
  new Ball(180, ballColors.yellow, 0.45),
  new Ball(300, ballColors.green, 0.75)
];
let airParticles = [];
let bubbles = [];
let smoothedIntensity = 0;
let mouthpieceGlow = 0;

function updateBallThresholds() {
  const presets = {
    easy: [0.10, 0.32, 0.55],
    medium: [0.15, 0.45, 0.72],
    hard: [0.22, 0.58, 0.85]
  };
  const levels = presets[difficulty] || presets.easy;
  balls.forEach((ball, i) => {
    ball.requiredLevel = levels[i];
  });
}

function intensityToFlow(intensity) {
  return Math.round(intensity * CHAMBER_FLOWS[2]);
}

// --- Lifecycle Event Handlers ---
window.addEventListener('DOMContentLoaded', () => {
  // Initialize Lucide Icons
  if (window.lucide) {
    window.lucide.createIcons();
  }

  // Load data from LocalStorage
  loadHistoryLogs();
  loadNoiseSettings();

  // Render analytical charts
  renderChart();

  // Difficulty thresholds for the three chambers
  updateBallThresholds();
  setMode(trainingMode);

  // Setup live audio animation loop (always running, listening to cal values)
  requestAnimationFrame(physicsRenderLoop);

  // Initialize UI displays
  updateDashboardStats();
  updateStreakPill();
  document.getElementById('pacer-hint').textContent =
    'Enable your microphone, then blow to test the balls — or press "Start Training" for a guided session.';

  // Notify Ceaser host app that AeroFlow is ready
  if (isEmbeddedInHost) {
    const badge = document.getElementById('ceaser-connected-badge');
    if (badge) badge.classList.remove('hidden');
    document.body.classList.add('embedded-mode');
  }
  emitToHost('AEROFLOW_READY', { mode: trainingMode, difficulty });
});

// --- Mode and Difficulty Selectors ---
function setMode(mode) {
  trainingMode = mode;
  document.getElementById('mode-inhale').classList.toggle('active', mode === 'inhale');
  document.getElementById('mode-exhale').classList.toggle('active', mode === 'exhale');
  
  const pulse = document.querySelector('.ai-avatar-pulse');
  if (pulse) {
    pulse.style.animationDuration = mode === 'inhale' ? '2.5s' : '1.5s';
  }

  if (micReady) {
    document.getElementById('spirometer-live-hint').textContent =
      mode === 'exhale'
        ? 'Blow steadily into your microphone — shouting won\'t lift the balls.'
        : 'Inhale steadily near your microphone — only breath airflow is detected.';
  }

  emitToHost('AEROFLOW_MODE_CHANGED', { mode });
}

function setDifficulty(diff) {
  difficulty = diff;
  document.querySelectorAll('.diff-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`diff-${diff}`).classList.add('active');
  updateBallThresholds();

  const pacerHint = document.getElementById('pacer-hint');
  if (sessionState === 'idle') {
    pacerHint.textContent = `Difficulty: ${diff.toUpperCase()}. Blow into your mic to test the balls, or press "Start Training".`;
  }

  emitToHost('AEROFLOW_DIFFICULTY_CHANGED', { difficulty: diff });
}

function setNoiseCancellation(enabled) {
  noiseCancellationEnabled = enabled;
  const toggle = document.getElementById('noise-cancel-toggle');
  if (toggle) toggle.checked = enabled;
  saveNoiseSettings();
  updateNoiseFloorDisplay();
}

async function rescanNoiseProfile() {
  if (!micReady) {
    await enableMicrophone();
    return;
  }
  breathLikeness = 0;
  smoothedIntensity = 0;
  recentRmsSamples = [];
  document.getElementById('mic-live-label').textContent = 'Scanning room noise — stay quiet…';
  await captureNoiseProfile(2000);
  updateNoiseFloorDisplay();
  document.getElementById('mic-live-label').textContent = 'Mic live — blow steadily (not shout)';
  updateInputTypeStatus('idle');
}

function saveNoiseSettings() {
  localStorage.setItem('aeroflow_noise_v1', JSON.stringify({
    noiseCancellationEnabled,
    calAmbient,
    calMaxInhale,
    calMaxExhale
  }));
}

function loadNoiseSettings() {
  const data = localStorage.getItem('aeroflow_noise_v1');
  if (!data) return;
  try {
    const saved = JSON.parse(data);
    if (typeof saved.noiseCancellationEnabled === 'boolean') {
      noiseCancellationEnabled = saved.noiseCancellationEnabled;
    }
    if (typeof saved.calAmbient === 'number') calAmbient = saved.calAmbient;
    if (typeof saved.calMaxInhale === 'number') calMaxInhale = saved.calMaxInhale;
    if (typeof saved.calMaxExhale === 'number') calMaxExhale = saved.calMaxExhale;
    adaptiveNoiseFloor = calAmbient;
    const toggle = document.getElementById('noise-cancel-toggle');
    if (toggle) toggle.checked = noiseCancellationEnabled;
  } catch (e) {
    // ignore corrupt settings
  }
}

function updateNoiseFloorDisplay() {
  const el = document.getElementById('noise-floor-label');
  if (!el) return;
  const floor = getEffectiveNoiseFloor();
  const status = noiseCancellationEnabled ? 'ON' : 'OFF';
  el.textContent = `Noise cancellation ${status} · gate ${Math.round(floor * 1000)} pts`;
}

function getEffectiveNoiseFloor() {
  if (!noiseCancellationEnabled) return calAmbient * 0.5;
  return Math.max(calAmbient, adaptiveNoiseFloor * 1.35);
}

// Capture room noise spectrum for spectral subtraction
function captureNoiseProfile(durationMs = 2000) {
  return new Promise(resolve => {
    if (!analyserNode || !audioCtx) {
      resolve();
      return;
    }

    const binCount = analyserNode.frequencyBinCount;
    const profileSum = new Float32Array(binCount);
    let snapshotCount = 0;
    const rmsSamples = [];

    const interval = 80;
    let elapsed = 0;

    const timer = setInterval(() => {
      elapsed += interval;
      const freqData = new Uint8Array(binCount);
      analyserNode.getByteFrequencyData(freqData);

      for (let i = 0; i < binCount; i++) {
        profileSum[i] += freqData[i];
      }
      snapshotCount++;

      const frame = analyzeAudioFrame({ skipNoiseCancel: true });
      if (frame) rmsSamples.push(frame.filteredRms);

      if (elapsed >= durationMs) {
        clearInterval(timer);

        if (snapshotCount > 0) {
          noiseSpectrumProfile = new Float32Array(binCount);
          for (let i = 0; i < binCount; i++) {
            noiseSpectrumProfile[i] = (profileSum[i] / snapshotCount) * 1.15;
          }
          noiseProfileSnapshots = snapshotCount;
        }

        if (rmsSamples.length > 0) {
          rmsSamples.sort((a, b) => a - b);
          const median = rmsSamples[Math.floor(rmsSamples.length / 2)];
          const peak = rmsSamples[rmsSamples.length - 1];
          calAmbient = Math.max(median * 1.4, peak * 1.1, 0.012);
          adaptiveNoiseFloor = calAmbient;
          saveNoiseSettings();
        }

        resolve();
      }
    }, interval);
  });
}

function applySpectralNoiseCancellation(freqData) {
  if (!noiseCancellationEnabled || !noiseSpectrumProfile) return freqData;

  const cleaned = new Uint8Array(freqData.length);
  for (let i = 0; i < freqData.length; i++) {
    cleaned[i] = Math.max(freqData[i] - noiseSpectrumProfile[i], 0);
  }
  return cleaned;
}

// --- Microphone Enable (user gesture required by browsers) ---
async function enableMicrophone() {
  const btn = document.getElementById('btn-enable-mic');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader"></i> Connecting...';
    if (window.lucide) window.lucide.createIcons();
  }

  const success = await initAudio();
  if (!success) {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="mic"></i> Enable Microphone';
      if (window.lucide) window.lucide.createIcons();
    }
    return;
  }

  document.getElementById('mic-live-label').textContent = 'Learning room noise — stay quiet 2s…';
  await captureNoiseProfile(2000);

  micReady = true;
  if (btn) btn.classList.add('hidden');
  document.getElementById('btn-calibrate')?.classList.remove('hidden');
  document.getElementById('btn-rescan-noise')?.classList.remove('hidden');
  document.getElementById('mic-overlay')?.classList.add('hidden');
  document.getElementById('spirometer-live-hint').textContent =
    trainingMode === 'exhale'
      ? 'Blow steadily into your microphone — shouting won\'t lift the balls.'
      : 'Inhale steadily near your microphone — stronger breath lifts higher balls.';
  document.getElementById('mic-live-label').textContent = 'Mic live — blow steadily (not shout)';
  updateInputTypeStatus('idle');
  updateNoiseFloorDisplay();
}

function updateInputTypeStatus(type) {
  const el = document.getElementById('input-type-status');
  if (!el) return;
  const labels = {
    idle: 'Waiting for breath…',
    breath: 'Airflow detected',
    rejected: 'Ignored — use steady blow, not voice',
    noise: 'Background noise filtered out'
  };
  el.textContent = labels[type] || labels.idle;
  el.className = 'input-type-status ' + type;
}

// --- Audio Core Engine ---
async function initAudio() {
  if (audioCtx && micStream) {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    return true;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    });
    micStream = stream;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    audioSourceNode = audioCtx.createMediaStreamSource(stream);

    // High-pass removes low rumble (fans, AC hum) before breath analysis
    highPassNode = audioCtx.createBiquadFilter();
    highPassNode.type = 'highpass';
    highPassNode.frequency.value = 120;
    highPassNode.Q.value = 0.7;

    // Bandpass isolates breath turbulence (400Hz–2500Hz)
    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = 'bandpass';
    filterNode.frequency.value = 1350;
    filterNode.Q.value = 0.8;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserNode.smoothingTimeConstant = 0.35;

    // Unfiltered analyser — voice/shout detection in low-mid frequencies
    analyserRawNode = audioCtx.createAnalyser();
    analyserRawNode.fftSize = 1024;
    analyserRawNode.smoothingTimeConstant = 0.4;

    audioSourceNode.connect(analyserRawNode);
    audioSourceNode.connect(highPassNode);
    highPassNode.connect(filterNode);
    filterNode.connect(analyserNode);

    document.getElementById('mic-live-label').textContent = 'Mic live — blow steadily (not shout)';
    return true;
  } catch (error) {
    console.error("Microphone access denied:", error);
    alert("Microphone permission is required. Allow access in your browser, then click Enable Microphone again.");
    return false;
  }
}

function bandAverage(freqData, binHz, lowHz, highHz) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < freqData.length; i++) {
    const hz = i * binHz;
    if (hz >= lowHz && hz <= highHz) {
      sum += freqData[i];
      count++;
    }
  }
  return count ? (sum / count) / 255 : 0;
}

function bandSpectralFlatness(freqData, binHz, lowHz, highHz) {
  const values = [];
  for (let i = 0; i < freqData.length; i++) {
    const hz = i * binHz;
    if (hz >= lowHz && hz <= highHz) {
      values.push(freqData[i] / 255 + 0.0001);
    }
  }
  if (values.length < 4) return 0;
  const logSum = values.reduce((s, v) => s + Math.log(v), 0);
  const geoMean = Math.exp(logSum / values.length);
  const arithMean = values.reduce((s, v) => s + v, 0) / values.length;
  return geoMean / arithMean;
}

function analyzeAudioFrame(options = {}) {
  if (!analyserNode || !analyserRawNode || !audioCtx) return null;

  const timeData = new Uint8Array(analyserNode.fftSize);
  analyserNode.getByteTimeDomainData(timeData);

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < timeData.length; i++) {
    const sample = (timeData[i] / 128.0) - 1.0;
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }
  const filteredRms = Math.sqrt(sumSquares / timeData.length);
  const crestFactor = filteredRms > 0.0001 ? peak / filteredRms : 1;

  let filteredFreq = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(filteredFreq);
  if (!options.skipNoiseCancel) {
    filteredFreq = applySpectralNoiseCancellation(filteredFreq);
  }

  const filteredBinHz = audioCtx.sampleRate / analyserNode.fftSize;

  const rawFreq = new Uint8Array(analyserRawNode.frequencyBinCount);
  analyserRawNode.getByteFrequencyData(rawFreq);
  const rawBinHz = audioCtx.sampleRate / analyserRawNode.fftSize;

  const airflowBand = bandAverage(filteredFreq, filteredBinHz, 400, 3500);
  const voiceBand = bandAverage(rawFreq, rawBinHz, 80, 450);
  const rumbleBand = bandAverage(rawFreq, rawBinHz, 40, 180);
  const spectralFlatness = bandSpectralFlatness(filteredFreq, filteredBinHz, 500, 3200);

  const noiseCancelledRms = Math.max(filteredRms - getEffectiveNoiseFloor() * 0.5, 0);

  return {
    filteredRms,
    noiseCancelledRms,
    airflowBand,
    voiceBand,
    rumbleBand,
    crestFactor,
    spectralFlatness
  };
}

// Score how likely the sound is steady breath vs shout/speech
function getBreathLikenessScore(frame) {
  const airflow = frame.airflowBand;
  const voice = frame.voiceBand;

  if (airflow < 0.015 && frame.filteredRms < getEffectiveNoiseFloor()) return 0;

  // Blowing: strong turbulent airflow band, weak voice fundamentals
  const blowRatio = airflow / (voice + 0.006);
  let score = Math.min(Math.max((blowRatio - 0.6) / 2.0, 0), 1);

  // Breath turbulence is broadband (flatter spectrum); voice has tonal peaks
  if (frame.spectralFlatness > 0.28) {
    score = Math.min(1, score * 1.2);
  } else if (frame.spectralFlatness < 0.12) {
    score *= 0.45;
  }

  // Shouts produce sharp transient peaks
  if (frame.crestFactor > 9) score *= 0.15;
  else if (frame.crestFactor > 6) score *= 0.4;
  else if (frame.crestFactor > 4.5) score *= 0.7;

  // Steady blow is more stable than a shout burst
  recentRmsSamples.push(frame.filteredRms);
  if (recentRmsSamples.length > 10) recentRmsSamples.shift();
  if (recentRmsSamples.length >= 4) {
    const mean = recentRmsSamples.reduce((a, b) => a + b, 0) / recentRmsSamples.length;
    const variance = recentRmsSamples.reduce((s, v) => s + (v - mean) ** 2, 0) / recentRmsSamples.length;
    const stability = 1 - Math.min(Math.sqrt(variance) / (mean + 0.001) * 2.5, 1);
    score *= 0.55 + stability * 0.45;
  }

  return Math.min(Math.max(score, 0), 1);
}

// Read microphone intensity — noise-cancelled steady breath only
function getLiveBreathIntensity(dt = 0.016) {
  if (!analyserNode || !audioCtx) return { intensity: 0, isBreath: false, rejectReason: null };

  const frame = analyzeAudioFrame();
  if (!frame) return { intensity: 0, isBreath: false, rejectReason: null };

  const noiseFloor = getEffectiveNoiseFloor();
  const rawSignal = Math.max(
    noiseCancellationEnabled ? frame.noiseCancelledRms : frame.filteredRms,
    frame.airflowBand * 0.5
  );

  // Track ambient drift when quiet
  if (noiseCancellationEnabled && rawSignal < noiseFloor * 1.15) {
    adaptiveNoiseFloor = adaptiveNoiseFloor * 0.996 + rawSignal * 0.004;
  }

  if (rawSignal < noiseFloor) {
    breathLikeness = Math.max(breathLikeness - dt * 6, 0);
    return { intensity: 0, isBreath: false, rejectReason: null };
  }

  const likeness = getBreathLikenessScore(frame);
  if (likeness > breathLikeness) {
    breathLikeness += (likeness - breathLikeness) * Math.min(dt * 10, 1);
  } else {
    breathLikeness += (likeness - breathLikeness) * Math.min(dt * 14, 1);
  }

  if (breathLikeness < 0.25) {
    const isVoice = frame.voiceBand > frame.airflowBand * 0.7;
    const isRumble = frame.rumbleBand > frame.airflowBand * 0.9;
    return {
      intensity: 0,
      isBreath: false,
      rejectReason: isVoice ? 'voice' : (isRumble ? 'noise' : 'voice')
    };
  }

  const maxLimit = (trainingMode === 'inhale') ? calMaxInhale : calMaxExhale;
  let difficultyFactor = 1.0;
  if (difficulty === 'easy') difficultyFactor = 0.7;
  else if (difficulty === 'hard') difficultyFactor = 1.35;

  const targetMax = maxLimit * difficultyFactor;
  const span = Math.max(targetMax - noiseFloor, 0.001);
  const normalized = (rawSignal - noiseFloor) / span;
  const likenessFactor = Math.min(Math.max((breathLikeness - 0.18) / 0.82, 0), 1);
  const intensity = Math.min(Math.max(normalized, 0), 1) * likenessFactor;

  return { intensity, isBreath: intensity > 0.02, rejectReason: null };
}

// --- Live Physics Visualizer Loop (HTML5 Canvas) ---
let lastTime = 0;
function physicsRenderLoop(timestamp) {
  if (!lastTime) lastTime = timestamp;
  const dt = Math.min((timestamp - lastTime) / 1000, 0.1); // Cap delta time at 100ms
  lastTime = timestamp;

  // 1. Read input breath intensity (always live when mic is connected)
  let breathIntensity = 0;
  if (analyserNode) {
    const { intensity: rawIntensity, isBreath, rejectReason } = getLiveBreathIntensity(dt);
    smoothedIntensity += (rawIntensity - smoothedIntensity) * Math.min(dt * 14, 1);
    breathIntensity = smoothedIntensity;

    const micPercent = Math.round(breathIntensity * 100);
    const flowCc = intensityToFlow(breathIntensity);
    document.getElementById('mic-live-bar').style.width = `${micPercent}%`;
    document.getElementById('mic-live-label').textContent = micReady
      ? `${trainingMode === 'exhale' ? 'Blow' : 'Inhale'} strength: ${micPercent}%`
      : 'Mic inactive — click Enable above';
    document.getElementById('live-flow-value').textContent = `${flowCc} cc/s`;

    if (micReady) {
      if (isBreath) {
        updateInputTypeStatus('breath');
      } else if (rejectReason === 'noise') {
        updateInputTypeStatus('noise');
      } else if (rejectReason === 'voice') {
        updateInputTypeStatus('rejected');
      } else {
        updateInputTypeStatus('idle');
      }
    }

    mouthpieceGlow = Math.max(mouthpieceGlow * 0.88, breathIntensity);
  }

  // Record breath samples only during guided breath phase
  if (sessionState === 'breath') {
    currentBreathSamples.push(breathIntensity);
  }

  // 2. Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 3. Draw Spirometer casing (glassmorphism back cylinder)
  drawSpirometerChambers(mouthpieceGlow);

  // 4. Air stream particles — spawn in each chamber when airflow exceeds its threshold
  if (breathIntensity > 0.03) {
    balls.forEach((ball, i) => {
      if (breathIntensity > ball.requiredLevel && Math.random() < 0.45 + breathIntensity * 0.35) {
        airParticles.push(new AirParticle(i));
      }
    });
    if (Math.random() < 0.25 + breathIntensity * 0.3) {
      bubbles.push(new Bubble([20, 340]));
    }
  }

  airParticles = airParticles.filter(p => p.alpha > 0.02 && p.y > 55);
  airParticles.forEach(p => {
    p.update(dt, breathIntensity);
    p.draw(ctx);
  });

  bubbles = bubbles.filter(b => b.alpha > 0 && b.y > 60);
  bubbles.forEach(b => {
    b.update(breathIntensity);
    b.draw(ctx);
  });

  // 5. Draw rising air columns inside active chambers
  drawChamberAirStreams(breathIntensity);

  // 6. Physics update and draw balls — always driven by live mic input
  balls.forEach(ball => {
    ball.update(breathIntensity, dt);
    ball.draw(ctx);
  });

  // 7. Draw glass tube highlights (casing front layer overlays)
  drawSpirometerHighlights();

  // Loop
  animationFrameId = requestAnimationFrame(physicsRenderLoop);
}

// Casing details
function drawSpirometerChambers(mouthGlow = 0) {
  ctx.save();

  // 1. Draw the flexible tubing in the background
  drawSpirometerHose(mouthGlow);

  // 2. Draw base (grey/white plastic)
  const baseGrad = ctx.createLinearGradient(0, canvas.height - 45, 0, canvas.height - 10);
  baseGrad.addColorStop(0, '#f8fafc'); // White/grey plastic top
  baseGrad.addColorStop(0.3, '#e2e8f0');
  baseGrad.addColorStop(0.8, '#cbd5e1');
  baseGrad.addColorStop(1, '#94a3b8');   // Darker bottom edge
  
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = baseGrad;
  ctx.beginPath();
  ctx.roundRect(15, canvas.height - 45, canvas.width - 30, 30, [6, 6, 12, 12]);
  ctx.fill();
  ctx.shadowColor = 'transparent'; // Reset shadows

  // 3. Draw 3 chambers backings (dome tops)
  for (let i = 0; i < 3; i++) {
    const x = 15 + i * 120;
    
    // Clear plastic transparent back fill
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, 60, 90, canvas.height - 105, [45, 45, 4, 4]); // Height is 315. Ends at 375.
    ctx.fill();
    ctx.stroke();
    
    // Grid lines inside chambers (measuring marks)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let h = 120; h < canvas.height - 70; h += 60) {
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + 90, h);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawChamberAirStreams(breathIntensity) {
  ctx.save();
  balls.forEach((ball, i) => {
    if (breathIntensity <= ball.requiredLevel) return;

    const x = 15 + i * 120;
    const exceed = (breathIntensity - ball.requiredLevel) / (1.0 - ball.requiredLevel);
    const streamHeight = 40 + exceed * (canvas.height - 160);
    const grad = ctx.createLinearGradient(x + 45, canvas.height - 50, x + 45, canvas.height - 50 - streamHeight);
    grad.addColorStop(0, `rgba(125, 211, 252, ${0.15 + exceed * 0.25})`);
    grad.addColorStop(0.5, `rgba(186, 230, 253, ${0.08 + exceed * 0.12})`);
    grad.addColorStop(1, 'rgba(186, 230, 253, 0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x + 30, canvas.height - 50 - streamHeight, 30, streamHeight, 8);
    ctx.fill();
  });
  ctx.restore();
}

function drawSpirometerHose(mouthGlow = 0) {
  ctx.save();
  const startX = 220, startY = canvas.height - 35;
  const cp1x = 380, cp1y = canvas.height + 40;
  const cp2x = -40, cp2y = canvas.height + 30;
  const endX = 35, endY = canvas.height - 110;

  // Mouthpiece glow when breath is detected
  if (mouthGlow > 0.04) {
    ctx.save();
    ctx.translate(endX, endY);
    ctx.rotate(-Math.PI / 10);
    ctx.shadowBlur = 18 + mouthGlow * 30;
    ctx.shadowColor = `rgba(56, 189, 248, ${0.35 + mouthGlow * 0.4})`;
    ctx.fillStyle = `rgba(56, 189, 248, ${0.15 + mouthGlow * 0.25})`;
    ctx.beginPath();
    ctx.roundRect(-14, -18, 28, 36, 6);
    ctx.fill();
    ctx.restore();
  }

  // Draw the mouthpiece at the end (looks like a blue/white plastic mouthpiece)
  ctx.fillStyle = '#e2e8f0';
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Angle it slightly
  ctx.translate(endX, endY);
  ctx.rotate(-Math.PI / 10);
  ctx.roundRect(-10, -15, 20, 30, 4);
  ctx.fill();
  ctx.stroke();
  
  // Blue connector tip
  ctx.fillStyle = '#3b82f6';
  ctx.beginPath();
  ctx.roundRect(-10, -15, 20, 6, 2);
  ctx.fill();
  ctx.restore(); // Undo rotation and translation

  ctx.save();
  // Draw ribbed circles along the curve
  const steps = 70;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Cubic Bezier curve formula
    const x = (1-t)*(1-t)*(1-t)*startX + 3*(1-t)*(1-t)*t*cp1x + 3*(1-t)*t*t*cp2x + t*t*t*endX;
    const y = (1-t)*(1-t)*(1-t)*startY + 3*(1-t)*(1-t)*t*cp1y + 3*(1-t)*t*t*cp2y + t*t*t*endY;
    
    // Ribbed effect: overlap circles with alternating subtle colors
    ctx.fillStyle = (i % 2 === 0) ? '#f1f5f9' : '#cbd5e1';
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawSpirometerHighlights() {
  ctx.save();
  for (let i = 0; i < 3; i++) {
    const x = 15 + i * 120;
    
    // Outer tube container reflection (dome top gradient)
    const gradient = ctx.createLinearGradient(x, 0, x + 90, 0);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
    gradient.addColorStop(0.15, 'rgba(255, 255, 255, 0.04)');
    gradient.addColorStop(0.4, 'rgba(255, 255, 255, 0.0)');
    gradient.addColorStop(0.75, 'rgba(255, 255, 255, 0.04)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.18)');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, 60, 90, canvas.height - 105, [45, 45, 4, 4]);
    ctx.fill();

    // 3D Glass Gleam Line on the left side
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 12, 105, 6, Math.PI, Math.PI * 1.5); // Curved highlight at top left dome
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + 6, 110);
    ctx.lineTo(x + 6, canvas.height - 60); // Vertical reflection line
    ctx.stroke();

    // Small vent plug/cap at top center
    ctx.fillStyle = '#64748b'; // grey plug
    ctx.beginPath();
    ctx.roundRect(x + 38, 52, 14, 8, [2, 2, 0, 0]);
    ctx.fill();
    
    // Joint pieces between cylinders
    if (i < 2) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.roundRect(x + 90, 120, 30, 20, 2);
      ctx.roundRect(x + 90, 280, 30, 20, 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// --- Calibration Wizard Logic ---
function startCalibrationModal() {
  enableMicrophone().then(() => {
    if (!micReady) return;
    document.getElementById('calibration-modal').classList.remove('hidden');
    showCalStep(1);
  });
}

function closeCalibrationModal() {
  document.getElementById('calibration-modal').classList.add('hidden');
  isCalibrating = false;
}

function showCalStep(stepNum) {
  document.querySelectorAll('.cal-step').forEach(step => step.classList.remove('active'));
  document.getElementById(`cal-step-${stepNum}`).classList.add('active');
}

// Step 1: Measure ambient room noise floor
function calibrateAmbient() {
  isCalibrating = true;
  const btn = document.getElementById('btn-cal-step1');
  const progress = document.getElementById('ambient-progress');
  const fill = document.getElementById('ambient-progress-fill');
  
  btn.disabled = true;
  progress.classList.remove('hidden');
  
  let duration = 3000; // 3 seconds
  let interval = 100;
  let elapsed = 0;
  let values = [];

  const timer = setInterval(() => {
    elapsed += interval;
    fill.style.width = `${(elapsed / duration) * 100}%`;
    
    // Sample mic volume (raw RMS)
    if (analyserNode) {
      const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
      analyserNode.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] / 128.0) - 1.0;
        sumSquares += val * val;
      }
      values.push(Math.sqrt(sumSquares / dataArray.length));
    }

    if (elapsed >= duration) {
      clearInterval(timer);
      btn.disabled = false;
      progress.classList.add('hidden');
      
      const avgAmbient = values.reduce((a, b) => a + b, 0) / values.length;
      calAmbient = Math.max(avgAmbient * 1.3, 0.02);
      
      // Move to Step 2
      document.getElementById('cal-type-label').textContent = trainingMode.toUpperCase();
      showCalStep(2);
    }
  }, interval);
}

// Step 2: Measure maximum breath intensity
function calibrateBreathPeak() {
  isCalibrating = true;
  const btn = document.getElementById('btn-cal-step2');
  const progress = document.getElementById('breath-progress');
  const fill = document.getElementById('breath-progress-fill');
  const liveLabel = document.getElementById('cal-live-level-container');
  const liveText = document.getElementById('cal-live-level');
  
  btn.disabled = true;
  progress.classList.remove('hidden');
  liveLabel.classList.remove('hidden');

  let duration = 5000; // 5 seconds
  let interval = 100;
  let elapsed = 0;
  let maxRms = 0;

  const timer = setInterval(() => {
    elapsed += interval;
    fill.style.width = `${(elapsed / duration) * 100}%`;

    // Sample mic volume (raw RMS)
    if (analyserNode) {
      const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
      analyserNode.getByteTimeDomainData(dataArray);
      let sumSquares = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] / 128.0) - 1.0;
        sumSquares += val * val;
      }
      const currentRms = Math.sqrt(sumSquares / dataArray.length);
      if (currentRms > maxRms) {
        maxRms = currentRms;
      }
      
      const relVal = Math.round((currentRms / 0.5) * 100);
      liveText.textContent = `${Math.min(relVal, 100)}%`;
    }

    if (elapsed >= duration) {
      clearInterval(timer);
      btn.disabled = false;
      progress.classList.add('hidden');
      liveLabel.classList.add('hidden');

      const finalMaxVal = Math.max(maxRms, calAmbient * 1.5);
      if (trainingMode === 'inhale') {
        calMaxInhale = finalMaxVal;
      } else {
        calMaxExhale = finalMaxVal;
      }

      // Render Step 3 Results
      document.getElementById('res-ambient').textContent = `${Math.round(calAmbient * 1000)} pts`;
      document.getElementById('res-inhale').textContent = `${Math.round(calMaxInhale * 1000)} pts`;
      document.getElementById('res-exhale').textContent = `${Math.round(calMaxExhale * 1000)} pts`;
      
      showCalStep(3);
    }
  }, interval);
}

// --- Guided Exercise State Machine ---
function toggleSession() {
  if (sessionState === 'idle') {
    enableMicrophone().then(() => {
      if (!micReady) return;
      startTrainingSession();
    });
  } else {
    stopTrainingSession();
  }
}

function startTrainingSession() {
  currentRep = 1;
  currentSessionScores = [];
  document.getElementById('current-rep').textContent = currentRep;
  document.getElementById('session-text').textContent = 'Stop Session';
  document.getElementById('session-icon').setAttribute('data-lucide', 'square');
  if (window.lucide) window.lucide.createIcons();

  // Move pacer state machine
  enterPacerState('prepare');
}

function stopTrainingSession() {
  // Clear timers
  clearInterval(pacerIntervalId);
  sessionState = 'idle';
  currentRep = 0;
  
  document.getElementById('current-rep').textContent = '0';
  document.getElementById('session-text').textContent = 'Start Training';
  document.getElementById('session-icon').setAttribute('data-lucide', 'play');
  if (window.lucide) window.lucide.createIcons();

  // Reset pacer visual
  const ring = document.getElementById('pacer-ring');
  ring.className = 'pacer-circle';
  document.getElementById('pacer-status').textContent = 'Ready';
  document.getElementById('pacer-timer').textContent = '0s';
  document.getElementById('pacer-hint').textContent = 'Exercise cancelled. Press start to run again.';
}

function enterPacerState(state) {
  sessionState = state;
  const ring = document.getElementById('pacer-ring');
  const statusEl = document.getElementById('pacer-status');
  const timerEl = document.getElementById('pacer-timer');
  const hintEl = document.getElementById('pacer-hint');

  // Reset classes
  ring.className = 'pacer-circle';

  // Config times and labels
  switch (state) {
    case 'prepare':
      pacerTimer = 4; // 4s exhale prep
      ring.classList.add('pacer-prepare');
      statusEl.textContent = 'Prepare';
      hintEl.textContent = 'Sit upright. Exhale completely, emptying your lungs.';
      break;

    case 'breath':
      pacerTimer = 5; // 5s inhale/exhale
      ring.classList.add(trainingMode === 'inhale' ? 'pacer-inhale' : 'pacer-exhale');
      statusEl.textContent = trainingMode === 'inhale' ? 'Breathe In' : 'Blow Out';
      hintEl.textContent = trainingMode === 'inhale' 
        ? 'Inhale deeply and steadily through the mouthpiece to lift the balls.'
        : 'Blow steadily and strongly into the mouthpiece to lift the balls.';
      currentBreathSamples = [];
      break;

    case 'hold':
      pacerTimer = 3; // 3s hold breath
      ring.classList.add('pacer-hold');
      statusEl.textContent = 'Hold';
      hintEl.textContent = 'Hold your breath! Keep the expansion in your lungs.';
      break;

    case 'relax':
      pacerTimer = 4; // 4s rest
      ring.classList.add('pacer-relax');
      statusEl.textContent = 'Rest';
      hintEl.textContent = 'Exhale gently. Relax and breathe normally.';
      break;
  }

  timerEl.textContent = `${pacerTimer}s`;

  // Start countdown clock
  clearInterval(pacerIntervalId);
  pacerIntervalId = setInterval(() => {
    pacerTimer--;
    timerEl.textContent = `${pacerTimer}s`;

    if (pacerTimer <= 0) {
      clearInterval(pacerIntervalId);
      advanceSessionState();
    }
  }, 1000);
}

function advanceSessionState() {
  if (sessionState === 'prepare') {
    enterPacerState('breath');
  } else if (sessionState === 'breath') {
    // Process breath sample metrics
    evaluateRepetitionScore();
    enterPacerState('hold');
  } else if (sessionState === 'hold') {
    enterPacerState('relax');
  } else if (sessionState === 'relax') {
    if (currentRep < totalReps) {
      currentRep++;
      document.getElementById('current-rep').textContent = currentRep;
      enterPacerState('prepare');
    } else {
      // Completed the 5-rep session
      finalizeSession();
    }
  }
}

// Evaluate performance of a single repetition
function evaluateRepetitionScore() {
  if (currentBreathSamples.length === 0) return;

  // Filter out silence values
  const activeSamples = currentBreathSamples.filter(s => s > 0.02);
  if (activeSamples.length === 0) return;

  // 1. Peak Capacity Index (PCI): max flow achieved
  const peakVal = Math.max(...activeSamples);
  const pciScore = Math.round(peakVal * 100);

  // 2. Stability Score: measure variation of breath (how steady was the hold)
  // Low variance = high stability.
  const mean = activeSamples.reduce((a, b) => a + b, 0) / activeSamples.length;
  const variance = activeSamples.reduce((a, b) => a + (b - mean) * (b - mean), 0) / activeSamples.length;
  const stdDev = Math.sqrt(variance);
  
  // Stability out of 100
  let stabilityScore = 100 - (stdDev / (mean || 1)) * 120;
  stabilityScore = Math.max(Math.min(Math.round(stabilityScore), 100), 20);

  // 3. Sustained Flow Time fraction (SFT): time spent above 20% flow
  const sustainedCount = activeSamples.filter(s => s >= 0.2).length;
  const sftRatio = sustainedCount / currentBreathSamples.length;
  const sftScore = Math.round(sftRatio * 100);

  // Repetition LPI (Lung Performance Index) out of 100
  const repLPI = Math.round((pciScore * 0.4) + (stabilityScore * 0.3) + (sftScore * 0.3));
  const repScore = {
    rep: currentRep,
    lpi: repLPI,
    peak: pciScore,
    stability: stabilityScore,
    sustained: parseFloat((sftRatio * 5).toFixed(1))
  };
  currentSessionScores.push(repScore);
  emitToHost('AEROFLOW_REP_COMPLETE', repScore);
}

// Finalize all 5 repetitions of the session
function finalizeSession() {
  sessionState = 'idle';
  document.getElementById('current-rep').textContent = '5';
  document.getElementById('session-text').textContent = 'Start Training';
  document.getElementById('session-icon').setAttribute('data-lucide', 'play');
  if (window.lucide) window.lucide.createIcons();

  if (currentSessionScores.length === 0) return;

  // Calculate averages of the session
  const avgLpi = Math.round(currentSessionScores.reduce((sum, s) => sum + s.lpi, 0) / currentSessionScores.length);
  const maxPeak = Math.max(...currentSessionScores.map(s => s.peak));
  const avgSustained = currentSessionScores.reduce((sum, s) => sum + s.sustained, 0) / currentSessionScores.length;
  const avgStability = Math.round(currentSessionScores.reduce((sum, s) => sum + s.stability, 0) / currentSessionScores.length);

  // Estimated Vital Volume Metric: average intensity * average time * conversion factor (liters estimate)
  // Standard capacity is around 3.5 to 5 liters.
  const estimatedVolume = Math.max((maxPeak / 100) * avgSustained * 1.15, 0.4).toFixed(2);

  // Update Header LPI
  document.getElementById('header-lpi').textContent = `${avgLpi}%`;

  // Log session to local logs list
  const newLog = {
    date: new Date().toISOString().split('T')[0],
    timestamp: Date.now(),
    mode: trainingMode,
    difficulty: difficulty,
    lpi: avgLpi,
    peak: maxPeak,
    sustained: avgSustained.toFixed(1),
    stability: avgStability,
    volume: estimatedVolume
  };

  historyLogs.push(newLog);
  saveHistoryLogs();
  emitToHost('AEROFLOW_SESSION_COMPLETE', newLog);

  // Run AI Biomechanical Diagnostics (The AI Coach)
  runAICoachFeedback(newLog);

  // Refresh Charts and Dashboard
  renderChart();
  updateDashboardStats();
  checkAchievementsUnlock(newLog);
  
  // Set pacer display to completed
  document.getElementById('pacer-status').textContent = 'Done!';
  document.getElementById('pacer-timer').textContent = `${avgLpi}%`;
  document.getElementById('pacer-hint').textContent = `Excellent job! Session logged. Average LPI score: ${avgLpi}%. Check your reports below.`;
}

// --- AI Coaching & Predictive Analytics Engine ---
function runAICoachFeedback(lastLog) {
  const coachFeedbackEl = document.getElementById('coach-feedback');
  const stabilityEl = document.getElementById('mini-stability');
  const volumeEl = document.getElementById('mini-volume');
  const forecastEl = document.getElementById('mini-forecast');

  // Load metrics
  const lpi = lastLog.lpi;
  const peak = lastLog.peak;
  const stability = lastLog.stability;
  const sustained = parseFloat(lastLog.sustained);
  const volume = parseFloat(lastLog.volume);
  const mode = lastLog.mode;

  // Mini stats display
  stabilityEl.textContent = `${stability}%`;
  volumeEl.textContent = `${volume}L`;

  // 1. Generate intelligent biomechanical analysis text
  let feedbackText = "";
  
  if (mode === 'inhale') {
    if (lpi >= 85) {
      feedbackText = `Outstanding inhalation! You sustained an impressive flow rate for ${sustained}s with a steady ${stability}% stability. Your lungs expanded fully. Maintain this form!`;
    } else if (stability < 65) {
      feedbackText = `Good effort, but your flow was unstable (${stability}%). Try inhaling slowly and smoothly as if drawing liquid through a straw. Avoid sudden gasps.`;
    } else if (sustained < 2.5) {
      feedbackText = `Your peak flow pressure was strong, but you dropped too quickly (${sustained}s). Focus on diaphragmatic breathing (expanding the stomach) to prolong the inhale.`;
    } else {
      feedbackText = `LPI is at ${lpi}%. Your chest cavity expansion is decent. Try sitting taller and pulling the shoulders back to widen the rib cage next time.`;
    }
  } else { // Exhale
    if (lpi >= 85) {
      feedbackText = `Excellent Exhalation! Your sustained expiratory pressure is building great core lung resistance. Very steady (${stability}% stability) and strong!`;
    } else if (peak < 50) {
      feedbackText = `Your exhalation force was low. Practice pursed-lip blowing (like blowing out candles) to build expiratory muscle pressure.`;
    } else if (stability < 65) {
      feedbackText = `You blew out in sudden bursts rather than a steady flow. Keep a gentle, long, and continuous blow for the full 5 seconds.`;
    } else {
      feedbackText = `Exhale LPI is ${lpi}%. You sustained breathing resistance for ${sustained}s. Continuous training will boost your accessory breathing muscles.`;
    }
  }

  coachFeedbackEl.textContent = feedbackText;

  // 2. AI Predictive Analytics (Linear Regression Forecast)
  // Fit a line to past LPI scores to predict when they'll reach a peak index of 95%
  const relevantLogs = historyLogs.filter(log => log.mode === mode);
  if (relevantLogs.length >= 3) {
    const n = relevantLogs.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    
    // X is session index, Y is LPI score
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += relevantLogs[i].lpi;
      sumXY += i * relevantLogs[i].lpi;
      sumXX += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    
    if (slope > 0.1) {
      const currentLpi = relevantLogs[n - 1].lpi;
      const targetLpi = 95;
      
      if (currentLpi < targetLpi) {
        const repsRemaining = Math.ceil((targetLpi - currentLpi) / slope);
        forecastEl.textContent = `${repsRemaining} more sessions`;
        
        // Append forecast statement to feedback
        coachFeedbackEl.textContent += ` [Forecast]: Based on your steady improvement trend (+${slope.toFixed(1)}% LPI/set), you are projected to reach your optimal target LPI of 95% in about ${repsRemaining} sessions.`;
      } else {
        forecastEl.textContent = `Target Reached!`;
      }
    } else if (slope < -0.1) {
      forecastEl.textContent = "Fluctuating";
      coachFeedbackEl.textContent += ` [AI Alert]: I detect a slight decline in your scores. Ensure you are resting fully between repetitions to avoid fatigue.`;
    } else {
      forecastEl.textContent = "Stable";
      coachFeedbackEl.textContent += ` [Forecast]: Your lung strength is stable. To push your limits, try increasing the difficulty to Medium or Hard.`;
    }
  } else {
    forecastEl.textContent = `Need ${3 - relevantLogs.length} logs`;
  }
}

// --- Achievements & Medal Unlocking ---
function checkAchievementsUnlock(lastLog) {
  // First Breath Achievement
  if (historyLogs.length >= 1) {
    unlockBadge('badge-first');
  }

  // Stable flow achievement
  if (lastLog.stability >= 85) {
    unlockBadge('badge-stable');
  }

  // Expert ball lifter (Yellow/Green ball lifted in hard difficulty)
  if (lastLog.peak >= 85 && (lastLog.difficulty === 'hard' || lastLog.difficulty === 'medium')) {
    unlockBadge('badge-expert');
  }

  // Daily habit (3-day streak)
  const streak = calculateStreak();
  if (streak >= 3) {
    unlockBadge('badge-streak');
  }
}

function unlockBadge(id) {
  const badgeEl = document.getElementById(id);
  if (badgeEl && badgeEl.classList.contains('locked')) {
    badgeEl.classList.remove('locked');
    badgeEl.classList.add('unlocked');
    // Add light animation flare
    badgeEl.style.transform = 'scale(1.1)';
    setTimeout(() => {
      badgeEl.style.transform = '';
    }, 400);
  }
}

// --- Dashboard Statistics Calculations ---
function updateDashboardStats() {
  if (historyLogs.length === 0) {
    document.getElementById('dashboard-peak').textContent = '--';
    document.getElementById('dashboard-sustained').textContent = '--';
    document.getElementById('dashboard-avg-lpi').textContent = '--';
    document.getElementById('header-lpi').textContent = '--';
    return;
  }

  const avgLpi = Math.round(historyLogs.reduce((sum, l) => sum + l.lpi, 0) / historyLogs.length);
  const maxPeak = Math.max(...historyLogs.map(l => l.peak));
  const avgSustained = (historyLogs.reduce((sum, l) => sum + parseFloat(l.sustained), 0) / historyLogs.length).toFixed(1);

  document.getElementById('dashboard-peak').textContent = `${maxPeak}%`;
  document.getElementById('dashboard-sustained').textContent = `${avgSustained}s`;
  document.getElementById('dashboard-avg-lpi').textContent = `${avgLpi}%`;
  document.getElementById('header-lpi').textContent = `${avgLpi}%`;
  
  updateStreakPill();
}

function updateStreakPill() {
  const streak = calculateStreak();
  document.getElementById('header-streak').textContent = `${streak} day${streak === 1 ? '' : 's'}`;
}

function calculateStreak() {
  if (historyLogs.length === 0) return 0;
  
  // Sort timestamps descending
  const dates = [...new Set(historyLogs.map(log => log.date))].sort().reverse();
  
  let streak = 0;
  let today = new Date().toISOString().split('T')[0];
  let yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // If the last log is not today or yesterday, streak is broken
  if (dates[0] !== today && dates[0] !== yesterday) {
    return 0;
  }

  let expectedDate = dates[0];
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] === expectedDate) {
      streak++;
      // Subtract one day from expectedDate
      const nextExpected = new Date(new Date(expectedDate).getTime() - 86400000);
      expectedDate = nextExpected.toISOString().split('T')[0];
    } else {
      break;
    }
  }

  return streak;
}

// --- LocalStorage Database Management ---
function saveHistoryLogs() {
  localStorage.setItem('aeroflow_logs_v1', JSON.stringify(historyLogs));
}

function loadHistoryLogs() {
  const data = localStorage.getItem('aeroflow_logs_v1');
  if (data) {
    try {
      historyLogs = JSON.parse(data);
      // Re-trigger badge unlocking based on loaded history
      if (historyLogs.length > 0) {
        unlockBadge('badge-first');
        if (historyLogs.some(l => l.stability >= 85)) unlockBadge('badge-stable');
        if (historyLogs.some(l => l.peak >= 85 && (l.difficulty === 'hard' || l.difficulty === 'medium'))) {
          unlockBadge('badge-expert');
        }
        if (calculateStreak() >= 3) unlockBadge('badge-streak');
      }
    } catch (e) {
      historyLogs = [];
    }
  }
}

function clearLogsData() {
  if (confirm("Are you sure you want to clear all your training logs? This will reset all charts, stats, and medals.")) {
    localStorage.removeItem('aeroflow_logs_v1');
    historyLogs = [];
    
    // Reset indicators
    document.getElementById('coach-feedback').textContent = 'Welcome back. Let\'s begin training.';
    document.getElementById('mini-stability').textContent = '--';
    document.getElementById('mini-volume').textContent = '--';
    document.getElementById('mini-forecast').textContent = 'Pending logs';
    
    // Lock all badges
    document.querySelectorAll('.badge').forEach(b => {
      b.classList.remove('unlocked');
      b.classList.add('locked');
    });

    updateDashboardStats();
    renderChart();
  }
}

// --- Graphical Charting (Chart.js Rendering) ---
function renderChart() {
  if (typeof Chart === 'undefined') {
    console.warn("Chart.js library is not loaded. Skipping chart rendering.");
    return;
  }
  const chartCanvas = document.getElementById('history-chart');
  
  if (historyChart) {
    historyChart.destroy();
  }

  // Pre-fill mock data if history is empty to make the dashboard look stunning initially
  let labels = [];
  let lpiData = [];
  let peakData = [];
  
  if (historyLogs.length === 0) {
    // Elegant baseline placeholder states
    labels = ['Baseline', 'Day 1', 'Day 2', 'Day 3', 'Day 4'];
    lpiData = [0, 0, 0, 0, 0];
    peakData = [0, 0, 0, 0, 0];
  } else {
    // Show up to the last 12 logs
    const sliceLogs = historyLogs.slice(-12);
    labels = sliceLogs.map((log, index) => `Set ${index + 1}\n(${log.date.substring(5)})`);
    lpiData = sliceLogs.map(log => log.lpi);
    peakData = sliceLogs.map(log => log.peak);
  }

  historyChart = new Chart(chartCanvas, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'LPI Score (%)',
          data: lpiData,
          borderColor: '#6366f1',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          tension: 0.35,
          borderWidth: 3,
          pointRadius: 4,
          pointBackgroundColor: '#6366f1'
        },
        {
          label: 'Peak Capacity (%)',
          data: peakData,
          borderColor: '#00d2d3',
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#00d2d3',
          borderDash: [5, 5]
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: '#94a3b8',
            font: {
              family: 'Plus Jakarta Sans',
              size: 11
            }
          }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleFont: { family: 'Outfit', size: 12 },
          bodyFont: { family: 'Plus Jakarta Sans', size: 12 },
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.02)' },
          ticks: { color: '#64748b', font: { size: 10 } }
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#64748b', font: { size: 10 } }
        }
      }
    }
  });
}

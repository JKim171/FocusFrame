import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from "recharts";

import { generateSyntheticGaze, computeHeatmapForFrame, computeRegionAttention, computeAttentionTimeline } from "./gazeUtils.js";
import { heatColor } from "./canvasUtils.js";
import { initEyeTracker, stopEyeTracker as destroyEyeTracker, fitCalibration, irisToScreen, resetCalibration, applyBiasCorrection } from "./eyeTracker.js";
import { btnStyle, formatTime, ToggleBtn, SliderControl, PanelCard, StatRow, Insight } from "./UIComponents.jsx";

const VIDEO_W = 640;
const VIDEO_H = 360;
const DURATION = 30;
const FPS = 30;

// Moving-dot calibration path: fractional (fx, fy) waypoints within the canvas.
// The dot travels through all corners, edges, and interior over CAL_DURATION_MS ms.
const CAL_WAYPOINTS = [
  [0.5,  0.5 ],  // center
  [0.05, 0.05],  // top-left
  [0.95, 0.05],  // top-right
  [0.95, 0.95],  // bottom-right
  [0.05, 0.95],  // bottom-left
  [0.05, 0.05],  // top-left (close square)
  [0.5,  0.05],  // top-center
  [0.5,  0.5 ],  // center
  [0.95, 0.5 ],  // right-center
  [0.5,  0.5 ],  // center
  [0.5,  0.95],  // bottom-center
  [0.5,  0.5 ],  // center
  [0.05, 0.5 ],  // left-center
  [0.5,  0.5 ],  // center
  [0.3,  0.3 ],  // inner top-left
  [0.7,  0.3 ],  // inner top-right
  [0.7,  0.7 ],  // inner bottom-right
  [0.3,  0.7 ],  // inner bottom-left
  [0.5,  0.5 ],  // center (finish)
];
const CAL_DURATION_MS = 26000; // kept for reference — actual time is dwell/transit based now

// Verification dots shown after calibration: user looks + clicks each one.
// The difference between model prediction and actual click position becomes the bias correction.
const VERIFY_DOTS = [
  { fx: 0.5,  fy: 0.5  },  // center
  { fx: 0.08, fy: 0.08 },  // top-left
  { fx: 0.92, fy: 0.08 },  // top-right
  { fx: 0.08, fy: 0.92 },  // bottom-left
  { fx: 0.92, fy: 0.92 },  // bottom-right
];

export default function VideoAttentionHeatmap() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animRef = useRef(null);
  const videoRef = useRef(null);       // camera
  const streamRef = useRef(null);
  const uploadedVideoRef = useRef(null); // uploaded mp4
  const fileInputRef = useRef(null);
  const renderCanvasRef = useRef(null); // stable ref to latest renderCanvas
  const liveGazeCursorRef = useRef(null); // latest gaze position in canvas coords {x,y}
  const smoothedGazeRef = useRef(null);    // EMA-smoothed gaze in canvas coords
  const eyeTrackerRafRef = useRef(null);   // rAF id for eye tracker canvas loop
  const calibrationCanvasRectRef = useRef(null); // canvas bounding rect at calibration start

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [showGaze, setShowGaze] = useState(false);
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.65);
  const [windowSize, setWindowSize] = useState(2);
  const [activeTab, setActiveTab] = useState("zones");
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState(null);
  const [uploadedVideoDuration, setUploadedVideoDuration] = useState(null);
  const [uploadedVideoName, setUploadedVideoName] = useState(null);

  // ─── Eye Tracker state ─────────────────────────────────────────────
  const [eyeTrackerStatus, setEyeTrackerStatus] = useState("idle"); // idle|loading|calibrating|verifying|tracking|error
  const [eyeTrackerError, setEyeTrackerError] = useState(null);
  // 1€ filter state — adapts smoothing to gaze velocity (smooth when still, responsive when moving)
  const oneEuroRef = useRef(null); // { x, dx, y, dy, t } or null
  // Previous iris for inter-frame jump rejection
  const prevIrisRef = useRef(null);
  // Verification step state (post-calibration bias correction)
  const verifyStepRef      = useRef(0);
  const verifyResidualsRef = useRef([]);
  const [verifyStep, setVerifyStep] = useState(0);
  // Moving-dot calibration state
  const calibDotPosRef      = useRef({ fx: 0.5, fy: 0.5 }); // current dot position (fractions)
  const calibAnimRef        = useRef(null);                  // rAF id for the animation loop
  const calibAnimRunningRef = useRef(false);                 // true while dot is moving — gates iris sampling
  const [calibrationProgress, setCalibrationProgress] = useState(-1); // -1=ready, 0-1=running
  // MediaPipe iris tracking: rolling raw-iris buffer (last 20 frames) + accumulated calibration pairs
  const irisBufferRef = useRef([]);        // [{ x, y }]  normalised 0-1 iris coords
  const calibrationPairsRef = useRef([]);  // [{ iris:{x,y}, screen:{x,y} }]
  const [liveGazeData, setLiveGazeData] = useState([]);   // state copy — drives chart/regions
  const liveGazeRef = useRef([]);                          // mutable accumulator — drives canvas
  const currentVideoTimeRef = useRef(0);                   // always latest currentTime (no stale closure)
  const liveGazeUpdateTimer = useRef(null);

  const gazeData = useMemo(() => generateSyntheticGaze(DURATION, FPS, VIDEO_W, VIDEO_H), []);

  // Use real gaze when tracking, synthetic otherwise
  const activeGazeData = eyeTrackerStatus === "tracking" ? liveGazeData : gazeData;
  const timeline = useMemo(
    () => computeAttentionTimeline(activeGazeData, uploadedVideoDuration || DURATION),
    [activeGazeData, uploadedVideoDuration]
  );
  const regions = useMemo(
    () => computeRegionAttention(activeGazeData, currentTime, windowSize, VIDEO_W, VIDEO_H, 4),
    [activeGazeData, currentTime, windowSize]
  );

  // ─── Camera ────────────────────────────────────────────────────────
  const initializeCameraAsync = useCallback(async () => {
    try {
      setCameraLoading(true);
      setCameraError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: VIDEO_W }, height: { ideal: VIDEO_H }, facingMode: "user" },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(err => setCameraError("Failed to play video: " + err.message));
        streamRef.current = stream;
        setCameraEnabled(true);
      } else {
        setCameraError("Video element not found");
      }
    } catch (err) {
      setCameraError(err.message);
      setCameraEnabled(false);
    } finally {
      setCameraLoading(false);
    }
  }, []);

  const disableCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraEnabled(false);
  }, []);

  useEffect(() => () => disableCamera(), [disableCamera]);

  // ─── MP4 Upload ────────────────────────────────────────────────────
  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // stop camera if active
    disableCamera();
    // revoke previous object URL
    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
    const url = URL.createObjectURL(file);
    setUploadedVideoUrl(url);
    setUploadedVideoName(file.name);
    setCurrentTime(0);
    setIsPlaying(false);
    // duration is read once metadata loads (see onLoadedMetadata on the element)
  }, [uploadedVideoUrl, disableCamera]);

  const clearUploadedVideo = useCallback(() => {
    setIsPlaying(false);
    if (uploadedVideoRef.current) {
      uploadedVideoRef.current.pause();
      uploadedVideoRef.current.src = "";
    }
    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
    setUploadedVideoUrl(null);
    setUploadedVideoDuration(null);
    setUploadedVideoName(null);
    setCurrentTime(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [uploadedVideoUrl]);

  // cleanup blob URL on unmount
  useEffect(() => () => { if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl); }, [uploadedVideoUrl]);

  // Keep currentVideoTimeRef in sync so the gaze listener can tag points without stale closures
  useEffect(() => { currentVideoTimeRef.current = currentTime; }, [currentTime]);

  // Cleanup eye tracker on unmount
  useEffect(() => () => {
    destroyEyeTracker();
    if (liveGazeUpdateTimer.current) clearInterval(liveGazeUpdateTimer.current);
  }, []);

  // ─── Eye Tracker handlers ───────────────────────────────────────────
  const startEyeTracker = useCallback(async () => {
    try {
      setEyeTrackerStatus("loading");
      setEyeTrackerError(null);
      irisBufferRef.current = [];
      calibrationPairsRef.current = [];
      oneEuroRef.current = null;
      prevIrisRef.current = null;
      resetCalibration();

      await initEyeTracker(({ x: ix, y: iy }) => {
        // Always maintain the rolling iris buffer.
        // Jump rejection: if iris teleports more than 0.2 units in one frame
        // it's a detection glitch — discard before it enters calibration or smoothing.
        const prev = prevIrisRef.current;
        if (prev) {
          const dist = Math.sqrt((ix - prev.x) ** 2 + (iy - prev.y) ** 2);
          if (dist > 0.2) { prevIrisRef.current = { x: ix, y: iy }; return; }
        }
        prevIrisRef.current = { x: ix, y: iy };

        irisBufferRef.current.push({ x: ix, y: iy });
        if (irisBufferRef.current.length > 20) irisBufferRef.current.shift();

        // ── High-frequency calibration sampling ──────────────────────
        // Record a pair for every single iris detection while the dot is
        // animating — far more pairs than sampling once per anim frame.
        if (calibAnimRunningRef.current) {
          const cr = calibrationCanvasRectRef.current;
          const { fx, fy } = calibDotPosRef.current;
          if (cr) {
            calibrationPairsRef.current.push({
              iris:   { x: ix, y: iy },
              screen: { x: cr.left + fx * cr.width, y: cr.top + fy * cr.height },
            });
          }
        }

        // Map iris → screen → canvas only when calibrated.
        const screenPt = irisToScreen(ix, iy);
        if (!screenPt) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = VIDEO_W / rect.width;
        const scaleY = VIDEO_H / rect.height;
        const rawCx = (screenPt.x - rect.left) * scaleX;
        const rawCy = (screenPt.y - rect.top) * scaleY;

        // ── 1€ filter ────────────────────────────────────────────────
        // Adapts its cutoff frequency to gaze speed:
        //   still gaze  → low cutoff  → heavy smoothing (removes jitter)
        //   fast saccade → high cutoff → low lag
        // Params tuned for ~60 fps webcam eye tracking:
        //   minCutoff=0.5 Hz, beta=0.08, dCutoff=1.0 Hz
        const MIN_FC = 0.5, BETA = 0.08, D_FC = 1.0;
        const now_s = performance.now() / 1000;
        const prev1e = oneEuroRef.current;
        let sc;
        if (!prev1e) {
          sc = { x: rawCx, y: rawCy };
          oneEuroRef.current = { x: rawCx, dx: 0, y: rawCy, dy: 0, t: now_s };
        } else {
          const dt = Math.max(now_s - prev1e.t, 1e-4);
          // Derivative (speed estimator) — filtered at fixed dCutoff
          const ad = 1 / (1 + 1 / (2 * Math.PI * D_FC * dt));
          const dxRaw = (rawCx - prev1e.x) / dt;
          const dyRaw = (rawCy - prev1e.y) / dt;
          const dx = ad * dxRaw + (1 - ad) * prev1e.dx;
          const dy = ad * dyRaw + (1 - ad) * prev1e.dy;
          const speed = Math.sqrt(dx * dx + dy * dy);
          // Adaptive cutoff — rises with speed
          const fc = MIN_FC + BETA * speed;
          const a  = 1 / (1 + 1 / (2 * Math.PI * fc * dt));
          const fx = a * rawCx + (1 - a) * prev1e.x;
          const fy = a * rawCy + (1 - a) * prev1e.y;
          sc = { x: fx, y: fy };
          oneEuroRef.current = { x: fx, dx, y: fy, dy, t: now_s };
        }
        smoothedGazeRef.current = sc;
        liveGazeCursorRef.current = { x: Math.round(sc.x), y: Math.round(sc.y) };
        // Only record to heatmap when actively tracking (not calibrating)
        if (sc.x >= 0 && sc.x < VIDEO_W && sc.y >= 0 && sc.y < VIDEO_H) {
          liveGazeRef.current.push({
            timestamp: currentVideoTimeRef.current,
            x: Math.round(sc.x),
            y: Math.round(sc.y),
            frame: Math.round(currentVideoTimeRef.current * FPS),
          });
        }
      });

      setEyeTrackerStatus("calibrating");
      // Snapshot canvas rect now so the animation positions the dot over the canvas
      calibrationCanvasRectRef.current = canvasRef.current?.getBoundingClientRect() ?? null;
      calibDotPosRef.current = { fx: 0.5, fy: 0.5 };
      setCalibrationProgress(-1); // -1 = "ready" — show Start button
    } catch (err) {
      setEyeTrackerStatus("error");
      setEyeTrackerError(err.message);
    }
  }, []);

  const stopEyeTracker = useCallback(() => {
    if (calibAnimRef.current) { cancelAnimationFrame(calibAnimRef.current); calibAnimRef.current = null; }
    calibAnimRunningRef.current = false;
    destroyEyeTracker();
    if (liveGazeUpdateTimer.current) { clearInterval(liveGazeUpdateTimer.current); liveGazeUpdateTimer.current = null; }
    if (eyeTrackerRafRef.current) { cancelAnimationFrame(eyeTrackerRafRef.current); eyeTrackerRafRef.current = null; }
    liveGazeCursorRef.current = null;
    smoothedGazeRef.current = null;
    oneEuroRef.current = null;
    prevIrisRef.current = null;
    irisBufferRef.current = [];
    calibrationPairsRef.current = [];
    setEyeTrackerStatus("idle");
  }, []);

  // ─── Verification click handler ─────────────────────────────────────
  // After calibration, user clicks each of the VERIFY_DOTS while looking at it.
  // We compare model prediction (irisToScreen on current iris) vs actual dot screen pos,
  // accumulate residuals, then applyBiasCorrection with the mean before starting tracking.
  const handleVerifyClick = useCallback((e) => {
    e.stopPropagation();
    const cr = calibrationCanvasRectRef.current;
    if (!cr) return;
    const dot = VERIFY_DOTS[verifyStepRef.current];
    const dotSx = cr.left + dot.fx * cr.width;
    const dotSy = cr.top  + dot.fy * cr.height;

    // Sample mean iris from buffer — this is what the user was looking at
    const buf = irisBufferRef.current;
    const samples = buf.slice(-8);
    if (samples.length >= 2) {
      const mi = {
        x: samples.reduce((s, p) => s + p.x, 0) / samples.length,
        y: samples.reduce((s, p) => s + p.y, 0) / samples.length,
      };
      const pred = irisToScreen(mi.x, mi.y);
      if (pred) {
        verifyResidualsRef.current.push({ dx: dotSx - pred.x, dy: dotSy - pred.y });
      }
    }

    verifyStepRef.current += 1;
    const next = verifyStepRef.current;

    if (next >= VERIFY_DOTS.length) {
      // Compute mean bias and apply it
      const res = verifyResidualsRef.current;
      if (res.length > 0) {
        const meanDx = res.reduce((s, r) => s + r.dx, 0) / res.length;
        const meanDy = res.reduce((s, r) => s + r.dy, 0) / res.length;
        applyBiasCorrection(meanDx, meanDy);
      }
      setVerifyStep(next);
      setEyeTrackerStatus("tracking");
      liveGazeUpdateTimer.current = setInterval(() => {
        setLiveGazeData([...liveGazeRef.current]);
      }, 500);
    } else {
      setVerifyStep(next);
    }
  }, []);

  const resetGazeData = useCallback(() => {
    liveGazeRef.current = [];
    setLiveGazeData([]);
  }, []);

  const recalibrate = useCallback(() => {
    if (calibAnimRef.current) { cancelAnimationFrame(calibAnimRef.current); calibAnimRef.current = null; }
    calibAnimRunningRef.current = false;
    if (liveGazeUpdateTimer.current) { clearInterval(liveGazeUpdateTimer.current); liveGazeUpdateTimer.current = null; }
    liveGazeCursorRef.current = null;
    smoothedGazeRef.current = null;
    oneEuroRef.current = null;
    prevIrisRef.current = null;
    irisBufferRef.current = [];
    calibrationPairsRef.current = [];
    resetCalibration();
    calibrationCanvasRectRef.current = canvasRef.current?.getBoundingClientRect() ?? null;
    calibDotPosRef.current = { fx: 0.5, fy: 0.5 };
    verifyStepRef.current = 0;
    verifyResidualsRef.current = [];
    setVerifyStep(0);
    setCalibrationProgress(-1);
    setEyeTrackerStatus("calibrating");
  }, []);

  // ─── Moving-dot calibration animation ──────────────────────────────
  // Dwell/transit architecture:
  //   DWELL phase  — dot stationary at waypoint; record iris samples after
  //                  SETTLE_MS so the eye has had time to land on the target.
  //   TRANSIT phase — dot sweeps to next waypoint; sampling disabled because
  //                   the eye is mid-saccade and hasn't arrived yet.
  const DWELL_MS   = 1400; // hold at each waypoint (ms)
  const TRANSIT_MS = 1200; // sweep between waypoints (ms)
  const SETTLE_MS  = 400;  // silence at start of each dwell (eye settling)

  const beginCalibrationAnimation = useCallback(() => {
    calibrationPairsRef.current = [];
    calibAnimRunningRef.current = false;
    const cr = calibrationCanvasRectRef.current;
    if (!cr) return;

    const WP = CAL_WAYPOINTS;
    const N  = WP.length;
    const TOTAL_MS = N * DWELL_MS + (N - 1) * TRANSIT_MS;

    let wpIdx     = 0;       // index of current target waypoint
    let phase     = 'dwell'; // 'dwell' | 'transit'
    let phaseStart = performance.now();

    // Start at first waypoint
    calibDotPosRef.current = { fx: WP[0][0], fy: WP[0][1] };

    function frame(now) {
      const phaseElapsed = now - phaseStart;

      if (phase === 'dwell') {
        // Enable sampling only after the eye has settled onto the dot
        calibAnimRunningRef.current = phaseElapsed >= SETTLE_MS;

        if (phaseElapsed >= DWELL_MS) {
          calibAnimRunningRef.current = false;
          if (wpIdx < N - 1) {
            phase = 'transit';
            phaseStart = now;
            wpIdx++;
          } else {
            // All waypoints done — fit then go to verification
            calibAnimRef.current = null;
            fitCalibration(calibrationPairsRef.current);
            verifyStepRef.current = 0;
            verifyResidualsRef.current = [];
            setVerifyStep(0);
            setEyeTrackerStatus('verifying');
            return;
          }
        }
      } else {
        // Transit — never sample; ease dot toward next waypoint
        calibAnimRunningRef.current = false;
        const [ax, ay] = WP[wpIdx - 1];
        const [bx, by] = WP[wpIdx];
        const t = Math.min(phaseElapsed / TRANSIT_MS, 1);
        // Sine ease-in-out — smoother than quadratic (no discontinuous second derivative)
        const eased = -(Math.cos(Math.PI * t) - 1) / 2;
        calibDotPosRef.current = { fx: ax + (bx - ax) * eased, fy: ay + (by - ay) * eased };

        if (phaseElapsed >= TRANSIT_MS) {
          calibDotPosRef.current = { fx: bx, fy: by };
          phase = 'dwell';
          phaseStart = now;
        }
      }

      // Overall progress 0→1
      const elapsed = wpIdx * (DWELL_MS + TRANSIT_MS) + phaseElapsed;
      setCalibrationProgress(Math.min(elapsed / TOTAL_MS, 1));
      calibAnimRef.current = requestAnimationFrame(frame);
    }

    calibAnimRef.current = requestAnimationFrame(frame);
  }, []);

  // ─── Canvas Render ─────────────────────────────────────────────────
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = VIDEO_W;
    canvas.height = VIDEO_H;
    ctx.clearRect(0, 0, VIDEO_W, VIDEO_H);

    const isEyeTracking = eyeTrackerStatus === "tracking" || eyeTrackerStatus === "calibrating" || eyeTrackerStatus === "verifying";

    if (!isEyeTracking && uploadedVideoUrl && uploadedVideoRef.current && uploadedVideoRef.current.readyState >= 2) {
      ctx.drawImage(uploadedVideoRef.current, 0, 0, VIDEO_W, VIDEO_H);
    } else if (!isEyeTracking && cameraEnabled && videoRef.current && videoRef.current.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
      ctx.drawImage(videoRef.current, 0, 0, VIDEO_W, VIDEO_H);
    } else if (isEyeTracking) {
      // ── Gaze test pattern ──────────────────────────────────────────
      // Dark background with a subtle grid
      ctx.fillStyle = "#0d0e14";
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
      // Grid
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= VIDEO_W; gx += VIDEO_W / 8) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, VIDEO_H); ctx.stroke(); }
      for (let gy = 0; gy <= VIDEO_H; gy += VIDEO_H / 4) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(VIDEO_W, gy); ctx.stroke(); }
      // Corner targets
      const targets = [
        { x: 60, y: 50 }, { x: VIDEO_W - 60, y: 50 },
        { x: VIDEO_W / 2, y: VIDEO_H / 2 },
        { x: 60, y: VIDEO_H - 50 }, { x: VIDEO_W - 60, y: VIDEO_H - 50 },
      ];
      targets.forEach(({ x, y }) => {
        ctx.strokeStyle = "rgba(180,120,255,0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 26, y); ctx.lineTo(x + 26, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y - 26); ctx.lineTo(x, y + 26); ctx.stroke();
      });
      // Label
      ctx.font = "700 13px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(180,120,255,0.5)";
      ctx.textAlign = "center";
      ctx.fillText(eyeTrackerStatus === "tracking" ? "GAZE TEST — look around to verify tracking" : eyeTrackerStatus === "verifying" ? "FINE-TUNE — look at each dot and click it" : "CALIBRATING — follow the dot", VIDEO_W / 2, VIDEO_H - 16);
      ctx.textAlign = "left";
    } else {
      // No source
      ctx.fillStyle = "#0d0e14";
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
      ctx.font = "600 15px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.textAlign = "center";
      ctx.fillText("NO SOURCE SELECTED", VIDEO_W / 2, VIDEO_H / 2 - 10);
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillText("Upload an MP4 or start the camera", VIDEO_W / 2, VIDEO_H / 2 + 14);
      ctx.textAlign = "left";
    }

    const gazeForRender = eyeTrackerStatus === "tracking" ? liveGazeRef.current : gazeData;

    if (showHeatmap) {
      const { grid, w, h, resolution } = computeHeatmapForFrame(gazeForRender, currentTime, windowSize, VIDEO_W, VIDEO_H, 4);
      const imgData = ctx.createImageData(VIDEO_W, VIDEO_H);
      for (let gy = 0; gy < h; gy++) {
        for (let gx = 0; gx < w; gx++) {
          const val = grid[gy * w + gx];
          if (val > 0.02) {
            const [r, g, b] = heatColor(val);
            const alpha = Math.floor(val * 255 * heatmapOpacity);
            for (let py = 0; py < resolution; py++) {
              for (let px = 0; px < resolution; px++) {
                const ix = gx * resolution + px;
                const iy = gy * resolution + py;
                if (ix < VIDEO_W && iy < VIDEO_H) {
                  const idx = (iy * VIDEO_W + ix) * 4;
                  const srcA = alpha / 255;
                  imgData.data[idx] = Math.min(255, imgData.data[idx] + r * srcA);
                  imgData.data[idx + 1] = Math.min(255, imgData.data[idx + 1] + g * srcA);
                  imgData.data[idx + 2] = Math.min(255, imgData.data[idx + 2] + b * srcA);
                  imgData.data[idx + 3] = Math.max(imgData.data[idx + 3], alpha);
                }
              }
            }
          }
        }
      }
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = VIDEO_W;
      tempCanvas.height = VIDEO_H;
      tempCanvas.getContext("2d").putImageData(imgData, 0, 0);
      ctx.drawImage(tempCanvas, 0, 0);
    }

    if (showGaze) {
      const tMin = currentTime - windowSize / 2;
      const tMax = currentTime + windowSize / 2;
      for (const pt of gazeForRender) {
        if (pt.timestamp >= tMin && pt.timestamp <= tMax) {
          const age = Math.abs(pt.timestamp - currentTime) / (windowSize / 2);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0, 255, 200, ${0.8 - age * 0.6})`;
          ctx.fill();
        }
      }
    }

    // ── Live gaze cursor (only while tracking) ─────────────────────
    if (eyeTrackerStatus === "tracking") {
      const cur = liveGazeCursorRef.current;
      if (cur && cur.x >= 0 && cur.x < VIDEO_W && cur.y >= 0 && cur.y < VIDEO_H) {
        const cx = cur.x, cy = cur.y;
        // Outer pulsing ring
        ctx.beginPath();
        ctx.arc(cx, cy, 20, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 80, 40, 0.7)";
        ctx.lineWidth = 2;
        ctx.stroke();
        // Inner filled dot
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 80, 40, 0.95)";
        ctx.fill();
        // Crosshair arms
        ctx.strokeStyle = "rgba(255, 80, 40, 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - 28, cy); ctx.lineTo(cx - 22, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx + 22, cy); ctx.lineTo(cx + 28, cy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy - 28); ctx.lineTo(cx, cy - 22); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, cy + 22); ctx.lineTo(cx, cy + 28); ctx.stroke();
      }
    }
  }, [gazeData, currentTime, showHeatmap, showGaze, heatmapOpacity, windowSize, cameraEnabled, uploadedVideoUrl, eyeTrackerStatus]);

  // Keep a stable ref so the rAF loop can call the latest version without stale closure
  useEffect(() => { renderCanvasRef.current = renderCanvas; }, [renderCanvas]);
  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // ─── Eye tracker canvas loop (runs independently of video playback)
  useEffect(() => {
    if (eyeTrackerStatus !== "tracking") {
      if (eyeTrackerRafRef.current) { cancelAnimationFrame(eyeTrackerRafRef.current); eyeTrackerRafRef.current = null; }
      return;
    }
    const tick = () => {
      renderCanvasRef.current?.();
      eyeTrackerRafRef.current = requestAnimationFrame(tick);
    };
    eyeTrackerRafRef.current = requestAnimationFrame(tick);
    return () => { if (eyeTrackerRafRef.current) { cancelAnimationFrame(eyeTrackerRafRef.current); eyeTrackerRafRef.current = null; } };
  }, [eyeTrackerStatus]);

  // ─── Playback Loop ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animRef.current);
      if (uploadedVideoRef.current && uploadedVideoUrl) uploadedVideoRef.current.pause();
      return;
    }
    // NOTE: for uploaded video, play() is called directly from the button onClick
    // (user-gesture context). Here we only run the rAF draw/sync loop.
    let lastTs = null;
    const tick = (ts) => {
      if (uploadedVideoUrl && uploadedVideoRef.current) {
        // Draw every animation frame directly — don't wait for React state
        renderCanvasRef.current?.();
        const vt = uploadedVideoRef.current.currentTime;
        setCurrentTime(vt);
        if (uploadedVideoRef.current.ended) {
          setIsPlaying(false);
          setCurrentTime(0);
          return;
        }
      } else {
        if (lastTs !== null) {
          const dt = (ts - lastTs) / 1000;
          setCurrentTime(prev => {
            const next = prev + dt;
            if (next >= DURATION) { setIsPlaying(false); return 0; }
            return next;
          });
        }
      }
      lastTs = ts;
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [isPlaying, uploadedVideoUrl]);

  const topRegions = regions.slice(0, 5);
  const totalGazePoints = activeGazeData.length;
  const currentBucket = timeline.find(b => Math.abs(b.time - Math.round(currentTime * 2) / 2) < 0.3);
  const currentIntensity = currentBucket ? currentBucket.intensity : 0;
  const peakTime = timeline.reduce((best, b) => b.intensity > best.intensity ? b : best, timeline[0]);
  const lowTime = timeline.reduce((best, b) => b.intensity < best.intensity ? b : best, timeline[0]);

  return (
    <>
      <div style={{
        minHeight: "100vh",
        background: "#0a0b0f",
        color: "#e0e0e6",
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      }}>
        {/* Header */}
        <div style={{
          padding: "16px 24px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "rgba(255,255,255,0.02)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: "linear-gradient(135deg, #ff4040, #ff8800)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16,
            }}>🔥</div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.5px", color: "#fff" }}>ATTENTION HEATMAP</div>
              <div style={{ fontSize: 10, color: "#666", letterSpacing: "1.5px", textTransform: "uppercase" }}>Video Analytics Engine · v0.1</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#555", alignItems: "center" }}>
            {eyeTrackerStatus === "tracking"
              ? <span style={{ color: "#60ff8c", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#60ff8c", display: "inline-block" }} />
                  {liveGazeData.length.toLocaleString()} live gaze pts
                </span>
              : uploadedVideoName
                ? <span style={{ color: "#a0c8ff", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📹 {uploadedVideoName}</span>
                : <span>{totalGazePoints.toLocaleString()} gaze points</span>
            }
            <span>{uploadedVideoDuration ? `${uploadedVideoDuration.toFixed(1)}s` : `${DURATION}s`} duration</span>
            <span>{FPS} fps</span>
          </div>
        </div>

        {/* Eye Tracker Calibration Overlay */}
        {eyeTrackerStatus === "calibrating" && (() => {
          const cr = calibrationCanvasRectRef.current;
          if (!cr) return null;
          const { fx, fy } = calibDotPosRef.current;
          const dotX = cr.left + fx * cr.width;
          const dotY = cr.top  + fy * cr.height;
          const isRunning = calibrationProgress >= 0;
          return (
            <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.82)", pointerEvents: "none" }}>

              {/* Canvas border highlight */}
              <div style={{
                position: "fixed",
                left: cr.left, top: cr.top,
                width: cr.width, height: cr.height,
                border: "2px solid rgba(255,96,40,0.4)",
                borderRadius: 8,
                pointerEvents: "none",
              }} />

              {/* Instruction text above canvas */}
              <div style={{
                position: "fixed",
                left: cr.left, top: cr.top - 72,
                width: cr.width, textAlign: "center",
                pointerEvents: "none",
              }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>
                  EYE TRACKER CALIBRATION
                </div>
                <div style={{ fontSize: 11, color: "#aaa" }}>
                  {isRunning
                    ? "Follow the dot with your eyes — keep your head still"
                    : "Keep your head still and follow the moving dot with your eyes only"}
                </div>
              </div>

              {/* Progress bar */}
              {isRunning && (
                <div style={{
                  position: "fixed",
                  left: cr.left, top: cr.top + cr.height + 10,
                  width: cr.width, height: 4,
                  background: "rgba(255,255,255,0.1)",
                  borderRadius: 2, pointerEvents: "none",
                }}>
                  <div style={{
                    width: `${calibrationProgress * 100}%`, height: "100%",
                    background: "linear-gradient(90deg,#ff6040,#ffb420)",
                    borderRadius: 2, transition: "width 0.05s linear",
                  }} />
                </div>
              )}

              {/* Moving dot */}
              {isRunning && (
                <div style={{
                  position: "fixed",
                  left: dotX, top: dotY,
                  transform: "translate(-50%,-50%)",
                  width: 22, height: 22, borderRadius: "50%",
                  background: "rgba(255,96,40,0.95)",
                  boxShadow: "0 0 20px rgba(255,96,40,0.9), 0 0 40px rgba(255,96,40,0.5)",
                  animation: "calPulse 0.6s ease-in-out infinite",
                  pointerEvents: "none",
                }} />
              )}

              {/* Start button — shown before animation begins */}
              {!isRunning && (
                <button
                  onClick={beginCalibrationAnimation}
                  style={{
                    position: "fixed",
                    left: cr.left + cr.width / 2, top: cr.top + cr.height / 2,
                    transform: "translate(-50%,-50%)",
                    ...btnStyle,
                    background: "rgba(255,96,40,0.2)", color: "#ff6040",
                    border: "1px solid rgba(255,96,40,0.6)",
                    padding: "10px 28px", fontSize: 14, fontWeight: 700,
                    pointerEvents: "all",
                  }}
                >▶ Start Calibration</button>
              )}

              <button
                onClick={stopEyeTracker}
                style={{
                  position: "fixed",
                  left: cr.left + cr.width / 2, top: cr.top + cr.height + (isRunning ? 28 : 16),
                  transform: "translateX(-50%)",
                  ...btnStyle,
                  background: "rgba(255,60,60,0.15)", color: "#ff6060",
                  border: "1px solid rgba(255,60,60,0.3)", padding: "7px 18px",
                  pointerEvents: "all",
                }}
              >✕ Cancel</button>

              <style>{`@keyframes calPulse{0%,100%{box-shadow:0 0 20px rgba(255,96,40,0.9),0 0 40px rgba(255,96,40,0.5)}50%{box-shadow:0 0 30px rgba(255,96,40,1),0 0 60px rgba(255,96,40,0.7)}}`}</style>
            </div>
          );
        })()}

        {/* Verification Overlay — post-calibration bias correction */}
        {eyeTrackerStatus === "verifying" && (() => {
          const cr = calibrationCanvasRectRef.current;
          if (!cr) return null;
          const dot = VERIFY_DOTS[Math.min(verifyStep, VERIFY_DOTS.length - 1)];
          const dotX = cr.left + dot.fx * cr.width;
          const dotY = cr.top  + dot.fy * cr.height;
          return (
            <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.82)", pointerEvents: "none" }}>

              <div style={{
                position: "fixed",
                left: cr.left, top: cr.top,
                width: cr.width, height: cr.height,
                border: "2px solid rgba(96,200,255,0.4)",
                borderRadius: 8, pointerEvents: "none",
              }} />

              <div style={{
                position: "fixed",
                left: cr.left, top: cr.top - 72,
                width: cr.width, textAlign: "center",
                pointerEvents: "none",
              }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>
                  FINE-TUNE CALIBRATION
                </div>
                <div style={{ fontSize: 11, color: "#aaa" }}>
                  Look at the <span style={{ color: "#60c8ff" }}>dot</span> and click it — {verifyStep + 1} / {VERIFY_DOTS.length}
                </div>
              </div>

              {/* Completed dots */}
              {VERIFY_DOTS.slice(0, verifyStep).map((d, i) => (
                <div key={i} style={{
                  position: "fixed",
                  left: cr.left + d.fx * cr.width,
                  top:  cr.top  + d.fy * cr.height,
                  transform: "translate(-50%,-50%)",
                  width: 12, height: 12, borderRadius: "50%",
                  background: "#60ff8c", opacity: 0.7,
                  boxShadow: "0 0 6px #60ff8c",
                  pointerEvents: "none",
                }} />
              ))}

              {/* Active dot */}
              <div
                onClick={handleVerifyClick}
                style={{
                  position: "fixed", left: dotX, top: dotY,
                  transform: "translate(-50%,-50%)",
                  width: 30, height: 30, borderRadius: "50%",
                  background: "rgba(96,200,255,0.95)",
                  boxShadow: "0 0 20px rgba(96,200,255,0.9), 0 0 40px rgba(96,200,255,0.5)",
                  animation: "verifyPulse 0.8s ease-in-out infinite",
                  cursor: "crosshair",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, color: "#000", fontWeight: 700,
                  pointerEvents: "all",
                }}
              >{verifyStep + 1}</div>

              <button
                onClick={stopEyeTracker}
                style={{
                  position: "fixed",
                  left: cr.left + cr.width / 2, top: cr.top + cr.height + 16,
                  transform: "translateX(-50%)",
                  ...btnStyle,
                  background: "rgba(255,60,60,0.15)", color: "#ff6060",
                  border: "1px solid rgba(255,60,60,0.3)", padding: "7px 18px",
                  pointerEvents: "all",
                }}
              >✕ Cancel</button>

              <style>{`@keyframes verifyPulse{0%,100%{box-shadow:0 0 20px rgba(96,200,255,0.9),0 0 40px rgba(96,200,255,0.5)}50%{box-shadow:0 0 30px rgba(96,200,255,1),0 0 60px rgba(96,200,255,0.7)}}`}</style>
            </div>
          );
        })()}

        {/* Hidden uploaded video element */}
        {uploadedVideoUrl && (
          <video
            ref={uploadedVideoRef}
            src={uploadedVideoUrl}
            style={{ display: "none" }}
            onLoadedMetadata={() => {
              if (uploadedVideoRef.current) setUploadedVideoDuration(uploadedVideoRef.current.duration);
            }}
            onEnded={() => { setIsPlaying(false); setCurrentTime(0); }}
            preload="auto"
          />
        )}

        {/* Camera Preview */}
        {(cameraEnabled || cameraLoading) && (
          <div style={{
            position: "fixed", top: 80, right: 16, width: 200, height: 150,
            borderRadius: 8, border: "2px solid rgba(100,200,255,0.5)",
            background: "#000", overflow: "hidden", zIndex: 1000,
            boxShadow: "0 0 12px rgba(100,200,255,0.3)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {cameraLoading && <div style={{ color: "#64c8ff", fontSize: 12 }}>Loading...</div>}
            {cameraError && (
              <div style={{ color: "#ff6060", fontSize: 10, padding: 8, textAlign: "center" }}>✕ {cameraError}</div>
            )}
            <video
              ref={videoRef}
              style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)", display: cameraError ? "none" : "block" }}
              autoPlay playsInline muted
              onError={() => setCameraError("Video playback error")}
            />
            {cameraEnabled && !cameraError && (
              <div style={{
                position: "absolute", bottom: 4, left: 4, fontSize: 8,
                color: "#64c8ff", background: "rgba(0,0,0,0.7)",
                padding: "2px 4px", borderRadius: 3, fontWeight: 600,
              }}>LIVE</div>
            )}
          </div>
        )}

        <div style={{ display: "flex", padding: "16px", gap: 16 }}>
          {/* Left: Video + Attention Chart */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div ref={containerRef} style={{
              position: "relative", borderRadius: 12, overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.08)", background: "#000",
            }}>
              <canvas
                ref={canvasRef}
                width={VIDEO_W}
                height={VIDEO_H}
                style={{ width: "100%", height: "auto", display: "block" }}
              />
              <div style={{
                position: "absolute", top: 12, left: 12,
                background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)",
                borderRadius: 6, padding: "4px 10px",
                fontSize: 12, fontWeight: 600, color: "#fff", fontVariantNumeric: "tabular-nums",
              }}>
                {formatTime(currentTime)} / {formatTime(uploadedVideoDuration || DURATION)}
              </div>
              {isPlaying && (
                <div style={{
                  position: "absolute", top: 12, right: 12,
                  background: "rgba(255,40,40,0.85)", borderRadius: 4,
                  padding: "3px 8px", fontSize: 10, fontWeight: 700,
                  color: "#fff", letterSpacing: "1px",
                  animation: "pulse 1.5s ease-in-out infinite",
                }}>● LIVE</div>
              )}
              <div style={{
                position: "absolute", bottom: 12, right: 12,
                background: `rgba(${currentIntensity > 70 ? "255,60,30" : currentIntensity > 40 ? "255,180,30" : "40,180,255"},0.85)`,
                borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#fff",
              }}>
                ATTENTION: {currentIntensity}%
              </div>
            </div>

            {/* Attention Timeline Chart */}
            <div style={{
              marginTop: 12, padding: "14px 16px",
              background: "rgba(255,255,255,0.03)",
              borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)",
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#888", marginBottom: 8, letterSpacing: "1px", textTransform: "uppercase" }}>
                Attention Intensity Over Time
              </div>
              <ResponsiveContainer width="100%" height={100}>
                <AreaChart data={timeline}>
                  <defs>
                    <linearGradient id="attGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ff6040" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#ff6040" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" tick={{ fontSize: 9, fill: "#555" }} tickLine={false} axisLine={{ stroke: "#222" }} />
                  <YAxis hide domain={[0, 100]} />
                  <Tooltip
                    contentStyle={{ background: "#1a1b22", border: "1px solid #333", borderRadius: 6, fontSize: 11 }}
                    labelStyle={{ color: "#888" }}
                    formatter={(v) => [`${v}%`, "Intensity"]}
                  />
                  <Area type="monotone" dataKey="intensity" stroke="#ff6040" fill="url(#attGrad)" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey={() => null} />
                </AreaChart>
              </ResponsiveContainer>
              <div style={{ position: "relative", height: 2, marginTop: -4 }}>
                <div style={{
                  position: "absolute",
                  left: `${(currentTime / DURATION) * 100}%`,
                  top: -60, width: 2, height: 64,
                  background: "rgba(255,255,255,0.25)",
                  transition: isPlaying ? "none" : "left 0.15s ease",
                }} />
              </div>
            </div>
          </div>

          {/* Right Sidebar */}
          <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>

            {/* Video Source */}
            <PanelCard title="Video Source">
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/*"
                style={{ display: "none" }}
                onChange={handleFileUpload}
              />
              {!uploadedVideoUrl ? (
                <button
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    ...btnStyle, width: "100%",
                    background: "rgba(160,200,255,0.1)",
                    color: "#a0c8ff",
                    border: "1px dashed rgba(160,200,255,0.3)",
                    padding: "14px 0",
                    fontSize: 12,
                  }}
                >
                  📂 Upload MP4
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{
                    background: "rgba(160,200,255,0.08)", borderRadius: 6,
                    padding: "8px 10px", border: "1px solid rgba(160,200,255,0.2)",
                  }}>
                    <div style={{ fontSize: 10, color: "#a0c8ff", fontWeight: 700, marginBottom: 2 }}>📹 LOADED</div>
                    <div style={{ fontSize: 10, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{uploadedVideoName}</div>
                    {uploadedVideoDuration && <div style={{ fontSize: 9, color: "#555", marginTop: 2 }}>{uploadedVideoDuration.toFixed(1)}s</div>}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => fileInputRef.current?.click()} style={{
                      ...btnStyle, flex: 1,
                      background: "rgba(255,255,255,0.05)", color: "#888",
                      border: "1px solid rgba(255,255,255,0.08)", fontSize: 10,
                    }}>Replace</button>
                    <button onClick={clearUploadedVideo} style={{
                      ...btnStyle,
                      background: "rgba(255,60,60,0.1)", color: "#ff8080",
                      border: "1px solid rgba(255,60,60,0.2)", fontSize: 10,
                    }}>✕ Clear</button>
                  </div>
                </div>
              )}
            </PanelCard>

            {/* Playback */}
            <PanelCard title="Playback">
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button onClick={() => {
                  const next = !isPlaying;
                  setIsPlaying(next);
                  if (uploadedVideoUrl && uploadedVideoRef.current) {
                    // Must call play/pause directly in the click handler (user-gesture context)
                    if (next) uploadedVideoRef.current.play().catch(() => {});
                    else uploadedVideoRef.current.pause();
                  }
                }} style={{
                  ...btnStyle, flex: 1,
                  background: isPlaying ? "rgba(255,60,60,0.15)" : "rgba(60,255,140,0.15)",
                  color: isPlaying ? "#ff6060" : "#60ff8c",
                  border: `1px solid ${isPlaying ? "rgba(255,60,60,0.3)" : "rgba(60,255,140,0.3)"}`,
                }}>
                  {isPlaying ? "⏸ Pause" : "▶ Play"}
                </button>
                <button onClick={() => {
                  setCurrentTime(0);
                  setIsPlaying(false);
                  if (uploadedVideoRef.current && uploadedVideoUrl) {
                    uploadedVideoRef.current.pause();
                    uploadedVideoRef.current.currentTime = 0;
                  }
                }} style={{
                  ...btnStyle, background: "rgba(255,255,255,0.05)", color: "#888",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}>⟲ Reset</button>
              </div>
              <div style={{ fontSize: 10, color: "#666", marginBottom: 4, letterSpacing: "0.5px" }}>TIMELINE</div>
              <input
                type="range"
                min={0}
                max={uploadedVideoDuration || DURATION}
                step={0.1}
                value={currentTime}
                onChange={e => {
                  const t = parseFloat(e.target.value);
                  setCurrentTime(t);
                  if (uploadedVideoRef.current && uploadedVideoUrl) uploadedVideoRef.current.currentTime = t;
                }}
                style={{ width: "100%", accentColor: "#ff6040", cursor: "pointer" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555", marginTop: 3 }}>
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(uploadedVideoDuration || DURATION)}</span>
              </div>
            </PanelCard>

            {/* Overlay Settings */}
            <PanelCard title="Overlay Settings">
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <SliderControl
                  label="Heatmap Opacity"
                  value={heatmapOpacity} min={0.1} max={1} step={0.05}
                  onChange={setHeatmapOpacity}
                  display={`${Math.round(heatmapOpacity * 100)}%`}
                />
                <SliderControl
                  label="Time Window"
                  value={windowSize} min={0.5} max={5} step={0.5}
                  onChange={setWindowSize}
                  display={`${windowSize}s`}
                />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <ToggleBtn active={showHeatmap} onClick={() => setShowHeatmap(!showHeatmap)} label="Heatmap" color="#ff6040" />
                <ToggleBtn active={showGaze} onClick={() => setShowGaze(!showGaze)} label="Gaze Pts" color="#00ffc8" />
              </div>
            </PanelCard>

            {/* Camera */}
            <PanelCard title="Camera">
              <button
                onClick={() => cameraEnabled ? disableCamera() : initializeCameraAsync()}
                disabled={cameraLoading}
                style={{
                  ...btnStyle, width: "100%",
                  background: cameraLoading ? "rgba(255,200,30,0.15)" : cameraEnabled ? "rgba(100,200,255,0.15)" : "rgba(255,255,255,0.05)",
                  color: cameraLoading ? "#ffc81e" : cameraEnabled ? "#64c8ff" : "#888",
                  border: `1px solid ${cameraLoading ? "rgba(255,200,30,0.3)" : cameraEnabled ? "rgba(100,200,255,0.3)" : "rgba(255,255,255,0.08)"}`,
                  cursor: cameraLoading ? "not-allowed" : "pointer",
                  opacity: cameraLoading ? 0.7 : 1,
                }}
              >
                📷 {cameraLoading ? "Loading..." : cameraEnabled ? "Stop Camera" : "Start Camera"}
              </button>
              {cameraError && <div style={{ fontSize: 10, color: "#ff6060", marginTop: 8 }}>✕ {cameraError}</div>}
            </PanelCard>

            {/* Eye Tracker */}
            <PanelCard title="Eye Tracker">
              {eyeTrackerStatus === "idle" && (
                <button onClick={startEyeTracker} style={{
                  ...btnStyle, width: "100%",
                  background: "rgba(180,120,255,0.1)", color: "#c080ff",
                  border: "1px solid rgba(180,120,255,0.3)", padding: "10px 0",
                }}>👁 Start Eye Tracker</button>
              )}
              {eyeTrackerStatus === "loading" && (
                <div style={{ fontSize: 11, color: "#c080ff", textAlign: "center", padding: "8px 0" }}>Loading eye tracker…</div>
              )}
              {eyeTrackerStatus === "calibrating" && (
                <div style={{ fontSize: 11, color: "#ffb420", textAlign: "center", padding: "8px 0" }}>● Calibrating — follow the dot</div>
              )}
              {eyeTrackerStatus === "verifying" && (
                <div style={{ fontSize: 11, color: "#60c8ff", textAlign: "center", padding: "8px 0" }}>● Fine-tuning — look &amp; click each dot ({verifyStep}/{VERIFY_DOTS.length})</div>
              )}
              {eyeTrackerStatus === "tracking" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#60ff8c", boxShadow: "0 0 6px #60ff8c", animation: "pulse 1.5s infinite" }} />
                    <span style={{ fontSize: 11, color: "#60ff8c", fontWeight: 700 }}>LIVE TRACKING</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#555" }}>{liveGazeData.length.toLocaleString()} gaze pts collected</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={recalibrate} style={{
                      ...btnStyle, flex: 1, fontSize: 10,
                      background: "rgba(180,120,255,0.1)", color: "#c080ff",
                      border: "1px solid rgba(180,120,255,0.3)",
                    }}>↺ Recalibrate</button>
                    <button onClick={resetGazeData} style={{
                      ...btnStyle, flex: 1, fontSize: 10,
                      background: "rgba(255,255,255,0.05)", color: "#888",
                      border: "1px solid rgba(255,255,255,0.08)",
                    }}>⟲ Reset Data</button>
                    <button onClick={stopEyeTracker} style={{
                      ...btnStyle, fontSize: 10,
                      background: "rgba(255,60,60,0.1)", color: "#ff8080",
                      border: "1px solid rgba(255,60,60,0.2)",
                    }}>Stop</button>
                  </div>
                </div>
              )}
              {eyeTrackerStatus === "error" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 10, color: "#ff6060" }}>✕ {eyeTrackerError}</div>
                  <button onClick={startEyeTracker} style={{
                    ...btnStyle, width: "100%", fontSize: 10,
                    background: "rgba(255,255,255,0.05)", color: "#888",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}>Retry</button>
                </div>
              )}
            </PanelCard>

            {/* Data Panel */}
            <div style={{ flex: 1 }}>
              <div style={{
                display: "flex", gap: 2, marginBottom: 8,
                background: "rgba(255,255,255,0.03)", borderRadius: 8,
                padding: 3, border: "1px solid rgba(255,255,255,0.06)",
              }}>
                {["zones", "insights", "grid"].map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)} style={{
                    flex: 1, padding: "6px 0", fontSize: 10, fontWeight: 600,
                    letterSpacing: "0.8px", textTransform: "uppercase",
                    background: activeTab === tab ? "rgba(255,96,64,0.15)" : "transparent",
                    color: activeTab === tab ? "#ff6040" : "#555",
                    border: "none", borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                  }}>{tab}</button>
                ))}
              </div>

              {activeTab === "zones" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <PanelCard title="Top Attention Zones">
                    {topRegions.map((r, i) => (
                      <div key={r.label} style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "6px 0",
                        borderBottom: i < topRegions.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                      }}>
                        <div style={{
                          width: 22, height: 22, borderRadius: 5, fontSize: 10, fontWeight: 700,
                          background: i === 0 ? "rgba(255,60,30,0.2)" : i < 3 ? "rgba(255,180,30,0.15)" : "rgba(255,255,255,0.05)",
                          color: i === 0 ? "#ff6040" : i < 3 ? "#ffb420" : "#666",
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>{i + 1}</div>
                        <div style={{ flex: 1 }}><div style={{ fontSize: 11, color: "#ccc" }}>{r.label}</div></div>
                        <div style={{ fontSize: 12, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: i === 0 ? "#ff6040" : "#999" }}>
                          {r.attention.toFixed(1)}%
                        </div>
                      </div>
                    ))}
                  </PanelCard>
                  <PanelCard title="Stats">
                    <StatRow label="Peak Attention" value={`${peakTime.intensity}% @ ${peakTime.time}s`} />
                    <StatRow label="Low Attention" value={`${lowTime.intensity}% @ ${lowTime.time}s`} />
                    <StatRow label="Current Intensity" value={`${currentIntensity}%`} />
                    <StatRow label="Gaze Points" value={totalGazePoints.toLocaleString()} />
                  </PanelCard>
                </div>
              )}

              {activeTab === "insights" && (
                <PanelCard title="AI Insights">
                  <Insight icon="⚠️" color="#ffb420" title="CTA Blindness Detected" text="Bottom-right CTA region received only 4.2% of total attention. Consider repositioning." />
                  <Insight icon="🎯" color="#60ff8c" title="Strong Center Bias" text="57% of gaze concentrated in center regions during first 10 seconds." />
                  <Insight icon="📉" color="#ff6040" title="Attention Drop" text={`Significant drop at ${lowTime.time}s — consider adding visual cue or transition.`} />
                  <Insight icon="👤" color="#40a0ff" title="Face Attraction" text="Face regions captured 42% attention — confirms face-priority viewing behavior." />
                </PanelCard>
              )}

              {activeTab === "grid" && (
                <PanelCard title="4×4 Attention Grid">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 3, marginTop: 4 }}>
                    {regions.sort((a, b) => (a.row * 4 + a.col) - (b.row * 4 + b.col)).map(r => {
                      const intensity = r.attention / Math.max(...regions.map(rr => rr.attention), 1);
                      const [cr, cg, cb] = heatColor(intensity);
                      return (
                        <div key={`${r.row}-${r.col}`} style={{
                          aspectRatio: "16/9", borderRadius: 4,
                          background: `rgba(${cr},${cg},${cb},${0.15 + intensity * 0.5})`,
                          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                          fontSize: 10, fontWeight: 700,
                          color: intensity > 0.5 ? "#fff" : "#888",
                          border: `1px solid rgba(${cr},${cg},${cb},0.3)`,
                        }}>
                          <div style={{ fontSize: 8, opacity: 0.6 }}>{r.short}</div>
                          <div>{r.attention.toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 10, color: "#555" }}>
                    Each cell shows the % of total gaze points in the current time window.
                  </div>
                </PanelCard>
              )}

              {/* Heat Scale */}
              <div style={{
                marginTop: 12, padding: "10px 14px",
                background: "rgba(255,255,255,0.03)",
                borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)",
              }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#666", letterSpacing: "0.8px", marginBottom: 6 }}>HEAT SCALE</div>
                <div style={{ height: 12, borderRadius: 6, background: "linear-gradient(90deg, #0a1eb4, #14a0c8, #28c850, #e6dc1e, #fa820a, #f01e14)" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#555", marginTop: 3 }}>
                  <span>Low</span><span>Medium</span><span>High</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
          input[type="range"] {
            height: 4px;
            border-radius: 2px;
            -webkit-appearance: none;
            appearance: none;
            background: rgba(255,255,255,0.1);
            outline: none;
          }
          input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px; height: 14px;
            border-radius: 50%;
            background: #ff6040;
            cursor: pointer;
            border: 2px solid #1a1b22;
          }
        `}</style>
      </div>
    </>
  );
}

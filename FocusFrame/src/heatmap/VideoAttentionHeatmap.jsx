import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { ReferenceLine, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from "recharts";

import { computeHeatmapForFrame, computeRegionAttention, computeAttentionTimeline } from "./gazeUtils.js";
import { heatColor } from "./canvasUtils.js";
import { initEyeTracker, stopEyeTracker as destroyEyeTracker, fitCalibration, irisToScreen, resetCalibration, applyBiasCorrection } from "./eyeTracker.js";
import { btnStyle, formatTime, ToggleBtn, SliderControl, PanelCard, StatRow, Insight } from "./UIComponents.jsx";

const VIDEO_W = 640;
const VIDEO_H = 360;
const FPS = 30;

/**
 * Unified session flow:
 *   IDLE  →  upload video  →  click "Start Session"
 *   CALIBRATING  →  eye tracker loads → moving-dot calibration → verification dots
 *   RECORDING  →  video plays + gaze tracked simultaneously
 *   REVIEW  →  scrub / replay with heatmap overlay + analytics
 */
const PHASE = { IDLE: "idle", CALIBRATING: "calibrating", RECORDING: "recording", REVIEW: "review" };

// Moving-dot calibration waypoints (fractional canvas coords)
const CAL_WAYPOINTS = [
  [0.5,  0.5 ],
  [0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95],
  [0.05, 0.05], [0.5,  0.05], [0.5,  0.5 ],
  [0.95, 0.5 ], [0.5,  0.5 ], [0.5,  0.95],
  [0.5,  0.5 ], [0.05, 0.5 ], [0.5,  0.5 ],
  [0.3,  0.3 ], [0.7,  0.3 ], [0.7,  0.7 ],
  [0.3,  0.7 ], [0.5,  0.5 ],
];

// Verification dots for post-calibration bias correction
const VERIFY_DOTS = [
  { fx: 0.5,  fy: 0.5  },
  { fx: 0.08, fy: 0.08 },
  { fx: 0.92, fy: 0.08 },
  { fx: 0.08, fy: 0.92 },
  { fx: 0.92, fy: 0.92 },
];

// Calibration timing
const DWELL_MS   = 1400;
const TRANSIT_MS = 1200;
const SETTLE_MS  = 400;

export default function VideoAttentionHeatmap({ onViewReport, onViewSessions, hidden }) {
  // ─── Refs ────────────────────────────────────────────────────────────
  const canvasRef                = useRef(null);
  const containerRef             = useRef(null);
  const animRef                  = useRef(null);
  const uploadedVideoRef         = useRef(null);
  const uploadedVideoFileRef     = useRef(null);
  const fileInputRef             = useRef(null);
  const renderCanvasRef          = useRef(null);
  const liveGazeCursorRef        = useRef(null);
  const smoothedGazeRef          = useRef(null);
  const eyeTrackerRafRef         = useRef(null);
  const calibrationCanvasRectRef = useRef(null);
  const oneEuroRef               = useRef(null);
  const prevIrisRef              = useRef(null);
  const verifyStepRef            = useRef(0);
  const verifyResidualsRef       = useRef([]);
  const calibDotPosRef           = useRef({ fx: 0.5, fy: 0.5 });
  const calibAnimRef             = useRef(null);
  const calibAnimRunningRef      = useRef(false);
  const irisBufferRef            = useRef([]);
  const calibrationPairsRef      = useRef([]);
  const liveGazeRef              = useRef([]);
  const currentVideoTimeRef      = useRef(0);
  const liveGazeUpdateTimer      = useRef(null);
  const recordingStartRef        = useRef(null);
  const calibratedRef            = useRef(false);

  // ─── Core State ──────────────────────────────────────────────────────
  const [phase, setPhase]                       = useState(PHASE.IDLE);
  const [currentTime, setCurrentTime]           = useState(0);
  const [isPlaying, setIsPlaying]               = useState(false);
  const [showHeatmap, setShowHeatmap]           = useState(true);
  const [showGaze, setShowGaze]                 = useState(false);
  const [heatmapOpacity, setHeatmapOpacity]     = useState(0.65);
  const [windowSize, setWindowSize]             = useState(2);
  const [activeTab, setActiveTab]               = useState("zones");
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState(null);
  const [uploadedVideoDuration, setUploadedVideoDuration] = useState(null);
  const [uploadedVideoName, setUploadedVideoName]         = useState(null);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [showGazeCursor, setShowGazeCursor] = useState(true);

  // ─── Eye Tracker Sub-State ──────────────────────────────────────────
  // Tracks internal calibration progress within the CALIBRATING phase
  const [etSubStatus, setEtSubStatus]             = useState("idle"); // idle|loading|dot-ready|dot-running|verifying|ready
  const [etError, setEtError]                     = useState(null);
  const [calibrationProgress, setCalibrationProgress] = useState(-1);
  const [verifyStep, setVerifyStep]               = useState(0);
  const [liveGazeData, setLiveGazeData]           = useState([]);

  // ─── Derived Data ───────────────────────────────────────────────────
  const activeDuration = uploadedVideoDuration ?? 30;
  const gazeData       = liveGazeData.length > 0 ? liveGazeData : [];

  // During recording: bucket by wallTime (independent of video playback position)
  // During review: bucket by video timestamp as before
  const LIVE_BUCKET_SEC = 0.5;
  const EXPECTED_GAZE_HZ = 12;
  const INTENSITY_WINDOW_SEC = 2;
  const timeline = useMemo(() => {
    if (gazeData.length === 0) return [];
    const hasWallTime = gazeData.some(p => p.wallTime !== undefined);
    if (hasWallTime) {
      const maxT = Math.max(...gazeData.map(p => p.wallTime ?? 0));
      const buckets = [];
      for (let t = 0; t <= maxT; t += LIVE_BUCKET_SEC) {
        const count = gazeData.filter(p => p.wallTime !== undefined && p.wallTime >= t && p.wallTime < t + LIVE_BUCKET_SEC).length;
        const intensity = Math.min(100, Math.round((count / (EXPECTED_GAZE_HZ * LIVE_BUCKET_SEC)) * 100));
        buckets.push({ time: +t.toFixed(1), intensity });
      }
      return buckets;
    }
    return computeAttentionTimeline(gazeData, activeDuration);
  }, [gazeData, activeDuration]);
  const regions = useMemo(
    () => gazeData.length > 0
      ? computeRegionAttention(gazeData, currentTime, windowSize, VIDEO_W, VIDEO_H, 4)
      : [],
    [gazeData, currentTime, windowSize]
  );

  // Keep currentVideoTimeRef in sync
  useEffect(() => { currentVideoTimeRef.current = currentTime; }, [currentTime]);

  // Cleanup on unmount
  useEffect(() => () => {
    destroyEyeTracker();
    if (liveGazeUpdateTimer.current) clearInterval(liveGazeUpdateTimer.current);
    if (calibAnimRef.current) cancelAnimationFrame(calibAnimRef.current);
    if (eyeTrackerRafRef.current) cancelAnimationFrame(eyeTrackerRafRef.current);
  }, []);

  // ─── Moving-dot Calibration Animation ──────────────────────────────
  const beginCalibrationAnimation = useCallback(() => {
    calibrationPairsRef.current = [];
    calibAnimRunningRef.current = false;
    const cr = calibrationCanvasRectRef.current;
    if (!cr) return;

    setEtSubStatus("dot-running");

    const WP = CAL_WAYPOINTS;
    const N  = WP.length;
    const TOTAL_MS = N * DWELL_MS + (N - 1) * TRANSIT_MS;

    let wpIdx     = 0;
    let phaseName = "dwell";
    let phaseStart = performance.now();

    calibDotPosRef.current = { fx: WP[0][0], fy: WP[0][1] };

    function frame(now) {
      const phaseElapsed = now - phaseStart;

      if (phaseName === "dwell") {
        calibAnimRunningRef.current = phaseElapsed >= SETTLE_MS;
        if (phaseElapsed >= DWELL_MS) {
          calibAnimRunningRef.current = false;
          if (wpIdx < N - 1) {
            phaseName = "transit";
            phaseStart = now;
            wpIdx++;
          } else {
            calibAnimRef.current = null;
            fitCalibration(calibrationPairsRef.current);
            verifyStepRef.current = 0;
            verifyResidualsRef.current = [];
            setVerifyStep(0);
            setEtSubStatus("verifying");
            return;
          }
        }
      } else {
        calibAnimRunningRef.current = false;
        const [ax, ay] = WP[wpIdx - 1];
        const [bx, by] = WP[wpIdx];
        const t = Math.min(phaseElapsed / TRANSIT_MS, 1);
        const eased = -(Math.cos(Math.PI * t) - 1) / 2;
        calibDotPosRef.current = { fx: ax + (bx - ax) * eased, fy: ay + (by - ay) * eased };

        if (phaseElapsed >= TRANSIT_MS) {
          calibDotPosRef.current = { fx: bx, fy: by };
          phaseName = "dwell";
          phaseStart = now;
        }
      }

      const elapsed = wpIdx * (DWELL_MS + TRANSIT_MS) + phaseElapsed;
      setCalibrationProgress(Math.min(elapsed / TOTAL_MS, 1));
      calibAnimRef.current = requestAnimationFrame(frame);
    }

    calibAnimRef.current = requestAnimationFrame(frame);
  }, []);

  // ─── Verification Click Handler ─────────────────────────────────────
  const handleVerifyClick = useCallback((e) => {
    e.stopPropagation();
    const cr = calibrationCanvasRectRef.current;
    if (!cr) return;
    const dot = VERIFY_DOTS[verifyStepRef.current];
    const dotSx = cr.left + dot.fx * cr.width;
    const dotSy = cr.top  + dot.fy * cr.height;

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
      const res = verifyResidualsRef.current;
      if (res.length > 0) {
        const meanDx = res.reduce((s, r) => s + r.dx, 0) / res.length;
        const meanDy = res.reduce((s, r) => s + r.dy, 0) / res.length;
        applyBiasCorrection(meanDx, meanDy);
      }
      setVerifyStep(next);
      setEtSubStatus("ready");
    } else {
      setVerifyStep(next);
    }
  }, []);

  // ─── Auto-transition: verification done → start recording ──────────
  useEffect(() => {
    if (phase !== PHASE.CALIBRATING) return;
    if (etSubStatus !== "ready") return;

    // Mark calibration as complete so future sessions can skip it
    calibratedRef.current = true;

    // Start the live gaze data timer
    liveGazeUpdateTimer.current = setInterval(() => {
      setLiveGazeData([...liveGazeRef.current]);
    }, 200);

    // Start the eye tracker canvas loop
    const tick = () => {
      renderCanvasRef.current?.();
      eyeTrackerRafRef.current = requestAnimationFrame(tick);
    };
    eyeTrackerRafRef.current = requestAnimationFrame(tick);

    // Start video and transition to RECORDING
    setPhase(PHASE.RECORDING);
    recordingStartRef.current = performance.now();
    if (uploadedVideoRef.current && uploadedVideoUrl) {
      uploadedVideoRef.current.currentTime = 0;
      uploadedVideoRef.current.play().catch(() => {});
    }
    setIsPlaying(true);
  }, [phase, etSubStatus, uploadedVideoUrl]);

  // ─── Recalibrate (force redo) ───────────────────────────────────────
  const handleRecalibrate = useCallback(() => {
    calibratedRef.current = false;
    destroyEyeTracker();
    resetCalibration();
    oneEuroRef.current = null;
    prevIrisRef.current = null;
    irisBufferRef.current = [];
    calibrationPairsRef.current = [];
  }, []);

  // ─── Session Actions ────────────────────────────────────────────────
  const handleStartSession = useCallback(async () => {
    // Reset all gaze data
    liveGazeRef.current = [];
    setLiveGazeData([]);
    setCurrentTime(0);
    setRecordingElapsed(0);
    recordingStartRef.current = null;
    setCalibrationProgress(-1);

    // Reset gaze-tracking state but keep calibration if already done
    oneEuroRef.current = null;
    prevIrisRef.current = null;
    liveGazeCursorRef.current = null;
    smoothedGazeRef.current = null;

    // If already calibrated, skip straight to recording
    if (calibratedRef.current) {
      setEtError(null);
      setEtSubStatus("ready");

      // Start gaze data timer
      liveGazeUpdateTimer.current = setInterval(() => {
        setLiveGazeData([...liveGazeRef.current]);
      }, 200);

      // Start canvas render loop
      const tick = () => {
        renderCanvasRef.current?.();
        eyeTrackerRafRef.current = requestAnimationFrame(tick);
      };
      eyeTrackerRafRef.current = requestAnimationFrame(tick);

      // Reset & play video — wait for readiness if needed
      if (uploadedVideoRef.current && uploadedVideoUrl) {
        const v = uploadedVideoRef.current;
        v.currentTime = 0;
        const startPlay = () => {
          v.play().catch(console.warn);
          recordingStartRef.current = performance.now();
          setPhase(PHASE.RECORDING);
          setIsPlaying(true);
        };
        if (v.readyState >= 3) {
          startPlay();
        } else {
          // Video needs to buffer (common after display:none) — wait for canplay
          const onReady = () => { v.removeEventListener('canplay', onReady); startPlay(); };
          v.addEventListener('canplay', onReady);
          v.load(); // force re-buffer
        }
      }
      return;
    }

    irisBufferRef.current = [];
    calibrationPairsRef.current = [];
    resetCalibration();

    setPhase(PHASE.CALIBRATING);
    setEtSubStatus("loading");
    setEtError(null);

    try {
      await initEyeTracker(({ x: ix, y: iy }) => {
        // Jump rejection
        const prev = prevIrisRef.current;
        if (prev) {
          const dist = Math.sqrt((ix - prev.x) ** 2 + (iy - prev.y) ** 2);
          if (dist > 0.2) { prevIrisRef.current = { x: ix, y: iy }; return; }
        }
        prevIrisRef.current = { x: ix, y: iy };

        irisBufferRef.current.push({ x: ix, y: iy });
        if (irisBufferRef.current.length > 20) irisBufferRef.current.shift();

        // Record calibration pairs while dot is animating
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

        // Map iris → screen → canvas (only when calibrated)
        const screenPt = irisToScreen(ix, iy);
        if (!screenPt) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = VIDEO_W / rect.width;
        const scaleY = VIDEO_H / rect.height;
        const rawCx = (screenPt.x - rect.left) * scaleX;
        const rawCy = (screenPt.y - rect.top) * scaleY;

        // 1€ filter
        const MIN_FC = 0.5, BETA = 0.08, D_FC = 1.0;
        const now_s = performance.now() / 1000;
        const prev1e = oneEuroRef.current;
        let sc;
        if (!prev1e) {
          sc = { x: rawCx, y: rawCy };
          oneEuroRef.current = { x: rawCx, dx: 0, y: rawCy, dy: 0, t: now_s };
        } else {
          const dt = Math.max(now_s - prev1e.t, 1e-4);
          const ad = 1 / (1 + 1 / (2 * Math.PI * D_FC * dt));
          const dxRaw = (rawCx - prev1e.x) / dt;
          const dyRaw = (rawCy - prev1e.y) / dt;
          const dx = ad * dxRaw + (1 - ad) * prev1e.dx;
          const dy = ad * dyRaw + (1 - ad) * prev1e.dy;
          const speed = Math.sqrt(dx * dx + dy * dy);
          const fc = MIN_FC + BETA * speed;
          const a  = 1 / (1 + 1 / (2 * Math.PI * fc * dt));
          const fx = a * rawCx + (1 - a) * prev1e.x;
          const fy = a * rawCy + (1 - a) * prev1e.y;
          sc = { x: fx, y: fy };
          oneEuroRef.current = { x: fx, dx, y: fy, dy, t: now_s };
        }
        smoothedGazeRef.current = sc;
        liveGazeCursorRef.current = { x: Math.round(sc.x), y: Math.round(sc.y) };

        // Record gaze point
        if (sc.x >= 0 && sc.x < VIDEO_W && sc.y >= 0 && sc.y < VIDEO_H) {
          liveGazeRef.current.push({
            timestamp: currentVideoTimeRef.current,
            wallTime: recordingStartRef.current != null ? (performance.now() - recordingStartRef.current) / 1000 : 0,
            x: Math.round(sc.x),
            y: Math.round(sc.y),
            frame: Math.round(currentVideoTimeRef.current * FPS),
          });
        }
      });

      // Eye tracker loaded — show calibration
      setEtSubStatus("dot-ready");
      calibrationCanvasRectRef.current = canvasRef.current?.getBoundingClientRect() ?? null;
      calibDotPosRef.current = { fx: 0.5, fy: 0.5 };
    } catch (err) {
      setEtError(err.message);
      setEtSubStatus("idle");
      setPhase(PHASE.IDLE);
    }
  }, []);

  const handleStopSession = useCallback(() => {
    // Stop animations & timers; keep eye tracker alive if calibrated
    if (calibAnimRef.current) { cancelAnimationFrame(calibAnimRef.current); calibAnimRef.current = null; }
    calibAnimRunningRef.current = false;
    if (!calibratedRef.current) destroyEyeTracker();
    if (liveGazeUpdateTimer.current) { clearInterval(liveGazeUpdateTimer.current); liveGazeUpdateTimer.current = null; }
    if (eyeTrackerRafRef.current) { cancelAnimationFrame(eyeTrackerRafRef.current); eyeTrackerRafRef.current = null; }
    liveGazeCursorRef.current = null;
    smoothedGazeRef.current = null;
    oneEuroRef.current = null;
    prevIrisRef.current = null;

    setIsPlaying(false);
    if (uploadedVideoRef.current) uploadedVideoRef.current.pause();

    // Flush final gaze data
    setLiveGazeData([...liveGazeRef.current]);
    setEtSubStatus("idle");
    setPhase(PHASE.REVIEW);
    setCurrentTime(0);
  }, []);

  const handleVideoEnded = useCallback(() => {
    if (phase === PHASE.RECORDING) {
      handleStopSession();
    } else {
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [phase, handleStopSession]);

  const handleNewSession = useCallback(() => {
    // Stop animations & timers but keep eye tracker alive if calibrated
    if (calibAnimRef.current) { cancelAnimationFrame(calibAnimRef.current); calibAnimRef.current = null; }
    calibAnimRunningRef.current = false;
    if (liveGazeUpdateTimer.current) { clearInterval(liveGazeUpdateTimer.current); liveGazeUpdateTimer.current = null; }
    if (eyeTrackerRafRef.current) { cancelAnimationFrame(eyeTrackerRafRef.current); eyeTrackerRafRef.current = null; }

    if (!calibratedRef.current) {
      destroyEyeTracker();
    }

    liveGazeRef.current = [];
    liveGazeCursorRef.current = null;
    smoothedGazeRef.current = null;
    setLiveGazeData([]);
    setPhase(PHASE.IDLE);
    setEtSubStatus("idle");
    setCurrentTime(0);
    setIsPlaying(false);
    setRecordingElapsed(0);
    recordingStartRef.current = null;

    // Also reset the actual video element so it's clean for the next session
    if (uploadedVideoRef.current) {
      uploadedVideoRef.current.pause();
      uploadedVideoRef.current.currentTime = 0;
    }
  }, []);

  // ─── MP4 Upload ────────────────────────────────────────────────────
  const handleFileUpload = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
    uploadedVideoFileRef.current = file;
    const url = URL.createObjectURL(file);
    setUploadedVideoUrl(url);
    setUploadedVideoName(file.name);
    setCurrentTime(0);
    setIsPlaying(false);
    handleNewSession();
  }, [uploadedVideoUrl, handleNewSession]);

  const clearUploadedVideo = useCallback(() => {
    setIsPlaying(false);
    uploadedVideoFileRef.current = null;
    if (uploadedVideoRef.current) {
      uploadedVideoRef.current.pause();
      uploadedVideoRef.current.src = "";
    }
    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
    setUploadedVideoUrl(null);
    setUploadedVideoDuration(null);
    setUploadedVideoName(null);
    setCurrentTime(0);
    handleNewSession();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [uploadedVideoUrl, handleNewSession]);

  useEffect(() => () => { if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl); }, [uploadedVideoUrl]);

  // ─── Canvas Render ─────────────────────────────────────────────────
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width  = VIDEO_W;
    canvas.height = VIDEO_H;
    ctx.clearRect(0, 0, VIDEO_W, VIDEO_H);

    // Draw video frame or placeholder
    if (uploadedVideoUrl && uploadedVideoRef.current && uploadedVideoRef.current.readyState >= 2) {
      ctx.drawImage(uploadedVideoRef.current, 0, 0, VIDEO_W, VIDEO_H);
    } else {
      ctx.fillStyle = "#0d0e14";
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
      ctx.font = "600 15px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.textAlign = "center";
      ctx.fillText("NO VIDEO LOADED", VIDEO_W / 2, VIDEO_H / 2 - 10);
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillText("Upload an MP4 to get started", VIDEO_W / 2, VIDEO_H / 2 + 14);
      ctx.textAlign = "left";
    }

    // Heatmap overlay
    const gazeForRender = phase === PHASE.RECORDING ? liveGazeRef.current : gazeData;
    if (showHeatmap && gazeForRender.length > 0) {
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
                  imgData.data[idx]     = Math.min(255, imgData.data[idx]     + r * srcA);
                  imgData.data[idx + 1] = Math.min(255, imgData.data[idx + 1] + g * srcA);
                  imgData.data[idx + 2] = Math.min(255, imgData.data[idx + 2] + b * srcA);
                  imgData.data[idx + 3] = Math.max(imgData.data[idx + 3], alpha);
                }
              }
            }
          }
        }
      }
      const tmpCanvas = document.createElement("canvas");
      tmpCanvas.width  = VIDEO_W;
      tmpCanvas.height = VIDEO_H;
      tmpCanvas.getContext("2d").putImageData(imgData, 0, 0);
      ctx.drawImage(tmpCanvas, 0, 0);
    }

    // Gaze points overlay
    if (showGaze && gazeForRender.length > 0) {
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

    // Live gaze cursor during recording (toggle-able)
    if (phase === PHASE.RECORDING && showGazeCursor) {
      const cur = liveGazeCursorRef.current;
      if (cur && cur.x >= 0 && cur.x < VIDEO_W && cur.y >= 0 && cur.y < VIDEO_H) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cur.x, cur.y, 20, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 80, 40, 0.7)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cur.x, cur.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 80, 40, 0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 80, 40, 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cur.x - 28, cur.y); ctx.lineTo(cur.x - 22, cur.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cur.x + 22, cur.y); ctx.lineTo(cur.x + 28, cur.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cur.x, cur.y - 28); ctx.lineTo(cur.x, cur.y - 22); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cur.x, cur.y + 22); ctx.lineTo(cur.x, cur.y + 28); ctx.stroke();
        ctx.restore();
      }
    }
  }, [gazeData, currentTime, showHeatmap, showGaze, showGazeCursor, heatmapOpacity, windowSize, uploadedVideoUrl, phase]);

  useEffect(() => { renderCanvasRef.current = renderCanvas; }, [renderCanvas]);
  useEffect(() => { renderCanvas(); }, [renderCanvas]);

  // Re-kick video & canvas when component becomes visible after being hidden
  const prevHiddenRef = useRef(hidden);
  useEffect(() => {
    if (prevHiddenRef.current && !hidden) {
      // Component just became visible again — force video frame decode
      if (uploadedVideoRef.current && uploadedVideoUrl) {
        const v = uploadedVideoRef.current;
        const t = v.currentTime;
        v.currentTime = t; // re-seek forces frame buffer refresh
      }
      // Re-render canvas on next frame to pick up the fresh video frame
      requestAnimationFrame(() => renderCanvasRef.current?.());
    }
    prevHiddenRef.current = hidden;
  }, [hidden, uploadedVideoUrl]);

  // ─── Playback / Recording Loop ─────────────────────────────────────
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(animRef.current);
      if (uploadedVideoRef.current && uploadedVideoUrl) uploadedVideoRef.current.pause();
      return;
    }
    const tick = () => {
      if (uploadedVideoUrl && uploadedVideoRef.current) {
        renderCanvasRef.current?.();
        const vt = uploadedVideoRef.current.currentTime;
        setCurrentTime(vt);
        if (phase === PHASE.RECORDING && recordingStartRef.current) {
          setRecordingElapsed((performance.now() - recordingStartRef.current) / 1000);
        }
        if (uploadedVideoRef.current.ended) {
          setIsPlaying(false);
          setCurrentTime(0);
          return;
        }
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [isPlaying, uploadedVideoUrl, phase]);

  // ─── Computed Metrics ──────────────────────────────────────────────
  const topRegions      = regions.slice(0, 5);
  const totalGazePoints = gazeData.length;
  const currentIntensity = (() => {
    if (phase !== PHASE.RECORDING || !recordingStartRef.current) return 0;
    const wallNow = (performance.now() - recordingStartRef.current) / 1000;
    const count = liveGazeRef.current.filter(
      p => p.wallTime !== undefined && p.wallTime >= wallNow - INTENSITY_WINDOW_SEC && p.wallTime <= wallNow
    ).length;
    return Math.min(100, Math.round((count / (EXPECTED_GAZE_HZ * INTENSITY_WINDOW_SEC)) * 100));
  })();
  const peakTime = timeline.length > 0 ? timeline.reduce((best, b) => b.intensity > best.intensity ? b : best, timeline[0]) : { intensity: 0, time: 0 };
  const lowTime  = timeline.length > 0 ? timeline.reduce((best, b) => b.intensity < best.intensity ? b : best, timeline[0]) : { intensity: 0, time: 0 };

  // ─── Phase Labels ──────────────────────────────────────────────────
  const phaseLabel = {
    [PHASE.IDLE]:        { text: "READY",       bg: "rgba(255,255,255,0.08)", color: "#888" },
    [PHASE.CALIBRATING]: { text: "CALIBRATING", bg: "rgba(255,180,40,0.15)",  color: "#ffb428" },
    [PHASE.RECORDING]:   { text: "● RECORDING", bg: "rgba(255,40,40,0.15)",   color: "#ff6060" },
    [PHASE.REVIEW]:      { text: "REVIEW",      bg: "rgba(100,200,255,0.15)", color: "#64c8ff" },
  }[phase];

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0b0f", color: "#e0e0e6",
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    }}>
      {/* ─── Header ──────────────────────────────────────────────── */}
      <div style={{
        padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "rgba(255,255,255,0.02)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: "linear-gradient(135deg, #ff4040, #ff8800)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
          }}>🔥</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.5px", color: "#fff" }}>FOCUSFRAME</div>
            <div style={{ fontSize: 10, color: "#666", letterSpacing: "1.5px", textTransform: "uppercase" }}>Attention Heatmap · MediaPipe Iris · v0.2</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 11, color: "#555", alignItems: "center" }}>
          {uploadedVideoName && (
            <span style={{ color: "#a0c8ff", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📹 {uploadedVideoName}</span>
          )}
          {totalGazePoints > 0 && <span>{totalGazePoints.toLocaleString()} gaze pts</span>}
          {activeDuration && <span>{activeDuration.toFixed(1)}s</span>}
          <span style={{
            padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
            background: phaseLabel.bg, color: phaseLabel.color,
            border: `1px solid ${phaseLabel.color}33`,
          }}>{phaseLabel.text}</span>
        </div>
      </div>

      {/* ─── Hidden Video Element ────────────────────────────────── */}
      {uploadedVideoUrl && (
        <video
          ref={uploadedVideoRef}
          src={uploadedVideoUrl}
          style={{ display: "none" }}
          onLoadedMetadata={() => { if (uploadedVideoRef.current) setUploadedVideoDuration(uploadedVideoRef.current.duration); }}
          onEnded={handleVideoEnded}
          preload="auto"
        />
      )}

      {/* ─── Calibration Overlay (moving dot) ────────────────────── */}
      {phase === PHASE.CALIBRATING && (etSubStatus === "dot-ready" || etSubStatus === "dot-running") && (() => {
        const cr = calibrationCanvasRectRef.current;
        if (!cr) return null;
        const { fx, fy } = calibDotPosRef.current;
        const dotX = cr.left + fx * cr.width;
        const dotY = cr.top  + fy * cr.height;
        const isRunning = etSubStatus === "dot-running";
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.82)", pointerEvents: "none" }}>
            <div style={{
              position: "fixed", left: cr.left, top: cr.top,
              width: cr.width, height: cr.height,
              border: "2px solid rgba(255,96,40,0.4)", borderRadius: 8, pointerEvents: "none",
            }} />
            <div style={{
              position: "fixed", left: cr.left, top: cr.top - 72,
              width: cr.width, textAlign: "center", pointerEvents: "none",
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>EYE TRACKER CALIBRATION</div>
              <div style={{ fontSize: 11, color: "#aaa" }}>
                {isRunning ? "Follow the dot with your eyes — keep your head still" : "Keep your head still and follow the moving dot with your eyes only"}
              </div>
            </div>
            {isRunning && (
              <div style={{
                position: "fixed", left: cr.left, top: cr.top + cr.height + 10,
                width: cr.width, height: 4, background: "rgba(255,255,255,0.1)", borderRadius: 2, pointerEvents: "none",
              }}>
                <div style={{
                  width: `${calibrationProgress * 100}%`, height: "100%",
                  background: "linear-gradient(90deg,#ff6040,#ffb420)", borderRadius: 2, transition: "width 0.05s linear",
                }} />
              </div>
            )}
            {isRunning && (
              <div style={{
                position: "fixed", left: dotX, top: dotY, transform: "translate(-50%,-50%)",
                width: 22, height: 22, borderRadius: "50%", background: "rgba(255,96,40,0.95)",
                boxShadow: "0 0 20px rgba(255,96,40,0.9), 0 0 40px rgba(255,96,40,0.5)",
                animation: "calPulse 0.6s ease-in-out infinite", pointerEvents: "none",
              }} />
            )}
            {!isRunning && (
              <button
                onClick={beginCalibrationAnimation}
                style={{
                  position: "fixed", left: cr.left + cr.width / 2, top: cr.top + cr.height / 2,
                  transform: "translate(-50%,-50%)", ...btnStyle,
                  background: "rgba(255,96,40,0.2)", color: "#ff6040",
                  border: "1px solid rgba(255,96,40,0.6)", padding: "10px 28px", fontSize: 14, fontWeight: 700, pointerEvents: "all",
                }}
              >▶ Start Calibration</button>
            )}
            <button
              onClick={handleNewSession}
              style={{
                position: "fixed", left: cr.left + cr.width / 2, top: cr.top + cr.height + (isRunning ? 28 : 16),
                transform: "translateX(-50%)", ...btnStyle,
                background: "rgba(255,60,60,0.15)", color: "#ff6060",
                border: "1px solid rgba(255,60,60,0.3)", padding: "7px 18px", pointerEvents: "all",
              }}
            >✕ Cancel</button>
            <style>{`@keyframes calPulse{0%,100%{box-shadow:0 0 20px rgba(255,96,40,0.9),0 0 40px rgba(255,96,40,0.5)}50%{box-shadow:0 0 30px rgba(255,96,40,1),0 0 60px rgba(255,96,40,0.7)}}`}</style>
          </div>
        );
      })()}

      {/* ─── Verification Overlay ────────────────────────────────── */}
      {phase === PHASE.CALIBRATING && etSubStatus === "verifying" && (() => {
        const cr = calibrationCanvasRectRef.current;
        if (!cr) return null;
        const dot = VERIFY_DOTS[Math.min(verifyStep, VERIFY_DOTS.length - 1)];
        const dotX = cr.left + dot.fx * cr.width;
        const dotY = cr.top  + dot.fy * cr.height;
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgba(0,0,0,0.82)", pointerEvents: "none" }}>
            <div style={{
              position: "fixed", left: cr.left, top: cr.top,
              width: cr.width, height: cr.height,
              border: "2px solid rgba(96,200,255,0.4)", borderRadius: 8, pointerEvents: "none",
            }} />
            <div style={{
              position: "fixed", left: cr.left, top: cr.top - 72,
              width: cr.width, textAlign: "center", pointerEvents: "none",
            }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 4 }}>FINE-TUNE CALIBRATION</div>
              <div style={{ fontSize: 11, color: "#aaa" }}>
                Look at the <span style={{ color: "#60c8ff" }}>dot</span> and click it — {verifyStep + 1} / {VERIFY_DOTS.length}
              </div>
            </div>
            {VERIFY_DOTS.slice(0, verifyStep).map((d, i) => (
              <div key={i} style={{
                position: "fixed", left: cr.left + d.fx * cr.width, top: cr.top + d.fy * cr.height,
                transform: "translate(-50%,-50%)", width: 12, height: 12, borderRadius: "50%",
                background: "#60ff8c", opacity: 0.7, boxShadow: "0 0 6px #60ff8c", pointerEvents: "none",
              }} />
            ))}
            <div
              onClick={handleVerifyClick}
              style={{
                position: "fixed", left: dotX, top: dotY, transform: "translate(-50%,-50%)",
                width: 30, height: 30, borderRadius: "50%", background: "rgba(96,200,255,0.95)",
                boxShadow: "0 0 20px rgba(96,200,255,0.9), 0 0 40px rgba(96,200,255,0.5)",
                animation: "verifyPulse 0.8s ease-in-out infinite",
                cursor: "crosshair", display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, color: "#000", fontWeight: 700, pointerEvents: "all",
              }}
            >{verifyStep + 1}</div>
            <button
              onClick={handleNewSession}
              style={{
                position: "fixed", left: cr.left + cr.width / 2, top: cr.top + cr.height + 16,
                transform: "translateX(-50%)", ...btnStyle,
                background: "rgba(255,60,60,0.15)", color: "#ff6060",
                border: "1px solid rgba(255,60,60,0.3)", padding: "7px 18px", pointerEvents: "all",
              }}
            >✕ Cancel</button>
            <style>{`@keyframes verifyPulse{0%,100%{box-shadow:0 0 20px rgba(96,200,255,0.9),0 0 40px rgba(96,200,255,0.5)}50%{box-shadow:0 0 30px rgba(96,200,255,1),0 0 60px rgba(96,200,255,0.7)}}`}</style>
          </div>
        );
      })()}

      {/* ─── Main Content ────────────────────────────────────────── */}
      <div style={{ display: "flex", padding: 16, gap: 16 }}>
        {/* Left: Canvas + Chart */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div ref={containerRef} style={{
            position: "relative", borderRadius: 12, overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.08)", background: "#000",
          }}>
            <canvas
              ref={canvasRef}
              width={VIDEO_W} height={VIDEO_H}
              style={{ width: "100%", height: "auto", display: "block" }}
            />

            {/* HUD Overlays */}
            <div style={{
              position: "absolute", top: 12, left: 12,
              background: "rgba(0,0,0,0.7)", backdropFilter: "blur(8px)",
              borderRadius: 6, padding: "4px 10px",
              fontSize: 12, fontWeight: 600, color: "#fff", fontVariantNumeric: "tabular-nums",
            }}>
              {formatTime(currentTime)} / {formatTime(activeDuration)}
            </div>
            {phase === PHASE.RECORDING && (
              <div style={{
                position: "absolute", top: 12, right: 12,
                background: "rgba(255,40,40,0.85)", borderRadius: 4,
                padding: "3px 8px", fontSize: 10, fontWeight: 700,
                color: "#fff", letterSpacing: "1px",
                animation: "pulse 1.5s ease-in-out infinite",
              }}>● REC {formatTime(recordingElapsed)}</div>
            )}
            {(phase === PHASE.REVIEW || phase === PHASE.RECORDING) && gazeData.length > 0 && (
              <div style={{
                position: "absolute", bottom: 12, right: 12,
                background: `rgba(${currentIntensity > 70 ? "255,60,30" : currentIntensity > 40 ? "255,180,30" : "40,180,255"},0.85)`,
                borderRadius: 6, padding: "4px 10px", fontSize: 11, fontWeight: 700, color: "#fff",
              }}>
                ATTENTION: {currentIntensity}%
              </div>
            )}
          </div>

          {/* Attention Timeline (review & recording) */}
          {(phase === PHASE.REVIEW || phase === PHASE.RECORDING) && gazeData.length > 0 && (
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
                  {timeline.length > 0 && (
                    <ReferenceLine
                      x={(() => {
                        if (recordingStartRef.current) {
                          const w = Math.round(((performance.now() - recordingStartRef.current) / 1000) * 2) / 2;
                          return +w.toFixed(1);
                        }
                        return Math.round(currentTime * 2) / 2;
                      })()}
                      stroke="rgba(255,255,255,0.5)"
                      strokeWidth={1.5}
                      strokeDasharray="3 3"
                    />
                  )}
                </AreaChart>
              </ResponsiveContainer>

            </div>
          )}
        </div>

        {/* ─── Right Sidebar ─────────────────────────────────────── */}
        <div style={{ width: 280, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>

          {/* 1. Select Video */}
          <PanelCard title="1 · Select Video">
            <input
              ref={fileInputRef}
              type="file" accept="video/mp4,video/*"
              style={{ display: "none" }}
              onChange={handleFileUpload}
            />
            {!uploadedVideoUrl ? (
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{
                  ...btnStyle, width: "100%",
                  background: "rgba(160,200,255,0.1)", color: "#a0c8ff",
                  border: "1px dashed rgba(160,200,255,0.3)",
                  padding: "14px 0", fontSize: 12,
                }}
              >📂 Upload MP4</button>
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
                    ...btnStyle, flex: 1, background: "rgba(255,255,255,0.05)", color: "#888",
                    border: "1px solid rgba(255,255,255,0.08)", fontSize: 10,
                  }}>Replace</button>
                  <button onClick={clearUploadedVideo} style={{
                    ...btnStyle, background: "rgba(255,60,60,0.1)", color: "#ff8080",
                    border: "1px solid rgba(255,60,60,0.2)", fontSize: 10,
                  }}>✕ Clear</button>
                </div>
              </div>
            )}
          </PanelCard>

          {/* 2. Eye Tracking Session */}
          <PanelCard title="2 · Eye Tracking Session">
            {/* Calibration Status */}
            {phase === PHASE.IDLE && calibratedRef.current && (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                marginBottom: 8, padding: "5px 10px",
                background: "rgba(96,255,140,0.06)", borderRadius: 6,
                border: "1px solid rgba(96,255,140,0.15)",
              }}>
                <span style={{ fontSize: 10, color: "#60ff8c", fontWeight: 600 }}>✓ Calibrated</span>
                <button onClick={handleRecalibrate} style={{
                  ...btnStyle, fontSize: 9, padding: "3px 8px",
                  background: "rgba(255,255,255,0.05)", color: "#888",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}>Recalibrate</button>
              </div>
            )}

            {/* IDLE */}
            {phase === PHASE.IDLE && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button
                  onClick={handleStartSession}
                  disabled={!uploadedVideoUrl}
                  style={{
                    ...btnStyle, width: "100%", padding: "14px 0", fontSize: 13, fontWeight: 700,
                    background: uploadedVideoUrl ? "linear-gradient(135deg, rgba(180,120,255,0.2), rgba(100,200,255,0.2))" : "rgba(255,255,255,0.03)",
                    color: uploadedVideoUrl ? "#c080ff" : "#444",
                    border: `1px solid ${uploadedVideoUrl ? "rgba(180,120,255,0.3)" : "rgba(255,255,255,0.06)"}`,
                    cursor: uploadedVideoUrl ? "pointer" : "not-allowed",
                    opacity: uploadedVideoUrl ? 1 : 0.5,
                  }}
                >
                  👁 Start Session
                </button>
                {!uploadedVideoUrl && (
                  <div style={{ fontSize: 10, color: "#555", textAlign: "center" }}>Upload a video first</div>
                )}
                {etError && <div style={{ fontSize: 10, color: "#ff6060", marginTop: 4 }}>✕ {etError}</div>}
                {onViewSessions && (
                  <button
                    onClick={onViewSessions}
                    style={{
                      ...btnStyle, width: "100%", padding: "10px 0", fontSize: 11, fontWeight: 600,
                      background: "rgba(255,180,40,0.08)", color: "#ffb420",
                      border: "1px solid rgba(255,180,40,0.2)",
                      marginTop: 4,
                    }}
                  >📊 View Past Sessions</button>
                )}
              </div>
            )}

            {/* CALIBRATING */}
            {phase === PHASE.CALIBRATING && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
                {etSubStatus === "loading" && (
                  <div style={{ fontSize: 11, color: "#c080ff", textAlign: "center", padding: "8px 0" }}>
                    Loading MediaPipe iris tracker…
                  </div>
                )}
                {(etSubStatus === "dot-ready" || etSubStatus === "dot-running") && (
                  <div style={{
                    fontSize: 11, color: "#ffb428", textAlign: "center", padding: "8px 0",
                    animation: "pulse 1.5s ease-in-out infinite",
                  }}>
                    🎯 {etSubStatus === "dot-ready" ? "Ready — click Start Calibration on the overlay" : "Follow the dot with your eyes"}
                  </div>
                )}
                {etSubStatus === "verifying" && (
                  <div style={{
                    fontSize: 11, color: "#60c8ff", textAlign: "center", padding: "8px 0",
                  }}>
                    Fine-tuning — look at each dot and click ({verifyStep}/{VERIFY_DOTS.length})
                  </div>
                )}
                <button onClick={handleNewSession} style={{
                  ...btnStyle, fontSize: 9, background: "rgba(255,255,255,0.05)", color: "#666",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}>Cancel</button>
              </div>
            )}

            {/* RECORDING */}
            {phase === PHASE.RECORDING && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{
                  fontSize: 10, color: "#60ff8c", textAlign: "center", padding: "6px 0",
                  animation: "pulse 1.5s ease-in-out infinite",
                }}>
                  ● Tracking active — look at the video
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#888" }}>
                  <span>{liveGazeRef.current.length.toLocaleString()} gaze points</span>
                  <span>{formatTime(recordingElapsed)} elapsed</span>
                </div>
                <button onClick={handleStopSession} style={{
                  ...btnStyle, width: "100%", padding: "10px 0",
                  background: "rgba(255,60,60,0.15)", color: "#ff6060",
                  border: "1px solid rgba(255,60,60,0.3)", fontSize: 12, fontWeight: 700,
                }}>⏹ Stop Recording</button>
              </div>
            )}

            {/* REVIEW */}
            {phase === PHASE.REVIEW && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 10, color: "#64c8ff", textAlign: "center", padding: "4px 0" }}>
                  Session complete — {gazeData.length.toLocaleString()} gaze points captured
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => {
                    const next = !isPlaying;
                    setIsPlaying(next);
                    if (uploadedVideoRef.current && uploadedVideoUrl) {
                      if (next) uploadedVideoRef.current.play().catch(() => {});
                      else uploadedVideoRef.current.pause();
                    }
                  }} style={{
                    ...btnStyle, flex: 1,
                    background: isPlaying ? "rgba(255,60,60,0.15)" : "rgba(60,255,140,0.15)",
                    color: isPlaying ? "#ff6060" : "#60ff8c",
                    border: `1px solid ${isPlaying ? "rgba(255,60,60,0.3)" : "rgba(60,255,140,0.3)"}`,
                  }}>
                    {isPlaying ? "⏸ Pause" : "▶ Replay"}
                  </button>
                  <button onClick={() => {
                    setCurrentTime(0); setIsPlaying(false);
                    if (uploadedVideoRef.current && uploadedVideoUrl) {
                      uploadedVideoRef.current.pause();
                      uploadedVideoRef.current.currentTime = 0;
                    }
                  }} style={{
                    ...btnStyle, background: "rgba(255,255,255,0.05)", color: "#888",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}>⟲</button>
                </div>
                <div>
                  <input
                    type="range" min={0} max={activeDuration} step={0.1}
                    value={currentTime}
                    onChange={e => {
                      const t = parseFloat(e.target.value);
                      setCurrentTime(t);
                      if (uploadedVideoRef.current && uploadedVideoUrl) uploadedVideoRef.current.currentTime = t;
                    }}
                    style={{ width: "100%", accentColor: "#ff6040", cursor: "pointer" }}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555", marginTop: 2 }}>
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(activeDuration)}</span>
                  </div>
                </div>
                <button onClick={() => { handleNewSession(); setTimeout(() => handleStartSession(), 0); }} style={{
                  ...btnStyle, width: "100%",
                  background: "rgba(100,200,255,0.1)", color: "#64c8ff",
                  border: "1px solid rgba(100,200,255,0.2)", fontSize: 10,
                }}>↻ Restart Session</button>
                {onViewReport && gazeData.length > 0 && (
                  <button onClick={() => onViewReport({
                    gazeData: [...gazeData],
                    duration: activeDuration,
                    videoName: uploadedVideoName,
                    videoFile: uploadedVideoFileRef.current,
                  })} style={{
                    ...btnStyle, width: "100%", padding: "10px 0",
                    background: "linear-gradient(135deg, rgba(255,96,64,0.2), rgba(255,180,40,0.2))",
                    color: "#ff8040",
                    border: "1px solid rgba(255,120,50,0.35)",
                    fontSize: 12, fontWeight: 700,
                  }}>📊 View Report</button>
                )}
              </div>
            )}
          </PanelCard>

          {/* Overlay Settings */}
          <PanelCard title="Overlay Settings">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <SliderControl label="Heatmap Opacity" value={heatmapOpacity} min={0.1} max={1} step={0.05} onChange={setHeatmapOpacity} display={`${Math.round(heatmapOpacity * 100)}%`} />
              <SliderControl label="Time Window" value={windowSize} min={0.5} max={5} step={0.5} onChange={setWindowSize} display={`${windowSize}s`} />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <ToggleBtn active={showHeatmap} onClick={() => setShowHeatmap(!showHeatmap)} label="Heatmap" color="#ff6040" />
              <ToggleBtn active={showGaze} onClick={() => setShowGaze(!showGaze)} label="Gaze Pts" color="#00ffc8" />
              <ToggleBtn active={showGazeCursor} onClick={() => setShowGazeCursor(!showGazeCursor)} label="Live Cursor" color="#ff8040" />
            </div>
          </PanelCard>

          {/* Live Intensity Meter — recording only */}
          {phase === PHASE.RECORDING && (() => {
            const hi = currentIntensity > 70;
            const mid = currentIntensity > 35;
            const meterColor = hi ? "#ff4040" : mid ? "#ffb420" : "#40a0ff";
            const meterLabel = hi ? "HIGH" : mid ? "MODERATE" : "LOW";
            const meterBg = hi ? "rgba(255,64,64,0.08)" : mid ? "rgba(255,180,32,0.08)" : "rgba(64,160,255,0.08)";
            const meterBorder = hi ? "rgba(255,64,64,0.25)" : mid ? "rgba(255,180,32,0.25)" : "rgba(64,160,255,0.25)";
            return (
              <div style={{
                padding: "12px 14px",
                background: meterBg,
                borderRadius: 10,
                border: `1px solid ${meterBorder}`,
                transition: "background 0.4s ease, border-color 0.4s ease",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: "#666", letterSpacing: "1px" }}>LIVE INTENSITY</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: meterColor, boxShadow: `0 0 6px ${meterColor}`, animation: "pulse 1s infinite" }} />
                    <div style={{ fontSize: 10, fontWeight: 700, color: meterColor, letterSpacing: "1px" }}>{meterLabel}</div>
                  </div>
                </div>
                <div style={{ fontSize: 38, fontWeight: 800, color: meterColor, lineHeight: 1, marginBottom: 8, fontVariantNumeric: "tabular-nums", transition: "color 0.4s ease" }}>
                  {currentIntensity}<span style={{ fontSize: 16, fontWeight: 600, opacity: 0.7 }}>%</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                  <div style={{
                    height: "100%", borderRadius: 3,
                    width: `${currentIntensity}%`,
                    background: `linear-gradient(90deg, ${mid ? "#ff6040" : "#40a0ff"}, ${meterColor})`,
                    transition: "width 0.3s ease, background 0.4s ease",
                    boxShadow: `0 0 6px ${meterColor}80`,
                  }} />
                </div>
                {/* Sparkline of recent wall-clock buckets */}
                {phase === PHASE.RECORDING && recordingStartRef.current && (() => {
                  const wallNow = (performance.now() - recordingStartRef.current) / 1000;
                  const BUCKET = 0.5;
                  const NUM_BARS = 10;
                  const bars = [];
                  for (let i = NUM_BARS - 1; i >= 0; i--) {
                    const t0 = wallNow - (i + 1) * BUCKET;
                    const t1 = wallNow - i * BUCKET;
                    if (t0 < 0) { bars.push(null); continue; }
                    const count = liveGazeRef.current.filter(p => p.wallTime !== undefined && p.wallTime >= t0 && p.wallTime < t1).length;
                    bars.push({ intensity: Math.min(100, Math.round((count / (EXPECTED_GAZE_HZ * BUCKET)) * 100)), isCurrent: i === 0 });
                  }
                  const maxVal = Math.max(...bars.filter(Boolean).map(b => b.intensity), 1);
                  return (
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 24, marginTop: 8 }}>
                      {bars.map((b, i) => (
                        <div key={i} style={{
                          flex: 1, borderRadius: 1, alignSelf: "flex-end",
                          height: b ? Math.max(2, (b.intensity / maxVal) * 24) : 2,
                          background: b?.isCurrent ? meterColor : b ? `${meterColor}60` : "rgba(255,255,255,0.05)",
                          transition: "height 0.3s ease",
                        }} />
                      ))}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Analytics (visible in recording & review) */}
          {(phase === PHASE.REVIEW || phase === PHASE.RECORDING) && gazeData.length > 0 && (
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
            </div>
          )}

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
  );
}

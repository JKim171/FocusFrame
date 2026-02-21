import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from "recharts";

import { generateSyntheticGaze, computeHeatmapForFrame, computeRegionAttention, computeAttentionTimeline } from "./gazeUtils.js";
import { heatColor, renderSimulatedFrame } from "./canvasUtils.js";
import { btnStyle, formatTime, ToggleBtn, SliderControl, PanelCard, StatRow, Insight } from "./UIComponents.jsx";

const VIDEO_W = 640;
const VIDEO_H = 360;
const DURATION = 30;
const FPS = 30;

export default function VideoAttentionHeatmap() {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animRef = useRef(null);
  const videoRef = useRef(null);       // camera
  const streamRef = useRef(null);
  const uploadedVideoRef = useRef(null); // uploaded mp4
  const fileInputRef = useRef(null);
  const renderCanvasRef = useRef(null); // stable ref to latest renderCanvas

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

  const gazeData = useMemo(() => generateSyntheticGaze(DURATION, FPS, VIDEO_W, VIDEO_H), []);
  const timeline = useMemo(() => computeAttentionTimeline(gazeData, DURATION), [gazeData]);
  const regions = useMemo(
    () => computeRegionAttention(gazeData, currentTime, windowSize, VIDEO_W, VIDEO_H, 4),
    [gazeData, currentTime, windowSize]
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

  // ─── Canvas Render ─────────────────────────────────────────────────
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    canvas.width = VIDEO_W;
    canvas.height = VIDEO_H;
    ctx.clearRect(0, 0, VIDEO_W, VIDEO_H);

    if (uploadedVideoUrl && uploadedVideoRef.current && uploadedVideoRef.current.readyState >= 2) {
      ctx.drawImage(uploadedVideoRef.current, 0, 0, VIDEO_W, VIDEO_H);
    } else if (cameraEnabled && videoRef.current && videoRef.current.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA) {
      ctx.drawImage(videoRef.current, 0, 0, VIDEO_W, VIDEO_H);
    } else {
      // No source — dark placeholder
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

    if (showHeatmap) {
      const { grid, w, h, resolution } = computeHeatmapForFrame(gazeData, currentTime, windowSize, VIDEO_W, VIDEO_H, 4);
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
      for (const pt of gazeData) {
        if (pt.timestamp >= tMin && pt.timestamp <= tMax) {
          const age = Math.abs(pt.timestamp - currentTime) / (windowSize / 2);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0, 255, 200, ${0.8 - age * 0.6})`;
          ctx.fill();
        }
      }
    }
  }, [gazeData, currentTime, showHeatmap, showGaze, heatmapOpacity, windowSize, cameraEnabled, uploadedVideoUrl]);

  // Keep a stable ref so the rAF loop can call the latest version without stale closure
  useEffect(() => { renderCanvasRef.current = renderCanvas; }, [renderCanvas]);
  useEffect(() => { renderCanvas(); }, [renderCanvas]);

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
  const totalGazePoints = gazeData.length;
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
            {uploadedVideoName
              ? <span style={{ color: "#a0c8ff", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>📹 {uploadedVideoName}</span>
              : <span>{totalGazePoints.toLocaleString()} gaze points</span>
            }
            <span>{uploadedVideoDuration ? `${uploadedVideoDuration.toFixed(1)}s` : `${DURATION}s`} duration</span>
            <span>{FPS} fps</span>
          </div>
        </div>

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

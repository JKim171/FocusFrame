import { useRef, useEffect, useState, useCallback } from "react";

// Gaze data is recorded in a 640×360 space
const VIDEO_W = 640;
const VIDEO_H = 360;

// How many seconds of trail to show behind the cursor
const TRAIL_SEC = 1.2;
// How close a gaze point must be (in video-time) to show as the live cursor
const CURSOR_WINDOW_SEC = 0.08;

/**
 * Renders the uploaded video with a real-time gaze trail overlay.
 * `gazeData` — array of points with { timestamp (video time, s), x, y }
 * `videoFile` — the original File object (null = no video available)
 */
export default function GazeReplayPlayer({ videoFile, gazeData }) {
  const videoRef   = useRef(null);
  const canvasRef  = useRef(null);
  const rafRef     = useRef(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [playing,  setPlaying]  = useState(false);

  // Create a fresh blob URL for this component; revoke on unmount
  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  // Sort once so trail filtering is fast
  const sortedGaze = gazeData
    .filter(p => p.timestamp != null)
    .sort((a, b) => a.timestamp - b.timestamp);

  // ─── Draw loop ───────────────────────────────────────────────────
  const draw = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) { rafRef.current = requestAnimationFrame(draw); return; }

    // Match canvas resolution to VIDEO_W/VIDEO_H — gaze coords map 1:1
    if (canvas.width !== VIDEO_W)  canvas.width  = VIDEO_W;
    if (canvas.height !== VIDEO_H) canvas.height = VIDEO_H;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, VIDEO_W, VIDEO_H);

    const t = video.currentTime;

    // Trail: all points in the past TRAIL_SEC
    const trail = sortedGaze.filter(p => p.timestamp >= t - TRAIL_SEC && p.timestamp <= t + 0.05);

    // Draw trail as diminishing glowing dots
    for (let i = 0; i < trail.length; i++) {
      const age    = Math.max(0, t - trail[i].timestamp);
      const alpha  = (1 - age / TRAIL_SEC) * 0.55;
      const radius = Math.max(2, 7 * (1 - age / TRAIL_SEC));
      ctx.beginPath();
      ctx.arc(trail[i].x, trail[i].y, radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 100, 50, ${alpha})`;
      ctx.fill();
    }

    // Live cursor: mean of gaze within ±CURSOR_WINDOW_SEC of current time
    const recent = sortedGaze.filter(p => Math.abs(p.timestamp - t) < CURSOR_WINDOW_SEC);
    if (recent.length > 0) {
      const cx = recent.reduce((s, p) => s + p.x, 0) / recent.length;
      const cy = recent.reduce((s, p) => s + p.y, 0) / recent.length;

      // Outer glow ring
      const grd = ctx.createRadialGradient(cx, cy, 2, cx, cy, 22);
      grd.addColorStop(0,   "rgba(255, 96, 50, 0.55)");
      grd.addColorStop(0.5, "rgba(255, 96, 50, 0.15)");
      grd.addColorStop(1,   "rgba(255, 96, 50, 0)");
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      // White centre dot
      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
      ctx.fill();

      // Coloured ring
      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 96, 50, 0.95)";
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    rafRef.current = requestAnimationFrame(draw);
  }, [sortedGaze]);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [draw]);

  // ─── Styles ──────────────────────────────────────────────────────
  const container = {
    position: "relative",
    width: "100%",
    aspectRatio: "16 / 9",
    background: "#000",
    borderRadius: 10,
    overflow: "hidden",
  };
  const overlayCanvas = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    // canvas aspect-ratio stretch is correct because canvas resolution = VIDEO_W×VIDEO_H
  };

  if (!videoFile) {
    return (
      <div style={{
        ...container,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(255,255,255,0.02)",
        border: "1px dashed rgba(255,255,255,0.08)",
      }}>
        <div style={{ textAlign: "center", color: "#555", fontSize: 12 }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🎞️</div>
          <div>No video available for this session.</div>
          <div style={{ fontSize: 10, marginTop: 4, color: "#444" }}>
            Video replay is only available immediately after recording.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={container}>
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        style={{ width: "100%", height: "100%", display: "block", objectFit: "contain" }}
      />
      <canvas ref={canvasRef} style={overlayCanvas} />
    </div>
  );
}

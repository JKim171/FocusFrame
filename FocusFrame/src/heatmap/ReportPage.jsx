import { useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, CartesianGrid, PieChart, Pie,
} from "recharts";
import { computeRegionAttention } from "./gazeUtils.js";
import { heatColor } from "./canvasUtils.js";
import { btnStyle, formatTime } from "./UIComponents.jsx";

const VIDEO_W = 640;
const VIDEO_H = 360;

// Same parameters as the live intensity meter
const EXPECTED_GAZE_HZ = 12;
const BUCKET_SEC = 0.5;

export default function ReportPage({ reportData, onBack }) {
  const { gazeData, duration, videoName } = reportData;

  // ─── Derived stats ─────────────────────────────────────────────────
  // Use wallTime (wall-clock elapsed since recording started) if available.
  // This is the same time axis the live intensity meter uses, so numbers match.
  const hasWallTime = gazeData.some(p => p.wallTime !== undefined);

  const timeline = useMemo(() => {
    if (gazeData.length === 0) return [];
    if (hasWallTime) {
      const maxT = Math.max(...gazeData.map(p => p.wallTime ?? 0));
      const buckets = [];
      for (let t = 0; t <= maxT; t += BUCKET_SEC) {
        const count = gazeData.filter(
          p => p.wallTime !== undefined && p.wallTime >= t && p.wallTime < t + BUCKET_SEC
        ).length;
        // Absolute scale: EXPECTED_GAZE_HZ * BUCKET_SEC points = 100%
        const intensity = Math.min(100, Math.round((count / (EXPECTED_GAZE_HZ * BUCKET_SEC)) * 100));
        buckets.push({ time: +t.toFixed(1), intensity });
      }
      return buckets;
    }
    // Fallback: timestamp-based with relative normalisation
    const maxT2 = gazeData.length > 0 ? Math.max(...gazeData.map(p => p.timestamp)) : duration;
    const maxT3 = Math.max(maxT2, duration);
    const buckets2 = [];
    for (let t = 0; t <= maxT3; t += BUCKET_SEC) {
      const count = gazeData.filter(p => p.timestamp >= t && p.timestamp < t + BUCKET_SEC).length;
      const intensity = Math.min(100, Math.round((count / (EXPECTED_GAZE_HZ * BUCKET_SEC)) * 100));
      buckets2.push({ time: +t.toFixed(1), intensity });
    }
    return buckets2;
  }, [gazeData, duration, hasWallTime]);

  // Region map: filter by wallTime full window when available, else full timestamp window
  const regions = useMemo(() => {
    if (gazeData.length === 0) return [];
    if (hasWallTime) {
      // Remap wallTime → timestamp so computeRegionAttention can filter correctly
      const remapped = gazeData.map(p => ({ ...p, timestamp: p.wallTime ?? p.timestamp }));
      const maxW = Math.max(...remapped.map(p => p.timestamp));
      return computeRegionAttention(remapped, maxW / 2, maxW + 1, VIDEO_W, VIDEO_H, 4);
    }
    return computeRegionAttention(gazeData, duration / 2, duration + 1, VIDEO_W, VIDEO_H, 4);
  }, [gazeData, duration, hasWallTime]);

  const totalPoints = gazeData.length;
  const avgIntensity = timeline.length > 0
    ? Math.round(timeline.reduce((s, b) => s + b.intensity, 0) / timeline.length)
    : 0;
  const peakBucket = timeline.reduce((best, b) => b.intensity > best.intensity ? b : best, timeline[0] ?? { time: 0, intensity: 0 });
  const lowBucket  = timeline.reduce((best, b) => b.intensity < best.intensity ? b : best, timeline[0] ?? { time: 0, intensity: 0 });
  const highBuckets = timeline.filter(b => b.intensity > 70).length;
  const highPct = timeline.length > 0 ? Math.round((highBuckets / timeline.length) * 100) : 0;

  // Center bias — inner 2×2 of the 4×4 grid
  const centerCells = regions.filter(r => r.row >= 1 && r.row <= 2 && r.col >= 1 && r.col <= 2);
  const centerPct = centerCells.reduce((s, r) => s + r.attention, 0);

  // Quadrant rollup
  const quadrants = useMemo(() => {
    const q = { "Top-Left": 0, "Top-Right": 0, "Bottom-Left": 0, "Bottom-Right": 0 };
    for (const r of regions) {
      const key = `${r.row < 2 ? "Top" : "Bottom"}-${r.col < 2 ? "Left" : "Right"}`;
      q[key] += r.attention;
    }
    return Object.entries(q).map(([name, value]) => ({ name, value: +value.toFixed(1) }));
  }, [regions]);

  // Average gaze position
  const avgX = totalPoints > 0 ? Math.round(gazeData.reduce((s, p) => s + p.x, 0) / totalPoints) : VIDEO_W / 2;
  const avgY = totalPoints > 0 ? Math.round(gazeData.reduce((s, p) => s + p.y, 0) / totalPoints) : VIDEO_H / 2;

  // Gaze dispersion (standard deviation)
  const stdX = totalPoints > 1
    ? Math.round(Math.sqrt(gazeData.reduce((s, p) => s + (p.x - avgX) ** 2, 0) / (totalPoints - 1)))
    : 0;
  const stdY = totalPoints > 1
    ? Math.round(Math.sqrt(gazeData.reduce((s, p) => s + (p.y - avgY) ** 2, 0) / (totalPoints - 1)))
    : 0;

  // Attention segments — first/last third intensity comparison
  const thirdLen = Math.floor(timeline.length / 3) || 1;
  const firstThirdAvg = timeline.length > 0
    ? Math.round(timeline.slice(0, thirdLen).reduce((s, b) => s + b.intensity, 0) / thirdLen)
    : 0;
  const lastThirdAvg = timeline.length > 0
    ? Math.round(timeline.slice(-thirdLen).reduce((s, b) => s + b.intensity, 0) / thirdLen)
    : 0;
  const attentionTrend = lastThirdAvg > firstThirdAvg + 5 ? "increasing" : lastThirdAvg < firstThirdAvg - 5 ? "decreasing" : "stable";

  // Fixation density estimate (how clustered gaze is — lower = more fixated)
  const dispersionScore = Math.round(Math.sqrt(stdX ** 2 + stdY ** 2));

  // ─── Styles ────────────────────────────────────────────────────────
  const card = {
    background: "rgba(255,255,255,0.03)",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.06)",
    padding: "16px 20px",
  };
  const sectionTitle = {
    fontSize: 11, fontWeight: 700, color: "#888",
    letterSpacing: "1.5px", textTransform: "uppercase", marginBottom: 12,
  };
  const statNum = { fontSize: 28, fontWeight: 800, lineHeight: 1, fontVariantNumeric: "tabular-nums" };
  const statLabel = { fontSize: 10, color: "#666", marginTop: 4 };

  const QUADRANT_COLORS = ["#ff6040", "#ffb420", "#40c0ff", "#60ff8c"];
  const RADIAN = Math.PI / 180;

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0b0f", color: "#e0e0e6",
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
          <button onClick={onBack} style={{
            ...btnStyle,
            background: "rgba(255,255,255,0.05)", color: "#888",
            border: "1px solid rgba(255,255,255,0.1)",
            padding: "6px 14px", fontSize: 12,
          }}>← Back</button>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: "0.5px", color: "#fff" }}>
              SESSION REPORT
            </div>
            <div style={{ fontSize: 10, color: "#666", letterSpacing: "1px" }}>
              {videoName ?? "Untitled"} · {formatTime(duration)} · {totalPoints.toLocaleString()} gaze points
            </div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "#555" }}>
          {new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
        </div>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: 1100, margin: "0 auto" }}>

        {/* ─── Key Metrics Row ─────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
          {[
            { label: "Avg Intensity", value: `${avgIntensity}%`, color: avgIntensity > 60 ? "#60ff8c" : avgIntensity > 30 ? "#ffb420" : "#ff6040" },
            { label: "Peak Attention", value: `${peakBucket.intensity}%`, sub: `@ ${peakBucket.time}s`, color: "#ff6040" },
            { label: "Low Attention", value: `${lowBucket.intensity}%`, sub: `@ ${lowBucket.time}s`, color: "#40c0ff" },
            { label: "High Attn Time", value: `${highPct}%`, sub: `>${" "}70% buckets`, color: "#ffb420" },
            { label: "Gaze Points", value: totalPoints.toLocaleString(), color: "#c080ff" },
          ].map((m, i) => (
            <div key={i} style={{ ...card, textAlign: "center" }}>
              <div style={{ ...statNum, color: m.color }}>{m.value}</div>
              {m.sub && <div style={{ fontSize: 9, color: "#555", marginTop: 2 }}>{m.sub}</div>}
              <div style={statLabel}>{m.label}</div>
            </div>
          ))}
        </div>

        {/* ─── Two-Column Layout ──────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>

          {/* Attention Over Time */}
          <div style={card}>
            <div style={sectionTitle}>Attention Intensity Over Time</div>
            <ResponsiveContainer width="100%" height={180}>
              <AreaChart data={timeline}>
                <defs>
                  <linearGradient id="reportGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff6040" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#ff6040" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                <XAxis
                  dataKey="time" tick={{ fontSize: 9, fill: "#555" }}
                  tickLine={false} axisLine={{ stroke: "#222" }}
                  label={{ value: "Time (s)", position: "insideBottomRight", offset: -4, fontSize: 9, fill: "#555" }}
                />
                <YAxis
                  hide={false} domain={[0, 100]}
                  tick={{ fontSize: 9, fill: "#555" }} tickLine={false} axisLine={false}
                  width={30}
                />
                <Tooltip
                  contentStyle={{ background: "#1a1b22", border: "1px solid #333", borderRadius: 6, fontSize: 11 }}
                  labelStyle={{ color: "#888" }}
                  formatter={(v) => [`${v}%`, "Intensity"]}
                />
                <Area
                  type="monotone" dataKey="intensity"
                  stroke="#ff6040" fill="url(#reportGrad)" strokeWidth={1.5} dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555", marginTop: 6 }}>
              <span>Average: {avgIntensity}%</span>
              <span>Trend: <span style={{
                color: attentionTrend === "increasing" ? "#60ff8c" : attentionTrend === "decreasing" ? "#ff6040" : "#ffb420",
                fontWeight: 700,
              }}>{attentionTrend === "increasing" ? "↑" : attentionTrend === "decreasing" ? "↓" : "→"} {attentionTrend}</span></span>
            </div>
          </div>

          {/* Quadrant Distribution */}
          <div style={card}>
            <div style={sectionTitle}>Quadrant Distribution</div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <ResponsiveContainer width="55%" height={180}>
                <PieChart>
                  <Pie
                    data={quadrants} dataKey="value" nameKey="name"
                    cx="50%" cy="50%"
                    innerRadius={40} outerRadius={70}
                    paddingAngle={3}
                    label={({ name, value, cx, cy, midAngle, outerRadius }) => {
                      const x = cx + (outerRadius + 14) * Math.cos(-midAngle * RADIAN);
                      const y = cy + (outerRadius + 14) * Math.sin(-midAngle * RADIAN);
                      return <text x={x} y={y} fill="#999" fontSize={9} textAnchor="middle" dominantBaseline="central">{value}%</text>;
                    }}
                  >
                    {quadrants.map((_, i) => <Cell key={i} fill={QUADRANT_COLORS[i]} />)}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: "#1a1b22", border: "1px solid #333", borderRadius: 6, fontSize: 11 }}
                    formatter={(v) => [`${v}%`, "Attention"]}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ flex: 1 }}>
                {quadrants.map((q, i) => (
                  <div key={q.name} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "6px 0",
                    borderBottom: i < quadrants.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                  }}>
                    <div style={{ width: 10, height: 10, borderRadius: 3, background: QUADRANT_COLORS[i] }} />
                    <span style={{ fontSize: 11, color: "#aaa", flex: 1 }}>{q.name}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#ccc", fontVariantNumeric: "tabular-nums" }}>{q.value}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ─── Second Row ─────────────────────────────────────────── */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>

          {/* 4×4 Attention Grid */}
          <div style={card}>
            <div style={sectionTitle}>4×4 Attention Grid</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
              {regions
                .sort((a, b) => (a.row * 4 + a.col) - (b.row * 4 + b.col))
                .map(r => {
                  const maxAtt = Math.max(...regions.map(rr => rr.attention), 1);
                  const intensity = r.attention / maxAtt;
                  const [cr, cg, cb] = heatColor(intensity);
                  return (
                    <div key={`${r.row}-${r.col}`} style={{
                      aspectRatio: "16/9", borderRadius: 6,
                      background: `rgba(${cr},${cg},${cb},${0.12 + intensity * 0.55})`,
                      display: "flex", flexDirection: "column",
                      alignItems: "center", justifyContent: "center",
                      fontSize: 11, fontWeight: 700,
                      color: intensity > 0.5 ? "#fff" : "#888",
                      border: `1px solid rgba(${cr},${cg},${cb},0.25)`,
                    }}>
                      <div style={{ fontSize: 8, opacity: 0.6 }}>{r.short}</div>
                      <div>{r.attention.toFixed(1)}%</div>
                    </div>
                  );
                })}
            </div>
            <div style={{ fontSize: 10, color: "#555", marginTop: 8 }}>
              Each cell shows the % of total gaze points that fell in that region across the entire session.
            </div>
          </div>

          {/* Gaze Statistics */}
          <div style={card}>
            <div style={sectionTitle}>Gaze Statistics</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { label: "Avg Gaze X", value: `${avgX}px`, color: "#40c0ff" },
                { label: "Avg Gaze Y", value: `${avgY}px`, color: "#40c0ff" },
                { label: "Std Dev X", value: `${stdX}px`, color: "#c080ff" },
                { label: "Std Dev Y", value: `${stdY}px`, color: "#c080ff" },
                { label: "Center Bias", value: `${centerPct.toFixed(1)}%`, color: centerPct > 40 ? "#60ff8c" : "#ffb420" },
                { label: "Dispersion", value: `${dispersionScore}px`, color: dispersionScore < 100 ? "#60ff8c" : "#ff6040" },
              ].map((s, i) => (
                <div key={i} style={{
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.03)",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.04)",
                }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: s.color, fontVariantNumeric: "tabular-nums" }}>{s.value}</div>
                  <div style={{ fontSize: 9, color: "#666", marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Gaze centroid indicator */}
            <div style={{ marginTop: 12, position: "relative" }}>
              <div style={{ fontSize: 9, color: "#555", marginBottom: 4 }}>GAZE CENTROID</div>
              <div style={{
                position: "relative", width: "100%", aspectRatio: "16/9",
                background: "rgba(255,255,255,0.02)", borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.04)", overflow: "hidden",
              }}>
                {/* Grid lines */}
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.04)" }} />
                <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.04)" }} />
                {/* Centroid dot */}
                <div style={{
                  position: "absolute",
                  left: `${(avgX / VIDEO_W) * 100}%`,
                  top: `${(avgY / VIDEO_H) * 100}%`,
                  transform: "translate(-50%, -50%)",
                  width: 14, height: 14, borderRadius: "50%",
                  background: "rgba(255,96,64,0.9)",
                  boxShadow: "0 0 12px rgba(255,96,64,0.6), 0 0 24px rgba(255,96,64,0.3)",
                  border: "2px solid rgba(255,255,255,0.3)",
                }} />
                {/* Dispersion ring */}
                <div style={{
                  position: "absolute",
                  left: `${(avgX / VIDEO_W) * 100}%`,
                  top: `${(avgY / VIDEO_H) * 100}%`,
                  transform: "translate(-50%, -50%)",
                  width: `${Math.min(80, (dispersionScore / VIDEO_W) * 200)}%`,
                  aspectRatio: "1",
                  borderRadius: "50%",
                  border: "1px dashed rgba(255,96,64,0.3)",
                }} />
              </div>
            </div>
          </div>
        </div>

        {/* ─── Insights Row ───────────────────────────────────────── */}
        <div style={{ ...card, marginBottom: 20 }}>
          <div style={sectionTitle}>Session Insights</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>
            {/* Attention trend */}
            <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.02)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: attentionTrend === "increasing" ? "#60ff8c" : attentionTrend === "decreasing" ? "#ff6040" : "#ffb420", marginBottom: 4 }}>
                {attentionTrend === "increasing" ? "📈 Attention Increased" : attentionTrend === "decreasing" ? "📉 Attention Declined" : "→ Steady Attention"}
              </div>
              <div style={{ fontSize: 10, color: "#777", lineHeight: 1.5 }}>
                First third avg: {firstThirdAvg}% → Last third avg: {lastThirdAvg}%.
                {attentionTrend === "decreasing" && " Consider shortening the video or adding hooks later in the timeline."}
                {attentionTrend === "increasing" && " Viewer engagement grew — content successfully builds interest."}
                {attentionTrend === "stable" && " Consistent engagement throughout the session."}
              </div>
            </div>

            {/* Center bias */}
            <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.02)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: centerPct > 40 ? "#60ff8c" : "#ffb420", marginBottom: 4 }}>
                {centerPct > 40 ? "◎ Strong Center Focus" : "◎ Distributed Gaze"}
              </div>
              <div style={{ fontSize: 10, color: "#777", lineHeight: 1.5 }}>
                {centerPct.toFixed(1)}% of gaze concentrated in the center 4 cells.
                {centerPct > 60 && " Very high center bias — peripheral content may be ignored."}
                {centerPct <= 40 && " Viewers explored the full frame — consider if key content is easily found."}
              </div>
            </div>

            {/* Top region + neglected */}
            <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.02)", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#ff6040", marginBottom: 4 }}>
                🎯 Hotspot: {regions[0]?.label ?? "—"}
              </div>
              <div style={{ fontSize: 10, color: "#777", lineHeight: 1.5 }}>
                Top zone received {regions[0]?.attention.toFixed(1)}% of all gaze.
                {regions.length > 0 && regions[regions.length - 1].attention < 1.5
                  ? ` ${regions[regions.length - 1].label} received only ${regions[regions.length - 1].attention.toFixed(1)}% — effectively a blind spot.`
                  : " Attention was reasonably distributed across zones."}
              </div>
            </div>
          </div>
        </div>

        {/* Top Attention Regions Bar Chart */}
        <div style={{ ...card, marginBottom: 20 }}>
          <div style={sectionTitle}>Top Attention Regions</div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={regions.slice(0, 8)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
              <XAxis type="number" domain={[0, "dataMax"]} tick={{ fontSize: 9, fill: "#555" }} unit="%" />
              <YAxis type="category" dataKey="label" tick={{ fontSize: 9, fill: "#888" }} width={130} />
              <Tooltip
                contentStyle={{ background: "#1a1b22", border: "1px solid #333", borderRadius: 6, fontSize: 11 }}
                formatter={(v) => [`${v.toFixed(1)}%`, "Attention"]}
              />
              <Bar dataKey="attention" radius={[0, 4, 4, 0]}>
                {regions.slice(0, 8).map((_, i) => {
                  const t = i / 7;
                  const [r, g, b] = heatColor(1 - t);
                  return <Cell key={i} fill={`rgb(${r},${g},${b})`} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Footer */}
        <div style={{
          textAlign: "center", padding: "20px 0 40px",
          fontSize: 10, color: "#444",
          borderTop: "1px solid rgba(255,255,255,0.04)",
        }}>
          Generated by FocusFrame · {new Date().toLocaleString()}
        </div>
      </div>
    </div>
  );
}

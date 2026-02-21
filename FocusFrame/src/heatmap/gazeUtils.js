// ─── Synthetic Gaze Generator ────────────────────────────────────────
export function generateSyntheticGaze(durationSec, fps = 30, width = 640, height = 360) {
  const data = [];
  const totalFrames = Math.floor(durationSec * fps);
  const cx = width / 2, cy = height / 2;

  const hotspots = [
    { x: cx, y: cy, weight: 0.3, label: "center" },
    { x: cx * 0.45, y: cy * 0.55, weight: 0.25, label: "face-left" },
    { x: cx * 1.5, y: cy * 0.6, weight: 0.2, label: "face-right" },
    { x: cx * 1.6, y: cy * 1.6, weight: 0.15, label: "cta-bottom-right" },
    { x: cx * 0.3, y: cy * 1.7, weight: 0.1, label: "text-bottom-left" },
  ];

  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps;
    const gazeCount = 3 + Math.floor(Math.random() * 5);

    for (let g = 0; g < gazeCount; g++) {
      const phase = f / totalFrames;
      let r = Math.random();
      let spot = hotspots[0];
      let cumWeight = 0;

      for (const hs of hotspots) {
        const timeAdjust = hs.label === "center"
          ? hs.weight * (1 - phase * 0.5)
          : hs.weight * (0.7 + phase * 0.6);
        cumWeight += timeAdjust;
        if (r * hotspots.reduce((s, h) => s + h.weight, 0) <= cumWeight) {
          spot = hs;
          break;
        }
      }

      const scatter = 40 + Math.random() * 60;
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.abs(gaussRandom()) * scatter;
      const x = Math.max(0, Math.min(width - 1, spot.x + Math.cos(angle) * dist));
      const y = Math.max(0, Math.min(height - 1, spot.y + Math.sin(angle) * dist));

      data.push({ timestamp: t, x: Math.round(x), y: Math.round(y), frame: f });
    }
  }
  return data;
}

function gaussRandom() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ─── Heatmap Processing ──────────────────────────────────────────────
export function computeHeatmapForFrame(gazeData, currentTime, windowSec, width, height, resolution = 4) {
  const w = Math.ceil(width / resolution);
  const h = Math.ceil(height / resolution);
  const grid = new Float32Array(w * h);

  const tMin = currentTime - windowSec / 2;
  const tMax = currentTime + windowSec / 2;

  let count = 0;
  for (const pt of gazeData) {
    if (pt.timestamp >= tMin && pt.timestamp <= tMax) {
      const gx = Math.floor(pt.x / resolution);
      const gy = Math.floor(pt.y / resolution);
      if (gx >= 0 && gx < w && gy >= 0 && gy < h) {
        const radius = 4;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = gx + dx, ny = gy + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              const d2 = dx * dx + dy * dy;
              const val = Math.exp(-d2 / (2 * (radius / 2) ** 2));
              grid[ny * w + nx] += val;
            }
          }
        }
        count++;
      }
    }
  }

  let max = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
  if (max > 0) for (let i = 0; i < grid.length; i++) grid[i] /= max;

  return { grid, w, h, resolution, count };
}

export function computeRegionAttention(gazeData, currentTime, windowSec, width, height, gridSize = 4) {
  const cellW = width / gridSize;
  const cellH = height / gridSize;
  const counts = new Array(gridSize * gridSize).fill(0);
  const tMin = currentTime - windowSec / 2;
  const tMax = currentTime + windowSec / 2;
  let total = 0;

  for (const pt of gazeData) {
    if (pt.timestamp >= tMin && pt.timestamp <= tMax) {
      const gx = Math.min(gridSize - 1, Math.floor(pt.x / cellW));
      const gy = Math.min(gridSize - 1, Math.floor(pt.y / cellH));
      counts[gy * gridSize + gx]++;
      total++;
    }
  }

  const labels = [
    "top-left", "top-center-left", "top-center-right", "top-right",
    "mid-upper-left", "mid-upper-center-left", "mid-upper-center-right", "mid-upper-right",
    "mid-lower-left", "mid-lower-center-left", "mid-lower-center-right", "mid-lower-right",
    "bottom-left", "bottom-center-left", "bottom-center-right", "bottom-right",
  ];
  const shortLabels = ["TL", "TCL", "TCR", "TR", "MUL", "MUC", "MUR", "MR", "ML", "MC", "MCR", "MLR", "BL", "BCL", "BCR", "BR"];

  return counts.map((c, i) => ({
    label: labels[i] || `region-${i}`,
    short: shortLabels[i] || `R${i}`,
    attention: total > 0 ? (c / total) * 100 : 0,
    row: Math.floor(i / gridSize),
    col: i % gridSize,
  })).sort((a, b) => b.attention - a.attention);
}

export function computeAttentionTimeline(gazeData, duration, bucketSec = 0.5) {
  const buckets = [];
  for (let t = 0; t < duration; t += bucketSec) {
    let count = 0;
    for (const pt of gazeData) {
      if (pt.timestamp >= t && pt.timestamp < t + bucketSec) count++;
    }
    buckets.push({ time: Math.round(t * 10) / 10, intensity: count });
  }
  const max = Math.max(...buckets.map(b => b.intensity), 1);
  return buckets.map(b => ({ ...b, intensity: Math.round((b.intensity / max) * 100) }));
}

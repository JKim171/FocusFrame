// ─── Color Maps ──────────────────────────────────────────────────────
export function heatColor(value) {
  // blue → cyan → green → yellow → red
  const stops = [
    [0, 0, 0, 0],
    [0.15, 10, 30, 180],
    [0.35, 20, 160, 200],
    [0.5, 40, 200, 80],
    [0.7, 230, 220, 30],
    [0.85, 250, 130, 10],
    [1.0, 240, 30, 20],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const t = (value - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return [
        Math.round(stops[i - 1][1] + t * (stops[i][1] - stops[i - 1][1])),
        Math.round(stops[i - 1][2] + t * (stops[i][2] - stops[i - 1][2])),
        Math.round(stops[i - 1][3] + t * (stops[i][3] - stops[i - 1][3])),
      ];
    }
  }
  return [240, 30, 20];
}

// ─── Simulated Video Frame ───────────────────────────────────────────
export function renderSimulatedFrame(ctx, w, h, time, duration) {
  const phase = time / duration;
  const grd = ctx.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, `hsl(${200 + phase * 40}, 30%, 12%)`);
  grd.addColorStop(1, `hsl(${220 + phase * 30}, 25%, 8%)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = "rgba(255,255,255,0.03)";
  ctx.lineWidth = 0.5;
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // Simulated face - left
  ctx.fillStyle = "rgba(180,140,120,0.15)";
  ctx.beginPath();
  ctx.ellipse(w * 0.22, h * 0.3, 35, 45, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = "10px monospace";
  ctx.fillText("SPEAKER A", w * 0.14, h * 0.5);

  // Simulated face - right
  ctx.fillStyle = "rgba(180,140,120,0.12)";
  ctx.beginPath();
  ctx.ellipse(w * 0.75, h * 0.32, 30, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillText("SPEAKER B", w * 0.67, h * 0.52);

  // Moving element
  const mx = w * 0.3 + Math.sin(time * 0.5) * w * 0.2;
  const my = h * 0.7 + Math.cos(time * 0.3) * 20;
  ctx.fillStyle = "rgba(255,100,60,0.08)";
  ctx.fillRect(mx - 40, my - 12, 80, 24);
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.font = "bold 9px monospace";
  ctx.fillText("BUY NOW →", mx - 28, my + 3);

  // CTA box bottom right
  ctx.fillStyle = "rgba(60,180,255,0.06)";
  ctx.fillRect(w * 0.72, h * 0.78, w * 0.22, h * 0.14);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = "bold 10px monospace";
  ctx.fillText("SUBSCRIBE", w * 0.76, h * 0.87);

  // Title bar
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, 0, w, 28);
  ctx.fillStyle = "rgba(255,255,255,0.1)";
  ctx.font = "bold 11px monospace";
  ctx.fillText("SAMPLE AD — Product Launch 2026", 12, 18);

  // Timestamp
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.font = "9px monospace";
  ctx.fillText(`FRAME ${Math.floor(time * 30)}`, w - 85, h - 10);
}

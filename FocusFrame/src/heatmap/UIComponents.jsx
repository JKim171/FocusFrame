// ─── Shared Styles ───────────────────────────────────────────────────
export const btnStyle = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "none",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
  fontFamily: "inherit",
  letterSpacing: "0.3px",
  transition: "all 0.15s ease",
};

// ─── Utility ─────────────────────────────────────────────────────────
export function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// ─── UI Components ───────────────────────────────────────────────────
export function ToggleBtn({ active, onClick, label, color }) {
  return (
    <button onClick={onClick} style={{
      ...btnStyle,
      background: active ? `${color}18` : "rgba(255,255,255,0.03)",
      color: active ? color : "#555",
      border: `1px solid ${active ? `${color}40` : "rgba(255,255,255,0.06)"}`,
      fontSize: 10,
    }}>
      {active ? "●" : "○"} {label}
    </button>
  );
}

export function SliderControl({ label, value, min, max, step, onChange, display }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#666", marginBottom: 3 }}>
        <span>{label}</span>
        <span style={{ color: "#999", fontVariantNumeric: "tabular-nums" }}>{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "#ff6040" }}
      />
    </div>
  );
}

export function PanelCard({ title, children }) {
  return (
    <div style={{
      padding: "12px 14px",
      background: "rgba(255,255,255,0.03)",
      borderRadius: 10,
      border: "1px solid rgba(255,255,255,0.06)",
    }}>
      {title && (
        <div style={{
          fontSize: 10, fontWeight: 600, color: "#666",
          letterSpacing: "0.8px", textTransform: "uppercase", marginBottom: 8,
        }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatRow({ label, value }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: "5px 0", borderBottom: "1px solid rgba(255,255,255,0.03)",
      fontSize: 11,
    }}>
      <span style={{ color: "#666" }}>{label}</span>
      <span style={{ color: "#ccc", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

export function Insight({ icon, color, title, text }) {
  return (
    <div style={{ padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
        <span>{icon}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color }}>{title}</span>
      </div>
      <div style={{ fontSize: 10, color: "#777", lineHeight: 1.5, paddingLeft: 22 }}>{text}</div>
    </div>
  );
}

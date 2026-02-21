// ─── Session Store ───────────────────────────────────────────────────
// Manages multi-user viewing sessions with localStorage persistence
// and JSON export/import.
//
// Session shape:
//   { id, createdAt, sourceVideoName, duration, gazePoints[] }
//
// gazePoint shape (same as existing gaze data):
//   { timestamp, wallTime, x, y, frame }

const STORAGE_KEY = "focusframe_sessions";

// ─── Helpers ─────────────────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
}

// ─── CRUD ────────────────────────────────────────────────────────────

/** Load all sessions from localStorage. */
export function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Persist sessions array to localStorage. */
export function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.warn("[FocusFrame] Could not save sessions:", e);
  }
}

/** Create & persist a new session from a completed recording. Returns the session. */
export function createSession({ sourceVideoName, duration, gazePoints }) {
  const session = {
    id: uuid(),
    createdAt: new Date().toISOString(),
    sourceVideoName: sourceVideoName ?? "Untitled",
    duration: duration ?? 0,
    gazePoints: gazePoints ?? [],
  };
  const sessions = loadSessions();
  sessions.push(session);
  saveSessions(sessions);
  return session;
}

/** Delete a session by id. */
export function deleteSession(id) {
  const sessions = loadSessions().filter(s => s.id !== id);
  saveSessions(sessions);
  return sessions;
}

/** Delete all sessions. */
export function clearAllSessions() {
  saveSessions([]);
}

// ─── Aggregation ─────────────────────────────────────────────────────

/**
 * Merge multiple sessions into a single reportData-like object.
 * gazePoints are concatenated (each viewer's points kept as-is).
 * Duration is the max across sessions.
 */
export function aggregateSessions(sessions) {
  if (!sessions || sessions.length === 0) {
    return { gazeData: [], duration: 0, videoName: "No sessions", sessionCount: 0 };
  }

  const allGaze = [];
  let maxDuration = 0;

  for (const s of sessions) {
    for (const pt of s.gazePoints) {
      allGaze.push(pt);
    }
    if (s.duration > maxDuration) maxDuration = s.duration;
  }

  // Collect unique video names
  const names = [...new Set(sessions.map(s => s.sourceVideoName))];
  const videoName = names.length === 1 ? names[0] : `${names[0]} +${names.length - 1} more`;

  return {
    gazeData: allGaze,
    duration: maxDuration,
    videoName,
    sessionCount: sessions.length,
  };
}

// ─── Export / Import ─────────────────────────────────────────────────

/** Export all sessions as a JSON blob download. */
export function exportSessionsJSON() {
  const sessions = loadSessions();
  const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `focusframe-sessions-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Import sessions from a JSON file. Merges with existing sessions
 * (deduplicates by id). Returns the updated sessions array.
 */
export function importSessionsJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error("Invalid format: expected an array of sessions");
        // Validate shape
        for (const s of imported) {
          if (!s.id || !Array.isArray(s.gazePoints)) {
            throw new Error("Invalid session object: missing id or gazePoints");
          }
        }
        // Merge with existing, deduplicate by id
        const existing = loadSessions();
        const existingIds = new Set(existing.map(s => s.id));
        const merged = [...existing];
        let added = 0;
        for (const s of imported) {
          if (!existingIds.has(s.id)) {
            merged.push(s);
            added++;
          }
        }
        saveSessions(merged);
        resolve({ sessions: merged, added, total: merged.length });
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}

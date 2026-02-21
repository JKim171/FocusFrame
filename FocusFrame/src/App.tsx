import { useState, useCallback, useEffect } from 'react';
// @ts-ignore
import VideoAttentionHeatmap from './heatmap/VideoAttentionHeatmap.jsx';
// @ts-ignore
import ReportPage from './heatmap/ReportPage.jsx';
// @ts-ignore
import { loadSessions, createSession } from './heatmap/sessionStore.js';

function App() {
  const [reportData, setReportData] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);

  // Hydrate sessions from localStorage on mount
  useEffect(() => {
    setSessions(loadSessions());
  }, []);

  // Refresh sessions list (called after import, delete, etc.)
  const refreshSessions = useCallback(() => {
    setSessions(loadSessions());
  }, []);

  // Called by VideoAttentionHeatmap when "View Report" is clicked —
  // auto-saves the session then opens the report
  const handleViewReport = useCallback((data: any) => {
    const session = createSession({
      sourceVideoName: data.videoName,
      duration: data.duration,
      gazePoints: data.gazeData,
    });
    const updated = loadSessions();
    setSessions(updated);
    // Open report pre-selected to this new session
    setReportData({ ...data, activeSessionId: session.id });
  }, []);

  if (reportData) {
    return (
      <ReportPage
        reportData={reportData}
        sessions={sessions}
        onRefreshSessions={refreshSessions}
        onBack={() => setReportData(null)}
      />
    );
  }

  return (
    <div>
      <VideoAttentionHeatmap onViewReport={handleViewReport} />
    </div>
  );
}

export default App;

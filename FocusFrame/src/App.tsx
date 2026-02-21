import { useState } from 'react';
// @ts-ignore
import VideoAttentionHeatmap from './heatmap/VideoAttentionHeatmap.jsx';
// @ts-ignore
import ReportPage from './heatmap/ReportPage.jsx';

function App() {
  const [reportData, setReportData] = useState(null);

  if (reportData) {
    return <ReportPage reportData={reportData} onBack={() => setReportData(null)} />;
  }

  return (
    <div>
      <VideoAttentionHeatmap onViewReport={(data: any) => setReportData(data)} />
    </div>
  );
}

export default App;

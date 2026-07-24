import { Routes, Route } from 'react-router-dom';
import { useAuth } from './hooks/useAuth.ts';
import { Header } from './components/Header.tsx';
import { Login } from './components/Login.tsx';
import { ProjectList } from './routes/ProjectList.tsx';
import { BundleView } from './routes/BundleView.tsx';
import { Settings } from './routes/Settings.tsx';

export default function App() {
  const { user, loading, login, logout } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p className="loading-text">Loading Notebook…</p>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={login} />;
  }

  return (
    <div className="app-shell">
      <Header user={user} onLogout={logout} />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<ProjectList user={user} />} />
          <Route path="/bundle/:bundleId" element={<BundleView />} />
          <Route path="/bundle/:bundleId/file/*" element={<BundleView />} />
          <Route path="/settings" element={<Settings user={user} />} />
        </Routes>
      </main>
    </div>
  );
}

import type { ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppLayout } from './components/AppLayout';
import { Logo } from './components/Logo';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { PayPage } from './pages/PayPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status !== 'authenticated') {
    return <Navigate to="/connexion" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-ink-950 px-4 text-center">
      <Logo className="text-[34px] text-white" />
      <div>
        <p className="text-6xl font-bold text-white">404</p>
        <p className="mt-2 text-muted">Cette page n&rsquo;existe pas.</p>
      </div>
      <Link
        to="/"
        className="inline-flex h-10 items-center rounded-full bg-brand-500 px-5 text-sm font-semibold text-white transition hover:bg-brand-600"
      >
        Retour à l&rsquo;accueil
      </Link>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/connexion" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="payer" element={<PayPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

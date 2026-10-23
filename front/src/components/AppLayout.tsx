import { NavLink, Outlet } from 'react-router-dom';
import { useAuth, useCurrentUser } from '../auth/AuthContext';
import { Logo } from './Logo';
import { ServiceBanner } from './ServiceBanner';
import { Avatar } from './ui';
import { Home, LogOut, Send } from './icons';
import { displayName } from '../lib/format';

const NAV_ITEMS = [
  { to: '/', label: 'Accueil', icon: <Home />, end: true },
  { to: '/payer', label: 'Payer', icon: <Send />, end: false },
];

export function AppLayout() {
  const user = useCurrentUser();
  const { logout } = useAuth();

  return (
    <div className="min-h-screen bg-ink-950 bg-[radial-gradient(1200px_500px_at_50%_-200px,rgba(123,77,255,0.16),transparent)]">
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-ink-950/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <NavLink to="/" className="text-[26px] text-white" aria-label="EPSI Pay, accueil">
            <Logo />
          </NavLink>

          <nav className="ml-4 hidden items-center gap-1 sm:flex" aria-label="Navigation principale">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-full px-4 py-2 text-sm font-medium transition ${
                    isActive ? 'bg-white/[0.08] text-white' : 'text-muted hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right md:block">
              <p className="text-sm font-semibold leading-tight text-white">{displayName(user)}</p>
              <p className="text-xs leading-tight text-muted">{user.email}</p>
            </div>
            <Avatar person={user} />
            <button
              type="button"
              onClick={() => void logout()}
              className="inline-flex h-10 w-10 items-center justify-center rounded-full text-lg text-muted transition hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/30"
              title="Se déconnecter"
              aria-label="Se déconnecter"
            >
              <LogOut />
            </button>
          </div>
        </div>
        <ServiceBanner />
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-28 pt-8 sm:px-6 sm:pb-16">
        <Outlet />
      </main>

      {/* Navigation basse sur mobile */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-white/[0.06] bg-ink-900/95 backdrop-blur-xl sm:hidden"
        aria-label="Navigation mobile"
      >
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 py-3 text-xs font-medium ${isActive ? 'text-brand-300' : 'text-muted'}`
            }
          >
            <span className="text-xl">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

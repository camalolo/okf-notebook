import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { User } from '../types.ts';

interface HeaderProps {
  user: User;
  onLogout: () => void;
}

export function Header({ user, onLogout }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  const handleSignOut = () => {
    setMenuOpen(false);
    void onLogout();
  };

  return (
    <header className="header">
      <Link to="/" className="header-brand">
        <span className="header-logo" aria-hidden="true">📓</span>
        <span className="header-title">Notebook</span>
      </Link>

      <div className="header-actions">
        {user.role === 'full' && (
          <Link
            to="/settings"
            className="header-icon-btn"
            title="Settings"
            aria-label="Settings"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14 12.94a7.49 7.49 0 0 0 .05-.94 7.49 7.49 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.04 8.84a.5.5 0 0 0 .12.64L4.19 11.06c-.03.31-.05.62-.05.94s.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.42.33.68.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.26.11.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"
              />
            </svg>
          </Link>
        )}

        <div className="user-menu" ref={menuRef}>
          <button
            className="user-trigger"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            {user.picture ? (
              <img
                src={user.picture}
                alt=""
                className="user-avatar"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="user-avatar user-avatar-fallback">
                {user.name.charAt(0).toUpperCase()}
              </span>
            )}
            <span className="user-name">{user.name}</span>
            <span className={`role-badge role-${user.role}`}>{user.role}</span>
          </button>

          {menuOpen && (
            <div className="user-dropdown" role="menu">
              <div className="user-dropdown-info">
                <span className="user-dropdown-name">{user.name}</span>
                <span className="user-dropdown-email">{user.email}</span>
                <span className={`role-badge role-${user.role}`}>
                  {user.role === 'full' ? 'Full access' : 'Read-only'}
                </span>
              </div>
              <button className="user-dropdown-item" onClick={handleSignOut} role="menuitem">
                <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z"
                  />
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

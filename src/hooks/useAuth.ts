import { useCallback, useEffect, useState } from 'react';
import type { User } from '../types.ts';
import { getCurrentUser, loginWithGoogle, logout as apiLogout } from '../services/auth.ts';

export interface AuthState {
  user: User | null;
  loading: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getCurrentUser()
      .then((u) => {
        if (active) setUser(u);
      })
      .catch(() => {
        // Network/unknown error: stay logged out but stop loading.
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(() => {
    // Preserve the current location (e.g. a shared bundle/file deep link)
    // across the OAuth round-trip; the server redirects back to it.
    const here = window.location.pathname + window.location.search + window.location.hash;
    loginWithGoogle(here === '/' ? undefined : here);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  return { user, loading, login, logout };
}

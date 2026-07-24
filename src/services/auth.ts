import type { User } from '../types.ts';

const AUTH_BASE = '/api/notebook/auth';

/** Returns the logged-in user, or `null` when there is no session (401). */
export async function getCurrentUser(): Promise<User | null> {
  const res = await fetch(`${AUTH_BASE}/me`, {
    credentials: 'same-origin',
  });
  if (res.status === 401) return null;
  if (!res.ok) {
    throw new Error(`Auth check failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as User;
}

export function loginWithGoogle(): void {
  window.location.href = `${AUTH_BASE}/google`;
}

export async function logout(): Promise<void> {
  await fetch(`${AUTH_BASE}/logout`, {
    method: 'POST',
    credentials: 'same-origin',
  });
}

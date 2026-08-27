import { useCallback, useEffect, useState } from 'react';

/**
 * PWA install detection.
 *
 * - Android/Chromium browsers fire `beforeinstallprompt`; the event is
 *   captured as early as possible by a snippet in index.html (it can fire
 *   before React mounts) and stashed on `window.__notebookInstallPrompt`.
 * - iOS Safari never fires it: installing means Share → "Add to Home
 *   Screen", so there we show step-by-step instructions instead.
 * - Once installed (display-mode: standalone), the prompt never shows again.
 * - Dismissals are remembered for REASK_AFTER_MS (2 weeks).
 */

export type InstallPlatform = 'android' | 'ios';

export const SHOW_INSTALL_PROMPT_EVENT = 'notebook:show-install-prompt';
const DISMISS_STORAGE_KEY = 'nb-install-dismissed-at';
const REASK_AFTER_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    __notebookInstallPrompt?: BeforeInstallPromptEvent | null;
  }
}

export function detectInstallPlatform(): InstallPlatform | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  // iPadOS 13+ pretends to be desktop Safari — detect via touch points.
  const appleLike =
    /iphone|ipod/i.test(ua) ||
    /ipad/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && /macintosh/i.test(ua));
  return appleLike ? 'ios' : null;
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari (pre-16.4 quirk)
    (navigator as { standalone?: boolean }).standalone === true
  );
}

function isRecentlyDismissed(): boolean {
  try {
    const dismissedAt = Number(localStorage.getItem(DISMISS_STORAGE_KEY));
    return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < REASK_AFTER_MS;
  } catch {
    return false;
  }
}

export interface InstallPromptState {
  /** Whether the full-screen install prompt should be shown right now. */
  visible: boolean;
  /** Install path available on this device. */
  platform: InstallPlatform | null;
  /** True when the browser gave us a native install prompt (Android/Chromium). */
  canNativeInstall: boolean;
  /** Opens the prompt (from the header menu). */
  show: () => void;
  /** "Not now" — hides and remembers the dismissal. */
  dismiss: () => void;
  /** Triggers the browser's native install flow. No-op without one. */
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): InstallPromptState {
  const platform = detectInstallPlatform();
  const [standalone, setStandalone] = useState(isStandaloneDisplay);
  const [nativeEvent, setNativeEvent] = useState<BeforeInstallPromptEvent | null>(
    () => window.__notebookInstallPrompt ?? null,
  );
  const [forceVisible, setForceVisible] = useState(false);

  useEffect(() => {
    const onBeforeInstallPrompt = (e: Event) => {
      setNativeEvent(e as BeforeInstallPromptEvent);
    };
    // The event may have fired before React mounted — it was captured by the
    // snippet in index.html and picked up by the useState initializer above.
    // Drop the stash so a later remount can't reuse a consumed event.
    window.__notebookInstallPrompt = null;

    const onInstalled = () => {
      setStandalone(true);
      setForceVisible(false);
    };
    const onShow = () => setForceVisible(true);
    const onDisplayChange = (e: MediaQueryListEvent) => setStandalone(e.matches);
    const displayMedia = window.matchMedia('(display-mode: standalone)');

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener(SHOW_INSTALL_PROMPT_EVENT, onShow);
    displayMedia.addEventListener('change', onDisplayChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener(SHOW_INSTALL_PROMPT_EVENT, onShow);
      displayMedia.removeEventListener('change', onDisplayChange);
    };
  }, []);

  // Auto-show once, shortly after mount, when it makes sense:
  // mobile device, not installed yet, not recently dismissed, and either a
  // native prompt is available (Android) or we're on iOS (instructions).
  // Desktop browsers never get the full-screen prompt on their own.
  useEffect(() => {
    if (!platform || standalone || isRecentlyDismissed()) return;
    if (platform === 'android' && !nativeEvent) return;
    const timer = window.setTimeout(() => setForceVisible(true), 1200);
    return () => window.clearTimeout(timer);
  }, [platform, standalone, nativeEvent]);

  const dismiss = useCallback(() => {
    setForceVisible(false);
    try {
      localStorage.setItem(DISMISS_STORAGE_KEY, String(Date.now()));
    } catch {
      // private mode — just hide for this session
    }
  }, []);

  const install = useCallback(async () => {
    if (!nativeEvent) return 'unavailable' as const;
    await nativeEvent.prompt();
    const { outcome } = await nativeEvent.userChoice;
    if (outcome === 'accepted') {
      setStandalone(true);
      setForceVisible(false);
    }
    setNativeEvent(null);
    return outcome;
  }, [nativeEvent]);

  const visible = forceVisible && !!platform && !standalone;

  return { visible, platform, canNativeInstall: !!nativeEvent, show: () => setForceVisible(true), dismiss, install };
}

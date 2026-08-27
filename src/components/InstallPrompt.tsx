import { useEffect, useRef } from 'react';
import { useInstallPrompt } from '../hooks/useInstallPrompt.ts';

/**
 * Full-screen "Install on your phone?" prompt.
 *
 * Shown automatically (once, with a grace period, on mobile devices that
 * haven't dismissed it recently) or on demand via the header menu, which
 * dispatches SHOW_INSTALL_PROMPT_EVENT.
 *
 * - Android/Chromium with a native install signal → big "Install" button
 *   that triggers the browser's own install dialog.
 * - iOS Safari (and Android browsers without the signal) → step-by-step
 *   "Add to Home Screen" instructions instead.
 */
export function InstallPrompt() {
  const { visible, platform, canNativeInstall, dismiss, install } = useInstallPrompt();
  const primaryBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!visible) return;
    primaryBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, dismiss]);

  if (!visible) return null;

  const handleInstall = () => {
    void install();
  };

  return (
    <div className="install-overlay" role="dialog" aria-modal="true" aria-labelledby="install-title">
      <div className="install-card">
        <img className="install-icon" src="/icons/icon-192.png" alt="" width="84" height="84" />
        <h2 className="install-title" id="install-title">
          Install on your phone?
        </h2>
        <p className="install-subtitle">
          Add Notebook to your home screen — it runs full-screen, like a native app.
        </p>

        {canNativeInstall ? (
          <div className="install-actions">
            <button ref={primaryBtnRef} className="btn btn-primary install-btn" onClick={handleInstall}>
              Install
            </button>
            <button className="btn btn-ghost install-btn" onClick={dismiss}>
              Not now
            </button>
          </div>
        ) : (
          <>
            <ol className="install-steps">
              {platform === 'ios' ? (
                <>
                  <li className="install-step">
                    <span className="install-step-icon" aria-hidden="true">
                      <ShareIcon />
                    </span>
                    <span>
                      Tap the <strong>Share</strong> button in Safari&apos;s toolbar
                    </span>
                  </li>
                  <li className="install-step">
                    <span className="install-step-icon" aria-hidden="true">
                      <PlusIcon />
                    </span>
                    <span>
                      Scroll down and tap <strong>Add to Home Screen</strong>
                    </span>
                  </li>
                  <li className="install-step">
                    <span className="install-step-icon" aria-hidden="true">
                      <CheckIcon />
                    </span>
                    <span>
                      Tap <strong>Add</strong> — Notebook lands on your home screen
                    </span>
                  </li>
                </>
              ) : (
                <>
                  <li className="install-step">
                    <span className="install-step-icon" aria-hidden="true">
                      <MenuIcon />
                    </span>
                    <span>
                      Open the browser menu (the <strong>⋮</strong> button)
                    </span>
                  </li>
                  <li className="install-step">
                    <span className="install-step-icon" aria-hidden="true">
                      <PlusIcon />
                    </span>
                    <span>
                      Tap <strong>Add to Home screen</strong> (or <strong>Install app</strong>)
                    </span>
                  </li>
                </>
              )}
            </ol>
            <div className="install-actions">
              <button ref={primaryBtnRef} className="btn btn-primary install-btn" onClick={dismiss}>
                Got it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 3a1 1 0 0 1 1 1v9.59l2.29-2.3a1 1 0 1 1 1.42 1.42l-4 4a1 1 0 0 1-1.42 0l-4-4a1 1 0 1 1 1.42-1.42l2.29 2.3V4a1 1 0 0 1 1-1ZM5 19a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M11 5a1 1 0 1 1 2 0v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M20.7 6.3a1 1 0 0 1 0 1.4l-9 9a1 1 0 0 1-1.4 0l-4.5-4.5a1 1 0 1 1 1.4-1.4l3.8 3.79 8.3-8.3a1 1 0 0 1 1.4 0Z"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="19" r="1.8" fill="currentColor" />
    </svg>
  );
}

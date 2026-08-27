import { describe, it, expect, afterEach, vi } from 'vitest';
import { detectInstallPlatform, isStandaloneDisplay } from './useInstallPrompt.ts';

function stubNavigator(ua: string, opts: { touchPoints?: number; standalone?: boolean } = {}) {
  vi.stubGlobal('navigator', {
    userAgent: ua,
    maxTouchPoints: opts.touchPoints ?? 0,
    ...(opts.standalone !== undefined ? { standalone: opts.standalone } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectInstallPlatform', () => {
  it('detects Android', () => {
    stubNavigator(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    );
    expect(detectInstallPlatform()).toBe('android');
  });

  it('detects iPhone', () => {
    stubNavigator(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    );
    expect(detectInstallPlatform()).toBe('ios');
  });

  it('detects classic iPad UA', () => {
    stubNavigator(
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    );
    expect(detectInstallPlatform()).toBe('ios');
  });

  it('detects desktop-mode iPadOS via Macintosh UA + touch points', () => {
    // iPadOS 13+ reports "Macintosh" with maxTouchPoints > 1
    stubNavigator(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      { touchPoints: 5 },
    );
    expect(detectInstallPlatform()).toBe('ios');
  });

  it('returns null for desktop browsers', () => {
    stubNavigator(
      'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
    );
    expect(detectInstallPlatform()).toBe(null);

    stubNavigator(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
    expect(detectInstallPlatform()).toBe(null);
  });

  it('returns null for a real desktop Mac (no touch)', () => {
    stubNavigator(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      { touchPoints: 0 },
    );
    expect(detectInstallPlatform()).toBe(null);
  });
});

describe('isStandaloneDisplay', () => {
  it('is true when display-mode matches standalone', () => {
    stubNavigator('Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36');
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({ matches: q.includes('standalone') }),
    });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('is true on iOS navigator.standalone', () => {
    stubNavigator('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', {
      standalone: true,
    });
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('is false in a regular browser tab', () => {
    stubNavigator('Mozilla/5.0 (Linux; Android 14) Chrome/126.0 Mobile Safari/537.36');
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    });
    expect(isStandaloneDisplay()).toBe(false);
  });
});

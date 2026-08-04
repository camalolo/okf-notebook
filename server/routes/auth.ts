import { Router } from 'express';
import passport from 'passport';
import { OAUTH_CALLBACK_PATH } from '../config.js';
import { WORKSPACE_SCOPES, getWorkspaceAuthStatus } from '../lib/workspace-auth.js';

const router = Router();

// passport-oauth2 reads `callbackURL` from authenticate options at runtime
// (overrides the strategy default), but @types/passport omits it — declare it.
type GoogleAuthOptions = passport.AuthenticateOptions & {
  callbackURL?: string;
  accessType?: string;
  prompt?: string;
  scope?: string[] | string;
};

/** Build the absolute OAuth callback URL from the incoming request origin. */
function callbackURL(req: import('express').Request): string {
  return `${req.protocol}://${req.get('host')}${OAUTH_CALLBACK_PATH}`;
}

/**
 * GET /auth/google — initiate Google OAuth.
 *
 * Every login requests Workspace scopes + offline access so that the MCP
 * tokens are captured transparently. On first authorization Google returns
 * a refresh_token; subsequent logins don't (the existing one stays valid).
 *
 * `?reconnect=1` adds `prompt: 'consent'` to force Google to issue a fresh
 * refresh_token — used when the previous one has expired (7-day test mode).
 */
router.get('/google', (req, res, next) => {
  const reconnect = req.query.reconnect === '1';
  passport.authenticate('google', {
    scope: ['profile', 'email', ...WORKSPACE_SCOPES],
    accessType: 'offline',
    ...(reconnect ? { prompt: 'consent' } : {}),
    callbackURL: callbackURL(req),
  } as GoogleAuthOptions)(req, res, next);
});

/** GET /auth/google/callback — handle the OAuth callback. */
router.get('/google/callback', (req, res, next) => {
  passport.authenticate(
    'google',
    { callbackURL: callbackURL(req) } as GoogleAuthOptions,
    (err: unknown, user: Express.User | false | null, _info?: unknown) => {
      if (err) return next(err);
      if (!user) {
        req.logout(() => {
          req.session.destroy(() => {
            res.redirect('/?auth_error=denied');
          });
        });
        return;
      }
      req.logIn(user, (err) => {
        if (err) return next(err);
        res.redirect('/');
      });
    },
  )(req, res, next);
});

/** GET /auth/me — return the current user or 401. */
router.get('/me', async (req, res) => {
  if (req.isAuthenticated()) {
    const workspace = await getWorkspaceAuthStatus();
    return res.json({ ...req.user, workspace });
  }
  return res.status(401).json({ error: 'Unauthorized' });
});

/** POST /auth/logout — terminate the session. */
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });
});

export default router;

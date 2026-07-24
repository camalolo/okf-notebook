import { Router } from 'express';
import passport from 'passport';
import { OAUTH_CALLBACK_PATH } from '../config.js';

const router = Router();

// passport-oauth2 reads `callbackURL` from authenticate options at runtime
// (overrides the strategy default), but @types/passport omits it — declare it.
type GoogleAuthOptions = passport.AuthenticateOptions & { callbackURL?: string };

/** Build the absolute OAuth callback URL from the incoming request origin. */
function callbackURL(req: import('express').Request): string {
  return `${req.protocol}://${req.get('host')}${OAUTH_CALLBACK_PATH}`;
}

/** GET /auth/google — initiate Google OAuth. */
router.get('/google', (req, res, next) => {
  passport.authenticate('google', {
    scope: ['profile', 'email'],
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
        // Authentication failed or email not in allowlist.
        // Destroy any partial session and redirect with an error flag.
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
router.get('/me', (req, res) => {
  if (req.isAuthenticated()) {
    return res.json(req.user);
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

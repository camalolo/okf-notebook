import type express from 'express';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, USERS } from './config.js';
import type { User } from './config.js';
import { getBundle, canAccessBundle } from './bundles.js';
import { writeWorkspaceTokens } from './lib/workspace-auth.js';
import { mcpManager } from './lib/mcp-manager.js';

/**
 * Initialize Passport on the Express app: session serialization + the Google
 * OAuth strategy.
 *
 * The Google strategy is only registered when client credentials are present.
 * `passport-google-oauth20` throws if `clientID` is empty, so in dev (no env
 * vars) we skip registration — the server still starts and the protected API
 * returns 401. OAuth endpoints will 500 until credentials are provided.
 */
export function setupPassport(app: express.Express): void {
  // Serialize/deserialize the whole user object (small, in-memory sessions).
  passport.serializeUser((user, done) => {
    done(null, user as User);
  });
  passport.deserializeUser((serialized, done) => {
    done(null, serialized as User);
  });

  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: GOOGLE_CLIENT_ID,
          clientSecret: GOOGLE_CLIENT_SECRET,
          // Overridden per-request via passport.authenticate({ callbackURL }).
          callbackURL: 'https://placeholder.example.com/api/notebook/auth/google/callback',
          passReqToCallback: true,
        },
        async (req, accessToken, refreshToken, profile, done) => {
          const email = profile.emails?.[0]?.value;
          if (!email) {
            // No email in profile — cannot map to allowlist.
            return done(null, false);
          }
          // Every login requests workspace scopes + offline access. Google
          // only returns a refresh_token on first authorization (or when
          // prompt:consent is used via ?reconnect=1). When present, write
          // per-user tokens and (re)start that user's MCP instance so their
          // Google account — and only theirs — is used for gw_ tools.
          if (refreshToken) {
            try {
              await writeWorkspaceTokens(email, accessToken, refreshToken);
              mcpManager
                .restartUserServer('google-workspace', email)
                .catch((e) => console.error('[mcp] Failed to restart user instance:', e));
            } catch (e) {
              console.error('[workspace-auth] Failed to write tokens:', e);
            }
          }
          const role = USERS[email];
          if (!role) {
            // Email is not in the allowlist — deny access.
            return done(null, false);
          }
          const user: User = {
            email,
            name: profile._json.name ?? profile.displayName ?? email,
            picture: profile._json.picture,
            role,
          };
          return done(null, user);
        },
      ),
    );
  } else {

    console.warn(
      '[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google OAuth disabled. ' +
        'Set them to enable login.',
    );
  }

  app.use(passport.initialize());
  app.use(passport.session());
}

/** Middleware: require an authenticated session. */
export const requireAuth: express.RequestHandler = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Unauthorized' });
};

/** Middleware: require the `full` role. Apply after `requireAuth`. */
export const requireFull: express.RequestHandler = (req, res, next) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (user.role !== 'full') {
    return res.status(403).json({ error: 'Forbidden: full role required' });
  }
  return next();
};

/**
 * Middleware: require access to the bundle whose id is the first path segment
 * after the mount point (e.g. `/demo/tree`). `full` users pass; readonly users
 * must be in the bundle's `allowedUsers`. Unknown bundles fall through so the
 * downstream route returns its own 404. Responds 404 (not 403) to avoid
 * leaking which bundle ids exist. Apply after `requireAuth`.
 */
export const requireBundleAccess: express.RequestHandler = (req, res, next) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const bundleId = req.path.split('/').filter(Boolean)[0];
  if (!bundleId) return next(); // list/create endpoints — no bundle in path
  getBundle(bundleId)
    .then((bundle) => {
      if (!bundle || canAccessBundle(bundle, user)) return next();
      return res.status(404).json({ error: 'Bundle not found' });
    })
    .catch(next);
};

export { passport };

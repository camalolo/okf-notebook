// Augment Express/Passport typings so that `req.user` is our application User.
import type { User as SessionUser } from './config.js';

declare global {
  namespace Express {
    // Merges with the empty `interface User {}` declared by @types/passport.
    interface User extends SessionUser {}
  }
}

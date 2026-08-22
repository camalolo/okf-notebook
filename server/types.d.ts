// Augment Express/Passport typings so that `req.user` is our application User.
import type { User as SessionUser } from './config.js';

declare global {
  namespace Express {
    // Merges with the empty `interface User {}` declared by @types/passport.
    // Declaration merging is the required mechanism — an empty body is
    // unavoidable here.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends SessionUser {}
  }
}

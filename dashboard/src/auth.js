// Staff sign-in with one shared password. Signed-in browsers hold a random token in
// a cookie, and tokens live in memory, so a server restart signs everyone out.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { StoreError } from './store.js';

const COOKIE = 'playpulse_session';
const SESSION_MS = 12 * 60 * 60 * 1000;  // A long shift.
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

const sha256 = (text) => createHash('sha256').update(text).digest();

function tokenFrom(cookieHeader = '') {
  for (const part of cookieHeader.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE) return value;
  }
  return null;
}

export class Logins {
  #password;
  #now;
  #sessions = new Map();
  #failures = new Map();

  constructor(password, { now = Date.now } = {}) {
    this.#password = password;
    this.#now = now;
  }

  isSignedIn(cookieHeader) {
    const expires = this.#sessions.get(tokenFrom(cookieHeader));
    return expires !== undefined && expires > this.#now();
  }

  // Returns the Set-Cookie value. Repeated failures lock that address for a minute,
  // which keeps a guessed password out of reach on a shared network.
  signIn(address, given) {
    const now = this.#now();
    const record = this.#failures.get(address);
    if (record?.lockedUntil > now) {
      throw new StoreError(429, 'too_many_attempts', 'Too many attempts. Try again in a minute.');
    }
    if (typeof given !== 'string' || !timingSafeEqual(sha256(given), sha256(this.#password))) {
      const failures = (record?.lockedUntil ? 0 : record?.failures ?? 0) + 1;
      const lockedUntil = failures >= MAX_FAILURES ? now + LOCK_MS : 0;
      this.#failures.set(address, { failures, lockedUntil });
      throw new StoreError(401, 'wrong_password', 'That password is not right.');
    }

    this.#failures.delete(address);
    for (const [token, expires] of this.#sessions) {
      if (expires <= now) this.#sessions.delete(token);
    }
    const token = randomBytes(32).toString('hex');
    this.#sessions.set(token, now + SESSION_MS);
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
  }

  // Returns the Set-Cookie value that clears the browser's copy.
  signOut(cookieHeader) {
    this.#sessions.delete(tokenFrom(cookieHeader));
    return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }
}

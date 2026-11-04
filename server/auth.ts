// The optional password (PTP_PASSWORD): HTTP Basic auth on every page and API call, so the
// browser's own prompt asks for it once and then sends it with every fetch and EventSource.
import type express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

/** The path Docker's healthcheck asks (see Dockerfile): it says only that the server is up. */
export const HEALTH_PATH = '/api/health';

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Whether an Authorization header carries `password` (any user name). Compares in constant time. */
export function passwordMatches(header: string | undefined, password: string): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  const sent = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
  const colon = sent.indexOf(':');
  // Hashing both first gives equal lengths, so timingSafeEqual tells nothing about the length either.
  const ok = timingSafeEqual(digest(colon < 0 ? '' : sent.slice(colon + 1)), digest(password));
  return ok && colon >= 0;
}

/** Middleware asking for `password` on everything but the healthcheck. */
export function requirePassword(password: string): express.RequestHandler {
  return (req, res, next) => {
    if (req.path === HEALTH_PATH || passwordMatches(req.headers.authorization, password)) return next();
    res.set('WWW-Authenticate', 'Basic realm="prompt-to-part", charset="UTF-8"').status(401).type('text/plain').send('prompt-to-part needs its password.');
  };
}

/** Whether `host` is an address only this computer can reach. */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

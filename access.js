// Cloudflare Access sits in front of the app: every request that reaches it
// carries a signed token in Cf-Access-Jwt-Assertion. This checks that token
// and says who sent it, one of the partners by email or one of the displays
// by its service token's Client ID (common_name). Standard library only.

import crypto from 'node:crypto';
import fs from 'node:fs';

// Cloudflare rotates its signing keys every few weeks and publishes the next
// one ahead of time, so an hour-old copy is fine.
const CERTS_TTL_MS = 60 * 60 * 1000;
// An unknown key id refetches the keys, but not more often than this, so a
// stream of forged tokens cannot become a stream of requests to Cloudflare.
const CERTS_RETRY_MS = 60 * 1000;
const CERTS_TIMEOUT_MS = 10_000;
// Allowed clock difference between Cloudflare and this node, in seconds.
const LEEWAY_S = 30;
// Device ids end up in file names (inbox/<id>.json), so keep them plain.
const DEVICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

// A token was refused: missing, malformed, badly signed, expired or for another app.
export class AccessRefused extends Error {}
// Cloudflare's signing keys could not be fetched, so nothing can be checked.
export class AccessUnavailable extends Error {}

const normEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

// Accepts "team.cloudflareaccess.com" or the same with https:// in front.
export function teamHost(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

// Checks config.json once at start-up, so a typo stops the server instead of
// locking someone out later. Users are keyed by email, devices by Client ID.
export function parseConfig(raw = {}) {
  const users = new Map();
  for (const entry of raw.users ?? []) {
    const email = normEmail(entry.email);
    if (!email) throw new Error('config: every user needs an email');
    if (users.has(email)) throw new Error(`config: user ${email} is listed twice`);
    users.set(email, { email, name: String(entry.name || email), partner: normEmail(entry.partner) || null });
  }
  for (const user of users.values()) {
    if (user.partner && !users.has(user.partner)) throw new Error(`config: ${user.email}'s partner ${user.partner} is not a user`);
  }

  const devices = new Map();
  const ids = new Set();
  for (const entry of raw.devices ?? []) {
    const clientId = typeof entry.clientId === 'string' ? entry.clientId.trim() : '';
    const id = typeof entry.id === 'string' ? entry.id : '';
    const owner = normEmail(entry.owner);
    if (!clientId) throw new Error('config: every device needs the clientId of its service token');
    if (!DEVICE_ID.test(id)) throw new Error(`config: device id "${id}" must be lowercase letters, digits and -`);
    if (!users.has(owner)) throw new Error(`config: device ${id}'s owner ${owner || '(none)'} is not a user`);
    if (devices.has(clientId) || ids.has(id)) throw new Error(`config: device ${id} is listed twice`);
    devices.set(clientId, { id, clientId, owner });
    ids.add(id);
  }
  return { users, devices };
}

export function loadConfig(file) {
  return parseConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// Who a verified token belongs to, or null when it is nobody in config.json.
// A partner's token carries an email; a service token's carries no email and
// its Client ID as common_name.
export function identify(claims, config) {
  const email = normEmail(claims.email);
  if (email) {
    const user = config.users.get(email);
    return user ? { kind: 'user', user } : null;
  }
  const clientId = typeof claims.common_name === 'string' ? claims.common_name : '';
  const device = clientId && config.devices.get(clientId);
  return device ? { kind: 'device', device } : null;
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new AccessRefused('malformed token');
  }
}

// Returns verify(jwt), which resolves to the token's claims or throws
// AccessRefused / AccessUnavailable.
export function createVerifier({ teamDomain, audience, fetchImpl = fetch }) {
  const issuer = `https://${teamHost(teamDomain)}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = new Map();
  let fetchedAt = 0;
  let pending = null;

  function refresh() {
    pending ??= (async () => {
      try {
        const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(CERTS_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`${certsUrl} answered ${res.status}`);
        const next = new Map();
        for (const jwk of (await res.json()).keys ?? []) {
          if (jwk.kty === 'RSA' && jwk.kid) next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        }
        keys = next;
      } catch (e) {
        console.error(`could not fetch the Access signing keys: ${e.message}`);
      } finally {
        fetchedAt = Date.now();
        pending = null;
      }
    })();
    return pending;
  }

  async function keyFor(kid) {
    const age = Date.now() - fetchedAt;
    if (age > CERTS_TTL_MS || (!keys.has(kid) && age > CERTS_RETRY_MS)) await refresh();
    if (!keys.size) throw new AccessUnavailable('the Access signing keys could not be fetched');
    return keys.get(kid);
  }

  return async function verify(jwt) {
    const parts = String(jwt || '').split('.');
    if (parts.length !== 3) throw new AccessRefused('malformed token');
    const header = decodePart(parts[0]);
    // Pinned: the token must not be able to pick a weaker algorithm, or none.
    if (header.alg !== 'RS256') throw new AccessRefused('unexpected signing algorithm');
    const key = await keyFor(header.kid);
    if (!key) throw new AccessRefused('unknown signing key');
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!crypto.verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) {
      throw new AccessRefused('bad signature');
    }

    const claims = decodePart(parts[1]);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new AccessRefused('token is for another Access application');
    if (claims.iss !== issuer) throw new AccessRefused('token is from another Access team');
    const now = Date.now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_S <= now) throw new AccessRefused('token has expired');
    if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_S > now) throw new AccessRefused('token is not valid yet');
    return claims;
  };
}

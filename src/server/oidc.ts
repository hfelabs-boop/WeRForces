// OpenID Connect sign-in for the browser: authorization code flow with PKCE against any
// OIDC provider (Keycloak, Entra ID, Okta, Auth0, Google...). The ID token's signature
// is checked against the provider's published keys, and its claims map to a role:
// exercise control or a player of one force. Signed-in users get an HttpOnly cookie.

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import type { ForceId, Role } from '../shared/types.js';

export interface OidcOptions {
  /** Issuer URL, e.g. https://login.example.com/realms/werforces */
  issuer: string;
  clientId: string;
  /** Confidential clients only; public clients rely on PKCE. */
  clientSecret?: string;
  /** Public URL of this server (for the redirect URI); default: from the request's Host. */
  publicUrl?: string;
  /** Extra scopes beyond "openid profile email" (e.g. "groups"). */
  scopes?: string[];
  /** Claim rules, first match wins: a claim (string or array) containing a value gives a role. */
  roles: { claim: string; value: string; role: Role }[];
  /** Role for signed-in users no rule matches (default: none, sign-in refused). */
  defaultRole?: Role;
  /** Session length in seconds (default 12 h). */
  sessionSeconds?: number;
}

export interface OidcUser {
  sub: string;
  name: string;
  email?: string;
  role: Role;
  expires: number;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const COOKIE = 'wf_session';
const FORCES: Record<string, ForceId> = { blue: 1, red: 2, neutral: 3 };

/** "controller", "blue", "red" or "neutral" as a role. */
export function parseRole(s: string): Role {
  const k = s.trim().toLowerCase();
  if (k === 'controller' || k === 'control') return { kind: 'controller' };
  if (k in FORCES) return { kind: 'player', force: FORCES[k] };
  throw new Error(`unknown role "${s}" (controller, blue, red or neutral)`);
}

/** "claim=value:role", e.g. "groups=red-cell:red". */
export function parseRoleRule(s: string): OidcOptions['roles'][number] {
  const m = /^([^=]+)=(.*):([a-z]+)$/i.exec(s.trim());
  if (!m) throw new Error(`role rule must be claim=value:role, got "${s}"`);
  return { claim: m[1], value: m[2], role: parseRole(m[3]) };
}

const b64url = (b: Buffer) => b.toString('base64url');

export class OidcError extends Error {}

export class Oidc {
  private discovery: Discovery | null = null;
  private keys = new Map<string, ReturnType<typeof createPublicKey>>();
  private pending = new Map<string, { verifier: string; nonce: string; returnTo: string; redirectUri: string; created: number }>();
  private sessions = new Map<string, OidcUser>();

  constructor(readonly opts: OidcOptions) {}

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.opts.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const r = await fetch(url);
    if (!r.ok) throw new OidcError(`OIDC discovery failed: ${url} answered ${r.status}`);
    const d = (await r.json()) as Discovery;
    if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new OidcError('OIDC discovery document is incomplete');
    this.discovery = d;
    return d;
  }

  private async key(kid: string | undefined): Promise<ReturnType<typeof createPublicKey>> {
    const find = () => (kid ? this.keys.get(kid) : this.keys.size === 1 ? [...this.keys.values()][0] : undefined);
    let k = find();
    if (k) return k;
    // Unknown key: the provider may have rotated its keys.
    const d = await this.discover();
    const r = await fetch(d.jwks_uri);
    if (!r.ok) throw new OidcError(`could not fetch the provider's keys (${r.status})`);
    const { keys } = (await r.json()) as { keys: (JsonWebKey & { kid?: string; use?: string })[] };
    this.keys.clear();
    keys.filter((j) => !j.use || j.use === 'sig').forEach((j, i) => this.keys.set(j.kid ?? `#${i}`, createPublicKey({ key: j, format: 'jwk' })));
    k = find();
    if (!k) throw new OidcError('the ID token was signed with an unknown key');
    return k;
  }

  /** Start sign-in: where to send the browser. */
  async loginUrl(baseUrl: string, returnTo: string): Promise<string> {
    const d = await this.discover();
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const redirectUri = `${(this.opts.publicUrl ?? baseUrl).replace(/\/+$/, '')}/auth/callback`;
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.created > 10 * 60_000) this.pending.delete(k);
    // Only same-site paths: never an open redirect.
    const safeReturn = /^\/(?!\/)[^\s]*$/.test(returnTo) ? returnTo : '/';
    this.pending.set(state, { verifier, nonce, returnTo: safeReturn, redirectUri, created: now });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      redirect_uri: redirectUri,
      scope: ['openid', 'profile', 'email', ...(this.opts.scopes ?? [])].join(' '),
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${d.authorization_endpoint}${d.authorization_endpoint.includes('?') ? '&' : '?'}${q}`;
  }

  /** Finish sign-in: exchange the code, verify the ID token, start a session. */
  async callback(params: URLSearchParams): Promise<{ sessionId: string; user: OidcUser; returnTo: string }> {
    if (params.get('error')) throw new OidcError(`sign-in failed: ${params.get('error_description') ?? params.get('error')}`);
    const state = params.get('state') ?? '';
    const p = this.pending.get(state);
    if (!p) throw new OidcError('sign-in expired or was not started here; try again');
    this.pending.delete(state);
    const code = params.get('code');
    if (!code) throw new OidcError('no authorization code');
    const d = await this.discover();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: this.opts.clientId, code_verifier: p.verifier });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (this.opts.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`).toString('base64')}`;
    const r = await fetch(d.token_endpoint, { method: 'POST', headers, body: form });
    const tok = (await r.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!r.ok || !tok.id_token) throw new OidcError(`token exchange failed: ${tok.error_description ?? tok.error ?? r.status}`);
    const claims = await this.verifyIdToken(tok.id_token, p.nonce);
    const role = this.roleFor(claims);
    if (!role) throw new OidcError(`${String(claims.email ?? claims.preferred_username ?? claims.sub)} has no role in this exercise`);
    const user: OidcUser = {
      sub: String(claims.sub),
      name: String(claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub),
      email: typeof claims.email === 'string' ? claims.email : undefined,
      role,
      expires: Date.now() + (this.opts.sessionSeconds ?? 12 * 3600) * 1000,
    };
    const sessionId = b64url(randomBytes(32));
    this.sessions.set(sessionId, user);
    return { sessionId, user, returnTo: p.returnTo };
  }

  /** Check an ID token's signature (RS256/ES256/PS256), issuer, audience, expiry and nonce; return its claims. */
  async verifyIdToken(token: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new OidcError('malformed ID token');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>;
    const algs: Record<string, { hash: string; opts?: object }> = {
      RS256: { hash: 'sha256' },
      RS384: { hash: 'sha384' },
      RS512: { hash: 'sha512' },
      PS256: { hash: 'sha256', opts: { padding: 6, saltLength: 32 } },
      ES256: { hash: 'sha256', opts: { dsaEncoding: 'ieee-p1363' } },
      ES384: { hash: 'sha384', opts: { dsaEncoding: 'ieee-p1363' } },
    };
    const alg = algs[header.alg ?? ''];
    if (!alg) throw new OidcError(`unsupported ID token algorithm ${header.alg}`);
    const key = await this.key(header.kid);
    const ok = verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), { key, ...alg.opts } as Parameters<typeof verify>[2], Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new OidcError('ID token signature is invalid');
    const d = await this.discover();
    if (claims.iss !== d.issuer) throw new OidcError('ID token is from another issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.opts.clientId)) throw new OidcError('ID token is for another client');
    const now = Date.now() / 1000;
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new OidcError('ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat > now + 300) throw new OidcError('ID token is issued in the future');
    const a = Buffer.from(String(claims.nonce ?? ''));
    const b = Buffer.from(nonce);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OidcError('ID token nonce does not match');
    return claims;
  }

  /** The first matching rule's role, else the default. */
  roleFor(claims: Record<string, unknown>): Role | null {
    for (const rule of this.opts.roles) {
      const v = claims[rule.claim];
      const values = Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)];
      if (values.includes(rule.value)) return rule.role;
    }
    return this.opts.defaultRole ?? null;
  }

  /** The signed-in user for a request's cookie header, if any. */
  user(cookieHeader: string | undefined): OidcUser | null {
    const id = cookieValue(cookieHeader, COOKIE);
    if (!id) return null;
    const u = this.sessions.get(id);
    if (!u) return null;
    if (u.expires < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return u;
  }

  logout(cookieHeader: string | undefined): string | undefined {
    const id = cookieValue(cookieHeader, COOKIE);
    if (id) this.sessions.delete(id);
    return this.discovery?.end_session_endpoint;
  }

  cookie(sessionId: string, secure: boolean): string {
    return `${COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.opts.sessionSeconds ?? 12 * 3600}${secure ? '; Secure' : ''}`;
  }

  clearCookie(secure: boolean): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }
}

function cookieValue(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

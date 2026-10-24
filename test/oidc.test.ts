import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Oidc, parseRoleRule } from '../src/server/oidc.js';
import { SimRunner } from '../src/server/runner.js';
import { SimServer } from '../src/server/server.js';
import { Engine } from '../src/sim/engine.js';
import { Terrain } from '../src/sim/terrain.js';

/**
 * A minimal identity provider for the test: discovery, JWKS, an authorize endpoint that
 * signs in a preset user at once, and a token endpoint that checks PKCE and issues an
 * RS256-signed ID token.
 */
function identityProvider() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { challenge: string; nonce: string; clientId: string; redirectUri: string }>();
  const idp = { url: '', user: { sub: 'u1', name: 'Jo Control', email: 'jo@example.org', groups: ['control'] }, tokenTweaks: {} as Record<string, unknown> };
  const signJwt = (claims: Record<string, unknown>) => {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, idp.url);
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: idp.url, authorization_endpoint: `${idp.url}/authorize`, token_endpoint: `${idp.url}/token`, jwks_uri: `${idp.url}/jwks`, end_session_endpoint: `${idp.url}/logout` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('nonce')) return json(400, { error: 'invalid_request' });
      const code = randomBytes(16).toString('hex');
      codes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce')!, clientId: q.get('client_id')!, redirectUri: q.get('redirect_uri')! });
      res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}` });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const f = new URLSearchParams(raw);
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const verifier = f.get('code_verifier') ?? '';
        if (!c || c.redirectUri !== f.get('redirect_uri') || c.clientId !== f.get('client_id')) return json(400, { error: 'invalid_grant' });
        if (createHash('sha256').update(verifier).digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const now = Math.floor(Date.now() / 1000);
        json(200, { token_type: 'Bearer', access_token: 'x', id_token: signJwt({ iss: idp.url, aud: c.clientId, iat: now, exp: now + 300, nonce: c.nonce, ...idp.user, ...idp.tokenTweaks }) });
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  return { idp, server, signJwt };
}

describe('OpenID Connect sign-in', () => {
  const { idp, server: idpServer, signJwt } = identityProvider();
  const terrain = Terrain.generate({ size: 6000, seed: 5, towns: 2 });
  const engine = new Engine({ terrain });
  let sim: SimServer;
  let base = '';
  const get = (p: string, cookie?: string) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

  /** Run the whole browser round trip and return the session cookie (or the failed response). */
  async function signIn(returnTo = '/'): Promise<{ cookie?: string; response: Response }> {
    const login = await get(`/auth/login?return=${encodeURIComponent(returnTo)}`);
    expect(login.status).toBe(302);
    const atIdp = await fetch(login.headers.get('location')!, { redirect: 'manual' });
    const callback = new URL(atIdp.headers.get('location')!);
    const back = await get(`${callback.pathname}${callback.search}`);
    const cookie = back.headers.get('set-cookie')?.split(';')[0];
    return { cookie, response: back };
  }

  beforeAll(async () => {
    await new Promise<void>((r) => idpServer.listen(0, '127.0.0.1', () => r()));
    idp.url = `http://127.0.0.1:${(idpServer.address() as AddressInfo).port}`;
    engine.newScenario('oidc', terrain.spec);
    const runner = new SimRunner(engine, 0.1, 20, 0);
    runner.start();
    sim = new SimServer(runner, {
      port: 0,
      host: '127.0.0.1',
      webRoot: 'dist/web',
      scenarioDir: 'scenarios',
      oidc: { issuer: idp.url, clientId: 'werforces', roles: [parseRoleRule('groups=control:controller'), parseRoleRule('groups=red-cell:red')] },
    });
    await sim.listen();
    base = sim.address;
  });

  afterAll(async () => {
    sim.runner.stop();
    await sim.close();
    idpServer.close();
  });

  it('requires sign-in, then a controller gets the full API', async () => {
    expect((await get('/api/v1/simulation')).status).toBe(401);
    expect(await (await get('/auth/config')).json()).toEqual({ oidc: true, user: null });
    const { cookie, response } = await signIn('/s/x/?a=1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/s/x/?a=1');
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await get('/api/v1/simulation', cookie)).status).toBe(200);
    expect((await get('/api/v1/sessions', cookie)).status).toBe(200);
    expect(await (await get('/auth/me', cookie)).json()).toMatchObject({ oidc: true, user: { name: 'Jo Control', role: { kind: 'controller' } } });
    // Signing out ends the session and goes to the provider's logout.
    const out = await get('/auth/logout', cookie);
    expect(out.headers.get('location')).toMatch(new RegExp(`^${idp.url}/logout\\?`));
    expect((await get('/api/v1/simulation', cookie)).status).toBe(401);
  });

  it('maps claims to a player role, and refuses users with no role', async () => {
    idp.user = { sub: 'u2', name: 'Red Cell', email: 'red@example.org', groups: ['red-cell'] };
    const red = await signIn();
    expect((await get('/api/v1/simulation', red.cookie)).status).toBe(200);
    expect((await get('/api/v1/sessions', red.cookie)).status).toBe(403);
    idp.user = { sub: 'u3', name: 'Visitor', email: 'v@example.org', groups: ['other'] };
    const none = await signIn();
    expect(none.cookie).toBeUndefined();
    expect(none.response.status).toBe(401);
    expect(await none.response.text()).toMatch(/has no role/);
    // Never an open redirect.
    idp.user = { sub: 'u1', name: 'Jo Control', email: 'jo@example.org', groups: ['control'] };
    expect((await signIn('//evil.example/')).response.headers.get('location')).toBe('/');
  });

  it('rejects tokens that are tampered with, expired, for another client or with the wrong nonce', async () => {
    const o = new Oidc({ issuer: idp.url, clientId: 'werforces', roles: [] });
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: idp.url, aud: 'werforces', sub: 'u1', iat: now, exp: now + 300, nonce: 'n1' };
    await expect(o.verifyIdToken(signJwt(good), 'n1')).resolves.toMatchObject({ sub: 'u1' });
    const [h, b, s] = signJwt(good).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...good, sub: 'admin' })).toString('base64url')}.${s}`;
    await expect(o.verifyIdToken(forged, 'n1')).rejects.toThrow(/signature/);
    await expect(o.verifyIdToken(`${h}.${b}.${s}`, 'other')).rejects.toThrow(/nonce/);
    await expect(o.verifyIdToken(signJwt({ ...good, aud: 'someone-else' }), 'n1')).rejects.toThrow(/another client/);
    await expect(o.verifyIdToken(signJwt({ ...good, exp: now - 600 }), 'n1')).rejects.toThrow(/expired/);
    await expect(o.verifyIdToken(signJwt({ ...good, iss: 'https://evil.example' }), 'n1')).rejects.toThrow(/issuer/);
  });
});

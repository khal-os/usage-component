#!/usr/bin/env node
/**
 * DEV ONLY — a throwaway stand-in for khal-auth, so the MCP endpoint can be
 * exercised end to end on a workstation without a real identity provider.
 *
 * It generates an RSA key pair IN MEMORY (nothing is written to disk, nothing
 * survives the process), publishes the matching JWKS, and mints session
 * tokens with the claims the module checks: iss, aud, tenant, sub, roles, exp.
 *
 * NEVER point a deployment at this. The module trusts whatever `KHAL_AUTH_URL`
 * publishes, which is exactly why this exists only as a local tool.
 *
 *   node scripts/dev/mcp-stub-issuer.mjs --port 4010 --tenant local \
 *     --audience usage-mcp --subject user_dev --roles master
 *
 * Prints the token on stdout and keeps serving:
 *   GET /.well-known/jwks.json                 the key set
 *   GET /.well-known/oauth-authorization-server  RFC 8414 document
 *   GET /token?roles=member&sub=user_2         mint another token
 */
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);

  return index > -1 ? process.argv[index + 1] : fallback;
};

const port = Number(argOf('port', '4010'));
const tenant = argOf('tenant', 'local');
const audience = argOf('audience', 'usage-mcp');
const subject = argOf('subject', 'user_dev');
const roles = argOf('roles', 'master');
const ttlMinutes = Number(argOf('ttl', '120'));

const issuer = `http://localhost:${port}`;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: 'stub-key',
  alg: 'RS256',
  use: 'sig',
};

const mint = (claims = {}) =>
  new SignJWT({
    tenant: claims.tenant ?? tenant,
    roles: claims.roles ?? roles,
    roleName: claims.roles ?? roles,
    email: 'dev@localhost',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'stub-key' })
    .setIssuer(issuer)
    .setAudience(claims.audience ?? audience)
    .setSubject(claims.sub ?? subject)
    .setIssuedAt()
    .setExpirationTime(`${String(ttlMinutes)}m`)
    .sign(privateKey);

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', issuer);

  if (url.pathname === '/.well-known/jwks.json') {
    json(res, 200, { keys: [jwk] });
    return;
  }

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    json(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
    });
    return;
  }

  if (url.pathname === '/token') {
    mint({
      roles: url.searchParams.get('roles') ?? undefined,
      sub: url.searchParams.get('sub') ?? undefined,
      audience: url.searchParams.get('audience') ?? undefined,
      tenant: url.searchParams.get('tenant') ?? undefined,
    }).then(
      (token) => json(res, 200, { access_token: token, token_type: 'Bearer' }),
      () => json(res, 500, { error: 'mint failed' }),
    );
    return;
  }

  json(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => {
  console.log(`stub issuer on ${issuer} (tenant=${tenant} aud=${audience})`);
  console.log('export these:');
  console.log(`  KHAL_AUTH_URL=${issuer}`);
  console.log(`  KHAL_TENANT=${tenant}`);
  console.log(`  MCP_AUDIENCE=${audience}`);
  mint().then((token) => {
    console.log(
      `\nmaster token (${String(ttlMinutes)}m, sub=${subject}):\n${token}`,
    );
  });
});

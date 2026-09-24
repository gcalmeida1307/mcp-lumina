import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../../gateway/config.js';
import { domainIds } from '../../services/domains.js';
import type { Principal } from '../../core/types.js';
declare global { namespace Express { interface Request { principal: Principal; requestId: string; } } }
const jwks = config.AUTH_MODE === 'oidc' ? createRemoteJWKSet(new URL(config.OIDC_JWKS_URL)) : undefined;
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  if (config.AUTH_MODE === 'local') {
    req.principal = { id: 'CORE', roles: ['global-admin', 'admin', 'editor', 'viewer'], domains: domainIds };
    return next();
  }
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token) return void res.status(401).json({ error: 'Autenticação necessária.' });
    const { payload } = await jwtVerify(token, jwks!, { issuer: config.OIDC_ISSUER, audience: config.OIDC_AUDIENCE, algorithms: ['RS256', 'ES256'] });
    if (!payload.sub) throw new Error('Missing subject');
    const realm = payload.realm_access as { roles?: unknown } | undefined;
    const roles = Array.isArray(realm?.roles) ? realm.roles.filter((r): r is string => typeof r === 'string') : [];
    const domains = Array.isArray(payload.domains) ? payload.domains.filter((d): d is string => typeof d === 'string' && domainIds.includes(d)) : [];
    req.principal = { id: payload.sub, roles, domains };
    next();
  } catch { res.status(401).json({ error: 'Sessão inválida ou expirada.' }); }
}
export function isGlobalAdmin(principal: Principal) { return principal.id === 'CORE' || principal.roles.includes('global-admin'); }
export function canRead(principal: Principal, domain: string) { return domainIds.includes(domain) && (isGlobalAdmin(principal) || principal.domains.includes(domain)) && principal.roles.some(r => ['viewer', 'editor', 'admin', 'global-admin'].includes(r)); }
export function canWrite(principal: Principal, domain: string) { return canRead(principal, domain) && principal.roles.some(r => ['editor', 'admin'].includes(r)); }
export function requireDomain(req: Request, res: Response, write = false): string | undefined {
  const domain = String(req.body?.domain ?? req.query.domain ?? 'geral');
  if (!(write ? canWrite(req.principal, domain) : canRead(req.principal, domain))) { res.status(403).json({ error: 'Acesso negado ao domínio.' }); return; }
  return domain;
}
export function admin(req: Request, res: Response, next: NextFunction) {
  if (!isGlobalAdmin(req.principal) && !req.principal.roles.includes('admin')) return void res.status(403).json({ error: 'Permissão de administrador necessária.' });
  next();
}
export function globalAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isGlobalAdmin(req.principal)) return void res.status(403).json({ error: 'Permissão de administrador global necessária.' });
  next();
}

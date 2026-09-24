import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Store } from '../../data/storage/database.js';
import { config } from '../../gateway/config.js';
import { domains } from '../../services/domains.js';
import { AuthError, AuthService, GLOBAL_ADMIN_CODE, type Session, type AuthUser } from './service.js';
declare global { namespace Express { interface Request { authSession?: Session; authUser?: AuthUser; } } }
const code = z.string().trim().toUpperCase().regex(/^[A-Z]{2}\d{6}$/);
const password = z.string().min(1).max(256);
const token = z.string().min(20).max(200);
const otp = z.string().regex(/^\d{6}$/);
const cookieName = 'lumina_session';
function setCookie(res: Response, session: Session) {
  res.cookie(cookieName, session.token, { httpOnly: true, sameSite: 'strict', secure: config.NODE_ENV === 'production', path: '/', maxAge: Math.max(0, session.expiresAt * 1000 - Date.now()) });
}
function cookie(req: Request) { return (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? ''; }
export function nativeAuth(store: Store) {
  const service = new AuthService(store), publicRoutes = Router(), privateRoutes = Router();
  const limiter = rateLimit({ windowMs: 60000, limit: 20, message: { error: 'Muitas tentativas. Aguarde um minuto.', detail: 'Muitas tentativas. Aguarde um minuto.' } });
  publicRoutes.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  publicRoutes.use(limiter);
  publicRoutes.get('/domains', (_req, res) => res.json(domains));
  publicRoutes.post('/login', async (req, res) => {
    const input = z.object({ identifier: z.string().trim().min(1).max(254), password, otp: z.string().max(6).default('') }).parse(req.body);
    const result = await service.login(input.identifier, input.password, input.otp);
    if ('token' in result) { setCookie(res, result); res.json({ token: 'http-only-cookie', user: result.user }); }
    else res.json(result);
  });
  publicRoutes.post('/requests', async (req, res) => {
    const input = z.object({ name: z.string().trim().min(2).max(150), email: z.email().max(254), requested_module: z.string(), scopes: z.array(z.string()).min(1).max(15) }).parse(req.body);
    res.status(201).json(await service.requestAccess(input.name, input.email, input.requested_module, input.scopes));
  });
  publicRoutes.post('/activation', async (req, res) => {
    const input = z.object({ user_code: code, activation_token: token, new_password: password }).parse(req.body);
    res.json(await service.activate(input.user_code, input.activation_token, input.new_password));
  });
  publicRoutes.post('/activation/resume', async (req, res) => {
    const input = z.object({ user_code: code, activation_token: token }).parse(req.body);
    res.json(await service.activate(input.user_code, input.activation_token));
  });
  publicRoutes.post('/activation/2fa', async (req, res) => {
    const input = z.object({ user_code: code, activation_token: token, code: otp }).parse(req.body);
    res.json(await service.activate2fa(input.user_code, input.activation_token, input.code));
  });
  publicRoutes.post('/password/reset', async (req, res) => {
    const input = z.object({ user_code: code, reset_token: token, new_password: password }).parse(req.body);
    res.json(await service.reset(input.user_code, input.reset_token, input.new_password));
  });
  async function authenticate(req: Request, res: Response, next: NextFunction) {
    const session = await service.session(cookie(req));
    if (!session) return void res.status(401).json({ error: 'Autenticação necessária.', detail: 'Autenticação necessária.' });
    req.authSession = session; req.authUser = session.user; req.principal = service.principal(session.user);
    res.setHeader('Cache-Control', 'no-store');
    const allowed = ['/auth/me', '/auth/logout', '/auth/token/rotate', '/auth/password', '/auth/2fa/setup', '/auth/2fa/enable', '/me'];
    if ((session.user.must_change_password || !session.user.two_factor_enabled || !session.elevated) && !allowed.includes(req.path)) {
      return void res.status(403).json({ error: 'Conclua a troca de senha e o 2FA antes de acessar o workspace.' });
    }
    next();
  }
  privateRoutes.get('/me', (req, res) => res.json({ user: req.authUser }));
  privateRoutes.post('/logout', async (req, res) => { await service.revoke(req.authSession!); res.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.NODE_ENV === 'production' }); res.json({ ok: true }); });
  privateRoutes.post('/token/rotate', async (req, res) => { const session = await service.rotate(req.authSession!); setCookie(res, session); res.json({ token: 'http-only-cookie', user: session.user }); });
  privateRoutes.post('/password', async (req, res) => {
    const input = z.object({ current_password: password, new_password: password }).parse(req.body);
    const session = await service.changePassword(req.authSession!, input.current_password, input.new_password);
    setCookie(res, session); res.json({ user: session.user });
  });
  privateRoutes.post('/2fa/setup', async (req, res) => res.json(await service.setup(req.authUser!.user_code)));
  privateRoutes.post('/2fa/enable', async (req, res) => {
    const input = z.object({ code: otp }).parse(req.body);
    const session = await service.enable(req.authSession!, input.code); setCookie(res, session); res.json({ user: session.user });
  });
  privateRoutes.use((req, res, next) => {
    if (req.authUser?.user_code !== GLOBAL_ADMIN_CODE || req.authUser.role !== 'admin' || !req.authSession?.elevated) return void res.status(403).json({ error: 'Acesso administrativo necessário.', detail: 'Acesso administrativo necessário.' });
    next();
  });
  privateRoutes.get('/requests', async (_req, res) => res.json({ requests: await service.requests() }));
  privateRoutes.post('/requests/:id/decision', async (req, res) => {
    const input = z.object({ approve: z.boolean(), scopes: z.array(z.string()).max(15), note: z.string().max(500).default('') }).parse(req.body);
    res.json(await service.decide(String(req.params.id), input.approve, input.scopes, req.authUser!.user_code, input.note));
  });
  privateRoutes.get('/users', async (_req, res) => { await service.enforceInactivity(); res.json(await service.users()); });
  privateRoutes.post('/users/inactivity-policy', async (req, res) => {
    const { inactive_lock_days } = z.object({ inactive_lock_days: z.number().int().min(1).max(3650) }).parse(req.body);
    await store.sql("UPDATE auth_settings SET setting_value=?,updated_at=? WHERE setting_key='inactive_lock_days'", [String(inactive_lock_days), new Date().toISOString()]);
    await store.audit(req.authUser!.user_code, 'auth.inactivity.updated', String(inactive_lock_days));
    res.json({ inactive_lock_days, blocked_now: await service.enforceInactivity() });
  });
  privateRoutes.post('/users/:code/reset', async (req, res) => res.json(await service.issueReset(code.parse(req.params.code), req.authUser!.user_code)));
  privateRoutes.post('/users/:code/activation', async (req, res) => res.json(await store.transaction(() => service.issueActivation(code.parse(req.params.code), req.authUser!.user_code))));
  privateRoutes.post('/users/:code/status', async (req, res) => {
    const input = z.object({ active: z.boolean(), reason: z.string().max(500).optional(), note: z.string().max(500).optional() }).parse(req.body);
    await service.setActive(code.parse(req.params.code), input.active, input.reason ?? input.note ?? 'Bloqueado pela administração', req.authUser!.user_code);
    res.json({ ok: true });
  });
  return { service, publicRoutes, privateRoutes, authenticate };
}
export function csrf(req: Request, res: Response, next: NextFunction) {
  if (config.AUTH_MODE === 'native' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.headers['x-lumina-request'] !== '1') return void res.status(403).json({ error: 'Cabeçalho de proteção ausente.', detail: 'Cabeçalho de proteção ausente.' });
    const origin = req.headers.origin;
    // Browser requests must originate from the configured app or this exact host.
    const sameHost = origin && new URL(origin).host === req.headers.host;
    const localDevOrigin = config.NODE_ENV === 'development' && origin && ['localhost', '127.0.0.1'].includes(new URL(origin).hostname) && new URL(origin).port === new URL(config.APP_ORIGIN).port;
    if (origin && origin !== config.APP_ORIGIN && !sameHost && !localDevOrigin) return void res.status(403).json({ error: 'Origem não autorizada.' });
  }
  next();
}
export { AuthError };

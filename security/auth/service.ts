import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { Store } from '../../data/storage/database.js';
import { domainIds } from '../../services/domains.js';
import { digest, emailLookup, hashPassword, matchesPassword, protect, reveal, secretToken, totpSecret, verifyTotp } from './crypto.js';
import type { Principal } from '../../core/types.js';
export class AuthError extends Error { constructor(message: string, public status = 400) { super(message); } }
const now = () => new Date().toISOString();
const seconds = () => Math.floor(Date.now() / 1000);
export const GLOBAL_ADMIN_CODE = 'AG000001';
export type AuthUser = { user_code: string; name: string; email: string; role: string; scopes: string[]; must_change_password: boolean; two_factor_enabled: boolean; active: boolean; last_login_at: string | null; last_seen_at: string | null; blocked_at: string | null; blocked_reason: string | null };
export type Session = { token: string; sessionId: string; user: AuthUser; elevated: boolean; expiresAt: number };
export class AuthService {
  constructor(public store: Store) {}
  private get lock() { return this.store.storageName === 'PostgreSQL' ? ' FOR UPDATE' : ''; }
  async row(code: string, lock = false) { return (await this.store.sql('SELECT * FROM users WHERE user_code=?' + (lock ? this.lock : ''), [code]))[0]; }
  async user(row: Record<string, any>): Promise<AuthUser> {
    return { user_code: row.user_code, name: reveal(row.name), email: reveal(row.email), role: row.role,
      scopes: (await this.store.sql('SELECT module_id FROM user_module_access WHERE user_code=? ORDER BY module_id', [row.user_code])).map(r => r.module_id),
      active: Boolean(row.active), must_change_password: Boolean(row.must_change_password), two_factor_enabled: Boolean(row.two_factor_enabled),
      last_login_at: row.last_login_at, last_seen_at: row.last_seen_at, blocked_at: row.blocked_at, blocked_reason: row.blocked_reason };
  }
  principal(user: AuthUser): Principal {
    const globalAdmin = user.user_code === GLOBAL_ADMIN_CODE && user.role === 'admin' && user.scopes.length === 1 && user.scopes[0] === 'CORE';
    return { id: user.user_code, roles: globalAdmin ? ['global-admin', 'admin', 'editor', 'viewer'] : ['editor', 'viewer'],
      domains: user.scopes.includes('CORE') ? domainIds : user.scopes.filter(s => domainIds.includes(s)) };
  }
  normalizeScopes(scopes: string[]) {
    if (scopes.includes('CORE')) return ['CORE'];
    const valid = [...new Set(scopes)].filter(s => domainIds.includes(s));
    if (valid.length !== 1) throw new AuthError('Cada usuário deve pertencer a exatamente um módulo.');
    return valid;
  }
  async createUser(input: { code: string; email: string; name: string; role?: string; passwordHash: string; scopes: string[]; active?: number; mustChange?: number; twoFactorSecret?: string; twoFactorEnabled?: number; createdAt?: string }) {
    const scopes = this.normalizeScopes(input.scopes);
    if (!/^[A-Z]{2}\d{6}$/.test(input.code)) throw new AuthError('Matrícula inválida.');
    const isGlobalAdmin = input.code === GLOBAL_ADMIN_CODE;
    if (scopes.includes('CORE') !== isGlobalAdmin || (input.role ?? 'user') === 'admin' !== isGlobalAdmin) {
      throw new AuthError('Somente AG000001 pode ser administrador global no CORE.');
    }
    await this.store.sql('INSERT INTO users(user_code,email,email_lookup,name,password_hash,role,active,created_at,must_change_password,two_factor_secret,two_factor_enabled,password_changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [input.code, protect(input.email.trim().toLowerCase()), emailLookup(input.email), protect(input.name), input.passwordHash, input.role ?? 'user', input.active ?? 1, input.createdAt ?? now(), input.mustChange ?? 0, input.twoFactorSecret ? protect(input.twoFactorSecret) : null, input.twoFactorEnabled ?? 0, now()]);
    for (const scope of scopes) await this.store.sql('INSERT INTO user_module_access(user_code,module_id) VALUES (?,?)', [input.code, scope]);
  }
  async issue(row: Record<string, any>, elevated: boolean, expiresAt = seconds() + 8 * 3600): Promise<Session> {
    const token = secretToken(), sessionId = randomUUID(), created = now();
    await this.store.sql('INSERT INTO sessions(session_id,token_hash,user_code,expires_at,created_at,last_seen_at,last_rotated_at,elevated) VALUES (?,?,?,?,?,?,?,?)',
      [sessionId, digest(token), row.user_code, expiresAt, created, created, created, Number(elevated)]);
    return { token, sessionId, user: await this.user(row), elevated, expiresAt };
  }
  async inactivityDays() { return Number((await this.store.sql("SELECT setting_value FROM auth_settings WHERE setting_key='inactive_lock_days'"))[0]?.setting_value ?? 90); }
  async enforceInactivity() {
    const cutoff = Date.now() - await this.inactivityDays() * 86400000;
    let blocked = 0;
    for (const row of await this.store.sql("SELECT user_code,last_seen_at,last_login_at,created_at FROM users WHERE active=1 AND role!='admin'")) {
      if (Date.parse(row.last_seen_at || row.last_login_at || row.created_at) < cutoff) {
        await this.store.sql('UPDATE users SET active=0,blocked_at=?,blocked_reason=? WHERE user_code=?', [now(), 'Bloqueado por inatividade', row.user_code]);
        await this.revokeAll(row.user_code); blocked++;
      }
    }
    return blocked;
  }
  async login(identifier: string, password: string, otp: string) {
    await this.enforceInactivity();
    const key = emailLookup(identifier), failure = (await this.store.sql('SELECT * FROM auth_failures WHERE identifier=?', [key]))[0];
    if (failure && Number(failure.locked_until) > seconds()) throw new AuthError('Muitas tentativas. Aguarde um minuto.', 429);
    const result = await this.store.transaction(async () => {
      const row = (await this.store.sql('SELECT * FROM users WHERE lower(user_code)=? OR email_lookup=?' + this.lock, [identifier.trim().toLowerCase(), key]))[0];
      const valid = await matchesPassword(password, row?.password_hash);
      let step: number | undefined;
      if (row?.two_factor_enabled && otp) step = verifyTotp(reveal(row.two_factor_secret), otp, Number(row.last_totp_step));
      if (!row || !row.active || !valid || (row.two_factor_enabled && otp && step === undefined)) {
        const count = failure && Number(failure.locked_until) === 0 ? Number(failure.failures) + 1 : 1;
        await this.store.sql('INSERT INTO auth_failures(identifier,failures,locked_until) VALUES (?,?,?) ON CONFLICT(identifier) DO UPDATE SET failures=excluded.failures,locked_until=excluded.locked_until', [key, count, count >= 5 ? seconds() + 60 : 0]);
        return { invalid: true } as const;
      }
      if ((await this.store.sql('SELECT 1 FROM password_reset_tokens WHERE user_code=? AND used_at IS NULL AND expires_at>?', [row.user_code, seconds()])).length) return { requires_password_reset: true } as const;
      if ((await this.store.sql('SELECT 1 FROM account_activation_tokens WHERE user_code=? AND used_at IS NULL AND expires_at>?', [row.user_code, seconds()])).length && !row.two_factor_enabled) return { requires_activation: true } as const;
      if (row.two_factor_enabled && !otp) return { requires_2fa: true } as const;
      if (step !== undefined) await this.store.sql('UPDATE users SET last_totp_step=? WHERE user_code=?', [step, row.user_code]);
      await this.store.sql('DELETE FROM auth_failures WHERE identifier=?', [key]);
      await this.store.sql('UPDATE users SET last_login_at=?,last_seen_at=? WHERE user_code=?', [now(), now(), row.user_code]);
      await this.store.audit(row.user_code, 'auth.login', row.user_code);
      return this.issue(row, Boolean(row.two_factor_enabled));
    });
    if ('invalid' in result) throw new AuthError('Usuário, senha ou código 2FA inválidos.', 401);
    return result;
  }
  async session(token: string): Promise<Session | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    const session = (await this.store.sql('SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?', [digest(token), seconds()]))[0];
    if (!session) return;
    const row = await this.row(session.user_code);
    if (!row?.active) return;
    if (row.role !== 'admin' && Date.parse(row.last_seen_at || row.last_login_at || row.created_at) < Date.now() - await this.inactivityDays() * 86400000) {
      await this.enforceInactivity(); return;
    }
    await this.store.sql('UPDATE users SET last_seen_at=? WHERE user_code=?', [now(), row.user_code]);
    await this.store.sql('UPDATE sessions SET last_seen_at=? WHERE session_id=?', [now(), session.session_id]);
    return { token, sessionId: session.session_id, user: await this.user(row), elevated: Boolean(session.elevated), expiresAt: Number(session.expires_at) };
  }
  async revokeAll(code: string) { await this.store.sql('UPDATE sessions SET revoked_at=? WHERE user_code=? AND revoked_at IS NULL', [now(), code]); }
  async revoke(session: Session) { await this.store.sql('UPDATE sessions SET revoked_at=? WHERE session_id=?', [now(), session.sessionId]); await this.store.audit(session.user.user_code, 'auth.logout', session.sessionId); }
  async rotate(session: Session) {
    return this.store.transaction(async () => { await this.revoke(session); return this.issue((await this.row(session.user.user_code))!, session.elevated, session.expiresAt); });
  }
  async changePassword(session: Session, current: string, next: string) {
    if (current === next) throw new AuthError('Escolha uma senha diferente da atual.');
    const hash = await hashPassword(next);
    return this.store.transaction(async () => {
      const row = await this.row(session.user.user_code, true);
      if (!row || !await matchesPassword(current, row.password_hash)) throw new AuthError('Senha atual inválida.', 401);
      await this.store.sql('UPDATE users SET password_hash=?,must_change_password=0,password_changed_at=? WHERE user_code=?', [hash, now(), row.user_code]);
      await this.revokeAll(row.user_code);
      await this.store.audit(row.user_code, 'auth.password.changed', row.user_code);
      return this.issue((await this.row(row.user_code))!, session.elevated);
    });
  }
  async artifact(code: string, secret: string) {
    const uri = 'otpauth://totp/' + encodeURIComponent('LUMINA:' + code) + '?secret=' + secret + '&issuer=LUMINA&algorithm=SHA1&digits=6&period=30';
    return { secret, otpauth_uri: uri, qr_data_uri: await QRCode.toDataURL(uri, { width: 240, margin: 2 }), enabled: false };
  }
  async setup(code: string) {
    return this.store.transaction(async () => {
      const row = await this.row(code, true);
      if (!row || row.two_factor_enabled) throw new AuthError('2FA já está ativo. O segredo não pode ser exibido novamente.');
      const secret = row.two_factor_secret ? reveal(row.two_factor_secret) : totpSecret();
      if (!row.two_factor_secret) await this.store.sql('UPDATE users SET two_factor_secret=? WHERE user_code=?', [protect(secret), code]);
      return this.artifact(code, secret);
    });
  }
  async enable(session: Session, otp: string) {
    return this.store.transaction(async () => {
      const row = await this.row(session.user.user_code, true);
      if (!row?.two_factor_secret || row.two_factor_enabled) throw new AuthError('Prepare o 2FA antes de confirmar.');
      const step = verifyTotp(reveal(row.two_factor_secret), otp, Number(row.last_totp_step));
      if (step === undefined) throw new AuthError('Código 2FA inválido.');
      await this.store.sql('UPDATE users SET two_factor_enabled=1,last_totp_step=? WHERE user_code=?', [step, row.user_code]);
      await this.revokeAll(row.user_code);
      await this.store.audit(row.user_code, 'auth.2fa.enabled', row.user_code);
      return this.issue((await this.row(row.user_code))!, true);
    });
  }
  async requestAccess(name: string, email: string, module: string, scopes: string[]) {
    const normalized = this.normalizeScopes(scopes), key = emailLookup(email);
    if (!domainIds.includes(module)) throw new AuthError('Módulo inválido.');
    const code = 'REQ-' + randomUUID().slice(0, 8).toUpperCase();
    if ((await this.store.sql("SELECT 1 FROM access_requests WHERE email_lookup=? AND status='pending'", [key])).length) return { request_code: 'JÁ REGISTRADA', message: 'Solicitação recebida.' };
    await this.store.sql('INSERT INTO access_requests(id,request_code,requested_module,email,email_lookup,name,requested_scopes,created_at) VALUES (?,?,?,?,?,?,?,?)',
      [randomUUID(), code, module, protect(email.trim().toLowerCase()), key, protect(name), JSON.stringify(normalized), now()]);
    await this.store.audit('anonymous', 'auth.access.requested', code);
    return { request_code: code };
  }
  async requests() {
    return (await this.store.sql("SELECT * FROM access_requests WHERE status='pending' ORDER BY created_at")).map(r => ({ ...r, email: reveal(r.email), name: reveal(r.name), requested_scopes: JSON.parse(r.requested_scopes), email_lookup: undefined }));
  }
  async issueActivation(code: string, actor: string) {
    const row = await this.row(code, true);
    if (!row?.active || row.two_factor_enabled) throw new AuthError('Conta não elegível para ativação.');
    const token = secretToken(), expiry = seconds() + 86400;
    await this.store.sql('UPDATE account_activation_tokens SET used_at=? WHERE user_code=? AND used_at IS NULL', [now(), code]);
    await this.store.sql('UPDATE users SET two_factor_secret=NULL,last_totp_step=-1 WHERE user_code=?', [code]);
    await this.store.sql('INSERT INTO account_activation_tokens(token_hash,user_code,expires_at) VALUES (?,?,?)', [digest(token), code, expiry]);
    await this.revokeAll(code);
    await this.store.audit(actor, 'auth.activation.issued', code);
    return { user_code: code, activation_token: token, expires_at: expiry, activation_expires_at: expiry };
  }
  async decide(id: string, approve: boolean, scopes: string[], actor: string, note: string) {
    return this.store.transaction(async () => {
      const request = (await this.store.sql("SELECT * FROM access_requests WHERE id=? AND status='pending'" + this.lock, [id]))[0];
      if (!request) throw new AuthError('Solicitação já decidida ou inexistente.', 409);
      let result: Record<string, unknown> = { approved: false };
      if (approve) {
        if ((await this.store.sql('SELECT 1 FROM users WHERE email_lookup=?', [request.email_lookup])).length) throw new AuthError('Já existe uma conta para este e-mail.', 409);
        const prefix = request.requested_module.slice(0, 2).toUpperCase();
        const rows = await this.store.sql('SELECT user_code FROM users WHERE user_code LIKE ?', [prefix + '%']);
        const number = Math.max(0, ...rows.map(r => Number(r.user_code.slice(2)) || 0)) + 1;
        if (number > 999999) throw new AuthError('Limite de matrículas atingido.');
        const code = prefix + String(number).padStart(6, '0');
        await this.createUser({ code, name: reveal(request.name), email: reveal(request.email), passwordHash: 'pending-activation', scopes });
        result = await this.issueActivation(code, actor);
      }
      await this.store.sql('UPDATE access_requests SET status=?,decided_at=?,decided_by=?,decision_note=? WHERE id=?', [approve ? 'approved' : 'rejected', now(), actor, note, id]);
      await this.store.audit(actor, approve ? 'auth.access.approved' : 'auth.access.rejected', request.request_code);
      return result;
    });
  }
  async activationRow(code: string, token: string) {
    const record = (await this.store.sql('SELECT * FROM account_activation_tokens WHERE token_hash=? AND user_code=? AND used_at IS NULL AND expires_at>?' + this.lock, [digest(token), code, seconds()]))[0];
    const user = await this.row(code, true);
    if (!record || !user?.active || user.two_factor_enabled) throw new AuthError('Token de ativação inválido, expirado ou já utilizado.');
    return { record, user };
  }
  async activate(code: string, token: string, password?: string) {
    const hash = password ? await hashPassword(password) : undefined;
    return this.store.transaction(async () => {
      const { record, user } = await this.activationRow(code, token);
      if (hash) {
        if (record.password_set_at) throw new AuthError('Senha já criada. Use a opção de recuperar o QR.');
        await this.store.sql('UPDATE users SET password_hash=?,password_changed_at=?,must_change_password=0 WHERE user_code=?', [hash, now(), code]);
        await this.store.sql('UPDATE account_activation_tokens SET password_set_at=? WHERE token_hash=?', [now(), digest(token)]);
      } else if (!record.password_set_at) throw new AuthError('Defina a senha antes de recuperar o QR.');
      const secret = user.two_factor_secret ? reveal(user.two_factor_secret) : totpSecret();
      await this.store.sql('UPDATE users SET two_factor_secret=? WHERE user_code=?', [protect(secret), code]);
      return { ...await this.artifact(code, secret), message: 'Senha criada. Configure o autenticador para concluir.' };
    });
  }
  async activate2fa(code: string, token: string, otp: string) {
    return this.store.transaction(async () => {
      const { record, user } = await this.activationRow(code, token);
      const step = user.two_factor_secret ? verifyTotp(reveal(user.two_factor_secret), otp, Number(user.last_totp_step)) : undefined;
      if (!record.password_set_at || step === undefined) throw new AuthError('Código 2FA inválido ou senha ainda não criada.');
      await this.store.sql('UPDATE users SET two_factor_enabled=1,last_totp_step=? WHERE user_code=?', [step, code]);
      await this.store.sql('UPDATE account_activation_tokens SET used_at=? WHERE token_hash=?', [now(), digest(token)]);
      await this.store.audit(code, 'auth.activation.completed', code);
      return { message: 'Conta ativada. Aguarde o próximo código do autenticador e faça login.' };
    });
  }
  async issueReset(code: string, actor: string) {
    return this.store.transaction(async () => {
      if (!(await this.row(code, true))?.active) throw new AuthError('Conta não disponível.');
      const token = secretToken(), expiry = seconds() + 600;
      await this.store.sql('UPDATE password_reset_tokens SET used_at=? WHERE user_code=? AND used_at IS NULL', [now(), code]);
      await this.store.sql('INSERT INTO password_reset_tokens(token_hash,user_code,expires_at,created_at,created_by) VALUES (?,?,?,?,?)', [digest(token), code, expiry, now(), actor]);
      await this.revokeAll(code);
      await this.store.audit(actor, 'auth.reset.issued', code);
      return { user_code: code, reset_token: token, expires_at: expiry };
    });
  }
  async reset(code: string, token: string, password: string) {
    const hash = await hashPassword(password);
    return this.store.transaction(async () => {
      const record = (await this.store.sql('SELECT * FROM password_reset_tokens WHERE token_hash=? AND user_code=? AND used_at IS NULL AND expires_at>?' + this.lock, [digest(token), code, seconds()]))[0];
      if (!record || !(await this.row(code, true))?.active) throw new AuthError('Token inválido, expirado ou já utilizado.');
      await this.store.sql('UPDATE users SET password_hash=?,must_change_password=0,password_changed_at=? WHERE user_code=?', [hash, now(), code]);
      await this.store.sql('UPDATE password_reset_tokens SET used_at=? WHERE token_hash=?', [now(), digest(token)]);
      await this.revokeAll(code); await this.store.audit(code, 'auth.password.reset', code);
      return { message: 'Senha redefinida. Entre com sua senha e o código 2FA.' };
    });
  }
  async users() {
    const result = [];
    for (const row of await this.store.sql('SELECT * FROM users ORDER BY user_code')) {
      const sessions = await this.store.sql('SELECT session_id,created_at,last_seen_at,last_rotated_at,expires_at FROM sessions WHERE user_code=? AND revoked_at IS NULL AND expires_at>?', [row.user_code, seconds()]);
      result.push({ ...await this.user(row), session_count: sessions.length, tokens: sessions.map(s => ({ ...s, fingerprint: s.session_id.slice(0, 8), rotation_seconds: 600, session_id: undefined })) });
    }
    return { users: result, inactivity: { inactive_lock_days: await this.inactivityDays() } };
  }
  async setActive(code: string, active: boolean, reason: string, actor: string) {
    if ((await this.row(code))?.role === 'admin') throw new AuthError('Contas administrativas não podem ser bloqueadas por esta ação.');
    await this.store.sql('UPDATE users SET active=?,blocked_at=?,blocked_reason=?,last_seen_at=? WHERE user_code=?', [Number(active), active ? null : now(), active ? null : reason, now(), code]);
    await this.revokeAll(code); await this.store.audit(actor, active ? 'auth.user.activated' : 'auth.user.blocked', code);
  }
}

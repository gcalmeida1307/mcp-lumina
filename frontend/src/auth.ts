import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
let manager: UserManager | undefined;
let mode = 'local';
export const authMode = () => mode;
export async function waitForAuthConfig(timeoutMs = 180_000, retryMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const response = await fetch('/api/auth/config', { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))), cache: 'no-store' });
      if (response.ok) return await response.json();
      if (response.status < 500) throw new Error('Configuração de autenticação indisponível.');
    } catch (error) {
      if (error instanceof Error && error.message === 'Configuração de autenticação indisponível.') throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, remaining)));
  } while (Date.now() < deadline);
  throw new Error('A API do LUMINA ainda não respondeu. Verifique o terminal do servidor e clique em Tentar novamente.');
}
export async function initializeAuth() {
  const config = await waitForAuthConfig();
  mode = config.mode;
  if (mode === 'oidc') {
    manager = new UserManager({
      authority: config.authority, client_id: config.clientId,
      redirect_uri: location.origin + '/auth/callback',
      post_logout_redirect_uri: location.origin,
      response_type: 'code', scope: 'openid profile',
      userStore: new WebStorageStateStore({ store: sessionStorage }),
      automaticSilentRenew: false
    });
    if (location.pathname === '/auth/callback') {
      await manager.signinRedirectCallback();
      history.replaceState({}, '', '/');
    }
  }
}
export async function authHeaders(): Promise<Record<string, string>> {
  if (mode !== 'oidc') return { 'X-Lumina-Request': '1' };
  const user = await manager?.getUser();
  return user && !user.expired ? { Authorization: 'Bearer ' + user.access_token } : {};
}
export async function login() { await manager?.signinRedirect(); }
export async function nativeLogin(identifier: string, password: string, otp = '') {
  const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lumina-Request': '1' }, body: JSON.stringify({ identifier, password, otp }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? 'Usuário ou senha inválidos.');
  if (result.requires_2fa) throw new Error('Informe o código de seis dígitos do seu autenticador para entrar.');
  if (result.requires_activation) throw new Error('Sua conta precisa ser ativada. Use o token de ativação fornecido pelo administrador.');
  if (result.requires_password_reset) throw new Error('Sua senha precisa ser redefinida. Use o token fornecido pelo administrador.');
  if (!result.user) throw new Error('O login não foi concluído. Tente novamente.');
  return result;
}
export async function changePassword() {
  if (mode !== 'oidc' || !manager) throw new Error('Troca de senha disponível apenas com identidade institucional.');
  await manager.signinRedirect({ extraQueryParams: { kc_action: 'UPDATE_PASSWORD' } });
}
export async function logout() {
  if (mode === 'native') {
    const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Lumina-Request': '1' } });
    if (!response.ok) throw new Error('Não foi possível encerrar a sessão.');
    location.reload();
  } else await manager?.signoutRedirect();
}

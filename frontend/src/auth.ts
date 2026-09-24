import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
let manager: UserManager | undefined;
let mode = 'local';
export const authMode = () => mode;
export async function initializeAuth() {
  const response = await fetch('/api/auth/config');
  if (!response.ok) throw new Error('Não foi possível conectar ao LUMINA.');
  const config = await response.json();
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

import { useState } from 'react';
import { api } from './api';

export type Account = { must_change_password: boolean; two_factor_enabled: boolean };
type Setup = { qr_data_uri: string; secret: string };
const policy = 'Use de 8 a 256 caracteres, com maiúscula, minúscula, número e caractere especial.';

export function NativeAccount({ user, onDone }: { user?: Account; onDone: () => void }) {
  const [mode, setMode] = useState<'activation' | 'reset'>('activation');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [account, setAccount] = useState(user);
  const [setup, setSetup] = useState<Setup>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage('');
    try { await action(); } catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  }
  async function submit() {
    const post = (path: string, body: unknown) => api<any>('/auth/' + path, { method: 'POST', body: JSON.stringify(body) });
    if (account) {
      if (account.must_change_password) {
        const result = await post('password', { current_password: current, new_password: password });
        setAccount(result.user); setCurrent(''); setPassword('');
        if (result.user.two_factor_enabled) onDone();
      } else if (!setup) setSetup(await post('2fa/setup', {}));
      else { await post('2fa/enable', { code: otp }); onDone(); }
    } else if (mode === 'reset') {
      const result = await post('password/reset', { user_code: code, reset_token: token, new_password: password });
      setPassword(''); setToken(''); setMessage(result.message);
    } else if (!setup) {
      setSetup(await post(password ? 'activation' : 'activation/resume', { user_code: code, activation_token: token, ...(password ? { new_password: password } : {}) }));
      setPassword('');
    } else {
      const result = await post('activation/2fa', { user_code: code, activation_token: token, code: otp });
      setSetup(undefined); setToken(''); setOtp(''); setMessage(result.message);
    }
  }
  const needsPassword = account?.must_change_password || (!account && !setup);
  return <>
    <p>{account ? 'Conclua a configuração de segurança para acessar o LUMINA.' : 'Informe a matrícula e o token fornecidos pelo administrador.'}</p>
    {!account && <div><button className="button ghost" disabled={busy} onClick={() => { setMode('activation'); setSetup(undefined); setMessage(''); }}>Ativar conta</button><button className="button ghost" disabled={busy} onClick={() => { setMode('reset'); setSetup(undefined); setMessage(''); }}>Redefinir senha</button></div>}
    <form onSubmit={event => { event.preventDefault(); void perform(submit); }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12 }}>
        {!account && <><label>Matrícula<input required pattern="[A-Z]{2}[0-9]{6}" value={code} readOnly={Boolean(setup)} onChange={e => setCode(e.target.value.toUpperCase())} /></label><label>Token de {mode === 'activation' ? 'ativação' : 'redefinição'}<input required value={token} readOnly={Boolean(setup)} onChange={e => setToken(e.target.value.trim())} autoComplete="off" /></label></>}
        {account?.must_change_password && <label>Senha atual<input type="password" required autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>}
        {needsPassword && <label>Nova senha<input type="password" required={Boolean(account) || mode === 'reset'} minLength={8} maxLength={256} autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} /><span>{policy}{!account && mode === 'activation' && ' Se já criou a senha, deixe em branco para recuperar o QR.'}</span></label>}
        {setup && <><img src={setup.qr_data_uri} alt="QR para cadastrar o LUMINA no autenticador" style={{ width: 240, maxWidth: '100%', margin: 'auto' }} /><label>Chave para cadastro manual<input readOnly value={setup.secret} /></label><label>Código do autenticador<input required pattern="[0-9]{6}" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={e => setOtp(e.target.value)} /></label></>}
        <button className="button primary login-button" type="submit">{busy ? 'Aguarde...' : setup ? 'Confirmar 2FA' : needsPassword ? 'Continuar' : 'Configurar autenticador'}</button>
      </fieldset>
    </form>
    {message && <p role="status">{message}</p>}
  </>;
}

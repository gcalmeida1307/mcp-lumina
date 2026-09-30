export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    const detail = status === 401
      ? 'A chave de API foi rejeitada. Verifique a credencial do provedor no servidor e reinicie a API.'
      : status === 403
        ? 'O provedor negou acesso. Verifique as permissões da chave e do modelo configurado.'
        : status === 429
          ? 'O provedor atingiu um limite de uso. Verifique a cota e os limites da conta antes de tentar novamente.'
          : status >= 500
            ? 'O provedor está temporariamente indisponível. Tente novamente em instantes.'
            : 'Verifique o modelo e a configuração do provedor no servidor.';
    super('Provedor de IA retornou HTTP ' + status + '. ' + detail);
    this.name = 'ProviderHttpError';
  }
}

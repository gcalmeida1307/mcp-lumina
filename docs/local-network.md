# Acesso pela rede local

Endereço configurado nesta máquina: **http://172.18.1.43:8080**.

O processo `scripts/lan-server.mjs` recebe conexões na porta TCP 8080 e encaminha para a aplicação compilada e API existentes em `127.0.0.1:4000`. O servidor Vite e os arquivos-fonte não são publicados por esse processo. A autenticação nativa e as permissões dos documentos continuam obrigatórias.

## Firewall (executar uma vez como administrador)

A sessão de configuração recebeu “Acesso negado” do Windows ao tentar criar a regra. Abra o PowerShell como administrador e execute:

```powershell
& 'C:\Users\glauco.almeida\Documents\LUMINA\scripts\enable-lan-firewall.ps1'
```

A regra permite TCP 8080 somente da sub-rede local, nos perfis Domínio/Privado. Não muda o perfil da rede nem desliga o firewall. Políticas corporativas podem exigir intervenção da equipe de TI.

## Uso

Nos demais computadores da mesma rede, abra o endereço acima e use o login do LUMINA. Este computador precisa continuar ligado e conectado. Se o endereço IP mudar por DHCP, consulte o endereço atual mostrado por `npm run start:lan`.

Para iniciar novamente após fechar os processos ou reiniciar o Windows, no diretório do projeto:

1. Execute `npm run build` quando houver mudanças no frontend.
2. Inicie `npm run dev:api` (ou mantenha a API existente na porta 4000).
3. Em outro terminal, execute `npm run start:lan`.

Não foi instalado serviço com inicialização automática no Windows. Nesta configuração, a aplicação continua usando seu ambiente atual e a autenticação native. Não habilite `AUTH_MODE=local` para exposição na rede.

## Voz e HTTPS

O acesso LAN configurado é HTTP. O chat textual funciona, mas o microfone em outro computador exige uma origem segura (HTTPS com certificado confiável nos clientes). O aplicativo explica essa limitação ao tentar iniciar a voz. Não foram alteradas configurações de segurança dos navegadores. Para voz na rede, é necessário configurar hostname e certificado confiável, normalmente com apoio da TI. O HTTP também não criptografa o tráfego do login.

## Verificação realizada

- Servidor ouvindo em `0.0.0.0:8080`.
- Página retornou HTTP 200 pelo IP `172.18.1.43` nesta máquina.
- Autenticação nativa confirmada; consulta anônima aos documentos retornou HTTP 401.
- Teste de ID de conversa cobre navegador sem `crypto.randomUUID`, como ocorre em origens HTTP de rede.
- Não houve teste originado de outro computador; o acesso externo depende do firewall e das regras da rede.

Logs da instância iniciada durante a configuração: `work/lan/server.log` e `work/lan/server-error.log`.

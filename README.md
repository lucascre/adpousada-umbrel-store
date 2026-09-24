# Loja comunitária do Umbrel — AD Pousada

Apps próprios da igreja que não existem na loja oficial do Umbrel. Esta pasta é
publicada como repositório **público** à parte
(`github.com/lucascre/adpousada-umbrel-store`), porque o Umbrel só instala loja
comunitária a partir da raiz de um repositório git. Nada aqui pode conter senha:
as senhas entram como variáveis do app, no próprio Umbrel.

Para adicionar no Umbrel: **Loja de aplicativos → ⋯ → Lojas comunitárias →**
colar a URL do repositório.

## adpousada-gravador

Grava a live direto para o acervo. Gravar e parar ficam no painel do site
(`/admin/audiencia`); o gravador pergunta ao site a cada 5 s o que fazer
(`/api/gravador`), então nada no Umbrel precisa ser exposto na internet.

Caminho do culto: HLS do Restreamer → pedaços `.ts` (sobrevivem a queda da
live e a reinício do app) → MP4 com `faststart` → cópia direta no disco
para `acervo/cultos/` → o site cadastra o `Titulo` tipo culto, já publicado.

Variáveis que precisam ser definidas no Umbrel depois de instalar:

| Variável | Valor |
|---|---|
| `GRAVADOR_TOKEN` | o mesmo valor configurado na Vercel |
| `LIVE_URL` | `http://192.168.0.160:8135/memfs/<id-do-canal>.m3u8` |

A pasta `acervo/cultos` do copyparty já vem montada pelo `docker-compose.yml`
(`${UMBREL_ROOT}/app-data/copyparty/...`), com `DESTINO_DIR=/acervo/cultos`. As
configurações do Umbrel não servem para isso: só aceitam montagem vinda de
`/Home`, de disco externo ou de rede. Ao ligar, o gravador cria
`acervo/cultos/.gravador-conectado`; se esse arquivo aparecer ali, a montagem
está certa.

`COPYPARTY_SENHA` só é usada se `DESTINO_DIR` ficar vazio — e a senha de
escrita do `.env.local` não existe no copyparty (verificado em 24/09/2026:
403 em qualquer pasta).

Testado em 24/09/2026 num contêiner `node:22-alpine` com live, site e
copyparty simulados: live derrubada por 10 s no meio da gravação, e o MP4 final
saiu inteiro (h264 + aac), subiu e foi cadastrado uma vez só.

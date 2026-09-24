# Imagem do gravador, publicada pelo GitHub Actions em
# ghcr.io/lucascre/adpousada-gravador:<versão do umbrel-app.yml>.
#
# O código vai dentro da imagem, não montado da pasta do app: numa
# atualização o Umbrel troca o docker-compose.yml mas mantém os outros
# arquivos da pasta, então um gravador.mjs montado ficaria na versão da
# primeira instalação para sempre.
FROM node:22-alpine
RUN apk add --no-cache ffmpeg
COPY gravador.mjs envio.mjs /app/
CMD ["node", "/app/gravador.mjs"]

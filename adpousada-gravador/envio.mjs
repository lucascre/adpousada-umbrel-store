// Envio de vídeos e imagens do painel para o AD Play.
//
// O navegador de quem administra manda o arquivo direto para cá, em pedaços:
// a Cloudflare corta qualquer requisição acima de 100 MB, e um filme tem
// gigabytes. Pedaço por pedaço, o envio também retoma de onde parou se a
// conexão cair — o painel pergunta quanto já chegou e continua dali.
//
// Quem autoriza é o site: ele assina (HMAC com o mesmo GRAVADOR_TOKEN) uma
// permissão curta que diz em qual pasta do AD Play se pode gravar. Aqui só se
// confere a assinatura. Sem ela, nada entra — e nenhuma senha do servidor
// chega ao navegador de ninguém.
//
//   POST /envio?t=<permissão>                 { nome, tamanho } → { id, recebido }
//   PUT  /envio/<id>?t=<permissão>&de=<byte>  pedaço            → { recebido }
//   POST /envio/<id>/concluir?t=<permissão>                      → { caminho }

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, normalize } from "node:path";

const segredo = process.env.GRAVADOR_TOKEN || "";
const raiz = process.env.ACERVO_DIR || "/acervo";
const dirControle = process.env.DIR_ENVIOS || "/data/envios";
const porta = Number(process.env.ENVIO_PORT || 8341);

/** Acima disto um pedaço é recusado: a Cloudflare barraria antes, e mal. */
const PEDACO_MAXIMO = 95 * 1024 * 1024;

const EXTENSOES = [".mp4", ".mkv", ".m4v", ".webm", ".mov", ".ts", ".mp3", ".m4a", ".jpg", ".jpeg", ".png", ".webp"];

// ─── Permissão assinada pelo site ────────────────────────────────────────────

function conferir(token) {
  if (!segredo || !token) return null;
  const [dados, assinatura] = String(token).split(".");
  if (!dados || !assinatura) return null;

  const esperada = createHmac("sha256", segredo).update(dados).digest("base64url");
  const a = Buffer.from(esperada);
  const b = Buffer.from(assinatura);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const p = JSON.parse(Buffer.from(dados, "base64url").toString("utf8"));
    if (typeof p.pasta !== "string" || !(p.exp * 1000 > Date.now())) return null;
    return p;
  } catch {
    return null;
  }
}

/** A pasta pedida, sem nenhum jeito de escapar da raiz do AD Play. */
function pastaSegura(pasta) {
  const limpa = normalize(`/${pasta}`).replace(/\\/g, "/");
  if (limpa.includes("..")) return null;
  return join(raiz, limpa);
}

/** Só o nome, sem caminho, e sem nada que o sistema de arquivos estranhe. */
function nomeSeguro(nome) {
  const n = basename(String(nome || "")).replace(/[\u0000-\u001f<>:"|?*\\/]/g, "").trim();
  if (!n || n.startsWith(".")) return null;
  const minusculo = n.toLowerCase();
  if (!EXTENSOES.some((e) => minusculo.endsWith(e))) return null;
  return n.slice(0, 200);
}

// ─── Estado de cada envio ────────────────────────────────────────────────────
//
// Fica em disco, e não na memória, para o envio sobreviver a um reinício do
// app no meio de um filme de 3 GB.

async function lerEnvio(id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return readFile(join(dirControle, `${id}.json`), "utf8").then(JSON.parse, () => null);
}

async function tamanhoParcial(envio) {
  return stat(envio.parcial).then((s) => s.size, () => 0);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function responder(res, status, corpo) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    // A permissão é o que protege, não a origem: o painel roda no site e,
    // nos testes, em localhost.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(corpo));
}

function lerJson(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(d));
      } catch {
        resolve(null);
      }
    });
  });
}

async function iniciar(req, res, permissao) {
  const corpo = await lerJson(req);
  const nome = nomeSeguro(corpo?.nome);
  const tamanho = Number(corpo?.tamanho);
  const pasta = pastaSegura(permissao.pasta);
  if (!nome) return responder(res, 400, { erro: "Tipo de arquivo não aceito." });
  if (!pasta || !(tamanho > 0)) return responder(res, 400, { erro: "Pedido inválido." });

  await stat(pasta).catch(() => mkdir(pasta, { recursive: true }));

  // O mesmo arquivo para a mesma pasta dá o mesmo id: é o que deixa o painel
  // retomar um envio interrompido em vez de começar do zero.
  const id = createHash("sha256").update(`${pasta}|${nome}|${tamanho}`).digest("hex").slice(0, 32);
  let envio = await lerEnvio(id);
  if (!envio) {
    envio = { id, pasta, nome, tamanho, parcial: join(pasta, `.${nome}.${id.slice(0, 8)}.parcial`) };
    await mkdir(dirControle, { recursive: true });
    await writeFile(join(dirControle, `${id}.json`), JSON.stringify(envio));
  }
  responder(res, 200, { id, recebido: await tamanhoParcial(envio) });
}

async function receberPedaco(req, res, envio, de) {
  const recebido = await tamanhoParcial(envio);
  // Pedaço fora de ordem (repetido depois de uma queda, por exemplo): diz ao
  // painel de onde continuar em vez de corromper o arquivo.
  if (de !== recebido) return responder(res, 409, { recebido });

  let bytes = 0;
  const saida = createWriteStream(envio.parcial, { flags: "a" });
  req.on("data", (c) => {
    bytes += c.length;
    if (bytes > PEDACO_MAXIMO) req.destroy();
  });
  req.pipe(saida);
  saida.on("finish", async () => responder(res, 200, { recebido: await tamanhoParcial(envio) }));
  saida.on("error", () => responder(res, 500, { erro: "Falha ao gravar no disco." }));
  req.on("aborted", () => saida.end());
}

async function concluir(res, envio) {
  const recebido = await tamanhoParcial(envio);
  if (recebido !== envio.tamanho) {
    return responder(res, 409, { erro: "O arquivo ainda não chegou inteiro.", recebido });
  }

  // Nunca sobrescreve: um "Culto.mp4" já existente vira "Culto (2).mp4".
  const ponto = envio.nome.lastIndexOf(".");
  const base = envio.nome.slice(0, ponto);
  const ext = envio.nome.slice(ponto);
  let final = envio.nome;
  for (let n = 2; await stat(join(envio.pasta, final)).then(() => true, () => false); n++) {
    final = `${base} (${n})${ext}`;
  }

  await rename(envio.parcial, join(envio.pasta, final));
  await rm(join(dirControle, `${envio.id}.json`), { force: true });

  const caminho = join(envio.pasta, final).slice(raiz.length).replace(/^\/+/, "");
  console.log(`${new Date().toISOString()} [envio] recebido ${caminho} (${envio.tamanho} bytes)`);
  responder(res, 200, { caminho });
}

export function iniciarServidorDeEnvio() {
  if (!segredo) {
    console.log("[envio] GRAVADOR_TOKEN ausente — envio desligado.");
    return;
  }

  createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return responder(res, 200, {});

      const url = new URL(req.url, "http://x");
      const partes = url.pathname.split("/").filter(Boolean); // ["envio", id?, "concluir"?]
      if (partes[0] !== "envio") return responder(res, 404, { erro: "Não encontrado." });

      const permissao = conferir(url.searchParams.get("t"));
      if (!permissao) return responder(res, 401, { erro: "Permissão de envio vencida. Recarregue a página." });

      if (req.method === "POST" && partes.length === 1) return await iniciar(req, res, permissao);

      const envio = await lerEnvio(partes[1] ?? "");
      // O envio precisa ser da mesma pasta que a permissão libera.
      if (!envio || envio.pasta !== pastaSegura(permissao.pasta)) {
        return responder(res, 404, { erro: "Envio não encontrado." });
      }

      if (req.method === "PUT" && partes.length === 2) {
        return await receberPedaco(req, res, envio, Number(url.searchParams.get("de")));
      }
      if (req.method === "POST" && partes[2] === "concluir") return await concluir(res, envio);

      responder(res, 404, { erro: "Não encontrado." });
    } catch (e) {
      console.log(`[envio] erro: ${e.message}`);
      if (!res.headersSent) responder(res, 500, { erro: "Erro no servidor." });
    }
  }).listen(porta, () => console.log(`${new Date().toISOString()} [envio] ouvindo em :${porta}`));
}

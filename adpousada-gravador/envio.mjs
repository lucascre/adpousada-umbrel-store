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
//
// E junta vídeos que já estão no AD Play num só — o culto gravado em
// pedaços de 30 minutos vira um arquivo (ver juntar(), mais abaixo):
//
//   POST /envio/juntar?t=<permissão>   { arquivos: [caminho…], nome, apagarPartes }
//                                                                → { id }
//   GET  /envio/juntar/<id>?t=<permissão>                        → { estado, caminho?, duracao?, erro? }
//
// E entrega os vídeos para quem assiste (ver servirMidia()):
//
//   GET  /envio/midia/<caminho>?e=<expira>&s=<assinatura>        → o arquivo, com Range

import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, join, normalize } from "node:path";

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
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
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
  pedirFaststart(join(envio.pasta, final));

  const caminho = join(envio.pasta, final).slice(raiz.length).replace(/^\/+/, "");
  console.log(`${new Date().toISOString()} [envio] recebido ${caminho} (${envio.tamanho} bytes)`);
  responder(res, 200, { caminho });
}

// ─── Juntar partes ───────────────────────────────────────────────────────────
//
// O servidor antigo gravava a live em arquivos de 30 minutos; um culto de
// duas horas virava quatro vídeos. Aqui eles viram um MP4 só, na pasta da
// permissão (cultos), pronto para streaming (faststart).
//
// Primeiro tenta sem converter (-c copy): segundos, e sem perder qualidade.
// Se as partes não casarem (resolução ou codec diferentes), converte — aí
// leva perto do tempo do vídeo, e o painel fica acompanhando.

/** Trabalhos em andamento e recentes, pelo id. */
const juntando = new Map();

function rodarFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let erro = "";
    p.stderr.on("data", (d) => (erro = (erro + d).slice(-1500)));
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(erro.trim() || `ffmpeg saiu com ${c}`))));
  });
}

function duracaoDoVideo(arquivo) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", arquivo]);
    let saida = "";
    p.stdout.on("data", (d) => (saida += d));
    p.on("close", () => resolve(Math.round(Number(saida.trim())) || 0));
  });
}

async function iniciarJuntar(req, res, permissao) {
  const corpo = await lerJson(req);
  const destinoDir = pastaSegura(permissao.pasta);
  const nome = nomeSeguro(corpo?.nome);
  const lista = Array.isArray(corpo?.arquivos) ? corpo.arquivos.map((a) => pastaSegura(String(a))) : [];

  if (!destinoDir || !nome || !nome.toLowerCase().endsWith(".mp4")) {
    return responder(res, 400, { erro: "Nome do culto inválido." });
  }
  if (lista.length < 2 || lista.length > 40 || lista.some((a) => !a)) {
    return responder(res, 400, { erro: "Escolha de 2 a 40 partes." });
  }
  for (const a of lista) {
    const existe = await stat(a).then((s) => s.isFile(), () => false);
    if (!existe) return responder(res, 400, { erro: `Parte não encontrada: ${basename(a)}` });
  }

  const id = randomBytes(12).toString("hex");
  const trabalho = { estado: "juntando", modo: "rapido", inicio: Date.now() };
  juntando.set(id, trabalho);
  responder(res, 200, { id });

  const dirTrabalho = join(dirControle, `juntar-${id}`);
  try {
    await mkdir(dirTrabalho, { recursive: true });
    await mkdir(destinoDir, { recursive: true });
    const txt = join(dirTrabalho, "lista.txt");
    // Aspas simples no nome do arquivo quebram a lista do concat: viram '\''.
    await writeFile(txt, lista.map((a) => `file '${a.replace(/'/g, "'\\''")}'`).join("\n"));

    // Nunca sobrescreve: um culto com o mesmo nome vira "(2)".
    const ponto = nome.lastIndexOf(".");
    let final = nome;
    for (let n = 2; await stat(join(destinoDir, final)).then(() => true, () => false); n++) {
      final = `${nome.slice(0, ponto)} (${n})${nome.slice(ponto)}`;
    }
    const parcial = join(destinoDir, `.${final}.parcial`);

    const base = ["-f", "concat", "-safe", "0", "-i", txt, "-map", "0:v?", "-map", "0:a?"];
    try {
      await rodarFfmpeg([...base, "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", "-f", "mp4", parcial]);
    } catch (e) {
      console.log(`[juntar] ${id} sem converter falhou (${e.message.slice(0, 200)}); convertendo`);
      trabalho.modo = "convertendo";
      await rodarFfmpeg([...base, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4", parcial]);
    }

    await rename(parcial, join(destinoDir, final));
    const duracao = await duracaoDoVideo(join(destinoDir, final));
    if (corpo.apagarPartes) {
      for (const a of lista) await rm(a, { force: true });
    }

    Object.assign(trabalho, {
      estado: "pronto",
      caminho: join(destinoDir, final).slice(raiz.length).replace(/^\/+/, ""),
      duracao,
    });
    console.log(`${new Date().toISOString()} [juntar] ${lista.length} partes → ${trabalho.caminho} (${duracao}s)`);
  } catch (e) {
    Object.assign(trabalho, { estado: "erro", erro: e.message.slice(0, 300) });
    console.log(`[juntar] ${id} erro: ${e.message}`);
  } finally {
    await rm(dirTrabalho, { recursive: true, force: true });
    // Some da memória depois de uma hora: o painel já leu o resultado.
    setTimeout(() => juntando.delete(id), 3600_000);
  }
}

// ─── Servir os vídeos ────────────────────────────────────────────────────────
//
// Antes o vídeo passava pelo site (/api/midia na Vercel, nos EUA): cada
// pedaço de 8 MB ia do Brasil até lá e voltava, levava de 12 a 29 s, e a
// função morre aos 30. O player esperava, travava e às vezes desistia. Daqui
// o arquivo sai do disco direto para quem assiste, numa conexão só.
//
// Quem libera é o site: ele assina (HMAC com o GRAVADOR_TOKEN) o caminho e o
// prazo, só para membro aprovado. Link repassado vale só até o prazo.

const TIPOS_MIDIA = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".ts": "video/mp2t", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
};

function assinaturaDaMidia(caminho, expira) {
  return createHmac("sha256", segredo).update(`midia|${caminho}|${expira}`).digest("base64url");
}

async function servirMidia(req, res, url) {
  const cabecalhos = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
  const negar = (status, texto) => {
    res.writeHead(status, { ...cabecalhos, "Content-Type": "text/plain; charset=utf-8" });
    res.end(texto);
  };

  let caminho;
  try {
    caminho = url.pathname.split("/").slice(3).map(decodeURIComponent).join("/");
  } catch {
    return negar(400, "Endereço inválido.");
  }
  const expira = url.searchParams.get("e") || "";
  const recebida = url.searchParams.get("s") || "";
  const esperada = assinaturaDaMidia(caminho, expira);
  const valida =
    Number(expira) * 1000 > Date.now() &&
    recebida.length === esperada.length &&
    timingSafeEqual(Buffer.from(recebida), Buffer.from(esperada));
  if (!valida) return negar(403, "Endereço expirado. Abra o vídeo pelo app de novo.");

  const arquivo = pastaSegura(caminho);
  const tipo = TIPOS_MIDIA[extname(caminho).toLowerCase()];
  if (!arquivo || !tipo) return negar(404, "Não encontrado.");
  const info = await stat(arquivo).catch(() => null);
  if (!info?.isFile()) return negar(404, "Vídeo não encontrado.");

  const total = info.size;
  const faixa = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  let inicio = 0;
  let fim = total - 1;
  if (faixa) {
    if (faixa[1] === "" && faixa[2] !== "") {
      inicio = Math.max(0, total - Number(faixa[2]));
    } else {
      inicio = Number(faixa[1] || 0);
      if (faixa[2] !== "") fim = Math.min(Number(faixa[2]), total - 1);
    }
    if (inicio > fim || inicio >= total) {
      res.writeHead(416, { ...cabecalhos, "Content-Range": `bytes */${total}` });
      return res.end();
    }
  }

  res.writeHead(faixa ? 206 : 200, {
    ...cabecalhos,
    "Content-Type": tipo,
    "Accept-Ranges": "bytes",
    "Content-Length": String(fim - inicio + 1),
    ...(faixa ? { "Content-Range": `bytes ${inicio}-${fim}/${total}` } : {}),
    // O endereço é assinado por pessoa e por prazo: nada de cache compartilhado.
    "Cache-Control": "private, max-age=0, no-store",
  });
  if (req.method === "HEAD") return res.end();

  const leitura = createReadStream(arquivo, { start: inicio, end: fim, highWaterMark: 1024 * 1024 });
  leitura.pipe(res);
  req.on("close", () => leitura.destroy());
}

// ─── Índice no começo (faststart) ────────────────────────────────────────────
//
// MP4 com o índice (moov) no fim obriga o player a baixar o fim do arquivo
// antes de mostrar o primeiro quadro — pela internet, é a espera que parece
// travamento ao escolher um episódio. Todo MP4 que chega é conferido e, se
// preciso, reescrito sem converter nada (-c copy, alguns segundos).

async function indiceNoFim(arquivo) {
  const f = await open(arquivo, "r").catch(() => null);
  if (!f) return false;
  try {
    const { size } = await f.stat();
    const cab = Buffer.alloc(16);
    let pos = 0;
    let viuMdat = false;
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      await f.read(cab, 0, 16, pos);
      let tamanho = cab.readUInt32BE(0);
      const tipo = cab.toString("latin1", 4, 8);
      if (tamanho === 1) tamanho = Number(cab.readBigUInt64BE(8));
      if (tamanho === 0) tamanho = size - pos;
      if (tamanho < 8) return false;
      if (tipo === "mdat") viuMdat = true;
      if (tipo === "moov") return viuMdat;
      pos += tamanho;
    }
    return false;
  } finally {
    await f.close();
  }
}

const filaFaststart = [];
let reescrevendo = false;

function pedirFaststart(arquivo) {
  if (!/\.(mp4|m4v|mov)$/i.test(arquivo) || filaFaststart.includes(arquivo)) return;
  filaFaststart.push(arquivo);
  if (!reescrevendo) processarFaststart();
}

async function processarFaststart() {
  reescrevendo = true;
  while (filaFaststart.length) {
    const arquivo = filaFaststart.shift();
    try {
      if (!(await indiceNoFim(arquivo))) continue;
      const temp = join(dirname(arquivo), `.${basename(arquivo)}.faststart`);
      await rodarFfmpeg(["-i", arquivo, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", temp]);
      await rename(temp, arquivo);
      console.log(`${new Date().toISOString()} [faststart] índice movido para o começo: ${arquivo.slice(raiz.length)}`);
    } catch (e) {
      console.log(`[faststart] ${arquivo}: ${e.message.slice(0, 200)}`);
    }
  }
  reescrevendo = false;
}

/** Ao ligar: confere os vídeos que já estão no AD Play. */
async function varrerAcervo(dir = raiz, nivel = 0) {
  if (nivel > 6) return;
  const itens = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const item of itens) {
    if (item.name.startsWith(".")) continue;
    const caminho = join(dir, item.name);
    if (item.isDirectory()) await varrerAcervo(caminho, nivel + 1);
    else if (/\.(mp4|m4v|mov)$/i.test(item.name) && (await indiceNoFim(caminho))) pedirFaststart(caminho);
  }
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

      // O vídeo para quem assiste: a assinatura vem na própria URL.
      if (partes[1] === "midia" && (req.method === "GET" || req.method === "HEAD")) {
        return await servirMidia(req, res, url);
      }

      const permissao = conferir(url.searchParams.get("t"));
      if (!permissao) return responder(res, 401, { erro: "Permissão de envio vencida. Recarregue a página." });

      if (req.method === "POST" && partes.length === 1) return await iniciar(req, res, permissao);

      if (partes[1] === "juntar") {
        if (req.method === "POST" && partes.length === 2) return await iniciarJuntar(req, res, permissao);
        const t = juntando.get(partes[2] ?? "");
        if (req.method === "GET" && t) return responder(res, 200, t);
        return responder(res, 404, { erro: "Trabalho não encontrado." });
      }

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
  }).listen(porta, () => {
    console.log(`${new Date().toISOString()} [envio] ouvindo em :${porta}`);
    varrerAcervo().catch((e) => console.log(`[faststart] varredura: ${e.message}`));
  });
}

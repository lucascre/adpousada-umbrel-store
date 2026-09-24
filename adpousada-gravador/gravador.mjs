// Gravador da live da AD Pousada.
//
// Roda no Umbrel, ao lado do Restreamer. A cada poucos segundos pergunta ao
// site (GET /api/gravador) se o painel pediu para gravar. Quando sim, puxa o
// HLS da live com ffmpeg, sem converter nada (-c copy), em pedaços .ts. Quando
// o painel manda parar: junta os pedaços num MP4 pronto para streaming, sobe
// para a pasta de cultos do copyparty e avisa o site, que cadastra o culto no
// acervo.
//
// Por que pedaços: se a live cai no meio do culto, o ffmpeg termina. O
// gravador abre outro pedaço assim que ela volta, e no fim tudo vira um
// arquivo só.
//
// Por que .ts e não .mp4 direto: MP4 interrompido (queda de energia, app
// reiniciado) fica ilegível, porque o índice só é escrito no fim. O .ts vale
// até o último byte gravado.
//
// Sem dependências: só Node 22 e ffmpeg.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { iniciarServidorDeEnvio } from "./envio.mjs";

const cfg = {
  site: (process.env.SITE_URL || "https://www.adpousada.com.br").replace(/\/+$/, ""),
  token: process.env.GRAVADOR_TOKEN || "",
  live: process.env.LIVE_URL || "",
  copyparty: (process.env.COPYPARTY_URL || "http://192.168.0.160:3923").replace(/\/+$/, ""),
  pasta: (process.env.COPYPARTY_PASTA || "acervo/cultos").replace(/^\/+|\/+$/g, ""),
  senha: process.env.COPYPARTY_SENHA || "",
  dir: process.env.DIR_GRAVACOES || "/data/gravacoes",
  // A pasta de cultos montada direto no contêiner. Com ela, o MP4 é copiado
  // no disco e o copyparty não entra no caminho (nem a senha dele).
  destino: process.env.DESTINO_DIR || "",
  intervalo: Number(process.env.INTERVALO_SEGUNDOS || 5) * 1000,
  porta: Number(process.env.PORT || 8080),
};

/** O caminho no acervo começa depois de "acervo/": é o que o site guarda. */
const PREFIXO_ACERVO = cfg.pasta.replace(/^acervo\/?/, "");

// ─── Estado ──────────────────────────────────────────────────────────────────

/** Gravação em curso: { id, titulo, inicio, dir, parte, proc } */
let atual = null;
/** Gravações paradas esperando virar MP4 e subir. Processadas uma por vez. */
const fila = [];
let ocupado = null; // "finalizando" | "enviando" | null
let ultimoErro = null;
let ultimo = null; // { nome, slug }
const log = [];

function registrar(msg) {
  const linha = `${new Date().toISOString()} ${msg}`;
  console.log(linha);
  log.push(linha);
  if (log.length > 200) log.shift();
}

// ─── Conversa com o site ─────────────────────────────────────────────────────

async function site(metodo, corpo) {
  const r = await fetch(`${cfg.site}/api/gravador`, {
    method: metodo,
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`site respondeu ${r.status}`);
  return r.json();
}

function situacao() {
  if (atual) {
    return {
      estado: "gravando",
      desde: atual.inicio,
      segundos: Math.floor((Date.now() - new Date(atual.inicio).getTime()) / 1000),
      mensagem: semSinal() ? "Nada chegando da live: ela está fora do ar? A gravação continua assim que ela voltar." : null,
      ultimo,
    };
  }
  if (ocupado) return { estado: ocupado, ultimo };
  if (ultimoErro) return { estado: "erro", mensagem: ultimoErro, ultimo };
  return { estado: "parado", ultimo };
}

/** Há mais de 20 s nenhum byte novo entra no arquivo. */
function semSinal() {
  return Date.now() - atual.recebendoEm > 20_000;
}

/** Confere se o pedaço atual cresceu desde o último ciclo. */
async function medirSinal() {
  if (!atual?.arquivo) return;
  const tamanho = await stat(atual.arquivo).then((s) => s.size, () => 0);
  if (tamanho > atual.tamanho) atual.recebendoEm = Date.now();
  atual.tamanho = tamanho;
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────

function rodar(args, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    let erro = "";
    p.stderr.on("data", (d) => (erro = (erro + d).slice(-2000)));
    const t = timeoutMs ? setTimeout(() => p.kill("SIGKILL"), timeoutMs) : null;
    p.on("close", (codigo) => {
      if (t) clearTimeout(t);
      codigo === 0 ? resolve() : reject(new Error(`ffmpeg saiu com ${codigo}: ${erro.trim()}`));
    });
  });
}

function duracaoDe(arquivo) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", arquivo]);
    let saida = "";
    p.stdout.on("data", (d) => (saida += d));
    p.on("close", () => resolve(Math.round(Number(saida.trim())) || 0));
  });
}

function abrirPedaco() {
  atual.parte += 1;
  const parte = atual.parte;
  const arquivo = join(atual.dir, `parte-${String(atual.parte).padStart(3, "0")}.ts`);
  const proc = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "warning",
    // Sem resposta do servidor por 20 s, desiste — o próximo ciclo tenta de novo.
    "-rw_timeout", "20000000",
    "-i", cfg.live,
    "-map", "0:v?", "-map", "0:a?", "-c", "copy",
    "-f", "mpegts", arquivo,
  ]);
  proc.stderr.on("data", (d) => {
    const t = String(d).trim();
    if (t) registrar(`[ffmpeg] ${t.slice(0, 300)}`);
  });
  proc.on("close", (codigo) => {
    registrar(`pedaço ${parte} fechado (código ${codigo})`);
    if (atual && atual.proc === proc) atual.proc = null;
  });
  atual.proc = proc;
  atual.arquivo = arquivo;
  atual.tamanho = 0;
  registrar(`gravando pedaço ${atual.parte}`);
}

function fecharPedaco(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.on("close", () => resolve());
    // "q" é o jeito educado de pedir ao ffmpeg para fechar o arquivo.
    proc.stdin.write("q");
    setTimeout(() => proc.kill("SIGKILL"), 15_000);
  });
}

// ─── Começar e parar ─────────────────────────────────────────────────────────

async function iniciar(pedido, continuar) {
  const dir = join(cfg.dir, pedido.id);
  await mkdir(dir, { recursive: true });

  const meta = continuar ?? { id: pedido.id, titulo: pedido.titulo, inicio: new Date().toISOString() };
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta));

  const partes = (await readdir(dir)).filter((f) => f.endsWith(".ts")).length;
  // recebendoEm começa agora: os primeiros 20 s são de tolerância, o tempo de
  // o ffmpeg abrir a live.
  atual = { ...meta, dir, parte: partes, proc: null, arquivo: null, tamanho: 0, recebendoEm: Date.now() };
  ultimoErro = null;
  registrar(`${continuar ? "retomando" : "iniciando"} gravação "${meta.titulo}"`);
  abrirPedaco();
}

async function parar() {
  const g = atual;
  atual = null;
  await fecharPedaco(g.proc);
  registrar(`gravação "${g.titulo}" parada; entrando na fila`);
  fila.push(g.dir);
  processarFila();
}

// ─── Do .ts ao acervo ────────────────────────────────────────────────────────

function nomeDoArquivo(meta) {
  const quando = new Date(meta.inicio);
  const sp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(quando); // "2026-09-24 20:05"
  const [data, hora] = sp.split(" ");
  const titulo = (meta.titulo || "culto")
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "culto";
  return `${data}-${hora.replace(":", "")}-${titulo}.mp4`;
}

async function enviar(arquivo, nome) {
  if (cfg.destino) {
    // Pasta que não existe é montagem que faltou: gravar ali perderia o culto
    // dentro do contêiner, sem ninguém ver.
    await stat(cfg.destino).catch(() => {
      throw new Error(`DESTINO_DIR ${cfg.destino} não está montado.`);
    });
    // Copia com outro nome e só então renomeia: quem abrir a pasta no meio da
    // cópia não vê um culto pela metade.
    const parcial = join(cfg.destino, `.${nome}.parcial`);
    await copyFile(arquivo, parcial);
    await rename(parcial, join(cfg.destino, nome));
    return;
  }

  const { size } = await stat(arquivo);
  const r = await fetch(`${cfg.copyparty}/${cfg.pasta}/${nome}`, {
    method: "PUT",
    headers: { PW: cfg.senha, "Content-Length": String(size), "Content-Type": "video/mp4" },
    body: createReadStream(arquivo),
    duplex: "half",
  });
  if (!r.ok) throw new Error(`copyparty respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function finalizar(dir) {
  const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8"));
  const pronto = join(dir, "pronto.json");
  let feito = await readFile(pronto, "utf8").then(JSON.parse).catch(() => null);

  if (!feito) {
    ocupado = "finalizando";
    const partes = [];
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".ts")).sort()) {
      if ((await stat(join(dir, f))).size > 0) partes.push(f);
    }
    if (partes.length === 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error("Nada foi gravado: a live estava no ar quando apertaram Gravar?");
    }

    const nome = nomeDoArquivo(meta);
    const mp4 = join(dir, nome);
    await writeFile(join(dir, "lista.txt"), partes.map((p) => `file '${p}'`).join("\n"));
    // faststart põe o índice no começo: o player abre o culto sem baixar o
    // arquivo inteiro antes.
    await rodar(["-f", "concat", "-safe", "0", "-i", join(dir, "lista.txt"),
      "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-bsf:a", "aac_adtstoasc", "-movflags", "+faststart", mp4]);
    const duracao = await duracaoDe(mp4);
    registrar(`MP4 pronto: ${nome} (${duracao}s)`);

    ocupado = "enviando";
    await enviar(mp4, nome);
    registrar(`guardado no acervo: ${cfg.pasta}/${nome}`);

    feito = { nome, duracao };
    // Gravado antes de avisar o site: se o aviso falhar, a próxima tentativa
    // não sobe o arquivo de novo.
    await writeFile(pronto, JSON.stringify(feito));
  }

  ocupado = "enviando";
  const r = await site("POST", {
    tipo: "concluida",
    id: meta.id,
    titulo: meta.titulo,
    caminho: `${PREFIXO_ACERVO}/${feito.nome}`,
    duracao: feito.duracao,
    inicio: meta.inicio,
  });
  ultimo = { nome: r.nome, slug: r.slug };
  registrar(`culto cadastrado no acervo: ${r.nome}`);
  await rm(dir, { recursive: true, force: true });
}

let processando = false;
async function processarFila() {
  if (processando) return;
  processando = true;
  try {
    while (fila.length) {
      const dir = fila[0];
      try {
        await finalizar(dir);
        ultimoErro = null;
        fila.shift();
      } catch (e) {
        ultimoErro = e.message;
        registrar(`erro ao finalizar ${dir}: ${e.message}`);
        // Sem a pasta não há o que refazer; com ela, tenta de novo em um minuto.
        const existe = await stat(dir).then(() => true, () => false);
        if (!existe) fila.shift();
        else {
          ocupado = null;
          await new Promise((r) => setTimeout(r, 60_000));
        }
      }
    }
  } finally {
    ocupado = null;
    processando = false;
  }
}

// ─── Ciclo ───────────────────────────────────────────────────────────────────

let iniciado = false;

async function recuperar(pedido) {
  // Gravações que ficaram pela metade quando o app parou (reinício, queda de
  // energia): a que ainda está pedida continua; as outras vão para a fila.
  await mkdir(cfg.dir, { recursive: true });
  for (const id of await readdir(cfg.dir)) {
    const dir = join(cfg.dir, id);
    const meta = await readFile(join(dir, "meta.json"), "utf8").then(JSON.parse).catch(() => null);
    if (!meta) continue;
    if (pedido.gravar && pedido.id === meta.id && !atual) await iniciar(pedido, meta);
    else fila.push(dir);
  }
  processarFila();
}

async function ciclo() {
  try {
    const pedido = await site("GET");
    if (!iniciado) {
      iniciado = true;
      await recuperar(pedido);
    }

    if (atual && (!pedido.gravar || pedido.id !== atual.id)) await parar();
    if (pedido.gravar && !atual && !fila.some((d) => d.endsWith(pedido.id))) {
      if (!cfg.live) ultimoErro = "LIVE_URL não configurada no gravador.";
      else await iniciar(pedido);
    }
    // A live caiu no meio: abre outro pedaço (o ffmpeg falha rápido se ela
    // ainda estiver fora, e a gente tenta de novo no próximo ciclo).
    if (atual && !atual.proc) abrirPedaco();
    await medirSinal();

    await site("POST", { tipo: "situacao", ...situacao() });
  } catch (e) {
    registrar(`ciclo: ${e.message}`);
  } finally {
    setTimeout(ciclo, cfg.intervalo);
  }
}

// ─── Tela de status (aberta pelo Umbrel) ─────────────────────────────────────

createServer((req, res) => {
  if (req.url === "/saude") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ...situacao(), fila: fila.length }));
  }
  const s = situacao();
  const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const faltando = [!cfg.token && "GRAVADOR_TOKEN", !cfg.live && "LIVE_URL", !cfg.destino && !cfg.senha && "DESTINO_DIR ou COPYPARTY_SENHA"].filter(Boolean);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta http-equiv=refresh content=5><title>Gravador</title>
<style>body{font:15px system-ui;margin:0;padding:16px;background:#0f172a;color:#e2e8f0}h1{font-size:20px}
.e{font-size:28px;font-weight:800}pre{background:#020617;padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap}
.a{color:#fbbf24}</style>
<h1>AD Pousada — Gravador</h1>
<p class=e>${esc(s.estado)}${s.segundos ? ` · ${Math.floor(s.segundos / 60)} min` : ""}</p>
${s.mensagem ? `<p class=a>${esc(s.mensagem)}</p>` : ""}
${faltando.length ? `<p class=a>Falta configurar: ${faltando.join(", ")}</p>` : ""}
<p>Gravar e parar pelo painel do site, em Audiência. Na fila: ${fila.length}.</p>
<pre>${esc(log.slice(-60).reverse().join("\n"))}</pre>`);
}).listen(cfg.porta, () => registrar(`status em :${cfg.porta}`));

if (!cfg.token) registrar("GRAVADOR_TOKEN ausente — o site vai recusar tudo.");

// Marca a pasta de destino ao ligar. Se a montagem apontar para o lugar
// errado, o Docker cria uma pasta vazia e tudo "funciona" — só que os cultos
// vão parar onde ninguém procura. O marcador deixa isso conferível pela
// pasta do acervo.
if (cfg.destino) {
  writeFile(join(cfg.destino, ".gravador-conectado"), `${new Date().toISOString()}
`)
    .then(() => registrar(`destino ${cfg.destino} gravável`))
    .catch((e) => registrar(`destino ${cfg.destino} NÃO gravável: ${e.message}`));
}
ciclo();
iniciarServidorDeEnvio();

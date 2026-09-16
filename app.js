'use strict';

/* ======================= CONFIGURAÇÃO ======================= */

const PEER_OPCOES = {};
const MAX_MEMBROS = 6; // você + 5 amigos
const MAX_PEDIDOS = 5;
const MAX_NOME = 30;
const CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const FORMATO_SALA = /^telao-[a-z0-9]{12}$/;
const AUDIO_KBPS = 128;
const QUALIDADES = {
  '1080p60': { fps: 60, kbps: 8000, rotulo: '1080p 60fps' },
  '1080p30': { fps: 30, kbps: 5000, rotulo: '1080p 30fps' },
};

const $ = (id) => document.getElementById(id);
const salaUrl = new URLSearchParams(location.search).get('sala');

/* ======================= ESTADO ======================= */

let peer = null;
let meuId = null;
let meuNome = '';
let souDono = false;
let connDono = null;           // membro: conexão com o dono da sala
let encerrado = false;

let membros = new Map();       // lista oficial enviada pelo dono: id -> { id, nome, dono, compartilhando, qualidade, audio }
const aprovados = new Map();   // só o dono: id -> { conn, nome, compartilhando, qualidade, audio }
const pedidos = new Map();     // só o dono: id -> { conn, nome, el }

let minhaTela = null;          // { stream, original, qualidade, audio }
let cadeiaAudio = null;        // só de quem compartilha: { contexto, ganhos, destino }
const envios = new Map();      // para quem estou mandando minha tela: id -> call
const querAssistir = new Set();// telas que eu pedi para ver
const recebendo = new Map();   // telas chegando: id -> call
const tiles = new Map();       // telas no palco: id -> { el, video, aviso, info, btnMudo, volume, btnDestacar, timer }
let destaque = null;           // id da tela grande no palco; as outras viram miniatura
let destaqueManual = false;    // escolha explícita no botão Destacar manda no automático

/* ======================= UTILIDADES ======================= */

function mostrar(id, sim) { $(id).classList.toggle('oculto', !sim); }
function avisoSala(texto) { $('statusSala').textContent = texto; }

function criar(tag, classe, texto) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texto != null) e.textContent = texto; // sempre texto, nunca HTML
  return e;
}

function botao(texto, classe, acao) {
  const b = criar('button', classe, texto);
  b.type = 'button';
  b.addEventListener('click', acao);
  return b;
}

// Nomes vêm de outras pessoas: sempre tratar como texto não confiável
function limparNome(valor) {
  if (typeof valor !== 'string') return '';
  return valor.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOME);
}

function gerarIdSala() {
  const nums = crypto.getRandomValues(new Uint32Array(12));
  return 'telao-' + Array.from(nums, (n) => CHARS[n % CHARS.length]).join('');
}

function enviar(conn, msg) {
  try { if (conn?.open) conn.send(msg); } catch { /* conexão já caiu */ }
}

function encerrarConexao(conn, tipo) {
  enviar(conn, { tipo });
  setTimeout(() => conn.close(), 500);
}

// Áudio em estéreo e com mais qualidade (padrão do WebRTC é mono, pensado para voz)
function sdpAudioEstereo(sdp) {
  return sdp.replace(/a=fmtp:(\d+) (.*useinbandfec=1.*)/g, (linha, pt, params) =>
    params.includes('stereo=1')
      ? linha
      : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=${AUDIO_KBPS * 1000}`);
}

function rotuloQualidade(altura, fps) {
  return altura ? `${Math.round(altura)}p ${Math.round(fps || 0)}fps` : '';
}

/* ======================= TELAS DO APP ======================= */

function telaInicio() {
  mostrar('telaInicio', true);
  if (salaUrl) {
    $('inicioTitulo').textContent = 'Você foi convidado para uma sala';
    $('inicioTexto').textContent = 'Digite seu nome para o dono da sala saber que é você.';
    $('btnInicio').textContent = 'Pedir para entrar';
  }
  $('inputNome').focus();
}

function mostrarAviso(titulo, texto, comBotao) {
  mostrar('telaInicio', false);
  mostrar('telaSala', false);
  mostrar('telaAviso', true);
  $('avisoTitulo').textContent = titulo;
  $('avisoTexto').textContent = texto;
  mostrar('btnVoltar', comBotao);
}

function abrirSala() {
  mostrar('telaInicio', false);
  mostrar('telaAviso', false);
  mostrar('telaSala', true);
  mostrar('blocoConvite', souDono);
  $('btnSair').textContent = souDono ? 'Encerrar sala' : 'Sair';
  if (!navigator.mediaDevices?.getDisplayMedia) {
    $('btnTela').disabled = true;
    avisoSala('Neste aparelho dá só para assistir. Para compartilhar, use Chrome ou Edge no computador.');
  }
  atualizarControles();
  atualizarPalco();
  renderMembros();
}

function acaoInicio() {
  const nome = limparNome($('inputNome').value);
  if (!nome) {
    $('inicioStatus').textContent = 'Digite seu nome para continuar.';
    return;
  }
  meuNome = nome;
  $('btnInicio').disabled = true;
  if (salaUrl) pedirEntrada();
  else criarSala();
}

function sair() {
  if (souDono && !confirm('Encerrar a sala para todo mundo?')) return;
  if (souDono) finalizar('Sala encerrada', 'Todo mundo foi desconectado.');
  else finalizar('Você saiu da sala', 'Peça o link de novo se quiser voltar.');
}

function finalizar(titulo, texto) {
  if (encerrado) return;
  pararTela();
  for (const id of [...querAssistir]) pararDeAssistir(id, false);
  encerrado = true;
  peer?.destroy();
  document.title = 'Telão';
  mostrarAviso(titulo, texto, true);
}

/* ======================= CONEXÃO ======================= */

function prepararPeer() {
  peer.on('call', aoReceberChamada);
  peer.on('disconnected', () => { if (!peer.destroyed && !encerrado) peer.reconnect(); });
  peer.on('error', (err) => {
    const naSala = souDono || membros.size > 0;
    if (err.type === 'peer-unavailable') {
      // Dentro da sala isso só significa que alguém saiu no meio de uma chamada
      if (!naSala) finalizar('Sala não encontrada', 'O link pode estar errado ou a sala já foi encerrada.');
      return;
    }
    if (naSala) avisoSala(`Problema de conexão (${err.type}). Se algo parar de funcionar, recarregue a página.`);
    else finalizar('Não foi possível conectar', `Erro: ${err.type}. Recarregue a página e tente de novo.`);
  });
}

/* ---------- Dono da sala ---------- */

function criarSala() {
  souDono = true;
  peer = new Peer(gerarIdSala(), PEER_OPCOES);
  prepararPeer();
  peer.on('connection', aoPedirEntrada);
  peer.on('open', (id) => {
    meuId = id;
    $('link').value = `${location.origin}${location.pathname}?sala=${id}`;
    abrirSala();
    publicarEstado();
  });
}

function aoPedirEntrada(conn) {
  conn.on('open', () => {
    if (pedidos.size >= MAX_PEDIDOS || aprovados.size >= MAX_MEMBROS - 1) {
      encerrarConexao(conn, 'cheia');
      return;
    }
    const id = conn.peer;
    const nome = limparNome(conn.metadata?.nome) || 'Sem nome';
    const li = criar('li');
    li.append(
      criar('span', null, nome),
      botao('Aceitar', 'principal', () => aceitar(id)),
      botao('Recusar', 'perigo', () => recusar(id)),
    );
    pedidos.set(id, { conn, nome, el: li });
    $('listaPedidos').append(li);
    atualizarPedidos();
  });

  // Mensagens só são levadas em conta depois que a pessoa foi aceita
  conn.on('data', (msg) => processarNoDono(conn.peer, msg));

  const aoSair = () => {
    removerPedido(conn.peer);
    if (aprovados.get(conn.peer)?.conn === conn) {
      aprovados.delete(conn.peer);
      publicarEstado();
    }
  };
  conn.on('close', aoSair);
  conn.on('error', aoSair);
}

function atualizarPedidos() {
  mostrar('blocoPedidos', pedidos.size > 0);
  document.title = pedidos.size > 0 ? `(${pedidos.size}) Pedido para entrar | Telão` : 'Telão';
}

function removerPedido(id) {
  const p = pedidos.get(id);
  if (!p) return;
  p.el.remove();
  pedidos.delete(id);
  atualizarPedidos();
}

function aceitar(id) {
  const p = pedidos.get(id);
  if (!p) return;
  removerPedido(id);
  if (aprovados.size >= MAX_MEMBROS - 1) {
    encerrarConexao(p.conn, 'cheia');
    return;
  }
  aprovados.set(id, { conn: p.conn, nome: p.nome, compartilhando: false, qualidade: null, audio: false });
  enviar(p.conn, { tipo: 'aceito' });
  publicarEstado();
}

function recusar(id) {
  const p = pedidos.get(id);
  if (!p) return;
  removerPedido(id);
  encerrarConexao(p.conn, 'recusado');
}

function remover(id) {
  const m = aprovados.get(id);
  if (!m) return;
  aprovados.delete(id);
  encerrarConexao(m.conn, 'removido');
  publicarEstado();
}

// O dono é quem guarda a lista oficial de quem está na sala e repassa os pedidos
function processarNoDono(de, msg) {
  const membro = aprovados.get(de);
  if (de !== meuId && !membro) return;

  if (msg?.tipo === 'compartilhando') {
    if (membro) {
      membro.compartilhando = !!msg.ligado;
      membro.qualidade = msg.ligado && QUALIDADES[msg.qualidade] ? msg.qualidade : null;
      membro.audio = !!msg.ligado && !!msg.audio;
    }
    publicarEstado();
  } else if (msg?.tipo === 'assistir') {
    const alvo = String(msg.alvo);
    const ligado = !!msg.ligado;
    if (alvo === de) return;
    if (alvo === meuId) pedidoDeTela(de, ligado);
    else if (aprovados.has(alvo)) enviar(aprovados.get(alvo).conn, { tipo: 'pedido-tela', de, ligado });
  }
}

function publicarEstado() {
  const lista = [{
    id: meuId, nome: meuNome, dono: true,
    compartilhando: !!minhaTela, qualidade: minhaTela?.qualidade || null, audio: !!minhaTela?.audio,
  }];
  for (const [id, m] of aprovados) {
    lista.push({ id, nome: m.nome, dono: false, compartilhando: m.compartilhando, qualidade: m.qualidade, audio: m.audio });
  }
  for (const m of aprovados.values()) enviar(m.conn, { tipo: 'estado', membros: lista });
  aplicarEstado(lista);
}

/* ---------- Membro ---------- */

function pedirEntrada() {
  mostrarAviso('Entrando na sala…', 'Conectando com o dono da sala.', false);
  peer = new Peer(PEER_OPCOES);
  prepararPeer();
  peer.on('connection', (c) => c.close()); // só o dono recebe conexões de dados

  peer.on('open', (id) => {
    meuId = id;
    connDono = peer.connect(salaUrl, { reliable: true, serialization: 'json', metadata: { nome: meuNome } });
    connDono.on('open', () => mostrarAviso('Aguardando aprovação', 'O dono da sala precisa aceitar sua entrada.', false));
    connDono.on('data', mensagemDoDono);
    connDono.on('close', () => finalizar('Sala encerrada', 'A conexão com o dono da sala foi fechada.'));
  });
}

function mensagemDoDono(msg) {
  switch (msg?.tipo) {
    case 'aceito': abrirSala(); break;
    case 'estado': if (Array.isArray(msg.membros)) aplicarEstado(msg.membros); break;
    case 'pedido-tela': pedidoDeTela(String(msg.de), !!msg.ligado); break;
    case 'recusado': finalizar('Entrada recusada', 'O dono da sala não aceitou seu pedido.'); break;
    case 'removido': finalizar('Você foi removido', 'O dono da sala encerrou seu acesso.'); break;
    case 'cheia': finalizar('Sala cheia', `A sala já tem ${MAX_MEMBROS} pessoas ou pedidos demais aguardando.`); break;
  }
}

// Dono fala direto consigo mesmo; membro manda pela conexão
function enviarAoDono(msg) {
  if (souDono) processarNoDono(meuId, msg);
  else enviar(connDono, msg);
}

/* ---------- Estado da sala (vale para todos) ---------- */

function aplicarEstado(lista) {
  membros = new Map();
  for (const m of lista.slice(0, MAX_MEMBROS)) {
    if (typeof m?.id !== 'string') continue;
    membros.set(m.id, {
      id: m.id,
      nome: limparNome(m.nome) || 'Sem nome',
      dono: !!m.dono,
      compartilhando: !!m.compartilhando,
      qualidade: QUALIDADES[m.qualidade] ? m.qualidade : null,
      audio: !!m.audio,
    });
  }
  // Quem parou de compartilhar ou saiu: some do palco
  for (const id of [...querAssistir]) {
    if (!membros.get(id)?.compartilhando) pararDeAssistir(id, false);
  }
  // Quem saiu ou foi removido: para de receber minha tela
  for (const id of [...envios.keys()]) {
    if (!membros.has(id)) fecharEnvio(id);
  }
  renderMembros();
}

function renderMembros() {
  const ul = $('listaMembros');
  ul.replaceChildren();
  for (const m of membros.values()) {
    const li = criar('li', m.compartilhando ? 'transmitindo' : null);
    const info = criar('div', 'membro-info');
    info.append(criar('span', 'membro-nome', m.nome));

    const tags = [];
    if (m.id === meuId) tags.push('você');
    if (m.dono) tags.push('dono da sala');
    if (tags.length) info.append(criar('span', 'membro-tag', tags.join(', ')));
    if (m.compartilhando) {
      const q = QUALIDADES[m.qualidade]?.rotulo || '';
      info.append(criar('span', 'membro-live', `Ao vivo ${q}, ${m.audio ? 'com áudio' : 'sem áudio'}`));
    }

    const acoes = criar('div', 'membro-acoes');
    if (m.compartilhando && m.id !== meuId) {
      acoes.append(querAssistir.has(m.id)
        ? botao('Parar de assistir', null, () => pararDeAssistir(m.id))
        : botao('Assistir', 'principal', () => assistir(m.id)));
    }
    if (souDono && m.id !== meuId) acoes.append(botao('Remover', 'perigo', () => remover(m.id)));

    li.append(info, acoes);
    ul.append(li);
  }
  $('tituloMembros').textContent = `Na sala (${membros.size} de ${MAX_MEMBROS})`;
}

/* ======================= COMPARTILHAR MINHA TELA ======================= */

async function alternarTela() {
  if (minhaTela) pararTela();
  else await compartilharTela();
}

async function compartilharTela() {
  if (!navigator.mediaDevices?.getDisplayMedia) return;
  const chaveQ = QUALIDADES[$('qualidade').value] ? $('qualidade').value : '1080p30';
  const q = QUALIDADES[chaveQ];
  const querAudio = $('comAudio').checked;

  let stream;
  $('btnTela').disabled = true;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: q.fps, max: q.fps },
      },
      audio: querAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true }
        : false,
      systemAudio: querAudio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude', // não deixa compartilhar a própria aba do Telão
      surfaceSwitching: 'include',
    });
  } catch {
    avisoSala('Compartilhamento cancelado.');
    return;
  } finally {
    $('btnTela').disabled = false;
  }
  if (encerrado) { stream.getTracks().forEach((t) => t.stop()); return; }

  const trilhaVideo = stream.getVideoTracks()[0];
  trilhaVideo.contentHint = 'motion'; // prioriza fluidez (jogos e vídeos)
  trilhaVideo.addEventListener('ended', pararTela);
  stream.getAudioTracks().forEach((t) => { t.contentHint = 'music'; });

  const temAudio = stream.getAudioTracks().length > 0;

  // Com áudio, o que sai daqui é a trilha tratada, não a bruta: o filtro de voz liga e
  // desliga ao vivo mexendo só nos ganhos, sem trocar a trilha no meio da transmissão.
  let streamEnvio = stream;
  if (temAudio) {
    try {
      cadeiaAudio = montarCadeiaAudio(stream);
      const trilhaTratada = cadeiaAudio.destino.stream.getAudioTracks()[0];
      trilhaTratada.contentHint = 'music';
      streamEnvio = new MediaStream([trilhaVideo, trilhaTratada]);
    } catch (e) {
      console.warn('Não foi possível montar a cadeia de áudio; seguindo com o som bruto', e);
      cadeiaAudio = null;
    }
  }
  minhaTela = { stream: streamEnvio, original: stream, qualidade: chaveQ, audio: temAudio };
  aplicarSemVoz($('semVoz').checked);

  avisarSobreAudio(trilhaVideo, querAudio);
  // surfaceSwitching deixa trocar de tela no meio da transmissão: o aviso acompanha
  trilhaVideo.addEventListener('configurationchange', () => {
    if (minhaTela?.original === stream) avisarSobreAudio(trilhaVideo, querAudio);
  });

  const t = criarTile(meuId, 'Sua tela', true);
  t.video.muted = true; // evita ouvir o próprio som em dobro
  t.video.srcObject = streamEnvio;
  t.aviso.classList.add('oculto');

  atualizarControles();
  enviarAoDono({ tipo: 'compartilhando', ligado: true, qualidade: chaveQ, audio: temAudio });
}

// O navegador não separa o som de um programa só: na tela inteira ele entrega o áudio do
// sistema já misturado. Quem está numa chamada (Discord) acaba devolvendo a voz de todo
// mundo. Compartilhar a aba resolve, porque aí só o som da aba é capturado.
function avisarSobreAudio(trilhaVideo, querAudio) {
  const superficie = trilhaVideo.getSettings().displaySurface;
  const temAudio = minhaTela?.original?.getAudioTracks().length > 0;

  if (querAudio && !temAudio) {
    avisoSala(superficie === 'window'
      ? 'Janela de programa não leva áudio. Para transmitir com som, escolha a tela inteira ou uma aba do navegador.'
      : 'Sua tela está sem áudio. Na janela de escolha, marque a opção de compartilhar áudio. Funciona com a tela inteira ou com uma aba.');
  } else if (temAudio && superficie === 'monitor') {
    avisoSala('Compartilhando a tela inteira, vai junto todo o som do computador — inclusive a voz do Discord, que volta duplicada para quem está na chamada. Para mandar só o som do vídeo, compartilhe a aba do navegador.');
  } else {
    avisoSala('');
  }
}

/* ---------- Filtro de voz de chamada (experimental) ---------- */

// Voz de chamada chega em mono, igual nos dois canais, então L menos R cancela ela.
// O preço é alto: some tudo que está no centro do estéreo, inclusive o diálogo do filme.
// A cadeia fica sempre montada; desligado é só uma questão de ganho (cada canal segue reto).
function montarCadeiaAudio(streamOriginal) {
  const contexto = new AudioContext();
  const divisor = contexto.createChannelSplitter(2);
  const juntador = contexto.createChannelMerger(2);
  const destino = contexto.createMediaStreamDestination();

  contexto.createMediaStreamSource(streamOriginal).connect(divisor);
  // ganhos[saida][entrada]: quanto de cada canal que entra vai para cada canal que sai
  const ganhos = [[], []];
  for (let saida = 0; saida < 2; saida++) {
    for (let entrada = 0; entrada < 2; entrada++) {
      const g = contexto.createGain();
      divisor.connect(g, entrada);
      g.connect(juntador, 0, saida);
      ganhos[saida][entrada] = g;
    }
  }
  juntador.connect(destino);
  contexto.resume().catch(() => {});
  return { contexto, ganhos, destino };
}

function aplicarSemVoz(ligado) {
  if (!cadeiaAudio) return;
  const [esq, dir] = cadeiaAudio.ganhos;
  // ligado: as duas saídas viram (L-R)/2 — metade, senão a soma estoura em som alto
  // desligado: cada canal segue reto, sem tocar no som
  esq[0].gain.value = ligado ? 0.5 : 1;
  esq[1].gain.value = ligado ? -0.5 : 0;
  dir[0].gain.value = ligado ? 0.5 : 0;
  dir[1].gain.value = ligado ? -0.5 : 1;
}

function pararTela() {
  if (!minhaTela) return;
  minhaTela.stream.getTracks().forEach((t) => t.stop());
  minhaTela.original.getTracks().forEach((t) => t.stop()); // a captura crua não está no stream enviado
  minhaTela = null;
  cadeiaAudio?.contexto.close().catch(() => {});
  cadeiaAudio = null;
  for (const id of [...envios.keys()]) fecharEnvio(id);
  removerTile(meuId);
  avisoSala(''); // o aviso falava da transmissão que acabou de terminar
  atualizarControles();
  enviarAoDono({ tipo: 'compartilhando', ligado: false });
}

// Alguém pediu (ou deixou de pedir) para ver minha tela
function pedidoDeTela(de, ligado) {
  if (!ligado) { fecharEnvio(de); return; }
  if (!minhaTela || de === meuId || !membros.has(de)) return;

  fecharEnvio(de);
  const call = peer.call(de, minhaTela.stream, { sdpTransform: sdpAudioEstereo });
  if (!call) return;
  envios.set(de, call);
  limitarQualidade(call, QUALIDADES[minhaTela.qualidade]);
  const limpar = () => { if (envios.get(de) === call) envios.delete(de); };
  call.on('close', limpar);
  call.on('error', limpar);
}

function fecharEnvio(id) {
  const call = envios.get(id);
  if (!call) return;
  envios.delete(id);
  call.close();
}

// Sobe o limite de qualidade (o padrão do navegador para telas é ~2,5 Mbps)
function limitarQualidade(call, q) {
  const pc = call.peerConnection;
  if (!pc) return;
  let aplicado = false;
  const aplicar = async () => {
    if (aplicado || pc.connectionState !== 'connected') return;
    aplicado = true;
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const p = sender.getParameters();
      if (!p.encodings?.length) continue;
      if (sender.track.kind === 'video') {
        p.encodings[0].maxBitrate = q.kbps * 1000;
        p.encodings[0].maxFramerate = q.fps;
      } else {
        p.encodings[0].maxBitrate = AUDIO_KBPS * 1000;
      }
      try { await sender.setParameters(p); } catch (e) { console.warn('Não foi possível ajustar a qualidade', e); }
    }
  };
  pc.addEventListener('connectionstatechange', aplicar);
  aplicar();
}

function atualizarControles() {
  const ativo = !!minhaTela;
  $('btnTela').textContent = ativo ? 'Parar de compartilhar' : 'Compartilhar tela';
  $('btnTela').classList.toggle('principal', !ativo);
  $('btnTela').classList.toggle('perigo', ativo);
  $('qualidade').disabled = ativo;
  $('comAudio').disabled = ativo;
  $('aoVivo').classList.toggle('ativo', ativo);
}

/* ======================= ASSISTIR OS OUTROS ======================= */

function assistir(id) {
  const m = membros.get(id);
  if (id === meuId || querAssistir.has(id) || !m?.compartilhando) return;
  querAssistir.add(id);
  const t = criarTile(id, m.nome, false);
  t.timer = setTimeout(() => {
    if (tiles.get(id) === t && !t.video.srcObject) {
      t.aviso.textContent = 'Não foi possível conectar. Clique em Parar de assistir e tente de novo.';
    }
  }, 20000);
  enviarAoDono({ tipo: 'assistir', alvo: id, ligado: true });
  renderMembros();
}

function pararDeAssistir(id, avisar = true) {
  if (!querAssistir.delete(id)) return;
  if (avisar) enviarAoDono({ tipo: 'assistir', alvo: id, ligado: false });
  const call = recebendo.get(id);
  recebendo.delete(id);
  call?.close();
  removerTile(id);
  renderMembros();
}

// Só aceita vídeo de quem está na sala, está ao vivo e foi pedido por mim
function aoReceberChamada(call) {
  const id = call.peer;
  if (!querAssistir.has(id) || !membros.get(id)?.compartilhando) {
    call.close();
    return;
  }
  const antiga = recebendo.get(id);
  recebendo.set(id, call);
  antiga?.close();

  call.answer(undefined, { sdpTransform: sdpAudioEstereo });
  call.on('stream', (stream) => ligarTile(id, stream));
  call.on('close', () => {
    if (recebendo.get(id) !== call) return;
    recebendo.delete(id);
    const t = tiles.get(id);
    if (t) {
      t.video.srcObject = null;
      t.aviso.textContent = 'Transmissão interrompida.';
      t.aviso.classList.remove('oculto');
    }
  });
}

/* ======================= PALCO ======================= */

function criarTile(id, nome, propria) {
  removerTile(id);
  const t = {};
  t.el = criar('div', 'tile');
  t.video = criar('video');
  t.video.autoplay = true;
  t.video.playsInline = true;
  t.aviso = criar('div', 'tile-aviso', 'Conectando…');

  const topo = criar('div', 'tile-topo');
  t.info = criar('span', 'tile-info', '');
  topo.append(criar('span', 'tile-nome', nome), t.info);

  const controles = criar('div', 'tile-controles');
  if (!propria) {
    t.btnMudo = botao('Mutar', null, () => alternarMudo(t));
    t.volume = criar('input');
    t.volume.type = 'range';
    t.volume.min = '0';
    t.volume.max = '100';
    t.volume.value = '100';
    t.volume.setAttribute('aria-label', `Volume de ${nome}`);
    t.volume.addEventListener('input', () => {
      t.video.volume = Number(t.volume.value) / 100;
      if (t.video.muted && Number(t.volume.value) > 0) alternarMudo(t);
    });
    t.btnMudo.classList.add('oculto');
    t.volume.classList.add('oculto');
    controles.append(t.btnMudo, t.volume);
  }
  t.btnDestacar = botao('Destacar', 'principal', () => definirDestaque(id));
  t.btnDestacar.classList.add('oculto');
  controles.append(t.btnDestacar, botao('Tela cheia', 'cheia', () => telaCheia(t)));
  if (!propria) controles.append(botao('Parar de assistir', 'perigo', () => pararDeAssistir(id)));

  t.el.append(t.video, t.aviso, topo, controles);
  if (propria) $('palco').prepend(t.el);
  else $('palco').append(t.el);
  tiles.set(id, t);
  atualizarPalco();
  return t;
}

function ligarTile(id, stream) {
  const t = tiles.get(id);
  if (!t || t.video.srcObject === stream) return;
  clearTimeout(t.timer);
  t.video.srcObject = stream;
  t.aviso.classList.add('oculto');

  const temAudio = stream.getAudioTracks().length > 0;
  t.btnMudo.classList.toggle('oculto', !temAudio);
  t.volume.classList.toggle('oculto', !temAudio);

  t.video.muted = false;
  t.video.play().catch(() => {
    // Navegador bloqueou som automático: começa mutado e a pessoa desmuta
    t.video.muted = true;
    atualizarMudo(t);
    t.video.play().catch(() => {});
  });
  atualizarMudo(t);
}

function alternarMudo(t) {
  t.video.muted = !t.video.muted;
  if (!t.video.muted && t.video.volume === 0) {
    t.video.volume = 0.5;
    t.volume.value = '50';
  }
  atualizarMudo(t);
}

function atualizarMudo(t) {
  if (!t.btnMudo) return;
  t.btnMudo.textContent = t.video.muted ? 'Desmutar' : 'Mutar';
  t.el.classList.toggle('mudo', t.video.muted && !t.btnMudo.classList.contains('oculto'));
}

function removerTile(id) {
  const t = tiles.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  t.video.srcObject = null;
  t.el.remove();
  tiles.delete(id);
  atualizarPalco();
}

function definirDestaque(id) {
  destaque = id;
  destaqueManual = true;
  atualizarPalco();
}

// Com mais de uma tela, uma fica grande e o resto vira miniatura embaixo. Sem destaque
// escolhido, prefere a tela de outra pessoa: a própria a gente já está vendo no monitor.
function atualizarPalco() {
  mostrar('palcoVazio', tiles.size === 0);
  if (!tiles.has(destaque)) { destaque = null; destaqueManual = false; }
  if (!destaqueManual) {
    destaque = [...tiles.keys()].find((id) => id !== meuId) ?? [...tiles.keys()][0] ?? null;
  }
  const varias = tiles.size > 1;
  $('palco').classList.toggle('foco', varias);
  for (const [id, t] of tiles) {
    t.el.classList.toggle('destaque', varias && id === destaque);
    t.btnDestacar.classList.toggle('oculto', !varias || id === destaque);
  }
}

function telaCheia(t) {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (t.el.requestFullscreen) t.el.requestFullscreen().catch(() => {});
  else if (t.video.webkitEnterFullscreen) t.video.webkitEnterFullscreen(); // iPhone
}

// Mostra a resolução e os fps que estão chegando de verdade
setInterval(async () => {
  for (const [id, t] of tiles) {
    if (id === meuId) {
      const s = minhaTela?.stream.getVideoTracks()[0]?.getSettings();
      if (s) t.info.textContent = rotuloQualidade(s.height, s.frameRate);
      continue;
    }
    const pc = recebendo.get(id)?.peerConnection;
    if (!pc) continue;
    try {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameHeight) {
          t.info.textContent = rotuloQualidade(r.frameHeight, r.framesPerSecond);
        }
      });
    } catch { /* conexão fechando */ }
  }
}, 2000);

/* ======================= INÍCIO ======================= */

async function copiarLink() {
  try {
    await navigator.clipboard.writeText($('link').value);
  } catch {
    $('link').select();
    document.execCommand('copy');
  }
  $('btnCopiar').textContent = 'Copiado';
  setTimeout(() => ($('btnCopiar').textContent = 'Copiar'), 2000);
}

$('btnInicio').addEventListener('click', acaoInicio);
$('inputNome').addEventListener('keydown', (e) => { if (e.key === 'Enter') acaoInicio(); });
$('btnVoltar').addEventListener('click', () => { location.href = location.pathname; });
$('btnTela').addEventListener('click', alternarTela);
$('semVoz').addEventListener('change', () => {
  const ligado = $('semVoz').checked;
  aplicarSemVoz(ligado);
  // Em mono os dois canais são iguais, então L menos R dá silêncio puro
  if (ligado && minhaTela?.original?.getAudioTracks()[0]?.getSettings().channelCount === 1) {
    avisoSala('O som capturado é mono: nesse caso o filtro zera o áudio inteiro. Só funciona com som em estéreo.');
  }
});
$('btnSair').addEventListener('click', sair);
$('btnCopiar').addEventListener('click', copiarLink);
window.addEventListener('beforeunload', () => peer?.destroy());

if (typeof Peer === 'undefined') {
  mostrarAviso('Não foi possível carregar o app', 'Confira se o arquivo peerjs.min.js foi enviado junto com os outros.', false);
} else if (salaUrl && !FORMATO_SALA.test(salaUrl)) {
  mostrarAviso('Link inválido', 'Peça um novo link para o dono da sala.', true);
} else {
  telaInicio();
}

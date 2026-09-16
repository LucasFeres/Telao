# CLAUDE.md

Orientações para o Claude Code (e para quem for mexer no código) trabalhar neste repositório.

## O que é o Telão

Site estático para assistir tela junto com amigos. Uma pessoa cria a sala, manda o link, e
quem entrar pode compartilhar a própria tela (com áudio, até 1080p 60fps) ou assistir a de
outra pessoa. Tudo roda no navegador, sem back-end próprio e sem conta.

Interface e código são em **português do Brasil** — nomes de variáveis, funções e comentários
inclusive. Mantenha esse padrão.

## Estrutura

Não há build, bundler, dependências de npm nem testes. Os arquivos da raiz **são** o site:

| Arquivo | Papel |
| --- | --- |
| `index.html` | Marcação das três telas (início, aviso, sala) + a CSP |
| `app.js` | Toda a lógica: sinalização, WebRTC, palco, lista de membros |
| `style.css` | Tema escuro, layout em grade, responsivo |
| `peerjs.min.js` | PeerJS embarcado (vendorizado) — **não editar** |
| `LICENSE-peerjs.txt` | Licença MIT do PeerJS |
| `.nojekyll` | Impede o Jekyll de processar o site no Pages |
| `.github/workflows/pages.yml` | Publica a raiz do repo no GitHub Pages |

Para rodar local: `python3 -m http.server 8000` e abrir `http://localhost:8000`.
`getDisplayMedia` só funciona em HTTPS ou em `localhost` — abrir o `index.html` como
`file://` não funciona (a CSP e o WebRTC quebram).

## Arquitetura

Duas topologias diferentes convivem:

- **Dados (sinalização) em estrela.** O dono da sala é o único hub. Membros só têm conexão
  de dados com ele; membro não fala com membro. O dono guarda a lista oficial de quem está
  na sala e repassa pedidos.
- **Mídia em malha.** O vídeo vai direto de quem compartilha para quem assiste, sem passar
  pelo dono.

O id da sala é o próprio id do Peer do dono: `telao-` + 12 caracteres sorteados com
`crypto.getRandomValues` (alfabeto `CHARS`, sem letras ambíguas). Ele vai no link como
`?sala=...` e é validado contra `FORMATO_SALA` antes de qualquer conexão.

### Protocolo de mensagens

Do dono para o membro:

| Tipo | Significado |
| --- | --- |
| `aceito` | Entrada aprovada; o membro abre a sala |
| `recusado` / `removido` / `cheia` | Fim de linha; o membro cai na tela de aviso |
| `estado` | `{ membros: [...] }` — lista oficial, reenviada a cada mudança |
| `pedido-tela` | `{ de, ligado }` — alguém quer (ou não quer mais) ver sua tela |

Do membro para o dono:

| Tipo | Significado |
| --- | --- |
| `compartilhando` | `{ ligado, qualidade, audio }` — liguei/desliguei minha tela |
| `assistir` | `{ alvo, ligado }` — quero (ou não) ver a tela de `alvo` |

O dono não é um caso especial no fluxo: `enviarAoDono()` chama `processarNoDono()` direto
quando `souDono`, em vez de mandar pela rede. Ao mexer no protocolo, garanta que os dois
caminhos continuem equivalentes.

### Fluxo de uma transmissão

1. Quem compartilha chama `compartilharTela()` e avisa o dono (`compartilhando`).
2. O dono publica o novo `estado`; todo mundo vê o botão **Assistir**.
3. Quem quer ver manda `assistir` ao dono, que roteia um `pedido-tela` para a origem.
4. A origem faz `peer.call(...)` com a stream; o espectador atende em `aoReceberChamada()`.

`aoReceberChamada()` só atende se **eu pedi** (`querAssistir`) e a pessoa **está na lista
oficial como ao vivo**. Essa checagem dupla é o que impede alguém de empurrar vídeo sem
convite — não a remova.

### Estado (tudo em `app.js`)

`membros` (lista oficial recebida do dono) · `aprovados` e `pedidos` (só no dono) ·
`minhaTela` · `envios` (para quem mando) · `querAssistir` e `recebendo` (o que recebo) ·
`tiles` (o que está no palco). `aplicarEstado()` é o ponto único de reconciliação: quando a
lista muda, ela derruba o que ficou órfão (quem saiu, quem parou de transmitir).

### Palco

A tela cresce até onde a janela deixa: `.tile` tem `max-width: calc((100vh - var(--sobra))
* 16 / 9)`, ou seja, a largura sai da altura disponível. Sem isso, em monitor grande a tela
16:9 fica mais alta que o visível e obriga a rolar a página.

`--sobra` é quanto o cabeçalho, os controles, o recado e (no modo foco) a fila de miniaturas
ocupam fora do palco. **`ajustarPalco()` mede isso de verdade, não chuta**: o valor muda
sozinho quando os controles quebram de linha ou o recado passa a ocupar duas linhas, e uma
media query com número fixo erra por dezenas de pixels (e quebraria de novo se um rótulo
mudasse de texto). Um `ResizeObserver` no cabeçalho, nos controles e no recado recalcula
sempre que qualquer um deles muda de altura — isso cobre inclusive redimensionar a janela.
O valor em CSS é só o palpite inicial até o JS rodar. Abaixo de 960px o teto é removido: a
lateral desce para baixo do palco, a página rola de qualquer jeito, e limitar só encolheria
o vídeo à toa.

Com mais de uma tela, `atualizarPalco()` põe a classe `foco` no palco: a tela `destaque`
ocupa a linha inteira e o resto vira miniatura embaixo (CSS puro, via `order` e
`grid-column` — nenhum tile muda de pai, senão o vídeo pisca). Sem escolha explícita, o
destaque cai na tela de outra pessoa; o botão **Destacar** liga `destaqueManual` e trava a
escolha até aquele tile sair. Miniatura só mostra Mutar e Destacar: o resto não cabe em
170px, e `.tile` tem `overflow: hidden`, então o excesso seria cortado em vez de vazar.

## Regras que o código assume

- **Nada de `innerHTML`.** Todo nó novo sai de `criar()`/`botao()`, que usam `textContent`.
- **Texto de outra pessoa passa por `limparNome()`** (tira controles, colapsa espaços, corta
  em `MAX_NOME`), tanto ao receber quanto ao reexibir.
- **Mensagem que chega é sempre suspeita.** Valide tipo e conteúdo antes de usar — veja
  `aplicarEstado()` e `processarNoDono()` como modelo.
- A CSP em `index.html` libera só `'self'` e o servidor do PeerJS. **Trocar de servidor de
  sinalização, ou adicionar STUN/TURN, exige atualizar `connect-src` junto** — senão o app
  quebra em produção e funciona no teste local.
- Sem bundler: arquivo novo precisa de `<script>`/`<link>` no `index.html`.

## Qualidade de vídeo e áudio

Os padrões do WebRTC são pensados para chamada de voz, não para jogo e filme. Três ajustes
seguram a qualidade, e os três precisam andar juntos:

- `QUALIDADES` define fps e teto de bitrate (8 Mbps a 60fps, 5 Mbps a 30fps).
- `limitarQualidade()` sobe o teto via `setParameters()` depois que a conexão conecta — o
  padrão do navegador para tela é ~2,5 Mbps.
- `sdpAudioEstereo()` reescreve o `fmtp` do Opus para estéreo a 128 kbps; sem isso o áudio
  vira mono comprimido.

`contentHint` é `motion` no vídeo e `music` no áudio, pela mesma razão.

### Cadeia de áudio de quem compartilha

Com áudio ligado, o que vai para os outros **não é a trilha bruta**: `montarCadeiaAudio()`
monta um grafo WebAudio (divisor → 4 ganhos → juntador → destino) e o stream enviado leva a
trilha tratada. `minhaTela.original` guarda a captura crua — `pararTela()` precisa parar as
duas, senão a captura do sistema continua viva.

A matriz de 4 ganhos é `ganhos[saída][entrada]`. Desligado, cada canal segue reto (1/0, 0/1)
e o som passa intacto; ligado, as duas saídas viram `(L−R)/2`, o efeito karaokê — a metade
evita estourar quando os lados somam. Como só os ganhos mudam, o filtro liga e desliga ao
vivo sem trocar a trilha, e nenhum `replaceTrack` é necessário.

O filtro é paliativo e tem dois buracos conhecidos: come o diálogo do que está sendo
assistido (também está no centro) e, se a captura vier em **mono**, zera o áudio inteiro
(os canais são iguais, a subtração dá silêncio). O `change` do `#semVoz` avisa nesse caso.

## Limites e limitações conhecidas

- **Não dá para capturar o som de um programa só.** Na tela inteira o navegador entrega o
  áudio do sistema já misturado; não existe API para tirar o Discord (ou qualquer outro app)
  de dentro do mix. Quem está numa chamada de voz devolve a voz de todo mundo duplicada.
  Compartilhar uma **aba** captura só o som da aba e resolve; janela de programa não leva
  áudio nenhum no Chrome. `avisarSobreAudio()` lê `displaySurface` e avisa em cada caso.
  Isso é diferente do eco do próprio Telão, que já está tratado por `restrictOwnAudio`,
  `selfBrowserSurface: 'exclude'` e o `muted` no tile da própria tela.
- `MAX_MEMBROS = 6` (você + 5) e `MAX_PEDIDOS = 5`. Como a mídia é em malha, cada pessoa que
  te assiste custa um envio inteiro de upload — subir esse número sem mudar a topologia
  estoura a internet de quem compartilha.
- **Não há TURN configurado** (`PEER_OPCOES` está vazio). Em rede corporativa ou NAT
  simétrico a conexão de mídia pode simplesmente não fechar.
- A sala morre com a aba do dono: ele é o hub da sinalização.
- Compartilhar tela exige navegador de desktop baseado em Chromium. No celular dá só para
  assistir — `abrirSala()` já trata isso desabilitando o botão.
- O servidor público `0.peerjs.com` é de terceiros e só serve para apresentar os pares;
  vídeo e áudio não passam por ele.

## Publicação

O site é a raiz do repositório. O workflow `.github/workflows/pages.yml` publica no Pages a
cada push na `main` (e liga o Pages sozinho na primeira execução, via `enablement: true`).
Não há etapa de build para rodar antes.

O link de convite é montado com `location.origin + location.pathname`, então funciona tanto
em domínio próprio quanto em subpasta (`usuario.github.io/Telao/`). Se mudar isso, teste o
convite nos dois casos.

## Commits

Mensagens em português, no imperativo, descrevendo o efeito para quem usa
("Mostra a resolução real de quem está transmitindo").

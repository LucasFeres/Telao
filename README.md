# Telão

Assista tela junto com seus amigos, direto no navegador.

Crie uma sala, mande o link e pronto. Cada pessoa compartilha a própria tela quando quiser —
com áudio e em até 1080p 60fps — e escolhe quem quer assistir. Sem instalar nada, sem criar
conta, sem servidor no meio: o vídeo vai direto de um computador para o outro.

**👉 [Abrir o Telão](https://lucasferes.github.io/Telao/)**

## Como funciona

1. Digite seu nome e clique em **Criar sala**.
2. Copie o link do convite e mande para a galera.
3. Quem abrir o link pede para entrar; você aceita ou recusa.
4. Clique em **Compartilhar tela** para transmitir, ou em **Assistir** para ver a tela de
   alguém. Dá para assistir a mais de uma ao mesmo tempo.

Cada tela tem controle de volume, botão de mudo e tela cheia, e mostra a resolução e os fps
que estão chegando de verdade.

## Precisa saber

- Até **6 pessoas** por sala (você + 5). O vídeo vai direto para cada espectador, então
  quanto mais gente te assistindo, mais upload você gasta.
- Para **compartilhar** tela: Chrome ou Edge no computador. No celular dá para assistir.
- Para transmitir **com som**, marque a opção de compartilhar áudio na janela que o navegador
  abre (funciona com a tela inteira ou com uma aba).
- A sala existe enquanto a aba de quem criou estiver aberta.
- Em rede corporativa muito fechada a conexão pode não fechar (não há servidor TURN).

## Privacidade

Vídeo e áudio são ponto a ponto (WebRTC) e não passam por nenhum servidor nosso. O serviço
público do PeerJS é usado só para os navegadores se acharem — ele não vê o conteúdo da
transmissão. Nada é gravado nem armazenado em lugar nenhum.

O link da sala é a senha: quem tiver o link consegue pedir para entrar, mas só entra se o
dono aceitar.

## Rodando local

Site estático, sem build e sem dependências para instalar:

```sh
python3 -m http.server 8000
```

Depois abra `http://localhost:8000`. Abrir o `index.html` direto pelo `file://` não funciona
— compartilhamento de tela exige HTTPS ou `localhost`.

## Publicação

Todo push na `main` publica no GitHub Pages pelo workflow `.github/workflows/pages.yml`.

## Licença

O [PeerJS](https://peerjs.com) vai embarcado em `peerjs.min.js`, sob licença MIT
(veja `LICENSE-peerjs.txt`).

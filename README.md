# Linozera Transmissão v3

Projeto de sala de compartilhamento de tela via WebRTC com visual inspirado no layout de referência enviado pelo usuário.

## Como iniciar no Windows
1. Extraia o ZIP.
2. Dê dois cliques em `INICIAR.bat`.
3. Abra `http://localhost:3000` se o navegador não abrir sozinho.

## Fluxo
- Digite seu nickname.
- Clique em **Criar sala**.
- Copie o código/link para outra pessoa.
- Dentro da sala, clique em **Compartilhar tela** quando quiser começar a transmissão.

## Sem retorno local
- O site não solicita microfone.
- A prévia do transmissor fica `muted` e com volume 0.
- O áudio compartilhado é apenas o áudio que o navegador permitir ao selecionar tela/janela/aba.

## Internet pública
Para conexões mais difíceis entre redes diferentes, configure TURN no `.env`/ambiente usando `TURN_URL`, `TURN_USERNAME` e `TURN_CREDENTIAL`.

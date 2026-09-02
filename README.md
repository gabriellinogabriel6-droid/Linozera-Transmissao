# Linozera Transmissão V4

Versão focada em compartilhamento de tela no estilo Meet, mas sem câmera e sem solicitar microfone.

## O que entrou na V4
- Várias pessoas podem compartilhar a tela ao mesmo tempo.
- Grade de transmissões e modo de destaque.
- Seletor de qualidade: Automático, 480p30, 720p30, 1080p30, 1080p60 e 1440p60.
- Mix de som: volume mestre, volume individual, Mute e Solo.
- Chat em tempo real.
- Avatar próprio com upload, movimento para cima/baixo/lados e zoom.
- Sala trancável pelo dono.
- Lobby novo em preto/roxo e botão do Discord.
- Salas públicas opcionais no lobby.
- Aviso de nova versão/atualização.
- Sons interativos configuráveis.
- Reconexão do Socket.IO e WebRTC ponto a ponto.

## Sem retorno
O projeto não usa `getUserMedia`, portanto não solicita câmera nem microfone. A prévia local de quem transmite fica muda e a própria transmissão não é enviada de volta para o transmissor.

Ao compartilhar, o navegador recebe as preferências `systemAudio: "exclude"` e `windowAudio: "window"` quando suportadas. Isso reduz o risco de capturar o áudio geral do Windows/Discord. Para o melhor resultado, compartilhe uma **aba ou janela específica** e ative áudio somente para a fonte que realmente deseja transmitir.

Observação: navegadores e sistemas operacionais controlam quais tipos de áudio podem ser capturados. Nenhum site consegue separar Discord de jogo depois que ambos já foram misturados pelo próprio sistema operacional.

## Windows
1. Extraia o ZIP.
2. Abra `INICIAR.bat`.
3. O site abre em `http://localhost:3000`.

## Render
Use **Web Service**:
- Build Command: `npm install`
- Start Command: `npm start`
- O servidor já usa `process.env.PORT`.

## TURN (recomendado para produção)
Configure no Render:
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Sem TURN, alguns pares em CGNAT, redes corporativas ou operadoras móveis podem não conseguir formar conexão direta.

## Discord
O botão do lobby abre: https://discord.gg/WndvT5HgG8

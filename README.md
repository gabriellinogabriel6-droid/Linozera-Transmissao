# Linozera Transmissão V4.2 — Visual atual + motor V3

Esta versão mantém o **modelo visual premium da V4.1** (lobby roxo/preto, sala com painel esquerdo, palco central, chat à direita e mixer), mas volta a usar o **fluxo de transmissão simples da V3**.

## Transmissão
- O dono/criador da sala é o transmissor principal.
- Os demais entram como espectadores.
- WebRTC direto transmissor → cada espectador, como na V3.
- Reconexão do Socket.IO mantém a sala e recria as conexões WebRTC.
- Seletor de qualidade: Automático, 480p30, 720p30, 1080p30, 1080p60 e 1440p60.

## Visual e recursos mantidos
- Lobby e sala no modelo visual atual aprovado.
- Chat em tempo real.
- Mix de som para controlar o áudio recebido.
- Avatar com upload, posição e zoom.
- Trancar/destrancar sala.
- Salas públicas opcionais.
- Botão do Discord: https://discord.gg/WndvT5HgG8
- Aviso de atualização e sons interativos.

## Sem retorno
- Não usa `getUserMedia`: câmera e microfone não são solicitados.
- A prévia local do transmissor fica sempre muda.
- O transmissor não recebe a própria transmissão pelo site.
- `systemAudio: "exclude"` e `windowAudio: "window"` são solicitados quando suportados para reduzir captura do áudio geral do Windows/Discord.
- Para melhor separação de áudio, compartilhe uma aba ou janela específica.

## Windows
1. Extraia o ZIP.
2. Abra `INICIAR.bat`.
3. Acesse `http://localhost:3000`.

## Render
Use **Web Service**:
- Build Command: `npm install`
- Start Command: `npm start`

O servidor usa `process.env.PORT` automaticamente.

## TURN (recomendado)
Para conexões entre redes mais restritas, configure no Render:
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

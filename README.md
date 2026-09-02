# Linozera Transmissão V4.5 — Visual idêntico ao modelo

Esta versão foi refeita para seguir o **layout aprovado pelo usuário**: preto + roxo neon, lobby com hero/card de entrada, salas públicas, recursos e rodapé; sala com painel esquerdo, transmissão central, chat à direita, mixer e dock inferior.

## Motor de transmissão
- Mantém o motor simples/estável da V3: o dono da sala transmite e os demais assistem.
- WebRTC direto entre transmissor e espectadores.
- Reconexão pelo Socket.IO.
- Qualidade: Automático, 480p30, 720p30, 1080p30, 1080p60 e 1440p60.

## Sem retorno
- Câmera e microfone bloqueados pelo site.
- Prévia local sempre muda.
- O transmissor não recebe a própria transmissão.
- Ao escolher Tela inteira, o áudio do sistema é removido para reduzir retorno do Discord/Windows.
- Para transmitir áudio, prefira uma Janela ou Aba específica.

## Recursos
- Chat em tempo real.
- Mix de som com volume até 150% e reforço opcional.
- Avatar com upload, posição e zoom.
- Sala privada/pública e trancar/destrancar.
- Atualização manual e automática das salas públicas.
- Central de Configurações: Geral, Áudio, Transmissão e Sala.
- Aviso de nova versão.
- Sons interativos.
- Discord: https://discord.gg/WndvT5HgG8

## Rodar no Windows
1. Extraia o ZIP.
2. Abra `INICIAR.bat`.
3. Acesse `http://localhost:3000`.

## Render
- Tipo: Web Service
- Build Command: `npm install`
- Start Command: `npm start`

O servidor usa `process.env.PORT` automaticamente.

## TURN opcional
Para redes mais restritas, configure:
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

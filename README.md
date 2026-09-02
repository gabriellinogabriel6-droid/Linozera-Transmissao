# Linozera Transmissão V5.1 Pro — Correção Tela Preta

Versão 5.1 com foco principal na correção de tela preta, estabilidade WebRTC e captura mais compatível com Chrome/Windows.

## Principais mudanças

- Interface reconstruída do zero (lobby + sala) em preto/roxo Linozera.
- Layout responsivo e estável: sidebar esquerda, palco central, mixer e chat lateral.
- Salas públicas aparecem no lobby em tempo real e também são atualizadas a cada 5 segundos.
- Botão **Atualizar** do lobby e **Atualizar sala** funcionais.
- Motor WebRTC de um apresentador principal (dono da sala) para espectadores.
- Correção de tela preta: o receptor usa apenas `event.track` de cada evento WebRTC e mantém uma faixa de vídeo estável.
- O player só é mostrado depois que um quadro real foi decodificado.
- Se nenhuma faixa chegar ou se os quadros pararem, o espectador renegocia a conexão automaticamente.
- A captura usa a resolução nativa da fonte; a qualidade é controlada no envio, evitando tela preta/tremedeira causada por redimensionamento de GPU.
- Watchdog de vídeo cobre tanto faixa ausente quanto faixa sem quadros decodificados.
- ICE recebido antes da oferta SDP é preservado, evitando conexões incompletas.
- Reconexão automática Socket.IO + WebRTC.
- Captura sem redimensionamento agressivo durante a apresentação para evitar “tremedeira”.
- Modo Automático reduz bitrate/FPS quando necessário, sem ficar alterando o tamanho do player.
- Sem microfone e sem câmera.
- Prévia local sempre muda.
- Compartilhamento de tela inteira/monitor tem o áudio removido para evitar retorno de Discord/Windows.
- Para enviar áudio, prefira **Aba** ou **Janela**.
- Mixer com volume padrão 120%, mute/solo e compressor.
- Chat em tempo real.
- Avatar editável com posição e zoom.
- Sala pública/privada e trancar/destrancar sala.
- Configurações completas.
- Link do Discord: https://discord.gg/WndvT5HgG8

## Rodar no Windows

1. Instale Node.js 18 ou superior.
2. Extraia a pasta.
3. Execute `INICIAR.bat`.
4. Acesse `http://localhost:3000`.

## Render

Crie um **Web Service** (não Static Site):

- Build Command: `npm install`
- Start Command: `npm start`

O Render fornece `PORT` automaticamente.

### TURN (recomendado)

STUN sozinho pode falhar em algumas redes, CGNATs, empresas e provedores. Para maior taxa de conexão entre redes diferentes, configure no Render:

- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Sem TURN, o sistema ainda funciona em muitas redes, mas não é possível garantir conexão P2P em todos os provedores.

## Como evitar retorno

- Não compartilhe **Tela inteira** se precisar transmitir áudio. Nesta versão, o áudio de monitor é removido automaticamente.
- Para jogo/programa com som, escolha **Janela** ou **Aba** quando o navegador oferecer áudio daquela fonte.
- O site nunca solicita seu microfone.
- O vídeo do próprio transmissor fica mudo localmente.

## Verificação feita

- `node --check server.js`
- `node --check public/app.js`
- IDs HTML/JavaScript conferidos.
- Assets locais conferidos.
- Contratos de eventos cliente/servidor conferidos.
- Lobby e sala renderizados em navegador headless para inspeção visual.

O teste WebRTC real entre dois computadores precisa ser feito no ambiente final (Render/PC), porque depende da rede, NAT, navegador e TURN.

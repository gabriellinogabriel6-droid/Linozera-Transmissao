# Linozera Transmissão V5 Pro

Reconstrução do projeto com foco em aparência profissional, estabilidade e correção de tela preta.

## Principais mudanças

- Interface reconstruída do zero (lobby + sala) em preto/roxo Linozera.
- Layout responsivo e estável: sidebar esquerda, palco central, mixer e chat lateral.
- Salas públicas aparecem no lobby em tempo real e também são atualizadas a cada 5 segundos.
- Botão **Atualizar** do lobby e **Atualizar sala** funcionais.
- Motor WebRTC de um apresentador principal (dono da sala) para espectadores.
- Correção de tela preta: as faixas de vídeo/áudio recebidas são acumuladas no mesmo `MediaStream`; áudio não substitui mais o vídeo.
- Watchdog de vídeo: se houver track de vídeo ativa mas nenhum quadro decodificado, o espectador reconecta automaticamente.
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

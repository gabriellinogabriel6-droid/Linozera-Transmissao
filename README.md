# Linozera Transmissão V4.6 — Estabilidade e sem retorno reforçados

Mantém o **visual preto + roxo neon aprovado** e o motor simples da V3 (o dono transmite e os demais assistem), com correções focadas em estabilidade, lag e áudio.

## O que melhorou na V4.6
- Qualidade **Automática adaptativa**: ajusta bitrate, FPS e escala por conexão quando a rede aperta.
- No modo Automático, reduz o custo por espectador para não saturar tão rápido o upload do transmissor.
- Recuperação automática de conexão WebRTC/ICE quando a rota cai ou fica desconectada.
- Pool de ICE e configuração de transporte mais enxuta para conexão inicial/reconexão.
- Se o dono cair da internet, a sala aguarda até 30 segundos para reconectar; depois encerra para não deixar sala “fantasma”.
- Ao sair/encerrar/trocar de sessão, todas as faixas de captura são encerradas para não continuar compartilhando escondido.

## Sem retorno reforçado
- Câmera e microfone continuam bloqueados pelo site.
- Prévia local sempre muda.
- O transmissor nunca toca a própria transmissão dentro do site.
- `systemAudio: exclude` continua ativo.
- Quando suportado pelo navegador, `restrictOwnAudio` tenta remover da captura o áudio produzido pela própria aba do Linozera.
- Ao escolher **Tela inteira**, qualquer faixa de áudio capturada é removida. Isso evita puxar o áudio geral do Windows/Discord.
- Para transmitir áudio do jogo/app, prefira **Janela** ou **Aba** específica.
- Sons da interface não tocam enquanto você está compartilhando.

> Importante: nenhum site consegue separar perfeitamente Discord e jogo se o navegador/SO entregar os dois já misturados na mesma fonte de áudio. Para o modo mais seguro contra retorno, não compartilhe “Tela inteira” com áudio.

## Qualidades
- Automático (recomendado)
- 480p • 30 FPS
- 720p • 30 FPS
- 1080p • 30 FPS
- 1080p • 60 FPS
- 1440p • 60 FPS

Para evitar travamentos, deixe **Automático** como padrão, principalmente com mais de um espectador.

## Recursos mantidos
- Visual aprovado do lobby e da sala.
- Chat em tempo real.
- Mixer com volume individual, Mute, Solo e reforço até 150%.
- Avatar com upload, posição e zoom.
- Sala pública/privada e trancar/destrancar.
- Atualização das salas públicas.
- Central de Configurações.
- Aviso de atualização.
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

## TURN recomendado
Para funcionar melhor entre provedores, CGNAT e redes restritas, configure no Render:
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

TURN melhora a capacidade de conectar em redes difíceis, mas não substitui uma boa velocidade de upload.

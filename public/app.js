const BUILD_VERSION = '4.0.0';
const DISCORD_URL = 'https://discord.gg/WndvT5HgG8';
const socket = io({ transports: ['websocket', 'polling'] });
const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];

const QUALITY = {
  auto: { label: 'Automático', width: 1920, height: 1080, fps: 30, bitrate: 6000000 },
  '480p30': { label: '480p • 30 FPS', width: 854, height: 480, fps: 30, bitrate: 1500000 },
  '720p30': { label: '720p • 30 FPS', width: 1280, height: 720, fps: 30, bitrate: 3000000 },
  '1080p30': { label: '1080p • 30 FPS', width: 1920, height: 1080, fps: 30, bitrate: 6000000 },
  '1080p60': { label: '1080p • 60 FPS', width: 1920, height: 1080, fps: 60, bitrate: 9000000 },
  '1440p60': { label: '1440p • 60 FPS', width: 2560, height: 1440, fps: 60, bitrate: 14000000 }
};

const makeClientId = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clientId = localStorage.getItem('lnz_client_id') || makeClientId();
localStorage.setItem('lnz_client_id', clientId);

let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let currentRoom = null;
let currentNickname = localStorage.getItem('lnz_nickname') || '';
let currentAvatar = localStorage.getItem('lnz_avatar') || '';
let ownerToken = null;
let isOwner = false;
let roomLocked = false;
let roomPublic = false;
let members = new Map();
let localStream = null;
let selectedQuality = localStorage.getItem('lnz_quality') || 'auto';
let layoutMode = 'grid';
let focusedClientId = null;
let reconnecting = false;

const sessions = new Map();
const remoteStreams = new Map();
const chatIds = new Set();
const channelMix = new Map();
let masterVolume = 1;
let soloClientId = null;

let soundEnabled = localStorage.getItem('lnz_sounds') !== '0';
let soundVolume = Number(localStorage.getItem('lnz_sound_volume') ?? '45') / 100;
let audioContext = null;

let avatarSource = currentAvatar || '/linozera-logo.png';
let avatarX = 0;
let avatarY = 0;
let avatarZoom = 1;

fetch('/api/config').then(r => r.json()).then(cfg => {
  if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) rtcConfig = { iceServers: cfg.iceServers };
}).catch(() => {});

function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
function formatRoom(value) {
  const v = normalizeRoom(value);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}
function sanitizeNickname(value) {
  return String(value || '').replace(/[<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24);
}
function safeAvatar(avatar) {
  return avatar && avatar.startsWith('data:image/') ? avatar : '/linozera-logo.png';
}
function initials(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[ch]));
}
function toast(message, timeout = 3000) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), timeout);
}
function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }
function setRoomUrl(room) {
  const url = new URL(location.href);
  if (room) url.searchParams.set('room', formatRoom(room)); else url.searchParams.delete('room');
  history.replaceState({}, '', url);
}
function roomInviteUrl() {
  const url = new URL(location.href);
  url.searchParams.set('room', formatRoom(currentRoom));
  return url.toString();
}
async function copyText(text, message = 'Copiado.') {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast(text, 6000); }
}
function requireNickname() {
  const nickname = sanitizeNickname($('nicknameInput').value);
  if (nickname.length < 2) {
    $('homeError').textContent = 'Digite um apelido com pelo menos 2 caracteres.';
    $('nicknameInput').focus();
    return null;
  }
  currentNickname = nickname;
  localStorage.setItem('lnz_nickname', nickname);
  $('homeError').textContent = '';
  return nickname;
}
function updateNicknameCounter() {
  const value = $('nicknameInput').value.slice(0, 24);
  $('nickCount').textContent = `${value.length}/24`;
}
function updateProfileImages() {
  const src = currentAvatar || '/linozera-logo.png';
  $('homeAvatarImg').src = src;
  $('roomAvatarImg').src = src;
  $('myNameLabel').textContent = currentNickname || 'Você';
}

/* Sons interativos: são suspensos enquanto VOCÊ compartilha para não entrar no áudio capturado. */
function ensureAudioContext() {
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  return audioContext;
}
function playUISound(type = 'tap') {
  if (!soundEnabled || soundVolume <= 0 || localStream) return;
  try {
    const ctx = ensureAudioContext();
    const map = {
      tap:[420,0.045], join:[660,0.085], leave:[250,0.08], chat:[830,0.055],
      start:[520,0.08], stop:[330,0.08], lock:[290,0.09], unlock:[720,0.08],
      connected:[760,0.08], update:[920,0.12], error:[180,0.13]
    };
    const [freq, dur] = map[type] || map.tap;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type === 'error' ? 'sawtooth' : 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(Math.max(.0001, soundVolume * .075), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + dur);
  } catch {}
}
document.addEventListener('pointerdown', () => { if (soundEnabled) ensureAudioContext(); }, { once: true });

/* Lobby */
async function loadPublicRooms() {
  const grid = $('publicRoomsGrid');
  try {
    const data = await fetch('/api/public-rooms', { cache: 'no-store' }).then(r => r.json());
    const list = Array.isArray(data.rooms) ? data.rooms : [];
    if (!list.length) {
      grid.innerHTML = '<div class="public-empty">Nenhuma sala pública ao vivo agora.</div>';
      return;
    }
    grid.innerHTML = list.map(room => `
      <article class="public-card" data-room="${escapeHtml(room.roomId)}">
        <div class="public-thumb"><span class="live-badge">AO VIVO</span></div>
        <div class="public-info">
          <h3>${escapeHtml(room.roomId)}</h3>
          <p>${escapeHtml(room.ownerName || 'Linozera')}</p>
          <div class="public-stats"><span>♙ ${room.members}</span><span>◉ ${room.streaming} transmitindo</span></div>
          <span class="privacy-badge">ENTRAR NA SALA →</span>
        </div>
      </article>`).join('');
    $$('.public-card').forEach(card => card.addEventListener('click', () => {
      $('roomInput').value = card.dataset.room;
      $('entryCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  } catch {
    grid.innerHTML = '<div class="public-empty">Não foi possível carregar as salas agora.</div>';
  }
}

function showRoom() {
  $('home').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  updateProfileImages();
}
function showHome() {
  $('roomView').classList.add('hidden');
  $('home').classList.remove('hidden');
  document.body.style.overflow = '';
  loadPublicRooms();
}

function createRoom() {
  const nickname = requireNickname();
  if (!nickname) return;
  playUISound('tap');
  socket.emit('room:create', {
    clientId,
    nickname,
    avatar: currentAvatar,
    isPublic: $('publicToggle').checked
  }, result => {
    if (!result?.ok) return toast(result?.error || 'Não foi possível criar a sala.');
    currentRoom = normalizeRoom(result.roomId);
    ownerToken = result.ownerToken;
    isOwner = true;
    sessionStorage.setItem('lnz_owner_room', currentRoom);
    sessionStorage.setItem('lnz_owner_token', ownerToken);
    enterRoomFromAck(result);
  });
}
function joinRoom(value, fromReconnect = false) {
  const nickname = fromReconnect ? currentNickname : requireNickname();
  if (!nickname) return;
  const roomId = normalizeRoom(value);
  if (roomId.length !== 8) {
    $('homeError').textContent = 'Digite um código de sala válido.';
    return;
  }
  const savedRoom = normalizeRoom(sessionStorage.getItem('lnz_owner_room'));
  const savedToken = sessionStorage.getItem('lnz_owner_token');
  const tokenForRoom = savedRoom === roomId ? savedToken : null;
  socket.emit('room:join', {
    roomId,
    clientId,
    nickname,
    avatar: currentAvatar,
    ownerToken: tokenForRoom
  }, result => {
    if (!result?.ok) {
      if (!fromReconnect) $('homeError').textContent = result?.error || 'Não foi possível entrar.';
      if (result?.locked) playUISound('error');
      if (!fromReconnect) showHome();
      return;
    }
    currentRoom = normalizeRoom(result.roomId);
    ownerToken = tokenForRoom || null;
    isOwner = Boolean(result.owner);
    enterRoomFromAck(result);
  });
}
function enterRoomFromAck(result) {
  $('homeError').textContent = '';
  setRoomUrl(currentRoom);
  const formatted = formatRoom(currentRoom);
  $('topRoomCode').innerHTML = `CÓDIGO DA SALA &nbsp; <b>${formatted}</b> &nbsp; ▢`;
  $('sideRoomCode').textContent = formatted;
  showRoom();
  applyRoomStatus(result.status || {});
  playUISound('join');
  if (localStream) {
    const q = QUALITY[selectedQuality] || QUALITY.auto;
    socket.emit('room:stream', { active: true, quality: q.label, audio: localStream.getAudioTracks().length > 0 });
  }
}

/* Sala e membros */
function applyRoomStatus(data) {
  const oldLocked = roomLocked;
  roomLocked = Boolean(data.locked);
  roomPublic = Boolean(data.isPublic);
  const next = new Map();
  (Array.isArray(data.members) ? data.members : []).forEach(m => next.set(m.clientId, m));
  members = next;
  if (data.ownerClientId !== clientId) isOwner = false;
  renderMembers();
  renderRoomState();
  syncStreamTiles();
  renderMixer();
  if (Array.isArray(data.chat)) data.chat.forEach(appendChatMessage);
  cleanupSessionsForMembers();
  if (localStream) ensureAllSendPeers();
  if (oldLocked !== roomLocked && oldLocked !== undefined) playUISound(roomLocked ? 'lock' : 'unlock');
}
function renderRoomState() {
  $('memberCount').textContent = String(members.size || 1);
  $('topPeopleCount').textContent = String(members.size || 1);
  const ownerOnly = $$('.owner-only');
  ownerOnly.forEach(el => el.classList.toggle('hidden', !isOwner));
  $('lockStateChip').textContent = roomLocked ? '🔒 Sala trancada' : '◈ Sala aberta';
  $('roomPrivacyBadge').textContent = roomLocked ? '🔒 SALA TRANCADA' : (roomPublic ? '◉ SALA PÚBLICA' : '◈ SALA ABERTA');
  $('lockBtn').innerHTML = roomLocked ? '🔓 &nbsp; Destrancar sala' : '🔒 &nbsp; Trancar sala';
}
function avatarMarkup(member, cls = 'member-avatar') {
  const src = member.avatar;
  if (src) return `<div class="${cls}"><img src="${src}" alt="" /><i class="online-dot"></i></div>`;
  return `<div class="${cls}"><div class="fallback-avatar">${escapeHtml(initials(member.name))}</div><i class="online-dot"></i></div>`;
}
function renderMembers() {
  const list = $('memberList');
  list.innerHTML = '';
  for (const member of members.values()) {
    const row = document.createElement('div');
    row.className = 'member';
    row.innerHTML = `${avatarMarkup(member)}
      <div class="member-copy">
        <div class="member-name">${escapeHtml(member.name)} ${member.owner ? '<span class="owner-crown">♛</span>' : ''} ${member.clientId === clientId ? '<span class="you-badge">VOCÊ</span>' : ''}</div>
        <div class="member-sub">${member.streaming ? '<span class="streaming-dot">● APRESENTANDO</span>' : (member.owner ? 'Dono da sala' : 'Na sala')}</div>
      </div>`;
    list.appendChild(row);
  }
}
function findMemberBySocket(socketId) {
  for (const member of members.values()) if (member.socketId === socketId) return member;
  return null;
}
function toggleLock() {
  if (!isOwner) return;
  socket.emit('room:lock', { locked: !roomLocked }, result => {
    if (!result?.ok) return toast(result?.error || 'Não foi possível alterar a sala.');
    roomLocked = Boolean(result.locked);
    renderRoomState();
    playUISound(roomLocked ? 'lock' : 'unlock');
  });
}
function closeRoom() {
  if (!isOwner || !confirm('Encerrar a sala para todos?')) return;
  socket.emit('room:close', {}, result => {
    if (!result?.ok) toast(result?.error || 'Não foi possível encerrar.');
  });
}
function leaveRoom() {
  if (localStream) stopSharing(false);
  socket.emit('room:leave');
  resetRoomState();
  showHome();
  playUISound('leave');
}
function resetRoomState() {
  closeAllSessions();
  remoteStreams.clear();
  members.clear();
  chatIds.clear();
  $('chatMessages').innerHTML = '<div class="chat-empty"><b>▢</b><strong>Nenhuma mensagem ainda</strong><span>Envie uma mensagem para a sala.</span></div>';
  currentRoom = null;
  isOwner = false;
  roomLocked = false;
  setRoomUrl(null);
  syncStreamTiles();
}

/* WebRTC multi-stream */
function newSessionId() {
  return `${clientId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { s.pc.onicecandidate = null; s.pc.ontrack = null; s.pc.close(); } catch {}
  sessions.delete(sessionId);
}
function closeAllSessions(direction = null) {
  for (const [id, s] of [...sessions]) if (!direction || s.direction === direction) closeSession(id);
}
function cleanupSessionsForMembers() {
  const sockets = new Set([...members.values()].map(m => m.socketId));
  for (const [id, s] of [...sessions]) if (!sockets.has(s.peerSocketId)) closeSession(id);
}
function queueIce(session, candidate) {
  session.pendingIce.push(candidate);
}
async function flushIce(session) {
  const list = session.pendingIce.splice(0);
  for (const candidate of list) {
    try { await session.pc.addIceCandidate(candidate); } catch {}
  }
}
function createPeerSession({ sessionId, direction, peerSocketId, peerClientId }) {
  const pc = new RTCPeerConnection(rtcConfig);
  const session = { sessionId, direction, peerSocketId, peerClientId, pc, pendingIce: [] };
  sessions.set(sessionId, session);
  pc.onicecandidate = event => {
    if (event.candidate) socket.emit('webrtc:ice', { target: peerSocketId, sessionId, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closeSession(sessionId);
  };
  return session;
}
async function applySenderBitrate(pc) {
  const cfg = QUALITY[selectedQuality] || QUALITY.auto;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = cfg.bitrate;
      await sender.setParameters(params);
    } catch {}
  }
}
async function makeSendPeer(member) {
  if (!localStream || !member?.socketId || member.clientId === clientId) return;
  const exists = [...sessions.values()].some(s => s.direction === 'send' && s.peerSocketId === member.socketId);
  if (exists) return;
  const sessionId = newSessionId();
  const session = createPeerSession({ sessionId, direction: 'send', peerSocketId: member.socketId, peerClientId: member.clientId });
  localStream.getTracks().forEach(track => session.pc.addTrack(track, localStream));
  try {
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    await applySenderBitrate(session.pc);
    socket.emit('webrtc:offer', { target: member.socketId, sessionId, sdp: session.pc.localDescription });
  } catch (err) {
    console.error('Falha ao criar oferta', err);
    closeSession(sessionId);
  }
}
function ensureAllSendPeers() {
  if (!localStream) return;
  for (const member of members.values()) makeSendPeer(member);
}
async function applyQualityToLocalTrack() {
  if (!localStream) return;
  const cfg = QUALITY[selectedQuality] || QUALITY.auto;
  const track = localStream.getVideoTracks()[0];
  if (track) {
    try {
      await track.applyConstraints({
        width: { ideal: cfg.width },
        height: { ideal: cfg.height },
        frameRate: { ideal: cfg.fps, max: cfg.fps }
      });
    } catch (err) { console.warn('Qualidade limitada pelo navegador/tela', err); }
  }
  for (const s of sessions.values()) if (s.direction === 'send') await applySenderBitrate(s.pc);
  const self = members.get(clientId);
  if (self) { self.quality = cfg.label; syncStreamTiles(); }
  socket.emit('room:stream', { active: true, quality: cfg.label, audio: localStream.getAudioTracks().length > 0 });
}
async function startSharing() {
  if (!currentRoom || localStream) return;
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Seu navegador não suporta compartilhamento de tela.');
  const cfg = QUALITY[selectedQuality] || QUALITY.auto;
  try {
    /*
      Sem retorno: não usamos getUserMedia, então microfone/câmera nunca são solicitados.
      systemAudio:'exclude' evita o áudio geral do Windows/Discord quando o Chrome respeita essa preferência.
      windowAudio:'window' prioriza o som da janela escolhida em Chromes novos.
    */
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: cfg.fps, max: cfg.fps } },
      audio: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
      windowAudio: 'window',
      preferCurrentTab: false
    });
    localStream = stream;
    await applyQualityToLocalTrack();
    const self = members.get(clientId) || { clientId, socketId: socket.id, name: currentNickname, avatar: currentAvatar };
    self.streaming = true; self.quality = cfg.label; self.audio = stream.getAudioTracks().length > 0;
    members.set(clientId, self);
    $('shareBtnLabel').textContent = 'Parar apresentação';
    $('shareBtn').classList.add('stop');
    syncStreamTiles();
    ensureAllSendPeers();
    socket.emit('room:stream', { active: true, quality: cfg.label, audio: self.audio });
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.addEventListener('ended', () => stopSharing(true), { once: true });
    toast(self.audio ? 'Apresentação iniciada com áudio da fonte escolhida.' : 'Apresentação iniciada sem áudio.');
  } catch (err) {
    if (!['NotAllowedError', 'AbortError'].includes(err?.name)) {
      console.error(err);
      toast('Não foi possível iniciar a apresentação.');
      playUISound('error');
    }
  }
}
function stopSharing(notify = true) {
  if (!localStream) return;
  localStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
  localStream = null;
  closeAllSessions('send');
  const self = members.get(clientId);
  if (self) { self.streaming = false; self.audio = false; }
  $('shareBtnLabel').textContent = 'Apresentar agora';
  $('shareBtn').classList.remove('stop');
  if (socket.connected && currentRoom) socket.emit('room:stream', { active: false, quality: QUALITY[selectedQuality].label, audio: false });
  syncStreamTiles();
  renderMixer();
  if (notify) { toast('Apresentação encerrada.'); playUISound('stop'); }
}

socket.on('webrtc:offer', async ({ from, sessionId, sdp }) => {
  const member = findMemberBySocket(from);
  if (!member) socket.emit('room:status');
  if (sessions.has(sessionId)) closeSession(sessionId);
  const session = createPeerSession({ sessionId, direction: 'recv', peerSocketId: from, peerClientId: member?.clientId || from });
  session.pc.ontrack = event => {
    const stream = event.streams?.[0] || new MediaStream([event.track]);
    const m = findMemberBySocket(from);
    const id = m?.clientId || session.peerClientId;
    session.peerClientId = id;
    remoteStreams.set(id, { stream, socketId: from });
    syncStreamTiles();
    renderMixer();
    const video = document.querySelector(`.stream-tile[data-client-id="${CSS.escape(id)}"] video`);
    if (video) video.play().catch(() => toast('Clique na página para liberar o áudio da transmissão.'));
  };
  try {
    await session.pc.setRemoteDescription(sdp);
    await flushIce(session);
    const answer = await session.pc.createAnswer();
    await session.pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', { target: from, sessionId, sdp: session.pc.localDescription });
  } catch (err) {
    console.error('Falha ao responder apresentação', err);
    closeSession(sessionId);
  }
});
socket.on('webrtc:answer', async ({ sessionId, sdp }) => {
  const session = sessions.get(sessionId);
  if (!session || session.direction !== 'send') return;
  try { await session.pc.setRemoteDescription(sdp); await flushIce(session); }
  catch (err) { console.warn('Resposta WebRTC não aplicada', err); }
});
socket.on('webrtc:ice', async ({ sessionId, candidate }) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.pc.remoteDescription) return queueIce(session, candidate);
  try { await session.pc.addIceCandidate(candidate); } catch {}
});

/* Grade e mix */
function getStreamingMembers() {
  return [...members.values()].filter(m => m.streaming || (m.clientId === clientId && localStream));
}
function ensureTile(member) {
  const stage = $('streamStage');
  let tile = stage.querySelector(`.stream-tile[data-client-id="${CSS.escape(member.clientId)}"]`);
  if (!tile) {
    tile = document.createElement('article');
    tile.className = 'stream-tile';
    tile.dataset.clientId = member.clientId;
    tile.innerHTML = `
      <div class="tile-top"><span class="quality-pill"></span><span class="local-pill hidden">SUA TELA • MUDO LOCAL</span></div>
      <div class="stream-waiting">Conectando à apresentação…</div>
      <div class="stream-overlay">
        <div class="stream-avatar-slot"></div>
        <div class="stream-meta"><b></b><small></small></div>
        <span class="live-pill">AO VIVO</span><span class="tile-spacer"></span>
        <span class="audio-indicator">▥</span><button class="stream-menu">•••</button>
      </div>`;
    tile.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      focusedClientId = member.clientId;
      layoutMode = 'focus';
      renderLayout();
    });
    stage.appendChild(tile);
  }
  tile.classList.toggle('local', member.clientId === clientId);
  tile.querySelector('.quality-pill').textContent = member.quality || 'Auto';
  tile.querySelector('.local-pill').classList.toggle('hidden', member.clientId !== clientId);
  const slot = tile.querySelector('.stream-avatar-slot');
  slot.innerHTML = member.avatar ? `<img class="stream-avatar-fallback" src="${member.avatar}" alt="" />` : `<div class="stream-avatar-fallback">${escapeHtml(initials(member.name))}</div>`;
  tile.querySelector('.stream-meta b').textContent = member.name || 'Visitante';
  tile.querySelector('.stream-meta small').textContent = member.clientId === clientId ? 'Você está apresentando' : (member.audio ? 'Áudio disponível' : 'Sem áudio');
  tile.querySelector('.audio-indicator').textContent = member.audio ? '▥' : '×';

  const stream = member.clientId === clientId ? localStream : remoteStreams.get(member.clientId)?.stream;
  let video = tile.querySelector('video');
  const waiting = tile.querySelector('.stream-waiting');
  if (stream) {
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true; video.playsInline = true;
      tile.insertBefore(video, tile.firstChild);
    }
    if (video.srcObject !== stream) video.srcObject = stream;
    video.muted = member.clientId === clientId;
    if (member.clientId === clientId) { video.volume = 0; video.setAttribute('aria-label', 'Sua transmissão local muda'); }
    else applyVolumeFor(member.clientId, video);
    waiting?.classList.add('hidden');
  } else {
    if (video) { video.srcObject = null; video.remove(); }
    waiting?.classList.remove('hidden');
  }
  return tile;
}
function syncStreamTiles() {
  const stage = $('streamStage');
  const streaming = getStreamingMembers();
  const valid = new Set(streaming.map(m => m.clientId));
  stage.querySelectorAll('.stream-tile').forEach(tile => {
    if (!valid.has(tile.dataset.clientId)) tile.remove();
  });
  streaming.forEach(ensureTile);
  $('emptyState').classList.toggle('hidden', streaming.length > 0);
  $('liveCountLabel').textContent = `${streaming.length} apresentando`;
  if (streaming.length === 1) focusedClientId = streaming[0].clientId;
  if (focusedClientId && !valid.has(focusedClientId)) focusedClientId = streaming[0]?.clientId || null;
  renderLayout();
}
function renderLayout() {
  const stage = $('streamStage');
  const count = getStreamingMembers().length;
  stage.classList.toggle('one-stream', count === 1);
  stage.classList.toggle('grid-layout', layoutMode === 'grid');
  stage.classList.toggle('focus-layout', layoutMode === 'focus' && count > 1);
  stage.querySelectorAll('.stream-tile').forEach(tile => tile.classList.toggle('focused', layoutMode === 'focus' && tile.dataset.clientId === focusedClientId));
  $('gridBtn').classList.toggle('active', layoutMode === 'grid');
  $('focusBtn').classList.toggle('active', layoutMode === 'focus');
}
function mixState(client) {
  if (!channelMix.has(client)) channelMix.set(client, { volume: 1, muted: false });
  return channelMix.get(client);
}
function applyVolumeFor(id, video = null) {
  if (id === clientId) return;
  const state = mixState(id);
  const target = video || document.querySelector(`.stream-tile[data-client-id="${CSS.escape(id)}"] video`);
  if (!target) return;
  const soloBlocks = soloClientId && soloClientId !== id;
  target.muted = Boolean(state.muted || soloBlocks);
  target.volume = Math.max(0, Math.min(1, masterVolume * state.volume));
}
function applyAllVolumes() {
  for (const member of getStreamingMembers()) if (member.clientId !== clientId) applyVolumeFor(member.clientId);
}
function renderMixer() {
  const wrap = $('mixerChannels');
  const streaming = getStreamingMembers();
  if (!streaming.length) {
    wrap.innerHTML = '<div class="mixer-note">Nenhuma transmissão ativa.</div>';
    return;
  }
  wrap.innerHTML = '';
  for (const member of streaming) {
    const local = member.clientId === clientId;
    const state = mixState(member.clientId);
    const channel = document.createElement('div');
    channel.className = 'mixer-channel';
    channel.innerHTML = `
      <div class="mixer-channel-head">${member.avatar ? `<img src="${member.avatar}" alt="" />` : `<div class="mix-fallback">${escapeHtml(initials(member.name))}</div>`}<b>${escapeHtml(member.name)}</b><span>${local ? 'LOCAL' : Math.round(state.volume*100)+'%'}</span></div>
      <input class="channel-volume" type="range" min="0" max="100" value="${Math.round(state.volume*100)}" ${local ? 'disabled' : ''} />
      <div class="mixer-channel-actions"><button class="mix-toggle mute ${state.muted?'active':''}" ${local?'disabled':''}>M</button><button class="mix-toggle solo ${soloClientId===member.clientId?'active':''}" ${local?'disabled':''}>S</button></div>`;
    if (!local) {
      channel.querySelector('.channel-volume').addEventListener('input', e => {
        state.volume = Number(e.target.value)/100;
        channel.querySelector('.mixer-channel-head span').textContent = `${e.target.value}%`;
        applyVolumeFor(member.clientId);
      });
      channel.querySelector('.mute').addEventListener('click', e => {
        state.muted = !state.muted; e.currentTarget.classList.toggle('active', state.muted); applyVolumeFor(member.clientId);
      });
      channel.querySelector('.solo').addEventListener('click', () => {
        soloClientId = soloClientId === member.clientId ? null : member.clientId; renderMixer(); applyAllVolumes();
      });
    }
    wrap.appendChild(channel);
  }
}

/* Chat */
function appendChatMessage(message) {
  if (!message?.id || chatIds.has(message.id)) return;
  chatIds.add(message.id);
  const box = $('chatMessages');
  box.querySelector('.chat-empty')?.remove();
  const item = document.createElement('div');
  item.className = 'chat-message';
  const time = new Date(message.at || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  item.innerHTML = `${message.avatar ? `<img src="${message.avatar}" alt="" />` : `<div class="chat-avatar-fallback">${escapeHtml(initials(message.name))}</div>`}
    <div class="chat-body"><div class="chat-meta"><b>${escapeHtml(message.name)}</b><span>${time}</span></div><p>${escapeHtml(message.text).replace(/\n/g,'<br>')}</p></div>`;
  box.appendChild(item);
  box.scrollTop = box.scrollHeight;
}
function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text) return;
  socket.emit('chat:send', { text }, result => { if (!result?.ok) toast('Mensagem não enviada.'); });
  $('chatInput').value = '';
}

/* Avatar ajustável */
function openAvatarEditor() {
  avatarSource = currentAvatar || '/linozera-logo.png';
  avatarX = 0; avatarY = 0; avatarZoom = 1;
  $('avatarEditorImg').src = avatarSource;
  $('avatarZoom').value = '100';
  updateAvatarEditorPreview();
  showModal('avatarModal');
}
function updateAvatarEditorPreview() {
  $('avatarEditorImg').style.transform = `translate(calc(-50% + ${avatarX}px),calc(-50% + ${avatarY}px)) scale(${avatarZoom})`;
  $('avatarZoomLabel').textContent = `${Math.round(avatarZoom*100)}%`;
}
async function saveAvatar() {
  const img = $('avatarEditorImg');
  if (!img.complete || !img.naturalWidth) return toast('A imagem ainda está carregando.');
  const size = 256;
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#08050f'; ctx.fillRect(0,0,size,size);
  const base = Math.max(size / img.naturalWidth, size / img.naturalHeight);
  const scale = base * avatarZoom;
  const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
  const ratio = size / 220;
  ctx.drawImage(img, (size-w)/2 + avatarX*ratio, (size-h)/2 + avatarY*ratio, w, h);
  currentAvatar = canvas.toDataURL('image/jpeg', .86);
  localStorage.setItem('lnz_avatar', currentAvatar);
  updateProfileImages();
  hideModal('avatarModal');
  if (currentRoom) socket.emit('room:profile', { nickname: currentNickname, avatar: currentAvatar });
  toast('Avatar atualizado.');
}

/* Atualização */
async function checkForUpdate() {
  try {
    const data = await fetch(`/api/version?t=${Date.now()}`, { cache: 'no-store' }).then(r => r.json());
    if (data.version && data.version !== BUILD_VERSION && sessionStorage.getItem(`lnz_skip_update_${data.version}`) !== '1') {
      $('updateText').textContent = `Versão ${data.version}: ${(data.notes || []).slice(0,2).join(' • ')}`;
      $('updateBanner').dataset.version = data.version;
      $('updateBanner').classList.remove('hidden');
      playUISound('update');
    }
  } catch {}
}
setInterval(checkForUpdate, 60000);

/* Eventos socket */
socket.on('room:status', data => { if (currentRoom && normalizeRoom(data.roomId) === currentRoom) applyRoomStatus(data); });
socket.on('member:joined', () => { playUISound('join'); socket.emit('room:status'); });
socket.on('member:left', ({ clientId: leftId }) => {
  remoteStreams.delete(leftId); channelMix.delete(leftId); if (soloClientId === leftId) soloClientId = null;
  playUISound('leave'); socket.emit('room:status');
});
socket.on('stream:state', ({ clientId: id, socketId, active, quality, audio }) => {
  const member = members.get(id);
  if (member) { member.streaming = Boolean(active); member.quality = quality || member.quality; member.audio = Boolean(audio); member.socketId = socketId || member.socketId; }
  if (!active && id !== clientId) {
    remoteStreams.delete(id);
    for (const [sid, s] of [...sessions]) if (s.direction === 'recv' && s.peerClientId === id) closeSession(sid);
  }
  syncStreamTiles(); renderMixer();
  if (id !== clientId) playUISound(active ? 'start' : 'stop');
});
socket.on('chat:message', message => { appendChatMessage(message); if (message.clientId !== clientId) playUISound('chat'); });
socket.on('room:closed', () => { resetRoomState(); showHome(); toast('A sala foi encerrada.'); playUISound('leave'); });
socket.on('member:replaced', () => { resetRoomState(); showHome(); toast('Sua sessão foi aberta em outra aba.'); });
socket.on('connect', () => {
  $('connection').innerHTML = '<i></i><span>Conectado</span>';
  if (reconnecting) playUISound('connected');
  reconnecting = false;
  if (currentRoom) joinRoom(currentRoom, true);
});
socket.on('disconnect', () => {
  reconnecting = true;
  $('connection').innerHTML = '<span>Reconectando…</span>';
  closeAllSessions();
});

/* Controles */
$('nicknameInput').value = currentNickname;
updateNicknameCounter(); updateProfileImages();
$('nicknameInput').addEventListener('input', updateNicknameCounter);
$('roomInput').addEventListener('input', e => { e.target.value = formatRoom(e.target.value); });
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(e.target.value); });
$('createBtn').addEventListener('click', createRoom);
$('heroCreateBtn').addEventListener('click', () => $('entryCard').scrollIntoView({ behavior:'smooth', block:'center' }));
$('navEnterBtn').addEventListener('click', () => $('entryCard').scrollIntoView({ behavior:'smooth', block:'center' }));
$('joinBtn').addEventListener('click', () => joinRoom($('roomInput').value));
$('refreshRoomsBtn').addEventListener('click', loadPublicRooms);
$('homeAvatarBtn').addEventListener('click', openAvatarEditor);
$('editAvatarBtn').addEventListener('click', openAvatarEditor);
$('editAvatarBtn2').addEventListener('click', openAvatarEditor);
$('copyCodeBtn').addEventListener('click', () => copyText(formatRoom(currentRoom), 'Código copiado.'));
$('topRoomCode').addEventListener('click', () => copyText(formatRoom(currentRoom), 'Código copiado.'));
$('copyLinkBtn').addEventListener('click', () => copyText(roomInviteUrl(), 'Link do convite copiado.'));
$('lockBtn').addEventListener('click', toggleLock);
$('closeRoomBtn').addEventListener('click', closeRoom);
$('leaveBtn').addEventListener('click', leaveRoom);

[$('shareBtn'), $('emptyShareBtn')].forEach(btn => btn.addEventListener('click', () => {
  if (localStream) stopSharing(true); else showModal('shareModal');
}));
$('qualityBtn').addEventListener('click', () => showModal('shareModal'));
$$('[data-quality]').forEach(btn => btn.addEventListener('click', () => {
  selectedQuality = btn.dataset.quality;
  localStorage.setItem('lnz_quality', selectedQuality);
  $$('[data-quality]').forEach(b => b.classList.toggle('selected', b === btn));
  $('qualityDockLabel').textContent = QUALITY[selectedQuality].label;
}));
$('confirmShareBtn').addEventListener('click', async () => {
  hideModal('shareModal');
  if (localStream) { await applyQualityToLocalTrack(); toast(`Qualidade ajustada para ${QUALITY[selectedQuality].label}.`); }
  else await startSharing();
});
$('qualityDockLabel').textContent = QUALITY[selectedQuality]?.label || QUALITY.auto.label;
$$('[data-quality]').forEach(b => b.classList.toggle('selected', b.dataset.quality === selectedQuality));

$('gridBtn').addEventListener('click', () => { layoutMode='grid'; renderLayout(); });
$('focusBtn').addEventListener('click', () => { layoutMode='focus'; focusedClientId ||= getStreamingMembers()[0]?.clientId || null; renderLayout(); });
$('fullscreenBtn').addEventListener('click', async () => {
  const focused = focusedClientId ? document.querySelector(`.stream-tile[data-client-id="${CSS.escape(focusedClientId)}"]`) : null;
  const target = focused || $('stageArea') || $('roomView');
  try { if (!document.fullscreenElement) await target.requestFullscreen(); else await document.exitFullscreen(); }
  catch { toast('Não foi possível abrir em tela cheia.'); }
});

$('mixerBtn').addEventListener('click', () => { renderMixer(); $('mixerPanel').classList.toggle('hidden'); });
$('closeMixerBtn').addEventListener('click', () => $('mixerPanel').classList.add('hidden'));
$('masterVolume').addEventListener('input', e => { masterVolume = Number(e.target.value)/100; $('masterVolumeLabel').textContent = `${e.target.value}%`; applyAllVolumes(); });
$('chatToggleBtn').addEventListener('click', () => $('chatPanel').classList.toggle('closed'));
$('closeChatBtn').addEventListener('click', () => $('chatPanel').classList.add('closed'));
$('sendChatBtn').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

$('avatarFile').addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Escolha uma imagem válida.');
  if (file.size > 8 * 1024 * 1024) return toast('Use uma imagem de até 8 MB.');
  const reader = new FileReader();
  reader.onload = () => { avatarSource = String(reader.result); $('avatarEditorImg').src = avatarSource; avatarX=0; avatarY=0; avatarZoom=1; $('avatarZoom').value='100'; updateAvatarEditorPreview(); };
  reader.readAsDataURL(file);
});
$$('[data-move]').forEach(btn => btn.addEventListener('click', () => {
  const move = btn.dataset.move, step = 8;
  if (move === 'up') avatarY -= step;
  if (move === 'down') avatarY += step;
  if (move === 'left') avatarX -= step;
  if (move === 'right') avatarX += step;
  if (move === 'center') { avatarX=0; avatarY=0; }
  updateAvatarEditorPreview();
}));
$('avatarZoom').addEventListener('input', e => { avatarZoom = Number(e.target.value)/100; updateAvatarEditorPreview(); });
$('saveAvatarBtn').addEventListener('click', saveAvatar);

$('settingsBtn').addEventListener('click', () => showModal('settingsModal'));
$('soundToggle').checked = soundEnabled;
$('soundVolume').value = String(Math.round(soundVolume*100));
$('soundVolumeLabel').textContent = `${Math.round(soundVolume*100)}%`;
$('soundToggle').addEventListener('change', e => { soundEnabled=e.target.checked; localStorage.setItem('lnz_sounds', soundEnabled?'1':'0'); if (soundEnabled) playUISound('tap'); });
$('soundVolume').addEventListener('input', e => { soundVolume=Number(e.target.value)/100; localStorage.setItem('lnz_sound_volume', e.target.value); $('soundVolumeLabel').textContent=`${e.target.value}%`; });

$$('[data-close]').forEach(btn => btn.addEventListener('click', () => hideModal(btn.dataset.close)));
$$('.modal-backdrop').forEach(backdrop => backdrop.addEventListener('click', e => { if (e.target === backdrop) hideModal(backdrop.id); }));
$('updateNowBtn').addEventListener('click', () => location.reload());
$('updateLaterBtn').addEventListener('click', () => { const v=$('updateBanner').dataset.version; if(v) sessionStorage.setItem(`lnz_skip_update_${v}`,'1'); $('updateBanner').classList.add('hidden'); });

window.addEventListener('beforeunload', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (currentRoom && socket.connected) socket.emit('room:leave');
});

const initialRoom = normalizeRoom(new URLSearchParams(location.search).get('room'));
if (initialRoom) $('roomInput').value = formatRoom(initialRoom);
loadPublicRooms(); checkForUpdate();
setInterval(loadPublicRooms, 15000);

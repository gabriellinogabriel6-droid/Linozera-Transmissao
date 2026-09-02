const BUILD_VERSION = '4.5.0';
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
if (!QUALITY[selectedQuality]) selectedQuality = 'auto';
let layoutMode = 'grid';
let focusedClientId = null;
let reconnecting = false;

const peers = new Map();
const pendingIce = new Map();
const knownViewers = new Set();
let viewerHostId = null;
const remoteStreams = new Map();
const chatIds = new Set();
const channelMix = new Map();
const audioPipelines = new Map();
let masterVolume = Math.max(0, Math.min(1.5, Number(localStorage.getItem('lnz_master_volume') ?? '110') / 100));
let soloClientId = null;

let soundEnabled = localStorage.getItem('lnz_sounds') !== '0';
let soundVolume = Math.max(0, Math.min(1, Number(localStorage.getItem('lnz_sound_volume') ?? '70') / 100));
let autoChatOpen = localStorage.getItem('lnz_auto_chat') !== '0';
let audioBoostEnabled = localStorage.getItem('lnz_audio_boost') !== '0';
let audioContext = null;
let publicRoomsLoading = false;

let avatarSource = currentAvatar || '/default-avatar.png';
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
  return avatar && avatar.startsWith('data:image/') ? avatar : '/default-avatar.png';
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
  const src = currentAvatar || '/default-avatar.png';
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
document.addEventListener('pointerdown', () => { if (soundEnabled || audioBoostEnabled) ensureAudioContext(); }, { once: true });

/* Áudio recebido: Web Audio permite reforço acima de 100% sem mexer no áudio enviado. */
function disposeAudioPipeline(id) {
  const pipe = audioPipelines.get(id);
  if (!pipe) return;
  try { pipe.source.disconnect(); } catch {}
  try { pipe.gain.disconnect(); } catch {}
  audioPipelines.delete(id);
}
function disposeAllAudioPipelines() {
  [...audioPipelines.keys()].forEach(disposeAudioPipeline);
}
function ensureRemoteAudioPipeline(id, stream) {
  if (!id || id === clientId || !stream?.getAudioTracks?.().length) {
    disposeAudioPipeline(id);
    return null;
  }
  const existing = audioPipelines.get(id);
  if (existing?.stream === stream) return existing;
  disposeAudioPipeline(id);
  try {
    const ctx = ensureAudioContext();
    const audioOnly = new MediaStream(stream.getAudioTracks());
    const source = ctx.createMediaStreamSource(audioOnly);
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    const pipe = { stream, source, gain };
    audioPipelines.set(id, pipe);
    return pipe;
  } catch (error) {
    console.warn('Áudio reforçado indisponível; usando volume padrão do navegador.', error);
    return null;
  }
}

/* Lobby */
async function loadPublicRooms(showFeedback = false) {
  const grid = $('publicRoomsGrid');
  const status = $('publicRoomsStatus');
  const button = $('refreshRoomsBtn');
  if (!grid || publicRoomsLoading) return;
  publicRoomsLoading = true;
  if (button) { button.disabled = true; button.classList.add('loading'); button.textContent = '↻ Atualizando…'; }
  if (status) status.textContent = 'Buscando salas no servidor…';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(`/api/public-rooms?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const list = Array.isArray(data.rooms) ? data.rooms : [];
    if (!list.length) {
      grid.innerHTML = '<div class="public-empty"><b>Nenhuma sala pública agora.</b><span>Crie uma sala e ative “Listar minha sala no lobby”.</span></div>';
    } else {
      grid.innerHTML = list.map(room => {
        const live = Boolean(room.streaming);
        const locked = Boolean(room.locked);
        const badge = locked ? '🔒 TRANCADA' : (live ? '● AO VIVO' : '◌ ABERTA');
        const badgeClass = locked ? 'locked' : (live ? 'live' : 'open');
        return `
          <article class="public-card ${locked ? 'is-locked' : ''}" data-room="${escapeHtml(room.roomId)}" data-locked="${locked ? '1' : '0'}">
            <div class="public-thumb"><span class="live-badge ${badgeClass}">${badge}</span><div class="public-logo-mark">LNZ</div></div>
            <div class="public-info">
              <h3>${escapeHtml(room.roomId)}</h3>
              <p>${escapeHtml(room.ownerName || 'Linozera')}</p>
              <div class="public-stats"><span>♙ ${Number(room.members || 0)} na sala</span><span>${live ? '▥ transmitindo' : '◌ aguardando'}</span></div>
              <span class="privacy-badge">${locked ? 'SALA TRANCADA' : 'ENTRAR NA SALA →'}</span>
            </div>
          </article>`;
      }).join('');
      $$('.public-card').forEach(card => card.addEventListener('click', () => {
        $('roomInput').value = card.dataset.room;
        $('entryCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (card.dataset.locked === '1') toast('Essa sala está trancada. O dono precisa destrancar para novos participantes.');
        else toast(`Sala ${card.dataset.room} selecionada.`);
      }));
    }
    const now = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    if (status) status.textContent = `${list.length} sala${list.length === 1 ? '' : 's'} • atualizado às ${now}`;
    if (showFeedback) toast(list.length ? `${list.length} sala(s) pública(s) encontrada(s).` : 'Lista atualizada. Nenhuma sala pública agora.');
  } catch (error) {
    console.error('Falha ao carregar salas públicas', error);
    grid.innerHTML = '<div class="public-empty error"><b>Não foi possível carregar as salas.</b><span>Confira a conexão com o Render e tente novamente.</span></div>';
    if (status) status.textContent = 'Falha ao atualizar';
    if (showFeedback) toast('Falha ao atualizar as salas públicas.');
  } finally {
    publicRoomsLoading = false;
    if (button) { button.disabled = false; button.classList.remove('loading'); button.textContent = 'Ver todas as salas  →'; }
  }
}

function syncSettingsUI() {
  const soundToggle = $('soundToggle');
  const soundRange = $('soundVolume');
  const autoChat = $('autoChatToggle');
  const defaultMaster = $('defaultMasterVolume');
  const boost = $('audioBoostToggle');
  const quality = $('defaultQualitySelect');
  const roomUnavailable = $('roomSettingsUnavailable');
  const roomControls = $('roomSettingsControls');
  const roomPublicToggle = $('roomPublicToggleSettings');
  const roomLockToggle = $('roomLockToggleSettings');

  if (soundToggle) soundToggle.checked = soundEnabled;
  if (soundRange) soundRange.value = String(Math.round(soundVolume * 100));
  if ($('soundVolumeLabel')) $('soundVolumeLabel').textContent = `${Math.round(soundVolume * 100)}%`;
  if (autoChat) autoChat.checked = autoChatOpen;

  const masterPct = Math.round(masterVolume * 100);
  if ($('masterVolume')) $('masterVolume').value = String(masterPct);
  if ($('masterVolumeLabel')) $('masterVolumeLabel').textContent = `${masterPct}%`;
  if (defaultMaster) defaultMaster.value = String(masterPct);
  if ($('defaultMasterVolumeLabel')) $('defaultMasterVolumeLabel').textContent = `${masterPct}%`;
  if (boost) boost.checked = audioBoostEnabled;
  if (quality) quality.value = selectedQuality;

  const inRoom = Boolean(currentRoom);
  if (roomUnavailable) roomUnavailable.classList.toggle('hidden', inRoom);
  if (roomControls) roomControls.classList.toggle('hidden', !inRoom);
  if (roomPublicToggle) {
    roomPublicToggle.checked = roomPublic;
    roomPublicToggle.disabled = !isOwner;
  }
  if (roomLockToggle) {
    roomLockToggle.checked = roomLocked;
    roomLockToggle.disabled = !isOwner;
  }
  if ($('settingsRefreshRoomBtn')) $('settingsRefreshRoomBtn').disabled = !inRoom;
  if ($('settingsCopyInviteBtn')) $('settingsCopyInviteBtn').disabled = !inRoom;
  if ($('settingsCloseRoomBtn')) $('settingsCloseRoomBtn').disabled = !inRoom || !isOwner;
  if ($('roomSettingsStatus')) {
    $('roomSettingsStatus').textContent = inRoom
      ? (isOwner ? 'Você é o dono desta sala.' : 'Somente o dono pode alterar visibilidade e bloqueio.')
      : 'Entre em uma sala para usar estas opções.';
  }
}

function openSettings(tab = 'general') {
  syncSettingsUI();
  const target = currentRoom && tab === 'room' ? 'room' : tab;
  $$('.settings-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.settingsTab === target));
  $$('[data-settings-pane]').forEach(pane => pane.classList.toggle('active', pane.dataset.settingsPane === target));
  showModal('settingsModal');
}

function selectSettingsTab(tab) {
  $$('.settings-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.settingsTab === tab));
  $$('[data-settings-pane]').forEach(pane => pane.classList.toggle('active', pane.dataset.settingsPane === tab));
  syncSettingsUI();
}

function showRoom() {
  $('home').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('chatPanel').classList.toggle('closed', !autoChatOpen);
  updateProfileImages();
  syncSettingsUI();
}
function showHome() {
  $('roomView').classList.add('hidden');
  $('home').classList.remove('hidden');
  document.body.style.overflow = '';
  loadPublicRooms();
}

function createRoom() {
  try { ensureAudioContext(); } catch {}
  const nickname = requireNickname();
  if (!nickname) return;
  playUISound('tap');
  socket.emit('room:create', {
    clientId,
    nickname,
    avatar: currentAvatar,
    isPublic: !$('publicToggle').checked
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
  if (!fromReconnect) { try { ensureAudioContext(); } catch {} }
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
  if (!isOwner) viewerHostId = result.hostId || viewerHostId;
  if (isOwner) knownViewers.clear();
  playUISound('join');
  if (localStream && isOwner) {
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
  cleanupPeersForMembers();
  if (localStream && isOwner) ensureHostPeers();
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
  [$('shareBtn'), $('emptyShareBtn'), $('qualityBtn')].forEach(el => { if (el) { el.disabled = !isOwner; el.classList.toggle('disabled', !isOwner); } });
  if (!localStream) $('shareBtnLabel').textContent = isOwner ? 'Compartilhar tela' : 'Somente assistir';
  syncSettingsUI();
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
function setRoomLock(nextLocked, showFeedback = true) {
  if (!isOwner) return showFeedback && toast('Apenas o dono da sala pode alterar o bloqueio.');
  socket.emit('room:lock', { locked: Boolean(nextLocked) }, result => {
    if (!result?.ok) return toast(result?.error || 'Não foi possível alterar a sala.');
    roomLocked = Boolean(result.locked);
    renderRoomState();
    syncSettingsUI();
    playUISound(roomLocked ? 'lock' : 'unlock');
    if (showFeedback) toast(roomLocked ? 'Sala trancada.' : 'Sala destrancada.');
  });
}
function toggleLock() { setRoomLock(!roomLocked); }
function setRoomVisibility(nextPublic, showFeedback = true) {
  if (!isOwner) return showFeedback && toast('Apenas o dono pode alterar a visibilidade da sala.');
  socket.emit('room:visibility', { isPublic: Boolean(nextPublic) }, result => {
    if (!result?.ok) return toast(result?.error || 'Não foi possível alterar a visibilidade.');
    roomPublic = Boolean(result.isPublic);
    renderRoomState();
    syncSettingsUI();
    if (showFeedback) toast(roomPublic ? 'Sala pública: ela aparecerá no lobby.' : 'Sala privada: removida do lobby.');
    loadPublicRooms();
  });
}
function refreshRoomStatus(showFeedback = true) {
  if (!currentRoom) return showFeedback && toast('Você ainda não entrou em uma sala.');
  const buttons = [$('refreshRoomBtn'), $('settingsRefreshRoomBtn')].filter(Boolean);
  buttons.forEach(btn => { btn.disabled = true; btn.dataset.oldText ||= btn.textContent; btn.textContent = '↻ Atualizando…'; });
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    buttons.forEach(btn => { btn.disabled = false; btn.textContent = btn.dataset.oldText || '↻ Atualizar sala'; });
    if (result?.ok && result.status) {
      applyRoomStatus(result.status);
      const now = new Date().toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      if ($('roomSettingsStatus')) $('roomSettingsStatus').textContent = `Sala sincronizada às ${now}.`;
      if (showFeedback) toast('Sala atualizada com o servidor.');
    } else if (showFeedback) toast(result?.error || 'Não foi possível atualizar a sala.');
  };
  const timer = setTimeout(() => finish({ ok:false, error:'O servidor demorou para responder.' }), 6000);
  socket.emit('room:status', {}, result => { clearTimeout(timer); finish(result); });
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
  closeAllPeers();
  knownViewers.clear();
  viewerHostId = null;
  remoteStreams.clear();
  disposeAllAudioPipelines();
  members.clear();
  channelMix.clear();
  soloClientId = null;
  chatIds.clear();
  $('chatMessages').innerHTML = '<div class="chat-empty"><b>▢</b><strong>Nenhuma mensagem ainda</strong><span>Envie uma mensagem para a sala.</span></div>';
  currentRoom = null;
  isOwner = false;
  roomLocked = false;
  setRoomUrl(null);
  syncStreamTiles();
}

/* WebRTC estável da V3: um transmissor principal (dono) -> espectadores */
function closePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch {}
  }
  peers.delete(peerId);
  pendingIce.delete(peerId);
}
function closeAllPeers() {
  [...peers.keys()].forEach(closePeer);
}
function cleanupPeersForMembers() {
  const sockets = new Set([...members.values()].map(m => m.socketId).filter(Boolean));
  for (const peerId of [...peers.keys()]) if (!sockets.has(peerId)) closePeer(peerId);
  for (const viewerId of [...knownViewers]) if (!sockets.has(viewerId)) knownViewers.delete(viewerId);
}
function queueIce(peerId, candidate) {
  const queue = pendingIce.get(peerId) || [];
  queue.push(candidate);
  pendingIce.set(peerId, queue);
}
async function flushIce(peerId, pc) {
  const queue = pendingIce.get(peerId) || [];
  pendingIce.delete(peerId);
  for (const candidate of queue) {
    try { await pc.addIceCandidate(candidate); } catch (err) { console.warn('ICE ignorado', err); }
  }
}
function makePeer(peerId, mode) {
  closePeer(peerId);
  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(peerId, pc);
  pc.onicecandidate = event => {
    if (event.candidate) socket.emit('webrtc:ice', { target: peerId, candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      if (mode === 'viewer') toast('A conexão direta falhou. Configure um TURN no Render para redes restritas.', 4500);
      closePeer(peerId);
    }
  };
  return pc;
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
  if (isOwner) for (const pc of peers.values()) await applySenderBitrate(pc);
  const self = members.get(clientId);
  if (self) { self.quality = cfg.label; syncStreamTiles(); }
  if (isOwner) socket.emit('room:stream', { active: true, quality: cfg.label, audio: localStream.getAudioTracks().length > 0 });
}
async function makeHostPeer(viewerId) {
  if (!isOwner || !localStream || !viewerId || viewerId === socket.id) return;
  knownViewers.add(viewerId);
  const pc = makePeer(viewerId, 'host');
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await applySenderBitrate(pc);
    socket.emit('webrtc:offer', { target: viewerId, sdp: pc.localDescription });
  } catch (error) {
    console.error('Falha ao criar oferta', error);
    closePeer(viewerId);
  }
}
function ensureHostPeers() {
  if (!isOwner || !localStream) return;
  for (const member of members.values()) {
    if (member.clientId === clientId || !member.socketId) continue;
    knownViewers.add(member.socketId);
    if (!peers.has(member.socketId)) makeHostPeer(member.socketId);
  }
}
function ownerInRoom() {
  return [...members.values()].find(m => m.owner) || null;
}
function ensureViewerPeer(hostId) {
  let pc = peers.get(hostId);
  if (pc) return pc;
  pc = makePeer(hostId, 'viewer');
  pc.ontrack = event => {
    const stream = event.streams?.[0] || new MediaStream([event.track]);
    const host = findMemberBySocket(hostId) || ownerInRoom();
    const hostClientId = host?.clientId || 'host';
    viewerHostId = hostId;
    remoteStreams.clear();
    remoteStreams.set(hostClientId, { stream, socketId: hostId });
    if (host) { host.streaming = true; host.audio = stream.getAudioTracks().length > 0; }
    syncStreamTiles();
    renderMixer();
    const video = document.querySelector(`.stream-tile[data-client-id="${CSS.escape(hostClientId)}"] video`);
    if (video) video.play().catch(() => toast('Clique na página para liberar o áudio da transmissão.'));
  };
  return pc;
}
async function startSharing() {
  if (!currentRoom || localStream) return;
  if (!isOwner) return toast('Na transmissão estável da V3, somente o dono da sala apresenta a tela.');
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Seu navegador não suporta compartilhamento de tela.');
  const cfg = QUALITY[selectedQuality] || QUALITY.auto;
  try {
    // Mantém o motor V3, mas preserva a proteção contra retorno solicitada.
    // Nunca pedimos microfone/câmera. A prévia local fica muda e o Chrome é orientado a não capturar o áudio geral do sistema.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: cfg.fps, max: cfg.fps } },
      audio: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'exclude',
      windowAudio: 'window',
      preferCurrentTab: false
    });
    const displaySurface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface || '';
    if (displaySurface === 'monitor' && stream.getAudioTracks().length) {
      // Tela inteira pode misturar Discord/Windows. Para garantir o modo sem retorno,
      // descartamos o áudio nessa modalidade. Janela/aba continua podendo enviar áudio.
      for (const track of [...stream.getAudioTracks()]) {
        try { stream.removeTrack(track); track.stop(); } catch {}
      }
      toast('Tela inteira: áudio do sistema foi removido para evitar retorno. Para transmitir som, compartilhe uma janela ou aba.');
    }
    localStream = stream;
    const self = members.get(clientId) || { clientId, socketId: socket.id, name: currentNickname, avatar: currentAvatar, owner: true };
    self.streaming = true;
    self.quality = cfg.label;
    self.audio = stream.getAudioTracks().length > 0;
    members.set(clientId, self);
    $('shareBtnLabel').textContent = 'Parar apresentação';
    $('shareBtn').classList.add('stop');
    syncStreamTiles();
    await applyQualityToLocalTrack();
    socket.emit('room:stream', { active: true, quality: cfg.label, audio: self.audio });
    for (const viewerId of knownViewers) makeHostPeer(viewerId);
    ensureHostPeers();
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.addEventListener('ended', () => stopSharing(true), { once: true });
    toast(self.audio ? 'Transmissão iniciada com áudio da janela/aba escolhida.' : 'Transmissão iniciada sem áudio.');
  } catch (err) {
    if (!['NotAllowedError', 'AbortError'].includes(err?.name)) {
      console.error(err);
      toast('Não foi possível iniciar a transmissão.');
      playUISound('error');
    }
  }
}
function stopSharing(notify = true) {
  if (!localStream) return;
  localStream.getTracks().forEach(track => { try { track.stop(); } catch {} });
  localStream = null;
  closeAllPeers();
  const self = members.get(clientId);
  if (self) { self.streaming = false; self.audio = false; }
  $('shareBtnLabel').textContent = 'Compartilhar tela';
  $('shareBtn').classList.remove('stop');
  if (socket.connected && currentRoom && isOwner) socket.emit('room:stream', { active: false, quality: QUALITY[selectedQuality].label, audio: false });
  syncStreamTiles();
  renderMixer();
  if (notify) { toast('Transmissão encerrada.'); playUISound('stop'); }
}

socket.on('viewer:joined', ({ viewerId }) => {
  if (!isOwner || !viewerId) return;
  knownViewers.add(viewerId);
  if (localStream) makeHostPeer(viewerId);
});
socket.on('viewer:left', ({ viewerId }) => {
  if (!viewerId) return;
  knownViewers.delete(viewerId);
  closePeer(viewerId);
});
socket.on('host:stream', ({ active, quality, audio }) => {
  if (isOwner) return;
  const host = ownerInRoom();
  if (host) {
    host.streaming = Boolean(active);
    host.quality = quality || host.quality;
    host.audio = Boolean(audio && active);
  }
  if (!active) {
    if (viewerHostId) closePeer(viewerHostId);
    viewerHostId = null;
    remoteStreams.clear();
    disposeAllAudioPipelines();
  }
  syncStreamTiles();
  renderMixer();
});
socket.on('host:reconnecting', () => {
  if (!isOwner) toast('O transmissor está se reconectando…');
});
socket.on('host:restored', ({ hostId }) => {
  if (isOwner) return;
  closeAllPeers();
  remoteStreams.clear();
  disposeAllAudioPipelines();
  viewerHostId = hostId || null;
  syncStreamTiles();
});
socket.on('webrtc:offer', async ({ from, sdp }) => {
  if (isOwner || !from || !sdp) return;
  viewerHostId = from;
  const pc = ensureViewerPeer(from);
  try {
    await pc.setRemoteDescription(sdp);
    await flushIce(from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', { target: from, sdp: pc.localDescription });
  } catch (error) {
    console.error('Falha ao responder oferta', error);
    closePeer(from);
  }
});
socket.on('webrtc:answer', async ({ from, sdp }) => {
  if (!isOwner) return;
  const pc = peers.get(from);
  if (!pc) return;
  try { await pc.setRemoteDescription(sdp); await flushIce(from, pc); }
  catch (error) { console.error('Falha ao aplicar resposta', error); }
});
socket.on('webrtc:ice', async ({ from, candidate }) => {
  if (!from || !candidate) return;
  let pc = peers.get(from);
  if (!pc && !isOwner) pc = ensureViewerPeer(from);
  if (!pc) return;
  if (!pc.remoteDescription) return queueIce(from, candidate);
  try { await pc.addIceCandidate(candidate); } catch (error) { console.warn('ICE não aplicado', error); }
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
    if (member.clientId === clientId) {
      video.muted = true;
      video.volume = 0;
      video.setAttribute('aria-label', 'Sua transmissão local muda');
    } else {
      const pipe = ensureRemoteAudioPipeline(member.clientId, stream);
      video.muted = Boolean(pipe);
      applyVolumeFor(member.clientId, video);
    }
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
  const soloBlocks = Boolean(soloClientId && soloClientId !== id);
  const blocked = Boolean(state.muted || soloBlocks);
  const maxGain = audioBoostEnabled ? 2 : 1;
  const effective = blocked ? 0 : Math.max(0, Math.min(maxGain, masterVolume * state.volume));
  const pipe = audioPipelines.get(id);
  if (pipe) {
    try { pipe.gain.gain.setTargetAtTime(effective, pipe.gain.context.currentTime, 0.015); } catch { pipe.gain.gain.value = effective; }
    if (target) target.muted = true;
    return;
  }
  if (!target) return;
  target.muted = blocked;
  target.volume = Math.max(0, Math.min(1, effective));
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
      <input class="channel-volume" type="range" min="0" max="${audioBoostEnabled ? 150 : 100}" value="${Math.round(state.volume*100)}" ${local ? 'disabled' : ''} />
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
  avatarSource = currentAvatar || '/default-avatar.png';
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
socket.on('public-rooms:changed', () => { if (!currentRoom) loadPublicRooms(false); });
socket.on('room:status', data => { if (currentRoom && normalizeRoom(data.roomId) === currentRoom) applyRoomStatus(data); });
socket.on('member:joined', () => { playUISound('join'); socket.emit('room:status'); });
socket.on('member:left', ({ clientId: leftId }) => {
  remoteStreams.delete(leftId); channelMix.delete(leftId); if (soloClientId === leftId) soloClientId = null;
  cleanupPeersForMembers();
  playUISound('leave'); socket.emit('room:status');
});
socket.on('stream:state', ({ clientId: id, socketId, active, quality, audio }) => {
  const member = members.get(id);
  if (member) { member.streaming = Boolean(active); member.quality = quality || member.quality; member.audio = Boolean(audio); member.socketId = socketId || member.socketId; }
  if (!active && id !== clientId) {
    remoteStreams.delete(id);
    const host = ownerInRoom();
    if (host?.clientId === id && viewerHostId) { closePeer(viewerHostId); viewerHostId = null; }
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
  closeAllPeers();
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
$('masterVolume').addEventListener('input', e => { masterVolume = Number(e.target.value)/100; localStorage.setItem('lnz_master_volume', e.target.value); $('masterVolumeLabel').textContent = `${e.target.value}%`; applyAllVolumes(); syncSettingsUI(); });
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

$('settingsBtn').addEventListener('click', () => openSettings('general'));
$('homeSettingsBtn').addEventListener('click', () => openSettings('general'));
$$('.settings-tab').forEach(btn => btn.addEventListener('click', () => selectSettingsTab(btn.dataset.settingsTab)));

$('soundToggle').addEventListener('change', e => {
  soundEnabled = e.target.checked;
  localStorage.setItem('lnz_sounds', soundEnabled ? '1' : '0');
  if (soundEnabled) playUISound('tap');
  syncSettingsUI();
});
$('soundVolume').addEventListener('input', e => {
  soundVolume = Number(e.target.value) / 100;
  localStorage.setItem('lnz_sound_volume', e.target.value);
  syncSettingsUI();
});
$('autoChatToggle').addEventListener('change', e => {
  autoChatOpen = e.target.checked;
  localStorage.setItem('lnz_auto_chat', autoChatOpen ? '1' : '0');
  if (currentRoom) $('chatPanel').classList.toggle('closed', !autoChatOpen);
  syncSettingsUI();
});
$('defaultMasterVolume').addEventListener('input', e => {
  masterVolume = Number(e.target.value) / 100;
  localStorage.setItem('lnz_master_volume', e.target.value);
  applyAllVolumes();
  syncSettingsUI();
});
$('audioBoostToggle').addEventListener('change', e => {
  audioBoostEnabled = e.target.checked;
  localStorage.setItem('lnz_audio_boost', audioBoostEnabled ? '1' : '0');
  if (!audioBoostEnabled && masterVolume > 1) masterVolume = 1;
  renderMixer();
  applyAllVolumes();
  syncSettingsUI();
});
$('defaultQualitySelect').addEventListener('change', e => {
  if (!QUALITY[e.target.value]) return;
  selectedQuality = e.target.value;
  localStorage.setItem('lnz_quality', selectedQuality);
  $('qualityDockLabel').textContent = QUALITY[selectedQuality].label;
  $$('[data-quality]').forEach(b => b.classList.toggle('selected', b.dataset.quality === selectedQuality));
  syncSettingsUI();
});
$('roomPublicToggleSettings').addEventListener('change', e => setRoomVisibility(e.target.checked));
$('roomLockToggleSettings').addEventListener('change', e => setRoomLock(e.target.checked));
$('settingsRefreshRoomBtn').addEventListener('click', () => refreshRoomStatus(true));
$('settingsCopyInviteBtn').addEventListener('click', () => currentRoom && copyText(roomInviteUrl(), 'Link do convite copiado.'));
$('settingsCloseRoomBtn').addEventListener('click', closeRoom);
$('settingsDoneBtn').addEventListener('click', () => hideModal('settingsModal'));
$('refreshRoomBtn').addEventListener('click', () => refreshRoomStatus(true));

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
syncSettingsUI();
loadPublicRooms(); checkForUpdate();
setInterval(loadPublicRooms, 15000);

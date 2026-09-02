'use strict';

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const QUALITY = {
  auto: { label: 'Automático', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  '480': { label: '480p • 30 FPS', width: 854, height: 480, fps: 30, bitrate: 1_250_000 },
  '720': { label: '720p • 30 FPS', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '1080': { label: '1080p • 30 FPS', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  '1080-60': { label: '1080p • 60 FPS', width: 1920, height: 1080, fps: 60, bitrate: 7_000_000 },
  '1440-60': { label: '1440p • 60 FPS', width: 2560, height: 1440, fps: 60, bitrate: 11_000_000 }
};

const STORE = {
  clientId: 'lnz_v5_client_id',
  nickname: 'lnz_v5_nickname',
  avatar: 'lnz_v5_avatar',
  quality: 'lnz_v5_quality',
  volume: 'lnz_v5_volume',
  sounds: 'lnz_v5_sounds',
  compressor: 'lnz_v5_compressor',
  autoChat: 'lnz_v5_auto_chat',
  updates: 'lnz_v5_updates'
};

function stableClientId() {
  let id = localStorage.getItem(STORE.clientId);
  if (!id) {
    id = crypto.randomUUID?.() || `lnz-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(STORE.clientId, id);
  }
  return id;
}

const clientId = stableClientId();
let currentNickname = (localStorage.getItem(STORE.nickname) || 'Linozera').slice(0, 24);
let currentAvatar = localStorage.getItem(STORE.avatar) || '';
let selectedQuality = QUALITY[localStorage.getItem(STORE.quality)] ? localStorage.getItem(STORE.quality) : 'auto';
let masterVolume = clamp(Number(localStorage.getItem(STORE.volume) || 120), 0, 150);
let uiSounds = localStorage.getItem(STORE.sounds) !== 'false';
let compressorEnabled = localStorage.getItem(STORE.compressor) !== 'false';
let autoChat = localStorage.getItem(STORE.autoChat) !== 'false';
let updateNotices = localStorage.getItem(STORE.updates) !== 'false';

let currentRoom = sessionStorage.getItem('lnz_v5_room') || '';
let ownerToken = sessionStorage.getItem('lnz_v5_owner_token') || '';
let isOwner = sessionStorage.getItem('lnz_v5_is_owner') === 'true';
let roomStatus = null;
let config = { version: '5.0.0', iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let localStream = null;
let remoteStream = null;
let remoteHostSocketId = null;
let attachedRemoteAt = 0;
let lastBlackRecovery = 0;
let peers = new Map();
let pendingIce = new Map();
let peerRecovery = new Map();
let hostBuilding = new Set();
let adaptiveTimer = null;
let publicPollTimer = null;
let roomRefreshTimer = null;
let rejoinInFlight = false;
let chatIds = new Set();
let channelVolume = new Map();
let channelMuted = new Set();
let soloClientId = null;
let audioContext = null;
let audioPipeline = null;
let avatarEdit = { dataUrl: '', x: 0, y: 0, zoom: 100 };
let toastTimer = null;

const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 700,
  reconnectionDelayMax: 3500,
  timeout: 12000
});

function clamp(n, min, max) { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function normalizeRoom(v) {
  const raw = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function initials(name) {
  return String(name || 'L').trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || '').join('') || 'L';
}
function avatarSrc(value) { return value || '/default-avatar.png'; }
function timeLabel(ts) {
  try { return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}
function roomUrl(code = currentRoom) {
  if (!code) return location.origin;
  const url = new URL(location.origin);
  url.searchParams.set('sala', normalizeRoom(code));
  return url.toString();
}
function ackEmit(event, payload = {}, timeout = 9000) {
  return new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'O servidor demorou para responder.' }); } }, timeout);
    socket.emit(event, payload, response => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(response || { ok: false });
    });
  });
}
function toast(text, duration = 3200) {
  if (!text) return;
  clearTimeout(toastTimer);
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.classList.add('hidden'), 180); }, duration);
}
function showModal(id) { $(id)?.classList.remove('hidden'); }
function hideModal(id) { $(id)?.classList.add('hidden'); }
function saveProfile() {
  currentNickname = String($('nicknameInput')?.value || currentNickname || 'Linozera').trim().slice(0, 24) || 'Linozera';
  localStorage.setItem(STORE.nickname, currentNickname);
  if (currentAvatar) localStorage.setItem(STORE.avatar, currentAvatar); else localStorage.removeItem(STORE.avatar);
  syncProfileUI();
}
function syncProfileUI() {
  if ($('nicknameInput')) $('nicknameInput').value = currentNickname;
  if ($('nicknameCounter')) $('nicknameCounter').textContent = `${currentNickname.length}/24`;
  for (const id of ['homeAvatar', 'sideAvatar', 'videoAvatar']) if ($(id)) $(id).src = avatarSrc(currentAvatar);
  if ($('sideProfileName')) $('sideProfileName').textContent = currentNickname;
}

/* ---------- UI sounds: generated locally; disabled while presenting ---------- */
async function getAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioContext) audioContext = new Ctx({ latencyHint: 'interactive' });
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch {}
  }
  return audioContext;
}
async function playUiSound(kind = 'click') {
  if (!uiSounds || localStream) return;
  const ctx = await getAudioContext();
  if (!ctx) return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  const osc = ctx.createOscillator();
  const map = { click: [540, .035], join: [700, .09], leave: [300, .09], message: [850, .055], success: [760, .11], error: [190, .13], lock: [430, .08], update: [920, .12] };
  const [freq, len] = map[kind] || map.click;
  osc.frequency.setValueAtTime(freq, now);
  osc.type = kind === 'error' ? 'sawtooth' : 'sine';
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.055, now + .008);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + len);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now); osc.stop(now + len + .02);
}
document.addEventListener('pointerdown', () => { if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {}); }, { passive: true });

/* ---------- startup ---------- */
async function boot() {
  syncProfileUI();
  $('masterVolume').value = String(masterVolume);
  $('masterVolumeLabel').textContent = `${Math.round(masterVolume)}%`;
  $('settingsVolume').value = String(masterVolume);
  $('settingsVolumeLabel').textContent = `${Math.round(masterVolume)}%`;
  $('settingsUiSounds').checked = uiSounds;
  $('settingsCompressor').checked = compressorEnabled;
  $('settingsAutoChat').checked = autoChat;
  $('settingsUpdates').checked = updateNotices;
  $('settingsQuality').value = selectedQuality;
  $('qualityDockLabel').textContent = QUALITY[selectedQuality].label;
  updateQualitySelection();

  const fromUrl = normalizeRoom(new URLSearchParams(location.search).get('sala'));
  if (fromUrl) $('roomInput').value = fromUrl;

  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (response.ok) config = await response.json();
  } catch {}

  refreshPublicRooms();
  clearInterval(publicPollTimer);
  publicPollTimer = setInterval(refreshPublicRooms, 5000);
  checkUpdates(false);
  bindUi();
  if (currentRoom) setConnectionText('Reconectando…', false);
}

function bindUi() {
  $('nicknameInput').addEventListener('input', e => {
    currentNickname = e.target.value.slice(0, 24);
    $('nicknameCounter').textContent = `${currentNickname.length}/24`;
  });
  $('roomInput').addEventListener('input', e => { e.target.value = normalizeRoom(e.target.value); });

  $('createRoomBtn').onclick = createRoom;
  $('heroCreateBtn').onclick = () => { $('entryCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(createRoom, 250); };
  $('joinBtn').onclick = () => joinRoom($('roomInput').value);
  $('navEnterBtn').onclick = () => $('entryCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('exploreRoomsBtn').onclick = () => $('publicRoomsSection').scrollIntoView({ behavior: 'smooth' });
  $('refreshPublicBtn').onclick = () => refreshPublicRooms(true);
  $$('[data-scroll]').forEach(btn => btn.onclick = () => document.querySelector(btn.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' }));

  for (const id of ['homeAvatarBtn', 'editAvatarBtn', 'settingsEditAvatarBtn']) $(id).onclick = openAvatarEditor;
  $('avatarFile').onchange = handleAvatarFile;
  $('avatarZoom').oninput = e => { avatarEdit.zoom = Number(e.target.value); $('avatarZoomLabel').textContent = `${avatarEdit.zoom}%`; applyAvatarEditorTransform(); };
  $$('[data-avatar-move]').forEach(btn => btn.onclick = () => moveAvatar(btn.dataset.avatarMove));
  $('saveAvatarBtn').onclick = saveEditedAvatar;

  $('copyTopCodeBtn').onclick = () => copyText(currentRoom, 'Código copiado.');
  $('copyCodeBtn').onclick = () => copyText(currentRoom, 'Código copiado.');
  $('copyLinkBtn').onclick = () => copyText(roomUrl(), 'Link do convite copiado.');
  $('refreshRoomBtn').onclick = refreshRoomStatus;
  $('lockBtn').onclick = toggleRoomLock;
  $('roomSettingsBtn').onclick = () => openSettings('room');
  $('settingsBtn').onclick = () => openSettings('general');

  $('presentMainBtn').onclick = openShareModal;
  $('presentDockBtn').onclick = openShareModal;
  $('stopDockBtn').onclick = () => stopSharing(true);
  $('qualityBtn').onclick = openShareModal;
  $$('[data-quality]').forEach(btn => btn.onclick = () => { selectedQuality = btn.dataset.quality; localStorage.setItem(STORE.quality, selectedQuality); $('settingsQuality').value = selectedQuality; $('qualityDockLabel').textContent = QUALITY[selectedQuality].label; updateQualitySelection(); });
  $('startShareBtn').onclick = () => localStream ? applyQualityLive() : startSharing();

  $('masterVolume').oninput = e => setMasterVolume(e.target.value);
  $('resetMixerBtn').onclick = () => { setMasterVolume(120); channelVolume.clear(); channelMuted.clear(); soloClientId = null; renderMixer(); };
  $('collapseMixerBtn').onclick = () => $('mixerPanel').classList.toggle('collapsed');
  $('mixerToggleBtn').onclick = () => { $('mixerPanel').classList.remove('collapsed'); $('mixerPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };

  $('chatToggleBtn').onclick = () => $('chatPanel').classList.toggle('chat-hidden');
  $('closeChatBtn').onclick = () => $('chatPanel').classList.add('chat-hidden');
  $('chatForm').onsubmit = sendChat;
  $('fullscreenBtn').onclick = toggleFullscreen;
  $('leaveRoomBtn').onclick = leaveRoom;

  $$('.settings-tab').forEach(tab => tab.onclick = () => activateSettingsTab(tab.dataset.settingsTab));
  $('settingsUiSounds').onchange = e => { uiSounds = e.target.checked; localStorage.setItem(STORE.sounds, String(uiSounds)); };
  $('settingsAutoChat').onchange = e => { autoChat = e.target.checked; localStorage.setItem(STORE.autoChat, String(autoChat)); };
  $('settingsVolume').oninput = e => setMasterVolume(e.target.value);
  $('settingsCompressor').onchange = e => { compressorEnabled = e.target.checked; localStorage.setItem(STORE.compressor, String(compressorEnabled)); rebuildAudioPipeline(); };
  $('settingsQuality').onchange = e => { selectedQuality = e.target.value; localStorage.setItem(STORE.quality, selectedQuality); $('qualityDockLabel').textContent = QUALITY[selectedQuality].label; updateQualitySelection(); if (localStream) applyQualityLive(); };
  $('settingsRoomPublic').onchange = e => setRoomVisibility(e.target.checked);
  $('settingsRoomLocked').onchange = e => setRoomLocked(e.target.checked);
  $('settingsRefreshRoomBtn').onclick = refreshRoomStatus;
  $('settingsCopyInviteBtn').onclick = () => copyText(roomUrl(), 'Convite copiado.');
  $('settingsCloseRoomBtn').onclick = closeRoom;
  $('settingsUpdates').onchange = e => { updateNotices = e.target.checked; localStorage.setItem(STORE.updates, String(updateNotices)); };
  $('settingsCheckUpdateBtn').onclick = () => checkUpdates(true);
  $('updateNowBtn').onclick = () => location.reload();
  $('updateLaterBtn').onclick = () => $('updateBanner').classList.add('hidden');
  $$('[data-close-modal]').forEach(btn => btn.onclick = () => hideModal(btn.dataset.closeModal));
  $$('.modal').forEach(modal => modal.addEventListener('pointerdown', e => { if (e.target === modal) hideModal(modal.id); }));
}

/* ---------- public lobby ---------- */
async function refreshPublicRooms(manual = false) {
  let payload = null;
  if (socket.connected) payload = await ackEmit('public-rooms:request', {}, 3500);
  if (!payload?.ok) {
    try {
      const response = await fetch(`/api/public-rooms?t=${Date.now()}`, { cache: 'no-store' });
      if (response.ok) payload = { ok: true, ...(await response.json()) };
    } catch {}
  }
  if (payload?.ok) {
    renderPublicRooms(payload.rooms || []);
    $('roomsUpdatedLabel').textContent = `Atualizado ${new Date(payload.at || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    if (manual) toast('Lista de salas atualizada.');
  } else if (manual) toast('Não foi possível atualizar as salas.');
}
function renderPublicRooms(rooms) {
  const grid = $('publicRoomsGrid');
  if (!rooms.length) {
    grid.innerHTML = `<div class="public-empty"><b>Nenhuma sala pública agora.</b><span>Quando alguém criar uma sala pública, ela aparecerá aqui automaticamente.</span></div>`;
    return;
  }
  const thumbs = ['/public-thumb-1.png', '/public-thumb-2.png', '/public-thumb-3.png'];
  grid.innerHTML = rooms.map((room, i) => {
    const locked = Boolean(room.locked);
    const live = Boolean(room.streaming);
    const av = room.ownerAvatar ? `<img src="${room.ownerAvatar}" alt="" />` : `<span>${escapeHtml(initials(room.ownerName))}</span>`;
    return `<article class="public-room-card ${locked ? 'locked' : ''}" data-room-code="${escapeHtml(room.roomId)}">
      <div class="room-thumb"><img src="${thumbs[i % thumbs.length]}" alt="Prévia da sala" /><span class="live-badge ${live ? '' : 'idle'}">${live ? '● AO VIVO' : '○ AGUARDANDO'}</span></div>
      <div class="public-room-info"><div><b>${escapeHtml(room.roomId)}</b><small><i class="tiny-avatar">${av}</i>${escapeHtml(room.ownerName || 'Linozera')}</small></div>
      <div class="room-card-stats"><span>♧ ${room.members || 0}</span><span>${locked ? '🔒 Trancada' : '◇ Aberta'}</span><span>${escapeHtml(room.quality || 'Automático')}</span></div></div>
    </article>`;
  }).join('');
  $$('.public-room-card').forEach(card => card.onclick = () => {
    const room = rooms.find(r => r.roomId === card.dataset.roomCode);
    if (room?.locked) return toast('Essa sala está trancada.');
    $('roomInput').value = card.dataset.roomCode;
    $('entryCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => joinRoom(card.dataset.roomCode), 250);
  });
}

/* ---------- rooms ---------- */
async function createRoom() {
  saveProfile();
  if (!socket.connected) return toast('A conexão com o servidor ainda não está pronta.');
  const res = await ackEmit('room:create', { clientId, nickname: currentNickname, avatar: currentAvatar, isPublic: $('homePublicToggle').checked });
  if (!res.ok) return toast(res.error || 'Não foi possível criar a sala.');
  ownerToken = res.ownerToken || '';
  isOwner = true;
  enterRoom(res.roomId, res.status);
  playUiSound('success');
}
async function joinRoom(code, silent = false) {
  saveProfile();
  const roomId = normalizeRoom(code || $('roomInput').value);
  if (roomId.replace('-', '').length !== 8) return toast('Digite um código de sala válido.');
  if (!socket.connected) return toast('A conexão com o servidor ainda não está pronta.');
  const storedOwnerRoom = normalizeRoom(sessionStorage.getItem('lnz_v5_owner_room'));
  const token = storedOwnerRoom === roomId ? (sessionStorage.getItem('lnz_v5_owner_token') || '') : '';
  const res = await ackEmit('room:join', { roomId, clientId, nickname: currentNickname, avatar: currentAvatar, ownerToken: token });
  if (!res.ok) return silent ? null : toast(res.error || 'Não foi possível entrar na sala.');
  isOwner = Boolean(res.owner);
  ownerToken = res.ownerToken || (isOwner ? token : '');
  enterRoom(res.roomId, res.status, silent);
  return res;
}
function enterRoom(roomId, status, silent = false) {
  currentRoom = normalizeRoom(roomId);
  roomStatus = status || roomStatus;
  sessionStorage.setItem('lnz_v5_room', currentRoom);
  sessionStorage.setItem('lnz_v5_is_owner', String(isOwner));
  if (isOwner && ownerToken) {
    sessionStorage.setItem('lnz_v5_owner_room', currentRoom);
    sessionStorage.setItem('lnz_v5_owner_token', ownerToken);
  }
  const url = new URL(location.href); url.searchParams.set('sala', currentRoom); history.replaceState({}, '', url);
  $('homeView').classList.add('hidden');
  $('roomView').classList.remove('hidden');
  if (autoChat) $('chatPanel').classList.remove('chat-hidden');
  applyOwnerClasses();
  applyRoomStatus(roomStatus);
  setConnectionText('Conectado', true);
  clearInterval(roomRefreshTimer);
  roomRefreshTimer = setInterval(() => { if (currentRoom && socket.connected) refreshRoomStatus(false); }, 12_000);
  if (!silent) { toast(isOwner ? 'Sala criada. Você é o dono.' : 'Você entrou na sala.'); playUiSound('join'); }
  if (!isOwner && ownerMember()?.streaming) requestHostStream();
}
function clearRoomSession() {
  const wasRoom = currentRoom;
  currentRoom = '';
  ownerToken = '';
  isOwner = false;
  roomStatus = null;
  sessionStorage.removeItem('lnz_v5_room');
  sessionStorage.removeItem('lnz_v5_is_owner');
  if (!wasRoom || normalizeRoom(sessionStorage.getItem('lnz_v5_owner_room')) === normalizeRoom(wasRoom)) {
    sessionStorage.removeItem('lnz_v5_owner_room');
    sessionStorage.removeItem('lnz_v5_owner_token');
  }
  const url = new URL(location.href); url.searchParams.delete('sala'); history.replaceState({}, '', url.pathname + url.search);
}
async function leaveRoom() {
  if (!currentRoom) return;
  if (isOwner && !confirm('Ao sair como dono, a sala será encerrada para todos. Deseja sair?')) return;
  stopSharing(false);
  await ackEmit('room:leave', {}, 3000);
  resetRoomUi();
  toast('Você saiu da sala.');
  playUiSound('leave');
}
async function closeRoom() {
  if (!isOwner || !currentRoom) return;
  if (!confirm('Encerrar esta sala para todos os participantes?')) return;
  const res = await ackEmit('room:close', {});
  if (!res.ok) return toast(res.error || 'Não foi possível encerrar a sala.');
  resetRoomUi();
}
function resetRoomUi() {
  clearInterval(roomRefreshTimer); roomRefreshTimer = null;
  stopSharing(false);
  closeAllPeers();
  resetRemoteMedia();
  disposeAudioPipeline();
  chatIds.clear();
  $('chatMessages').innerHTML = `<div class="chat-empty"><span>▢</span><b>Nenhuma mensagem ainda</b><small>Envie uma mensagem para a sala.</small></div>`;
  clearRoomSession();
  $('roomView').classList.add('hidden');
  $('homeView').classList.remove('hidden');
  refreshPublicRooms();
}
async function refreshRoomStatus(showToast = true) {
  if (!currentRoom || !socket.connected) return;
  const res = await ackEmit('room:status:request', {}, 4500);
  if (res.ok) { applyRoomStatus(res.status); if (showToast) toast('Sala atualizada.'); }
  else if (showToast) toast(res.error || 'Não foi possível atualizar a sala.');
}
function applyRoomStatus(status) {
  if (!status) return;
  roomStatus = status;
  const members = status.members || [];
  $('topRoomCode').textContent = status.roomId || currentRoom;
  $('sideRoomCode').textContent = status.roomId || currentRoom;
  $('topPeopleCount').textContent = `♧ ${members.length}`;
  $('participantCount').textContent = `(${members.length})`;
  $('topRoomPrivacy').textContent = status.isPublic ? '◇ Sala pública' : '🔒 Sala privada';
  $('sideVisibilityBadge').textContent = status.isPublic ? '● SALA PÚBLICA' : '● SALA PRIVADA';
  $('sideVisibilityBadge').classList.toggle('private', !status.isPublic);
  $('sideLockText').textContent = status.locked ? 'Trancada' : 'Aberta';
  $('lockBtn').textContent = status.locked ? '🔓 Destrancar sala' : '🔒 Trancar sala';
  $('settingsRoomPublic').checked = Boolean(status.isPublic);
  $('settingsRoomLocked').checked = Boolean(status.locked);
  $('roomSettingsUnavailable').classList.add('hidden');
  $('roomSettingsControls').classList.remove('hidden');
  renderParticipants(members);
  renderChat(status.chat || []);
  renderStage();
  renderMixer();
  applyOwnerClasses();
  const owner = ownerMember();
  if (!isOwner && owner?.streaming && !hasLiveRemoteVideo()) requestHostStream();
}
function ownerMember() { return roomStatus?.members?.find(m => m.clientId === roomStatus.ownerClientId) || null; }
function meMember() { return roomStatus?.members?.find(m => m.clientId === clientId) || null; }
function applyOwnerClasses() {
  document.body.classList.toggle('is-owner', Boolean(isOwner));
  document.body.classList.toggle('is-viewer', Boolean(currentRoom && !isOwner));
  $$('.owner-only').forEach(el => el.classList.toggle('role-hidden', !isOwner));
  $$('.viewer-only').forEach(el => el.classList.toggle('role-hidden', isOwner));
}
function renderParticipants(members) {
  $('participantsList').innerHTML = members.map(member => {
    const avatar = member.avatar ? `<img src="${member.avatar}" alt="" />` : `<span>${escapeHtml(initials(member.name))}</span>`;
    return `<div class="participant ${member.streaming ? 'presenting' : ''}"><div class="participant-avatar">${avatar}<i></i></div><div class="participant-text"><b>${escapeHtml(member.name)} ${member.owner ? '<em>♛</em>' : ''}</b><small>${member.clientId === clientId ? 'Você' : (member.streaming ? 'Apresentando' : 'Na sala')}</small></div><span class="participant-state">${member.streaming ? '▥' : '·'}</span></div>`;
  }).join('');
}
async function toggleRoomLock() { if (isOwner) setRoomLocked(!roomStatus?.locked); }
async function setRoomLocked(locked) {
  const res = await ackEmit('room:lock', { locked });
  if (!res.ok) { $('settingsRoomLocked').checked = Boolean(roomStatus?.locked); return toast(res.error || 'Não foi possível alterar a sala.'); }
  playUiSound('lock');
}
async function setRoomVisibility(isPublic) {
  const res = await ackEmit('room:visibility', { isPublic });
  if (!res.ok) { $('settingsRoomPublic').checked = Boolean(roomStatus?.isPublic); return toast(res.error || 'Não foi possível alterar a visibilidade.'); }
  toast(isPublic ? 'A sala agora aparece no lobby.' : 'A sala foi removida do lobby.');
}

/* ---------- WebRTC: stable single presenter ---------- */
function rtcConfiguration() {
  return { iceServers: config.iceServers || [], iceCandidatePoolSize: 6, bundlePolicy: 'max-bundle' };
}
function queueIce(peerId, candidate) {
  const q = pendingIce.get(peerId) || []; q.push(candidate); pendingIce.set(peerId, q);
}
async function flushIce(peerId, pc) {
  const q = pendingIce.get(peerId) || []; pendingIce.delete(peerId);
  for (const candidate of q) { try { await pc.addIceCandidate(candidate); } catch {} }
}
function closePeer(peerId) {
  const timer = peerRecovery.get(peerId); if (timer) clearTimeout(timer); peerRecovery.delete(peerId);
  const pc = peers.get(peerId);
  if (pc) { try { pc.onicecandidate = null; pc.ontrack = null; pc.close(); } catch {} }
  peers.delete(peerId); pendingIce.delete(peerId); hostBuilding.delete(peerId);
}
function closeAllPeers() { [...peers.keys()].forEach(closePeer); stopAdaptiveMonitor(); }
function schedulePeerRecovery(peerId, role, delay = 1800) {
  if (!currentRoom || peerRecovery.has(peerId)) return;
  const timer = setTimeout(() => {
    peerRecovery.delete(peerId);
    if (!currentRoom || !socket.connected) return;
    if (role === 'host' && isOwner && localStream) createHostPeer(peerId, true);
    if (role === 'viewer' && !isOwner) requestHostStream(true);
  }, delay);
  peerRecovery.set(peerId, timer);
}
function newPeer(peerId, role) {
  // ICE can arrive a few milliseconds before the SDP offer. Preserve that queue
  // while replacing an older peer so the viewer does not end up connected with black video.
  const earlyIce = pendingIce.get(peerId) || [];
  closePeer(peerId);
  if (earlyIce.length) pendingIce.set(peerId, earlyIce);
  const pc = new RTCPeerConnection(rtcConfiguration());
  peers.set(peerId, pc);
  pc.onicecandidate = e => { if (e.candidate) socket.emit('webrtc:ice', { target: peerId, candidate: e.candidate }); };
  const watch = () => {
    const state = pc.connectionState;
    const ice = pc.iceConnectionState;
    if (state === 'failed' || ice === 'failed') schedulePeerRecovery(peerId, role, 300);
    else if (state === 'disconnected' || ice === 'disconnected') schedulePeerRecovery(peerId, role, 2200);
    else if (state === 'connected' || ice === 'connected' || ice === 'completed') {
      const t = peerRecovery.get(peerId); if (t) clearTimeout(t); peerRecovery.delete(peerId);
    }
  };
  pc.onconnectionstatechange = watch; pc.oniceconnectionstatechange = watch;
  return pc;
}
async function createHostPeer(viewerSocketId, iceRestart = false) {
  if (!isOwner || !localStream || !viewerSocketId || viewerSocketId === socket.id || hostBuilding.has(viewerSocketId)) return;
  hostBuilding.add(viewerSocketId);
  try {
    const pc = newPeer(viewerSocketId, 'host');
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await pc.setLocalDescription(offer);
    await tuneSender(pc, viewerSocketId);
    socket.emit('webrtc:offer', { target: viewerSocketId, description: pc.localDescription });
  } catch (err) {
    console.error('Oferta WebRTC falhou', err);
    closePeer(viewerSocketId);
    schedulePeerRecovery(viewerSocketId, 'host');
  } finally { hostBuilding.delete(viewerSocketId); }
}
function resetRemoteMedia() {
  if (remoteStream) {
    try { remoteStream.getTracks().forEach(t => { t.onunmute = null; t.onended = null; }); } catch {}
  }
  remoteStream = null; remoteHostSocketId = null; attachedRemoteAt = 0;
  if ($('stageVideo')) { try { $('stageVideo').pause(); $('stageVideo').srcObject = null; } catch {} }
}
function ensureRemoteStream() { if (!remoteStream) remoteStream = new MediaStream(); return remoteStream; }
function mergeRemoteTrackEvent(event, from) {
  const stream = ensureRemoteStream();
  remoteHostSocketId = from;
  const candidates = event.streams?.[0]?.getTracks?.() || [event.track];
  for (const track of candidates) {
    if (!track || stream.getTracks().some(t => t.id === track.id)) continue;
    // Keep one live track of each kind; a renegotiation replaces the old one cleanly.
    for (const old of stream.getTracks().filter(t => t.kind === track.kind && t.id !== track.id)) stream.removeTrack(old);
    stream.addTrack(track);
    track.onunmute = () => { attachStageStream(stream, false); renderStage(); };
    track.onended = () => { try { stream.removeTrack(track); } catch {} renderStage(); };
  }
  attachedRemoteAt = Date.now();
  attachStageStream(stream, false);
  rebuildAudioPipeline();
  renderStage();
}
function createViewerPeer(hostSocketId) {
  const pc = newPeer(hostSocketId, 'viewer');
  pc.ontrack = event => mergeRemoteTrackEvent(event, hostSocketId);
  return pc;
}
async function requestHostStream(force = false) {
  if (isOwner || !currentRoom || !socket.connected) return;
  if (!force && [...peers.values()].some(pc => ['new', 'connecting', 'connected'].includes(pc.connectionState))) return;
  const res = await ackEmit('viewer:request-stream', {}, 3500);
  if (!res?.active && force) toast('Aguardando o transmissor iniciar a tela.');
}
function hasLiveRemoteVideo() { return Boolean(remoteStream?.getVideoTracks().some(t => t.readyState === 'live')); }
function attachStageStream(stream, local) {
  const video = $('stageVideo');
  if (!video || !stream) return;
  video.muted = true; // áudio remoto passa pelo mixer; local nunca volta para o transmissor.
  video.playsInline = true; video.autoplay = true;
  if (video.srcObject !== stream) {
    try { video.pause(); } catch {}
    video.srcObject = stream;
  }
  const play = () => video.play().catch(() => {});
  video.onloadedmetadata = play;
  video.oncanplay = play;
  requestAnimationFrame(play);
  if (local) video.setAttribute('aria-label', 'Prévia local muda');
}
async function safeGetDisplayMedia() {
  const q = QUALITY[selectedQuality] || QUALITY.auto;
  const video = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps, max: q.fps } };
  const preferred = {
    video,
    audio: { restrictOwnAudio: true },
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'exclude',
    windowAudio: 'window',
    preferCurrentTab: false
  };
  try { return await navigator.mediaDevices.getDisplayMedia(preferred); }
  catch (err) {
    if (err?.name !== 'TypeError') throw err;
    return navigator.mediaDevices.getDisplayMedia({ video, audio: true });
  }
}
async function startSharing() {
  if (!isOwner || !currentRoom || localStream) return;
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('Este navegador não suporta compartilhamento de tela.');
  try {
    const stream = await safeGetDisplayMedia();
    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) { stream.getTracks().forEach(t => t.stop()); throw new Error('Nenhuma faixa de vídeo foi recebida.'); }
    const surface = videoTrack.getSettings?.().displaySurface || '';
    videoTrack.contentHint = (QUALITY[selectedQuality]?.fps || 30) >= 50 ? 'motion' : 'detail';
    // Monitor/tela inteira pode carregar Discord e a própria voz. Remover áudio é a forma segura.
    if (surface === 'monitor') {
      for (const track of [...stream.getAudioTracks()]) { stream.removeTrack(track); track.stop(); }
      toast('Tela inteira: áudio removido para impedir retorno. Use Aba/Janela para transmitir som.', 5200);
    }
    for (const track of stream.getAudioTracks()) { try { track.contentHint = 'music'; } catch {} }
    localStream = stream;
    videoTrack.addEventListener('ended', () => stopSharing(true), { once: true });
    videoTrack.addEventListener('mute', () => toast('O Windows/navegador pausou a captura.'), { passive: true });
    attachStageStream(localStream, true);
    hideModal('shareModal');
    setShareButtons(true);
    renderStage();
    disposeAudioPipeline();
    const q = QUALITY[selectedQuality] || QUALITY.auto;
    await ackEmit('room:stream', { active: true, quality: q.label, audio: stream.getAudioTracks().length > 0 }, 4000);
    for (const member of roomStatus?.members || []) if (member.socketId && member.clientId !== clientId) createHostPeer(member.socketId);
    startAdaptiveMonitor();
    playUiSound('success');
  } catch (err) {
    if (!['NotAllowedError', 'AbortError'].includes(err?.name)) { console.error(err); toast('Não foi possível iniciar a transmissão. Tente escolher a tela novamente.'); playUiSound('error'); }
  }
}
function stopSharing(notify = true) {
  if (!localStream) return;
  stopAdaptiveMonitor();
  localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
  localStream = null;
  closeAllPeers();
  setShareButtons(false);
  if (currentRoom && isOwner && socket.connected) socket.emit('room:stream', { active: false, quality: QUALITY[selectedQuality].label, audio: false });
  renderStage(); renderMixer();
  if (notify) { toast('Apresentação encerrada.'); playUiSound('leave'); }
}
function setShareButtons(active) {
  $('presentDockBtn').classList.toggle('hidden', active);
  $('stopDockBtn').classList.toggle('hidden', !active);
  $('presentMainBtn').classList.toggle('hidden', active);
}
async function applyQualityLive() {
  $('qualityDockLabel').textContent = QUALITY[selectedQuality].label;
  updateQualitySelection();
  hideModal('shareModal');
  if (!localStream) return;
  for (const [id, pc] of peers) await tuneSender(pc, id);
  socket.emit('room:stream', { active: true, quality: QUALITY[selectedQuality].label, audio: localStream.getAudioTracks().length > 0 });
  toast(`Qualidade de envio: ${QUALITY[selectedQuality].label}. A captura não foi redimensionada.`);
}
function updateQualitySelection() {
  $$('[data-quality]').forEach(btn => btn.classList.toggle('selected', btn.dataset.quality === selectedQuality));
  $('qualityDockLabel').textContent = QUALITY[selectedQuality].label;
  if ($('startShareBtn')) $('startShareBtn').textContent = localStream ? 'Aplicar sem reiniciar a tela' : 'Continuar e escolher tela';
}
async function tuneSender(pc, peerId) {
  if (!pc) return;
  const q = QUALITY[selectedQuality] || QUALITY.auto;
  let bitrate = q.bitrate;
  let fps = q.fps;
  if (selectedQuality === 'auto') {
    const viewers = Math.max(1, (roomStatus?.members?.length || 1) - 1);
    if (viewers >= 5) bitrate = Math.min(bitrate, 1_500_000);
    else if (viewers >= 3) bitrate = Math.min(bitrate, 2_200_000);
    else if (viewers >= 2) bitrate = Math.min(bitrate, 3_000_000);
    try {
      const stats = await pc.getStats();
      let available = NaN, rtt = 0, loss = 0;
      stats.forEach(r => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && Number.isFinite(r.availableOutgoingBitrate)) available = r.availableOutgoingBitrate;
        if (r.type === 'candidate-pair' && Number.isFinite(r.currentRoundTripTime)) rtt = Math.max(rtt, r.currentRoundTripTime);
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && Number.isFinite(r.fractionLost)) loss = Math.max(loss, r.fractionLost);
      });
      if (Number.isFinite(available) && available > 0) bitrate = Math.min(bitrate, Math.max(650_000, available * .72));
      if (loss > .08 || rtt > .4) { bitrate = Math.min(bitrate, 1_800_000); fps = Math.min(fps, 24); }
      if (loss > .16 || rtt > .75) { bitrate = Math.min(bitrate, 950_000); fps = Math.min(fps, 18); }
    } catch {}
  }
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    try {
      const p = sender.getParameters(); p.encodings ||= [{}];
      if (sender.track.kind === 'video') {
        p.encodings[0].maxBitrate = Math.round(bitrate);
        p.encodings[0].maxFramerate = fps;
        p.degradationPreference = 'balanced';
      } else p.encodings[0].maxBitrate = 160_000;
      await sender.setParameters(p);
    } catch {}
  }
}
function startAdaptiveMonitor() {
  stopAdaptiveMonitor();
  if (!isOwner || !localStream || selectedQuality !== 'auto') return;
  adaptiveTimer = setInterval(() => { for (const [id, pc] of peers) if (pc.connectionState === 'connected') tuneSender(pc, id); }, 4500);
}
function stopAdaptiveMonitor() { if (adaptiveTimer) clearInterval(adaptiveTimer); adaptiveTimer = null; }

/* Black-screen watchdog: recovers only when video track exists but no decoded dimensions. */
setInterval(() => {
  if (!currentRoom || isOwner || !ownerMember()?.streaming || !hasLiveRemoteVideo()) return;
  const video = $('stageVideo');
  if (!video || Date.now() - attachedRemoteAt < 4500) return;
  const black = video.videoWidth === 0 || video.videoHeight === 0;
  if (black && Date.now() - lastBlackRecovery > 10_000) {
    lastBlackRecovery = Date.now();
    toast('Recuperando o vídeo da transmissão…');
    closeAllPeers(); resetRemoteMedia(); requestHostStream(true);
  }
}, 2500);

/* ---------- stream/server events ---------- */
socket.on('connect', async () => {
  setConnectionText('Conectado', true);
  refreshPublicRooms();
  if (currentRoom && !rejoinInFlight) {
    rejoinInFlight = true;
    try {
      const res = await ackEmit('room:join', { roomId: currentRoom, clientId, nickname: currentNickname, avatar: currentAvatar, ownerToken }, 7000);
      if (res.ok) {
        isOwner = Boolean(res.owner); if (res.ownerToken) ownerToken = res.ownerToken;
        enterRoom(res.roomId, res.status, true);
        if (!isOwner && ownerMember()?.streaming) requestHostStream(true);
      } else { toast(res.error || 'A sala foi encerrada.'); resetRoomUi(); }
    } finally { rejoinInFlight = false; }
  }
});
socket.on('disconnect', () => setConnectionText('Reconectando…', false));
socket.on('connect_error', () => setConnectionText('Sem conexão', false));
socket.on('public-rooms:list', payload => { if (payload?.rooms) { renderPublicRooms(payload.rooms); $('roomsUpdatedLabel').textContent = 'Atualizado agora'; } });
socket.on('room:status', status => { if (currentRoom) applyRoomStatus(status); });
socket.on('member:joined', member => { if (isOwner && localStream && member?.socketId) createHostPeer(member.socketId); playUiSound('join'); });
socket.on('member:left', () => playUiSound('leave'));
socket.on('room:closed', () => { toast('A sala foi encerrada pelo dono.'); resetRoomUi(); });
socket.on('session:replaced', () => { toast('Esta sessão foi aberta em outra aba/dispositivo.'); resetRoomUi(); });
socket.on('host:stream', ({ active }) => {
  if (isOwner) return;
  if (!active) { closeAllPeers(); resetRemoteMedia(); disposeAudioPipeline(); renderStage(); }
  else requestHostStream(true);
});
socket.on('host:reconnected', () => { if (!isOwner) { closeAllPeers(); resetRemoteMedia(); setTimeout(() => requestHostStream(true), 500); } });
socket.on('viewer:ready', ({ viewerId }) => { if (isOwner && localStream && viewerId) createHostPeer(viewerId); });
socket.on('viewer:left', ({ viewerId }) => { if (viewerId) closePeer(viewerId); });
socket.on('webrtc:offer', async ({ from, description }) => {
  if (isOwner || !from || !description) return;
  remoteHostSocketId = from;
  resetRemoteMedia();
  const pc = createViewerPeer(from);
  try {
    await pc.setRemoteDescription(description);
    await flushIce(from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', { target: from, description: pc.localDescription });
  } catch (err) { console.error('Resposta WebRTC falhou', err); closePeer(from); schedulePeerRecovery(from, 'viewer'); }
});
socket.on('webrtc:answer', async ({ from, description }) => {
  if (!isOwner || !from || !description) return;
  const pc = peers.get(from); if (!pc) return;
  try { await pc.setRemoteDescription(description); await flushIce(from, pc); }
  catch { schedulePeerRecovery(from, 'host'); }
});
socket.on('webrtc:ice', async ({ from, candidate }) => {
  if (!from || !candidate) return;
  const pc = peers.get(from);
  if (!pc || !pc.remoteDescription) return queueIce(from, candidate);
  try { await pc.addIceCandidate(candidate); } catch {}
});
socket.on('chat:message', message => { appendChat(message); if (message?.clientId !== clientId) playUiSound('message'); });

/* ---------- Stage ---------- */
function renderStage() {
  const owner = ownerMember();
  const streaming = isOwner ? Boolean(localStream) : Boolean(owner?.streaming);
  $('presentingCount').textContent = streaming ? '1 apresentando' : '0 apresentando';
  $('stagePlaceholder').classList.toggle('hidden', streaming && (isOwner ? localStream : hasLiveRemoteVideo()));
  $('videoSurface').classList.toggle('hidden', !(streaming && (isOwner ? localStream : hasLiveRemoteVideo())));
  if (isOwner && localStream) attachStageStream(localStream, true);
  else if (!isOwner && remoteStream && hasLiveRemoteVideo()) attachStageStream(remoteStream, false);

  if (!streaming) {
    $('placeholderText').innerHTML = isOwner ? 'Clique em <b>Apresentar agora</b>, escolha uma tela, janela ou aba e comece.' : 'Aguardando o dono da sala iniciar a apresentação.';
    $('viewerWaitingLabel').textContent = 'Aguardando o dono iniciar a transmissão.';
  } else if (!isOwner && !hasLiveRemoteVideo()) {
    $('stagePlaceholder').classList.remove('hidden');
    $('placeholderText').textContent = 'Conectando ao vídeo da transmissão…';
  }
  const presenter = isOwner ? (meMember() || { name: currentNickname, avatar: currentAvatar, quality: QUALITY[selectedQuality].label, audio: localStream?.getAudioTracks().length > 0 }) : owner;
  if (presenter) {
    $('videoAvatar').src = avatarSrc(presenter.avatar);
    $('videoUserName').textContent = presenter.name || currentNickname;
    $('videoQualityPill').textContent = presenter.quality || QUALITY[selectedQuality].label;
    const hasAudio = isOwner ? Boolean(localStream?.getAudioTracks().length) : Boolean(presenter.audio);
    $('videoAudioLabel').textContent = hasAudio ? 'Áudio da apresentação' : 'Sem áudio';
    $('audioActivity').classList.toggle('active', hasAudio);
  }
  $('localMutePill').classList.toggle('hidden', !isOwner || !localStream);
  setShareButtons(Boolean(localStream));
  updateQualitySelection();
}

/* ---------- Mixer / remote audio ---------- */
function setMasterVolume(value) {
  masterVolume = clamp(Number(value), 0, 150);
  localStorage.setItem(STORE.volume, String(masterVolume));
  $('masterVolume').value = String(masterVolume); $('masterVolumeLabel').textContent = `${Math.round(masterVolume)}%`;
  $('settingsVolume').value = String(masterVolume); $('settingsVolumeLabel').textContent = `${Math.round(masterVolume)}%`;
  updateAudioGain();
}
function disposeAudioPipeline() {
  if (!audioPipeline) return;
  try { audioPipeline.source.disconnect(); audioPipeline.compressor?.disconnect(); audioPipeline.gain.disconnect(); } catch {}
  audioPipeline = null;
}
async function rebuildAudioPipeline() {
  disposeAudioPipeline();
  if (isOwner || !remoteStream?.getAudioTracks().length) return;
  const ctx = await getAudioContext(); if (!ctx) return;
  try {
    const audioOnly = new MediaStream(remoteStream.getAudioTracks());
    const source = ctx.createMediaStreamSource(audioOnly);
    const gain = ctx.createGain();
    let compressor = null;
    if (compressorEnabled) {
      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -16; compressor.knee.value = 20; compressor.ratio.value = 4; compressor.attack.value = .004; compressor.release.value = .22;
      source.connect(compressor).connect(gain).connect(ctx.destination);
    } else source.connect(gain).connect(ctx.destination);
    audioPipeline = { source, compressor, gain };
    updateAudioGain();
  } catch (err) { console.warn('Mixer WebAudio indisponível', err); }
}
function updateAudioGain() {
  if (!audioPipeline) return;
  const owner = ownerMember(); const id = owner?.clientId || 'host';
  const channel = (channelVolume.get(id) ?? 100) / 100;
  const muted = channelMuted.has(id) || (soloClientId && soloClientId !== id);
  audioPipeline.gain.gain.value = muted ? 0 : (masterVolume / 100) * channel;
}
function renderMixer() {
  const owner = ownerMember();
  const hostId = owner?.clientId;
  if (!hostId) { $('mixerChannels').innerHTML = '<div class="mixer-empty">Aguardando transmissor.</div>'; return; }
  const vol = channelVolume.get(hostId) ?? 100;
  const muted = channelMuted.has(hostId);
  const solo = soloClientId === hostId;
  $('mixerChannels').innerHTML = `<div class="mixer-channel"><div class="mixer-person"><span class="mixer-avatar">${owner.avatar ? `<img src="${owner.avatar}" alt="" />` : escapeHtml(initials(owner.name))}</span><div><b>${escapeHtml(owner.name)}</b><small>${owner.audio ? 'Áudio disponível' : 'Sem áudio'}</small></div></div><div class="channel-control"><input data-channel-volume="${escapeHtml(hostId)}" type="range" min="0" max="150" value="${vol}" /><b>${Math.round(vol)}%</b><button data-channel-mute="${escapeHtml(hostId)}" class="${muted ? 'active' : ''}">M</button><button data-channel-solo="${escapeHtml(hostId)}" class="${solo ? 'active' : ''}">S</button></div></div>`;
  $$('[data-channel-volume]').forEach(input => input.oninput = e => { channelVolume.set(e.target.dataset.channelVolume, Number(e.target.value)); renderMixer(); updateAudioGain(); });
  $$('[data-channel-mute]').forEach(btn => btn.onclick = () => { const id = btn.dataset.channelMute; channelMuted.has(id) ? channelMuted.delete(id) : channelMuted.add(id); renderMixer(); updateAudioGain(); });
  $$('[data-channel-solo]').forEach(btn => btn.onclick = () => { soloClientId = soloClientId === btn.dataset.channelSolo ? null : btn.dataset.channelSolo; renderMixer(); updateAudioGain(); });
  updateAudioGain();
}

/* ---------- Chat ---------- */
function renderChat(messages) {
  chatIds.clear();
  $('chatMessages').innerHTML = '';
  for (const msg of messages) appendChat(msg, false);
  if (!messages.length) $('chatMessages').innerHTML = `<div class="chat-empty"><span>▢</span><b>Nenhuma mensagem ainda</b><small>Envie uma mensagem para a sala.</small></div>`;
}
function appendChat(message, scroll = true) {
  if (!message?.id || chatIds.has(message.id)) return;
  chatIds.add(message.id);
  $('chatMessages').querySelector('.chat-empty')?.remove();
  const mine = message.clientId === clientId;
  const div = document.createElement('article'); div.className = `chat-message ${mine ? 'mine' : ''}`;
  div.innerHTML = `<div class="chat-avatar">${message.avatar ? `<img src="${message.avatar}" alt="" />` : escapeHtml(initials(message.name))}</div><div class="chat-bubble"><div><b>${escapeHtml(message.name)}</b><time>${timeLabel(message.at)}</time></div><p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p></div>`;
  $('chatMessages').appendChild(div);
  if (scroll) $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}
async function sendChat(e) {
  e.preventDefault(); const text = $('chatInput').value.trim(); if (!text) return;
  const res = await ackEmit('chat:send', { text }, 4000);
  if (!res.ok) return toast(res.error || 'Mensagem não enviada.');
  $('chatInput').value = '';
}

/* ---------- Avatar ---------- */
function openAvatarEditor() {
  avatarEdit = { dataUrl: currentAvatar || '/default-avatar.png', x: 0, y: 0, zoom: 100 };
  $('avatarEditorImg').src = avatarEdit.dataUrl;
  $('avatarZoom').value = '100'; $('avatarZoomLabel').textContent = '100%';
  applyAvatarEditorTransform(); showModal('avatarModal');
}
function applyAvatarEditorTransform() { $('avatarEditorImg').style.transform = `translate(${avatarEdit.x}px, ${avatarEdit.y}px) scale(${avatarEdit.zoom / 100})`; }
function moveAvatar(dir) {
  const step = 8;
  if (dir === 'up') avatarEdit.y -= step; if (dir === 'down') avatarEdit.y += step;
  if (dir === 'left') avatarEdit.x -= step; if (dir === 'right') avatarEdit.x += step;
  if (dir === 'center') { avatarEdit.x = 0; avatarEdit.y = 0; }
  applyAvatarEditorTransform();
}
function handleAvatarFile(e) {
  const file = e.target.files?.[0]; if (!file) return;
  if (file.size > 6 * 1024 * 1024) return toast('A imagem deve ter no máximo 6 MB.');
  const reader = new FileReader(); reader.onload = () => { avatarEdit.dataUrl = String(reader.result); $('avatarEditorImg').src = avatarEdit.dataUrl; avatarEdit.x = avatarEdit.y = 0; avatarEdit.zoom = 100; $('avatarZoom').value = '100'; applyAvatarEditorTransform(); }; reader.readAsDataURL(file);
}
async function saveEditedAvatar() {
  try {
    const img = new Image(); img.decoding = 'async'; img.src = avatarEdit.dataUrl; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256; const ctx = canvas.getContext('2d');
    const cover = Math.max(256 / img.naturalWidth, 256 / img.naturalHeight) * (avatarEdit.zoom / 100);
    const w = img.naturalWidth * cover, h = img.naturalHeight * cover;
    ctx.drawImage(img, (256 - w) / 2 + avatarEdit.x * 1.6, (256 - h) / 2 + avatarEdit.y * 1.6, w, h);
    currentAvatar = canvas.toDataURL('image/jpeg', .86);
    localStorage.setItem(STORE.avatar, currentAvatar); syncProfileUI(); hideModal('avatarModal');
    if (currentRoom) await ackEmit('room:profile', { nickname: currentNickname, avatar: currentAvatar }, 4000);
    toast('Avatar atualizado.');
  } catch { toast('Não foi possível salvar esse avatar.'); }
}

/* ---------- Settings ---------- */
function openSettings(tab = 'general') { activateSettingsTab(tab); showModal('settingsModal'); $('roomSettingsUnavailable').classList.toggle('hidden', Boolean(currentRoom)); $('roomSettingsControls').classList.toggle('hidden', !currentRoom); }
function activateSettingsTab(name) { $$('.settings-tab').forEach(x => x.classList.toggle('active', x.dataset.settingsTab === name)); $$('[data-settings-panel]').forEach(x => x.classList.toggle('active', x.dataset.settingsPanel === name)); }
async function checkUpdates(manual = false) {
  try {
    const res = await fetch(`/api/version?t=${Date.now()}`, { cache: 'no-store' }); if (!res.ok) throw new Error();
    const data = await res.json(); $('settingsVersionInfo').textContent = `Versão atual: V${data.version}`;
    if (manual) toast(`Você está na versão V${data.version}.`);
    const seen = localStorage.getItem('lnz_seen_version');
    if (updateNotices && seen && seen !== data.version) { $('updateText').textContent = `V${data.version} disponível.`; $('updateBanner').classList.remove('hidden'); playUiSound('update'); }
    localStorage.setItem('lnz_seen_version', data.version);
  } catch { if (manual) toast('Não foi possível verificar atualização agora.'); }
}

/* ---------- Misc ---------- */
function openShareModal() { if (!isOwner) return; updateQualitySelection(); showModal('shareModal'); }
async function copyText(text, ok = 'Copiado.') { try { await navigator.clipboard.writeText(text); toast(ok); } catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(ok); } }
function setConnectionText(text, connected) { $('connectionStatus').innerHTML = `<i class="${connected ? '' : 'offline'}"></i> ${escapeHtml(text)}`; }
async function toggleFullscreen() { const el = $('stageArea'); try { if (!document.fullscreenElement) await el.requestFullscreen(); else await document.exitFullscreen(); } catch {} }

window.addEventListener('beforeunload', () => { if (localStream) localStream.getTracks().forEach(t => t.stop()); });
window.addEventListener('pagehide', () => { if (localStream) localStream.getTracks().forEach(t => t.stop()); });

boot();

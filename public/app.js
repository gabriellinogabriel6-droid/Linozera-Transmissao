const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 800, reconnectionDelayMax: 3000 });
const $ = id => document.getElementById(id);

const home = $('home');
const roomView = $('roomView');
const hostVideo = $('hostVideo');
const viewerVideo = $('viewerVideo');
const peers = new Map();
const pendingIce = new Map();
const knownViewers = new Set();

const makeClientId = () => globalThis.crypto?.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clientId = localStorage.getItem('lnz_client_id') || makeClientId();
localStorage.setItem('lnz_client_id', clientId);

let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
let localStream = null;
let currentRoom = null;
let currentNickname = localStorage.getItem('lnz_nickname') || '';
let hostToken = sessionStorage.getItem('lnz_host_token') || null;
let role = null;
let viewerHostId = null;
let leaving = false;
let remoteStreaming = false;

fetch('/api/config').then(r => r.json()).then(cfg => {
  if (Array.isArray(cfg.iceServers) && cfg.iceServers.length) rtcConfig = { iceServers: cfg.iceServers };
}).catch(() => {});

function show(view) {
  [home, roomView].forEach(el => el.classList.add('hidden'));
  view.classList.remove('hidden');
}

function toast(message, timeout = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), timeout);
}

function sanitizeNickname(value) {
  return String(value || '').replace(/[<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function formatRoom(value) {
  const v = normalizeRoom(value);
  return v.length > 4 ? `${v.slice(0,4)}-${v.slice(4)}` : v;
}

function setRoomInUrl(room) {
  const url = new URL(location.href);
  if (room) url.searchParams.set('room', formatRoom(room));
  else url.searchParams.delete('room');
  history.replaceState({}, '', url);
}

function updateNickCounter() {
  const value = $('nicknameInput').value.slice(0, 24);
  $('nickCount').textContent = `${value.length}/24`;
}

function requireNickname() {
  const nickname = sanitizeNickname($('nicknameInput').value);
  if (nickname.length < 2) {
    $('homeError').textContent = 'Digite um nickname com pelo menos 2 caracteres.';
    $('nicknameInput').focus();
    return null;
  }
  currentNickname = nickname;
  localStorage.setItem('lnz_nickname', nickname);
  $('homeError').textContent = '';
  return nickname;
}

function updateRoleUI() {
  document.querySelectorAll('.host-only').forEach(el => el.classList.toggle('hidden', role !== 'host'));
  $('activityName').textContent = currentNickname || '—';
  if (role === 'viewer') {
    $('emptyTitle').textContent = remoteStreaming ? 'Conectando à transmissão…' : 'Ninguém está compartilhando ainda';
    $('emptyText').textContent = remoteStreaming ? 'A transmissão está iniciando. Aguarde alguns instantes.' : 'O transmissor ainda não começou a compartilhar a tela.';
  } else {
    $('emptyTitle').textContent = 'Ninguém está compartilhando ainda';
    $('emptyText').textContent = 'Chame alguém com o link da sala ou comece transmitindo a sua tela.';
  }
}

function enterRoomUI(roomId) {
  const label = formatRoom(roomId);
  $('topRoomCode').textContent = `↗  ${label}`;
  $('sideRoomCode').textContent = label;
  $('activityName').textContent = currentNickname;
  updateRoleUI();
  setRoomInUrl(roomId);
  show(roomView);
}

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
      if (mode === 'viewer') toast('A conexão direta falhou. Um servidor TURN pode ser necessário.', 4200);
      closePeer(peerId);
    }
  };
  return pc;
}

function renderMembers(members = []) {
  const list = $('memberList');
  list.innerHTML = '';
  const safeMembers = Array.isArray(members) ? members : [];
  $('memberCount').textContent = String(safeMembers.length || 1);
  $('topPeopleCount').textContent = String(safeMembers.length || 1);

  for (const member of safeMembers) {
    const row = document.createElement('div');
    row.className = 'member';

    const avatar = document.createElement('div');
    avatar.className = 'member-avatar';
    if (member.host) {
      const img = document.createElement('img');
      img.src = '/linozera-logo.png';
      img.alt = '';
      avatar.appendChild(img);
    } else {
      const letter = document.createElement('div');
      letter.className = 'letter-avatar';
      letter.textContent = (member.name || '?').slice(0,1).toUpperCase();
      avatar.appendChild(letter);
    }
    const dot = document.createElement('i');
    dot.className = 'online-dot';
    avatar.appendChild(dot);

    const copy = document.createElement('div');
    copy.className = 'member-copy';
    const name = document.createElement('div');
    name.className = 'member-name';
    name.append(document.createTextNode(member.name || 'Visitante'));
    if (member.host) {
      const crown = document.createElement('span'); crown.className = 'host-crown'; crown.textContent = '♛'; name.appendChild(crown);
    }
    if (member.mine) {
      const badge = document.createElement('span'); badge.className = 'you-badge'; badge.textContent = 'VOCÊ'; name.appendChild(badge);
    }
    const sub = document.createElement('div');
    sub.className = 'member-sub';
    sub.textContent = member.mine ? 'Você' : (member.host ? 'Anfitrião' : 'Na sala');
    copy.append(name, sub);
    row.append(avatar, copy);
    list.appendChild(row);
  }
}

function requestStatus() {
  if (currentRoom) socket.emit('room:status', { roomId: currentRoom });
}

function createRoom() {
  const nickname = requireNickname();
  if (!nickname) return;

  leaving = false;
  role = 'host';
  hostToken = null;
  sessionStorage.removeItem('lnz_host_token');

  socket.emit('host:create', { nickname }, result => {
    if (!result?.ok) {
      role = null;
      toast(result?.error || 'Não foi possível criar a sala.');
      return;
    }
    currentRoom = result.roomId;
    hostToken = result.hostToken;
    sessionStorage.setItem('lnz_host_token', hostToken);
    enterRoomUI(currentRoom);
    requestStatus();
  });
}

async function startSharing() {
  if (role !== 'host' || !currentRoom) return;
  if (localStream) {
    stopSharing();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Esse navegador não suporta compartilhamento de tela.');
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include'
    });

    hostVideo.srcObject = localStream;
    hostVideo.muted = true;
    hostVideo.volume = 0;
    hostVideo.classList.remove('hidden');
    viewerVideo.classList.add('hidden');
    $('emptyState').classList.add('hidden');
    $('shareLabel').textContent = 'Parar transmissão';
    socket.emit('host:stream', { active: true });

    for (const viewerId of knownViewers) makeHostPeer(viewerId);

    const track = localStream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => stopSharing(), { once: true });
  } catch (error) {
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') {
      console.error(error);
      toast('Não foi possível iniciar o compartilhamento.');
    }
  }
}

function stopSharing() {
  if (role !== 'host') return;
  if (localStream) localStream.getTracks().forEach(track => track.stop());
  localStream = null;
  hostVideo.srcObject = null;
  hostVideo.classList.add('hidden');
  closeAllPeers();
  $('emptyState').classList.remove('hidden');
  $('shareLabel').textContent = 'Compartilhar tela';
  if (socket.connected && currentRoom) socket.emit('host:stream', { active: false });
}

async function makeHostPeer(viewerId) {
  if (!localStream || !viewerId) return;
  const pc = makePeer(viewerId, 'host');
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc:offer', { target: viewerId, sdp: pc.localDescription });
  } catch (error) {
    console.error('Falha ao criar oferta', error);
    closePeer(viewerId);
  }
}

function joinRoom(value, fromReconnect = false) {
  const nickname = fromReconnect ? currentNickname : requireNickname();
  if (!nickname) return;
  const roomId = normalizeRoom(value);
  if (roomId.length !== 8) {
    $('homeError').textContent = 'Digite um código de sala válido.';
    $('roomInput').focus();
    return;
  }

  leaving = false;
  role = 'viewer';
  currentRoom = roomId;
  socket.emit('viewer:join', { roomId, clientId, nickname }, result => {
    if (!result?.ok) {
      if (fromReconnect && result?.reconnecting) {
        $('viewerReconnect').classList.remove('hidden');
        return;
      }
      role = null;
      currentRoom = null;
      $('homeError').textContent = result?.error || 'Sala não encontrada.';
      show(home);
      return;
    }

    currentRoom = result.roomId;
    viewerHostId = result.hostId;
    remoteStreaming = Boolean(result.streaming);
    $('homeError').textContent = '';
    enterRoomUI(currentRoom);
    $('viewerReconnect').classList.add('hidden');
    viewerVideo.classList.add('hidden');
    $('emptyState').classList.remove('hidden');
    updateRoleUI();
    requestStatus();
  });
}

function ensureViewerPeer(hostId) {
  let pc = peers.get(hostId);
  if (pc) return pc;
  pc = makePeer(hostId, 'viewer');
  pc.ontrack = event => {
    const stream = event.streams?.[0] || new MediaStream([event.track]);
    viewerVideo.srcObject = stream;
    viewerVideo.classList.remove('hidden');
    hostVideo.classList.add('hidden');
    $('emptyState').classList.add('hidden');
    $('viewerReconnect').classList.add('hidden');
    viewerVideo.play().catch(() => toast('Clique no vídeo para liberar o áudio.'));
  };
  return pc;
}

function leaveRoom(closeHost = false) {
  leaving = true;
  if (role === 'host') {
    stopSharing();
    if (socket.connected) socket.emit('host:stop');
    sessionStorage.removeItem('lnz_host_token');
    hostToken = null;
  } else if (role === 'viewer' && socket.connected) {
    socket.emit('viewer:leave');
  }
  closeAllPeers();
  knownViewers.clear();
  viewerVideo.pause();
  viewerVideo.srcObject = null;
  viewerVideo.classList.add('hidden');
  hostVideo.classList.add('hidden');
  $('emptyState').classList.remove('hidden');
  $('viewerReconnect').classList.add('hidden');
  $('hostReconnect').classList.add('hidden');
  currentRoom = null;
  viewerHostId = null;
  remoteStreaming = false;
  role = null;
  setRoomInUrl(null);
  show(home);
  if (closeHost) toast('Sala encerrada.');
}

async function copyText(text, success = 'Copiado.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(success);
  } catch {
    toast(text, 5000);
  }
}

function roomInviteUrl() {
  const url = new URL(location.href);
  url.searchParams.set('room', formatRoom(currentRoom));
  return url.toString();
}

socket.on('viewer:joined', ({ viewerId }) => {
  if (role !== 'host' || !viewerId) return;
  knownViewers.add(viewerId);
  if (localStream) makeHostPeer(viewerId);
  requestStatus();
});

socket.on('viewer:left', ({ viewerId }) => {
  knownViewers.delete(viewerId);
  closePeer(viewerId);
  requestStatus();
});

socket.on('room:status', data => {
  if (!currentRoom || normalizeRoom(data?.roomId) !== currentRoom) return;
  const members = Array.isArray(data.members) ? data.members.map(m => ({ ...m, mine: m.clientId === clientId || (role === 'host' && m.host) })) : [];
  renderMembers(members);
  if (role === 'viewer') {
    remoteStreaming = Boolean(data.streaming);
    if (!remoteStreaming && !viewerVideo.srcObject) {
      viewerVideo.classList.add('hidden');
      $('emptyState').classList.remove('hidden');
      updateRoleUI();
    }
  }
});

socket.on('host:stream', ({ active }) => {
  if (role !== 'viewer') return;
  remoteStreaming = Boolean(active);
  if (!active) {
    closeAllPeers();
    viewerVideo.pause();
    viewerVideo.srcObject = null;
    viewerVideo.classList.add('hidden');
    $('emptyState').classList.remove('hidden');
    updateRoleUI();
  } else if (!viewerVideo.srcObject) {
    $('emptyState').classList.remove('hidden');
    updateRoleUI();
  }
});

socket.on('webrtc:offer', async ({ from, sdp }) => {
  if (role !== 'viewer') return;
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
  const pc = peers.get(from);
  if (!pc) return;
  try {
    await pc.setRemoteDescription(sdp);
    await flushIce(from, pc);
  } catch (error) { console.error('Falha ao aplicar resposta', error); }
});

socket.on('webrtc:ice', async ({ from, candidate }) => {
  let pc = peers.get(from);
  if (!pc && role === 'viewer') pc = ensureViewerPeer(from);
  if (!pc) return;
  if (!pc.remoteDescription) return queueIce(from, candidate);
  try { await pc.addIceCandidate(candidate); } catch (error) { console.warn('ICE não aplicado', error); }
});

socket.on('host:reconnecting', () => {
  if (role !== 'viewer') return;
  $('viewerReconnect').classList.remove('hidden');
});

socket.on('host:restored', ({ hostId }) => {
  if (role !== 'viewer') return;
  closeAllPeers();
  viewerHostId = hostId;
  $('viewerReconnect').classList.add('hidden');
  joinRoom(currentRoom, true);
});

socket.on('host:ended', () => {
  if (role !== 'viewer' || leaving) return;
  leaveRoom(false);
  toast('A sala foi encerrada pelo anfitrião.');
});

socket.on('viewer:replaced', () => {
  if (role !== 'viewer') return;
  leaveRoom(false);
  toast('Esta sala foi aberta em outra aba.');
});

socket.on('connect', () => {
  $('connection').innerHTML = '<i></i><span>Conectado</span>';
  $('hostReconnect').classList.add('hidden');
  if (role === 'host' && currentRoom && hostToken) {
    closeAllPeers();
    knownViewers.clear();
    socket.emit('host:create', { roomId: currentRoom, hostToken, nickname: currentNickname }, result => {
      if (!result?.ok) return leaveRoom(false);
      requestStatus();
    });
  } else if (role === 'viewer' && currentRoom) {
    closeAllPeers();
    joinRoom(currentRoom, true);
  }
});

socket.on('disconnect', () => {
  $('connection').innerHTML = '<span>Reconectando…</span>';
  if (role === 'host') $('hostReconnect').classList.remove('hidden');
  if (role === 'viewer') $('viewerReconnect').classList.remove('hidden');
});

$('nicknameInput').value = currentNickname;
updateNickCounter();
$('nicknameInput').addEventListener('input', updateNickCounter);
$('createBtn').addEventListener('click', createRoom);
$('joinBtn').addEventListener('click', () => joinRoom($('roomInput').value));
$('roomInput').addEventListener('input', e => { e.target.value = formatRoom(e.target.value); });
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(e.target.value); });
$('nicknameInput').addEventListener('keydown', e => { if (e.key === 'Enter' && normalizeRoom($('roomInput').value).length !== 8) createRoom(); });

[$('sidebarShareBtn'), $('emptyShareBtn'), $('dockShareBtn')].forEach(btn => btn.addEventListener('click', startSharing));
[$('copyLinkBtn'), $('emptyCopyBtn')].forEach(btn => btn.addEventListener('click', () => copyText(roomInviteUrl(), 'Link copiado.')));
[$('copyCodeBtn'), $('topRoomCode')].forEach(btn => btn.addEventListener('click', () => copyText(formatRoom(currentRoom), 'Código copiado.')));
$('lockBtn').addEventListener('click', () => leaveRoom(true));
$('leaveBtn').addEventListener('click', () => leaveRoom(role === 'host'));
$('fullscreenBtn').addEventListener('click', async () => {
  const target = document.querySelector('.stream-video:not(.hidden)') || $('roomView');
  try {
    if (!document.fullscreenElement) await target.requestFullscreen();
    else await document.exitFullscreen();
  } catch { toast('Não foi possível abrir em tela cheia.'); }
});

window.addEventListener('beforeunload', () => {
  if (role === 'host' && socket.connected) socket.emit('host:stop');
  if (role === 'viewer' && socket.connected) socket.emit('viewer:leave');
});

const initialRoom = normalizeRoom(new URLSearchParams(location.search).get('room'));
if (initialRoom) $('roomInput').value = formatRoom(initialRoom);

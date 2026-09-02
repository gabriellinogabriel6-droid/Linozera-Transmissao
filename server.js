const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 5e6
});

const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = '4.6.0';
const EMPTY_ROOM_TTL_MS = 120000;
const OWNER_RECONNECT_GRACE_MS = 30000;
const MAX_CHAT = 100;
const rooms = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION, rooms: rooms.size }));
app.get('/api/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(v => v.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  res.json({ iceServers, version: APP_VERSION, transmissionEngine: 'v3-stable' });
});
app.get('/api/version', (_req, res) => {
  res.json({
    version: APP_VERSION,
    notes: [
      'Motor V3 mantido, agora com recuperação automática de conexão WebRTC',
      'Visual desktop reconstruído para seguir o mockup aprovado',
      'Prévia local sempre muda e microfone bloqueado',
      'Configurações completas, abas e botões de atualização corrigidos',
      'Lobby sincroniza automaticamente quando salas públicas mudam',
      'Modo sem retorno reforçado com restrictOwnAudio quando o navegador suporta',
      'Qualidade Automática adapta bitrate/resolução para reduzir lag e saturação de upload',
      'Tela inteira continua sem áudio do sistema para impedir retorno de Discord/Windows',
      'Salas públicas aparecem no lobby mesmo quando ainda não há transmissão',
      'Chat, avatar, sala trancável e seletor de qualidade mantidos'
    ]
  });
});
app.get('/api/public-rooms', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  const list = [...rooms.entries()]
    .filter(([, room]) => room.isPublic && room.members.size > 0)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 24)
    .map(([roomId, room]) => ({
      roomId: formatRoom(roomId),
      ownerName: room.ownerName,
      members: room.members.size,
      streaming: Boolean(room.members.get(room.ownerClientId)?.streaming),
      locked: Boolean(room.locked),
      updatedAt: room.updatedAt
    }));
  res.json({ rooms: list, at: Date.now() });
});

function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
function formatRoom(value) {
  const id = normalizeRoom(value);
  return id.length > 4 ? `${id.slice(0, 4)}-${id.slice(4)}` : id;
}
function sanitizeNickname(value) {
  return String(value || 'Visitante').replace(/[<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Visitante';
}
function sanitizeText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}
function sanitizeAvatar(value) {
  const v = String(value || '');
  if (!v.startsWith('data:image/')) return '';
  if (v.length > 450000) return '';
  return v;
}
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do id = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  while (rooms.has(id));
  return id;
}
function token() { return crypto.randomBytes(24).toString('hex'); }
function notifyLobbyRooms() {
  io.emit('public-rooms:changed', { at: Date.now() });
}
function clearCleanup(room) {
  if (room?.cleanupTimer) clearTimeout(room.cleanupTimer);
  if (room) room.cleanupTimer = null;
}
function clearOwnerReconnect(room) {
  if (room?.ownerReconnectTimer) clearTimeout(room.ownerReconnectTimer);
  if (room) room.ownerReconnectTimer = null;
}
function scheduleOwnerReconnectTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearOwnerReconnect(room);
  room.ownerReconnectTimer = setTimeout(() => {
    const current = rooms.get(roomId);
    if (!current || current.members.has(current.ownerClientId)) return;
    closeRoom(roomId, 'owner-timeout');
  }, OWNER_RECONNECT_GRACE_MS);
}
function scheduleCleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearCleanup(room);
  if (room.members.size > 0) return;
  room.cleanupTimer = setTimeout(() => { rooms.delete(roomId); notifyLobbyRooms(); }, EMPTY_ROOM_TTL_MS);
}
function memberPayload(member, room) {
  return {
    clientId: member.clientId,
    socketId: member.socketId,
    name: member.name,
    avatar: member.avatar || '',
    owner: member.clientId === room.ownerClientId,
    streaming: Boolean(member.streaming),
    quality: member.quality || 'Auto',
    audio: Boolean(member.audio)
  };
}
function statusPayload(roomId, room) {
  return {
    roomId: formatRoom(roomId),
    locked: Boolean(room.locked),
    isPublic: Boolean(room.isPublic),
    ownerClientId: room.ownerClientId,
    members: [...room.members.values()].map(member => memberPayload(member, room)),
    chat: room.chat.slice(-50)
  };
}
function emitStatus(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.updatedAt = Date.now();
  io.to(roomId).emit('room:status', statusPayload(roomId, room));
  notifyLobbyRooms();
}
function ownerMember(room) {
  return room?.members.get(room.ownerClientId) || null;
}
function sameRoomTarget(socket, target) {
  const targetSocket = io.sockets.sockets.get(target);
  return Boolean(targetSocket && socket.data.roomId && targetSocket.data.roomId === socket.data.roomId);
}
function closeRoom(roomId, reason = 'closed') {
  const room = rooms.get(roomId);
  if (!room) return;
  clearCleanup(room);
  clearOwnerReconnect(room);
  io.to(roomId).emit('room:closed', { reason });
  for (const member of room.members.values()) {
    const s = io.sockets.sockets.get(member.socketId);
    if (s) {
      s.leave(roomId);
      s.data.roomId = null;
      s.data.clientId = null;
      s.data.ownerAuth = false;
    }
  }
  rooms.delete(roomId);
  notifyLobbyRooms();
}
function removeSocketFromRoom(socket, explicit = false) {
  const roomId = socket.data.roomId;
  const clientId = socket.data.clientId;
  const room = rooms.get(roomId);
  if (!room || !clientId) return;

  const member = room.members.get(clientId);
  if (member?.socketId === socket.id) {
    const isOwner = clientId === room.ownerClientId;
    if (isOwner && explicit) {
      closeRoom(roomId, 'owner-left');
      return;
    }
    if (isOwner) {
      member.streaming = false;
      member.audio = false;
      socket.to(roomId).emit('host:stream', { active: false });
      socket.to(roomId).emit('host:reconnecting', { explicit: false });
      scheduleOwnerReconnectTimeout(roomId);
    } else {
      const owner = ownerMember(room);
      if (owner?.socketId) io.to(owner.socketId).emit('viewer:left', { viewerId: socket.id, viewerClientId: clientId });
    }
    room.members.delete(clientId);
    socket.to(roomId).emit('member:left', { clientId, socketId: socket.id, explicit });
    emitStatus(roomId);
  }

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.clientId = null;
  socket.data.ownerAuth = false;
  scheduleCleanup(roomId);
}

io.on('connection', socket => {
  socket.on('room:create', ({ clientId, nickname, avatar, isPublic } = {}, ack = () => {}) => {
    const stableId = sanitizeText(clientId, 100) || socket.id;
    const id = roomCode();
    const ownerToken = token();
    const member = {
      clientId: stableId,
      socketId: socket.id,
      name: sanitizeNickname(nickname),
      avatar: sanitizeAvatar(avatar),
      streaming: false,
      quality: 'Auto',
      audio: false,
      joinedAt: Date.now()
    };
    const room = {
      ownerClientId: stableId,
      ownerToken,
      ownerName: member.name,
      locked: false,
      isPublic: Boolean(isPublic),
      knownClientIds: new Set([stableId]),
      members: new Map([[stableId, member]]),
      chat: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cleanupTimer: null,
      ownerReconnectTimer: null
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    socket.data.clientId = stableId;
    socket.data.ownerAuth = true;
    ack({ ok: true, roomId: formatRoom(id), ownerToken, owner: true, hostId: socket.id, status: statusPayload(id, room) });
    emitStatus(id);
  });

  socket.on('room:join', ({ roomId, clientId, nickname, avatar, ownerToken } = {}, ack = () => {}) => {
    const id = normalizeRoom(roomId);
    const room = rooms.get(id);
    if (!room) return ack({ ok: false, error: 'Sala não encontrada ou encerrada.' });

    const stableId = sanitizeText(clientId, 100) || socket.id;
    const isOwner = Boolean(ownerToken && ownerToken === room.ownerToken && stableId === room.ownerClientId);
    const returning = room.knownClientIds.has(stableId);
    if (room.locked && !returning && !isOwner) return ack({ ok: false, locked: true, error: 'A sala está trancada.' });

    clearCleanup(room);
    if (isOwner) clearOwnerReconnect(room);
    const previous = room.members.get(stableId);
    if (previous?.socketId && previous.socketId !== socket.id) io.to(previous.socketId).emit('member:replaced');

    const member = {
      clientId: stableId,
      socketId: socket.id,
      name: sanitizeNickname(nickname || previous?.name),
      avatar: sanitizeAvatar(avatar) || previous?.avatar || '',
      streaming: isOwner ? Boolean(previous?.streaming) : false,
      quality: previous?.quality || 'Auto',
      audio: isOwner ? Boolean(previous?.audio) : false,
      joinedAt: previous?.joinedAt || Date.now()
    };
    room.members.set(stableId, member);
    room.knownClientIds.add(stableId);
    if (isOwner) room.ownerName = member.name;

    socket.join(id);
    socket.data.roomId = id;
    socket.data.clientId = stableId;
    socket.data.ownerAuth = isOwner;

    const owner = ownerMember(room);
    ack({
      ok: true,
      roomId: formatRoom(id),
      owner: isOwner,
      hostId: owner?.socketId || null,
      streaming: Boolean(owner?.streaming),
      status: statusPayload(id, room)
    });

    socket.to(id).emit('member:joined', memberPayload(member, room));
    emitStatus(id);

    if (isOwner) {
      socket.to(id).emit('host:restored', { hostId: socket.id });
      for (const viewer of room.members.values()) {
        if (viewer.clientId !== room.ownerClientId && viewer.socketId) {
          io.to(socket.id).emit('viewer:joined', { viewerId: viewer.socketId, viewerClientId: viewer.clientId, resumed: true });
        }
      }
    } else if (owner?.socketId) {
      io.to(owner.socketId).emit('viewer:joined', { viewerId: socket.id, viewerClientId: stableId });
    }
  });

  socket.on('room:status', (_payload = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return ack({ ok: false, error: 'Sala não encontrada.' });
    const status = statusPayload(roomId, room);
    socket.emit('room:status', status);
    ack({ ok: true, status });
  });

  socket.on('room:profile', ({ nickname, avatar } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const clientId = socket.data.clientId;
    const room = rooms.get(roomId);
    const member = room?.members.get(clientId);
    if (!room || !member || member.socketId !== socket.id) return ack({ ok: false });
    member.name = sanitizeNickname(nickname || member.name);
    const safeAvatar = sanitizeAvatar(avatar);
    if (safeAvatar) member.avatar = safeAvatar;
    if (clientId === room.ownerClientId) room.ownerName = member.name;
    emitStatus(roomId);
    ack({ ok: true });
  });

  socket.on('room:lock', ({ locked } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !socket.data.ownerAuth || socket.data.clientId !== room.ownerClientId) return ack({ ok: false, error: 'Apenas o dono da sala pode trancar.' });
    room.locked = Boolean(locked);
    emitStatus(roomId);
    ack({ ok: true, locked: room.locked });
  });

  socket.on('room:visibility', ({ isPublic } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !socket.data.ownerAuth || socket.data.clientId !== room.ownerClientId) return ack({ ok: false });
    room.isPublic = Boolean(isPublic);
    emitStatus(roomId);
    ack({ ok: true, isPublic: room.isPublic });
  });

  // Motor de transmissão V3: somente o dono da sala transmite; espectadores recebem uma conexão direta dele.
  socket.on('room:stream', ({ active, quality, audio } = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !socket.data.ownerAuth || socket.data.clientId !== room.ownerClientId) return;
    const member = room.members.get(room.ownerClientId);
    if (!member || member.socketId !== socket.id) return;
    member.streaming = Boolean(active);
    member.quality = sanitizeText(quality, 24) || 'Auto';
    member.audio = Boolean(audio && active);
    io.to(roomId).emit('stream:state', {
      clientId: member.clientId,
      socketId: socket.id,
      active: member.streaming,
      quality: member.quality,
      audio: member.audio
    });
    socket.to(roomId).emit('host:stream', { active: member.streaming, quality: member.quality, audio: member.audio });
    emitStatus(roomId);
  });

  socket.on('chat:send', ({ text } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const clientId = socket.data.clientId;
    const room = rooms.get(roomId);
    const member = room?.members.get(clientId);
    const safe = sanitizeText(text, 500);
    if (!room || !member || !safe) return ack({ ok: false });
    const message = {
      id: crypto.randomUUID(),
      clientId,
      name: member.name,
      avatar: member.avatar || '',
      text: safe,
      at: Date.now()
    };
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT) room.chat.splice(0, room.chat.length - MAX_CHAT);
    io.to(roomId).emit('chat:message', message);
    ack({ ok: true });
  });

  // Sinalização simples igual à V3, sem múltiplas sessões por usuário.
  socket.on('webrtc:offer', ({ target, sdp } = {}) => {
    if (target && sdp && sameRoomTarget(socket, target)) io.to(target).emit('webrtc:offer', { from: socket.id, sdp });
  });
  socket.on('webrtc:answer', ({ target, sdp } = {}) => {
    if (target && sdp && sameRoomTarget(socket, target)) io.to(target).emit('webrtc:answer', { from: socket.id, sdp });
  });
  socket.on('webrtc:ice', ({ target, candidate } = {}) => {
    if (target && candidate && sameRoomTarget(socket, target)) io.to(target).emit('webrtc:ice', { from: socket.id, candidate });
  });
  socket.on('webrtc:restart-request', ({ target } = {}) => {
    if (target && sameRoomTarget(socket, target)) io.to(target).emit('webrtc:restart-request', { from: socket.id });
  });

  socket.on('room:leave', () => removeSocketFromRoom(socket, true));
  socket.on('room:close', (_payload = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !socket.data.ownerAuth || socket.data.clientId !== room.ownerClientId) return ack({ ok: false, error: 'Apenas o dono pode encerrar a sala.' });
    ack({ ok: true });
    closeRoom(roomId, 'owner');
  });

  socket.on('disconnect', () => removeSocketFromRoom(socket, false));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Linozera Transmissão v${APP_VERSION} online em http://localhost:${PORT}`);
});

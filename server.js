'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const APP_VERSION = '5.1.0';
const PORT = Number(process.env.PORT || 3000);
const ROOM_EMPTY_TTL_MS = 2 * 60 * 1000;
const OWNER_RECONNECT_GRACE_MS = 35 * 1000;
const MAX_CHAT_MESSAGES = 120;
const MAX_MEMBERS = 30;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 25000,
  maxHttpBufferSize: 5e6
});

const rooms = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  setHeaders(res, filePath) {
    const base = path.basename(filePath);
    // Interface/código devem atualizar logo após um deploy; imagens podem ficar em cache.
    if (base === 'index.html' || base === 'app.js' || base === 'style.css') {
      res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
    }
  }
}));

app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, version: APP_VERSION, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] }
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: String(process.env.TURN_URL).split(',').map(v => v.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  res.json({ version: APP_VERSION, iceServers, transmissionEngine: 'single-presenter-black-screen-fix-v5.1' });
});

app.get('/api/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    version: APP_VERSION,
    notes: [
      'Correção V5.1 para tela preta: receptor aguarda quadro real antes de exibir o player',
      'Recuperação automática também quando nenhuma faixa de vídeo chega',
      'Captura em resolução nativa para evitar falhas de GPU/redimensionamento no Chrome/Windows',
      'Interface reconstruída do zero com layout responsivo e profissional',
      'Salas públicas aparecem no lobby em tempo real e têm atualização de segurança a cada 5 segundos',
      'Motor de transmissão estabilizado sem redimensionamento agressivo durante a apresentação',
      'Modo sem retorno: microfone bloqueado, prévia local muda e áudio de monitor/tela inteira removido',
      'Reconexão automática do Socket.IO e recuperação ICE/WebRTC',
      'Mixer com volume alto, compressor e limite para evitar distorção',
      'Configurações reais de Geral, Áudio, Transmissão, Sala e Notificações',
      'Chat, avatar ajustável, sala trancável e Discord mantidos'
    ]
  });
});

app.get('/api/public-rooms', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ rooms: publicRoomList(), at: Date.now() });
});

function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
function formatRoom(value) {
  const id = normalizeRoom(value);
  return id.length > 4 ? `${id.slice(0, 4)}-${id.slice(4)}` : id;
}
function safeName(value) {
  return String(value || 'Visitante').replace(/[<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Visitante';
}
function safeText(value, max = 500) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, max);
}
function safeAvatar(value) {
  const v = String(value || '');
  if (!v.startsWith('data:image/')) return '';
  if (v.length > 420000) return '';
  return v;
}
function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do {
    id = Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(id));
  return id;
}
function authToken() {
  return crypto.randomBytes(24).toString('hex');
}
function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}
function memberPayload(member, room) {
  return {
    clientId: member.clientId,
    socketId: member.socketId,
    name: member.name,
    avatar: member.avatar || '',
    owner: member.clientId === room.ownerClientId,
    streaming: Boolean(member.streaming),
    quality: member.quality || 'Automático',
    audio: Boolean(member.audio),
    joinedAt: member.joinedAt
  };
}
function statusPayload(roomId, room) {
  return {
    roomId: formatRoom(roomId),
    ownerClientId: room.ownerClientId,
    locked: Boolean(room.locked),
    isPublic: Boolean(room.isPublic),
    members: [...room.members.values()].map(m => memberPayload(m, room)),
    chat: room.chat.slice(-60),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}
function ownerMember(room) {
  return room ? room.members.get(room.ownerClientId) || null : null;
}
function publicRoomList() {
  return [...rooms.entries()]
    .filter(([, room]) => room.isPublic && room.members.size > 0)
    .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
    .slice(0, 30)
    .map(([roomId, room]) => {
      const owner = ownerMember(room);
      return {
        roomId: formatRoom(roomId),
        ownerName: owner?.name || room.ownerName || 'Linozera',
        ownerAvatar: owner?.avatar || '',
        members: room.members.size,
        streaming: Boolean(owner?.streaming),
        quality: owner?.quality || 'Automático',
        audio: Boolean(owner?.audio),
        locked: Boolean(room.locked),
        createdAt: room.createdAt,
        updatedAt: room.updatedAt
      };
    });
}
function emitPublicRooms() {
  io.emit('public-rooms:list', { rooms: publicRoomList(), at: Date.now() });
}
function touchRoom(room) {
  if (room) room.updatedAt = Date.now();
}
function emitRoomStatus(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  touchRoom(room);
  io.to(roomId).emit('room:status', statusPayload(roomId, room));
  emitPublicRooms();
}
function scheduleRoomCleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimer(room.cleanupTimer);
  room.cleanupTimer = null;
  if (room.members.size > 0) return;
  room.cleanupTimer = setTimeout(() => {
    const current = rooms.get(roomId);
    if (current && current.members.size === 0) {
      rooms.delete(roomId);
      emitPublicRooms();
    }
  }, ROOM_EMPTY_TTL_MS);
}
function scheduleOwnerTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimer(room.ownerReconnectTimer);
  room.ownerReconnectTimer = setTimeout(() => {
    const current = rooms.get(roomId);
    if (!current) return;
    if (!current.members.has(current.ownerClientId)) closeRoom(roomId, 'owner-timeout');
  }, OWNER_RECONNECT_GRACE_MS);
}
function closeRoom(roomId, reason = 'closed') {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimer(room.cleanupTimer);
  clearTimer(room.ownerReconnectTimer);
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
  emitPublicRooms();
}
function removeFromRoom(socket, explicit = false) {
  const roomId = socket.data.roomId;
  const clientId = socket.data.clientId;
  if (!roomId || !clientId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const member = room.members.get(clientId);
  if (!member || member.socketId !== socket.id) return;

  const ownerLeaving = clientId === room.ownerClientId;
  if (ownerLeaving && explicit) {
    closeRoom(roomId, 'owner-left');
    return;
  }

  if (ownerLeaving) {
    member.streaming = false;
    member.audio = false;
    room.members.delete(clientId);
    socket.to(roomId).emit('host:stream', { active: false, reconnecting: true });
    socket.to(roomId).emit('member:left', { clientId, socketId: socket.id, temporary: true });
    scheduleOwnerTimeout(roomId);
  } else {
    const owner = ownerMember(room);
    if (owner?.socketId) io.to(owner.socketId).emit('viewer:left', { viewerId: socket.id, viewerClientId: clientId });
    room.members.delete(clientId);
    socket.to(roomId).emit('member:left', { clientId, socketId: socket.id, temporary: false });
  }

  socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.clientId = null;
  socket.data.ownerAuth = false;
  emitRoomStatus(roomId);
  scheduleRoomCleanup(roomId);
}
function sameRoom(socket, targetSocketId) {
  const target = io.sockets.sockets.get(targetSocketId);
  return Boolean(target && socket.data.roomId && target.data.roomId === socket.data.roomId);
}
function canOwner(socket, room) {
  return Boolean(room && socket.data.ownerAuth && socket.data.clientId === room.ownerClientId);
}

io.on('connection', socket => {
  socket.data.chatTimes = [];

  socket.on('public-rooms:request', (_payload, ack = () => {}) => {
    ack({ ok: true, rooms: publicRoomList(), at: Date.now() });
  });

  socket.on('room:create', ({ clientId, nickname, avatar, isPublic = true } = {}, ack = () => {}) => {
    if (socket.data.roomId) removeFromRoom(socket, true);
    const stableId = safeText(clientId, 100) || socket.id;
    const roomId = randomRoomCode();
    const ownerToken = authToken();
    const member = {
      clientId: stableId,
      socketId: socket.id,
      name: safeName(nickname),
      avatar: safeAvatar(avatar),
      streaming: false,
      quality: 'Automático',
      audio: false,
      joinedAt: Date.now()
    };
    const room = {
      ownerClientId: stableId,
      ownerToken,
      ownerName: member.name,
      locked: false,
      isPublic: isPublic !== false,
      knownClientIds: new Set([stableId]),
      members: new Map([[stableId, member]]),
      chat: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cleanupTimer: null,
      ownerReconnectTimer: null
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.clientId = stableId;
    socket.data.ownerAuth = true;
    ack({ ok: true, roomId: formatRoom(roomId), ownerToken, owner: true, status: statusPayload(roomId, room) });
    emitRoomStatus(roomId);
  });

  socket.on('room:join', ({ roomId, clientId, nickname, avatar, ownerToken } = {}, ack = () => {}) => {
    const id = normalizeRoom(roomId);
    const room = rooms.get(id);
    if (!room) return ack({ ok: false, error: 'Sala não encontrada ou já encerrada.' });

    const stableId = safeText(clientId, 100) || socket.id;
    const isOwner = Boolean(ownerToken && ownerToken === room.ownerToken && stableId === room.ownerClientId);
    const returning = room.knownClientIds.has(stableId);

    if (!isOwner && room.locked && !returning) return ack({ ok: false, error: 'Essa sala está trancada.' });
    if (!isOwner && room.members.size >= MAX_MEMBERS) return ack({ ok: false, error: 'Essa sala atingiu o limite de participantes.' });

    const previous = room.members.get(stableId);
    if (previous && previous.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(previous.socketId);
      if (oldSocket) {
        oldSocket.leave(id);
        oldSocket.data.roomId = null;
        oldSocket.data.clientId = null;
        oldSocket.data.ownerAuth = false;
        oldSocket.emit('session:replaced');
      }
    }

    const member = {
      clientId: stableId,
      socketId: socket.id,
      name: safeName(nickname),
      avatar: safeAvatar(avatar),
      streaming: isOwner ? Boolean(previous?.streaming) : false,
      quality: previous?.quality || 'Automático',
      audio: isOwner ? Boolean(previous?.audio) : false,
      joinedAt: previous?.joinedAt || Date.now()
    };

    room.members.set(stableId, member);
    room.knownClientIds.add(stableId);
    room.ownerName = room.ownerClientId === stableId ? member.name : room.ownerName;
    touchRoom(room);
    clearTimer(room.cleanupTimer);
    room.cleanupTimer = null;
    if (isOwner) {
      clearTimer(room.ownerReconnectTimer);
      room.ownerReconnectTimer = null;
    }

    socket.join(id);
    socket.data.roomId = id;
    socket.data.clientId = stableId;
    socket.data.ownerAuth = isOwner;

    ack({ ok: true, roomId: formatRoom(id), owner: isOwner, ownerToken: isOwner ? room.ownerToken : '', status: statusPayload(id, room) });
    socket.to(id).emit('member:joined', memberPayload(member, room));
    emitRoomStatus(id);

    const owner = ownerMember(room);
    if (!isOwner && owner?.streaming && owner.socketId) {
      socket.emit('host:stream', { active: true, quality: owner.quality, audio: owner.audio });
      io.to(owner.socketId).emit('viewer:ready', { viewerId: socket.id, viewerClientId: stableId });
    }
    if (isOwner) socket.to(id).emit('host:reconnected', { ownerSocketId: socket.id });
  });

  socket.on('room:leave', (_payload, ack = () => {}) => {
    removeFromRoom(socket, true);
    ack({ ok: true });
  });

  socket.on('room:close', (_payload, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!canOwner(socket, room)) return ack({ ok: false, error: 'Somente o dono pode encerrar a sala.' });
    closeRoom(roomId, 'owner-closed');
    ack({ ok: true });
  });

  socket.on('room:status:request', (_payload, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return ack({ ok: false, error: 'Sala não encontrada.' });
    ack({ ok: true, status: statusPayload(roomId, room) });
  });

  socket.on('room:lock', ({ locked } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!canOwner(socket, room)) return ack({ ok: false, error: 'Somente o dono pode alterar a sala.' });
    room.locked = Boolean(locked);
    emitRoomStatus(roomId);
    ack({ ok: true, locked: room.locked });
  });

  socket.on('room:visibility', ({ isPublic } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!canOwner(socket, room)) return ack({ ok: false, error: 'Somente o dono pode alterar a sala.' });
    room.isPublic = Boolean(isPublic);
    emitRoomStatus(roomId);
    ack({ ok: true, isPublic: room.isPublic });
  });

  socket.on('room:profile', ({ nickname, avatar } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    const member = room?.members.get(socket.data.clientId);
    if (!room || !member || member.socketId !== socket.id) return ack({ ok: false });
    member.name = safeName(nickname);
    member.avatar = safeAvatar(avatar);
    if (member.clientId === room.ownerClientId) room.ownerName = member.name;
    emitRoomStatus(roomId);
    ack({ ok: true });
  });

  socket.on('room:stream', ({ active, quality, audio } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!canOwner(socket, room)) return ack({ ok: false, error: 'Somente o dono da sala pode apresentar.' });
    const owner = ownerMember(room);
    if (!owner) return ack({ ok: false, error: 'Dono da sala desconectado.' });
    owner.streaming = Boolean(active);
    owner.quality = safeText(quality, 30) || 'Automático';
    owner.audio = Boolean(audio && active);
    socket.to(roomId).emit('host:stream', { active: owner.streaming, quality: owner.quality, audio: owner.audio });
    emitRoomStatus(roomId);
    ack({ ok: true });
  });

  socket.on('viewer:request-stream', (_payload, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return ack({ ok: false });
    const owner = ownerMember(room);
    if (owner?.streaming && owner.socketId && owner.socketId !== socket.id) {
      io.to(owner.socketId).emit('viewer:ready', { viewerId: socket.id, viewerClientId: socket.data.clientId });
      ack({ ok: true, active: true });
    } else ack({ ok: true, active: false });
  });

  socket.on('chat:send', ({ text } = {}, ack = () => {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    const member = room?.members.get(socket.data.clientId);
    if (!room || !member || member.socketId !== socket.id) return ack({ ok: false, error: 'Você não está em uma sala.' });

    const now = Date.now();
    socket.data.chatTimes = (socket.data.chatTimes || []).filter(t => now - t < 5000);
    if (socket.data.chatTimes.length >= 6) return ack({ ok: false, error: 'Você está enviando mensagens rápido demais.' });
    socket.data.chatTimes.push(now);

    const clean = safeText(text, 600);
    if (!clean) return ack({ ok: false });
    const message = {
      id: crypto.randomUUID(),
      clientId: member.clientId,
      name: member.name,
      avatar: member.avatar || '',
      text: clean,
      at: now
    };
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT_MESSAGES) room.chat.splice(0, room.chat.length - MAX_CHAT_MESSAGES);
    touchRoom(room);
    io.to(roomId).emit('chat:message', message);
    ack({ ok: true });
  });

  socket.on('webrtc:offer', ({ target, description } = {}) => {
    if (!target || !description || !sameRoom(socket, target)) return;
    io.to(target).emit('webrtc:offer', { from: socket.id, description });
  });
  socket.on('webrtc:answer', ({ target, description } = {}) => {
    if (!target || !description || !sameRoom(socket, target)) return;
    io.to(target).emit('webrtc:answer', { from: socket.id, description });
  });
  socket.on('webrtc:ice', ({ target, candidate } = {}) => {
    if (!target || !candidate || !sameRoom(socket, target)) return;
    io.to(target).emit('webrtc:ice', { from: socket.id, candidate });
  });

  socket.on('disconnect', () => removeFromRoom(socket, false));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Linozera Transmissao V${APP_VERSION} online na porta ${PORT}`);
});

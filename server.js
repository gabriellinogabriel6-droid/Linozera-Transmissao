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
  maxHttpBufferSize: 1e6
});

const PORT = Number(process.env.PORT || 3000);
const HOST_GRACE_MS = 15000;
const rooms = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(v => v.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  res.json({ iceServers, hostGraceMs: HOST_GRACE_MS });
});

function normalizeRoom(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
function sanitizeNickname(value) {
  return String(value || 'Visitante').replace(/[<>]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24) || 'Visitante';
}
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  do { id = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(id));
  return id;
}
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

function membersFor(room) {
  if (!room) return [];
  const members = [];
  if (room.hostSocketId || room.hostToken) members.push({ clientId: 'host', name: room.hostName || 'Linozera', host: true });
  for (const [clientId, viewer] of room.viewers.entries()) {
    members.push({ clientId, name: viewer.nickname || 'Visitante', host: false });
  }
  return members;
}

function roomStatus(room) {
  return {
    live: Boolean(room?.hostSocketId),
    reconnecting: Boolean(room && !room.hostSocketId && room.hostToken),
    streaming: Boolean(room?.streaming),
    viewers: room?.viewers?.size || 0,
    members: membersFor(room)
  };
}
function emitStatus(roomId) {
  const room = rooms.get(roomId);
  io.to(roomId).emit('room:status', { roomId, ...roomStatus(room) });
}
function clearHostTimer(room) {
  if (room?.hostTimer) clearTimeout(room.hostTimer);
  if (room) room.hostTimer = null;
}
function closeRoom(roomId, reason = 'ended') {
  const room = rooms.get(roomId);
  if (!room) return;
  clearHostTimer(room);
  io.to(roomId).emit('host:ended', { reason });
  rooms.delete(roomId);
}

io.on('connection', socket => {
  socket.on('room:status', ({ roomId } = {}) => {
    const id = normalizeRoom(roomId);
    socket.emit('room:status', { roomId: id, ...roomStatus(rooms.get(id)) });
  });

  socket.on('host:create', ({ roomId, hostToken, nickname } = {}, ack = () => {}) => {
    const requested = normalizeRoom(roomId);
    const id = requested || roomCode();
    let room = rooms.get(id);

    if (room) {
      const canResume = hostToken && room.hostToken && hostToken === room.hostToken;
      if (room.hostSocketId && room.hostSocketId !== socket.id && !canResume) return ack({ ok: false, error: 'Essa sala já está em uso.' });
      if (!canResume && room.hostToken) return ack({ ok: false, error: 'Essa sala está se reconectando.' });
    } else {
      room = {
        hostSocketId: null,
        hostToken: hostToken || makeToken(),
        hostName: sanitizeNickname(nickname),
        viewers: new Map(),
        hostTimer: null,
        streaming: false
      };
      rooms.set(id, room);
    }

    clearHostTimer(room);
    room.hostSocketId = socket.id;
    room.hostName = sanitizeNickname(nickname || room.hostName);
    if (!room.hostToken) room.hostToken = hostToken || makeToken();

    socket.join(id);
    socket.data.role = 'host';
    socket.data.roomId = id;
    socket.data.clientId = 'host';

    ack({ ok: true, roomId: id, hostToken: room.hostToken, resumed: Boolean(hostToken), streaming: room.streaming });
    socket.to(id).emit('host:restored', { hostId: socket.id });
    emitStatus(id);

    for (const viewer of room.viewers.values()) {
      io.to(socket.id).emit('viewer:joined', { viewerId: viewer.socketId, resumed: true });
    }
  });

  socket.on('viewer:join', ({ roomId, clientId, nickname } = {}, ack = () => {}) => {
    const id = normalizeRoom(roomId);
    const room = rooms.get(id);
    if (!room) return ack({ ok: false, error: 'Transmissão não encontrada ou encerrada.' });
    if (!room.hostSocketId) return ack({ ok: false, reconnecting: true, error: 'O transmissor está se reconectando. Tente novamente.' });

    const stableId = String(clientId || socket.id).slice(0, 80);
    const previous = room.viewers.get(stableId);
    if (previous?.socketId && previous.socketId !== socket.id) io.to(previous.socketId).emit('viewer:replaced');

    room.viewers.set(stableId, { socketId: socket.id, nickname: sanitizeNickname(nickname) });
    socket.join(id);
    socket.data.role = 'viewer';
    socket.data.roomId = id;
    socket.data.clientId = stableId;

    ack({ ok: true, roomId: id, hostId: room.hostSocketId, streaming: room.streaming });
    io.to(room.hostSocketId).emit('viewer:joined', { viewerId: socket.id });
    emitStatus(id);
  });

  socket.on('host:stream', ({ active } = {}) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || socket.data.role !== 'host' || room.hostSocketId !== socket.id) return;
    room.streaming = Boolean(active);
    socket.to(roomId).emit('host:stream', { active: room.streaming });
    emitStatus(roomId);
  });

  socket.on('webrtc:offer', ({ target, sdp } = {}) => { if (target && sdp) io.to(target).emit('webrtc:offer', { from: socket.id, sdp }); });
  socket.on('webrtc:answer', ({ target, sdp } = {}) => { if (target && sdp) io.to(target).emit('webrtc:answer', { from: socket.id, sdp }); });
  socket.on('webrtc:ice', ({ target, candidate } = {}) => { if (target && candidate) io.to(target).emit('webrtc:ice', { from: socket.id, candidate }); });

  socket.on('host:stop', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (room && room.hostSocketId === socket.id) closeRoom(roomId, 'stopped');
    socket.data.roomId = null;
    socket.data.role = null;
  });

  socket.on('viewer:leave', () => removeViewer(socket));

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;

    if (socket.data.role === 'host' && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      io.to(roomId).emit('host:reconnecting', { graceMs: HOST_GRACE_MS });
      emitStatus(roomId);
      clearHostTimer(room);
      room.hostTimer = setTimeout(() => closeRoom(roomId, 'timeout'), HOST_GRACE_MS);
      return;
    }
    if (socket.data.role === 'viewer') removeViewer(socket, true);
  });
});

function removeViewer(socket, disconnected = false) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room) return;
  const clientId = socket.data.clientId;
  const current = clientId ? room.viewers.get(clientId) : null;
  if (!clientId || current?.socketId === socket.id) {
    if (clientId) room.viewers.delete(clientId);
    if (room.hostSocketId) io.to(room.hostSocketId).emit('viewer:left', { viewerId: socket.id });
    emitStatus(roomId);
  }
  if (!disconnected) socket.leave(roomId);
  socket.data.roomId = null;
  socket.data.role = null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Linozera Transmissão online em http://localhost:${PORT}`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Renderでも動くようにpolling→websocketのアップグレードを明示
  transports: ['polling', 'websocket']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── アカウントDB（メモリ）───────────────────────────────
// password は sha256 ハッシュで保存
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

const accounts = new Map([
  ['カピバラ族のリーダー', { passwordHash: sha256('tkhr0422'), isAdmin: true }]
]);

// セッショントークン: token -> username
const sessions = new Map();

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ─── REST: ログイン・登録 ────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '入力が空です' });

  const account = accounts.get(username);
  if (!account) return res.status(401).json({ error: 'ユーザーが存在しません' });
  if (account.passwordHash !== sha256(password))
    return res.status(401).json({ error: 'パスワードが違います' });

  const token = makeToken();
  sessions.set(token, username);
  res.json({ token, username, isAdmin: account.isAdmin });
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '入力が空です' });
  if (username.length > 20) return res.status(400).json({ error: '名前は20文字以内' });
  if (password.length < 4)  return res.status(400).json({ error: 'パスワードは4文字以上' });
  if (accounts.has(username)) return res.status(409).json({ error: 'すでに使われている名前です' });

  accounts.set(username, { passwordHash: sha256(password), isAdmin: false });
  const token = makeToken();
  sessions.set(token, username);
  res.json({ token, username, isAdmin: false });
});

// ─── State ───────────────────────────────────────────────
const users  = new Map(); // socketId -> { username, room, color, isAdmin, ip, joinedAt }
const rooms  = new Map(); // roomName -> Set<socketId>
const banned = new Set(); // banned IPs / usernames
const msgLog = [];
const MAX_LOG = 500;

const COLORS = [
  '#800000','#008000','#000080','#808000',
  '#800080','#008080','#804000','#004080'
];
let colorIdx = 0;
function nextColor() { return COLORS[colorIdx++ % COLORS.length]; }

function getIP(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address;
}

function getMembersInRoom(room) {
  return [...(rooms.get(room) || [])].map(id => {
    const u = users.get(id);
    return u ? { socketId: id, username: u.username, color: u.color, isAdmin: u.isAdmin } : null;
  }).filter(Boolean);
}

function getAdminSocket() {
  for (const [sid, u] of users) {
    if (u.isAdmin) return io.sockets.sockets.get(sid);
  }
  return null;
}

function broadcastAdminStats() {
  const adminSock = getAdminSocket();
  if (!adminSock) return;
  const roomList = [...rooms.entries()].map(([name, ids]) => ({
    name, count: ids.size,
    members: [...ids].map(id => {
      const u = users.get(id);
      return u ? { socketId: id, username: u.username, color: u.color, isAdmin: u.isAdmin, ip: u.ip } : null;
    }).filter(Boolean)
  }));
  adminSock.emit('admin:stats', {
    totalUsers: users.size,
    totalRooms: rooms.size,
    bannedCount: banned.size,
    rooms: roomList,
    recentLogs: msgLog.slice(-50)
  });
}

// ─── Socket ──────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = getIP(socket);

  // ── 認証付きjoin ──
  socket.on('join', ({ token, room }) => {
    const username = sessions.get(token);
    if (!username) {
      socket.emit('authError', 'セッションが無効です。再ログインしてください。');
      return;
    }
    if (banned.has(username) || banned.has(ip)) {
      socket.emit('kicked', { reason: 'あなたはBANされています。' });
      socket.disconnect(true);
      return;
    }

    const account = accounts.get(username);
    const isAdmin = account?.isAdmin || false;
    const trimRoom = (room || 'General').trim().slice(0, 30);
    const color = nextColor();

    users.set(socket.id, { username, room: trimRoom, color, isAdmin, ip, joinedAt: Date.now() });
    socket.join(trimRoom);
    if (!rooms.has(trimRoom)) rooms.set(trimRoom, new Set());
    rooms.get(trimRoom).add(socket.id);

    socket.emit('joined', { isAdmin, username, color });
    io.to(trimRoom).emit('system', {
      text: `${username} が入室しました${isAdmin ? '【管理者】' : ''}`,
      timestamp: Date.now()
    });
    io.to(trimRoom).emit('members', getMembersInRoom(trimRoom));
    broadcastAdminStats();
  });

  // ── メッセージ ──
  socket.on('message', (text) => {
    const user = users.get(socket.id);
    if (!user || !text || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) return;

    const msg = {
      id: `${socket.id}-${Date.now()}`,
      room: user.room, name: user.username, color: user.color,
      text: trimmed, timestamp: Date.now(), isAdmin: user.isAdmin
    };
    msgLog.push(msg);
    if (msgLog.length > MAX_LOG) msgLog.shift();
    io.to(user.room).emit('message', msg);
    broadcastAdminStats();
  });

  // ── typing ──
  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit('typing', { name: user.username, isTyping });
  });

  // ── ADMIN ──────────────────────────────────────────────
  function chkAdmin() { return users.get(socket.id)?.isAdmin === true; }

  socket.on('admin:kick', ({ targetSocketId }) => {
    if (!chkAdmin()) return;
    const tUser = users.get(targetSocketId);
    const tSock = io.sockets.sockets.get(targetSocketId);
    if (!tUser || !tSock) return;
    tSock.emit('kicked', { reason: '管理者によってキックされました。' });
    tSock.disconnect(true);
    io.to(tUser.room).emit('system', { text: `${tUser.username} がキックされました`, timestamp: Date.now() });
    broadcastAdminStats();
  });

  socket.on('admin:ban', ({ targetSocketId }) => {
    if (!chkAdmin()) return;
    const tUser = users.get(targetSocketId);
    const tSock = io.sockets.sockets.get(targetSocketId);
    if (!tUser) return;
    banned.add(tUser.username);
    banned.add(tUser.ip);
    if (tSock) { tSock.emit('kicked', { reason: '管理者によってBANされました。' }); tSock.disconnect(true); }
    io.to(tUser.room).emit('system', { text: `${tUser.username} がBANされました`, timestamp: Date.now() });
    broadcastAdminStats();
  });

  socket.on('admin:deleteMsg', ({ msgId }) => {
    if (!chkAdmin()) return;
    const idx = msgLog.findIndex(m => m.id === msgId);
    if (idx !== -1) msgLog.splice(idx, 1);
    io.emit('deleteMsg', { msgId });
    broadcastAdminStats();
  });

  socket.on('admin:createRoom', ({ roomName }) => {
    if (!chkAdmin()) return;
    const r = (roomName || '').trim().slice(0, 30);
    if (!r || rooms.has(r)) return;
    rooms.set(r, new Set());
    io.emit('roomCreated', { room: r });
    broadcastAdminStats();
  });

  socket.on('admin:deleteRoom', ({ roomName }) => {
    if (!chkAdmin()) return;
    if (!rooms.has(roomName)) return;
    [...rooms.get(roomName)].forEach(id => {
      const s = io.sockets.sockets.get(id);
      if (s) { s.emit('roomDeleted', { room: roomName }); s.disconnect(true); }
    });
    rooms.delete(roomName);
    broadcastAdminStats();
  });

  socket.on('admin:getStats', () => { if (chkAdmin()) broadcastAdminStats(); });

  // ── disconnect ──
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    const { username, room } = user;
    rooms.get(room)?.delete(socket.id);
    if (rooms.get(room)?.size === 0) rooms.delete(room);
    users.delete(socket.id);
    io.to(room).emit('system', { text: `${username} が退出しました`, timestamp: Date.now() });
    io.to(room).emit('members', getMembersInRoom(room));
    broadcastAdminStats();
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', users: users.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Chat server on port ${PORT}`));

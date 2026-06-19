const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SQLite DB ────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'chat.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    name TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS banned (
    value TEXT PRIMARY KEY,
    banned_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, timestamp);
`);

// デフォルト板を作成
const defaultRooms = ['General', '雑談', '質問', 'ゲーム', 'アニメ'];
const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms(name) VALUES(?)');
defaultRooms.forEach(r => insertRoom.run(r));

// 管理者アカウント初期化
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
db.prepare('INSERT OR IGNORE INTO accounts(username, password_hash, is_admin) VALUES(?,?,1)')
  .run('カピバラ族のリーダー', sha256('tkhr0422'));

// ─── セッション（メモリ）────────────────────────────────
const sessions = new Map();

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

// ─── DB ヘルパー ─────────────────────────────────────────
const stmts = {
  getAccount: db.prepare('SELECT * FROM accounts WHERE username = ?'),
  createAccount: db.prepare('INSERT INTO accounts(username, password_hash) VALUES(?,?)'),
  insertMsg: db.prepare('INSERT INTO messages(id,room,username,text,is_admin,timestamp) VALUES(?,?,?,?,?,?)'),
  getRoomMessages: db.prepare('SELECT * FROM messages WHERE room=? AND deleted=0 ORDER BY timestamp ASC LIMIT ?'),
  deleteMsg: db.prepare('UPDATE messages SET deleted=1 WHERE id=?'),
  getAllRooms: db.prepare('SELECT name FROM rooms ORDER BY name ASC'),
  createRoom: db.prepare('INSERT OR IGNORE INTO rooms(name) VALUES(?)'),
  deleteRoom: db.prepare('DELETE FROM rooms WHERE name=?'),
  isBanned: db.prepare('SELECT 1 FROM banned WHERE value=?'),
  addBan: db.prepare('INSERT OR IGNORE INTO banned(value) VALUES(?)'),
  getBannedCount: db.prepare('SELECT COUNT(*) as cnt FROM banned'),
  getRecentLogs: db.prepare('SELECT * FROM messages WHERE deleted=0 ORDER BY timestamp DESC LIMIT 50'),
  searchMessages: db.prepare('SELECT * FROM messages WHERE room=? AND deleted=0 AND text LIKE ? ORDER BY timestamp DESC LIMIT 50'),
  getRoomCount: db.prepare('SELECT COUNT(*) as cnt FROM rooms'),
};

// ─── REST API ─────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '入力が空です' });

  const account = stmts.getAccount.get(username);
  if (!account) return res.status(401).json({ error: 'ユーザーが存在しません' });
  if (account.password_hash !== sha256(password))
    return res.status(401).json({ error: 'パスワードが違います' });

  const token = makeToken();
  sessions.set(token, username);
  res.json({ token, username, isAdmin: !!account.is_admin });
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '入力が空です' });
  if (username.length > 20) return res.status(400).json({ error: '名前は20文字以内' });
  if (password.length < 4) return res.status(400).json({ error: 'パスワードは4文字以上' });
  if (stmts.getAccount.get(username)) return res.status(409).json({ error: 'すでに使われている名前です' });

  stmts.createAccount.run(username, sha256(password));
  const token = makeToken();
  sessions.set(token, username);
  res.json({ token, username, isAdmin: false });
});

// メッセージ検索API
app.get('/api/search', (req, res) => {
  const { room, q } = req.query;
  if (!room || !q) return res.json([]);
  const results = stmts.searchMessages.all(room, `%${q}%`);
  res.json(results);
});

// ─── State ───────────────────────────────────────────────
const users = new Map(); // socketId -> { username, room, isAdmin, ip }

const COLORS = ['#e07b54','#5b9bd5','#5aab7f','#9b72c4','#c4a44a','#5ab8c4','#c45a7f','#7f9b5a'];
let colorIdx = 0;
function nextColor() { return COLORS[colorIdx++ % COLORS.length]; }

function getIP(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address;
}

function getMembersInRoom(room) {
  return [...users.entries()]
    .filter(([, u]) => u.room === room)
    .map(([id, u]) => ({ socketId: id, username: u.username, isAdmin: u.isAdmin }));
}

function broadcastAdminStats() {
  for (const [sid, u] of users) {
    if (!u.isAdmin) continue;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;

    const roomList = stmts.getAllRooms.all().map(r => ({
      name: r.name,
      count: getMembersInRoom(r.name).length,
      members: getMembersInRoom(r.name).map(m => ({ ...m, ip: users.get(m.socketId)?.ip || '' }))
    }));

    sock.emit('admin:stats', {
      totalUsers: users.size,
      totalRooms: roomList.length,
      bannedCount: stmts.getBannedCount.get().cnt,
      rooms: roomList,
      recentLogs: stmts.getRecentLogs.all().reverse()
    });
  }
}

// ─── Socket.IO ────────────────────────────────────────────
let typingTimeouts = new Map();

io.on('connection', (socket) => {
  const ip = getIP(socket);

  socket.on('join', ({ token, room }) => {
    const username = sessions.get(token);
    if (!username) {
      socket.emit('authError', 'セッションが無効です。再ログインしてください。');
      return;
    }
    if (stmts.isBanned.get(username) || stmts.isBanned.get(ip)) {
      socket.emit('kicked', { reason: 'あなたはBANされています。' });
      socket.disconnect(true);
      return;
    }

    // 前の部屋から退出
    const prev = users.get(socket.id);
    if (prev) {
      socket.leave(prev.room);
      io.to(prev.room).emit('system', { text: `${username} が退出しました`, timestamp: Date.now() });
      io.to(prev.room).emit('members', getMembersInRoom(prev.room));
    }

    const account = stmts.getAccount.get(username);
    const isAdmin = !!account?.is_admin;
    const trimRoom = (room || 'General').trim().slice(0, 30);

    users.set(socket.id, { username, room: trimRoom, isAdmin, ip, color: nextColor() });
    socket.join(trimRoom);

    // 板が存在しなければ作成
    stmts.createRoom.run(trimRoom);

    socket.emit('joined', { isAdmin, username });

    // 過去100件のメッセージを送信
    const history = stmts.getRoomMessages.all(trimRoom, 100);
    socket.emit('history', history);

    io.to(trimRoom).emit('system', {
      text: `${username} が入室しました${isAdmin ? '【管理者】' : ''}`,
      timestamp: Date.now()
    });
    io.to(trimRoom).emit('members', getMembersInRoom(trimRoom));
    broadcastAdminStats();
  });

  socket.on('message', (text) => {
    const user = users.get(socket.id);
    if (!user || !text || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) return;

    const msg = {
      id: `${socket.id}-${Date.now()}`,
      room: user.room,
      username: user.username,
      name: user.username,
      text: trimmed,
      timestamp: Date.now(),
      isAdmin: user.isAdmin,
      is_admin: user.isAdmin ? 1 : 0
    };

    stmts.insertMsg.run(msg.id, msg.room, msg.username, msg.text, msg.is_admin, msg.timestamp);
    io.to(user.room).emit('message', msg);
    broadcastAdminStats();
  });

  socket.on('typing', (isTyping) => {
    const user = users.get(socket.id);
    if (!user) return;
    socket.to(user.room).emit('typing', { name: user.username, isTyping });
    if (isTyping) {
      clearTimeout(typingTimeouts.get(socket.id));
      typingTimeouts.set(socket.id, setTimeout(() => {
        socket.to(user.room).emit('typing', { name: user.username, isTyping: false });
      }, 3000));
    }
  });

  // ─── 管理者 ──────────────────────────────────────────
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
    stmts.addBan.run(tUser.username);
    stmts.addBan.run(tUser.ip);
    if (tSock) { tSock.emit('kicked', { reason: '管理者によってBANされました。' }); tSock.disconnect(true); }
    io.to(tUser.room).emit('system', { text: `${tUser.username} がBANされました`, timestamp: Date.now() });
    broadcastAdminStats();
  });

  socket.on('admin:deleteMsg', ({ msgId }) => {
    if (!chkAdmin()) return;
    stmts.deleteMsg.run(msgId);
    io.emit('deleteMsg', { msgId });
    broadcastAdminStats();
  });

  socket.on('admin:createRoom', ({ roomName }) => {
    if (!chkAdmin()) return;
    const r = (roomName || '').trim().slice(0, 30);
    if (!r) return;
    stmts.createRoom.run(r);
    io.emit('roomCreated', { room: r });
    broadcastAdminStats();
  });

  socket.on('admin:deleteRoom', ({ roomName }) => {
    if (!chkAdmin()) return;
    stmts.deleteRoom.run(roomName);
    [...users.entries()].forEach(([id, u]) => {
      if (u.room !== roomName) return;
      const s = io.sockets.sockets.get(id);
      if (s) { s.emit('roomDeleted', { room: roomName }); s.disconnect(true); }
    });
    broadcastAdminStats();
  });

  socket.on('admin:getStats', () => { if (chkAdmin()) broadcastAdminStats(); });

  // 板一覧取得
  socket.on('getRooms', () => {
    const rooms = stmts.getAllRooms.all().map(r => ({ name: r.name }));
    socket.emit('roomList', rooms);
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;
    clearTimeout(typingTimeouts.get(socket.id));
    typingTimeouts.delete(socket.id);
    users.delete(socket.id);
    io.to(user.room).emit('system', { text: `${user.username} が退出しました`, timestamp: Date.now() });
    io.to(user.room).emit('members', getMembersInRoom(user.room));
    broadcastAdminStats();
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', users: users.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Chat server v2 on port ${PORT}`));

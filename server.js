const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['polling', 'websocket']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Firebase Admin 初期化 ────────────────────────────────
// FIREBASE_SERVICE_ACCOUNT 環境変数にサービスアカウントJSONを設定
// 未設定時は databaseURL だけで匿名アクセス（開発用）
let db;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  initializeApp(serviceAccount
    ? { credential: cert(serviceAccount), databaseURL: 'https://kapibarazoku-d0a6f-default-rtdb.firebaseio.com' }
    : { databaseURL: 'https://kapibarazoku-d0a6f-default-rtdb.firebaseio.com' }
  );
  db = getDatabase();
  console.log('✅ Firebase connected');
} catch (e) {
  console.error('Firebase init error:', e.message);
  process.exit(1);
}

// ─── DB ヘルパー ─────────────────────────────────────────
const ref = (p) => db.ref(p);

async function dbGet(path) {
  const snap = await ref(path).get();
  return snap.exists() ? snap.val() : null;
}
async function dbSet(path, val) { await ref(path).set(val); }
async function dbUpdate(path, val) { await ref(path).update(val); }
async function dbPush(path, val) { return await ref(path).push(val); }

// ─── ユーティリティ ───────────────────────────────────────
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}
function makeToken() { return crypto.randomBytes(24).toString('hex'); }

// ─── 起動時：管理者アカウント・デフォルト板を初期化 ─────
async function bootstrap() {
  // 管理者アカウント
  const adminExists = await dbGet('accounts/カピバラ族のリーダー');
  if (!adminExists) {
    await dbSet('accounts/カピバラ族のリーダー', {
      passwordHash: sha256('tkhr0422'),
      isAdmin: true
    });
    console.log('管理者アカウント作成');
  }

  // デフォルト板
  const defaultRooms = ['General', '雑談', '質問', 'ゲーム', 'アニメ'];
  for (const r of defaultRooms) {
    const exists = await dbGet(`rooms/${r}`);
    if (!exists) await dbSet(`rooms/${r}`, { createdAt: Date.now() });
  }
  console.log('✅ Bootstrap complete');
}

// ─── セッション（メモリ）────────────────────────────────
const sessions = new Map(); // token -> username

// ─── REST API ─────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '入力が空です' });

  const account = await dbGet(`accounts/${encodeKey(username)}`);
  if (!account) return res.status(401).json({ error: 'ユーザーが存在しません' });
  if (account.passwordHash !== sha256(password))
    return res.status(401).json({ error: 'パスワードが違います' });

  const token = makeToken();
  sessions.set(token, username);
  res.json({ token, username, isAdmin: !!account.isAdmin });
});

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '入力が空です' });
  if (username.length > 20) return res.status(400).json({ error: '名前は20文字以内' });
  if (password.length < 4)  return res.status(400).json({ error: 'パスワードは4文字以上' });

  const exists = await dbGet(`accounts/${encodeKey(username)}`);
  if (exists) return res.status(409).json({ error: 'すでに使われている名前です' });

  await dbSet(`accounts/${encodeKey(username)}`, {
    passwordHash: sha256(password),
    isAdmin: false
  });
  const token = makeToken();
  sessions.set(token, username);
  res.json({ token, username, isAdmin: false });
});

// Firebase キーに使えない文字をエスケープ
function encodeKey(str) {
  return str.replace(/[.#$[\]/]/g, c => '%' + c.charCodeAt(0).toString(16));
}
function encodeRoom(str) { return encodeKey(str); }

// ─── 接続中ユーザー（メモリ）────────────────────────────
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

async function broadcastAdminStats() {
  for (const [sid, u] of users) {
    if (!u.isAdmin) continue;
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;

    const roomsData = await dbGet('rooms') || {};
    const roomList = Object.keys(roomsData).map(r => ({
      name: r,
      count: getMembersInRoom(r).length,
      members: getMembersInRoom(r).map(m => ({ ...m, ip: users.get(m.socketId)?.ip || '' }))
    }));

    // 最新ログ50件
    const logsSnap = await ref('messages').orderByChild('timestamp').limitToLast(50).get();
    const recentLogs = [];
    if (logsSnap.exists()) {
      logsSnap.forEach(child => {
        const m = child.val();
        if (!m.deleted) recentLogs.push({ ...m, id: child.key });
      });
    }

    const bannedSnap = await ref('banned').get();
    const bannedCount = bannedSnap.exists() ? Object.keys(bannedSnap.val()).length : 0;

    sock.emit('admin:stats', {
      totalUsers: users.size,
      totalRooms: roomList.length,
      bannedCount,
      rooms: roomList,
      recentLogs: recentLogs.reverse()
    });
  }
}

// ─── Socket.IO ────────────────────────────────────────────
const typingTimeouts = new Map();

io.on('connection', (socket) => {
  const ip = getIP(socket);

  socket.on('getRooms', async () => {
    const roomsData = await dbGet('rooms') || {};
    socket.emit('roomList', Object.keys(roomsData).map(r => ({ name: r })));
  });

  socket.on('join', async ({ token, room }) => {
    const username = sessions.get(token);
    if (!username) { socket.emit('authError', 'セッションが無効です。再ログインしてください。'); return; }

    // BAN チェック
    const bannedUser = await dbGet(`banned/${encodeKey(username)}`);
    const bannedIp   = await dbGet(`banned/${encodeKey(ip)}`);
    if (bannedUser || bannedIp) {
      socket.emit('kicked', { reason: 'あなたはBANされています。' });
      socket.disconnect(true); return;
    }

    // 前の部屋から退出
    const prev = users.get(socket.id);
    if (prev) {
      socket.leave(prev.room);
      io.to(prev.room).emit('system', { text: `${username} が退出しました`, timestamp: Date.now() });
      io.to(prev.room).emit('members', getMembersInRoom(prev.room));
    }

    const account = await dbGet(`accounts/${encodeKey(username)}`);
    const isAdmin = !!account?.isAdmin;
    const trimRoom = (room || 'General').trim().slice(0, 30);

    // 板を作成（なければ）
    const roomExists = await dbGet(`rooms/${encodeRoom(trimRoom)}`);
    if (!roomExists) await dbSet(`rooms/${encodeRoom(trimRoom)}`, { createdAt: Date.now() });

    users.set(socket.id, { username, room: trimRoom, isAdmin, ip, color: nextColor() });
    socket.join(trimRoom);

    socket.emit('joined', { isAdmin, username });

    // 過去100件の履歴を送信
    const histSnap = await ref('messages')
      .orderByChild('room_ts')
      .startAt(`${trimRoom}_`)
      .endAt(`${trimRoom}_\uf8ff`)
      .limitToLast(100)
      .get();

    const history = [];
    if (histSnap.exists()) {
      histSnap.forEach(child => {
        const m = child.val();
        if (!m.deleted) history.push({ ...m, id: child.key });
      });
    }
    socket.emit('history', history);

    io.to(trimRoom).emit('system', {
      text: `${username} が入室しました${isAdmin ? '【管理者】' : ''}`,
      timestamp: Date.now()
    });
    io.to(trimRoom).emit('members', getMembersInRoom(trimRoom));
    broadcastAdminStats();
  });

  socket.on('message', async (text) => {
    const user = users.get(socket.id);
    if (!user || !text || typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) return;

    const msg = {
      room: user.room,
      username: user.username,
      name: user.username,
      text: trimmed,
      timestamp: Date.now(),
      isAdmin: user.isAdmin,
      deleted: false,
      // 部屋+タイムスタンプで範囲クエリできるようにする
      room_ts: `${user.room}_${Date.now()}`
    };

    const pushed = await dbPush('messages', msg);
    const msgWithId = { ...msg, id: pushed.key };

    io.to(user.room).emit('message', msgWithId);
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

  socket.on('admin:ban', async ({ targetSocketId }) => {
    if (!chkAdmin()) return;
    const tUser = users.get(targetSocketId);
    const tSock = io.sockets.sockets.get(targetSocketId);
    if (!tUser) return;
    await dbSet(`banned/${encodeKey(tUser.username)}`, true);
    await dbSet(`banned/${encodeKey(tUser.ip)}`, true);
    if (tSock) { tSock.emit('kicked', { reason: '管理者によってBANされました。' }); tSock.disconnect(true); }
    io.to(tUser.room).emit('system', { text: `${tUser.username} がBANされました`, timestamp: Date.now() });
    broadcastAdminStats();
  });

  socket.on('admin:deleteMsg', async ({ msgId }) => {
    if (!chkAdmin()) return;
    await dbUpdate(`messages/${msgId}`, { deleted: true });
    io.emit('deleteMsg', { msgId });
    broadcastAdminStats();
  });

  socket.on('admin:createRoom', async ({ roomName }) => {
    if (!chkAdmin()) return;
    const r = (roomName || '').trim().slice(0, 30);
    if (!r) return;
    const exists = await dbGet(`rooms/${encodeRoom(r)}`);
    if (exists) return;
    await dbSet(`rooms/${encodeRoom(r)}`, { createdAt: Date.now() });
    io.emit('roomCreated', { room: r });
    broadcastAdminStats();
  });

  socket.on('admin:deleteRoom', async ({ roomName }) => {
    if (!chkAdmin()) return;
    await ref(`rooms/${encodeRoom(roomName)}`).remove();
    [...users.entries()].forEach(([id, u]) => {
      if (u.room !== roomName) return;
      const s = io.sockets.sockets.get(id);
      if (s) { s.emit('roomDeleted', { room: roomName }); s.disconnect(true); }
    });
    broadcastAdminStats();
  });

  socket.on('admin:getStats', () => { if (chkAdmin()) broadcastAdminStats(); });

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
bootstrap().then(() => {
  server.listen(PORT, () => console.log(`✅ Chat server (Firebase) on port ${PORT}`));
});

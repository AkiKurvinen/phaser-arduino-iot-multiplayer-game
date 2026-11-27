const express = require('express')
const app = express()
const server = require('http').Server(app)
const { Server } = require('socket.io');
const io = new Server(server, {
  pingTimeout: 60000,
  connectionStateRecovery: { maxDisconnectionDuration: 30000 },
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const GAMESIZE = { width: 800, height: 450 }
const PORT = process.env.PORT || 8080
const HEARTBEAT_TIMEOUT = 60000
const RECONNECT_GRACE = 30000

// ─── Helpers ────────────────────────────────────────────────────────────────

const generateRandomLobbyName = (length = 4) => {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

const randomPos = () => ({
  x: Math.floor(Math.random() * GAMESIZE.width) + 50,
  y: Math.floor(Math.random() * GAMESIZE.height) + 50,
})

// ─── Lobby / Game State ──────────────────────────────────────────────────────

/**
 * games = {
 *   [lobbyCode]: {
 *     code: string,
 *     players: { [socketId]: PlayerObject },
 *     star: { x, y },
 *     scores: { [socketId]: { username: string, score: number } },
 *   }
 * }
 */
const games = {}
const pendingRemovals = new Map()

function createGame(code) {
  games[code] = {
    code,
    players: {},
    star: randomPos(),
    scores: {},
  };
  return games[code];
}

function getOrCreateGame(code) {
  return games[code] ?? createGame(code);
}

function removePlayerFromGame(game, socketId) {
  delete game.players[socketId];
  delete game.scores[socketId];
  // Clean up empty lobbies
  if (Object.keys(game.players).length === 0) {
    delete games[game.code];
    console.log(`Lobby ${game.code} deleted (empty)`);
  }
}

// ─── HTTP Routes ─────────────────────────────────────────────────────────────

app.use(express.static(`${__dirname}/public`))
app.get('/', (req, res) => res.sendFile(`${__dirname}/index.html`))

/** Create a new lobby and return its code. */
app.get('/lobby/create', (req, res) => {
  let code;
  // Avoid accidental collisions with existing lobbies
  do { code = generateRandomLobbyName(4); } while (games[code]);
  createGame(code);
  console.log(`Lobby created: ${code}`);
  res.json({ lobby: code });
});

/** List all active lobbies with player counts. */
app.get('/lobby/list', (req, res) => {
  const list = Object.values(games).map(g => ({
    code: g.code,
    playerCount: Object.keys(g.players).length,
    scores: g.scores,
  }));
  res.json(list);
});

/** Stats for a specific lobby. */
app.get('/lobby/stats/:lobby', (req, res) => {
  const game = games[req.params.lobby];
  if (!game) return res.status(404).json({ error: 'Game not found' });
  res.json(lobbySnapshot(game));
});

function lobbySnapshot(game) {
  return {
    code: game.code,
    players: Object.values(game.players),
    scores: game.scores,
    star: game.star,
  };
}

app.get('/lobby/view/:lobby', (req, res) => {
  const game = games[req.params.lobby];
  if (game) return res.json(lobbySnapshot(game));
  res.json({
    code: req.params.lobby,
    players: [],
    scores: {},
    star: null,
  });
});

server.listen(PORT, () => console.log(`Server listening at http://localhost:${PORT}`))

// ─── Socket.IO ───────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`${socket.id} connected`);

  // Client must send { username, color, lobby } in the handshake query.
  const { username, color, lobby: lobbyCode } = socket.handshake.query;

  if (!lobbyCode) {
    console.log(`${socket.id} rejected: no lobby provided`);
    socket.emit('error', { message: 'No lobby code provided.' });
    socket.disconnect(true);
    return;
  }

  const game = getOrCreateGame(lobbyCode);
  const pendingRemoval = pendingRemovals.get(socket.id);
  if (pendingRemoval) {
    clearTimeout(pendingRemoval);
    pendingRemovals.delete(socket.id);
  }
  const heartbeatTimer = setTimeout(() => {
    console.log(`${socket.id} disconnected after heartbeat timeout`);
    socket.conn.close(true);
  }, HEARTBEAT_TIMEOUT);
  const onPacket = packet => {
    if (packet.type === 'pong') heartbeatTimer.refresh();
  };
  socket.conn.on('packet', onPacket);

  const recoveredPlayer = socket.recovered && game.players[socket.id];
  const player = recoveredPlayer || {
    rotation: 0,
    ...randomPos(),
    playerId: socket.id,
    username: username || 'Anonymous',
    color: color || '#ffffff',
    lobby: lobbyCode,
  };

  game.players[socket.id] = player;
  if (!recoveredPlayer) {
    game.scores[socket.id] = { username: player.username, score: 0 };
  }

  // Join the socket.io room for this lobby
  socket.join(lobbyCode);
  console.log(`${player.username} (${socket.id}) joined lobby ${lobbyCode}`);

  // Bootstrap the joining player
  socket.emit('currentPlayers', game.players);
  socket.emit('starLocation', game.star);
  io.to(lobbyCode).emit('scoreUpdate', game.scores);

  // Notify everyone else in the lobby
  if (!recoveredPlayer) socket.to(lobbyCode).emit('newPlayer', player);

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', reason => {
    clearTimeout(heartbeatTimer);
    socket.conn.off('packet', onPacket);
    console.log(`${socket.id} disconnected from lobby ${lobbyCode}: ${reason}`);
    const removePlayer = () => {
      pendingRemovals.delete(socket.id);
      removePlayerFromGame(game, socket.id);
      io.to(lobbyCode).emit('playerDisconnected', socket.id);
      io.to(lobbyCode).emit('scoreUpdate', game.scores);
    };
    if (reason === 'client namespace disconnect' || reason === 'server namespace disconnect') {
      removePlayer();
    } else {
      pendingRemovals.set(socket.id, setTimeout(removePlayer, RECONNECT_GRACE));
    }
  });

  // ── Movement ──────────────────────────────────────────────────────────────

  socket.on('playerMovement', data => {
    const p = game.players[socket.id];
    if (!p) return;
    p.x = data.x;
    p.y = data.y;
    p.rotation = data.rotation;
    socket.to(lobbyCode).emit('playerMoved', p);
  });

  // ── Star Collection ───────────────────────────────────────────────────────

  socket.on('starCollected', () => {
    const p = game.players[socket.id];
    if (!p) return;
    console.log(`${p.username} collected star in lobby ${lobbyCode}`);
    game.scores[socket.id].score += 10;
    Object.assign(game.star, randomPos());
    io.to(lobbyCode).emit('starLocation', game.star);
    io.to(lobbyCode).emit('scoreUpdate', game.scores);
  });

  // ── Color Change ──────────────────────────────────────────────────────────

  socket.on('colorChange', data => {
    const p = game.players[socket.id];
    if (!p) return;
    p.color = data.color;
    socket.to(lobbyCode).emit('playerColorUpdate', {
      playerId: socket.id,
      color: data.color,
    });
  });
});
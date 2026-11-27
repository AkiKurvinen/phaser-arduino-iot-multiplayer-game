const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const vm = require('node:vm');

async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startServer(t) {
  const port = await availablePort();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 5000);
    server.stdout.on('data', data => {
      if (data.toString().includes('Server listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Server exited with code ${code}`)));
  });
  return `http://127.0.0.1:${port}`;
}

async function connect(base, username, lobby, recovery) {
  const endpoint = new URL('/socket.io/', base);
  endpoint.search = new URLSearchParams({
    EIO: '4', transport: 'polling', username, lobby, color: '#ff0000',
  });
  const request = async (method = 'GET', body) => {
    const response = await fetch(endpoint, { method, body, signal: AbortSignal.timeout(32000) });
    assert.equal(response.status, 200);
    return response.text();
  };
  const handshake = await request();
  assert.equal(handshake[0], '0');
  endpoint.searchParams.set('sid', JSON.parse(handshake.slice(1)).sid);
  await request('POST', `40${recovery ? JSON.stringify(recovery) : ''}`);
  const pending = [];
  let pid;
  let offset;
  return {
    async event(name, predicate = () => true) {
      while (true) {
        const index = pending.findIndex(event => event[0] === name && predicate(event[1]));
        if (index !== -1) return pending.splice(index, 1)[0][1];
        const packets = (await request()).split('\x1e');
        for (const packet of packets) {
          if (packet.startsWith('40')) pid = JSON.parse(packet.slice(2)).pid;
          if (packet.startsWith('42')) {
            const event = JSON.parse(packet.slice(2));
            if (typeof event[event.length - 1] === 'string') offset = event[event.length - 1];
            pending.push(event);
          }
          if (packet === '2') await request('POST', '3');
        }
      }
    },
    async emit(name, data) {
      await request('POST', `42${JSON.stringify(data === undefined ? [name] : [name, data])}`);
    },
    async disconnect() {
      await request('POST', '41');
    },
    async loseConnection() {
      await request('POST', '1');
    },
    async sendStatus(name, data) {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: `42${JSON.stringify([name, data])}`,
        signal: AbortSignal.timeout(5000),
      });
      return response.status;
    },
    recovery() {
      assert.ok(pid && offset);
      return { pid, offset };
    },
  };
}

test('scores belong to individual players and remain isolated by lobby', async t => {
  const base = await startServer(t);
  const emptyView = await (await fetch(`${base}/lobby/view/one`)).json();
  assert.deepEqual(emptyView, { code: 'one', players: [], scores: {}, star: null });
  assert.deepEqual(await (await fetch(`${base}/lobby/list`)).json(), []);
  const alice = await connect(base, 'Alice', 'one');
  const alicePlayers = await alice.event('currentPlayers');
  const aliceId = Object.keys(alicePlayers)[0];
  assert.equal('team' in alicePlayers[aliceId], false);
  assert.deepEqual(await alice.event('scoreUpdate'), { [aliceId]: { username: 'Alice', score: 0 } });

  const bob = await connect(base, 'Bob', 'one');
  const bobPlayers = await bob.event('currentPlayers');
  const bobId = Object.keys(bobPlayers).find(id => id !== aliceId);
  assert.ok(bobId);
  await alice.event('scoreUpdate', scores => Object.keys(scores).length === 2);

  const other = await connect(base, 'Alice', 'two');
  const otherPlayers = await other.event('currentPlayers');
  const otherId = Object.keys(otherPlayers)[0];
  await other.event('scoreUpdate');

  await alice.emit('starCollected');
  const scores = await bob.event('scoreUpdate', value => value[aliceId].score === 10);
  assert.deepEqual(scores, {
    [aliceId]: { username: 'Alice', score: 10 },
    [bobId]: { username: 'Bob', score: 0 },
  });
  const stats = await (await fetch(`${base}/lobby/stats/one`)).json();
  assert.deepEqual(stats.scores, scores);
  assert.deepEqual(await (await fetch(`${base}/lobby/view/one`)).json(), stats);
  const otherStats = await (await fetch(`${base}/lobby/stats/two`)).json();
  assert.deepEqual(otherStats.scores, { [otherId]: { username: 'Alice', score: 0 } });

  await bob.emit('starCollected');
  const updatedScores = await alice.event('scoreUpdate', value => value[bobId] && value[bobId].score === 10);
  assert.equal(updatedScores[aliceId].score, 10);
  assert.equal(updatedScores[bobId].score, 10);

  await alice.disconnect();
  await bob.event('playerDisconnected', id => id === aliceId);
  assert.deepEqual(
    await bob.event('scoreUpdate', value => !value[aliceId]),
    { [bobId]: { username: 'Bob', score: 10 } },
  );
  await bob.disconnect();
  await other.disconnect();
});

test('unexpected disconnect preserves a score during the 30-second recovery window', { timeout: 45000 }, async t => {
  const base = await startServer(t);
  const alice = await connect(base, 'Alice', 'recovery');
  const aliceId = Object.keys(await alice.event('currentPlayers'))[0];
  await alice.event('scoreUpdate');
  await alice.emit('starCollected');
  await alice.event('scoreUpdate', scores => scores[aliceId].score === 10);
  const credentials = alice.recovery();

  const bob = await connect(base, 'Bob', 'recovery');
  await bob.event('currentPlayers');
  await bob.event('scoreUpdate');
  await alice.loseConnection();
  const duringGrace = await (await fetch(`${base}/lobby/stats/recovery`)).json();
  assert.equal(duringGrace.scores[aliceId].score, 10);

  const recovered = await connect(base, 'Alice', 'recovery', credentials);
  const recoveredPlayers = await recovered.event('currentPlayers');
  assert.ok(recoveredPlayers[aliceId]);
  const recoveredScores = await recovered.event('scoreUpdate', scores => scores[aliceId].score === 10);
  assert.equal(Object.keys(recoveredScores).length, 2);

  const removed = bob.event('playerDisconnected', id => id === aliceId);
  await recovered.loseConnection();
  await sleep(29000);
  const beforeExpiry = await (await fetch(`${base}/lobby/stats/recovery`)).json();
  assert.equal(beforeExpiry.scores[aliceId].score, 10);
  await removed;
  const afterExpiry = await (await fetch(`${base}/lobby/stats/recovery`)).json();
  assert.equal(afterExpiry.scores[aliceId], undefined);
  await bob.disconnect();
});

test('heartbeat timeout is 60 seconds even if gameplay packets arrive', { timeout: 105000 }, async t => {
  const base = await startServer(t);
  const alice = await connect(base, 'Alice', 'heartbeat');
  const aliceId = Object.keys(await alice.event('currentPlayers'))[0];
  await alice.event('scoreUpdate');
  const start = Date.now();
  const bob = await connect(base, 'Bob', 'heartbeat');
  await bob.event('currentPlayers');
  await bob.event('scoreUpdate');
  const removed = bob.event('playerDisconnected', id => id === aliceId);

  await sleep(40000);
  assert.equal(await alice.sendStatus('playerMovement', { x: 1, y: 1, rotation: 0 }), 200);
  await sleep(Math.max(0, 59000 - (Date.now() - start)));
  assert.equal(await alice.sendStatus('playerMovement', { x: 2, y: 2, rotation: 0 }), 200);
  await sleep(Math.max(0, 62000 - (Date.now() - start)));
  assert.equal(await alice.sendStatus('playerMovement', { x: 3, y: 3, rotation: 0 }), 400);
  const duringGrace = await (await fetch(`${base}/lobby/stats/heartbeat`)).json();
  assert.ok(duringGrace.scores[aliceId]);
  assert.equal(Object.keys(duringGrace.scores).length, 2);
  await removed;
  assert.ok(Date.now() - start >= 89000);
  const afterGrace = await (await fetch(`${base}/lobby/stats/heartbeat`)).json();
  assert.equal(afterGrace.scores[aliceId], undefined);
  assert.equal(Object.keys(afterGrace.scores).length, 1);
  await bob.disconnect();
});

for (const webgl of [true, false]) test(`players initialize and update colors with ${webgl ? 'WebGL' : 'Canvas'}`, () => {
  const handlers = {};
  const players = [];
  let scoreText;
  let overlapShip;
  const makeSprite = () => ({
    setOrigin() { return this; },
    setDisplaySize() { return this; },
    setTint(color) { this.color = color; return this; },
    setDrag() {},
    setAngularDrag() {},
    setMaxVelocity() {},
    enableFilters() {
      this.filters = webgl ? { internal: { addGlow: color => ({
        color,
        setPaddingOverride(padding) { assert.equal(padding, null); },
      }) } } : null;
    },
    destroy() { this.destroyed = true; },
  });
  const sprite = makeSprite();
  const ship = makeSprite();
  const game = {
    socket: { id: 'alice', on: (event, handler) => { handlers[event] = handler; }, emit() {} },
    otherPlayers: { add: player => players.push(player), getChildren: () => players, clear: () => { players.length = 0; } },
    scoreText: { setText: text => { scoreText = text.join('\n'); } },
    add: { sprite: () => sprite },
    physics: { add: {
      image: (x, y, key) => key === 'ship' ? ship : makeSprite(),
      overlap: player => {
        overlapShip = player;
        return { destroy() { assert.equal(this.destroyed, undefined); this.destroyed = true; } };
      },
    } },
    playerColorLabel: { fillStyle() {}, fillRect() {} },
    playerNameLabel: { setText() {} },
  };
  const context = {
    Phaser: { Display: { Color: { HexStringToColor: color => ({ color: parseInt(color.slice(1), 16) }) } } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'socketActions.js'), 'utf8'), context);
  context.setupSocketActions(game);
  handlers.currentPlayers({
    bob: { playerId: 'bob', color: '#00ff00', x: 0, y: 0 },
    alice: { playerId: 'alice', username: 'Alice', lobby: 'one', color: '#ff0000', x: 0, y: 0 },
  });
  handlers.starLocation({ x: 10, y: 20 });
  assert.equal(overlapShip, ship);
  assert.equal(ship.color, 0xff0000);
  assert.equal(sprite.color, 0x00ff00);
  if (webgl) {
    assert.equal(ship.playerGlow.color, 0xff0000);
    assert.equal(sprite.playerGlow.color, 0x00ff00);
  }
  handlers.scoreUpdate({
    alice: { username: 'Alice', score: 10 },
    bob: { username: 'Bob', score: 20 },
  });
  assert.equal(scoreText, 'Scores\nBob: 20\nAlice (you): 10');
  handlers.playerColorUpdate({ playerId: 'bob', color: 0x0000ff });
  assert.equal(sprite.color, 0x0000ff);
  if (webgl) assert.equal(sprite.playerGlow.color, 0x0000ff);
  handlers.currentPlayers({
    alice: { playerId: 'alice', username: 'Alice', lobby: 'one', color: 0xff0000, x: 0, y: 0 },
    bob: { playerId: 'bob', color: 0x0000ff, x: 0, y: 0 },
  });
  handlers.starLocation({ x: 30, y: 40 });
  assert.equal(overlapShip, ship);
  handlers.playerDisconnected('bob');
  assert.equal(sprite.destroyed, true);
});

test('spectator snapshots display player changes and clear an empty lobby', () => {
  const players = [];
  let scoreText;
  const makeSprite = () => ({
    setOrigin() { return this; },
    setDisplaySize() { return this; },
    setTint(color) { this.color = color; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
    setRotation(rotation) { this.rotation = rotation; return this; },
    enableFilters() { this.filters = null; },
    destroy() {
      this.destroyed = true;
      const index = players.indexOf(this);
      if (index !== -1) players.splice(index, 1);
    },
  });
  const game = {
    otherPlayers: { add: player => players.push(player), getChildren: () => players },
    scoreText: { setText: text => { scoreText = text.join('\n'); } },
    add: { sprite: makeSprite },
    physics: { add: { image: (x, y) => makeSprite().setPosition(x, y) } },
  };
  const context = {
    Phaser: { Display: { Color: { HexStringToColor: color => ({ color: parseInt(color.slice(1), 16) }) } } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'socketActions.js'), 'utf8'), context);
  context.renderSpectatorSnapshot(game, {
    players: [{ playerId: 'alice', color: '#ff0000', x: 10, y: 20, rotation: 1 }],
    scores: { alice: { username: 'Alice', score: 10 } },
    star: { x: 40, y: 50 },
  });
  const ship = players[0];
  assert.equal(ship.color, 0xff0000);
  assert.equal(scoreText, 'Scores\nAlice: 10');
  assert.deepEqual([game.star.x, game.star.y], [40, 50]);

  context.renderSpectatorSnapshot(game, {
    players: [{ playerId: 'alice', color: 0x00ff00, x: 11, y: 22, rotation: 2 }],
    scores: { alice: { username: 'Alice', score: 20 } },
    star: { x: 60, y: 70 },
  });
  assert.equal(players[0], ship);
  assert.deepEqual([ship.x, ship.y, ship.rotation, ship.color], [11, 22, 2, 0x00ff00]);
  assert.deepEqual([game.star.x, game.star.y], [60, 70]);
  assert.equal(scoreText, 'Scores\nAlice: 20');

  context.renderSpectatorSnapshot(game, { players: [], scores: {}, star: null });
  assert.equal(players.length, 0);
  assert.equal(ship.destroyed, true);
  assert.equal(game.star, null);
  assert.equal(scoreText, 'Scores');
});

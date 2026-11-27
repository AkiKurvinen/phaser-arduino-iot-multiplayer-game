const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
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

async function connect(base, username, lobby) {
  const endpoint = new URL('/socket.io/', base);
  endpoint.search = new URLSearchParams({
    EIO: '4', transport: 'polling', username, lobby, color: '#ff0000',
  });
  const request = async (method = 'GET', body) => {
    const response = await fetch(endpoint, { method, body, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return response.text();
  };
  const handshake = await request();
  assert.equal(handshake[0], '0');
  endpoint.searchParams.set('sid', JSON.parse(handshake.slice(1)).sid);
  await request('POST', '40');
  const pending = [];
  return {
    async event(name, predicate = () => true) {
      while (true) {
        const index = pending.findIndex(event => event[0] === name && predicate(event[1]));
        if (index !== -1) return pending.splice(index, 1)[0][1];
        const packets = (await request()).split('\x1e');
        for (const packet of packets) {
          if (packet.startsWith('42')) pending.push(JSON.parse(packet.slice(2)));
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
  };
}

test('scores belong to individual players and remain isolated by lobby', async t => {
  const base = await startServer(t);
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
    otherPlayers: { add: player => players.push(player), getChildren: () => players },
    scoreText: { setText: text => { scoreText = text.join('\n'); } },
    add: { sprite: () => sprite },
    physics: { add: {
      image: (x, y, key) => key === 'ship' ? ship : makeSprite(),
      overlap: player => { overlapShip = player; },
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
  handlers.playerDisconnected('bob');
  assert.equal(sprite.destroyed, true);
});

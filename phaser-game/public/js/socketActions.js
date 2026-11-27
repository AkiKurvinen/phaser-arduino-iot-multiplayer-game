function setupSocketActions(game) {
    let reconnectTimer;
    game.socket.on('connect', () => {
        clearTimeout(reconnectTimer);
        game.connectionText.setText('');
    });

    game.socket.on('disconnect', () => {
        if (game.ship) {
            game.ship.setVelocity(0);
            game.ship.setAcceleration(0);
            game.ship.setAngularVelocity(0);
        }
        if (!game.socket.active) {
            game.connectionText.setText('Disconnected. Refresh to rejoin.');
            return;
        }
        game.connectionText.setText('Connection lost. Reconnecting...');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            game.socket.disconnect();
            game.connectionText.setText('Connection lost. Refresh to rejoin.');
        }, 30000);
    });

    game.socket.on('currentPlayers', players => {
        if (game.starCollider) {
            game.starCollider.destroy();
            game.starCollider = null;
        }
        if (game.star) {
            game.star.destroy();
            game.star = null;
        }
        if (game.ship) game.ship.destroy();
        game.otherPlayers.clear(true, true);
        addPlayer(game, players[game.socket.id]);
        Object.keys(players).forEach(id => {
            if (id !== game.socket.id) addOtherPlayers(game, players[id]);
        });
    });

    game.socket.on('newPlayer', player => addOtherPlayers(game, player));

    game.socket.on('playerDisconnected', playerId => {
        game.otherPlayers.getChildren().forEach(oPlayer => {
            if (playerId === oPlayer.playerId) {
                oPlayer.destroy();
            }
        });
    });

    game.socket.on('playerMoved', player => {
        game.otherPlayers.getChildren().forEach(oPlayer => {
            if (player.playerId === oPlayer.playerId) {
                oPlayer.setRotation(player.rotation);
                oPlayer.setPosition(player.x, player.y);
            }
        });
    });

    game.socket.on('scoreUpdate', scores => {
        updateScoreboard(game, scores, game.socket.id);
    });

    game.socket.on('starLocation', starLocation => {
        if (game.starCollider) game.starCollider.destroy();
        if (game.star) game.star.destroy();
        game.star = game.physics.add.image(starLocation.x, starLocation.y, 'star');
        game.starCollider = game.physics.add.overlap(game.ship, game.star, () => {
            if (game.socket.connected) game.socket.emit('starCollected');
        }, null, game);
    });

    game.socket.on('playerColorUpdate', data => {
        const player = game.otherPlayers.getChildren().find(p => p.playerId === data.playerId);
        if (player) updatePlayerColor(player, data.color);
    });
}

function addPlayer(game, player) {
    const color = playerColor(player.color);
    game.ship = game.physics.add.image(player.x, player.y, 'ship')
        .setOrigin(0.5, 0.5)
        .setDisplaySize(53, 40);
    game.ship.setTint(color);
    game.ship.setDrag(100);
    game.ship.setAngularDrag(100);
    game.ship.setMaxVelocity(200);
    addPlayerGlow(game.ship, color);
    game.socket.emit('colorChange', { color });
    game.playerColorLabel.fillStyle(color, 1);
    game.playerColorLabel.fillRect(240, 26, 50, 10);
    game.playerNameLabel.setText(`${player.username} (${player.lobby})`);
}

function addOtherPlayers(game, oPlayer) {
    const color = playerColor(oPlayer.color);
    const otherPlayer = game.add.sprite(oPlayer.x, oPlayer.y, 'otherPlayer')
        .setOrigin(0.5, 0.5)
        .setDisplaySize(53, 40)
        .setTint(color);
    otherPlayer.playerId = oPlayer.playerId;
    otherPlayer.playerColor = color;
    game.otherPlayers.add(otherPlayer);
    addPlayerGlow(otherPlayer, color);
    return otherPlayer;
}

function updatePlayerColor(player, color) {
    color = playerColor(color);
    player.setTint(color);
    player.playerColor = color;
    if (player.playerGlow) player.playerGlow.color = color;
}

function updateScoreboard(game, scores, ownId) {
    const leaderboard = Object.entries(scores)
        .sort(([, a], [, b]) => b.score - a.score)
        .map(([id, entry]) => `${entry.username}${id === ownId ? ' (you)' : ''}: ${entry.score}`);
    game.scoreText.setText(['Scores', ...leaderboard]);
}

function setupSpectator(game, lobby) {
    let timer;
    let stopped = false;
    let failed = false;
    let controller;
    game.events.once('shutdown', () => {
        stopped = true;
        clearTimeout(timer);
        if (controller) controller.abort();
    });

    async function poll() {
        controller = new AbortController();
        const requestTimeout = setTimeout(() => controller.abort(), 5000);
        try {
            const response = await fetch(`/lobby/view/${encodeURIComponent(lobby)}`, {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (stopped) return;
            if (!response.ok) throw new Error(`Lobby request failed: ${response.status}`);
            const snapshot = await response.json();
            if (stopped) return;
            renderSpectatorSnapshot(game, snapshot);
            game.connectionText.setText(snapshot.players.length ? 'Spectating' : 'Waiting for players...');
            failed = false;
        } catch (error) {
            if (!stopped) {
                if (!failed) console.error('Unable to update spectator view:', error);
                failed = true;
                game.connectionText.setText('Connection lost. Retrying...');
            }
        } finally {
            clearTimeout(requestTimeout);
            if (!stopped) timer = setTimeout(poll, 250);
        }
    }

    poll();
}

function renderSpectatorSnapshot(game, snapshot) {
    const ids = new Set(snapshot.players.map(player => player.playerId));
    for (const player of [...game.otherPlayers.getChildren()]) {
        if (!ids.has(player.playerId)) player.destroy();
    }
    for (const player of snapshot.players) {
        let sprite = game.otherPlayers.getChildren().find(other => other.playerId === player.playerId);
        if (!sprite) sprite = addOtherPlayers(game, player);
        sprite.setPosition(player.x, player.y);
        sprite.setRotation(player.rotation);
        if (sprite.playerColor !== playerColor(player.color)) updatePlayerColor(sprite, player.color);
    }
    updateScoreboard(game, snapshot.scores);
    if (!snapshot.star) {
        if (game.star) game.star.destroy();
        game.star = null;
    } else if (game.star) {
        game.star.setPosition(snapshot.star.x, snapshot.star.y);
    } else {
        game.star = game.physics.add.image(snapshot.star.x, snapshot.star.y, 'star');
    }
}

function playerColor(color) {
    return typeof color === 'number' ? color : Phaser.Display.Color.HexStringToColor(color).color;
}

function addPlayerGlow(player, color) {
    player.enableFilters();
    if (player.filters) {
        player.playerGlow = player.filters.internal.addGlow(color, 4, 2);
        player.playerGlow.setPaddingOverride(null);
    }
}
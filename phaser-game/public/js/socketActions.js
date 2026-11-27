function setupSocketActions(game) {
    game.socket.on('currentPlayers', players => {
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
        const leaderboard = Object.entries(scores)
            .sort(([, a], [, b]) => b.score - a.score)
            .map(([id, entry]) => `${entry.username}${id === game.socket.id ? ' (you)' : ''}: ${entry.score}`);
        game.scoreText.setText(['Scores', ...leaderboard]);
    });

    game.socket.on('starLocation', starLocation => {
        if (game.star) game.star.destroy();
        game.star = game.physics.add.image(starLocation.x, starLocation.y, 'star');
        game.physics.add.overlap(game.ship, game.star, () => {
            game.socket.emit('starCollected');
        }, null, game);
    });

    game.socket.on('playerColorUpdate', data => {
        const player = game.otherPlayers.getChildren().find(p => p.playerId === data.playerId);
        if (player) {
            player.setTint(data.color);
            if (player.playerGlow) player.playerGlow.color = data.color;
        }
    });
}

function addPlayer(game, player) {
    const glowColor = Phaser.Display.Color.HexStringToColor(player.color);
    game.ship = game.physics.add.image(player.x, player.y, 'ship')
        .setOrigin(0.5, 0.5)
        .setDisplaySize(53, 40);
    game.ship.setTint(glowColor.color);
    game.ship.setDrag(100);
    game.ship.setAngularDrag(100);
    game.ship.setMaxVelocity(200);
    addPlayerGlow(game.ship, glowColor.color);
    game.socket.emit('colorChange', { color: glowColor.color });
    game.playerColorLabel.fillStyle(glowColor.color, 1);
    game.playerColorLabel.fillRect(240, 26, 50, 10);
    game.playerNameLabel.setText(`${player.username} (${player.lobby})`);
}

function addOtherPlayers(game, oPlayer) {
    const color = typeof oPlayer.color === 'number'
        ? oPlayer.color
        : Phaser.Display.Color.HexStringToColor(oPlayer.color).color;
    const otherPlayer = game.add.sprite(oPlayer.x, oPlayer.y, 'otherPlayer')
        .setOrigin(0.5, 0.5)
        .setDisplaySize(53, 40)
        .setTint(color);
    otherPlayer.playerId = oPlayer.playerId;
    game.otherPlayers.add(otherPlayer);
    addPlayerGlow(otherPlayer, color);
}

function addPlayerGlow(player, color) {
    player.enableFilters();
    if (player.filters) {
        player.playerGlow = player.filters.internal.addGlow(color, 4, 2);
        player.playerGlow.setPaddingOverride(null);
    }
}
const { generateChallenge, fetchArticle } = require('./wikipedia');
const { calculateScore } = require('./scoring');
const seedArticles = require('./seedArticles');

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room object
  }

  generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(hostNickname, hostSocketId, settings = {}) {
    const code = this.generateRoomCode();
    const hostId = `player_${Math.random().toString(36).substring(2, 9)}`;

    const room = {
      code,
      hostId,
      state: 'LOBBY', // LOBBY, ROUND_INTRO, COUNTDOWN, PLAYING, ROUND_RESULTS, FINAL_RESULTS
      currentRound: 1,
      settings: {
        rounds: settings.rounds || 3,
        timeLimit: settings.timeLimit || 45 // in seconds
      },
      players: [
        {
          id: hostId,
          nickname: hostNickname,
          joinOrder: 1,
          connected: true,
          socketId: hostSocketId,
          score: 0,
          currentPage: '',
          currentClicks: 0,
          roundResults: {} // roundNumber -> { status, clicks, time, score }
        }
      ],
      currentChallenge: null,
      roundStartTime: null,
      timerId: null,
      introTimerId: null,
      countdownTimerId: null
    };

    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    if (!code) return null;
    return this.rooms.get(code.toUpperCase());
  }

  joinRoom(code, nickname, socketId) {
    const room = this.getRoom(code);
    if (!room) {
      return { error: 'Room does not exist' };
    }

    if (room.state !== 'LOBBY') {
      return { error: 'Game has already started' };
    }

    if (room.players.length >= 7) {
      return { error: 'Room is full (max 7 players)' };
    }

    // Sanitize and validate nickname
    const sanitizedNickname = nickname ? nickname.trim() : '';
    if (!sanitizedNickname) {
      return { error: 'Nickname cannot be empty' };
    }

    if (sanitizedNickname.length > 15) {
      return { error: 'Nickname must be 15 characters or less' };
    }

    const nicknameExists = room.players.some(
      p => p.nickname.toLowerCase() === sanitizedNickname.toLowerCase()
    );

    if (nicknameExists) {
      return { error: 'Nickname is already taken in this room' };
    }

    const playerId = `player_${Math.random().toString(36).substring(2, 9)}`;
    const joinOrder = room.players.length > 0 
      ? Math.max(...room.players.map(p => p.joinOrder)) + 1 
      : 1;

    const newPlayer = {
      id: playerId,
      nickname: sanitizedNickname,
      joinOrder,
      connected: true,
      socketId,
      score: 0,
      currentPage: '',
      currentClicks: 0,
      roundResults: {}
    };

    room.players.push(newPlayer);
    return { room, player: newPlayer };
  }

  handleDisconnect(socketId) {
    let affectedRoom = null;
    let disconnectedPlayer = null;

    for (const [code, room] of this.rooms.entries()) {
      const player = room.players.find(p => p.socketId === socketId);
      if (player) {
        player.connected = false;
        disconnectedPlayer = player;
        affectedRoom = room;
        
        console.log(`Player ${player.nickname} disconnected from room ${code}`);

        // If in Lobby, we can remove them immediately.
        // If the game has started, we keep them so they can reconnect.
        if (room.state === 'LOBBY') {
          room.players = room.players.filter(p => p.id !== player.id);
        }

        // Host migration if host disconnected
        if (room.hostId === player.id && room.players.length > 0) {
          this.migrateHost(room);
        }

        // Cleanup empty room
        const activePlayersCount = room.players.filter(p => p.connected).length;
        if (room.players.length === 0 || (room.state === 'LOBBY' && room.players.length === 0)) {
          this.clearRoomTimers(room);
          this.rooms.delete(code);
          console.log(`Deleted empty room ${code}`);
        }

        break;
      }
    }

    return { room: affectedRoom, player: disconnectedPlayer };
  }

  migrateHost(room) {
    // Find next eligible player based on join order who is currently connected
    const eligiblePlayers = room.players
      .filter(p => p.connected)
      .sort((a, b) => a.joinOrder - b.joinOrder);

    if (eligiblePlayers.length > 0) {
      const newHost = eligiblePlayers[0];
      room.hostId = newHost.id;
      console.log(`Promoted ${newHost.nickname} to host in room ${room.code}`);
      return newHost;
    }

    // If no connected players, promote the first disconnected player in join order just in case they reconnect
    const disconnectedEligible = room.players
      .sort((a, b) => a.joinOrder - b.joinOrder);

    if (disconnectedEligible.length > 0) {
      room.hostId = disconnectedEligible[0].id;
      return disconnectedEligible[0];
    }

    return null;
  }

  handleReconnect(code, nickname, socketId) {
    const room = this.getRoom(code);
    if (!room) return { error: 'Room does not exist' };

    const player = room.players.find(
      p => p.nickname.toLowerCase() === nickname.toLowerCase()
    );

    if (!player) {
      return { error: 'Player not found in this room' };
    }

    // Re-link player connection
    player.connected = true;
    player.socketId = socketId;

    console.log(`Player ${player.nickname} reconnected to room ${room.code}`);

    // If this player was host and we migrated, they don't automatically get host back unless they are the only connected player or we want to keep the migrated host.
    // Keeping the migrated host is standard to avoid shifting privileges back and forth.
    
    return { room, player };
  }

  clearRoomTimers(room) {
    if (room.timerId) {
      clearTimeout(room.timerId);
      room.timerId = null;
    }
    if (room.introTimerId) {
      clearTimeout(room.introTimerId);
      room.introTimerId = null;
    }
    if (room.countdownTimerId) {
      clearTimeout(room.countdownTimerId);
      room.countdownTimerId = null;
    }
  }

  async startRound(code, io) {
    const room = this.getRoom(code);
    if (!room) return;

    if (room.players.length < 2) {
      io.to(room.code).emit('error', 'Cannot start game with fewer than 2 players');
      return;
    }

    this.clearRoomTimers(room);

    try {
      // 1. Generate challenge
      const challenge = await generateChallenge(seedArticles);
      room.currentChallenge = challenge;

      // Reset players' round settings
      room.players.forEach(p => {
        p.currentPage = challenge.start;
        p.currentClicks = 0;
      });

      // Fetch the starting article to warm up cache
      await fetchArticle(challenge.start);

      // Transition to ROUND_INTRO
      room.state = 'ROUND_INTRO';
      io.to(room.code).emit('state_update', {
        state: room.state,
        currentRound: room.currentRound,
        currentChallenge: {
          start: challenge.start,
          target: challenge.target
        },
        players: this.getPlayerSummary(room)
      });

      // 2. Wait 3 seconds for Intro, then transition to COUNTDOWN
      room.introTimerId = setTimeout(() => {
        this.startCountdown(room, io);
      }, 3000);

    } catch (err) {
      console.error("Failed to start round due to challenge generation error:", err);
      io.to(room.code).emit('error', 'Failed to generate Wikipedia challenge. Please try again.');
    }
  }

  startCountdown(room, io) {
    room.state = 'COUNTDOWN';
    io.to(room.code).emit('state_update', {
      state: room.state,
      players: this.getPlayerSummary(room)
    });

    let count = 3;
    const countdownInterval = () => {
      if (count > 0) {
        io.to(room.code).emit('countdown', count);
        count--;
        room.countdownTimerId = setTimeout(countdownInterval, 1000);
      } else {
        io.to(room.code).emit('countdown', 'GO!');
        room.countdownTimerId = setTimeout(() => {
          this.beginGameplay(room, io);
        }, 800); // Small delay after "GO!" before full gameplay starts
      }
    };

    countdownInterval();
  }

  beginGameplay(room, io) {
    room.state = 'PLAYING';
    room.roundStartTime = Date.now();
    
    // Broadcast state update
    io.to(room.code).emit('state_update', {
      state: room.state,
      roundStartTime: room.roundStartTime,
      timeLimit: room.settings.timeLimit,
      players: this.getPlayerSummary(room)
    });

    // Fetch and send the initial page to each connected player
    room.players.forEach(async (p) => {
      if (p.connected) {
        try {
          const article = await fetchArticle(room.currentChallenge.start);
          io.to(p.socketId).emit('article_content', {
            title: article.title,
            html: article.html,
            clicks: 0
          });
        } catch (err) {
          io.to(p.socketId).emit('error', 'Error loading Wikipedia content');
        }
      }
    });

    // Authoritative end round timer
    room.timerId = setTimeout(() => {
      this.endRound(room, io);
    }, room.settings.timeLimit * 1000);
  }

  async handleNavigate(socketId, targetTitle, io) {
    let affectedRoom = null;
    let player = null;

    for (const room of this.rooms.values()) {
      player = room.players.find(p => p.socketId === socketId);
      if (player) {
        affectedRoom = room;
        break;
      }
    }

    if (!affectedRoom || affectedRoom.state !== 'PLAYING' || !player) {
      return;
    }

    const roundNum = affectedRoom.currentRound;
    // Check if player has already finished
    if (player.roundResults[roundNum]) {
      return;
    }

    const currentArt = await fetchArticle(player.currentPage);
    
    // Verify targetTitle is in the links of the current page (Anti-Cheat!)
    const targetNorm = targetTitle.trim().replace(/ /g, '_');
    const isValidTransition = currentArt.links.some(
      link => link.toLowerCase() === targetNorm.toLowerCase()
    );

    if (!isValidTransition) {
      console.warn(`Cheating attempt detected? Player ${player.nickname} tried invalid transition: ${player.currentPage} -> ${targetTitle}`);
      io.to(player.socketId).emit('error', 'Invalid page transition. Click count not updated.');
      return;
    }

    // Fetch target article
    try {
      const targetArt = await fetchArticle(targetTitle);
      player.currentPage = targetArt.title;
      player.currentClicks += 1;

      // Send the article content to the player
      io.to(player.socketId).emit('article_content', {
        title: targetArt.title,
        html: targetArt.html,
        clicks: player.currentClicks
      });

      // Check if target reached
      const targetCanonical = affectedRoom.currentChallenge.target.toLowerCase().replace(/_/g, ' ');
      const currentCanonical = targetArt.title.toLowerCase().replace(/_/g, ' ');

      if (currentCanonical === targetCanonical) {
        // Player finished!
        const timeTaken = (Date.now() - affectedRoom.roundStartTime) / 1000;
        const score = calculateScore(timeTaken, affectedRoom.settings.timeLimit, player.currentClicks);

        player.roundResults[roundNum] = {
          status: 'FINISHED',
          clicks: player.currentClicks,
          time: parseFloat(timeTaken.toFixed(1)),
          score
        };
        player.score += score;

        console.log(`Player ${player.nickname} finished in ${timeTaken}s with ${player.currentClicks} clicks! Score: ${score}`);
        
        io.to(player.socketId).emit('round_finished', player.roundResults[roundNum]);
        
        // Notify others that this player finished (without disclosing clicks/time)
        io.to(affectedRoom.code).emit('player_finished_status', {
          id: player.id,
          nickname: player.nickname,
          status: 'FINISHED'
        });

        // Check if all players finished
        this.checkAllPlayersCompleted(affectedRoom, io);
      }
    } catch (err) {
      console.error(`Failed to navigate player ${player.nickname} to ${targetTitle}:`, err.message);
      io.to(player.socketId).emit('error', 'Failed to load Wikipedia page.');
    }
  }

  handleGiveUp(socketId, io) {
    let affectedRoom = null;
    let player = null;

    for (const room of this.rooms.values()) {
      player = room.players.find(p => p.socketId === socketId);
      if (player) {
        affectedRoom = room;
        break;
      }
    }

    if (!affectedRoom || affectedRoom.state !== 'PLAYING' || !player) {
      return;
    }

    const roundNum = affectedRoom.currentRound;
    if (player.roundResults[roundNum]) {
      return;
    }

    player.roundResults[roundNum] = {
      status: 'GAVE_UP',
      clicks: player.currentClicks,
      time: null,
      score: 0
    };

    console.log(`Player ${player.nickname} gave up on round ${roundNum}`);

    io.to(player.socketId).emit('round_finished', player.roundResults[roundNum]);

    io.to(affectedRoom.code).emit('player_finished_status', {
      id: player.id,
      nickname: player.nickname,
      status: 'GAVE_UP'
    });

    this.checkAllPlayersCompleted(affectedRoom, io);
  }

  checkAllPlayersCompleted(room, io) {
    const roundNum = room.currentRound;
    // Check if every player has a result (or is disconnected)
    const allCompleted = room.players.every(p => {
      // If a player is disconnected, they don't block the game from proceeding
      return !p.connected || p.roundResults[roundNum] !== undefined;
    });

    if (allCompleted) {
      this.clearRoomTimers(room);
      this.endRound(room, io);
    }
  }

  endRound(room, io) {
    this.clearRoomTimers(room);
    const roundNum = room.currentRound;

    // Timeout remaining active players
    room.players.forEach(p => {
      if (!p.roundResults[roundNum]) {
        p.roundResults[roundNum] = {
          status: 'TIMEOUT',
          clicks: p.currentClicks,
          time: null,
          score: 0
        };
      }
    });

    room.state = 'ROUND_RESULTS';

    // Broadcast update
    io.to(room.code).emit('state_update', {
      state: room.state,
      players: this.getPlayerSummary(room),
      roundResults: this.getRoundResultsSummary(room, roundNum)
    });
  }

  nextRound(code, io) {
    const room = this.getRoom(code);
    if (!room || room.state !== 'ROUND_RESULTS') return;

    if (room.currentRound >= room.settings.rounds) {
      // Game ended completely!
      room.state = 'FINAL_RESULTS';
      io.to(room.code).emit('state_update', {
        state: room.state,
        players: this.getPlayerSummary(room),
        finalStats: this.getFinalStatsSummary(room)
      });
    } else {
      room.currentRound += 1;
      this.startRound(room.code, io);
    }
  }

  resetRoom(code, io) {
    const room = this.getRoom(code);
    if (!room) return;

    this.clearRoomTimers(room);
    room.state = 'LOBBY';
    room.currentRound = 1;
    room.currentChallenge = null;
    room.roundStartTime = null;

    room.players.forEach(p => {
      p.score = 0;
      p.currentPage = '';
      p.currentClicks = 0;
      p.roundResults = {};
    });

    io.to(room.code).emit('state_update', {
      state: room.state,
      players: this.getPlayerSummary(room),
      settings: room.settings,
      currentRound: room.currentRound
    });
  }

  getPlayerSummary(room) {
    return room.players.map(p => ({
      id: p.id,
      nickname: p.nickname,
      connected: p.connected,
      score: p.score,
      isHost: room.hostId === p.id,
      // Provide round results for this round if finished
      roundResult: p.roundResults[room.currentRound] || null
    }));
  }

  getRoundResultsSummary(room, roundNum) {
    return room.players.map(p => {
      const result = p.roundResults[roundNum] || { status: 'TIMEOUT', score: 0, clicks: 0, time: null };
      return {
        id: p.id,
        nickname: p.nickname,
        status: result.status,
        clicks: result.clicks,
        time: result.time,
        score: result.score
      };
    }).sort((a, b) => b.score - a.score);
  }

  getFinalStatsSummary(room) {
    const totalRounds = room.settings.rounds;

    return room.players.map(p => {
      let totalClicks = 0;
      let totalTime = 0;
      let finishedRoundsCount = 0;
      let giveUps = 0;
      let timeOuts = 0;

      for (let r = 1; r <= totalRounds; r++) {
        const res = p.roundResults[r];
        if (res) {
          totalClicks += res.clicks;
          if (res.status === 'FINISHED') {
            totalTime += res.time;
            finishedRoundsCount++;
          } else if (res.status === 'GAVE_UP') {
            giveUps++;
          } else if (res.status === 'TIMEOUT') {
            timeOuts++;
          }
        }
      }

      const avgTime = finishedRoundsCount > 0 ? parseFloat((totalTime / finishedRoundsCount).toFixed(1)) : null;

      return {
        id: p.id,
        nickname: p.nickname,
        totalScore: p.score,
        totalClicks,
        avgTime,
        roundsCompleted: finishedRoundsCount,
        giveUps,
        timeOuts
      };
    }).sort((a, b) => b.totalScore - a.totalScore);
  }
}

module.exports = RoomManager;

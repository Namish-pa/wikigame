require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const RoomManager = require('./game');
const { fetchArticle } = require('./wikipedia');

const app = express();
const port = process.env.PORT || 5000;

// Enable CORS for Vite dev server (usually localhost:5173 or similar)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));

app.use(express.json());

// API route to get current page content (can be used as fallback or verification)
app.get('/api/wiki/page', async (req, res) => {
  const { title } = req.query;
  if (!title) {
    return res.status(400).json({ error: 'Title parameter is required' });
  }
  try {
    const article = await fetchArticle(title);
    res.json(article);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Wikipedia article' });
  }
});

// Serve frontend assets in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const roomManager = new RoomManager();

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // 1. Create Room
  socket.on('create_room', ({ nickname, settings }) => {
    try {
      const room = roomManager.createRoom(nickname, socket.id, settings);
      socket.join(room.code);

      console.log(`Room created: ${room.code} by ${nickname}`);

      socket.emit('room_joined', {
        roomCode: room.code,
        playerId: room.hostId,
        isHost: true,
        roomState: room
      });
    } catch (err) {
      console.error("Error creating room:", err);
      socket.emit('error', 'Failed to create room. Please try again.');
    }
  });

  // 2. Join Room
  socket.on('join_room', ({ roomCode, nickname }) => {
    try {
      const code = roomCode ? roomCode.toUpperCase().trim() : '';
      const result = roomManager.joinRoom(code, nickname, socket.id);

      if (result.error) {
        return socket.emit('error', result.error);
      }

      const { room, player } = result;
      socket.join(room.code);

      console.log(`Player ${nickname} joined room ${room.code}`);

      socket.emit('room_joined', {
        roomCode: room.code,
        playerId: player.id,
        isHost: false,
        roomState: room
      });

      // Broadcast update to all clients in the room
      io.to(room.code).emit('state_update', {
        state: room.state,
        players: roomManager.getPlayerSummary(room)
      });
    } catch (err) {
      console.error("Error joining room:", err);
      socket.emit('error', 'Failed to join room.');
    }
  });

  // 3. Reconnect
  socket.on('reconnect_player', ({ roomCode, nickname }) => {
    try {
      const code = roomCode ? roomCode.toUpperCase().trim() : '';
      const result = roomManager.handleReconnect(code, nickname, socket.id);

      if (result.error) {
        return socket.emit('error', result.error);
      }

      const { room, player } = result;
      socket.join(room.code);

      socket.emit('room_joined', {
        roomCode: room.code,
        playerId: player.id,
        isHost: room.hostId === player.id,
        roomState: room
      });

      // Send the current gameplay page back to the reconnected player if game is running
      if (room.state === 'PLAYING') {
        fetchArticle(player.currentPage)
          .then(article => {
            socket.emit('article_content', {
              title: article.title,
              html: article.html,
              clicks: player.currentClicks
            });
          })
          .catch(() => {
            socket.emit('error', 'Failed to reload Wikipedia content.');
          });
      }

      // Broadcast update
      io.to(room.code).emit('state_update', {
        state: room.state,
        players: roomManager.getPlayerSummary(room),
        currentRound: room.currentRound,
        currentChallenge: room.currentChallenge ? {
          start: room.currentChallenge.start,
          target: room.currentChallenge.target
        } : null,
        roundStartTime: room.roundStartTime,
        timeLimit: room.settings.timeLimit
      });
    } catch (err) {
      console.error("Error reconnecting:", err);
      socket.emit('error', 'Failed to reconnect.');
    }
  });

  // 4. Start Game (Host only)
  socket.on('start_game', ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) return socket.emit('error', 'Room not found');

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || room.hostId !== player.id) {
      return socket.emit('error', 'Only the host can start the game');
    }

    roomManager.startRound(room.code, io);
  });

  // 5. Navigation Event (Wiki Link Clicked)
  socket.on('navigate', ({ targetTitle }) => {
    roomManager.handleNavigate(socket.id, targetTitle, io);
  });

  // 6. Give Up
  socket.on('give_up', () => {
    roomManager.handleGiveUp(socket.id, io);
  });

  // 7. Next Round (Host only)
  socket.on('next_round', ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) return socket.emit('error', 'Room not found');

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || room.hostId !== player.id) {
      return socket.emit('error', 'Only the host can proceed');
    }

    roomManager.nextRound(room.code, io);
  });

  // 8. Return to Lobby / Play Again (Host only)
  socket.on('play_again', ({ roomCode }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) return socket.emit('error', 'Room not found');

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || room.hostId !== player.id) {
      return socket.emit('error', 'Only the host can reset the game');
    }

    roomManager.resetRoom(room.code, io);
  });

  // 9. Disconnect
  socket.on('disconnect', () => {
    const { room, player } = roomManager.handleDisconnect(socket.id);
    if (room) {
      // Notify other players
      io.to(room.code).emit('state_update', {
        state: room.state,
        players: roomManager.getPlayerSummary(room)
      });
      io.to(room.code).emit('player_disconnected_status', {
        id: player ? player.id : null,
        nickname: player ? player.nickname : '',
        hostId: room.hostId
      });
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

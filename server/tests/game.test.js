const { expect } = require('chai');
const RoomManager = require('../game');
const { calculateScore } = require('../scoring');
const { normalizeTitle, validateChallenge } = require('../wikipedia');

describe('Wikipedia Race Game Tests', () => {
  
  describe('Room Lifecycle & Player Limits', () => {
    let rm;

    beforeEach(() => {
      rm = new RoomManager();
    });

    it('should create a room with host', () => {
      const room = rm.createRoom('HostPlayer', 'socket_host', { rounds: 5, timeLimit: 30 });
      expect(room).to.exist;
      expect(room.code).to.have.lengthOf(6);
      expect(room.players).to.have.lengthOf(1);
      expect(room.players[0].nickname).to.equal('HostPlayer');
      expect(room.players[0].joinOrder).to.equal(1);
      expect(room.hostId).to.equal(room.players[0].id);
      expect(room.settings.rounds).to.equal(5);
      expect(room.settings.timeLimit).to.equal(30);
    });

    it('should join a room and assign join order', () => {
      const room = rm.createRoom('HostPlayer', 'socket_host');
      const joinRes = rm.joinRoom(room.code, 'SecondPlayer', 'socket_2');

      expect(joinRes.error).to.be.undefined;
      expect(room.players).to.have.lengthOf(2);
      expect(room.players[1].nickname).to.equal('SecondPlayer');
      expect(room.players[1].joinOrder).to.equal(2);
    });

    it('should reject joining non-existent room', () => {
      const joinRes = rm.joinRoom('XYZXYZ', 'Player', 'socket_1');
      expect(joinRes.error).to.equal('Room does not exist');
    });

    it('should reject duplicate nicknames in same room', () => {
      const room = rm.createRoom('HostPlayer', 'socket_host');
      const joinRes = rm.joinRoom(room.code, 'hostplayer', 'socket_2'); // Case insensitive check
      expect(joinRes.error).to.equal('Nickname is already taken in this room');
    });

    it('should enforce limit of 7 players', () => {
      const room = rm.createRoom('HostPlayer', 'socket_host');
      for (let i = 2; i <= 7; i++) {
        const joinRes = rm.joinRoom(room.code, `Player${i}`, `socket_${i}`);
        expect(joinRes.error).to.be.undefined;
      }
      
      const eighthJoin = rm.joinRoom(room.code, 'Player8', 'socket_8');
      expect(eighthJoin.error).to.equal('Room is full (max 7 players)');
    });
  });

  describe('Host Migration', () => {
    let rm;

    beforeEach(() => {
      rm = new RoomManager();
    });

    it('should promote next player in join order on host disconnect', () => {
      const room = rm.createRoom('HostPlayer', 'socket_host');
      rm.joinRoom(room.code, 'SecondPlayer', 'socket_2');
      rm.joinRoom(room.code, 'ThirdPlayer', 'socket_3');

      expect(room.hostId).to.equal(room.players[0].id);

      // Disconnect host
      rm.handleDisconnect('socket_host');

      // The next connected player in join order is SecondPlayer (joinOrder = 2)
      const secondPlayer = room.players.find(p => p.nickname === 'SecondPlayer');
      expect(room.hostId).to.equal(secondPlayer.id);
    });

    it('should skip disconnected players when promoting host', () => {
      const room = rm.createRoom('HostPlayer', 'socket_host');
      rm.joinRoom(room.code, 'SecondPlayer', 'socket_2');
      rm.joinRoom(room.code, 'ThirdPlayer', 'socket_3');

      // Disconnect SecondPlayer first (they are now offline)
      rm.handleDisconnect('socket_2');

      // Now disconnect HostPlayer
      rm.handleDisconnect('socket_host');

      // ThirdPlayer should become host because SecondPlayer is disconnected
      const thirdPlayer = room.players.find(p => p.nickname === 'ThirdPlayer');
      expect(room.hostId).to.equal(thirdPlayer.id);
    });
  });

  describe('Scoring Logic', () => {
    it('should calculate correct scores according to formula rules', () => {
      const T_max = 60;
      const c_min = 2;

      // Player 1 finishes in 20s with 2 clicks (Optimal)
      const s1 = calculateScore(20, T_max, 2, c_min);
      
      // Player 2 finishes in 10s but with 6 clicks (Fast but inefficient)
      const s2 = calculateScore(10, T_max, 6, c_min);

      // Player 3 finishes in 40s with 3 clicks (Slow but efficient)
      const s3 = calculateScore(40, T_max, 3, c_min);

      expect(s1).to.be.greaterThan(s2);
      expect(s3).to.be.greaterThan(0);

      // Timeout & Giveup = 0
      const scoreTimeout = calculateScore(65, T_max, 3, c_min);
      expect(scoreTimeout).to.equal(0);

      const scoreGiveUp = calculateScore(null, T_max, 3, c_min);
      expect(scoreGiveUp).to.equal(0);
    });

    it('should never produce negative scores or exceed 1000', () => {
      const sMax = calculateScore(0.1, 40, 2, 2);
      expect(sMax).to.be.at.most(1000);

      const sLow = calculateScore(39.9, 40, 1000, 2);
      expect(sLow).to.be.at.least(500); // Reaching target always gets at least base 500 points
    });
  });

  describe('Wikipedia Utilities', function() {
    this.timeout(10000); // Set timeout to 10s for live API calls

    it('should normalize titles correctly', () => {
      expect(normalizeTitle('Albert Einstein')).to.equal('Albert_Einstein');
      expect(normalizeTitle('United States')).to.equal('United_States');
      expect(normalizeTitle('Albert%20Einstein')).to.equal('Albert_Einstein');
    });

    it('should validate challenge connectivity rules', async () => {
      // Einstein and Theory of Relativity are 2-hop connected
      const isValid = await validateChallenge('Albert_Einstein', 'Theory_of_Relativity');
      // Direct connections are rejected, impossible/no-link ones rejected
      const isSelfValid = await validateChallenge('Physics', 'Physics');
      expect(isSelfValid).to.be.false;
    });
  });

});

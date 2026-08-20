import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

let socket;

function App() {
  // Connection / Identity State
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [roomCode, setRoomCode] = useState(null);
  const [nickname, setNickname] = useState('');
  const [roomState, setRoomState] = useState(null);

  // Form State
  const [inputNickname, setInputNickname] = useState('');
  const [inputRoomCode, setInputRoomCode] = useState('');
  const [screen, setScreen] = useState('HOME'); // HOME, CREATE_GAME, JOIN_GAME, LOBBY, ROUND_INTRO, COUNTDOWN, PLAYING, ROUND_RESULTS, FINAL_RESULTS
  const [numRounds, setNumRounds] = useState(3);
  const [timeLimit, setTimeLimit] = useState(45);
  
  // Game Play State
  const [articleTitle, setArticleTitle] = useState('');
  const [articleHtml, setArticleHtml] = useState('');
  const [clicks, setClicks] = useState(0);
  const [countdownVal, setCountdownVal] = useState('');
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [finishedResult, setFinishedResult] = useState(null);
  const [hasFinishedCurrentRound, setHasFinishedCurrentRound] = useState(false);
  
  // UI States
  const [errorMsg, setErrorMsg] = useState('');
  const [showGiveUpConfirm, setShowGiveUpConfirm] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [notifications, setNotifications] = useState([]);

  const wikiViewportRef = useRef(null);

  // Initialize Socket Connection
  useEffect(() => {
    // In production, socket connects to the same origin host. In development, it proxies via Vite.
    socket = io();

    socket.on('connect', () => {
      setConnected(true);
      setErrorMsg('');
      
      // Try to recover session if disconnected
      const savedCode = sessionStorage.getItem('wiki_race_room_code');
      const savedNickname = sessionStorage.getItem('wiki_race_nickname');
      if (savedCode && savedNickname) {
        socket.emit('reconnect_player', { roomCode: savedCode, nickname: savedNickname });
      }
    });

    socket.on('disconnect', () => {
      setConnected(false);
      addNotification('Disconnected from server. Attempting to reconnect...');
    });

    // Handle session success
    socket.on('room_joined', ({ roomCode, playerId, isHost, roomState }) => {
      setRoomCode(roomCode);
      setPlayerId(playerId);
      setIsHost(isHost);
      setRoomState(roomState);
      setScreen(roomState.state);
      setNickname(roomState.players.find(p => p.id === playerId)?.nickname || '');

      // Store session for reconnections
      sessionStorage.setItem('wiki_race_room_code', roomCode);
      sessionStorage.setItem('wiki_race_nickname', roomState.players.find(p => p.id === playerId)?.nickname || '');

      if (roomState.state === 'PLAYING') {
        const roundNum = roomState.currentRound;
        const player = roomState.players.find(p => p.id === playerId);
        const result = player?.roundResult; // check if already finished/gave up/timed out in this round
        if (result) {
          setFinishedResult(result);
          setHasFinishedCurrentRound(true);
        } else {
          setHasFinishedCurrentRound(false);
          setFinishedResult(null);
        }
      }
    });

    // Real-time state machine sync
    socket.on('state_update', (updatedState) => {
      setRoomState(prev => {
        const newState = { ...prev, ...updatedState };
        setScreen(newState.state);

        // Update Host status
        const me = newState.players.find(p => p.id === playerId);
        if (me) {
          setIsHost(newState.hostId === playerId);
        }

        // Reset round state variables when transition to new round
        if (newState.state === 'ROUND_INTRO') {
          setArticleTitle('');
          setArticleHtml('');
          setClicks(0);
          setCountdownVal('');
          setHasFinishedCurrentRound(false);
          setFinishedResult(null);
        }

        return newState;
      });
    });

    socket.on('countdown', (val) => {
      setCountdownVal(val);
    });

    // Authoritative content distribution
    socket.on('article_content', ({ title, html, clicks }) => {
      setArticleTitle(title);
      setArticleHtml(html);
      setClicks(clicks);
      
      // Scroll article container to top
      if (wikiViewportRef.current) {
        wikiViewportRef.current.scrollTop = 0;
      }
    });

    socket.on('round_finished', (result) => {
      setFinishedResult(result);
      setHasFinishedCurrentRound(true);
    });

    socket.on('player_finished_status', ({ nickname, status }) => {
      addNotification(`${nickname} is ${status.toLowerCase()}!`);
    });

    socket.on('player_disconnected_status', ({ nickname, hostId }) => {
      addNotification(`${nickname} disconnected.`);
      if (hostId === playerId) {
        setIsHost(true);
        addNotification(`You have been promoted to Host!`);
      }
    });

    socket.on('error', (msg) => {
      setErrorMsg(msg);
      // Automatically clear error after 5s
      setTimeout(() => setErrorMsg(''), 5000);
    });

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('room_joined');
      socket.off('state_update');
      socket.off('countdown');
      socket.off('article_content');
      socket.off('round_finished');
      socket.off('player_finished_status');
      socket.off('player_disconnected_status');
      socket.off('error');
    };
  }, [playerId]);

  // Synchronized Gameplay Timer Loop
  useEffect(() => {
    if (screen !== 'PLAYING' || !roomState?.roundStartTime) return;

    const interval = setInterval(() => {
      const start = roomState.roundStartTime;
      const limit = roomState.timeLimit;
      const elapsed = (Date.now() - start) / 1000;
      const remaining = Math.max(0, limit - elapsed);

      setTimeRemaining(parseFloat(remaining.toFixed(1)));

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [screen, roomState]);

  // Notifications helper
  const addNotification = (text) => {
    const id = Math.random().toString(36).substring(2, 9);
    setNotifications(prev => [...prev, { id, text }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  };

  // Actions
  const handleCreateRoom = (e) => {
    e.preventDefault();
    if (!inputNickname.trim()) return setErrorMsg('Nickname is required');
    socket.emit('create_room', {
      nickname: inputNickname.trim(),
      settings: {
        rounds: numRounds,
        timeLimit: timeLimit
      }
    });
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (!inputNickname.trim()) return setErrorMsg('Nickname is required');
    if (!inputRoomCode.trim()) return setErrorMsg('Room Code is required');
    socket.emit('join_room', {
      roomCode: inputRoomCode.trim(),
      nickname: inputNickname.trim()
    });
  };

  const handleStartGame = () => {
    if (roomState.players.length < 2) {
      return setErrorMsg('Cannot start game with fewer than 2 players');
    }
    socket.emit('start_game', { roomCode });
  };

  const handleArticleClick = (e) => {
    // Intercept clicks on links that are rewritten as data-wiki-link
    const anchor = e.target.closest('a[data-wiki-link]');
    if (anchor) {
      e.preventDefault();
      const targetTitle = anchor.getAttribute('data-wiki-link');
      if (targetTitle && !hasFinishedCurrentRound) {
        socket.emit('navigate', { targetTitle });
      }
    }
  };

  const handleGiveUpSubmit = () => {
    socket.emit('give_up');
    setShowGiveUpConfirm(false);
  };

  const handleNextRound = () => {
    socket.emit('next_round', { roomCode });
  };

  const handlePlayAgain = () => {
    socket.emit('play_again', { roomCode });
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(roomCode);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  const leaveRoom = () => {
    sessionStorage.removeItem('wiki_race_room_code');
    sessionStorage.removeItem('wiki_race_nickname');
    window.location.reload();
  };

  // Render Screens
  return (
    <>
      <header>
        <div className="logo" onClick={leaveRoom} style={{ cursor: 'pointer' }}>
          <img src="https://upload.wikimedia.org/wikipedia/en/8/80/Wikipedia-logo-v2.svg" alt="Wiki Logo" />
          <span>Wiki <span className="text-gradient">Race</span></span>
        </div>
        {roomCode && (
          <div className="room-code-badge">
            <span className="setting-label">Room:</span>
            <div className="copy-tooltip-container" onClick={copyRoomCode}>
              <span className="room-code-value">{roomCode}</span>
              <span className="copy-tooltip-text">
                {copySuccess ? 'Copied!' : 'Click to copy'}
              </span>
            </div>
            <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }} onClick={leaveRoom}>
              Leave
            </button>
          </div>
        )}
      </header>

      {/* Floating System Notifications */}
      <div style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        pointerEvents: 'none'
      }}>
        {notifications.map(n => (
          <div key={n.id} className="animate-scale" style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            padding: '12px 20px',
            borderRadius: 'var(--border-radius-sm)',
            boxShadow: 'var(--shadow-md)',
            color: 'var(--text-primary)',
            fontSize: '14px',
            pointerEvents: 'auto'
          }}>
            {n.text}
          </div>
        ))}
      </div>

      {/* Error alert banner */}
      {errorMsg && (
        <div style={{
          background: 'var(--accent-rose)',
          color: 'white',
          padding: '12px 24px',
          textAlign: 'center',
          fontWeight: 700,
          position: 'sticky',
          top: '73px',
          zIndex: 99,
          boxShadow: 'var(--shadow-md)'
        }}>
          ⚠️ {errorMsg}
        </div>
      )}

      <main className="main-content">
        
        {/* SCREEN 1: HOME */}
        {screen === 'HOME' && (
          <div className="welcome-container animate-fade">
            <div>
              <h1 className="welcome-title">Wiki <span className="text-gradient">Race</span> Multiplayer</h1>
              <p className="welcome-subtitle">
                Race against friends in a real-time Wikipedia link-clicking challenge!
              </p>
            </div>

            <div className="card-action-row">
              <div className="glass-panel option-card" onClick={() => setScreen('CREATE_GAME')}>
                <div className="option-icon">👑</div>
                <h3>Create Game</h3>
                <p style={{ color: 'var(--text-secondary)', marginTop: '8px', fontSize: '14px' }}>
                  Host a room, configure rounds and limits, invite friends.
                </p>
              </div>

              <div className="glass-panel option-card" onClick={() => setScreen('JOIN_GAME')}>
                <div className="option-icon">⚔️</div>
                <h3>Join Game</h3>
                <p style={{ color: 'var(--text-secondary)', marginTop: '8px', fontSize: '14px' }}>
                  Enter room code, join the game instantly.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* SCREEN 2: CREATE GAME */}
        {screen === 'CREATE_GAME' && (
          <div className="glass-panel welcome-container animate-fade" style={{ maxWidth: '500px' }}>
            <h2 style={{ marginBottom: '24px', textAlign: 'center' }}>Game Settings</h2>
            <form onSubmit={handleCreateRoom}>
              <div className="input-group">
                <label className="input-label">Your Nickname</label>
                <input
                  type="text"
                  className="text-input"
                  placeholder="Enter a unique nickname..."
                  value={inputNickname}
                  onChange={(e) => setInputNickname(e.target.value)}
                  maxLength={15}
                  required
                />
              </div>

              <div className="slider-group">
                <div className="slider-header">
                  <span className="input-label">Number of Rounds</span>
                  <span className="slider-value">{numRounds} rounds</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={numRounds}
                  onChange={(e) => setNumRounds(parseInt(e.target.value))}
                />
              </div>

              <div className="slider-group">
                <div className="slider-header">
                  <span className="input-label">Round Time Limit</span>
                  <span className="slider-value">{timeLimit} seconds</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="70"
                  value={timeLimit}
                  onChange={(e) => setTimeLimit(parseInt(e.target.value))}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '30px' }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setScreen('HOME')}>
                  Back
                </button>
                <button type="submit" className="btn" style={{ flex: 2 }}>
                  Create Room
                </button>
              </div>
            </form>
          </div>
        )}

        {/* SCREEN 3: JOIN GAME */}
        {screen === 'JOIN_GAME' && (
          <div className="glass-panel welcome-container animate-fade" style={{ maxWidth: '450px' }}>
            <h2 style={{ marginBottom: '24px', textAlign: 'center' }}>Join Room</h2>
            <form onSubmit={handleJoinRoom}>
              <div className="input-group">
                <label className="input-label">Room Code</label>
                <input
                  type="text"
                  className="text-input"
                  placeholder="e.g. X7K4P2"
                  value={inputRoomCode}
                  onChange={(e) => setInputRoomCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  required
                  style={{ textTransform: 'uppercase', letterSpacing: '2px', textAlign: 'center', fontSize: '20px', fontWeight: 700 }}
                />
              </div>

              <div className="input-group">
                <label className="input-label">Your Nickname</label>
                <input
                  type="text"
                  className="text-input"
                  placeholder="Enter a unique nickname..."
                  value={inputNickname}
                  onChange={(e) => setInputNickname(e.target.value)}
                  maxLength={15}
                  required
                />
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '30px' }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setScreen('HOME')}>
                  Back
                </button>
                <button type="submit" className="btn btn-cyan" style={{ flex: 2 }}>
                  Join Game
                </button>
              </div>
            </form>
          </div>
        )}

        {/* SCREEN 4: LOBBY */}
        {screen === 'LOBBY' && roomState && (
          <div className="lobby-grid animate-fade">
            <div>
              <div className="lobby-header">
                <h2>Lobby Room</h2>
                <div style={{ color: 'var(--text-secondary)' }}>
                  Players: {roomState.players.length} / 7
                </div>
              </div>

              <div className="glass-panel players-card">
                <h3>Players Connected</h3>
                <div className="players-list">
                  {roomState.players.map((p, idx) => (
                    <div key={p.id} className="player-row">
                      <div className="player-info">
                        <div className="player-avatar">
                          {p.nickname.substring(0, 2).toUpperCase()}
                        </div>
                        <span style={{ fontWeight: 600 }}>{p.nickname}</span>
                        {roomState.hostId === p.id && <span className="host-badge">Host</span>}
                        {p.id === playerId && <span style={{ color: 'var(--accent-cyan)', fontSize: '14px' }}>(You)</span>}
                      </div>
                      <span className={`player-status-badge ${p.connected ? 'status-connected' : 'status-disconnected'}`}>
                        {p.connected ? 'Connected' : 'Offline'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div className="glass-panel settings-card">
                <h3>Match Rules</h3>
                
                <div className="setting-row">
                  <span className="setting-label">Total Rounds</span>
                  <span className="setting-value">{roomState.settings.rounds}</span>
                </div>

                <div className="setting-row">
                  <span className="setting-label">Time Limit / Round</span>
                  <span className="setting-value">{roomState.settings.timeLimit}s</span>
                </div>

                <div className="setting-row">
                  <span className="setting-label">Host Status</span>
                  <span className="setting-value">
                    {roomState.players.find(p => p.id === roomState.hostId)?.nickname || 'Migrating...'}
                  </span>
                </div>
              </div>

              {isHost ? (
                <button
                  className="btn"
                  style={{ width: '100%', height: '54px' }}
                  onClick={handleStartGame}
                  disabled={roomState.players.length < 2}
                >
                  Start Match
                </button>
              ) : (
                <div style={{
                  background: 'rgba(255, 255, 255, 0.02)',
                  border: '1px solid var(--border-color)',
                  padding: '16px',
                  borderRadius: 'var(--border-radius-sm)',
                  textAlign: 'center',
                  color: 'var(--text-secondary)',
                  fontSize: '14px'
                }}>
                  Waiting for Host to start...
                </div>
              )}
              {roomState.players.length < 2 && (
                <p style={{ color: 'var(--accent-amber)', fontSize: '13px', textAlign: 'center' }}>
                  ⚠️ Minimum 2 players required to start the race.
                </p>
              )}
            </div>
          </div>
        )}

        {/* SCREEN 5: ROUND INTRO */}
        {screen === 'ROUND_INTRO' && roomState && (
          <div className="intro-container animate-fade">
            <h2 className="intro-title">Round {roomState.currentRound} / {roomState.settings.rounds}</h2>
            
            <div className="challenge-flow">
              <div className="topic-box">
                <div className="topic-label">Starting Article</div>
                <div className="topic-name">{roomState.currentChallenge?.start.replace(/_/g, ' ')}</div>
              </div>

              <div className="flow-arrow">↓</div>

              <div className="topic-box" style={{ borderColor: 'var(--accent-cyan)' }}>
                <div className="topic-label" style={{ color: 'var(--accent-cyan)' }}>Target Article</div>
                <div className="topic-name" style={{ color: 'var(--accent-cyan)' }}>{roomState.currentChallenge?.target.replace(/_/g, ' ')}</div>
              </div>
            </div>
            <p style={{ color: 'var(--text-muted)' }}>Get ready! Navigating begins shortly...</p>
          </div>
        )}

        {/* SCREEN 6: COUNTDOWN */}
        {screen === 'COUNTDOWN' && (
          <div className="intro-container animate-fade">
            <div className="countdown-number">{countdownVal}</div>
          </div>
        )}

        {/* SCREEN 7: PLAYING */}
        {screen === 'PLAYING' && roomState && (
          <div className="game-container animate-fade">
            
            {/* GAME HUD PANEL */}
            <div className="game-hud">
              <div className="hud-panel">
                <span className="hud-label">Objective: Reach</span>
                <span className="hud-value target" title={roomState.currentChallenge?.target.replace(/_/g, ' ')}>
                  🎯 {roomState.currentChallenge?.target.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="hud-panel">
                <span className="hud-label">Time Remaining</span>
                <span className={`hud-value ${timeRemaining <= 10 ? 'highlight' : ''}`} style={{ fontFamily: 'monospace' }}>
                  ⏳ {timeRemaining}s
                </span>
              </div>
              <div className="hud-panel">
                <span className="hud-label">Your Steps</span>
                <span className="hud-value" style={{ color: 'var(--accent-indigo)' }}>
                  🐾 {clicks} clicks
                </span>
              </div>
              <button className="btn btn-danger" onClick={() => setShowGiveUpConfirm(true)} disabled={hasFinishedCurrentRound}>
                Give Up
              </button>
            </div>

            {/* MAIN WIKIPEDIA VIEWPORT */}
            <div className="wiki-card">
              <div className="wiki-header">
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="hud-label">Current Wikipedia Page</span>
                  <span className="wiki-title">{articleTitle || 'Loading...'}</span>
                </div>
                <span className="hud-label" style={{ fontSize: '12px' }}>
                  Round {roomState.currentRound} / {roomState.settings.rounds}
                </span>
              </div>

              {hasFinishedCurrentRound ? (
                <div className="finished-waiting-card">
                  {finishedResult?.status === 'FINISHED' ? (
                    <>
                      <div className="success-icon">🏆</div>
                      <h2>Target Reached!</h2>
                      <p style={{ color: 'var(--text-secondary)', maxWidth: '400px', marginTop: '10px' }}>
                        You reached {roomState.currentChallenge?.target.replace(/_/g, ' ')} in {finishedResult.time}s with {finishedResult.clicks} clicks!
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="success-icon" style={{ color: 'var(--text-muted)', filter: 'none' }}>🏳️</div>
                      <h2>Gave Up</h2>
                      <p style={{ color: 'var(--text-muted)', marginTop: '10px' }}>
                        You surrendered this round. Waiting for other players to finish...
                      </p>
                    </>
                  )}
                  <div style={{ marginTop: '30px', background: 'rgba(255, 255, 255, 0.02)', padding: '20px', borderRadius: 'var(--border-radius-sm)', border: '1px solid var(--border-color)' }}>
                    <h4 style={{ marginBottom: '10px' }}>Race Status</h4>
                    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
                      {roomState.players.map(p => {
                        const hasRes = p.roundResult;
                        return (
                          <div key={p.id} style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{ color: hasRes ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>●</span>
                            <span>{p.nickname} ({hasRes ? 'Done' : 'Navigating'})</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  ref={wikiViewportRef}
                  className="wiki-viewport"
                  onClick={handleArticleClick}
                >
                  <div className="wiki-content" dangerouslySetInnerHTML={{ __html: articleHtml }} />
                </div>
              )}
            </div>

            {/* CONFIRMATION POPUP FOR GIVE UP */}
            {showGiveUpConfirm && (
              <div className="modal-overlay">
                <div className="modal-content animate-scale">
                  <h3 className="modal-title">Are you sure?</h3>
                  <p className="modal-text">
                    Giving up will award you 0 points for this round. You cannot resume playing this round.
                  </p>
                  <div className="modal-buttons">
                    <button className="btn btn-secondary" onClick={() => setShowGiveUpConfirm(false)}>
                      Resume Playing
                    </button>
                    <button className="btn btn-danger" onClick={handleGiveUpSubmit}>
                      Yes, Give Up
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

        {/* SCREEN 8: ROUND RESULTS */}
        {screen === 'ROUND_RESULTS' && roomState && (
          <div className="results-container animate-fade">
            <h2 className="results-title">Round {roomState.currentRound} Results</h2>
            
            <div className="glass-panel">
              <h3 style={{ marginBottom: '16px' }}>Round Rankings</h3>
              <table className="leaderboard-table">
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Player</th>
                    <th>Clicks</th>
                    <th>Time</th>
                    <th>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {roomState.roundResults?.map((r, index) => (
                    <tr key={r.id}>
                      <td>
                        <span className={`rank-badge ${index === 0 ? 'rank-first' : index === 1 ? 'rank-second' : index === 2 ? 'rank-third' : ''}`}>
                          {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : index + 1}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600 }}>{r.nickname}</span>
                        {r.id === playerId && <span style={{ color: 'var(--accent-cyan)', fontSize: '12px' }}> (You)</span>}
                      </td>
                      <td>{r.status === 'FINISHED' ? r.clicks : '—'}</td>
                      <td>{r.status === 'FINISHED' ? `${r.time}s` : '—'}</td>
                      <td>
                        <span className={`result-status-text ${r.status.toLowerCase()}`}>
                          {r.status === 'FINISHED' ? `+${r.score}` : r.status.replace(/_/g, ' ')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="glass-panel">
              <h3 style={{ marginBottom: '16px' }}>Overall Standings</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {roomState.players
                  .sort((a, b) => b.score - a.score)
                  .map((p, index) => (
                    <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px', background: 'rgba(255, 255, 255, 0.01)', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-sm)' }}>
                      <span style={{ fontWeight: 600 }}>
                        {index + 1}. {p.nickname} {p.id === playerId && '(You)'}
                      </span>
                      <span style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>{p.score} pts</span>
                    </div>
                  ))}
              </div>
            </div>

            {isHost && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '10px' }}>
                <button className="btn" style={{ width: '220px' }} onClick={handleNextRound}>
                  {roomState.currentRound >= roomState.settings.rounds ? 'Show Final Standings' : 'Next Round'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* SCREEN 9: FINAL RESULTS */}
        {screen === 'FINAL_RESULTS' && roomState && (
          <div className="results-container animate-fade">
            <h2 className="results-title">🏁 Match Final Standings</h2>

            {/* Winner Card */}
            {roomState.finalStats && roomState.finalStats.length > 0 && (
              <div className="final-winner-card animate-scale">
                <div className="winner-crown">👑</div>
                <div className="topic-label" style={{ color: 'var(--accent-amber)' }}>Grand Champion</div>
                <div className="winner-name">{roomState.finalStats[0].nickname}</div>
                <div style={{ fontSize: '20px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Total Score: <span style={{ color: 'var(--accent-cyan)' }}>{roomState.finalStats[0].totalScore} pts</span>
                </div>
              </div>
            )}

            <div className="glass-panel">
              <h3 style={{ marginBottom: '16px' }}>Complete Rankings & Stats</h3>
              <table className="leaderboard-table" style={{ fontSize: '14px' }}>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Player</th>
                    <th>Score</th>
                    <th>Total Clicks</th>
                    <th>Avg Time</th>
                    <th>D/O/T</th>
                  </tr>
                </thead>
                <tbody>
                  {roomState.finalStats?.map((s, idx) => (
                    <tr key={s.id}>
                      <td>
                        <span className={`rank-badge ${idx === 0 ? 'rank-first' : idx === 1 ? 'rank-second' : idx === 2 ? 'rank-third' : ''}`}>
                          {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : idx + 1}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontWeight: 600 }}>{s.nickname}</span>
                      </td>
                      <td style={{ color: 'var(--accent-cyan)', fontWeight: 700 }}>{s.totalScore}</td>
                      <td>{s.totalClicks}</td>
                      <td>{s.avgTime ? `${s.avgTime}s` : '—'}</td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                        {/* Done / Out / Timeout stats */}
                        <span style={{ color: 'var(--accent-emerald)' }}>{s.roundsCompleted}</span>/
                        <span style={{ color: 'var(--text-muted)' }}>{s.giveUps}</span>/
                        <span style={{ color: 'var(--accent-rose)' }}>{s.timeOuts}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'right' }}>
                *D/O/T: Rounds Completed / Give Ups / Timeouts
              </div>
            </div>

            <div className="actions-footer">
              <button className="btn btn-secondary" onClick={leaveRoom}>
                Exit to Home
              </button>
              {isHost && (
                <button className="btn btn-cyan" onClick={handlePlayAgain}>
                  Play Again
                </button>
              )}
            </div>
          </div>
        )}

      </main>
    </>
  );
}

export default App;

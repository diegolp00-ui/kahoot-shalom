const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Load questions
const questionsPath = path.join(__dirname, 'questions.json');
const ALL_QUESTIONS = JSON.parse(fs.readFileSync(questionsPath, 'utf-8'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Helper to detect local LAN IP for local testing
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Game Rooms storage (keyed by 6-digit PIN)
const rooms = new Map();
let activeDefaultPin = null;
let publicTunnelUrl = process.env.PUBLIC_URL || '';

function generatePin() {
  let pin;
  do {
    pin = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(pin));
  return pin;
}

function createRoom(mode = 'all') {
  const pin = generatePin();
  let selectedQuestions = [...ALL_QUESTIONS];
  if (mode === 'quick10') {
    // Balanced 10 questions across all categories
    const indices = [0, 1, 4, 6, 12, 13, 17, 20, 23, 27];
    selectedQuestions = indices.map(i => ALL_QUESTIONS[i]).filter(Boolean);
  } else if (mode === 'quick15') {
    const indices = [0, 1, 2, 4, 5, 6, 12, 13, 16, 17, 19, 20, 23, 27, 29];
    selectedQuestions = indices.map(i => ALL_QUESTIONS[i]).filter(Boolean);
  } else if (mode.startsWith('cat:')) {
    const catName = mode.slice(4);
    selectedQuestions = ALL_QUESTIONS.filter(q => q.category === catName);
  }

  const room = {
    pin,
    state: 'LOBBY', // LOBBY | QUESTION | RESULTS | LEADERBOARD | PODIUM
    mode,
    autoAdvance: true,
    autoTimer: null,
    autoCountdown: 0,
    questions: selectedQuestions,
    currentQuestionIndex: -1,
    questionStartTime: 0,
    timerInterval: null,
    timeRemaining: 0,
    players: new Map(), // playerId -> { id, socketId, name, dni, score, streak, correctCount, answers: {}, connected }
    currentAnswers: new Map(), // playerId -> { optionIndex, timeMs, pointsEarned, isCorrect }
    hostSocketId: null,
    createdAt: Date.now()
  };

  rooms.set(pin, room);
  activeDefaultPin = pin;
  return room;
}

function getSerializedPlayers(room) {
  return Array.from(room.players.values())
    .map(p => ({
      id: p.id,
      name: p.name,
      dni: p.dni || '',
      score: p.score,
      streak: p.streak,
      correctCount: p.correctCount,
      connected: p.connected,
      hasAnswered: room.currentAnswers.has(p.id)
    }))
    .sort((a, b) => b.score - a.score);
}

function broadcastRoomState(room) {
  const currentQ = room.currentQuestionIndex >= 0 && room.currentQuestionIndex < room.questions.length
    ? room.questions[room.currentQuestionIndex]
    : null;

  const answerCounts = [0, 0, 0, 0];
  if (room.state === 'RESULTS' && currentQ) {
    for (const ans of room.currentAnswers.values()) {
      if (ans.optionIndex >= 0 && ans.optionIndex < 4) {
        answerCounts[ans.optionIndex]++;
      }
    }
  }

  const payload = {
    pin: room.pin,
    state: room.state,
    mode: room.mode,
    autoAdvance: room.autoAdvance,
    autoCountdown: room.autoCountdown,
    totalQuestions: room.questions.length,
    currentQuestionIndex: room.currentQuestionIndex,
    timeRemaining: room.timeRemaining,
    players: getSerializedPlayers(room),
    answeredCount: room.currentAnswers.size,
    totalPlayers: room.players.size,
    question: currentQ ? {
      id: currentQ.id,
      category: currentQ.category,
      question: currentQ.question,
      options: currentQ.options,
      timeLimit: currentQ.timeLimit,
      ...(room.state === 'RESULTS' ? {
        correctIndex: currentQ.correctIndex,
        explanation: currentQ.explanation,
        answerCounts
      } : {})
    } : null
  };

  io.to(room.pin).emit('room:state', payload);
}

function clearAutoTimer(room) {
  if (room.autoTimer) {
    clearInterval(room.autoTimer);
    room.autoTimer = null;
  }
  room.autoCountdown = 0;
}

function scheduleAutoTransition(room, seconds, callback) {
  clearAutoTimer(room);
  if (!room.autoAdvance) return;
  room.autoCountdown = seconds;
  io.to(room.pin).emit('room:autoTick', { autoCountdown: room.autoCountdown, state: room.state });

  room.autoTimer = setInterval(() => {
    if (!room.autoAdvance) {
      clearAutoTimer(room);
      return;
    }
    room.autoCountdown--;
    if (room.autoCountdown <= 0) {
      clearAutoTimer(room);
      callback();
    } else {
      io.to(room.pin).emit('room:autoTick', { autoCountdown: room.autoCountdown, state: room.state });
    }
  }, 1000);
}

function showLeaderboardOrPodium(room) {
  clearAutoTimer(room);
  if (room.currentQuestionIndex + 1 >= room.questions.length) {
    room.state = 'PODIUM';
    broadcastRoomState(room);
  } else {
    room.state = 'LEADERBOARD';
    room.autoCountdown = room.autoAdvance ? 4 : 0;
    broadcastRoomState(room);
    scheduleAutoTransition(room, 4, () => {
      startNextQuestion(room);
    });
  }
}

function finishQuestion(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  clearAutoTimer(room);
  if (room.state !== 'QUESTION') return;

  room.state = 'RESULTS';
  room.timeRemaining = 0;
  room.autoCountdown = room.autoAdvance ? 6 : 0;
  const currentQ = room.questions[room.currentQuestionIndex];

  // For players who didn't answer in time, reset their streak
  for (const player of room.players.values()) {
    if (!room.currentAnswers.has(player.id)) {
      player.streak = 0;
      player.answers[room.currentQuestionIndex] = {
        optionIndex: -1,
        isCorrect: false,
        pointsEarned: 0
      };
    }
  }

  // Send individual result feedback to each player
  const rankedPlayers = getSerializedPlayers(room);
  for (const player of room.players.values()) {
    const ans = room.currentAnswers.get(player.id);
    const rank = rankedPlayers.findIndex(p => p.id === player.id) + 1;
    if (player.socketId) {
      io.to(player.socketId).emit('player:questionResult', {
        isCorrect: ans ? ans.isCorrect : false,
        pointsEarned: ans ? ans.pointsEarned : 0,
        chosenIndex: ans ? ans.optionIndex : -1,
        correctIndex: currentQ.correctIndex,
        correctIndexText: currentQ.options[currentQ.correctIndex],
        correctText: currentQ.options[currentQ.correctIndex],
        explanation: currentQ.explanation,
        totalScore: player.score,
        streak: player.streak,
        rank,
        totalPlayers: rankedPlayers.length
      });
    }
  }

  broadcastRoomState(room);

  // Auto-advance from RESULTS (6s) -> LEADERBOARD (4s) -> NEXT QUESTION
  scheduleAutoTransition(room, 6, () => {
    showLeaderboardOrPodium(room);
  });
}

function startNextQuestion(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  clearAutoTimer(room);

  room.currentQuestionIndex++;
  if (room.currentQuestionIndex >= room.questions.length) {
    room.state = 'PODIUM';
    broadcastRoomState(room);
    return;
  }

  room.state = 'QUESTION';
  room.currentAnswers.clear();
  const currentQ = room.questions[room.currentQuestionIndex];
  room.timeRemaining = currentQ.timeLimit || 20;
  room.questionStartTime = Date.now();

  broadcastRoomState(room);

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    if (room.timeRemaining <= 0) {
      finishQuestion(room);
    } else {
      io.to(room.pin).emit('room:tick', {
        timeRemaining: room.timeRemaining,
        answeredCount: room.currentAnswers.size,
        totalPlayers: room.players.size
      });
    }
  }, 1000);
}

// REST Endpoints
app.get('/api/info', async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const localIp = getLocalIp();

  let baseUrl = `${proto}://${hostHeader}`;
  if (publicTunnelUrl) {
    baseUrl = publicTunnelUrl;
  } else if (hostHeader.startsWith('localhost') || hostHeader.startsWith('127.0.0.1')) {
    baseUrl = `http://${localIp}:${PORT}`;
  }

  const pin = req.query.pin || activeDefaultPin || '';
  const joinUrl = pin ? `${baseUrl}/play.html?pin=${pin}` : `${baseUrl}/play.html`;

  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl, {
      width: 280,
      margin: 1,
      color: { dark: '#111827', light: '#FFFFFF' }
    });
  } catch (err) {
    console.error('QR generation error:', err);
  }

  res.json({
    pin,
    baseUrl,
    joinUrl,
    publicTunnelUrl,
    localLanUrl: `http://${localIp}:${PORT}/play.html${pin ? `?pin=${pin}` : ''}`,
    qrDataUrl,
    totalQuestionsAvailable: ALL_QUESTIONS.length,
    categories: [...new Set(ALL_QUESTIONS.map(q => q.category))]
  });
});

// Export CSV for RRHH
app.get('/api/export/:pin', (req, res) => {
  const room = rooms.get(req.params.pin);
  if (!room) {
    return res.status(404).send('Sala no encontrada');
  }

  const ranked = getSerializedPlayers(room);
  const totalQ = room.questions.length;
  const rows = [
    ['Puesto', 'Nombre y Apellidos', 'DNI / Sede', 'Puntaje Total', 'Respuestas Correctas', 'Total Preguntas', '% Aciertos', 'Condicion (Min 70%)']
  ];

  ranked.forEach((p, idx) => {
    const pct = totalQ > 0 ? Math.round((p.correctCount / totalQ) * 100) : 0;
    const status = pct >= 70 ? 'APROBADO' : 'POR REFORZAR';
    rows.push([
      idx + 1,
      `"${(p.name || '').replace(/"/g, '""')}"`,
      `"${(p.dni || '-').replace(/"/g, '""')}"`,
      p.score,
      p.correctCount,
      totalQ,
      `${pct}%`,
      status
    ]);
  });

  const csvContent = '\uFEFF' + rows.map(r => r.join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Resultados_Induccion_Shalom_${room.pin}.csv"`);
  res.send(csvContent);
});

// Socket.IO Real-time Logic
io.on('connection', (socket) => {
  // Host creates or attaches to a room
  socket.on('host:init', ({ pin, mode }, callback) => {
    let room = pin && rooms.get(pin);
    if (!room) {
      room = createRoom(mode || 'all');
    }
    room.hostSocketId = socket.id;
    socket.join(room.pin);
    if (callback) callback({ ok: true, pin: room.pin });
    broadcastRoomState(room);
  });

  // Host changes game mode / resets lobby
  socket.on('host:newGame', ({ pin, mode }, callback) => {
    const oldRoom = rooms.get(pin);
    if (oldRoom) {
      if (oldRoom.timerInterval) clearInterval(oldRoom.timerInterval);
      clearAutoTimer(oldRoom);
    }
    const room = createRoom(mode || 'all');
    room.hostSocketId = socket.id;
    socket.join(room.pin);
    if (callback) callback({ ok: true, pin: room.pin });
    broadcastRoomState(room);
  });

  // Host toggles auto-advance
  socket.on('host:toggleAutoAdvance', ({ pin, autoAdvance }) => {
    const room = rooms.get(pin);
    if (!room) return;
    room.autoAdvance = Boolean(autoAdvance);
    if (!room.autoAdvance) {
      clearAutoTimer(room);
      broadcastRoomState(room);
    } else {
      if (room.state === 'RESULTS') {
        scheduleAutoTransition(room, 6, () => showLeaderboardOrPodium(room));
      } else if (room.state === 'LEADERBOARD') {
        scheduleAutoTransition(room, 4, () => startNextQuestion(room));
      }
      broadcastRoomState(room);
    }
  });

  // Host starts game or moves to next question
  socket.on('host:nextQuestion', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room) return;
    startNextQuestion(room);
  });

  // Host ends current question timer early
  socket.on('host:finishQuestion', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room) return;
    finishQuestion(room);
  });

  // Host shows intermediate leaderboard
  socket.on('host:showLeaderboard', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room) return;
    showLeaderboardOrPodium(room);
  });

  // Host jumps directly to final Podium
  socket.on('host:endToPodium', ({ pin }) => {
    const room = rooms.get(pin);
    if (!room) return;
    if (room.timerInterval) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
    }
    clearAutoTimer(room);
    room.state = 'PODIUM';
    broadcastRoomState(room);
  });

  // Host removes a player from lobby
  socket.on('host:kickPlayer', ({ pin, playerId }) => {
    const room = rooms.get(pin);
    if (!room) return;
    const player = room.players.get(playerId);
    if (player && player.socketId) {
      io.to(player.socketId).emit('player:kicked');
    }
    room.players.delete(playerId);
    broadcastRoomState(room);
  });

  // Player joins or reconnects
  socket.on('player:join', ({ pin, playerId, name, dni }, callback) => {
    const targetPin = (pin || activeDefaultPin || '').toString().trim();
    const room = rooms.get(targetPin);
    if (!room) {
      return callback && callback({ ok: false, error: 'El código PIN no existe o la sala aún no ha sido creada.' });
    }

    const cleanName = (name || '').trim().slice(0, 28);
    if (!cleanName) {
      return callback && callback({ ok: false, error: 'Por favor ingresa tu nombre y apellido.' });
    }

    let player = room.players.get(playerId);
    if (player) {
      // Reconnecting existing player
      player.socketId = socket.id;
      player.name = cleanName || player.name;
      if (dni) player.dni = dni.trim().slice(0, 20);
      player.connected = true;
    } else {
      // New player
      player = {
        id: playerId,
        socketId: socket.id,
        name: cleanName,
        dni: (dni || '').trim().slice(0, 20),
        score: 0,
        streak: 0,
        correctCount: 0,
        answers: {},
        connected: true
      };
      room.players.set(playerId, player);
    }

    socket.data.pin = room.pin;
    socket.data.playerId = playerId;
    socket.join(room.pin);

    if (callback) {
      callback({
        ok: true,
        pin: room.pin,
        player: {
          id: player.id,
          name: player.name,
          dni: player.dni,
          score: player.score,
          streak: player.streak
        }
      });
    }

    broadcastRoomState(room);
  });

  // Player submits an answer
  socket.on('player:answer', ({ pin, playerId, optionIndex }, callback) => {
    const room = rooms.get(pin);
    if (!room || room.state !== 'QUESTION') {
      return callback && callback({ ok: false, error: 'La pregunta ya no está activa.' });
    }

    const player = room.players.get(playerId);
    if (!player) {
      return callback && callback({ ok: false, error: 'Jugador no registrado en la sala.' });
    }

    if (room.currentAnswers.has(playerId)) {
      return callback && callback({ ok: false, error: 'Ya enviaste tu respuesta.' });
    }

    const currentQ = room.questions[room.currentQuestionIndex];
    const elapsedMs = Math.max(0, Date.now() - room.questionStartTime);
    const limitMs = (currentQ.timeLimit || 20) * 1000;
    const isCorrect = Number(optionIndex) === currentQ.correctIndex;

    let pointsEarned = 0;
    if (isCorrect) {
      // Kahoot-style speed formula: 500 to 1000 base points + streak bonus
      const timeRatio = Math.max(0, Math.min(1, 1 - (elapsedMs / limitMs) * 0.5));
      const basePoints = Math.round(1000 * timeRatio);
      player.streak += 1;
      const streakBonus = Math.min(player.streak - 1, 5) * 50;
      pointsEarned = basePoints + streakBonus;
      player.score += pointsEarned;
      player.correctCount += 1;
    } else {
      player.streak = 0;
    }

    const answerRecord = {
      optionIndex: Number(optionIndex),
      timeMs: elapsedMs,
      pointsEarned,
      isCorrect
    };

    room.currentAnswers.set(playerId, answerRecord);
    player.answers[room.currentQuestionIndex] = answerRecord;

    if (callback) {
      callback({ ok: true, chosenIndex: Number(optionIndex) });
    }

    // Notify host of answer count update
    io.to(room.pin).emit('room:tick', {
      timeRemaining: room.timeRemaining,
      answeredCount: room.currentAnswers.size,
      totalPlayers: room.players.size
    });

    // If all connected players have answered, end question immediately
    const connectedPlayersCount = Array.from(room.players.values()).filter(p => p.connected).length;
    if (connectedPlayersCount > 0 && room.currentAnswers.size >= connectedPlayersCount) {
      setTimeout(() => {
        if (room.state === 'QUESTION') {
          finishQuestion(room);
        }
      }, 450);
    }
  });

  socket.on('disconnect', () => {
    const { pin, playerId } = socket.data || {};
    if (pin && playerId && rooms.has(pin)) {
      const room = rooms.get(pin);
      const player = room.players.get(playerId);
      if (player) {
        player.connected = false;
        broadcastRoomState(room);
      }
    }
  });
});

// Create an initial room on boot so it's immediately ready
createRoom('all');

function startPublicTunnel() {
  if (process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.PUBLIC_URL) return;
  try {
    const ssh = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R', `80:127.0.0.1:${PORT}`,
      'nokey@localhost.run'
    ]);

    const handleOutput = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.lhr\.life/);
      if (match && match[0] !== publicTunnelUrl) {
        publicTunnelUrl = match[0];
        console.log(`🌐 TÚNEL PÚBLICO INTERNET ACTIVO: ${publicTunnelUrl}`);
        io.emit('tunnel:ready', { publicUrl: publicTunnelUrl });
      }
    };

    ssh.stdout.on('data', handleOutput);
    ssh.stderr.on('data', handleOutput);
    ssh.on('error', () => {});
  } catch (e) {}
}

server.listen(PORT, () => {
  const localIp = getLocalIp();
  console.log(`====================================================`);
  console.log(`🚀 SHALOM KAHOOT 2026 - SERVIDOR MULTIJUGADOR ACTIVO`);
  console.log(`📺 Panel Anfitrión (PC): http://127.0.0.1:${PORT}/host.html`);
  console.log(`📱 Jugadores (WiFi/Web): http://${localIp}:${PORT}/play.html`);
  console.log(`====================================================`);
  startPublicTunnel();
});

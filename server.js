const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────────────────────────────
// 게임 상태 관리
// ───────────────────────────────────────────────

const rooms = {}; // roomId → roomState

function createDeck() {
  const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
  const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const deck = [];
  for (const suit of suits) {
    for (const value of values) {
      deck.push({
        id: `${value}_${suit}`,
        suit,
        value,
        faceUp: false,
        x: 80,
        y: 300,
        rotation: 0,
        owner: null,   // null = 테이블/덱
        inHand: false,
        zIndex: 1
      });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createRoom(roomId, hostName) {
  return {
    roomId,
    host: null,
    players: [],
    deck: createDeck(),         // 아직 덱에 있는 카드들
    tableCards: [],             // 테이블 위 공개 카드
    hands: {},                  // playerId → 카드 배열 (비공개)
    chat: [],
    zCounter: 100
  };
}

// 특정 플레이어에게 보낼 게임 상태 생성 (패는 본인 것만 공개)
function getStateFor(room, playerId) {
  const hands = {};
  for (const [pid, cards] of Object.entries(room.hands)) {
    if (pid === playerId) {
      hands[pid] = cards; // 본인 패: 앞면 정보 포함
    } else {
      // 타인 패: 장수만, 뒷면으로
      hands[pid] = cards.map(c => ({
        id: c.id, suit: '?', value: '?', faceUp: false,
        x: c.x, y: c.y, rotation: c.rotation,
        owner: c.owner, inHand: true, zIndex: c.zIndex
      }));
    }
  }
  return {
    players: room.players,
    deckCount: room.deck.length,
    tableCards: room.tableCards,
    hands,
    zCounter: room.zCounter
  };
}

function broadcastState(room) {
  for (const player of room.players) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.emit('gameState', getStateFor(room, player.id));
    }
  }
}

// ───────────────────────────────────────────────
// Socket 이벤트
// ───────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('연결:', socket.id);

  // 방 목록 요청
  socket.on('getRooms', () => {
    const list = Object.values(rooms).map(r => ({
      roomId: r.roomId,
      playerCount: r.players.length,
      host: r.players.find(p => p.id === r.host)?.name || '?'
    }));
    socket.emit('roomList', list);
  });

  // 방 생성
  socket.on('createRoom', ({ roomId, playerName }) => {
    if (rooms[roomId]) {
      socket.emit('error', { msg: '이미 존재하는 방 이름입니다.' });
      return;
    }
    const room = createRoom(roomId);
    rooms[roomId] = room;

    const player = { id: socket.id, socketId: socket.id, name: playerName };
    room.players.push(player);
    room.host = socket.id;
    room.hands[socket.id] = [];

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;

    socket.emit('joinedRoom', { roomId, playerId: socket.id, players: room.players });
    broadcastState(room);
    io.to(roomId).emit('chat', { system: true, msg: `🃏 방이 생성되었습니다. (${playerName} 입장)` });
  });

  // 방 참여
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit('error', { msg: '존재하지 않는 방입니다.' }); return; }
    if (room.players.length >= 6) { socket.emit('error', { msg: '방이 가득 찼습니다.' }); return; }

    const player = { id: socket.id, socketId: socket.id, name: playerName };
    room.players.push(player);
    room.hands[socket.id] = [];

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;

    socket.emit('joinedRoom', { roomId, playerId: socket.id, players: room.players });
    broadcastState(room);
    io.to(roomId).emit('chat', { system: true, msg: `👤 ${playerName}님이 입장했습니다.` });
    io.to(roomId).emit('playerList', room.players);
  });

  // 채팅
  socket.on('chat', ({ msg }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const entry = { name: socket.data.playerName, msg, time: Date.now() };
    room.chat.push(entry);
    io.to(socket.data.roomId).emit('chat', entry);
  });

  // 덱에서 카드 뽑기 (draw) → 내 패로
  socket.on('drawCard', ({ count = 1 }) => {
    const room = rooms[socket.data.roomId];
    if (!room || room.deck.length === 0) return;

    const drawn = room.deck.splice(0, Math.min(count, room.deck.length));
    drawn.forEach(c => {
      c.owner = socket.id;
      c.inHand = true;
      c.faceUp = true;
    });
    room.hands[socket.id].push(...drawn);

    broadcastState(room);
    io.to(socket.data.roomId).emit('chat', {
      system: true,
      msg: `🎴 ${socket.data.playerName}이(가) 카드 ${drawn.length}장을 뽑았습니다.`
    });
  });

  // 딜하기 - 모든 플레이어에게 N장씩
  socket.on('dealCards', ({ count = 1 }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const players = room.players;
    const total = count * players.length;
    if (room.deck.length < total) {
      socket.emit('error', { msg: '덱에 카드가 부족합니다.' });
      return;
    }
    for (const p of players) {
      const drawn = room.deck.splice(0, count);
      drawn.forEach(c => { c.owner = p.id; c.inHand = true; c.faceUp = true; });
      room.hands[p.id].push(...drawn);
    }
    broadcastState(room);
    io.to(socket.data.roomId).emit('chat', {
      system: true,
      msg: `🃏 ${socket.data.playerName}이(가) 각 플레이어에게 ${count}장씩 딜했습니다.`
    });
  });

  // 패에서 카드 버리기 → 테이블로
  socket.on('discardCard', ({ cardId, x, y }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const hand = room.hands[socket.id];
    const idx = hand.findIndex(c => c.id === cardId);
    if (idx === -1) return;

    const [card] = hand.splice(idx, 1);
    card.owner = null;
    card.inHand = false;
    card.faceUp = true;
    card.x = x ?? 400;
    card.y = y ?? 300;
    room.zCounter++;
    card.zIndex = room.zCounter;
    room.tableCards.push(card);

    broadcastState(room);
  });

  // 드래그 중 실시간 위치 브로드캐스트 (상태 저장 없이 즉시 전달)
  socket.on('dragCard', ({ cardId, x, y }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    socket.to(socket.data.roomId).emit('cardDragging', { cardId, x, y });
  });

  // 테이블 카드 이동 확정 (드롭 시 서버 상태 저장)
  socket.on('moveCard', ({ cardId, x, y, rotation }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const card = room.tableCards.find(c => c.id === cardId);
    if (!card) return;

    card.x = x;
    card.y = y;
    if (rotation !== undefined) card.rotation = rotation;
    room.zCounter++;
    card.zIndex = room.zCounter;

    // 이동은 전체 브로드캐스트 (빠른 응답용 별도 이벤트)
    io.to(socket.data.roomId).emit('cardMoved', { cardId, x, y, rotation, zIndex: card.zIndex });
  });

  // 카드 뒤집기
  socket.on('flipCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const card = room.tableCards.find(c => c.id === cardId);
    if (!card) return;
    card.faceUp = !card.faceUp;
    broadcastState(room);
    io.to(socket.data.roomId).emit('chat', {
      system: true,
      msg: `🔄 ${socket.data.playerName}이(가) 카드를 뒤집었습니다.`
    });
  });

  // 패 공개 (선택한 카드만 테이블로)
  socket.on('revealHand', ({ cardIds }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const hand = room.hands[socket.id];
    const targets = (cardIds && cardIds.length > 0)
      ? cardIds.map(id => hand.find(c => c.id === id)).filter(Boolean)
      : [...hand];

    targets.forEach((c, i) => {
      const idx = hand.indexOf(c);
      if (idx !== -1) hand.splice(idx, 1);
      c.owner = null;
      c.inHand = false;
      c.faceUp = true;
      c.x = 200 + i * 75;
      c.y = 250;
      room.zCounter++;
      c.zIndex = room.zCounter;
      room.tableCards.push(c);
    });

    broadcastState(room);
    io.to(socket.data.roomId).emit('chat', {
      system: true,
      msg: `👐 ${socket.data.playerName}이(가) 카드 ${targets.length}장을 공개했습니다!`
    });
  });

  // 테이블 카드 집기 (내 패로)
  socket.on('pickupCard', ({ cardId }) => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    const idx = room.tableCards.findIndex(c => c.id === cardId);
    if (idx === -1) return;
    const [card] = room.tableCards.splice(idx, 1);
    card.owner = socket.id;
    card.inHand = true;
    card.faceUp = true;
    room.hands[socket.id].push(card);
    broadcastState(room);
  });

  // 덱 셔플 (모두 가능)
  socket.on('shuffleDeck', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    room.deck = shuffle(room.deck);
    broadcastState(room);
    io.to(socket.data.roomId).emit('chat', {
      system: true,
      msg: `🔀 ${socket.data.playerName}이(가) 덱을 섞었습니다.`
    });
  });

  // 덱 리셋 (모두 가능) - 테이블 카드 + 패 전부 덱으로
  socket.on('resetDeck', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    room.deck = shuffle(createDeck());
    room.tableCards = [];
    for (const pid of Object.keys(room.hands)) room.hands[pid] = [];
    broadcastState(room);
    io.to(socket.data.roomId).emit('chat', {
      system: true,
      msg: `♻️ ${socket.data.playerName}이(가) 덱을 초기화했습니다.`
    });
  });

  // 연결 해제
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);
    delete room.hands[socket.id];

    if (room.players.length === 0) {
      delete rooms[roomId];
    } else {
      if (room.host === socket.id) room.host = room.players[0].socketId;
      io.to(roomId).emit('chat', { system: true, msg: `👤 ${socket.data.playerName}님이 퇴장했습니다.` });
      io.to(roomId).emit('playerList', room.players);
      broadcastState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏 카드 테이블 서버 실행 중: http://localhost:${PORT}`));

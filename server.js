// server.js (Backend)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors'); // สำหรับอนุญาตให้ Frontend เข้าถึงได้

const app = express();
const server = http.createServer(app);

// กำหนด CORS ให้ Frontend สามารถเชื่อมต่อได้
// ถ้า Frontend รันอยู่บน http://localhost:3000 ให้เปลี่ยน origin เป็นค่านี้
const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000", // **สำคัญ: เปลี่ยนเป็น URL ของ Frontend คุณ**
        methods: ["GET", "POST"]
    }
});

app.use(cors()); // ใช้ CORS สำหรับ Express ด้วย (ถ้ามี API ปกติ)
app.use(express.json()); // สำหรับอ่าน JSON ใน request body

// --- ฐานข้อมูลเกม (เก็บใน RAM ชั่วคราว) ---
let rooms = {}; // เก็บข้อมูลห้อง: { roomId: { players: [], currentSpymaster: null, currentCard: null, targetValue: null, clue: null, guess: null, scores: {} } }
const SPECTRUM_CARDS = require('./spectrumCards'); // โหลดการ์ด Spectrum จากไฟล์แยก

// --- ฟังก์ชันช่วยเหลือ ---
function generateRoomId() {
    let roomId;
    do {
        roomId = Math.random().toString(36).substring(2, 6).toUpperCase(); // 4 ตัวอักษร
    } while (rooms[roomId]);
    return roomId;
}

function getRandomItem(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// --- Socket.IO Connection Handling ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // [Event 1] ผู้เล่นสร้างห้องใหม่
    socket.on('createRoom', (username) => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            players: [{ id: socket.id, username, score: 0 }],
            currentSpymaster: null,
            currentCard: null,
            targetValue: null,
            clue: null,
            guess: null,
            gameState: 'waiting', // waiting, choosing_clue, guessing, revealing
            scores: {} // { playerId: score }
        };
        socket.join(roomId);
        console.log(`Room created: ${roomId} by ${username} (${socket.id})`);
        socket.emit('roomCreated', { roomId, players: rooms[roomId].players });
    });

    // [Event 2] ผู้เล่นเข้าร่วมห้องที่มีอยู่
    socket.on('joinRoom', ({ roomId, username }) => {
        if (!rooms[roomId]) {
            socket.emit('error', 'Room does not exist.');
            return;
        }
        if (rooms[roomId].players.length >= 5) { // จำกัดผู้เล่นสูงสุด 5 คน
            socket.emit('error', 'Room is full.');
            return;
        }

        rooms[roomId].players.push({ id: socket.id, username, score: 0 });
        rooms[roomId].scores[socket.id] = 0; // Initialize score
        socket.join(roomId);
        console.log(`User ${username} (${socket.id}) joined room ${roomId}`);

        // แจ้งทุกคนในห้องว่ามีผู้เล่นใหม่เข้าร่วม
        io.to(roomId).emit('playerJoined', { players: rooms[roomId].players });
        socket.emit('roomJoined', { roomId, players: rooms[roomId].players, gameState: rooms[roomId].gameState });
    });

    // [Event 3] เริ่มเกม
    socket.on('startGame', (roomId) => {
        if (!rooms[roomId] || rooms[roomId].players.length < 2) {
            socket.emit('error', 'Need at least 2 players to start.');
            return;
        }
        if (rooms[roomId].gameState !== 'waiting') {
            socket.emit('error', 'Game already started or in progress.');
            return;
        }

        startNewRound(roomId);
    });

    // [Event 4] Spymaster ส่งคำใบ้
    socket.on('sendClue', ({ roomId, clue }) => {
        const room = rooms[roomId];
        if (!room || room.currentSpymaster !== socket.id || room.gameState !== 'choosing_clue') {
            socket.emit('error', 'Not your turn to send a clue or invalid game state.');
            return;
        }

        room.clue = clue;
        room.gameState = 'guessing'; // เปลี่ยนสถานะเป็นรอทีมเดา
        console.log(`Room ${roomId}: Spymaster ${room.players.find(p => p.id === socket.id).username} gave clue "${clue}"`);

        // ส่งคำใบ้ไปยังทุกคน (รวม Spymaster ด้วย)
        io.to(roomId).emit('clueGiven', { clue, card: room.currentCard });

        // แจ้ง Psychics ว่าถึงตาเดา
        room.players.forEach(p => {
            if (p.id !== room.currentSpymaster) {
                io.to(p.id).emit('yourTurnToGuess');
            }
        });
    });

    // [Event 5] Psychics ส่งค่าเดา
    socket.on('sendGuess', ({ roomId, guessValue }) => {
        const room = rooms[roomId];
        // ตรวจสอบว่าเป็นคนในทีมเดา และอยู่ในสถานะที่ถูกต้อง
        if (!room || room.currentSpymaster === socket.id || room.gameState !== 'guessing') {
            socket.emit('error', 'Not your turn to guess or invalid game state.');
            return;
        }

        room.guess = guessValue;
        room.gameState = 'revealing'; // เปลี่ยนสถานะเป็นรอเปิดเผย

        console.log(`Room ${roomId}: Team guessed ${guessValue}`);

        // แจ้งทุกคนว่าถึงเวลาเปิดเผย
        io.to(roomId).emit('guessSubmitted', { guessValue });

        // แจ้ง Spymaster ให้กดเปิดเผย
        io.to(room.currentSpymaster).emit('yourTurnToReveal');
    });

    // [Event 6] Spymaster เปิดเผยคำตอบ
    socket.on('revealAnswer', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.currentSpymaster !== socket.id || room.gameState !== 'revealing') {
            socket.emit('error', 'Not your turn to reveal or invalid game state.');
            return;
        }

        // คำนวณคะแนน (Wavelength คะแนนสูงสุด 4)
        const diff = Math.abs(room.targetValue - room.guess);
        let score = 0;
        if (diff <= 5) { // เช่น ห่างไม่เกิน 5 ได้ 4 คะแนน (ตรงกับ zone4)
            score = 4;
        } else if (diff <= 10) { // ห่างไม่เกิน 10 ได้ 3 คะแนน (ตรงกับ zone3)
            score = 3;
        } else if (diff <= 15) { // ห่างไม่เกิน 15 ได้ 2 คะแนน (ตรงกับ zone2)
            score = 2;
        } else if (diff <= 20) { // ห่างไม่เกิน 20 ได้ 1 คะแนน (ตรงกับ zone1)
            score = 1;
        }

        // อัปเดตคะแนน Spymaster (หรือจะให้คะแนนทีมเดา?) Wavelength ให้คะแนนทีม Spymaster
        const spymasterPlayer = room.players.find(p => p.id === room.currentSpymaster);
        if (spymasterPlayer) {
            spymasterPlayer.score += score;
            room.scores[spymasterPlayer.id] = spymasterPlayer.score; // Update in scores map as well
        }

        // ส่งผลลัพธ์ไปยังทุกคน
        io.to(roomId).emit('roundResult', {
            targetValue: room.targetValue,
            guessValue: room.guess,
            scoreThisRound: score,
            totalScores: room.players.map(p => ({ id: p.id, username: p.username, score: p.score })), // ส่งคะแนนอัปเดตไป
            currentCard: room.currentCard,
            clue: room.clue
        });

        // เตรียมรอบใหม่
        setTimeout(() => {
            startNewRound(roomId);
        }, 5000); // รอ 5 วินาทีก่อนเริ่มรอบใหม่
    });


    // [Event 7] ผู้เล่นตัดการเชื่อมต่อ
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // หาห้องที่ผู้เล่นนี้อยู่และลบออก
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const initialPlayerCount = room.players.length;
            room.players = room.players.filter(player => player.id !== socket.id);

            if (room.players.length < initialPlayerCount) { // ถ้าผู้เล่นถูกลบออกจากห้อง
                if (room.players.length === 0) {
                    delete rooms[roomId]; // ถ้าไม่มีผู้เล่นเหลือในห้อง ให้ลบห้องนั้นทิ้ง
                    console.log(`Room ${roomId} deleted as it is empty.`);
                } else {
                    io.to(roomId).emit('playerLeft', { players: room.players });
                    // ถ้า Spymaster ออกไป ให้เริ่มรอบใหม่
                    if (room.currentSpymaster === socket.id && room.gameState !== 'waiting') {
                        console.log(`Spymaster left room ${roomId}. Starting new round.`);
                        startNewRound(roomId);
                    }
                }
                break;
            }
        }
    });
});

// --- [เพิ่ม] ฟังก์ชันคำนวณโซนคะแนน ---
function calculateScoreZones(target) {
    const zones = {
        zone4: [], // 4 คะแนน (diff <= 5)
        zone3: [], // 3 คะแนน (diff <= 10)
        zone2: [], // 2 คะแนน (diff <= 15)
        zone1: []  // 1 คะแนน (diff <= 20)
    };

    // วนลูปตั้งแต่ 0-100 เพื่อให้ครอบคลุมสเกลทั้งหมด
    for (let i = 0; i <= 100; i++) {
        const diff = Math.abs(target - i);
        if (diff <= 5) {
            zones.zone4.push(i);
        } else if (diff <= 10) {
            zones.zone3.push(i);
        } else if (diff <= 15) {
            zones.zone2.push(i);
        } else if (diff <= 20) {
            zones.zone1.push(i);
        }
    }
    return zones;
}

// --- [แก้ไข] ฟังก์ชันสำหรับเริ่มรอบใหม่ ---
function startNewRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // สุ่ม Spymaster คนใหม่ (วนไปเรื่อยๆ)
    let nextSpymasterIndex;
    if (room.currentSpymaster) {
        const currentSpymasterIdx = room.players.findIndex(p => p.id === room.currentSpymaster);
        nextSpymasterIndex = (currentSpymasterIdx + 1) % room.players.length;
    } else {
        nextSpymasterIndex = Math.floor(Math.random() * room.players.length);
    }
    const nextSpymaster = room.players[nextSpymasterIndex];

    room.currentSpymaster = nextSpymaster.id;
    room.currentCard = getRandomItem(SPECTRUM_CARDS);
    room.targetValue = Math.floor(Math.random() * 100) + 1; // ค่าระหว่าง 1-100
    room.clue = null;
    room.guess = null;
    room.gameState = 'choosing_clue'; // สถานะให้ Spymaster เลือกคำใบ้

    console.log(`Room ${roomId}: New round. Spymaster: ${nextSpymaster.username}. Card: ${room.currentCard.left} - ${room.currentCard.right}. Target: ${room.targetValue}`);

s    // แจ้งทุกคนว่า Spymaster คือใครและมีการ์ดอะไร
    io.to(roomId).emit('newRound', {
        spymasterId: room.currentSpymaster,
        card: room.currentCard,
        players: room.players.map(p => ({ id: p.id, username: p.username, score: p.score })) // ส่งคะแนนอัปเดตไป
    });

    // *** [เพิ่ม] 1. คำนวณโซนคะแนน ***
    const scoreZones = calculateScoreZones(room.targetValue);

    // ส่ง TargetValue ให้ Spymaster เท่านั้น
    io.to(room.currentSpymaster).emit('yourTurnToClue', {
        card: room.currentCard,
        targetValue: room.targetValue,
        // *** [เพิ่ม] 2. ส่งข้อมูลโซนคะแนนไปด้วย ***
        scoreZones: scoreZones
    });
}


const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
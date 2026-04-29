require('dotenv').config();
const express = require('express');
const http = require('http');
const session = require('express-session');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const pool = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Session middleware
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "bingo_secret_key",
    resave: false,
    saveUninitialized: false
});
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));   // index.html served here

// ---------- Telegram Login Verification ----------
function verifyTelegram(initData) {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const data = [...params.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
    const secret = crypto.createHash("sha256").update(process.env.BOT_TOKEN).digest();
    const hmac = crypto.createHmac("sha256", secret).update(data).digest("hex");
    return hmac === hash;
}

app.post("/api/auth", async (req, res) => {
    const { initData } = req.body;
    if (!initData || !verifyTelegram(initData)) {
        return res.status(403).json({ error: "Invalid auth" });
    }
    const params = new URLSearchParams(initData);
    const userData = JSON.parse(params.get("user"));
    const telegramId = userData.id;
    const username = userData.username || userData.first_name;

    // Upsert user into Neon DB
    const result = await pool.query(
        `INSERT INTO users (telegram_id, username, balance) 
         VALUES ($1, $2, 100) 
         ON CONFLICT (telegram_id) 
         DO UPDATE SET username = EXCLUDED.username 
         RETURNING telegram_id, username, balance`,
        [telegramId, username]
    );
    const user = result.rows[0];
    req.session.userId = telegramId;
    res.json({ success: true, userId: user.telegram_id, username: user.username, balance: user.balance });
});

// ---------- Bingo Game State (in-memory + DB persist on win) ----------
let currentNumbers = Array.from({ length: 100 }, (_, i) => i + 1);   // 1..100
let availableNumbers = new Set(currentNumbers);
let userSelections = new Map();   // socketId -> { userId, selectedNumber }
let gameLocked = false;
let drawInterval = null;
let roundPool = 0;

async function updateUserBalance(telegramId, delta) {
    const res = await pool.query(
        `UPDATE users SET balance = balance + $1 WHERE telegram_id = $2 RETURNING balance`,
        [delta, telegramId]
    );
    return res.rows[0]?.balance || 0;
}

function startNewRound() {
    // Reset round
    gameLocked = false;
    availableNumbers = new Set(currentNumbers);
    userSelections.clear();
    roundPool = 0;
    io.emit('gameState', { locked: false, available: Array.from(availableNumbers) });
    io.emit('statusMessage', { text: "New round started! Choose your number (1-100).", type: "info" });

    // Auto-lock after 15 seconds, then draw winner
    if (drawInterval) clearTimeout(drawInterval);
    drawInterval = setTimeout(async () => {
        gameLocked = true;
        io.emit('gameState', { locked: true, available: [] });
        io.emit('statusMessage', { text: "Betting closed! Drawing winner...", type: "warning" });

        // Pick random winning number from original 1..100
        const winningNumber = Math.floor(Math.random() * 100) + 1;
        io.emit('numberDrawn', { number: winningNumber });

        // Find winner
        let winnerTelegramId = null;
        let winnerSocketId = null;
        for (let [sockId, data] of userSelections.entries()) {
            if (data.selectedNumber === winningNumber) {
                winnerTelegramId = data.userId;
                winnerSocketId = sockId;
                break;
            }
        }

        if (winnerTelegramId && roundPool > 0) {
            const newBalance = await updateUserBalance(winnerTelegramId, roundPool);
            io.to(winnerSocketId).emit('balanceUpdate', newBalance);
            io.emit('statusMessage', { text: `🎉 Winner! User ${winnerTelegramId} won ${roundPool}!`, type: "success" });
        } else {
            io.emit('statusMessage', { text: `No winner this round. Winning number: ${winningNumber}`, type: "info" });
        }

        // Reset pool and start next round after 5 seconds
        roundPool = 0;
        setTimeout(() => startNewRound(), 5000);
    }, 15000);
}

// Start first round
startNewRound();

// ---------- Socket.IO with session auth ----------
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});
io.on('connection', async (socket) => {
    const userId = socket.request.session.userId;
    if (!userId) {
        socket.disconnect();
        return;
    }

    // Fetch latest balance
    const userRes = await pool.query(`SELECT balance FROM users WHERE telegram_id = $1`, [userId]);
    let balance = userRes.rows[0]?.balance || 0;
    socket.emit('balanceUpdate', balance);

    // Send current game state
    socket.emit('gameState', { locked: gameLocked, available: Array.from(availableNumbers) });

    // Player selects a number
    socket.on('selectCard', async ({ cardNumber, name }) => {
        if (gameLocked) {
            socket.emit('error', { message: "Round locked, cannot pick now." });
            return;
        }
        if (!availableNumbers.has(cardNumber)) {
            socket.emit('error', { message: "Number already taken." });
            return;
        }
        if (userSelections.has(socket.id)) {
            socket.emit('error', { message: "You already picked a number this round." });
            return;
        }

        const cost = 10;
        if (balance < cost) {
            socket.emit('error', { message: "Insufficient balance." });
            return;
        }

        // Deduct cost from DB and update balance
        const newBalance = await updateUserBalance(userId, -cost);
        balance = newBalance;
        socket.emit('balanceUpdate', balance);

        // Mark number taken
        availableNumbers.delete(cardNumber);
        userSelections.set(socket.id, { userId, selectedNumber: cardNumber });
        roundPool += cost;

        socket.emit('cardAssigned', { cardNumber, balance: newBalance });
        io.emit('gameState', { locked: gameLocked, available: Array.from(availableNumbers) });
        io.emit('statusMessage', { text: `${name} picked number ${cardNumber}`, type: "action" });
    });

    socket.on('disconnect', () => {
        userSelections.delete(socket.id);
    });
});

// Serve frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
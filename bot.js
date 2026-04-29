const { Telegraf, Markup } = require('telegraf');
const pool = require('./db');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;   // read from .env
const ADMIN_ID = parseInt(process.env.ADMIN_ID); // 5423314276
const FRONTEND_URL = process.env.FRONTEND_URL || "https://dast12.onrender.com";

const bot = new Telegraf(BOT_TOKEN);

// Helper: ensure user exists in DB
async function ensureUser(telegramId, username) {
    const res = await pool.query(
        `INSERT INTO users (telegram_id, username, balance) 
         VALUES ($1, $2, 0) 
         ON CONFLICT (telegram_id) 
         DO UPDATE SET username = EXCLUDED.username 
         RETURNING *`,
        [telegramId, username]
    );
    return res.rows[0];
}

// Start command
bot.start(async (ctx) => {
    const telegramId = ctx.from.id;
    const username = ctx.from.username || "player";
    const user = await ensureUser(telegramId, username);

    ctx.reply(
        `Welcome ${username}\nBalance: ${user.balance}`,
        {
            reply_markup: {
                keyboard: [
                    ["🎮 Play"],
                    ["💰 Balance"],
                    ["➕ Deposit", "➖ Withdraw"]
                ],
                resize_keyboard: true
            }
        }
    );
});

bot.hears("🎮 Play", (ctx) => {
    ctx.reply("🚀 Open Bingo Game:", {
        reply_markup: {
            inline_keyboard: [[
                { text: "▶️ Play Now", web_app: { url: FRONTEND_URL } }
            ]]
        }
    });
});

bot.hears("💰 Balance", async (ctx) => {
    const telegramId = ctx.from.id;
    const res = await pool.query(`SELECT balance FROM users WHERE telegram_id = $1`, [telegramId]);
    const balance = res.rows[0]?.balance || 0;
    ctx.reply(`💰 Balance: ${balance}`);
});

// Deposit / Withdraw state
const userStates = new Map();

bot.hears("➕ Deposit", (ctx) => {
    userStates.set(ctx.from.id, "deposit");
    ctx.reply("Enter deposit amount:");
});

bot.hears("➖ Withdraw", (ctx) => {
    userStates.set(ctx.from.id, "withdraw");
    ctx.reply("Enter withdraw amount:");
});

bot.on("text", async (ctx) => {
    const action = userStates.get(ctx.from.id);
    if (!action) return;

    const amount = Number(ctx.message.text);
    if (!Number.isFinite(amount) || amount <= 0) {
        return ctx.reply("❌ Invalid amount");
    }

    const telegramId = ctx.from.id;
    const username = ctx.from.username || "player";

    if (action === "withdraw") {
        const balanceRes = await pool.query(`SELECT balance FROM users WHERE telegram_id = $1`, [telegramId]);
        const balance = balanceRes.rows[0]?.balance || 0;
        if (balance < amount) {
            return ctx.reply("❌ Not enough balance");
        }
    }

    // Create request
    await pool.query(
        `INSERT INTO requests (user_id, type, amount, status) VALUES ($1, $2, $3, 'pending')`,
        [telegramId, action, amount]
    );

    ctx.reply(`✅ Request sent: ${action} ${amount}. Awaiting admin approval.`);
    userStates.delete(ctx.from.id);
});

// Admin approval buttons (requires ADMIN_ID)
bot.action(/approve_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Not allowed");

    const requestId = parseInt(ctx.match[1]);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const reqRes = await client.query(`SELECT * FROM requests WHERE id = $1 AND status = 'pending'`, [requestId]);
        if (reqRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return ctx.answerCbQuery("Request not found or processed");
        }
        const req = reqRes.rows[0];

        if (req.type === 'deposit') {
            await client.query(
                `UPDATE users SET balance = balance + $1 WHERE telegram_id = $2`,
                [req.amount, req.user_id]
            );
        } else if (req.type === 'withdraw') {
            await client.query(
                `UPDATE users SET balance = balance - $1 WHERE telegram_id = $2 AND balance >= $1`,
                [req.amount, req.user_id]
            );
        }

        await client.query(`UPDATE requests SET status = 'approved' WHERE id = $1`, [requestId]);
        await client.query('COMMIT');

        ctx.editMessageText("✅ Approved");
        bot.telegram.sendMessage(req.user_id, `✅ ${req.type} of ${req.amount} approved`);
    } catch (err) {
        await client.query('ROLLBACK');
        ctx.editMessageText("❌ Error approving");
    } finally {
        client.release();
    }
});

bot.action(/reject_(\d+)/, async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Not allowed");

    const requestId = parseInt(ctx.match[1]);
    await pool.query(`UPDATE requests SET status = 'rejected' WHERE id = $1`, [requestId]);
    ctx.editMessageText("❌ Rejected");
    const reqRes = await pool.query(`SELECT user_id FROM requests WHERE id = $1`, [requestId]);
    if (reqRes.rows[0]) {
        bot.telegram.sendMessage(reqRes.rows[0].user_id, `❌ Request rejected`);
    }
});

// Admin command to show pending requests
bot.command('pending', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const res = await pool.query(`SELECT * FROM requests WHERE status = 'pending' ORDER BY id ASC`);
    if (res.rows.length === 0) {
        return ctx.reply("No pending requests.");
    }
    for (const req of res.rows) {
        ctx.reply(
            `Request #${req.id}\nUser: ${req.user_id}\nType: ${req.type}\nAmount: ${req.amount}`,
            Markup.inlineKeyboard([
                Markup.button.callback('✅ Approve', `approve_${req.id}`),
                Markup.button.callback('❌ Reject', `reject_${req.id}`)
            ])
        );
    }
});

bot.launch();
console.log("🤖 Bot running...");
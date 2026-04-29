const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error("❌ DATABASE_URL is missing in .env");
}

const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
});

module.exports = pool;
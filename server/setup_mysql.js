require('dotenv').config({ path: './.env' });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function setupDatabase() {
    console.log("Connecting to MySQL at " + process.env.DB_HOST + "...");
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            multipleStatements: true
        });

        console.log("Connected! Reading init_mysql.sql...");
        const sqlPath = path.join(__dirname, 'db', 'init_mysql.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        console.log("Executing SQL script...");
        await connection.query(sql);

        console.log("Database tables created successfully!");
        await connection.end();
    } catch (err) {
        console.error("Error setting up database:", err);
    }
}

setupDatabase();

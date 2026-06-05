const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const sqlPath = path.join(__dirname, 'init.sql');

function initDB() {
    console.log('--- Inicializando Base de Datos ---');
    const db = new Database(dbPath, { verbose: console.log });

    try {
        const sql = fs.readFileSync(sqlPath, 'utf8');
        db.exec(sql);
        console.log('✔ Tablas creadas e inicializadas correctamente.');
    } catch (err) {
        console.error('✘ Error inicializando la base de datos:', err);
    } finally {
        db.close();
    }
}

if (require.main === module) {
    initDB();
}

module.exports = initDB;

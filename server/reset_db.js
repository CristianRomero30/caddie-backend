const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'db', 'database.sqlite'));

try {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM incidencias').run();
    db.prepare('DELETE FROM servicios').run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name='servicios' OR name='incidencias'").run();
    db.prepare('UPDATE perfiles_caddie SET horas_acumuladas = 0, esta_en_club = 0, fecha_entrada_club = NULL').run();
    db.pragma('foreign_keys = ON');
    console.log('Database cleared successfully and caddie hours reset to 0');
} catch (e) {
    console.error('Error clearing database:', e.message);
} finally {
    db.close();
}


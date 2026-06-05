const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'db', 'database.sqlite'));

const states = db.prepare('SELECT DISTINCT estado FROM usuarios WHERE rol_id = 4').all();
console.log('Estados de caddies en la DB:', states);

const golfInactives = db.prepare("SELECT nombre, estado, deporte FROM usuarios WHERE rol_id = 4 AND (deporte = 'Golf' OR deporte = 'Ambos') AND estado = 'Inactivo'").all();
console.log('Inactivos de Golf encontrados:', golfInactives);

const allGolf = db.prepare("SELECT nombre, estado, deporte FROM usuarios WHERE rol_id = 4 AND (deporte = 'Golf' OR deporte = 'Ambos')").all();
console.log('Todos los de Golf:', allGolf.length);

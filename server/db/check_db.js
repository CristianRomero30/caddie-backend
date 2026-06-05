const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'database.sqlite'));

const query = `
    SELECT 
        s.id, 
        u2.nombre as caddie_nombre,
        p2.esta_en_club as caddie_en_club
    FROM servicios s
    LEFT JOIN usuarios u2 ON s.caddie_id = u2.id
    LEFT JOIN perfiles_caddie p2 ON u2.id = p2.usuario_id
    WHERE s.caddie_id IS NOT NULL
`;

try {
    const results = db.prepare(query).all();
    console.log(JSON.stringify(results, null, 2));
} catch (e) {
    console.error(e);
}

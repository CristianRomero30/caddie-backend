const Database = require('better-sqlite3');
const path = require('path');

try {
    const db = new Database(path.join(__dirname, 'db', 'database.sqlite'));
    console.log('✅ Base de datos conectada');
    
    const query = "SELECT id, nombre, email FROM usuarios WHERE rol_id = 3 AND estado = 'Activo' ORDER BY nombre ASC";
    const socios = db.prepare(query).all();
    
    console.log('📊 Resultados:', socios.length, 'socios encontrados');
    if (socios.length > 0) {
        console.log('Sample:', socios[0]);
    }
} catch (error) {
    console.error('❌ ERROR SQL:', error.message);
    console.error(error.stack);
}

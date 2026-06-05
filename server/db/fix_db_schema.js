const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'database.sqlite'));

try {
    console.log('Aplicando índice único a external_id en la tabla servicios...');
    
    // 1. Eliminar duplicados si los hay (basado en external_id)
    // Mantener solo el ID más bajo para cada external_id no nulo
    db.prepare(`
        DELETE FROM servicios 
        WHERE id NOT IN (
            SELECT MIN(id) 
            FROM servicios 
            WHERE external_id IS NOT NULL 
            GROUP BY external_id
        ) AND external_id IS NOT NULL
    `).run();

    // 2. Crear el índice único
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_servicios_external_id ON servicios(external_id) WHERE external_id IS NOT NULL').run();
    
    console.log('✅ Esquema actualizado exitosamente.');
} catch (error) {
    console.error('❌ Error actualizando el esquema:', error.message);
}

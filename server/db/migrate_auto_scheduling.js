const db = require('better-sqlite3')('server/db/database.sqlite');

try {
    console.log('🚀 Iniciando migración de base de datos...');

    // 1. Modificar servicios
    db.exec(`
        ALTER TABLE servicios ADD COLUMN estado_confirmacion TEXT DEFAULT 'Pendiente';
        ALTER TABLE servicios ADD COLUMN es_backup INTEGER DEFAULT 0;
        ALTER TABLE servicios ADD COLUMN reporto_llegada INTEGER DEFAULT 0;
        ALTER TABLE servicios ADD COLUMN hora_llegada TIME;
        ALTER TABLE servicios ADD COLUMN ubicacion_verificada INTEGER DEFAULT 0;
    `);
    console.log('✅ Tabla "servicios" actualizada.');

    // 2. Modificar perfiles_caddie (SQLite no permite DROP COLUMN fácilmente, pero podemos ignorarla en la UI o recrear la tabla)
    // Para simplificar, la mantendremos pero la ignoraremos en la UI.
    // Sin embargo, si queremos ser limpios:
    /*
    db.exec(`
        CREATE TABLE perfiles_caddie_new (
            usuario_id INTEGER PRIMARY KEY,
            horas_acumuladas REAL DEFAULT 0,
            disponibilidad TEXT DEFAULT 'Disponible',
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        );
        INSERT INTO perfiles_caddie_new (usuario_id, horas_acumuladas, disponibilidad)
        SELECT usuario_id, horas_acumuladas, disponibilidad FROM perfiles_caddie;
        DROP TABLE perfiles_caddie;
        ALTER TABLE perfiles_caddie_new RENAME TO perfiles_caddie;
    `);
    */
    // Por ahora, solo la ignoraremos en la UI para evitar riesgos de datos.
    console.log('ℹ️  Columna "calificacion" será ignorada en la UI.');

    // 3. Tabla de configuración global
    db.exec(`
        CREATE TABLE IF NOT EXISTS configuracion_sistema (
            clave TEXT PRIMARY KEY,
            valor TEXT
        );
        INSERT OR IGNORE INTO configuracion_sistema (clave, valor) VALUES ('backups_sugeridos', '5');
    `);
    console.log('✅ Tabla "configuracion_sistema" creada.');

    console.log('🏁 Migración completada exitosamente.');
} catch (error) {
    if (error.message.includes('duplicate column name')) {
        console.log('⚠️  La migración ya fue aplicada anteriormente.');
    } else {
        console.error('❌ Error en la migración:', error.message);
    }
}

const Database = require('better-sqlite3');
const path = require('path');

try {
    const db = new Database(path.join(__dirname, 'db', 'database.sqlite'));
    
    console.log('--- ESQUEMA USUARIOS ---');
    console.log(db.prepare("PRAGMA table_info(usuarios)").all());
    
    console.log('\n--- ESQUEMA PERFILES_CADDIE ---');
    console.log(db.prepare("PRAGMA table_info(perfiles_caddie)").all());
    
    console.log('\n--- ESQUEMA SERVICIOS ---');
    console.log(db.prepare("PRAGMA table_info(servicios)").all());
    
    console.log('\n--- ROLES ACTUALES ---');
    console.log(db.prepare("SELECT * FROM roles").all());
    
} catch (error) {
    console.error('ERROR:', error.message);
}

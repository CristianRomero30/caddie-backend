require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const xlsx = require('xlsx');
const multer = require('multer');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3001;

// Helper para formatear minutos a HH:mm
const formatTime = (totalMin) => {
    const h = Math.floor(totalMin / 60).toString().padStart(2, '0');
    const m = (totalMin % 60).toString().padStart(2, '0');
    return `${h}:${m}`;
};

const calcularHorasReales = (horaInicio, horaFin) => {
    if (!horaInicio || !horaFin) return 4.5;
    const [hIni, mIni] = horaInicio.split(':').map(Number);
    const [hFin, mFin] = horaFin.split(':').map(Number);
    if (isNaN(hIni) || isNaN(mIni) || isNaN(hFin) || isNaN(mFin)) return 4.5;
    
    let diffMin = (hFin * 60 + mFin) - (hIni * 60 + mIni);
    if (diffMin < 0) {
        diffMin += 24 * 60;
    }
    return Math.round((diffMin / 60) * 10) / 10;
};

// Configuración de la base de datos
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    dateStrings: true
});

// Wrapper temporal para facilitar migración a MySQL
const db = {
    prepare: (sql) => {
        return {
            all: async (...params) => {
                const [rows] = await pool.query(sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
                return rows;
            },
            get: async (...params) => {
                const [rows] = await pool.query(sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
                return rows[0];
            },
            run: async (...params) => {
                const [result] = await pool.query(sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
                return { lastInsertRowid: result.insertId, changes: result.affectedRows };
            }
        };
    },
    transaction: (fn) => {
        return async (...args) => {
            const connection = await pool.getConnection();
            await connection.beginTransaction();
            
            const originalPrepare = db.prepare;
            db.prepare = (sql) => {
                return {
                    all: async (...params) => { const [rows] = await connection.query(sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params); return rows; },
                    get: async (...params) => { const [rows] = await connection.query(sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params); return rows[0]; },
                    run: async (...params) => { const [result] = await connection.query(sql, params.length === 1 && Array.isArray(params[0]) ? params[0] : params); return { lastInsertRowid: result.insertId, changes: result.affectedRows }; }
                };
            };

            try {
                const result = await fn(...args);
                await connection.commit();
                return result;
            } catch (err) {
                await connection.rollback();
                throw err;
            } finally {
                db.prepare = originalPrepare;
                connection.release();
            }
        };
    }
};


// Asegurar que la columna es_puntual existe





// Asegurar columnas de rango en incidencias






// Helper para fecha local YYYY-MM-DD
const getLocalDate = () => {
    const d = new Date();
    const year = d.getFullYear();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

async function initDB() {
    try {
    await db.prepare('ALTER TABLE servicios ADD COLUMN es_puntual INTEGER DEFAULT 1').run();
} catch (e) {}
    try { await db.prepare('ALTER TABLE servicios ADD COLUMN hora_inicio_real TIME').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE servicios ADD COLUMN hora_fin_real TIME').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE incidencias ADD COLUMN fecha_inicio DATE').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE incidencias ADD COLUMN fecha_fin DATE').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE incidencias ADD COLUMN hora_inicio TIME').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE incidencias ADD COLUMN hora_fin TIME').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE incidencias ADD COLUMN todo_el_dia INTEGER DEFAULT 0').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE servicios ADD COLUMN tiene_boliador INTEGER DEFAULT 0').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE servicios ADD COLUMN nombre_boliador TEXT').run(); } catch (e) {}
    try { await db.prepare('ALTER TABLE horarios_caddie ADD COLUMN horas_disponibles JSON').run(); } catch (e) {}
}
initDB();

app.use(cors());
app.use(express.json());

// --- SISTEMA DE AUDITORIA ---
const registrarLog = async (usuarioNombre, rol, accion, detalles) => {
    try {
        const fechaStr = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
        const [datePart, timePart] = fechaStr.split(' ');
        const [mm, dd, yyyy] = datePart.split('/');
        const fechaDB = `${yyyy}-${mm}-${dd} ${timePart}`;

        const safeDetalles = { ...detalles };
        if (safeDetalles.password) delete safeDetalles.password;

        const stmt = await db.prepare('INSERT INTO logs_auditoria (fecha, usuario_nombre, rol, accion, detalles) VALUES (?, ?, ?, ?, ?)');
        await stmt.run(fechaDB, usuarioNombre, rol, accion, JSON.stringify(safeDetalles));
    } catch (e) {
        console.error('Error registrando log:', e);
    }
};

app.use(async (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api') && !req.path.startsWith('/api/auth') && !req.path.startsWith('/api/logs_auditoria')) {
        const adminNombre = req.headers['x-admin-nombre'];
        const adminRol = req.headers['x-admin-rol'];
        
        if (adminNombre && adminRol && adminRol !== 'Caddie') {
            res.on('finish', async () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    let accion = `${req.method} ${req.path}`;
                    let match;
                    let targetName = '';
                    let targetId = '';
                    
                    try {
                        const idMatch = req.path.match(/\/(\d+)(\/|$)/);
                        if (idMatch && idMatch[1]) {
                            targetId = idMatch[1];
                            if (req.path.includes('/usuarios') || req.path.includes('/caddies')) {
                                const u = await db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(targetId);
                                if (u) targetName = u.nombre;
                            } else if (req.path.includes('/servicios')) {
                                const s = await db.prepare('SELECT u.nombre FROM servicios s JOIN usuarios u ON s.caddie_id = u.id WHERE s.id = ?').get(targetId);
                                if (s) targetName = `(Caddie asignado: ${s.nombre})`;
                            } else if (req.path.includes('/backups')) {
                                const b = await db.prepare('SELECT u.nombre FROM backups_programados b JOIN usuarios u ON b.caddie_id = u.id WHERE b.id = ?').get(targetId);
                                if (b) targetName = `(Backup asignado a: ${b.nombre})`;
                            }
                        } else if (req.path === '/api/backups/manual' && req.body && req.body.caddie_id) {
                            const u = await db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.body.caddie_id);
                            if (u) {
                                targetName = u.nombre;
                                targetId = req.body.caddie_id;
                            }
                        }
                    } catch (e) {}

                    let targetStr = targetName ? targetName : (targetId ? `ID #${targetId}` : '');

                    if (req.path === '/api/servicios' && req.method === 'POST') accion = `Creó un nuevo turno para ${req.body.deporte || 'un deporte'}`;
                    else if ((match = req.path.match(/^\/api\/servicios\/(\d+)$/)) && req.method === 'DELETE') accion = `Eliminó el turno ${targetStr}`;
                    else if ((match = req.path.match(/^\/api\/servicios\/(\d+)\/estado$/)) && req.method === 'PATCH') accion = `Cambió el estado del turno ${targetStr} a '${req.body.estado || 'Desconocido'}'`;
                    else if ((match = req.path.match(/^\/api\/servicios\/(\d+)\/hora$/)) && req.method === 'PUT') accion = `Cambió la hora del turno ${targetStr} a '${req.body.hora || ''}'`;
                    else if ((match = req.path.match(/^\/api\/servicios\/(\d+)\/confirmar$/))) accion = `Confirmó/Rechazó o Reasignó el turno ${targetStr}`;
                    else if (req.path === '/api/caddies' && req.method === 'POST') accion = `Registró al nuevo Caddie: ${req.body.nombre || ''}`;
                    else if ((match = req.path.match(/^\/api\/caddies\/(\d+)$/)) && req.method === 'PUT') accion = `Editó los datos de ${targetStr}`;
                    else if ((match = req.path.match(/^\/api\/usuarios\/(\d+)$/)) && req.method === 'PUT') {
                        if (req.body.estado) accion = `Cambió el estado a '${req.body.estado}' para ${targetStr}`;
                        else accion = `Editó los datos de ${targetStr}`;
                    }
                    else if ((match = req.path.match(/^\/api\/caddies\/(\d+)\/horario$/)) && req.method === 'PUT') {
                        let diasActivos = [];
                        if (req.body && req.body.horario && Array.isArray(req.body.horario)) {
                            const nombresDias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
                            req.body.horario.forEach(diaInfo => {
                                if (diaInfo.manana || diaInfo.tarde || (diaInfo.horas_disponibles && diaInfo.horas_disponibles.length > 0)) {
                                    if (nombresDias[diaInfo.dia]) diasActivos.push(nombresDias[diaInfo.dia]);
                                }
                            });
                        }
                        const diasStr = diasActivos.length > 0 ? ` (Días activos: ${diasActivos.join(', ')})` : ' (Sin días activos)';
                        accion = `Actualizó el horario semanal de ${targetStr}${diasStr}`;
                    }
                    else if ((match = req.path.match(/^\/api\/caddies\/(\d+)\/estado$/)) && req.method === 'PATCH') accion = `Cambió el estado a '${req.body.estado}' de ${targetStr}`;
                    else if ((match = req.path.match(/^\/api\/caddies\/(\d+)$/)) && req.method === 'DELETE') accion = `Eliminó a ${targetStr}`;
                    else if (req.path === '/api/perfil/estado-club' && req.method === 'POST') accion = `Marcó Entrada/Salida de Caddie en el Club`;
                    else if (req.path === '/api/backups' && req.method === 'POST') accion = `Programó Backups Inteligentes para la fecha: ${req.body.fecha || ''}`;
                    else if (req.path === '/api/backups/manual' && req.method === 'POST') accion = `Asignó Backup Manual a ${targetStr}`;
                    else if ((match = req.path.match(/^\/api\/backups\/(\d+)$/)) && req.method === 'DELETE') accion = `Eliminó Backup ${targetStr}`;
                    else if ((match = req.path.match(/^\/api\/backups\/(\d+)$/)) && req.method === 'PUT') {
                        let newName = req.body.caddie_id;
                        try {
                           const u = await db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(req.body.caddie_id);
                           if (u) newName = u.nombre;
                        } catch(e) {}
                        accion = `Modificó Backup ${targetStr} (Nuevo Caddie: ${newName})`;
                    }
                    
                    await registrarLog(adminNombre, adminRol, accion, { path: req.path, method: req.method, body: req.body });
                }
            });
        }
    }
    next();
});

// Endpoint para leer logs
app.get('/api/logs_auditoria', async (req, res) => {
    try {
        const logs = await db.prepare('SELECT * FROM logs_auditoria ORDER BY fecha DESC LIMIT 500').all();
        res.json(logs);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/incidencias', async (req, res) => {
    try {
        const incidencias = await db.prepare(`SELECT i.*, u.nombre as caddie_nombre FROM incidencias i LEFT JOIN usuarios u ON i.reportado_por_id = u.id ORDER BY i.id DESC`).all();
        res.json(incidencias);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


// Servir archivos estáticos del frontend (cuando se construya)
app.use(express.static(path.join(__dirname, '../client/dist')));

// Configuración de Multer para importaciones
const upload = multer({ dest: 'uploads/' });
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- RUTAS DE LA API ---

// Login Seguro
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const user = await db.prepare('SELECT u.id, u.nombre, u.email, u.password, u.rol_id, u.deporte, r.nombre as rol FROM usuarios u JOIN roles r ON u.rol_id = r.id WHERE email = ?')
                      .get(email);
        
        if (user) {
            // Verificar contraseña (soporte temporal para texto plano durante migración, luego solo bcrypt)
            let passwordMatch = false;
            
            if (user.password.startsWith('$2a$') || user.password.startsWith('$2b$')) {
                passwordMatch = bcrypt.compareSync(password, user.password);
            } else {
                // Fallback para contraseñas antiguas
                passwordMatch = (password === user.password);
                // Opcionalmente: actualizar a hash automáticamente aquí
            }

            if (passwordMatch) {
                // Bloqueo temporal: Solo permitir Admin y Coordinador
                const allowedRoles = ['Administrador', 'Coordinador'];
                if (!allowedRoles.includes(user.rol)) {
                    return res.status(403).json({ success: false, message: 'Acceso restringido: Solo el personal administrativo puede ingresar al sistema.' });
                }
                const { password: _, ...userData } = user;
                // Registrar log de inicio de sesión
                await registrarLog(user.nombre, user.rol, 'Inició sesión en el sistema', {});
                res.json({ success: true, user: userData });
            } else {
                res.status(401).json({ success: false, message: 'Credenciales inválidas' });
            }
        } else {
            res.status(401).json({ success: false, message: 'Credenciales inválidas' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error en el servidor' });
    }
});

// Obtener roles
app.get('/api/roles', async (req, res) => {
    const roles = await db.prepare('SELECT * FROM roles').all();
    res.json(roles);
});

// --- MÓDULO DE CADDIES ---

// Listar caddies filtrados por deporte si se especifica
app.get('/api/caddies', async (req, res) => {
    const { deporte, estado } = req.query;
    try {
        let conditions = ["u.rol_id = 4"];
        let params = [];

        if (deporte && deporte !== 'Ambos') {
            conditions.push("(u.deporte = ? OR u.deporte = 'Ambos')");
            params.push(deporte);
        }

        if (estado && estado !== 'Todos') {
            conditions.push("u.estado = ? ");
            params.push(estado);
        }

        let query = `
            SELECT 
                u.id, u.nombre, u.email, u.estado, u.deporte,
                p.horas_acumuladas, p.calificacion, p.disponibilidad, p.esta_en_club, p.fecha_entrada_club, p.turno_backup, p.deporte_backup,
                (SELECT JSON_ARRAYAGG(
                    json_object(
                        'dia', dia_semana, 
                        'manana', manana, 
                        'tarde', tarde, 
                        'estudio', es_estudio,
                        'horas_disponibles', horas_disponibles
                    )
                ) FROM horarios_caddie WHERE usuario_id = u.id) as horario
            FROM usuarios u
            LEFT JOIN perfiles_caddie p ON u.id = p.usuario_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY u.nombre ASC
        `;
        const [caddies] = await pool.query(query, params);

        // Parsear el JSON del horario
        const result = caddies.map(c => ({
            ...c,
            horario: typeof c.horario === 'string' ? JSON.parse(c.horario || '[]') : (c.horario || [])
        }));

        res.json(result);
    } catch (error) {
        console.error('ERROR API CADDIES:', error.message);
        console.error('QUERY WAS:', query);
        console.error('PARAMS WERE:', params);
        res.status(500).json({ success: false, message: 'Error recuperando caddies', detail: error.message, stack: error.stack });
    }
});

// Actualizar horario de un caddie
app.put('/api/caddies/:id/horario', async (req, res) => {
    const { id } = req.params;
    const { horario } = req.body; // Array de 7 días

    try {
        const updateStmt = await db.prepare(`
            INSERT INTO horarios_caddie (usuario_id, dia_semana, manana, tarde, es_estudio, horas_disponibles)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE manana=VALUES(manana), tarde=VALUES(tarde), es_estudio=VALUES(es_estudio), horas_disponibles=VALUES(horas_disponibles)
        `);

        const transaction = db.transaction(async (data) => {
            for (const day of data) {
                const horasJson = JSON.stringify(day.horas_disponibles || []);
                await updateStmt.run(id, day.dia, day.manana, day.tarde, day.estudio, horasJson);
            }
        });

        await transaction(horario);
        res.json({ success: true, message: 'Horario actualizado' });
    } catch (error) {
        console.error('Error actualizando horario:', error);
        res.status(500).json({ success: false, message: 'Error actualizando horario' });
    }
});

// Generar Cronograma de Tenis Fin de Semana
app.post('/api/cronograma/tenis-fin-semana', async (req, res) => {
    const { fecha } = req.body;
    if (!fecha) return res.status(400).json({ success: false, message: 'La fecha es obligatoria' });

    try {
        const transaction = db.transaction(async () => {
            // 1. Obtener todas las canchas (30 de tenis + 3 de mini tenis)
            const canchas = await db.prepare(`
                SELECT id, nombre FROM usuarios 
                WHERE (nombre LIKE 'Cancha %' OR nombre LIKE 'Mini Tenis %') AND rol_id = 3 
            `).all();

            // Ordenar estricamente en JS para evitar problemas de compatibilidad SQL
            canchas.sort((a, b) => {
                const isMiniA = a.nombre.toLowerCase().includes('mini');
                const isMiniB = b.nombre.toLowerCase().includes('mini');
                if (isMiniA !== isMiniB) return isMiniA ? 1 : -1;
                
                const numA = parseInt((a.nombre.match(/\d+/) || [0])[0], 10);
                const numB = parseInt((b.nombre.match(/\d+/) || [0])[0], 10);
                if (numA !== numB) return numA - numB;
                
                return a.nombre.localeCompare(b.nombre);
            });

            if (canchas.length === 0) {
                throw new Error('No se encontraron las canchas virtuales en la base de datos.');
            }

            // 2. Obtener caddies disponibles para Tenis ese día en la mañana (asumiendo inicio 07:00)
            const [y, m, d_part] = fecha.split('-').map(Number);
            const dateObj = new Date(y, m - 1, d_part);
            let diaJS = dateObj.getDay();
            const festivos = ['2026-07-13', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25'];
            if (festivos.includes(fecha)) diaJS = 0; // Tratar festivo como Domingo
            let diaProcesado = diaJS === 0 ? 6 : diaJS - 1;
            
            const esHoy = (fecha === getLocalDate());

            const caddiesDisponibles = await db.prepare(`
                SELECT u.id, u.nombre, p.horas_acumuladas, p.esta_en_club
                FROM usuarios u
                JOIN perfiles_caddie p ON u.id = p.usuario_id
                JOIN horarios_caddie h ON u.id = h.usuario_id
                WHERE u.rol_id = 4 
                  AND u.estado = 'Activo'
                  AND h.dia_semana = ? 
                  AND h.es_estudio = 0
                  AND (h.manana = 1 OR h.tarde = 1 OR p.turno_backup = 'tarde')
                  AND (u.deporte = 'Tenis' OR u.deporte = 'Ambos')
                  AND u.id NOT IN (
                      SELECT caddie_id FROM servicios 
                      WHERE fecha_servicio = ? AND estado IN ('Pendiente', 'En Juego') AND caddie_id IS NOT NULL
                      UNION
                      SELECT caddie_id FROM asignaciones_canchas WHERE fecha = ?
                  )
            `).all(diaProcesado, fecha, fecha);

            // Ordenar equitativamente
            caddiesDisponibles.sort((a, b) => {
                if (esHoy && a.esta_en_club !== b.esta_en_club) {
                    return b.esta_en_club - a.esta_en_club;
                }
                return a.horas_acumuladas - b.horas_acumuladas;
            });

            // 3. Asignar Caddies a Canchas
            const insertStmt = await db.prepare(`
                INSERT INTO asignaciones_canchas (fecha, cancha_id, caddie_id) 
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE caddie_id = VALUES(caddie_id)
            `);

            let asignados = 0;
            const asignaciones = [];
            const canchaCaddiePairs = [];

            // MAPA DE CADDIES FIJOS PARA FIN DE SEMANA
            const caddiesFijosCanchas = {
                1: 75,
                2: 150,
                3: 81,
                4: 90,
                5: 104,
                13: 131,
                14: 175,
                15: 158,
                16: 99,
                17: 183,
                18: 87
            };

            const caddiesFijosMini = {
                1: 69, // Andrés Mauricio Huertas
                2: 95  // David Alejandro Velásquez
            };

            // Novedad: Filtrar los backups de la mañana para NO asignarlos a canchas completas
            const backupsMananaDB = await db.prepare("SELECT caddie_id FROM backups_programados WHERE fecha = ? AND turno = 'mañana' AND (deporte = 'Tenis' OR deporte = 'Ambos')").all(fecha);
            const backupMananaIds = new Set(backupsMananaDB.map(b => b.caddie_id));

            let caddiesRestantes = caddiesDisponibles.filter(c => !backupMananaIds.has(c.id));

            for (const cancha of canchas) {
                let caddieSeleccionado = null;
                
                // Verificar si la cancha tiene un caddie fijo asignado
                const numMatch = cancha.nombre.match(/\d+/);
                const isMini = cancha.nombre.toLowerCase().includes('mini');
                
                if (isMini && numMatch && parseInt(numMatch[0], 10) === 3) {
                    continue; // Requerimiento: No asignar caddie a Mini Tenis 3 por defecto
                }
                
                if (numMatch) {
                    const numCancha = parseInt(numMatch[0], 10);
                    const fijoId = isMini ? caddiesFijosMini[numCancha] : caddiesFijosCanchas[numCancha];
                    
                    if (fijoId) {
                        // Verificar si este caddie fijo está como backup de mañana. Si lo está, no lo forzamos.
                        const isBackupManana = await db.prepare("SELECT 1 FROM backups_programados WHERE fecha = ? AND turno = 'mañana' AND caddie_id = ?").get(fecha, fijoId);
                        
                        if (!isBackupManana) {
                            const idx = caddiesRestantes.findIndex(c => c.id === fijoId);
                            if (idx !== -1) {
                                // El caddie fijo está disponible, se asigna y se quita de los restantes
                                caddieSeleccionado = caddiesRestantes.splice(idx, 1)[0];
                            } else {
                                // FORZAR ASIGNACIÓN: El caddie es fijo, asignarlo SÍ O SÍ
                                const caddieForzado = await db.prepare('SELECT u.id, u.nombre, p.esta_en_club FROM usuarios u JOIN perfiles_caddie p ON u.id = p.usuario_id WHERE u.id = ?').get(fijoId);
                                if (caddieForzado) {
                                    caddieSeleccionado = caddieForzado;
                                }
                            }
                        }
                    }
                }

                // Si no hubo caddie fijo (o no estaba disponible), usar el siguiente de la lista
                if (!caddieSeleccionado && caddiesRestantes.length > 0) {
                    caddieSeleccionado = caddiesRestantes.shift();
                }
                
                if (caddieSeleccionado) {
                    await insertStmt.run(fecha, cancha.id, caddieSeleccionado.id);
                    
                    asignados++;
                    asignaciones.push({ 
                        id: caddieSeleccionado.id, 
                        nombre: caddieSeleccionado.nombre, 
                        cancha: cancha.nombre,
                        hora_inicio_programada: '07:00', 
                        esta_en_club: caddieSeleccionado.esta_en_club 
                    });
                    canchaCaddiePairs.push({ cancha_id: cancha.id, caddie_id: caddieSeleccionado.id });
                } else {
                    // Ya no hay más caddies disponibles para repartir
                    break;
                }
            }

            // LIMPIEZA DE BACKUPS (ROBO INTELIGENTE)
            // Cualquier caddie que haya sido robado de la lista de backups para asignarlo a una cancha, se elimina de los backups.
            if (canchaCaddiePairs.length > 0) {
                const assignedCaddieIds = canchaCaddiePairs.map(p => p.caddie_id);
                const placeholders = assignedCaddieIds.map(() => '?').join(',');
                await db.prepare(`DELETE FROM backups_programados WHERE fecha = ? AND caddie_id IN (${placeholders})`).run(fecha, ...assignedCaddieIds);
            }

            // 4. Distribuir los turnos (servicios) importados - asignar caddies
            if (canchaCaddiePairs.length > 0) {
                // Obtener servicios de tenis sin caddie para esta fecha
                const serviciosPendientes = await db.prepare(`
                    SELECT id, hora_inicio_programada, cancha_id 
                    FROM servicios 
                    WHERE fecha_servicio = ? 
                    AND deporte = 'Tenis' 
                    AND estado IN ('Pendiente', 'En Juego') 
                    AND caddie_id IS NULL
                    ORDER BY hora_inicio_programada ASC
                `).all(fecha);

                // Agrupar por hora
                const serviciosPorHora = {};
                for (const serv of serviciosPendientes) {
                    const hora = serv.hora_inicio_programada;
                    if (!serviciosPorHora[hora]) serviciosPorHora[hora] = [];
                    serviciosPorHora[hora].push(serv);
                }

                // Stmt para cuando NO tiene cancha (asignar ambos)
                const updateBothStmt = await db.prepare(`
                    UPDATE servicios 
                    SET cancha_id = ?, caddie_id = ? 
                    WHERE id = ?
                `);
                // Stmt para cuando YA tiene cancha del Excel (solo asignar caddie)
                const updateCaddieOnlyStmt = await db.prepare(`
                    UPDATE servicios 
                    SET caddie_id = ? 
                    WHERE id = ?
                `);

                // Mapa rápido de cancha -> caddie asignado para hoy
                const courtToCaddieMap = new Map();
                canchaCaddiePairs.forEach(p => courtToCaddieMap.set(p.cancha_id, p.caddie_id));

                // Asignar caddies, respetando estrictamente que 1 caddie = 1 cancha todo el día
                for (const hora in serviciosPorHora) {
                    const serviciosHora = serviciosPorHora[hora];
                    
                    // OBVIAR LOS JUGADORES / EXCEL: ignoramos por completo cualquier cancha
                    // que haya traído el archivo Excel. Empezamos con la lista limpia.
                    const canchasOcupadasEstaHora = new Set();

                    for (const servicio of serviciosHora) {
                        // OBVIAR LOS JUGADORES / EXCEL: Ignoramos si el Excel traia una cancha.
                        // Asignamos estrictamente secuencial desde Cancha 1 usando los caddies disponibles.
                        const parDisponible = canchaCaddiePairs.find(p => !canchasOcupadasEstaHora.has(p.cancha_id));
                        if (parDisponible) {
                            canchasOcupadasEstaHora.add(parDisponible.cancha_id);
                            await updateBothStmt.run(parDisponible.cancha_id, parDisponible.caddie_id, servicio.id);
                        }
                    }
                }

                // FORZAR SINCRONIZACIÓN: Cualquier partido (antiguo o nuevo) en estas canchas 
                // debe tener el caddie oficial del día asignado, para que el PDF y la UI coincidan 100%.
                const forceSyncStmt = await db.prepare("UPDATE servicios SET caddie_id = ? WHERE fecha_servicio = ? AND deporte = 'Tenis' AND cancha_id = ?");
                for (const par of canchaCaddiePairs) {
                    await forceSyncStmt.run(par.caddie_id, fecha, par.cancha_id);
                }
            }

            return { asignados, asignaciones };
        });

        const resultado = await transaction();
        res.json({ success: true, message: `Cronograma generado: ${resultado.asignados} canchas asignadas.`, data: resultado });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message || 'Error al generar el cronograma' });
    }
});

// Obtener asignaciones de canchas (1 caddie = 1 cancha todo el dia)
app.get('/api/asignaciones_canchas', async (req, res) => {
    const { fecha } = req.query;
    try {
        const asignaciones = await db.prepare(`
            SELECT a.fecha, u_cancha.nombre as cancha_nombre, u_caddie.nombre as caddie_nombre
            FROM asignaciones_canchas a
            JOIN usuarios u_cancha ON a.cancha_id = u_cancha.id
            JOIN usuarios u_caddie ON a.caddie_id = u_caddie.id
            WHERE a.fecha = ?
            ORDER BY 
                CASE WHEN u_cancha.nombre LIKE 'Cancha %' THEN 0 ELSE 1 END,
                CAST(REGEXP_REPLACE(u_cancha.nombre, '[^0-9]', '') AS UNSIGNED)
        `).all(fecha);
        res.json(asignaciones);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al obtener asignaciones' });
    }
});

// --- MÓDULO DE SERVICIOS ---

// Obtener servicios (filtrados por deporte, mes y anio si se especifica)
app.get('/api/servicios', async (req, res) => {
    const { deporte, mes, anio, socio_id, caddie_id } = req.query;
    try {
        const hoy = getLocalDate();
        const ahora = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

        /* Auto-expiración removida temporalmente por causar reseteo de asignaciones en tiempo real
        const pendingTurns = db.prepare(`
            SELECT id, hora_inicio_programada 
            FROM servicios 
            WHERE estado = 'Pendiente' 
            AND estado_confirmacion = 'Pendiente' 
            AND caddie_id IS NOT NULL
            AND fecha_servicio = ?
        `).all(hoy);

        pendingTurns.forEach(t => {
            if (t.hora_inicio_programada) {
                const [h, m] = t.hora_inicio_programada.split(':').map(Number);
                const limitMin = h * 60 + m - 15;
                const [currH, currM] = ahora.split(':').map(Number);
                const currMin = currH * 60 + currM;

                if (currMin > limitMin) {
                    await db.prepare("UPDATE servicios SET estado_confirmacion = 'Pendiente', caddie_id = NULL WHERE id = ?").run(t.id);
                }
            }
        });
        */

        let query = `
            SELECT 
                s.*, 
                u1.nombre as jugador_nombre, 
                u2.nombre as caddie_nombre,
                p2.esta_en_club as caddie_en_club,
                u3.nombre as cancha_nombre,
                s.tee
            FROM servicios s
            JOIN usuarios u1 ON s.socio_id = u1.id
            LEFT JOIN usuarios u2 ON s.caddie_id = u2.id
            LEFT JOIN perfiles_caddie p2 ON u2.id = p2.usuario_id
            LEFT JOIN usuarios u3 ON s.cancha_id = u3.id
            WHERE 1=1
        `;
        
        const params = [];
        if (deporte && deporte !== 'Ambos') {
            query += ' AND s.deporte = ?';
            params.push(deporte);
        }
        if (socio_id) {
            query += ' AND s.socio_id = ?';
            params.push(socio_id);
        }
        if (caddie_id) {
            query += ' AND s.caddie_id = ?';
            params.push(caddie_id);
        }
        if (mes && anio) {
            query += " AND YEAR(s.fecha_servicio) = ? AND MONTH(s.fecha_servicio) = ?";
            params.push(anio.toString(), mes.toString().padStart(2, '0'));
        }
        if (req.query.estado) {
            query += ' AND s.estado = ?';
            params.push(req.query.estado);
        }
        if (req.query.fecha) {
            query += ' AND s.fecha_servicio = ?';
            params.push(req.query.fecha);
        }
        query += ' ORDER BY s.fecha_servicio DESC, s.hora_inicio_programada ASC, u3.nombre ASC LIMIT 1000';
        
        const servicios = await db.prepare(query).all(...params);
        res.json(servicios);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error recuperando servicios' });
    }
});

// Obtener todas las canchas (Para listados en manual)
app.get('/api/canchas', async (req, res) => {
    try {
        const query = `
            SELECT id, nombre FROM usuarios 
            WHERE (nombre LIKE 'Cancha %' OR nombre LIKE 'Mini Tenis %') AND rol_id = 3 
            ORDER BY CASE WHEN nombre LIKE 'Cancha %' THEN 0 ELSE 1 END, CAST(REGEXP_REPLACE(nombre, '[^0-9]', '') AS UNSIGNED)
        `;
        const canchas = await db.prepare(query).all();
        res.json(canchas);
    } catch (error) {
        res.status(500).json({ error: 'Error recuperando todas las canchas' });
    }
});

// Listar canchas disponibles para asignación
app.get('/api/canchas/disponibles', async (req, res) => {
    const { fecha, hora } = req.query; // fecha: YYYY-MM-DD
    if (!fecha) return res.status(400).json({ error: 'Falta fecha' });

    try {
        // Obtenemos canchas que tienen caddie asignado hoy
        // Y que no están "En Juego" ni tienen turno "Pendiente" en esa misma hora exacta
        const query = `
            SELECT c.id as cancha_id, c.nombre as cancha_nombre, 
                   cad.id as caddie_id, cad.nombre as caddie_nombre
            FROM asignaciones_canchas ac
            JOIN usuarios c ON ac.cancha_id = c.id
            JOIN usuarios cad ON ac.caddie_id = cad.id
            WHERE ac.fecha = ?
            AND c.id NOT IN (
                SELECT cancha_id FROM servicios
                WHERE fecha_servicio = ?
                AND cancha_id IS NOT NULL
                AND (estado = 'En Juego' OR (estado = 'Pendiente' AND hora_inicio_programada = ?))
            )
            ORDER BY CASE WHEN c.nombre LIKE 'Cancha %' THEN 0 ELSE 1 END, CAST(REGEXP_REPLACE(c.nombre, '[^0-9]', '') AS UNSIGNED)
        `;
        const canchas = await db.prepare(query).all(fecha, fecha, hora);
        res.json(canchas);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error recuperando canchas' });
    }
});

app.get('/api/canchas/asignaciones', async (req, res) => {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Falta fecha' });

    try {
        const query = `
            SELECT c.id as cancha_id, ? as fecha, c.nombre as cancha_nombre, 
                   cad.nombre as caddie_nombre, cad.id as caddie_id,
                   ac.estado, ac.caddie_tarde_id, cad_tarde.nombre as caddie_tarde_nombre
            FROM usuarios c
            LEFT JOIN asignaciones_canchas ac ON c.id = ac.cancha_id AND ac.fecha = ?
            LEFT JOIN usuarios cad ON ac.caddie_id = cad.id
            LEFT JOIN usuarios cad_tarde ON ac.caddie_tarde_id = cad_tarde.id
            WHERE (c.nombre LIKE 'Cancha %' OR c.nombre LIKE 'Mini Tenis %') AND c.rol_id = 3 AND c.estado = 'Activo'
        `;
        const asignaciones = await db.prepare(query).all(fecha, fecha);
        
        asignaciones.sort((a, b) => {
            const isMiniA = a.cancha_nombre.toLowerCase().includes('mini');
            const isMiniB = b.cancha_nombre.toLowerCase().includes('mini');
            if (isMiniA !== isMiniB) return isMiniA ? 1 : -1;
            
            const numA = parseInt((a.cancha_nombre.match(/\d+/) || [0])[0], 10);
            const numB = parseInt((b.cancha_nombre.match(/\d+/) || [0])[0], 10);
            if (numA !== numB) return numA - numB;
            
            return a.cancha_nombre.localeCompare(b.cancha_nombre);
        });

        res.json(asignaciones);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error recuperando asignaciones' });
    }
});

app.patch('/api/canchas/asignaciones/estado', async (req, res) => {
    const { fecha, cancha_id, estado } = req.body;
    if (!fecha || !cancha_id || !estado) return res.status(400).json({ success: false, message: 'Faltan parámetros' });
    try {
        await db.prepare(`
            UPDATE asignaciones_canchas 
            SET estado = ? 
            WHERE fecha = ? AND cancha_id = ?
        `).run(estado, fecha, cancha_id);
        res.json({ success: true });
    } catch(err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

app.patch('/api/canchas/asignaciones/tarde', async (req, res) => {
    const { fecha, cancha_id, caddie_tarde_id } = req.body;
    if (!fecha || !cancha_id || !caddie_tarde_id) return res.status(400).json({ success: false, message: 'Faltan parámetros' });
    
    try {
        // 1. Update asignaciones_canchas
        await db.prepare(`
            UPDATE asignaciones_canchas 
            SET caddie_tarde_id = ? 
            WHERE fecha = ? AND cancha_id = ?
        `).run(caddie_tarde_id, fecha, cancha_id);

        // 2. Cascade update servicios >= 13:00 for that date and court
        // This ensures the afternoon backup takes over matches starting 1:00 PM or later
        await db.prepare(`
            UPDATE servicios 
            SET caddie_id = ? 
            WHERE fecha_servicio = ? AND deporte = 'Tenis' AND cancha_id = ? AND hora_inicio_programada >= '13:00:00'
        `).run(caddie_tarde_id, fecha, cancha_id);
        
        res.json({ success: true });
    } catch(err) {
        console.error(err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Crear nuevo servicio
app.post('/api/servicios', async (req, res) => {
    const { socio_id, caddie_id, fecha_servicio, hora_inicio_programada, observaciones, deporte } = req.body;
    try {
        const info = await db.prepare(`
            INSERT INTO servicios (socio_id, caddie_id, fecha_servicio, hora_inicio_programada, estado, observaciones, deporte)
            VALUES (?, ?, ?, ?, 'Pendiente', ?, ?)
        `).run(socio_id, caddie_id, fecha_servicio, hora_inicio_programada, observaciones, deporte);
        
        res.json({ success: true, id: info.lastInsertRowid });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error creando servicio' });
    }
});

// Actualizar estado de un servicio (Flujo de Equidad)
app.patch('/api/servicios/:id/estado', async (req, res) => {
    const { id } = req.params;
    const { estado, horas_reales, bypass_horario } = req.body;
    
    try {
        const transaction = db.transaction(async () => {
            // 1. Obtener datos actuales del servicio
            const servicio = await db.prepare('SELECT caddie_id, estado, fecha_servicio, hora_inicio_real, hora_inicio_programada, horas_reales FROM servicios WHERE id = ?').get(id);
            if (!servicio) throw new Error('Servicio no encontrado');

            const hoy = getLocalDate();
            const ahora = new Date().toLocaleTimeString('en-US', {hour12: false, hour: '2-digit', minute:'2-digit'});
            
            if (estado === 'En Juego' && !bypass_horario) {
                if (servicio.fecha_servicio > hoy) {
                    throw new Error('No se puede iniciar un acompañamiento de una fecha futura.');
                }
                
                if (!servicio.hora_inicio_programada) {
                    throw new Error('El servicio no tiene una hora programada válida.');
                }

                // Validación de ventana de 15 minutos (antes y después)
                const [progH, progM] = servicio.hora_inicio_programada.split(':').map(Number);
                const [currH, currM] = ahora.split(':').map(Number);
                
                const progTotalMin = progH * 60 + progM;
                const currTotalMin = currH * 60 + currM;
                const diff = currTotalMin - progTotalMin;

                if (servicio.fecha_servicio === hoy) {
                    if (diff < -15) {
                        throw new Error(`Demasiado pronto. Solo puedes iniciar a partir de las ${formatTime(progTotalMin - 15)}.`);
                    }
                    if (diff > 15) {
                        throw new Error(`Demasiado tarde. El tiempo límite de inicio era a las ${formatTime(progTotalMin + 15)}.`);
                    }
                }
            }

            // 2. Actualizar el estado del servicio y registrar tiempos
            let finalHorasReales = horas_reales;

            if (estado === 'En Juego') {
                await db.prepare('UPDATE servicios SET hora_inicio_real = COALESCE(hora_inicio_real, ?) WHERE id = ?').run(ahora, id);
            } else if (estado === 'Completado') {
                await db.prepare('UPDATE servicios SET hora_fin_real = COALESCE(hora_fin_real, ?) WHERE id = ?').run(ahora, id);
                
                // Si no se pasaron horas reales desde el cliente (o para forzar cálculo automático)
                if (!horas_reales) {
                    const hInicio = servicio.hora_inicio_real || servicio.hora_inicio_programada;
                    finalHorasReales = calcularHorasReales(hInicio, ahora);
                }
            }

            const updateStmt = await db.prepare('UPDATE servicios SET estado = ?, horas_reales = ? WHERE id = ?');
            updateStmt.run(estado, finalHorasReales, id);

            // 3. Gestión de Horas Acumuladas
            if (estado === 'Completado' && servicio.estado !== 'Completado' && servicio.caddie_id) {
                // Acreditar horas
                const horas = finalHorasReales || 4.5;
                db.prepare('UPDATE perfiles_caddie SET horas_acumuladas = horas_acumuladas + ? WHERE usuario_id = ?')
                  .run(horas, servicio.caddie_id);
                console.log(`✅ Acreditadas ${horas}h al caddie #${servicio.caddie_id}`);
            } else if (servicio.estado === 'Completado' && estado !== 'Completado' && servicio.caddie_id) {
                // Revertir horas si el servicio deja de estar completado
                const horas = servicio.horas_reales || 4.5;
                db.prepare('UPDATE perfiles_caddie SET horas_acumuladas = MAX(0, horas_acumuladas - ?) WHERE usuario_id = ?')
                  .run(horas, servicio.caddie_id);
                console.log(`⏪ Revertidas ${horas}h al caddie #${servicio.caddie_id} (Cambio de estado)`);
            }
        });

        await transaction();
        res.json({ success: true, message: `Estado actualizado a ${estado}` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Actualizar HORA de un servicio (Nueva funcionalidad administrativa)
app.patch('/api/servicios/:id/hora', async (req, res) => {
    const { id } = req.params;
    const { nueva_hora } = req.body;
    try {
        if (!nueva_hora) throw new Error('La hora es requerida');
        db.prepare('UPDATE servicios SET hora_inicio_programada = ? WHERE id = ?').run(nueva_hora, id);
        res.json({ success: true, message: 'Hora actualizada correctamente' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});
  // Reasignar una Cancha Completa (Tenis Finde)
  app.post('/api/canchas/asignar', async (req, res) => {
      const { cancha_id, caddie_id, fecha, prev_caddie_id, prev_caddie_backup_action } = req.body;
      if (!cancha_id || !caddie_id || !fecha) {
          return res.status(400).json({ success: false, message: 'Faltan parámetros requeridos' });
      }
      try {
          // 1. Actualizar asignaciones_canchas
          await db.prepare(`
              INSERT INTO asignaciones_canchas (fecha, cancha_id, caddie_id) 
              VALUES (?, ?, ?) 
              ON DUPLICATE KEY UPDATE caddie_id = VALUES(caddie_id)
          `).run(fecha, cancha_id, caddie_id);
  
          // 2. Sincronizar todos los servicios de tenis de ese día para esa cancha (turno mañana)
          // Aquellos programados antes de la 1pm o sin hora
          await db.prepare(`
              UPDATE servicios 
              SET caddie_id = ? 
              WHERE fecha_servicio = ? AND deporte = 'Tenis' AND cancha_id = ? AND (hora_inicio_programada < '13:00:00' OR hora_inicio_programada IS NULL)
          `).run(caddie_id, fecha, cancha_id);

          // 3. Manejo de backup caddie
          const getLocalDate = () => {
    const formatter = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Bogota', 
        year: 'numeric', 
        month: '2-digit', 
        day: '2-digit' 
    });
    return formatter.format(new Date()); // Retorna YYYY-MM-DD
}
          if (prev_caddie_id && prev_caddie_backup_action) {
              const hoyStr = getLocalDate();
              
              const turnoNormalizado = prev_caddie_backup_action === 'Mañana' ? 'Mañana' : 'Tarde';
              
              if (fecha === hoyStr) {
                  await db.prepare(`
                      UPDATE perfiles_caddie 
                      SET esta_en_club = 1, turno_backup = ?, deporte_backup = 'Tenis', fecha_entrada_club = CURRENT_TIMESTAMP
                      WHERE usuario_id = ?
                  `).run(turnoNormalizado, prev_caddie_id);
              } else {
                  await db.prepare(`
                      INSERT INTO backups_programados (caddie_id, fecha, turno, deporte)
                      VALUES (?, ?, ?, 'Tenis')
                      ON DUPLICATE KEY UPDATE turno = VALUES(turno)
                  `).run(prev_caddie_id, fecha, turnoNormalizado);
              }
          }
  
          res.json({ success: true, message: 'Cancha reasignada exitosamente' });
      } catch (error) {
          res.status(500).json({ success: false, message: error.message });
      }
  });

  // Reasignar Caddie a un turno existente
app.patch('/api/servicios/:id/asignar', async (req, res) => {
    const { id } = req.params;
    const { caddie_id, cancha_id } = req.body;
    try {
        const [servicio] = await db.prepare('SELECT fecha_servicio, hora_inicio_programada, deporte, cancha_id FROM servicios WHERE id = ?').all(id);
        if (!servicio) throw new Error('Servicio no encontrado');

        const [y, m, d_part] = servicio.fecha_servicio.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d_part);
        const diaJS = dateObj.getDay();
        const festivos = ['2026-07-13', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25'];
        const isWeekendTennis = servicio.deporte === 'Tenis' && (diaJS === 0 || diaJS === 6 || festivos.includes(servicio.fecha_servicio));

        if (cancha_id && caddie_id) {
            // Asignación de ambos
            const [ocupado] = await db.prepare(`
                SELECT id FROM servicios 
                WHERE fecha_servicio = ? 
                AND hora_inicio_programada = ? 
                AND cancha_id = ? 
                AND estado NOT IN ('Cancelado')
                AND id != ?
            `).all(servicio.fecha_servicio, servicio.hora_inicio_programada, cancha_id, id);
            
            if (ocupado) {
                throw new Error('La cancha seleccionada ya está ocupada en este horario.');
            }
            
            if (isWeekendTennis) {
                await db.prepare("UPDATE servicios SET caddie_id = ?, estado_confirmacion = 'Pendiente', reporto_llegada = 0, es_puntual = NULL, ubicacion_verificada = 0 WHERE fecha_servicio = ? AND cancha_id = ? AND deporte = 'Tenis'").run(caddie_id, servicio.fecha_servicio, cancha_id);
                const hasAsignacion = await db.prepare("SELECT caddie_id FROM asignaciones_canchas WHERE fecha = ? AND cancha_id = ?").get(servicio.fecha_servicio, cancha_id);
                if (hasAsignacion) {
                    await db.prepare("UPDATE asignaciones_canchas SET caddie_id = ? WHERE fecha = ? AND cancha_id = ?").run(caddie_id, servicio.fecha_servicio, cancha_id);
                } else {
                    await db.prepare("INSERT INTO asignaciones_canchas (fecha, cancha_id, caddie_id) VALUES (?, ?, ?)").run(servicio.fecha_servicio, cancha_id, caddie_id);
                }
                await db.prepare("UPDATE servicios SET cancha_id = ? WHERE id = ?").run(cancha_id, id);
            } else {
                await db.prepare("UPDATE servicios SET caddie_id = ?, cancha_id = ?, estado_confirmacion = 'Pendiente', reporto_llegada = 0, es_puntual = NULL, ubicacion_verificada = 0 WHERE id = ?").run(caddie_id, cancha_id, id);
            }
        } else if (cancha_id) {
            // Solo Cancha
            const [asignacion] = await db.prepare('SELECT caddie_id FROM asignaciones_canchas WHERE fecha = ? AND cancha_id = ?').all(servicio.fecha_servicio, cancha_id);
            if (!asignacion) throw new Error('La cancha seleccionada no tiene un caddie asignado para este día.');
            
            await db.prepare("UPDATE servicios SET caddie_id = ?, cancha_id = ?, estado_confirmacion = 'Pendiente', reporto_llegada = 0, es_puntual = NULL, ubicacion_verificada = 0 WHERE id = ?").run(asignacion.caddie_id, cancha_id, id);
        } else if (caddie_id) {
            if (isWeekendTennis && servicio.cancha_id) {
                await db.prepare("UPDATE servicios SET caddie_id = ?, estado_confirmacion = 'Pendiente', reporto_llegada = 0, es_puntual = NULL, ubicacion_verificada = 0 WHERE fecha_servicio = ? AND cancha_id = ? AND deporte = 'Tenis'").run(caddie_id, servicio.fecha_servicio, servicio.cancha_id);
                const hasAsignacion = await db.prepare("SELECT caddie_id FROM asignaciones_canchas WHERE fecha = ? AND cancha_id = ?").get(servicio.fecha_servicio, servicio.cancha_id);
                if (hasAsignacion) {
                    await db.prepare("UPDATE asignaciones_canchas SET caddie_id = ? WHERE fecha = ? AND cancha_id = ?").run(caddie_id, servicio.fecha_servicio, servicio.cancha_id);
                } else {
                    await db.prepare("INSERT INTO asignaciones_canchas (fecha, cancha_id, caddie_id) VALUES (?, ?, ?)").run(servicio.fecha_servicio, servicio.cancha_id, caddie_id);
                }
            } else {
                await db.prepare("UPDATE servicios SET caddie_id = ?, estado_confirmacion = 'Pendiente', reporto_llegada = 0, es_puntual = NULL, ubicacion_verificada = 0 WHERE id = ?").run(caddie_id, id);
            }
        } else {
            throw new Error('Debe proporcionar un caddie o una cancha.');
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message || 'Error reasignando caddie' });
    }
});
 
// Eliminar un servicio (solo admin/coordinador)
app.delete('/api/servicios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const transaction = db.transaction(async () => {
            // 1. Verificar si el servicio estaba completado para restar horas
            const servicio = db.prepare('SELECT caddie_id, estado, horas_reales FROM servicios WHERE id = ?').get(id);
            if (servicio && servicio.estado === 'Completado' && servicio.caddie_id) {
                const horas = servicio.horas_reales || 4.5;
                await db.prepare('UPDATE perfiles_caddie SET horas_acumuladas = MAX(0, horas_acumuladas - ?) WHERE usuario_id = ?')
                  .run(horas, servicio.caddie_id);
                console.log(`⏪ Revertidas ${horas}h al caddie #${servicio.caddie_id} (Servicio eliminado)`);
            }

            // 2. Eliminar incidencias y servicio
            db.prepare('DELETE FROM incidencias WHERE servicio_id = ?').run(id);
            await db.prepare('DELETE FROM servicios WHERE id = ?').run(id);
        });

        await transaction();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// El endpoint de validación por PIN ha sido removido.

// --- MOTOR DE ASIGNACIÓN AUTOMÁTICA Y CRONOGRAMA ---

app.get('/api/cronograma/stats', async (req, res) => {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ success: false, message: 'La fecha es obligatoria' });

    try {
        const [y, m, d_part] = fecha.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d_part);
        let diaJS = dateObj.getDay();
        const festivos = ['2026-07-13', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25'];
        if (festivos.includes(fecha)) diaJS = 0;
        let diaProcesado = diaJS === 0 ? 6 : diaJS - 1;

        // 1. Activos
        const activosGolf = await db.prepare("SELECT COUNT(*) as count FROM usuarios WHERE rol_id = 4 AND estado = 'Activo' AND (deporte = 'Golf' OR deporte = 'Ambos')").get();
        const activosTenis = await db.prepare("SELECT COUNT(*) as count FROM usuarios WHERE rol_id = 4 AND estado = 'Activo' AND (deporte = 'Tenis' OR deporte = 'Ambos')").get();

        // 2. Disponibles Hoy
        const disponiblesGolf = await db.prepare(`
            SELECT COUNT(DISTINCT u.id) as count 
            FROM usuarios u 
            JOIN horarios_caddie h ON u.id = h.usuario_id 
            WHERE u.rol_id = 4 AND u.estado = 'Activo' AND (u.deporte = 'Golf' OR u.deporte = 'Ambos') 
            AND h.dia_semana = ? AND (h.manana = 1 OR h.tarde = 1)
        `).get(diaProcesado);

        const disponiblesTenis = await db.prepare(`
            SELECT COUNT(DISTINCT u.id) as count 
            FROM usuarios u 
            JOIN horarios_caddie h ON u.id = h.usuario_id 
            WHERE u.rol_id = 4 AND u.estado = 'Activo' AND (u.deporte = 'Tenis' OR u.deporte = 'Ambos') 
            AND h.dia_semana = ? AND (h.manana = 1 OR h.tarde = 1)
        `).get(diaProcesado);

        // 3. Turnos Creados
        const turnosGolf = await db.prepare("SELECT COUNT(*) as count FROM servicios WHERE fecha_servicio = ? AND deporte = 'Golf' AND estado != 'Cancelado' AND estado != 'Completado'").get(fecha);
        const turnosTenis = await db.prepare("SELECT COUNT(*) as count FROM servicios WHERE fecha_servicio = ? AND deporte = 'Tenis' AND estado != 'Cancelado' AND estado != 'Completado'").get(fecha);

        res.json({
            success: true,
            golf: {
                activos: activosGolf.count,
                descansos: activosGolf.count - disponiblesGolf.count,
                disponibles: disponiblesGolf.count,
                turnos: turnosGolf.count
            },
            tenis: {
                activos: activosTenis.count,
                descansos: activosTenis.count - disponiblesTenis.count,
                disponibles: disponiblesTenis.count,
                turnos: turnosTenis.count
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error calculando stats' });
    }
});

app.post('/api/cronograma/generar', async (req, res) => {
    const { fecha, deporte } = req.body;
    if (!fecha) return res.status(400).json({ success: false, message: 'Fecha requerida' });

    try {
        const logPath = path.join(__dirname, 'logs/cronograma.log');
        const log = (msg) => {
            const time = new Date().toISOString();
            fs.appendFileSync(logPath, `[${time}] ${msg}\n`);
            console.log(msg);
        };

        log(`📅 [CRONOGRAMA] INICIO: Generando para fecha ${fecha}`);
        
        const transaction = db.transaction(async () => {
            const hoy = getLocalDate();
            // 1. Obtener servicios sin caddie
            let queryStr = "SELECT id, hora_inicio_programada, deporte, cancha_id FROM servicios WHERE fecha_servicio = ? AND caddie_id IS NULL";
            const queryParams = [fecha];
            
            if (deporte && deporte !== 'Ambos') {
                queryStr += " AND deporte = ?";
                queryParams.push(deporte);
            }
            queryStr += " ORDER BY hora_inicio_programada ASC";

            const servicios = await db.prepare(queryStr).all(...queryParams);
            log(`🔍 Servicios sin asignar: ${servicios.length}`);

            if (servicios.length === 0) return { count: 0, backups: 0 };

            // 2. Determinar día de la semana
            const [y, m_part, d_part] = fecha.split('-').map(Number);
            const dateObj = new Date(y, m_part - 1, d_part);
            let diaJS = dateObj.getDay();
            const festivos = ['2026-07-13', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25'];
            if (festivos.includes(fecha)) diaJS = 0;
            const diaProcesado = diaJS === 0 ? 6 : diaJS - 1;
            log(`📆 Fecha=${fecha} | JS Day=${diaJS} | DB Day=${diaProcesado}`);

            // 3. Caddies Disponibles (Horario + Activo)
            const esHoy = (fecha === hoy);
            
            // Obtener turnos pendientes futuros para sumar horas virtuales
            const turnosPendientes = await db.prepare(`
                SELECT caddie_id, COUNT(*) as count 
                FROM servicios 
                WHERE caddie_id IS NOT NULL AND estado IN ('Pendiente', 'En Juego') 
                AND fecha_servicio >= ?
                GROUP BY caddie_id
            `).all(hoy);
            const pendingTurnsMap = new Map();
            for (const t of turnosPendientes) {
                pendingTurnsMap.set(t.caddie_id, t.count);
            }

            const caddiesDisponibles = await db.prepare(`
                SELECT u.id, u.nombre, u.deporte, p.horas_acumuladas, h.manana, h.tarde, h.horas_disponibles, p.esta_en_club
                FROM usuarios u
                JOIN perfiles_caddie p ON u.id = p.usuario_id
                JOIN horarios_caddie h ON u.id = h.usuario_id
                WHERE u.rol_id = 4 AND u.estado = 'Activo' AND h.dia_semana = ? AND h.es_estudio = 0
            `).all(diaProcesado);

            // Calcular horas efectivas y factor de desempate aleatorio
            for (const c of caddiesDisponibles) {
                const pending = pendingTurnsMap.get(c.id) || 0;
                c.horas_efectivas = c.horas_acumuladas + (pending * 4.5);
                c.random_tiebreaker = Math.random();
            }

            // Ordenar por presencia (si es hoy), luego horas efectivas, luego aleatorio
            caddiesDisponibles.sort((a, b) => {
                if (esHoy) {
                    if (b.esta_en_club !== a.esta_en_club) return b.esta_en_club - a.esta_en_club;
                }
                if (a.horas_efectivas !== b.horas_efectivas) return a.horas_efectivas - b.horas_efectivas;
                return a.random_tiebreaker - b.random_tiebreaker;
            });

            // Obtener novedades que afecten esta fecha
            const novedades = await db.prepare(`
                SELECT reportado_por_id as caddie_id, hora_inicio, hora_fin, todo_el_dia
                FROM incidencias
                WHERE ? BETWEEN IFNULL(fecha_inicio, date(fecha_reporte)) AND IFNULL(fecha_fin, date(fecha_reporte))
            `).all(fecha);

            log(`👥 Caddies con disponibilidad teórica: ${caddiesDisponibles.length}`);

            const turnosExistentes = await db.prepare("SELECT caddie_id, hora_inicio_programada FROM servicios WHERE fecha_servicio = ? AND caddie_id IS NOT NULL AND estado IN ('Pendiente', 'En Juego')").all(fecha);
            
            const caddiesUsadosHora = new Map();
            for (const t of turnosExistentes) {
                if (!caddiesUsadosHora.has(t.caddie_id)) caddiesUsadosHora.set(t.caddie_id, new Set());
                caddiesUsadosHora.get(t.caddie_id).add(t.hora_inicio_programada);
            }

            const turnosGolfExistentes = await db.prepare("SELECT caddie_id, COUNT(*) as count FROM servicios WHERE fecha_servicio = ? AND caddie_id IS NOT NULL AND LOWER(deporte) = 'golf' AND estado NOT IN ('Cancelado') GROUP BY caddie_id").all(fecha);
            const caddiesGolfCount = new Map();
            for (const t of turnosGolfExistentes) {
                caddiesGolfCount.set(t.caddie_id, t.count);
            }

            // Obtener todas las canchas para asignación de tenis
            const todasLasCanchas = await db.prepare(`
                SELECT id, nombre FROM usuarios 
                WHERE (nombre LIKE 'Cancha %' OR nombre LIKE 'Mini Tenis %') AND rol_id = 3 
                ORDER BY CASE WHEN nombre LIKE 'Cancha %' THEN 0 ELSE 1 END, CAST(REGEXP_REPLACE(nombre, '[^0-9]', '') AS UNSIGNED)
            `).all();

            // Obtener backups de la mañana de Tenis
            const backupsMananaTenisDB = await db.prepare("SELECT caddie_id FROM backups_programados WHERE fecha = ? AND turno = 'mañana' AND deporte = 'Tenis'").all(fecha);
            const morningTenisBackups = new Set(backupsMananaTenisDB.map(b => b.caddie_id));

            // Obtener todos los backups de Golf
            const backupsGolfDB = await db.prepare("SELECT caddie_id FROM backups_programados WHERE fecha = ? AND deporte = 'Golf'").all(fecha);
            const golfBackups = new Set(backupsGolfDB.map(b => b.caddie_id));

            // 4. Bucle de Asignación
            let asignadosCount = 0;
            for (const serv of servicios) {
                const hour = parseInt(serv.hora_inicio_programada.split(':')[0]);
                const esManana = hour < 12;

                let bestCaddie = null;
                let minTurnsToday = Infinity;

                for (const c of caddiesDisponibles) {
                    const assignedHours = caddiesUsadosHora.get(c.id) || new Set();
                    if (assignedHours.has(serv.hora_inicio_programada)) continue;
                    
                    // Verificar que el caddie pertenezca al área del servicio (Golf o Tenis)
                    if (c.deporte !== 'Ambos' && serv.deporte && c.deporte !== serv.deporte) {
                        continue;
                    }

                    // Los backups de golf no pueden ser asignados con generación automática a ningún turno
                    if (golfBackups.has(c.id)) {
                        continue;
                    }

                    // Los backups de la mañana de tenis NO pueden ser asignados a turnos a partir de la 1:00 PM (13:00)
                    if (hour >= 13 && morningTenisBackups.has(c.id)) {
                        continue;
                    }

                    // Validación de máximo 1 turno de golf por día en automático
                    if ((serv.deporte || '').toLowerCase() === 'golf') {
                        const count = caddiesGolfCount.get(c.id) || 0;
                        if (count >= 1) continue;
                    }

                    // Verificar si tiene novedad bloqueante
                    const tieneNovedad = novedades.some(n => {
                        if (n.caddie_id !== c.id) return false;
                        if (n.todo_el_dia === 1) return true;
                        
                        // Si es por horas, verificar solapamiento
                        if (n.hora_inicio && n.hora_fin) {
                            const serviceTime = serv.hora_inicio_programada; // HH:mm
                            return (serviceTime >= n.hora_inicio && serviceTime <= n.hora_fin);
                        }
                        return false;
                    });

                    if (tieneNovedad) continue;

                    let cumpleTurno = false;
                    try {
                        const parsedHoras = c.horas_disponibles ? (typeof c.horas_disponibles === 'string' ? JSON.parse(c.horas_disponibles) : c.horas_disponibles) : null;
                        if (Array.isArray(parsedHoras) && parsedHoras.length > 0) {
                            cumpleTurno = parsedHoras.includes(hour) || parsedHoras.includes(hour.toString());
                        } else {
                            cumpleTurno = false; 
                        }
                    } catch (e) {
                        cumpleTurno = false;
                    }
                    if (!cumpleTurno) continue;

                    // Si es válido, verificamos equidad del día
                    const turnsToday = assignedHours.size;
                    
                    if (turnsToday < minTurnsToday) {
                        bestCaddie = c;
                        minTurnsToday = turnsToday;
                    }
                    
                    // Si encontramos uno con 0 turnos hoy, es el mejor candidato posible (ya viene ordenado por equidad histórica)
                    if (minTurnsToday === 0) {
                        break;
                    }
                }

                const caddie = bestCaddie;

                if (caddie) {
                    let canchaAsignadaId = null;
                    if (serv.deporte === 'Tenis') {
                        // Si el servicio ya tiene cancha del Excel, respetarla
                        if (serv.cancha_id) {
                            canchaAsignadaId = serv.cancha_id;
                            log(`📌 Turno #${serv.id} ya tiene cancha del Excel (ID: ${serv.cancha_id}), se respeta.`);
                        } else {
                            const canchasOcupadas = await db.prepare(`
                                SELECT cancha_id FROM servicios 
                                WHERE fecha_servicio = ? 
                                AND hora_inicio_programada = ? 
                                AND estado NOT IN ('Cancelado')
                                AND cancha_id IS NOT NULL
                            `).all(fecha, serv.hora_inicio_programada);
                            const ocupadasIds = new Set(canchasOcupadas.map(c => c.cancha_id));
                            
                            const canchasLibres = todasLasCanchas.filter(c => !ocupadasIds.has(c.id));
                            if (canchasLibres.length > 0) {
                                // Seleccionar aleatoriamente pero preservando el tipo (Cancha vs Mini Tenis)
                                const firstAvailableType = canchasLibres[0].nombre.includes('Mini Tenis') ? 'Mini Tenis' : 'Cancha';
                                const preferredCanchas = canchasLibres.filter(c => c.nombre.includes(firstAvailableType));
                                const randomIndex = Math.floor(Math.random() * preferredCanchas.length);
                                canchaAsignadaId = preferredCanchas[randomIndex].id;
                            } else {
                                log(`⚠️ No hay canchas disponibles para Turno #${serv.id} a las ${serv.hora_inicio_programada}`);
                            }
                        }
                    }

                    if (canchaAsignadaId) {
                        await db.prepare("UPDATE servicios SET caddie_id = ?, cancha_id = ?, estado_confirmacion = 'Pendiente' WHERE id = ?").run(caddie.id, canchaAsignadaId, serv.id);
                    } else {
                        await db.prepare("UPDATE servicios SET caddie_id = ?, estado_confirmacion = 'Pendiente' WHERE id = ?").run(caddie.id, serv.id);
                    }
                    
                    if (!caddiesUsadosHora.has(caddie.id)) caddiesUsadosHora.set(caddie.id, new Set());
                    caddiesUsadosHora.get(caddie.id).add(serv.hora_inicio_programada);
                    
                    if ((serv.deporte || '').toLowerCase() === 'golf') {
                        caddiesGolfCount.set(caddie.id, (caddiesGolfCount.get(caddie.id) || 0) + 1);
                    }
                    
                    asignadosCount++;
                    log(`✅ Turno #${serv.id} (${serv.hora_inicio_programada}) -> Assigned to ${caddie.nombre} (ID: ${caddie.id})${canchaAsignadaId ? ` en Cancha ID: ${canchaAsignadaId}` : ''}`);
                } else {
                    log(`⚠️ No caddie found for Turno #${serv.id} (${serv.hora_inicio_programada}) [Morning=${esManana}]`);
                }
            }

            // 5. Backups automáticos desactivados por requerimiento (evitar jugadores dummy)
            const backupsCount = 0;

            // 6. Obtener listado final de caddies asignados para esta fecha
            const asignadosList = await db.prepare(`
                SELECT DISTINCT u.id, u.nombre, s.hora_inicio_programada, p.esta_en_club
                FROM usuarios u
                JOIN servicios s ON u.id = s.caddie_id
                JOIN perfiles_caddie p ON u.id = p.usuario_id
                WHERE s.fecha_servicio = ? AND s.caddie_id IS NOT NULL
                ORDER BY s.hora_inicio_programada ASC
            `).all(fecha);

            return { count: asignadosCount, backups: backupsCount, asignados: asignadosList };
        });

        const result = await transaction();
        log(`🏁 CRONOGRAMA FINALIZADO: ${JSON.stringify({ count: result.count, backups: result.backups })}`);
        res.json({ success: true, ...result });

    } catch (error) {
        const errorMsg = `❌ [CRONOGRAMA ERROR]: ${error.message}`;
        console.error(errorMsg);
        const logPath = path.join(__dirname, 'logs/cronograma.log');
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${errorMsg}\n`);
        res.status(500).json({ success: false, message: error.message });
    }
});
app.get('/api/caddies/en-club', async (req, res) => {
    try {
        const caddies = await db.prepare(`
            SELECT u.id, u.nombre, p.horas_acumuladas, u.telefono
            FROM usuarios u
            JOIN perfiles_caddie p ON u.id = p.usuario_id
            WHERE u.rol_id = 4 AND u.estado = 'Activo' AND p.esta_en_club = 1
            AND u.id NOT IN (
                SELECT caddie_id FROM servicios 
                WHERE (estado = 'Pendiente' OR estado = 'En Juego') 
                AND fecha_servicio = CURDATE()
                AND caddie_id IS NOT NULL
            )
            ORDER BY p.horas_acumuladas ASC
        `).all();
        res.json({ success: true, caddies });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Confirmar Turno (Caddie)
app.post('/api/servicios/:id/confirmar', async (req, res) => {
    const { id } = req.params;
    const { accion, motivo } = req.body;
    try {
        if (accion === 'Rechazar') {
            const serv = await db.prepare('SELECT caddie_id FROM servicios WHERE id = ?').get(id);
            await db.prepare('UPDATE servicios SET estado_confirmacion = ? WHERE id = ?').run('Rechazado', id);
            await db.prepare('INSERT INTO incidencias (servicio_id, reportado_por_id, tipo, descripcion) VALUES (?, ?, ?, ?)')
              .run(id, serv.caddie_id, 'Rechazo de Turno', motivo || 'El caddie rechazó el turno asignado.');
        } else {
            db.prepare('UPDATE servicios SET estado_confirmacion = ? WHERE id = ?').run('Aceptado', id);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Reportar Llegada
app.post('/api/servicios/:id/llegada', async (req, res) => {
    const { id } = req.params;
    const { ubicacion_ok, es_puntual } = req.body;
    try {
        await db.prepare(`
            UPDATE servicios 
            SET reporto_llegada = 1, 
                hora_llegada = time('now', 'localtime'), 
                ubicacion_verificada = ?, 
                es_puntual = ?
            WHERE id = ?
        `).run(
            ubicacion_ok ? 1 : 0, 
            Number(es_puntual) === 1 ? 1 : 0, 
            id
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Deshacer Llegada
app.post('/api/servicios/:id/deshacer-llegada', async (req, res) => {
    const { id } = req.params;
    try {
        await db.prepare(`
            UPDATE servicios 
            SET reporto_llegada = 0, 
                hora_llegada = NULL, 
                ubicacion_verificada = 0, 
                es_puntual = NULL
            WHERE id = ?
        `).run(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Registrar una Incidencia (General o de Servicio)
app.post('/api/incidencias', async (req, res) => {
    const { 
        servicio_id, 
        reportado_por_id, 
        tipo, 
        descripcion,
        fecha_inicio,
        fecha_fin,
        hora_inicio,
        hora_fin,
        todo_el_dia 
    } = req.body;

    try {
        // Si servicio_id es 0 o null, es una novedad global
        const sId = (servicio_id === 0 || !servicio_id) ? null : servicio_id;
        
        if (sId) {
            const serv = await db.prepare('SELECT estado, estado_confirmacion FROM servicios WHERE id = ?').get(sId);
            if (serv && (serv.estado_confirmacion === 'Rechazado' || serv.estado_confirmacion === 'Reasignado por novedad' || serv.estado === 'Cancelado')) {
                return res.status(400).json({ success: false, message: 'No se pueden reportar novedades sobre turnos rechazados o cancelados.' });
            }
        }

        console.log(`📝 [API] Nueva Novedad: Tipo=${tipo}, Caddie=${reportado_por_id}, Servicio=${sId || 'Global'}`);
        
        await db.prepare(`
            INSERT INTO incidencias (
                servicio_id, reportado_por_id, tipo, descripcion, 
                fecha_inicio, fecha_fin, hora_inicio, hora_fin, todo_el_dia
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            sId, reportado_por_id, tipo, descripcion,
            fecha_inicio || null, fecha_fin || null, 
            hora_inicio || null, hora_fin || null, 
            todo_el_dia ? 1 : 0
        );

        // Lógica de Reasignación Automática
        const hoy = getLocalDate();
            if (sId) {
                console.log(`🚨 [ACCION] Iniciando reasignación automática para turno #${sId}`);
                
                const servInfo = await db.prepare('SELECT fecha_servicio, hora_inicio_programada, deporte FROM servicios WHERE id = ?').get(sId);
                const esHoy = (servInfo.fecha_servicio === hoy);
                const diaSemana = new Date(servInfo.fecha_servicio).getDay();
                const esManana = parseInt(servInfo.hora_inicio_programada.split(':')[0]) < 12;
                const orderBy = esHoy ? 'p.esta_en_club DESC, p.horas_acumuladas ASC' : 'p.horas_acumuladas ASC';

                // Buscar reemplazo (Equidad + Club)
                const reemplazo = await db.prepare(`
                    SELECT u.id, u.nombre 
                    FROM usuarios u
                    JOIN perfiles_caddie p ON u.id = p.usuario_id
                    JOIN horarios_caddie h ON u.id = h.usuario_id
                    WHERE u.rol_id = 4 AND u.estado = 'Activo' 
                    AND h.dia_semana = ? 
                    AND h.es_estudio = 0
                    AND ( ( ? = 1 AND h.manana = 1 ) OR ( ? = 0 AND h.tarde = 1 ) )
                    AND u.id != ?
                    AND (u.deporte = 'Ambos' OR u.deporte = ?)
                    AND u.id NOT IN (SELECT caddie_id FROM servicios WHERE fecha_servicio = ? AND hora_inicio_programada = ? AND estado IN ('Pendiente', 'En Juego'))
                    AND u.id NOT IN (
                        SELECT reportado_por_id FROM incidencias 
                        WHERE (? BETWEEN IFNULL(fecha_inicio, date(fecha_reporte)) AND IFNULL(fecha_fin, date(fecha_reporte)))
                        AND (todo_el_dia = 1 OR (? BETWEEN IFNULL(hora_inicio, '00:00') AND IFNULL(hora_fin, '23:59')))
                    )
                    ORDER BY ${orderBy}
                    LIMIT 1
                `).get(diaSemana, esManana ? 1 : 0, esManana ? 1 : 0, reportado_por_id, servInfo.deporte, servInfo.fecha_servicio, servInfo.hora_inicio_programada, servInfo.fecha_servicio, servInfo.hora_inicio_programada);

                if (reemplazo) {
                    await db.prepare(`
                        UPDATE servicios 
                        SET caddie_id = ?, estado_confirmacion = 'Pendiente', observaciones = COALESCE(observaciones, '') || ?
                        WHERE id = ?
                    `).run(reemplazo.id, ` [Reasignado por novedad de #${reportado_por_id}]`, sId);
                    console.log(`✅ [ACCION] Turno #${sId} reasignado exitosamente a ${reemplazo.nombre}`);
                } else {
                    await db.prepare(`UPDATE servicios SET estado_confirmacion = 'Pendiente', caddie_id = NULL WHERE id = ?`).run(sId);
                    console.log(`⚠️ [ACCION] No se encontró reemplazo disponible para turno #${sId}. Queda como PENDIENTE de asignar.`);
                }
            } else {
                console.log(`🚨 [ACCION] Liberando turnos para caddie #${reportado_por_id} por rango de ausencia reportada`);
                const fIni = fecha_inicio || hoy;
                const fFin = fecha_fin || hoy;
                const hIni = hora_inicio || '00:00';
                const hFin = hora_fin || '23:59';
                const isFullDay = (todo_el_dia ? 1 : 0);

                await db.prepare(`
                    UPDATE servicios 
                    SET estado_confirmacion = 'Pendiente', caddie_id = NULL, observaciones = COALESCE(observaciones, '') || ' [Liberado por novedad]'
                    WHERE caddie_id = ? 
                    AND estado = 'Pendiente' 
                    AND (
                        ( ? = 1 AND fecha_servicio BETWEEN ? AND ? )
                        OR
                        ( ? = 0 AND fecha_servicio BETWEEN ? AND ? AND hora_inicio_programada BETWEEN ? AND ? )
                    )
                `).run(reportado_por_id, isFullDay, fIni, fFin, isFullDay, fIni, fFin, hIni, hFin);
            }
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error registrando novedad' });
    }
});

// --- NUEVO: Estado en Club ---
app.post('/api/perfil/estado-club', async (req, res) => {
    const { usuario_id, esta_en_club, turno_backup, deporte_backup } = req.body;
    try {
        await db.prepare(`
            UPDATE perfiles_caddie 
            SET esta_en_club = ?, fecha_entrada_club = ?, turno_backup = ?, deporte_backup = ?
            WHERE usuario_id = ?
        `).run(esta_en_club ? 1 : 0, esta_en_club ? new Date().toISOString() : null, esta_en_club ? (turno_backup || null) : null, esta_en_club ? (deporte_backup || null) : null, usuario_id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/perfil/estado-club-bulk', async (req, res) => {
    const { caddieIds, esta_en_club, turno_backup, deporte_backup } = req.body;
    if (!Array.isArray(caddieIds)) return res.status(400).json({ success: false, message: 'caddieIds must be an array' });
    try {
        const updateStmt = db.prepare(`
            UPDATE perfiles_caddie 
            SET esta_en_club = ?, fecha_entrada_club = ?, turno_backup = ?, deporte_backup = ?
            WHERE usuario_id = ?
        `);
        const transaction = db.transaction((ids) => {
            const date = esta_en_club ? new Date().toISOString() : null;
            const turno = esta_en_club ? (turno_backup || null) : null;
            const deporte = esta_en_club ? (deporte_backup || null) : null;
            for (const id of ids) {
                updateStmt.run(esta_en_club ? 1 : 0, date, turno, deporte, id);
            }
        });
        transaction(caddieIds);
        res.json({ success: true, count: caddieIds.length });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- NUEVO: Gestión de Backups Programados ---
app.get('/api/backups', async (req, res) => {
    const { fecha, deporte } = req.query;
    try {
        let query = `
            SELECT b.*, u.nombre 
            FROM backups_programados b
            JOIN usuarios u ON b.caddie_id = u.id
            WHERE b.fecha = ?
        `;
        const params = [fecha];
        if (deporte && deporte !== 'Ambos') {
            query += ` AND b.deporte = ?`;
            params.push(deporte);
        }
        const backups = await db.prepare(query).all(...params);
        res.json(backups);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/backups', async (req, res) => {
    const { fecha, deporte, turno, caddieIds } = req.body;
    try {
        const transaction = db.transaction(async (ids) => {
            // Eliminar los anteriores para esa fecha, deporte y turno
            await db.prepare(`DELETE FROM backups_programados WHERE fecha = ? AND deporte = ? AND turno = ?`).run(fecha, deporte, turno);
            
            // Insertar los nuevos
            const insertStmt = db.prepare(`INSERT INTO backups_programados (fecha, deporte, turno, caddie_id) VALUES (?, ?, ?, ?)`);
            for (const id of ids) {
                await insertStmt.run(fecha, deporte, turno, id);
            }
        });
        await transaction(caddieIds || []);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/backups/manual', async (req, res) => {
    const { fecha, deporte, turno, caddie_id } = req.body;
    try {
        await db.prepare(`INSERT INTO backups_programados (fecha, deporte, turno, caddie_id) VALUES (?, ?, ?, ?)`).run(fecha, deporte || 'Tenis', turno, caddie_id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/backups/:id', async (req, res) => {
    const { caddie_id } = req.body;
    try {
        await db.prepare(`UPDATE backups_programados SET caddie_id = ? WHERE id = ?`).run(caddie_id, req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/backups/:id', async (req, res) => {
    try {
        await db.prepare(`DELETE FROM backups_programados WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Listar todos los usuarios (Staff y Jugadores)
app.get('/api/usuarios', async (req, res) => {
    try {
        const usuarios = await db.prepare(`
            SELECT u.id, u.nombre, u.email, u.telefono, u.deporte, u.estado, r.nombre as rol, u.rol_id
            FROM usuarios u
            JOIN roles r ON u.rol_id = r.id
            ORDER BY u.rol_id ASC, u.nombre ASC
        `).all();
        res.json(usuarios);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error recuperando usuarios' });
    }
});

// Listar solo Jugadores (para selección en turnos)
app.get('/api/jugadores', async (req, res) => {
    try {
        const jugadores = await db.prepare('SELECT id, nombre, email FROM usuarios WHERE rol_id = 3 ORDER BY nombre ASC').all();
        res.json(jugadores);
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error recuperando jugadores' });
    }
});

// Crear usuario (Admin, Coordinador, Jugador)
app.post('/api/usuarios', async (req, res) => {
    const { nombre, email, password, telefono, deporte, rol_id } = req.body;
    try {
        const hashedPassword = bcrypt.hashSync(password || 'club123', 10);
        const info = await db.prepare(`
            INSERT INTO usuarios (nombre, email, password, telefono, deporte, rol_id, estado)
            VALUES (?, ?, ?, ?, ?, ?, 'Activo')
        `).run(nombre, email, hashedPassword, telefono, deporte, rol_id);
        
        res.json({ success: true, id: info.lastInsertRowid });
    } catch (error) {
        console.error(error);
        if (error.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ success: false, message: 'El correo electrónico ya existe' });
        } else {
            res.status(500).json({ success: false, message: 'Error creando usuario' });
        }
    }
});

// Eliminar usuario
app.delete('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // No permitir eliminar al admin principal (id 1) por seguridad
        if (id == 1) return res.status(403).json({ error: 'No se puede eliminar el administrador principal' });
        
        await db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error eliminando usuario' });
    }
});

// Actualizar usuario
app.put('/api/usuarios/:id', async (req, res) => {
    const { id } = req.params;
    const { nombre, email, telefono, deporte, estado } = req.body;
    try {
        await db.prepare(`
            UPDATE usuarios 
            SET nombre = COALESCE(?, nombre), 
                email = COALESCE(?, email), 
                telefono = COALESCE(?, telefono), 
                deporte = COALESCE(?, deporte),
                estado = COALESCE(?, estado)
            WHERE id = ?
        `).run(nombre, email, telefono, deporte, estado, id);
        
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error actualizando usuario' });
    }
});

// Resetear contraseña de usuario
app.put('/api/usuarios/:id/password', async (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    
    if (!password) {
        return res.status(400).json({ success: false, message: 'La contraseña es obligatoria' });
    }

    try {
        const hashedPassword = bcrypt.hashSync(password, 10);
        await db.prepare('UPDATE usuarios SET password = ? WHERE id = ?').run(hashedPassword, id);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error reseteando contraseña' });
    }
});

// Inteligencia: Obtener Caddies Disponibles para una fecha/hora específica
app.get('/api/caddies/disponibles', async (req, res) => {
    const { fecha, hora, deporte } = req.query; // fecha: YYYY-MM-DD, hora: HH:mm
    if (!fecha || !hora) return res.status(400).json({ error: 'Falta fecha u hora' });

    try {
        // ... (lógica de fecha igual)
        const [y, m, d_part] = fecha.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d_part);
        let diaJS = dateObj.getDay();
        const festivos = ['2026-07-13', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16', '2026-12-08', '2026-12-25'];
        if (festivos.includes(fecha)) diaJS = 0;
        let diaProcesado = diaJS === 0 ? 6 : diaJS - 1;
        const horaInt = parseInt(hora.split(':')[0]);
        const esManana = horaInt < 12 ? 1 : 0;
        const esTarde = horaInt >= 12 ? 1 : 0;

        const esHoy = (fecha === getLocalDate());
        const orderBy = esHoy ? 'p.esta_en_club DESC, p.horas_acumuladas ASC' : 'p.horas_acumuladas ASC';

        let query = `
            SELECT u.id, u.nombre, p.horas_acumuladas, p.esta_en_club,
            (SELECT COUNT(*) FROM backups_programados bp WHERE bp.caddie_id = u.id AND bp.fecha = ?) as isBackup
            FROM usuarios u
            JOIN perfiles_caddie p ON u.id = p.usuario_id
            JOIN horarios_caddie h ON u.id = h.usuario_id
            WHERE u.rol_id = 4 
            AND u.estado = 'Activo'
            AND h.dia_semana = ? 
            AND h.es_estudio = 0
            AND ( ( ? = 1 AND h.manana = 1 ) OR ( ? = 1 AND h.tarde = 1 ) )
        `;
        
        const params = [fecha, diaProcesado, esManana, esTarde];
        
        if (deporte && deporte !== 'Ambos') {
            query += " AND (u.deporte = ? OR u.deporte = 'Ambos')";
            params.push(deporte);
        }

        query += `
            AND u.id NOT IN (
                SELECT caddie_id FROM servicios 
                WHERE fecha_servicio = ? AND hora_inicio_programada = ? AND estado IN ('Pendiente', 'En Juego') AND caddie_id IS NOT NULL
            )
        `;
        params.push(fecha, hora);

        const disponibles = await db.prepare(query).all(...params);
        
        // --- MOTOR DE PRIORIZACIÓN POR EQUIDAD Y CLUB ---
        // Si es para hoy, los que están en el club van de primero.
        // Luego ordenar por horas acumuladas (ascendente) para dar prioridad a los que han ganado menos.
        // Como desempate, usamos la calificación (descendente).
        disponibles.sort((a, b) => {
            if (esHoy && a.esta_en_club !== b.esta_en_club) {
                return b.esta_en_club - a.esta_en_club;
            }
            return a.horas_acumuladas - b.horas_acumuladas;
        });

        res.json(disponibles);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error calculando disponibilidad' });
    }
});

// --- MÓDULO DE ESTADÍSTICAS OPERATIVAS ---

app.get('/api/stats', async (req, res) => {
    const { deporte, caddie_id } = req.query;
    try {
        if (caddie_id) {
            // --- ESTADÍSTICAS PERSONALIZADAS PARA EL CADDIE ---
            const perfil = await db.prepare('SELECT horas_acumuladas, esta_en_club FROM perfiles_caddie WHERE usuario_id = ?').get(caddie_id);
            const acompanamientoTotal = perfil?.horas_acumuladas || 0;
            const estaEnClub = perfil?.esta_en_club || 0;
            const serviciosCompletados = await db.prepare('SELECT COUNT(*) as count FROM servicios WHERE caddie_id = ? AND estado = \'Completado\'').get(caddie_id).count;
            
            // Horas acumuladas este mes
            const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
            const horasMes = await db.prepare(`
                SELECT SUM(horas_reales) as total 
                FROM servicios 
                WHERE caddie_id = ? AND estado = 'Completado' AND fecha_servicio LIKE ?
            `).get(caddie_id, `${currentMonth}%`)?.total || 0;

            const proximoTurno = await db.prepare(`
                SELECT s.*, u.nombre as jugador_nombre 
                FROM servicios s
                JOIN usuarios u ON s.socio_id = u.id
                WHERE s.caddie_id = ? AND s.estado IN ('Pendiente', 'En Juego')
                AND s.fecha_servicio >= CURDATE()
                ORDER BY s.fecha_servicio ASC, s.hora_inicio_programada ASC
                LIMIT 1
            `).get(caddie_id);

            // Tendencia personal (últimos 7 días)
            const tendenciaRaw = await db.prepare(`
                SELECT fecha_servicio as fecha, COUNT(*) as cantidad 
                FROM servicios 
                WHERE caddie_id = ? AND estado = 'Completado' AND fecha_servicio >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
                GROUP BY fecha_servicio
            `).all(caddie_id);

            const tendencia = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setHours(0,0,0,0);
                d.setDate(d.getDate() - i);
                
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                const dateStr = `${year}-${month}-${day}`;
                
                const found = tendenciaRaw.find(t => t.fecha === dateStr);
                tendencia.push({
                    name: d.toLocaleDateString('es-ES', { weekday: 'short' }),
                    salidas: found ? found.cantidad : 0
                });
            }

            return res.json({
                acompanamientoTotal,
                serviciosCompletados,
                horasMes,
                proximoTurno,
                estaEnClub,
                tendencia,
                esPersonal: true
            });
        }

        const filter = (deporte && deporte !== 'Ambos') ? " AND deporte = ?" : "";
        const param = (deporte && deporte !== 'Ambos') ? [deporte] : [];

        // 1. Basic Stats (Admin/Coordinador)
        const rowServicios = await db.prepare(`SELECT COUNT(*) as count FROM servicios WHERE fecha_servicio = CURDATE()${filter}`).get(...param);
        const serviciosHoy = rowServicios ? rowServicios.count : 0;
        
        const rowCaddies = await db.prepare(`SELECT COUNT(*) as count FROM usuarios WHERE rol_id = 4 AND estado = 'Activo'${filter}`).get(...param);
        const caddiesActivos = rowCaddies ? rowCaddies.count : 0;
        
        const rowIncidencias = await db.prepare(`SELECT COUNT(*) as count FROM incidencias WHERE date(fecha_reporte) = CURDATE()`).get();
        const incidenciasHoy = rowIncidencias ? rowIncidencias.count : 0;

        // 2. Trend (Last 7 Days)
        const tendenciaRaw = await db.prepare(`
            SELECT fecha_servicio as fecha, COUNT(*) as cantidad 
            FROM servicios 
            WHERE fecha_servicio >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
            ${filter}
            GROUP BY fecha_servicio
            ORDER BY fecha_servicio ASC
        `).all(...param);

        const tendencia = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            // Restar i días a la fecha local
            d.setHours(0,0,0,0);
            d.setDate(d.getDate() - i);
            
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            
            const found = tendenciaRaw.find(t => t.fecha === dateStr);
            tendencia.push({
                name: d.toLocaleDateString('es-ES', { weekday: 'short' }),
                salidas: found ? found.cantidad : 0
            });
        }

        // 3. Distribución por Deporte
        const distribucionRaw = await db.prepare(`
            SELECT deporte, COUNT(*) as cantidad 
            FROM servicios 
            WHERE DATE_FORMAT(fecha_servicio, '%Y-%m') = DATE_FORMAT(CURDATE(), '%Y-%m')
            GROUP BY deporte
        `).all();
        
        const distribucion = distribucionRaw.map(d => ({
            name: d.deporte,
            value: d.cantidad
        }));

        const result = {
            serviciosHoy: serviciosHoy,
            caddiesActivos: caddiesActivos,
            incidenciasHoy,
            tendencia,
            distribucion,
            alertasCriticas: [],
            esPersonal: false
        };

        // ALERTA PROACTIVA: Caddies que no han reportado llegada y faltan menos de 20 min
        const alertasNoLlegada = await db.prepare(`
            SELECT s.id, u1.nombre as jugador_nombre, u2.nombre as caddie_nombre, s.hora_inicio_programada, 'No ha llegado' as motivo_alerta
            FROM servicios s
            JOIN usuarios u1 ON s.socio_id = u1.id
            JOIN usuarios u2 ON s.caddie_id = u2.id
            WHERE s.fecha_servicio = CURDATE()
              AND s.estado = 'Pendiente'
              AND s.reporto_llegada = 0
              AND s.caddie_id IS NOT NULL
              AND (HOUR(CURTIME()) * 60 + MINUTE(CURTIME())) > 
                  (HOUR(s.hora_inicio_programada) * 60 + MINUTE(s.hora_inicio_programada) - 20)
        `).all();

        // ALERTA PROACTIVA: Turnos cancelados por novedad hoy
        const alertasNovedad = await db.prepare(`
            SELECT s.id, u1.nombre as jugador_nombre, u2.nombre as caddie_nombre, s.hora_inicio_programada, 'Cancelado por Novedad' as motivo_alerta
            FROM servicios s
            JOIN usuarios u1 ON s.socio_id = u1.id
            LEFT JOIN usuarios u2 ON s.caddie_id = u2.id
            WHERE s.fecha_servicio = CURDATE()
              AND s.estado_confirmacion = 'Reasignado por novedad'
        `).all();

        result.alertasCriticas = [...alertasNoLlegada, ...alertasNovedad];

        res.json(result);
    } catch (error) {
        console.error('❌ [API] Error en /api/stats:', error.message);
        res.status(500).json({ success: false, message: 'Error recuperando estadísticas' });
    }
});
// --- MÓDULO DE REPORTES Y NÓMINA ---

app.get('/api/reportes/nomina', async (req, res) => {
    try {
        // Query cruzando usuarios y perfiles caddie para tener las horas acumuladas netas.
        const nominaRaw = await db.prepare(`
            SELECT 
                u.id as "ID Caddie",
                u.nombre as "Nombre Completo",
                u.email as "Correo Electrónico",
                u.telefono as "Teléfono",
                u.deporte as "Deporte Principal",
                p.horas_acumuladas as "Horas Acumuladas Netas",
                p.calificacion as "Calificación Histórica"
            FROM usuarios u
            INNER JOIN perfiles_caddie p ON u.id = p.usuario_id
            WHERE u.rol_id = 4 AND u.estado = 'Activo'
            ORDER BY u.nombre ASC
        `).all();

        // Crear Libro de Excel
        const wb = xlsx.utils.book_new();
        // Convertir JSON a Hoja de Cálculo
        const ws = xlsx.utils.json_to_sheet(nominaRaw);
        
        // Ajustar ancho de columnas básico
        ws['!cols'] = [
            { wch: 10 }, { wch: 30 }, { wch: 30 }, 
            { wch: 15 }, { wch: 20 }, { wch: 25 }, { wch: 25 }
        ];

        // Añadir hoja al libro
        xlsx.utils.book_append_sheet(wb, ws, "Nómina Caddies");

        // Escribir a Buffer
        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        // Enviar al cliente
        res.setHeader('Content-Disposition', 'attachment; filename="Nomina_Caddies.xlsx"');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);

    } catch (error) {
        console.error('❌ [API] Error generando reporte de nómina:', error.message);
        res.status(500).json({ success: false, message: 'Error generando reporte' });
    }
});

// Crear nuevo caddie (Usuario + Perfil + Horario Inicial)
app.post('/api/caddies', async (req, res) => {
    const { nombre, email, password, telefono, deporte } = req.body;
    
    try {
        const hashedPassword = bcrypt.hashSync(password || 'caddie123', 10);
        
        const transaction = db.transaction(async () => {
            // 1. Crear Usuario (rol_id 4 = Caddie)
            const userStmt = db.prepare("INSERT INTO usuarios (nombre, email, password, telefono, deporte, rol_id, estado) VALUES (?, ?, ?, ?, ?, 4, 'Activo')");
            const userResult = await userStmt.run(nombre, email, hashedPassword, telefono, deporte);
            const userId = userResult.lastInsertRowid;

            // 2. Crear Perfil
            const profileStmt = db.prepare("INSERT INTO perfiles_caddie (usuario_id, horas_acumuladas, calificacion, disponibilidad) VALUES (?, 0, 5.0, 'Disponible')");
            await profileStmt.run(userId);

            // 3. Crear Horario Base (Lunes a Domingo - Disponible todo el día)
            const horarioStmt = db.prepare('INSERT INTO horarios_caddie (usuario_id, dia_semana, manana, tarde, es_estudio) VALUES (?, ?, 1, 1, 0)');
            for (let i = 0; i <= 6; i++) {
                await horarioStmt.run(userId, i);
            }

            return userId;
        });

        const newId = await transaction();
        res.json({ success: true, id: newId, message: 'Caddie registrado exitosamente' });
    } catch (error) {
        console.error(error);
        if (error.message.includes('UNIQUE constraint failed')) {
            res.status(400).json({ success: false, message: 'El correo electrónico ya está registrado' });
        } else {
            res.status(500).json({ success: false, message: 'Error registrando caddie' });
        }
    }
});

// Middleware catch-all para React (Production)
// --- IMPORTACIÓN DE HORARIOS (99apps) ---
// --- IMPORTACIÓN DE HORARIOS (99apps) ---
app.post('/api/importar-horario', upload.single('file'), async (req, res) => {
    const logPath = path.join(__dirname, 'logs/import.log');
    const log = (msg) => {
        const time = new Date().toISOString();
        const entry = `[${time}] ${msg}\n`;
        fs.appendFileSync(logPath, entry);
        console.log(msg);
    };

    log(`🚀 [IMPORT] Iniciando procesamiento de archivo: ${req.file?.originalname}`);
    if (!req.file) {
        log('❌ No se subió ningún archivo');
        return res.status(400).json({ success: false, message: 'No se subió ningún archivo' });
    }

    try {
        log('📖 Leyendo archivo...');
        const { sportHint } = req.body;
        
        let rows = [];
        const content = fs.readFileSync(req.file.path, 'utf8');
        
        if (content.includes('<table') || content.includes('<TABLE')) {
            log('🔍 Formato HTML detectado (99apps), procesando manualmente...');
            const trRegex = /<tr[^>]*>(.*?)<\/tr>/gis;
            let trMatch;
            while ((trMatch = trRegex.exec(content)) !== null) {
                const tdRegex = /<t[dh][^>]*>(.*?)<\/t[dh]>/gis;
                let tdMatch;
                const row = [];
                while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
                    let text = tdMatch[1].trim().replace(/<[^>]+>/g, '');
                    text = text.replace(/&nbsp;/g, ' ')
                               .replace(/&ntilde;/gi, 'ñ')
                               .replace(/&aacute;/gi, 'á')
                               .replace(/&eacute;/gi, 'é')
                               .replace(/&iacute;/gi, 'í')
                               .replace(/&oacute;/gi, 'ó')
                               .replace(/&uacute;/gi, 'ú');
                    row.push(text);
                }
                if (row.length > 0) {
                    rows.push(row);
                }
            }
            // Alinear índices con la lectura de xlsx (para que headers queden en rows[2])
            rows.unshift([]);
        } else {
            log('📖 Formato Excel binario detectado, procesando con xlsx...');
            const workbook = xlsx.readFile(req.file.path);
            const sheetName = workbook.SheetNames[0];
            rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
        }
        
        log(`📊 Filas detectadas: ${rows.length}`);

        if (rows.length < 3) throw new Error('El archivo no tiene el formato esperado (muy pocas filas)');

        const headers = rows[2] || [];
        
        let deporte = sportHint || (headers.includes('Predio') || req.file.originalname.toLowerCase().includes('tenis') ? 'Tenis' : 'Golf');
        const isTenis = deporte === 'Tenis';
        const colMap = isTenis ? { socio: 9, fecha: 28, hora: 29, id: 0, boliador: 21, elemento: 26 } : { socio: 7, fecha: 22, hora: 23, id: 0 };
        
        if (!isTenis) {
            for (let i = 0; i < 4 && i < rows.length; i++) {
                if (rows[i]) {
                    const teeIndex = rows[i].findIndex(c => String(c).trim().toUpperCase() === 'TEE');
                    if (teeIndex !== -1) {
                        colMap.tee = teeIndex;
                        break;
                    }
                }
            }
        }
        
        log(`🎯 Deporte detectado: ${deporte} | Mapeo: ${JSON.stringify(colMap)}`);

        let importedCount = 0;
        let errors = [];
        const dataRows = rows.slice(3);

        const insertStmt = db.prepare(`
            INSERT INTO servicios 
            (socio_id, fecha_servicio, hora_inicio_programada, deporte, estado, external_id, observaciones, tiene_boliador, nombre_boliador, cancha_id, tee)
            VALUES (?, ?, ?, ?, 'Pendiente', ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE cancha_id = COALESCE(VALUES(cancha_id), cancha_id), tee = COALESCE(VALUES(tee), tee)
        `);

        const userCheckStmt = db.prepare('SELECT id FROM usuarios WHERE nombre = ? AND rol_id = 3');
        const userInsertStmt = db.prepare('INSERT INTO usuarios (nombre, email, password, rol_id, deporte, estado) VALUES (?, ?, ?, 3, ?, ?)');
        const userByEmailStmt = db.prepare('SELECT id FROM usuarios WHERE email = ?');
        const canchaByNameStmt = db.prepare('SELECT id FROM usuarios WHERE nombre = ? AND rol_id = 3');

        log('⚙️ Iniciando transacción de base de datos...');
        const performImport = db.transaction(async (rowsToProcess) => {
            let index = 0;
            for (const row of rowsToProcess) {
                if (!row || row.length < 5) { index++; continue; }

                try {
                    const idReserva = row[colMap.id];
                    const nombreJugador = String(row[colMap.socio] || '').trim();
                    const rawFecha = row[colMap.fecha];
                    const rawHora = row[colMap.hora];
                    if (!idReserva || !nombreJugador) { index++; continue; }

                    // 1. Obtener o Crear Jugador
                    let jugadorId;
                    const existingUser = await userCheckStmt.get(nombreJugador);
                    
                    if (!existingUser) {
                        const emailBase = nombreJugador.toLowerCase().replace(/\s+/g, '.');
                        const emailDummy = `${emailBase}@club.com`;
                        
                        try {
                            const resInsert = await userInsertStmt.run(nombreJugador, emailDummy, 'jugador123', deporte, 'Activo');
                            jugadorId = resInsert.lastInsertRowid;
                        } catch (err) {
                            if (err.message.includes('UNIQUE constraint failed') || err.message.includes('Duplicate entry')) {
                                const userByEmail = await userByEmailStmt.get(emailDummy);
                                if (userByEmail) {
                                    jugadorId = userByEmail.id;
                                } else {
                                    const emailAlt = `${emailBase}.${Date.now().toString().slice(-4)}@club.com`;
                                    const resInsertAlt = await userInsertStmt.run(nombreJugador, emailAlt, 'jugador123', deporte, 'Activo');
                                    jugadorId = resInsertAlt.lastInsertRowid;
                                }
                            } else {
                                throw err;
                            }
                        }
                    } else {
                        jugadorId = existingUser.id;
                    }

                    // 2. Procesar Fecha
                    let fechaStr = '';
                    if (typeof rawFecha === 'number' && rawFecha > 40000) {
                        const date = new Date(Math.round((rawFecha - 25569) * 86400 * 1000));
                        fechaStr = date.toISOString().split('T')[0];
                    } else if (typeof rawFecha === 'string') {
                        fechaStr = rawFecha.split(' ')[0];
                    } else if (rawFecha) {
                         try { fechaStr = new Date(rawFecha).toISOString().split('T')[0]; } catch(e) { fechaStr = getLocalDate(); }
                    } else {
                        fechaStr = getLocalDate();
                    }

                    // 3. Procesar Hora
                    let horaStr = '08:00';
                    if (typeof rawHora === 'number') {
                        const totalSeconds = Math.round(rawHora * 86400);
                        const hours = Math.floor(totalSeconds / 3600);
                        const minutes = Math.floor((totalSeconds % 3600) / 60);
                        horaStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
                    } else if (typeof rawHora === 'string') {
                        horaStr = rawHora.trim();
                    }

                    let tiene_boliador = 0;
                    let nombre_boliador = null;
                    if (isTenis && row[colMap.boliador] && String(row[colMap.boliador]).trim() !== '') {
                        tiene_boliador = 1;
                        nombre_boliador = String(row[colMap.boliador]).trim();
                    }

                    // 4. Procesar Cancha del Excel (columna ELEMENTO)
                    let canchaId = null;
                    if (isTenis && colMap.elemento !== undefined && row[colMap.elemento]) {
                        const nombreCancha = String(row[colMap.elemento]).trim();
                        if (nombreCancha) {
                            const canchaRecord = await canchaByNameStmt.get(nombreCancha);
                            if (canchaRecord) {
                                canchaId = canchaRecord.id;
                            } else {
                                log(`⚠️ Cancha '${nombreCancha}' no encontrada en BD para fila ${index + 4}`);
                            }
                        }
                    }

                    let teeValue = null;
                    if (!isTenis && colMap.tee !== undefined && row[colMap.tee]) {
                        teeValue = String(row[colMap.tee]).trim();
                    }

                    const obs = `Importado de 99apps (ID: ${idReserva})`;
                    const info = await insertStmt.run(jugadorId, fechaStr, horaStr, deporte, idReserva, obs, tiene_boliador, nombre_boliador, canchaId, teeValue);
                    if (info.changes > 0) {
                        importedCount++;
                        if (importedCount % 10 === 0) log(`🔹 Procesadas ${importedCount} filas...`);
                    }

                } catch (e) {
                    log(`⚠️ Error en fila ${index + 4}: ${e.message}`);
                    errors.push(`Fila ${index + 4}: ${e.message}`);
                }
                index++;
            }
        });

        await performImport(dataRows);
        
        log(`✅ [IMPORT] Finalizado exitosamente. ${importedCount} servicios nuevos.`);
        
        res.json({ 
            success: true, 
            message: importedCount === 0 && errors.length > 0 
                ? `0 turnos. Error interno: ${errors[0]}` 
                : importedCount === 0 
                    ? `0 turnos cargados. Todos los turnos en este archivo ya existían o el archivo no tiene turnos nuevos.`
                    : `Importación exitosa: ${importedCount} turnos cargados.`,
            count: importedCount,
            errors: errors.slice(0, 5)
        });

    } catch (error) {
        log(`❌ [IMPORT] Error crítico: ${error.message}`);
        res.status(500).json({ success: false, message: 'Error procesando el archivo: ' + error.message });
    }
});

// --- REPORTES ---
app.get('/api/reportes/puntualidad', async (req, res) => {
    try {
        const report = await db.prepare(`
            SELECT 
                u.id as caddie_id,
                u.nombre as caddie_nombre,
                u.deporte,
                COUNT(s.id) as total_servicios,
                SUM(CASE WHEN (s.es_puntual = 1 OR (s.es_puntual IS NULL AND s.estado IN ('En Juego', 'Completado'))) AND (s.estado_confirmacion != 'Reasignado por novedad' AND s.estado_confirmacion != 'Rechazado') THEN 1 ELSE 0 END) as puntuales,
                SUM(CASE WHEN s.es_puntual = 0 AND (s.estado_confirmacion != 'Reasignado por novedad' AND s.estado_confirmacion != 'Rechazado') THEN 1 ELSE 0 END) as tardanzas,
                SUM(CASE WHEN s.estado_confirmacion = 'Reasignado por novedad' OR s.estado_confirmacion = 'Rechazado' THEN 1 ELSE 0 END) as novedades
            FROM usuarios u
            LEFT JOIN servicios s ON u.id = s.caddie_id
            WHERE u.rol_id = 4 AND u.estado = 'Activo'
            GROUP BY u.id
            ORDER BY u.nombre
        `).all();
        res.json(report);
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Error al generar reporte de puntualidad' });
    }
});

// --- MÓDULO DE MANTENIMIENTO AUTOMÁTICO ---
const ejecutarMantenimiento = async () => {
    console.log('🧹 Ejecutando mantenimiento de servicios antiguos...');
    try {
        const hoy = getLocalDate();
        
        // 1. Auto-completar servicios que quedaron "En Juego" de días anteriores
        const stuckInPlay = db.prepare(`
            SELECT id, caddie_id FROM servicios 
            WHERE estado = 'En Juego' AND fecha_servicio < ?
        `).all(hoy);

        if (stuckInPlay.length > 0) {
            const updateStmt = await db.prepare("UPDATE servicios SET estado = 'Completado', observaciones = COALESCE(observaciones, '') || ' [Auto-Completado por Sistema]' WHERE id = ?");
            const creditHoursStmt = db.prepare("UPDATE perfiles_caddie SET horas_acumuladas = horas_acumuladas + 4.5 WHERE usuario_id = ?");
            const logIncidencia = db.prepare("INSERT INTO incidencias (tipo, descripcion, reportado_por_id, servicio_id) VALUES ('Sistema', 'Cierre automático de turno tras 24h sin finalizar', 1, ?)");

            const transaction = db.transaction((servicios) => {
                for (const s of servicios) {
                    updateStmt.run(s.id);
                    if (s.caddie_id) creditHoursStmt.run(s.caddie_id);
                    logIncidencia.run(s.id);
                }
            });
            await transaction(stuckInPlay);
            console.log(`✅ Se auto-completaron ${stuckInPlay.length} servicios antiguos.`);
        }

        // 2. Marcar como "Cancelado" servicios "Pendientes" de días anteriores
        const oldPending = db.prepare("UPDATE servicios SET estado = 'Cancelado' WHERE estado = 'Pendiente' AND fecha_servicio < ?").run(hoy);
        if (oldPending.changes > 0) {
            console.log(`✅ Se marcaron como Cancelados ${oldPending.changes} turnos no tomados de días anteriores.`);
        }

    } catch (error) {
        console.error('❌ Error en mantenimiento:', error);
    }
};

// Ejecutar al iniciar y cada hora
ejecutarMantenimiento();
setInterval(ejecutarMantenimiento, 1000 * 60 * 60);

// --- AUTO-INICIO DE TURNOS ---
async function ejecutarIniciosAutomaticos() {
    try {
        const hoy = getLocalDate();
        
        // Obtener la hora actual exacta en Colombia
        const nowColombia = new Date().toLocaleString("en-US", { timeZone: "America/Bogota", hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const ahora = nowColombia; // ya viene en formato HH:MM:SS
        
        
        // Find services for today, that are Pendiente, have a caddie, and hora_inicio_programada <= ahora
        const serviciosParaIniciar = await db.prepare(`
            SELECT id FROM servicios 
            WHERE fecha_servicio = ? 
            AND estado = 'Pendiente' 
            AND caddie_id IS NOT NULL 
            AND hora_inicio_programada <= ?
            AND hora_inicio_programada != ''
            AND hora_inicio_programada IS NOT NULL
        `).all(hoy, ahora);

        if (serviciosParaIniciar && serviciosParaIniciar.length > 0) {
            const updateStmt = db.prepare("UPDATE servicios SET estado = 'En Juego', hora_inicio_real = COALESCE(hora_inicio_real, ?) WHERE id = ?");
            await db.transaction(async (servicios) => {
                for (const s of servicios) {
                    await updateStmt.run(ahora, s.id);
                }
            })(serviciosParaIniciar);
            console.log(`✅ [AUTO-INICIO] Se iniciaron automáticamente ${serviciosParaIniciar.length} turnos.`);
        }
    } catch (e) {
        console.error('Error en inicio automático de turnos:', e);
    }
}
setInterval(ejecutarIniciosAutomaticos, 1000 * 60);
setTimeout(ejecutarIniciosAutomaticos, 5000); // Check shortly after startup


// --- CATCH ALL para el frontend ---
// Ahora el frontend está en Hostinger, así que el backend solo responde APIs
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
        return next();
    }
    res.send('API Backend Caddies Online 🟢');
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en el puerto ${PORT}`);
});

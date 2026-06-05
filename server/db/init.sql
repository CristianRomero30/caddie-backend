-- Script de inicialización de la base de datos Caddie System (v2.0)

-- Tabla de Roles
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL UNIQUE
);

-- Insertar roles por defecto
INSERT OR IGNORE INTO roles (nombre) VALUES ('Administrador'), ('Coordinador'), ('Jugador'), ('Caddie');

-- Tabla de Usuarios
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    telefono TEXT,
    pin TEXT DEFAULT '0000',
    rol_id INTEGER NOT NULL,
    deporte TEXT DEFAULT 'Golf',
    estado TEXT DEFAULT 'Activo',
    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rol_id) REFERENCES roles(id)
);

-- Perfil específico para Caddies
CREATE TABLE IF NOT EXISTS perfiles_caddie (
    usuario_id INTEGER PRIMARY KEY,
    horas_acumuladas REAL DEFAULT 0,
    calificacion REAL DEFAULT 5.0,
    disponibilidad TEXT DEFAULT 'Disponible',
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Horarios de Disponibilidad para Caddies
CREATE TABLE IF NOT EXISTS horarios_caddie (
    usuario_id INTEGER NOT NULL,
    dia_semana INTEGER NOT NULL, -- 0 (Lun) a 6 (Dom)
    manana INTEGER DEFAULT 1,    -- 0 o 1
    tarde INTEGER DEFAULT 1,     -- 0 o 1
    es_estudio INTEGER DEFAULT 0, -- 0 o 1
    PRIMARY KEY (usuario_id, dia_semana),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- Tabla de Servicios (Turnos)
CREATE TABLE IF NOT EXISTS servicios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE, -- ID de 99apps
    socio_id INTEGER NOT NULL,
    caddie_id INTEGER,
    fecha_servicio DATE NOT NULL,
    hora_inicio_programada TIME,
    hora_inicio_real TIME,
    hora_fin_real TIME,
    horas_reales REAL,
    estado TEXT DEFAULT 'Pendiente', -- Pendiente, En Juego, Completado, Cancelado
    estado_confirmacion TEXT DEFAULT 'Pendiente', -- Pendiente, Aceptado, Rechazado
    reporto_llegada INTEGER DEFAULT 0,
    hora_llegada TIME,
    ubicacion_verificada INTEGER DEFAULT 0,
    es_backup INTEGER DEFAULT 0,
    deporte TEXT DEFAULT 'Golf', -- Golf, Tenis
    observaciones TEXT,
    FOREIGN KEY (socio_id) REFERENCES usuarios(id),
    FOREIGN KEY (caddie_id) REFERENCES usuarios(id)
);

-- Tabla de Incidencias (Novedades)
CREATE TABLE IF NOT EXISTS incidencias (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    servicio_id INTEGER,
    reportado_por_id INTEGER,
    tipo TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    fecha_reporte DATETIME DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (servicio_id) REFERENCES servicios(id),
    FOREIGN KEY (reportado_por_id) REFERENCES usuarios(id)
);

-- Tabla de Configuración del Sistema
CREATE TABLE IF NOT EXISTS configuracion_sistema (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
);

-- Insertar configuración inicial
INSERT OR IGNORE INTO configuracion_sistema (clave, valor) VALUES ('backups_sugeridos', '5');

-- Poblar con un administrador inicial
INSERT OR IGNORE INTO usuarios (nombre, email, password, rol_id, deporte) 
VALUES ('Administrador Sistema', 'admin@elrancho.com', 'admin123', 1, 'Ambos');


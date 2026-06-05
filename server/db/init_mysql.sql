-- Script de inicialización de MySQL
CREATE TABLE IF NOT EXISTS roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL UNIQUE
);

INSERT IGNORE INTO roles (id, nombre) VALUES (1, 'Administrador'), (2, 'Coordinador'), (3, 'Jugador'), (4, 'Caddie');

CREATE TABLE IF NOT EXISTS usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    telefono VARCHAR(20),
    pin VARCHAR(10) DEFAULT '0000',
    rol_id INT NOT NULL,
    deporte VARCHAR(50) DEFAULT 'Golf',
    estado VARCHAR(20) DEFAULT 'Activo',
    fecha_creacion DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rol_id) REFERENCES roles(id)
);

CREATE TABLE IF NOT EXISTS perfiles_caddie (
    usuario_id INT PRIMARY KEY,
    horas_acumuladas FLOAT DEFAULT 0,
    calificacion FLOAT DEFAULT 5.0,
    disponibilidad VARCHAR(50) DEFAULT 'Disponible',
    esta_en_club TINYINT(1) DEFAULT 0,
    fecha_entrada_club DATETIME DEFAULT NULL,
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS horarios_caddie (
    usuario_id INT NOT NULL,
    dia_semana INT NOT NULL,
    manana TINYINT(1) DEFAULT 1,
    tarde TINYINT(1) DEFAULT 1,
    es_estudio TINYINT(1) DEFAULT 0,
    PRIMARY KEY (usuario_id, dia_semana),
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS servicios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    external_id VARCHAR(100) UNIQUE,
    socio_id INT NOT NULL,
    caddie_id INT,
    fecha_servicio DATE NOT NULL,
    hora_inicio_programada TIME,
    hora_inicio_real TIME,
    hora_fin_real TIME,
    horas_reales FLOAT,
    estado VARCHAR(50) DEFAULT 'Pendiente',
    estado_confirmacion VARCHAR(50) DEFAULT 'Pendiente',
    reporto_llegada TINYINT(1) DEFAULT 0,
    hora_llegada TIME,
    ubicacion_verificada TINYINT(1) DEFAULT 0,
    es_backup TINYINT(1) DEFAULT 0,
    es_puntual TINYINT(1) DEFAULT 1,
    deporte VARCHAR(50) DEFAULT 'Golf',
    observaciones TEXT,
    FOREIGN KEY (socio_id) REFERENCES usuarios(id),
    FOREIGN KEY (caddie_id) REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS incidencias (
    id INT AUTO_INCREMENT PRIMARY KEY,
    servicio_id INT,
    reportado_por_id INT,
    tipo VARCHAR(100) NOT NULL,
    descripcion TEXT NOT NULL,
    fecha_reporte DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_inicio DATE,
    fecha_fin DATE,
    hora_inicio TIME,
    hora_fin TIME,
    todo_el_dia TINYINT(1) DEFAULT 0,
    FOREIGN KEY (servicio_id) REFERENCES servicios(id),
    FOREIGN KEY (reportado_por_id) REFERENCES usuarios(id)
);

CREATE TABLE IF NOT EXISTS configuracion_sistema (
    clave VARCHAR(100) PRIMARY KEY,
    valor TEXT NOT NULL
);

INSERT IGNORE INTO configuracion_sistema (clave, valor) VALUES ('backups_sugeridos', '5');

INSERT IGNORE INTO usuarios (id, nombre, email, password, rol_id, deporte) 
VALUES (1, 'Administrador Sistema', 'admin@elrancho.com', '$2a$10$wE9c7t3/N5f5iM/p9T2S/ejU9xQ2n9v5vJ8o8u6x5R9v5vJ8o8u6x', 1, 'Ambos');

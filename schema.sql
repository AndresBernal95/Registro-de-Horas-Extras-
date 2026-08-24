-- ══════════════════════════════════════════════════════════════════
-- GPA AQUA — HORAS EXTRAS · Esquema Neon Postgres  (v2.0)
--
-- Este archivo es IDEMPOTENTE: puedes ejecutarlo completo en el SQL
-- Editor de Neon tantas veces como quieras. No borra datos ni duplica
-- usuarios; si la tabla ya existe sólo agrega lo que falta.
--
-- Cambios respecto a la v1:
--   · password pasa de VARCHAR(100) a TEXT (los hash bcrypt miden 60
--     caracteres y conviene margen para el futuro).
--   · Nueva columna causa_grupo ('op' | 'adm') para separar las horas
--     extra operativas de las administrativas en los reportes.
--   · Índices nuevos que hacen rápido el monitor y el reporte de Excel.
--   · Restricción que impide dos registros del mismo empleado el mismo
--     día a nivel de base de datos, no sólo en la aplicación.
-- ══════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ──────────────────────────────────────────────────────────────────
-- TABLA: usuarios
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id           SERIAL PRIMARY KEY,
  num_emp      VARCHAR(20)  UNIQUE NOT NULL,
  password     TEXT         NOT NULL DEFAULT 'GPA2026',
  nombre       TEXT         NOT NULL,
  puesto       TEXT,
  ubicacion    TEXT,
  depto        TEXT,
  rol          TEXT         NOT NULL CHECK (rol IN ('operario','jefe','gerente','admin')),
  jefe_num     VARCHAR(20),   -- num_emp del jefe directo
  gerente_num  VARCHAR(20),   -- num_emp del gerente que autoriza la hora 10+
  email        TEXT,
  activo       BOOLEAN      DEFAULT TRUE,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- Migración segura si la tabla venía de la v1
ALTER TABLE usuarios ALTER COLUMN password TYPE TEXT;

-- ──────────────────────────────────────────────────────────────────
-- TABLA: horas_extras
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS horas_extras (
  id              TEXT PRIMARY KEY DEFAULT 'HE-' || upper(encode(gen_random_bytes(4),'hex')),
  fecha           DATE         NOT NULL,
  hora_registro   TIME         NOT NULL,
  ts              TIMESTAMPTZ  DEFAULT NOW(),
  num_emp         VARCHAR(20)  NOT NULL REFERENCES usuarios(num_emp) ON UPDATE CASCADE,
  nombre          TEXT,
  puesto          TEXT,
  ubicacion       TEXT,
  depto           TEXT,
  horas_dia       NUMERIC(4,1) NOT NULL CHECK (horas_dia > 0 AND horas_dia <= 3),
  horas_semana    NUMERIC(5,1) DEFAULT 0,
  causa_cat       TEXT,
  causa_grupo     TEXT,        -- 'op' = operativa · 'adm' = administrativa
  causa_p1        TEXT,
  causa_p2        TEXT,
  causa_p3        TEXT,
  causa_texto     TEXT,
  estado_lft      TEXT         DEFAULT 'ok',
  -- Nivel 1: jefe directo (horas 1 a 9 de la semana)
  auth_jefe       TEXT         DEFAULT 'pendiente' CHECK (auth_jefe IN ('pendiente','autorizado','rechazado','na')),
  auth_jefe_num   VARCHAR(20),
  auth_jefe_ts    TIMESTAMPTZ,
  -- Nivel 2: gerencia (hora 10 en adelante — autorización especial)
  auth_gerente     TEXT        DEFAULT 'na'        CHECK (auth_gerente IN ('pendiente','autorizado','rechazado','na')),
  auth_gerente_num VARCHAR(20),
  auth_gerente_ts  TIMESTAMPTZ,
  estado_final    TEXT         DEFAULT 'pendiente' CHECK (estado_final IN ('pendiente','autorizado','rechazado'))
);

ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS causa_grupo TEXT;

-- ──────────────────────────────────────────────────────────────────
-- TABLA: sabados_laborados
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sabados_laborados (
  id              TEXT PRIMARY KEY DEFAULT 'SAB-' || upper(encode(gen_random_bytes(4),'hex')),
  ts              TIMESTAMPTZ  DEFAULT NOW(),
  fecha_sabado    DATE         NOT NULL,
  jefe_num        VARCHAR(20)  NOT NULL REFERENCES usuarios(num_emp) ON UPDATE CASCADE,
  jefe_nombre     TEXT,
  ubicacion       TEXT,
  depto           TEXT,
  personal        JSONB        DEFAULT '[]',
  causa_cat       TEXT,
  causa_grupo     TEXT,
  causa_p1        TEXT,
  causa_p2        TEXT,
  causa_p3        TEXT,
  causa_texto     TEXT,
  gerente_num     VARCHAR(20),
  auth_gerente    TEXT         DEFAULT 'pendiente' CHECK (auth_gerente IN ('pendiente','autorizado','rechazado')),
  auth_gerente_num VARCHAR(20),
  auth_gerente_ts TIMESTAMPTZ,
  notas           TEXT
);

ALTER TABLE sabados_laborados ADD COLUMN IF NOT EXISTS causa_grupo TEXT;
ALTER TABLE sabados_laborados ADD COLUMN IF NOT EXISTS gerente_num VARCHAR(20);

-- ──────────────────────────────────────────────────────────────────
-- TABLA: notificaciones
-- ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notificaciones (
  id          SERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ DEFAULT NOW(),
  para_num    VARCHAR(20) NOT NULL,
  de_num      VARCHAR(20),
  tipo        TEXT,       -- 'hora_extra' | 'sabado' | 'auth_gerente' | 'resultado'
  referencia  TEXT,
  asunto      TEXT,
  cuerpo      TEXT,
  leida       BOOLEAN DEFAULT FALSE
);

-- ──────────────────────────────────────────────────────────────────
-- ÍNDICES
-- El monitor y el reporte filtran por (num_emp, fecha) y por rango de
-- fechas. Sin estos índices Postgres recorría la tabla completa en
-- cada carga del monitor.
-- ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_he_num_fecha   ON horas_extras(num_emp, fecha);
CREATE INDEX IF NOT EXISTS idx_he_fecha       ON horas_extras(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_he_ts          ON horas_extras(ts DESC);
CREATE INDEX IF NOT EXISTS idx_he_estado      ON horas_extras(estado_final);
CREATE INDEX IF NOT EXISTS idx_he_auth_jefe   ON horas_extras(auth_jefe)    WHERE auth_jefe    = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_he_auth_ger    ON horas_extras(auth_gerente) WHERE auth_gerente = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_usr_jefe       ON usuarios(jefe_num)    WHERE activo = TRUE;
CREATE INDEX IF NOT EXISTS idx_usr_gerente    ON usuarios(gerente_num) WHERE activo = TRUE;
CREATE INDEX IF NOT EXISTS idx_usr_activo     ON usuarios(activo);
CREATE INDEX IF NOT EXISTS idx_sab_jefe       ON sabados_laborados(jefe_num);
CREATE INDEX IF NOT EXISTS idx_sab_fecha      ON sabados_laborados(fecha_sabado DESC);
CREATE INDEX IF NOT EXISTS idx_sab_personal   ON sabados_laborados USING GIN (personal);
CREATE INDEX IF NOT EXISTS idx_noti_para      ON notificaciones(para_num, leida);

-- Un solo registro vigente por empleado y día, garantizado por la base
-- de datos (antes sólo lo validaba la aplicación, así que dos clics
-- rápidos podían insertar dos veces).
CREATE UNIQUE INDEX IF NOT EXISTS uq_he_emp_dia
  ON horas_extras(num_emp, fecha)
  WHERE estado_final <> 'rechazado';

-- ══════════════════════════════════════════════════════════════════
-- DATOS INICIALES — CATÁLOGO DE PERSONAL
--
-- Contraseñas iniciales (en texto plano aquí; el sistema las cifra
-- automáticamente con bcrypt la primera vez que cada persona entra):
--   Admin    → Admin2026
--   Gerentes → Gerente2026
--   Jefes    → Jefe2026
--   Operarios→ GPA2026
--
-- ON CONFLICT DO NOTHING: si el empleado ya existe no se toca, así que
-- este bloque nunca sobreescribe una contraseña ya cifrada.
-- ══════════════════════════════════════════════════════════════════
INSERT INTO usuarios (num_emp,password,nombre,puesto,ubicacion,depto,rol,jefe_num,gerente_num,email) VALUES

-- ── ADMIN ──────────────────────────────────────────────────
('0000','Admin2026','Administrador','Administrador del Sistema','Corporativo Guadalajara','TI','admin',NULL,NULL,'admin@gpa.com.mx'),

-- ── GERENTES ───────────────────────────────────────────────
('8101','Gerente2026','LOMELI LLAMAS JOSE MIGUEL','Gerente Cadena de Suministro','Corporativo Guadalajara','Cadena de Suministro','gerente',NULL,NULL,'jmlomelil@gpa.com.mx'),
('8021','Gerente2026','JAIME LANDEROS OSWALDO','Gerente Cadena de Suministro','Corporativo Guadalajara','Cadena de Suministro','gerente',NULL,NULL,'ojaime@gpa.com.mx'),
('8137','Gerente2026','CABRERA RODRIGUEZ OSCAR','Gerente de Administración','Corporativo Guadalajara','Administración','gerente',NULL,NULL,'ocabrera@gpa.com.mx'),
('8185','Gerente2026','MARTINEZ AGUILAR SANDRA LUZ','Gerente de Compras y Tráfico','Corporativo Guadalajara','Compras','gerente',NULL,NULL,'smartinez@gpa.com.mx'),
('8244','Gerente2026','RODRIGUEZ SUAREZ ANA ROSA','Gerente de Capital Humano','Corporativo Guadalajara','Capital Humano','gerente',NULL,NULL,'arodriguez@gpa.com.mx'),

-- ── JEFES ──────────────────────────────────────────────────
('240','Jefe2026','CERVANTES GONZALEZ JOSE GUADALUPE','Jefe de CEDIS','Corporativo Guadalajara','Almacén','jefe','8101','8101','jcervantes@gpa.com.mx'),
('8020','Jefe2026','GUTIERREZ NAVARRO LORENZO','Jefe de Almacén Gdl','Sucursal Guadalajara','Almacén','jefe','8101','8101','lgutierrez@gpa.com.mx'),
('8182','Jefe2026','CORONADO AVIÑA MIGUEL','Jefe de Almacén','Sucursal Guadalajara','Almacén','jefe','8101','8101','mcoronado@gpa.com.mx'),
('2052','Jefe2026','ROBLEDO SULVARAN GERARDO','Jefe de Almacén','Sucursal Cancun','Almacén','jefe','8101','8101','grobledo@gpa.com.mx'),
('3063','Jefe2026','CORDERO OCHOA CESAR DANIEL','Jefe de Almacén','Sucursal Puerto Vallarta','Almacén','jefe','8101','8101','ccordero@gpa.com.mx'),
('4079','Jefe2026','ROSAS RIVERA ANDRES','Jefe de Almacén','Sucursal Mexico','Almacén','jefe','8101','8101','arosas@gpa.com.mx'),
('5022','Jefe2026','GONZALEZ LOPEZ SERGIO RENE','Jefe de Almacén','Sucursal Monterrey','Almacén','jefe','8101','8101','sgonzalez@gpa.com.mx'),
('6017','Jefe2026','CABRERA REYES JUAN VICTOR','Jefe de Almacén','Sucursal Cabos','Almacén','jefe','8101','8101','jcabrera@gpa.com.mx'),
('7009','Jefe2026','BECERRA VELAZQUEZ CESAR DE JESUS','Jefe de Planta','TISA','Tisa','jefe','8101','8101','cbecerra@gpa.com.mx'),
('8197','Jefe2026','BERNAL PLASCENCIA ANDRES','Auditor de Procesos','Corporativo Guadalajara','Procesos','jefe','8101','8101','abernal@gpa.com.mx'),
('222','Jefe2026','TORRES GARCIA KARLA JIMENA','Jefe Nacional de Logística','Corporativo Guadalajara','Logística','jefe','8101','8101','ktorres@gpa.com.mx'),
('8002','Jefe2026','MUGICA CASILLAS HECTOR ENRIQUE','Jefe de Tesorería','Corporativo Guadalajara','Tesorería','jefe','8137','8137','hmugica@gpa.com.mx'),
('8031','Jefe2026','BAEZ ALFEREZ MARIA ISABEL','Jefe de Crédito y Cobranza','Corporativo Guadalajara','Crédito y Cobranza','jefe','8137','8137','mbaez@gpa.com.mx'),
('372','Jefe2026','CIBRIAN VELAZQUEZ KARLA ALEJANDRA','Jefe de Marketing','Corporativo Guadalajara','Marketing','jefe','8137','8137','kcibrian@gpa.com.mx'),
('8109','Jefe2026','CORONA BAUTISTA JESUS LEONARDO','Jefe de Soporte e Infraestructura','Corporativo Guadalajara','Sistemas','jefe','8137','8137','lcorona@gpa.com.mx'),
('8246','Jefe2026','CORONA SANCHEZ SAULO','Jefe de Mantenimiento','Corporativo Guadalajara','Mantenimiento','jefe','8137','8137','scorona@gpa.com.mx'),

-- ── OPERARIOS — Corporativo GDL / Almacén ──────────────────
('8','GPA2026','CONTRERAS ORNELAS JAIME','Auditor Interno de Inventarios','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('101','GPA2026','CABRERA CHAVEZ RUBEN','Líder de Consolidación','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('140','GPA2026','NAVARRO CASAS RAUL EVERARDO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('149','GPA2026','LOMELI MARTINEZ RIGOBERTO','Chofer Almacenista','Corporativo Guadalajara','Logística','operario','222','8101',NULL),
('215','GPA2026','CARRILLO ESPINOZA CARLOS JAVIER','Líder de Recibo y Almacenaje','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('256','GPA2026','ARIAS RAMIREZ MOISES ALEJANDRO','Líder de Dispersión','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('264','GPA2026','GUTIERREZ ORTEGA IAN ALFREDO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('273','GPA2026','ORTIZ HERNANDEZ ROBERTO MIGUEL','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('324','GPA2026','MOLINA LEYVA MIGUEL ANGEL','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('358','GPA2026','ORTIZ HERNANDEZ RAYMUNDO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('363','GPA2026','CARRILLO DE LEON BRAULIO YAEL','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('366','GPA2026','CERVANTES PERALES RAMON','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('367','GPA2026','MARTINEZ DIAZ JORGE ALBERTO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('384','GPA2026','BELTRAN RODRIGUEZ JOSE LUIS','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('390','GPA2026','CORONEL BARBOSA DANIEL ALEJANDRO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('396','GPA2026','VENTURA SANTOS JOSE FRANCISCO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('406','GPA2026','FARIAS HERNANDEZ LUIS ALBERTO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('407','GPA2026','HERRERA LARA CARLOS FABIAN','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('8254','GPA2026','RUVALCABA VARGAS ALONSO','Almacenista','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),
('8012','GPA2026','GONZALEZ RANGEL MARCOS','Analista de CEDIS','Corporativo Guadalajara','Almacén','operario','240','8101',NULL),

-- ── OPERARIOS — Sucursal GDL / Almacén ─────────────────────
('43','GPA2026','COLMENERO GAZCA GUILLERMO DE JESUS','Líder de Almacenaje','Sucursal Guadalajara','Almacén','operario','8020','8101',NULL),
('51','GPA2026','ELIZONDO LANDA EMMANUEL','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8020','8101',NULL),
('122','GPA2026','GALLARDO MARROQUIN JOSE DAVID','Analista de Almacén','Sucursal Guadalajara','Almacén','operario','8020','8101',NULL),
('147','GPA2026','VEGA CERVANTES MARCO ANTONIO','Almacenista túneles-cuartos','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('216','GPA2026','HERNANDEZ ZAMORA FRANCISCO JAVIER','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('277','GPA2026','CUEVAS MIRANDA LUIS ENRIQUE','Validador de Surtido','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('317','GPA2026','BERNAL ESQUIVEL CRISTIAN ABRAHAM','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('320','GPA2026','ROMERO ANDALON FERNANDO','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('322','GPA2026','TORRES HERNANDEZ ERIC SAMUEL','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('325','GPA2026','HUERTA GARCIA EDGAR ARTURO','Validador de Surtido','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('329','GPA2026','BENITEZ RENTERIA GIOVANNI PAUL','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('336','GPA2026','OJEDA RAMOS JUAN FELIPE','Líder de Surtido','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('341','GPA2026','BAÑUELOS NAVARRO JORGE ANTONIO','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('346','GPA2026','IBARRA ZARAGOZA DIEGO JAIR','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('348','GPA2026','VILLA REYNA ERICK ALFREDO','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('364','GPA2026','CANDELARIO RIVERA LUIS MANUEL','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('375','GPA2026','LEPE DOMINGUEZ AXEL ALEJANDRO','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('376','GPA2026','RENTERIA AVILA MIGUEL ALEJANDRO','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('387','GPA2026','RIOS MEZA VICTOR MANUEL','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('391','GPA2026','DE DIOS SOLIS MAURICIO','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('394','GPA2026','CANO PATIÑO JUAN ANTONIO','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('397','GPA2026','PEREZ TELLEZ OSWALDO ISRAEL','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('405','GPA2026','SWAN PARRA NOEL','Chofer Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),
('411','GPA2026','GONZALEZ ROJAS JULIO ALBERTO','Almacenista','Sucursal Guadalajara','Almacén','operario','8182','8101',NULL),

-- ── LOGÍSTICA GDL ──────────────────────────────────────────
('335','GPA2026','RUIZ LOZANO ULISES IMANOL','Líder de Logística','Sucursal Guadalajara','Logística','operario','222','8101',NULL),
('319','GPA2026','BARRETO ANTONIO LORENA','Ejecutivo de Logística','Corporativo Guadalajara','Logística','operario','222','8101',NULL),
('8263','GPA2026','ALCANTARA AVILA VIRIDIANA BETZABE','Auxiliar de Logística','Corporativo Guadalajara','Logística','operario','222','8101',NULL),

-- ── CANCÚN ─────────────────────────────────────────────────
('2044','GPA2026','RIVERA PERERA JOSE ENRIQUE','Líder de Almacén','Sucursal Cancun','Almacén','operario','2052','8101',NULL),
('2070','GPA2026','MORA LAVADORES JAVIER','Chofer Almacenista','Sucursal Cancun','Almacén','operario','2052','8101',NULL),
('2072','GPA2026','HOY VALENCIA FELIPE','Chofer Almacenista','Sucursal Cancun','Almacén','operario','2052','8101',NULL),
('2073','GPA2026','BRITO VARGAS EDWIN RUBICEL','Almacenista','Sucursal Cancun','Almacén','operario','2052','8101',NULL),
('2075','GPA2026','SAMPE HERNANDEZ ROGER ESTEBAN','Almacenista','Sucursal Cancun','Almacén','operario','2052','8101',NULL),
('2078','GPA2026','ARAUJO PECH JUAN ANTONIO','Chofer Almacenista','Sucursal Cancun','Almacén','operario','2052','8101',NULL),
('2079','GPA2026','RODRIGUEZ RODRIGUEZ JESUS','Chofer Almacenista','Sucursal Cancun','Almacén','operario','2052','8101',NULL),

-- ── PUERTO VALLARTA ────────────────────────────────────────
('3054','GPA2026','OLIVO PULGARIN JUAN CARLOS','Chofer Almacenista','Sucursal Puerto Vallarta','Almacén','operario','3063','8101',NULL),
('3056','GPA2026','LOPEZ ALVARADO FRANCISCO NAHUM','Líder de Almacén','Sucursal Puerto Vallarta','Almacén','operario','3063','8101',NULL),
('3058','GPA2026','CARLOS LOPEZ EDGAR FERNANDO','Chofer Almacenista','Sucursal Puerto Vallarta','Almacén','operario','3063','8101',NULL),
('3059','GPA2026','VARGAS NERI JOSE FRANCISCO','Chofer Almacenista','Sucursal Puerto Vallarta','Almacén','operario','3063','8101',NULL),
('3061','GPA2026','RIVERA AGUILAR FERNANDO ANTONIO','Chofer Almacenista','Sucursal Puerto Vallarta','Almacén','operario','3063','8101',NULL),
('3062','GPA2026','ESTRADA HERNANDEZ RICARDO','Chofer Almacenista','Sucursal Puerto Vallarta','Almacén','operario','3063','8101',NULL),

-- ── CDMX ───────────────────────────────────────────────────
('2077','GPA2026','MARTINEZ TREJO JOSE IVAN','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4052','GPA2026','RAMON GONZALEZ ERIK DANIEL','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4069','GPA2026','MORALES FLORES BRAYAN YAIR','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4071','GPA2026','GARCIA DE LEON VILLA JOSE CARLOS','Líder de Almacén','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4073','GPA2026','VEGA RODRIGUEZ JOSE ANTONIO','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4075','GPA2026','PAULINO FLORES LUIS DANIEL','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4077','GPA2026','BASTIDA VERA DANIEL ANDRES','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4081','GPA2026','BAEZ RAMIREZ EDUARDO','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4082','GPA2026','ROMAN JULIAN HECTOR DAVID','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4085','GPA2026','ZUÑIGA ROMAN ALFONSO','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4086','GPA2026','RAMIREZ ALVAREZ CARLOS GUSTAVO','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),
('4087','GPA2026','VALLEJO LOPEZ CARLOS DANIEL','Chofer Almacenista','Sucursal Mexico','Almacén','operario','4079','8101',NULL),

-- ── MONTERREY ──────────────────────────────────────────────
('272','GPA2026','ALFARO PALOMO EMILIO EMMANUEL','Chofer Almacenista','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),
('5029','GPA2026','ALFARO HERNANDEZ JUAN DANIEL','Líder de Almacén','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),
('5030','GPA2026','ADAME CABALLERO SERGIO MISAEL','Líder de Almacén','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),
('5033','GPA2026','PEREZ CRUZ DAVID ALEJANDRO','Chofer Almacenista','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),
('5044','GPA2026','LOPEZ BELMARES JUAN PAULO','Almacenista','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),
('5057','GPA2026','MARTINEZ BELMARES JONATHAN FRANCISCO','Chofer Almacenista','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),
('5066','GPA2026','PINEDA MORALES CRUZ WILLIAM','Chofer Almacenista','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),
('5067','GPA2026','GONZALEZ IZQUIERDO HERNAN FABRICIO','Chofer Almacenista','Sucursal Monterrey','Almacén','operario','5022','8101',NULL),

-- ── CABOS ──────────────────────────────────────────────────
('6019','GPA2026','OLEA TORNEZ JULIO ALBERTO','Líder de Almacén','Sucursal Cabos','Almacén','operario','6017','8101',NULL),
('6030','GPA2026','NAVARRO CASTRO CARLOS DANIEL','Chofer Almacenista','Sucursal Cabos','Almacén','operario','6017','8101',NULL),
('6034','GPA2026','MENDOZA NIEVES DIEGO EMMANUEL','Chofer Almacenista','Sucursal Cabos','Almacén','operario','6017','8101',NULL),
('6037','GPA2026','VILLAGRANA ORTIZ JOB GERARDO','Chofer Almacenista','Sucursal Cabos','Almacén','operario','6017','8101',NULL),

-- ── TISA ───────────────────────────────────────────────────
('7008','GPA2026','OCHOA MEDINA IVAN DE JESUS','Líder de Almacén y Producción','TISA','Tisa','operario','7009','8101',NULL),
('7023','GPA2026','GONZALEZ MEJIA ALBERTO DE JESUS','Operador Logístico y Producción','TISA','Tisa','operario','7009','8101',NULL),
('7040','GPA2026','RODRIGUEZ CHAVEZ DAVID ALEJANDRO','Operador de Estiba doble y Producción','TISA','Tisa','operario','7009','8101',NULL),
('7042','GPA2026','CORTES GONZALEZ LUCIO ISAIAS','Operador de Estiba y Producción','TISA','Tisa','operario','7009','8101',NULL),
('7047','GPA2026','PRECIADO HERNANDEZ ALFREDO','Operador de Estiba doble y Producción','TISA','Tisa','operario','7009','8101',NULL),
('7048','GPA2026','HERNANDEZ VENTURA YONATHAN JOSUE','Auxiliar General','TISA','Tisa','operario','7009','8101',NULL),
('7054','GPA2026','CARRILLO ANGUIANO DAVID','Auxiliar General','TISA','Tisa','operario','7009','8101',NULL),
('7055','GPA2026','PEREZ JIMENEZ MIGUEL ANGEL','Auxiliar General','TISA','Tisa','operario','7009','8101',NULL),
('7056','GPA2026','AMERICANO RIOS ESTEBAN','Auxiliar General','TISA','Tisa','operario','7009','8101',NULL),

-- ── RESTO DEL PERSONAL ─────────────────────────────────────
('399','GPA2026','PRECIADO SEDANO CESAR MANUEL','Gerente Regional Guadalajara','Sucursal Guadalajara','Ventas','operario','8137','8137',NULL),
('2012','GPA2026','GUERRA PEREZ JOSE LUIS','Gerente de Sucursal','Sucursal Cancun','Ventas','operario','8137','8137',NULL),
('3025','GPA2026','LUJAN PERALTA DANIEL GABINO','Gerente de Sucursal','Sucursal Puerto Vallarta','Ventas','operario','8137','8137',NULL),
('4045','GPA2026','GARCIA BARBOSA ALEJANDRO ULISES','Gerente de Sucursal','Sucursal Mexico','Ventas','operario','8137','8137',NULL),
('5043','GPA2026','RODRIGUEZ ZURITA JORGE ALBERTO','Gerente de Sucursal','Sucursal Monterrey','Ventas','operario','8137','8137',NULL),
('6000','GPA2026','MARTINEZ AYON ALEJANDRO','Gerente de Sucursal','Sucursal Cabos','Ventas','operario','8137','8137',NULL),
('8001','GPA2026','MEDRANO CARDENAS CECILIA','Gerente Nacional de Ventas','Corporativo Guadalajara','Ventas','operario','8137','8137',NULL),
('8165','GPA2026','LEON FRIAS LUIS ANTONIO','Contador General','Corporativo Guadalajara','Contabilidad','operario','8137','8137',NULL),
('8133','GPA2026','JUAN ALVARADO JOEL','Coordinador de Capacitación','Corporativo Guadalajara','Capacitación','operario','8137','8137',NULL),
('1','GPA2026','RODRIGUEZ TRUJILLO MARGARITA CONCEPCION','Ejecutivo de Ventas','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('35','GPA2026','MENDEZ MARTINEZ ALMA ESTELA','Ejecutivo de Ventas','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('59','GPA2026','ROJAS HERRERA PERLA DANIELA','Ejecutivo de Ventas','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('123','GPA2026','SANCHEZ CORTES ANGEL DE JESUS','Coordinador Nacional Mesa de Control','Corporativo Guadalajara','Administración','operario','8137','8137',NULL),
('146','GPA2026','IBARRA QUIROZ KEVIN','Auditor de Calidad','Sucursal Guadalajara','Control Interno','operario','8197','8101',NULL),
('164','GPA2026','PEREZ MORALES EDGARDO','Auditor de Puerta','Sucursal Guadalajara','Control Interno','operario','8197','8101',NULL),
('172','GPA2026','CISNEROS AMEZCUA LUIS FRANCISCO','Ejecutivo de Ventas','Sucursal Monterrey','Ventas','operario','5043','5043',NULL),
('177','GPA2026','PONCE GARCIA FRANCISCO JAVIER','Auditor de Puerta','Corporativo Guadalajara','Control Interno','operario','8197','8101',NULL),
('223','GPA2026','LOPEZ GALVAN JESUS ABRAHAM','Devoluciones','Corporativo Guadalajara','Servicio Post Venta','operario','8137','8137',NULL),
('228','GPA2026','GUZMAN BAÑUELOS ALEJANDRA DEL CARMEN','Auxiliar Administrativo','Corporativo Guadalajara','Administración','operario','8137','8137',NULL),
('234','GPA2026','SOLANO ALVARADO BRANDON GIOVANNI','Auditor de Almacenes','Corporativo Guadalajara','Control Interno','operario','8197','8101',NULL),
('300','GPA2026','ESPINO MEDRANO MARIO ALBERTO','Ejecutivo de Ventas','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('347','GPA2026','GONZALEZ HERNANDEZ GERARDO ALEJANDRO','Ejecutivo de Ventas','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('368','GPA2026','MERCADO BERRIOS THALIA ANDREA','Analista de Crédito y Cobranza','Corporativo Guadalajara','Crédito y Cobranza','operario','8031','8137',NULL),
('379','GPA2026','GODINEZ GUTIERREZ ROSA YAHAIRA','Analista de Crédito y Cobranza','Sucursal Guadalajara','Crédito y Cobranza','operario','8031','8137',NULL),
('380','GPA2026','HERNANDEZ MALDONADO CRISTAL','Analista de Crédito y Cobranza','Sucursal Guadalajara','Crédito y Cobranza','operario','8031','8137',NULL),
('381','GPA2026','MACIAS CUEVAS GUSTAVO','Ejecutivo Mesa de Control','Sucursal Guadalajara','Administración','operario','8137','8137',NULL),
('383','GPA2026','ORTIZ LARA FABIOLA GUADALUPE','Ejecutivo de Ventas','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('385','GPA2026','BENITEZ CRUZ LUIS MANUEL','Auxiliar de Mantenimiento','Corporativo Guadalajara','Mantenimiento','operario','8246','8137',NULL),
('400','GPA2026','BAÑUELOS AVILA CESAR','Asesor Comercial','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('404','GPA2026','MENDOZA LAZCANO RICARDO','Técnico Especialista','Sucursal Guadalajara','Servicio Post Venta','operario','8137','8137',NULL),
('408','GPA2026','MANCILLA VELAZCO LILIANA JEANET','Auxiliar Mesa de Control','Corporativo Guadalajara','Administración','operario','8137','8137',NULL),
('409','GPA2026','SALAZAR FAVELA DENISSE LILIANA','Ejecutivo de Ventas','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('410','GPA2026','PALAFOX JOAQUIN ICELA YADIRA','Ejecutivo de Apoyo Comercial','Sucursal Guadalajara','Ventas','operario','399','399',NULL),
('2000','GPA2026','AGUAYO HERNANDEZ ANTONIO','Ejecutivo de Ventas','Sucursal Cancun','Ventas','operario','2012','2012',NULL),
('2048','GPA2026','FUENTES MENDEZ DANIELA GUADALUPE','Analista de Crédito y Cobranza','Sucursal Cancun','Crédito y Cobranza','operario','8031','8137',NULL),
('2057','GPA2026','SANCHEZ AGUILAR LARLY MARTIN','Ejecutivo de Ventas','Sucursal Cancun','Ventas','operario','2012','2012',NULL),
('2068','GPA2026','ANTONIO MENDOZA JESSICA','Ejecutivo de Ventas','Sucursal Cancun','Ventas','operario','2012','2012',NULL),
('2074','GPA2026','PEREZ HUERTA LITZY YAMILE','Auxiliar de Limpieza','Sucursal Cancun','Administración','operario','2052','8101',NULL),
('3002','GPA2026','RUELAS CASTILLON LIDIA MARISSA','Ejecutivo de Ventas','Sucursal Puerto Vallarta','Ventas','operario','3025','3025',NULL),
('3014','GPA2026','LARA POLANCO IVAN','Técnico de Servicio y Mantenimiento','Sucursal Puerto Vallarta','Servicio Post Venta','operario','3025','3025',NULL),
('3047','GPA2026','PEREZ SEVILLA CHRISTIAN LIZBETH','Analista de Crédito y Cobranza','Sucursal Puerto Vallarta','Crédito y Cobranza','operario','8031','8137',NULL),
('4048','GPA2026','MARTINEZ OSORNIO DULCE CAROLINA','Ejecutivo de Ventas','Sucursal Mexico','Ventas','operario','4045','4045',NULL),
('4054','GPA2026','LOPEZ LOZANO ARMANDO','Ejecutivo de Ventas','Sucursal Mexico','Ventas','operario','4045','4045',NULL),
('4065','GPA2026','GARCIA VALDES OSCAR','Ejecutivo de Ventas','Sucursal Mexico','Ventas','operario','4045','4045',NULL),
('4080','GPA2026','CARRANZA OCAMPO ANDREA CITLALI','Analista de Crédito y Cobranza','Sucursal Mexico','Crédito y Cobranza','operario','8031','8137',NULL),
('4088','GPA2026','CARRETO BARRERA JARED','Ejecutivo de Ventas','Sucursal Mexico','Ventas','operario','4045','4045',NULL),
('4089','GPA2026','MACIAS LOYOLA CARLOS ALBERTO','Técnico de Servicio y Mantenimiento','Sucursal Mexico','Servicio Post Venta','operario','4045','4045',NULL),
('5000','GPA2026','RUIZ JIMENEZ FLOR','Subgerente Nacional de Ventas','Corporativo Guadalajara','Ventas','operario','8001','8001',NULL),
('5032','GPA2026','VIVEROS DOMINGUEZ LUIS EMILIO','Ejecutivo de Ventas','Sucursal Monterrey','Ventas','operario','5043','5043',NULL),
('5038','GPA2026','TELLEZ LUNA ANA LIDIA','Analista de Crédito y Cobranza','Sucursal Monterrey','Crédito y Cobranza','operario','8031','8137',NULL),
('5039','GPA2026','MACIAS RIVERA OSCAR URIEL','Ejecutivo de Ventas','Sucursal Monterrey','Ventas','operario','5043','5043',NULL),
('5055','GPA2026','MAZA VILLAGRANA DIEGO','Técnico de Servicio y Mantenimiento','Sucursal Monterrey','Servicio Post Venta','operario','5043','5043',NULL),
('5063','GPA2026','RODRIGUEZ JIMENEZ GERARDO','Auxiliar de Limpieza','Sucursal Monterrey','Administración','operario','5022','8101',NULL),
('6008','GPA2026','MARTINEZ TAQUILLO JUAN PABLO','Analista de Crédito y Cobranza','Sucursal Cabos','Crédito y Cobranza','operario','8031','8137',NULL),
('6028','GPA2026','MARTINEZ CASTRO LILIANA','Ejecutivo de Ventas','Sucursal Cabos','Ventas','operario','6000','6000',NULL),
('6035','GPA2026','HILARIO MARTINEZ ELOISA SENAIDA','Auxiliar de Limpieza','Sucursal Cabos','Administración','operario','6017','8101',NULL),
('6038','GPA2026','SANCHEZ ZOQUIAPA ALEJANDRO','Ejecutivo de Ventas','Sucursal Cabos','Ventas','operario','6000','6000',NULL),
('8003','GPA2026','VARGAS MEJIA ROSALBA','Recepcionista','Corporativo Guadalajara','Capital Humano','operario','8244','8244',NULL),
('8006','GPA2026','SANCHEZ LEAL CARLOS EDUARDO','Community Manager','Corporativo Guadalajara','Marketing','operario','372','8137',NULL),
('8009','GPA2026','VALDIVIA ALONSO MARIA DE JESUS','Cuentas por Pagar','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL),
('8010','GPA2026','OCAMPO ALVAREZ SERGIO ALEJANDRO','Administrador de Infraestructura','Corporativo Guadalajara','Sistemas','operario','8109','8137',NULL),
('8051','GPA2026','MARTINEZ MARTINEZ FLORENCIO SALVADOR','Analista de Mejora Continua','Corporativo Guadalajara','Cadena de Suministro','operario','8101','8101',NULL),
('8058','GPA2026','LANDEROS OCAMPO LUIS EDER','Auditor Operativo','Corporativo Guadalajara','Control Interno','operario','8197','8101',NULL),
('8059','GPA2026','SALCEDO LOPEZ ORLANDO VINICIO','Ingenieria','Corporativo Guadalajara','Especificación','operario','8137','8137',NULL),
('8062','GPA2026','GUZMAN BEDOLLA IVAN ULISES','Coordinador de Compras y Tráfico B','Corporativo Guadalajara','Compras','operario','8185','8185',NULL),
('8066','GPA2026','TEJEDA SANTA ANA JOSE RUBEN','Analista de Información','Corporativo Guadalajara','Sistemas','operario','8109','8137',NULL),
('8075','GPA2026','MEDINA GONZALEZ GABRIEL','Coordinador de Seguridad e Higiene','Corporativo Guadalajara','Seguridad e Higiene','operario','8137','8137',NULL),
('8088','GPA2026','RAMIREZ RUVALCABA NESTOR ABRAHAM','Comprador de Indirectos','Corporativo Guadalajara','Insumos','operario','8185','8185',NULL),
('8089','GPA2026','BECERRA ESPARZA GLORIA','Reclutador','Corporativo Guadalajara','Capital Humano','operario','8244','8244',NULL),
('8098','GPA2026','TORRES MARTINEZ GABRIEL','Contralor','Corporativo Guadalajara','Contraloría','operario','8137','8137',NULL),
('8151','GPA2026','GONZALEZ ESPINOZA BRAYAN ADAN','Coordinador de Crédito y Cobranza','Corporativo Guadalajara','Crédito y Cobranza','operario','8031','8137',NULL),
('8153','GPA2026','ARREDONDO MAESTRO MIGUEL ANGEL','Gerente de Telemarketing','Corporativo Guadalajara','Ventas','operario','8137','8137',NULL),
('8166','GPA2026','FIGUEROA CHAVEZ ANA GRECIA','Contador Senior','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL),
('8174','GPA2026','ZUÑIGA VILLEGAS JORGE','Entrenador','Corporativo Guadalajara','Capacitación','operario','8133','8137',NULL),
('8175','GPA2026','OROZCO ZEPEDA ANDRES ROBERTO','Becario de Procesos','Corporativo Guadalajara','Mejora Continua','operario','8197','8101',NULL),
('8195','GPA2026','BASTIDAS FIGUEROA JESUS IVAN','Reclutador Senior','Corporativo Guadalajara','Capital Humano','operario','8244','8244',NULL),
('8204','GPA2026','NAPOLES BUTANDA JONATHAN EDUARDO','Auditor de Almacenes','Corporativo Guadalajara','Control Interno','operario','8197','8101',NULL),
('8208','GPA2026','TORRES MENDEZ ERIC MIGUEL','Programador','Corporativo Guadalajara','Sistemas','operario','8109','8137',NULL),
('8215','GPA2026','RAMIREZ GARCIA CARLOS EDUARDO','Especialista de Control Interno','Corporativo Guadalajara','Control Interno','operario','8197','8101',NULL),
('8217','GPA2026','GONZALEZ SANDOVAL IVETH KARINA','Analista de Capital Humano','Corporativo Guadalajara','Capital Humano','operario','8244','8244',NULL),
('8219','GPA2026','HERNANDEZ LIMON TANIA PAMELA CAROLINA','Analista de Sistemas','Corporativo Guadalajara','Sistemas','operario','8109','8137',NULL),
('8220','GPA2026','DEL ANGEL NARANJO SOLEDAD','Auxiliar Contable','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL),
('8223','GPA2026','FERRAL ARANDA JOSE ALBERTO','Coordinador de Compras y Tráfico A','Corporativo Guadalajara','Compras','operario','8185','8185',NULL),
('8224','GPA2026','DE ANDA OCHOA JENNIFER SARAI','Auxiliar de Comercio Exterior','Corporativo Guadalajara','Compras','operario','8185','8185',NULL),
('8230','GPA2026','NAVARES OROZCO EMILIANO','Analista de Tesorería','Corporativo Guadalajara','Tesorería','operario','8002','8137',NULL),
('8232','GPA2026','MARTINEZ NUÑEZ GUADALUPE NAZARET','Compras y Tráfico','Corporativo Guadalajara','Compras','operario','8185','8185',NULL),
('8237','GPA2026','GONZALEZ REYES ARCELIA','Administrador de Personal','Corporativo Guadalajara','Capital Humano','operario','8244','8244',NULL),
('8238','GPA2026','ESPINOZA BUCIO JOSE CRUZ','Especialista de Control Interno','Corporativo Guadalajara','Control Interno','operario','8197','8101',NULL),
('8240','GPA2026','ARRATIA ORTIZ KARLA','Administrador de Riesgos','Corporativo Guadalajara','Administración','operario','8137','8137',NULL),
('8247','GPA2026','ALVARADO IBAÑEZ ELIA LETICIA','Contador Senior','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL),
('8248','GPA2026','VILLASEÑOR ROSAS ELISEO','Técnico','Sucursal Guadalajara','Servicio Post Venta','operario','8182','8101',NULL),
('8250','GPA2026','ELIZALDE PONCE MIGUEL ANGEL','Auxiliar de Mantenimiento','Corporativo Guadalajara','Mantenimiento','operario','8246','8137',NULL),
('8251','GPA2026','GUZMAN CRUZ KARINA GUADALUPE','Documentador de Procesos','Corporativo Guadalajara','Control Interno','operario','8197','8101',NULL),
('8257','GPA2026','LOPEZ MERAZ OSCAR EDUARDO','Compras y Tráfico','Corporativo Guadalajara','Compras','operario','8185','8185',NULL),
('8261','GPA2026','VILLA CASTILLO JULIO ADRIAN','Administrador de Ventas','Corporativo Guadalajara','Marketing','operario','372','8137',NULL),
('8264','GPA2026','ALVARADO FIGUEROA ABRAHAM','Médico Laboral','Corporativo Guadalajara','Medicina Laboral','operario','8244','8244',NULL),
('8265','GPA2026','CARREON GARCIA DIANA FERNANDA','Atención a Clientes','Corporativo Guadalajara','Servicio Post Venta','operario','8137','8137',NULL),
('8270','GPA2026','GARCIA JIMENEZ OSCAR ISAIAS','Especialista de Control Interno','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL),
('8271','GPA2026','ESPARZA BAUTISTA ROSA YESENIA','Auxiliar Contable','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL),
('8272','GPA2026','GUTIERREZ TERREROS MIRIAM ALEJANDRA','Analista de Costos','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL),
('8274','GPA2026','CARREON GARCIA FATIMA DOLORES','Analista de Capacitación','Corporativo Guadalajara','Capacitación','operario','8133','8137',NULL),
('8276','GPA2026','MERCADO VIRGEN DANIELA LUCIA','Promoción y Publicidad','Corporativo Guadalajara','Marketing','operario','372','8137',NULL),
('8277','GPA2026','BUSTOS REYNOSO KEVIN ALFREDO','Diseñador Gráfico','Corporativo Guadalajara','Marketing','operario','372','8137',NULL),
('8278','GPA2026','VALENZUELA DE SANTIAGO MARIO ALEJANDRO','Compras y Tráfico','Corporativo Guadalajara','Compras','operario','8185','8185',NULL),
('8279','GPA2026','SAAVEDRA REYES CARMEN ELIZABETH','Nominista','Corporativo Guadalajara','Contabilidad','operario','8165','8137',NULL)

ON CONFLICT (num_emp) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — ejecuta esto para confirmar que todo quedó bien
-- ══════════════════════════════════════════════════════════════════
-- SELECT rol, COUNT(*) AS total FROM usuarios GROUP BY rol ORDER BY rol;
--
-- Empleados cuyo jefe no existe en el catálogo (deberían ser 0 filas):
-- SELECT u.num_emp, u.nombre, u.jefe_num FROM usuarios u
--   LEFT JOIN usuarios j ON j.num_emp = u.jefe_num
--   WHERE u.jefe_num IS NOT NULL AND j.num_emp IS NULL;
--
-- Contraseñas que siguen en texto plano (bajan solas conforme entran):
-- SELECT COUNT(*) AS sin_cifrar FROM usuarios WHERE password NOT LIKE '$2%';

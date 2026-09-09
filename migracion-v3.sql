-- ══════════════════════════════════════════════════════════════════
-- GPA HORAS EXTRAS — MIGRACIÓN v2.2 → v3.0
--
-- Qué hace esta versión:
--   · El jefe levanta la solicitud de horas extra para su personal
--     (antes cada operativo capturaba las suyas).
--   · El trabajador ACEPTA o RECHAZA, y esa aceptación se guarda como
--     firma electrónica con sello de tiempo, leyenda, IP y hash.
--   · Los sábados laborados llevan el mismo consentimiento individual.
--
-- Cómo ejecutarla:
--   1. Abre el SQL Editor de Neon.
--   2. Pega este archivo COMPLETO y ejecútalo.
--   3. Verifica en https://tu-app.vercel.app/api/diagnostico que diga
--      "estado": "TODO CORRECTO".
--
-- Es idempotente: puedes ejecutarla las veces que quieras. No borra
-- datos, no toca contraseñas y no altera el catálogo de personal.
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- ──────────────────────────────────────────────────────────────────
-- 1. HORAS_EXTRAS — quién solicitó y quién consintió
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS lote_id            TEXT;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS origen             TEXT DEFAULT 'jefe';
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS solicitante_num    VARCHAR(20);
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS solicitante_nombre TEXT;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS solicitante_ts     TIMESTAMPTZ;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS rechazado_por      TEXT;

-- Consentimiento del trabajador (firma electrónica)
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp          TEXT DEFAULT 'na';
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp_ts       TIMESTAMPTZ;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp_ip       TEXT;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp_ua       TEXT;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp_leyenda  TEXT;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp_ley_ver  TEXT;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp_hash     TEXT;
ALTER TABLE horas_extras ADD COLUMN IF NOT EXISTS acept_emp_nota     TEXT;

-- Los registros que ya existían los capturó el propio empleado: se
-- marcan como 'auto' y NO se les pide firma retroactiva.
--
-- OJO con el criterio: ADD COLUMN ... DEFAULT 'jefe' rellena los
-- renglones existentes con 'jefe', así que buscar origen IS NULL no
-- encuentra ninguno y los registros viejos quedarían marcados como si
-- los hubiera levantado un jefe. Lo que de verdad los distingue es que
-- no tienen solicitante: nadie los pidió, los capturó el empleado.
UPDATE horas_extras SET origen = 'auto'  WHERE solicitante_num IS NULL;
UPDATE horas_extras SET acept_emp = 'na' WHERE acept_emp IS NULL;

-- ──────────────────────────────────────────────────────────────────
-- 2. ESTADOS NUEVOS
--    estado_final gana 'vencido' (nadie respondió a tiempo) y
--    'cancelado' (el jefe retiró la solicitud).
--    Los CHECK originales son anónimos; Postgres los nombró
--    <tabla>_<columna>_check. Se reemplazan por constraints con
--    nombre propio para que esta migración sea repetible.
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE horas_extras DROP CONSTRAINT IF EXISTS horas_extras_estado_final_check;
ALTER TABLE horas_extras DROP CONSTRAINT IF EXISTS ck_he_estado_final;
ALTER TABLE horas_extras ADD  CONSTRAINT ck_he_estado_final
  CHECK (estado_final IN ('pendiente','autorizado','rechazado','vencido','cancelado'));

ALTER TABLE horas_extras DROP CONSTRAINT IF EXISTS ck_he_acept_emp;
ALTER TABLE horas_extras ADD  CONSTRAINT ck_he_acept_emp
  CHECK (acept_emp IN ('na','pendiente','aceptado','rechazado','vencido'));

ALTER TABLE horas_extras DROP CONSTRAINT IF EXISTS ck_he_origen;
ALTER TABLE horas_extras ADD  CONSTRAINT ck_he_origen
  CHECK (origen IN ('jefe','auto'));

ALTER TABLE horas_extras DROP CONSTRAINT IF EXISTS ck_he_rechazado_por;
ALTER TABLE horas_extras ADD  CONSTRAINT ck_he_rechazado_por
  CHECK (rechazado_por IS NULL OR rechazado_por IN ('jefe','gerente','trabajador','sistema'));

-- ──────────────────────────────────────────────────────────────────
-- 3. SÁBADOS — horas por persona y consentimiento individual
--
--    La columna personal (JSONB) se conserva para no romper nada,
--    pero a partir de la v3 la fuente de verdad es sabados_personal:
--    un renglón por persona, porque cada quien firma por separado.
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE sabados_laborados ADD COLUMN IF NOT EXISTS horas_persona NUMERIC(4,1) DEFAULT 5;

CREATE TABLE IF NOT EXISTS sabados_personal (
  id             SERIAL PRIMARY KEY,
  sabado_id      TEXT        NOT NULL REFERENCES sabados_laborados(id) ON DELETE CASCADE,
  num_emp        VARCHAR(20) NOT NULL REFERENCES usuarios(num_emp) ON UPDATE CASCADE,
  nombre         TEXT,
  puesto         TEXT,
  ubicacion      TEXT,
  horas          NUMERIC(4,1) DEFAULT 5,
  acept          TEXT         DEFAULT 'pendiente',
  acept_ts       TIMESTAMPTZ,
  acept_ip       TEXT,
  acept_ua       TEXT,
  acept_leyenda  TEXT,
  acept_ley_ver  TEXT,
  acept_hash     TEXT,
  acept_nota     TEXT,
  UNIQUE (sabado_id, num_emp)
);

ALTER TABLE sabados_personal DROP CONSTRAINT IF EXISTS ck_sp_acept;
ALTER TABLE sabados_personal ADD  CONSTRAINT ck_sp_acept
  CHECK (acept IN ('na','pendiente','aceptado','rechazado','vencido'));

-- Traslada el personal de los sábados que ya existían. Los históricos
-- quedan como 'na': no se le pide firma a nadie por un sábado que ya
-- pasó y que se autorizó bajo las reglas anteriores.
INSERT INTO sabados_personal (sabado_id, num_emp, nombre, horas, acept)
SELECT s.id,
       p->>'num_emp',
       NULLIF(p->>'nombre',''),
       COALESCE(s.horas_persona, 5),
       'na'
FROM sabados_laborados s
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.personal,'[]'::jsonb)) AS p
WHERE p->>'num_emp' IS NOT NULL
  AND EXISTS (SELECT 1 FROM usuarios u WHERE u.num_emp = p->>'num_emp')
ON CONFLICT (sabado_id, num_emp) DO NOTHING;

-- ──────────────────────────────────────────────────────────────────
-- 4. UN REGISTRO VIGENTE POR EMPLEADO Y DÍA
--
--    El índice anterior sólo excluía 'rechazado'. Con el flujo nuevo,
--    una solicitud que el trabajador rechaza o que vence sin respuesta
--    dejaría al empleado bloqueado el resto del día: el jefe no podría
--    levantar otra. El índice pasa a cubrir sólo lo que sigue vivo.
-- ──────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS uq_he_emp_dia;
CREATE UNIQUE INDEX IF NOT EXISTS uq_he_emp_dia_viva
  ON horas_extras(num_emp, fecha)
  WHERE estado_final IN ('pendiente','autorizado');

-- ──────────────────────────────────────────────────────────────────
-- 5. ÍNDICES DE LAS BANDEJAS NUEVAS
-- ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_he_bandeja_emp ON horas_extras(num_emp, fecha)
  WHERE acept_emp = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_he_lote        ON horas_extras(lote_id);
CREATE INDEX IF NOT EXISTS idx_he_solicitante ON horas_extras(solicitante_num);
CREATE INDEX IF NOT EXISTS idx_sp_sabado      ON sabados_personal(sabado_id);
CREATE INDEX IF NOT EXISTS idx_sp_emp         ON sabados_personal(num_emp);
CREATE INDEX IF NOT EXISTS idx_sp_bandeja     ON sabados_personal(num_emp)
  WHERE acept = 'pendiente';

COMMIT;

-- ══════════════════════════════════════════════════════════════════
-- COMPROBACIÓN — debe devolver una sola fila con todo en 0 problemas
-- ══════════════════════════════════════════════════════════════════
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_name='horas_extras'
      AND column_name IN ('lote_id','origen','solicitante_num','acept_emp',
                          'acept_emp_ts','acept_emp_hash','rechazado_por'))            AS cols_horas_extras_de_7,
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_name='sabados_personal')                                               AS tabla_sabados_personal,
  (SELECT COUNT(*) FROM sabados_personal)                                              AS personal_migrado,
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname='uq_he_emp_dia_viva')               AS indice_dia_vigente;

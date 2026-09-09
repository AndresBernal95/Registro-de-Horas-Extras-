-- ══════════════════════════════════════════════════════════════════
-- MIGRACIÓN v2.1 — corrige el error 500 al guardar registros
--
-- Pégalo COMPLETO en el SQL Editor de Neon y ejecútalo. Tarda 1 segundo.
-- No borra datos, no toca el catálogo de personal y no modifica ninguna
-- contraseña ya cifrada. Puedes ejecutarlo las veces que quieras.
--
-- Qué corrige:
--   · Faltaban las columnas jefe_num y gerente_num en horas_extras, que
--     las consultas de Solicitudes, Monitor y Reporte sí usaban:
--     de ahí los errores 500 en /api/registros.
--   · Faltaba causa_grupo si la base se creó con la v1: de ahí el
--     "Error al guardar el registro" al enviar la solicitud.
--   · Agrega los índices que hacen rápidos el monitor y el reporte.
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Columnas faltantes ─────────────────────────────────────────
ALTER TABLE horas_extras      ADD COLUMN IF NOT EXISTS causa_grupo TEXT;
ALTER TABLE horas_extras      ADD COLUMN IF NOT EXISTS jefe_num    VARCHAR(20);
ALTER TABLE horas_extras      ADD COLUMN IF NOT EXISTS gerente_num VARCHAR(20);

ALTER TABLE sabados_laborados ADD COLUMN IF NOT EXISTS causa_grupo TEXT;
ALTER TABLE sabados_laborados ADD COLUMN IF NOT EXISTS gerente_num VARCHAR(20);

-- Los hash de bcrypt miden 60 caracteres; VARCHAR(100) alcanza, pero
-- TEXT evita cualquier truncamiento a futuro.
ALTER TABLE usuarios ALTER COLUMN password TYPE TEXT;

-- ── 2. Rellenar la cadena de autorización de los registros ya
--       capturados, tomándola del catálogo de usuarios ────────────
UPDATE horas_extras h
   SET jefe_num    = COALESCE(h.jefe_num,    u.jefe_num),
       gerente_num = COALESCE(h.gerente_num, u.gerente_num)
  FROM usuarios u
 WHERE u.num_emp = h.num_emp
   AND (h.jefe_num IS NULL OR h.gerente_num IS NULL);

-- ── 3. Índices ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_he_num_fecha ON horas_extras(num_emp, fecha);
CREATE INDEX IF NOT EXISTS idx_he_fecha     ON horas_extras(fecha DESC);
CREATE INDEX IF NOT EXISTS idx_he_ts        ON horas_extras(ts DESC);
CREATE INDEX IF NOT EXISTS idx_he_estado    ON horas_extras(estado_final);
CREATE INDEX IF NOT EXISTS idx_he_jefe      ON horas_extras(jefe_num);
CREATE INDEX IF NOT EXISTS idx_he_gerente   ON horas_extras(gerente_num);
CREATE INDEX IF NOT EXISTS idx_he_auth_jefe ON horas_extras(auth_jefe)    WHERE auth_jefe    = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_he_auth_ger  ON horas_extras(auth_gerente) WHERE auth_gerente = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_usr_jefe     ON usuarios(jefe_num)    WHERE activo = TRUE;
CREATE INDEX IF NOT EXISTS idx_usr_gerente  ON usuarios(gerente_num) WHERE activo = TRUE;
CREATE INDEX IF NOT EXISTS idx_usr_activo   ON usuarios(activo);
CREATE INDEX IF NOT EXISTS idx_sab_jefe     ON sabados_laborados(jefe_num);
CREATE INDEX IF NOT EXISTS idx_sab_fecha    ON sabados_laborados(fecha_sabado DESC);
CREATE INDEX IF NOT EXISTS idx_sab_personal ON sabados_laborados USING GIN (personal);
CREATE INDEX IF NOT EXISTS idx_noti_para    ON notificaciones(para_num, leida);

-- Un solo registro vigente por empleado y día, garantizado por la base.
CREATE UNIQUE INDEX IF NOT EXISTS uq_he_emp_dia
  ON horas_extras(num_emp, fecha)
  WHERE estado_final <> 'rechazado';

-- ══════════════════════════════════════════════════════════════════
-- 4. VERIFICACIÓN — debe devolver 5 renglones, todos en TRUE
-- ══════════════════════════════════════════════════════════════════
SELECT 'horas_extras.causa_grupo' AS columna,
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='horas_extras' AND column_name='causa_grupo') AS existe
UNION ALL SELECT 'horas_extras.jefe_num',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='horas_extras' AND column_name='jefe_num')
UNION ALL SELECT 'horas_extras.gerente_num',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='horas_extras' AND column_name='gerente_num')
UNION ALL SELECT 'sabados_laborados.causa_grupo',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='sabados_laborados' AND column_name='causa_grupo')
UNION ALL SELECT 'sabados_laborados.gerente_num',
       EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='sabados_laborados' AND column_name='gerente_num');

import { getDb, preflight, fail, semanaMX } from '../lib/db.js';
import { puedeVerMonitor } from '../lib/auth.js';

/* ══════════════════════════════════════════════════════════════════
   MONITOR — acumulado semanal por empleado

   Correcciones respecto a la versión anterior:
   1. La semana se calcula con la fecha de México, no con UTC (antes,
      después de las 18:00 del domingo el monitor ya mostraba la
      semana siguiente y aparecía en ceros).
   2. El admin sólo veía usuarios con rol 'operario': las horas de
      jefes y gerentes eran invisibles. Ahora ve a todo el personal
      activo excepto la cuenta de sistema.
   3. Se resolvía con 2 consultas + un cruce en JavaScript. Ahora es
      un solo LEFT JOIN con agregación en Postgres: menos datos por
      la red y mucho más rápido con cientos de empleados.
   ══════════════════════════════════════════════════════════════════ */

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Método no permitido');

  const numEmp = req.query.num_emp ? String(req.query.num_emp).trim() : '';
  const rol = String(req.query.rol || '');

  if (!puedeVerMonitor(rol)) return fail(res, 403, 'Tu rol no tiene acceso al monitor');
  if (!numEmp) return fail(res, 400, 'Falta el número de empleado');

  const sql = getDb();
  const { ini, fin } = semanaMX();

  try {
    let rows;

    if (rol === 'admin') {
      rows = await sql`
        SELECT u.num_emp, u.nombre, u.puesto, u.ubicacion, u.depto, u.rol,
               u.jefe_num, u.gerente_num,
               COALESCE(h.total,0)::float8      AS horas_semana,
               COALESCE(h.regs,0)::int          AS total_regs,
               COALESCE(h.pendientes,0)::int    AS pendientes,
               COALESCE(h.autorizadas,0)::float8 AS horas_autorizadas
        FROM usuarios u
        LEFT JOIN (
          SELECT num_emp,
                 SUM(CASE WHEN estado_final <> 'rechazado' THEN horas_dia ELSE 0 END) AS total,
                 COUNT(*) AS regs,
                 SUM(CASE WHEN estado_final = 'pendiente'  THEN 1 ELSE 0 END) AS pendientes,
                 SUM(CASE WHEN estado_final = 'autorizado' THEN horas_dia ELSE 0 END) AS autorizadas
          FROM horas_extras WHERE fecha BETWEEN ${ini} AND ${fin}
          GROUP BY num_emp
        ) h ON h.num_emp = u.num_emp
        WHERE u.activo = TRUE AND u.rol <> 'admin'
        ORDER BY u.ubicacion NULLS LAST, u.nombre`;

    } else if (rol === 'gerente') {
      rows = await sql`
        SELECT u.num_emp, u.nombre, u.puesto, u.ubicacion, u.depto, u.rol,
               u.jefe_num, u.gerente_num,
               COALESCE(h.total,0)::float8      AS horas_semana,
               COALESCE(h.regs,0)::int          AS total_regs,
               COALESCE(h.pendientes,0)::int    AS pendientes,
               COALESCE(h.autorizadas,0)::float8 AS horas_autorizadas
        FROM usuarios u
        LEFT JOIN (
          SELECT num_emp,
                 SUM(CASE WHEN estado_final <> 'rechazado' THEN horas_dia ELSE 0 END) AS total,
                 COUNT(*) AS regs,
                 SUM(CASE WHEN estado_final = 'pendiente'  THEN 1 ELSE 0 END) AS pendientes,
                 SUM(CASE WHEN estado_final = 'autorizado' THEN horas_dia ELSE 0 END) AS autorizadas
          FROM horas_extras WHERE fecha BETWEEN ${ini} AND ${fin}
          GROUP BY num_emp
        ) h ON h.num_emp = u.num_emp
        WHERE u.activo = TRUE
          AND (u.gerente_num = ${numEmp}
               OR u.jefe_num IN (SELECT num_emp FROM usuarios WHERE gerente_num = ${numEmp}))
        ORDER BY u.ubicacion NULLS LAST, u.nombre`;

    } else { /* jefe */
      rows = await sql`
        SELECT u.num_emp, u.nombre, u.puesto, u.ubicacion, u.depto, u.rol,
               u.jefe_num, u.gerente_num,
               COALESCE(h.total,0)::float8      AS horas_semana,
               COALESCE(h.regs,0)::int          AS total_regs,
               COALESCE(h.pendientes,0)::int    AS pendientes,
               COALESCE(h.autorizadas,0)::float8 AS horas_autorizadas
        FROM usuarios u
        LEFT JOIN (
          SELECT num_emp,
                 SUM(CASE WHEN estado_final <> 'rechazado' THEN horas_dia ELSE 0 END) AS total,
                 COUNT(*) AS regs,
                 SUM(CASE WHEN estado_final = 'pendiente'  THEN 1 ELSE 0 END) AS pendientes,
                 SUM(CASE WHEN estado_final = 'autorizado' THEN horas_dia ELSE 0 END) AS autorizadas
          FROM horas_extras WHERE fecha BETWEEN ${ini} AND ${fin}
          GROUP BY num_emp
        ) h ON h.num_emp = u.num_emp
        WHERE u.activo = TRUE AND u.jefe_num = ${numEmp}
        ORDER BY u.nombre`;
    }

    return res.status(200).json({
      ok: true,
      data: rows,
      semana: { ini, fin }
    });
  } catch (err) {
    return fail(res, 500, 'Error al cargar el monitor', err);
  }
}

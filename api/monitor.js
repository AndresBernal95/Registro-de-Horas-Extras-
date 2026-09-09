import { getDb, preflight, fail, semanaMX, MAX_SEMANA } from '../lib/db.js';
import { puedeVerMonitor } from '../lib/auth.js';

/* ══════════════════════════════════════════════════════════════════
   MONITOR — acumulado semanal por empleado

   v3: el acumulado ya no son sólo las horas entre semana. Suma
   también las horas de los sábados laborados que gerencia autorizó,
   porque para el límite de 9 h del artículo 66 cuentan igual. Sin
   esto, alguien podía trabajar el sábado y otras 9 h entre semana
   sin que el sistema disparara la autorización especial.

   Además informa, por persona, cuántas solicitudes tiene esperando
   SU firma y cuántas esperan a gerencia: es lo que el jefe necesita
   ver para saber a quién recordarle que responda.
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
    const rows = await sql`
      SELECT u.num_emp, u.nombre, u.puesto, u.ubicacion, u.depto, u.rol,
             u.jefe_num, u.gerente_num,
             (COALESCE(h.vivas,0) + COALESCE(sb.horas,0))::float8 AS horas_semana,
             COALESCE(h.vivas,0)::float8        AS horas_entre_semana,
             COALESCE(sb.horas,0)::float8       AS horas_sabado,
             COALESCE(h.regs,0)::int            AS total_regs,
             COALESCE(h.pendientes,0)::int      AS pendientes,
             COALESCE(h.por_firmar,0)::int      AS por_firmar,
             COALESCE(h.en_gerencia,0)::int     AS en_gerencia,
             COALESCE(h.autorizadas,0)::float8  AS horas_autorizadas,
             COALESCE(sp.por_firmar_sab,0)::int AS por_firmar_sabado
      FROM usuarios u

      LEFT JOIN (
        SELECT num_emp,
               SUM(CASE WHEN estado_final IN ('pendiente','autorizado') THEN horas_dia ELSE 0 END) AS vivas,
               COUNT(*)                                                                    AS regs,
               SUM(CASE WHEN estado_final = 'pendiente'  THEN 1 ELSE 0 END)                AS pendientes,
               SUM(CASE WHEN acept_emp    = 'pendiente'  THEN 1 ELSE 0 END)                AS por_firmar,
               SUM(CASE WHEN auth_gerente = 'pendiente'  THEN 1 ELSE 0 END)                AS en_gerencia,
               SUM(CASE WHEN estado_final = 'autorizado' THEN horas_dia ELSE 0 END)        AS autorizadas
        FROM horas_extras WHERE fecha BETWEEN ${ini} AND ${fin}
        GROUP BY num_emp
      ) h ON h.num_emp = u.num_emp

      LEFT JOIN (
        SELECT sp.num_emp, SUM(sp.horas) AS horas
        FROM sabados_personal sp
        JOIN sabados_laborados s ON s.id = sp.sabado_id
        WHERE s.fecha_sabado BETWEEN ${ini} AND ${fin}
          AND s.auth_gerente = 'autorizado'
          AND sp.acept <> 'rechazado'
        GROUP BY sp.num_emp
      ) sb ON sb.num_emp = u.num_emp

      LEFT JOIN (
        SELECT sp.num_emp, COUNT(*) AS por_firmar_sab
        FROM sabados_personal sp
        JOIN sabados_laborados s ON s.id = sp.sabado_id
        WHERE sp.acept = 'pendiente' AND s.fecha_sabado >= ${ini}
        GROUP BY sp.num_emp
      ) sp ON sp.num_emp = u.num_emp

      WHERE u.activo = TRUE AND (
            (${rol} = 'admin'   AND u.rol <> 'admin')
         OR (${rol} = 'gerente' AND (u.gerente_num = ${numEmp}
              OR u.jefe_num IN (SELECT num_emp FROM usuarios WHERE gerente_num = ${numEmp})))
         OR (${rol} = 'jefe'    AND (u.jefe_num = ${numEmp} OR u.num_emp = ${numEmp}))
      )
      ORDER BY u.ubicacion NULLS LAST, u.nombre`;

    return res.status(200).json({
      ok: true,
      data: rows,
      semana: { ini, fin },
      max_semana: MAX_SEMANA
    });
  } catch (err) {
    return fail(res, 500, 'Error al cargar el monitor', err);
  }
}

import { getDb, preflight, fail, fechaMX } from '../lib/db.js';

/* ══════════════════════════════════════════════════════════════════
   VENCIMIENTO DE SOLICITUDES SIN RESPUESTA (v3)

   Una solicitud que nadie respondió no puede quedarse abierta para
   siempre: al cerrar el día programado deja de ser válida. Si no
   venciera, dos cosas malas pasan: el acumulado semanal seguiría
   reservando horas que nunca se trabajaron, y alguien podría "aceptar"
   en diciembre una hora extra de agosto.

   Vence:
     · horas extra con la firma del trabajador pendiente y fecha ya pasada
     · horas extra esperando autorización de gerencia y fecha ya pasada
     · sábados con la firma del trabajador pendiente y fecha ya pasada

   Lo vencido NO cuenta como autorizado y NO suma al acumulado semanal.

   Se ejecuta solo, todos los días, con el cron de Vercel configurado en
   vercel.json (00:00 hora de México). También se puede llamar a mano:
     GET /api/vencer?num_emp=0000      ← siendo administrador activo
   ══════════════════════════════════════════════════════════════════ */

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST')
    return fail(res, 405, 'Método no permitido');

  const sql = getDb();
  const hoy = fechaMX();

  /* ── Quién puede disparar esto ─────────────────────────────────
     1. El cron de Vercel (manda su propia cabecera).
     2. Un llamado con el secreto CRON_SECRET, si se configuró.
     3. Un administrador activo, para poder ejecutarlo a mano. */
  const esCron = !!req.headers['x-vercel-cron'];
  const secreto = process.env.CRON_SECRET;
  const auth = String(req.headers['authorization'] || '');
  const conSecreto = !!secreto && auth === `Bearer ${secreto}`;

  let esAdmin = false;
  const quien = req.query?.num_emp ? String(req.query.num_emp).trim() : '';
  if (!esCron && !conSecreto && quien) {
    try {
      const r = await sql`SELECT rol FROM usuarios WHERE num_emp = ${quien} AND activo = TRUE LIMIT 1`;
      esAdmin = r[0]?.rol === 'admin';
    } catch (e) { console.warn('[GPA] vencer: no se pudo validar al solicitante', e.message); }
  }

  if (!esCron && !conSecreto && !esAdmin)
    return fail(res, 403, 'Este proceso lo ejecuta el sistema automáticamente cada noche.');

  try {
    /* Firma del trabajador nunca respondida */
    const heTrabajador = await sql`
      UPDATE horas_extras SET
        acept_emp     = 'vencido',
        estado_final  = 'vencido',
        rechazado_por = 'sistema'
      WHERE acept_emp = 'pendiente' AND fecha < ${hoy}::date
      RETURNING id`;

    /* Gerencia nunca respondió: la solicitud murió sin llegar al trabajador */
    const heGerencia = await sql`
      UPDATE horas_extras SET
        auth_gerente  = 'rechazado',
        estado_final  = 'vencido',
        rechazado_por = 'sistema'
      WHERE auth_gerente = 'pendiente' AND fecha < ${hoy}::date
      RETURNING id`;

    /* Nivel jefe heredado de la v2.2 que quedó sin respuesta */
    const heJefe = await sql`
      UPDATE horas_extras SET
        auth_jefe     = 'rechazado',
        estado_final  = 'vencido',
        rechazado_por = 'sistema'
      WHERE auth_jefe = 'pendiente' AND origen = 'auto' AND fecha < ${hoy}::date
      RETURNING id`;

    /* Sábados: firma del trabajador sin responder */
    const sab = await sql`
      UPDATE sabados_personal sp SET acept = 'vencido'
      FROM sabados_laborados s
      WHERE s.id = sp.sabado_id
        AND sp.acept = 'pendiente'
        AND s.fecha_sabado < ${hoy}::date
      RETURNING sp.id`;

    const resumen = {
      fecha_proceso: hoy,
      horas_extras_sin_firma_del_trabajador: heTrabajador.length,
      horas_extras_sin_respuesta_de_gerencia: heGerencia.length,
      horas_extras_sin_respuesta_del_jefe: heJefe.length,
      sabados_sin_firma_del_trabajador: sab.length
    };
    console.warn('[GPA] Vencimiento diario:', resumen);

    return res.status(200).json({ ok: true, data: resumen });
  } catch (err) {
    return fail(res, 500, 'Error al vencer las solicitudes sin respuesta', err);
  }
}

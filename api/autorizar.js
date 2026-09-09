import { getDb, preflight, fail, done, readBody, DECISIONES, aISO } from '../lib/db.js';

/* ══════════════════════════════════════════════════════════════════
   AUTORIZACIÓN DE GERENCIA

   v3 — el flujo tiene ahora TRES niveles:

     1. jefe      · la solicitud del jefe vale como su autorización.
                    Se estampa al levantarla, no hay bandeja.
     2. gerencia  · sólo cuando el acumulado semanal rebasa las 9 h
                    (la hora 10ª en adelante, art. 66 LFT) o cuando el
                    solicitante se incluyó a sí mismo.
     3. trabajador· acepta o rechaza. Esa firma va en /api/aceptar.

   Este endpoint atiende el nivel 2. El nivel 'jefe' se conserva
   únicamente para los registros heredados de la v2.2, que el propio
   empleado capturó (origen = 'auto') y que siguen esperando firma.

   El estado final se deriva de LOS TRES niveles dentro del mismo
   UPDATE, así que es atómico: dos autorizadores simultáneos no pueden
   dejar el registro en un estado inconsistente.

   Cuando el gerente autoriza, la solicitud NO queda autorizada: pasa
   a la bandeja del trabajador (acept_emp: 'na' → 'pendiente'). Sin su
   consentimiento no hay hora extra.
   ══════════════════════════════════════════════════════════════════ */

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'PUT') return fail(res, 405, 'Método no permitido');

  const { id, decision, nivel, auth_num } = readBody(req);

  if (!id) return fail(res, 400, 'Falta el id del registro');
  if (!DECISIONES.includes(decision)) return fail(res, 400, 'La decisión debe ser "autorizado" o "rechazado"');
  if (nivel !== 'jefe' && nivel !== 'gerente') return fail(res, 400, 'El nivel debe ser "jefe" o "gerente"');
  if (!auth_num) return fail(res, 400, 'Falta el número de quien autoriza');

  const sql = getDb();
  const quien = String(auth_num).trim();

  try {
    /* ══════════════════════════════════════════════════════════════
       SEGREGACIÓN DE FUNCIONES — se valida aquí, que es lo único que
       un usuario no puede saltarse ocultando botones:

         1. Nadie autoriza sus propias horas extra. Ni el administrador.
         2. Nadie autoriza el lote que él mismo levantó.
         3. El nivel gerencia sólo lo firma el gerente autorizador.
       ══════════════════════════════════════════════════════════════ */
    const regRows = await sql`
      SELECT num_emp, nombre, jefe_num, gerente_num, solicitante_num,
             auth_jefe, auth_gerente, acept_emp, origen
      FROM horas_extras WHERE id = ${String(id)} LIMIT 1`;
    if (regRows.length === 0) return fail(res, 404, 'El registro no existe');
    const reg = regRows[0];

    if (String(reg.num_emp) === quien)
      return fail(res, 403, 'No puedes autorizar tus propias horas extra. Tu solicitud la autoriza tu gerente.');

    if (reg.solicitante_num && String(reg.solicitante_num) === quien)
      return fail(res, 403, 'No puedes autorizar una solicitud que tú mismo levantaste. La autoriza tu gerente.');

    const autRows = await sql`
      SELECT rol FROM usuarios WHERE num_emp = ${quien} AND activo = TRUE LIMIT 1`;
    if (autRows.length === 0) return fail(res, 403, 'Tu usuario no está activo en el catálogo');
    const esAdmin = autRows[0].rol === 'admin';

    /* Cadena vigente, por si le cambiaron de jefe al empleado después
       de capturar la solicitud. */
    const empRows = await sql`
      SELECT jefe_num, gerente_num FROM usuarios WHERE num_emp = ${reg.num_emp} LIMIT 1`;
    const emp = empRows[0] || {};

    let gerenteDelSolicitante = null;
    if (reg.solicitante_num) {
      const s = await sql`SELECT gerente_num FROM usuarios WHERE num_emp = ${reg.solicitante_num} LIMIT 1`;
      gerenteDelSolicitante = s[0]?.gerente_num || null;
    }

    const coincide = (...valores) => valores.some(v => v != null && String(v) === quien);

    if (nivel === 'jefe' && !esAdmin && !coincide(reg.jefe_num, emp.jefe_num))
      return fail(res, 403, `Sólo el jefe directo de ${reg.nombre || reg.num_emp} puede autorizar este registro.`);

    if (nivel === 'gerente' && !esAdmin && !coincide(reg.gerente_num, emp.gerente_num, gerenteDelSolicitante))
      return fail(res, 403, `Sólo el gerente autorizador de ${reg.nombre || reg.num_emp} puede autorizar este registro.`);

    let rows;

    if (nivel === 'gerente') {
      rows = await sql`
        UPDATE horas_extras SET
          auth_gerente     = ${decision},
          auth_gerente_num = ${quien},
          auth_gerente_ts  = NOW(),
          rechazado_por    = CASE WHEN ${decision} = 'rechazado' THEN 'gerente' ELSE rechazado_por END,
          /* Autorizado por gerencia → pasa a la bandeja del trabajador */
          acept_emp = CASE
            WHEN ${decision} = 'autorizado' AND acept_emp = 'na' AND origen = 'jefe' THEN 'pendiente'
            ELSE acept_emp
          END,
          estado_final = CASE
            WHEN ${decision} = 'rechazado'  THEN 'rechazado'
            WHEN auth_jefe   = 'rechazado'  THEN 'rechazado'
            WHEN acept_emp   = 'rechazado'  THEN 'rechazado'
            WHEN acept_emp   = 'vencido'    THEN 'vencido'
            WHEN ${decision} = 'autorizado' AND acept_emp = 'na' AND origen = 'jefe' THEN 'pendiente'
            WHEN auth_jefe IN ('na','autorizado') AND acept_emp IN ('na','aceptado') THEN 'autorizado'
            ELSE 'pendiente'
          END
        WHERE id = ${String(id)} AND auth_gerente = 'pendiente'
        RETURNING *`;
    } else {
      rows = await sql`
        UPDATE horas_extras SET
          auth_jefe     = ${decision},
          auth_jefe_num = ${quien},
          auth_jefe_ts  = NOW(),
          rechazado_por = CASE WHEN ${decision} = 'rechazado' THEN 'jefe' ELSE rechazado_por END,
          estado_final  = CASE
            WHEN ${decision}  = 'rechazado' THEN 'rechazado'
            WHEN auth_gerente = 'rechazado' THEN 'rechazado'
            WHEN acept_emp    = 'rechazado' THEN 'rechazado'
            WHEN acept_emp    = 'vencido'   THEN 'vencido'
            WHEN auth_gerente IN ('na','autorizado') AND acept_emp IN ('na','aceptado') THEN 'autorizado'
            ELSE 'pendiente'
          END
        WHERE id = ${String(id)} AND auth_jefe = 'pendiente'
        RETURNING *`;
    }

    if (rows.length === 0) {
      const estado = nivel === 'jefe' ? reg.auth_jefe : reg.auth_gerente;
      if (estado === 'na') {
        return fail(res, 409, nivel === 'jefe'
          ? 'Este registro no lo autoriza un jefe: lo levantó su jefe directo, así que el nivel 1 ya está firmado.'
          : 'Este registro no requiere autorización de gerencia.');
      }
      return fail(res, 409, `Este registro ya fue ${estado} en el nivel de ${nivel}`);
    }

    const r = rows[0];

    /* Aviso: al trabajador si ya le toca firmar, o al solicitante si
       gerencia rechazó. Nunca bloquea la operación. */
    try {
      if (decision === 'autorizado' && r.acept_emp === 'pendiente') {
        await sql`
          INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
          VALUES (${r.num_emp}, ${quien}, 'consentimiento', ${r.id},
            'Tienes una solicitud de horas extra por responder',
            ${`Gerencia autorizó las ${r.horas_dia} h del ${aISO(r.fecha)}. Falta tu aceptación.`})`;
      } else {
        await sql`
          INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
          VALUES (${r.solicitante_num || r.num_emp}, ${quien}, 'resultado', ${r.id},
            ${'Horas extra ' + decision + ' — ' + (r.nombre || r.num_emp)},
            ${`El registro de ${r.horas_dia} h del ${aISO(r.fecha)} fue ${decision} en el nivel de ${nivel}.`})`;
      }
    } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

    return done(res, r);
  } catch (err) {
    return fail(res, 500, 'Error al procesar la autorización', err);
  }
}

import { getDb, preflight, fail, done, readBody, DECISIONES } from '../lib/db.js';

/* ══════════════════════════════════════════════════════════════════
   AUTORIZACIÓN

   BUG CORREGIDO: el código anterior escribía estado_final = decision
   en cuanto CUALQUIER nivel decidía. Con eso, si un registro requería
   autorización de gerencia y el jefe lo tocaba, el estado final ya
   quedaba resuelto sin que el gerente participara.

   Ahora el estado final se deriva de los dos niveles:
   · rechazado por cualquiera        → rechazado
   · todos los niveles que aplican   → autorizado
   · falta alguno                    → pendiente
   Todo se resuelve dentro de la misma sentencia UPDATE, así que es
   atómico: dos autorizadores simultáneos no pueden dejar el registro
   en un estado inconsistente.
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
    let rows;

    if (nivel === 'jefe') {
      rows = await sql`
        UPDATE horas_extras SET
          auth_jefe     = ${decision},
          auth_jefe_num = ${quien},
          auth_jefe_ts  = NOW(),
          estado_final  = CASE
            WHEN ${decision} = 'rechazado'      THEN 'rechazado'
            WHEN auth_gerente = 'rechazado'     THEN 'rechazado'
            WHEN auth_gerente IN ('na','autorizado') THEN 'autorizado'
            ELSE 'pendiente'
          END
        WHERE id = ${String(id)} AND auth_jefe = 'pendiente'
        RETURNING *`;
    } else {
      rows = await sql`
        UPDATE horas_extras SET
          auth_gerente     = ${decision},
          auth_gerente_num = ${quien},
          auth_gerente_ts  = NOW(),
          estado_final     = CASE
            WHEN ${decision} = 'rechazado'   THEN 'rechazado'
            WHEN auth_jefe = 'rechazado'     THEN 'rechazado'
            WHEN auth_jefe IN ('na','autorizado') THEN 'autorizado'
            ELSE 'pendiente'
          END
        WHERE id = ${String(id)} AND auth_gerente = 'pendiente'
        RETURNING *`;
    }

    if (rows.length === 0) {
      /* Distingue "no existe" de "ya estaba resuelto" para dar un
         mensaje útil en lugar de un 404 genérico. */
      const ex = await sql`SELECT auth_jefe, auth_gerente FROM horas_extras WHERE id = ${String(id)} LIMIT 1`;
      if (ex.length === 0) return fail(res, 404, 'El registro no existe');
      const estado = nivel === 'jefe' ? ex[0].auth_jefe : ex[0].auth_gerente;
      if (estado === 'na') return fail(res, 409, `Este registro no requiere autorización de ${nivel}`);
      return fail(res, 409, `Este registro ya fue ${estado} por ${nivel}`);
    }

    const reg = rows[0];

    /* Aviso al empleado (no crítico) */
    try {
      await sql`
        INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
        VALUES (${reg.num_emp}, ${quien}, 'resultado', ${reg.id},
          ${'Tus horas extra fueron ' + decision},
          ${`Tu registro de ${reg.horas_dia}h del ${reg.fecha} fue ${decision} por ${nivel}.`})`;
    } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

    return done(res, reg);
  } catch (err) {
    return fail(res, 500, 'Error al procesar la autorización', err);
  }
}

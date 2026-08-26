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
    /* ══════════════════════════════════════════════════════════════
       SEGREGACIÓN DE FUNCIONES

       Antes este endpoint autorizaba cualquier folio para cualquiera
       que lo llamara: ocultar el botón en la pantalla no impedía nada.
       Ahora se valida aquí, que es lo único que un usuario no puede
       saltarse:

         1. Nadie autoriza sus propias horas extra. Ni un jefe, ni un
            gerente, ni el administrador.
         2. El nivel "jefe" sólo lo puede firmar el jefe directo de esa
            persona (o el administrador).
         3. El nivel "gerente" sólo lo puede firmar su gerente
            autorizador (o el administrador).
       ══════════════════════════════════════════════════════════════ */
    const regRows = await sql`
      SELECT num_emp, nombre, jefe_num, gerente_num, auth_jefe, auth_gerente
      FROM horas_extras WHERE id = ${String(id)} LIMIT 1`;
    if (regRows.length === 0) return fail(res, 404, 'El registro no existe');
    const reg = regRows[0];

    if (String(reg.num_emp) === quien) {
      return fail(res, 403, 'No puedes autorizar tus propias horas extra. Tu solicitud la autoriza tu jefe o tu gerente.');
    }

    const autRows = await sql`
      SELECT rol FROM usuarios WHERE num_emp = ${quien} AND activo = TRUE LIMIT 1`;
    if (autRows.length === 0) return fail(res, 403, 'Tu usuario no está activo en el catálogo');
    const esAdmin = autRows[0].rol === 'admin';

    /* Cadena vigente del empleado, por si le cambiaron de jefe
       después de capturar la solicitud. */
    const empRows = await sql`
      SELECT jefe_num, gerente_num FROM usuarios WHERE num_emp = ${reg.num_emp} LIMIT 1`;
    const emp = empRows[0] || {};

    const coincide = (...valores) => valores.some(v => v != null && String(v) === quien);

    if (nivel === 'jefe' && !esAdmin && !coincide(reg.jefe_num, emp.jefe_num)) {
      return fail(res, 403, `Sólo el jefe directo de ${reg.nombre || reg.num_emp} puede autorizar este registro.`);
    }
    if (nivel === 'gerente' && !esAdmin && !coincide(reg.gerente_num, emp.gerente_num)) {
      return fail(res, 403, `Sólo el gerente autorizador de ${reg.nombre || reg.num_emp} puede autorizar este registro.`);
    }

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
      /* El registro existe (ya se validó arriba), así que sólo puede
         ser que ese nivel no aplique o ya esté resuelto. */
      const estado = nivel === 'jefe' ? reg.auth_jefe : reg.auth_gerente;
      if (estado === 'na') {
        return fail(res, 409, nivel === 'jefe'
          ? 'Este registro no lo autoriza un jefe: por su rol o por rebasar las 9 h semanales, corresponde a la gerencia.'
          : 'Este registro no requiere autorización de gerencia.');
      }
      return fail(res, 409, `Este registro ya fue ${estado} en el nivel de ${nivel}`);
    }

    const actualizado = rows[0];

    /* Aviso al empleado (no crítico) */
    try {
      await sql`
        INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
        VALUES (${actualizado.num_emp}, ${quien}, 'resultado', ${actualizado.id},
          ${'Tus horas extra fueron ' + decision},
          ${`Tu registro de ${actualizado.horas_dia}h del ${actualizado.fecha} fue ${decision} por ${nivel}.`})`;
    } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

    return done(res, actualizado);
  } catch (err) {
    return fail(res, 500, 'Error al procesar la autorización', err);
  }
}

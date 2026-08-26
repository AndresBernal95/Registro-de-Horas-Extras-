import { getDb, preflight, fail, done, readBody, DECISIONES, esFechaISO } from '../lib/db.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  const sql = getDb();

  /* ══ GET ══ */
  if (req.method === 'GET') {
    const numEmp = req.query.num_emp ? String(req.query.num_emp).trim() : '';
    const rol = String(req.query.rol || '');
    if (!numEmp) return fail(res, 400, 'Falta el número de empleado');

    try {
      let rows;
      if (rol === 'admin') {
        rows = await sql`SELECT * FROM sabados_laborados ORDER BY fecha_sabado DESC, ts DESC LIMIT 500`;
      } else if (rol === 'gerente') {
        rows = await sql`
          SELECT s.* FROM sabados_laborados s
          LEFT JOIN usuarios u ON u.num_emp = s.jefe_num
          WHERE u.gerente_num = ${numEmp}
             OR s.gerente_num = ${numEmp}
             OR s.jefe_num    = ${numEmp}
          ORDER BY s.fecha_sabado DESC, s.ts DESC LIMIT 300`;
      } else if (rol === 'jefe') {
        rows = await sql`
          SELECT * FROM sabados_laborados
          WHERE jefe_num = ${numEmp}
          ORDER BY fecha_sabado DESC, ts DESC LIMIT 200`;
      } else {
        /* Un operario ve los sábados en los que fue convocado. */
        rows = await sql`
          SELECT * FROM sabados_laborados
          WHERE personal @> ${JSON.stringify([{ num_emp: numEmp }])}::jsonb
          ORDER BY fecha_sabado DESC, ts DESC LIMIT 100`;
      }
      return done(res, rows);
    } catch (err) {
      return fail(res, 500, 'Error al obtener las solicitudes de sábado', err);
    }
  }

  /* ══ POST — crear solicitud ══ */
  if (req.method === 'POST') {
    const b = readBody(req);
    const fecha = b.fecha_sabado;
    const jefeNum = b.jefe_num ? String(b.jefe_num).trim() : '';
    const personal = Array.isArray(b.personal) ? b.personal : [];

    if (!esFechaISO(fecha)) return fail(res, 400, 'La fecha del sábado no es válida');
    if (!jefeNum) return fail(res, 400, 'Falta el número del solicitante');
    if (personal.length === 0) return fail(res, 400, 'Debes convocar al menos a un empleado');
    if (!b.causa_p3) return fail(res, 400, 'Falta completar el análisis de causa raíz');

    /* Validación de que realmente sea sábado (día 6 en UTC sobre la fecha pura). */
    const d = new Date(fecha + 'T12:00:00Z');
    if (d.getUTCDay() !== 6) return fail(res, 400, 'La fecha seleccionada no es un sábado');

    try {
      /* Evita solicitudes duplicadas del mismo jefe para el mismo sábado. */
      const dup = await sql`
        SELECT id FROM sabados_laborados
        WHERE jefe_num = ${jefeNum} AND fecha_sabado = ${fecha} AND auth_gerente <> 'rechazado'
        LIMIT 1`;
      if (dup.length > 0)
        return fail(res, 409, 'Ya existe una solicitud tuya para ese sábado. Edítala o espera la respuesta.');

      const nulo = v => (v === undefined || v === '' ? null : v);
      const limpio = personal.map(p => ({
        num_emp: String((p && p.num_emp) || p || '').trim(),
        nombre: String((p && p.nombre) || '').trim()
      })).filter(p => p.num_emp);

      const rows = await sql`
        INSERT INTO sabados_laborados (
          fecha_sabado, jefe_num, jefe_nombre, ubicacion, depto, personal,
          causa_cat, causa_grupo, causa_p1, causa_p2, causa_p3, causa_texto,
          auth_gerente, gerente_num
        ) VALUES (
          ${fecha}, ${jefeNum}, ${nulo(b.jefe_nombre)}, ${nulo(b.ubicacion)}, ${nulo(b.depto)},
          ${JSON.stringify(limpio)}::jsonb,
          ${nulo(b.causa_cat)}, ${nulo(b.causa_grupo)}, ${nulo(b.causa_p1)},
          ${nulo(b.causa_p2)}, ${nulo(b.causa_p3)}, ${nulo(b.causa_texto)},
          'pendiente', ${nulo(b.gerente_num)}
        ) RETURNING *`;

      try {
        if (b.gerente_num) {
          await sql`
            INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
            VALUES (${String(b.gerente_num)}, ${jefeNum}, 'sabado', ${rows[0].id},
              ${'Sábado laborado por autorizar — ' + fecha},
              ${`${b.jefe_nombre || jefeNum} solicita ${limpio.length} persona(s) para el sábado ${fecha}. Causa: ${b.causa_texto || ''}`})`;
        }
      } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

      return done(res, rows[0], 201);
    } catch (err) {
      if (String(err.message || '').includes('foreign key'))
        return fail(res, 400, 'El número del solicitante no existe en el catálogo de usuarios');
      return fail(res, 500, 'Error al guardar la solicitud', err);
    }
  }

  /* ══ PUT — autorizar / rechazar ══ */
  if (req.method === 'PUT') {
    const { id, decision, auth_num } = readBody(req);
    if (!id) return fail(res, 400, 'Falta el id de la solicitud');
    if (!DECISIONES.includes(decision)) return fail(res, 400, 'La decisión debe ser "autorizado" o "rechazado"');
    if (!auth_num) return fail(res, 400, 'Falta el número de quien autoriza');

    try {
      const rows = await sql`
        UPDATE sabados_laborados SET
          auth_gerente     = ${decision},
          auth_gerente_num = ${String(auth_num).trim()},
          auth_gerente_ts  = NOW()
        WHERE id = ${String(id)} AND auth_gerente = 'pendiente'
        RETURNING *`;

      if (rows.length === 0) {
        const ex = await sql`SELECT auth_gerente FROM sabados_laborados WHERE id = ${String(id)} LIMIT 1`;
        if (ex.length === 0) return fail(res, 404, 'La solicitud no existe');
        return fail(res, 409, `Esta solicitud ya fue ${ex[0].auth_gerente}`);
      }

      const sab = rows[0];
      try {
        await sql`
          INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
          VALUES (${sab.jefe_num}, ${String(auth_num)}, 'resultado', ${sab.id},
            ${'Sábado ' + sab.fecha_sabado + ' ' + decision},
            ${`Tu solicitud de sábado laborado del ${sab.fecha_sabado} fue ${decision}.`})`;
      } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

      return done(res, sab);
    } catch (err) {
      return fail(res, 500, 'Error al procesar la solicitud', err);
    }
  }

  /* ══ DELETE ══ */
  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id).trim() : '';
    if (!id) return fail(res, 400, 'Falta el id de la solicitud');
    try {
      const rows = await sql`DELETE FROM sabados_laborados WHERE id = ${id} RETURNING id`;
      if (rows.length === 0) return fail(res, 404, 'La solicitud no existe');
      return done(res, { id });
    } catch (err) {
      return fail(res, 500, 'Error al eliminar la solicitud', err);
    }
  }

  return fail(res, 405, 'Método no permitido');
}

import {
  getDb, preflight, fail, done, readBody, RESPUESTAS, aISO
} from '../lib/db.js';
import {
  leyendaConsentimiento, sellarFirma, LEYENDA_VERSION, ipDe, uaDe
} from '../lib/firma.js';

/* ══════════════════════════════════════════════════════════════════
   CONSENTIMIENTO DEL TRABAJADOR — firma electrónica (v3)

   PUT /api/aceptar
   { tipo: 'hora_extra' | 'sabado', id, num_emp, decision, nota }

   · tipo 'hora_extra' → id es el folio de horas_extras
   · tipo 'sabado'     → id es el folio de sabados_laborados
                         (el renglón se ubica por sabado_id + num_emp)

   REGLA QUE NO TIENE EXCEPCIÓN: sólo el propio trabajador firma lo
   suyo. Ni su jefe, ni su gerente, ni el administrador. Una firma que
   otro puede poner por ti no es una firma.

   Se guarda, además de la decisión: el texto íntegro de la leyenda
   que se mostró, su versión, el sello de fecha y hora, la IP, el
   navegador y un hash SHA-256 que permite demostrar después que el
   renglón no se alteró.

   El RECHAZO no pide justificación: obligar a justificarlo
   contradice el artículo 68 de la LFT, que dice que el trabajador no
   está obligado a laborar tiempo extraordinario. El campo de
   comentario es opcional.
   ══════════════════════════════════════════════════════════════════ */

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const diaDe = f => DIAS[new Date(String(f).slice(0, 10) + 'T12:00:00Z').getUTCDay()] || '';

export default async function handler(req, res) {
  if (preflight(req, res)) return;

  /* ══════════════════════════════════════════════════════════════
     GET — el texto exacto que se va a firmar

     El navegador NO arma la leyenda. La pide aquí y se muestra tal
     cual, porque es este mismo texto el que se guardará junto con la
     firma. Si se escribiera en el frontend, algún día cambiaría de un
     lado y no del otro, y el expediente diría algo distinto de lo que
     la persona vio en pantalla.
     ══════════════════════════════════════════════════════════════ */
  if (req.method === 'GET') return leerSolicitud(req, res);

  if (req.method !== 'PUT') return fail(res, 405, 'Método no permitido');

  const b = readBody(req);
  const tipo = String(b.tipo || 'hora_extra');
  const id = b.id ? String(b.id).trim() : '';
  const quien = b.num_emp ? String(b.num_emp).trim() : '';
  const decision = String(b.decision || '');
  const nota = b.nota ? String(b.nota).slice(0, 400) : null;

  if (!id) return fail(res, 400, 'Falta el folio de la solicitud');
  if (!quien) return fail(res, 400, 'Falta tu número de empleado');
  if (!RESPUESTAS.includes(decision))
    return fail(res, 400, 'La respuesta debe ser "aceptado" o "rechazado"');
  if (tipo !== 'hora_extra' && tipo !== 'sabado')
    return fail(res, 400, 'Tipo de solicitud no válido');

  const sql = getDb();
  const ahora = new Date();
  const ahoraISO = ahora.toISOString();
  const ip = ipDe(req);
  const ua = uaDe(req);

  try {
    /* El firmante debe estar activo en el catálogo. */
    const yoRows = await sql`
      SELECT num_emp, nombre, puesto, ubicacion FROM usuarios
      WHERE num_emp = ${quien} AND activo = TRUE LIMIT 1`;
    if (yoRows.length === 0) return fail(res, 403, 'Tu usuario no está activo en el catálogo');
    const yo = yoRows[0];

    /* ══════════════════════════════════════════════════════════════
       HORAS EXTRA ENTRE SEMANA
       ══════════════════════════════════════════════════════════════ */
    if (tipo === 'hora_extra') {
      const regRows = await sql`
        SELECT id, num_emp, nombre, fecha, horas_dia, causa_texto, causa_cat,
               solicitante_num, solicitante_nombre, acept_emp, auth_jefe,
               auth_gerente, estado_final
        FROM horas_extras WHERE id = ${id} LIMIT 1`;
      if (regRows.length === 0) return fail(res, 404, 'La solicitud no existe');
      const reg = regRows[0];

      if (String(reg.num_emp) !== quien)
        return fail(res, 403, 'Sólo el trabajador al que se le solicitaron las horas puede aceptarlas o rechazarlas.');

      if (reg.acept_emp === 'na')
        return fail(res, 409, 'Esta solicitud todavía está esperando la autorización de gerencia. Cuando la autoricen te aparecerá para firmar.');
      if (reg.acept_emp !== 'pendiente')
        return fail(res, 409, `Ya respondiste esta solicitud: la ${reg.acept_emp === 'aceptado' ? 'aceptaste' : reg.acept_emp}.`);

      const fechaISO = aISO(reg.fecha);
      const leyenda = leyendaConsentimiento({
        tipo: 'hora_extra',
        nombre: reg.nombre || yo.nombre,
        num_emp: reg.num_emp,
        horas: Number(reg.horas_dia),
        fecha: fechaISO,
        solicitante: reg.solicitante_nombre || 'Mi jefe inmediato',
        causa: reg.causa_texto || reg.causa_cat || ''
      });
      const hash = sellarFirma({
        id: reg.id, num_emp: reg.num_emp, horas: reg.horas_dia,
        fecha: fechaISO, decision, leyenda, ts: ahoraISO, ip
      });

      /* Un solo UPDATE: la decisión y el estado final se resuelven en
         la misma sentencia, así que dos pestañas abiertas no pueden
         dejar el registro en un estado a medias. */
      const rows = await sql`
        UPDATE horas_extras SET
          acept_emp         = ${decision},
          acept_emp_ts      = ${ahoraISO}::timestamptz,
          acept_emp_ip      = ${ip},
          acept_emp_ua      = ${ua},
          acept_emp_leyenda = ${leyenda},
          acept_emp_ley_ver = ${LEYENDA_VERSION},
          acept_emp_hash    = ${hash},
          acept_emp_nota    = ${nota},
          rechazado_por     = CASE WHEN ${decision} = 'rechazado' THEN 'trabajador' ELSE rechazado_por END,
          estado_final      = CASE
            WHEN ${decision} = 'rechazado'   THEN 'rechazado'
            WHEN auth_jefe    = 'rechazado'  THEN 'rechazado'
            WHEN auth_gerente = 'rechazado'  THEN 'rechazado'
            WHEN auth_jefe    IN ('na','autorizado')
             AND auth_gerente IN ('na','autorizado') THEN 'autorizado'
            ELSE 'pendiente'
          END
        WHERE id = ${id} AND num_emp = ${quien} AND acept_emp = 'pendiente'
        RETURNING *`;

      if (rows.length === 0)
        return fail(res, 409, 'La solicitud cambió mientras respondías. Actualiza la pantalla.');

      const r = rows[0];
      try {
        await sql`
          INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
          VALUES (
            ${r.solicitante_num || r.jefe_num || r.gerente_num},
            ${quien}, 'consentimiento', ${r.id},
            ${(decision === 'aceptado' ? 'Horas extra aceptadas por ' : 'Horas extra RECHAZADAS por ') + (r.nombre || quien)},
            ${`${r.nombre || quien} ${decision === 'aceptado' ? 'aceptó' : 'rechazó'} las ${r.horas_dia} h del ${fechaISO}.` +
              (nota ? ` Comentario: ${nota}` : '')})`;
      } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

      return done(res, r);
    }

    /* ══════════════════════════════════════════════════════════════
       SÁBADO LABORADO
       ══════════════════════════════════════════════════════════════ */
    const spRows = await sql`
      SELECT sp.id AS sp_id, sp.sabado_id, sp.num_emp, sp.nombre, sp.horas, sp.acept,
             s.fecha_sabado, s.jefe_nombre, s.jefe_num, s.causa_texto, s.causa_cat,
             s.auth_gerente
      FROM sabados_personal sp
      JOIN sabados_laborados s ON s.id = sp.sabado_id
      WHERE sp.sabado_id = ${id} AND sp.num_emp = ${quien} LIMIT 1`;
    if (spRows.length === 0)
      return fail(res, 404, 'No estás convocado en esa solicitud de sábado');
    const sp = spRows[0];

    if (sp.auth_gerente !== 'autorizado')
      return fail(res, 409, sp.auth_gerente === 'rechazado'
        ? 'Esa solicitud de sábado fue rechazada por gerencia.'
        : 'Esa solicitud de sábado todavía está esperando la autorización de gerencia.');
    if (sp.acept === 'na')
      return fail(res, 409, 'Este sábado es un registro histórico y no requiere tu firma.');
    if (sp.acept !== 'pendiente')
      return fail(res, 409, `Ya respondiste este sábado: lo ${sp.acept === 'aceptado' ? 'aceptaste' : sp.acept}.`);

    const fechaISO = aISO(sp.fecha_sabado);
    const leyenda = leyendaConsentimiento({
      tipo: 'sabado',
      nombre: sp.nombre || yo.nombre,
      num_emp: sp.num_emp,
      horas: Number(sp.horas),
      fecha: fechaISO,
      solicitante: sp.jefe_nombre || 'Mi jefe inmediato',
      causa: sp.causa_texto || sp.causa_cat || ''
    });
    const hash = sellarFirma({
      id: sp.sabado_id, num_emp: sp.num_emp, horas: sp.horas,
      fecha: fechaISO, decision, leyenda, ts: ahoraISO, ip
    });

    const rows = await sql`
      UPDATE sabados_personal SET
        acept         = ${decision},
        acept_ts      = ${ahoraISO}::timestamptz,
        acept_ip      = ${ip},
        acept_ua      = ${ua},
        acept_leyenda = ${leyenda},
        acept_ley_ver = ${LEYENDA_VERSION},
        acept_hash    = ${hash},
        acept_nota    = ${nota}
      WHERE sabado_id = ${id} AND num_emp = ${quien} AND acept = 'pendiente'
      RETURNING *`;

    if (rows.length === 0)
      return fail(res, 409, 'La solicitud cambió mientras respondías. Actualiza la pantalla.');

    try {
      await sql`
        INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
        VALUES (${sp.jefe_num}, ${quien}, 'consentimiento', ${sp.sabado_id},
          ${(decision === 'aceptado' ? 'Sábado aceptado por ' : 'Sábado RECHAZADO por ') + (sp.nombre || quien)},
          ${`${sp.nombre || quien} ${decision === 'aceptado' ? 'aceptó' : 'rechazó'} laborar el sábado ${fechaISO}.` +
            (nota ? ` Comentario: ${nota}` : '')})`;
    } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

    return done(res, rows[0]);

  } catch (err) {
    return fail(res, 500, 'Error al registrar tu respuesta', err);
  }
}

/* ══════════════════════════════════════════════════════════════════
   GET /api/aceptar?tipo=hora_extra|sabado&id=...&num_emp=...
   Devuelve los datos de la solicitud y la leyenda ya redactada.
   Sólo se la entrega al trabajador dueño de la solicitud.
   ══════════════════════════════════════════════════════════════════ */
async function leerSolicitud(req, res) {
  const tipo = String(req.query.tipo || 'hora_extra');
  const id = req.query.id ? String(req.query.id).trim() : '';
  const quien = req.query.num_emp ? String(req.query.num_emp).trim() : '';

  if (!id) return fail(res, 400, 'Falta el folio de la solicitud');
  if (!quien) return fail(res, 400, 'Falta tu número de empleado');
  if (tipo !== 'hora_extra' && tipo !== 'sabado')
    return fail(res, 400, 'Tipo de solicitud no válido');

  const sql = getDb();

  try {
    if (tipo === 'hora_extra') {
      const rows = await sql`
        SELECT id, num_emp, nombre, fecha, horas_dia, causa_texto, causa_cat,
               solicitante_nombre, acept_emp
        FROM horas_extras WHERE id = ${id} AND num_emp = ${quien} LIMIT 1`;
      if (rows.length === 0) return fail(res, 404, 'La solicitud no existe o no es tuya');
      const r = rows[0];
      if (r.acept_emp !== 'pendiente')
        return fail(res, 409, r.acept_emp === 'na'
          ? 'Esta solicitud todavía espera la autorización de gerencia.'
          : 'Esta solicitud ya fue respondida.');

      const fecha = aISO(r.fecha);
      return done(res, {
        tipo, id: r.id, fecha, dia: diaDe(fecha),
        horas: Number(r.horas_dia),
        solicitante: r.solicitante_nombre || 'Tu jefe inmediato',
        causa: r.causa_texto || r.causa_cat || '',
        leyenda_version: LEYENDA_VERSION,
        leyenda: leyendaConsentimiento({
          tipo: 'hora_extra', nombre: r.nombre, num_emp: r.num_emp,
          horas: Number(r.horas_dia), fecha,
          solicitante: r.solicitante_nombre || 'Mi jefe inmediato',
          causa: r.causa_texto || r.causa_cat || ''
        })
      });
    }

    const rows = await sql`
      SELECT s.id, s.fecha_sabado, s.jefe_nombre, s.causa_texto, s.causa_cat,
             s.auth_gerente, sp.num_emp, sp.nombre, sp.horas, sp.acept
      FROM sabados_personal sp
      JOIN sabados_laborados s ON s.id = sp.sabado_id
      WHERE sp.sabado_id = ${id} AND sp.num_emp = ${quien} LIMIT 1`;
    if (rows.length === 0) return fail(res, 404, 'No estás convocado en esa solicitud de sábado');
    const r = rows[0];
    if (r.auth_gerente !== 'autorizado')
      return fail(res, 409, 'Esa solicitud de sábado todavía no la autoriza gerencia.');
    if (r.acept !== 'pendiente')
      return fail(res, 409, 'Este sábado ya fue respondido.');

    const fecha = aISO(r.fecha_sabado);
    return done(res, {
      tipo, id: r.id, fecha, dia: diaDe(fecha),
      horas: Number(r.horas),
      solicitante: r.jefe_nombre || 'Tu jefe inmediato',
      causa: r.causa_texto || r.causa_cat || '',
      leyenda_version: LEYENDA_VERSION,
      leyenda: leyendaConsentimiento({
        tipo: 'sabado', nombre: r.nombre, num_emp: r.num_emp,
        horas: Number(r.horas), fecha,
        solicitante: r.jefe_nombre || 'Mi jefe inmediato',
        causa: r.causa_texto || r.causa_cat || ''
      })
    });
  } catch (err) {
    return fail(res, 500, 'Error al cargar la solicitud', err);
  }
}

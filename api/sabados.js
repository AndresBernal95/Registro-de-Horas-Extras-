import {
  getDb, preflight, fail, done, readBody, DECISIONES, esFechaISO, SAB_HORAS, aISO
} from '../lib/db.js';
import { puedeSolicitarHoras, puedeSolicitarA } from '../lib/auth.js';
import { leyendaConsentimiento, sellarFirma, LEYENDA_VERSION, ipDe, uaDe } from '../lib/firma.js';

/* ══════════════════════════════════════════════════════════════════
   SÁBADOS LABORADOS — v3

   El jefe convoca, el gerente autoriza y —esto es lo nuevo— cada
   persona convocada acepta o rechaza por su cuenta, con la misma
   leyenda y la misma firma electrónica que las horas extra entre
   semana. Un sábado laborado también es jornada extraordinaria.

   La lista de personal vive ahora en la tabla sabados_personal, un
   renglón por persona, porque cada quien firma por separado. La
   columna personal (JSONB) se sigue llenando por compatibilidad con
   lo que ya estaba capturado.
   ══════════════════════════════════════════════════════════════════ */

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  const sql = getDb();

  /* ══ GET ══════════════════════════════════════════════════════ */
  if (req.method === 'GET') {
    const numEmp = req.query.num_emp ? String(req.query.num_emp).trim() : '';
    const rol = String(req.query.rol || '');
    if (!numEmp) return fail(res, 400, 'Falta el número de empleado');

    try {
      let rows;
      if (rol === 'admin') {
        rows = await sql`
          SELECT s.*, COALESCE(p.detalle,'[]'::json) AS personal_detalle
          FROM sabados_laborados s
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object(
              'num_emp', sp.num_emp, 'nombre', sp.nombre, 'horas', sp.horas,
              'acept', sp.acept, 'acept_ts', sp.acept_ts, 'acept_nota', sp.acept_nota
            ) ORDER BY sp.nombre) AS detalle
            FROM sabados_personal sp WHERE sp.sabado_id = s.id
          ) p ON TRUE
          ORDER BY s.fecha_sabado DESC, s.ts DESC LIMIT 500`;
      } else if (rol === 'gerente') {
        rows = await sql`
          SELECT s.*, COALESCE(p.detalle,'[]'::json) AS personal_detalle
          FROM sabados_laborados s
          LEFT JOIN usuarios u ON u.num_emp = s.jefe_num
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object(
              'num_emp', sp.num_emp, 'nombre', sp.nombre, 'horas', sp.horas,
              'acept', sp.acept, 'acept_ts', sp.acept_ts, 'acept_nota', sp.acept_nota
            ) ORDER BY sp.nombre) AS detalle
            FROM sabados_personal sp WHERE sp.sabado_id = s.id
          ) p ON TRUE
          WHERE u.gerente_num = ${numEmp}
             OR s.gerente_num = ${numEmp}
             OR s.jefe_num    = ${numEmp}
             OR EXISTS (SELECT 1 FROM sabados_personal x WHERE x.sabado_id = s.id AND x.num_emp = ${numEmp})
          ORDER BY s.fecha_sabado DESC, s.ts DESC LIMIT 300`;
      } else if (rol === 'jefe') {
        rows = await sql`
          SELECT s.*, COALESCE(p.detalle,'[]'::json) AS personal_detalle
          FROM sabados_laborados s
          LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object(
              'num_emp', sp.num_emp, 'nombre', sp.nombre, 'horas', sp.horas,
              'acept', sp.acept, 'acept_ts', sp.acept_ts, 'acept_nota', sp.acept_nota
            ) ORDER BY sp.nombre) AS detalle
            FROM sabados_personal sp WHERE sp.sabado_id = s.id
          ) p ON TRUE
          WHERE s.jefe_num = ${numEmp}
             OR EXISTS (SELECT 1 FROM sabados_personal x WHERE x.sabado_id = s.id AND x.num_emp = ${numEmp})
          ORDER BY s.fecha_sabado DESC, s.ts DESC LIMIT 200`;
      } else {
        /* Operativo: los sábados en los que fue convocado, con SU
           renglón (horas, estado de su firma) resuelto por el servidor. */
        rows = await sql`
          SELECT s.id, s.fecha_sabado, s.jefe_num, s.jefe_nombre, s.ubicacion, s.depto,
                 s.causa_cat, s.causa_p1, s.causa_p2, s.causa_p3, s.causa_texto,
                 s.auth_gerente, s.auth_gerente_ts, s.horas_persona,
                 sp.horas AS mis_horas, sp.acept AS mi_acept, sp.acept_ts AS mi_acept_ts,
                 sp.acept_nota AS mi_acept_nota
          FROM sabados_personal sp
          JOIN sabados_laborados s ON s.id = sp.sabado_id
          WHERE sp.num_emp = ${numEmp}
          ORDER BY s.fecha_sabado DESC, s.ts DESC LIMIT 100`;
      }
      return done(res, rows);
    } catch (err) {
      return fail(res, 500, 'Error al obtener las solicitudes de sábado', err);
    }
  }

  /* ══ POST — el jefe convoca ═══════════════════════════════════ */
  if (req.method === 'POST') {
    const b = readBody(req);
    const fecha = b.fecha_sabado;
    const jefeNum = b.jefe_num ? String(b.jefe_num).trim() : '';
    const personal = Array.isArray(b.personal) ? b.personal : [];
    const horasPersona = Number(b.horas_persona || SAB_HORAS);

    if (!esFechaISO(fecha)) return fail(res, 400, 'La fecha del sábado no es válida');
    if (!jefeNum) return fail(res, 400, 'Falta el número del solicitante');
    if (personal.length === 0) return fail(res, 400, 'Debes convocar al menos a un empleado');
    if (!b.causa_p3) return fail(res, 400, 'Falta completar el análisis de causa raíz');
    if (!Number.isFinite(horasPersona) || horasPersona <= 0 || horasPersona > 8)
      return fail(res, 400, 'Las horas del sábado deben estar entre 0.5 y 8');

    /* Que sea sábado de verdad (día 6 en UTC sobre la fecha pura). */
    const d = new Date(fecha + 'T12:00:00Z');
    if (d.getUTCDay() !== 6) return fail(res, 400, 'La fecha seleccionada no es un sábado');

    try {
      const solRows = await sql`
        SELECT num_emp, nombre, rol, puesto, ubicacion, depto, jefe_num, gerente_num
        FROM usuarios WHERE num_emp = ${jefeNum} AND activo = TRUE LIMIT 1`;
      if (solRows.length === 0)
        return fail(res, 403, 'Tu usuario no está activo en el catálogo');
      const sol = solRows[0];
      if (!puedeSolicitarHoras(sol.rol))
        return fail(res, 403, 'Tu rol no puede convocar personal en sábado');

      const dup = await sql`
        SELECT id FROM sabados_laborados
        WHERE jefe_num = ${jefeNum} AND fecha_sabado = ${fecha} AND auth_gerente <> 'rechazado'
        LIMIT 1`;
      if (dup.length > 0)
        return fail(res, 409, 'Ya existe una solicitud tuya para ese sábado. Edítala o espera la respuesta.');

      /* Personal validado contra el catálogo, no contra el navegador. */
      const nums = [];
      for (const p of personal) {
        const n = String((p && p.num_emp) || p || '').trim();
        if (!n) continue;
        if (!nums.includes(n)) nums.push(n);
      }
      if (nums.length === 0) return fail(res, 400, 'Debes convocar al menos a un empleado');

      const empRows = await sql`
        SELECT num_emp, nombre, puesto, ubicacion, depto, rol, jefe_num, gerente_num
        FROM usuarios WHERE num_emp = ANY(${nums}::text[]) AND activo = TRUE`;
      const catalogo = new Map(empRows.map(u => [String(u.num_emp), u]));

      const problemas = [];
      for (const n of nums) {
        const u = catalogo.get(n);
        if (!u) { problemas.push(`${n}: no existe en el catálogo o está dado de baja`); continue; }
        if (u.rol === 'admin') problemas.push(`${u.nombre}: cuenta de sistema, no se convoca`);
        else if (!puedeSolicitarA(sol, u)) problemas.push(`${u.nombre}: no forma parte de tu personal a cargo`);
      }
      if (problemas.length)
        return fail(res, 403, 'No se envió nada. Corrige lo siguiente: ' + problemas.join(' · '));

      const nulo = v => (v === undefined || v === '' ? null : v);
      const limpio = nums.map(n => ({ num_emp: n, nombre: catalogo.get(n).nombre || '' }));
      const gerenteAutoriza = sol.rol === 'jefe' ? (sol.gerente_num || '0000') : '0000';

      const rows = await sql`
        INSERT INTO sabados_laborados (
          fecha_sabado, jefe_num, jefe_nombre, ubicacion, depto, personal,
          causa_cat, causa_grupo, causa_p1, causa_p2, causa_p3, causa_texto,
          auth_gerente, gerente_num, horas_persona
        ) VALUES (
          ${fecha}, ${jefeNum}, ${sol.nombre || null}, ${nulo(b.ubicacion) || sol.ubicacion},
          ${nulo(b.depto) || sol.depto}, ${JSON.stringify(limpio)}::jsonb,
          ${nulo(b.causa_cat)}, ${nulo(b.causa_grupo)}, ${nulo(b.causa_p1)},
          ${nulo(b.causa_p2)}, ${nulo(b.causa_p3)}, ${nulo(b.causa_texto)},
          'pendiente', ${gerenteAutoriza}, ${horasPersona}
        ) RETURNING *`;

      const sab = rows[0];
      const ahoraISO = new Date().toISOString();
      const ip = ipDe(req), ua = uaDe(req);
      const causaTexto = b.causa_texto || b.causa_cat || '';

      /* Un renglón por persona. Todos arrancan en 'na': el trabajador
         no debe firmar nada hasta que gerencia autorice el sábado.
         El propio solicitante se autofirma, igual que en horas extra. */
      const detalle = nums.map(n => {
        const u = catalogo.get(n);
        const esYo = String(n) === String(sol.num_emp);
        const fila = {
          num_emp: n, nombre: u.nombre || null, puesto: u.puesto || null,
          ubicacion: u.ubicacion || null, horas: horasPersona,
          acept: esYo ? 'aceptado' : 'na',
          acept_ts: null, acept_ip: null, acept_ua: null,
          acept_leyenda: null, acept_ley_ver: null, acept_hash: null, acept_nota: null
        };
        if (esYo) {
          const leyenda = leyendaConsentimiento({
            tipo: 'sabado', nombre: u.nombre, num_emp: n, horas: horasPersona,
            fecha, solicitante: 'Yo mismo, como responsable del área,', causa: causaTexto
          });
          fila.acept_ts = ahoraISO;
          fila.acept_ip = ip;
          fila.acept_ua = ua;
          fila.acept_leyenda = leyenda;
          fila.acept_ley_ver = LEYENDA_VERSION;
          fila.acept_nota = 'Autofirma: el solicitante se convocó a sí mismo.';
          fila.acept_hash = sellarFirma({
            id: sab.id, num_emp: n, horas: horasPersona, fecha,
            decision: 'aceptado', leyenda, ts: ahoraISO, ip
          });
        }
        return fila;
      });

      await sql`
        INSERT INTO sabados_personal (
          sabado_id, num_emp, nombre, puesto, ubicacion, horas, acept,
          acept_ts, acept_ip, acept_ua, acept_leyenda, acept_ley_ver,
          acept_hash, acept_nota
        )
        SELECT ${sab.id}, x.num_emp, x.nombre, x.puesto, x.ubicacion, x.horas, x.acept,
               x.acept_ts, x.acept_ip, x.acept_ua, x.acept_leyenda, x.acept_ley_ver,
               x.acept_hash, x.acept_nota
        FROM jsonb_to_recordset(${JSON.stringify(detalle)}::jsonb) AS x(
          num_emp text, nombre text, puesto text, ubicacion text, horas numeric,
          acept text, acept_ts timestamptz, acept_ip text, acept_ua text,
          acept_leyenda text, acept_ley_ver text, acept_hash text, acept_nota text
        )
        ON CONFLICT (sabado_id, num_emp) DO NOTHING`;

      try {
        if (gerenteAutoriza) {
          await sql`
            INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
            VALUES (${gerenteAutoriza}, ${jefeNum}, 'sabado', ${sab.id},
              ${'Sábado laborado por autorizar — ' + fecha},
              ${`${sol.nombre || jefeNum} convoca a ${nums.length} persona(s) de ${horasPersona} h para el sábado ${fecha}. Causa: ${causaTexto}`})`;
        }
      } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

      return done(res, { ...sab, personal_detalle: detalle }, 201);
    } catch (err) {
      if (String(err.message || '').includes('foreign key'))
        return fail(res, 400, 'Alguno de los números de empleado no existe en el catálogo');
      return fail(res, 500, 'Error al guardar la solicitud', err);
    }
  }

  /* ══ PUT — gerencia autoriza o rechaza ════════════════════════ */
  if (req.method === 'PUT') {
    const { id, decision, auth_num } = readBody(req);
    if (!id) return fail(res, 400, 'Falta el id de la solicitud');
    if (!DECISIONES.includes(decision)) return fail(res, 400, 'La decisión debe ser "autorizado" o "rechazado"');
    if (!auth_num) return fail(res, 400, 'Falta el número de quien autoriza');

    const quien = String(auth_num).trim();

    try {
      const sabRows = await sql`
        SELECT jefe_num, jefe_nombre, gerente_num, auth_gerente, fecha_sabado
        FROM sabados_laborados WHERE id = ${String(id)} LIMIT 1`;
      if (sabRows.length === 0) return fail(res, 404, 'La solicitud no existe');
      const solicitud = sabRows[0];

      /* Un jefe SÍ puede convocarse a sí mismo, pero no puede firmar
         su propia solicitud. Eso lo hace su gerente. */
      if (String(solicitud.jefe_num) === quien)
        return fail(res, 403, 'No puedes autorizar tu propia solicitud de sábado. La autoriza tu gerente.');

      const autRows = await sql`
        SELECT rol FROM usuarios WHERE num_emp = ${quien} AND activo = TRUE LIMIT 1`;
      if (autRows.length === 0) return fail(res, 403, 'Tu usuario no está activo en el catálogo');
      const esAdmin = autRows[0].rol === 'admin';

      const solRows = await sql`SELECT gerente_num FROM usuarios WHERE num_emp = ${solicitud.jefe_num} LIMIT 1`;
      const gerenteVigente = solRows[0]?.gerente_num;

      const autorizado = esAdmin
        || (solicitud.gerente_num != null && String(solicitud.gerente_num) === quien)
        || (gerenteVigente != null && String(gerenteVigente) === quien);
      if (!autorizado)
        return fail(res, 403, `Sólo el gerente de ${solicitud.jefe_nombre || solicitud.jefe_num} puede autorizar este sábado.`);

      const rows = await sql`
        UPDATE sabados_laborados SET
          auth_gerente     = ${decision},
          auth_gerente_num = ${quien},
          auth_gerente_ts  = NOW()
        WHERE id = ${String(id)} AND auth_gerente = 'pendiente'
        RETURNING *`;

      if (rows.length === 0)
        return fail(res, 409, `Esta solicitud ya fue ${solicitud.auth_gerente}`);

      const sab = rows[0];

      /* Autorizado → cada convocado pasa a tener que firmar.
         Rechazado → la solicitud muere ahí, nadie firma nada. */
      if (decision === 'autorizado') {
        await sql`
          UPDATE sabados_personal SET acept = 'pendiente'
          WHERE sabado_id = ${sab.id} AND acept = 'na'`;
      }

      try {
        await sql`
          INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
          VALUES (${sab.jefe_num}, ${quien}, 'resultado', ${sab.id},
            ${'Sábado ' + aISO(sab.fecha_sabado) + ' ' + decision},
            ${`Tu solicitud de sábado laborado del ${aISO(sab.fecha_sabado)} fue ${decision}.`})`;
        if (decision === 'autorizado') {
          await sql`
            INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
            SELECT sp.num_emp, ${quien}, 'consentimiento', ${sab.id},
              'Tienes una solicitud de sábado laborado por responder',
              'Gerencia autorizó el sábado ' || ${aISO(sab.fecha_sabado)} || '. Falta tu aceptación.'
            FROM sabados_personal sp
            WHERE sp.sabado_id = ${sab.id} AND sp.acept = 'pendiente'`;
        }
      } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

      return done(res, sab);
    } catch (err) {
      return fail(res, 500, 'Error al procesar la solicitud', err);
    }
  }

  /* ══ DELETE ═══════════════════════════════════════════════════ */
  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id).trim() : '';
    if (!id) return fail(res, 400, 'Falta el id de la solicitud');
    try {
      /* Si alguien ya firmó, la evidencia no se borra. */
      const [firmas] = await sql`
        SELECT COUNT(*)::int AS n FROM sabados_personal
        WHERE sabado_id = ${id} AND acept = 'aceptado'`;
      if (Number(firmas?.n || 0) > 0)
        return fail(res, 409, 'No se puede eliminar: ya hay trabajadores que firmaron su aceptación. Pide a un administrador que la anule.');

      const rows = await sql`DELETE FROM sabados_laborados WHERE id = ${id} RETURNING id`;
      if (rows.length === 0) return fail(res, 404, 'La solicitud no existe');
      await sql`DELETE FROM notificaciones WHERE referencia = ${id}`;
      return done(res, { id });
    } catch (err) {
      return fail(res, 500, 'Error al eliminar la solicitud', err);
    }
  }

  return fail(res, 405, 'Método no permitido');
}

import {
  getDb, preflight, fail, done, readBody,
  fechaMX, horaMX, esFechaISO, diasEntre,
  acumuladoSemanalVarios, MAX_DIA, MAX_SEMANA, VENTANA_RETRO
} from '../lib/db.js';
import { puedeSolicitarHoras, puedeSolicitarA } from '../lib/auth.js';
import { leyendaConsentimiento, sellarFirma, LEYENDA_VERSION, ipDe, uaDe } from '../lib/firma.js';

/* ══════════════════════════════════════════════════════════════════
   SOLICITUDES DE HORAS EXTRA — v3

   CAMBIO DE FONDO respecto a la v2.2: el operativo ya no captura sus
   propias horas. Es el jefe quien levanta la solicitud para su
   personal (por lote, igual que los sábados) y el trabajador la
   acepta o la rechaza desde su cuenta.

   Ese orden es el que refleja lo que pasa en la operación —el jefe
   pide que la persona se quede— y es el que exige el artículo 68 de
   la LFT, que dice que el trabajador NO está obligado a laborar
   tiempo extraordinario. La empresa solicita; el trabajador consiente.

   RUTA (se decide aquí, con datos del catálogo, nunca con lo que
   manda el navegador):

     Solicitud del jefe
       ├─ acumulado semanal ≤ 9 h → directo al TRABAJADOR
       │    auth_jefe = 'autorizado' (la solicitud ES la firma del jefe)
       │    acept_emp = 'pendiente'
       │
       └─ acumulado > 9 h (hora 10ª+) → GERENTE del solicitante
            auth_gerente = 'pendiente'
            acept_emp    = 'na'  ← el trabajador todavía no la ve
            (al autorizar el gerente, pasa a 'pendiente')

   El renglón del propio solicitante se autofirma: no tiene sentido
   que se mande una solicitud a sí mismo. Igual requiere la firma de
   su gerente.
   ══════════════════════════════════════════════════════════════════ */

const LIMITES = { admin: 1000, gerente: 800, jefe: 400, propios: 150, operario: 150 };
const MAX_PERSONAS = 60;

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  const sql = getDb();

  /* ══════════════════════════════════════════════════════════════
     GET — listar según rol
     ══════════════════════════════════════════════════════════════ */
  if (req.method === 'GET') {
    const numEmp = req.query.num_emp ? String(req.query.num_emp).trim() : '';
    const rol = String(req.query.rol || 'propios');
    if (!numEmp) return fail(res, 400, 'Falta el número de empleado');

    try {
      let rows;
      if (rol === 'admin') {
        rows = await sql`
          SELECT * FROM horas_extras ORDER BY ts DESC LIMIT ${LIMITES.admin}`;
      } else if (rol === 'gerente') {
        rows = await sql`
          SELECT h.* FROM horas_extras h
          LEFT JOIN usuarios u ON u.num_emp = h.num_emp
          WHERE u.gerente_num    = ${numEmp}
             OR h.gerente_num    = ${numEmp}
             OR h.solicitante_num = ${numEmp}
             OR h.num_emp        = ${numEmp}
          ORDER BY h.ts DESC LIMIT ${LIMITES.gerente}`;
      } else if (rol === 'jefe') {
        rows = await sql`
          SELECT h.* FROM horas_extras h
          LEFT JOIN usuarios u ON u.num_emp = h.num_emp
          WHERE u.jefe_num       = ${numEmp}
             OR h.jefe_num       = ${numEmp}
             OR h.solicitante_num = ${numEmp}
             OR h.num_emp        = ${numEmp}
          ORDER BY h.ts DESC LIMIT ${LIMITES.jefe}`;
      } else {
        /* 'propios' u 'operario': únicamente los suyos. Incluye la
           bandeja de lo que tiene por firmar (acept_emp='pendiente')
           y su historial. */
        rows = await sql`
          SELECT * FROM horas_extras
          WHERE num_emp = ${numEmp}
          ORDER BY fecha DESC, ts DESC LIMIT ${LIMITES.propios}`;
      }
      return done(res, rows);
    } catch (err) {
      return fail(res, 500, 'Error al obtener los registros', err);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     POST — el jefe levanta la solicitud para su personal (lote)
     ══════════════════════════════════════════════════════════════ */
  if (req.method === 'POST') {
    const b = readBody(req);
    const quien = b.solicitante_num ? String(b.solicitante_num).trim() : '';
    const fecha = b.fecha ? String(b.fecha).trim() : '';
    const personal = Array.isArray(b.personal) ? b.personal : [];

    if (!quien) return fail(res, 400, 'Falta el número de quien solicita');
    if (!esFechaISO(fecha)) return fail(res, 400, 'La fecha de la solicitud no es válida');
    if (personal.length === 0) return fail(res, 400, 'Agrega al menos una persona a la solicitud');
    if (personal.length > MAX_PERSONAS)
      return fail(res, 400, `No se pueden incluir más de ${MAX_PERSONAS} personas en una sola solicitud`);
    if (!b.causa_p3) return fail(res, 400, 'Falta completar el análisis de causa raíz');

    const hoy = fechaMX();
    const dif = diasEntre(fecha, hoy);           // negativo = fecha pasada
    if (dif < -VENTANA_RETRO)
      return fail(res, 400,
        `Sólo se pueden registrar horas de hoy, de fecha futura o de hasta ${VENTANA_RETRO} día(s) atrás. ` +
        `Para algo más antiguo, pide el alta a un administrador.`);
    if (dif > 60)
      return fail(res, 400, 'La fecha está demasiado lejos: máximo 60 días de anticipación');

    const esRetroactiva = dif < 0;

    try {
      /* ── 1. El solicitante, desde el catálogo ─────────────────── */
      const solRows = await sql`
        SELECT num_emp, nombre, rol, puesto, ubicacion, depto, jefe_num, gerente_num
        FROM usuarios WHERE num_emp = ${quien} AND activo = TRUE LIMIT 1`;
      if (solRows.length === 0)
        return fail(res, 403, 'Tu usuario no está activo en el catálogo');
      const sol = solRows[0];

      if (!puedeSolicitarHoras(sol.rol))
        return fail(res, 403, 'Tu rol no puede levantar solicitudes de horas extra. Tu jefe es quien las solicita por ti.');

      /* ── 2. El personal solicitado, también del catálogo ──────── */
      const pedidos = [];
      const vistos = new Set();
      for (const p of personal) {
        const n = String((p && p.num_emp) || '').trim();
        const h = Number(p && p.horas);
        if (!n) return fail(res, 400, 'Hay una persona sin número de empleado en la lista');
        if (vistos.has(n)) return fail(res, 400, `El empleado ${n} está repetido en la solicitud`);
        vistos.add(n);
        if (!Number.isFinite(h) || h <= 0)
          return fail(res, 400, `Las horas del empleado ${n} no son válidas`);
        if (h > MAX_DIA)
          return fail(res, 400, `No se pueden solicitar más de ${MAX_DIA} horas por día (Art. 66 LFT). Revisa al empleado ${n}.`);
        pedidos.push({ num_emp: n, horas: Math.round(h * 10) / 10 });
      }

      const nums = pedidos.map(p => p.num_emp);
      const empRows = await sql`
        SELECT num_emp, nombre, puesto, ubicacion, depto, rol, jefe_num, gerente_num
        FROM usuarios WHERE num_emp = ANY(${nums}::text[]) AND activo = TRUE`;
      const catalogo = new Map(empRows.map(u => [String(u.num_emp), u]));

      const problemas = [];
      for (const p of pedidos) {
        const u = catalogo.get(p.num_emp);
        if (!u) { problemas.push(`${p.num_emp}: no existe en el catálogo o está dado de baja`); continue; }
        if (u.rol === 'admin')
          problemas.push(`${u.nombre}: la cuenta de administrador es una cuenta de sistema y no registra horas extra`);
        else if (!puedeSolicitarA(sol, u))
          problemas.push(`${u.nombre}: no forma parte de tu personal a cargo`);
      }
      if (problemas.length)
        return fail(res, 403, 'No se envió nada. Corrige lo siguiente: ' + problemas.join(' · '));

      /* ── 3. Duplicados: una solicitud viva por persona y día ──── */
      const dup = await sql`
        SELECT num_emp, nombre FROM horas_extras
        WHERE fecha = ${fecha}
          AND num_emp = ANY(${nums}::text[])
          AND estado_final IN ('pendiente','autorizado')`;
      if (dup.length > 0) {
        const lista = dup.map(d => d.nombre || d.num_emp).join(', ');
        return fail(res, 409,
          `Ya hay una solicitud vigente para el ${fecha} de: ${lista}. ` +
          `Quítalos de la lista o cancela la solicitud anterior.`);
      }

      /* ── 4. Acumulado semanal real, de todos de una vez ───────── */
      const acum = await acumuladoSemanalVarios(sql, nums, fecha);

      /* ── 5. Ruta de autorización de cada renglón ──────────────── */
      const loteId = 'LOTE-' + Date.now().toString(36).toUpperCase() +
                     '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
      const ahora = new Date();
      const ahoraISO = ahora.toISOString();
      const ip = ipDe(req), ua = uaDe(req);
      const causaTexto = b.causa_texto || b.causa_cat || '';
      const gerenteDelSolicitante = sol.rol === 'jefe' ? (sol.gerente_num || '0000') : '0000';

      const filas = pedidos.map(p => {
        const u = catalogo.get(p.num_emp);
        const previas = Number(acum[p.num_emp] || 0);
        const horasSemana = Math.round((previas + p.horas) * 10) / 10;
        const esYo = String(u.num_emp) === String(sol.num_emp);
        const rebasa = horasSemana > MAX_SEMANA;

        /* El propio solicitante: su renglón lo firma su gerente y él
           ya consintió al levantarlo (autofirma). El resto: la
           solicitud del jefe vale como autorización de nivel 1. */
        const requiereGerente = esYo || rebasa;

        const fila = {
          num_emp: u.num_emp,
          nombre: u.nombre || null,
          puesto: u.puesto || null,
          ubicacion: u.ubicacion || null,
          depto: u.depto || null,
          horas: p.horas,
          horas_semana: horasSemana,
          jefe_num: esYo ? null : String(sol.num_emp),
          gerente_num: requiereGerente ? gerenteDelSolicitante : (u.gerente_num || null),
          auth_jefe: esYo ? 'na' : 'autorizado',
          auth_jefe_num: esYo ? null : String(sol.num_emp),
          auth_jefe_ts: esYo ? null : ahoraISO,
          auth_gerente: requiereGerente ? 'pendiente' : 'na',
          /* Mientras falte la firma de gerencia el trabajador no ve la
             solicitud: no tiene caso pedirle que acepte algo que quizá
             el gerente rechace. */
          acept_emp: esYo ? 'aceptado' : (requiereGerente ? 'na' : 'pendiente'),
          acept_ts: null,
          acept_ip: null,
          acept_ua: null,
          acept_leyenda: null,
          acept_ley_ver: null,
          acept_hash: null,
          acept_nota: null,
          estado_lft: p.horas > MAX_DIA ? 'bloqueado' : (p.horas >= 2.5 ? 'alerta' : 'ok')
        };

        /* Autofirma del solicitante: se guarda con la misma evidencia
           que cualquier otra aceptación. */
        if (esYo) {
          const leyenda = leyendaConsentimiento({
            tipo: 'hora_extra', nombre: u.nombre, num_emp: u.num_emp,
            horas: p.horas, fecha, solicitante: 'Yo mismo, como responsable del área,',
            causa: causaTexto
          });
          fila.acept_ts = ahoraISO;
          fila.acept_ip = ip;
          fila.acept_ua = ua;
          fila.acept_leyenda = leyenda;
          fila.acept_ley_ver = LEYENDA_VERSION;
          fila.acept_nota = 'Autofirma: el solicitante se incluyó en su propia solicitud.';
          fila.acept_hash = sellarFirma({
            id: loteId + ':' + u.num_emp, num_emp: u.num_emp, horas: p.horas,
            fecha, decision: 'aceptado', leyenda, ts: ahoraISO, ip
          });
        }
        return fila;
      });

      /* ── 6. Alta en una sola sentencia (atómica) ──────────────── */
      const insertadas = await sql`
        INSERT INTO horas_extras (
          fecha, hora_registro, num_emp, nombre, puesto, ubicacion, depto,
          horas_dia, horas_semana, causa_cat, causa_grupo, causa_p1, causa_p2,
          causa_p3, causa_texto, estado_lft, jefe_num, gerente_num,
          auth_jefe, auth_jefe_num, auth_jefe_ts, auth_gerente,
          lote_id, origen, solicitante_num, solicitante_nombre, solicitante_ts,
          acept_emp, acept_emp_ts, acept_emp_ip, acept_emp_ua,
          acept_emp_leyenda, acept_emp_ley_ver, acept_emp_hash, acept_emp_nota,
          estado_final
        )
        SELECT
          ${fecha}::date, ${horaMX()}::time, x.num_emp, x.nombre, x.puesto,
          x.ubicacion, x.depto, x.horas, x.horas_semana,
          ${b.causa_cat || null}, ${b.causa_grupo || null}, ${b.causa_p1 || null},
          ${b.causa_p2 || null}, ${b.causa_p3 || null}, ${b.causa_texto || null},
          x.estado_lft, x.jefe_num, x.gerente_num,
          x.auth_jefe, x.auth_jefe_num, x.auth_jefe_ts, x.auth_gerente,
          ${loteId}, 'jefe', ${String(sol.num_emp)}, ${sol.nombre || null}, ${ahoraISO}::timestamptz,
          x.acept_emp, x.acept_ts, x.acept_ip, x.acept_ua,
          x.acept_leyenda, x.acept_ley_ver, x.acept_hash, x.acept_nota,
          'pendiente'
        FROM jsonb_to_recordset(${JSON.stringify(filas)}::jsonb) AS x(
          num_emp text, nombre text, puesto text, ubicacion text, depto text,
          horas numeric, horas_semana numeric, jefe_num text, gerente_num text,
          auth_jefe text, auth_jefe_num text, auth_jefe_ts timestamptz,
          auth_gerente text, acept_emp text, acept_ts timestamptz,
          acept_ip text, acept_ua text, acept_leyenda text, acept_ley_ver text,
          acept_hash text, acept_nota text, estado_lft text
        )
        RETURNING *`;

      /* El renglón autofirmado del solicitante puede quedar resuelto ya
         mismo si además no requiere gerencia (caso del administrador
         solicitando para sí, que el catálogo no permite, o de un
         registro sin gerente asignado). Se deriva igual que siempre. */
      await sql`
        UPDATE horas_extras SET estado_final = 'autorizado'
        WHERE lote_id = ${loteId}
          AND auth_jefe    IN ('na','autorizado')
          AND auth_gerente IN ('na','autorizado')
          AND acept_emp    IN ('na','aceptado')`;

      /* ── 7. Notificaciones (nunca bloquean el alta) ───────────── */
      try {
        await sql`
          INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
          SELECT
            CASE WHEN h.auth_gerente = 'pendiente' THEN h.gerente_num ELSE h.num_emp END,
            ${String(sol.num_emp)},
            CASE WHEN h.auth_gerente = 'pendiente' THEN 'auth_gerente' ELSE 'consentimiento' END,
            h.id,
            CASE WHEN h.auth_gerente = 'pendiente'
                 THEN 'Autorización especial de horas extra — ' || COALESCE(h.nombre, h.num_emp)
                 ELSE 'Tienes una solicitud de horas extra por responder' END,
            COALESCE(h.nombre, h.num_emp) || ': ' || h.horas_dia || ' h el ' || h.fecha ||
              '. Acumulado semanal: ' || h.horas_semana || ' h.'
          FROM horas_extras h
          WHERE h.lote_id = ${loteId}
            AND h.acept_emp <> 'aceptado'
            AND COALESCE(CASE WHEN h.auth_gerente = 'pendiente' THEN h.gerente_num ELSE h.num_emp END, '') <> ''`;
      } catch (e) { console.warn('[GPA] Notificaciones no registradas:', e.message); }

      const aGerencia = insertadas.filter(r => r.auth_gerente === 'pendiente').length;
      return done(res, {
        lote_id: loteId,
        fecha,
        retroactiva: esRetroactiva,
        total: insertadas.length,
        a_gerencia: aGerencia,
        al_trabajador: insertadas.length - aGerencia,
        registros: insertadas
      }, 201);

    } catch (err) {
      if (String(err.message || '').includes('uq_he_emp_dia_viva'))
        return fail(res, 409, 'Alguien más acaba de registrar una solicitud para esa persona y ese día. Actualiza la pantalla e inténtalo de nuevo.');
      if (String(err.message || '').includes('foreign key'))
        return fail(res, 400, 'Alguno de los números de empleado no existe en el catálogo');
      if (String(err.message || '').includes('horas_dia'))
        return fail(res, 400, `Las horas de algún renglón salen del rango permitido (máximo ${MAX_DIA} h por día)`);
      return fail(res, 500, 'Error al guardar la solicitud', err);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     DELETE — cancelar / eliminar un registro

     Una solicitud que el trabajador YA FIRMÓ no se borra: se cancela,
     y la firma se conserva. Borrar evidencia firmada es justo lo que
     una auditoría no debe poder hacer. El borrado duro queda sólo
     para el administrador y para solicitudes sin firmar.
     ══════════════════════════════════════════════════════════════ */
  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id).trim() : '';
    const quien = req.query.num_emp ? String(req.query.num_emp).trim() : '';
    if (!id) return fail(res, 400, 'Falta el id del registro');

    try {
      const regRows = await sql`
        SELECT id, num_emp, nombre, solicitante_num, acept_emp, estado_final
        FROM horas_extras WHERE id = ${id} LIMIT 1`;
      if (regRows.length === 0) return fail(res, 404, 'El registro no existe o ya fue eliminado');
      const reg = regRows[0];

      let esAdmin = false;
      if (quien) {
        const a = await sql`SELECT rol FROM usuarios WHERE num_emp = ${quien} AND activo = TRUE LIMIT 1`;
        esAdmin = a[0]?.rol === 'admin';
      }

      /* Firmada por el trabajador → se cancela, no se borra. */
      if (reg.acept_emp === 'aceptado' && !esAdmin) {
        const rows = await sql`
          UPDATE horas_extras
          SET estado_final = 'cancelado', rechazado_por = 'jefe'
          WHERE id = ${id} AND estado_final IN ('pendiente','autorizado')
          RETURNING *`;
        if (rows.length === 0) return fail(res, 409, 'Este registro ya estaba cerrado');
        return done(res, { id, cancelado: true, data: rows[0] });
      }

      await sql`DELETE FROM horas_extras WHERE id = ${id}`;
      await sql`DELETE FROM notificaciones WHERE referencia = ${id}`;
      return done(res, { id, cancelado: false });
    } catch (err) {
      return fail(res, 500, 'Error al eliminar el registro', err);
    }
  }

  return fail(res, 405, 'Método no permitido');
}

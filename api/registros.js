import {
  getDb, preflight, fail, done, readBody,
  fechaMX, horaMX, semanaMX, MAX_DIA, MAX_SEMANA
} from '../lib/db.js';

const LIMITES = { admin: 1000, gerente: 800, jefe: 400, propios: 120, operario: 120 };

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
        /* Su gente directa + los que lo tienen como gerente + sus propios registros */
        rows = await sql`
          SELECT h.* FROM horas_extras h
          LEFT JOIN usuarios u ON u.num_emp = h.num_emp
          WHERE u.gerente_num = ${numEmp}
             OR h.gerente_num = ${numEmp}
             OR h.num_emp     = ${numEmp}
          ORDER BY h.ts DESC LIMIT ${LIMITES.gerente}`;
      } else if (rol === 'jefe') {
        rows = await sql`
          SELECT h.* FROM horas_extras h
          LEFT JOIN usuarios u ON u.num_emp = h.num_emp
          WHERE u.jefe_num = ${numEmp}
             OR h.jefe_num = ${numEmp}
             OR h.num_emp  = ${numEmp}
          ORDER BY h.ts DESC LIMIT ${LIMITES.jefe}`;
      } else {
        /* 'propios' u 'operario': únicamente los suyos */
        rows = await sql`
          SELECT * FROM horas_extras
          WHERE num_emp = ${numEmp}
          ORDER BY ts DESC LIMIT ${LIMITES.propios}`;
      }
      return done(res, rows);
    } catch (err) {
      return fail(res, 500, 'Error al obtener los registros', err);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     POST — crear registro
     ══════════════════════════════════════════════════════════════ */
  if (req.method === 'POST') {
    const b = readBody(req);
    const numEmp = b.num_emp ? String(b.num_emp).trim() : '';
    const horasDia = Number(b.horas_dia);

    if (!numEmp) return fail(res, 400, 'Falta el número de empleado');
    if (!Number.isFinite(horasDia) || horasDia <= 0)
      return fail(res, 400, 'Las horas registradas no son válidas');
    if (horasDia > MAX_DIA)
      return fail(res, 400, `No se pueden registrar más de ${MAX_DIA} horas por día (Art. 68 LFT)`);
    if (!b.causa_p3)
      return fail(res, 400, 'Falta completar el análisis de causa raíz');

    try {
      /* ─────────────────────────────────────────────────────────────
         El rol y la cadena de autorización se leen de la BASE, nunca
         del navegador. Antes llegaban en el body: un jefe podía
         mandarse a sí mismo como autorizador y firmarse sus horas.
         ───────────────────────────────────────────────────────────── */
      const empRows = await sql`
        SELECT rol, nombre, puesto, ubicacion, depto, jefe_num, gerente_num
        FROM usuarios WHERE num_emp = ${numEmp} AND activo = TRUE LIMIT 1`;
      if (empRows.length === 0)
        return fail(res, 400, 'El empleado no existe en el catálogo o está dado de baja');
      const emp = empRows[0];
      /* Fecha y hora en zona horaria de México, no en UTC. */
      const hoy = fechaMX();
      const hora = horaMX();

      /* Candado de un registro por día. Va DENTRO del try: antes estaba
         fuera y si la consulta fallaba, Vercel devolvía una página HTML
         de error 500 que el frontend no podía interpretar. */
      const dup = await sql`
        SELECT id FROM horas_extras
        WHERE num_emp = ${numEmp} AND fecha = ${hoy} AND estado_final <> 'rechazado'
        LIMIT 1`;
      if (dup.length > 0)
        return fail(res, 409, 'Ya registraste tus horas extra hoy. Sólo se permite un registro por día.');

      /* El acumulado semanal se calcula EN EL SERVIDOR con los datos
         reales de la base. Antes llegaba desde el navegador, así que
         un cliente desactualizado (o alterado) podía saltarse el
         límite de 9 h semanales. */
      const { ini, fin } = semanaMX(hoy);
      const acum = await sql`
        SELECT COALESCE(SUM(horas_dia),0) AS total FROM horas_extras
        WHERE num_emp = ${numEmp} AND fecha BETWEEN ${ini} AND ${fin}
          AND estado_final <> 'rechazado'`;
      const previas = Number(acum[0]?.total || 0);
      const horasSemana = Math.round((previas + horasDia) * 10) / 10;

      /* ─────────────────────────────────────────────────────────────
         RUTA DE AUTORIZACIÓN — se decide aquí, según el rol real.

         · Operario   → su jefe directo. Si pasa de 9 h en la semana,
                        salta al gerente (autorización especial).
         · Jefe       → SIEMPRE su gerente. Nunca pasa por el nivel de
                        jefe, para que no pueda autorizarse a sí mismo
                        ni caer en la bandeja de otro jefe.
         · Gerente    → el administrador.
         · Admin      → el administrador (queda registrado igual).
         ───────────────────────────────────────────────────────────── */
      let jefeNum = null, gerenteNum = null;
      let authJefe = 'na', authGerente = 'na';

      if (emp.rol === 'operario') {
        if (horasSemana > MAX_SEMANA) {
          authGerente = 'pendiente';
          gerenteNum  = emp.gerente_num || '0000';
        } else if (emp.jefe_num) {
          authJefe = 'pendiente';
          jefeNum  = emp.jefe_num;
          gerenteNum = emp.gerente_num || null;   // referencia, no autoriza
        } else {
          // Operario sin jefe asignado: sube al gerente para que la
          // solicitud no se quede sin nadie que la revise.
          authGerente = 'pendiente';
          gerenteNum  = emp.gerente_num || '0000';
        }
      } else {
        authGerente = 'pendiente';
        gerenteNum  = emp.rol === 'jefe' ? (emp.gerente_num || '0000') : '0000';
      }

      const requiereGerente = authGerente === 'pendiente';
      const nulo = v => (v === undefined || v === '' ? null : v);

      /* jefe_num / gerente_num guardan la cadena de autorización ASIGNADA.
         auth_jefe_num / auth_gerente_num se quedan en NULL y sólo se llenan
         cuando alguien autoriza de verdad: así el expediente distingue
         "quién debía firmar" de "quién firmó", que es lo que pide una
         auditoría. Antes se escribía el jefe asignado en auth_jefe_num
         desde el alta, y esa distinción se perdía. */
      const rows = await sql`
        INSERT INTO horas_extras (
          fecha, hora_registro, num_emp, nombre, puesto, ubicacion, depto,
          horas_dia, horas_semana, causa_cat, causa_grupo, causa_p1, causa_p2, causa_p3,
          causa_texto, estado_lft, jefe_num, gerente_num,
          auth_jefe, auth_gerente, estado_final
        ) VALUES (
          ${hoy}, ${hora}, ${numEmp}, ${emp.nombre}, ${emp.puesto},
          ${emp.ubicacion}, ${emp.depto}, ${horasDia}, ${horasSemana},
          ${nulo(b.causa_cat)}, ${nulo(b.causa_grupo)}, ${nulo(b.causa_p1)},
          ${nulo(b.causa_p2)}, ${nulo(b.causa_p3)}, ${nulo(b.causa_texto)},
          ${nulo(b.estado_lft) || 'ok'}, ${jefeNum}, ${gerenteNum},
          ${authJefe}, ${authGerente}, 'pendiente'
        ) RETURNING *`;

      /* Notificación al autorizador (se ignora si algo falla: no debe
         impedir que la solicitud quede guardada). */
      try {
        const para = requiereGerente ? gerenteNum : jefeNum;
        if (para) {
          await sql`
            INSERT INTO notificaciones (para_num, de_num, tipo, referencia, asunto, cuerpo)
            VALUES (${String(para)}, ${numEmp},
              ${requiereGerente ? 'auth_gerente' : 'hora_extra'}, ${rows[0].id},
              ${'Horas extra por autorizar: ' + (emp.nombre || numEmp)},
              ${`${emp.nombre || numEmp} registró ${horasDia}h el ${hoy}. Acumulado semanal: ${horasSemana}h. Causa: ${b.causa_texto || ''}`})`;
        }
      } catch (e) { console.warn('[GPA] Notificación no registrada:', e.message); }

      return done(res, rows[0], 201);
    } catch (err) {
      if (String(err.message || '').includes('foreign key'))
        return fail(res, 400, 'El número de empleado no existe en el catálogo de usuarios');
      return fail(res, 500, 'Error al guardar el registro', err);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     DELETE — el frontend ya lo llamaba, pero el endpoint no existía:
     el botón de eliminar no hacía nada. Ahora sí funciona.
     ══════════════════════════════════════════════════════════════ */
  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id).trim() : '';
    if (!id) return fail(res, 400, 'Falta el id del registro');
    try {
      const rows = await sql`DELETE FROM horas_extras WHERE id = ${id} RETURNING id`;
      if (rows.length === 0) return fail(res, 404, 'El registro no existe o ya fue eliminado');
      await sql`DELETE FROM notificaciones WHERE referencia = ${id}`;
      return done(res, { id });
    } catch (err) {
      return fail(res, 500, 'Error al eliminar el registro', err);
    }
  }

  return fail(res, 405, 'Método no permitido');
}

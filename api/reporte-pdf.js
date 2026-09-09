import { getDb, preflight, fail, esFechaISO, fechaMX, horaMX, aISO } from '../lib/db.js';
import { puedeDescargarPDF } from '../lib/auth.js';
import { construirFormatoPDF, DOC_CODIGO } from '../lib/pdf-formato.js';

/* ══════════════════════════════════════════════════════════════════
   GRL-RH-FO-2 Rev. 3
   HISTORIAL Y AUTORIZACIÓN DE TIEMPO EXTRAORDINARIO

   Formato imprimible y firmable, uno por trabajador. Sustituye a la
   hoja que hoy se llena a mano: trae el detalle de las horas que la
   persona aceptó, el resumen del periodo, la constancia de la firma
   electrónica y el bloque de tres firmas autógrafas (trabajador,
   jefe inmediato y Recursos Humanos).

   Aquí se validan permisos y se consultan los datos. El dibujo del
   documento vive en lib/pdf-formato.js.

   GET /api/reporte-pdf
     num_emp   · quién lo descarga (debe ser gerente o admin)
     rol       · su rol
     desde     · AAAA-MM-DD          (por defecto, el mes en curso)
     hasta     · AAAA-MM-DD
     empleado  · num_emp del trabajador, o 'todos'
     ubicacion · filtro de sucursal (opcional)
     agrupar   · 'dia' | 'semana' | 'mes'
     todas     · '1' para incluir pendientes, rechazadas y vencidas
                 (el documento sale marcado BORRADOR — SIN VALIDEZ)

   Restringido a gerencia y administración: es el documento que se
   imprime y se firma, no un reporte de consulta.
   ══════════════════════════════════════════════════════════════════ */

const iso = aISO;
const dmy = v => { const s = iso(v); return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : ''; };

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Método no permitido');

  const numEmp = req.query.num_emp ? String(req.query.num_emp).trim() : '';
  const rol = String(req.query.rol || '');
  if (!numEmp) return fail(res, 400, 'Falta el número de empleado');
  if (!puedeDescargarPDF(rol))
    return fail(res, 403, 'Este formato sólo lo pueden descargar Gerencia y Administración.');

  const hoy = fechaMX();
  let desde = req.query.desde ? String(req.query.desde) : hoy.slice(0, 8) + '01';
  let hasta = req.query.hasta ? String(req.query.hasta) : hoy;
  if (!esFechaISO(desde) || !esFechaISO(hasta))
    return fail(res, 400, 'Las fechas deben tener formato AAAA-MM-DD');
  if (desde > hasta) { const t = desde; desde = hasta; hasta = t; }

  const objetivo = req.query.empleado && String(req.query.empleado) !== 'todos'
    ? String(req.query.empleado).trim() : '';
  const ubicacion = req.query.ubicacion ? String(req.query.ubicacion).trim() : '';
  const agrupar = ['dia', 'semana', 'mes'].includes(String(req.query.agrupar))
    ? String(req.query.agrupar) : 'dia';
  const todas = String(req.query.todas || '') === '1';

  const sql = getDb();

  try {
    /* ── Alcance ────────────────────────────────────────────────
       Se resuelve en el servidor: un gerente sólo ve su estructura,
       aunque manipule la URL a mano. */
    const esAdmin = rol === 'admin';

    const personas = await sql`
      SELECT u.num_emp, u.nombre, u.puesto, u.depto, u.ubicacion, u.rol,
             u.jefe_num, u.gerente_num,
             j.nombre AS jefe_nombre, j.puesto AS jefe_puesto
      FROM usuarios u
      LEFT JOIN usuarios j ON j.num_emp = u.jefe_num
      WHERE u.rol <> 'admin'
        AND (${esAdmin} OR u.gerente_num = ${numEmp}
             OR u.jefe_num IN (SELECT num_emp FROM usuarios WHERE gerente_num = ${numEmp}))
        AND (${objetivo} = '' OR u.num_emp = ${objetivo})
        AND (${ubicacion} = '' OR u.ubicacion = ${ubicacion})
      ORDER BY u.ubicacion NULLS LAST, u.nombre`;

    if (personas.length === 0)
      return fail(res, 404, 'No hay personal dentro de tu alcance con esos filtros.');
    if (!objetivo && personas.length > 200)
      return fail(res, 400, 'Son demasiadas personas para un solo archivo. Filtra por sucursal o genera el formato por empleado.');

    const nums = personas.map(p => String(p.num_emp));

    const horas = await sql`
      SELECT id, fecha, num_emp, horas_dia, causa_cat, causa_p3, causa_texto,
             solicitante_nombre, solicitante_num, origen,
             auth_jefe_num, auth_gerente, auth_gerente_num, auth_gerente_ts,
             acept_emp, acept_emp_ts, acept_emp_hash, acept_emp_nota, acept_emp_ley_ver,
             estado_final, rechazado_por
      FROM horas_extras
      WHERE num_emp = ANY(${nums}::text[])
        AND fecha BETWEEN ${desde} AND ${hasta}
        AND (${todas} OR estado_final = 'autorizado')
      ORDER BY fecha, num_emp`;

    const sabados = await sql`
      SELECT s.id, s.fecha_sabado AS fecha, sp.num_emp, sp.horas AS horas_dia,
             s.causa_cat, s.causa_p3, s.causa_texto,
             s.jefe_nombre AS solicitante_nombre, s.jefe_num AS solicitante_num,
             s.auth_gerente, s.auth_gerente_num, s.auth_gerente_ts,
             sp.acept AS acept_emp, sp.acept_ts AS acept_emp_ts, sp.acept_hash AS acept_emp_hash,
             sp.acept_nota AS acept_emp_nota, sp.acept_ley_ver AS acept_emp_ley_ver
      FROM sabados_personal sp
      JOIN sabados_laborados s ON s.id = sp.sabado_id
      WHERE sp.num_emp = ANY(${nums}::text[])
        AND s.fecha_sabado BETWEEN ${desde} AND ${hasta}
        AND (${todas} OR (s.auth_gerente = 'autorizado' AND sp.acept <> 'rechazado'))
      ORDER BY s.fecha_sabado, sp.num_emp`;

    /* Horas entre semana y sábados se juntan en una sola línea de
       tiempo por persona: para el trabajador todo es tiempo extra. */
    const movimientos = new Map(nums.map(n => [n, []]));
    horas.forEach(h => movimientos.get(String(h.num_emp))?.push({ ...h, tipo: 'Entre semana' }));
    sabados.forEach(s => movimientos.get(String(s.num_emp))?.push({
      ...s,
      tipo: 'Sábado',
      estado_final: s.auth_gerente === 'autorizado'
        ? (s.acept_emp === 'rechazado' ? 'rechazado'
          : s.acept_emp === 'vencido' ? 'vencido'
            : s.acept_emp === 'pendiente' ? 'pendiente' : 'autorizado')
        : (s.auth_gerente === 'rechazado' ? 'rechazado' : 'pendiente')
    }));
    movimientos.forEach(lista => lista.sort((a, b) => iso(a.fecha) < iso(b.fecha) ? -1 : 1));

    /* Sólo se imprime a quien tenga movimientos en el periodo: nadie
       firma una hoja en blanco. */
    const conDatos = personas.filter(p => (movimientos.get(String(p.num_emp)) || []).length > 0);
    if (conDatos.length === 0)
      return fail(res, 404, 'No hay horas extra registradas en ese periodo con los filtros elegidos.');

    const quienRows = await sql`SELECT nombre FROM usuarios WHERE num_emp = ${numEmp} LIMIT 1`;
    const quien = quienRows[0]?.nombre || numEmp;

    const folio = 'RPT-' + Date.now().toString(36).toUpperCase() +
                  '-' + Math.random().toString(36).slice(2, 5).toUpperCase();

    const buf = await construirFormatoPDF({
      personas: conDatos,
      movimientos,
      desde, hasta, agrupar, todas, folio,
      generadoPor: `${quien} (${numEmp})`,
      generadoEl: `${dmy(hoy)} a las ${horaMX().slice(0, 5)} h`
    });

    const sufijo = objetivo ? `_${objetivo}` : '_todos';
    const nombre = `${DOC_CODIGO}_Horas_Extras${sufijo}_${desde}_a_${hasta}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('Content-Length', String(buf.length));
    return res.status(200).send(buf);

  } catch (err) {
    return fail(res, 500, 'Error al generar el formato PDF', err);
  }
}

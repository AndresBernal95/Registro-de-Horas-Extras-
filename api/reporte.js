import * as XLSX from 'xlsx';
import { getDb, preflight, fail, esFechaISO, fechaMX, semanaMX, aISO, MAX_SEMANA } from '../lib/db.js';
import { puedeVerMonitor } from '../lib/auth.js';

/* ══════════════════════════════════════════════════════════════════
   REPORTE EN EXCEL (.xlsx real, no CSV renombrado)

   GET /api/reporte?num_emp=8101&rol=gerente&desde=2026-08-01&hasta=2026-08-31
                    [&ubicacion=Sucursal%20Cancun][&estado=autorizado]

   Genera un libro con tres hojas:
     1. Detalle              — una fila por solicitud + fila de TOTAL
     2. Resumen por empleado — total, autorizadas, pendientes, rechazadas
     3. Resumen por causa    — horas por categoría, operativas vs. administrativas
   ══════════════════════════════════════════════════════════════════ */

const ESTADOS = ['pendiente', 'autorizado', 'rechazado', 'vencido', 'cancelado'];

const ETIQ_ACEPT = {
  aceptado: 'ACEPTADO por el trabajador',
  rechazado: 'RECHAZADO por el trabajador',
  pendiente: 'Esperando al trabajador',
  vencido: 'Sin respuesta (vencida)',
  na: 'No aplica'
};
const fechaHora = v => v ? String(new Date(v).toISOString()).replace('T', ' ').slice(0, 19) + ' UTC' : '';
const r1 = n => Math.round(Number(n || 0) * 10) / 10;

function semaforo(h) {
  const v = Number(h || 0);
  if (v <= 0) return 'Sin horas';
  if (v <= 3) return 'Normal';
  if (v <= 6) return 'Precaución';
  if (v <= MAX_SEMANA) return 'En límite';
  return 'Excedido';
}

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Método no permitido');

  const numEmp = req.query.num_emp ? String(req.query.num_emp).trim() : '';
  const rol = String(req.query.rol || '');
  if (!numEmp) return fail(res, 400, 'Falta el número de empleado');
  if (!puedeVerMonitor(rol)) return fail(res, 403, 'Tu rol no puede descargar reportes');

  /* Rango por defecto: mes en curso */
  const hoy = fechaMX();
  let desde = req.query.desde ? String(req.query.desde) : hoy.slice(0, 8) + '01';
  let hasta = req.query.hasta ? String(req.query.hasta) : hoy;
  if (!esFechaISO(desde) || !esFechaISO(hasta)) return fail(res, 400, 'Las fechas deben tener formato AAAA-MM-DD');
  if (desde > hasta) { const t = desde; desde = hasta; hasta = t; }

  const ubicacion = req.query.ubicacion ? String(req.query.ubicacion).trim() : '';
  const estado = req.query.estado && ESTADOS.includes(String(req.query.estado)) ? String(req.query.estado) : '';

  const sql = getDb();

  try {
    /* ── Consulta según el alcance del rol ─────────────────────── */
    let filas;
    if (rol === 'admin') {
      filas = await sql`
        SELECT h.* FROM horas_extras h
        WHERE h.fecha BETWEEN ${desde} AND ${hasta}
        ORDER BY h.fecha DESC, h.nombre`;
    } else if (rol === 'gerente') {
      filas = await sql`
        SELECT h.* FROM horas_extras h
        LEFT JOIN usuarios u ON u.num_emp = h.num_emp
        WHERE h.fecha BETWEEN ${desde} AND ${hasta}
          AND (u.gerente_num = ${numEmp} OR h.gerente_num = ${numEmp} OR h.num_emp = ${numEmp})
        ORDER BY h.fecha DESC, h.nombre`;
    } else { /* jefe */
      filas = await sql`
        SELECT h.* FROM horas_extras h
        LEFT JOIN usuarios u ON u.num_emp = h.num_emp
        WHERE h.fecha BETWEEN ${desde} AND ${hasta}
          AND (u.jefe_num = ${numEmp} OR h.jefe_num = ${numEmp} OR h.num_emp = ${numEmp})
        ORDER BY h.fecha DESC, h.nombre`;
    }

    /* Filtros en memoria (el conjunto ya viene acotado por fecha y rol) */
    if (ubicacion) filas = filas.filter(f => f.ubicacion === ubicacion);
    if (estado) filas = filas.filter(f => (f.estado_final || 'pendiente') === estado);

    /* ── HOJA 1 · DETALLE ─────────────────────────────────────── */
    const encDetalle = ['Folio', 'Fecha', 'Hora', 'N° Empleado', 'Nombre', 'Puesto',
      'Departamento', 'Sucursal', 'Horas del día', 'Acum. semana', 'Semáforo',
      'Tipo de causa', 'Categoría', 'Detalle', '¿Por qué? (1er porqué)', 'Causa raíz',
      'Estado LFT', 'Solicitada por', 'N° Solicitante', 'Autoriz. Jefe', 'N° Jefe',
      'Autoriz. Gerente', 'N° Gerente', 'Respuesta del trabajador', 'Fecha de la firma',
      'Comentario del trabajador', 'Estado final', 'Rechazada por'];

    const detalle = filas.map(f => ([
      f.id,
      aISO(f.fecha),
      String(f.hora_registro || '').slice(0, 8),
      f.num_emp, f.nombre || '', f.puesto || '', f.depto || '', f.ubicacion || '',
      Number(f.horas_dia || 0), Number(f.horas_semana || 0), semaforo(f.horas_semana || f.horas_dia),
      f.causa_grupo === 'adm' ? 'Administrativa' : 'Operativa',
      f.causa_cat || '', f.causa_p1 || '', f.causa_p2 || '', f.causa_p3 || '',
      f.estado_lft || '',
      f.solicitante_nombre || (f.origen === 'auto' ? 'El propio empleado (v2)' : ''),
      f.solicitante_num || '',
      f.auth_jefe || '', f.auth_jefe_num || '',
      f.auth_gerente || '', f.auth_gerente_num || '',
      ETIQ_ACEPT[f.acept_emp] || f.acept_emp || '',
      fechaHora(f.acept_emp_ts), f.acept_emp_nota || '',
      f.estado_final || 'pendiente', f.rechazado_por || ''
    ]));

    const totalHoras = r1(filas.reduce((s, f) => s + Number(f.horas_dia || 0), 0));
    const totalAut = r1(filas.filter(f => f.estado_final === 'autorizado').reduce((s, f) => s + Number(f.horas_dia || 0), 0));
    const totalPen = r1(filas.filter(f => (f.estado_final || 'pendiente') === 'pendiente').reduce((s, f) => s + Number(f.horas_dia || 0), 0));
    const totalRec = r1(filas.filter(f => f.estado_final === 'rechazado').reduce((s, f) => s + Number(f.horas_dia || 0), 0));

    const aoaDetalle = [
      ['GPA AQUA — REPORTE DE HORAS EXTRAS'],
      [`Periodo: ${desde} al ${hasta}`,
       ubicacion ? `Sucursal: ${ubicacion}` : 'Todas las sucursales',
       estado ? `Estado: ${estado}` : 'Todos los estados',
       `Generado: ${hoy}`],
      [],
      encDetalle,
      ...detalle,
      [],
      ['', '', '', '', '', '', '', 'TOTAL DE HORAS:', totalHoras],
      ['', '', '', '', '', '', '', 'Autorizadas:', totalAut],
      ['', '', '', '', '', '', '', 'Pendientes:', totalPen],
      ['', '', '', '', '', '', '', 'Rechazadas:', totalRec],
      ['', '', '', '', '', '', '', 'Solicitudes:', filas.length]
    ];

    const hDetalle = XLSX.utils.aoa_to_sheet(aoaDetalle);
    hDetalle['!cols'] = [{ wch: 13 }, { wch: 11 }, { wch: 9 }, { wch: 12 }, { wch: 34 }, { wch: 26 },
      { wch: 20 }, { wch: 24 }, { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 14 }, { wch: 32 },
      { wch: 26 }, { wch: 34 }, { wch: 32 }, { wch: 11 }, { wch: 30 }, { wch: 13 }, { wch: 13 },
      { wch: 10 }, { wch: 15 }, { wch: 11 }, { wch: 26 }, { wch: 21 }, { wch: 30 }, { wch: 13 },
      { wch: 13 }];
    hDetalle['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: 3 + detalle.length, c: encDetalle.length - 1 } }) };
    hDetalle['!freeze'] = { xSplit: 0, ySplit: 4 };

    /* ── HOJA 2 · RESUMEN POR EMPLEADO ────────────────────────── */
    const porEmp = new Map();
    filas.forEach(f => {
      const k = String(f.num_emp);
      if (!porEmp.has(k)) porEmp.set(k, {
        num: f.num_emp, nombre: f.nombre || '', puesto: f.puesto || '',
        depto: f.depto || '', suc: f.ubicacion || '',
        regs: 0, total: 0, aut: 0, pen: 0, rec: 0, op: 0, adm: 0
      });
      const e = porEmp.get(k);
      const h = Number(f.horas_dia || 0);
      e.regs++; e.total += h;
      if (f.estado_final === 'autorizado') e.aut += h;
      else if (f.estado_final === 'rechazado') e.rec += h;
      else e.pen += h;
      if (f.causa_grupo === 'adm') e.adm += h; else e.op += h;
    });

    const emps = [...porEmp.values()].sort((a, b) => b.total - a.total);
    const aoaEmp = [
      ['RESUMEN POR EMPLEADO'],
      [`Periodo: ${desde} al ${hasta}`],
      [],
      ['N° Empleado', 'Nombre', 'Puesto', 'Departamento', 'Sucursal', 'Solicitudes',
       'Horas totales', 'Autorizadas', 'Pendientes', 'Rechazadas', 'H. Operativas', 'H. Administrativas'],
      ...emps.map(e => [e.num, e.nombre, e.puesto, e.depto, e.suc, e.regs,
        r1(e.total), r1(e.aut), r1(e.pen), r1(e.rec), r1(e.op), r1(e.adm)]),
      [],
      ['', '', '', '', 'TOTALES:', filas.length, totalHoras, totalAut, totalPen, totalRec,
        r1(emps.reduce((s, e) => s + e.op, 0)), r1(emps.reduce((s, e) => s + e.adm, 0))]
    ];
    const hEmp = XLSX.utils.aoa_to_sheet(aoaEmp);
    hEmp['!cols'] = [{ wch: 12 }, { wch: 36 }, { wch: 26 }, { wch: 20 }, { wch: 24 },
      { wch: 12 }, { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 17 }];
    hEmp['!freeze'] = { xSplit: 0, ySplit: 4 };

    /* ── HOJA 3 · RESUMEN POR CAUSA ───────────────────────────── */
    const porCausa = new Map();
    filas.forEach(f => {
      const k = (f.causa_grupo === 'adm' ? 'A|' : 'O|') + (f.causa_cat || 'Sin categoría');
      if (!porCausa.has(k)) porCausa.set(k, {
        tipo: f.causa_grupo === 'adm' ? 'Administrativa' : 'Operativa',
        cat: f.causa_cat || 'Sin categoría', regs: 0, horas: 0, emps: new Set(), raices: new Map()
      });
      const c = porCausa.get(k);
      c.regs++; c.horas += Number(f.horas_dia || 0); c.emps.add(String(f.num_emp));
      const raiz = f.causa_p3 || 'Sin causa raíz';
      c.raices.set(raiz, (c.raices.get(raiz) || 0) + 1);
    });

    const causas = [...porCausa.values()].sort((a, b) => b.horas - a.horas);
    const aoaCausa = [
      ['RESUMEN POR CAUSA RAÍZ'],
      [`Periodo: ${desde} al ${hasta}`],
      ['Ordenado por horas, de mayor a menor. Útil para priorizar acciones de mejora.'],
      [],
      ['Tipo', 'Categoría', 'Solicitudes', 'Horas', '% del total', 'Empleados', 'Causa raíz más frecuente', 'Veces'],
      ...causas.map(c => {
        const top = [...c.raices.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
        return [c.tipo, c.cat, c.regs, r1(c.horas),
          totalHoras > 0 ? Math.round((c.horas / totalHoras) * 1000) / 10 + '%' : '0%',
          c.emps.size, top[0], top[1]];
      }),
      [],
      ['', 'TOTAL:', filas.length, totalHoras, '100%'],
      [],
      ['DESGLOSE POR TIPO'],
      ['Operativas', '', filas.filter(f => f.causa_grupo !== 'adm').length,
        r1(filas.filter(f => f.causa_grupo !== 'adm').reduce((s, f) => s + Number(f.horas_dia || 0), 0))],
      ['Administrativas', '', filas.filter(f => f.causa_grupo === 'adm').length,
        r1(filas.filter(f => f.causa_grupo === 'adm').reduce((s, f) => s + Number(f.horas_dia || 0), 0))]
    ];
    const hCausa = XLSX.utils.aoa_to_sheet(aoaCausa);
    hCausa['!cols'] = [{ wch: 16 }, { wch: 40 }, { wch: 12 }, { wch: 10 },
      { wch: 12 }, { wch: 11 }, { wch: 40 }, { wch: 8 }];

    /* ── HOJA 4 · CONSENTIMIENTOS (firma electrónica) ─────────────
       Es la hoja que pide una auditoría: por cada hora extra, quién
       firmó, cuándo, desde dónde y con qué sello de integridad. */
    const firmadas = filas.filter(f => f.acept_emp && f.acept_emp !== 'na');
    const aoaFirmas = [
      ['CONSENTIMIENTOS DEL TRABAJADOR — FIRMA ELECTRÓNICA'],
      [`Periodo: ${desde} al ${hasta}`],
      ['Cada renglón conserva el texto íntegro de la leyenda que se mostró en pantalla, el sello de'],
      ['fecha y hora, la IP de origen y un sello de integridad SHA-256 que permite comprobar que el'],
      ['registro no se alteró después de firmarse.'],
      [],
      ['Folio', 'Fecha de las horas', 'N° Empleado', 'Nombre', 'Horas', 'Solicitada por',
       'Respuesta', 'Fecha y hora de la firma', 'Versión de la leyenda', 'IP de origen',
       'Sello de integridad (SHA-256)', 'Comentario'],
      ...firmadas.map(f => [
        f.id, aISO(f.fecha), f.num_emp, f.nombre || '',
        Number(f.horas_dia || 0), f.solicitante_nombre || '',
        ETIQ_ACEPT[f.acept_emp] || f.acept_emp,
        fechaHora(f.acept_emp_ts), f.acept_emp_ley_ver || '', f.acept_emp_ip || '',
        f.acept_emp_hash || '', f.acept_emp_nota || ''
      ])
    ];
    const hFirmas = XLSX.utils.aoa_to_sheet(aoaFirmas);
    hFirmas['!cols'] = [{ wch: 13 }, { wch: 17 }, { wch: 12 }, { wch: 34 }, { wch: 8 },
      { wch: 30 }, { wch: 26 }, { wch: 23 }, { wch: 19 }, { wch: 17 }, { wch: 66 }, { wch: 34 }];
    hFirmas['!freeze'] = { xSplit: 0, ySplit: 7 };

    /* ── HOJA 5 · SÁBADOS LABORADOS ───────────────────────────────
       Las horas de sábado cuentan para el límite de 9 h de la semana,
       así que un reporte que sólo trae lo de entre semana engaña. */
    let sabados = [];
    try {
      if (rol === 'admin') {
        sabados = await sql`
          SELECT s.id, s.fecha_sabado, s.jefe_nombre, s.causa_cat, s.causa_p3, s.auth_gerente,
                 sp.num_emp, sp.nombre, sp.puesto, sp.ubicacion, sp.horas,
                 sp.acept, sp.acept_ts, sp.acept_hash, sp.acept_nota
          FROM sabados_personal sp
          JOIN sabados_laborados s ON s.id = sp.sabado_id
          WHERE s.fecha_sabado BETWEEN ${desde} AND ${hasta}
          ORDER BY s.fecha_sabado DESC, sp.nombre`;
      } else if (rol === 'gerente') {
        sabados = await sql`
          SELECT s.id, s.fecha_sabado, s.jefe_nombre, s.causa_cat, s.causa_p3, s.auth_gerente,
                 sp.num_emp, sp.nombre, sp.puesto, sp.ubicacion, sp.horas,
                 sp.acept, sp.acept_ts, sp.acept_hash, sp.acept_nota
          FROM sabados_personal sp
          JOIN sabados_laborados s ON s.id = sp.sabado_id
          LEFT JOIN usuarios u ON u.num_emp = sp.num_emp
          WHERE s.fecha_sabado BETWEEN ${desde} AND ${hasta}
            AND (u.gerente_num = ${numEmp} OR s.gerente_num = ${numEmp} OR s.jefe_num = ${numEmp})
          ORDER BY s.fecha_sabado DESC, sp.nombre`;
      } else {
        sabados = await sql`
          SELECT s.id, s.fecha_sabado, s.jefe_nombre, s.causa_cat, s.causa_p3, s.auth_gerente,
                 sp.num_emp, sp.nombre, sp.puesto, sp.ubicacion, sp.horas,
                 sp.acept, sp.acept_ts, sp.acept_hash, sp.acept_nota
          FROM sabados_personal sp
          JOIN sabados_laborados s ON s.id = sp.sabado_id
          LEFT JOIN usuarios u ON u.num_emp = sp.num_emp
          WHERE s.fecha_sabado BETWEEN ${desde} AND ${hasta}
            AND (u.jefe_num = ${numEmp} OR s.jefe_num = ${numEmp})
          ORDER BY s.fecha_sabado DESC, sp.nombre`;
      }
      if (ubicacion) sabados = sabados.filter(s => s.ubicacion === ubicacion);
    } catch (e) {
      console.warn('[GPA] No se pudieron leer los sábados para el reporte:', e.message);
    }

    const totalSab = r1(sabados
      .filter(s => s.auth_gerente === 'autorizado' && s.acept !== 'rechazado')
      .reduce((a, s) => a + Number(s.horas || 0), 0));

    const aoaSab = [
      ['SÁBADOS LABORADOS'],
      [`Periodo: ${desde} al ${hasta}`],
      ['Estas horas cuentan para el límite de 9 h semanales (Art. 66 LFT) junto con las de entre semana.'],
      [],
      ['Folio', 'Fecha del sábado', 'N° Empleado', 'Nombre', 'Puesto', 'Sucursal', 'Horas',
       'Solicitado por', 'Categoría', 'Causa raíz', 'Autorización de gerencia',
       'Respuesta del trabajador', 'Fecha de la firma', 'Sello de integridad', 'Comentario'],
      ...sabados.map(s => [
        s.id, aISO(s.fecha_sabado), s.num_emp, s.nombre || '',
        s.puesto || '', s.ubicacion || '', Number(s.horas || 0), s.jefe_nombre || '',
        s.causa_cat || '', s.causa_p3 || '', s.auth_gerente || '',
        ETIQ_ACEPT[s.acept] || s.acept || '', fechaHora(s.acept_ts),
        s.acept_hash || '', s.acept_nota || ''
      ]),
      [],
      ['', '', '', '', '', 'TOTAL DE HORAS DE SÁBADO VIGENTES:', totalSab]
    ];
    const hSab = XLSX.utils.aoa_to_sheet(aoaSab);
    hSab['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 34 }, { wch: 26 }, { wch: 24 },
      { wch: 8 }, { wch: 30 }, { wch: 28 }, { wch: 34 }, { wch: 22 }, { wch: 26 }, { wch: 21 },
      { wch: 66 }, { wch: 30 }];
    hSab['!freeze'] = { xSplit: 0, ySplit: 5 };

    /* ── LIBRO ────────────────────────────────────────────────── */
    const wb = XLSX.utils.book_new();
    wb.Props = {
      Title: 'Reporte de Horas Extras GPA',
      Subject: `Periodo ${desde} a ${hasta}`,
      Author: 'Sistema GPA Horas Extras',
      Company: 'Grupo GPA Aqua',
      CreatedDate: new Date()
    };
    XLSX.utils.book_append_sheet(wb, hDetalle, 'Detalle');
    XLSX.utils.book_append_sheet(wb, hEmp, 'Resumen por empleado');
    XLSX.utils.book_append_sheet(wb, hCausa, 'Resumen por causa');
    XLSX.utils.book_append_sheet(wb, hFirmas, 'Consentimientos');
    XLSX.utils.book_append_sheet(wb, hSab, 'Sábados laborados');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
    const nombre = `GPA_Horas_Extras_${desde}_a_${hasta}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.setHeader('Content-Length', String(buf.length));
    return res.status(200).send(buf);

  } catch (err) {
    return fail(res, 500, 'Error al generar el reporte de Excel', err);
  }
}

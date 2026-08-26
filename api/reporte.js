import * as XLSX from 'xlsx';
import { getDb, preflight, fail, esFechaISO, fechaMX, semanaMX, MAX_SEMANA } from '../lib/db.js';
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

const ESTADOS = ['pendiente', 'autorizado', 'rechazado'];
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
      'Estado LFT', 'Autoriz. Jefe', 'N° Jefe', 'Autoriz. Gerente', 'N° Gerente', 'Estado final'];

    const detalle = filas.map(f => ([
      f.id,
      String(f.fecha || '').slice(0, 10),
      String(f.hora_registro || '').slice(0, 8),
      f.num_emp, f.nombre || '', f.puesto || '', f.depto || '', f.ubicacion || '',
      Number(f.horas_dia || 0), Number(f.horas_semana || 0), semaforo(f.horas_semana || f.horas_dia),
      f.causa_grupo === 'adm' ? 'Administrativa' : 'Operativa',
      f.causa_cat || '', f.causa_p1 || '', f.causa_p2 || '', f.causa_p3 || '',
      f.estado_lft || '', f.auth_jefe || '', f.auth_jefe_num || '',
      f.auth_gerente || '', f.auth_gerente_num || '', f.estado_final || 'pendiente'
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
      { wch: 26 }, { wch: 34 }, { wch: 32 }, { wch: 11 }, { wch: 13 }, { wch: 10 }, { wch: 15 },
      { wch: 11 }, { wch: 13 }];
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

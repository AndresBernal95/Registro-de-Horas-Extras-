import PDFDocument from 'pdfkit';
import { semanaMX, aISO, MAX_SEMANA } from './db.js';
import { LEYENDA_PDF } from './firma.js';
import { LOGO_BUFFER } from './logo.js';

/* ══════════════════════════════════════════════════════════════════
   GRL-RH-FO-2 Rev. 3 — MAQUETA DEL FORMATO IMPRESO
   HISTORIAL Y AUTORIZACIÓN DE TIEMPO EXTRAORDINARIO

   Aquí sólo se DIBUJA. Los datos llegan ya resueltos desde
   api/reporte-pdf.js, que es quien valida permisos y consulta la
   base. Separarlo permite revisar la maqueta sin base de datos:

       node test/pdf-preview.mjs

   Un formato por trabajador, cada uno en hoja nueva, para poder
   desprenderlo, firmarlo y archivarlo en su expediente.
   ══════════════════════════════════════════════════════════════════ */

export const DOC_CODIGO   = 'GRL-RH-FO-2';
export const DOC_REVISION = 'Rev. 3';
const EMPRESA    = 'GENERAL DE PRODUCTOS PARA EL AGUA, S.A. DE C.V.';
const DOC_TITULO = 'HISTORIAL Y AUTORIZACIÓN DE TIEMPO EXTRAORDINARIO';

/* Geometría de la página (carta, en puntos) */
const M = { top: 108, bottom: 62, left: 40, right: 40 };
const ANCHO = 612 - M.left - M.right;          // 532
const COLS  = [58, 34, 74, 56, 34, 152, 124];  // suma exacta = ANCHO
const ENC   = ['Fecha', 'Día', 'Folio', 'Tipo', 'Horas', 'Motivo (categoría · causa raíz)', 'Estado'];

const GRIS  = '#6b7280';
const TINTA = '#111827';
const AZUL  = '#1e40af';
const LINEA = '#d1d5db';
const ROJO  = '#b91c1c';

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
  'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const r1 = n => Math.round(Number(n || 0) * 10) / 10;
const iso = aISO;
const dmy = v => { const s = iso(v); return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : ''; };
const diaDe = v => { const s = iso(v); if (!s) return ''; const d = new Date(s + 'T12:00:00Z'); return DIAS[d.getUTCDay()]; };
const mesDe = v => { const s = iso(v); return s ? `${MESES[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}` : ''; };

function selloFecha(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const f = new Intl.DateTimeFormat('es-MX', {
      timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(d);
    return f.replace(',', '') + ' h';
  } catch { return String(ts).slice(0, 16).replace('T', ' '); }
}

const ETIQUETA = {
  autorizado: 'Autorizada',
  pendiente: 'Pendiente',
  rechazado: 'Rechazada',
  vencido: 'Vencida sin respuesta',
  cancelado: 'Cancelada'
};

/**
 * Arma el documento completo.
 *
 * @param {object} d
 *   personas   [{num_emp, nombre, puesto, depto, ubicacion, jefe_nombre, jefe_puesto}]
 *   movimientos Map o objeto: num_emp → [{fecha, id, tipo, horas_dia, causa_cat,
 *               causa_p3, solicitante_nombre, auth_gerente, auth_gerente_num,
 *               acept_emp, acept_emp_ts, acept_emp_hash, estado_final}]
 *   desde, hasta  AAAA-MM-DD
 *   agrupar    'dia' | 'semana' | 'mes'
 *   todas      true = incluye no aceptadas → sale marcado BORRADOR
 *   folio, generadoPor, generadoEl
 * @returns {Promise<Buffer>}
 */
export function construirFormatoPDF(d) {
  const movs = d.movimientos instanceof Map
    ? d.movimientos
    : new Map(Object.entries(d.movimientos || {}));

  const doc = new PDFDocument({
    size: 'LETTER', margins: M, bufferPages: true, autoFirstPage: false,
    info: {
      Title: `${DOC_CODIGO} ${DOC_REVISION} — Historial de tiempo extraordinario`,
      Author: 'Sistema de Registro de Horas Extras — GPA',
      Subject: `Periodo ${d.desde} al ${d.hasta}`,
      Keywords: `${DOC_CODIGO}, ${d.folio}, horas extra, LFT`
    }
  });

  const trozos = [];
  doc.on('data', c => trozos.push(c));
  const listo = new Promise(resolve => doc.on('end', () => resolve(Buffer.concat(trozos))));

  /* El logo se abre UNA vez y se reutiliza en cada hoja. Si se pasara
     el Buffer directo a doc.image(), pdfkit no lo reconoce como el
     mismo recurso y lo vuelve a incrustar en cada página: un reporte
     de 40 hojas pesaba 1.7 MB por puro logo repetido. */
  try { doc._logoGpa = doc.openImage(LOGO_BUFFER); } catch { doc._logoGpa = null; }

  doc.on('pageAdded', () => encabezado(doc));

  /* Cada trabajador arranca en hoja nueva. */
  d.personas.forEach(p => {
    doc.addPage();
    formatoDeUnaPersona(doc, {
      persona: p,
      movimientos: movs.get(String(p.num_emp)) || [],
      desde: d.desde, hasta: d.hasta, agrupar: d.agrupar, todas: d.todas
    });
  });

  /* El foliado se escribe al final, cuando ya se sabe cuántas hojas salieron. */
  const rango = doc.bufferedPageRange();
  for (let i = 0; i < rango.count; i++) {
    doc.switchToPage(rango.start + i);
    if (d.todas) marcaBorrador(doc);
    pie(doc, {
      pagina: i + 1, total: rango.count, folio: d.folio,
      quien: d.generadoPor, generado: d.generadoEl
    });
  }

  doc.end();
  return listo;
}

/* ══════════════════════════════════════════════════════════════════
   ENCABEZADO CONTROLADO — se repite en todas las hojas
   ══════════════════════════════════════════════════════════════════ */
function encabezado(doc) {
  const y = 32;
  doc.save();

  /* Recuadro del encabezado */
  const ALTO = 62;
  doc.lineWidth(0.8).strokeColor(LINEA)
    .rect(M.left, y, ANCHO, ALTO).stroke();
  doc.moveTo(M.left + 92, y).lineTo(M.left + 92, y + ALTO).stroke();
  doc.moveTo(M.left + ANCHO - 132, y).lineTo(M.left + ANCHO - 132, y + ALTO).stroke();

  /* Logo */
  try {
    if (doc._logoGpa) doc.image(doc._logoGpa, M.left + 8, y + 12, { fit: [76, 34], align: 'center' });
  } catch { /* si el logo fallara, el formato sigue siendo válido */ }

  /* Identificación */
  const xc = M.left + 100, wc = ANCHO - 132 - 100 - 8;
  doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(8)
    .text(EMPRESA, xc, y + 8, { width: wc, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(AZUL)
    .text(DOC_TITULO, xc, y + 20, { width: wc, align: 'center' });
  doc.font('Helvetica').fontSize(6.8).fillColor(GRIS)
    .text('Formato de control interno — Recursos Humanos', xc, y + 47, { width: wc, align: 'center' });

  /* Control documental */
  const xd = M.left + ANCHO - 126;
  doc.fontSize(7.5).fillColor(TINTA).font('Helvetica-Bold')
    .text(`Código: ${DOC_CODIGO}`, xd, y + 11, { width: 120, lineBreak: false });
  doc.font('Helvetica')
    .text(DOC_REVISION, xd, y + 24, { width: 120, lineBreak: false })
    .text('Hoja: ___ de ___', xd, y + 37, { width: 120, lineBreak: false });  // el pie lo sobrescribe

  doc.restore();
  doc.x = M.left;
  doc.y = M.top;
}

/* ══════════════════════════════════════════════════════════════════
   PIE — foliado, trazabilidad y confidencialidad
   ══════════════════════════════════════════════════════════════════ */
function pie(doc, d) {
  const y = 792 - 52;
  /* El pie se dibuja por DEBAJO del margen inferior. Sin desactivar el
     margen, pdfkit cree que el texto no cabe y agrega una hoja nueva por
     cada pie: el documento salía con el triple de páginas, la mitad en
     blanco. */
  const margenAbajo = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.save();

  /* Tapa el marcador "Hoja: ___ de ___" del encabezado */
  doc.rect(M.left + ANCHO - 130, 32 + 33, 128, 14).fillColor('#ffffff').fill();
  doc.fillColor(TINTA).font('Helvetica').fontSize(7.5)
    .text(`Hoja: ${d.pagina} de ${d.total}`, M.left + ANCHO - 126, 32 + 37, { width: 120, lineBreak: false });

  doc.lineWidth(0.6).strokeColor(LINEA)
    .moveTo(M.left, y).lineTo(M.left + ANCHO, y).stroke();
  doc.font('Helvetica').fontSize(6.4).fillColor(GRIS)
    .text(
      `Sistema de Registro de Horas Extras · Folio de emisión ${d.folio} · ` +
      `Generado por ${d.quien} el ${d.generado} · Página ${d.pagina} de ${d.total}`,
      M.left, y + 7, { width: ANCHO, align: 'center' })
    .text(
      'Documento de uso interno y confidencial. Contiene datos personales del trabajador.',
      M.left, y + 17, { width: ANCHO, align: 'center' });
  doc.restore();
  doc.page.margins.bottom = margenAbajo;
}

function marcaBorrador(doc) {
  const margenAbajo = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.save();
  doc.rotate(-30, { origin: [306, 396] });
  doc.font('Helvetica-Bold').fontSize(36).fillColor(ROJO).opacity(0.11)
    .text('BORRADOR — SIN VALIDEZ', 0, 378, { width: 612, align: 'center', lineBreak: false });
  doc.opacity(1).restore();
  doc.page.margins.bottom = margenAbajo;
}

/* ══════════════════════════════════════════════════════════════════
   EL FORMATO DE UNA PERSONA
   ══════════════════════════════════════════════════════════════════ */
function formatoDeUnaPersona(doc, ctx) {
  const { persona: p, movimientos: movs, desde, hasta, agrupar, todas } = ctx;

  bloqueTrabajador(doc, p);
  bloquePeriodo(doc, { desde, hasta, agrupar, todas, movs });
  tablaDetalle(doc, movs, agrupar);
  bloqueResumen(doc, movs);
  bloqueConstancia(doc, movs, todas);
  bloqueFirmas(doc, p);
}

/* ── Datos del trabajador ────────────────────────────────────────── */
function bloqueTrabajador(doc, p) {
  tituloSeccion(doc, '1. DATOS DEL TRABAJADOR');
  const y0 = doc.y;
  const alto = 54;
  doc.lineWidth(0.7).strokeColor(LINEA).rect(M.left, y0, ANCHO, alto).stroke();

  const campo = (etq, val, x, y, w) => {
    doc.font('Helvetica').fontSize(6.8).fillColor(GRIS).text(etq.toUpperCase(), x, y, { width: w });
    doc.font('Helvetica-Bold').fontSize(8.6).fillColor(TINTA)
      .text(val || '—', x, y + 8, { width: w, ellipsis: true, lineBreak: false });
  };

  campo('Nombre del trabajador', p.nombre, M.left + 8, y0 + 7, 300);
  campo('N° de empleado', p.num_emp, M.left + 318, y0 + 7, 90);
  campo('Departamento', p.depto, M.left + 414, y0 + 7, 110);
  campo('Puesto', p.puesto, M.left + 8, y0 + 30, 210);
  campo('Sucursal / Centro de trabajo', p.ubicacion, M.left + 224, y0 + 30, 160);
  campo('Jefe inmediato', p.jefe_nombre, M.left + 390, y0 + 30, 134);

  doc.y = y0 + alto + 10;
}

/* ── Periodo y criterios ─────────────────────────────────────────── */
function bloquePeriodo(doc, d) {
  tituloSeccion(doc, '2. PERIODO Y CRITERIOS DEL REPORTE');
  const etqAgr = { dia: 'por día', semana: 'por semana', mes: 'por mes' }[d.agrupar];
  const y0 = doc.y;

  doc.font('Helvetica').fontSize(8).fillColor(TINTA)
    .text(`Periodo reportado: del ${dmy(d.desde)} al ${dmy(d.hasta)}   ·   Agrupación: ${etqAgr}   ·   ` +
      `Movimientos incluidos: ${d.movs.length}`, M.left, y0, { width: ANCHO });

  doc.font('Helvetica').fontSize(7.6).fillColor(d.todas ? ROJO : GRIS)
    .text(d.todas
      ? 'Criterio: SE INCLUYEN solicitudes pendientes, rechazadas y vencidas. Este ejemplar es informativo ' +
        'y NO debe firmarse: contiene horas que el trabajador no aceptó.'
      : 'Criterio: se incluyen únicamente las horas extraordinarias autorizadas y aceptadas por el trabajador.',
      M.left, doc.y + 2, { width: ANCHO });

  doc.y += 8;
}

/* ── Detalle ─────────────────────────────────────────────────────── */
function tablaDetalle(doc, movs, agrupar) {
  tituloSeccion(doc, '3. DETALLE DE TIEMPO EXTRAORDINARIO');
  cabeceraTabla(doc);

  const grupos = agruparMovs(movs, agrupar);

  grupos.forEach(g => {
    if (g.titulo) {
      espacio(doc, 32);                     // que el título no quede solo al pie
      const y0 = doc.y;
      doc.save().rect(M.left, y0, ANCHO, 14).fillColor('#eef2ff').fill().restore();
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(AZUL)
        .text(g.titulo, M.left + 6, y0 + 3.6, { width: ANCHO - 120, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7.8).fillColor(AZUL)
        .text(`Subtotal: ${r1(g.total)} h`, M.left + ANCHO - 110, y0 + 3.6, { width: 104, align: 'right', lineBreak: false });
      doc.y = y0 + 17;
    }
    g.filas.forEach(m => filaDetalle(doc, m));
  });

  /* Total general */
  const total = r1(movs.reduce((a, m) => a + Number(m.horas_dia || 0), 0));
  espacio(doc, 20);
  const yT = doc.y + 2;
  doc.save().rect(M.left, yT, ANCHO, 15).fillColor('#e5e7eb').fill().restore();
  doc.font('Helvetica-Bold').fontSize(8.4).fillColor(TINTA)
    .text('TOTAL DE HORAS EXTRAORDINARIAS DEL PERIODO', M.left + 6, yT + 4, { width: 380, lineBreak: false })
    .text(`${total} h`, M.left + ANCHO - 130, yT + 4, { width: 124, align: 'right', lineBreak: false });
  doc.y = yT + 18;
}

function cabeceraTabla(doc) {
  espacio(doc, 30);
  const y0 = doc.y;
  doc.save().rect(M.left, y0, ANCHO, 15).fillColor('#1e3a8a').fill().restore();
  let x = M.left;
  ENC.forEach((t, i) => {
    doc.font('Helvetica-Bold').fontSize(7.2).fillColor('#ffffff')
      .text(t, x + 4, y0 + 4.4, { width: COLS[i] - 8, align: i === 4 ? 'right' : 'left', lineBreak: false });
    x += COLS[i];
  });
  doc.y = y0 + 16;
}

function filaDetalle(doc, m) {
  const motivo = [m.causa_cat, m.causa_p3].filter(Boolean).join(' · ') || (m.causa_texto || '—');
  const estado = ETIQUETA[m.estado_final] || m.estado_final || '';
  const acept = m.acept_emp === 'aceptado' ? 'Aceptada por el trabajador'
    : m.acept_emp === 'rechazado' ? 'Rechazada por el trabajador'
      : m.acept_emp === 'pendiente' ? 'Esperando respuesta del trabajador'
        : m.acept_emp === 'vencido' ? 'Sin respuesta del trabajador'
          : 'Registro anterior a la firma electrónica';

  const celdas = [
    dmy(m.fecha), diaDe(m.fecha).slice(0, 3), String(m.id || ''), m.tipo,
    String(r1(m.horas_dia)), motivo, estado
  ];

  /* Alto de la fila: la celda más alta manda */
  doc.font('Helvetica').fontSize(7.4);
  let alto = 0;
  celdas.forEach((c, i) => {
    alto = Math.max(alto, doc.heightOfString(String(c), { width: COLS[i] - 8 }));
  });
  alto = Math.max(alto, 9);

  /* Sub-línea de trazabilidad */
  const traza = [
    m.solicitante_nombre ? `Solicitó: ${m.solicitante_nombre}` : (m.origen === 'auto' ? 'Registro capturado por el propio trabajador (versión anterior)' : ''),
    m.auth_gerente === 'autorizado' && m.auth_gerente_num ? `Autorización de gerencia: ${m.auth_gerente_num}` : '',
    acept + (m.acept_emp_ts ? ` el ${selloFecha(m.acept_emp_ts)}` : ''),
    m.acept_emp_hash ? `Sello ${String(m.acept_emp_hash).slice(0, 16)}…` : '',
    m.acept_emp_nota ? `Nota: ${m.acept_emp_nota}` : ''
  ].filter(Boolean).join('   ·   ');

  doc.font('Helvetica').fontSize(6.4);
  const altoTraza = traza ? doc.heightOfString(traza, { width: ANCHO - 66 }) : 0;
  const altoTotal = alto + 5 + altoTraza + 4;

  espacio(doc, altoTotal + 2);
  const y0 = doc.y;

  doc.font('Helvetica').fontSize(7.4).fillColor(TINTA);
  let x = M.left;
  celdas.forEach((c, i) => {
    doc.fillColor(i === 6 && /Rechaz|Vencid|Cancel/.test(String(c)) ? ROJO : TINTA)
      .text(String(c), x + 4, y0 + 2, { width: COLS[i] - 8, align: i === 4 ? 'right' : 'left' });
    x += COLS[i];
  });

  if (traza) {
    doc.font('Helvetica').fontSize(6.4).fillColor(GRIS)
      .text(traza, M.left + 62, y0 + alto + 4, { width: ANCHO - 66 });
  }

  const yFin = y0 + altoTotal;
  doc.lineWidth(0.4).strokeColor('#e5e7eb')
    .moveTo(M.left, yFin).lineTo(M.left + ANCHO, yFin).stroke();
  doc.y = yFin + 2;
}

/* ── Resumen ─────────────────────────────────────────────────────── */
function bloqueResumen(doc, movs) {
  espacio(doc, 120);
  tituloSeccion(doc, '4. RESUMEN DEL PERIODO');

  const vigentes = movs.filter(m => m.estado_final === 'autorizado');
  const totalV = r1(vigentes.reduce((a, m) => a + Number(m.horas_dia || 0), 0));
  const entreSemana = r1(vigentes.filter(m => m.tipo === 'Entre semana').reduce((a, m) => a + Number(m.horas_dia || 0), 0));
  const enSabado = r1(vigentes.filter(m => m.tipo === 'Sábado').reduce((a, m) => a + Number(m.horas_dia || 0), 0));

  const y0 = doc.y;
  doc.lineWidth(0.7).strokeColor(LINEA).rect(M.left, y0, ANCHO, 34).stroke();
  const cuadro = (etq, val, x, w) => {
    doc.font('Helvetica').fontSize(6.8).fillColor(GRIS).text(etq.toUpperCase(), x, y0 + 6, { width: w });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA).text(val, x, y0 + 16, { width: w });
  };
  cuadro('Horas autorizadas y aceptadas', `${totalV} h`, M.left + 8, 160);
  cuadro('Horas entre semana', `${entreSemana} h`, M.left + 176, 120);
  cuadro('Horas en sábado', `${enSabado} h`, M.left + 304, 110);
  cuadro('Movimientos', String(vigentes.length), M.left + 424, 100);
  doc.y = y0 + 42;

  /* Desglose semanal — el límite del art. 66 se mide por semana */
  const semanas = new Map();
  vigentes.forEach(m => {
    const { ini, fin } = semanaMX(iso(m.fecha));
    const k = ini;
    if (!semanas.has(k)) semanas.set(k, { ini, fin, semana: 0, sabado: 0 });
    const s = semanas.get(k);
    if (m.tipo === 'Sábado') s.sabado += Number(m.horas_dia || 0);
    else s.semana += Number(m.horas_dia || 0);
  });
  const lista = [...semanas.values()].sort((a, b) => a.ini < b.ini ? -1 : 1);

  if (lista.length) {
    espacio(doc, 30 + lista.length * 12);
    doc.font('Helvetica-Bold').fontSize(7.6).fillColor(TINTA)
      .text('Desglose por semana (lunes a domingo)', M.left, doc.y);
    doc.y += 3;

    /* OJO: doc.text() mueve doc.y. Si el alto de la celda se leyera de
       doc.y dentro del bucle, cada columna se dibujaría más abajo que
       la anterior y la tabla saldría escalonada. Por eso la fila se
       ancla en yFila, que no cambia. */
    const c = [176, 104, 96, 76, 80];
    const xCol = i => M.left + c.slice(0, i).reduce((a, b) => a + b, 0);

    let yFila = doc.y;
    doc.save().rect(M.left, yFila, ANCHO, 13).fillColor('#f3f4f6').fill().restore();
    ['Semana', 'Entre semana', 'Sábado', 'Total', 'Observación'].forEach((t, i) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(TINTA)
        .text(t, xCol(i) + 4, yFila + 3.4,
          { width: c[i] - 8, align: i > 0 && i < 4 ? 'right' : 'left', lineBreak: false });
    });
    doc.y = yFila + 13;

    lista.forEach(s => {
      const tot = r1(s.semana + s.sabado);
      const excede = tot > MAX_SEMANA;
      const vals = [
        `Del ${dmy(s.ini)} al ${dmy(s.fin)}`,
        `${r1(s.semana)} h`, `${r1(s.sabado)} h`, `${tot} h`,
        excede ? 'Rebasa 9 h semanales' : ''
      ];
      espacio(doc, 14);
      yFila = doc.y;
      vals.forEach((v, i) => {
        doc.font(i === 3 ? 'Helvetica-Bold' : 'Helvetica').fontSize(7)
          .fillColor(excede && (i === 3 || i === 4) ? ROJO : TINTA)
          .text(v, xCol(i) + 4, yFila + 2.6,
            { width: c[i] - 8, align: i > 0 && i < 4 ? 'right' : 'left', lineBreak: false });
      });
      doc.lineWidth(0.35).strokeColor('#e5e7eb')
        .moveTo(M.left, yFila + 13).lineTo(M.left + ANCHO, yFila + 13).stroke();
      doc.y = yFila + 13;
    });

    doc.font('Helvetica').fontSize(6.6).fillColor(GRIS)
      .text('El artículo 66 de la Ley Federal del Trabajo limita la jornada extraordinaria a tres horas ' +
        'diarias y a tres veces por semana. Las semanas marcadas rebasan ese límite y requirieron ' +
        'autorización especial de gerencia.', M.left, doc.y + 3, { width: ANCHO });
    doc.y += 4;
  }
}

/* ── Constancia de firma electrónica ─────────────────────────────── */
function bloqueConstancia(doc, movs, todas) {
  espacio(doc, 82);
  tituloSeccion(doc, '5. CONSTANCIA DE CONSENTIMIENTO ELECTRÓNICO');

  const firmadas = movs.filter(m => m.acept_emp === 'aceptado').length;
  const y0 = doc.y;
  doc.lineWidth(0.7).strokeColor(LINEA).rect(M.left, y0, ANCHO, 62).stroke();

  doc.font('Helvetica').fontSize(7.4).fillColor(TINTA)
    .text(LEYENDA_PDF, M.left + 8, y0 + 7, { width: ANCHO - 16, align: 'justify' });

  doc.font('Helvetica-Bold').fontSize(7.4).fillColor(TINTA)
    .text(`Movimientos con consentimiento electrónico registrado en este periodo: ${firmadas} de ${movs.length}.` +
      (todas ? '  Los movimientos sin consentimiento aparecen marcados en el detalle.' : ''),
      M.left + 8, y0 + 48, { width: ANCHO - 16 });

  doc.y = y0 + 70;
}

/* ── Firmas autógrafas ───────────────────────────────────────────── */
function bloqueFirmas(doc, p) {
  espacio(doc, 130);
  tituloSeccion(doc, '6. FIRMAS DE CONFORMIDAD');

  doc.font('Helvetica').fontSize(7.4).fillColor(TINTA)
    .text('Quienes suscriben hacen constar que el historial de tiempo extraordinario descrito en este ' +
      'formato corresponde a las horas efectivamente solicitadas, autorizadas y aceptadas en el periodo ' +
      'reportado, y que su registro se realizó conforme a la Ley Federal del Trabajo.',
      M.left, doc.y, { width: ANCHO, align: 'justify' });

  const y0 = doc.y + 12;
  const ancho = (ANCHO - 32) / 3;
  const firma = (x, titulo, nombre, puesto) => {
    doc.lineWidth(0.8).strokeColor(TINTA)
      .moveTo(x, y0 + 44).lineTo(x + ancho, y0 + 44).stroke();
    doc.font('Helvetica-Bold').fontSize(7.6).fillColor(TINTA)
      .text(nombre || '', x, y0 + 48, { width: ancho, align: 'center', ellipsis: true, lineBreak: false });
    doc.font('Helvetica').fontSize(6.8).fillColor(GRIS)
      .text(puesto || '', x, y0 + 58, { width: ancho, align: 'center', ellipsis: true, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor(TINTA)
      .text(titulo, x, y0 + 70, { width: ancho, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(6.6).fillColor(GRIS)
      .text('Nombre y firma', x, y0 + 80, { width: ancho, align: 'center', lineBreak: false })
      .fontSize(6.6)
      .text('Fecha: ______ / ______ / __________', x, y0 + 92, { width: ancho, align: 'center', lineBreak: false });
  };

  firma(M.left, 'EL TRABAJADOR', p.nombre, `N° de empleado ${p.num_emp}`);
  firma(M.left + ancho + 16, 'JEFE INMEDIATO', p.jefe_nombre, p.jefe_puesto || '');
  firma(M.left + (ancho + 16) * 2, 'RECURSOS HUMANOS', '', 'Capital Humano');

  doc.y = y0 + 104;
}

/* ══════════════════════════════════════════════════════════════════
   AUXILIARES DE MAQUETACIÓN
   ══════════════════════════════════════════════════════════════════ */
function tituloSeccion(doc, texto) {
  espacio(doc, 30);
  doc.y += 6;                         // aire entre secciones
  doc.font('Helvetica-Bold').fontSize(8.6).fillColor(AZUL)
    .text(texto, M.left, doc.y, { width: ANCHO });
  doc.lineWidth(0.9).strokeColor(AZUL)
    .moveTo(M.left, doc.y + 1).lineTo(M.left + ANCHO, doc.y + 1).stroke();
  doc.y += 6;
}

/** Salta de hoja si lo que sigue no cabe. */
function espacio(doc, alto) {
  if (doc.y + alto > 792 - M.bottom) { if(process.env.DBG) console.log('  salto: y='+doc.y.toFixed(0)+' pide='+alto); doc.addPage(); }
}

function agruparMovs(movs, modo) {
  if (modo === 'dia') return [{ titulo: null, filas: movs, total: 0 }];
  const clave = m => modo === 'mes' ? mesDe(m.fecha)
    : (() => { const { ini, fin } = semanaMX(iso(m.fecha)); return `Semana del ${dmy(ini)} al ${dmy(fin)}`; })();

  const mapa = new Map();
  movs.forEach(m => {
    const k = clave(m);
    if (!mapa.has(k)) mapa.set(k, { titulo: k, filas: [], total: 0 });
    const g = mapa.get(k);
    g.filas.push(m);
    g.total += Number(m.horas_dia || 0);
  });
  return [...mapa.values()];
}

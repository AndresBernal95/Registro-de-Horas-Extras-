import { createHash } from 'node:crypto';

/* ══════════════════════════════════════════════════════════════════
   FIRMA ELECTRÓNICA DEL TRABAJADOR (v3)

   El "Acepto" del trabajador es el consentimiento para laborar la
   jornada extraordinaria que su jefe le solicitó. Para que sirva como
   evidencia no basta con guardar un 'sí': hay que poder demostrar
   DESPUÉS qué texto exacto se le mostró, cuándo, desde dónde, y que
   el renglón no se alteró luego.

   Por eso se guarda, junto con la decisión:
     · el texto íntegro de la leyenda que vio en pantalla
     · la versión de esa leyenda (si algún día cambia la redacción,
       cada firma conserva la que estuvo vigente)
     · el sello de fecha y hora
     · la IP y el navegador desde donde firmó
     · un hash SHA-256 de todo lo anterior

   El hash es el sello de integridad: se recalcula con los mismos
   datos y, si no coincide, alguien tocó el registro en la base.

   NOTA LEGAL: la redacción de la leyenda debe validarla Capital
   Humano con el área jurídica. Lo que el sistema garantiza es la
   evidencia técnica; la suficiencia legal la dictamina jurídico.
   ══════════════════════════════════════════════════════════════════ */

export const LEYENDA_VERSION = 'LFT-2026.1';

const fmtFecha = iso => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso || '');
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${Number(m[3])} de ${meses[Number(m[2]) - 1]} de ${m[1]}`;
};

/**
 * Texto que se le muestra al trabajador y que queda guardado tal cual.
 * @param {object} d { tipo:'hora_extra'|'sabado', nombre, num_emp, horas,
 *                     fecha, solicitante, causa }
 */
export function leyendaConsentimiento(d) {
  const esSabado = d.tipo === 'sabado';
  const jornada = esSabado
    ? `laborar el sábado ${fmtFecha(d.fecha)} una jornada extraordinaria de ${d.horas} horas`
    : `laborar ${d.horas} horas extraordinarias el ${fmtFecha(d.fecha)}`;

  return [
    'CONSENTIMIENTO PARA LABORAR TIEMPO EXTRAORDINARIO',
    '',
    `${d.solicitante || 'Mi jefe inmediato'} ha solicitado que yo, ${d.nombre || ''} ` +
    `(número de empleado ${d.num_emp}), acepte ${jornada}.`,
    d.causa ? `Motivo de la solicitud: ${d.causa}.` : '',
    '',
    'Al presionar ACEPTO manifiesto, de manera libre y sin coacción, mi conformidad ' +
    'para laborar esa jornada extraordinaria en términos de los artículos 66, 67 y 68 ' +
    'de la Ley Federal del Trabajo, y reconozco que:',
    '',
    '1. La jornada extraordinaria no puede exceder de tres horas diarias ni de tres ' +
    'veces en una semana (artículo 66 de la Ley Federal del Trabajo).',
    '2. El tiempo extraordinario se me pagará con los recargos que la Ley Federal del ' +
    'Trabajo establece en sus artículos 67 y 68.',
    '3. NO ESTOY OBLIGADO A LABORAR TIEMPO EXTRAORDINARIO. Puedo presionar RECHAZO sin ' +
    'consecuencia laboral alguna (artículo 68 de la Ley Federal del Trabajo).',
    '',
    'Acepto que esta manifestación electrónica, realizada desde mi cuenta personal e ' +
    'intransferible de número de empleado y contraseña, junto con el sello de fecha y ' +
    'hora que registra el sistema, produce los mismos efectos que mi firma autógrafa ' +
    'para todos los efectos legales, en términos de los artículos 776 fracción VIII y ' +
    '836-D de la Ley Federal del Trabajo.'
  ].filter(l => l !== null).join('\n');
}

/** Versión corta para el PDF, donde el espacio es contado. */
export const LEYENDA_PDF =
  'El trabajador manifestó su conformidad de manera electrónica desde su cuenta personal ' +
  'e intransferible, en términos de los artículos 66, 67 y 68 de la Ley Federal del Trabajo, ' +
  'reconociendo que dicha manifestación produce los mismos efectos que su firma autógrafa ' +
  '(artículos 776 fracción VIII y 836-D de la Ley Federal del Trabajo). El sistema conserva, ' +
  'por cada aceptación, el texto íntegro de la leyenda firmada, el sello de fecha y hora, ' +
  'la dirección IP de origen y un sello de integridad SHA-256.';

/* Normalizadores del sello.

   Son la parte delicada de todo esto: el hash se calcula al firmar,
   con los datos tal como los tenía el endpoint (fecha en texto, horas
   como número), y se vuelve a calcular después leyendo el renglón de
   la base, donde la fecha llega como objeto Date y el NUMERIC puede
   llegar como "2.0" en lugar de 2. Si no se normalizan igual en los
   dos momentos, el sello "no verifica" aunque nadie haya tocado nada
   — y un sello que da falsas alarmas no sirve como evidencia. */
const nFecha = v => {
  if (!v) return '';
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};
const nSello = v => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? String(v) : d.toISOString();
};
const nNum = v => String(Number(v));

/**
 * Sello de integridad. Cualquier cambio posterior en las horas, la
 * fecha, la decisión o la leyenda hace que el hash deje de coincidir.
 */
export function sellarFirma({ id, num_emp, horas, fecha, decision, leyenda, ts, ip }) {
  const canonico = [
    String(id), String(num_emp), nNum(horas), nFecha(fecha),
    String(decision), String(LEYENDA_VERSION), String(leyenda),
    nSello(ts), String(ip || '')
  ].join('|');
  return createHash('sha256').update(canonico, 'utf8').digest('hex');
}

/** Recalcula el sello de un renglón ya guardado, para verificarlo. */
export function verificarSello(fila, campos) {
  const c = campos || {};
  const esperado = sellarFirma({
    id: fila[c.id || 'id'],
    num_emp: fila.num_emp,
    horas: fila[c.horas || 'horas_dia'],
    fecha: fila[c.fecha || 'fecha'],
    decision: fila[c.decision || 'acept_emp'],
    leyenda: fila[c.leyenda || 'acept_emp_leyenda'],
    ts: fila[c.ts || 'acept_emp_ts'],
    ip: fila[c.ip || 'acept_emp_ip']
  });
  return esperado === fila[c.hash || 'acept_emp_hash'];
}

/** IP real detrás del proxy de Vercel. */
export function ipDe(req) {
  const xf = req.headers['x-forwarded-for'];
  const primera = Array.isArray(xf) ? xf[0] : String(xf || '').split(',')[0];
  return (primera || req.headers['x-real-ip'] || req.socket?.remoteAddress || '').trim() || null;
}

/** Navegador / dispositivo, recortado para no llenar la base de basura. */
export function uaDe(req) {
  return String(req.headers['user-agent'] || '').slice(0, 250) || null;
}

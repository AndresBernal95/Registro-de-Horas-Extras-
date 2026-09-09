import { neon, neonConfig } from '@neondatabase/serverless';

/* Reutiliza la conexión entre invocaciones "calientes" de la función
   serverless. Sin esto, cada petición abría una conexión nueva a Neon,
   lo que agrega 100-300 ms a CADA llamada (la causa principal de que la
   página se sintiera lenta). */
let _sql = null;

neonConfig.fetchConnectionCache = true;

export function getDb() {
  if (_sql) return _sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL no está definida. Agrégala en Vercel → Settings → Environment Variables.');
  }
  _sql = neon(url);
  return _sql;
}

/* ──────────────────────────────────────────────────────────────────
   Utilidades compartidas por todos los endpoints
   ────────────────────────────────────────────────────────────────── */

/** CORS + preflight. Devuelve true si la petición ya quedó respondida. */
export function preflight(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

/** Respuesta de error uniforme. El frontend siempre recibe JSON, nunca HTML. */
export function fail(res, code, msg, err) {
  if (err) console.error(`[GPA ${code}] ${msg}`, err);
  return res.status(code).json({ ok: false, error: msg });
}

export function done(res, data, code) {
  return res.status(code || 200).json({ ok: true, data });
}

/** El body puede llegar como string según el runtime de Vercel. */
export function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } }
  return b;
}

/* ──────────────────────────────────────────────────────────────────
   FECHAS — zona horaria de México (America/Mexico_City, UTC-6)

   BUG CORREGIDO: el código anterior usaba
   new Date().toISOString().slice(0,10), que devuelve la fecha en UTC.
   A partir de las 18:00 en México, UTC ya está en el día siguiente,
   así que un registro hecho a las 19:00 del lunes se guardaba como
   martes: rompía el candado de "un registro por día" y descuadraba
   el acumulado semanal.
   ────────────────────────────────────────────────────────────────── */
const TZ = 'America/Mexico_City';

export function fechaMX(d) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return f.format(d || new Date());            // YYYY-MM-DD
}

export function horaMX(d) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  return f.format(d || new Date());            // HH:MM:SS
}

/** Lunes y domingo de la semana en curso, en fecha local de México. */
export function semanaMX(baseISO) {
  const hoy = baseISO || fechaMX();
  const [y, m, d] = hoy.split('-').map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d));
  const dow = ref.getUTCDay() || 7;                       // domingo = 7
  const lun = new Date(ref); lun.setUTCDate(ref.getUTCDate() - (dow - 1));
  const dom = new Date(lun); dom.setUTCDate(lun.getUTCDate() + 6);
  const iso = x => x.toISOString().slice(0, 10);
  return { ini: iso(lun), fin: iso(dom) };
}

/** Valida YYYY-MM-DD y evita inyectar basura en las consultas de fechas. */
export function esFechaISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
}

/* ──────────────────────────────────────────────────────────────────
   Una columna DATE puede volver de la base como texto o como objeto
   Date, según el driver. Con String(fecha).slice(0,10) sobre un Date
   sale "Wed Sep 09" en lugar de "2026-09-09": la leyenda que firma el
   trabajador quedaba con una fecha ilegible y el agrupado por semana
   del PDF reventaba. Todo lo que salga de la base pasa por aquí.
   ────────────────────────────────────────────────────────────────── */
export function aISO(v) {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v)) return '';
    /* Una columna DATE se convierte a medianoche LOCAL, así que la
       fecha del calendario son sus componentes locales. Pasarla por la
       zona de México la correría un día hacia atrás. */
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

export const ROLES = ['operario', 'jefe', 'gerente', 'admin'];
export const DECISIONES = ['autorizado', 'rechazado'];
export const RESPUESTAS = ['aceptado', 'rechazado'];   // v3 · respuesta del trabajador
export const MAX_DIA = 3;      // Art. 66 LFT
export const MAX_SEMANA = 9;   // Art. 66 LFT
export const SAB_HORAS = 5;    // jornada estándar del sábado laborado

/* Días hacia atrás que se permite programar una solicitud. La regla es
   consentimiento PREVIO: lo normal es hoy o una fecha futura. Esta
   ventana existe sólo para regularizar lo que ya se trabajó y quedó sin
   capturar; el registro se marca como regularización posterior. */
export const VENTANA_RETRO = 2;

/** Suma de días entre dos fechas ISO (a - b), en días completos. */
export function diasEntre(a, b) {
  const t = s => Date.UTC(...String(s).split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)));
  return Math.round((t(a) - t(b)) / 86400000);
}

/* ──────────────────────────────────────────────────────────────────
   ACUMULADO SEMANAL — el límite de 9 h del art. 66

   Suma, para la semana (lunes a domingo) que contiene la fecha dada:

     · las horas extra del empleado que siguen VIVAS
       (pendiente o autorizado). Lo rechazado, vencido o cancelado no
       cuenta: si contara, un rechazo dejaría bloqueada a la persona.

     · las 5 h de cada sábado laborado que su gerente YA AUTORIZÓ.
       Cuentan desde la autorización del gerente, sin esperar la firma
       del trabajador, para que la ruta de gerencia se dispare ANTES de
       rebasar las 9 h y no después.

   Se calcula SIEMPRE aquí, contra la base. Nunca se cree el acumulado
   que manda el navegador: un cliente desactualizado (o alterado) podía
   saltarse el límite.
   ────────────────────────────────────────────────────────────────── */
export async function acumuladoSemanal(sql, numEmp, fechaISO, excluirId) {
  const { ini, fin } = semanaMX(fechaISO || fechaMX());
  const emp = String(numEmp);
  const excluir = excluirId ? String(excluirId) : '';

  const [he] = await sql`
    SELECT COALESCE(SUM(horas_dia),0)::float8 AS total
    FROM horas_extras
    WHERE num_emp = ${emp}
      AND fecha BETWEEN ${ini} AND ${fin}
      AND estado_final IN ('pendiente','autorizado')
      AND id <> ${excluir}`;

  const [sab] = await sql`
    SELECT COALESCE(SUM(sp.horas),0)::float8 AS total
    FROM sabados_personal sp
    JOIN sabados_laborados s ON s.id = sp.sabado_id
    WHERE sp.num_emp = ${emp}
      AND s.fecha_sabado BETWEEN ${ini} AND ${fin}
      AND s.auth_gerente = 'autorizado'
      AND sp.acept <> 'rechazado'`;

  const total = Number(he?.total || 0) + Number(sab?.total || 0);
  return {
    total: Math.round(total * 10) / 10,
    horas_extras: Math.round(Number(he?.total || 0) * 10) / 10,
    sabados: Math.round(Number(sab?.total || 0) * 10) / 10,
    semana: { ini, fin }
  };
}

/** Acumulado de varias personas de una vez (para pintar el lote del jefe). */
export async function acumuladoSemanalVarios(sql, nums, fechaISO) {
  const lista = [...new Set((nums || []).map(String))];
  if (lista.length === 0) return {};
  const { ini, fin } = semanaMX(fechaISO || fechaMX());

  const he = await sql`
    SELECT num_emp, COALESCE(SUM(horas_dia),0)::float8 AS total
    FROM horas_extras
    WHERE num_emp = ANY(${lista}::text[])
      AND fecha BETWEEN ${ini} AND ${fin}
      AND estado_final IN ('pendiente','autorizado')
    GROUP BY num_emp`;

  const sab = await sql`
    SELECT sp.num_emp, COALESCE(SUM(sp.horas),0)::float8 AS total
    FROM sabados_personal sp
    JOIN sabados_laborados s ON s.id = sp.sabado_id
    WHERE sp.num_emp = ANY(${lista}::text[])
      AND s.fecha_sabado BETWEEN ${ini} AND ${fin}
      AND s.auth_gerente = 'autorizado'
      AND sp.acept <> 'rechazado'
    GROUP BY sp.num_emp`;

  const mapa = {};
  lista.forEach(n => { mapa[n] = 0; });
  he.forEach(r => { mapa[String(r.num_emp)] = (mapa[String(r.num_emp)] || 0) + Number(r.total || 0); });
  sab.forEach(r => { mapa[String(r.num_emp)] = (mapa[String(r.num_emp)] || 0) + Number(r.total || 0); });
  Object.keys(mapa).forEach(k => { mapa[k] = Math.round(mapa[k] * 10) / 10; });
  return mapa;
}

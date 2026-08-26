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

export const ROLES = ['operario', 'jefe', 'gerente', 'admin'];
export const DECISIONES = ['autorizado', 'rechazado'];
export const MAX_DIA = 3;      // Art. 68 LFT
export const MAX_SEMANA = 9;   // Art. 66 LFT

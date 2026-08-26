import { getDb, preflight, fail, readBody } from '../lib/db.js';
import { verificarPassword } from '../lib/auth.js';

/* ══════════════════════════════════════════════════════════════════
   LIMPIEZA DE DATOS DE PRUEBA — sólo administrador

   POST /api/limpiar
   { num_emp, password, confirmacion: 'BORRAR TODO', alcance }

   alcance: 'horas'   → sólo horas extras
            'sabados' → sólo sábados laborados
            'todo'    → horas + sábados + notificaciones  (por defecto)

   Pensado para entregar el sistema limpio después de las pruebas.
   Es una operación destructiva e irreversible, así que pide TRES cosas:
   ser administrador activo, la contraseña del administrador, y escribir
   la frase exacta. Nada de esto se puede saltar desde el navegador
   porque todo se valida aquí.
   ══════════════════════════════════════════════════════════════════ */

const FRASE = 'BORRAR TODO';
const ALCANCES = ['horas', 'sabados', 'todo'];

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido');

  const { num_emp, password, confirmacion, alcance } = readBody(req);
  const quien = num_emp ? String(num_emp).trim() : '';
  const modo = ALCANCES.includes(alcance) ? alcance : 'todo';

  if (!quien || !password) return fail(res, 400, 'Se requiere tu número de empleado y tu contraseña');
  if (String(confirmacion || '').trim().toUpperCase() !== FRASE)
    return fail(res, 400, `Para continuar debes escribir exactamente: ${FRASE}`);

  const sql = getDb();

  try {
    /* 1. Debe ser administrador activo */
    const rows = await sql`
      SELECT num_emp, nombre, rol, password, activo
      FROM usuarios WHERE num_emp = ${quien} LIMIT 1`;
    if (rows.length === 0) return fail(res, 401, 'Usuario o contraseña incorrectos');

    const u = rows[0];
    if (u.activo === false) return fail(res, 403, 'Tu usuario está dado de baja');
    if (u.rol !== 'admin')
      return fail(res, 403, 'Sólo un administrador puede borrar los registros del sistema');

    /* 2. Debe reingresar su contraseña */
    const { valido } = verificarPassword(password, u.password);
    if (!valido) return fail(res, 401, 'Usuario o contraseña incorrectos');

    /* 3. Conteo previo, para poder reportar qué se eliminó */
    const [antes] = await sql`
      SELECT (SELECT COUNT(*) FROM horas_extras)::int      AS horas,
             (SELECT COUNT(*) FROM sabados_laborados)::int  AS sabados,
             (SELECT COUNT(*) FROM notificaciones)::int     AS notificaciones`;

    const borrado = { horas_extras: 0, sabados_laborados: 0, notificaciones: 0 };

    if (modo === 'horas' || modo === 'todo') {
      const r = await sql`DELETE FROM horas_extras RETURNING id`;
      borrado.horas_extras = r.length;
    }
    if (modo === 'sabados' || modo === 'todo') {
      const r = await sql`DELETE FROM sabados_laborados RETURNING id`;
      borrado.sabados_laborados = r.length;
    }
    if (modo === 'todo') {
      const r = await sql`DELETE FROM notificaciones RETURNING id`;
      borrado.notificaciones = r.length;
    } else {
      /* Si sólo se borró una parte, se limpian las notificaciones
         huérfanas para que nadie reciba avisos de folios que ya no existen. */
      await sql`
        DELETE FROM notificaciones
        WHERE referencia IS NOT NULL
          AND referencia NOT IN (SELECT id FROM horas_extras)
          AND referencia NOT IN (SELECT id FROM sabados_laborados)`;
    }

    /* El catálogo de personal NUNCA se toca aquí. */
    const [usuarios] = await sql`SELECT COUNT(*)::int AS total FROM usuarios`;

    console.warn(`[GPA] LIMPIEZA (${modo}) ejecutada por ${quien} — ${u.nombre}:`, borrado);

    return res.status(200).json({
      ok: true,
      data: {
        alcance: modo,
        ejecutado_por: `${quien} — ${u.nombre}`,
        antes,
        borrado,
        usuarios_conservados: usuarios.total,
        mensaje: 'Registros eliminados. El catálogo de personal y las contraseñas quedaron intactos.'
      }
    });

  } catch (err) {
    return fail(res, 500, 'Error al limpiar los registros', err);
  }
}

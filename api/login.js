import { getDb, preflight, fail, readBody } from '../lib/db.js';
import { verificarPassword, hashPassword } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return fail(res, 405, 'Método no permitido');

  const { num_emp, password } = readBody(req);
  if (!num_emp || !password) return fail(res, 400, 'Ingresa tu número de empleado y contraseña');

  const numEmp = String(num_emp).trim();

  try {
    const sql = getDb();

    /* Una sola consulta: el usuario junto con el nombre de su jefe y de
       su gerente. Antes eran 3 consultas secuenciales (3 viajes de red
       a Neon en cada login). */
    const rows = await sql`
      SELECT u.num_emp, u.password, u.nombre, u.puesto, u.ubicacion, u.depto, u.rol,
             u.jefe_num, u.gerente_num, u.email, u.activo,
             j.nombre AS jefe_nombre,    j.email AS jefe_email,
             g.nombre AS gerente_nombre, g.email AS gerente_email
      FROM usuarios u
      LEFT JOIN usuarios j ON j.num_emp = u.jefe_num
      LEFT JOIN usuarios g ON g.num_emp = u.gerente_num
      WHERE u.num_emp = ${numEmp}
      LIMIT 1
    `;

    if (rows.length === 0) return fail(res, 401, 'Usuario o contraseña incorrectos');

    const u = rows[0];
    if (u.activo === false) return fail(res, 403, 'Tu usuario está dado de baja. Contacta a Capital Humano.');

    const { valido, necesitaCifrado } = verificarPassword(password, u.password);
    if (!valido) return fail(res, 401, 'Usuario o contraseña incorrectos');

    /* Cifrado transparente de contraseñas heredadas en texto plano.
       Se hace después de validar y no bloquea la respuesta si falla. */
    if (necesitaCifrado) {
      try {
        const h = hashPassword(password);
        await sql`UPDATE usuarios SET password = ${h} WHERE num_emp = ${numEmp}`;
      } catch (e) {
        console.warn('[GPA] No se pudo cifrar la contraseña de', numEmp, e.message);
      }
    }

    delete u.password;   // nunca sale de aquí

    return res.status(200).json({ ok: true, user: u });
  } catch (err) {
    return fail(res, 500, 'Error del servidor al iniciar sesión. Verifica la conexión a la base de datos.', err);
  }
}

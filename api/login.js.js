import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { num_emp, password } = req.body;
  if (!num_emp || !password) return res.status(400).json({ error: 'Datos incompletos' });

  try {
    const sql = getDb();
    const rows = await sql`
      SELECT num_emp, nombre, puesto, ubicacion, depto, rol,
             jefe_num, gerente_num, email, activo
      FROM usuarios
      WHERE num_emp = ${num_emp} AND password = ${password} AND activo = TRUE
    `;
    if (rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const user = rows[0];

    // Si tiene jefe, traer datos del jefe
    let jefeData = null;
    if (user.jefe_num) {
      const jefe = await sql`SELECT nombre, email FROM usuarios WHERE num_emp = ${user.jefe_num}`;
      if (jefe.length > 0) jefeData = jefe[0];
    }

    // Si tiene gerente, traer datos del gerente
    let gerenteData = null;
    if (user.gerente_num) {
      const ger = await sql`SELECT nombre, email FROM usuarios WHERE num_emp = ${user.gerente_num}`;
      if (ger.length > 0) gerenteData = ger[0];
    }

    return res.status(200).json({
      ok: true,
      user: {
        ...user,
        jefe_nombre: jefeData?.nombre || null,
        jefe_email: jefeData?.email || null,
        gerente_nombre: gerenteData?.nombre || null,
        gerente_email: gerenteData?.email || null,
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Error del servidor' });
  }
}

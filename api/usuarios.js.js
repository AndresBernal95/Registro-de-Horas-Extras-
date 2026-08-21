import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const sql = getDb();

  // GET — listar todos
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT num_emp, nombre, puesto, ubicacion, depto, rol,
               jefe_num, gerente_num, email, activo, created_at
        FROM usuarios ORDER BY ubicacion, depto, nombre
      `;
      return res.status(200).json({ ok: true, data: rows });
    } catch (err) {
      return res.status(500).json({ error: 'Error al obtener usuarios' });
    }
  }

  // POST — crear usuario
  if (req.method === 'POST') {
    const { num_emp, password, nombre, puesto, ubicacion, depto, rol, jefe_num, gerente_num, email } = req.body;
    if (!num_emp || !nombre || !rol) return res.status(400).json({ error: 'Datos incompletos' });
    try {
      const rows = await sql`
        INSERT INTO usuarios (num_emp, password, nombre, puesto, ubicacion, depto, rol, jefe_num, gerente_num, email)
        VALUES (${num_emp}, ${password || 'GPA2026'}, ${nombre}, ${puesto}, ${ubicacion},
                ${depto}, ${rol}, ${jefe_num || null}, ${gerente_num || null}, ${email || null})
        RETURNING num_emp, nombre, puesto, ubicacion, depto, rol, activo
      `;
      return res.status(201).json({ ok: true, data: rows[0] });
    } catch (err) {
      if (err.message.includes('unique')) return res.status(409).json({ error: 'Número de empleado ya existe' });
      return res.status(500).json({ error: 'Error al crear usuario' });
    }
  }

  // PUT — editar usuario
  if (req.method === 'PUT') {
    const { num_emp, nombre, puesto, ubicacion, depto, rol, jefe_num, gerente_num, email, activo, password } = req.body;
    if (!num_emp) return res.status(400).json({ error: 'num_emp requerido' });
    try {
      const rows = await sql`
        UPDATE usuarios SET
          nombre      = COALESCE(${nombre}, nombre),
          puesto      = COALESCE(${puesto}, puesto),
          ubicacion   = COALESCE(${ubicacion}, ubicacion),
          depto       = COALESCE(${depto}, depto),
          rol         = COALESCE(${rol}, rol),
          jefe_num    = COALESCE(${jefe_num}, jefe_num),
          gerente_num = COALESCE(${gerente_num}, gerente_num),
          email       = COALESCE(${email}, email),
          activo      = COALESCE(${activo}, activo),
          password    = COALESCE(${password}, password)
        WHERE num_emp = ${num_emp}
        RETURNING num_emp, nombre, puesto, ubicacion, depto, rol, activo
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
      return res.status(200).json({ ok: true, data: rows[0] });
    } catch (err) {
      return res.status(500).json({ error: 'Error al actualizar usuario' });
    }
  }

  // DELETE — baja lógica
  if (req.method === 'DELETE') {
    const { num_emp } = req.query;
    if (!num_emp) return res.status(400).json({ error: 'num_emp requerido' });
    try {
      await sql`UPDATE usuarios SET activo = FALSE WHERE num_emp = ${num_emp}`;
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Error al dar de baja' });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

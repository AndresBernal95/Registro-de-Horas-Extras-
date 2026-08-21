import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const sql = getDb();

  // GET — listar registros según rol
  if (req.method === 'GET') {
    const { num_emp, rol, ubicacion, depto } = req.query;
    try {
      let rows;
      if (rol === 'admin') {
        rows = await sql`SELECT * FROM horas_extras ORDER BY ts DESC LIMIT 500`;
      } else if (rol === 'gerente') {
        // Ve todo su departamento o los que tienen su num_emp como gerente_num
        rows = await sql`
          SELECT h.* FROM horas_extras h
          JOIN usuarios u ON h.num_emp = u.num_emp
          WHERE u.gerente_num = ${num_emp}
          ORDER BY h.ts DESC LIMIT 500
        `;
      } else if (rol === 'jefe') {
        // Ve solo su personal directo y su ubicación
        rows = await sql`
          SELECT h.* FROM horas_extras h
          JOIN usuarios u ON h.num_emp = u.num_emp
          WHERE u.jefe_num = ${num_emp}
             OR h.num_emp = ${num_emp}
          ORDER BY h.ts DESC LIMIT 200
        `;
      } else {
        // Operario: solo los suyos
        rows = await sql`
          SELECT * FROM horas_extras
          WHERE num_emp = ${num_emp}
          ORDER BY ts DESC LIMIT 50
        `;
      }
      return res.status(200).json({ ok: true, data: rows });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al obtener registros' });
    }
  }

  // POST — crear registro
  if (req.method === 'POST') {
    const {
      num_emp, nombre, puesto, ubicacion, depto,
      horas_dia, causa_cat, causa_p1, causa_p2, causa_p3, causa_texto,
      estado_lft, jefe_num, gerente_num, horas_semana
    } = req.body;

    if (!num_emp || !horas_dia) return res.status(400).json({ error: 'Datos incompletos' });

    // Verificar si ya registró hoy
    const hoy = new Date().toISOString().slice(0, 10);
    const existing = await sql`
      SELECT id FROM horas_extras WHERE num_emp = ${num_emp} AND fecha = ${hoy}
    `;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Ya registraste horas extra hoy' });
    }

    // Determinar si necesita autorización de gerente (hora 10+)
    const necesitaGerente = parseFloat(horas_semana) > 9;
    const authJefe = necesitaGerente ? 'na' : 'pendiente';
    const authGerente = necesitaGerente ? 'pendiente' : 'na';

    try {
      const now = new Date();
      const rows = await sql`
        INSERT INTO horas_extras (
          fecha, hora_registro, num_emp, nombre, puesto, ubicacion, depto,
          horas_dia, horas_semana, causa_cat, causa_p1, causa_p2, causa_p3,
          causa_texto, estado_lft, auth_jefe, auth_jefe_num, auth_gerente,
          auth_gerente_num, estado_final
        ) VALUES (
          ${hoy}, ${now.toTimeString().slice(0,8)}, ${num_emp}, ${nombre},
          ${puesto}, ${ubicacion}, ${depto}, ${horas_dia}, ${horas_semana},
          ${causa_cat}, ${causa_p1}, ${causa_p2}, ${causa_p3}, ${causa_texto},
          ${estado_lft}, ${authJefe}, ${jefe_num || null},
          ${authGerente}, ${gerente_num || null}, 'pendiente'
        ) RETURNING *
      `;
      return res.status(201).json({ ok: true, data: rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al guardar registro' });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

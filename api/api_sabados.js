import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  const sql = getDb();

  // GET
  if (req.method === 'GET') {
    const { num_emp, rol } = req.query;
    try {
      let rows;
      if (rol === 'admin') {
        rows = await sql`SELECT * FROM sabados_laborados ORDER BY ts DESC`;
      } else if (rol === 'gerente') {
        rows = await sql`
          SELECT s.* FROM sabados_laborados s
          JOIN usuarios u ON s.jefe_num = u.num_emp
          WHERE u.gerente_num = ${num_emp}
          ORDER BY s.ts DESC
        `;
      } else if (rol === 'jefe') {
        rows = await sql`
          SELECT * FROM sabados_laborados
          WHERE jefe_num = ${num_emp}
          ORDER BY ts DESC
        `;
      } else {
        rows = [];
      }
      return res.status(200).json({ ok: true, data: rows });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al obtener sábados' });
    }
  }

  // POST — crear solicitud sábado
  if (req.method === 'POST') {
    const {
      fecha_sabado, jefe_num, jefe_nombre, ubicacion, depto,
      personal, causa_cat, causa_p1, causa_p2, causa_p3, causa_texto,
      gerente_num
    } = req.body;

    if (!fecha_sabado || !jefe_num || !personal) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    try {
      const rows = await sql`
        INSERT INTO sabados_laborados (
          fecha_sabado, jefe_num, jefe_nombre, ubicacion, depto,
          personal, causa_cat, causa_p1, causa_p2, causa_p3, causa_texto,
          auth_gerente, auth_gerente_num
        ) VALUES (
          ${fecha_sabado}, ${jefe_num}, ${jefe_nombre}, ${ubicacion}, ${depto},
          ${JSON.stringify(personal)}, ${causa_cat}, ${causa_p1},
          ${causa_p2}, ${causa_p3}, ${causa_texto},
          'pendiente', ${gerente_num || null}
        ) RETURNING *
      `;
      return res.status(201).json({ ok: true, data: rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al guardar solicitud' });
    }
  }

  // PUT — autorizar / rechazar
  if (req.method === 'PUT') {
    const { id, decision, auth_num } = req.body;
    try {
      const rows = await sql`
        UPDATE sabados_laborados SET
          auth_gerente = ${decision},
          auth_gerente_num = ${auth_num},
          auth_gerente_ts = NOW()
        WHERE id = ${id} AND auth_gerente = 'pendiente'
        RETURNING *
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'No encontrado o ya procesado' });
      return res.status(200).json({ ok: true, data: rows[0] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Error al procesar' });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

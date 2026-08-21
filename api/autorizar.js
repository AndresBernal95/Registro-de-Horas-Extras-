import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PUT') return res.status(405).json({ error: 'Método no permitido' });

  const { id, decision, nivel, auth_num } = req.body;
  // nivel: 'jefe' | 'gerente'
  // decision: 'autorizado' | 'rechazado'
  if (!id || !decision || !nivel) return res.status(400).json({ error: 'Datos incompletos' });

  const sql = getDb();
  const now = new Date();

  try {
    let rows;
    if (nivel === 'jefe') {
      rows = await sql`
        UPDATE horas_extras SET
          auth_jefe = ${decision},
          auth_jefe_num = ${auth_num},
          auth_jefe_ts = ${now},
          estado_final = ${decision}
        WHERE id = ${id} AND auth_jefe = 'pendiente'
        RETURNING *
      `;
    } else if (nivel === 'gerente') {
      rows = await sql`
        UPDATE horas_extras SET
          auth_gerente = ${decision},
          auth_gerente_num = ${auth_num},
          auth_gerente_ts = ${now},
          estado_final = ${decision}
        WHERE id = ${id} AND auth_gerente = 'pendiente'
        RETURNING *
      `;
    } else {
      return res.status(400).json({ error: 'Nivel inválido' });
    }

    if (rows.length === 0) return res.status(404).json({ error: 'Registro no encontrado o ya procesado' });
    return res.status(200).json({ ok: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error al autorizar' });
  }
}

import { getDb } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  const { num_emp, rol } = req.query;
  const sql = getDb();

  // Inicio y fin de semana actual (lunes a domingo)
  const hoy = new Date();
  const dia = hoy.getDay() || 7;
  const lunes = new Date(hoy);
  lunes.setDate(hoy.getDate() - (dia - 1));
  lunes.setHours(0, 0, 0, 0);
  const domingo = new Date(lunes);
  domingo.setDate(lunes.getDate() + 6);
  domingo.setHours(23, 59, 59, 999);

  try {
    let empleados, registros;

    if (rol === 'admin') {
      empleados = await sql`
        SELECT num_emp, nombre, puesto, ubicacion, depto, rol, jefe_num, gerente_num
        FROM usuarios WHERE rol = 'operario' AND activo = TRUE ORDER BY ubicacion, nombre
      `;
      registros = await sql`
        SELECT num_emp, SUM(horas_dia) as total_horas,
               COUNT(*) as total_regs,
               SUM(CASE WHEN estado_final='pendiente' THEN 1 ELSE 0 END) as pendientes
        FROM horas_extras
        WHERE fecha BETWEEN ${lunes.toISOString().slice(0,10)} AND ${domingo.toISOString().slice(0,10)}
        GROUP BY num_emp
      `;
    } else if (rol === 'gerente') {
      empleados = await sql`
        SELECT u.num_emp, u.nombre, u.puesto, u.ubicacion, u.depto, u.rol, u.jefe_num
        FROM usuarios u
        WHERE u.gerente_num = ${num_emp} AND u.activo = TRUE
        ORDER BY u.ubicacion, u.nombre
      `;
      const empNums = empleados.map(e => e.num_emp);
      registros = empNums.length > 0 ? await sql`
        SELECT num_emp, SUM(horas_dia) as total_horas,
               COUNT(*) as total_regs,
               SUM(CASE WHEN estado_final='pendiente' THEN 1 ELSE 0 END) as pendientes
        FROM horas_extras
        WHERE num_emp = ANY(${empNums}) AND
              fecha BETWEEN ${lunes.toISOString().slice(0,10)} AND ${domingo.toISOString().slice(0,10)}
        GROUP BY num_emp
      ` : [];
    } else if (rol === 'jefe') {
      // Solo su equipo directo en su ubicación
      empleados = await sql`
        SELECT num_emp, nombre, puesto, ubicacion, depto, rol, jefe_num
        FROM usuarios
        WHERE jefe_num = ${num_emp} AND activo = TRUE
        ORDER BY nombre
      `;
      const empNums = empleados.map(e => e.num_emp);
      registros = empNums.length > 0 ? await sql`
        SELECT num_emp, SUM(horas_dia) as total_horas,
               COUNT(*) as total_regs,
               SUM(CASE WHEN estado_final='pendiente' THEN 1 ELSE 0 END) as pendientes
        FROM horas_extras
        WHERE num_emp = ANY(${empNums}) AND
              fecha BETWEEN ${lunes.toISOString().slice(0,10)} AND ${domingo.toISOString().slice(0,10)}
        GROUP BY num_emp
      ` : [];
    } else {
      return res.status(403).json({ error: 'Sin acceso al monitor' });
    }

    // Combinar
    const regMap = {};
    for (const r of registros) regMap[r.num_emp] = r;

    const result = empleados.map(e => ({
      ...e,
      horas_semana: parseFloat(regMap[e.num_emp]?.total_horas || 0),
      total_regs: parseInt(regMap[e.num_emp]?.total_regs || 0),
      pendientes: parseInt(regMap[e.num_emp]?.pendientes || 0),
    }));

    return res.status(200).json({ ok: true, data: result, semana: { ini: lunes, fin: domingo } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Error en monitor' });
  }
}

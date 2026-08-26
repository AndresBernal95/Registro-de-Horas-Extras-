import { getDb, preflight, fail, done, readBody, ROLES } from '../lib/db.js';
import { prepararPassword } from '../lib/auth.js';

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  const sql = getDb();

  /* ══ GET — catálogo (nunca devuelve contraseñas) ══ */
  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT num_emp, nombre, puesto, ubicacion, depto, rol,
               jefe_num, gerente_num, email, activo, created_at
        FROM usuarios
        ORDER BY ubicacion NULLS LAST, depto NULLS LAST, nombre`;
      return done(res, rows);
    } catch (err) {
      return fail(res, 500, 'Error al obtener los usuarios', err);
    }
  }

  /* ══ POST — crear ══ */
  if (req.method === 'POST') {
    const b = readBody(req);
    const numEmp = b.num_emp ? String(b.num_emp).trim() : '';
    const nombre = b.nombre ? String(b.nombre).trim() : '';
    const rol = b.rol || 'operario';

    if (!numEmp) return fail(res, 400, 'El número de empleado es obligatorio');
    if (!nombre) return fail(res, 400, 'El nombre es obligatorio');
    if (!ROLES.includes(rol)) return fail(res, 400, 'El rol no es válido');
    if (b.jefe_num && String(b.jefe_num).trim() === numEmp)
      return fail(res, 400, 'Un empleado no puede ser su propio jefe');

    try {
      const nulo = v => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };
      const pass = prepararPassword(b.password) || prepararPassword('GPA2026');

      const rows = await sql`
        INSERT INTO usuarios (num_emp, password, nombre, puesto, ubicacion, depto,
                              rol, jefe_num, gerente_num, email, activo)
        VALUES (${numEmp}, ${pass}, ${nombre}, ${nulo(b.puesto)}, ${nulo(b.ubicacion)},
                ${nulo(b.depto)}, ${rol}, ${nulo(b.jefe_num)}, ${nulo(b.gerente_num)},
                ${nulo(b.email)}, ${b.activo === false ? false : true})
        RETURNING num_emp, nombre, puesto, ubicacion, depto, rol,
                  jefe_num, gerente_num, email, activo`;
      return done(res, rows[0], 201);
    } catch (err) {
      const m = String(err.message || '').toLowerCase();
      if (m.includes('unique') || m.includes('duplicate'))
        return fail(res, 409, `El número de empleado ${numEmp} ya existe`);
      if (m.includes('check') && m.includes('rol'))
        return fail(res, 400, 'El rol no es válido');
      return fail(res, 500, 'Error al crear el usuario', err);
    }
  }

  /* ══ PUT — editar ══
     Antes se usaba COALESCE(${campo}, campo) en todos los campos, lo
     que hacía IMPOSIBLE dejar un campo vacío: al borrar el email o el
     jefe, el valor viejo se conservaba. Ahora sólo se actualizan los
     campos que realmente vienen en la petición. */
  if (req.method === 'PUT') {
    const b = readBody(req);
    const numEmp = b.num_emp ? String(b.num_emp).trim() : '';
    if (!numEmp) return fail(res, 400, 'El número de empleado es obligatorio');
    if (b.rol !== undefined && !ROLES.includes(b.rol)) return fail(res, 400, 'El rol no es válido');
    if (b.jefe_num && String(b.jefe_num).trim() === numEmp)
      return fail(res, 400, 'Un empleado no puede ser su propio jefe');

    try {
      const existe = await sql`SELECT num_emp FROM usuarios WHERE num_emp = ${numEmp} LIMIT 1`;
      if (existe.length === 0) return fail(res, 404, 'El usuario no existe');

      const nulo = v => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };

      /* Cada campo se actualiza sólo si viene definido en el body.
         Se usan sentencias separadas y sencillas para no armar SQL
         dinámico (el driver de Neon exige plantillas etiquetadas). */
      if (b.nombre      !== undefined) await sql`UPDATE usuarios SET nombre      = ${nulo(b.nombre)}      WHERE num_emp = ${numEmp}`;
      if (b.puesto      !== undefined) await sql`UPDATE usuarios SET puesto      = ${nulo(b.puesto)}      WHERE num_emp = ${numEmp}`;
      if (b.ubicacion   !== undefined) await sql`UPDATE usuarios SET ubicacion   = ${nulo(b.ubicacion)}   WHERE num_emp = ${numEmp}`;
      if (b.depto       !== undefined) await sql`UPDATE usuarios SET depto       = ${nulo(b.depto)}       WHERE num_emp = ${numEmp}`;
      if (b.rol         !== undefined) await sql`UPDATE usuarios SET rol         = ${b.rol}               WHERE num_emp = ${numEmp}`;
      if (b.jefe_num    !== undefined) await sql`UPDATE usuarios SET jefe_num    = ${nulo(b.jefe_num)}    WHERE num_emp = ${numEmp}`;
      if (b.gerente_num !== undefined) await sql`UPDATE usuarios SET gerente_num = ${nulo(b.gerente_num)} WHERE num_emp = ${numEmp}`;
      if (b.email       !== undefined) await sql`UPDATE usuarios SET email       = ${nulo(b.email)}       WHERE num_emp = ${numEmp}`;
      if (b.activo      !== undefined) await sql`UPDATE usuarios SET activo      = ${!!b.activo}          WHERE num_emp = ${numEmp}`;

      /* La contraseña sólo se toca si mandaron una nueva, y se guarda cifrada. */
      if (b.password) {
        const h = prepararPassword(b.password);
        await sql`UPDATE usuarios SET password = ${h} WHERE num_emp = ${numEmp}`;
      }

      const rows = await sql`
        SELECT num_emp, nombre, puesto, ubicacion, depto, rol,
               jefe_num, gerente_num, email, activo
        FROM usuarios WHERE num_emp = ${numEmp}`;
      return done(res, rows[0]);
    } catch (err) {
      return fail(res, 500, 'Error al actualizar el usuario', err);
    }
  }

  /* ══ DELETE — baja lógica, nunca borrado físico
     (los registros de horas extras hacen referencia a usuarios) ══ */
  if (req.method === 'DELETE') {
    const numEmp = req.query.num_emp ? String(req.query.num_emp).trim() : '';
    if (!numEmp) return fail(res, 400, 'El número de empleado es obligatorio');
    try {
      const rows = await sql`UPDATE usuarios SET activo = FALSE WHERE num_emp = ${numEmp} RETURNING num_emp`;
      if (rows.length === 0) return fail(res, 404, 'El usuario no existe');
      return done(res, { num_emp: numEmp, activo: false });
    } catch (err) {
      return fail(res, 500, 'Error al dar de baja al usuario', err);
    }
  }

  return fail(res, 405, 'Método no permitido');
}

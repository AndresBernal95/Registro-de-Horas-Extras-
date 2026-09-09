import { getDb, preflight, fail, fechaMX, horaMX, semanaMX } from '../lib/db.js';

/* ══════════════════════════════════════════════════════════════════
   DIAGNÓSTICO — abre https://tu-app.vercel.app/api/diagnostico

   Revisa que la base de datos tenga todo lo que el código necesita y
   dice exactamente qué falta. Úsalo siempre después de desplegar o
   cuando algo devuelva error 500: en lugar de adivinar, este endpoint
   te dice si falta una columna, un índice o la variable DATABASE_URL.
   ══════════════════════════════════════════════════════════════════ */

const COLUMNAS = {
  usuarios: ['num_emp','password','nombre','puesto','ubicacion','depto','rol',
             'jefe_num','gerente_num','email','activo'],
  horas_extras: ['id','fecha','hora_registro','ts','num_emp','nombre','puesto','ubicacion','depto',
                 'horas_dia','horas_semana','causa_cat','causa_grupo','causa_p1','causa_p2','causa_p3',
                 'causa_texto','estado_lft','jefe_num','gerente_num','auth_jefe','auth_jefe_num',
                 'auth_jefe_ts','auth_gerente','auth_gerente_num','auth_gerente_ts','estado_final',
                 /* v3 · solicitud del jefe y firma del trabajador */
                 'lote_id','origen','solicitante_num','solicitante_nombre','solicitante_ts',
                 'rechazado_por','acept_emp','acept_emp_ts','acept_emp_ip','acept_emp_ua',
                 'acept_emp_leyenda','acept_emp_ley_ver','acept_emp_hash','acept_emp_nota'],
  sabados_laborados: ['id','ts','fecha_sabado','jefe_num','jefe_nombre','ubicacion','depto','personal',
                      'causa_cat','causa_grupo','causa_p1','causa_p2','causa_p3','causa_texto',
                      'gerente_num','auth_gerente','auth_gerente_num','auth_gerente_ts','horas_persona'],
  sabados_personal: ['id','sabado_id','num_emp','nombre','puesto','ubicacion','horas','acept',
                     'acept_ts','acept_ip','acept_ua','acept_leyenda','acept_ley_ver','acept_hash','acept_nota'],
  notificaciones: ['id','ts','para_num','de_num','tipo','referencia','asunto','cuerpo','leida']
};

export default async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') return fail(res, 405, 'Método no permitido');

  const inicio = Date.now();
  const problemas = [];
  const info = {
    revisado: `${fechaMX()} ${horaMX()} (hora de México)`,
    semana_en_curso: semanaMX(),
    node: process.version
  };

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({
      ok: false,
      estado: 'SIN CONFIGURAR',
      problemas: ['Falta la variable DATABASE_URL en Vercel → Settings → Environment Variables. Agrégala en Production, Preview y Development, y vuelve a desplegar.'],
      info
    });
  }

  try {
    const sql = getDb();

    /* Conexión */
    const ping = await sql`SELECT 1 AS ok`;
    info.conexion = ping.length === 1 ? 'correcta' : 'respuesta inesperada';

    /* Tablas y columnas */
    const cols = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('usuarios','horas_extras','sabados_laborados','sabados_personal','notificaciones')`;

    const mapa = {};
    for (const c of cols) (mapa[c.table_name] ||= new Set()).add(c.column_name);

    info.tablas = {};
    for (const [tabla, esperadas] of Object.entries(COLUMNAS)) {
      const tiene = mapa[tabla];
      if (!tiene) {
        problemas.push(`Falta la tabla "${tabla}". Ejecuta schema.sql completo en el SQL Editor de Neon.`);
        info.tablas[tabla] = 'NO EXISTE';
        continue;
      }
      const faltan = esperadas.filter(c => !tiene.has(c));
      info.tablas[tabla] = faltan.length ? `faltan ${faltan.length} columna(s)` : 'completa';
      if (faltan.length) {
        problemas.push(`En "${tabla}" faltan las columnas: ${faltan.join(', ')}. Ejecuta migracion-v3.sql en Neon.`);
      }
    }

    /* Índices clave */
    const idx = await sql`SELECT indexname FROM pg_indexes WHERE schemaname='public'`;
    const nombres = new Set(idx.map(i => i.indexname));
    const claves = ['idx_he_num_fecha','idx_he_fecha','uq_he_emp_dia_viva','idx_usr_jefe','idx_usr_gerente','idx_sp_sabado'];
    const sinIdx = claves.filter(i => !nombres.has(i));
    info.indices = sinIdx.length ? `faltan: ${sinIdx.join(', ')}` : 'completos';
    if (sinIdx.length) {
      problemas.push(`Faltan índices (${sinIdx.join(', ')}). El sistema funciona pero el monitor será lento. Ejecuta migracion-v3.sql.`);
    }

    /* Datos */
    const [u] = await sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE activo)::int AS activos,
             COUNT(*) FILTER (WHERE rol='admin')::int AS admins,
             COUNT(*) FILTER (WHERE password NOT LIKE '$2%')::int AS sin_cifrar
      FROM usuarios`;
    info.usuarios = u;
    if (u.total === 0) problemas.push('No hay usuarios cargados. Ejecuta la sección de datos iniciales de schema.sql.');
    if (u.admins === 0) problemas.push('No existe ningún usuario con rol admin. Nadie podrá administrar el catálogo.');
    if (u.sin_cifrar > 0) {
      info.nota_contrasenas = `${u.sin_cifrar} contraseña(s) siguen en texto plano. Se cifran solas la primera vez que cada persona entra; no requiere acción.`;
    }

    const [h] = await sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE estado_final='pendiente')::int AS pendientes,
             COALESCE(SUM(horas_dia),0)::float8 AS horas_totales
      FROM horas_extras`;
    info.horas_extras = h;

    /* Empleados cuyo jefe o gerente no existe: rompe la autorización */
    const huerfanos = await sql`
      SELECT u.num_emp, u.nombre, u.jefe_num, u.gerente_num
      FROM usuarios u
      LEFT JOIN usuarios j ON j.num_emp = u.jefe_num
      LEFT JOIN usuarios g ON g.num_emp = u.gerente_num
      WHERE u.activo = TRUE
        AND ((u.jefe_num    IS NOT NULL AND j.num_emp IS NULL)
          OR (u.gerente_num IS NOT NULL AND g.num_emp IS NULL))
      LIMIT 25`;
    if (huerfanos.length) {
      info.cadena_autorizacion_rota = huerfanos;
      problemas.push(`${huerfanos.length} empleado(s) tienen asignado un jefe o gerente que no existe en el catálogo: sus solicitudes no le llegarían a nadie. Corrígelos en la pestaña Usuarios.`);
    } else {
      info.cadena_autorizacion_rota = 'ninguna';
    }

    /* Gerentes sin personal asignado */
    const gerSinGente = await sql`
      SELECT g.num_emp, g.nombre FROM usuarios g
      WHERE g.rol = 'gerente' AND g.activo = TRUE
        AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.gerente_num = g.num_emp AND u.activo = TRUE)`;
    info.gerentes_sin_personal = gerSinGente.length ? gerSinGente : 'ninguno';

    /* Prueba real de escritura y borrado (transacción efímera) */
    try {
      const prueba = await sql`
        INSERT INTO horas_extras (fecha, hora_registro, num_emp, nombre, horas_dia, horas_semana,
                                  causa_cat, causa_grupo, causa_p1, causa_p2, causa_p3, causa_texto,
                                  estado_lft, jefe_num, gerente_num, auth_jefe, auth_gerente, estado_final)
        SELECT '1900-01-01', '00:00:00', num_emp, 'PRUEBA DE DIAGNOSTICO', 0.5, 0.5,
               'diagnostico', 'op', 'x', 'x', 'x', 'x', 'ok', NULL, NULL, 'na', 'na', 'rechazado'
        FROM usuarios ORDER BY num_emp LIMIT 1
        RETURNING id`;
      if (prueba[0]) {
        await sql`DELETE FROM horas_extras WHERE id = ${prueba[0].id}`;
        info.prueba_escritura = 'correcta (el registro de prueba se eliminó)';
      }
    } catch (e) {
      info.prueba_escritura = 'FALLÓ: ' + e.message;
      problemas.push('No se pudo insertar un registro de prueba: ' + e.message + ' → ejecuta migracion-v3.sql en Neon.');
    }

    info.duracion_ms = Date.now() - inicio;

    return res.status(problemas.length ? 409 : 200).json({
      ok: problemas.length === 0,
      estado: problemas.length === 0 ? 'TODO CORRECTO' : 'REQUIERE ATENCIÓN',
      problemas,
      info
    });

  } catch (err) {
    console.error('[GPA diagnostico]', err);
    return res.status(500).json({
      ok: false,
      estado: 'ERROR DE CONEXIÓN',
      problemas: [
        'No se pudo consultar la base de datos: ' + err.message,
        'Revisa que DATABASE_URL sea la cadena "Pooled connection" de Neon y que termine en ?sslmode=require.'
      ],
      info
    });
  }
}

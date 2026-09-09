/* ══════════════════════════════════════════════════════════════════
   PUENTE DE PRUEBAS: @neondatabase/serverless → PostgreSQL local

   Los endpoints hablan con Neon por HTTP, así que no se pueden probar
   contra una base local tal cual. Este módulo imita la interfaz de
   @neondatabase/serverless (la función etiquetada `sql` y neonConfig)
   pero por debajo usa el cliente `pg` normal.

   Con esto, test/api-v3.mjs ejecuta el CÓDIGO REAL de los endpoints
   —sin copiar consultas ni simular nada— contra un PostgreSQL de
   verdad, que es lo único que demuestra que el SQL está bien escrito.

   Se activa con el cargador de test/registrar-shim.mjs:
     node --import ./test/registrar-shim.mjs test/api-v3.mjs
   ══════════════════════════════════════════════════════════════════ */
import pg from 'pg';

/* Los NUMERIC llegan como string desde pg; Neon los entrega como
   número. Se igualan para que el código se comporte igual. */
pg.types.setTypeParser(1700, v => v === null ? null : Number(v));
pg.types.setTypeParser(20, v => v === null ? null : Number(v));   // int8

export const neonConfig = {};

let pool = null;

export function neon(url) {
  if (!pool) pool = new pg.Pool({ connectionString: url, max: 4 });

  /* sql`SELECT ... ${valor} ...` → consulta con $1, $2, ... */
  const sql = async (strings, ...valores) => {
    let texto = '';
    strings.forEach((s, i) => {
      texto += s;
      if (i < valores.length) texto += '$' + (i + 1);
    });
    const r = await pool.query(texto, valores);
    return r.rows;
  };

  sql.query = async (texto, params) => (await pool.query(texto, params || [])).rows;
  sql.end = async () => { if (pool) { await pool.end(); pool = null; } };
  return sql;
}

export async function cerrar() { if (pool) { await pool.end(); pool = null; } }

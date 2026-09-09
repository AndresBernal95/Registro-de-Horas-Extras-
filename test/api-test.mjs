/* ══════════════════════════════════════════════════════════════════
   PRUEBAS DE LO QUE NO CAMBIÓ CON LA v3

   Login (bcrypt transparente), monitor, catálogo de usuarios, reporte
   de Excel y borrado total. El flujo nuevo —solicitud del jefe,
   consentimiento del trabajador, sábados con firma individual y el
   formato PDF— se prueba en test/api-v3.mjs.

     DATABASE_URL='postgresql://usuario@localhost:5432/gpa' \
       node --import ./test/registrar-shim.mjs test/api-test.mjs
   ══════════════════════════════════════════════════════════════════ */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5433/gpa';

let fallos = 0, n = 0;
const t = (nombre, ok, extra) => {
  n++;
  if (ok) console.log(`  ✅ ${nombre}`);
  else { fallos++; console.log(`  ❌ ${nombre}${extra ? '\n       → ' + extra : ''}`); }
};

/* Simula el objeto res de Vercel */
function mkRes() {
  const o = { code: 0, body: null, headers: {} };
  o.setHeader = (k, v) => { o.headers[k] = v; };
  o.status = c => { o.code = c; return o; };
  o.json = b => { o.body = b; return o; };
  o.send = b => { o.body = b; return o; };
  o.end = () => o;
  return o;
}

async function call(mod, method, query, body) {
  const { default: h } = await import(mod);
  const res = mkRes();
  await h({ method, query: query || {}, body: body || undefined }, res);
  return res;
}

const login     = '../api/login.js';
const registros = '../api/registros.js';
const monitor   = '../api/monitor.js';
const autorizar = '../api/autorizar.js';
const sabados   = '../api/sabados.js';
const usuarios  = '../api/usuarios.js';
const reporte   = '../api/reporte.js';
const limpiar   = '../api/limpiar.js';

console.log('\n══════ LOGIN ══════');
let r = await call(login, 'POST', {}, { num_emp: '8197', password: 'Jefe2026' });
t('Jefe 8197 entra con la contraseña en texto plano', r.code === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 300));
const JEFE = r.body.user || {};
t('Trae el nombre del gerente por JOIN', JEFE.gerente_nombre === 'LOMELI LLAMAS JOSE MIGUEL', 'gerente_nombre=' + JEFE.gerente_nombre);
t('Nunca devuelve el campo password', !('password' in JEFE));

r = await call(login, 'POST', {}, { num_emp: '8197', password: 'Jefe2026' });
t('Segundo login funciona (ya con hash bcrypt)', r.code === 200 && r.body.ok, JSON.stringify(r.body).slice(0, 200));
r = await call(login, 'POST', {}, { num_emp: '8197', password: 'incorrecta' });
t('Rechaza contraseña incorrecta contra el hash', r.code === 401);
r = await call(login, 'POST', {}, { num_emp: '8101', password: 'Gerente2026' });
t('Gerente 8101 entra', r.code === 200 && r.body.ok);
const GER = r.body.user || {};
r = await call(login, 'POST', {}, { num_emp: '0000', password: 'Admin2026' });
t('Admin 0000 entra', r.code === 200 && r.body.ok);
r = await call(login, 'POST', {}, { num_emp: '140', password: 'GPA2026' });
t('Operario 140 entra', r.code === 200 && r.body.ok);
const OPE = r.body.user || {};

console.log('\n══════ MONITOR ══════');
for (const [rol, quien, min] of [['admin','0000',200],['gerente','8101',100],['jefe','240',15]]) {
  r = await call(monitor, 'GET', { num_emp: quien, rol });
  const cuantos = r.body?.data?.length || 0;
  t(`Monitor rol=${rol} (${cuantos} empleados)`, r.code === 200 && r.body.ok && cuantos >= min,
    `HTTP ${r.code} · ${cuantos} filas · ${JSON.stringify(r.body).slice(0,220)}`);
}
r = await call(monitor, 'GET', { num_emp: '8101', rol: 'gerente' });
const m8197 = (r.body.data || []).find(x => x.num_emp === '8197');
/* El bug #8 de la v2.2: el monitor filtraba por rol='operario' y las
   horas de jefes y gerentes eran invisibles. Aquí se comprueba que el
   jefe 8197 aparece en la estructura de su gerente. */
t('El gerente ve a su jefe 8197 en el monitor', !!m8197,
  m8197 ? 'ok' : 'no aparece 8197');
t('El monitor separa las horas de sábado de las de entre semana',
  m8197 && typeof m8197.horas_sabado === 'number', JSON.stringify(m8197));
t('Los campos numéricos llegan como número, no texto', typeof m8197?.horas_semana === 'number',
  typeof m8197?.horas_semana);
r = await call(monitor, 'GET', { num_emp: '140', rol: 'operario' });
t('Operario no puede ver el monitor (403)', r.code === 403);

console.log('\n══════ USUARIOS ══════');
/* La suite debe poder correrse varias veces sobre la misma base */
try { const { getDb } = await import('./lib/db.js'); const sql = getDb();
      await sql`DELETE FROM horas_extras WHERE num_emp = 'TEST1'`;
      await sql`DELETE FROM usuarios WHERE num_emp = 'TEST1'`; } catch {}
r = await call(usuarios, 'GET', {});
t(`GET usuarios (${r.body?.data?.length} filas)`, r.code === 200 && r.body.data.length >= 220, 'n=' + r.body?.data?.length);
t('El catálogo no expone contraseñas', !JSON.stringify(r.body).includes('password'));
r = await call(usuarios, 'POST', {}, { num_emp: 'TEST1', nombre: 'PRUEBA UNO', rol: 'operario', jefe_num: '240', gerente_num: '8101', password: 'Prueba123', email: 'p@gpa.com.mx' });
t('Crea usuario', r.code === 201 && r.body.ok, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,220)}`);
r = await call(login, 'POST', {}, { num_emp: 'TEST1', password: 'Prueba123' });
t('El usuario nuevo entra con su contraseña ya cifrada', r.code === 200 && r.body.ok, JSON.stringify(r.body).slice(0,200));
r = await call(usuarios, 'POST', {}, { num_emp: 'TEST1', nombre: 'DUPLICADO', rol: 'operario' });
t('Rechaza número duplicado (409)', r.code === 409);
r = await call(usuarios, 'PUT', {}, { num_emp: 'TEST1', puesto: 'Almacenista', email: '' });
t('Edita usuario y SÍ permite vaciar el email', r.code === 200 && r.body.data.email === null,
  'email=' + JSON.stringify(r.body?.data?.email));
r = await call(usuarios, 'PUT', {}, { num_emp: 'TEST1', activo: false });
t('Da de baja', r.code === 200 && r.body.data.activo === false);
r = await call(login, 'POST', {}, { num_emp: 'TEST1', password: 'Prueba123' });
t('Un usuario dado de baja no puede entrar (403)', r.code === 403, `HTTP ${r.code}`);
r = await call(usuarios, 'PUT', {}, { num_emp: 'TEST1', jefe_num: 'TEST1' });
t('No permite que sea su propio jefe', r.code === 400);

console.log('\n══════ REPORTE EXCEL ══════');
for (const [rol, quien] of [['admin','0000'],['gerente','8101'],['jefe','240']]) {
  r = await call(reporte, 'GET', { num_emp: quien, rol, desde: '2026-08-01', hasta: '2026-08-31' });
  const bytes = r.body?.length || 0;
  t(`Reporte rol=${rol} (${bytes} bytes)`, r.code === 200 && bytes > 3000,
    `HTTP ${r.code} · ${typeof r.body === 'object' && !Buffer.isBuffer(r.body) ? JSON.stringify(r.body).slice(0,240) : bytes + ' bytes'}`);
}
r = await call(reporte, 'GET', { num_emp: '0000', rol: 'admin' });
t('Reporte sin fechas usa el mes en curso', r.code === 200 && (r.body?.length || 0) > 3000, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,200)}`);
r = await call(reporte, 'GET', { num_emp: '140', rol: 'operario' });
t('Un operario no puede descargar el reporte (403)', r.code === 403);

console.log('\n══════ BORRADO TOTAL (sólo admin) ══════');
r = await call(limpiar, 'POST', {}, { num_emp: '240', password: 'Jefe2026', confirmacion: 'BORRAR TODO' });
t('BLOQUEA a un jefe (403)', r.code === 403, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,200)}`);
r = await call(limpiar, 'POST', {}, { num_emp: '8101', password: 'Gerente2026', confirmacion: 'BORRAR TODO' });
t('BLOQUEA a un gerente (403)', r.code === 403, `HTTP ${r.code}`);
r = await call(limpiar, 'POST', {}, { num_emp: '0000', password: 'incorrecta', confirmacion: 'BORRAR TODO' });
t('BLOQUEA con contraseña incorrecta (401)', r.code === 401, `HTTP ${r.code}`);
r = await call(limpiar, 'POST', {}, { num_emp: '0000', password: 'Admin2026', confirmacion: 'borrar' });
t('BLOQUEA sin la frase exacta (400)', r.code === 400, `HTTP ${r.code}`);

r = await call(registros, 'GET', { num_emp: '0000', rol: 'admin' });
const antesN = r.body?.data?.length || 0;
r = await call(limpiar, 'POST', {}, { num_emp: '0000', password: 'Admin2026', confirmacion: 'BORRAR TODO', alcance: 'todo' });
t(`El admin SÍ puede borrar (había ${antesN} registros)`, r.code === 200 && r.body.ok,
  `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,260)}`);
t('Reporta cuántos borró', (r.body?.data?.borrado?.horas_extras || 0) === antesN,
  JSON.stringify(r.body?.data?.borrado));
t('CONSERVA el catálogo de personal', (r.body?.data?.usuarios_conservados || 0) > 200,
  'usuarios=' + r.body?.data?.usuarios_conservados);
r = await call(registros, 'GET', { num_emp: '0000', rol: 'admin' });
t('Ya no quedan horas extras', (r.body?.data?.length || 0) === 0, 'quedan ' + r.body?.data?.length);
r = await call(sabados, 'GET', { num_emp: '0000', rol: 'admin' });
t('Ya no quedan sábados', (r.body?.data?.length || 0) === 0, 'quedan ' + r.body?.data?.length);
r = await call(login, 'POST', {}, { num_emp: '8101', password: 'Gerente2026' });
t('Después de borrar, los usuarios siguen entrando', r.code === 200 && r.body.ok, `HTTP ${r.code}`);

console.log('\n' + '═'.repeat(56));
console.log(fallos === 0 ? `✅ ${n} pruebas contra PostgreSQL real, todas correctas`
                          : `❌ ${fallos} de ${n} pruebas FALLARON`);
console.log('═'.repeat(56));
process.exit(fallos ? 1 : 0);

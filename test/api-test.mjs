process.env.DATABASE_URL = 'postgresql://postgres@localhost:5433/gpa';

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

console.log('\n══════ GET REGISTROS (los 500 de la consola) ══════');
for (const [rol, quien] of [['propios','8197'],['operario','140'],['jefe','8197'],['gerente','8101'],['admin','0000']]) {
  r = await call(registros, 'GET', { num_emp: quien, rol });
  t(`GET registros rol=${rol}`, r.code === 200 && r.body.ok, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,240)}`);
}

console.log('\n══════ POST REGISTROS (el error al enviar la solicitud) ══════');
r = await call(registros, 'POST', {}, {
  num_emp: '8197', nombre: JEFE.nombre, puesto: JEFE.puesto, ubicacion: JEFE.ubicacion, depto: JEFE.depto,
  horas_dia: 2, horas_semana: 2,
  causa_cat: 'Junta con mi jefe / Reunión de trabajo', causa_grupo: 'adm',
  causa_p1: 'Mi jefe directo', causa_p2: 'Tema urgente que no podía esperar',
  causa_p3: 'Requerimiento de dirección',
  causa_texto: 'Junta con mi jefe › Mi jefe directo › Tema urgente › Requerimiento de dirección',
  estado_lft: 'alerta', jefe_num: null, gerente_num: '8101'
});
t('POST registro de un JEFE (caso exacto de la captura)', r.code === 201 && r.body.ok,
  `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,300)}`);
const REG_ID = r.body?.data?.id;
t('El registro trae folio', !!REG_ID, 'id=' + REG_ID);
t('Guarda causa_grupo', r.body?.data?.causa_grupo === 'adm', 'causa_grupo=' + r.body?.data?.causa_grupo);
t('Ruta de autorización correcta (jefe pendiente, gerente na)',
  r.body?.data?.auth_jefe === 'pendiente' && r.body?.data?.auth_gerente === 'na',
  `auth_jefe=${r.body?.data?.auth_jefe} auth_gerente=${r.body?.data?.auth_gerente}`);

r = await call(registros, 'POST', {}, { num_emp: '8197', horas_dia: 1, causa_p3: 'x' });
t('Bloquea el segundo registro del mismo día (409)', r.code === 409, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,200)}`);

r = await call(registros, 'POST', {}, {
  num_emp: '140', nombre: OPE.nombre, puesto: OPE.puesto, ubicacion: OPE.ubicacion, depto: OPE.depto,
  horas_dia: 3, horas_semana: 3, causa_cat: 'Apoyo a Surtido', causa_grupo: 'op',
  causa_p1: '42', causa_p2: 'Volumen de pedidos inesperado', causa_p3: 'Pico de demanda',
  causa_texto: 'Apoyo a Surtido › 42', estado_lft: 'bloqueado', jefe_num: '240', gerente_num: '8101'
});
t('POST registro de un OPERARIO', r.code === 201 && r.body.ok, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,240)}`);
const REG_OPE = r.body?.data?.id;

r = await call(registros, 'POST', {}, { num_emp: '101', horas_dia: 5, causa_p3: 'x' });
t('Rechaza más de 3h por día (Art. 68)', r.code === 400);
r = await call(registros, 'POST', {}, { num_emp: '101', horas_dia: 2 });
t('Rechaza sin causa raíz', r.code === 400);
r = await call(registros, 'POST', {}, { num_emp: '99999', horas_dia: 2, causa_p3: 'x' });
t('Rechaza empleado inexistente con mensaje claro', r.code === 400, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,200)}`);

console.log('\n══════ MONITOR ══════');
for (const [rol, quien, min] of [['admin','0000',200],['gerente','8101',100],['jefe','240',15]]) {
  r = await call(monitor, 'GET', { num_emp: quien, rol });
  const cuantos = r.body?.data?.length || 0;
  t(`Monitor rol=${rol} (${cuantos} empleados)`, r.code === 200 && r.body.ok && cuantos >= min,
    `HTTP ${r.code} · ${cuantos} filas · ${JSON.stringify(r.body).slice(0,220)}`);
}
r = await call(monitor, 'GET', { num_emp: '8101', rol: 'gerente' });
const m8197 = (r.body.data || []).find(x => x.num_emp === '8197');
t('El gerente ve las horas de su jefe 8197', m8197 && Number(m8197.horas_semana) === 2,
  m8197 ? 'horas=' + m8197.horas_semana : 'no aparece 8197');
t('Los campos numéricos llegan como número, no texto', typeof m8197?.horas_semana === 'number',
  typeof m8197?.horas_semana);
r = await call(monitor, 'GET', { num_emp: '140', rol: 'operario' });
t('Operario no puede ver el monitor (403)', r.code === 403);

console.log('\n══════ AUTORIZAR ══════');
r = await call(autorizar, 'PUT', {}, { id: REG_ID, decision: 'autorizado', nivel: 'jefe', auth_num: '8101' });
t('Autoriza nivel jefe', r.code === 200 && r.body.ok, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,240)}`);
t('El estado final queda autorizado', r.body?.data?.estado_final === 'autorizado', 'estado=' + r.body?.data?.estado_final);
r = await call(autorizar, 'PUT', {}, { id: REG_ID, decision: 'rechazado', nivel: 'jefe', auth_num: '8101' });
t('No permite re-autorizar (409)', r.code === 409, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,200)}`);
r = await call(autorizar, 'PUT', {}, { id: REG_ID, decision: 'autorizado', nivel: 'gerente', auth_num: '0000' });
t('Avisa que no requiere nivel gerente (409)', r.code === 409, JSON.stringify(r.body).slice(0,200));
r = await call(autorizar, 'PUT', {}, { id: 'HE-NOEXISTE', decision: 'autorizado', nivel: 'jefe', auth_num: '1' });
t('404 en folio inexistente', r.code === 404);
r = await call(autorizar, 'PUT', {}, { id: REG_OPE, decision: 'x', nivel: 'jefe', auth_num: '1' });
t('Rechaza decisión inválida', r.code === 400);

console.log('\n══════ SÁBADOS ══════');
r = await call(sabados, 'POST', {}, {
  fecha_sabado: '2026-08-29', jefe_num: '8197', jefe_nombre: JEFE.nombre,
  ubicacion: JEFE.ubicacion, depto: JEFE.depto,
  personal: [{ num_emp: '146', nombre: 'IBARRA QUIROZ KEVIN' }, { num_emp: '164', nombre: 'PEREZ MORALES EDGARDO' }],
  causa_cat: 'Inventario Anual (conteo físico)', causa_grupo: 'adm',
  causa_p1: 'CEDIS', causa_p2: 'El conteo debe hacerse sin movimiento de mercancía',
  causa_p3: 'Política de control interno', causa_texto: 'x', gerente_num: '8101'
});
t('POST sábado', r.code === 201 && r.body.ok, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,260)}`);
const SAB_ID = r.body?.data?.id;
r = await call(sabados, 'POST', {}, { fecha_sabado: '2026-08-26', jefe_num: '8197', personal: [{num_emp:'146'}], causa_p3: 'x' });
t('Rechaza fecha que no es sábado', r.code === 400);
for (const [rol, quien] of [['admin','0000'],['gerente','8101'],['jefe','8197'],['operario','146']]) {
  r = await call(sabados, 'GET', { num_emp: quien, rol });
  t(`GET sábados rol=${rol} (${r.body?.data?.length ?? '?'} filas)`, r.code === 200 && r.body.ok,
    `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,240)}`);
}
r = await call(sabados, 'PUT', {}, { id: SAB_ID, decision: 'autorizado', auth_num: '8101' });
t('Autoriza sábado', r.code === 200 && r.body.ok, JSON.stringify(r.body).slice(0,200));

console.log('\n══════ USUARIOS ══════');
r = await call(usuarios, 'GET', {});
t(`GET usuarios (${r.body?.data?.length} filas)`, r.code === 200 && r.body.data.length === 220, 'n=' + r.body?.data?.length);
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

console.log('\n══════ DELETE REGISTROS ══════');
r = await call(registros, 'DELETE', { id: REG_OPE });
t('Elimina registro', r.code === 200 && r.body.ok, `HTTP ${r.code} · ${JSON.stringify(r.body).slice(0,200)}`);
r = await call(registros, 'DELETE', { id: REG_OPE });
t('404 al eliminar dos veces', r.code === 404);

console.log('\n' + '═'.repeat(56));
console.log(fallos === 0 ? `✅ ${n} pruebas contra PostgreSQL real, todas correctas`
                          : `❌ ${fallos} de ${n} pruebas FALLARON`);
console.log('═'.repeat(56));
process.exit(fallos ? 1 : 0);

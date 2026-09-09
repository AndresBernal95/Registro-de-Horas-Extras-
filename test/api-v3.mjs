/* ══════════════════════════════════════════════════════════════════
   PRUEBAS DE LA API v3 CONTRA UN POSTGRESQL REAL

   Ejecuta el código real de los endpoints —no una simulación— contra
   una base de datos de verdad. Es lo único que demuestra que el SQL
   está bien escrito: sintaxis, tipos, restricciones, índices únicos y
   la derivación del estado final.

   Cómo correrlas:
     1. Levanta un PostgreSQL y crea una base vacía.
     2. Ejecuta schema.sql en ella.
     3. export DATABASE_URL='postgresql://usuario@localhost:5432/gpa'
     4. node --import ./test/registrar-shim.mjs test/api-v3.mjs

   El cargador de registrar-shim.mjs sustituye el cliente de Neon por
   uno de PostgreSQL normal; los endpoints no se enteran.
   ══════════════════════════════════════════════════════════════════ */

let fallos = 0, n = 0;
const t = (nombre, ok, extra) => {
  n++;
  if (ok) console.log(`  ✅ ${nombre}`);
  else { fallos++; console.log(`  ❌ ${nombre}${extra ? '\n       → ' + extra : ''}`); }
};

function mkRes() {
  const o = { code: 0, body: null, headers: {} };
  o.setHeader = (k, v) => { o.headers[k] = v; };
  o.status = c => { o.code = c; return o; };
  o.json = b => { o.body = b; return o; };
  o.send = b => { o.body = b; return o; };
  o.end = () => o;
  return o;
}

async function call(mod, method, query, body, headers) {
  const { default: h } = await import(mod);
  const res = mkRes();
  await h({ method, query: query || {}, body, headers: headers || {}, socket: {} }, res);
  return res;
}

const registros = '../api/registros.js';
const aceptar   = '../api/aceptar.js';
const autorizar = '../api/autorizar.js';
const sabados   = '../api/sabados.js';
const monitor   = '../api/monitor.js';
const vencer    = '../api/vencer.js';
const reportePdf = '../api/reporte-pdf.js';

const { getDb, fechaMX, semanaMX } = await import('../lib/db.js');
const sql = getDb();

/* Fechas dentro de la semana en curso, para que el acumulado semanal
   se calcule sobre datos reales y no sobre semanas pasadas. */
const { ini } = semanaMX();
const dia = k => { const d = new Date(ini + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const LUN = dia(0), MAR = dia(1), MIE = dia(2), JUE = dia(3), SAB = dia(5);

/* Base limpia de movimientos; el catálogo de personal no se toca. */
await sql`DELETE FROM notificaciones`;
await sql`DELETE FROM horas_extras`;
await sql`DELETE FROM sabados_laborados`;

const JEFE = '240';      // CERVANTES — Jefe de CEDIS
const GER  = '8101';     // LOMELI — gerente del jefe
const OP1  = '140';      // NAVARRO — operario de 240
const OP2  = '215';      // CARRILLO — operario de 240
const AJENO = '43';      // COLMENERO — operario de OTRO jefe (8020)
const ADMIN = '0000';

console.log('\n══════ 1 · EL JEFE LEVANTA LA SOLICITUD ══════');

let r = await call(registros, 'POST', {}, {
  solicitante_num: OP1, fecha: LUN,
  personal: [{ num_emp: OP2, horas: 2 }], causa_p3: 'x'
});
t('Un operario NO puede levantar solicitudes', r.code === 403, JSON.stringify(r.body));

r = await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: LUN,
  personal: [{ num_emp: AJENO, horas: 2 }], causa_p3: 'x'
});
t('Un jefe NO puede solicitar a personal ajeno', r.code === 403, JSON.stringify(r.body));

r = await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: LUN,
  personal: [{ num_emp: OP1, horas: 4 }], causa_p3: 'x'
});
t('Rechaza más de 3 h en un día (Art. 66 LFT)', r.code === 400, JSON.stringify(r.body));

r = await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: LUN,
  personal: [{ num_emp: OP1, horas: 2 }]
});
t('Exige el análisis de causa raíz', r.code === 400);

r = await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: LUN,
  personal: [{ num_emp: OP1, horas: 2 }, { num_emp: OP2, horas: 3 }],
  causa_cat: 'Recepción de Mercancía', causa_grupo: 'op',
  causa_p1: 'Nacional', causa_p2: 'Llegó fuera de ventana',
  causa_p3: 'Citas programadas sin holgura', causa_texto: 'Recepción › Nacional'
}, { 'x-forwarded-for': '10.0.0.9', 'user-agent': 'prueba' });
t('El jefe levanta un lote de 2 personas', r.code === 201 && r.body.data.total === 2, JSON.stringify(r.body).slice(0, 300));
const LOTE = r.body.data;
t('El lote comparte un mismo folio de lote', new Set(LOTE.registros.map(x => x.lote_id)).size === 1);
t('La solicitud del jefe YA vale como autorización de nivel 1',
  LOTE.registros.every(x => x.auth_jefe === 'autorizado' && x.auth_jefe_num === JEFE));
t('Nadie rebasa 9 h todavía: no pasa por gerencia',
  LOTE.registros.every(x => x.auth_gerente === 'na'));
t('Las dos quedan esperando la firma del trabajador',
  LOTE.registros.every(x => x.acept_emp === 'pendiente'), JSON.stringify(LOTE.registros.map(x => x.acept_emp)));
t('El estado final sigue pendiente hasta que el trabajador firme',
  LOTE.registros.every(x => x.estado_final === 'pendiente'));

const REG1 = LOTE.registros.find(x => x.num_emp === OP1);

r = await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: LUN,
  personal: [{ num_emp: OP1, horas: 1 }], causa_p3: 'x'
});
t('No deja dos solicitudes vivas el mismo día para la misma persona', r.code === 409, JSON.stringify(r.body));

console.log('\n══════ 2 · SÓLO EL TRABAJADOR FIRMA LO SUYO ══════');

r = await call(aceptar, 'PUT', {}, { tipo: 'hora_extra', id: REG1.id, num_emp: JEFE, decision: 'aceptado' });
t('El jefe NO puede aceptar por su trabajador', r.code === 403, JSON.stringify(r.body));

r = await call(aceptar, 'PUT', {}, { tipo: 'hora_extra', id: REG1.id, num_emp: ADMIN, decision: 'aceptado' });
t('El administrador tampoco puede firmar por otro', r.code === 403, JSON.stringify(r.body));

r = await call(aceptar, 'GET', { tipo: 'hora_extra', id: REG1.id, num_emp: OP1 });
t('El trabajador recibe la leyenda antes de firmar', r.code === 200 && /Ley Federal del Trabajo/.test(r.body.data.leyenda));
t('La leyenda le dice que no está obligado', /NO ESTOY OBLIGADO/.test(r.body.data.leyenda));
const LEYENDA_VISTA = r.body.data.leyenda;

r = await call(aceptar, 'PUT', {}, {
  tipo: 'hora_extra', id: REG1.id, num_emp: OP1, decision: 'aceptado'
}, { 'x-forwarded-for': '10.0.0.5, 10.0.0.1', 'user-agent': 'Mozilla/5.0 prueba' });
t('El trabajador acepta', r.code === 200 && r.body.data.acept_emp === 'aceptado', JSON.stringify(r.body).slice(0, 300));
t('Al aceptar, la solicitud queda AUTORIZADA', r.body.data.estado_final === 'autorizado');
t('Se guardó el texto exacto que se le mostró', r.body.data.acept_emp_leyenda === LEYENDA_VISTA);
t('Se guardó el sello de fecha y hora', !!r.body.data.acept_emp_ts);
t('Se guardó la IP real detrás del proxy', r.body.data.acept_emp_ip === '10.0.0.5', r.body.data.acept_emp_ip);
t('Se guardó el sello de integridad SHA-256', /^[0-9a-f]{64}$/.test(r.body.data.acept_emp_hash || ''));

const { verificarSello } = await import('../lib/firma.js');
t('El sello de integridad verifica contra el renglón guardado', verificarSello(r.body.data));

r = await call(aceptar, 'PUT', {}, { tipo: 'hora_extra', id: REG1.id, num_emp: OP1, decision: 'rechazado' });
t('No se puede firmar dos veces la misma solicitud', r.code === 409, JSON.stringify(r.body));

console.log('\n══════ 3 · RECHAZO DEL TRABAJADOR ══════');

const REG2 = LOTE.registros.find(x => x.num_emp === OP2);
r = await call(aceptar, 'PUT', {}, {
  tipo: 'hora_extra', id: REG2.id, num_emp: OP2, decision: 'rechazado', nota: 'Tengo un compromiso'
});
t('El trabajador puede rechazar', r.code === 200 && r.body.data.acept_emp === 'rechazado');
t('La solicitud rechazada queda RECHAZADA', r.body.data.estado_final === 'rechazado');
t('Queda registrado que la rechazó el trabajador', r.body.data.rechazado_por === 'trabajador');
t('Se guarda el comentario opcional', r.body.data.acept_emp_nota === 'Tengo un compromiso');

r = await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: LUN,
  personal: [{ num_emp: OP2, horas: 2 }], causa_p3: 'x', causa_cat: 'c'
});
t('Tras un rechazo, el jefe SÍ puede volver a solicitar ese día', r.code === 201, JSON.stringify(r.body).slice(0, 200));
const REG2B = r.body.data.registros[0];

console.log('\n══════ 4 · LA HORA 10 PASA POR GERENCIA ══════');

/* OP1 lleva 2 h aceptadas. Se le suman 3 + 3 = 8 → 10 h en total. */
await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: MAR, personal: [{ num_emp: OP1, horas: 3 }], causa_p3: 'x', causa_cat: 'c'
});
await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: MIE, personal: [{ num_emp: OP1, horas: 3 }], causa_p3: 'x', causa_cat: 'c'
});
r = await call(registros, 'POST', {}, {
  solicitante_num: JEFE, fecha: JUE, personal: [{ num_emp: OP1, horas: 3 }], causa_p3: 'x', causa_cat: 'c'
});
const R10 = r.body.data.registros[0];
t('Al rebasar las 9 h, la solicitud pasa a gerencia',
  R10.auth_gerente === 'pendiente', `auth_gerente=${R10.auth_gerente} semana=${R10.horas_semana}`);
t('El acumulado se calculó en el servidor', Number(R10.horas_semana) === 11, `horas_semana=${R10.horas_semana}`);
t('El trabajador NO la ve hasta que gerencia responda',
  R10.acept_emp === 'na', `acept_emp=${R10.acept_emp}`);
t('El autorizador es el gerente del jefe solicitante', String(R10.gerente_num) === GER);

r = await call(autorizar, 'PUT', {}, { id: R10.id, decision: 'autorizado', nivel: 'gerente', auth_num: JEFE });
t('Quien levantó el lote NO puede autorizarlo', r.code === 403, JSON.stringify(r.body));

r = await call(autorizar, 'PUT', {}, { id: R10.id, decision: 'autorizado', nivel: 'gerente', auth_num: OP1 });
t('El propio trabajador no autoriza sus horas', r.code === 403);

r = await call(autorizar, 'PUT', {}, { id: R10.id, decision: 'autorizado', nivel: 'gerente', auth_num: GER });
t('El gerente autoriza', r.code === 200 && r.body.data.auth_gerente === 'autorizado', JSON.stringify(r.body).slice(0, 250));
t('Autorizada por gerencia, pasa a la bandeja del trabajador',
  r.body.data.acept_emp === 'pendiente', `acept_emp=${r.body.data.acept_emp}`);
t('Todavía NO queda autorizada: falta la firma',
  r.body.data.estado_final === 'pendiente', `estado_final=${r.body.data.estado_final}`);

r = await call(aceptar, 'PUT', {}, { tipo: 'hora_extra', id: R10.id, num_emp: OP1, decision: 'aceptado' });
t('Con la firma del trabajador queda autorizada', r.body.data.estado_final === 'autorizado');

console.log('\n══════ 5 · SÁBADOS CON FIRMA INDIVIDUAL ══════');

r = await call(sabados, 'POST', {}, {
  fecha_sabado: SAB, jefe_num: JEFE, personal: [{ num_emp: OP1 }, { num_emp: OP2 }, { num_emp: JEFE }],
  causa_cat: 'Inventario', causa_p3: 'Cierre de mes', causa_texto: 'Inventario'
});
t('El jefe convoca el sábado', r.code === 201, JSON.stringify(r.body).slice(0, 250));
const SABI = r.body.data;

let per = await sql`SELECT num_emp, acept, horas FROM sabados_personal WHERE sabado_id = ${SABI.id} ORDER BY num_emp`;
t('Se crea un renglón por persona convocada', per.length === 3, JSON.stringify(per));
t('Nadie firma hasta que gerencia autorice',
  per.filter(x => x.num_emp !== JEFE).every(x => x.acept === 'na'), JSON.stringify(per));
t('El jefe que se convoca a sí mismo queda autofirmado',
  per.find(x => x.num_emp === JEFE).acept === 'aceptado');
t('Cada persona queda con 5 h', per.every(x => Number(x.horas) === 5));

r = await call(aceptar, 'PUT', {}, { tipo: 'sabado', id: SABI.id, num_emp: OP1, decision: 'aceptado' });
t('No se puede firmar un sábado que gerencia no ha autorizado', r.code === 409, JSON.stringify(r.body));

r = await call(sabados, 'PUT', {}, { id: SABI.id, decision: 'autorizado', auth_num: JEFE });
t('El jefe no autoriza su propia solicitud de sábado', r.code === 403);

r = await call(sabados, 'PUT', {}, { id: SABI.id, decision: 'autorizado', auth_num: GER });
t('El gerente autoriza el sábado', r.code === 200);

per = await sql`SELECT num_emp, acept FROM sabados_personal WHERE sabado_id = ${SABI.id} ORDER BY num_emp`;
t('Autorizado el sábado, cada quien pasa a tener que firmar',
  per.filter(x => x.num_emp !== JEFE).every(x => x.acept === 'pendiente'), JSON.stringify(per));

r = await call(aceptar, 'PUT', {}, { tipo: 'sabado', id: SABI.id, num_emp: OP1, decision: 'aceptado' });
t('El trabajador firma el sábado', r.code === 200 && r.body.data.acept === 'aceptado');
t('El sábado también guarda su sello de integridad', /^[0-9a-f]{64}$/.test(r.body.data.acept_hash || ''));

r = await call(aceptar, 'PUT', {}, { tipo: 'sabado', id: SABI.id, num_emp: AJENO, decision: 'aceptado' });
t('Alguien no convocado no puede firmar el sábado', r.code === 404);

console.log('\n══════ 6 · LAS 5 H DEL SÁBADO CUENTAN PARA LAS 9 ══════');

const { acumuladoSemanal } = await import('../lib/db.js');
const acumOP1 = await acumuladoSemanal(sql, OP1, LUN);
t('El acumulado suma las horas de sábado autorizadas',
  acumOP1.sabados === 5, JSON.stringify(acumOP1));
t('El acumulado total incluye entre semana y sábado',
  acumOP1.total === acumOP1.horas_extras + 5, JSON.stringify(acumOP1));

const acumOP2 = await acumuladoSemanal(sql, OP2, LUN);
t('Lo rechazado por el trabajador NO cuenta al acumulado',
  acumOP2.horas_extras === 2, JSON.stringify(acumOP2));

r = await call(monitor, 'GET', { num_emp: JEFE, rol: 'jefe' });
const mOP1 = (r.body.data || []).find(x => String(x.num_emp) === OP1);
t('El monitor muestra las horas de sábado por separado',
  mOP1 && Number(mOP1.horas_sabado) === 5, JSON.stringify(mOP1));
t('El monitor cuenta lo que falta por firmar',
  mOP1 && typeof mOP1.por_firmar === 'number', JSON.stringify(mOP1));

console.log('\n══════ 7 · VENCIMIENTO DE LO NO RESPONDIDO ══════');

/* Se manda una solicitud a una fecha ya pasada, saltando la validación
   de la ventana, para comprobar el proceso nocturno. */
await sql`
  INSERT INTO horas_extras (fecha, hora_registro, num_emp, nombre, horas_dia, horas_semana,
    causa_cat, causa_p3, estado_lft, origen, solicitante_num, jefe_num,
    auth_jefe, auth_jefe_num, auth_gerente, acept_emp, estado_final)
  VALUES ('2020-01-06','08:00:00',${OP2},'X',2,2,'c','x','ok','jefe',${JEFE},${JEFE},
    'autorizado',${JEFE},'na','pendiente','pendiente')`;

r = await call(vencer, 'GET', { num_emp: OP1 });
t('Un operario no puede disparar el proceso de vencimiento', r.code === 403);

r = await call(vencer, 'GET', { num_emp: ADMIN });
t('El administrador sí puede ejecutarlo', r.code === 200, JSON.stringify(r.body).slice(0, 200));
t('Venció la solicitud vieja sin respuesta',
  r.body.data.horas_extras_sin_firma_del_trabajador >= 1, JSON.stringify(r.body.data));

const vencidas = await sql`SELECT estado_final, acept_emp, rechazado_por FROM horas_extras WHERE fecha = '2020-01-06'`;
t('Lo vencido NO queda como autorizado',
  vencidas[0].estado_final === 'vencido' && vencidas[0].acept_emp === 'vencido', JSON.stringify(vencidas[0]));

console.log('\n══════ 8 · EL FORMATO PDF ══════');

r = await call(reportePdf, 'GET', { num_emp: JEFE, rol: 'jefe', desde: LUN, hasta: SAB });
t('Un jefe NO puede descargar el formato firmable', r.code === 403, JSON.stringify(r.body));

r = await call(reportePdf, 'GET', { num_emp: OP1, rol: 'operario' });
t('Un operario tampoco', r.code === 403);

r = await call(reportePdf, 'GET', { num_emp: GER, rol: 'gerente', desde: LUN, hasta: SAB, empleado: OP1, agrupar: 'semana' });
t('El gerente sí lo descarga', r.code === 200, JSON.stringify(r.body).slice(0, 200));
t('Responde un PDF de verdad',
  Buffer.isBuffer(r.body) && r.body.slice(0, 4).toString() === '%PDF', String(r.body).slice(0, 60));
t('El archivo lleva el código del formato en el nombre',
  /GRL-RH-FO-2/.test(r.headers['Content-Disposition'] || ''), r.headers['Content-Disposition']);

r = await call(reportePdf, 'GET', { num_emp: GER, rol: 'gerente', desde: '2019-01-01', hasta: '2019-12-31' });
t('Sin movimientos en el periodo, avisa en lugar de entregar una hoja en blanco', r.code === 404);

console.log(`\n${'═'.repeat(56)}`);
console.log(`  ${n - fallos} correctas · ${fallos} fallidas   (${n} pruebas)`);
console.log('═'.repeat(56));

const { cerrar } = await import('./pg-shim.mjs');
await cerrar();
process.exit(fallos ? 1 : 0);

/* ══════════════════════════════════════════════════════════════════
   PRUEBAS DEL FLUJO v3 EN UN NAVEGADOR REAL

   Comprueba, de punta a punta y sin base de datos:
     · El operativo YA NO puede capturar horas: sólo ve su bandeja.
     · La solicitud del jefe le llega, con la leyenda de la LFT y los
       botones Acepto / Rechazo.
     · Al aceptar, la solicitud queda firmada y sale de la bandeja.
     · El jefe puede levantar una solicitud por lote con horas por
       persona, y el aviso de las 9 h aparece cuando corresponde.
     · El formato PDF sólo se ofrece a Gerencia y Administración.
     · No hay bucles de peticiones (el bug crítico de la v2.2).

   Uso:
     node test/mock-server.mjs 4321 &
     node test/v3-flujo.mjs
   ══════════════════════════════════════════════════════════════════ */
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4321';
let ok = 0, fallo = 0;
const errores = [];

function check(nombre, cond, detalle) {
  if (cond) { ok++; console.log(`  ✓ ${nombre}`); }
  else { fallo++; errores.push(nombre + (detalle ? ` — ${detalle}` : '')); console.log(`  ✗ ${nombre}${detalle ? ' — ' + detalle : ''}`); }
}

async function entrar(page, num, pass) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#loginNum', num);
  await page.fill('#loginPass', pass);
  await page.click('[data-act="login"]');
  await page.waitForSelector('#appScreen', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(700);
}

const navegador = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  .catch(() => chromium.launch());

/* ── 1 · OPERATIVO ──────────────────────────────────────────────── */
console.log('\n1. OPERATIVO (140) — bandeja de consentimiento');
{
  const ctx = await navegador.newContext();
  const page = await ctx.newPage();
  const consola = [];
  page.on('console', m => { if (m.type() === 'error') consola.push(m.text()); });
  page.on('pageerror', e => consola.push('pageerror: ' + e.message));

  await entrar(page, '140', 'GPA2026');

  const cuerpo = await page.textContent('#mainContent');
  check('No aparece el formulario de captura de horas',
    !(await page.locator('.hour-btn').count()), 'siguen los botones de horas');
  check('Aparece la solicitud que le levantó su jefe',
    /Solicitudes por responder/.test(cuerpo), 'no se pintó la bandeja');
  check('Muestra quién se la solicitó',
    /BERNAL PLASCENCIA ANDRES/.test(cuerpo));
  check('Sólo tiene la pestaña de Mis Horas',
    await page.locator('#tabsBar.hidden').count() === 1 ||
    await page.locator('#tabRegs:visible').count() === 0);

  /* Abre el modal de consentimiento */
  await page.click('[data-act="abrirFirma"]');
  await page.waitForSelector('#modalFirma:not(.hidden)', { timeout: 5000 });
  await page.waitForTimeout(600);
  const ley = await page.textContent('#firmaLeyenda');
  check('La leyenda cita la Ley Federal del Trabajo', /Ley Federal del Trabajo/.test(ley));
  check('La leyenda cita los artículos 66, 67 y 68', /66, 67 y 68/.test(ley));
  check('La leyenda dice que NO está obligado', /NO ESTOY OBLIGADO/.test(ley));
  check('La leyenda equipara el Acepto con la firma autógrafa', /firma autógrafa/.test(ley));
  check('Existen los botones ACEPTO y RECHAZO',
    await page.locator('#btnAcepto').isVisible() && await page.locator('#btnRechazo').isVisible());

  /* Acepta */
  await page.click('#btnAcepto');
  await page.waitForTimeout(1200);
  const despues = await page.textContent('#mainContent');
  check('Tras aceptar, la solicitud sale de la bandeja',
    /No tienes solicitudes por responder/.test(despues), 'la bandeja no se vació');

  /* Historial */
  await page.click('[data-act="toggleHist"]');
  await page.waitForTimeout(300);
  check('El historial marca que él aceptó',
    /TÚ ACEPTASTE/.test(await page.textContent('#fHist')));

  /* Sin bucles de peticiones */
  const antes = await (await fetch(URL + '/api/__stats')).json();
  const n1 = antes.data.registros || 0;
  await page.waitForTimeout(4000);
  const desp = await (await fetch(URL + '/api/__stats')).json();
  check('No hay bucle de peticiones (0 llamadas extra en 4 s)',
    (desp.data.registros || 0) - n1 === 0, `se dispararon ${(desp.data.registros || 0) - n1}`);

  check('Sin errores de JavaScript', consola.length === 0, consola.join(' | '));
  await ctx.close();
}

/* ── 2 · JEFE ───────────────────────────────────────────────────── */
console.log('\n2. JEFE (8197) — levantar la solicitud por lote');
{
  const ctx = await navegador.newContext();
  const page = await ctx.newPage();
  const consola = [];
  page.on('console', m => { if (m.type() === 'error') consola.push(m.text()); });
  page.on('pageerror', e => consola.push('pageerror: ' + e.message));

  await entrar(page, '8197', 'Jefe2026');
  await page.click('[data-tab="registros"]');
  await page.waitForTimeout(900);

  check('El jefe tiene el botón para solicitar horas',
    await page.locator('[data-act="abrirModalHE"]').count() > 0);
  check('El jefe NO puede descargar el formato PDF (es de gerencia)',
    await page.locator('[data-act="descargarPDF"]').count() === 0);

  await page.click('[data-act="abrirModalHE"]');
  await page.waitForSelector('#modalHE:not(.hidden)');
  await page.waitForTimeout(700);

  /* Agrega dos personas con horas distintas */
  await page.selectOption('#fh_personal_sel', '140');
  await page.click('[data-act="agregarPersonalHE"]');
  await page.waitForTimeout(200);
  await page.selectOption('#fh_personal_sel', '101');
  await page.click('[data-act="agregarPersonalHE"]');
  await page.waitForTimeout(200);

  check('Se agregaron los dos renglones de personal',
    await page.locator('.pers-fila').count() === 2);

  /* 101 ya trae 10.5 h de la semana: debe avisar del rebase */
  check('Avisa cuando alguien rebasa las 9 h semanales',
    /rebasa las 9h de la semana/i.test(await page.textContent('#hePersonalList')),
    await page.textContent('#hePersonalList'));

  /* Sube las horas de 140 a 3 */
  await page.selectOption('.pers-fila select[data-hepers="140"]', '3');
  await page.waitForTimeout(200);
  check('El acumulado proyectado se recalcula al cambiar las horas',
    /sem: 5h/.test(await page.textContent('#hePersonalList')),
    await page.textContent('#hePersonalList'));

  /* No deja enviar sin causa raíz */
  await page.click('[data-act="guardarHE"]');
  await page.waitForTimeout(400);
  check('Exige el análisis de causa raíz antes de enviar',
    /causa raíz/i.test(await page.textContent('#modalHEErr')));

  check('Sin errores de JavaScript', consola.length === 0, consola.join(' | '));
  await ctx.close();
}

/* ── 3 · ADMINISTRADOR ──────────────────────────────────────────── */
console.log('\n3. ADMINISTRADOR (0000) — formato PDF');
{
  const ctx = await navegador.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const consola = [];
  page.on('console', m => { if (m.type() === 'error') consola.push(m.text()); });
  page.on('pageerror', e => consola.push('pageerror: ' + e.message));

  await entrar(page, '0000', 'Admin2026');
  await page.click('[data-tab="reportes"]');
  await page.waitForTimeout(900);

  const rep = await page.textContent('#mainContent');
  check('Aparece la tarjeta del formato GRL-RH-FO-2', /GRL-RH-FO-2/.test(rep));
  check('Ofrece agrupar por día, semana o mes',
    await page.locator('#pdf_agr option').count() === 3);
  check('Ofrece elegir un trabajador o todos',
    await page.locator('#pdf_emp option').count() > 1);
  check('Advierte que el borrador no debe firmarse',
    /BORRADOR — SIN VALIDEZ/.test(rep));

  const descarga = page.waitForEvent('download', { timeout: 25000 });
  await page.click('[data-act="descargarPDF"]');
  const d = await descarga.catch(() => null);
  check('El PDF se descarga', !!d, 'no llegó el archivo');
  if (d) check('El archivo se llama con el código del formato',
    /GRL-RH-FO-2/.test(d.suggestedFilename()), d.suggestedFilename());

  check('Sin errores de JavaScript', consola.length === 0, consola.join(' | '));
  await ctx.close();
}

await navegador.close();

console.log(`\n${'═'.repeat(52)}`);
console.log(`  ${ok} correctas · ${fallo} fallidas`);
if (fallo) { console.log('\nFallas:'); errores.forEach(e => console.log('  · ' + e)); }
console.log('═'.repeat(52));
process.exit(fallo ? 1 : 0);

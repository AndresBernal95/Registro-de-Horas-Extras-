/* Pruebas automatizadas del frontend contra el servidor simulado.
   Verifican específicamente los bugs que se reportaron.
   Uso: node test/mock-server.mjs & node test/e2e.mjs */
import { chromium } from 'playwright';

const URL = 'http://localhost:4321';
let fallos = 0, pruebas = 0;

function check(nombre, ok, extra){
  pruebas++;
  if(ok) console.log(`  ✅ ${nombre}`);
  else { fallos++; console.log(`  ❌ ${nombre}${extra?' → '+extra:''}`); }
}

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args:['--no-sandbox'] });
const ctx = await nav.newContext({ viewport:{width:1280,height:900} });
const pg = await ctx.newPage();

const errores = [];
pg.on('pageerror', e => errores.push('pageerror: '+e.message));
pg.on('console', m => { if(m.type()==='error') errores.push('console: '+m.text()); });

const overlayVisible = () => pg.evaluate(()=>!document.getElementById('loadingOverlay').classList.contains('hidden'));
const stats = async () => (await (await pg.request.get(URL+'/api/__stats')).json()).data;

console.log('\n══ 1. LOGIN Y LOGO ══');
await pg.goto(URL, { waitUntil:'domcontentloaded' });
check('El logo de GPA aparece en el login',
  await pg.locator('#loginScreen img.login-logo').isVisible());
check('El logo es la imagen real de la empresa (PNG embebido)',
  (await pg.locator('#loginScreen img.login-logo').getAttribute('src')||'').startsWith('data:image/png;base64,'));
const logoOk = await pg.evaluate(()=>{ const i=document.querySelector('.login-logo'); return i.complete && i.naturalWidth>0; });
check('El PNG del logo se decodifica correctamente', logoOk);

await pg.fill('#loginNum','8197'); await pg.fill('#loginPass','malacontrasena');
await pg.click('#btnLogin'); await pg.waitForTimeout(400);
check('Rechaza credenciales incorrectas', await pg.locator('#loginErr').isVisible());
check('No queda el overlay pegado tras un login fallido', !(await overlayVisible()));

await pg.fill('#loginPass','Jefe2026'); await pg.click('#btnLogin');
await pg.waitForSelector('#appScreen', { state:'visible' });
await pg.waitForTimeout(700);
check('Entra con credenciales correctas', await pg.locator('#appScreen').isVisible());
check('El logo aparece en el encabezado', await pg.locator('.header-logo').isVisible());
check('El reloj corre', /\d{2}:\d{2}:\d{2}/.test(await pg.locator('#clockTime').textContent()));

console.log('\n══ 2. CAMBIO RÁPIDO DE PESTAÑAS (el bug del congelamiento) ══');
const antes = await stats();
/* 30 clics agresivos entre pestañas sin esperar a que terminen las
   peticiones: exactamente lo que congelaba la versión anterior. */
const orden = ['tabMon','tabRegs','tabSab','tabForm','tabRep','tabMon','tabForm','tabRegs','tabSab','tabRep'];
for(let i=0;i<3;i++) for(const t of orden){ await pg.click('#'+t,{force:true}); await pg.waitForTimeout(35); }
await pg.waitForTimeout(2500);
check('No queda el overlay de carga bloqueando la pantalla', !(await overlayVisible()));
check('La app sigue respondiendo tras 30 cambios de pestaña',
  await pg.evaluate(()=>document.getElementById('mainContent').children.length>0));
await pg.click('#tabMon'); await pg.waitForTimeout(1200);
check('El monitor se pinta correctamente después del estrés',
  await pg.locator('.monitor-table').isVisible());
const desp = await stats();
const totalPeticiones = Object.values(desp).reduce((a,b)=>a+b,0) - Object.values(antes).reduce((a,b)=>a+b,0);
check(`Sin avalancha de peticiones (${totalPeticiones} en 30 clics, límite 90)`, totalPeticiones < 90, totalPeticiones+' peticiones');
check('La tabla del monitor escapa el HTML de los nombres (sin XSS)',
  (await pg.content()).includes('&lt;script&gt;alert(1)&lt;/script&gt;'));

console.log('\n══ 3. BUCLE INFINITO EN "MIS HORAS" (empleado sin registros) ══');
await pg.click('.btn-logout'); await pg.waitForTimeout(300);
await pg.fill('#loginNum','140'); await pg.fill('#loginPass','GPA2026');
await pg.click('#btnLogin'); await pg.waitForSelector('#appScreen',{state:'visible'});
await pg.waitForTimeout(600);
const r0 = (await stats()).registros || 0;
await pg.waitForTimeout(4000);          // si hubiera bucle, aquí se dispararía
const r1 = (await stats()).registros || 0;
check(`Sin bucle infinito de peticiones (${r1-r0} llamadas en 4 s, límite 3)`, (r1-r0) <= 3, (r1-r0)+' llamadas');
check('Muestra el estado vacío en lugar de girar para siempre',
  (await pg.locator('#fHist').textContent()||'').includes('Aún no tienes'));
check('El operario sólo ve su pestaña de captura', !(await pg.locator('#tabsBar').isVisible()));
check('Sin overlay pegado', !(await overlayVisible()));

console.log('\n══ 4. CATEGORÍAS ADMINISTRATIVAS Y 5 PORQUÉS ══');
await pg.click('.hour-btn:nth-child(4)');   // 2h
await pg.waitForTimeout(250);
check('Se selecciona la cantidad de horas', await pg.locator('.hour-btn.selected').isVisible());
check('Existe el grupo visual "Administrativas"',
  (await pg.locator('#fArbol').textContent()||'').includes('Administrativas'));
const adminEsperadas = ['Junta con mi jefe','Inventario Anual','Cierre Contable','Auditoría Interna',
  'Capacitación o Curso','Reportes o Entregables','Soporte / Implementación','Atención a Cliente'];
const textoArbol = await pg.locator('#fArbol').textContent();
for(const c of adminEsperadas) check(`Categoría presente: ${c}`, textoArbol.includes(c));

await pg.click('button[data-val="junta_jefe"]'); await pg.waitForTimeout(220);
check('Paso 1 registra la categoría', (await pg.locator('#fArbol').textContent()).includes('¿Con quién fue la reunión?'));
await pg.click('button[data-act="setP1"]:first-of-type'); await pg.waitForTimeout(220);
await pg.click('button[data-act="setP2"]:first-of-type'); await pg.waitForTimeout(220);
check('Llega al paso de causa raíz', (await pg.locator('#fArbol').textContent()).includes('Causa raíz'));
await pg.click('button[data-act="setP3"]:first-of-type'); await pg.waitForTimeout(300);
check('Muestra el resumen de causa raíz identificada', await pg.locator('.causa-ok').isVisible());
check('El botón de enviar se habilita', !(await pg.locator('#fEnviar').isDisabled()));

console.log('\n══ 5. NO SE PIERDE EL ESTADO AL CAMBIAR LAS HORAS ══');
await pg.click('.hour-btn:nth-child(6)');   // 3h
await pg.waitForTimeout(300);
check('El árbol de causa raíz se conserva al cambiar las horas',
  await pg.locator('.causa-ok').isVisible());
check('El acumulado se recalcula', (await pg.locator('#fAcum').textContent()).includes('3h'));

console.log('\n══ 6. ENVÍO Y CANDADO DE UN REGISTRO POR DÍA ══');
await pg.click('#fEnviar'); await pg.waitForTimeout(1400);
check('Confirma el registro con un aviso', (await pg.locator('#toastWrap').textContent()||'').length>0);
check('Sin overlay pegado tras enviar', !(await overlayVisible()));
await pg.waitForTimeout(600);
check('Bloquea un segundo registro el mismo día',
  (await pg.locator('#fAviso').textContent()||'').includes('Ya registraste'));
check('El botón de enviar queda deshabilitado', await pg.locator('#fEnviar').isDisabled());

console.log('\n══ 7. SESIÓN Y MÓVIL ══');
await pg.reload({waitUntil:'domcontentloaded'}); await pg.waitForTimeout(900);
check('La sesión sobrevive a recargar la página', await pg.locator('#appScreen').isVisible());
await pg.setViewportSize({width:390,height:844}); await pg.waitForTimeout(400);
const desborde = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(`Sin desbordamiento horizontal en móvil (${desborde}px)`, desborde <= 2, desborde+'px');

console.log('\n══ 8. PANEL DE ADMIN ══');
await pg.setViewportSize({width:1280,height:900});
await pg.click('.btn-logout'); await pg.waitForTimeout(300);
await pg.fill('#loginNum','0000'); await pg.fill('#loginPass','Admin2026');
await pg.click('#btnLogin'); await pg.waitForSelector('#appScreen',{state:'visible'});
await pg.waitForTimeout(1400);
check('El admin entra al monitor', await pg.locator('.monitor-table').isVisible());
await pg.click('#tabRegs'); await pg.waitForTimeout(1200);
check('Ve las solicitudes', await pg.locator('.reg-card').first().isVisible());
check('Puede autorizar como gerencia',
  await pg.locator('button[data-nivel="gerente"]').first().isVisible());
await pg.locator('button[data-nivel="gerente"][data-dec="autorizado"]').first().click();
await pg.waitForTimeout(1000);
check('La autorización se refleja sin recargar la pestaña',
  (await pg.locator('#regWrap').textContent()||'').includes('AUTORIZADO'));
await pg.click('#tabUsr'); await pg.waitForTimeout(1100);
check('Ve el catálogo de usuarios', await pg.locator('table').isVisible());
await pg.click('#tabRep'); await pg.waitForTimeout(600);
check('Ve la pestaña de reportes con el botón de Excel', await pg.locator('#btnExcel').isVisible());
await pg.click('#tabSab'); await pg.waitForTimeout(1100);
check('Ve los sábados laborados', (await pg.locator('#mainContent').textContent()).includes('Sábado'));
await pg.click('button[data-act="abrirModalSab"]'); await pg.waitForTimeout(900);
check('Abre el modal de sábado con su árbol de 5 porqués',
  await pg.locator('#modalSab .porq-step').first().isVisible());
await pg.keyboard.press('Escape'); await pg.waitForTimeout(300);
check('Cierra el modal con Escape', !(await pg.locator('#modalSab').isVisible()));

console.log('\n══ 9. ERRORES DE CONSOLA ══');
/* Se ignora el 401 del intento de login incorrecto de la prueba 1:
   el navegador lo registra siempre, pero es el comportamiento esperado. */
const reales = errores.filter(e=>!/favicon|net::ERR_ABORTED|401 \(Unauthorized\)/i.test(e));
check(`Sin errores de JavaScript (${reales.length})`, reales.length===0, reales.slice(0,4).join(' | '));

await nav.close();
console.log(`\n${'═'.repeat(52)}`);
console.log(fallos===0 ? `✅ ${pruebas} pruebas, todas correctas` : `❌ ${fallos} de ${pruebas} pruebas fallaron`);
console.log('═'.repeat(52));
process.exit(fallos===0?0:1);

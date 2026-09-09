/* Servidor de prueba: sirve public/index.html y simula /api/* .
   Sirve para validar el frontend sin necesidad de Neon.
   Uso: node test/mock-server.mjs [puerto] */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
/* La leyenda se toma del módulo real: así la prueba valida el mismo
   texto que se guardaría en producción. */
import { leyendaConsentimiento, LEYENDA_VERSION } from '../lib/firma.js';

const PUERTO = Number(process.argv[2] || 4321);
const RAIZ = path.resolve(import.meta.dirname, '..');
const contadores = {};

const USUARIOS = [
  { num_emp:'8197', password:'Jefe2026', nombre:'BERNAL PLASCENCIA ANDRES', puesto:'Auditor de Procesos',
    ubicacion:'Corporativo Guadalajara', depto:'Procesos', rol:'jefe', jefe_num:'8101', gerente_num:'8101',
    email:'abernal@gpa.com.mx', activo:true, jefe_nombre:'LOMELI LLAMAS JOSE MIGUEL', gerente_nombre:'LOMELI LLAMAS JOSE MIGUEL' },
  { num_emp:'140', password:'GPA2026', nombre:'NAVARRO CASAS RAUL EVERARDO', puesto:'Almacenista',
    ubicacion:'Corporativo Guadalajara', depto:'Almacén', rol:'operario', jefe_num:'240', gerente_num:'8101',
    activo:true, jefe_nombre:'CERVANTES GONZALEZ JOSE GUADALUPE', gerente_nombre:'LOMELI LLAMAS JOSE MIGUEL' },
  { num_emp:'0000', password:'Admin2026', nombre:'Administrador', puesto:'Administrador del Sistema',
    ubicacion:'Corporativo Guadalajara', depto:'TI', rol:'admin', jefe_num:null, gerente_num:null, activo:true }
];

/* Empleado 140 arranca SIN registros: así se reproduce el caso que
   provocaba el bucle infinito en la versión anterior. */
let REGISTROS = [
  { id:'HE-AAAA1111', fecha:'2026-08-19', hora_registro:'19:30:00', ts:'2026-08-19T19:30:00Z',
    num_emp:'8', nombre:'CONTRERAS ORNELAS JAIME', puesto:'Auditor Interno de Inventarios',
    ubicacion:'Corporativo Guadalajara', depto:'Almacén', horas_dia:2.5, horas_semana:7.5,
    causa_cat:"Inventario Anual (conteo físico)", causa_grupo:'adm', causa_p1:'CEDIS "Guadalajara" / Túneles',
    causa_p2:'Diferencias que obligaron a recontar', causa_p3:"Movimientos durante el conteo",
    causa_texto:'Inventario Anual › CEDIS › Diferencias › Movimientos', estado_lft:'alerta',
    auth_jefe:'pendiente', auth_gerente:'na', acept_emp:'na', origen:'auto', estado_final:'pendiente' },
  { id:'HE-BBBB2222', fecha:'2026-08-20', hora_registro:'20:05:00', ts:'2026-08-20T20:05:00Z',
    num_emp:'101', nombre:"O'BRIEN <script>alert(1)</script> RUBEN", puesto:'Líder de Consolidación',
    ubicacion:'Sucursal Guadalajara', depto:'Almacén', horas_dia:3, horas_semana:10.5,
    causa_cat:'Junta con mi jefe / Reunión de trabajo', causa_grupo:'adm', causa_p1:'Mi gerente de área',
    causa_p2:"La reunión se extendió más de lo previsto", causa_p3:'Sin agenda ni tiempos definidos',
    causa_texto:'Junta › Gerente › Se extendió › Sin agenda', estado_lft:'bloqueado',
    auth_jefe:'na', auth_gerente:'pendiente', acept_emp:'na', origen:'auto', estado_final:'pendiente' }
];

/* v3 · Solicitud que el jefe 8197 ya levantó para el operario 140:
   es la que debe aparecerle en su bandeja con los botones de firma. */
REGISTROS.push({ id:'HE-FIRMA001', fecha:hoyLocal(), hora_registro:'08:15:00', ts:new Date().toISOString(),
    num_emp:'140', nombre:'NAVARRO CASAS RAUL EVERARDO', puesto:'Almacenista',
    ubicacion:'Corporativo Guadalajara', depto:'Almacén', horas_dia:2, horas_semana:2,
    causa_cat:'Recepción de Mercancía', causa_grupo:'op', causa_p1:'Nacional',
    causa_p2:'El proveedor llegó fuera de la ventana pactada', causa_p3:'Programación de citas sin holgura',
    causa_texto:'Recepción › Nacional › Fuera de ventana › Sin holgura', estado_lft:'alerta',
    lote_id:'LOTE-DEMO', origen:'jefe', solicitante_num:'8197',
    solicitante_nombre:'BERNAL PLASCENCIA ANDRES', solicitante_ts:new Date().toISOString(),
    jefe_num:'8197', gerente_num:'8101',
    auth_jefe:'autorizado', auth_jefe_num:'8197', auth_gerente:'na',
    acept_emp:'pendiente', estado_final:'pendiente' });

REGISTROS.push({ id:'HE-MIO00001', fecha:'2026-08-21', hora_registro:'19:00:00', ts:'2026-08-21T19:00:00Z',
    num_emp:'8197', nombre:'BERNAL PLASCENCIA ANDRES', puesto:'Auditor de Procesos',
    ubicacion:'Corporativo Guadalajara', depto:'Procesos', horas_dia:2, horas_semana:2,
    causa_cat:'Junta con mi jefe / Reunión de trabajo', causa_grupo:'adm', causa_p1:'Mi gerente de área',
    causa_p2:'Tema urgente que no podía esperar', causa_p3:'Requerimiento de dirección',
    causa_texto:'x', estado_lft:'alerta', jefe_num:null, gerente_num:'8101',
    auth_jefe:'na', auth_gerente:'pendiente', acept_emp:'aceptado', origen:'auto', estado_final:'pendiente' });

let MONITOR = [
  { num_emp:'8', nombre:'CONTRERAS ORNELAS JAIME', puesto:'Auditor Interno de Inventarios',
    ubicacion:'Corporativo Guadalajara', depto:'Almacén', rol:'operario', horas_semana:7.5, pendientes:1, total_regs:3 },
  { num_emp:'101', nombre:"O'BRIEN <script>alert(1)</script> RUBEN", puesto:'Líder de Consolidación',
    ubicacion:'Sucursal Guadalajara', depto:'Almacén', rol:'operario', horas_semana:10.5, pendientes:1, total_regs:4 },
  { num_emp:'140', nombre:'NAVARRO CASAS RAUL EVERARDO', puesto:'Almacenista',
    ubicacion:'Corporativo Guadalajara', depto:'Almacén', rol:'operario', horas_semana:2, horas_entre_semana:2,
    horas_sabado:0, pendientes:1, por_firmar:1, en_gerencia:0, total_regs:1, jefe_num:'8197', gerente_num:'8101' }
];

let SABADOS = [
  { id:'SAB-CCCC3333', fecha_sabado:'2026-08-29', jefe_num:'8197', jefe_nombre:'BERNAL PLASCENCIA ANDRES',
    ubicacion:'Corporativo Guadalajara', depto:'Procesos',
    personal:[{num_emp:'8',nombre:'CONTRERAS ORNELAS JAIME'},{num_emp:'140',nombre:'NAVARRO CASAS RAUL EVERARDO'}],
    causa_cat:'Inventario Anual (conteo físico)', causa_grupo:'adm',
    causa_p2:'El conteo debe hacerse sin movimiento de mercancía', causa_p3:'Política de control interno',
    horas_persona:5, auth_gerente:'pendiente',
    personal_detalle:[{num_emp:'8',nombre:'CONTRERAS ORNELAS JAIME',horas:5,acept:'na'},
                      {num_emp:'140',nombre:'NAVARRO CASAS RAUL EVERARDO',horas:5,acept:'na'}] }
];

/* Fecha local, no UTC: es el bug que se corrigió en la v2.2 y las
   pruebas no deben reintroducirlo. */
function hoyLocal(){
  const d=new Date();
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

const MIME = { '.html':'text/html; charset=utf-8', '.png':'image/png', '.ico':'image/x-icon', '.js':'text/javascript' };

function json(res, code, obj){
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Content-Length':b.length,'Cache-Control':'no-store'});
  res.end(b);
}

const srv = http.createServer((req,res)=>{
  const u = new URL(req.url, 'http://x');
  const ruta = u.pathname;

  if(ruta.startsWith('/api/')){
    const ep = ruta.slice(5);
    contadores[ep] = (contadores[ep]||0)+1;
    if(req.method==='OPTIONS'){ res.writeHead(204); return res.end(); }

    let cuerpo='';
    req.on('data',c=>cuerpo+=c);
    req.on('end',()=>{
      let b={}; try{ b = cuerpo?JSON.parse(cuerpo):{}; }catch{}

      if(ep==='login'){
        const us = USUARIOS.find(x=>x.num_emp===String(b.num_emp) && x.password===b.password);
        if(!us) return json(res,401,{ok:false,error:'Usuario o contraseña incorrectos'});
        const { password, ...limpio } = us;
        return json(res,200,{ok:true,user:limpio});
      }

      if(ep==='registros'){
        if(req.method==='GET'){
          const ne=u.searchParams.get('num_emp'), rol=u.searchParams.get('rol');
          if(rol==='propios'||rol==='operario') return json(res,200,{ok:true,data:REGISTROS.filter(r=>r.num_emp===ne)});
          return json(res,200,{ok:true,data:REGISTROS});
        }
        if(req.method==='POST'){
          /* v3 · el jefe levanta la solicitud para su personal (lote) */
          const sol=USUARIOS.find(x=>x.num_emp===String(b.solicitante_num));
          if(!sol) return json(res,403,{ok:false,error:'Tu usuario no está activo en el catálogo'});
          if(sol.rol==='operario') return json(res,403,{ok:false,error:'Tu rol no puede levantar solicitudes de horas extra.'});
          const personal=Array.isArray(b.personal)?b.personal:[];
          if(!personal.length) return json(res,400,{ok:false,error:'Agrega al menos una persona a la solicitud'});
          if(personal.some(x=>Number(x.horas)>3))
            return json(res,400,{ok:false,error:'No se pueden solicitar más de 3 horas por día (Art. 66 LFT).'});
          const dup=personal.filter(x=>REGISTROS.some(r=>String(r.num_emp)===String(x.num_emp)
            && r.fecha===b.fecha && ['pendiente','autorizado'].includes(r.estado_final)));
          if(dup.length) return json(res,409,{ok:false,error:'Ya hay una solicitud vigente para esa persona y ese día.'});

          const lote='LOTE-'+Math.random().toString(36).slice(2,8).toUpperCase();
          const ahora=new Date().toISOString();
          const creados=personal.map(x=>{
            const u=[...USUARIOS,...MONITOR].find(y=>String(y.num_emp)===String(x.num_emp))||{};
            const previas=Number((MONITOR.find(m=>String(m.num_emp)===String(x.num_emp))||{}).horas_semana||0);
            const semana=Math.round((previas+Number(x.horas))*10)/10;
            const esYo=String(x.num_emp)===String(sol.num_emp);
            const aGerencia=esYo||semana>9;
            return {
              id:'HE-'+Math.random().toString(16).slice(2,10).toUpperCase(),
              fecha:b.fecha, hora_registro:'08:00:00', ts:ahora,
              num_emp:String(x.num_emp), nombre:u.nombre||String(x.num_emp),
              puesto:u.puesto||'', ubicacion:u.ubicacion||'', depto:u.depto||'',
              horas_dia:Number(x.horas), horas_semana:semana,
              causa_cat:b.causa_cat, causa_grupo:b.causa_grupo, causa_p1:b.causa_p1,
              causa_p2:b.causa_p2, causa_p3:b.causa_p3, causa_texto:b.causa_texto,
              estado_lft:Number(x.horas)>=2.5?'alerta':'ok',
              lote_id:lote, origen:'jefe',
              solicitante_num:String(sol.num_emp), solicitante_nombre:sol.nombre, solicitante_ts:ahora,
              jefe_num:esYo?null:String(sol.num_emp), gerente_num:aGerencia?(sol.gerente_num||'0000'):(u.gerente_num||null),
              auth_jefe:esYo?'na':'autorizado', auth_jefe_num:esYo?null:String(sol.num_emp),
              auth_gerente:aGerencia?'pendiente':'na',
              acept_emp:esYo?'aceptado':(aGerencia?'na':'pendiente'),
              acept_emp_ts:esYo?ahora:null,
              estado_final:'pendiente'
            };
          });
          creados.forEach(r=>REGISTROS.unshift(r));
          const aGer=creados.filter(r=>r.auth_gerente==='pendiente').length;
          return json(res,201,{ok:true,data:{lote_id:lote,fecha:b.fecha,total:creados.length,
            a_gerencia:aGer,al_trabajador:creados.length-aGer,registros:creados}});
        }
        if(req.method==='DELETE'){
          const id=u.searchParams.get('id');
          REGISTROS=REGISTROS.filter(r=>r.id!==id);
          return json(res,200,{ok:true,data:{id}});
        }
      }

      /* v3 · consentimiento del trabajador */
      if(ep==='aceptar'){
        const tipo=String((req.method==='GET'?u.searchParams.get('tipo'):b.tipo)||'hora_extra');
        const id=String((req.method==='GET'?u.searchParams.get('id'):b.id)||'');
        const quien=String((req.method==='GET'?u.searchParams.get('num_emp'):b.num_emp)||'');

        if(tipo==='sabado'){
          const sab=SABADOS.find(x=>x.id===id);
          const per=sab&&(sab.personal_detalle||[]).find(x=>String(x.num_emp)===quien);
          if(!per) return json(res,404,{ok:false,error:'No estás convocado en esa solicitud de sábado'});
          if(sab.auth_gerente!=='autorizado') return json(res,409,{ok:false,error:'Esa solicitud de sábado todavía no la autoriza gerencia.'});
          if(per.acept!=='pendiente') return json(res,409,{ok:false,error:'Este sábado ya fue respondido.'});
          const ley=leyendaConsentimiento({tipo:'sabado',nombre:per.nombre,num_emp:per.num_emp,
            horas:per.horas,fecha:sab.fecha_sabado,solicitante:sab.jefe_nombre,causa:sab.causa_cat});
          if(req.method==='GET') return json(res,200,{ok:true,data:{tipo,id,fecha:sab.fecha_sabado,
            horas:per.horas,solicitante:sab.jefe_nombre,causa:sab.causa_cat,leyenda:ley,leyenda_version:LEYENDA_VERSION}});
          per.acept=b.decision; per.acept_ts=new Date().toISOString();
          per.acept_leyenda=ley; per.acept_nota=b.nota||null;
          return json(res,200,{ok:true,data:per});
        }

        const r=REGISTROS.find(x=>x.id===id);
        if(!r||String(r.num_emp)!==quien) return json(res,404,{ok:false,error:'La solicitud no existe o no es tuya'});
        if(r.acept_emp==='na') return json(res,409,{ok:false,error:'Esta solicitud todavía espera la autorización de gerencia.'});
        if(r.acept_emp!=='pendiente') return json(res,409,{ok:false,error:'Esta solicitud ya fue respondida.'});
        const ley=leyendaConsentimiento({tipo:'hora_extra',nombre:r.nombre,num_emp:r.num_emp,
          horas:r.horas_dia,fecha:r.fecha,solicitante:r.solicitante_nombre,causa:r.causa_texto||r.causa_cat});
        if(req.method==='GET') return json(res,200,{ok:true,data:{tipo,id:r.id,fecha:r.fecha,
          horas:r.horas_dia,solicitante:r.solicitante_nombre,causa:r.causa_texto,leyenda:ley,leyenda_version:LEYENDA_VERSION}});
        r.acept_emp=b.decision;
        r.acept_emp_ts=new Date().toISOString();
        r.acept_emp_leyenda=ley; r.acept_emp_ley_ver=LEYENDA_VERSION;
        r.acept_emp_hash='mock'+Math.random().toString(16).slice(2,18);
        r.acept_emp_nota=b.nota||null;
        r.estado_final = b.decision==='rechazado' ? 'rechazado'
          : (['na','autorizado'].includes(r.auth_jefe)&&['na','autorizado'].includes(r.auth_gerente)) ? 'autorizado' : 'pendiente';
        if(b.decision==='rechazado') r.rechazado_por='trabajador';
        return json(res,200,{ok:true,data:r});
      }

      if(ep==='monitor')  return json(res,200,{ok:true,data:MONITOR});
      if(ep==='sabados'){
        if(req.method==='POST'){
          const sol=USUARIOS.find(x=>x.num_emp===String(b.jefe_num))||{};
          const horas=Number(b.horas_persona||5);
          const n={...b, id:'SAB-'+Math.random().toString(16).slice(2,8).toUpperCase(),
            jefe_nombre:sol.nombre||b.jefe_num, horas_persona:horas, auth_gerente:'pendiente',
            personal_detalle:(b.personal||[]).map(x=>({num_emp:String(x.num_emp),nombre:x.nombre,
              horas, acept:String(x.num_emp)===String(b.jefe_num)?'aceptado':'na'}))};
          SABADOS.unshift(n); return json(res,201,{ok:true,data:n});
        }
        if(req.method==='PUT'){
          const s=SABADOS.find(x=>x.id===b.id);
          if(s){
            s.auth_gerente=b.decision;
            if(b.decision==='autorizado')
              (s.personal_detalle||[]).forEach(x=>{ if(x.acept==='na') x.acept='pendiente'; });
          }
          return json(res,200,{ok:true,data:s});
        }
        const ne=u.searchParams.get('num_emp'), rol=u.searchParams.get('rol');
        if(rol==='operario'||rol==='propios'){
          const mios=SABADOS.filter(s=>(s.personal_detalle||[]).some(x=>String(x.num_emp)===String(ne)))
            .map(s=>{ const p=(s.personal_detalle||[]).find(x=>String(x.num_emp)===String(ne));
              return {...s, mis_horas:p.horas, mi_acept:p.acept, mi_acept_ts:p.acept_ts||null}; });
          return json(res,200,{ok:true,data:mios});
        }
        return json(res,200,{ok:true,data:SABADOS});
      }
      if(ep==='usuarios') return json(res,200,{ok:true,data:USUARIOS.map(({password,...u2})=>({...u2}))});
      if(ep==='autorizar'){
        const r=REGISTROS.find(x=>x.id===b.id);
        if(!r) return json(res,404,{ok:false,error:'No encontrado'});
        if(b.nivel==='jefe'){ r.auth_jefe=b.decision; } else { r.auth_gerente=b.decision; }
        r.estado_final = b.decision==='rechazado' ? 'rechazado'
          : (['na','autorizado'].includes(r.auth_jefe) && ['na','autorizado'].includes(r.auth_gerente)) ? 'autorizado' : 'pendiente';
        return json(res,200,{ok:true,data:r});
      }
      /* /api/__stats devuelve cuántas veces se llamó cada endpoint:
         así se demuestra que no hay bucles de peticiones. */
      if(ep==='diagnostico') return json(res,200,{ok:true,estado:'TODO CORRECTO',problemas:[],info:{conexion:'correcta'}});
      if(ep==='limpiar'){
        if(String(b.num_emp)!=='0000') return json(res,403,{ok:false,error:'Sólo un administrador puede borrar los registros'});
        if(b.password!=='Admin2026') return json(res,401,{ok:false,error:'Usuario o contraseña incorrectos'});
        if(String(b.confirmacion||'').toUpperCase()!=='BORRAR TODO') return json(res,400,{ok:false,error:'Escribe BORRAR TODO'});
        const n1=REGISTROS.length, n2=SABADOS.length;
        REGISTROS=[]; SABADOS=[]; MONITOR=MONITOR.map(m=>({...m,horas_semana:0,pendientes:0}));
        return json(res,200,{ok:true,data:{alcance:b.alcance||'todo',borrado:{horas_extras:n1,sabados_laborados:n2,notificaciones:0},usuarios_conservados:USUARIOS.length}});
      }
      if(ep==='vencer') return json(res,200,{ok:true,data:{fecha_proceso:hoyLocal()}});

      /* El PDF se genera con la maqueta REAL (lib/pdf-formato.js), así la
         prueba del navegador comprueba también que el archivo se descarga. */
      if(ep==='reporte-pdf'){
        const rol=String(u.searchParams.get('rol')||'');
        if(rol!=='gerente'&&rol!=='admin')
          return json(res,403,{ok:false,error:'Este formato sólo lo pueden descargar Gerencia y Administración.'});
        const objetivo=String(u.searchParams.get('empleado')||'todos');
        const todas=u.searchParams.get('todas')==='1';
        const gente=MONITOR.filter(m=>objetivo==='todos'||String(m.num_emp)===objetivo);
        const movs=new Map();
        gente.forEach(g=>{
          const lista=REGISTROS
            .filter(r=>String(r.num_emp)===String(g.num_emp))
            .filter(r=>todas||r.estado_final==='autorizado')
            .map(r=>({...r,tipo:'Entre semana'}));
          if(lista.length) movs.set(String(g.num_emp),lista);
        });
        const conDatos=gente.filter(g=>movs.has(String(g.num_emp)));
        if(!conDatos.length)
          return json(res,404,{ok:false,error:'No hay horas extra registradas en ese periodo con los filtros elegidos.'});
        import('../lib/pdf-formato.js').then(async m=>{
          const buf=await m.construirFormatoPDF({
            personas:conDatos.map(g=>({...g,jefe_nombre:'CERVANTES GONZALEZ JOSE GUADALUPE',jefe_puesto:'Jefe de CEDIS'})),
            movimientos:movs,
            desde:u.searchParams.get('desde')||'2026-01-01',
            hasta:u.searchParams.get('hasta')||hoyLocal(),
            agrupar:u.searchParams.get('agrupar')||'semana',
            todas, folio:'RPT-MOCK-001',
            generadoPor:'MOCK (0000)', generadoEl:hoyLocal()
          });
          res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':buf.length});
          res.end(buf);
        }).catch(e=>json(res,500,{ok:false,error:String(e.message)}));
        return;
      }
      if(ep==='__stats') return json(res,200,{ok:true,data:contadores});

      return json(res,404,{ok:false,error:'Endpoint no simulado: '+ep});
    });
    return;
  }

  const archivo = ruta==='/' ? 'public/index.html'
    : ruta==='/index.html' ? 'public/index.html'
    : 'public'+ruta;
  const full = path.join(RAIZ, archivo);
  if(!full.startsWith(RAIZ) || !fs.existsSync(full)){
    const fb=path.join(RAIZ,'public/index.html');
    const d=fs.readFileSync(fb);
    res.writeHead(200,{'Content-Type':MIME['.html']}); return res.end(d);
  }
  const d=fs.readFileSync(full);
  res.writeHead(200,{'Content-Type':MIME[path.extname(full)]||'application/octet-stream'});
  res.end(d);
});

srv.listen(PUERTO,()=>console.log('Mock GPA en http://localhost:'+PUERTO));

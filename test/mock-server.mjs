/* Servidor de prueba: sirve public/index.html y simula /api/* .
   Sirve para validar el frontend sin necesidad de Neon.
   Uso: node test/mock-server.mjs [puerto] */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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
    auth_jefe:'pendiente', auth_gerente:'na', estado_final:'pendiente' },
  { id:'HE-BBBB2222', fecha:'2026-08-20', hora_registro:'20:05:00', ts:'2026-08-20T20:05:00Z',
    num_emp:'101', nombre:"O'BRIEN <script>alert(1)</script> RUBEN", puesto:'Líder de Consolidación',
    ubicacion:'Sucursal Guadalajara', depto:'Almacén', horas_dia:3, horas_semana:10.5,
    causa_cat:'Junta con mi jefe / Reunión de trabajo', causa_grupo:'adm', causa_p1:'Mi gerente de área',
    causa_p2:"La reunión se extendió más de lo previsto", causa_p3:'Sin agenda ni tiempos definidos',
    causa_texto:'Junta › Gerente › Se extendió › Sin agenda', estado_lft:'bloqueado',
    auth_jefe:'na', auth_gerente:'pendiente', estado_final:'pendiente' }
];

let MONITOR = [
  { num_emp:'8', nombre:'CONTRERAS ORNELAS JAIME', puesto:'Auditor Interno de Inventarios',
    ubicacion:'Corporativo Guadalajara', depto:'Almacén', rol:'operario', horas_semana:7.5, pendientes:1, total_regs:3 },
  { num_emp:'101', nombre:"O'BRIEN <script>alert(1)</script> RUBEN", puesto:'Líder de Consolidación',
    ubicacion:'Sucursal Guadalajara', depto:'Almacén', rol:'operario', horas_semana:10.5, pendientes:1, total_regs:4 },
  { num_emp:'140', nombre:'NAVARRO CASAS RAUL EVERARDO', puesto:'Almacenista',
    ubicacion:'Corporativo Guadalajara', depto:'Almacén', rol:'operario', horas_semana:0, pendientes:0, total_regs:0 }
];

let SABADOS = [
  { id:'SAB-CCCC3333', fecha_sabado:'2026-08-29', jefe_num:'8197', jefe_nombre:'BERNAL PLASCENCIA ANDRES',
    ubicacion:'Corporativo Guadalajara', depto:'Procesos',
    personal:[{num_emp:'8',nombre:'CONTRERAS ORNELAS JAIME'},{num_emp:'140',nombre:'NAVARRO CASAS RAUL EVERARDO'}],
    causa_cat:'Inventario Anual (conteo físico)', causa_grupo:'adm',
    causa_p2:'El conteo debe hacerse sin movimiento de mercancía', causa_p3:'Política de control interno',
    auth_gerente:'pendiente' }
];

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
          if(REGISTROS.some(r=>r.num_emp===String(b.num_emp)&&r.fecha===new Date().toISOString().slice(0,10)))
            return json(res,409,{ok:false,error:'Ya registraste tus horas extra hoy.'});
          const nuevo={...b,id:'HE-'+Math.random().toString(16).slice(2,10).toUpperCase(),
            fecha:new Date().toISOString().slice(0,10),hora_registro:'18:00:00',ts:new Date().toISOString(),
            auth_jefe:'pendiente',auth_gerente:'na',estado_final:'pendiente'};
          REGISTROS.unshift(nuevo);
          return json(res,201,{ok:true,data:nuevo});
        }
        if(req.method==='DELETE'){
          const id=u.searchParams.get('id');
          REGISTROS=REGISTROS.filter(r=>r.id!==id);
          return json(res,200,{ok:true,data:{id}});
        }
      }

      if(ep==='monitor')  return json(res,200,{ok:true,data:MONITOR});
      if(ep==='sabados'){
        if(req.method==='POST'){ const n={...b,id:'SAB-NEW',auth_gerente:'pendiente'}; SABADOS.unshift(n); return json(res,201,{ok:true,data:n}); }
        if(req.method==='PUT'){ const s=SABADOS.find(x=>x.id===b.id); if(s) s.auth_gerente=b.decision; return json(res,200,{ok:true,data:s}); }
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

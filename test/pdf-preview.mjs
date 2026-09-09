/* ══════════════════════════════════════════════════════════════════
   VISTA PREVIA DEL FORMATO GRL-RH-FO-2 SIN BASE DE DATOS

   Genera un PDF de muestra con datos inventados para revisar la
   maqueta (encabezado controlado, tabla, resumen, constancia de firma
   electrónica y bloque de firmas) sin levantar Neon ni desplegar.

     node test/pdf-preview.mjs              → salida.pdf
     node test/pdf-preview.mjs borrador     → salida-borrador.pdf
                                              (incluye horas no aceptadas
                                               y sale con la marca de agua)
   ══════════════════════════════════════════════════════════════════ */
import { writeFileSync } from 'node:fs';
import { construirFormatoPDF } from '../lib/pdf-formato.js';

const borrador = process.argv[2] === 'borrador';

const personas = [
  {
    num_emp: '140', nombre: 'NAVARRO CASAS RAUL EVERARDO', puesto: 'Almacenista',
    depto: 'Almacén', ubicacion: 'Corporativo Guadalajara',
    jefe_nombre: 'CERVANTES GONZALEZ JOSE GUADALUPE', jefe_puesto: 'Jefe de CEDIS'
  },
  {
    num_emp: '215', nombre: 'CARRILLO ESPINOZA CARLOS JAVIER',
    puesto: 'Líder de Recibo y Almacenaje', depto: 'Almacén',
    ubicacion: 'Corporativo Guadalajara',
    jefe_nombre: 'CERVANTES GONZALEZ JOSE GUADALUPE', jefe_puesto: 'Jefe de CEDIS'
  }
];

const he = (id, fecha, horas, cat, raiz, estado, acept) => ({
  id, fecha, horas_dia: horas, tipo: 'Entre semana',
  causa_cat: cat, causa_p3: raiz, causa_texto: cat,
  solicitante_nombre: 'CERVANTES GONZALEZ JOSE GUADALUPE', solicitante_num: '240',
  origen: 'jefe', auth_jefe_num: '240',
  auth_gerente: horas > 2.5 ? 'autorizado' : 'na',
  auth_gerente_num: horas > 2.5 ? '8101' : null,
  acept_emp: acept,
  acept_emp_ts: acept === 'aceptado' ? '2026-09-01T22:14:00.000Z' : null,
  acept_emp_hash: acept === 'aceptado'
    ? 'd41d8cd98f00b204e9800998ecf8427e0f2c1a9b7d3e5c8a1b2c3d4e5f607182' : null,
  acept_emp_nota: null, acept_emp_ley_ver: 'LFT-2026.1',
  estado_final: estado, rechazado_por: estado === 'rechazado' ? 'trabajador' : null
});

const uno = [
  he('HE-A1B2C3D4', '2026-09-01', 2, 'Recepción de Mercancía',
     'El proveedor entregó fuera de la ventana de recibo pactada', 'autorizado', 'aceptado'),
  he('HE-B2C3D4E5', '2026-09-02', 3, 'Surtido de Pedidos',
     'Pico de demanda de temporada no contemplado en el plan de personal', 'autorizado', 'aceptado'),
  he('HE-C3D4E5F6', '2026-09-03', 2.5, 'Inventario Cíclico',
     'Diferencias de conteo en la zona de químicos que obligaron a recontar el rack completo', 'autorizado', 'aceptado'),
  {
    id: 'SAB-11AA22BB', fecha: '2026-09-05', horas_dia: 5, tipo: 'Sábado',
    causa_cat: 'Surtido de Pedidos', causa_p3: 'Rezago acumulado por el cierre de mes',
    solicitante_nombre: 'CERVANTES GONZALEZ JOSE GUADALUPE', solicitante_num: '240',
    auth_gerente: 'autorizado', auth_gerente_num: '8101',
    acept_emp: 'aceptado', acept_emp_ts: '2026-09-03T18:40:00.000Z',
    acept_emp_hash: '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069',
    acept_emp_ley_ver: 'LFT-2026.1', estado_final: 'autorizado'
  },
  he('HE-D4E5F6A7', '2026-09-08', 3, 'Carga y Descarga',
     'Llegada simultánea de tres contenedores por retraso en aduana', 'autorizado', 'aceptado'),
  he('HE-E5F6A7B8', '2026-09-09', 1.5, 'Auditoría Interna o Externa',
     'Levantamiento de evidencia para la auditoría de certificación', 'autorizado', 'aceptado'),
  he('HE-A9B8C7D6', '2026-09-15', 2, 'Recepción de Mercancía',
     'Descarga de contenedor programada al cierre del turno', 'autorizado', 'aceptado'),
  he('HE-B8C7D6E5', '2026-09-16', 2, 'Acomodo de Mercancía',
     'Falta de ubicaciones libres en el rack selectivo', 'autorizado', 'aceptado'),
  he('HE-C7D6E5F4', '2026-09-22', 3, 'Surtido de Pedidos',
     'Cierre de mes con doble carga de pedidos de sucursal', 'autorizado', 'aceptado'),
  he('HE-D6E5F4A3', '2026-09-23', 2, 'Inventario Anual',
     'Preparación del conteo físico anual', 'autorizado', 'aceptado')
];

if (borrador) {
  uno.push(
    he('HE-99887766', '2026-09-07', 2, 'Reportes Urgentes',
       'Solicitud de información fuera de calendario', 'rechazado', 'rechazado'),
    he('HE-55443322', '2026-09-10', 1, 'Junta con mi jefe',
       'Junta convocada al cierre del turno', 'pendiente', 'pendiente')
  );
}

const dos = [
  he('HE-F6A7B8C9', '2026-09-04', 2, 'Recepción de Mercancía',
     'Falta de personal por incapacidad en el turno', 'autorizado', 'aceptado'),
  he('HE-A7B8C9D0', '2026-09-11', 1.5, 'Capacitación o Curso',
     'Curso de manejo de sustancias químicas fuera de horario', 'autorizado', 'aceptado')
];

const movimientos = new Map([['140', uno], ['215', dos]]);
movimientos.forEach(l => l.sort((a, b) => a.fecha < b.fecha ? -1 : 1));

const buf = await construirFormatoPDF({
  personas, movimientos,
  desde: '2026-09-01', hasta: '2026-09-30',
  agrupar: process.argv[3] || 'semana',
  todas: borrador,
  folio: 'RPT-DEMO-001',
  generadoPor: 'LOMELI LLAMAS JOSE MIGUEL (8101)',
  generadoEl: '09/09/2026 a las 14:05 h'
});

const nombre = borrador ? 'salida-borrador.pdf' : 'salida.pdf';
writeFileSync(nombre, buf);
console.log(`OK · ${nombre} · ${(buf.length / 1024).toFixed(1)} KB`);

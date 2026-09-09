# GPA Aqua — Sistema de Horas Extras · v3.0

> ### ⚠️ ANTES DE SUBIR NADA: EJECUTA LA MIGRACIÓN
> Abre el **SQL Editor de Neon**, pega **`migracion-v3.sql`** completo y
> ejecútalo. No borra datos, no toca contraseñas y se puede ejecutar
> las veces que quieras.
>
> Para confirmar que quedó bien, abre
> **`https://tu-app.vercel.app/api/diagnostico`** → debe decir
> `"estado": "TODO CORRECTO"`.
>
> Vercel instalará `pdfkit` solo, a partir de `package.json`.

---

## 1. Qué cambia y por qué

Hasta la v2.2 el operativo capturaba sus propias horas extra y su jefe
las autorizaba. Eso invierte el orden real de los hechos: en la
operación **es el jefe quien requiere que la persona se quede**, y el
artículo 68 de la Ley Federal del Trabajo es explícito en que el
trabajador **no está obligado** a laborar tiempo extraordinario.

A partir de la v3 el sistema refleja el hecho tal como ocurre: **la
empresa solicita y el trabajador consiente.**

```
JEFE levanta la solicitud por lote
  · fecha en que se trabajarán las horas
  · causa raíz (5 porqués)
  · personal + horas de cada quien (máx. 3 h/día, Art. 66 LFT)
        │
        │ el servidor recalcula el acumulado semanal real de cada persona
        │
        ├─ acumulado ≤ 9 h ───────────► bandeja del TRABAJADOR
        │   auth_jefe = 'autorizado'      (la solicitud ES la firma del jefe)
        │   acept_emp = 'pendiente'
        │
        └─ acumulado > 9 h (hora 10ª+) ──► GERENTE del solicitante
             auth_gerente = 'pendiente'
             acept_emp    = 'na'   ← el trabajador todavía no la ve
                   ├─ rechaza ──► fin
                   └─ autoriza ─► acept_emp pasa a 'pendiente'
                                  y llega a la bandeja del trabajador

TRABAJADOR:  [ ACEPTO ]  [ RECHAZO ]  + leyenda de la LFT
        ├─ ACEPTO  ─► autorizada · firma electrónica registrada
        ├─ RECHAZO ─► rechazada  · rechazado_por = 'trabajador'
        └─ sin responder al cerrar el día ─► vencida (no cuenta)
```

**Los sábados laborados siguen el mismo camino:** el jefe convoca, el
gerente autoriza y después **cada persona firma la suya por separado**.

---

## 2. Novedades, una por una

### El operativo ya no captura horas

Su pestaña **Mis Horas** dejó de ser un formulario y pasó a ser una
bandeja: ve su acumulado de la semana, las solicitudes que le
levantaron y su historial. Nada más.

### La solicitud del jefe, por lote

Un solo formulario con la fecha, la causa raíz (los mismos 5 porqués de
siempre) y la lista de personal con **las horas de cada quien**. Al
agregar a alguien se muestra su acumulado proyectado de la semana y se
avisa en el momento si va a rebasar las 9 h.

### La firma electrónica

Al presionar ACEPTO se guarda, además de la decisión:

| Dato | Para qué sirve |
|---|---|
| Texto íntegro de la leyenda mostrada | Demostrar **qué** firmó, no sólo que firmó |
| Versión de la leyenda (`LFT-2026.1`) | Si la redacción cambia, cada firma conserva la suya |
| Sello de fecha y hora | Cuándo |
| IP de origen y navegador | Desde dónde |
| Hash SHA-256 del renglón | Comprobar que nadie lo alteró después |

El hash se recalcula con `verificarSello()` y, si no coincide, el
registro se tocó en la base. La leyenda **no la arma el navegador**: la
pide al servidor, que devuelve el mismo texto que va a guardar. Si se
escribiera en el frontend, algún día cambiaría de un lado y no del
otro, y el expediente diría algo distinto de lo que la persona vio.

> **Nota legal.** La redacción de la leyenda debe validarla Capital
> Humano con el área jurídica antes de presentar el módulo. Lo que el
> sistema garantiza es la **evidencia técnica**; la suficiencia legal la
> dictamina jurídico. También hay que agregar al aviso de privacidad
> del personal que se conserva la IP de origen.

### Formato PDF firmable — GRL-RH-FO-2 Rev. 3

`Reportes → Descargar formato PDF`, **sólo para Gerencia y
Administración**. Un formato por trabajador, cada uno en hoja nueva
para desprenderlo y archivarlo en su expediente. Trae:

1. Encabezado controlado con logo, razón social, código, revisión y
   «Hoja X de Y» en todas las páginas.
2. Datos del trabajador: nombre, número, puesto, departamento, sucursal
   y jefe inmediato.
3. Periodo y criterios aplicados.
4. Detalle del tiempo extraordinario, agrupable **por día, por semana o
   por mes**, con una línea de trazabilidad bajo cada renglón: quién lo
   solicitó, quién lo autorizó, cuándo lo aceptó el trabajador y el
   sello de integridad.
5. Resumen del periodo y **desglose semanal** que marca las semanas que
   rebasaron las 9 h del artículo 66.
6. Constancia del consentimiento electrónico.
7. **Bloque de tres firmas**: el trabajador, su jefe inmediato y
   Recursos Humanos, cada una con línea de firma y fecha.
8. Pie con folio de emisión, quién lo generó, cuándo, foliado y leyenda
   de confidencialidad.

Si se marca *incluir pendientes, rechazadas y vencidas*, el documento
sale con la marca de agua **BORRADOR — SIN VALIDEZ**, para que nadie
firme una hoja con horas que el trabajador no aceptó.

### Las 5 h del sábado cuentan para las 9 de la semana

Antes el acumulado sólo miraba las horas entre semana, así que alguien
podía trabajar el sábado y otras 9 h y el sistema nunca disparaba la
autorización especial. Ahora el acumulado suma ambas, desde que el
gerente autoriza el sábado.

### Vencimiento automático

Una solicitud sin responder no puede quedarse abierta para siempre: al
cerrar el día programado deja de ser válida. Lo hace el cron de Vercel
configurado en `vercel.json` (00:00 hora de México). Lo vencido **no**
cuenta como autorizado ni suma al acumulado semanal.

### Reporte de Excel

Dos hojas nuevas: **Consentimientos** (quién firmó, cuándo, desde qué
IP y con qué sello) y **Sábados laborados**. La hoja Detalle gana las
columnas de solicitante, respuesta del trabajador, fecha de la firma y
quién rechazó.

---

## 3. Reglas que el servidor impone siempre

Viven en el backend, no en la pantalla: aunque alguien llame la API por
su cuenta, se rechaza con 403.

1. **Sólo el trabajador firma lo suyo.** Ni su jefe, ni su gerente, ni
   el administrador. Una firma que otro puede poner por ti no es firma.
2. Un jefe sólo solicita horas a su personal directo y a sí mismo.
3. Nadie autoriza un lote que él mismo levantó.
4. Nadie autoriza sus propias horas extra.
5. El nivel gerencia sólo lo firma el gerente autorizador del
   solicitante.
6. Las horas y el acumulado se recalculan contra la base; nunca se cree
   lo que manda el navegador.
7. Máximo **3 h por día** (Art. 66 LFT), bloqueo duro; a partir de la
   **hora 10 de la semana**, autorización especial de gerencia.

---

## 4. Cambios en la base de datos

Todo en `migracion-v3.sql`. Es aditiva e idempotente.

**`horas_extras`** — columnas nuevas: `lote_id`, `origen`,
`solicitante_num`, `solicitante_nombre`, `solicitante_ts`,
`rechazado_por` y el bloque de la firma (`acept_emp`, `acept_emp_ts`,
`acept_emp_ip`, `acept_emp_ua`, `acept_emp_leyenda`,
`acept_emp_ley_ver`, `acept_emp_hash`, `acept_emp_nota`).
`estado_final` acepta ahora `vencido` y `cancelado`.

**`sabados_personal`** — tabla nueva, un renglón por persona convocada,
porque cada quien firma por separado. El `personal` (JSONB) de
`sabados_laborados` se conserva por compatibilidad y se migra solo.

**Índice de un registro por día** — pasa a ser parcial:

```sql
CREATE UNIQUE INDEX uq_he_emp_dia_viva ON horas_extras(num_emp, fecha)
  WHERE estado_final IN ('pendiente','autorizado');
```

El anterior sólo excluía `rechazado`. Con el flujo nuevo, una solicitud
que el trabajador rechaza o que vence dejaría al empleado bloqueado el
resto del día: el jefe no podría levantar otra.

**Lo que ya estaba capturado** queda con `origen = 'auto'` y
`acept_emp = 'na'`: no se le pide firma retroactiva, sigue autorizándose
por el nivel de jefe y el reporte lo distingue.

---

## 5. Errores encontrados y corregidos en el camino

Salieron al probar contra un PostgreSQL real y un navegador real, no
por revisión a ojo.

| # | Problema | Por qué pasaba | Corrección |
|---|----------|----------------|------------|
| 1 | La migración marcaba los registros viejos como si los hubiera levantado un jefe | `ADD COLUMN ... DEFAULT 'jefe'` rellena los renglones existentes, así que `WHERE origen IS NULL` no encontraba ninguno | Se distinguen por lo que de verdad los caracteriza: no tienen solicitante (`WHERE solicitante_num IS NULL`) |
| 2 | La fecha salía como «Wed Sep 09» en la leyenda que firma el trabajador, y el PDF reventaba al agrupar por semana | Una columna `DATE` vuelve de la base como objeto `Date`, y `String(fecha).slice(0,10)` sobre un `Date` no da una fecha ISO | Función `aISO()` en `lib/db.js`; todo lo que sale de la base pasa por ahí |
| 3 | El sello de integridad no verificaba aunque nadie hubiera tocado el registro | Se calculaba con la fecha en texto y se recalculaba con la fecha como `Date`, y el `NUMERIC` volvía como `2.0` en vez de `2` | `sellarFirma()` normaliza fecha, sello de tiempo y números antes de calcular el hash |
| 4 | Los clics del árbol de causa raíz del jefe repintaban el árbol del sábado: el formulario parecía muerto | El despacho seguía siendo un `if` de dos ramas de cuando sólo había dos árboles | Tabla `ARBOL_DESTINO`; agregar un tercer árbol es una línea |
| 5 | El PDF salía con el triple de páginas, la mitad en blanco | El pie se dibuja por debajo del margen inferior y pdfkit creía que el texto no cabía: agregaba una hoja por cada pie | Se desactiva el margen inferior mientras se dibuja el pie |
| 6 | Un reporte de 40 hojas pesaba 1.7 MB de puro logo | Al pasar el `Buffer` del logo a `doc.image()`, pdfkit no lo reconoce como el mismo recurso y lo incrusta de nuevo en cada página | Se abre una vez con `doc.openImage()` y se reutiliza |
| 7 | La tabla del desglose semanal salía escalonada | El alto de cada celda se leía de `doc.y`, que se mueve con cada `doc.text()` | Cada fila se ancla en una `y` fija |
| 8 | Faltaba el resumen «Causa raíz identificada» en la solicitud del jefe | Ese bloque lo pintaba el formulario de captura, que se retiró | `pintarResumenHE()` |

---

## 6. Estructura del proyecto

```
gpa-horas-extras/
├── public/
│   ├── index.html          ← Frontend completo (un solo archivo)
│   └── logo.png
├── api/
│   ├── login.js            ← POST   /api/login
│   ├── registros.js        ← GET POST DELETE /api/registros   (POST = lote del jefe)
│   ├── aceptar.js          ← GET PUT /api/aceptar             ← NUEVO · firma del trabajador
│   ├── autorizar.js        ← PUT    /api/autorizar            (nivel gerencia)
│   ├── sabados.js          ← GET POST PUT DELETE /api/sabados
│   ├── usuarios.js         ← GET POST PUT DELETE /api/usuarios
│   ├── monitor.js          ← GET    /api/monitor
│   ├── reporte.js          ← GET    /api/reporte              (Excel .xlsx)
│   ├── reporte-pdf.js      ← GET    /api/reporte-pdf          ← NUEVO · GRL-RH-FO-2
│   ├── vencer.js           ← GET    /api/vencer               ← NUEVO · cron diario
│   ├── limpiar.js          ← POST   /api/limpiar              (borrado, sólo admin)
│   └── diagnostico.js      ← GET    /api/diagnostico
├── lib/
│   ├── db.js               ← Conexión Neon, fechas y acumulado semanal
│   ├── auth.js             ← Contraseñas (bcrypt) y permisos
│   ├── firma.js            ← NUEVO · leyenda, sello SHA-256, IP
│   ├── pdf-formato.js      ← NUEVO · maqueta del formato GRL-RH-FO-2
│   └── logo.js             ← NUEVO · logo embebido para el PDF
├── test/
│   ├── mock-server.mjs     ← Servidor simulado para probar sin Neon
│   ├── e2e.mjs             ← 82 pruebas del frontend (navegador real)
│   ├── v3-flujo.mjs        ← NUEVO · 27 pruebas del flujo de consentimiento
│   ├── api-test.mjs        ← 39 pruebas de lo que no cambió
│   ├── api-v3.mjs          ← NUEVO · 65 pruebas del flujo v3 contra PostgreSQL
│   ├── pdf-preview.mjs     ← NUEVO · genera el PDF de muestra sin base de datos
│   ├── pg-shim.mjs         ← NUEVO · puente Neon → PostgreSQL local
│   ├── registrar-shim.mjs  ← NUEVO ·   "
│   └── cargador-shim.mjs   ← NUEVO ·   "
├── schema.sql              ← Instalación limpia
├── migracion-v3.sql        ← Ejecutar si la base ya existía  ← NUEVO
├── migracion-v2.1.sql
├── vercel.json             ← Ahora incluye el cron de /api/vencer
└── package.json
```

---

## 7. Roles y permisos

| | Monitor | Solicitudes | Mis Horas | Sábados | Reportes | PDF firmable | Usuarios |
|---|---|---|---|---|---|---|---|
| **Operario** | — | — | bandeja + historial | — | — | — | — |
| **Jefe** | su equipo | solicita y ve | ✔ | solicita | Excel | — | — |
| **Gerente** | su estructura | autoriza hora 10+ | ✔ | autoriza | Excel | ✔ | — |
| **Admin** | todos | ambos niveles | — | todos | Excel | ✔ | ✔ |

---

## 8. Cómo probarlo antes de subirlo

**Sin base de datos, en el navegador:**

```bash
npm install
npm install --no-save playwright        # sólo para las pruebas

# Cada suite necesita el servidor simulado RECIÉN LEVANTADO: guarda su
# estado en memoria y la primera suite termina borrando los registros.
node test/mock-server.mjs 4321 &  sleep 2
node test/e2e.mjs                       # 82 pruebas
kill %1

node test/mock-server.mjs 4321 &  sleep 2
node test/v3-flujo.mjs                  # 27 pruebas del flujo nuevo
kill %1
```

Entra a <http://localhost:4321> con `140` / `GPA2026` (operativo),
`8197` / `Jefe2026` (jefe) o `0000` / `Admin2026`.

**Sólo el PDF, sin nada más:**

```bash
node test/pdf-preview.mjs            # salida.pdf
node test/pdf-preview.mjs borrador   # salida-borrador.pdf, con marca de agua
```

**Contra un PostgreSQL de verdad** (es lo que prueba el SQL):

```bash
npm install --no-save pg
createdb gpa && psql gpa -f schema.sql
export DATABASE_URL='postgresql://usuario@localhost:5432/gpa'
node --import ./test/registrar-shim.mjs test/api-v3.mjs    # 65 pruebas
node --import ./test/registrar-shim.mjs test/api-test.mjs  # 39 pruebas
```

Y para comprobar que la migración no rompe lo que ya está capturado:
restaura un respaldo de la base actual en una copia, ejecútale
`migracion-v3.sql` y revisa que los registros viejos queden con
`origen = 'auto'`.

**Sintaxis de todos los archivos:** `npm run check`

---

## 9. Pendientes para la siguiente versión

1. **Tokens de sesión firmados (JWT).** Hoy el backend confía en el
   `rol` que llega en la petición. Con una firma electrónica de por
   medio esto sube de prioridad: quien sepa llamar la API puede
   presentarse como otro empleado. **Es el único pendiente que yo
   pondría como bloqueante antes de presentar el módulo como firma.**
2. **Correos automáticos.** La tabla `notificaciones` ya se llena en
   cada paso del flujo; falta el endpoint que las envíe con Resend o
   SendGrid y las marque como leídas.
3. Ventana de regularización configurable (hoy son 2 días fijos en
   `VENTANA_RETRO`, en `lib/db.js`).
4. Historial de cambios de quién editó cada usuario y cuándo.
5. Respaldo periódico de las firmas y constancia de conservación
   (NOM-151) para el expediente.

---

Grupo GPA Aqua · Auditoría de Procesos · v3.0

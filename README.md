# GPA Aqua — Sistema de Horas Extras · v2.2

> ### ✅ LA v2.2 NO NECESITA TOCAR LA BASE DE DATOS
> Si ya ejecutaste `migracion-v2.1.sql`, sólo sube los archivos y listo.
> Verifica en `https://tu-app.vercel.app/api/diagnostico` que siga
> diciendo `"estado": "TODO CORRECTO"`.
>
> ### ⚠️ SI VIENES DE LA v2.0, HAZ ESTO PRIMERO
> Abre el **SQL Editor de Neon**, pega **`migracion-v2.1.sql`** completo y
> ejecútalo. Tarda un segundo, no borra datos y no toca contraseñas.
> Sin esa migración, al enviar una solicitud sale **«Error al guardar el
> registro»** y la pestaña Solicitudes devuelve error 500.
>
> Para confirmar que quedó bien, abre en el navegador:
> **`https://tu-app.vercel.app/api/diagnostico`** → debe decir
> `"estado": "TODO CORRECTO"`.

Sistema web cerrado con usuario y contraseña para el registro y autorización
de horas extras de Grupo GPA Aqua. Se despliega en **Vercel** con base de
datos **Neon Postgres**.

---

## 1. Qué cambió en esta versión

### Bugs corregidos

| # | Problema | Causa real | Corrección |
|---|----------|-----------|------------|
| 1 | **La página se congelaba** al moverse entre pestañas | Dos peticiones simultáneas: la primera que terminaba llamaba `hideLoading()` y la segunda dejaba el overlay visible para siempre. El overlay es `position:fixed; inset:0`, así que **capturaba todos los clics**: la app parecía muerta aunque seguía funcionando. | El overlay ahora lleva un **contador de peticiones activas** y un seguro que lo libera a los 30 s. Además todo `hideLoading()` va en un bloque `finally`, así que se ejecuta incluso si la petición falla. |
| 2 | **Bucle infinito** que tumbaba el navegador | `renderForm()` llamaba a `recargarMisHoras()` cuando el caché estaba vacío, y `recargarMisHoras()` volvía a llamar a `renderForm()`. Con un empleado **sin registros** el caché nunca dejaba de estar vacío → peticiones infinitas. | Bandera `misRegCargados` que corta el ciclo en la primera respuesta, incluso si falla o llega vacía. Verificado: **0 peticiones extra en 4 segundos**. |
| 3 | Contenido de una pestaña apareciendo en otra | Al cambiar de pestaña, la respuesta de la petición anterior seguía en camino y sobreescribía el contenido nuevo. | **Token de render**: cada carga se etiqueta y las respuestas obsoletas se descartan en silencio. |
| 4 | Botones que no respondían al primer clic | Los `onclick="setP2('texto con apóstrofo')"` inline rompían el HTML cuando el texto traía `'` o `"`. Un atributo roto = botón muerto. | **Delegación de eventos**: un solo listener y `data-*` atributos escapados. Ningún `onclick` inline quedó en el archivo. |
| 5 | «Ya registraste hoy» apareciendo el día equivocado | El servidor usaba `new Date().toISOString()` = fecha **UTC**. Después de las 18:00 en México, UTC ya está en el día siguiente. | Todas las fechas se calculan en `America/Mexico_City` con `Intl.DateTimeFormat`. Verificado: 19:30 del 23-ago se guarda como **23-ago**, no 24. |
| 6 | El botón de eliminar registro no hacía nada | El frontend llamaba `DELETE /api/registros`, pero ese método **no existía** en el endpoint: devolvía 405. | Se implementó `DELETE` con limpieza de notificaciones asociadas. |
| 7 | Autorizaciones que se resolvían solas | `estado_final` se escribía con la decisión de cualquier nivel. Si un registro requería gerencia y el jefe lo tocaba, quedaba resuelto sin el gerente. | El estado final se **deriva de ambos niveles** dentro del mismo `UPDATE` (atómico). |
| 8 | Horas de jefes y gerentes invisibles en el monitor | La consulta del admin filtraba `WHERE rol = 'operario'`. | Ahora incluye a todo el personal activo. |
| 9 | Imposible borrar el correo o el jefe de un usuario | `COALESCE(${campo}, campo)` conservaba el valor viejo al mandar vacío. | Sólo se actualizan los campos que realmente vienen en la petición. |
| 10 | Se perdía lo escrito al cambiar las horas | Cada clic reconstruía todo el DOM del formulario. | Repintado parcial: el árbol de causa raíz sólo se redibuja cuando cambia. |
| 11 | Se podía saltar el límite de 9 h semanales | El acumulado llegaba desde el navegador y el servidor lo creía. | El servidor **recalcula el acumulado** contra la base antes de insertar. |
| 12 | Doble registro con dos clics rápidos | Sólo la aplicación validaba el candado de un registro por día. | Índice único en la base de datos + botón que se deshabilita al enviar. |
| 13 | Las funciones podían no arrancar en Vercel | `package.json` usaba `import` sin declarar `"type": "module"`. | Declarado. |
| 14 | **Error 500 al guardar la solicitud y en Solicitudes** (corregido en v2.1) | Las consultas de Solicitudes, Monitor y Reporte referenciaban `horas_extras.jefe_num` y `horas_extras.gerente_num`, **columnas que esa tabla nunca tuvo** (sólo existían `auth_jefe_num` / `auth_gerente_num`). Y si la base venía de la v1, tampoco existía `causa_grupo`, que el alta sí escribe. | Se agregaron `jefe_num`, `gerente_num` y `causa_grupo` a la tabla (`migracion-v2.1.sql`) y el alta ahora las llena. Como efecto secundario bueno: `auth_jefe_num` se queda vacío hasta que alguien autoriza de verdad, así el expediente distingue **quién debía firmar** de **quién firmó** — lo que pide una auditoría. |
| 15 | Archivos estáticos rotos | `vercel.json` reescribía todo hacia `/public/index.html`, ruta que no existe en Vercel. | Reescritura corregida excluyendo `/api/`. |

### Cambios de la v2.2 — reglas de autorización

Detectados probando el sistema. **Ninguno requiere migración de base de datos.**

| Tema | Antes | Ahora |
|------|-------|-------|
| **Un jefe se autorizaba sus propias horas** | Su solicitud caía en la bandeja del nivel «jefe», donde él mismo la firmaba. | Las solicitudes de un jefe **saltan el nivel de jefe** y van siempre a su gerente (`auth_jefe = 'na'`, `auth_gerente = 'pendiente'`). |
| **Cualquiera podía autorizar cualquier folio** | El endpoint `/api/autorizar` no verificaba quién llamaba: ocultar el botón no impedía nada. | Se valida en el servidor: nadie firma lo propio, el nivel jefe sólo lo firma el jefe directo de esa persona, y el nivel gerencia sólo su gerente autorizador. El administrador puede ambos niveles, pero **tampoco lo suyo**. |
| **La ruta de autorización venía del navegador** | El cliente mandaba `jefe_num` y `gerente_num`; se podían alterar. | Se leen del catálogo en el servidor. Los datos del empleado (nombre, puesto, sucursal) también. |
| **Sábados** | El jefe no aparecía en la lista de personal a convocar. | Puede **incluirse a sí mismo** («— yo» al inicio de la lista), pero **no puede firmar su propia solicitud**: la autoriza su gerente, validado en el servidor. |

### Otras funciones nuevas de la v2.2

- **Nombre del proveedor en Recepción de Mercancía.** Después de elegir
  nacional o internacional aparece un paso de texto libre para capturarlo,
  y el árbol continúa con los porqués. Viaja al Excel dentro de la columna
  *Detalle* como `Nacional · Proveedor: <nombre>`. El mecanismo es genérico
  (`p1b` en el catálogo del árbol), así que agregar un campo libre a
  cualquier otra categoría es una línea de configuración.
- **Filtros en Usuarios** para el administrador: sucursal, puesto, rol y
  estatus (activos / bajas), combinables con el buscador.
- **Borrado de registros** en Reportes → *Mantenimiento*, sólo para el
  administrador. Permite borrar todo, sólo horas extras o sólo sábados.
  Pide **contraseña del administrador** y escribir la frase `BORRAR TODO`;
  las dos cosas se vuelven a validar en el servidor. **Nunca toca el
  catálogo de personal ni las contraseñas.** Sirve para entregar el sistema
  limpio después de las pruebas.
- Los filtros ya no se arrastran de una pestaña a otra.

### Mejoras de rendimiento

- **Login: 3 consultas → 1.** Antes se pedía el usuario, luego su jefe, luego
  su gerente, en secuencia. Ahora es un solo `LEFT JOIN`.
- **Monitor: 2 consultas + cruce en JavaScript → 1 consulta con agregación**
  en Postgres. Con cientos de empleados la diferencia es grande.
- **Conexión a Neon reutilizada** entre invocaciones tibias de la función
  (antes se abría una nueva en cada petición: 100–300 ms extra por llamada).
- **13 índices nuevos**, incluidos índices parciales para las autorizaciones
  pendientes. El monitor ya no recorre la tabla completa.
- **Autorización masiva en paralelo.** Antes era un `await` por registro
  dentro de un `for`: con 20 registros la pantalla se trababa.
- `alert()` reemplazado por avisos flotantes. `alert()` congela el hilo del
  navegador hasta que el usuario acepta.
- Actualizaciones en memoria: autorizar una solicitud ya no recarga la lista
  completa desde el servidor.

### Funciones nuevas

- **Logo oficial de GPA Aqua** embebido en el login y en el encabezado
  (el SVG dibujado a mano se eliminó).
- **10 categorías administrativas nuevas**, cada una con su árbol completo
  de 5 porqués, agrupadas visualmente aparte de las operativas:
  Junta con mi jefe · Inventario Anual · Cierre Contable/Administrativo ·
  Auditoría Interna o Externa · Capacitación o Curso · Reportes Urgentes ·
  Soporte/Implementación de Sistemas · Atención a Cliente o Proveedor ·
  Otra actividad administrativa. (Además se separó *Inventario Cíclico*
  de *Inventario Anual*.)
- **Reporte Excel real (.xlsx)** en `/api/reporte`, con filtros de fecha,
  sucursal y estado, y tres hojas: Detalle (con fila de totales), Resumen
  por empleado y Resumen por causa raíz.
- **Contraseñas cifradas con bcrypt**, sin migración manual (ver §4).
- La sesión sobrevive a recargar la página.
- Buscador en Monitor, Solicitudes y Usuarios; filtro por estado en Solicitudes.
- Los nombres se escapan antes de mostrarse: un nombre con HTML ya no
  puede inyectar código en la página.
- `Escape` cierra los modales; `Enter` envía el login.

---

## 2. Estructura del proyecto

```
gpa-horas-extras/
├── public/
│   ├── index.html        ← Frontend completo (un solo archivo)
│   └── logo.png          ← Logo GPA Aqua
├── api/
│   ├── login.js          ← POST   /api/login
│   ├── registros.js      ← GET POST DELETE /api/registros
│   ├── autorizar.js      ← PUT    /api/autorizar
│   ├── sabados.js        ← GET POST PUT DELETE /api/sabados
│   ├── usuarios.js       ← GET POST PUT DELETE /api/usuarios
│   ├── monitor.js        ← GET    /api/monitor
│   ├── reporte.js        ← GET    /api/reporte      (Excel .xlsx)
│   ├── limpiar.js        ← POST   /api/limpiar      (borrado, sólo admin)
│   └── diagnostico.js    ← GET    /api/diagnostico  (revisa la base)
├── lib/
│   ├── db.js             ← Conexión Neon + utilidades de fecha
│   └── auth.js           ← Contraseñas (bcrypt) y permisos
├── test/
│   ├── mock-server.mjs   ← Servidor simulado para probar sin Neon
│   ├── e2e.mjs           ← 79 pruebas del frontend (navegador real)
│   └── api-test.mjs      ← 91 pruebas de la API contra PostgreSQL real
├── schema.sql            ← Tablas, índices y catálogo de personal
├── migracion-v2.1.sql    ← Ejecutar si la base ya existía
├── vercel.json
├── package.json
├── .env.example
└── .gitignore
```

---

## 3. Despliegue

### Paso 1 — Base de datos en Neon

1. Entra a <https://neon.tech> y abre tu proyecto (o crea uno nuevo
   llamado `gpa-horas-extras`).
2. Abre el **SQL Editor**.
3. Pega y ejecuta **todo** el contenido de `schema.sql`.
   Es idempotente: puedes ejecutarlo las veces que quieras y **no borra
   datos ni sobreescribe contraseñas ya cifradas**.
4. Copia el **Connection String** (usa la opción *Pooled connection*).

### Paso 2 — GitHub

1. Sube todos los archivos **conservando la estructura de carpetas**.
2. Confirma que `.env` **no** se subió (ya está en `.gitignore`).

### Paso 3 — Vercel

1. **Add New Project** → selecciona el repositorio.
2. Framework Preset: **Other**. No configures comando de build.
3. **Environment Variables** → agrega:
   - Nombre: `DATABASE_URL`
   - Valor: tu connection string de Neon
   - Entornos: **Production, Preview y Development** (los tres).
4. **Deploy**.

Vercel instala `@neondatabase/serverless`, `bcryptjs` y `xlsx` solo, a
partir de `package.json`.

### Si el reporte de Excel se pasa del tiempo límite

Con muchos meses de datos, agrega esto a `vercel.json`:

```json
"functions": { "api/reporte.js": { "maxDuration": 60 } }
```

---

## 4. Contraseñas — cómo funciona el cifrado

Las contraseñas estaban guardadas en **texto plano**: cualquiera con acceso
a Neon las veía todas. Ahora se cifran con bcrypt, pero **sin pedirle nada
a nadie**:

- Si la contraseña guardada ya es un hash → se compara con bcrypt.
- Si sigue en texto plano → se compara directo y, **si es correcta, se
  guarda cifrada en ese mismo momento**.

Nadie tiene que cambiar su contraseña, no hay script de migración, y la
base se va cifrando sola conforme la gente entra. Para ver cuántas faltan:

```sql
SELECT COUNT(*) AS sin_cifrar FROM usuarios WHERE password NOT LIKE '$2%';
```

El cifrado sólo corre en el login (≈80 ms, una vez por sesión). No afecta
la velocidad de la aplicación.

---

## 5. Credenciales iniciales

| Rol | Usuario | Contraseña |
|-----|---------|-----------|
| Admin | `0000` | `Admin2026` |
| Gerente Cadena de Suministro | `8101` | `Gerente2026` |
| Jefes | su número | `Jefe2026` |
| Operarios | su número | `GPA2026` |

> **Antes de presentar el sistema a la institución**, cambia al menos la
> contraseña del usuario `0000` desde la pestaña **Usuarios**.

---

## 6. Roles y permisos

| | Monitor | Solicitudes | Mis Horas | Sábados | Reportes | Usuarios |
|---|---|---|---|---|---|---|
| **Operario** | — | — | ✔ | — | — | — |
| **Jefe** | su equipo | autoriza nivel 1 | ✔ | solicita | ✔ | — |
| **Gerente** | su estructura | autoriza nivel 2 | ✔ | autoriza | ✔ | — |
| **Admin** | todos | ambos niveles | — | todos | ✔ | ✔ |

**Flujo de autorización** (se decide en el servidor, según el rol real)

| Quién registra | Quién autoriza |
|---|---|
| Operario, hasta 9 h en la semana | Su **jefe directo** |
| Operario, de la hora 10 en adelante | Su **gerente** (autorización especial; el jefe no interviene) |
| Operario sin jefe asignado | Su **gerente**, para que no se quede sin revisar |
| **Jefe** | **Siempre su gerente.** Nunca pasa por el nivel de jefe |
| **Gerente** | El **administrador** (`0000`) |

**Reglas que el servidor impone siempre**

1. Nadie autoriza sus propias horas extra ni su propia solicitud de
   sábado. Tampoco el administrador.
2. El nivel «jefe» sólo lo firma el jefe directo de esa persona.
3. El nivel «gerencia» sólo lo firma su gerente autorizador.
4. El administrador puede firmar ambos niveles de cualquier persona,
   excepto los suyos.

Estas reglas viven en `api/autorizar.js` y `api/sabados.js`, no en la
pantalla: aunque alguien llame la API por su cuenta, se rechaza con 403.

**Límites legales aplicados** (LFT): máximo **3 h por día** (Art. 68,
bloqueo duro) y **9 h por semana** (Art. 66, dispara autorización especial).

---

## 7. Probar en local sin tocar Neon

```bash
npm install
node test/mock-server.mjs 4321      # servidor simulado en :4321
```

Abre <http://localhost:4321> y entra con `8197` / `Jefe2026`,
`140` / `GPA2026` o `0000` / `Admin2026`.

Para correr las 79 pruebas de navegador:

```bash
npm install playwright && npx playwright install chromium
node test/mock-server.mjs 4321 &
node test/e2e.mjs
```

Cubren el congelamiento de pestañas, el bucle infinito, las categorías
administrativas, el campo de proveedor, el candado de un registro por día,
el escapado de HTML, la vista móvil, los filtros de usuarios, el borrado
total y que un jefe no pueda autorizarse.

Para correr las 91 pruebas de la API contra un PostgreSQL de verdad
(no simulado), levanta una base local, ejecuta `schema.sql` en ella y
apunta `DATABASE_URL` ahí:

```bash
node test/api-test.mjs
```

Estas son las que importan para las reglas de autorización: verifican que
el servidor rechace con 403 los intentos de firmar lo propio o de firmar
a personal que no es tuyo.

Verificar la sintaxis de todos los archivos:

```bash
npm run check
```

---

## 8. Pendientes sugeridos para las siguientes versiones

1. **Correos automáticos** al autorizador. La tabla `notificaciones` ya se
   llena en cada solicitud; sólo falta un endpoint que las envíe con
   Resend o SendGrid y las marque como leídas.
2. **Tokens de sesión firmados.** Hoy el frontend guarda los datos del
   usuario y el backend confía en el `rol` que llega en la URL. Para uso
   interno es aceptable; antes de exponer el sistema fuera de la red de la
   empresa conviene un JWT con expiración.
3. **Historial de cambios (auditoría)** de quién editó cada usuario y cuándo.
4. **Vista mensual y comparativo por sucursal** en el monitor.
5. **Firma de conformidad del empleado** sobre las horas autorizadas.

---

Grupo GPA Aqua · Auditoría de Procesos · v2.2

# GPA Horas Extras — Guía de Despliegue Completo

## Estructura del proyecto

```
gpa-horas-extras/
├── public/
│   └── index.html          ← Frontend completo
├── api/
│   ├── login.js            ← POST /api/login
│   ├── registros.js        ← GET/POST /api/registros
│   ├── autorizar.js        ← PUT /api/autorizar
│   ├── sabados.js          ← GET/POST /api/sabados
│   ├── usuarios.js         ← GET/POST/PUT/DELETE /api/usuarios
│   └── monitor.js          ← GET /api/monitor
├── lib/
│   └── db.js               ← Conexión Neon Postgres
├── schema.sql              ← Tablas y datos iniciales
├── .env.example
├── package.json
└── vercel.json
```

## Pasos para desplegar

### 1. Crear base de datos en Neon
1. Entra a https://neon.tech y crea una cuenta
2. Crea un nuevo proyecto llamado `gpa-horas-extras`
3. Copia el **Connection String** (formato: `postgresql://user:pass@host/db`)
4. En el panel de Neon, abre el **SQL Editor**
5. Pega y ejecuta el contenido de `schema.sql`

### 2. Subir a GitHub
1. Crea un repo nuevo en https://github.com (ej. `gpa-horas-extras`)
2. Sube todos los archivos del ZIP manteniendo la estructura de carpetas
3. Asegúrate de que `.env` NO se suba (está en `.gitignore`)

### 3. Conectar con Vercel
1. Entra a https://vercel.com con tu cuenta de GitHub
2. Haz clic en **Add New Project**
3. Selecciona el repo `gpa-horas-extras`
4. En **Environment Variables** agrega:
   - `DATABASE_URL` = tu connection string de Neon
5. Haz clic en **Deploy**

### 4. Listo
Tu app estará disponible en `https://gpa-horas-extras.vercel.app`

## Credenciales iniciales
- **Admin:** usuario `0000` / contraseña `Admin2026`
- **Gerente CS:** usuario `8101` / contraseña `Gerente2026`
- **Jefes de almacén:** contraseña `Jefe2026`
- **Operarios:** contraseña `GPA2026`

## Notas
- El logo de GPA se carga desde `/public/logo.png` — reemplaza ese archivo con el logo oficial
- Los correos son simulados — para activarlos integra SendGrid o EmailJS en `/api/notificaciones.js`

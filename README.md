# Aplicacion Web con Roles y MySQL

Aplicacion web en Node.js + Express + EJS con autenticacion por sesion y control de acceso por roles. Incluye funcionalidades de carga de horarios (MXG) y analítica avanzada con filtros.

## Roles

- `admin`: puede agregar y modificar usuarios.
- `analista`: accede a panel de carga de horarios MXG, visualización de horarios en mapa de calor con filtros, y análisis de datos.
- `escuela`: accede a su panel funcional.

## Requisitos

- Node.js 20+
- MySQL 8+

## Configuracion

1. Copia `.env.example` a `.env` y ajusta valores.
2. Crea la base de datos en MySQL:

```sql
CREATE DATABASE match2_db;
```

## Instalacion

```bash
npm install
```

## Ejecucion

Modo desarrollo:

```bash
npm run dev
```

Modo produccion:

```bash
npm start
```

Al iniciar la aplicacion:

- Se sincroniza automáticamente todas las tablas Sequelize.
- Se valida compatibilidad de schema y se agregan columnas faltantes (incluidas `semNivel` y `asigTipo` en `mxg_schedule_imports`).
- Se crea el usuario administrador inicial con `ADMIN_USERNAME` y `ADMIN_PASSWORD` (si no existe).
- Se normalizan datos faltantes en tabla de usuarios.

## Flujo principal

- Ingresar en `/login` con el usuario admin.
- Ir a `/admin/users` para crear o editar usuarios `analista` o `escuela`.
- Cada usuario se redirige automaticamente a su panel segun su perfil.

## Funcionalidades del Analista

### Carga de Horarios MXG

- Acceder a `/analista/cargas` para cargar archivos Excel con formato MXG.
- El archivo se procesa automáticamente:
  - Se extraen todas las columnas incluyendo `SEM_NIVEL` y `ASIG_TIPO`.
  - Se valida que cada fila tenga asignatura y academia.
  - Se calcula automáticamente solicitudes de horas adicionales.
- El sistema almacena:
  - **Resumen**: total de registros, docentes únicos, solicitudes adicionales.
  - **Datos completos**: modalidad, plantel, carrera, grupo, horarios por día (L-S), datos del docente, y nuevos campos de nivel semestral y tipo de asignatura.

### Mapa de Calor de Horarios

- Acceder a `/analista/analitica` para visualizar mapa de calor de horarios.
- **Filtros disponibles**:
  - **Sem/Nivel**: filtra por nivel semestral (`SEM_NIVEL` del MXG)
  - **Academia**: filtra por academia (`ACADEMIADESC`)
  - **Asig. Tipo**: filtra por tipo de asignatura (`ASIG_TIPO` del MXG)
- El mapa muestra conflictos de horarios (docentes asignados múltiples grupos simultáneamente) con código de colores.
- Los filtros son dinámicos: solo muestran opciones presentes en los datos cargados.

## Estructura de Datos — MXG

Columnas procesadas del archivo Excel:
- `MODALIDAD`, `PLANTEL`, `PLANTELDESC`, `CICLO`, `CARRERA`, `CARRERADESC`, `PLANESTUDIO`
- `GRUPO`, `TURNO`, `ASIGNATURA`, `ASIGNATURADESC`, `ACADEMIADESC`
- **`SEM_NIVEL`** ← Nivel semestral (nuevo filtro)
- **`ASIG_TIPO`** ← Tipo de asignatura (nuevo filtro)
- `NUMEMP`, `RFC2`, `NOMBRE2`, `HRSASIG`, `HRSNECESARIAS`
- `LUNES`, `MARTES`, `MIERCOLES`, `JUEVES`, `VIERNES`, `SABADO`
- `INCIDENCIA`

## Auto-migración de Schema

El sistema detecta automáticamente columnas faltantes en las tablas y las crea al iniciar:
- Verifica estructura actual con `describeTable()`.
- Compara con definiciones del modelo.
- Agrega nuevas columnas si no existen (con valores por defecto `NULL`).
- Sin necesidad de migraciones manuales Sequelize.

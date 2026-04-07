# Aplicacion Web con Roles y MySQL

Aplicacion web en Node.js + Express + EJS con autenticacion por sesion y control de acceso por roles.

## Roles

- `admin`: puede agregar y modificar usuarios.
- `analista`: accede a su panel funcional.
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

- Se sincroniza la tabla `users`.
- Se crea el usuario administrador inicial con `ADMIN_USERNAME` y `ADMIN_PASSWORD` (si no existe).

## Flujo principal

- Ingresar en `/login` con el usuario admin.
- Ir a `/admin/users` para crear o editar usuarios `analista` o `escuela`.
- Cada usuario se redirige automaticamente a su panel segun su perfil.

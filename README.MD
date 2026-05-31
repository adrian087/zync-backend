# ⚙️ Zync Backend - API REST & WebSockets

![NodeJS](https://img.shields.io/badge/Node.js-339933?style=for-the-badge\&logo=nodedotjs\&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge\&logo=express\&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge\&logo=mysql\&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-010101?style=for-the-badge\&logo=socketdotio\&logoColor=white)

Este repositorio contiene el código fuente del **Servidor, la API REST y el motor de Tiempo Real** de Zync, una red social multiplataforma.

Desarrollado como parte del **Trabajo de Fin de Grado (TFG)** en Desarrollo de Aplicaciones Multiplataforma, este backend está diseñado para soportar alta concurrencia, garantizando la seguridad de los datos y la inmediatez en las comunicaciones.

---

## ✨ Características Principales

### 📡 API RESTful

Endpoints estructurados para la gestión de:

* Usuarios
* Publicaciones (*Zyncs*)
* Historias (*Drops*)
* Relaciones sociales (*Followers* y bloqueos)

### ⚡ Motor en Tiempo Real

Implementación de WebSockets bidireccionales mediante **Socket.io** para:

* Mensajería privada 1 a 1
* Actualización instantánea de likes
* Sincronización de comentarios en tiempo real
* Eventos sociales entre usuarios

### 🔐 Seguridad y Autenticación Stateless

* Protección de rutas mediante **JSON Web Tokens (JWT)**.
* Contraseñas almacenadas utilizando **Bcrypt**.
* Prevención de inyección SQL mediante consultas parametrizadas.
* Validación de peticiones antes de acceder a recursos protegidos.

### 🗃️ Integridad Referencial

Base de datos MySQL diseñada con:

* Claves foráneas.
* Restricciones de integridad.
* Eliminación en cascada (`ON DELETE CASCADE`) para evitar registros huérfanos.

### 📦 Gestión Multimedia

Procesamiento asíncrono de archivos utilizando **Multer** para:

* Avatares de usuario.
* Imágenes de publicaciones.
* Gestión eficiente de almacenamiento.

### 🚀 Paginación Dinámica

Consultas SQL optimizadas mediante:

```sql
LIMIT
OFFSET
```

Permitiendo:

* Scroll infinito en clientes móviles.
* Menor consumo de ancho de banda.
* Mejor rendimiento en dispositivos con recursos limitados.

---

## 🛠️ Stack Tecnológico

| Categoría               | Tecnología     |
| ----------------------- | -------------- |
| Entorno de ejecución    | Node.js        |
| Framework Web           | Express.js     |
| Base de datos           | MySQL 8.0+     |
| Driver SQL              | mysql2/promise |
| Tiempo real             | Socket.io      |
| Autenticación           | jsonwebtoken   |
| Hash de contraseñas     | bcrypt         |
| Gestión de archivos     | multer         |
| Utilidades              | path           |
| Seguridad de peticiones | cors           |

---

## 🏗️ Arquitectura y Flujo de Datos

El servidor sigue un patrón basado en **Controladores y Middlewares**.

### 1️⃣ Middlewares de Seguridad

Cada petición a rutas privadas pasa por un middleware encargado de:

* Verificar la firma del JWT.
* Validar la identidad del usuario.
* Autorizar el acceso al recurso solicitado.

### 2️⃣ Consultas SQL Optimizadas

Se aprovecha la potencia del motor MySQL mediante:

* `LEFT JOIN`
* Subconsultas
* Funciones agregadas (`COUNT`, `SUM`, etc.)
* Consultas condicionales

De esta forma se reduce la carga sobre el Event Loop de Node.js.

### 3️⃣ Manejo de Errores

Toda la lógica asíncrona se encuentra encapsulada en bloques:

```javascript
try {
  // lógica
} catch (error) {
  // gestión del error
}
```

Permitiendo devolver respuestas HTTP coherentes:

| Código | Significado           |
| ------ | --------------------- |
| 400    | Bad Request           |
| 401    | Unauthorized          |
| 403    | Forbidden             |
| 404    | Not Found             |
| 500    | Internal Server Error |

---

## ⚙️ Instalación y Configuración Local

### Prerrequisitos

* Node.js v16 o superior.
* MySQL Server en local o remoto.

---

### 1. Clonar el repositorio

```bash
git clone https://github.com/tu_usuario/zync-backend.git
cd zync-backend
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

Crear un archivo `.env` en la raíz del proyecto:

```env
# Configuración del Servidor
PORT=3000

# Configuración MySQL
DB_HOST=localhost
DB_USER=root
DB_PASS=tu_contraseña_mysql
DB_NAME=zync_db

# Seguridad JWT
JWT_SECRET=tu_clave_secreta_super_segura
```

### 4. Configurar la base de datos

Ejecuta el script SQL de creación de tablas incluido en el proyecto (o adjunto en la documentación del TFG) para generar toda la estructura relacional necesaria.

### 5. Iniciar el servidor

#### Producción

```bash
node index.js
```

#### Desarrollo

```bash
npm run dev
```

---

## ☁️ Despliegue en Producción (DevOps)

Actualmente el backend se encuentra desplegado utilizando una arquitectura basada en VPS Linux.

### 🖥️ Host

Servidor Privado Virtual (VPS) basado en Linux.

### 🔄 Process Manager

**PM2** se encarga de:

* Mantener la aplicación activa 24/7.
* Reiniciar automáticamente ante fallos.
* Monitorizar procesos Node.js.

### 🌐 Proxy Inverso

**Nginx** configurado para:

* Redirigir tráfico HTTP y HTTPS.
* Gestionar certificados SSL.
* Actuar como capa de seguridad adicional.

### 🛡️ Seguridad Perimetral

**Cloudflare** proporciona:

* Ocultación de la IP real del servidor.
* Protección anti-DDoS.
* Certificados SSL/TLS.
* Caché y optimización de tráfico.

---

## 📁 Estructura del Proyecto

```text
zync-backend/
│
├── controllers/
├── middleware/
├── routes/
├── uploads/
├── database/
├── config/
├── socket/
│
├── index.js
├── package.json
├── .env
└── README.md
```

---

## 📄 Licencia

Este proyecto fue desarrollado con fines académicos como parte del **Trabajo de Fin de Grado (TFG)** del ciclo de **Desarrollo de Aplicaciones Multiplataforma (DAM)**.

Su uso, modificación y distribución quedan sujetos a la licencia especificada por el autor.

---

## 👨‍💻 Autor

**Adrián Torres Cañete**

TFG — Desarrollo de Aplicaciones Multiplataforma (DAM)

**Zync — Red Social Multiplataforma**
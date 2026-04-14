const express = require('express');
const cors = require('cors');
const db = require('./db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const verificarToken = require('./middlewares/auth');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ mensaje: 'Servidor funcionando y conectado 🚀' });
});

// NUEVA RUTA: Prueba de base de datos
app.get('/prueba-db', async (req, res) => {
    try {
        // Hacemos una consulta simple para ver la hora del servidor MySQL
        const [rows] = await db.query('SELECT NOW() as hora_actual');
        res.json({
            status: 'Conexión OK',
            datos: rows[0]
        });
    } catch (error) {
        res.status(500).json({ error: 'Error en la base de datos' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor en http://localhost:${PORT}`);
});

// ==========================================
// RUTA: REGISTRO DE USUARIO
// ==========================================
app.post('/api/registro', async (req, res) => {
    // 1. Recibimos los datos que nos enviará Flutter (o Postman por ahora)
    const { username, email, password } = req.body;

    // 2. Comprobación básica: ¿Faltan datos?
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    try {
        // 3. Encriptamos la contraseña (el número 10 es el "coste" o nivel de seguridad)
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 4. Guardamos el usuario en la base de datos MySQL
        const query = 'INSERT INTO usuarios (username, email, password) VALUES (?, ?, ?)';
        const [resultado] = await db.query(query, [username, email, hashedPassword]);

        // 5. Respondemos que todo ha ido bien
        res.status(201).json({
            mensaje: 'Usuario registrado con éxito 🎉',
            usuarioId: resultado.insertId
        });

    } catch (error) {
        // Si el correo o el usuario ya existen, MySQL dará un error de duplicado (código 1062)
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'El nombre de usuario o email ya están en uso' });
        }
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTA: LOGIN DE USUARIO
// ==========================================
app.post('/api/login', async (req, res) => {
    // 1. Recibimos el email y la contraseña de la app
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        // 2. Buscamos al usuario por su email en la base de datos
        const [usuarios] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        
        // Si no hay ningún usuario con ese email...
        if (usuarios.length === 0) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        }

        const usuario = usuarios[0];

        // 3. Comparamos la contraseña enviada con la encriptada
        const passwordCorrecta = await bcrypt.compare(password, usuario.password);

        if (!passwordCorrecta) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        }

        // 4. ¡Todo correcto! Creamos el Token (El Pasaporte)
        const token = jwt.sign(
            { id: usuario.id }, 
            'MI_CLAVE_SECRETA_SUPER_SEGURA', // En el futuro esconderemos esto
            { expiresIn: '7d' } // El token durará 7 días
        );

        // 5. Devolvemos el token a la app de Flutter
        res.json({
            mensaje: 'Login exitoso 🔓',
            token: token,
            usuario: {
                id: usuario.id,
                username: usuario.username
            }
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTA: CREAR UNA PUBLICACIÓN (Protegida)
// ==========================================
app.post('/api/publicaciones', verificarToken, async (req, res) => {
    // 1. Recibimos el texto del tweet
    const { contenido } = req.body;

    if (!contenido) {
        return res.status(400).json({ error: 'El contenido no puede estar vacío' });
    }

    try {
        // 2. ¿Recuerdas que el guardián guardó el ID del usuario? ¡Lo usamos aquí!
        const usuarioId = req.usuario.id;

        // 3. Guardamos el tweet en MySQL
        const query = 'INSERT INTO publicaciones (usuario_id, contenido) VALUES (?, ?)';
        const [resultado] = await db.query(query, [usuarioId, contenido]);

        res.status(201).json({
            mensaje: 'Publicación creada con éxito 📝',
            publicacionId: resultado.insertId
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear la publicación' });
    }
});

// ==========================================
// RUTA: VER EL FEED (Todas las publicaciones)
// ==========================================
// Fíjate que usamos app.get en lugar de app.post, y también ponemos al Guardián
app.get('/api/publicaciones', verificarToken, async (req, res) => {
    try {
        // La magia del JOIN: Unimos la tabla publicaciones (p) con usuarios (u)
        // Ordenamos por fecha descendente (DESC) para ver los más nuevos primero
        const query = `
            SELECT p.id, p.contenido, p.fecha_creacion, u.username 
            FROM publicaciones p
            JOIN usuarios u ON p.usuario_id = u.id
            ORDER BY p.fecha_creacion DESC
        `;
        
        const [publicaciones] = await db.query(query);

        // Devolvemos la lista de tweets como respuesta
        res.json(publicaciones);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al cargar el feed' });
    }
});
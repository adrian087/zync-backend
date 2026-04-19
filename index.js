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
    const { username, email, password } = req.body;

    // 2. Comprobación básica: ¿Faltan datos?
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 4. Guardamos el usuario en la base de datos MySQL
        const query = 'INSERT INTO usuarios (username, email, password) VALUES (?, ?, ?)';
        const [resultado] = await db.query(query, [username, email, hashedPassword]);

        res.status(201).json({
            mensaje: 'Usuario registrado con éxito 🎉',
            usuarioId: resultado.insertId
        });

    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'El nombre de usuario o email ya están en uso' });
        }
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// RUTA: LOGIN DE USUARIO
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        const [usuarios] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);

        if (usuarios.length === 0) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        }

        const usuario = usuarios[0];

        const passwordCorrecta = await bcrypt.compare(password, usuario.password);

        if (!passwordCorrecta) {
            return res.status(401).json({ error: 'Email o contraseña incorrectos' });
        }

        const token = jwt.sign(
            { id: usuario.id },
            'MI_CLAVE_SECRETA_SUPER_SEGURA',
            { expiresIn: '7d' }
        );

        res.json({
            mensaje: 'Login exitoso',
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

// RUTA: CREAR UNA PUBLICACIÓN (Protegida)
app.post('/api/publicaciones', verificarToken, async (req, res) => {
    const { contenido } = req.body;

    if (!contenido) {
        return res.status(400).json({ error: 'El contenido no puede estar vacío' });
    }

    try {
        const usuarioId = req.usuario.id;

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

// RUTA: VER EL FEED (Todas las publicaciones)
app.get('/api/publicaciones', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id, p.contenido, p.fecha_creacion, u.username,
                (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id) AS total_likes,
                (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id AND usuario_id = ?) AS le_has_dado_like,
                (SELECT COUNT(*) FROM comentarios WHERE publicacion_id = p.id) AS total_comentarios -- 👇 ¡NUEVA LÍNEA! 👇
            FROM publicaciones p
            JOIN usuarios u ON p.usuario_id = u.id
            ORDER BY p.fecha_creacion DESC
        `;
        
        const [publicaciones] = await db.query(query, [req.usuario.id]);

        res.json(publicaciones);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al cargar el feed' });
    }
});

// RUTA: DAR O QUITAR LIKE (Protegida)
app.post('/api/publicaciones/:id/like', verificarToken, async (req, res) => {
    const publicacionId = req.params.id;
    const usuarioId = req.usuario.id; // Lo sacamos del token gracias al Guardián

    try {
        const [likes] = await db.query(
            'SELECT * FROM likes WHERE usuario_id = ? AND publicacion_id = ?',
            [usuarioId, publicacionId]
        );

        if (likes.length > 0) {
            await db.query(
                'DELETE FROM likes WHERE usuario_id = ? AND publicacion_id = ?',
                [usuarioId, publicacionId]
            );
            return res.json({ mensaje: 'Like quitado 💔', liked: false });
        } else {
            await db.query(
                'INSERT INTO likes (usuario_id, publicacion_id) VALUES (?, ?)',
                [usuarioId, publicacionId]
            );
            return res.json({ mensaje: 'Like añadido ❤️', liked: true });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al procesar el like' });
    }
});

// RUTA: MI PERFIL (Protegida)
app.get('/api/perfil', verificarToken, async (req, res) => {
    try {
        const usuarioId = req.usuario.id;

        const [usuarioData] = await db.query(
            'SELECT username FROM usuarios WHERE id = ?', 
            [usuarioId]
        );

        const query = `
            SELECT 
                p.id, p.contenido, p.fecha_creacion, u.username,
                (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id) AS total_likes,
                (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id AND usuario_id = ?) AS le_has_dado_like
            FROM publicaciones p
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.usuario_id = ?
            ORDER BY p.fecha_creacion DESC
        `;
        
        const [publicaciones] = await db.query(query, [usuarioId, usuarioId]);

        res.json({
            username: usuarioData[0].username,
            totalPosts: publicaciones.length,
            publicaciones: publicaciones
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al cargar el perfil' });
    }
});

// RUTA: BORRAR PUBLICACIÓN (Protegida)
app.delete('/api/publicaciones/:id', verificarToken, async (req, res) => {
    const publicacionId = req.params.id;
    const usuarioId = req.usuario.id;

    try {
        const [resultado] = await db.query(
            'DELETE FROM publicaciones WHERE id = ? AND usuario_id = ?',
            [publicacionId, usuarioId]
        );

        if (resultado.affectedRows === 0) {
            return res.status(403).json({ error: 'No autorizado para borrar esta publicación o no existe' });
        }

        res.json({ mensaje: 'Publicación eliminada correctamente 🗑️' });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al intentar borrar la publicación' });
    }
});

// RUTA: CREAR UN COMENTARIO (Protegida)
app.post('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    const publicacionId = req.params.id;
    const usuarioId = req.usuario.id;
    const { contenido } = req.body;

    if (!contenido) {
        return res.status(400).json({ error: 'El comentario no puede estar vacío' });
    }

    try {
        const [resultado] = await db.query(
            'INSERT INTO comentarios (usuario_id, publicacion_id, contenido) VALUES (?, ?, ?)',
            [usuarioId, publicacionId, contenido]
        );
        res.status(201).json({ mensaje: 'Comentario publicado 🚀', comentarioId: resultado.insertId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al publicar el comentario' });
    }
});

// RUTA: VER COMENTARIOS DE UNA PUBLICACIÓN (Protegida)
app.get('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    const publicacionId = req.params.id;

    try {
        const query = `
            SELECT c.id, c.contenido, c.fecha_creacion, u.username 
            FROM comentarios c
            JOIN usuarios u ON c.usuario_id = u.id
            WHERE c.publicacion_id = ?
            ORDER BY c.fecha_creacion ASC
        `;
        const [comentarios] = await db.query(query, [publicacionId]);
        res.json(comentarios);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al cargar los comentarios' });
    }
});
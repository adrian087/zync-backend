const express = require('express');
const http = require('http'); // 👈 NUEVO: Necesario para sockets
const { Server } = require('socket.io'); // 👈 NUEVO: El motor de tiempo real
const cors = require('cors');
const db = require('./db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const verificarToken = require('./middlewares/auth');

const multer = require('multer');
const path = require('path');

const app = express();
// 👈 NUEVO: Envolvemos Express en un servidor HTTP para que soporte WebSockets
const server = http.createServer(app);
// 👈 NUEVO: Creamos el túnel Socket.io abierto a todas las conexiones
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = 3000;

app.use(cors());
app.use(express.json());

// HACER PÚBLICA LA CARPETA DE IMÁGENES
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// CONFIGURACIÓN DE MULTER
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// 👇 NUEVO: Detectar cuándo alguien entra o sale del túnel
io.on('connection', (socket) => {
    console.log('🔌 Un usuario se ha conectado al túnel de Zync');
    socket.on('disconnect', () => console.log('🔌 Usuario desconectado del túnel'));
});

app.get('/', (req, res) => {
    res.json({ mensaje: 'Servidor funcionando y conectado 🚀' });
});

// 👇 OJO AQUÍ: Ahora usamos server.listen en lugar de app.listen 👇
server.listen(PORT, () => {
    console.log(`✅ Servidor en http://209.38.196.225:${PORT}`);
});

// ==========================================
// RUTA: REGISTRO DE USUARIO (Actualizada con 5 campos)
// ==========================================
app.post('/api/registro', async (req, res) => {
    const { nombres, apellidos, username, email, password } = req.body;

    if (!nombres || !apellidos || !username || !email || !password) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const query = 'INSERT INTO usuarios (nombres, apellidos, username, email, password) VALUES (?, ?, ?, ?, ?)';
        const [resultado] = await db.query(query, [nombres, apellidos, username, email, hashedPassword]);

        res.status(201).json({ mensaje: 'Usuario registrado con éxito', usuarioId: resultado.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'El usuario o email ya está en uso' });
        console.error(error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTA: LOGIN
// ==========================================
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Faltan datos' });

    try {
        const [usuarios] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        if (usuarios.length === 0) return res.status(401).json({ error: 'Credenciales incorrectas' });

        const usuario = usuarios[0];
        const passwordCorrecta = await bcrypt.compare(password, usuario.password);
        if (!passwordCorrecta) return res.status(401).json({ error: 'Credenciales incorrectas' });

        const token = jwt.sign({ id: usuario.id }, 'MI_CLAVE_SECRETA_SUPER_SEGURA', { expiresIn: '7d' });
        res.json({ mensaje: 'Login exitoso', token, usuario: { id: usuario.id, username: usuario.username } });
    } catch (error) {
        res.status(500).json({ error: 'Error interno' });
    }
});

// ==========================================
// RUTA: CREAR PUBLICACIÓN
// ==========================================
// 👇 Fíjate que ahora dice upload.array('imagenes', 4) en lugar de single 👇
app.post('/api/publicaciones', verificarToken, upload.array('imagenes', 4), async (req, res) => {
    const { contenido } = req.body;
    const usuarioId = req.usuario.id;

    try {
        // 1. Insertamos el texto de la publicación
        const [resultado] = await db.query(
            'INSERT INTO publicaciones (usuario_id, contenido) VALUES (?, ?)',
            [usuarioId, contenido]
        );

        const publicacionId = resultado.insertId;

        // 2. Si vienen imágenes, las guardamos en la nueva tabla puente
        if (req.files && req.files.length > 0) {
            const queries = req.files.map(file => {
                const url = `http://209.38.196.225:3000/uploads/${file.filename}`;
                return db.query(
                    'INSERT INTO publicaciones_imagenes (publicacion_id, imagen_url) VALUES (?, ?)',
                    [publicacionId, url]
                );
            });
            // Ejecutamos todas las inserciones en paralelo
            await Promise.all(queries);
        }

        res.status(201).json({ mensaje: 'Publicación creada' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al crear publicación' });
    }
});

// ==========================================
// RUTA: VER EL FEED (Todas las publicaciones - PAGINADO)
// ==========================================
app.get('/api/publicaciones', verificarToken, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    try {
        const query = `
    SELECT p.*, u.username, u.avatar_url,
           (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id) AS total_likes,
           (SELECT COUNT(*) FROM comentarios WHERE publicacion_id = p.id) AS total_comentarios,
           (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id AND usuario_id = ?) AS le_has_dado_like,
           -- 👇 LA LÍNEA NUEVA: Junta todas las URLs separadas por comas 👇
           (SELECT GROUP_CONCAT(imagen_url) FROM publicaciones_imagenes WHERE publicacion_id = p.id) AS imagenes
    FROM publicaciones p
    JOIN usuarios u ON p.usuario_id = u.id
    ORDER BY p.fecha_creacion DESC
    LIMIT ? OFFSET ?
`;

        const [publicaciones] = await db.query(query, [req.usuario.id, limit, offset]);

        const formateadas = publicaciones.map(post => ({
            ...post,
            imagen_url: post.imagen_url ? `http://209.38.196.225:3000${post.imagen_url}` : null,
            avatar_url: post.avatar_url ? `http://209.38.196.225:3000${post.avatar_url}` : null
        }));
        res.json(formateadas);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar el feed' });
    }
});

// ==========================================
// RUTA: DAR LIKE (👇 MAGIA DE SOCKET.IO AÑADIDA 👇)
// ==========================================
app.post('/api/publicaciones/:id/like', verificarToken, async (req, res) => {
    const publicacionId = req.params.id;
    const usuarioId = req.usuario.id;
    try {
        let liked = false;
        const [likes] = await db.query('SELECT * FROM likes WHERE usuario_id = ? AND publicacion_id = ?', [usuarioId, publicacionId]);

        if (likes.length > 0) {
            await db.query('DELETE FROM likes WHERE usuario_id = ? AND publicacion_id = ?', [usuarioId, publicacionId]);
        } else {
            await db.query('INSERT INTO likes (usuario_id, publicacion_id) VALUES (?, ?)', [usuarioId, publicacionId]);
            liked = true;
        }

        // Calculamos cuántos likes hay ahora en total en esa publicación
        const [likesCount] = await db.query('SELECT COUNT(*) as total FROM likes WHERE publicacion_id = ?', [publicacionId]);
        const totalLikes = likesCount[0].total;

        // 📢 ¡GRITAMOS POR EL TÚNEL! Avisamos a TODOS los móviles conectados que el contador ha cambiado
        io.emit('actualizacion_like', {
            publicacionId: parseInt(publicacionId),
            total_likes: totalLikes
        });

        return res.json({ mensaje: liked ? 'Like añadido ❤️' : 'Like quitado 💔', liked });
    } catch (error) {
        res.status(500).json({ error: 'Error al dar like' });
    }
});

// ==========================================
// RUTA: MI PERFIL PRIVADO
// ==========================================
app.get('/api/perfil', verificarToken, async (req, res) => {
    try {
        const usuarioId = req.usuario.id;
        const [usuarioData] = await db.query('SELECT username, bio, avatar_url FROM usuarios WHERE id = ?', [usuarioId]);

        const query = `
            SELECT 
                p.id, p.usuario_id, p.contenido, p.imagen_url, p.fecha_creacion, u.username, u.avatar_url,
                (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id) AS total_likes,
                (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id AND usuario_id = ?) AS le_has_dado_like
            FROM publicaciones p
            JOIN usuarios u ON p.usuario_id = u.id
            WHERE p.usuario_id = ?
            ORDER BY p.fecha_creacion DESC
        `;
        const [publicaciones] = await db.query(query, [usuarioId, usuarioId]);

        const formateadas = publicaciones.map(post => ({
            ...post,
            imagen_url: post.imagen_url ? `http://209.38.196.225:3000${post.imagen_url}` : null,
            avatar_url: post.avatar_url ? `http://209.38.196.225:3000${post.avatar_url}` : null
        }));

        res.json({
            username: usuarioData[0].username,
            bio: usuarioData[0].bio,
            avatar_url: usuarioData[0].avatar_url ? `http://209.38.196.225:3000${usuarioData[0].avatar_url}` : null,
            totalPosts: formateadas.length,
            publicaciones: formateadas
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar perfil' });
    }
});

// ==========================================
// RUTA: EDITAR MI PERFIL (Protegida + MULTER)
// ==========================================
app.put('/api/perfil/editar', verificarToken, upload.single('avatar'), async (req, res) => {
    const { username, bio } = req.body;
    const usuarioId = req.usuario.id;

    const avatarUrl = req.file ? `/uploads/${req.file.filename}` : undefined;

    try {
        if (username) {
            const [existe] = await db.query('SELECT id FROM usuarios WHERE username = ? AND id != ?', [username, usuarioId]);
            if (existe.length > 0) return res.status(400).json({ error: 'El nombre de usuario ya está en uso' });
        }

        let query = 'UPDATE usuarios SET ';
        let valores = [];

        if (username) { query += 'username = ?, '; valores.push(username); }
        if (bio !== undefined) { query += 'bio = ?, '; valores.push(bio); }
        if (avatarUrl) { query += 'avatar_url = ?, '; valores.push(avatarUrl); }

        query = query.slice(0, -2) + ' WHERE id = ?';
        valores.push(usuarioId);

        await db.query(query, valores);

        res.json({
            mensaje: 'Perfil actualizado correctamente',
            avatar_url: avatarUrl ? `http://209.38.196.225:3000${avatarUrl}` : null
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al actualizar el perfil' });
    }
});

// ==========================================
// RUTA: BORRAR PUBLICACIÓN
// ==========================================
app.delete('/api/publicaciones/:id', verificarToken, async (req, res) => {
    try {
        const [resultado] = await db.query('DELETE FROM publicaciones WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
        if (resultado.affectedRows === 0) return res.status(403).json({ error: 'No autorizado o no existe' });
        res.json({ mensaje: 'Publicación eliminada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al borrar' });
    }
});

// ==========================================
// RUTA: CREAR COMENTARIO
// ==========================================
app.post('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    const { contenido } = req.body;
    if (!contenido) return res.status(400).json({ error: 'Vacío' });
    try {
        const [resultado] = await db.query('INSERT INTO comentarios (usuario_id, publicacion_id, contenido) VALUES (?, ?, ?)', [req.usuario.id, req.params.id, contenido]);
        res.status(201).json({ mensaje: 'Comentario publicado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al comentar' });
    }
});

// ==========================================
// RUTA: VER COMENTARIOS
// ==========================================
app.get('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    try {
        const query = `
            SELECT c.id, c.usuario_id, c.contenido, c.fecha_creacion, u.username, u.avatar_url 
            FROM comentarios c JOIN usuarios u ON c.usuario_id = u.id 
            WHERE c.publicacion_id = ? ORDER BY c.fecha_creacion ASC
        `;
        const [comentarios] = await db.query(query, [req.params.id]);

        const formateados = comentarios.map(com => ({
            ...com,
            avatar_url: com.avatar_url ? `http://209.38.196.225:3000${com.avatar_url}` : null
        }));
        res.json(formateados);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar comentarios' });
    }
});

// ==========================================
// RUTA: BUSCAR USUARIOS
// ==========================================
app.get('/api/usuarios/buscar', verificarToken, async (req, res) => {
    const termino = req.query.q;
    if (!termino || termino.trim() === '') return res.json([]);
    try {
        const [usuarios] = await db.query('SELECT id, username, avatar_url FROM usuarios WHERE username LIKE ? LIMIT 15', [`%${termino}%`]);
        const formateados = usuarios.map(u => ({
            ...u, avatar_url: u.avatar_url ? `http://209.38.196.225:3000${u.avatar_url}` : null
        }));
        res.json(formateados);
    } catch (error) {
        res.status(500).json({ error: 'Error al buscar' });
    }
});

// ==========================================
// RUTA: BUSCAR PUBLICACIONES
// ==========================================
app.get('/api/publicaciones/buscar', verificarToken, async (req, res) => {
    const termino = req.query.q;
    if (!termino || termino.trim() === '') return res.json([]);
    try {
        const query = `
            SELECT p.id, p.usuario_id, p.contenido, p.imagen_url, p.fecha_creacion, u.username, u.avatar_url,
            (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id) AS total_likes,
            (SELECT COUNT(*) FROM comentarios WHERE publicacion_id = p.id) AS total_comentarios
            FROM publicaciones p JOIN usuarios u ON p.usuario_id = u.id 
            WHERE p.contenido LIKE ? ORDER BY p.fecha_creacion DESC LIMIT 20
        `;
        const [publicaciones] = await db.query(query, [`%${termino}%`]);
        const formateadas = publicaciones.map(post => ({
            ...post,
            imagen_url: post.imagen_url ? `http://209.38.196.225:3000${post.imagen_url}` : null,
            avatar_url: post.avatar_url ? `http://209.38.196.225:3000${post.avatar_url}` : null
        }));
        res.json(formateadas);
    } catch (error) {
        res.status(500).json({ error: 'Error al buscar' });
    }
});

// ==========================================
// RUTA: SEGUIR / DEJAR DE SEGUIR
// ==========================================
app.post('/api/usuarios/:id/seguir', verificarToken, async (req, res) => {
    const usuarioAseguirId = req.params.id;
    const miUsuarioId = req.usuario.id;
    if (miUsuarioId.toString() === usuarioAseguirId.toString()) return res.status(400).json({ error: 'No te puedes seguir a ti mismo' });
    try {
        const [seguimiento] = await db.query('SELECT * FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miUsuarioId, usuarioAseguirId]);
        if (seguimiento.length > 0) {
            await db.query('DELETE FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miUsuarioId, usuarioAseguirId]);
            return res.json({ mensaje: 'Unfollow', siguiendo: false });
        } else {
            await db.query('INSERT INTO seguidores (seguidor_id, seguido_id) VALUES (?, ?)', [miUsuarioId, usuarioAseguirId]);
            return res.json({ mensaje: 'Follow', siguiendo: true });
        }
    } catch (error) {
        res.status(500).json({ error: 'Error al seguir' });
    }
});

// ==========================================
// RUTA: FEED "SIGUIENDO" (PAGINADO)
// ==========================================
app.get('/api/publicaciones/siguiendo', verificarToken, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const offset = (page - 1) * limit;

    try {
        const miUsuarioId = req.usuario.id;
        const query = `
        SELECT p.*, u.username, u.avatar_url,
               (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id) AS total_likes,
               (SELECT COUNT(*) FROM comentarios WHERE publicacion_id = p.id) AS total_comentarios,
               (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id AND usuario_id = ?) AS le_has_dado_like,
               -- 👇 ESTA ES LA LÍNEA QUE FALTABA O ESTABA MAL 👇
               (SELECT GROUP_CONCAT(imagen_url) FROM publicaciones_imagenes WHERE publicacion_id = p.id) AS imagenes
        FROM publicaciones p
        JOIN usuarios u ON p.usuario_id = u.id
        JOIN seguidores s ON p.usuario_id = s.seguido_id
        WHERE s.seguidor_id = ?
        ORDER BY p.fecha_creacion DESC
        LIMIT ? OFFSET ?
    `;
        const [publicaciones] = await db.query(query, [miUsuarioId, miUsuarioId, limit, offset]);

        const formateadas = publicaciones.map(post => ({
            ...post,
            imagen_url: post.imagen_url ? `http://209.38.196.225:3000${post.imagen_url}` : null,
            avatar_url: post.avatar_url ? `http://209.38.196.225:3000${post.avatar_url}` : null
        }));
        res.json(formateadas);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar feed' });
    }
});

// ==========================================
// RUTA: PERFIL PÚBLICO
// ==========================================
app.get('/api/usuarios/:id', verificarToken, async (req, res) => {
    const perfilId = req.params.id;
    const miUsuarioId = req.usuario.id;
    try {
        const [usuarioData] = await db.query(`
            SELECT id, username, bio, avatar_url,
            (SELECT COUNT(*) FROM publicaciones WHERE usuario_id = ?) AS total_posts,
            (SELECT COUNT(*) FROM seguidores WHERE seguido_id = ?) AS total_seguidores,
            (SELECT COUNT(*) FROM seguidores WHERE seguidor_id = ?) AS total_siguiendo
            FROM usuarios WHERE id = ?
        `, [perfilId, perfilId, perfilId, perfilId]);

        if (usuarioData.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [siguiendoData] = await db.query('SELECT * FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miUsuarioId, perfilId]);
        const leSigo = siguiendoData.length > 0;

        const [publicaciones] = await db.query(`
            SELECT p.id, p.usuario_id, p.contenido, p.imagen_url, p.fecha_creacion, u.username, u.avatar_url,
            (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id) AS total_likes,
            (SELECT COUNT(*) FROM likes WHERE publicacion_id = p.id AND usuario_id = ?) AS le_has_dado_like,
            (SELECT COUNT(*) FROM comentarios WHERE publicacion_id = p.id) AS total_comentarios
            FROM publicaciones p JOIN usuarios u ON p.usuario_id = u.id 
            WHERE p.usuario_id = ? ORDER BY p.fecha_creacion DESC
        `, [miUsuarioId, perfilId]);

        const formateadas = publicaciones.map(post => ({
            ...post,
            imagen_url: post.imagen_url ? `http://209.38.196.225:3000${post.imagen_url}` : null,
            avatar_url: post.avatar_url ? `http://209.38.196.225:3000${post.avatar_url}` : null
        }));

        res.json({
            usuario: {
                ...usuarioData[0],
                avatar_url: usuarioData[0].avatar_url ? `http://209.38.196.225:3000${usuarioData[0].avatar_url}` : null
            },
            le_sigo: leSigo,
            publicaciones: formateadas
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar perfil' });
    }
});

// ==========================================
// RUTA: GUARDAR TOKEN FCM DEL MÓVIL
// ==========================================
app.put('/api/usuarios/fcm-token', verificarToken, async (req, res) => {
    const { fcm_token } = req.body;
    if (!fcm_token) return res.status(400).json({ error: 'Falta el token' });

    try {
        await db.query('UPDATE usuarios SET fcm_token = ? WHERE id = ?', [fcm_token, req.usuario.id]);
        res.json({ mensaje: 'Token FCM actualizado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar token FCM' });
    }
});
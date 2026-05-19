const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const db = require('./db');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const verificarToken = require('./middlewares/auth');

const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

io.on('connection', (socket) => {
    console.log('🔌 Un usuario se ha conectado al túnel de Zync');
    socket.on('disconnect', () => console.log('🔌 Usuario desconectado del túnel'));
});

app.get('/', (req, res) => {
    res.json({ mensaje: 'Servidor funcionando y conectado 🚀' });
});

server.listen(PORT, () => {
    console.log(`✅ Servidor en http://209.38.196.225:${PORT}`);
});

const baseQueryPublicaciones = `
    SELECT p.*, u.username, u.avatar_url,
           po.contenido AS original_contenido,
           po.fecha_creacion AS original_fecha,
           uo.username AS original_username,
           uo.avatar_url AS original_avatar_url,
           (SELECT COUNT(*) FROM likes WHERE publicacion_id = COALESCE(p.publicacion_original_id, p.id)) AS total_likes,
           (SELECT COUNT(*) FROM comentarios WHERE publicacion_id = COALESCE(p.publicacion_original_id, p.id)) AS total_comentarios,
           (SELECT COUNT(*) FROM publicaciones WHERE publicacion_original_id = COALESCE(p.publicacion_original_id, p.id)) AS total_rezyncs,
           (SELECT COUNT(*) FROM likes WHERE publicacion_id = COALESCE(p.publicacion_original_id, p.id) AND usuario_id = ?) AS le_has_dado_like,
           (SELECT COUNT(*) FROM publicaciones WHERE publicacion_original_id = COALESCE(p.publicacion_original_id, p.id) AND usuario_id = ?) AS lo_has_rezynceado,
           (SELECT COUNT(*) FROM guardados WHERE publicacion_id = COALESCE(p.publicacion_original_id, p.id) AND usuario_id = ?) AS lo_has_guardado,
           (SELECT GROUP_CONCAT(imagen_url) FROM publicaciones_imagenes WHERE publicacion_id = COALESCE(p.publicacion_original_id, p.id)) AS imagenes
    FROM publicaciones p
    JOIN usuarios u ON p.usuario_id = u.id
    LEFT JOIN publicaciones po ON p.publicacion_original_id = po.id
    LEFT JOIN usuarios uo ON po.usuario_id = uo.id
`;

// ==========================================
// 🧠 FORMATEADOR INTELIGENTE DE FOTOS
// ==========================================
const arreglarUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url; // Si ya tiene http (Google), lo dejamos
    return `https://zync-app.net${url}`; // Si no, le ponemos nuestro dominio HTTPS
};

const formatearPost = (post) => ({
    ...post,
    avatar_url: arreglarUrl(post.avatar_url),
    original_avatar_url: arreglarUrl(post.original_avatar_url)
});

// ==========================================
// RUTA: REGISTRO DE USUARIO
// ==========================================
app.post('/api/registro', async (req, res) => {
    const { nombres, apellidos, username, email, password } = req.body;
    if (!nombres || !apellidos || !username || !email || !password) return res.status(400).json({ error: 'Faltan datos obligatorios' });
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const [resultado] = await db.query('INSERT INTO usuarios (nombres, apellidos, username, email, password) VALUES (?, ?, ?, ?, ?)', [nombres, apellidos, username, email, hashedPassword]);
        res.status(201).json({ mensaje: 'Usuario registrado con éxito', usuarioId: resultado.insertId });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'El usuario o email ya está en uso' });
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
// RUTA: LOGIN / REGISTRO CON GOOGLE
// ==========================================
app.post('/api/auth/google', async (req, res) => {
    const { email, displayName, photoUrl, googleId } = req.body;

    if (!email) return res.status(400).json({ error: 'Falta el correo electrónico de Google' });

    try {
        const [users] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        let usuario = users[0];

        if (!usuario) {
            const baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
            const randomPassword = await bcrypt.hash(Math.random().toString(36).slice(-10), 10);

            const [result] = await db.query(
                'INSERT INTO usuarios (username, email, password, avatar_url) VALUES (?, ?, ?, ?)',
                [baseUsername, email, randomPassword, photoUrl]
            );

            usuario = {
                id: result.insertId,
                username: baseUsername,
                email: email,
                avatar_url: photoUrl
            };
        }

        const token = jwt.sign(
            { id: usuario.id }, 
            'MI_CLAVE_SECRETA_SUPER_SEGURA',
            { expiresIn: '7d' }
        );

        res.json({ token, usuario });
    } catch (error) {
        console.error('Error en Login con Google:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTA: CREAR PUBLICACIÓN NORMAL (CARRUSEL)
// ==========================================
app.post('/api/publicaciones', verificarToken, upload.array('imagenes', 4), async (req, res) => {
    const { contenido } = req.body;
    const usuarioId = req.usuario.id;
    try {
        const [resultado] = await db.query('INSERT INTO publicaciones (usuario_id, contenido) VALUES (?, ?)', [usuarioId, contenido]);
        const publicacionId = resultado.insertId;
        if (req.files && req.files.length > 0) {
            const queries = req.files.map(file => {
                const url = `/uploads/${file.filename}`;
                return db.query('INSERT INTO publicaciones_imagenes (publicacion_id, imagen_url) VALUES (?, ?)', [publicacionId, url]);
            });
            await Promise.all(queries);
        }
        res.status(201).json({ mensaje: 'Publicación creada' });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear publicación' });
    }
});

// ==========================================
// RUTA: HACER RE-ZYNC (🔄)
// ==========================================
app.post('/api/publicaciones/:id/rezync', verificarToken, async (req, res) => {
    const publicacionIdParam = req.params.id;
    const miId = req.usuario.id;
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [publicacionIdParam]);
        if (pub.length === 0) return res.status(404).json({ error: 'Post no encontrado' });
        const originalId = pub[0].publicacion_original_id || publicacionIdParam;

        const [existe] = await db.query('SELECT id FROM publicaciones WHERE usuario_id = ? AND publicacion_original_id = ?', [miId, originalId]);
        let rezynceado = false;

        if (existe.length > 0) {
            await db.query('DELETE FROM publicaciones WHERE id = ?', [existe[0].id]);
        } else {
            await db.query('INSERT INTO publicaciones (usuario_id, contenido, publicacion_original_id) VALUES (?, "", ?)', [miId, originalId]);
            rezynceado = true;

            const [propietarioData] = await db.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [originalId]);
            const propietarioId = propietarioData[0].usuario_id;

            if (propietarioId !== miId) { 
                await db.query(
                    "INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'rezync', ?)",
                    [propietarioId, miId, originalId]
                );
            }
        }

        const [count] = await db.query('SELECT COUNT(*) as total FROM publicaciones WHERE publicacion_original_id = ?', [originalId]);
        io.emit('actualizacion_rezync', { publicacionId: parseInt(originalId), total_rezyncs: count[0].total });

        res.json({ mensaje: rezynceado ? 'Re-Zync añadido' : 'Re-Zync quitado', rezynceado });
    } catch (error) {
        res.status(500).json({ error: 'Error al hacer Re-Zync' });
    }
});

// ==========================================
// RUTA: GUARDAR / QUITAR BOOKMARK (🔖)
// ==========================================
app.post('/api/publicaciones/:id/guardar', verificarToken, async (req, res) => {
    const pId = req.params.id;
    const uId = req.usuario.id;
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [pId]);
        if (pub.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const targetId = pub[0].publicacion_original_id || pId;

        const [existe] = await db.query('SELECT id FROM guardados WHERE usuario_id = ? AND publicacion_id = ?', [uId, targetId]);
        let guardado = false;

        if (existe.length > 0) {
            await db.query('DELETE FROM guardados WHERE id = ?', [existe[0].id]);
        } else {
            await db.query('INSERT INTO guardados (usuario_id, publicacion_id) VALUES (?, ?)', [uId, targetId]);
            guardado = true;
        }
        res.json({ guardado, mensaje: guardado ? 'Zync guardado' : 'Zync eliminado de guardados' });
    } catch (error) {
        res.status(500).json({ error: 'Error al guardar' });
    }
});

// ==========================================
// RUTA: VER MIS GUARDADOS (📂)
// ==========================================
app.get('/api/publicaciones/guardadas', verificarToken, async (req, res) => {
    try {
        const query = baseQueryPublicaciones + `
            JOIN guardados g ON (p.id = g.publicacion_id OR p.publicacion_original_id = g.publicacion_id)
            WHERE g.usuario_id = ?
            ORDER BY g.fecha_guardado DESC
        `;
        const [publicaciones] = await db.query(query, [req.usuario.id, req.usuario.id, req.usuario.id, req.usuario.id]);
        res.json(publicaciones.map(formatearPost));
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar guardados' });
    }
});

// ==========================================
// RUTA: VER EL FEED (PAGINADO)
// ==========================================
app.get('/api/publicaciones', verificarToken, async (req, res) => {
    const limit = 10;
    const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    const miId = req.usuario.id; 
    
    try {
        const query = baseQueryPublicaciones + `
            WHERE p.publicacion_original_id IS NULL 
               OR p.usuario_id = ? 
               OR p.usuario_id IN (SELECT seguido_id FROM seguidores WHERE seguidor_id = ?)
            ORDER BY p.fecha_creacion DESC 
            LIMIT ? OFFSET ?
        `;
        
        const [publicaciones] = await db.query(query, [miId, miId, miId, miId, miId, limit, offset]);
        res.json(publicaciones.map(formatearPost));
    } catch (error) {
        console.error('Error al cargar el feed Para ti:', error);
        res.status(500).json({ error: 'Error al cargar el feed' });
    }
});

// ==========================================
// RUTA: DAR LIKE (SOCKET.IO)
// ==========================================
app.post('/api/publicaciones/:id/like', verificarToken, async (req, res) => {
    const publicacionIdParam = req.params.id;
    const usuarioId = req.usuario.id;
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [publicacionIdParam]);
        if (pub.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const targetId = pub[0].publicacion_original_id || publicacionIdParam;

        let liked = false;
        const [likes] = await db.query('SELECT * FROM likes WHERE usuario_id = ? AND publicacion_id = ?', [usuarioId, targetId]);

        if (likes.length > 0) {
            await db.query('DELETE FROM likes WHERE usuario_id = ? AND publicacion_id = ?', [usuarioId, targetId]);
        } else {
            await db.query('INSERT INTO likes (usuario_id, publicacion_id) VALUES (?, ?)', [usuarioId, targetId]);
            liked = true;

            const [propietarioData] = await db.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [targetId]);
            const propietarioId = propietarioData[0].usuario_id;

            if (propietarioId !== usuarioId) { 
                await db.query(
                    "INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'like', ?)",
                    [propietarioId, usuarioId, targetId]
                );
            }
        }

        const [likesCount] = await db.query('SELECT COUNT(*) as total FROM likes WHERE publicacion_id = ?', [targetId]);
        io.emit('actualizacion_like', { publicacionId: parseInt(targetId), total_likes: likesCount[0].total });

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
        const query = baseQueryPublicaciones + ' WHERE p.usuario_id = ? ORDER BY p.fecha_creacion DESC';
        const [publicaciones] = await db.query(query, [usuarioId, usuarioId, usuarioId, usuarioId]);

        res.json({
            username: usuarioData[0].username,
            bio: usuarioData[0].bio,
            avatar_url: arreglarUrl(usuarioData[0].avatar_url),
            totalPosts: publicaciones.length,
            publicaciones: publicaciones.map(formatearPost)
        });
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar perfil' });
    }
});

// ==========================================
// RUTA: EDITAR MI PERFIL 
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
        res.json({ mensaje: 'Perfil actualizado', avatar_url: avatarUrl ? `https://zync-app.net${avatarUrl}` : null });
    } catch (error) {
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
// RUTA: EDITAR PUBLICACIÓN
// ==========================================
app.put('/api/publicaciones/:id', verificarToken, async (req, res) => {
    const { contenido } = req.body;
    const publicacionId = req.params.id;
    const miId = req.usuario.id;

    if (!contenido || contenido.trim() === '') {
        return res.status(400).json({ error: 'El contenido no puede estar vacío' });
    }

    try {
        const [resultado] = await db.query(
            'UPDATE publicaciones SET contenido = ? WHERE id = ? AND usuario_id = ?',
            [contenido, publicacionId, miId]
        );

        if (resultado.affectedRows === 0) {
            return res.status(403).json({ error: 'No autorizado o la publicación no existe' });
        }

        res.json({ mensaje: 'Zync actualizado correctamente' });
    } catch (error) {
        console.error('Error al editar Zync:', error);
        res.status(500).json({ error: 'Error al editar la publicación' });
    }
});

// ==========================================
// RUTA: CREAR COMENTARIO
// ==========================================
app.post('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    const { contenido, comentario_padre_id } = req.body;
    const miId = req.usuario.id;

    if (!contenido) return res.status(400).json({ error: 'Vacío' });

    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        const targetId = pub[0]?.publicacion_original_id || req.params.id;

        await db.query(
            'INSERT INTO comentarios (usuario_id, publicacion_id, contenido, comentario_padre_id) VALUES (?, ?, ?, ?)',
            [miId, targetId, contenido, comentario_padre_id || null]
        );

        const [propietarioData] = await db.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [targetId]);
        const propietarioId = propietarioData[0].usuario_id;

        if (propietarioId !== miId) { 
            await db.query(
                "INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'comentario', ?)",
                [propietarioId, miId, targetId]
            );
        }

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
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        const targetId = pub[0]?.publicacion_original_id || req.params.id;

        const query = `
            SELECT c.id, c.usuario_id, c.contenido, c.fecha_creacion, c.comentario_padre_id, 
                   u.username, u.avatar_url 
            FROM comentarios c 
            JOIN usuarios u ON c.usuario_id = u.id 
            WHERE c.publicacion_id = ? 
            ORDER BY c.fecha_creacion ASC
        `;
        const [comentarios] = await db.query(query, [targetId]);
        res.json(comentarios.map(formatearPost));
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
        res.json(usuarios.map(formatearPost));
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
        const query = baseQueryPublicaciones + ' WHERE p.contenido LIKE ? OR po.contenido LIKE ? ORDER BY p.fecha_creacion DESC LIMIT 20';
        const [publicaciones] = await db.query(query, [req.usuario.id, req.usuario.id, req.usuario.id, `%${termino}%`, `%${termino}%`]);
        res.json(publicaciones.map(formatearPost));
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

            await db.query(
                "INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'seguir', NULL)",
                [usuarioAseguirId, miUsuarioId]
            );

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
    const limit = 10;
    const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    try {
        const query = baseQueryPublicaciones + `
            JOIN seguidores s ON p.usuario_id = s.seguido_id
            WHERE s.seguidor_id = ?
            ORDER BY p.fecha_creacion DESC LIMIT ? OFFSET ?
        `;
        const [publicaciones] = await db.query(query, [req.usuario.id, req.usuario.id, req.usuario.id, req.usuario.id, limit, offset]);
        res.json(publicaciones.map(formatearPost));
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
        const [usuarioData] = await db.query('SELECT id, username, bio, avatar_url FROM usuarios WHERE id = ?', [perfilId]);
        if (usuarioData.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [siguiendoData] = await db.query('SELECT * FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miUsuarioId, perfilId]);

        const [seguidoresCount] = await db.query('SELECT COUNT(*) as total FROM seguidores WHERE seguido_id = ?', [perfilId]);
        const [siguiendoCount] = await db.query('SELECT COUNT(*) as total FROM seguidores WHERE seguidor_id = ?', [perfilId]);

        const query = baseQueryPublicaciones + ' WHERE p.usuario_id = ? ORDER BY p.fecha_creacion DESC';
        const [publicaciones] = await db.query(query, [miUsuarioId, miUsuarioId, miUsuarioId, perfilId]);

        res.json({
            usuario: {
                ...usuarioData[0],
                avatar_url: arreglarUrl(usuarioData[0].avatar_url),
                total_seguidores: seguidoresCount[0].total,
                total_siguiendo: siguiendoCount[0].total,
                totalPosts: publicaciones.length 
            },
            le_sigo: siguiendoData.length > 0,
            publicaciones: publicaciones.map(formatearPost)
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

// ==========================================
// RUTAS DE MENSAJES DIRECTOS
// ==========================================

// 1. Obtener lista de chats recientes (Bandeja de entrada)
app.get('/api/mensajes/chats', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const query = `
            SELECT 
                u.id as otro_usuario_id, 
                u.username, 
                u.avatar_url, 
                m.contenido as ultimo_mensaje, 
                m.fecha_envio, 
                m.leido,
                m.remitente_id
            FROM usuarios u
            JOIN mensajes m ON (u.id = m.remitente_id OR u.id = m.destinatario_id)
            WHERE (m.remitente_id = ? OR m.destinatario_id = ?)
              AND u.id != ?
              AND m.id = (
                  SELECT MAX(id) 
                  FROM mensajes m2 
                  WHERE (m2.remitente_id = ? AND m2.destinatario_id = u.id) 
                     OR (m2.remitente_id = u.id AND m2.destinatario_id = ?)
              )
            ORDER BY m.fecha_envio DESC
        `;
        const [chats] = await db.query(query, [miId, miId, miId, miId, miId]);

        const chatsFormateados = chats.map(chat => ({
            ...chat,
            avatar_url: arreglarUrl(chat.avatar_url)
        }));

        res.json(chatsFormateados);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar la bandeja de entrada' });
    }
});


// 2. Obtener historial de chat con un usuario específico
app.get('/api/mensajes/:otroUsuarioId', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    // 👇 Forzamos a que el ID sea numérico para que MySQL no falle silenciosamente 👇
    const otroId = parseInt(req.params.otroUsuarioId, 10); 

    try {
        // 1. PRIMERO marcamos los mensajes como leídos
        await db.query('UPDATE mensajes SET leido = 1 WHERE remitente_id = ? AND destinatario_id = ?', [otroId, miId]);

        // 2. LUEGO obtenemos los mensajes para mandarlos a Flutter
        const query = `
            SELECT m.*, u.username as remitente_username
            FROM mensajes m
            JOIN usuarios u ON m.remitente_id = u.id
            WHERE (m.remitente_id = ? AND m.destinatario_id = ?)
               OR (m.remitente_id = ? AND m.destinatario_id = ?)
            ORDER BY m.fecha_envio ASC
        `;
        const [mensajes] = await db.query(query, [miId, otroId, otroId, miId]);

        res.json(mensajes);
    } catch (error) {
        console.error('Error en historial de mensajes:', error);
        res.status(500).json({ error: 'Error al cargar mensajes' });
    }
});

// 3. Enviar un nuevo mensaje en tiempo real
app.post('/api/mensajes/:otroUsuarioId', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    const otroId = req.params.otroUsuarioId;
    const { contenido } = req.body;

    if (!contenido || contenido.trim() === '') return res.status(400).json({ error: 'Mensaje vacío' });

    try {
        const [resultado] = await db.query(
            'INSERT INTO mensajes (remitente_id, destinatario_id, contenido) VALUES (?, ?, ?)',
            [miId, otroId, contenido]
        );

        const [nuevoMensaje] = await db.query(`
            SELECT m.*, u.username as remitente_username
            FROM mensajes m
            JOIN usuarios u ON m.remitente_id = u.id
            WHERE m.id = ?
        `, [resultado.insertId]);

        io.emit('nuevo_mensaje', nuevoMensaje[0]);

        res.status(201).json(nuevoMensaje[0]);
    } catch (error) {
        res.status(500).json({ error: 'Error al enviar mensaje' });
    }
});

// ==========================================
// RUTAS DE NOTIFICACIONES 🔔
// ==========================================

// 1. Obtener el historial de notificaciones
app.get('/api/notificaciones', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    try {
        const query = `
            SELECT 
                n.id, n.tipo, n.leida, n.fecha_creacion, n.publicacion_id,
                u.username as origen_username, u.avatar_url as origen_avatar,
                p.contenido as publicacion_contenido
            FROM notificaciones n
            JOIN usuarios u ON n.usuario_origen_id = u.id
            LEFT JOIN publicaciones p ON n.publicacion_id = p.id
            WHERE n.usuario_destino_id = ?
            ORDER BY n.fecha_creacion DESC
            LIMIT ? OFFSET ?
        `;
        const [notificaciones] = await db.query(query, [miId, limit, offset]);

        const notificacionesFormateadas = notificaciones.map(noti => ({
            ...noti,
            origen_avatar: arreglarUrl(noti.origen_avatar)
        }));

        res.json(notificacionesFormateadas);
    } catch (error) {
        console.error('Error al cargar notificaciones:', error);
        res.status(500).json({ error: 'Error al cargar notificaciones' });
    }
});

// 2. Marcar todas como leídas (Para apagar la campanita)
app.put('/api/notificaciones/leidas', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        await db.query('UPDATE notificaciones SET leida = 1 WHERE usuario_destino_id = ? AND leida = 0', [miId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar notificaciones' });
    }
});

// ==========================================
// RUTA: ELIMINAR CUENTA (ZONA DE PELIGRO)
// ==========================================
app.delete('/api/usuarios/me', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        await db.query('DELETE FROM usuarios WHERE id = ?', [miId]);
        res.json({ mensaje: 'Cuenta eliminada para siempre' });
    } catch (error) {
        console.error('Error al eliminar cuenta:', error);
        res.status(500).json({ error: 'Error al eliminar la cuenta' });
    }
});

// ==========================================
// RUTAS: CAMBIAR DATOS DE LA CUENTA
// ==========================================

// 1. Cambiar Nombre de Usuario
app.put('/api/usuarios/me/username', verificarToken, async (req, res) => {
    const { username } = req.body;
    if (!username || username.trim() === '') return res.status(400).json({ error: 'El usuario no puede estar vacío' });
    try {
        const [existe] = await db.query('SELECT id FROM usuarios WHERE username = ? AND id != ?', [username, req.usuario.id]);
        if (existe.length > 0) return res.status(400).json({ error: 'Este nombre de usuario ya está en uso' });

        await db.query('UPDATE usuarios SET username = ? WHERE id = ?', [username, req.usuario.id]);
        res.json({ mensaje: 'Nombre de usuario actualizado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar el usuario' });
    }
});

// 2. Cambiar Correo Electrónico
app.put('/api/usuarios/me/email', verificarToken, async (req, res) => {
    const { email } = req.body;
    if (!email || email.trim() === '') return res.status(400).json({ error: 'El correo no puede estar vacío' });
    try {
        const [existe] = await db.query('SELECT id FROM usuarios WHERE email = ? AND id != ?', [email, req.usuario.id]);
        if (existe.length > 0) return res.status(400).json({ error: 'Este correo ya está registrado por otra cuenta' });

        await db.query('UPDATE usuarios SET email = ? WHERE id = ?', [email, req.usuario.id]);
        res.json({ mensaje: 'Correo actualizado correctamente' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar el correo' });
    }
});

// 3. Cambiar Contraseña
app.put('/api/usuarios/me/password', verificarToken, async (req, res) => {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva) return res.status(400).json({ error: 'Faltan datos' });
    try {
        const [usuarios] = await db.query('SELECT password FROM usuarios WHERE id = ?', [req.usuario.id]);
        const passwordCorrecta = await bcrypt.compare(password_actual, usuarios[0].password);

        if (!passwordCorrecta) return res.status(401).json({ error: 'La contraseña actual es incorrecta' });

        const salt = await bcrypt.genSalt(10);
        const hashedNueva = await bcrypt.hash(password_nueva, salt);

        await db.query('UPDATE usuarios SET password = ? WHERE id = ?', [hashedNueva, req.usuario.id]);
        res.json({ mensaje: 'Contraseña actualizada de forma segura' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar la contraseña' });
    }
});

// ==========================================
// RUTA: CREAR STORY O ZYNC DROP (🔥)
// ==========================================
app.post('/api/stories', verificarToken, upload.single('media'), async (req, res) => {
    const { tipo, max_visualizaciones } = req.body; 
    const miId = req.usuario.id;
    const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (!mediaUrl) return res.status(400).json({ error: 'Falta la imagen o vídeo' });

    try {
        const maxVis = tipo === 'drop' ? (max_visualizaciones || 10) : null;
        
        const [resultado] = await db.query(
            'INSERT INTO stories (usuario_id, media_url, tipo, max_visualizaciones) VALUES (?, ?, ?, ?)',
            [miId, mediaUrl, tipo || 'normal', maxVis]
        );

        res.status(201).json({ mensaje: 'Historia publicada con éxito', storyId: resultado.insertId });
    } catch (error) {
        console.error('Error al subir Story:', error);
        res.status(500).json({ error: 'Error al publicar' });
    }
});

// ==========================================
// RUTA: OBTENER EL FEED DE STORIES (El Radar 📡)
// ==========================================
app.get('/api/stories', verificarToken, async (req, res) => {
    const miId = req.usuario.id;

    try {
        const query = `
            SELECT s.id, s.usuario_id, s.media_url, s.tipo, s.max_visualizaciones, s.fecha_creacion,
                   u.username, u.avatar_url,
                   (SELECT COUNT(*) FROM visualizaciones_stories WHERE story_id = s.id AND usuario_id = ?) as la_he_visto
            FROM stories s
            JOIN usuarios u ON s.usuario_id = u.id
            WHERE s.activa = 1
              AND s.fecha_creacion >= NOW() - INTERVAL 1 DAY
              AND (s.usuario_id = ? OR s.usuario_id IN (SELECT seguido_id FROM seguidores WHERE seguidor_id = ?))
            ORDER BY s.fecha_creacion ASC
        `;

        const [stories] = await db.query(query, [miId, miId, miId]);

        const storiesFormateadas = stories.map(story => ({
            ...story,
            media_url: story.media_url ? `https://zync-app.net${story.media_url}` : null, 
            avatar_url: arreglarUrl(story.avatar_url),
            la_he_visto: story.la_he_visto > 0 
        }));

        res.json(storiesFormateadas);
    } catch (error) {
        console.error('Error al cargar stories:', error);
        res.status(500).json({ error: 'Error al cargar historias' });
    }
});

// ==========================================
// RUTA: VER STORY Y LA GUILLOTINA (🪓)
// ==========================================
app.post('/api/stories/:id/ver', verificarToken, async (req, res) => {
    const storyId = req.params.id;
    const miId = req.usuario.id;

    try {
        await db.query(
            'INSERT IGNORE INTO visualizaciones_stories (story_id, usuario_id) VALUES (?, ?)',
            [storyId, miId]
        );

        const [storyInfo] = await db.query('SELECT tipo, max_visualizaciones, activa FROM stories WHERE id = ?', [storyId]);

        if (storyInfo.length > 0 && storyInfo[0].tipo === 'drop' && storyInfo[0].activa === 1) {
            
            const [vistas] = await db.query('SELECT COUNT(*) as total FROM visualizaciones_stories WHERE story_id = ?', [storyId]);
            const totalVistas = vistas[0].total;

            if (totalVistas >= storyInfo[0].max_visualizaciones) {
                await db.query('UPDATE stories SET activa = 0 WHERE id = ?', [storyId]);

                io.emit('drop_agotado', { storyId: parseInt(storyId) });
                
                console.log(`💥 Drop ${storyId} destruido al alcanzar ${totalVistas} visualizaciones.`);
            }
        }

        res.json({ mensaje: 'Visualización registrada' });
    } catch (error) {
        console.error('Error al registrar vista de story:', error);
        res.status(500).json({ error: 'Error interno al ver historia' });
    }
});

// ==========================================
// RUTA: DAR LIKE A UNA STORY Y NOTIFICAR (❤️)
// ==========================================
app.post('/api/stories/:id/like', verificarToken, async (req, res) => {
    const storyId = req.params.id;
    const miId = req.usuario.id;

    try {
        const [story] = await db.query('SELECT usuario_id FROM stories WHERE id = ?', [storyId]);
        if (story.length === 0) return res.status(404).json({ error: 'Story no encontrada' });
        
        const propietarioId = story[0].usuario_id;
        
        // Generamos la notificación en la campanita
        // Usamos el tipo "like" para que la app lo lea automáticamente como un me gusta
        if (propietarioId !== miId) {
            await db.query(
                "INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'like', NULL)",
                [propietarioId, miId]
            );
        }
        res.json({ success: true, mensaje: 'Notificación enviada' });
    } catch (error) {
        console.error('Error al dar like a la historia:', error);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ==========================================
// RUTA: OBTENER CONTADORES DE BADGES
// ==========================================
app.get('/api/badges', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        // Contamos cuántas notificaciones NO están leídas
        const [notis] = await db.query('SELECT COUNT(*) as total FROM notificaciones WHERE usuario_destino_id = ? AND leida = 0', [miId]);
        // Contamos cuántos mensajes NO están leídos
        const [mensajes] = await db.query('SELECT COUNT(*) as total FROM mensajes WHERE destinatario_id = ? AND leido = 0', [miId]);
        
        res.json({ notificaciones: notis[0].total, mensajes: mensajes[0].total });
    } catch (error) {
        console.error('Error al cargar badges:', error);
        res.status(500).json({ error: 'Error al cargar badges' });
    }
});
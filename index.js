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

// ==========================================
// 🧠 SUPER-CONSULTA BASE (Re-Zyncs + Guardados)
// ==========================================
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
           -- 👇 NUEVO: Saber si tú tienes este post guardado 👇
           (SELECT COUNT(*) FROM guardados WHERE publicacion_id = COALESCE(p.publicacion_original_id, p.id) AND usuario_id = ?) AS lo_has_guardado,
           (SELECT GROUP_CONCAT(imagen_url) FROM publicaciones_imagenes WHERE publicacion_id = COALESCE(p.publicacion_original_id, p.id)) AS imagenes
    FROM publicaciones p
    JOIN usuarios u ON p.usuario_id = u.id
    LEFT JOIN publicaciones po ON p.publicacion_original_id = po.id
    LEFT JOIN usuarios uo ON po.usuario_id = uo.id
`;

const formatearPost = (post) => ({
    ...post,
    avatar_url: post.avatar_url ? `http://209.38.196.225:3000${post.avatar_url}` : null,
    original_avatar_url: post.original_avatar_url ? `http://209.38.196.225:3000${post.original_avatar_url}` : null
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
        // Redirigir el guardado al post original si es un Re-Zync
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
        // Pasamos 3 veces req.usuario.id para baseQuery, y 1 vez para la condición WHERE de guardados
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
    try {
        const query = baseQueryPublicaciones + ' ORDER BY p.fecha_creacion DESC LIMIT ? OFFSET ?';
        // Pasamos 3 veces el usuarioId para las 3 preguntas de la consulta base
        const [publicaciones] = await db.query(query, [req.usuario.id, req.usuario.id, req.usuario.id, limit, offset]);
        res.json(publicaciones.map(formatearPost));
    } catch (error) {
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
            avatar_url: usuarioData[0].avatar_url ? `http://209.38.196.225:3000${usuarioData[0].avatar_url}` : null,
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
        res.json({ mensaje: 'Perfil actualizado', avatar_url: avatarUrl ? `http://209.38.196.225:3000${avatarUrl}` : null });
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
// RUTA: CREAR COMENTARIO (Soporta respuestas anidadas)
// ==========================================
app.post('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    // 👇 Ahora recibimos también el ID del comentario al que respondemos (puede ser null)
    const { contenido, comentario_padre_id } = req.body; 
    
    if (!contenido) return res.status(400).json({ error: 'Vacío' });
    
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        const targetId = pub[0]?.publicacion_original_id || req.params.id;

        // Insertamos el comentario con su padre (si lo tiene)
        await db.query(
            'INSERT INTO comentarios (usuario_id, publicacion_id, contenido, comentario_padre_id) VALUES (?, ?, ?, ?)', 
            [req.usuario.id, targetId, contenido, comentario_padre_id || null]
        );
        res.status(201).json({ mensaje: 'Comentario publicado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al comentar' });
    }
});

// ==========================================
// RUTA: VER COMENTARIOS (Devuelve el padre)
// ==========================================
app.get('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        const targetId = pub[0]?.publicacion_original_id || req.params.id;

        // 👇 Ahora pedimos también c.comentario_padre_id en el SELECT
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
// RUTA: PERFIL PÚBLICO (CORREGIDA)
// ==========================================
app.get('/api/usuarios/:id', verificarToken, async (req, res) => {
    const perfilId = req.params.id;
    const miUsuarioId = req.usuario.id;
    try {
        const [usuarioData] = await db.query('SELECT id, username, bio, avatar_url FROM usuarios WHERE id = ?', [perfilId]);
        if (usuarioData.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

        const [siguiendoData] = await db.query('SELECT * FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miUsuarioId, perfilId]);
        
        // 👇 NUEVO: Contamos los seguidores y a los que sigue este usuario 👇
        const [seguidoresCount] = await db.query('SELECT COUNT(*) as total FROM seguidores WHERE seguido_id = ?', [perfilId]);
        const [siguiendoCount] = await db.query('SELECT COUNT(*) as total FROM seguidores WHERE seguidor_id = ?', [perfilId]);

        const query = baseQueryPublicaciones + ' WHERE p.usuario_id = ? ORDER BY p.fecha_creacion DESC';
        // Pasamos 3 veces tu ID para la baseQuery y 1 vez el perfilId para el WHERE
        const [publicaciones] = await db.query(query, [miUsuarioId, miUsuarioId, miUsuarioId, perfilId]);

        res.json({
            usuario: {
                ...usuarioData[0],
                avatar_url: usuarioData[0].avatar_url ? `http://209.38.196.225:3000${usuarioData[0].avatar_url}` : null,
                total_seguidores: seguidoresCount[0].total,
                total_siguiendo: siguiendoCount[0].total,
                totalPosts: publicaciones.length // 👈 Añadimos el total de posts
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
        // Esta super-consulta agrupa los mensajes y saca el último de cada conversación
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
        // Le pasamos tu ID 5 veces para rellenar las interrogaciones de la consulta
        const [chats] = await db.query(query, [miId, miId, miId, miId, miId]);

        // Formateamos las fotos de perfil
        const chatsFormateados = chats.map(chat => ({
            ...chat,
            avatar_url: chat.avatar_url ? `http://209.38.196.225:3000${chat.avatar_url}` : null
        }));

        res.json(chatsFormateados);
    } catch (error) {
        res.status(500).json({ error: 'Error al cargar la bandeja de entrada' });
    }
});

// 2. Obtener historial de chat con un usuario específico
app.get('/api/mensajes/:otroUsuarioId', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    const otroId = req.params.otroUsuarioId;
    
    try {
        const query = `
            SELECT m.*, u.username as remitente_username
            FROM mensajes m
            JOIN usuarios u ON m.remitente_id = u.id
            WHERE (m.remitente_id = ? AND m.destinatario_id = ?)
               OR (m.remitente_id = ? AND m.destinatario_id = ?)
            ORDER BY m.fecha_envio ASC
        `;
        const [mensajes] = await db.query(query, [miId, otroId, otroId, miId]);

        // Cuando entramos al chat, marcamos los mensajes que nos mandaron como leídos
        await db.query('UPDATE mensajes SET leido = 1 WHERE remitente_id = ? AND destinatario_id = ?', [otroId, miId]);

        res.json(mensajes);
    } catch (error) {
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
        // Guardamos el mensaje en MySQL
        const [resultado] = await db.query(
            'INSERT INTO mensajes (remitente_id, destinatario_id, contenido) VALUES (?, ?, ?)',
            [miId, otroId, contenido]
        );

        // Recuperamos el mensaje recién guardado con el nombre del remitente
        const [nuevoMensaje] = await db.query(`
            SELECT m.*, u.username as remitente_username
            FROM mensajes m
            JOIN usuarios u ON m.remitente_id = u.id
            WHERE m.id = ?
        `, [resultado.insertId]);

        // 👇 MAGIA EN TIEMPO REAL: Emitimos el mensaje a todos los clientes 👇
        io.emit('nuevo_mensaje', nuevoMensaje[0]);

        res.status(201).json(nuevoMensaje[0]);
    } catch (error) {
        res.status(500).json({ error: 'Error al enviar mensaje' });
    }
});
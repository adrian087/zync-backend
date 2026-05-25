require('dotenv').config(); // 👈 MAGIA: Carga las variables del archivo .env
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

// CONFIGURACIÓN DE RESEND (Ahora usando variables de entorno 🔒)
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// ==========================================
// 1. INICIALIZAMOS FIREBASE ADMIN SDK ☁️
// ==========================================
const admin = require('firebase-admin');
let serviceAccount;
try {
    serviceAccount = require('./firebase-key.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('☁️ Firebase Admin SDK Inicializado correctamente');
} catch (error) {
    console.warn('⚠️ No se encontró firebase-key.json. Los push no funcionarán.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

// ESTO DEBE SER LO PRIMERO
app.use(cors({
    origin: ['https://www.zync-app.net', 'https://zync-app.net'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

app.options('*', cors({
    origin: ['https://www.zync-app.net', 'https://zync-app.net'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true
}));

app.use(express.json());

// CONFIGURACIÓN ESTÁTICOS Y CACHÉ
app.use('/uploads', express.static('uploads', {
    setHeaders: (res, path, stat) => {
        // 👇 Esto obliga al navegador a NO cachear la imagen si no es necesario
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    }
}));

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/'); },
    filename: function (req, file, cb) { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

io.on('connection', (socket) => {
    console.log('🔌 Un usuario se ha conectado al túnel de Zync');
    socket.on('disconnect', () => console.log('🔌 Usuario desconectado del túnel'));
});

// ==========================================
// 🚀 CAÑÓN DE NOTIFICACIONES PUSH REALES
// ==========================================
async function dispararPush(destinoId, origenId, tipo) {
    try {
        if (!admin.apps.length) return; 

        // Buscamos la "matrícula" del móvil del usuario destino
        const [destinos] = await db.query('SELECT fcm_token FROM usuarios WHERE id = ?', [destinoId]);
        const fcmToken = destinos[0]?.fcm_token;
        if (!fcmToken) return; 

        // Buscamos el nombre del usuario que hace la acción
        const [origenes] = await db.query('SELECT username FROM usuarios WHERE id = ?', [origenId]);
        const origenUsername = origenes[0]?.username || 'Alguien';

        // Montamos el mensaje
        let titulo = 'Zync';
        let cuerpo = '';

        switch(tipo) {
            case 'like': cuerpo = `@${origenUsername} le dio Me gusta a tu Zync.`; break;
            case 'rezync': cuerpo = `@${origenUsername} ha re-zynceado tu publicación.`; break;
            case 'comentario': cuerpo = `@${origenUsername} comentó en tu publicación.`; break;
            case 'seguir': cuerpo = `@${origenUsername} ha comenzado a seguirte.`; break;
            case 'mensaje': cuerpo = `Tienes un nuevo mensaje de @${origenUsername}.`; break;
            case 'like_story': cuerpo = `@${origenUsername} reaccionó a tu historia.`; break;
            default: return;
        }

        const mensaje = {
            notification: { title: titulo, body: cuerpo },
            token: fcmToken
        };

        await admin.messaging().send(mensaje);
        console.log(`✅ Push enviado con éxito a @${origenUsername} -> [${tipo}]`);
    } catch (e) {
        console.error('❌ Error disparando Push FCM:', e);
    }
}

// ==========================================
// 🧠 UTILIDADES Y FORMATEADORES
// ==========================================
const arreglarUrl = (url) => {
    if (!url) return null;
    if (url.startsWith('http')) return url; 
    return `https://api.zync-app.net${url}`;
};

const formatearPost = (post) => ({
    ...post,
    avatar_url: arreglarUrl(post.avatar_url),
    original_avatar_url: arreglarUrl(post.original_avatar_url),
    imagenes: post.imagenes ? post.imagenes.split(',').map(url => arreglarUrl(url)).join(',') : null
});

const baseQueryPublicaciones = `
    SELECT p.*, u.username, u.avatar_url,
           po.contenido AS original_contenido, po.fecha_creacion AS original_fecha,
           uo.username AS original_username, uo.avatar_url AS original_avatar_url,
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

app.get('/', (req, res) => res.json({ mensaje: 'Servidor funcionando 🚀' }));
server.listen(PORT, () => console.log(`✅ Servidor en puerto ${PORT}`));

// ==========================================
// RUTA: REGISTRO Y LOGIN (Auth)
// ==========================================

app.post('/api/registro', async (req, res) => {
    const { nombres, apellidos, username, email, password } = req.body;
    if (!nombres || !apellidos || !username || !email || !password) return res.status(400).json({ error: 'Faltan datos obligatorios' });
    try {
        const salt = await bcrypt.genSalt(10);
        const hashed = await bcrypt.hash(password, salt);
        const [r] = await db.query('INSERT INTO usuarios (nombres, apellidos, username, email, password) VALUES (?, ?, ?, ?, ?)', [nombres, apellidos, username, email, hashed]);
        
        // 👇 MAGIA: ENVIAR CORREO DE BIENVENIDA 👇
        resend.emails.send({
            from: 'Zync App <no-reply@zync-app.net>',
            to: email,
            subject: '¡Bienvenido a Zync, @' + username + '! 🎉',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                    <h1 style="color: #1DA1F2; text-align: center;">¡Bienvenido a Zync!</h1>
                    <h2 style="color: #333;">Hola @${username},</h2>
                    <p style="color: #555; font-size: 16px;">Nos hace muchísima ilusión tenerte por aquí. Zync es tu nuevo espacio para compartir ideas, fotos y conectar con el mundo.</p>
                    <p style="color: #555; font-size: 16px;">¿Por qué no empiezas publicando tu primer Zync o subiendo un Zync Drop?</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="https://zync-app.net" style="background-color: #1DA1F2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px;">Empezar a Zyncear</a>
                    </div>
                    <p style="color: #999; font-size: 12px; text-align: center;">Si tienes alguna duda, estamos aquí para ayudarte.</p>
                </div>
            `
        }).then(() => console.log(`✉️ Correo de bienvenida enviado a @${username}`))
          .catch(err => console.error('❌ Error enviando bienvenida:', err));

        res.status(201).json({ mensaje: 'OK', usuarioId: r.insertId });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'El usuario ya existe' });
        console.error('🔥 Error en registro:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/login', async (req, res) => {
    const identificador = req.body.email; 
    const password = req.body.password;

    try {
        const [u] = await db.query(
            'SELECT * FROM usuarios WHERE email = ? OR username = ?', 
            [identificador, identificador]
        );

        if (u.length === 0) return res.status(401).json({ error: 'Credenciales incorrectas' });
        
        const passOk = await bcrypt.compare(password, u[0].password);
        if (!passOk) return res.status(401).json({ error: 'Credenciales incorrectas' });
        
        const token = jwt.sign({ id: u[0].id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, usuario: { id: u[0].id, username: u[0].username } });
    } catch (e) { 
        console.error('🔥 Error en login:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.post('/api/auth/google', async (req, res) => {
    const { email, photoUrl } = req.body;
    try {
        const [u] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        let usuario = u[0];
        
        if (!usuario) {
            const baseUser = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
            const rndPass = await bcrypt.hash(Math.random().toString(36).slice(-10), 10);
            const [r] = await db.query('INSERT INTO usuarios (username, email, password, avatar_url) VALUES (?, ?, ?, ?)', [baseUser, email, rndPass, photoUrl]);
            usuario = { id: r.insertId, username: baseUser };

            resend.emails.send({
                from: 'Zync App <no-reply@zync-app.net>',
                to: email,
                subject: '¡Bienvenido a Zync, @' + baseUser + '! 🎉',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                        <h1 style="color: #1DA1F2; text-align: center;">¡Bienvenido a Zync!</h1>
                        <h2 style="color: #333;">Hola @${baseUser},</h2>
                        <p style="color: #555; font-size: 16px;">Has iniciado sesión con éxito usando Google. Tu aventura en Zync acaba de comenzar.</p>
                        <div style="text-align: center; margin: 30px 0;">
                            <a href="https://zync-app.net" style="background-color: #1DA1F2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 25px; font-weight: bold; font-size: 16px;">Ir a mi Muro</a>
                        </div>
                    </div>
                `
            }).catch(e => console.log('Error correo Google:', e));
        }
        
        const token = jwt.sign({ id: usuario.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, usuario });
    } catch (e) { 
        console.error('🔥 Error en auth google:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// ==========================================
// RUTAS: PUBLICACIONES BASE
// ==========================================
app.post('/api/publicaciones', verificarToken, upload.array('imagenes', 4), async (req, res) => {
    const { contenido } = req.body;
    try {
        const [r] = await db.query('INSERT INTO publicaciones (usuario_id, contenido) VALUES (?, ?)', [req.usuario.id, contenido]);
        if (req.files && req.files.length > 0) {
            await Promise.all(req.files.map(f => db.query('INSERT INTO publicaciones_imagenes (publicacion_id, imagen_url) VALUES (?, ?)', [r.insertId, `/uploads/${f.filename}`])));
        }
        res.status(201).json({ mensaje: 'OK' });
    } catch (e) { 
        console.error('🔥 Error subiendo publicacion:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/publicaciones', verificarToken, async (req, res) => {
    const limit = 10;
    const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    const miId = req.usuario.id; 
    try {
        const query = baseQueryPublicaciones + ` 
            WHERE (p.publicacion_original_id IS NULL OR p.usuario_id = ? OR p.usuario_id IN (SELECT seguido_id FROM seguidores WHERE seguidor_id = ?))
            AND p.usuario_id NOT IN (SELECT bloqueado_id FROM bloqueos WHERE bloqueador_id = ?)
            AND p.usuario_id NOT IN (SELECT bloqueador_id FROM bloqueos WHERE bloqueado_id = ?)
            ORDER BY p.fecha_creacion DESC LIMIT ? OFFSET ?`;
        const [p] = await db.query(query, [miId, miId, miId, miId, miId, miId, miId, limit, offset]);
        res.json(p.map(formatearPost));
    } catch (e) { 
        console.error('🔥 Error obteniendo muro:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// RUTAS "SIGUIENDO" CORRECTA Y ÚNICA (Anti-bloqueos)
app.get('/api/publicaciones/siguiendo', verificarToken, async (req, res) => {
    const limit = 10; const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    const miId = req.usuario.id;
    try {
        const query = baseQueryPublicaciones + ` 
            JOIN seguidores s ON p.usuario_id = s.seguido_id 
            WHERE s.seguidor_id = ?
            AND p.usuario_id NOT IN (SELECT bloqueado_id FROM bloqueos WHERE bloqueador_id = ?)
            AND p.usuario_id NOT IN (SELECT bloqueador_id FROM bloqueos WHERE bloqueado_id = ?)
            ORDER BY p.fecha_creacion DESC LIMIT ? OFFSET ?`;
        const [p] = await db.query(query, [miId, miId, miId, miId, miId, miId, limit, offset]);
        res.json(p.map(formatearPost));
    } catch (e) { 
        console.error('🔥 Error obteniendo feed siguiendo:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.delete('/api/publicaciones/:id', verificarToken, async (req, res) => {
    try {
        const [r] = await db.query('DELETE FROM publicaciones WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
        if (r.affectedRows === 0) return res.status(403).json({ error: 'No autorizado' });
        res.json({ mensaje: 'Eliminada' });
    } catch (e) { 
        console.error('🔥 Error borrando post:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.put('/api/publicaciones/:id', verificarToken, async (req, res) => {
    try {
        if (!req.body.contenido || req.body.contenido.trim() === '') return res.status(400).json({ error: 'Contenido vacío' });
        const [r] = await db.query('UPDATE publicaciones SET contenido = ? WHERE id = ? AND usuario_id = ?', [req.body.contenido, req.params.id, req.usuario.id]);
        if (r.affectedRows === 0) return res.status(403).json({ error: 'No autorizado' });
        res.json({ mensaje: 'Actualizada' });
    } catch (e) { 
        console.error('🔥 Error actualizando post:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// ==========================================
// RUTAS: INTERACCIONES Y PUSH (Likes, Comentarios, ReZyncs)
// ==========================================
app.post('/api/publicaciones/:id/rezync', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        if (pub.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const originalId = pub[0].publicacion_original_id || req.params.id;

        const [existe] = await db.query('SELECT id FROM publicaciones WHERE usuario_id = ? AND publicacion_original_id = ?', [miId, originalId]);
        let rezynceado = false;

        if (existe.length > 0) {
            await db.query('DELETE FROM publicaciones WHERE id = ?', [existe[0].id]);
        } else {
            await db.query('INSERT INTO publicaciones (usuario_id, contenido, publicacion_original_id) VALUES (?, "", ?)', [miId, originalId]);
            rezynceado = true;

            const [propData] = await db.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [originalId]);
            const propietarioId = propData[0].usuario_id;
            
            if (propietarioId !== miId) { 
                await db.query("INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'rezync', ?)", [propietarioId, miId, originalId]);
                dispararPush(propietarioId, miId, 'rezync');
            }
        }
        const [c] = await db.query('SELECT COUNT(*) as total FROM publicaciones WHERE publicacion_original_id = ?', [originalId]);
        io.emit('actualizacion_rezync', { publicacionId: parseInt(originalId), total_rezyncs: c[0].total });
        res.json({ rezynceado });
    } catch (e) { 
        console.error('🔥 Error en rezync:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.post('/api/publicaciones/:id/like', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        if (pub.length === 0) return res.status(404).json({ error: 'No encontrado' });
        const targetId = pub[0].publicacion_original_id || req.params.id;

        let liked = false;
        const [likes] = await db.query('SELECT * FROM likes WHERE usuario_id = ? AND publicacion_id = ?', [miId, targetId]);

        if (likes.length > 0) {
            await db.query('DELETE FROM likes WHERE usuario_id = ? AND publicacion_id = ?', [miId, targetId]);
        } else {
            await db.query('INSERT INTO likes (usuario_id, publicacion_id) VALUES (?, ?)', [miId, targetId]);
            liked = true;

            const [propData] = await db.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [targetId]);
            const propietarioId = propData[0].usuario_id;

            if (propietarioId !== miId) { 
                await db.query("INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'like', ?)", [propietarioId, miId, targetId]);
                dispararPush(propietarioId, miId, 'like');
            }
        }
        const [c] = await db.query('SELECT COUNT(*) as total FROM likes WHERE publicacion_id = ?', [targetId]);
        io.emit('actualizacion_like', { publicacionId: parseInt(targetId), total_likes: c[0].total });
        return res.json({ liked });
    } catch (e) { 
        console.error('🔥 Error en like:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.post('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        const targetId = pub[0]?.publicacion_original_id || req.params.id;

        await db.query('INSERT INTO comentarios (usuario_id, publicacion_id, contenido, comentario_padre_id) VALUES (?, ?, ?, ?)', [miId, targetId, req.body.contenido, req.body.comentario_padre_id || null]);

        const [propData] = await db.query('SELECT usuario_id FROM publicaciones WHERE id = ?', [targetId]);
        const propietarioId = propData[0].usuario_id;

        if (propietarioId !== miId) { 
            await db.query("INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo, publicacion_id) VALUES (?, ?, 'comentario', ?)", [propietarioId, miId, targetId]);
            dispararPush(propietarioId, miId, 'comentario');
        }
        res.status(201).json({ mensaje: 'Comentado' });
    } catch (e) { 
        console.error('🔥 Error comentando:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/publicaciones/:id/comentarios', verificarToken, async (req, res) => {
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        const targetId = pub[0]?.publicacion_original_id || req.params.id;
        const [c] = await db.query(`SELECT c.id, c.usuario_id, c.contenido, c.fecha_creacion, c.comentario_padre_id, u.username, u.avatar_url FROM comentarios c JOIN usuarios u ON c.usuario_id = u.id WHERE c.publicacion_id = ? ORDER BY c.fecha_creacion ASC`, [targetId]);
        res.json(c.map(formatearPost));
    } catch (e) { 
        console.error('🔥 Error obteniendo comentarios:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// ==========================================
// RUTAS: GUARDADOS Y BÚSQUEDAS
// ==========================================
app.post('/api/publicaciones/:id/guardar', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [pub] = await db.query('SELECT publicacion_original_id FROM publicaciones WHERE id = ?', [req.params.id]);
        const targetId = pub[0]?.publicacion_original_id || req.params.id;

        const [existe] = await db.query('SELECT id FROM guardados WHERE usuario_id = ? AND publicacion_id = ?', [miId, targetId]);
        let guardado = false;
        if (existe.length > 0) { await db.query('DELETE FROM guardados WHERE id = ?', [existe[0].id]); } 
        else { await db.query('INSERT INTO guardados (usuario_id, publicacion_id) VALUES (?, ?)', [miId, targetId]); guardado = true; }
        res.json({ guardado });
    } catch (e) { 
        console.error('🔥 Error en guardar post:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/publicaciones/guardadas', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const q = baseQueryPublicaciones + ` JOIN guardados g ON (p.id = g.publicacion_id OR p.publicacion_original_id = g.publicacion_id) WHERE g.usuario_id = ? ORDER BY g.fecha_guardado DESC`;
        const [p] = await db.query(q, [miId, miId, miId, miId]);
        res.json(p.map(formatearPost));
    } catch (e) { 
        console.error('🔥 Error obteniendo guardados:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// BUSCADOR DE PUBLICACIONES (Anti-bloqueos)
app.get('/api/publicaciones/buscar', verificarToken, async (req, res) => {
    if (!req.query.q) return res.json([]);
    const miId = req.usuario.id;
    try {
        const q = baseQueryPublicaciones + ` 
            WHERE (p.contenido LIKE ? OR po.contenido LIKE ?)
            AND p.usuario_id NOT IN (SELECT bloqueado_id FROM bloqueos WHERE bloqueador_id = ?)
            AND p.usuario_id NOT IN (SELECT bloqueador_id FROM bloqueos WHERE bloqueado_id = ?)
            ORDER BY p.fecha_creacion DESC LIMIT 20`;
        const [p] = await db.query(q, [miId, miId, miId, `%${req.query.q}%`, `%${req.query.q}%`, miId, miId]);
        res.json(p.map(formatearPost));
    } catch (e) {
        console.error('🔥 Error buscando publicaciones:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// NUEVO: BUSCADOR DE USUARIOS (Anti-bloqueos)
app.get('/api/usuarios/buscar', verificarToken, async (req, res) => {
    if (!req.query.q) return res.json([]);
    const miId = req.usuario.id;
    try {
        const q = `
            SELECT id, username, avatar_url, nombres, apellidos 
            FROM usuarios 
            WHERE (username LIKE ? OR nombres LIKE ? OR apellidos LIKE ?)
            AND id NOT IN (SELECT bloqueado_id FROM bloqueos WHERE bloqueador_id = ?)
            AND id NOT IN (SELECT bloqueador_id FROM bloqueos WHERE bloqueado_id = ?)
            LIMIT 20
        `;
        const [usuarios] = await db.query(q, [
            `%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`, 
            miId, miId
        ]);
        
        res.json(usuarios.map(u => ({ ...u, avatar_url: arreglarUrl(u.avatar_url) })));
    } catch (e) {
        console.error('🔥 Error buscando usuarios:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTAS: PERFILES Y SEGUIR
// ==========================================
app.get('/api/perfil', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [u] = await db.query('SELECT username, bio, avatar_url FROM usuarios WHERE id = ?', [miId]);
        const [p] = await db.query(baseQueryPublicaciones + ' WHERE p.usuario_id = ? ORDER BY p.fecha_creacion DESC', [miId, miId, miId, miId]);
        res.json({ username: u[0].username, bio: u[0].bio, avatar_url: arreglarUrl(u[0].avatar_url), totalPosts: p.length, publicaciones: p.map(formatearPost) });
    } catch(e) {
        console.error('🔥 Error cargando mi perfil:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.put('/api/perfil/editar', verificarToken, upload.single('avatar'), async (req, res) => {
    const { username, bio } = req.body; const miId = req.usuario.id;
    try {
        if (username) {
            const [e] = await db.query('SELECT id FROM usuarios WHERE username = ? AND id != ?', [username, miId]);
            if (e.length > 0) return res.status(400).json({ error: 'En uso' });
        }
        let q = 'UPDATE usuarios SET ', vals = [];
        if (username) { q += 'username = ?, '; vals.push(username); }
        if (bio !== undefined) { q += 'bio = ?, '; vals.push(bio); }
        if (req.file) { q += 'avatar_url = ?, '; vals.push(`/uploads/${req.file.filename}`); }
        q = q.slice(0, -2) + ' WHERE id = ?'; vals.push(miId);
        await db.query(q, vals);
        res.json({ mensaje: 'OK' });
    } catch (e) { 
        console.error('🔥 Error editando perfil:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/usuarios/bloqueados', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [b] = await db.query(
            `SELECT u.id, u.username, u.avatar_url 
             FROM bloqueos b 
             JOIN usuarios u ON b.bloqueado_id = u.id 
             WHERE b.bloqueador_id = ?`,
            [miId]
        );
        res.json(b.map(u => ({ ...u, avatar_url: arreglarUrl(u.avatar_url) })));
    } catch (e) {
        console.error('🔥 Error obteniendo bloqueados:', e);
        res.status(500).json({ error: 'Error al obtener la lista de bloqueados' });
    }
});

app.get('/api/usuarios/:id', verificarToken, async (req, res) => {
    const miId = req.usuario.id; const perfilId = req.params.id;
    try {
        const [u] = await db.query('SELECT id, username, bio, avatar_url FROM usuarios WHERE id = ?', [perfilId]);
        if (u.length === 0) return res.status(404).json({ error: 'No encontrado' });
        
        const [s] = await db.query('SELECT * FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miId, perfilId]);
        const [seg] = await db.query('SELECT COUNT(*) as t FROM seguidores WHERE seguido_id = ?', [perfilId]);
        const [sig] = await db.query('SELECT COUNT(*) as t FROM seguidores WHERE seguidor_id = ?', [perfilId]);
        
        const [bloqueo] = await db.query('SELECT id FROM bloqueos WHERE bloqueador_id = ? AND bloqueado_id = ?', [miId, perfilId]);
        
        const [p] = await db.query(baseQueryPublicaciones + ' WHERE p.usuario_id = ? ORDER BY p.fecha_creacion DESC', [miId, miId, miId, perfilId]);
        
        res.json({
            usuario: { ...u[0], avatar_url: arreglarUrl(u[0].avatar_url), total_seguidores: seg[0].t, total_siguiendo: sig[0].t, totalPosts: p.length },
            le_sigo: s.length > 0, 
            le_tengo_bloqueado: bloqueo.length > 0, 
            publicaciones: p.map(formatearPost)
        });
    } catch (e) { 
        console.error('🔥 Error cargando perfil ajeno:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.post('/api/usuarios/:id/seguir', verificarToken, async (req, res) => {
    const miId = req.usuario.id; const targetId = req.params.id;
    if (miId == targetId) return res.status(400).json({ error: 'Error' });
    try {
        const [s] = await db.query('SELECT * FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miId, targetId]);
        if (s.length > 0) {
            await db.query('DELETE FROM seguidores WHERE seguidor_id = ? AND seguido_id = ?', [miId, targetId]);
            res.json({ siguiendo: false });
        } else {
            await db.query('INSERT INTO seguidores (seguidor_id, seguido_id) VALUES (?, ?)', [miId, targetId]);
            await db.query("INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo) VALUES (?, ?, 'seguir')", [targetId, miId]);
            dispararPush(targetId, miId, 'seguir');
            res.json({ siguiendo: true });
        }
    } catch (e) { 
        console.error('🔥 Error siguiendo usuario:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// ==========================================
// RUTAS: MENSAJES Y CHATS
// ==========================================
app.get('/api/mensajes/chats', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const q = `SELECT u.id as otro_usuario_id, u.username, u.avatar_url, m.contenido as ultimo_mensaje, m.fecha_envio, m.leido, m.remitente_id 
                   FROM usuarios u JOIN mensajes m ON (u.id = m.remitente_id OR u.id = m.destinatario_id) 
                   WHERE (m.remitente_id = ? OR m.destinatario_id = ?) AND u.id != ? AND m.id = (SELECT MAX(id) FROM mensajes m2 WHERE (m2.remitente_id = ? AND m2.destinatario_id = u.id) OR (m2.remitente_id = u.id AND m2.destinatario_id = ?)) 
                   ORDER BY m.fecha_envio DESC`;
        const [c] = await db.query(q, [miId, miId, miId, miId, miId]);
        res.json(c.map(chat => ({ ...chat, avatar_url: arreglarUrl(chat.avatar_url) })));
    } catch(e) {
        console.error('🔥 Error cargando chats:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.get('/api/mensajes/:otroUsuarioId', verificarToken, async (req, res) => {
    const miId = req.usuario.id; const otroId = parseInt(req.params.otroUsuarioId, 10);
    try {
        await db.query('UPDATE mensajes SET leido = 1 WHERE remitente_id = ? AND destinatario_id = ?', [otroId, miId]);
        const [m] = await db.query(`SELECT m.*, u.username as remitente_username FROM mensajes m JOIN usuarios u ON m.remitente_id = u.id WHERE (m.remitente_id = ? AND m.destinatario_id = ?) OR (m.remitente_id = ? AND m.destinatario_id = ?) ORDER BY m.fecha_envio ASC`, [miId, otroId, otroId, miId]);
        res.json(m);
    } catch (e) { 
        console.error('🔥 Error cargando mensajes:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.post('/api/mensajes/:otroUsuarioId', verificarToken, async (req, res) => {
    const miId = req.usuario.id; const otroId = req.params.otroUsuarioId;
    if (!req.body.contenido || req.body.contenido.trim() === '') return res.status(400).json({ error: 'Vacío' });
    try {
        const [r] = await db.query('INSERT INTO mensajes (remitente_id, destinatario_id, contenido) VALUES (?, ?, ?)', [miId, otroId, req.body.contenido]);
        const [m] = await db.query(`SELECT m.*, u.username as remitente_username FROM mensajes m JOIN usuarios u ON m.remitente_id = u.id WHERE m.id = ?`, [r.insertId]);
        io.emit('nuevo_mensaje', m[0]);
        dispararPush(otroId, miId, 'mensaje');
        res.status(201).json(m[0]);
    } catch (e) { 
        console.error('🔥 Error enviando mensaje:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// ==========================================
// RUTAS: NOTIFICACIONES, BADGES Y FCM
// ==========================================
app.put('/api/usuarios/fcm-token', verificarToken, async (req, res) => {
    try {
        await db.query('UPDATE usuarios SET fcm_token = ? WHERE id = ?', [req.body.fcm_token, req.usuario.id]);
        res.json({ mensaje: 'OK' });
    } catch (e) { 
        console.error('🔥 Error guardando fcm_token:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/badges', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [n] = await db.query('SELECT COUNT(*) as t FROM notificaciones WHERE usuario_destino_id = ? AND leida = 0', [miId]);
        const [m] = await db.query('SELECT COUNT(*) as t FROM mensajes WHERE destinatario_id = ? AND leido = 0', [miId]);
        res.json({ notificaciones: n[0].t, mensajes: m[0].t });
    } catch (e) { 
        console.error('🔥 Error obteniendo badges:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/notificaciones', verificarToken, async (req, res) => {
    const miId = req.usuario.id; const limit = 20; const offset = ((parseInt(req.query.page) || 1) - 1) * limit;
    try {
        const q = `SELECT n.*, u.username as origen_username, u.avatar_url as origen_avatar, p.contenido as publicacion_contenido FROM notificaciones n JOIN usuarios u ON n.usuario_origen_id = u.id LEFT JOIN publicaciones p ON n.publicacion_id = p.id WHERE n.usuario_destino_id = ? ORDER BY n.fecha_creacion DESC LIMIT ? OFFSET ?`;
        const [n] = await db.query(q, [miId, limit, offset]);
        res.json(n.map(noti => ({ ...noti, origen_avatar: arreglarUrl(noti.origen_avatar) })));
    } catch(e) {
        console.error('🔥 Error obteniendo notificaciones:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.put('/api/notificaciones/leidas', verificarToken, async (req, res) => {
    try {
        await db.query('UPDATE notificaciones SET leida = 1 WHERE usuario_destino_id = ? AND leida = 0', [req.usuario.id]);
        res.json({ success: true });
    } catch(e) {
        console.error('🔥 Error marcando notificaciones leídas:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// ==========================================
// RUTAS: STORIES Y ZYNC DROPS
// ==========================================
app.post('/api/stories', verificarToken, upload.single('media'), async (req, res) => {
    const { tipo, max_visualizaciones } = req.body;
    try {
        const m = tipo === 'drop' ? (max_visualizaciones || 10) : null;
        const [r] = await db.query('INSERT INTO stories (usuario_id, media_url, tipo, max_visualizaciones) VALUES (?, ?, ?, ?)', [req.usuario.id, `/uploads/${req.file.filename}`, tipo || 'normal', m]);
        res.status(201).json({ storyId: r.insertId });
    } catch (e) { 
        console.error('🔥 Error subiendo story:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/stories', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const q = `SELECT s.*, u.username, u.avatar_url, (SELECT COUNT(*) FROM visualizaciones_stories WHERE story_id = s.id AND usuario_id = ?) as la_he_visto 
                   FROM stories s 
                   JOIN usuarios u ON s.usuario_id = u.id 
                   WHERE s.activa = 1 AND s.fecha_creacion >= NOW() - INTERVAL 1 DAY 
                   AND (s.usuario_id = ? OR s.usuario_id IN (SELECT seguido_id FROM seguidores WHERE seguidor_id = ?))
                   AND s.usuario_id NOT IN (SELECT bloqueado_id FROM bloqueos WHERE bloqueador_id = ?)
                   AND s.usuario_id NOT IN (SELECT bloqueador_id FROM bloqueos WHERE bloqueado_id = ?)
                   ORDER BY s.fecha_creacion ASC`;
        const [s] = await db.query(q, [miId, miId, miId, miId, miId]);
        res.json(s.map(st => ({ ...st, media_url: arreglarUrl(st.media_url), avatar_url: arreglarUrl(st.avatar_url), la_he_visto: st.la_he_visto > 0 })));
    } catch(e) {
        console.error('🔥 Error obteniendo stories:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/stories/:id/ver', verificarToken, async (req, res) => {
    const sId = req.params.id; const miId = req.usuario.id;
    try {
        await db.query('INSERT IGNORE INTO visualizaciones_stories (story_id, usuario_id) VALUES (?, ?)', [sId, miId]);
        const [st] = await db.query('SELECT tipo, max_visualizaciones, activa FROM stories WHERE id = ?', [sId]);
        if (st.length > 0 && st[0].tipo === 'drop' && st[0].activa === 1) {
            const [v] = await db.query('SELECT COUNT(*) as t FROM visualizaciones_stories WHERE story_id = ?', [sId]);
            if (v[0].t >= st[0].max_visualizaciones) {
                await db.query('UPDATE stories SET activa = 0 WHERE id = ?', [sId]);
                io.emit('drop_agotado', { storyId: parseInt(sId) });
            }
        }
        res.json({ mensaje: 'OK' });
    } catch (e) { 
        console.error('🔥 Error registrando vista de story:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.post('/api/stories/:id/like', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [st] = await db.query('SELECT usuario_id FROM stories WHERE id = ?', [req.params.id]);
        if (st.length > 0 && st[0].usuario_id !== miId) {
            await db.query("INSERT INTO notificaciones (usuario_destino_id, usuario_origen_id, tipo) VALUES (?, ?, 'like')", [st[0].usuario_id, miId]);
            dispararPush(st[0].usuario_id, miId, 'like_story');
        }
        res.json({ success: true });
    } catch (e) { 
        console.error('🔥 Error dando like a story:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.get('/api/stories/:id/vistas', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    try {
        const [st] = await db.query('SELECT usuario_id FROM stories WHERE id = ?', [req.params.id]);
        if (st.length === 0 || st[0].usuario_id !== miId) return res.status(403).json({ error: 'No autorizado' });
        const [v] = await db.query(`SELECT u.id, u.username, u.avatar_url FROM visualizaciones_stories v JOIN usuarios u ON v.usuario_id = u.id WHERE v.story_id = ? AND u.id != ?`, [req.params.id, miId]);
        res.json(v.map(usr => ({ ...usr, avatar_url: arreglarUrl(usr.avatar_url) })));
    } catch (e) { 
        console.error('🔥 Error obteniendo vistas de story:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

app.delete('/api/stories/:id', verificarToken, async (req, res) => {
    try {
        const [r] = await db.query('DELETE FROM stories WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
        if (r.affectedRows === 0) return res.status(403).json({ error: 'No autorizado' });
        io.emit('drop_agotado', { storyId: parseInt(req.params.id) });
        res.json({ mensaje: 'OK' });
    } catch (e) { 
        console.error('🔥 Error borrando story:', e);
        res.status(500).json({ error: 'Error interno del servidor' }); 
    }
});

// ==========================================
// RUTA: CONFIGURACIÓN CUENTA
// ==========================================
app.delete('/api/usuarios/me', verificarToken, async (req, res) => {
    try {
        await db.query('DELETE FROM usuarios WHERE id = ?', [req.usuario.id]);
        res.json({ mensaje: 'OK' });
    } catch(e) {
        console.error('🔥 Error borrando cuenta:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
app.put('/api/usuarios/me/username', verificarToken, async (req, res) => {
    try {
        const [e] = await db.query('SELECT id FROM usuarios WHERE username = ? AND id != ?', [req.body.username, req.usuario.id]);
        if (e.length > 0) return res.status(400).json({ error: 'En uso' });
        await db.query('UPDATE usuarios SET username = ? WHERE id = ?', [req.body.username, req.usuario.id]);
        res.json({ mensaje: 'OK' });
    } catch(e) {
        console.error('🔥 Error editando username:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
app.put('/api/usuarios/me/email', verificarToken, async (req, res) => {
    try {
        const [e] = await db.query('SELECT id FROM usuarios WHERE email = ? AND id != ?', [req.body.email, req.usuario.id]);
        if (e.length > 0) return res.status(400).json({ error: 'En uso' });
        await db.query('UPDATE usuarios SET email = ? WHERE id = ?', [req.body.email, req.usuario.id]);
        res.json({ mensaje: 'OK' });
    } catch(e) {
        console.error('🔥 Error editando email:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});
app.put('/api/usuarios/me/password', verificarToken, async (req, res) => {
    try {
        const [u] = await db.query('SELECT password FROM usuarios WHERE id = ?', [req.usuario.id]);
        const ok = await bcrypt.compare(req.body.password_actual, u[0].password);
        if (!ok) return res.status(401).json({ error: 'Incorrecta' });
        const h = await bcrypt.hash(req.body.password_nueva, await bcrypt.genSalt(10));
        await db.query('UPDATE usuarios SET password = ? WHERE id = ?', [h, req.usuario.id]);
        res.json({ mensaje: 'OK' });
    } catch(e) {
        console.error('🔥 Error editando password:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ==========================================
// RUTAS: RECUPERACIÓN DE CONTRASEÑA
// ==========================================
app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const [usuarios] = await db.query('SELECT * FROM usuarios WHERE email = ?', [email]);
        if (usuarios.length === 0) return res.status(404).json({ error: 'Este correo no está registrado en Zync' });

        const codigo = Math.floor(100000 + Math.random() * 900000).toString();

        await db.query('DELETE FROM recuperacion_passwords WHERE email = ?', [email]);
        await db.query('INSERT INTO recuperacion_passwords (email, codigo, expira_en) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))', [email, codigo]);

        console.log(`\n🔐 INTENTANDO ENVIAR CÓDIGO [${codigo}] a ${email} POR RESEND...`);

        const { data, error } = await resend.emails.send({
            from: 'Zync App <no-reply@zync-app.net>',
            to: email,
            subject: 'Zync - Tu código de recuperación',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                    <h2 style="color: #1DA1F2;">Hola @${usuarios[0].username},</h2>
                    <p>Has solicitado restablecer tu contraseña. Tu código de verificación es:</p>
                    <div style="background-color: #f8f9fa; padding: 15px; text-align: center; border-radius: 8px; margin: 20px 0;">
                        <h1 style="color: #333; letter-spacing: 8px; margin: 0;">${codigo}</h1>
                    </div>
                    <p style="color: #666; font-size: 14px;">Este código caducará en 5 minutos. Si no has sido tú, puedes ignorar este mensaje de forma segura.</p>
                </div>
            `
        });

        if (error) {
            console.error('Error de Resend:', error);
            return res.status(500).json({ error: 'Error al enviar el correo con Resend' });
        }

        console.log('¡CORREO ENVIADO CON ÉXITO! ID:', data.id);
        res.json({ mensaje: 'Código enviado correctamente' });
        
    } catch (error) {
        console.error('🔥 Error del servidor en forgot-password:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

app.post('/api/auth/verify-reset-code', async (req, res) => {
    const { email, codigo } = req.body;
    try {
        const [registro] = await db.query('SELECT * FROM recuperacion_passwords WHERE email = ? AND codigo = ?', [email, codigo]);
        if (registro.length === 0) return res.status(400).json({ error: 'El código es incorrecto.' });

        const ahora = new Date();
        const expiracion = new Date(registro[0].expira_en);

        if (ahora > expiracion) {
            return res.status(400).json({ error: 'Este código ha caducado. Por favor, solicita uno nuevo.' });
        }

        res.json({ mensaje: 'Código válido' });
    } catch (error) {
        console.error('🔥 Error en verify-reset-code:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { email, codigo, nuevaPassword } = req.body;
    try {
        const [registro] = await db.query('SELECT * FROM recuperacion_passwords WHERE email = ? AND codigo = ? AND expira_en > NOW()', [email, codigo]);
        if (registro.length === 0) return res.status(400).json({ error: 'El código es inválido o ha caducado.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(nuevaPassword, salt);

        await db.query('UPDATE usuarios SET password = ? WHERE email = ?', [hashedPassword, email]);
        await db.query('DELETE FROM recuperacion_passwords WHERE email = ?', [email]);

        res.json({ mensaje: 'Contraseña cambiada con éxito' });
    } catch (error) {
        console.error('🔥 Error en reset-password:', error);
        res.status(500).json({ error: 'Error al cambiar contraseña' });
    }
});

// ==========================================
// RUTAS: MODERACIÓN (Reportes y Bloqueos)
// ==========================================
app.post('/api/reportar', verificarToken, async (req, res) => {
    const { usuario_destino_id, publicacion_id, motivo } = req.body;
    try {
        await db.query(
            'INSERT INTO reportes (usuario_origen_id, usuario_destino_id, publicacion_id, motivo) VALUES (?, ?, ?, ?)',
            [req.usuario.id, usuario_destino_id || null, publicacion_id || null, motivo]
        );
        res.json({ mensaje: 'Reporte enviado con éxito. Nuestro equipo lo revisará.' });
    } catch (e) {
        console.error('🔥 Error al reportar:', e);
        res.status(500).json({ error: 'Error al enviar el reporte' });
    }
});

app.post('/api/usuarios/:id/bloquear', verificarToken, async (req, res) => {
    const miId = req.usuario.id;
    const targetId = req.params.id;
    if (miId == targetId) return res.status(400).json({ error: 'No puedes bloquearte a ti mismo' });

    try {
        const [existe] = await db.query('SELECT id FROM bloqueos WHERE bloqueador_id = ? AND bloqueado_id = ?', [miId, targetId]);
        
        if (existe.length > 0) {
            await db.query('DELETE FROM bloqueos WHERE id = ?', [existe[0].id]);
            res.json({ bloqueado: false, mensaje: 'Usuario desbloqueado' });
        } else {
            await db.query('INSERT INTO bloqueos (bloqueador_id, bloqueado_id) VALUES (?, ?)', [miId, targetId]);
            await db.query('DELETE FROM seguidores WHERE (seguidor_id = ? AND seguido_id = ?) OR (seguidor_id = ? AND seguido_id = ?)', [miId, targetId, targetId, miId]);
            
            res.json({ bloqueado: true, mensaje: 'Usuario bloqueado' });
        }
    } catch (e) {
        console.error('🔥 Error al bloquear:', e);
        res.status(500).json({ error: 'Error interno' });
    }
});
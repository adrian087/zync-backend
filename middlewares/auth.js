const jwt = require('jsonwebtoken');

const verificarToken = (req, res, next) => {
    const token = req.header('Authorization');

    if (!token) {
        return res.status(401).json({ error: 'Acceso denegado. No hay token.' });
    }

    try {
        const tokenLimpio = token.replace('Bearer ', '');

        const verificado = jwt.verify(tokenLimpio, 'MI_CLAVE_SECRETA_SUPER_SEGURA');
        
        req.usuario = verificado;
        
        next(); 
    } catch (error) {
        res.status(400).json({ error: 'El token no es válido o ha caducado' });
    }
};

module.exports = verificarToken;
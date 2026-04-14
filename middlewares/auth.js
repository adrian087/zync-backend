const jwt = require('jsonwebtoken');

// Esta función es nuestro "Guardián"
const verificarToken = (req, res, next) => {
    // 1. Buscamos el token en la cabecera de la petición
    const token = req.header('Authorization');

    // 2. Si no hay token, le denegamos el paso
    if (!token) {
        return res.status(401).json({ error: 'Acceso denegado. No hay token.' });
    }

    try {
        // 3. El token suele venir como "Bearer eyJhbG...". Le quitamos la palabra "Bearer "
        const tokenLimpio = token.replace('Bearer ', '');

        // 4. Comprobamos si el token es real y no ha sido falsificado ni ha caducado
        const verificado = jwt.verify(tokenLimpio, 'MI_CLAVE_SECRETA_SUPER_SEGURA');
        
        // 5. Si es válido, guardamos los datos del usuario en "req.usuario" para usarlos luego
        req.usuario = verificado;
        
        // 6. Le decimos al servidor que puede continuar con lo que iba a hacer
        next(); 
    } catch (error) {
        res.status(400).json({ error: 'El token no es válido o ha caducado' });
    }
};

module.exports = verificarToken;
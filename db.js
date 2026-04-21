const mysql = require('mysql2');

// Creamos el "pool" de conexiones
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'red_social_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Exportamos la versión de promesas para usar async/await
const promisePool = pool.promise();

// Función para probar la conexión al arrancar
async function testConnection() {
    try {
        await promisePool.query('SELECT 1');
        console.log('🔌 Conectado a la base de datos MySQL con éxito');
    } catch (err) {
        console.error('❌ Error conectando a la base de datos:', err.message);
    }
}

testConnection();

module.exports = promisePool;
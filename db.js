const oracledb = require('oracledb');

async function getConnection() {
    try {
        const connection = await oracledb.getConnection({
            user: process.env.ORACLE_DB_USER,
            password: process.env.ORACLE_DB_PASSWORD,
            connectString: process.env.ORACLE_CONNECT_STRING
        });
        return connection;
    } catch (err) {
        console.error("Oracle Database connection failed:", err);
        throw err;
    }
}

module.exports = { getConnection };

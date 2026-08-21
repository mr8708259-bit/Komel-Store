const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const { getConnection } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ============================================================
// DATABASE INITIALIZATION (Oracle PL/SQL used for "IF NOT EXISTS")
// ============================================================
async function initDatabase() {
    let connection;
    try {
        connection = await getConnection();
        
        // Oracle 23c se pehle "IF NOT EXISTS" supported nahi hai, isliye PL/SQL block use kiya hai
        await connection.execute(`BEGIN
            EXECUTE IMMEDIATE 'CREATE TABLE products (id VARCHAR2(50) PRIMARY KEY, name VARCHAR2(255) NOT NULL, category VARCHAR2(100), price NUMBER(10,2) NOT NULL, stock NUMBER(10) DEFAULT 0, description CLOB, icon VARCHAR2(255))';
            EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
        END;`);

        await connection.execute(`BEGIN
            EXECUTE IMMEDIATE 'CREATE TABLE users (id VARCHAR2(50) PRIMARY KEY, username VARCHAR2(100) UNIQUE NOT NULL, email VARCHAR2(255) UNIQUE NOT NULL, password VARCHAR2(255) NOT NULL, joined TIMESTAMP DEFAULT CURRENT_TIMESTAMP)';
            EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
        END;`);

        await connection.execute(`BEGIN
            EXECUTE IMMEDIATE 'CREATE TABLE orders (id VARCHAR2(50) PRIMARY KEY, user_id VARCHAR2(50) REFERENCES users(id), total NUMBER(10,2) NOT NULL, status VARCHAR2(50) DEFAULT ''pending'', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)';
            EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
        END;`);

        await connection.execute(`BEGIN
            EXECUTE IMMEDIATE 'CREATE TABLE order_items (order_id VARCHAR2(50) REFERENCES orders(id), product_id VARCHAR2(50) REFERENCES products(id), quantity NUMBER(10) NOT NULL, price NUMBER(10,2) NOT NULL, PRIMARY KEY (order_id, product_id))';
            EXCEPTION WHEN OTHERS THEN IF SQLCODE != -955 THEN RAISE; END IF;
        END;`);

        console.log('✅ Database tables verified/created successfully!');
    } catch (err) {
        console.error('❌ Database initialization error:', err.message);
    } finally {
        if (connection) await connection.close();
    }
}

// Run initialization
initDatabase();

// ============================================================
// ROUTES (Oracle uses :1 instead of $1)
// ============================================================

app.get('/', (req, res) => {
    res.send('🚀 Server is running!');
});

// 1. GET all products
app.get('/api/products', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        const result = await connection.execute(
            `SELECT id, name, category, price, stock, description, icon FROM products ORDER BY name`,
            [],
            { outFormat: 4001 } // 4001 is OBJECT format
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// 2. ADD product (Admin)
app.post('/api/products', async (req, res) => {
    const { name, category, price, stock, description, icon } = req.body;
    let connection;
    try {
        connection = await getConnection();
        const id = 'p' + Date.now();
        await connection.execute(
            `INSERT INTO products (id, name, category, price, stock, description, icon)
             VALUES (:1, :2, :3, :4, :5, :6, :7)`,
            [id, name, category, price, stock, description, icon],
            { autoCommit: true }
        );
        res.status(201).json({ message: 'Product added', id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// 3. DELETE product (Admin)
app.delete('/api/products/:id', async (req, res) => {
    const productId = req.params.id;
    let connection;
    try {
        connection = await getConnection();
        await connection.execute(
            `DELETE FROM products WHERE id = :1`,
            [productId],
            { autoCommit: true }
        );
        res.json({ message: 'Product deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// 4. REGISTER (with password hashing)
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    let connection;
    try {
        connection = await getConnection();
        
        const check = await connection.execute(
            `SELECT username, email FROM users WHERE username = :1 OR email = :2`,
            [username, email]
        );
        
        if (check.rows.length > 0) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const id = 'u' + Date.now();
        
        await connection.execute(
            `INSERT INTO users (id, username, email, password, joined)
             VALUES (:1, :2, :3, :4, CURRENT_TIMESTAMP)`,
            [id, username, email, hashedPassword],
            { autoCommit: true }
        );
        
        res.status(201).json({
            token: 'dummy-token-' + Date.now(),
            user: { id, username, email }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// 5. LOGIN (with password verification)
app.post('/api/auth/login', async (req, res) => {
    const { identifier, password } = req.body;
    let connection;
    try {
        connection = await getConnection();
        const result = await connection.execute(
            `SELECT id, username, email, password FROM users 
             WHERE username = :1 OR email = :1`,
            [identifier]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        
        const isValid = await bcrypt.compare(password, user.PASSWORD); // Oracle returns uppercase keys
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        res.json({
            token: 'dummy-token-' + Date.now(),
            user: { id: user.ID, username: user.USERNAME, email: user.EMAIL }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// 6. CHECKOUT (place order with transaction)
app.post('/api/orders', async (req, res) => {
    const { items, total, userId } = req.body;
    let connection;
    try {
        connection = await getConnection();
        
        const orderId = 'ord' + Date.now();
        const userIdToUse = userId || 'u1';
        
        // Oracle auto-commit is off by default, so we control it manually
        await connection.execute(
            `INSERT INTO orders (id, user_id, total, status, created_at)
             VALUES (:1, :2, :3, 'pending', CURRENT_TIMESTAMP)`,
            [orderId, userIdToUse, total]
        );
        
        for (const item of items) {
            await connection.execute(
                `INSERT INTO order_items (order_id, product_id, quantity, price)
                 VALUES (:1, :2, :3, :4)`,
                [orderId, item.productId, item.quantity, item.price]
            );
            
            await connection.execute(
                `UPDATE products SET stock = stock - :1 WHERE id = :2`,
                [item.quantity, item.productId]
            );
        }
        
        await connection.commit(); // Commit the transaction
        
        res.status(201).json({ message: 'Order placed', orderId });
    } catch (err) {
        if (connection) await connection.rollback();
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// 7. ADMIN – get all orders
app.get('/api/admin/orders', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        const result = await connection.execute(`
            SELECT o.id, o.total, o.status, o.created_at, u.username 
            FROM orders o 
            LEFT JOIN users u ON o.user_id = u.id 
            ORDER BY o.created_at DESC`,
            [],
            { outFormat: 4001 }
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// 8. ADMIN – get all users
app.get('/api/admin/users', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        const result = await connection.execute(
            `SELECT id, username, email, joined FROM users ORDER BY username`,
            [],
            { outFormat: 4001 }
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (connection) await connection.close();
    }
});

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`✅ Test: https://your-render-url.onrender.com/`);
    console.log(`📦 Products: https://your-render-url.onrender.com/api/products`);
});

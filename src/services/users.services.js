const pool    = require('../../db/conn');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const jwt = require('jsonwebtoken');

// ─────────────────────────────────────────
// Alag alag keys — teen alag purposes
// ─────────────────────────────────────────
const PGP_SECRET_KEY  = process.env.PGP_SECRET_KEY;   // email, contact encrypt karne ke liye
const HMAC_SECRET_KEY = process.env.HMAC_SECRET_KEY;  // blind index (email_hash, contact_hash)
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET;   // stripe_webhook_secret encrypt karne ke liye

const BASE_URL = process.env.BASE_URL;                // e.g. https://yourdomain.com

// ─────────────────────────────────────────
// Blind index — HMAC_SECRET_KEY se
// ─────────────────────────────────────────
const createBlindIndex = (value) => {
    return crypto
        .createHmac('sha256', HMAC_SECRET_KEY)
        .update(value.toLowerCase().trim())
        .digest('hex');
};

const registerUserAndTenant = async (data) => {

    const {
        name,
        email,
        contact,
        country,
        password,
        business_name,
        slug,
        stripe_webhook_secret
    } = data;

    if (!name || !email || !password || !business_name || !slug) {
        throw new Error('Missing required fields');
    }

    if (!stripe_webhook_secret?.startsWith('whsec_')) {
        throw new Error('Invalid Stripe webhook secret — must start with whsec_');
    }

    const hashPassword = await bcrypt.hash(password, 12);

    // HMAC_SECRET_KEY se blind index banta hai
    const emailHash   = createBlindIndex(email);
    const contactHash = contact ? createBlindIndex(contact) : null;

    const client = await pool.connect();

    try {

        await client.query('BEGIN');

        // ── Check existing user ───────────────────────────────────────────
        // email BYTEA hai — direct compare nahi hoga
        // email_hash (blind index) se check karo
        const existingUser = await client.query(
            `SELECT id FROM users WHERE email_hash = $1`,
            [emailHash]
        );

        if (existingUser.rows.length > 0) {
            throw new Error('User with this email already exists');
        }

        // ── Create user ───────────────────────────────────────────────────
        // PGP_SECRET_KEY se email aur contact encrypt hoga
        const userResult = await client.query(
            `INSERT INTO users (
                name,
                email,
                email_hash,
                contact,
                contact_hash,
                country,
                password
            )
            VALUES (
                $1,
                pgp_sym_encrypt($2, $3),
                $4,
                CASE
                    WHEN $5 = '' THEN NULL
                    ELSE pgp_sym_encrypt($5, $3)
                END,
                $6,
                $7,
                $8
            )
            RETURNING
                id,
                name,
                email_hash,
                contact_hash,
                country,
                created_at;`,
            [
                name,
                email,          // $2 → PGP_SECRET_KEY se encrypt
                PGP_SECRET_KEY, // $3 → sirf user PII ke liye
                emailHash,      // $4 → HMAC blind index
                contact || '',  // $5 → PGP_SECRET_KEY se encrypt
                contactHash,    // $6 → HMAC blind index
                country,        // $7
                hashPassword    // $8
            ]
        );

        const user = userResult.rows[0];

        // ── Create tenant ─────────────────────────────────────────────────
        // WEBHOOK_SECRET se stripe_webhook_secret encrypt hoga — alag key
        const tenantResult = await client.query(
            `INSERT INTO tenants (
                business_name,
                slug,
                admin_id,
                stripe_webhook_secret
            )
            VALUES (
                $1,
                $2,
                $3,
                pgp_sym_encrypt($4, $5)
            )
            RETURNING
                id,
                business_name,
                slug,
                created_at;`,
            [
                business_name,
                slug,
                user.id,
                stripe_webhook_secret, // $4 → Stripe ka whsec_
                WEBHOOK_SECRET         // $5 → sirf webhook ke liye alag key
            ]
        );

        const tenant = tenantResult.rows[0];

        await client.query('COMMIT');

        // Tenant ID se unique webhook URL banta hai
        const webhook_url = `${BASE_URL}/webhooks/stripe/${tenant.id}`;

        return {
            user,
            tenant: {
                id:            tenant.id,
                business_name: tenant.business_name,
                slug:          tenant.slug,
                created_at:    tenant.created_at
            },
            // Client isko Stripe Dashboard mein save karega
            webhook_url
        };

    } catch (error) {
    await client.query('ROLLBACK');

    // Postgres unique violation code — 23505
    if (error.code === '23505') {
        if (error.constraint === 'tenants_slug_key') {
            throw new Error('Slug already taken — choose a different one');
        }
        if (error.constraint === 'users_email_hash_key') {
            throw new Error('User with this email already exists');
        }
    }

    throw error;
} finally {
        client.release();
    }
};


// ─────────────────────────────────────────
// Email se user dhundho aur login - karo blind index use hoga
// PGP_SECRET_KEY se email decrypt hoga
// ─────────────────────────────────────────
const loginUser = async (email, password) => {
    if (!email || !password) {
        throw new Error('Please provide all the details!');
    }

    const emailHash = createBlindIndex(email);

    // SQL query mein ::TEXT cast lagaya taaki BYTEA se pure String bane
    const result = await pool.query(
        `SELECT
            id,
            email_hash,
            pgp_sym_decrypt(email, $2)::TEXT AS email, 
            password
         FROM users
         WHERE email_hash = $1`,
        [emailHash, PGP_SECRET_KEY]
    );

    const user = result.rows[0] || null;
    if (!user) {
        throw new Error('No user found with this email');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
        throw new Error('Credentials do not match');
    }

    // Ab user.email ek pure Clean String hai, payload perfect banega
    const token = jwt.sign(
        {
            id: user.id,
            email: user.email
        },
        process.env.JWT_SECRET,
        {
            expiresIn: '1h'
        }
    );

    return { token };
};

// ─────────────────────────────────────────
// Email se user dhundho — blind index use hoga
// PGP_SECRET_KEY se email decrypt hoga
// ─────────────────────────────────────────
const findUserByEmail = async (email) => {

    const emailHash = createBlindIndex(email);

    const result = await pool.query(
        `SELECT
            id,
            name,
            email_hash,
            pgp_sym_decrypt(email, $2) AS email,
            country,
            password,
            created_at
         FROM users
         WHERE email_hash = $1`,
        [emailHash, PGP_SECRET_KEY]
    );

    return result.rows[0] || null;
};

const getTenantDetails = async (userId) => {
    if (!userId) {
        const error = new Error("User Id missing!");
        error.statusCode = 400;
        throw error;
    }

    const result = await pool.query(
        `SELECT t.id AS tenant_id 
         FROM tenants t
         JOIN users u ON u.id = t.admin_id
         WHERE u.id = $1`,
        [userId]
    );

    if (result.rows.length === 0) {
        const error = new Error("No tenant found for this user!");
        error.statusCode = 404;
        throw error;
    }

    return result.rows[0];
};

module.exports = {
    registerUserAndTenant,
    findUserByEmail,
    loginUser,
    getTenantDetails
};
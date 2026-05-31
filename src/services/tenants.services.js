const pool = require('../../db/conn');

const createTenant = async(data)=>{
    const {
        business_name,
        slug,
        admin_id
    } = data

    const query = `
    INSERT INTO tenants (
    business_name,
    slug,
    admin_id
    )
    VALUES($!, $2, $3)
    RETURNIN *;
    `

    const values = [
        business_name, slug, admin_id
    ];

    const result = await pool.query(query, values);

    return result.rows[0];
}


module.exports = {createTenant};



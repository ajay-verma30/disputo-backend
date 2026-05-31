const tenantService = require('../services/tenants.services');

const createTenant = async (req, res) => {
    try {

        const tenant = await tenantService.createTenant(req.body);

        return res.status(201).json({
            success: true,
            data: tenant
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }
};

module.exports = {
    createTenant
};
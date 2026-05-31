const userService = require('../services/users.services');

const registerUser = async (req, res) => {

    try {

        const result = await userService.registerUserAndTenant(req.body);

        return res.status(201).json({
            success: true,
            message: 'User registered successfully',
            data: result
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            message: error.message
        });

    }

};


const loginUser = async(req,res) =>{
    try{
const { email, password } = req.body;
const result = await userService.loginUser(email, password);
        return res.status(200).json({
            success: true,
            data: result
        });
    } catch(error){
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
}


const getUserTenant = async (req, res) => {
    try {
        const userId = req.user.id; 

        const result = await userService.getTenantDetails(userId);

        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};


module.exports = {
    registerUser,
    loginUser,
    getUserTenant
};
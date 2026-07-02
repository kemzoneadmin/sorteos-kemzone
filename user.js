const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
    verificationCode: { type: String },
    tokems: { type: Number, default: 0 }, // Aquí guardaremos su saldo
    history: { type: Array, default: [] } // Historial de jugadas/compras
});

module.exports = mongoose.model('User', userSchema);
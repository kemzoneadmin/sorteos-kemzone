require('dotenv').config(); 
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // 🚀 OBLIGA A USAR IPV4 (Cura el error ENETUNREACH de Railway)

const express = require('express');
const { ApifyClient } = require('apify-client');
// ... (el resto de tus imports siguen igual)
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose'); // 🚀 Conector oficial para MongoDB
const bcrypt = require('bcrypt'); // 🔐 Para encriptar contraseñas
const jwt = require('jsonwebtoken'); // 🔐 Para mantener sesiones activas
const { Resend } = require('resend'); // 🚀 Activamos el motor de Resend
const resend = new Resend(process.env.RESEND_API_KEY);
const rateLimit = require('express-rate-limit');

const previewLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hora
    max: 20, // Máximo 20 previsualizaciones por IP cada hora
    message: { error: 'Demasiadas consultas desde esta conexión. Intenta más tarde.' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 10, // Máximo 10 intentos de registro/login
    message: { error: 'Has superado el límite de intentos. Espera 15 minutos.' }
});

const app = express();
app.set('trust proxy', 1); // 🚀 Permite a express-rate-limit leer la IP real del cliente en Railway
const port = process.env.PORT || 3000;

// 🔗 CONEXIÓN CENTRAL A BASE DE DATOS
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('📦 Conectado con éxito a MongoDB Atlas'))
    .catch(err => console.error('❌ Error crítico al conectar a MongoDB:', err));

// =================================================================
// 📝 ESQUEMAS Y MODELOS DE BASE DE DATOS
// =================================================================
const PinSchema = new mongoose.Schema({
    code: { type: String, unique: true, uppercase: true, trim: true },
    tokens: { type: Number, required: true },
    used: { type: Boolean, default: false }
});
const Pin = mongoose.model('Pin', PinSchema, 'pines'); 

const PreviewSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    date: { type: String, required: true },
    count: { type: Number, default: 0 }
});
const Preview = mongoose.model('Preview', PreviewSchema);

// 💰 NUEVO ESQUEMA: SALDOS DE USUARIOS (Para guardar las compras de Shopify)
const BalanceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    tokens: { type: Number, default: 0 }
});
const Balance = mongoose.model('Balance', BalanceSchema);

// 🔒 NUEVO ESQUEMA: CUENTAS DE USUARIOS REGISTRADOS
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
    verificationCode: { type: String },
    tokems: { type: Number, default: 0 },
    history: { type: Array, default: [] },
    customConfig: { type: Object, default: null } // 👈 Agregado para guardar el diseño en la nube
});
const User = mongoose.model('User', UserSchema);

// =================================================================
// 📜 NUEVO ESQUEMA: HISTORIAL DE SORTEOS
// =================================================================
const historySchema = new mongoose.Schema({
    deviceId: { type: String, required: true }, // Guarda el correo o UUID
    drawId: { type: String, uppercase: true, trim: true },
    maquina: { type: String, required: true },  // Ruleta, Slots, Vasos, etc.
    url: { type: String },                      // El enlace del post de TikTok/Ig
    fecha: { type: Date, default: Date.now },   // Fecha exacta automática
    ganadores: [{
        nombre: String,
        texto: String,
        avatarUrl: String
    }]
});
const History = mongoose.model('History', historySchema);

// =================================================================
// 💳 NUEVO ESQUEMA: HISTORIAL DE TRANSACCIONES (COMPRAS Y CANJES)
// =================================================================
const TransactionSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, index: true },
    tipo: { type: String, enum: ['Compra', 'Canje'], required: true },
    tokens: { type: Number, required: true },
    plan: { type: String, default: '' },
    precio: { type: String, default: '' },
    codigoPin: { type: String, default: '' },
    detalles: { type: String, default: '' },
    fecha: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// =================================================================
// 🛡️ ESQUEMA: CERTIFICADOS DE VERIFICACIÓN PÚBLICA (SELLADO ANTIFRAUDE)
// =================================================================
const DrawVerificationSchema = new mongoose.Schema({
    drawId: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    deviceId: { type: String, index: true },
    maquina: { type: String, default: 'Sorteo' },
    url: { type: String, default: '' },
    plataforma: { type: String, default: 'Instagram' },
    fecha: { type: Date, default: Date.now },
    ganadores: [{
        nombre: String,
        texto: String,
        avatarUrl: String,
        isSuplente: Boolean,
        posicion: Number
    }],
    totalComentarios: { type: Number, default: 0 },
    totalParticipantesValidos: { type: Number, default: 0 },
    verificationHash: { type: String, required: true },
    participantes: [{ type: String }] // Lista de nombres limpios en minúsculas para el buscador
}, { timestamps: true });

// ⚡ Índice compuesto para que la búsqueda por ID y por usuario responda en 1 milisegundo
DrawVerificationSchema.index({ drawId: 1, 'participantes': 1 });

// ⚡ Auto-eliminación tras 7 días (604.800 segundos) para no acumular datos viejos
DrawVerificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });

const DrawVerification = mongoose.model('DrawVerification', DrawVerificationSchema);

// 🔒 CLIENTE APIFY PROTEGIDO CON VARIABLES DE ENTORNO
const client = new ApifyClient({
    token: process.env.APIFY_TOKEN
});

// =================================================================
// 7. ENDPOINT: WEBHOOK DE SHOPIFY (BLINDADO CON HMAC)
// =================================================================
// IMPORTANTE: Esta ruta debe ir ANTES de los app.use(express.json())
app.post('/api/shopify-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const hmac = req.header('X-Shopify-Hmac-Sha256');
        const secret = process.env.SHOPIFY_SECRET; 

        // 1. Calculamos el sello matemático con el mensaje intacto
        const hash = crypto
            .createHmac('sha256', secret)
            .update(req.body, 'utf8', 'hex')
            .digest('base64');

        // 2. Si los sellos no coinciden, rebotamos al atacante
        if (hash !== hmac) {
            console.log('⚠️ Intento de recarga de Tokems FALSA detectado.');
            return res.status(401).send('Firma de Shopify inválida');
        }

        // 3. Si el sello es real, convertimos el mensaje a formato entendible
        const order = JSON.parse(req.body.toString());

        // --- A PARTIR DE AQUÍ ES TU LÓGICA ORIGINAL ---
        let deviceId = null;
        
        const atributos = order.note_attributes || [];
        const deviceIdAttr = atributos.find(attr => attr.name === '_deviceId');
        if (deviceIdAttr) deviceId = deviceIdAttr.value;

        if (!deviceId && order.line_items && order.line_items.length > 0) {
            const props = order.line_items[0].properties || [];
            const propAttr = props.find(p => p.name === '_deviceId');
            if (propAttr) deviceId = propAttr.value;
        }

if (!deviceId || deviceId === 'null' || deviceId === 'undefined') {
            console.log("⚠️ Webhook ignorado: No se detectó un deviceId válido.");
            return res.status(200).send("Pedido sin deviceId"); 
        }

// 🔒 Evitar duplicación por reintentos automáticos de Shopify (Coincidencia exacta)
        const ordenId = String(order.order_number || order.id || '');
        if (ordenId) {
            const yaProcesada = await Transaction.findOne({ detalles: `Compra Shopify #${ordenId}` });
            if (yaProcesada) {
                console.log(`⚠️ Webhook ignorado: La orden #${ordenId} ya fue acreditada anteriormente.`);
                return res.status(200).send("Orden ya procesada");
            }
        }

        console.log(`🛒 ¡Pedido pagado detectado para el identificador: ${deviceId}!`);

        let tokensAAgregar = 0;
        const lineItems = order.line_items || [];

        lineItems.forEach(item => {
            const variantIdString = String(item.variant_id);
            const cantidadComprada = item.quantity || 1;

            if (TOKENS_POR_VARIANTE[variantIdString]) {
                const tokensDelPlan = TOKENS_POR_VARIANTE[variantIdString];
                tokensAAgregar += (tokensDelPlan * cantidadComprada);
            }
        });

        if (tokensAAgregar === 0) {
            console.log("⚠️ El pedido no contenía ninguna variante de Tokems registrada.");
            return res.status(200).send("No hay tokens que sumar");
        }

        const identificadorLimpio = deviceId.trim().toLowerCase();
        
        // Buscamos si es cuenta registrada o invitado
        let usuarioCuenta = await User.findOne({ email: identificadorLimpio });

        if (usuarioCuenta) {
            usuarioCuenta.tokems = (usuarioCuenta.tokems || 0) + tokensAAgregar;
            await usuarioCuenta.save();
            console.log(`✅ Éxito (Cuenta): Se le sumaron ${tokensAAgregar} Tokems al usuario registrado ${identificadorLimpio}. Nuevo saldo: ${usuarioCuenta.tokems}`);
        } else {
            let registroInvitado = await Balance.findOne({ deviceId: deviceId });
            
            if (!registroInvitado) {
                registroInvitado = new Balance({ deviceId: deviceId, tokens: 0 });
            }
            
            registroInvitado.tokens += tokensAAgregar;
            await registroInvitado.save();
            console.log(`✅ Éxito (Invitado): Se le sumaron ${tokensAAgregar} Tokems al dispositivo anónimo ${deviceId}. Nuevo saldo: ${registroInvitado.tokens}`);
        }

        // Registramos la transacción
        const nuevaTx = new Transaction({
            deviceId: identificadorLimpio,
            tipo: 'Compra',
            tokens: tokensAAgregar,
            precio: order.total_price ? `$${order.total_price}` : '',
            detalles: `Compra Shopify #${order.order_number || order.id || ''}`
        });
        await nuevaTx.save();

        return res.status(200).send("Webhook procesado con éxito");

    } catch (error) {
        console.error("❌ Error procesando el Webhook de Shopify:", error);
        return res.status(500).send("Error interno del servidor");
    }
});

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.get('/', (req, res) => {
    res.send('Base del servidor de KemZone activa y corriendo.');
});

// EL GUARDIA DE SEGURIDAD
const verificarTokenOpcional = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        // Es un usuario invitado, lo dejamos pasar con su deviceId
        return next();
    }

    const tokenLimpio = authHeader.split(" ")[1];
    jwt.verify(tokenLimpio, process.env.JWT_SECRET, (err, decoded) => {
        if (!err && decoded) {
            req.user = decoded;
        }
        next();
    });
};

// 🎛️ FUNCIONES DE MINERÍA PROFUNDA PARA EVITAR LLAVES VACÍAS EN TIKTOK
function extraerAvatarDinamicamente(obj) {
    if (!obj || typeof obj !== 'object') return "";
    const llavesDirectas = ['avatar', 'avatarThumb', 'avatarMedium', 'profilePicUrl', 'avatar_thumb', 'author_avatar', 'user_avatar'];
    for (let key of llavesDirectas) {
        if (obj[key] && typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key];
    }
    let urlEncontrada = "";
    function escanear(item, parentKey = '') {
        if (urlEncontrada) return;
        if (!item || typeof item !== 'object') return;
        for (let k in item) {
            if (Object.prototype.hasOwnProperty.call(item, k)) {
                const val = item[k];
                const pk = (k + '_' + parentKey).toLowerCase();
                if (typeof val === 'string' && val.startsWith('http')) {
                    if (pk.includes('avatar') || pk.includes('thumb') || pk.includes('pic') || pk.includes('image') || pk.includes('icon')) {
                        urlEncontrada = val;
                        return;
                    }
                } else if (val && typeof val === 'object') {
                    escanear(val, k);
                }
            }
        }
    }
    escanear(obj);
    if (urlEncontrada) return urlEncontrada;
    function buscarCualquierUrlDeImagen(item) {
        if (urlEncontrada) return;
        if (!item || typeof item !== 'object') return;
        for (let k in item) {
            if (Object.prototype.hasOwnProperty.call(item, k)) {
                const val = item[k];
                if (typeof val === 'string' && val.startsWith('http')) {
                    if (!val.includes('/video/') && !val.includes('tiktok.com/@') && (val.includes('p16') || val.includes('p77') || val.includes('tos-') || val.includes('avatar') || val.includes('image'))) {
                        urlEncontrada = val;
                        return;
                    }
                } else if (val && typeof val === 'object') {
                    buscarCualquierUrlDeImagen(val);
                }
            }
        }
    }
    buscarCualquierUrlDeImagen(obj);
    return urlEncontrada;
}

function extraerUsuarioDinamicamente(obj) {
    if (!obj || typeof obj !== 'object') return "Participante";
    if (obj.uniqueId && typeof obj.uniqueId === 'string') return obj.uniqueId;
    if (obj.username && typeof obj.username === 'string') return obj.username;
    if (obj.authorMeta?.uniqueId) return obj.authorMeta.uniqueId;
    if (obj.authorMeta?.name) return obj.authorMeta.name;
    if (obj.user?.uniqueId) return obj.user.uniqueId;
    if (obj.author?.uniqueId) return obj.author.uniqueId;
    if (obj.nickname && typeof obj.nickname === 'string') return obj.nickname;
    let userEncontrado = "";
    function buscarLlave(item) {
        if (userEncontrado) return;
        if (!item || typeof item !== 'object') return;
        const llavesFiltro = ['uniqueid', 'username', 'screen_name', 'nickname'];
        for (let k in item) {
            if (Object.prototype.hasOwnProperty.call(item, k)) {
                if (llavesFiltro.includes(k.toLowerCase()) && typeof item[k] === 'string' && item[k].length > 0) {
                    userEncontrado = item[k];
                    return;
                } else if (item[k] && typeof item[k] === 'object') {
                    buscarLlave(item[k]);
                }
            }
        }
    }
    buscarLlave(obj);
    return userEncontrado || "Participante";
}

// =================================================================
// 🔐 NUEVOS ENDPOINTS: SISTEMA DE AUTENTICACIÓN Y CUENTAS
// =================================================================

// 1. REGISTRO DE USUARIOS + ENVÍO DE CÓDIGO
app.post('/api/register', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'El correo y la contraseña son obligatorios' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        let usuario = await User.findOne({ email: correoLimpio });
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const codigoVerificacion = Math.floor(100000 + Math.random() * 900000).toString();

        if (usuario) {
            if (usuario.isVerified) {
                return res.status(400).json({ error: 'El correo electrónico ya está registrado y verificado. Por favor inicia sesión.' });
            } else {
                usuario.password = hashedPassword;
                usuario.verificationCode = codigoVerificacion;
                await usuario.save();
            }
        } else {
            usuario = new User({
                email: correoLimpio,
                password: hashedPassword,
                verificationCode: codigoVerificacion
            });
            await usuario.save();
        }

        // 🚀 NUEVO ENVÍO MEDIANTE API DE RESEND (Bypassea cualquier bloqueo de puertos)
        await resend.emails.send({
            from: 'KZ Sorteos <registro@kzsorteos.com>', // 🔥 Tu dominio verificado actuando de forma nativa
            to: correoLimpio,
            subject: 'Código de verificación - Panel KZ',
            html: `
                <div style="font-family: sans-serif; background-color: #0d0d14; color: #ffffff; padding: 20px; border-radius: 10px; border: 1px solid #66ff33; max-width: 500px;">
                    <h2 style="color: #66ff33; text-transform: uppercase;">¡Bienvenido al Panel KZ!</h2>
                    <p style="color: #aaaaaa;">Usa el siguiente código de seguridad de 6 dígitos para verificar tu cuenta y activar tu almacenamiento en la nube:</p>
                    <div style="background-color: #1a1a20; border: 1px dashed #66ff33; padding: 15px; text-align: center; font-size: 28px; font-weight: bold; color: #66ff33; letter-spacing: 5px; border-radius: 5px; margin: 20px 0;">
                        ${codigoVerificacion}
                    </div>
                    <p style="font-size: 12px; color: #555555;">Si no solicitaste este registro, puedes ignorar este correo de forma segura.</p>
                </div>
            `
        });

        return res.status(200).json({ message: 'Código de verificación enviado al correo de forma exitosa.' });
    } catch (error) {
        console.error('Error en /api/register:', error);
        return res.status(500).json({ error: 'Error interno en el servidor durante el registro.' });
    }
});

// 2. VERIFICACIÓN DEL CÓDIGO DE REGISTRO
app.post('/api/verify', authLimiter, async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'El correo y el código son estrictamente requeridos.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const usuario = await User.findOne({ email: correoLimpio });

        if (!usuario || usuario.verificationCode !== code.trim()) {
            return res.status(400).json({ error: 'El código de seguridad introducido es incorrecto.' });
        }

        usuario.isVerified = true;
        usuario.verificationCode = null; 
        await usuario.save();

        return res.status(200).json({ success: true, message: 'Tu cuenta ha sido verificada exitosamente.' });
    } catch (error) {
        console.error('Error en /api/verify:', error);
        return res.status(500).json({ error: 'Error interno al procesar la verificación.' });
    }
});

// 3. INICIO DE SESIÓN (LOGIN)
app.post('/api/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Por favor rellena todos los campos.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const usuario = await User.findOne({ email: correoLimpio });

        if (!usuario || !(await bcrypt.compare(password, usuario.password))) {
            return res.status(400).json({ error: 'El correo o la contraseña son totalmente incorrectos.' });
        }
        if (!usuario.isVerified) {
            return res.status(401).json({ error: 'Esta cuenta no se encuentra verificada. Revisa tu correo electrónico.' });
        }

        const token = jwt.sign(
            { userId: usuario._id, email: usuario.email },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        // 🚀 OBTENEMOS EL CONTEO DE LA CUENTA (Totalmente independiente)
        const hoy = new Date().toLocaleDateString();
        let previewCount = 0;
        let finalReg = await Preview.findOne({ deviceId: correoLimpio, date: hoy });
        if (finalReg) previewCount = finalReg.count;

       return res.json({
            success: true,
            token,
            tokems: usuario.tokems,
            previewCount,
            customConfig: usuario.customConfig // 👈 Envía el diseño guardado al loguearse
        });
    } catch (error) {
        console.error('Error en /api/login:', error);
        return res.status(500).json({ error: 'Error interno en el servidor al intentar loguear.' });
    }
});

// =================================================================
// 🔄 ENDPOINT: FUSIONAR SALDO, HISTORIALES Y DISEÑO A LA CUENTA
// =================================================================
app.post('/api/transfer-guest', async (req, res) => {
    const { email, deviceId, customConfig } = req.body;
    if (!email || !deviceId) return res.status(400).json({ error: 'Faltan parámetros.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const usuario = await User.findOne({ email: correoLimpio });
        if (!usuario) return res.status(404).json({ error: 'Cuenta no encontrada.' });

        // 1. 🪙 Transferir Saldo de Tokems de Balance a la Cuenta
        const registroBalance = await Balance.findOneAndUpdate(
            { deviceId: deviceId, tokens: { $gt: 0 } },
            { $set: { tokens: 0 } },
            { new: false }
        );

        let tokensSumados = 0;
        if (registroBalance && registroBalance.tokens > 0) {
            tokensSumados = registroBalance.tokens;
        }

        // 2. 🎨 Preparar actualización atómica de cuenta y diseño
        const updateDoc = {
            $inc: { tokems: tokensSumados }
        };

        if (customConfig && typeof customConfig === 'object') {
            updateDoc.$set = { customConfig: customConfig };
        }

        const usuarioActualizado = await User.findOneAndUpdate(
            { email: correoLimpio },
            updateDoc,
            { new: true }
        );

        // 3. 🎟️ Migrar Historial de Sorteos realizados como invitado a la Cuenta
        await History.updateMany(
            { deviceId: deviceId },
            { $set: { deviceId: correoLimpio } }
        );

        // 4. 💳 Migrar Historial de Transacciones a la Cuenta
        await Transaction.updateMany(
            { deviceId: deviceId },
            { $set: { deviceId: correoLimpio } }
        );

        // 5. Conteo de previsualizaciones
        const hoy = new Date().toLocaleDateString();
        let previewCount = 0;
        let userPreview = await Preview.findOne({ deviceId: correoLimpio, date: hoy });
        if (userPreview) previewCount = userPreview.count;

        return res.status(200).json({ 
            success: true, 
            nuevoSaldo: usuarioActualizado ? usuarioActualizado.tokems : usuario.tokems,
            previewCount,
            customConfig: usuarioActualizado ? usuarioActualizado.customConfig : usuario.customConfig 
        });
    } catch (error) {
        console.error('Error en transferencia integral:', error);
        return res.status(500).json({ error: 'Error interno fusionando los balances, historiales y diseño.' });
    }
});

// =================================================================
// 1. ENDPOINT: PREVISUALIZACIÓN (ABORTABLE EN TIEMPO REAL EN APIFY)
// =================================================================
app.post('/api/preview', previewLimiter, async (req, res) => {
    const { url, deviceId } = req.body; 
    if (!url || !deviceId) return res.status(400).json({ error: 'La URL y el deviceId son obligatorios' });

    if (!url.includes('tiktok.com') && !url.includes('instagram.com')) {
        return res.status(400).json({ error: 'El enlace debe pertenecer a una publicación de Instagram o TikTok.' });
    }

    const hoy = new Date().toLocaleDateString();
    const identificadorLimpio = deviceId.trim().toLowerCase();
    let apifyRunId = null;
    let canceladoPorCliente = false;

    // 🛑 Listener: Si el usuario presiona "Volver" o "X", cancela el Actor de Apify al instante
    req.on('close', async () => {
        if (!res.writableEnded) {
            canceladoPorCliente = true;
            console.log(`[🛑] Previsualización cancelada por el usuario: ${url}`);
            
            // Revertir el conteo diario
            try {
                let roll = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
                if (roll && roll.count > 0) {
                    roll.count--;
                    await roll.save();
                }
            } catch(e) {}

            // Abortar la ejecución en Apify para frenar el gasto
            if (apifyRunId) {
                try {
                    await client.run(apifyRunId).abort();
                    console.log(`[🛑] Ejecución de Apify ${apifyRunId} detenida con éxito.`);
                } catch(e) {
                    console.log("Aviso al abortar en Apify:", e.message);
                }
            }
        }
    });

    try {
        const esCuenta = identificadorLimpio.includes('@');
        const limiteMaximo = esCuenta ? 6 : 3;

        let registro = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
        if (!registro) {
            registro = new Preview({ deviceId: identificadorLimpio, date: hoy, count: 0 });
        }

        if (registro.count > limiteMaximo) {
            registro.count = limiteMaximo;
            await registro.save();
        }

        if (registro.count >= limiteMaximo) {
            return res.status(429).json({ error: `Límite diario de ${limiteMaximo} previsualizaciones agotado por hoy.` });
        }

        registro.count++;
        await registro.save();

        const esTikTok = url.includes('tiktok.com');
        console.log(`\n[🔍] Procesando previsualización (${esTikTok ? 'TikTok' : 'Instagram'}): ${url}`);

        if (esTikTok) {
            const inputTikTok = {
                "postURLs": [url],
                "resultsLimit": 1,
                "commentsPerPost": 0,
                "downloadVideos": false,
                "extractTranscripts": false
            };

            // Inicia el actor guardando su ID para permitir abortos
            const run = await client.actor("clockworks/tiktok-scraper").start(inputTikTok);
            apifyRunId = run.id;

            await client.run(run.id).waitForFinish();
            if (canceladoPorCliente) return;

            const { items } = await client.dataset(run.defaultDatasetId).listItems();

            if (!items || items.length === 0) {
                registro.count--;
                await registro.save();
                return res.status(404).json({ error: 'No se encontraron datos en TikTok.' });
            }

            const postData = items[0];
            const username = extraerUsuarioDinamicamente(postData);
            const description = postData.text || postData.desc || 'Sin descripción.';
            const coverUrl = postData.videoMeta?.coverUrl || postData.videoMeta?.posterUrl || postData.coverUrl || postData.video?.cover || '';

            return res.json({
                author: `@${username}`,
                rawUsername: username,
                description: description,
                commentsCount: postData.commentCount || 0,
                likesCount: postData.diggCount || 0,
                displayUrl: coverUrl,
                currentCount: registro.count
            });

        } else {
            const inputInstagram = {
                "directUrls": [url],
                "resultsType": "posts",
                "resultsLimit": 1,
                "addParentData": false
            };

            const run = await client.actor("shu8hvrXbJbY3Eb9W").start(inputInstagram);
            apifyRunId = run.id;

            await client.run(run.id).waitForFinish();
            if (canceladoPorCliente) return;

            const { items } = await client.dataset(run.defaultDatasetId).listItems();

            if (!items || items.length === 0) {
                registro.count--;
                await registro.save();
                return res.status(404).json({ error: 'No se encontraron datos.' });
            }

            const postData = items[0];
            const authorUsername = postData.ownerUsername || postData.username || 'usuario_instagram';

            let coverUrl = postData.displayUrl || postData.thumbnailUrl || postData.imageUrl;
            if (coverUrl) coverUrl = coverUrl.replace(/&amp;/g, '&');

            return res.json({
                author: `@${authorUsername}`,
                rawUsername: authorUsername,
                description: postData.caption || 'Sin descripción.',
                commentsCount: postData.commentsCount || 0,
                likesCount: postData.likesCount || 0,
                displayUrl: coverUrl,
                currentCount: registro.count
            });
        }
    } catch (error) {
        if (!canceladoPorCliente) {
            try {
                let roll = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
                if (roll && roll.count > 0) {
                    roll.count--;
                    await roll.save();
                }
            } catch(e) {}
            console.error('❌ Error en /api/preview:', error.message);
            return res.status(500).json({ error: error.message });
        }
    }
});

// =================================================================
// 2. ENDPOINT: EXTRACCIÓN MASIVA (CON REEMBOLSO AUTOMÁTICO Y TOPE SEGURO)
// =================================================================

// 🧮 Función oficial de cálculo de Tokems según la tabla de precios
function calcularCostoTokemsServidor(total) {
    const c = parseInt(total) || 0;
    if (c <= 300) return 1;
    if (c <= 600) return 2;
    if (c <= 1000) return 3;
    if (c <= 2000) return 6;
    if (c <= 4000) return 12;
    if (c <= 10000) return 24;
    if (c <= 12500) return 30;
    if (c <= 15000) return 36;
    if (c <= 17500) return 42;
    if (c <= 20000) return 48;
    const bloquesExtras = Math.ceil((c - 20000) / 500);
    return 48 + bloquesExtras;
}

app.post('/api/comments', verificarTokenOpcional, async (req, res) => {
    const { url, maxComments, deviceId, costoTokens } = req.body;
    if (!url) return res.status(400).json({ error: 'La URL es obligatoria' });

    if (!url.includes('tiktok.com') && !url.includes('instagram.com')) {
        return res.status(400).json({ error: 'El enlace debe pertenecer a una publicación de Instagram o TikTok.' });
    }

    const esTikTok = url.includes('tiktok.com');
    const costoReal = parseInt(costoTokens) || 0;
    
    // 🔒 Techo máximo calculado de forma segura en servidor
    function obtenerTechoServidor(tokens) {
        if (tokens <= 1) return 300;
        if (tokens === 2) return 600;
        if (tokens === 3) return 1000;
        if (tokens === 6) return 2000;
        if (tokens === 12) return 4000;
        if (tokens === 24) return 10000;
        if (tokens === 30) return 12500;
        if (tokens === 36) return 15000;
        if (tokens === 42) return 17500;
        if (tokens === 48) return 20000;
        return 20000 + ((tokens - 48) * 500);
    }

// ✅ CÓDIGO CORREGIDO Y SEGURO
const techoSeguro = obtenerTechoServidor(costoReal);
const limiteSeguro = techoSeguro;

    try {
        console.log(`\n[📥] Extracción masiva en marcha (${esTikTok ? 'TikTok' : 'Instagram'}) para: ${url}`);
        
        let nuevoSaldoDefinitivo = 0;
        let tokensCobrados = 0;
        let usuarioAfectado = null;

// 💰 1. DÉBITO INICIAL DE TOKEMS (BLINDADO CON VALIDACIÓN DE FONDOS)
        if (!deviceId || costoReal <= 0) {
            return res.status(400).json({ error: 'Parámetros de cobro inválidos.' });
        }

        const identificadorLimpio = deviceId.trim().toLowerCase();

        if (identificadorLimpio.includes('@')) {
            if (!req.user || req.user.email.toLowerCase() !== identificadorLimpio) {
                return res.status(403).json({ error: 'No tienes autorización para debitar saldo de esta cuenta.' });
            }

            let usuario = await User.findOne({ email: identificadorLimpio });
            if (!usuario || (usuario.tokems || 0) < costoReal) {
                return res.status(402).json({ error: 'Saldo insuficiente de Tokems para realizar esta extracción.' });
            }

            usuario.tokems -= costoReal;
            await usuario.save();
            nuevoSaldoDefinitivo = usuario.tokems;
            tokensCobrados = costoReal;
            usuarioAfectado = { tipo: 'user', doc: usuario };
            console.log(`[🪙] Cobrado x${costoReal} Tokems a la Cuenta: ${identificadorLimpio}. Restan: ${nuevoSaldoDefinitivo}`);
        } else {
            let registroInvitado = await Balance.findOne({ deviceId: identificadorLimpio });
            if (!registroInvitado || (registroInvitado.tokens || 0) < costoReal) {
                return res.status(402).json({ error: 'Saldo insuficiente de Tokems en este dispositivo.' });
            }

            registroInvitado.tokens -= costoReal;
            await registroInvitado.save();
            nuevoSaldoDefinitivo = registroInvitado.tokens;
            tokensCobrados = costoReal;
            usuarioAfectado = { tipo: 'guest', doc: registroInvitado };
            console.log(`[🪙] Cobrado x${costoReal} Tokems al Dispositivo: ${identificadorLimpio}. Restan: ${nuevoSaldoDefinitivo}`);
        }

        let listaComentarios = [];

        // 🤖 2. EXTRACCIÓN CON FRENO EN APIFY
        if (esTikTok) {
            const inputTikTok = {
                "postURLs": [url],
                "resultsLimit": 1,
                "commentsPerPost": limiteSeguro,
                "maxCommentsPerPost": limiteSeguro,
                "downloadVideos": false,
                "extractTranscripts": false
            };

            const run = await client.actor("clockworks/tiktok-scraper").call(inputTikTok);
            const { items } = await client.dataset(run.defaultDatasetId).listItems();

            if (items && items.length > 0) {
                const videoPost = items[0];
                let subDatasetId = videoPost.commentsDatasetId;
                if (!subDatasetId && videoPost.commentsDatasetUrl) {
                    const match = videoPost.commentsDatasetUrl.match(/datasets\/([^\/]+)/);
                    if (match) subDatasetId = match[1];
                }

                if (subDatasetId && subDatasetId !== 'items') {
                    console.log(`[📦] Descargando comentarios del dataset indexado: ${subDatasetId}`);
                    const subDatasetResult = await client.dataset(subDatasetId).listItems();
                    const comentariosCrudos = subDatasetResult.items || [];

                    comentariosCrudos.forEach(c => {
                        const user = extraerUsuarioDinamicamente(c);
                        const rawAvatar = extraerAvatarDinamicamente(c);
                        if (user) {
                            listaComentarios.push({
                                username: user,
                                text: c.text || c.commentText || "",
                                profilePicUrl: rawAvatar
                            });
                        }
                    });
                }
            }

        } else {
            let cookiesInstagram = [];
            try {
                if (process.env.INSTAGRAM_COOKIES) {
                    cookiesInstagram = JSON.parse(process.env.INSTAGRAM_COOKIES);
                }
            } catch (e) {
                console.error("Error parseando INSTAGRAM_COOKIES:", e);
            }

            const inputInstagram = {
                "addParentData": false,
                "directUrls": [url],
                "resultsLimit": limiteSeguro,
                "resultsType": "comments",
                "searchLimit": 10,
                "searchType": "hashtag",
                "proxyConfiguration": { "useApifyProxy": true },
                ...(cookiesInstagram.length > 0 && { "loginCookies": cookiesInstagram })
            };

            const run = await client.actor("shu8hvrXbJbY3Eb9W").call(inputInstagram);
            const { items } = await client.dataset(run.defaultDatasetId).listItems();

            if (items && items.length > 0) {
                listaComentarios = items
                    .filter(c => c.ownerUsername || c.username || c.author)
                    .map(c => {
                        const user = c.ownerUsername || c.username || c.author || "Participante";
                        const avatar = extraerAvatarDinamicamente(c) || c.ownerProfilePicUrl || c.profilePicUrl || c.authorProfilePicUrl || "";
                        return {
                            username: user,
                            text: c.text || c.caption || "",
                            profilePicUrl: avatar
                        };
                    });
            }
        }

// 🔄 3. LÓGICA DE REEMBOLSO AUTOMÁTICO TRAS LA LIMPIEZA (0 COMENTARIOS = 0 TOKEMS)
        const costoFinalCalculado = listaComentarios.length === 0 ? 0 : calcularCostoTokemsServidor(listaComentarios.length);
        let tokemsReembolsados = 0;

        if (costoReal > costoFinalCalculado && deviceId) {
            tokemsReembolsados = costoReal - costoFinalCalculado;
            const identificadorLimpio = deviceId.trim().toLowerCase();

            if (identificadorLimpio.includes('@')) {
                let usuario = await User.findOne({ email: identificadorLimpio });
                if (usuario) {
                    usuario.tokems = (usuario.tokems || 0) + tokemsReembolsados;
                    await usuario.save();
                    nuevoSaldoDefinitivo = usuario.tokems;
                }
            } else {
                let registroInvitado = await Balance.findOne({ deviceId: identificadorLimpio });
                if (registroInvitado) {
                    registroInvitado.tokens = (registroInvitado.tokens || 0) + tokemsReembolsados;
                    await registroInvitado.save();
                    nuevoSaldoDefinitivo = registroInvitado.tokens;
                }
            }
            console.log(`[🔄 REEMBOLSO] Se devolvieron ${tokemsReembolsados} Tokems a ${deviceId}. Saldo final: ${nuevoSaldoDefinitivo}`);
        }

        console.log(`[✅] Proceso completado. Se enviaron ${listaComentarios.length} comentarios válidos.`);
        
        return res.json({ 
            comments: listaComentarios, 
            nuevoSaldo: nuevoSaldoDefinitivo,
            reembolso: tokemsReembolsados
        });

    } catch (error) {
        if (typeof tokensCobrados !== 'undefined' && tokensCobrados > 0 && typeof usuarioAfectado !== 'undefined' && usuarioAfectado) {
            if (usuarioAfectado.tipo === 'user') {
                usuarioAfectado.doc.tokems += tokensCobrados;
                await usuarioAfectado.doc.save();
            } else {
                usuarioAfectado.doc.tokens += tokensCobrados;
                await usuarioAfectado.doc.save();
            }
            console.log(`[🔄 DEVOLUCIÓN] Devueltos ${tokensCobrados} Tokems por caída de API.`);
        }
        
        console.error('❌ Error crítico en /api/comments:', error);
        return res.status(500).json({ error: 'Error en Apify: ' + error.message });
    }
});

// =================================================================
// 3. PROXY DE IMÁGENES CENTRALIZADO (AMPLIADO Y ANTI-403)
// =================================================================
app.get('/api/proxy-image', async (req, res) => {
    let imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Falta la URL');

    while (imageUrl.includes('api/proxy-image?url=')) {
        const parts = imageUrl.split('api/proxy-image?url=');
        imageUrl = decodeURIComponent(parts[parts.length - 1]);
    }

    if (imageUrl.startsWith('imagenes/') || imageUrl.startsWith('Sonidos/')) {
        return res.sendFile(path.join(__dirname, imageUrl));
    }

    // 🔒 Lista blanca ampliada con todos los CDNs conocidos de Instagram, TikTok y Shopify
    const dominiosPermitidos = [
        'cdninstagram.com', 'fbcdn.net', 'instagram.com', 'akamaized.net', 'akamaihd.net',
        'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokcdn-eu.com', 'tiktokv.com', 'byteoversea.com', 
        'ibytedtos.com', 'bytedance.com', 'ttwstatic.com', 'musical.ly',
        'shopify.com', 'shopifycdn.com'
    ];

    const esDominioValido = dominiosPermitidos.some(d => imageUrl.includes(d));
    if (!esDominioValido) {
        return res.redirect('https://cdn.shopify.com/s/files/1/0780/8444/0222/files/blank-profile-picture-973460_640.webp?v=1787703095');
    }

    const esInstagram = imageUrl.includes('cdninstagram.com') || imageUrl.includes('fbcdn.net') || imageUrl.includes('instagram.com');
    
    const customHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
    };

    if (esInstagram) {
        customHeaders['Referer'] = 'https://www.instagram.com/';
        customHeaders['Origin'] = 'https://www.instagram.com/';
    } else {
        customHeaders['Referer'] = 'https://www.tiktok.com/';
        customHeaders['Origin'] = 'https://www.tiktok.com/';
    }

    try {
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'arraybuffer',
            headers: customHeaders,
            timeout: 10000
        });

        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(response.data);
    } catch (error) {
        return res.redirect(`https://cdn.shopify.com/s/files/1/0780/8444/0222/files/blank-profile-picture-973460_640.webp?v=1787703095`);
    }
});

// =================================================================
// 4. ENDPOINT: PROCESADOR DE PINES (CORREGIDO ANTI-CRASH)
// =================================================================
app.post('/api/redeem', async (req, res) => {
    const { code, deviceId } = req.body;
    if (!code || !deviceId) return res.status(400).json({ error: 'El código y el identificador son estrictamente requeridos.' });

    try {
        // 🔒 Operación atómica directa en MongoDB: bloquea el pin al instante en el mismo milisegundo
        const pin = await Pin.findOneAndUpdate(
            { code: code.trim().toUpperCase(), used: false },
            { $set: { used: true } },
            { new: true }
        );

        if (!pin) {
            return res.status(400).json({ error: 'El pin introducido no es válido o ya fue canjeado.' });
        }

        const identificadorLimpio = deviceId.trim().toLowerCase();
        let nuevoSaldo = 0;

        if (identificadorLimpio.includes('@')) {
            let usuario = await User.findOne({ email: identificadorLimpio });
            if (!usuario) {
                // Si la cuenta no existe, revertimos el pin para no perderlo
                pin.used = false;
                await pin.save();
                return res.status(404).json({ error: 'Cuenta no encontrada.' });
            }
            
            usuario.tokems = (usuario.tokems || 0) + pin.tokens;
            await usuario.save();
            nuevoSaldo = usuario.tokems;
        } else {
            let registroInvitado = await Balance.findOne({ deviceId: identificadorLimpio });
            if (!registroInvitado) {
                registroInvitado = new Balance({ deviceId: identificadorLimpio, tokens: 0 });
            }
            registroInvitado.tokens += pin.tokens;
            await registroInvitado.save();
            nuevoSaldo = registroInvitado.tokens;
        }

        return res.status(200).json({ success: true, tokens: pin.tokens, userTokens: nuevoSaldo });
    } catch (error) {
        console.error('Error en /api/redeem:', error);
        return res.status(500).json({ error: 'Error interno del servidor al procesar el pin.' });
    }
});

// =================================================================
// 5. DICCIONARIO DE EQUIVALENCIAS DE TOKEMS (SHOPIFY)
// =================================================================
const TOKENS_POR_VARIANTE = {
    "47912562720926": 1,   "47912562851998": 3,   "47912562884766": 6,   
    "47912563015838": 12,  "47912563114142": 24,  "47912563245214": 48   
};

// =================================================================
// 6. ENDPOINT: OBTENER EL SALDO (Y CONTEO DE PREVISUALIZACIONES)
// =================================================================
app.get('/api/get-balance', async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: "Falta el parámetro deviceId" });

    try {
        const identificadorLimpio = deviceId.trim().toLowerCase();
        const hoy = new Date().toLocaleDateString();
        
        // 🚀 Consultar conteo real en MongoDB (Inmune al LocalStorage)
        let previewCount = 0;
        const previewReg = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
        if (previewReg) previewCount = previewReg.count;

        if (identificadorLimpio.includes('@')) {
            const usuario = await User.findOne({ email: identificadorLimpio });
            return res.json({ 
                tokens: usuario ? usuario.tokems : 0, 
                previewCount,
                customConfig: usuario ? usuario.customConfig : null 
            });
        } else {
            const registro = await Balance.findOne({ deviceId: identificadorLimpio });
            return res.json({ 
                tokens: registro ? registro.tokens : 0, 
                previewCount,
                customConfig: null 
            });
        }
    } catch (error) {
        console.error('❌ Error al obtener balance en DB:', error);
        return res.status(500).json({ error: "Error consultando saldo" });
    }
});

// =================================================================
// 📜 ENDPOINTS: GUARDAR Y LEER HISTORIAL EN LA NUBE
// =================================================================

// PUERTA 1: Recibe los ganadores y los guarda en MongoDB
app.post('/api/save-history', async (req, res) => {
    try {
        const { deviceId, drawId, maquina, url, ganadores } = req.body;
        
        const nuevoSorteo = new History({ 
            deviceId, 
            drawId: drawId ? drawId.trim().toUpperCase() : '',maquina, url, ganadores });
        await nuevoSorteo.save(); // ¡Guardado en la base de datos!
        
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error guardando historial:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

// PUERTA 2: Busca el historial en MongoDB y se lo envía a la página web
app.get('/api/get-history', async (req, res) => {
    try {
        const { deviceId, uuid } = req.query;
        if (!deviceId && !uuid) return res.status(400).json({ error: "Falta el identificador" });

        const idQuery = [];
        if (deviceId) {
            idQuery.push({ deviceId: deviceId });
            idQuery.push({ deviceId: deviceId.trim().toLowerCase() });
        }
        if (uuid && uuid !== deviceId) {
            idQuery.push({ deviceId: uuid });
        }

        const historial = await History.find({ $or: idQuery })
                                       .sort({ fecha: -1 })
                                       .limit(30);

        res.status(200).json({ historial });
    } catch (error) {
        console.error("Error obteniendo historial:", error);
        res.status(500).json({ error: "Error interno" });
    }
});

// --- RUTA 1: ELIMINAR UN SOLO SORTEO POR ID ---
app.post('/api/delete-history-item', verificarTokenOpcional, async (req, res) => {
    try {
        const { id, deviceId } = req.body;
        if (!id || !deviceId) return res.status(400).json({ error: "Faltan parámetros" });

        const identificadorLimpio = deviceId.trim().toLowerCase();
        
        await History.findOneAndDelete({
            _id: id,
            $or: [
                { deviceId: deviceId },
                { deviceId: identificadorLimpio }
            ]
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error eliminando registro:", error);
        res.status(500).json({ error: "Error al eliminar registro" });
    }
});

app.post('/api/clear-history', verificarTokenOpcional, async (req, res) => {
    try {
        const { deviceId, maquina } = req.body;
        if (!deviceId) return res.status(400).json({ error: "Falta el identificador" });

        const identificadorLimpio = deviceId.trim().toLowerCase();
        const filtroDB = { 
            $or: [
                { deviceId: deviceId },
                { deviceId: identificadorLimpio }
            ] 
        };

        if (maquina && maquina !== 'Todas') {
            filtroDB.maquina = maquina;
        }

        await History.deleteMany(filtroDB);
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error vaciando historial:", error);
        res.status(500).json({ error: "Error al vaciar historial" });
    }
});

// =================================================================
// 🎨 ENDPOINTS: GUARDAR Y REINICIAR DISEÑO EN LA NUBE (MONGO ATLAS)
// =================================================================

// 1. Guarda el diseño personalizado en la cuenta del usuario
app.post('/api/save-custom-config', async (req, res) => {
    try {
        const { email, customConfig } = req.body;
        if (!email || !customConfig) return res.status(400).json({ error: "Faltan parámetros" });

        const correoLimpio = email.trim().toLowerCase();
        await User.findOneAndUpdate(
            { email: correoLimpio }, 
            { $set: { customConfig: customConfig } },
            { new: true }
        );

        res.status(200).json({ success: true, message: "Diseño guardado en la cuenta" });
    } catch (error) {
        console.error("Error guardando diseño en MongoDB:", error);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// 2. Borra el diseño personalizado de la cuenta (vuelve a estado de fábrica)
app.post('/api/reset-custom-config', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Falta el correo" });

        const correoLimpio = email.trim().toLowerCase();
        await User.findOneAndUpdate({ email: correoLimpio }, { customConfig: null });

        res.status(200).json({ success: true, message: "Diseño reiniciado de fábrica" });
    } catch (error) {
        console.error("Error reiniciando diseño en MongoDB:", error);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

// =================================================================
// 💳 ENDPOINTS: HISTORIAL DE COMPRAS Y CANJES DE TOKEMS
// =================================================================

// 1. Guardar nueva transacción (Compra o Canje)
app.post('/api/save-transaction', async (req, res) => {
    try {
        const { deviceId, tipo, tokens, plan, precio, codigoPin, detalles } = req.body;
        if (!deviceId || !tokens) {
            return res.status(400).json({ error: 'Datos insuficientes para guardar la transacción.' });
        }

        const nuevaTx = new Transaction({
            deviceId: deviceId.trim().toLowerCase(),
            tipo: tipo || 'Canje',
            tokens: Number(tokens),
            plan: plan || '',
            precio: precio || '',
            codigoPin: codigoPin || '',
            detalles: detalles || ''
        });

        await nuevaTx.save();
        res.json({ success: true, transaction: nuevaTx });
    } catch (error) {
        console.error('Error guardando transacción:', error);
        res.status(500).json({ error: 'Error interno del servidor.' });
    }
});

// 2. Obtener transacciones del usuario / dispositivo
app.get('/api/get-transactions', async (req, res) => {
    try {
        const { deviceId, uuid } = req.query;
        if (!deviceId && !uuid) return res.status(400).json({ error: 'Falta identificador.' });

        const idQuery = [];
        if (deviceId) {
            idQuery.push({ deviceId: deviceId });
            idQuery.push({ deviceId: deviceId.trim().toLowerCase() });
        }
        if (uuid && uuid !== deviceId) {
            idQuery.push({ deviceId: uuid });
            idQuery.push({ deviceId: uuid.trim().toLowerCase() });
        }

        const transacciones = await Transaction.find({ $or: idQuery })
            .sort({ fecha: -1 })
            .limit(50)
            .lean();

        res.json({ success: true, transacciones });
    } catch (error) {
        console.error('Error obteniendo transacciones:', error);
        res.status(500).json({ error: 'Error al consultar historial de transacciones.' });
    }
});

// ✅ CÓDIGO CORREGIDO Y SEGURO
app.post('/api/delete-transaction-item', async (req, res) => {
    try {
        const { id, deviceId } = req.body;
        if (!id || !deviceId) return res.status(400).json({ error: 'Faltan parámetros.' });

        const identificadorLimpio = deviceId.trim().toLowerCase();
        await Transaction.deleteOne({ 
            _id: id,
            $or: [
                { deviceId: deviceId },
                { deviceId: identificadorLimpio }
            ]
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar la transacción.' });
    }
});

// 4. Vaciar transacciones por tipo o todas
app.post('/api/clear-transactions', async (req, res) => {
    try {
        const { deviceId, tipo } = req.body;
        if (!deviceId) return res.status(400).json({ error: 'Falta el identificador.' });

        const identificadorLimpio = deviceId.trim().toLowerCase();
        const filtroDB = { 
            $or: [
                { deviceId: deviceId },
                { deviceId: identificadorLimpio }
            ] 
        };

        if (tipo && tipo !== 'Todas') {
            filtroDB.tipo = tipo;
        }

        await Transaction.deleteMany(filtroDB);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Error al vaciar transacciones.' });
    }
});

// =================================================================
// 🛡️ ENDPOINTS: VERIFICACIÓN PÚBLICA Y SELLADO CRIPTOGRÁFICO
// =================================================================

// 1. Guardar y sellar el sorteo al finalizar
app.post('/api/save-verification', async (req, res) => {
    try {
        const { 
            drawId, 
            deviceId, 
            maquina, 
            url, 
            plataforma, 
            ganadores, 
            totalComentarios, 
            totalParticipantesValidos, 
            participantes 
        } = req.body;

        if (!drawId || !ganadores || ganadores.length === 0) {
            return res.status(400).json({ error: "Datos insuficientes para sellar el sorteo." });
        }

        // 🔒 Generar Hash SHA-256 Inmutable
        const rawString = `${drawId}_${url || ''}_${Date.now()}_${JSON.stringify(ganadores)}_${totalParticipantesValidos || 0}`;
        const verificationHash = crypto.createHash('sha256').update(rawString).digest('hex');

        // Limpieza de lista para búsqueda instantánea
        const listaLimpia = (participantes || []).map(p => {
            const nom = typeof p === 'string' ? p : (p.username || p.nombre || '');
            return nom.replace('@', '').trim().toLowerCase();
        }).filter(p => p !== '');

        const idLimpio = drawId.trim().toUpperCase();

        // Si ya existe (ej: reintento), actualiza; si no, lo crea
        const sorteoSellado = await DrawVerification.findOneAndUpdate(
            { drawId: idLimpio },
            {
                drawId: idLimpio,
                deviceId: (deviceId || 'invitado').trim().toLowerCase(),
                maquina: maquina || 'Sorteo',
                url: url || '',
                plataforma: plataforma || (url && url.includes('tiktok.com') ? 'TikTok' : 'Instagram'),
                fecha: new Date(),
                ganadores: ganadores,
                totalComentarios: totalComentarios || 0,
                totalParticipantesValidos: totalParticipantesValidos || listaLimpia.length,
                verificationHash: verificationHash,
                participantes: listaLimpia
            },
            { upsert: true, new: true }
        );

        console.log(`[🛡️ VERIFICACIÓN] Sorteo ${idLimpio} sellado con éxito. Hash: ${verificationHash.substring(0, 16)}...`);
        return res.json({ success: true, drawId: sorteoSellado.drawId, hash: verificationHash });

    } catch (error) {
        console.error("❌ Error en /api/save-verification:", error);
        return res.status(500).json({ error: "No se pudo sellar el sorteo en la base de datos." });
    }
});

// 2. Consulta pública (Optimizado para soportar 50.000 visitas con Caché de Borde)
app.get('/api/verify/:drawId', async (req, res) => {
    try {
        const idBuscado = req.params.drawId.trim().toUpperCase();
        const sorteo = await DrawVerification.findOne({ drawId: idBuscado }).lean();

        if (!sorteo) {
            return res.status(404).json({ error: "Certificado de sorteo no encontrado o no existe." });
        }

        // ⚡ CABECERAS DE CACHÉ EDGE (Cloudflare / CDN):
        // Cloudflare guarda una copia estática en sus servidores por 7 días.
        // Las miles de personas que entren desde Instagram recibirán la respuesta desde Cloudflare en <20ms sin tocar Node.js ni MongoDB.
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400, immutable');

        return res.json({
            drawId: sorteo.drawId,
            maquina: sorteo.maquina,
            url: sorteo.url,
            plataforma: sorteo.plataforma,
            fecha: sorteo.fecha,
            ganadores: sorteo.ganadores,
            totalComentarios: sorteo.totalComentarios,
            totalParticipantesValidos: sorteo.totalParticipantesValidos,
            verificationHash: sorteo.verificationHash,
            participantes: sorteo.participantes
        });

    } catch (error) {
        console.error("❌ Error en /api/verify:", error);
        return res.status(500).json({ error: "Error consultando certificado." });
    }
});

// Levantar el servidor
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor KemZone corriendo en el puerto ${port}`);
});


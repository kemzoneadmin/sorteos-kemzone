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

const app = express();
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
const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    
    // Si no trae pulsera (token), lo rebotamos
    if (!token) return res.status(403).json({ error: 'Acceso denegado. Falta la pulsera VIP.' });

    // Leemos la pulsera
    const tokenLimpio = token.split(" ")[1]; 
    jwt.verify(tokenLimpio, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ error: 'Pulsera inválida o caducada.' });
        req.user = decoded; // Identificamos quién es
        next(); // Lo dejamos pasar
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
app.post('/api/register', async (req, res) => {
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
app.post('/api/verify', async (req, res) => {
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
app.post('/api/login', async (req, res) => {
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
// 🔄 ENDPOINT: FUSIONAR SALDO DE TOKEMS (PREVISUALIZACIONES INDEPENDIENTES)
// =================================================================
app.post('/api/transfer-guest', async (req, res) => {
    const { email, deviceId } = req.body;
    if (!email || !deviceId) return res.status(400).json({ error: 'Faltan parámetros.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const usuario = await User.findOne({ email: correoLimpio });
        if (!usuario) return res.status(404).json({ error: 'Cuenta no encontrada.' });

        let saldoATransferir = 0;
        const registroBalance = await Balance.findOne({ deviceId: deviceId });
        
        if (registroBalance && registroBalance.tokens > 0) {
            saldoATransferir = registroBalance.tokens;
            registroBalance.tokens = 0; // Vaciamos los bolsillos de Tokems del invitado
            await registroBalance.save();
        }

        if (saldoATransferir > 0) {
            usuario.tokems = (usuario.tokems || 0) + saldoATransferir;
            await usuario.save();
        }

        // 🚀 OBTENEMOS EL CONTEO INDEPENDIENTE DE LA CUENTA (Sin tocar el del invitado)
        const hoy = new Date().toLocaleDateString();
        let previewCount = 0;
        let userPreview = await Preview.findOne({ deviceId: correoLimpio, date: hoy });
        if (userPreview) previewCount = userPreview.count;

        return res.status(200).json({ 
            success: true, 
            nuevoSaldo: usuario.tokems,
            previewCount 
        });
    } catch (error) {
        console.error('Error en transferencia:', error);
        return res.status(500).json({ error: 'Error interno fusionando los balances.' });
    }
});

// =================================================================
// 1. ENDPOINT: PREVISUALIZACIÓN (TOTALMENTE INDEPENDIENTE)
// =================================================================
app.post('/api/preview', async (req, res) => {
    const { url, deviceId } = req.body; 
    // Ya no requerimos hardwareUUID porque no habrá espejo
    if (!url || !deviceId) return res.status(400).json({ error: 'La URL y el deviceId son obligatorios' });

    const hoy = new Date().toLocaleDateString();
    const identificadorLimpio = deviceId.trim().toLowerCase();

    try {
        const esCuenta = identificadorLimpio.includes('@');
        const limiteMaximo = esCuenta ? 6 : 3;

        // Buscamos el registro independiente directamente en MongoDB
        let registro = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
        if (!registro) {
            registro = new Preview({ deviceId: identificadorLimpio, date: hoy, count: 0 });
        }

        // 🧼 LIMPIEZA DE SEGURIDAD
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
        
        // ... (De aquí hacia abajo, deja intacto el código de Apify)

        if (esTikTok) {
            const inputTikTok = {
                "postURLs": [url],
                "resultsLimit": 1,
                "commentsPerPost": 0,
                "downloadVideos": false,
                "extractTranscripts": false
            };

            const run = await client.actor("clockworks/tiktok-scraper").call(inputTikTok);
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

            const run = await client.actor("shu8hvrXbJbY3Eb9W").call(inputInstagram);
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

app.post('/api/comments', verificarToken, async (req, res) => {
    const { url, maxComments, deviceId, costoTokens } = req.body;
    if (!url) return res.status(400).json({ error: 'La URL es obligatoria' });

    const esTikTok = url.includes('tiktok.com');
    const limiteSeguro = parseInt(maxComments) || 300;
    const costoReal = parseInt(costoTokens) || 0;

try {
        console.log(`\n[📥] Extracción masiva en marcha (${esTikTok ? 'TikTok' : 'Instagram'}) para: ${url}`);
        
        let nuevoSaldoDefinitivo = 0;
        let tokensCobrados = 0; // 👈 NUEVO: Memoria de cuánto cobramos
        let usuarioAfectado = null; // 👈 NUEVO: Memoria de a quién le cobramos

        // 💰 1. DÉBITO INICIAL DE TOKEMS
        if (deviceId && costoReal > 0) {
            const identificadorLimpio = deviceId.trim().toLowerCase();

            if (identificadorLimpio.includes('@')) {
                let usuario = await User.findOne({ email: identificadorLimpio });
                if (usuario) {
                    usuario.tokems = Math.max(0, (usuario.tokems || 0) - costoReal);
                    await usuario.save();
                    nuevoSaldoDefinitivo = usuario.tokems;
                    tokensCobrados = costoReal; // 👈 Guardamos el monto
                    usuarioAfectado = { tipo: 'user', doc: usuario }; // 👈 Guardamos el usuario
                    console.log(`[🪙] Cobrado x${costoReal} Tokems a la Cuenta: ${identificadorLimpio}. Restan: ${nuevoSaldoDefinitivo}`);
                }
            } else {
                let registroInvitado = await Balance.findOne({ deviceId: identificadorLimpio });
                if (registroInvitado) {
                    registroInvitado.tokens = Math.max(0, (registroInvitado.tokens || 0) - costoReal);
                    await registroInvitado.save();
                    nuevoSaldoDefinitivo = registroInvitado.tokens;
                    tokensCobrados = costoReal; // 👈 Guardamos el monto
                    usuarioAfectado = { tipo: 'guest', doc: registroInvitado }; // 👈 Guardamos el usuario
                    console.log(`[🪙] Cobrado x${costoReal} Tokems al Dispositivo: ${identificadorLimpio}. Restan: ${nuevoSaldoDefinitivo}`);
                }
            }
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
            const inputInstagram = {
                "addParentData": false,
                "directUrls": [url],
                "resultsLimit": limiteSeguro,
                "resultsType": "comments",
                "searchLimit": 10,
                "searchType": "hashtag",
                "proxyConfiguration": { "useApifyProxy": true },
                "loginCookies": [
                    { "domain": ".instagram.com", "expirationDate": 1789598959.16949, "hostOnly": false, "httpOnly": true, "name": "ps_n", "path": "/", "sameSite": "no_restriction", "secure": true, "session": false, "storeId": null, "value": "1" },
                    { "domain": ".instagram.com", "expirationDate": 1789450890.42235, "hostOnly": false, "httpOnly": true, "name": "datr", "path": "/", "sameSite": "no_restriction", "secure": true, "session": false, "storeId": null, "value": "CYOZaOgNY_Hhcp-MIwRia-8J" },
                    { "domain": ".instagram.com", "expirationDate": 1786574960.309325, "hostOnly": false, "httpOnly": false, "name": "ig_nrcb", "path": "/", "sameSite": null, "secure": true, "session": false, "storeId": null, "value": "1" },
                    { "domain": ".instagram.com", "expirationDate": 1788853357.812318, "hostOnly": false, "httpOnly": false, "name": "ds_user_id", "path": "/", "sameSite": "no_restriction", "secure": true, "session": false, "storeId": null, "value": "27565603979" },
                    { "domain": ".instagram.com", "expirationDate": 1815637357.812134, "hostOnly": false, "httpOnly": false, "name": "csrftoken", "path": "/", "sameSite": null, "secure": true, "session": false, "storeId": null, "value": "hygekoBl2ZmKzCViih1RZVHUQ5WIjXlw" },
                    { "domain": ".instagram.com", "expirationDate": 1786426890.422378, "hostOnly": false, "httpOnly": true, "name": "ig_did", "path": "/", "sameSite": "no_restriction", "secure": true, "session": false, "storeId": null, "value": "0A159DEB-E490-40E8-BD4C-868B6A21E403" },
                    { "domain": ".instagram.com", "expirationDate": 1789598959.169378, "hostOnly": false, "httpOnly": true, "name": "ps_l", "path": "/", "sameSite": "lax", "secure": true, "session": false, "storeId": null, "value": "1" },
                    { "domain": ".instagram.com", "expirationDate": 1781682156, "hostOnly": false, "httpOnly": false, "name": "wd", "path": "/", "sameSite": "lax", "secure": true, "session": false, "storeId": null, "value": "2048x1018" },
                    { "domain": ".instagram.com", "expirationDate": 1789598222.929081, "hostOnly": false, "httpOnly": true, "name": "mid", "path": "/", "sameSite": "no_restriction", "secure": true, "session": false, "storeId": null, "value": "aJvCkAALAAFuTvIGIg0Ozqer1w8C" },
                    { "domain": ".instagram.com", "expirationDate": 1812613351.403508, "hostOnly": false, "httpOnly": true, "name": "sessionid", "value": "27565603979%3ALyOiF1sINhKeH5%3A27%3AAYg_G66zbNllbQVxX1hFvc2pT5HlsrP4fK8QeLTajw" },
                    { "domain": ".instagram.com", "expirationDate": 1781682156, "hostOnly": false, "httpOnly": false, "name": "dpr", "path": "/", "sameSite": "no_restriction", "secure": true, "session": false, "storeId": null, "value": "1.25" },
                    { "domain": ".instagram.com", "expirationDate": 1791433469, "hostOnly": false, "httpOnly": false, "name": "ig_lang", "path": "/", "sameSite": null, "secure": false, "session": false, "storeId": null, "value": "es-la" },
                    { "domain": ".instagram.com", "hostOnly": false, "httpOnly": true, "name": "rur", "path": "/", "sameSite": "lax", "secure": true, "session": true, "storeId": null, "value": "\"MWG\\05427565603979\\0541812613368:01ff035dd4505dbf423e3935e4e05d4f27a8b890269ae06923b7a5287fcd48701949d4b1\"" }
                ]
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

        // 🔄 3. LÓGICA DE REEMBOLSO AUTOMÁTICO TRAS LA LIMPIEZA
        const costoFinalCalculado = calcularCostoTokemsServidor(listaComentarios.length);
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
        // 🔥 ROLLBACK DE EMERGENCIA SI APIFY EXPLOTA
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
// 3. PROXY DE IMÁGENES CENTRALIZADO CON CAMUFLAJE ANTI-BLOQUEO 403
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

    // 🎯 Detectar de qué red social viene la imagen para colocar el camuflaje correcto
    const esInstagram = imageUrl.includes('cdninstagram.com') || imageUrl.includes('fbcdn.net') || imageUrl.includes('instagram.com');
    
    const customHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
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
            timeout: 12000
        });

        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(response.data);
    } catch (error) {
        console.error('Error cargando la imagen remota mediante Proxy:', error.message);
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
        const pin = await Pin.findOne({ code: code.toUpperCase(), used: false });
        if (!pin) return res.status(400).json({ error: 'El pin introducido no es válido o ya fue canjeado.' });

        const identificadorLimpio = deviceId.trim().toLowerCase();
        let nuevoSaldo = 0;

        // 🌟 CORRECCIÓN: Separamos la lógica de Invitado y Usuario para no crear cuentas sin contraseña
        if (identificadorLimpio.includes('@')) {
            // Es un Usuario Registrado
            let usuario = await User.findOne({ email: identificadorLimpio });
            if (!usuario) return res.status(404).json({ error: 'Cuenta no encontrada.' });
            
            usuario.tokems = (usuario.tokems || 0) + pin.tokens;
            await usuario.save();
            nuevoSaldo = usuario.tokems;
        } else {
            // Es un Invitado (Guardamos en la colección Balance)
            let registroInvitado = await Balance.findOne({ deviceId: identificadorLimpio });
            if (!registroInvitado) {
                registroInvitado = new Balance({ deviceId: identificadorLimpio, tokens: 0 });
            }
            registroInvitado.tokens += pin.tokens;
            await registroInvitado.save();
            nuevoSaldo = registroInvitado.tokens;
        }

        pin.used = true;
        await pin.save();

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
        const { deviceId, maquina, url, ganadores } = req.body;
        
        const nuevoSorteo = new History({ deviceId, maquina, url, ganadores });
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
app.post('/api/delete-history-item', verificarToken, async (req, res) => {
    try {
        const { id, deviceId } = req.body;
        if (!id || !deviceId) return res.status(400).json({ error: "Faltan parámetros" });

        await History.findOneAndDelete({ _id: id, deviceId });
        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Error eliminando registro:", error);
        res.status(500).json({ error: "Error al eliminar registro" });
    }
});

// --- RUTA 2: VACIAR HISTORIAL (COMPLETO O POR MÁQUINA) ---
app.post('/api/clear-history', verificarToken, async (req, res) => {
    try {
        const { deviceId, maquina } = req.body;
        if (!deviceId) return res.status(400).json({ error: "Falta el identificador" });

        const filtroDB = { deviceId };
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
        await User.findOneAndUpdate({ email: correoLimpio }, { customConfig: customConfig });

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

// 3. Eliminar transacción individual
app.post('/api/delete-transaction-item', async (req, res) => {
    try {
        const { id, deviceId } = req.body;
        if (!id || !deviceId) return res.status(400).json({ error: 'Faltan parámetros.' });

        await Transaction.deleteOne({ _id: id });
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

// Levantar el servidor
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor KemZone corriendo en el puerto ${port}`);
});

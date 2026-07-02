require('dotenv').config(); 
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // 🚀 OBLIGA A USAR IPV4 (Cura el error ENETUNREACH de Railway)

const express = require('express');
const { ApifyClient } = require('apify-client');
// ... (el resto de tus imports siguen igual)
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
    tokems: { type: Number, default: 0 }, // Aquí se guardará su saldo en la nube
    history: { type: Array, default: [] } // Historial de jugadas o canjes
});
const User = mongoose.model('User', UserSchema);

// 🔒 CLIENTE APIFY PROTEGIDO CON VARIABLES DE ENTORNO
const client = new ApifyClient({
    token: process.env.APIFY_TOKEN
});

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Base del servidor de KemZone activa y corriendo.');
});

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

        return res.json({
            success: true,
            token,
            tokems: usuario.tokems
        });
    } catch (error) {
        console.error('Error en /api/login:', error);
        return res.status(500).json({ error: 'Error interno en el servidor al intentar loguear.' });
    }
});

// =================================================================
// 1. ENDPOINT: PREVISUALIZACIÓN (PERSISTENCIA CON MONGO)
// =================================================================
app.post('/api/preview', async (req, res) => {
    const { url, deviceId } = req.body;
    if (!url) return res.status(400).json({ error: 'La URL es obligatoria' });

    const ipUsuario = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const hoy = new Date().toLocaleDateString();
    const identificadorDestino = deviceId || `ip_${ipUsuario}`;

    try {
        let registro = await Preview.findOne({ deviceId: identificadorDestino, date: hoy });
        if (!registro) {
            registro = new Preview({ deviceId: identificadorDestino, date: hoy, count: 0 });
        }

        if (registro.count >= 3) {
            return res.status(429).json({ error: 'Límite diario agotado por hoy.' });
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
                displayUrl: coverUrl
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
                displayUrl: coverUrl
            });
        }
    } catch (error) {
        try {
            let roll = await Preview.findOne({ deviceId: identificadorDestino, date: hoy });
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
// 2. ENDPOINT: EXTRACCIÓN MASIVA
// =================================================================
app.post('/api/comments', async (req, res) => {
    const { url, maxComments } = req.body;
    if (!url) return res.status(400).json({ error: 'La URL es obligatoria' });

    const esTikTok = url.includes('tiktok.com');
    const limiteSeguro = parseInt(maxComments) || 100;

    try {
        console.log(`\n[📥] Extracción masiva en marcha (${esTikTok ? 'TikTok' : 'Instagram'}) para: ${url}`);
        let listaComentarios = [];

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
                    { "domain": ".instagram.com", "expirationDate": 1812613351.403508, "hostOnly": false, "httpOnly": true, "name": "sessionid", "style": "", "value": "27565603979%3ALyOiF1sINhKeH5%3A27%3AAYg_G66zbNllbQVxX1hFvc2pT5HlsrP4fK8QeLTajw" },
                    { "domain": ".instagram.com", "expirationDate": 1781682156, "hostOnly": false, "httpOnly": false, "name": "dpr", "path": "/", "sameSite": "no_restriction", "secure": true, "session": false, "storeId": null, "value": "1.25" },
                    { "domain": ".instagram.com", "expirationDate": 1791433469, "hostOnly": false, "httpOnly": false, "name": "ig_lang", "path": "/", "sameSite": null, "secure": false, "session": false, "storeId": null, "value": "es-la" },
                    { "domain": ".instagram.com", "hostOnly": false, "httpOnly": true, "name": "rur", "path": "/", "sameSite": "lax", "secure": true, "session": true, "storeId": null, "value": "\"MWG\\05427565603979\\0541812613368:01ff035dd4505dbf423e3935e4e05d4f27a8b890269ae06923b7a5287fcd48701949d4b1\"" }
                ]
            };

            const run = await client.actor("shu8hvrXbJbY3Eb9W").call(inputInstagram);
            const { items } = await client.dataset(run.defaultDatasetId).listItems();

            if (items && items.length > 0) {
                listaComentarios = items
                    .filter(c => c.ownerUsername || c.username)
                    .map(c => ({
                        username: c.ownerUsername || c.username,
                        text: c.text || "",
                        profilePicUrl: c.ownerProfilePicUrl || c.profilePicUrl || ""
                    }));
            }
        }

        console.log(`[✅] Proceso completado. Se enviaron ${listaComentarios.length} comentarios.`);
        return res.json({ comments: listaComentarios });

    } catch (error) {
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

    try {
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://www.tiktok.com/', 
                'Origin': 'https://www.tiktok.com/',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            },
            timeout: 10000
        });

        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(response.data);
    } catch (error) {
        console.error('Error cargando la imagen remota mediante Proxy:', error.message);
        return res.redirect(`https://ui-avatars.com/api/?name=K+Z&background=00ffcc&color=0d0d14&size=128`);
    }
});

// =================================================================
// 4. ENDPOINT: PROCESADOR DE PINES 
// =================================================================
app.post('/api/redeem', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'El código es estrictamente requerido.' });

    try {
        const pinLimpio = code.trim().toUpperCase();
        
        const pinEncontrado = await Pin.findOne({ code: pinLimpio });

        if (!pinEncontrado) {
            return res.status(404).json({ error: 'El pin prepago introducido no existe en el sistema.' });
        }

        if (pinEncontrado.used) {
            return res.status(400).json({ error: 'Este pin ya fue canjeado. Los códigos son de un único uso.' });
        }

        pinEncontrado.used = true;
        await pinEncontrado.save();

        return res.json({
            success: true,
            tokens: pinEncontrado.tokens
        });

    } catch (error) {
        console.error('Error en el proceso de canje:', error);
        return res.status(500).json({ error: 'Error interno del servidor al validar el pin.' });
    }
});

// =================================================================
// 5. DICCIONARIO DE EQUIVALENCIAS DE TOKEMS (SHOPIFY)
// =================================================================
const TOKENS_POR_VARIANTE = {
    "47912562720926": 1,   // Plan Base (1 Tokem)
    "47912562851998": 3,   // Plan Starter (3 Tokems)
    "47912562884766": 6,   // Plan Pro (6 Tokems)
    "47912563015838": 12,  // Plan Business (12 Tokems)
    "47912563114142": 24,  // Plan Influencer (24 Tokems)
    "47912563245214": 48   // Plan Agencia (48 Tokems)
};

// =================================================================
// 6. ENDPOINT: OBTENER EL SALDO DE UN USUARIO (MONGO DB)
// =================================================================
app.get('/api/get-balance', async (req, res) => {
    const { deviceId } = req.query;

    if (!deviceId) {
        return res.status(400).json({ error: "Falta el parámetro deviceId" });
    }

    try {
        const registro = await Balance.findOne({ deviceId: deviceId });
        const saldoActual = registro ? registro.tokens : 0;
        
        return res.json({ tokens: saldoActual });
    } catch (error) {
        console.error('❌ Error al obtener balance en DB:', error);
        return res.status(500).json({ error: "Error consulting saldo" });
    }
});

// =================================================================
// 7. ENDPOINT: WEBHOOK DE SHOPIFY (PEDIDO PAGADO)
// =================================================================
app.post('/api/shopify-webhook', async (req, res) => {
    try {
        const order = req.body;

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

        console.log(`🛒 ¡Pedido pagado detectado para el dispositivo: ${deviceId}!`);

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

        let registro = await Balance.findOne({ deviceId: deviceId });
        
        if (!registro) {
            registro = new Balance({ deviceId: deviceId, tokens: 0 });
        }
        
        registro.tokens += tokensAAgregar;
        await registro.save();

        console.log(`✅ Éxito: Se le sumaron ${tokensAAgregar} Tokems a ${deviceId}. Nuevo saldo: ${registro.tokens}`);
        return res.status(200).send("Webhook procesado con éxito");

    } catch (error) {
        console.error("❌ Error procesando el Webhook de Shopify:", error);
        return res.status(500).send("Error interno del servidor");
    }
});

// Levantar el servidor
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor KemZone corriendo en el puerto ${port}`);
});
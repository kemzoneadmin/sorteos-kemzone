require('dotenv').config(); 
const express = require('express');
const { ApifyClient } = require('apify-client');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose'); // 🚀 Conector oficial para MongoDB

const app = express();
const port = process.env.PORT || 3000;

// 🔗 CONEXIÓN CENTRAL A BASE DE DATOS
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('📦 Conectado con éxito a MongoDB Atlas'))
    .catch(err => console.error('❌ Error crítico al conectar a MongoDB:', err));

// 📝 ESQUEMAS Y MODELOS DE BASE DE DATOS
const PinSchema = new mongoose.Schema({
    code: { type: String, unique: true, uppercase: true, trim: true },
    tokens: { type: Number, required: true },
    used: { type: Boolean, default: false }
});
const Pin = mongoose.model('Pin', PinSchema, 'pines'); // 👈 El tercer parámetro fuerza el nombre de la colección

const PreviewSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    date: { type: String, required: true },
    count: { type: Number, default: 0 }
});
const Preview = mongoose.model('Preview', PreviewSchema);

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
// 1. ENDPOINT: PREVISUALIZACIÓN (PERSISTENCIA CON MONGO)
// =================================================================
app.post('/api/preview', async (req, res) => {
    const { url, deviceId } = req.body;
    if (!url) return res.status(400).json({ error: 'La URL es obligatoria' });

    const ipUsuario = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const hoy = new Date().toLocaleDateString();
    const identificadorDestino = deviceId || `ip_${ipUsuario}`;

    try {
        // Consultar Base de Datos por límite diario
        let registro = await Preview.findOne({ deviceId: identificadorDestino, date: hoy });
        if (!registro) {
            registro = new Preview({ deviceId: identificadorDestino, date: hoy, count: 0 });
        }

        if (registro.count >= 3) {
            return res.status(429).json({ error: 'Límite diario agotado por hoy.' });
        }

        // Incremento anticipado persistente
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
                // Reembolso inmediato si no hay data
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
        // Reembolso en caso de caída del Scraper o Red
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
// 4. ENDPOINT: PROCESADOR DE PINES (MONGO DB INTERGATED)
// =================================================================
// 📑 MÓDULO DE VALIDACIÓN DE PINES CON MONGODB
app.post('/api/redeem', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'El código es estrictamente requerido.' });

    try {
        const pinLimpio = code.trim().toUpperCase();
        
        // 🔍 Buscamos el pin directamente en la colección de MongoDB Atlas
        const pinEncontrado = await Pin.findOne({ code: pinLimpio });

        if (!pinEncontrado) {
            return res.status(404).json({ error: 'El pin prepago introducido no existe en el sistema.' });
        }

        if (pinEncontrado.used) {
            return res.status(400).json({ error: 'Este pin ya fue canjeado. Los códigos son de un único uso.' });
        }

        // 🔒 Cambiamos el estado a usado y guardamos el cambio en la base de datos
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

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor KemZone corriendo en http://localhost:${port}`);
});
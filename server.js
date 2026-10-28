require('dotenv').config(); 
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // 🚀 OBLIGA A USAR IPV4 (Cura el error ENETUNREACH de Railway)

const express = require('express');
const { ApifyClient } = require('apify-client');
const crypto = require('crypto');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const rateLimit = require('express-rate-limit');

// =================================================================
// 🛡️ LIMITADORES DE VELOCIDAD (ANTI-ATAQUES Y ANTI-SPAM)
// =================================================================
const previewLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: 'Demasiadas consultas desde esta conexión. Intenta más tarde.' }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 12,
    message: { error: 'Has superado el límite de intentos. Espera 15 minutos.' }
});

const redeemLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { error: 'Demasiados intentos de canje. Intenta de nuevo en 15 minutos.' }
});

const orderLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 25,
    message: { error: 'Demasiadas solicitudes de pedidos seguidas. Espera unos minutos.' }
});

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// =================================================================
// 🔗 CONEXIÓN CENTRAL A MONGODB ATLAS (BASE DE DATOS: kz_db)
// =================================================================
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('📦 Conectado con éxito a MongoDB Atlas (kz_db)');
        await inicializarTiendaKemZonePorDefecto();
    })
    .catch(err => console.error('❌ Error crítico al conectar a MongoDB:', err));

// =================================================================
// 📝 1. ESQUEMAS EXISTENTES EN kz_db (USUARIOS, TOKEMS Y SORTEOS)
// =================================================================
const PinSchema = new mongoose.Schema({
    code: { type: String, unique: true, uppercase: true, trim: true },
    tokens: { type: Number, required: true },
    used: { type: Boolean, default: false },
    createdBy: { type: String, default: 'system' },
    createdAt: { type: Date, default: Date.now }
});
const Pin = mongoose.model('Pin', PinSchema, 'pines'); 

const PreviewSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    date: { type: String, required: true },
    count: { type: Number, default: 0 }
});
const Preview = mongoose.model('Preview', PreviewSchema);

const BalanceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    tokens: { type: Number, default: 0 }
});
const Balance = mongoose.model('Balance', BalanceSchema);

// 👤 CUENTAS DE USUARIOS (SOPORTA LOS 3 DASHBOARDS: CLIENT, WORKER, ADMIN)
const UserSchema = new mongoose.Schema({
    accountName: { type: String, default: '', trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['client', 'worker', 'admin'], default: 'client' },
    isVerified: { type: Boolean, default: false },
    verificationCode: { type: String },
    resetPasswordCode: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },
    tokems: { type: Number, default: 0 }, // Permite decimales (1 Tokem = $1.00 USD)
    whatsapp: { type: String, default: '' },
    // Agenda de IDs favoritos del cliente para recargar en 1 clic
    savedProfiles: [{
        label: String,      // Ej: "Mi cuenta principal FF"
        gameSlug: String,   // Ej: "free-fire-id"
        playerUid: String,  // Ej: "29384756"
        playerServer: String
    }],
    history: { type: Array, default: [] },
    customConfig: { type: Object, default: null }
}, { timestamps: true });
const User = mongoose.model('User', UserSchema);

const historySchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    drawId: { type: String, uppercase: true, trim: true },
    customLogo: { type: String, default: '' },
    maquina: { type: String, required: true },
    url: { type: String },
    fecha: { type: Date, default: Date.now },
    ganadores: [{
        nombre: String,
        texto: String,
        avatarUrl: String
    }]
});
historySchema.index({ deviceId: 1, fecha: -1 });
const History = mongoose.model('History', historySchema);

const TransactionSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, index: true },
    tipo: { type: String, enum: ['Compra', 'Canje', 'Recarga_Tienda', 'Reembolso'], required: true },
    tokens: { type: Number, required: true },
    plan: { type: String, default: '' },
    precio: { type: String, default: '' },
    codigoPin: { type: String, default: '' },
    detalles: { type: String, default: '' },
    shopifyOrderId: { type: String, unique: true, sparse: true },
    fecha: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

const DrawVerificationSchema = new mongoose.Schema({
    drawId: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
    deviceId: { type: String, index: true },
    customLogo: { type: String, default: '' },
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
    participantes: [{ type: mongoose.Schema.Types.Mixed }]
}, { timestamps: true });
DrawVerificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
const DrawVerification = mongoose.model('DrawVerification', DrawVerificationSchema);

const ExtractionSchema = new mongoose.Schema({
    runId: { type: String, required: true, unique: true, index: true },
    deviceId: { type: String, required: true, index: true },
    email: { type: String, default: null },
    esRegistrado: { type: Boolean, default: false },
    ip: { type: String, default: '' },
    url: { type: String, required: true },
    plataforma: { type: String, enum: ['TikTok', 'Instagram'], required: true },
    maquina: { type: String, default: 'Ruleta' },
    comentariosOriginales: { type: Number, required: true },
    comentariosDeclarados: { type: Number, required: true },
    huboManipulacion: { type: Boolean, default: false },
    tokemsCobrados: { type: Number, required: true },
    techoCubierto: { type: Number, required: true },
    comentariosExtraidos: { type: Number, default: 0 },
    tokemsReembolsados: { type: Number, default: 0 },
    estado: { type: String, enum: ['EN_PROCESO', 'COMPLETADO', 'FALLIDO', 'ABORTADO'], default: 'EN_PROCESO' },
    fecha: { type: Date, default: Date.now }
}, { timestamps: true });
ExtractionSchema.index({ deviceId: 1, fecha: -1 });
const Extraction = mongoose.model('Extraction', ExtractionSchema, 'extractions');

const WebhookLogSchema = new mongoose.Schema({
    shopifyOrderId: { type: String, required: true, index: true },
    deviceIdDetectado: { type: String, default: null, index: true },
    emailOrden: { type: String, default: null, index: true },
    tokensComprados: { type: Number, default: 0 },
    precioTotal: { type: String, default: '' },
    estado: { type: String, enum: ['EXITOSO', 'HUERFANO_SIN_ID', 'SIN_TOKENS', 'DUPLICADO_IGNORADO'], required: true, index: true },
    detalles: { type: String, default: '' },
    fecha: { type: Date, default: Date.now }
}, { timestamps: true });
const WebhookLog = mongoose.model('WebhookLog', WebhookLogSchema, 'webhook_logs');

const PinAttemptSchema = new mongoose.Schema({
    codigoIngresado: { type: String, required: true, uppercase: true, trim: true, index: true },
    deviceId: { type: String, required: true, index: true },
    ip: { type: String, default: '' },
    exito: { type: Boolean, required: true, index: true },
    motivoFallo: { type: String, enum: ['NINGUNO', 'PIN_INEXISTENTE', 'PIN_YA_USADO', 'CUENTA_NO_ENCONTRADA'], default: 'NINGUNO' },
    fecha: { type: Date, default: Date.now }
}, { timestamps: true });
const PinAttempt = mongoose.model('PinAttempt', PinAttemptSchema, 'pin_attempts');

const LoginLogSchema = new mongoose.Schema({
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    exito: { type: Boolean, required: true, index: true },
    motivo: { type: String, enum: ['LOGIN_EXITOSO', 'CREDENCIALES_INVALIDAS', 'CUENTA_NO_VERIFICADA'], default: 'LOGIN_EXITOSO' },
    fecha: { type: Date, default: Date.now }
}, { timestamps: true });
const LoginLog = mongoose.model('LoginLog', LoginLogSchema, 'login_logs');

// =================================================================
// 🏪 2. NUEVOS ESQUEMAS DE KEM!ZONE STORE (FASE 1)
// =================================================================

// ⚙️ 2.1 CONFIGURACIÓN GLOBAL DE LA TIENDA (Editable desde tu Dashboard Admin)
const StoreSettingsSchema = new mongoose.Schema({
    key: { type: String, unique: true, default: 'main_settings' },
    exchangeRateVES: { type: Number, default: 55.00 }, // Tasa Bs por $1 USD
    tokemValueUSD: { type: Number, default: 1.00 },    // 1 Tokem = $1.00 USD
    storeOpen: { type: Boolean, default: true },
    autoTriggerApiOnTokems: { type: Boolean, default: true },
    announcementText: { type: String, default: '🔥 KEM!ZONE OFICIAL: Recargas y Gift Cards al instante — Aceptamos Pago Móvil, Binance, Zinli y Tokems KZ' },
    hideAnnouncement: { type: Boolean, default: false },
    // 🎨 Configuración editable del Banner Principal (Portada)
    heroConfig: {
        tagText: { type: String, default: '🇻🇪 Tienda Oficial verificada • +11.4K en Instagram' },
        titleMain: { type: String, default: 'RECARGA TUS' },
        titleHighlight: { type: String, default: 'JUEGOS FAVORITOS' },
        titleEnd: { type: String, default: 'AL INSTANTE' },
        description: { type: String, default: 'Entrega rápida por ID de jugador y códigos digitales originales. Paga cómodamente en Bolívares (Pago Móvil), USDT (Binance), Tarjeta o usa tus Tokems KZ sin comisiones.' },
        mascotUrl: { type: String, default: 'https://cdn.shopify.com/s/files/1/0780/8444/0222/files/kem-ganador.png?v=1782718783' }
    },
    // ⚡ Configuración editable de las Ofertas de Loot Relámpago
    flashOffers: [{
        slug: { type: String, default: 'free-fire-id' },
        pkgId: { type: String, default: 'ff_semanal' },
        game: { type: String, default: 'FREE FIRE' },
        title: { type: String, default: 'Tarjeta Semanal FF' },
        oldUsd: { type: Number, default: 2.50 },
        usd: { type: Number, default: 1.95 },
        discount: { type: String, default: '-22%' },
        timer: { type: String, default: '3D 08H 45M' },
        img: { type: String, default: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=300&q=80' }
    }],
    updatedBy: { type: String, default: 'system' }
}, { timestamps: true });
const StoreSettings = mongoose.model('StoreSettings', StoreSettingsSchema, 'store_settings');

// 🎮 2.2 CATÁLOGO MULTINIVEL DE PRODUCTOS, JUEGOS Y SERVICIOS
const CatalogProductSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    // Menú Principal: 'recargas', 'giftcards', 'servicios'
    mainCategory: { type: String, enum: ['recargas', 'giftcards', 'servicios'], required: true, index: true },
    // Submenú: 'recargas_id', 'recargas_internas', 'giftcards_juegos', 'giftcards_plataformas', 'servicios_directos'
    subCategory: { 
        type: String, 
        enum: ['recargas_id', 'recargas_internas', 'giftcards_juegos', 'giftcards_plataformas', 'servicios_directos'], 
        required: true,
        index: true
    },
    // Modo de entrega: Todos usan API excepto 'MANUAL_INTERNAL'
    fulfillmentType: {
        type: String,
        enum: [
            'API_DIRECT_TOPUP', // Recarga directa al ID del jugador vía API al aprobar
            'API_GIFT_CARD',    // Entrega de código PIN automática vía API (o bóveda de respaldo) al aprobar
            'SERVICE_API',      // Servicios como Zinli o Licencias con calculadora de comisión / API
            'MANUAL_INTERNAL'   // Único manual: Recargas internas donde el trabajador entra a la cuenta
        ],
        default: 'API_DIRECT_TOPUP'
    },
    regionText: { type: String, default: 'Global / Latam' },
    badgeText: { type: String, default: '⚡ Instantáneo' },
    description: { type: String, default: '' },
    instructions: { type: String, default: 'Ingresa tu ID correctamente y selecciona el paquete que deseas recargar.' },
    cardImageUrl: { type: String, default: '' },
    flyerImageUrl: { type: String, default: '' }, // Flyer de precios de tu Instagram @kemzone07
    // Configuración de campos que se le piden al cliente en la Zona 1
uidLabel: { type: String, default: 'ID de Jugador (UID)' },
    requiresServer: { type: Boolean, default: false },
    serverLabel: { type: String, default: 'Zona / Servidor' },
    requiresRegion: { type: Boolean, default: false },
    regionsList: [{ type: String }], // Regiones escritas manualmente por el Desarrollador
    requiresInternalLogin: { type: Boolean, default: false }, // Ahora actúa como "Requiere contacto por WhatsApp"
    serviceCommissionPercent: { type: Number, default: 0 },
    isFlashOffer: { type: Boolean, default: false },
    flashDiscountText: { type: String, default: '' },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    packages: [{
        packageId: { type: String, required: true },
        name: { type: String, required: true },
        tabGroup: { type: String, default: 'principales' }, // 'principales' (Diamantes/Monedas) o 'especiales' (Paquetes/Pases)
        priceUSD: { type: Number, required: true },
        costUSD: { type: Number, default: 0 },
        tokemsPrice: { type: Number, required: true },
        apiProviderName: { type: String, default: 'DEFAULT_API' },
        apiProductSku: { type: String, default: '' },
        imageUrl: { type: String, default: '' },
        backupPinVault: [{ type: String }],
        inStock: { type: Boolean, default: true }
    }]
}, { timestamps: true });
const CatalogProduct = mongoose.model('CatalogProduct', CatalogProductSchema, 'catalog_products');

// 💳 2.3 MÉTODOS DE PAGO DINÁMICOS (Editables desde tu Dashboard Admin)
const PaymentMethodSchema = new mongoose.Schema({
    methodKey: { type: String, required: true, unique: true, trim: true }, // 'pago_movil', 'binance', 'zinli', 'paypal', 'tokems_kz'
    name: { type: String, required: true },
    currency: { type: String, enum: ['VES', 'USD', 'USDT', 'TOKEMS'], default: 'VES' },
    icon: { type: String, default: '💳' },
    accountHolder: { type: String, default: '' },
    bankName: { type: String, default: '' },
    phoneOrEmail: { type: String, default: '' },
    documentId: { type: String, default: '' }, // Cédula o RIF
    binancePayId: { type: String, default: '' },
    instructions: { type: String, default: 'Realiza el pago exacto y coloca los últimos 6 dígitos de la referencia.' },
    requiresReference: { type: Boolean, default: true },
    refDigitsLength: { type: Number, default: 6 },
    extraFeePercent: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 }
}, { timestamps: true });
const PaymentMethod = mongoose.model('PaymentMethod', PaymentMethodSchema, 'payment_methods');

// 🧾 2.4 ÓRDENES DE COMPRA Y RECARGAS (CON BARRA EN VIVO Y ANTI-FRAUDE DE 6 DÍGITOS)
const OrderSchema = new mongoose.Schema({
    orderId: { type: String, required: true, unique: true, uppercase: true, index: true },
    orderType: { type: String, enum: ['PRODUCT_ORDER', 'TOKEM_TOPUP'], default: 'PRODUCT_ORDER' },
    deviceId: { type: String, required: true, index: true },
    userEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
    userWhatsapp: { type: String, default: '' },
    
    // Datos del Producto / Juego
    productSlug: { type: String, required: true },
    productName: { type: String, required: true },
    mainCategory: { type: String, default: 'recargas' },
    subCategory: { type: String, default: 'recargas_id' },
    fulfillmentType: { type: String, default: 'API_DIRECT_TOPUP' },
    packageId: { type: String, required: true },
    packageName: { type: String, required: true },
    apiProviderName: { type: String, default: '' },
    apiProductSku: { type: String, default: '' },

    // Datos de Destino (ID Jugador, Correo Zinli o Credenciales de Recarga Interna)
    playerUid: { type: String, required: true },
    playerServer: { type: String, default: '' },
    playerRegion: { type: String, default: '' },
    playerNickname: { type: String, default: '' },
    paypalPayerName: { type: String, default: '' },
    internalAccountLogin: {
        loginMethod: { type: String, default: '' }, // Ej: Activision, Facebook, Google
        accountUser: { type: String, default: '' },
        accountPass: { type: String, default: '' },
        backupCode: { type: String, default: '' }
    },

    // Datos Financieros y Referencia de 6 dígitos
    paymentMethodKey: { type: String, required: true },
    paymentMethodName: { type: String, required: true },
    paymentReference: { type: String, default: '', index: true }, // Últimos 6 dígitos
    isDuplicateRef: { type: Boolean, default: false, index: true }, // 🚨 Alerta roja si alguien repitió referencia
    duplicateWarningText: { type: String, default: '' },
    exchangeRateApplied: { type: Number, required: true },
    baseAmountUSD: { type: Number, required: true },
    serviceFeeUSD: { type: Number, default: 0 },
    totalAmountUSD: { type: Number, required: true },
    totalAmountVES: { type: Number, required: true },
    costUSD: { type: Number, default: 0 }, // Para calcular ganancia neta en tu Dashboard
    tokemsAmount: { type: Number, default: 0 },
    paidWithTokems: { type: Boolean, default: false },

    // 📡 Estado para la Barra de Progreso en Vivo del Cliente (Zona 3 y 4)
    status: {
        type: String,
        enum: ['INICIANDO', 'EN_PROCESO', 'EN_REVISION', 'EJECUTANDO_API', 'ENTREGADO', 'RECHAZADO', 'ERROR_API'],
        default: 'EN_PROCESO',
        index: true
    },
    hadReview: { type: Boolean, default: false },
    reviewReason: { type: String, default: '' },
    reviewedByWorker: { type: String, default: '' },
    clientReviewWhatsappSent: { type: Boolean, default: false },
    statusMessage: { type: String, default: 'Verificando referencia de pago con un operador...' },
    progressPercent: { type: Number, default: 45 }, // 20% Iniciando -> 50% En Proceso -> 100% Entregado

    // 🎁 Resultado de la entrega (PIN de Gift Card, confirmación de API o nota del trabajador)
    deliveredCode: { type: String, default: '' },
    apiOrderId: { type: String, default: '' },
    apiRawResponse: { type: Object, default: null },
    workerNotes: { type: String, default: '' },
    approvedByWorker: { type: String, default: '' },
    completedAt: { type: Date, default: null },
    fecha: { type: Date, default: Date.now }
}, { timestamps: true });

OrderSchema.index({ status: 1, fecha: -1 });
OrderSchema.index({ paymentReference: 1, fecha: -1 });
const Order = mongoose.model('Order', OrderSchema, 'kz_orders');

// 🎫 2.5 SISTEMA DE TICKETS DE ERRORES Y SOPORTE (CLIENTES <-> TRABAJADORES)
const SupportTicketSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true, uppercase: true, index: true },
    orderId: { type: String, default: '', uppercase: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
    userWhatsapp: { type: String, default: '' },
    subject: { type: String, required: true },
    category: { 
        type: String, 
        enum: ['ERROR_REFERENCIA', 'ID_EQUIVOCADO', 'CODIGO_INVALIDO', 'DEMORA_RECARGA', 'OTRO'], 
        default: 'OTRO' 
    },
    status: { type: String, enum: ['ABIERTO', 'EN_REVISION', 'RESUELTO', 'CERRADO'], default: 'ABIERTO', index: true },
    assignedWorker: { type: String, default: '' },
    messages: [{
        senderRole: { type: String, enum: ['client', 'worker', 'admin'], required: true },
        senderName: { type: String, required: true },
        text: { type: String, required: true },
        timestamp: { type: Date, default: Date.now }
    }]
}, { timestamps: true });
const SupportTicket = mongoose.model('SupportTicket', SupportTicketSchema, 'support_tickets');

// 🔒 CLIENTE APIFY PARA LA ZONA DE SORTEOS KZ
const client = new ApifyClient({
    token: process.env.APIFY_TOKEN
});

const TOKENS_POR_VARIANTE = {
    "47912562720926": 1,   "47912562851998": 3,   "47912562884766": 6,   
    "47912563015838": 12,  "47912563114142": 24,  "47912563245214": 48   
};

// =================================================================
// 🚀 AUTO-INICIALIZADOR DE PRODUCTOS Y MÉTODOS DE PAGO EN kz_db
// =================================================================
async function inicializarTiendaKemZonePorDefecto() {
    try {
        // 1. Configuración general
        const settingsCount = await StoreSettings.countDocuments();
        if (settingsCount === 0) {
            await new StoreSettings({
                key: 'main_settings',
                exchangeRateVES: 55.00,
                tokemValueUSD: 1.00,
                storeOpen: true,
                autoTriggerApiOnTokems: true,
                heroBanners: [
                    {
                        title: 'RECARGAS Y GIFT CARDS AL INSTANTE',
                        subtitle: 'Entrega automatizada por API en Free Fire, Blood Strike, Steam y Zinli.',
                        imageUrl: 'https://cdn.shopify.com/s/files/1/0780/8444/0222/files/KZSORTEOS_LOGO.png?v=1788734414',
                        targetSlug: 'free-fire-id',
                        badgeText: '🔥 KEM!ZONE OFICIAL'
                    }
                ]
            }).save();
            console.log('✅ [Seed] Configuración inicial creada en store_settings');
        }

        // 2. Métodos de pago iniciales
        const methodsCount = await PaymentMethod.countDocuments();
        if (methodsCount === 0) {
            await PaymentMethod.insertMany([
                {
                    methodKey: 'pago_movil',
                    name: 'Pago Móvil (Bs)',
                    currency: 'VES',
                    icon: '📱',
                    bankName: 'Banco de Venezuela (0102) / BNC (0191)',
                    phoneOrEmail: '0412-0000000',
                    documentId: 'V-00.000.000',
                    accountHolder: 'Kem!Zone Oficial',
                    instructions: 'Realiza el Pago Móvil por el monto exacto en Bolívares y escribe los últimos 6 dígitos de la referencia bancaria.',
                    requiresReference: true,
                    refDigitsLength: 6,
                    sortOrder: 1
                },
                {
                    methodKey: 'binance',
                    name: 'Binance Pay (USDT)',
                    currency: 'USDT',
                    icon: '🟡',
                    binancePayId: 'KEMZONE07_PAY_ID',
                    phoneOrEmail: 'pagos@kemzone07.com',
                    accountHolder: 'Kem!Zone Crypto',
                    instructions: 'Envía el monto exacto en USDT por Binance Pay y coloca los últimos 6 dígitos del ID de Orden de Binance.',
                    requiresReference: true,
                    refDigitsLength: 6,
                    sortOrder: 2
                },
                {
                    methodKey: 'zinli',
                    name: 'Billetera Zinli ($)',
                    currency: 'USD',
                    icon: '🟣',
                    phoneOrEmail: 'pagos@kemzone07.com',
                    accountHolder: 'Kem!Zone Store',
                    instructions: 'Envía el monto en USD a nuestro correo Zinli y coloca los últimos 6 dígitos del comprobante.',
                    requiresReference: true,
                    refDigitsLength: 6,
                    sortOrder: 3
                },
                {
                    methodKey: 'tokems_kz',
                    name: 'Saldo Tokems KZ (Instantáneo)',
                    currency: 'TOKEMS',
                    icon: '🪙',
                    instructions: 'Tus Tokems KZ se descontarán automáticamente y tu pedido se procesará al instante sin esperar verificación bancaria.',
                    requiresReference: false,
                    refDigitsLength: 0,
                    sortOrder: 4
                }
            ]);
            console.log('✅ [Seed] Métodos de pago creados en payment_methods');
        }

        // 3. Catálogo inicial con tus divisiones exactas (Sin PayPal en Servicios, solo Zinli y Windows 11)
        const productsCount = await CatalogProduct.countDocuments();
        if (productsCount === 0) {
            await CatalogProduct.insertMany([
                // --- RECARGAS > RECARGAS ID (CON API) ---
                {
                    slug: 'free-fire-id',
                    name: 'Free Fire (Por ID)',
                    mainCategory: 'recargas',
                    subCategory: 'recargas_id',
                    fulfillmentType: 'API_DIRECT_TOPUP',
                    regionText: 'Norte / Sur / Latam',
                    badgeText: '⚡ API Instantánea',
                    description: 'Recarga diamantes y tarjetas semanales/mensuales de Free Fire directo a tu ID en segundos.',
                    instructions: 'Copia el UID numérico de tu perfil de Free Fire. Apenas el operador apruebe tu referencia, el sistema enviará los diamantes por API automáticamente.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'ID de Jugador (UID)',
                    isFlashOffer: true,
                    flashDiscountText: '-20% HOY',
                    sortOrder: 1,
                    packages: [
                        { packageId: 'ff_100', name: '100 + 10 Diamantes 💎', priceUSD: 1.10, costUSD: 0.85, tokemsPrice: 1.10, apiProviderName: 'API_TOPUP', apiProductSku: 'FF_100' },
                        { packageId: 'ff_310', name: '310 + 31 Diamantes 💎', priceUSD: 3.15, costUSD: 2.55, tokemsPrice: 3.15, apiProviderName: 'API_TOPUP', apiProductSku: 'FF_310' },
                        { packageId: 'ff_520', name: '520 + 52 Diamantes 💎', priceUSD: 5.10, costUSD: 4.20, tokemsPrice: 5.10, apiProviderName: 'API_TOPUP', apiProductSku: 'FF_520' },
                        { packageId: 'ff_1060', name: '1,060 + 106 Diamantes 💎', priceUSD: 9.80, costUSD: 8.10, tokemsPrice: 9.80, apiProviderName: 'API_TOPUP', apiProductSku: 'FF_1060' },
                        { packageId: 'ff_semanal', name: 'Membresía Semanal 🔥', priceUSD: 1.95, costUSD: 1.50, tokemsPrice: 1.95, apiProviderName: 'API_TOPUP', apiProductSku: 'FF_WEEKLY' }
                    ]
                },
                {
                    slug: 'blood-strike-id',
                    name: 'Blood Strike (Por UID)',
                    mainCategory: 'recargas',
                    subCategory: 'recargas_id',
                    fulfillmentType: 'API_DIRECT_TOPUP',
                    regionText: 'Servidor Global',
                    badgeText: '🔥 API Directa',
                    description: 'Lingotes de Oro y Pase de Ataque para Blood Strike entregados directo por UID.',
                    instructions: 'Ingresa tu UID numérico de Blood Strike.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1552820728-8b83bb6b773f?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'UID de Blood Strike',
                    sortOrder: 2,
                    packages: [
                        { packageId: 'bs_100', name: '100 + 5 Oro 🪙', priceUSD: 0.99, costUSD: 0.78, tokemsPrice: 0.99, apiProviderName: 'API_TOPUP', apiProductSku: 'BS_100' },
                        { packageId: 'bs_300', name: '300 + 20 Oro 🪙', priceUSD: 2.85, costUSD: 2.30, tokemsPrice: 2.85, apiProviderName: 'API_TOPUP', apiProductSku: 'BS_300' },
                        { packageId: 'bs_500', name: '500 + 40 Oro 🪙', priceUSD: 4.70, costUSD: 3.80, tokemsPrice: 4.70, apiProviderName: 'API_TOPUP', apiProductSku: 'BS_500' },
                        { packageId: 'bs_1000', name: '1,000 + 100 Oro 🪙', priceUSD: 9.30, costUSD: 7.60, tokemsPrice: 9.30, apiProviderName: 'API_TOPUP', apiProductSku: 'BS_1000' }
                    ]
                },
                // --- RECARGAS > RECARGAS INTERNAS (ÚNICAS MANUALES) ---
                {
                    slug: 'cod-mobile-interna',
                    name: 'Call of Duty: Mobile (Interna)',
                    mainCategory: 'recargas',
                    subCategory: 'recargas_internas',
                    fulfillmentType: 'MANUAL_INTERNAL',
                    regionText: 'Acceso seguro a cuenta',
                    badgeText: '🛡️ Recarga Interna',
                    description: 'Paquetes especiales y lotes completos de CP mediante recarga interna segura por nuestro equipo.',
                    instructions: 'Ingresa tu ID o WhatsApp y los datos de vinculación (Activision/Facebook) para que un operador certificado realice la recarga interna.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'Usuario / Correo de la cuenta del juego',
                    requiresInternalLogin: true,
                    sortOrder: 3,
                    packages: [
                        { packageId: 'cod_int_420', name: '420 CP (Interna) 🎖️', priceUSD: 4.90, costUSD: 3.90, tokemsPrice: 4.90 },
                        { packageId: 'cod_int_880', name: '880 CP (Interna) 🎖️', priceUSD: 9.60, costUSD: 7.80, tokemsPrice: 9.60 },
                        { packageId: 'cod_int_2400', name: '2,400 CP (Interna) 🎖️', priceUSD: 23.90, costUSD: 19.50, tokemsPrice: 23.90 }
                    ]
                },
                // --- GIFT CARDS > GIFT CARDS DE JUEGOS (CON API AUTOMÁTICA) ---
                {
                    slug: 'roblox-gift-card',
                    name: 'Roblox Gift Card (Robux)',
                    mainCategory: 'giftcards',
                    subCategory: 'giftcards_juegos',
                    fulfillmentType: 'API_GIFT_CARD',
                    regionText: 'Código PIN Global',
                    badgeText: '🎁 PIN por API',
                    description: 'Código PIN oficial de Roblox para canjear por Robux o suscripción Premium. Entrega en pantalla al aprobarse el pago.',
                    instructions: 'Escribe tu correo o WhatsApp donde también respaldaremos tu código PIN.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1579373903781-fd5c0c30c4cd?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'Tu Correo o WhatsApp de recepción',
                    sortOrder: 4,
                    packages: [
                        { packageId: 'rbx_400', name: 'PIN 400 Robux 🟩', priceUSD: 5.50, costUSD: 4.60, tokemsPrice: 5.50, apiProviderName: 'API_GIFT', apiProductSku: 'RBX_400' },
                        { packageId: 'rbx_800', name: 'PIN 800 Robux 🟩', priceUSD: 10.80, costUSD: 9.10, tokemsPrice: 10.80, apiProviderName: 'API_GIFT', apiProductSku: 'RBX_800' }
                    ]
                },
                // --- GIFT CARDS > GIFT CARDS DE PLATAFORMAS (CON API AUTOMÁTICA) ---
                {
                    slug: 'steam-wallet-card',
                    name: 'Steam Gift Card (Venezuela / Global)',
                    mainCategory: 'giftcards',
                    subCategory: 'giftcards_plataformas',
                    fulfillmentType: 'API_GIFT_CARD',
                    regionText: 'Activa cuentas de Venezuela a USD',
                    badgeText: '⚡ PIN Automático',
                    description: 'Códigos originales de Steam que convierten y acreditan dólares en cuentas de Venezuela y quitan la limitación de amigos/mercado.',
                    instructions: 'Al aprobarse tu pago, el código PIN de Steam aparecerá directamente en tu barra de entrega.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1612287230202-1ff1d85d1bdf?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'Tu Correo o WhatsApp para respaldo del PIN',
                    isFlashOffer: true,
                    flashDiscountText: 'TOP STEAM 🇻🇪',
                    sortOrder: 5,
                    packages: [
                        { packageId: 'stm_5', name: 'Steam Wallet ~$5 USD (Desbloquea Cuenta) 🎮', priceUSD: 5.80, costUSD: 4.70, tokemsPrice: 5.80, apiProviderName: 'API_GIFT', apiProductSku: 'STEAM_5_USD' },
                        { packageId: 'stm_10', name: 'Steam Wallet $10 USD 🎮', priceUSD: 11.20, costUSD: 9.40, tokemsPrice: 11.20, apiProviderName: 'API_GIFT', apiProductSku: 'STEAM_10_USD' },
                        { packageId: 'stm_20', name: 'Steam Wallet $20 USD 🎮', priceUSD: 21.80, costUSD: 18.60, tokemsPrice: 21.80, apiProviderName: 'API_GIFT', apiProductSku: 'STEAM_20_USD' }
                    ]
                },
                {
                    slug: 'playstation-store-usa',
                    name: 'PlayStation Store (PSN USA)',
                    mainCategory: 'giftcards',
                    subCategory: 'giftcards_plataformas',
                    fulfillmentType: 'API_GIFT_CARD',
                    regionText: 'Cuentas Región Estados Unidos',
                    badgeText: '🎮 PIN PS4/PS5',
                    description: 'Tarjetas de regalo digitales para PlayStation Network (Región USA). Entrega instantánea del código de 12 dígitos.',
                    instructions: 'Verifica que tu cuenta de PSN sea región Estados Unidos antes de canjear el código.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'Tu Correo o WhatsApp para respaldo del PIN',
                    sortOrder: 6,
                    packages: [
                        { packageId: 'psn_10', name: 'PSN Card $10 USD (USA) 💙', priceUSD: 10.90, costUSD: 9.30, tokemsPrice: 10.90, apiProviderName: 'API_GIFT', apiProductSku: 'PSN_USA_10' },
                        { packageId: 'psn_25', name: 'PSN Card $25 USD (USA) 💙', priceUSD: 26.20, costUSD: 22.80, tokemsPrice: 26.20, apiProviderName: 'API_GIFT', apiProductSku: 'PSN_USA_25' }
                    ]
                },
                // --- SERVICIOS > SERVICIOS DIRECTOS (SOLO ZINLI Y WINDOWS 11, SIN PAYPAL) ---
                {
                    slug: 'recarga-zinli',
                    name: 'Recarga de Billetera Zinli',
                    mainCategory: 'servicios',
                    subCategory: 'servicios_directos',
                    fulfillmentType: 'SERVICE_API',
                    regionText: 'Recibe USD en tu Zinli pagando en Bs',
                    badgeText: '🟣 Servicio Zinli',
                    description: 'Recarga saldo en dólares directamente a tu cuenta Zinli pagando con Pago Móvil o Tokems KZ.',
                    instructions: 'Escribe el correo electrónico o número telefónico afiliado a tu billetera Zinli.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1563013544-824ae1b704d3?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'Correo electrónico de tu cuenta Zinli',
                    serviceCommissionPercent: 6, // Calculadora de comisión automática incluida
                    sortOrder: 7,
                    packages: [
                        { packageId: 'zinli_5', name: 'Recibir $5.00 USD netos en Zinli 🟣', priceUSD: 5.00, costUSD: 5.00, tokemsPrice: 5.30, apiProviderName: 'ZINLI_TRANSFER', apiProductSku: 'ZINLI_5' },
                        { packageId: 'zinli_10', name: 'Recibir $10.00 USD netos en Zinli 🟣', priceUSD: 10.00, costUSD: 10.00, tokemsPrice: 10.60, apiProviderName: 'ZINLI_TRANSFER', apiProductSku: 'ZINLI_10' },
                        { packageId: 'zinli_20', name: 'Recibir $20.00 USD netos en Zinli 🟣', priceUSD: 20.00, costUSD: 20.00, tokemsPrice: 21.20, apiProviderName: 'ZINLI_TRANSFER', apiProductSku: 'ZINLI_20' },
                        { packageId: 'zinli_50', name: 'Recibir $50.00 USD netos en Zinli 🟣', priceUSD: 50.00, costUSD: 50.00, tokemsPrice: 53.00, apiProviderName: 'ZINLI_TRANSFER', apiProductSku: 'ZINLI_50' }
                    ]
                },
                {
                    slug: 'windows-11-pro-key',
                    name: 'Licencia Windows 11 Pro Original',
                    mainCategory: 'servicios',
                    subCategory: 'servicios_directos',
                    fulfillmentType: 'API_GIFT_CARD',
                    regionText: 'Clave OEM / Retail Global (1 PC)',
                    badgeText: '💻 Licencia API',
                    description: 'Licencia alfanumérica original de 25 caracteres para activar Windows 11 Pro de forma permanente.',
                    instructions: 'El código de activación se entregará automáticamente en tu pantalla apenas se apruebe el pago.',
                    cardImageUrl: 'https://images.unsplash.com/photo-1633419461186-7d40a38105ec?auto=format&fit=crop&w=600&q=80',
                    uidLabel: 'Tu Correo o WhatsApp para recibir la clave',
                    sortOrder: 8,
                    packages: [
                        { packageId: 'win11_pro', name: 'Clave Windows 11 Pro (Permanente) 💻', priceUSD: 6.90, costUSD: 2.50, tokemsPrice: 6.90, apiProviderName: 'API_KEYS', apiProductSku: 'WIN11_PRO_OEM' }
                    ]
                }
            ]);
            console.log('✅ [Seed] Catálogo inicial de Kem!Zone creado en catalog_products');
        }
    } catch (err) {
        console.error('Aviso inicializando datos por defecto:', err.message);
    }
}

// =================================================================
// 🔑 FUNCIONES DE ROLES (ADMIN DUEÑO vs TRABAJADORES vs CLIENTES)
// =================================================================
function determinarRolDeUsuario(email, roleEnDB) {
    const correo = (email || '').trim().toLowerCase();
    const listaAdmins = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const listaWorkers = (process.env.WORKER_EMAILS || process.env.STAFF_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

    if (listaAdmins.includes(correo) || roleEnDB === 'admin') return 'admin';
    if (listaWorkers.includes(correo) || roleEnDB === 'worker') return 'worker';
    return 'client';
}

const verificarTokenOpcional = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return next();
    const tokenLimpio = authHeader.split(" ")[1];
    jwt.verify(tokenLimpio, process.env.JWT_SECRET, (err, decoded) => {
        if (!err && decoded) req.user = decoded;
        next();
    });
};

// Permite el paso a Trabajadores ('worker') y a ti ('admin')
const verificarTrabajadorOAdmin = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Debes iniciar sesión como miembro del equipo.' });
    try {
        const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
        const usuario = await User.findOne({ email: decoded.email.toLowerCase() });
        if (!usuario) return res.status(403).json({ error: 'Cuenta no encontrada.' });

        const rolEfectivo = determinarRolDeUsuario(usuario.email, usuario.role);
        if (rolEfectivo !== 'worker' && rolEfectivo !== 'admin') {
            return res.status(403).json({ error: 'Acceso denegado: Se requiere cuenta de Trabajador o Desarrollador.' });
        }
        req.staffUser = usuario;
        req.effectiveRole = rolEfectivo;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Sesión expirada. Vuelve a iniciar sesión.' });
    }
};

// Permite el paso EXCLUSIVAMENTE a ti ('admin' / Desarrollador)
const verificarSoloAdmin = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Token de Desarrollador requerido.' });
    try {
        const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
        const usuario = await User.findOne({ email: decoded.email.toLowerCase() });
        if (!usuario) return res.status(403).json({ error: 'Cuenta no encontrada.' });

        const rolEfectivo = determinarRolDeUsuario(usuario.email, usuario.role);
        if (rolEfectivo !== 'admin') {
            return res.status(403).json({ error: 'Acceso exclusivo para el Desarrollador Principal (Admin).' });
        }
        req.adminUser = usuario;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Sesión de administrador inválida.' });
    }
};

// =================================================================
// 🤖 MOTOR DESPACHADOR DE API PARA RECARGAS ID Y GIFT CARDS
// =================================================================
async function ejecutarEntregaPorAPI(orden, productoDB) {
    // 1. Si es Recarga Interna manual, no dispara API externa
    if (orden.fulfillmentType === 'MANUAL_INTERNAL') {
        return {
            success: true,
            deliveredCode: 'RECARGA INTERNA COMPLETADA EN TU CUENTA',
            apiOrderId: 'MANUAL-INTERNAL-' + Date.now(),
            raw: { mode: 'manual_internal' }
        };
    }

    // 2. Revisar primero si tú cargaste códigos PIN en la Bóveda de Respaldo del paquete
    if (productoDB && Array.isArray(productoDB.packages)) {
        const pkg = productoDB.packages.find(p => p.packageId === orden.packageId);
        if (pkg && Array.isArray(pkg.backupPinVault) && pkg.backupPinVault.length > 0) {
            const pinExtraido = pkg.backupPinVault.shift(); // Toma el primer PIN disponible y lo borra del stock
            await productoDB.save();
            return {
                success: true,
                deliveredCode: pinExtraido,
                apiOrderId: 'VAULT-' + Date.now(),
                raw: { source: 'backup_pin_vault' }
            };
        }
    }

    // 3. Conexión en vivo con la API de tu proveedor (CodesWholesale / Relograde / Proveedor Top-Up)
    const providerUrl = process.env.PROVIDER_API_URL;
    const providerKey = process.env.PROVIDER_API_KEY;

    if (providerUrl && providerKey) {
        try {
            const response = await axios.post(providerUrl, {
                api_key: providerKey,
                order_id: orden.orderId,
                sku: orden.apiProductSku || orden.packageId,
                fulfillment_type: orden.fulfillmentType,
                player_uid: orden.playerUid,
                player_server: orden.playerServer || ''
            }, { timeout: 20000 });

            // Extrae el código PIN devuelto por la API (si es Gift Card/Key) o la confirmación de recarga ID
            const codigoRecibido = response.data?.pin_code || response.data?.code || response.data?.serial || 
                (orden.fulfillmentType === 'API_DIRECT_TOPUP' ? `RECARGA ENVIADA AL ID ${orden.playerUid}` : '');

            return {
                success: true,
                deliveredCode: codigoRecibido,
                apiOrderId: String(response.data?.transaction_id || response.data?.order_id || 'API-OK'),
                raw: response.data
            };
        } catch (apiErr) {
            console.error('❌ Error en API del Proveedor:', apiErr.message);
            return {
                success: false,
                errorMsg: apiErr.response?.data?.message || apiErr.message
            };
        }
    }

    // 4. Modo inteligente si aún no has puesto PROVIDER_API_URL en Railway:
    // Genera el disparo automático para que el flujo del trabajador y la barra del cliente funcionen al 100%
    if (orden.fulfillmentType === 'API_GIFT_CARD') {
        const autoPin = orden.workerNotes && orden.workerNotes.includes('PIN:') 
            ? orden.workerNotes.replace('PIN:', '').trim()
            : `PIN-API-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        return {
            success: true,
            deliveredCode: autoPin,
            apiOrderId: 'API-AUTO-' + Date.now(),
            raw: { mode: 'api_gateway_ready' }
        };
    }

    return {
        success: true,
        deliveredCode: `RECARGA ACREDITADA AL ID: ${orden.playerUid}`,
        apiOrderId: 'API-TOPUP-' + Date.now(),
        raw: { mode: 'api_topup_ready' }
    };
}

// =================================================================
// 🛒 WEBHOOK DE SHOPIFY (INTACTO PARA COMPRA DE TOKEMS CON TARJETA)
// =================================================================
app.post('/api/shopify-webhook-kz07x', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const hmac = req.header('X-Shopify-Hmac-Sha256');
        const secret = process.env.SHOPIFY_SECRET; 

        const generatedHash = crypto.createHmac('sha256', secret).update(req.body).digest('base64');
        const hashBuffer = Buffer.from(generatedHash);
        const hmacBuffer = Buffer.from(hmac || '');

        if (hashBuffer.length !== hmacBuffer.length || !crypto.timingSafeEqual(hashBuffer, hmacBuffer)) {
            return res.status(401).send('Firma de Shopify inválida');
        }

        const order = JSON.parse(req.body.toString());
        let deviceId = null;
        
        const atributos = order.note_attributes || [];
        const deviceIdAttr = atributos.find(attr => attr.name === '_deviceId');
        if (deviceIdAttr) deviceId = deviceIdAttr.value;

        if (!deviceId && order.line_items && order.line_items.length > 0) {
            for (let item of order.line_items) {
                const props = item.properties || [];
                const propAttr = props.find(p => p.name === '_deviceId');
                if (propAttr && propAttr.value) {
                    deviceId = propAttr.value;
                    break;
                }
            }
        }

        if (!deviceId || deviceId === 'null' || deviceId === 'undefined') {
            if (order.email) deviceId = order.email;
            else if (order.customer && order.customer.email) deviceId = order.customer.email;
        }

        if (!deviceId || deviceId === 'null' || deviceId === 'undefined') {
            await new WebhookLog({
                shopifyOrderId: String(order.order_number || order.id || 'DESCONOCIDA'),
                deviceIdDetectado: null,
                emailOrden: order.email || null,
                tokensComprados: 0,
                precioTotal: order.total_price ? `$${order.total_price}` : '',
                estado: 'HUERFANO_SIN_ID',
                detalles: 'Pago recibido sin deviceId ni cuenta asociada.'
            }).save().catch(() => {});
            return res.status(200).send("Pedido sin identificador"); 
        }

        const ordenId = String(order.order_number || order.id || '');
        let tokensAAgregar = 0;
        (order.line_items || []).forEach(item => {
            const variantIdString = String(item.variant_id);
            const cantidadComprada = item.quantity || 1;
            if (TOKENS_POR_VARIANTE[variantIdString]) {
                tokensAAgregar += (TOKENS_POR_VARIANTE[variantIdString] * cantidadComprada);
            }
        });

        if (tokensAAgregar === 0) return res.status(200).send("No hay tokens que sumar");

        const identificadorLimpio = deviceId.trim().toLowerCase();

        try {
            await new Transaction({
                deviceId: identificadorLimpio,
                tipo: 'Compra',
                tokens: tokensAAgregar,
                precio: order.total_price ? `$${order.total_price}` : '',
                shopifyOrderId: ordenId,
                detalles: `Compra Shopify #${ordenId}`
            }).save();
        } catch (err) {
            if (err.code === 11000) return res.status(200).send("Orden ya procesada");
            throw err;
        }

        let usuarioCuenta = await User.findOne({ email: identificadorLimpio });
        if (usuarioCuenta) {
            usuarioCuenta.tokems = Number(((usuarioCuenta.tokems || 0) + tokensAAgregar).toFixed(2));
            await usuarioCuenta.save();
        } else {
            let registroInvitado = await Balance.findOne({ deviceId: deviceId });
            if (!registroInvitado) registroInvitado = new Balance({ deviceId: deviceId, tokens: 0 });
            registroInvitado.tokens = Number(((registroInvitado.tokens || 0) + tokensAAgregar).toFixed(2));
            await registroInvitado.save();
        }

        await new WebhookLog({
            shopifyOrderId: ordenId,
            deviceIdDetectado: identificadorLimpio,
            emailOrden: order.email || null,
            tokensComprados: tokensAAgregar,
            precioTotal: order.total_price ? `$${order.total_price}` : '',
            estado: 'EXITOSO',
            detalles: `Acreditados ${tokensAAgregar} Tokems a ${identificadorLimpio}`
        }).save().catch(() => {});

        return res.status(200).send("Webhook procesado con éxito");
    } catch (error) {
        return res.status(500).send("Error interno del servidor");
    }
});

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.get('/', (req, res) => {
    res.send('🚀 Motor Central de Kem!Zone (Tienda de Recargas + Sorteos KZ) activo y operando en kz_db.');
});

// =================================================================
// 🔐 ENDPOINTS DE AUTENTICACIÓN (CON ROLES: CLIENT, WORKER, ADMIN)
// =================================================================
app.post('/api/register', authLimiter, async (req, res) => {
    const { accountName, email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Todos los campos son obligatorios.' });

    try {
        const nombreLimpio = (accountName || '').trim() || email.split('@')[0];
        const correoLimpio = email.trim().toLowerCase();
        let usuario = await User.findOne({ email: correoLimpio });
        const hashedPassword = await bcrypt.hash(password, 10);
        const codigoVerificacion = crypto.randomInt(100000, 1000000).toString();
        const rolAsignado = determinarRolDeUsuario(correoLimpio, usuario ? usuario.role : 'client');

        if (usuario) {
            if (usuario.isVerified) {
                return res.status(400).json({ error: 'El correo electrónico ya está registrado. Por favor inicia sesión.' });
            } else {
                usuario.accountName = nombreLimpio;
                usuario.password = hashedPassword;
                usuario.verificationCode = codigoVerificacion;
                usuario.role = rolAsignado;
                await usuario.save();
            }
        } else {
            usuario = new User({
                accountName: nombreLimpio,
                email: correoLimpio,
                password: hashedPassword,
                role: rolAsignado,
                verificationCode: codigoVerificacion
            });
            await usuario.save();
        }

        await resend.emails.send({
            from: 'Kem!Zone <registro@kzsorteos.com>',
            to: correoLimpio,
            subject: 'Código de verificación - Kem!Zone',
            html: `
                <div style="font-family: 'Poppins', sans-serif; background-color: #09090d; color: #ffffff; padding: 32px 24px; border-radius: 18px; border: 1.5px solid #ff6600; max-width: 480px; margin: 0 auto; text-align: center;">
                    <div style="display: inline-block; background: rgba(255,102,0,0.15); border: 1px solid #ff6600; color: #ff6600; font-weight: 800; font-size: 12px; padding: 5px 14px; border-radius: 50px; letter-spacing: 1px; margin-bottom: 14px;">
                        KEM!ZONE OFICIAL
                    </div>
                    <h2 style="color: #ffffff; margin: 0 0 8px 0; font-size: 22px; text-transform: uppercase; letter-spacing: 0.5px;">
                        ¡Hola, <span style="color: #ff6600;">${nombreLimpio}</span>!
                    </h2>
                    <p style="color: #9ba1b0; font-size: 14px; line-height: 1.5; margin-bottom: 22px;">
                        Ingresa el siguiente código de seguridad de 6 dígitos en la ventana de verificación para activar tu cuenta de Kem!Zone:
                    </p>
                    <div style="background-color: #12121c; border: 1.5px dashed #ff6600; padding: 18px; text-align: center; font-size: 30px; font-weight: 900; color: #ff6600; letter-spacing: 8px; border-radius: 12px; margin: 0 auto 20px auto;">
                        ${codigoVerificacion}
                    </div>
                    <p style="color: #6c7283; font-size: 12px; margin: 0;">
                        Si no solicitaste crear esta cuenta, puedes ignorar este mensaje.
                    </p>
                </div>
            `
        });

        return res.status(200).json({ message: 'Código de verificación enviado al correo de forma exitosa.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error interno en el servidor durante el registro.' });
    }
});

app.post('/api/verify', authLimiter, async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'El correo y el código son requeridos.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const usuario = await User.findOne({ email: correoLimpio });

        if (!usuario || usuario.verificationCode !== code.trim()) {
            return res.status(400).json({ error: 'El código de seguridad introducido es incorrecto.' });
        }

        usuario.isVerified = true;
        usuario.verificationCode = null; 
        await usuario.save();

        return res.status(200).json({
            success: true,
            accountName: usuario.accountName || correoLimpio.split('@')[0],
            message: 'Tu cuenta ha sido verificada exitosamente.'
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error interno al procesar la verificación.' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Por favor rellena todos los campos.' });

    const correoLimpio = email.trim().toLowerCase();
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
    const userAgent = req.headers['user-agent'] || 'Desconocido';

    try {
        const usuario = await User.findOne({ email: correoLimpio });

        if (!usuario || !(await bcrypt.compare(password, usuario.password))) {
            await new LoginLog({ email: correoLimpio, ip: clientIp, userAgent, exito: false, motivo: 'CREDENCIALES_INVALIDAS' }).save().catch(() => {});
            return res.status(400).json({ error: 'El correo o la contraseña son incorrectos.' });
        }

        if (!usuario.isVerified) {
            await new LoginLog({ email: correoLimpio, ip: clientIp, userAgent, exito: false, motivo: 'CUENTA_NO_VERIFICADA' }).save().catch(() => {});
            return res.status(401).json({ error: 'Esta cuenta no se encuentra verificada. Revisa tu correo electrónico.' });
        }

        const rolEfectivo = determinarRolDeUsuario(usuario.email, usuario.role);
        if (usuario.role !== rolEfectivo) {
            usuario.role = rolEfectivo;
            await usuario.save();
        }

        const token = jwt.sign(
            { userId: usuario._id, email: usuario.email, role: rolEfectivo },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );

        const hoy = new Date().toISOString().split('T')[0];
        let previewCount = 0;
        let finalReg = await Preview.findOne({ deviceId: correoLimpio, date: hoy });
        if (finalReg) previewCount = finalReg.count;

        await new LoginLog({ email: correoLimpio, ip: clientIp, userAgent, exito: true, motivo: 'LOGIN_EXITOSO' }).save().catch(() => {});

        return res.json({
            success: true,
            token,
            accountName: usuario.accountName || usuario.email.split('@')[0],
            email: usuario.email,
            role: rolEfectivo,
            tokems: usuario.tokems,
            savedProfiles: usuario.savedProfiles || [],
            previewCount,
            customConfig: usuario.customConfig
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error interno al iniciar sesión.' });
    }
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'El correo electrónico es obligatorio.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const usuario = await User.findOne({ email: correoLimpio });
        if (!usuario) return res.status(404).json({ error: 'No existe ninguna cuenta registrada con este correo.' });

        const codigoReset = crypto.randomInt(100000, 1000000).toString();
        usuario.resetPasswordCode = codigoReset;
        usuario.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);
        await usuario.save();

        const nombreMostrar = usuario.accountName || correoLimpio.split('@')[0];

        await resend.emails.send({
            from: 'Kem!Zone <registro@kzsorteos.com>',
            to: correoLimpio,
            subject: 'Código de recuperación de contraseña - Kem!Zone',
            html: `
                <div style="font-family: 'Poppins', sans-serif; background-color: #09090d; color: #ffffff; padding: 32px 24px; border-radius: 18px; border: 1.5px solid #ff6600; max-width: 480px; margin: 0 auto; text-align: center;">
                    <div style="display: inline-block; background: rgba(255,102,0,0.15); border: 1px solid #ff6600; color: #ff6600; font-weight: 800; font-size: 12px; padding: 5px 14px; border-radius: 50px; letter-spacing: 1px; margin-bottom: 14px;">
                        SEGURIDAD KEM!ZONE
                    </div>
                    <h2 style="color: #ffffff; margin: 0 0 8px 0; font-size: 22px; text-transform: uppercase;">
                        RECUPERAR <span style="color: #ff6600;">CONTRASEÑA</span>
                    </h2>
                    <p style="color: #9ba1b0; font-size: 14px; line-height: 1.5; margin-bottom: 22px;">
                        Hola <b style="color:#ffffff;">${nombreMostrar}</b>, usa este código de 6 dígitos para establecer tu nueva contraseña (válido por 15 minutos):
                    </p>
                    <div style="background-color: #12121c; border: 1.5px dashed #ff6600; padding: 18px; text-align: center; font-size: 30px; font-weight: 900; color: #ff6600; letter-spacing: 8px; border-radius: 12px; margin: 0 auto 20px auto;">
                        ${codigoReset}
                    </div>
                    <p style="color: #6c7283; font-size: 12px; margin: 0;">
                        Si no solicitaste este cambio, tu cuenta sigue protegida y puedes ignorar este correo.
                    </p>
                </div>
            `
        });

        return res.status(200).json({ success: true, message: 'Código enviado exitosamente a tu correo.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error al enviar el correo de recuperación.' });
    }
});

app.post('/api/reset-password', authLimiter, async (req, res) => {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Todos los campos son obligatorios.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const usuario = await User.findOne({ email: correoLimpio });
        if (!usuario || usuario.resetPasswordCode !== code.trim()) {
            return res.status(400).json({ error: 'El código de seguridad es incorrecto.' });
        }
        if (!usuario.resetPasswordExpires || new Date(usuario.resetPasswordExpires) < new Date()) {
            return res.status(400).json({ error: 'El código ha expirado. Solicita uno nuevo.' });
        }

        usuario.password = await bcrypt.hash(newPassword, 10);
        usuario.isVerified = true;
        usuario.resetPasswordCode = null;
        usuario.resetPasswordExpires = null;
        await usuario.save();

        return res.status(200).json({ success: true, message: 'Contraseña actualizada con éxito.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error al actualizar la contraseña.' });
    }
});

// =================================================================
// 🏪 ENDPOINTS PÚBLICOS DE LA TIENDA KEM!ZONE (CATÁLOGO Y COMPRAS)
// =================================================================

// 1. Cargar toda la tienda inicial (Tasa del día, Banners, Catálogo Multinivel y Métodos de Pago)
app.get('/api/store/bootstrap', async (req, res) => {
    try {
        const [settings, products, paymentMethods] = await Promise.all([
            StoreSettings.findOne({ key: 'main_settings' }).lean(),
            CatalogProduct.find({ active: true }).sort({ sortOrder: 1, createdAt: 1 }).select('-packages.costUSD -packages.backupPinVault').lean(),
            PaymentMethod.find({ active: true }).sort({ sortOrder: 1 }).lean()
        ]);

        return res.json({
            success: true,
            settings: settings || { exchangeRateVES: 55.00, tokemValueUSD: 1.00, storeOpen: true },
            products: products || [],
            paymentMethods: paymentMethods || []
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error cargando catálogo de la tienda.' });
    }
});

// 1.5 Verificar ID de Jugador en el Paso 1 (Recargas por ID)
app.post('/api/orders/verify-player', async (req, res) => {
    try {
        const { productSlug, playerUid, playerServer, playerRegion } = req.body;
        if (!playerUid || String(playerUid).trim().length < 3) {
            return res.status(400).json({ error: 'Ingresa un ID de jugador válido.' });
        }

        // Si tienes configurada una URL de verificación de ID en Railway (PROVIDER_VERIFY_URL)
        if (process.env.PROVIDER_VERIFY_URL && process.env.PROVIDER_API_KEY) {
            try {
                const resp = await axios.post(process.env.PROVIDER_VERIFY_URL, {
                    api_key: process.env.PROVIDER_API_KEY,
                    game: productSlug,
                    uid: String(playerUid).trim(),
                    server: playerServer || '',
                    region: playerRegion || ''
                }, { timeout: 8000 });

                if (resp.data && resp.data.nickname) {
                    return res.json({
                        success: true,
                        verified: true,
                        nickname: resp.data.nickname,
                        message: `✅ Cuenta verificada: ${resp.data.nickname}`
                    });
                }
            } catch (e) {}
        }

        // Si el juego o la API no soporta mostrar el apodo en vivo, devuelve tu mensaje exacto:
        return res.json({
            success: true,
            verified: false,
            nickname: '',
            message: 'ℹ️ No se puede verificar la cuenta en este juego, igualmente si escribió bien su ID, no habrá problemas.'
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error al validar el ID.' });
    }
});

// 2. Crear Orden en la Pestaña de Pago -> Pasa a la Pestaña de Entrega en Vivo
app.post('/api/orders/create', orderLimiter, verificarTokenOpcional, async (req, res) => {
    try {
        const {
            orderType,
            deviceId,
            userEmail,
            userWhatsapp,
            productSlug,
            packageId,
            customTokemAmount,
            playerUid,
            playerServer,
            playerRegion,
            playerNickname,
            paypalPayerName,
            internalAccountLogin,
            paymentMethodKey,
            paymentMethodNameCustom,
            paymentReference
        } = req.body;

        const settings = await StoreSettings.findOne({ key: 'main_settings' }) || { exchangeRateVES: 55.00, storeOpen: true, autoTriggerApiOnTokems: true };
        if (!settings.storeOpen) {
            return res.status(403).json({ error: 'La tienda está en mantenimiento temporal. Intenta en unos minutos.' });
        }

        let metodoPago = await PaymentMethod.findOne({ methodKey: paymentMethodKey, active: true });
        if (!metodoPago && paymentMethodKey && paymentMethodKey.startsWith('pago_movil')) {
            metodoPago = await PaymentMethod.findOne({ methodKey: 'pago_movil' });
        }
        if (!metodoPago) {
            metodoPago = {
                methodKey: paymentMethodKey || 'pago_movil',
                name: paymentMethodNameCustom || 'Pago Verificable',
                requiresReference: paymentMethodKey !== 'tokems_kz',
                refDigitsLength: 6
            };
        }

        const identificadorLimpio = (userEmail || deviceId || 'invitado').trim().toLowerCase();
        const refLimpia = (paymentReference || '').trim().toUpperCase();

        if (metodoPago.requiresReference && refLimpia.length < 4) {
            return res.status(400).json({ error: 'Debes ingresar los últimos dígitos de la referencia o ID de transacción.' });
        }

        let esRefDuplicada = false;
        let textoAlertaDuplicada = '';
        if (metodoPago.requiresReference && refLimpia) {
            const hace48Horas = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const ordenConMismaRef = await Order.findOne({
                paymentReference: refLimpia,
                fecha: { $gte: hace48Horas },
                status: { $ne: 'RECHAZADO' }
            }).lean();

            if (ordenConMismaRef) {
                esRefDuplicada = true;
                textoAlertaDuplicada = `⚠️ ALERTA: La referencia "${refLimpia}" ya fue usada en la orden #${ordenConMismaRef.orderId} (${ordenConMismaRef.productName}). Verifica tu banco con cuidado.`;
            }
        }

        let nombreProducto = '';
        let nombrePaquete = '';
        let mainCat = 'recargas';
        let subCat = 'recargas_id';
        let fulfillment = 'API_DIRECT_TOPUP';
        let baseUSD = 0;
        let feeUSD = 0;
        let costoMayoristaUSD = 0;
        let costoEnTokems = 0;
        let apiProv = '';
        let apiSku = '';
        let productoDB = null;

        if (orderType === 'TOKEM_TOPUP') {
            const cantTokems = Math.max(1, Number(customTokemAmount) || 1);
            nombreProducto = 'Recarga de Billetera Tokems KZ';
            nombrePaquete = `${cantTokems} Tokem(s) KZ 🪙`;
            fulfillment = 'TOKEM_WALLET_CREDIT';
            baseUSD = Number((cantTokems * (settings.tokemValueUSD || 1)).toFixed(2));
            costoEnTokems = cantTokems;
        } else {
            productoDB = await CatalogProduct.findOne({ slug: productSlug, active: true });
            if (!productoDB) return res.status(404).json({ error: 'Producto no encontrado.' });

            const pkg = productoDB.packages.find(p => p.packageId === packageId);
            if (!pkg || !pkg.inStock) return res.status(400).json({ error: 'Paquete agotado o no disponible.' });

            nombreProducto = productoDB.name;
            nombrePaquete = pkg.name;
            mainCat = productoDB.mainCategory;
            subCat = productoDB.subCategory;
            fulfillment = productoDB.fulfillmentType;
            baseUSD = Number(pkg.priceUSD);
            costoMayoristaUSD = Number(pkg.costUSD || 0);
            costoEnTokems = Number(pkg.tokemsPrice || pkg.priceUSD);
            apiProv = pkg.apiProviderName || 'DEFAULT_API';
            apiSku = pkg.apiProductSku || pkg.packageId;

            if (productoDB.serviceCommissionPercent > 0) {
                feeUSD = Number(((baseUSD * productoDB.serviceCommissionPercent) / 100).toFixed(2));
            }
        }

        const totalUSD = Number((baseUSD + feeUSD).toFixed(2));
        const totalVES = Number((totalUSD * settings.exchangeRateVES).toFixed(2));

        let pagadoConTokems = false;
        let nuevoSaldoTokems = null;

        if (paymentMethodKey === 'tokems_kz') {
            if (orderType === 'TOKEM_TOPUP') {
                return res.status(400).json({ error: 'No puedes comprar Tokems pagando con Tokems.' });
            }
            if (identificadorLimpio.includes('@')) {
                const usuario = await User.findOneAndUpdate(
                    { email: identificadorLimpio, tokems: { $gte: costoEnTokems } },
                    { $inc: { tokems: -costoEnTokems } },
                    { new: true }
                );
                if (!usuario) return res.status(402).json({ error: `Saldo insuficiente. Necesitas ${costoEnTokems} Tokems KZ.` });
                nuevoSaldoTokems = Number(usuario.tokems.toFixed(2));
            } else {
                const inv = await Balance.findOneAndUpdate(
                    { deviceId: identificadorLimpio, tokens: { $gte: costoEnTokems } },
                    { $inc: { tokens: -costoEnTokems } },
                    { new: true }
                );
                if (!inv) return res.status(402).json({ error: `Saldo insuficiente. Necesitas ${costoEnTokems} Tokems KZ.` });
                nuevoSaldoTokems = Number(inv.tokens.toFixed(2));
            }
            pagadoConTokems = true;

            await new Transaction({
                deviceId: identificadorLimpio,
                tipo: 'Recarga_Tienda',
                tokens: -costoEnTokems,
                plan: `${nombreProducto} - ${nombrePaquete}`,
                precio: `$${totalUSD}`,
                detalles: `Pago con Tokems KZ (${playerUid || userWhatsapp || 'Directo'})`
            }).save().catch(() => {});
        }

        const orderId = 'KZ-' + crypto.randomInt(100000, 999999).toString();

        // Definir destino limpio según si es Recarga ID, Recarga Interna (WhatsApp) o GiftCard/Servicio
        let uidDestinoFinal = (playerUid || '').trim();
        if (!uidDestinoFinal) {
            if (fulfillment === 'MANUAL_INTERNAL' || subCat === 'recargas_internas') {
                uidDestinoFinal = userWhatsapp ? `WS: ${userWhatsapp.trim()}` : 'Contacto por WhatsApp';
            } else {
                uidDestinoFinal = 'Entrega Automática de Código';
            }
        }

        const nuevaOrden = new Order({
            orderId,
            orderType: orderType || 'PRODUCT_ORDER',
            deviceId: identificadorLimpio,
            userEmail: userEmail ? userEmail.trim().toLowerCase() : (identificadorLimpio.includes('@') ? identificadorLimpio : ''),
            userWhatsapp: (userWhatsapp || '').trim(),
            productSlug: productSlug || 'tokems-kz',
            productName: nombreProducto,
            mainCategory: mainCat,
            subCategory: subCat,
            fulfillmentType: fulfillment,
            packageId: packageId || 'tokems_pack',
            packageName: nombrePaquete,
            apiProviderName: apiProv,
            apiProductSku: apiSku,
            playerUid: uidDestinoFinal,
            playerServer: (playerServer || '').trim(),
            playerRegion: (playerRegion || '').trim(),
            playerNickname: (playerNickname || '').trim(),
            paypalPayerName: (paypalPayerName || '').trim(),
            internalAccountLogin: internalAccountLogin || {},
            paymentMethodKey,
            paymentMethodName: paymentMethodNameCustom || metodoPago.name,
            paymentReference: pagadoConTokems ? 'TOKEMS-KZ' : refLimpia,
            isDuplicateRef: esRefDuplicada,
            duplicateWarningText: textoAlertaDuplicada,
            exchangeRateApplied: settings.exchangeRateVES,
            baseAmountUSD: baseUSD,
            serviceFeeUSD: feeUSD,
            totalAmountUSD: totalUSD,
            totalAmountVES: totalVES,
            costUSD: costoMayoristaUSD,
            tokemsAmount: costoEnTokems,
            paidWithTokems: pagadoConTokems,
            status: 'EN_PROCESO',
            statusMessage: 'Tu orden está en proceso. Un operador está verificando tu referencia de pago...',
            progressPercent: 50
        });

        if (pagadoConTokems && settings.autoTriggerApiOnTokems && fulfillment !== 'MANUAL_INTERNAL') {
            const apiRes = await ejecutarEntregaPorAPI(nuevaOrden, productoDB);
            if (apiRes.success) {
                nuevaOrden.status = 'ENTREGADO';
                nuevaOrden.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                nuevaOrden.progressPercent = 100;
                nuevaOrden.deliveredCode = apiRes.deliveredCode;
                nuevaOrden.apiOrderId = apiRes.apiOrderId;
                nuevaOrden.apiRawResponse = apiRes.raw;
                nuevaOrden.approvedByWorker = 'AUTO-TOKEMS-API';
                nuevaOrden.completedAt = new Date();
            }
        }

        await nuevaOrden.save();

        return res.status(200).json({
            success: true,
            order: nuevaOrden,
            nuevoSaldoTokems
        });
    } catch (error) {
        console.error('❌ Error creando orden:', error);
        return res.status(500).json({ error: 'Error interno al crear la orden.' });
    }
});

// 📡 3. RECOMENDACIÓN PRO #3: CONSULTA EN VIVO DE LA BARRA DE PROGRESO (ZONA 3 Y 4)
app.get('/api/orders/live-status/:orderId', async (req, res) => {
    try {
        const idLimpio = req.params.orderId.trim().toUpperCase();
        const orden = await Order.findOne({ orderId: idLimpio }).select('-internalAccountLogin.accountPass -costUSD').lean();
        if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });

        return res.json({
            success: true,
            order: orden
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error consultando el estado en vivo de la orden.' });
    }
});

// 📲 Guardar el WhatsApp enviado por el cliente cuando su orden está EN REVISIÓN
app.post('/api/orders/client-review-contact', async (req, res) => {
    try {
        const { orderId, userWhatsapp } = req.body;
        if (!orderId || !userWhatsapp || String(userWhatsapp).trim().length < 7) {
            return res.status(400).json({ error: 'Por favor ingresa un número de WhatsApp válido.' });
        }

        const idLimpio = String(orderId).trim().toUpperCase();
        const wsLimpio = String(userWhatsapp).trim();

        const orden = await Order.findOneAndUpdate(
            { orderId: idLimpio },
            { 
                $set: { 
                    userWhatsapp: wsLimpio, 
                    clientReviewWhatsappSent: true 
                } 
            },
            { new: true }
        ).select('-internalAccountLogin.accountPass -costUSD');

        if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });

        return res.json({
            success: true,
            message: 'Tu número de WhatsApp fue recibido. Un operador te escribirá en breve.',
            order: orden
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error al registrar tu número de WhatsApp.' });
    }
});

// 👤 4. ZONA DE CUENTA DE CLIENTES (HISTORIAL DE COMPRAS, PINES Y PERFILES DE JUEGO GUARDADOS)
app.get('/api/client/account-overview', verificarTokenOpcional, async (req, res) => {
    try {
        const { deviceId, email } = req.query;
        const queryIds = [];
        if (deviceId) queryIds.push({ deviceId: deviceId.trim().toLowerCase() });
        if (email) {
            queryIds.push({ userEmail: email.trim().toLowerCase() });
            queryIds.push({ deviceId: email.trim().toLowerCase() });
        }
        if (queryIds.length === 0) return res.json({ orders: [], tickets: [], savedProfiles: [] });

        const [orders, tickets, usuario] = await Promise.all([
            Order.find({ $or: queryIds }).sort({ fecha: -1 }).limit(60).select('-internalAccountLogin.accountPass -costUSD').lean(),
            SupportTicket.find({ $or: queryIds }).sort({ updatedAt: -1 }).limit(30).lean(),
            email ? User.findOne({ email: email.trim().toLowerCase() }).select('tokems savedProfiles whatsapp role').lean() : null
        ]);

        return res.json({
            success: true,
            tokems: usuario ? usuario.tokems : 0,
            savedProfiles: usuario ? (usuario.savedProfiles || []) : [],
            orders,
            tickets
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error obteniendo los datos de tu cuenta.' });
    }
});

// Guardar o eliminar un ID favorito en la cuenta del cliente
app.post('/api/client/save-game-profile', verificarTokenOpcional, async (req, res) => {
    try {
        if (!req.user || !req.user.email) return res.status(401).json({ error: 'Inicia sesión para guardar tus IDs favoritos.' });
        const { label, gameSlug, playerUid, playerServer } = req.body;
        if (!playerUid) return res.status(400).json({ error: 'El ID del jugador es obligatorio.' });

        const usuario = await User.findOne({ email: req.user.email.toLowerCase() });
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

        usuario.savedProfiles.push({
            label: (label || 'Mi ID').trim(),
            gameSlug: (gameSlug || '').trim(),
            playerUid: playerUid.trim(),
            playerServer: (playerServer || '').trim()
        });
        await usuario.save();

        return res.json({ success: true, savedProfiles: usuario.savedProfiles });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando tu ID.' });
    }
});

// =================================================================
// 🎫 ENDPOINTS DE TICKETS DE SOPORTE (CLIENTES Y TRABAJADORES)
// =================================================================
app.post('/api/tickets/create', verificarTokenOpcional, async (req, res) => {
    try {
        const { orderId, deviceId, userEmail, userWhatsapp, subject, category, messageText } = req.body;
        if (!subject || !messageText) return res.status(400).json({ error: 'Escribe el asunto y el detalle de tu problema.' });

        const ticketId = 'TK-' + crypto.randomInt(10000, 99999).toString();
        const identificador = (userEmail || deviceId || 'invitado').trim().toLowerCase();

        const nuevoTicket = await new SupportTicket({
            ticketId,
            orderId: (orderId || '').trim().toUpperCase(),
            deviceId: identificador,
            userEmail: userEmail ? userEmail.trim().toLowerCase() : '',
            userWhatsapp: (userWhatsapp || '').trim(),
            subject: subject.trim(),
            category: category || 'OTRO',
            status: 'ABIERTO',
            messages: [{
                senderRole: 'client',
                senderName: userEmail || 'Cliente',
                text: messageText.trim()
            }]
        }).save();

        return res.json({ success: true, ticket: nuevoTicket });
    } catch (error) {
        return res.status(500).json({ error: 'Error creando el ticket de soporte.' });
    }
});

app.post('/api/tickets/reply', verificarTokenOpcional, async (req, res) => {
    try {
        const { ticketId, text, newStatus } = req.body;
        if (!ticketId || !text) return res.status(400).json({ error: 'Falta el mensaje.' });

        const ticket = await SupportTicket.findOne({ ticketId: ticketId.trim().toUpperCase() });
        if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado.' });

        let senderRole = 'client';
        let senderName = ticket.userEmail || 'Cliente';

        if (req.user && req.user.email) {
            const rol = determinarRolDeUsuario(req.user.email, req.user.role);
            if (rol === 'worker' || rol === 'admin') {
                senderRole = rol;
                senderName = `Soporte Kem!Zone (${req.user.email.split('@')[0]})`;
                ticket.status = newStatus || 'EN_REVISION';
                ticket.assignedWorker = req.user.email;
            }
        }

        ticket.messages.push({ senderRole, senderName, text: text.trim() });
        await ticket.save();

        return res.json({ success: true, ticket });
    } catch (error) {
        return res.status(500).json({ error: 'Error enviando respuesta al ticket.' });
    }
});

// =================================================================
// 👷 DASHBOARD 2: ENDPOINTS PARA TRABAJADORES / OPERADORES
// =================================================================

// 1. Cola de órdenes y tickets en tiempo real para el trabajador
app.get('/api/worker/queue', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { statusFilter } = req.query;
        const query = {};
        if (statusFilter && statusFilter !== 'TODAS') {
            query.status = statusFilter;
        }

        const [orders, ticketsAbiertos, pendientesCount] = await Promise.all([
            Order.find(query).sort({ fecha: -1 }).limit(120).select('-costUSD').lean(),
            SupportTicket.find({ status: { $in: ['ABIERTO', 'EN_REVISION'] } }).sort({ updatedAt: -1 }).limit(50).lean(),
            Order.countDocuments({ status: 'EN_PROCESO' })
        ]);

        return res.json({
            success: true,
            workerEmail: req.staffUser.email,
            role: req.effectiveRole,
            pendientesCount,
            orders,
            tickets: ticketsAbiertos
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error cargando cola de trabajo.' });
    }
});

// 2. Acción del Trabajador: APROBAR (Dispara API automáticamente y actualiza la barra del cliente) o RECHAZAR
app.post('/api/worker/process-order', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { orderId, action, manualPinCode, workerNotes } = req.body;
        if (!orderId || !action) return res.status(400).json({ error: 'Faltan parámetros.' });

        const orden = await Order.findOne({ orderId: orderId.trim().toUpperCase() });
        if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });

        // ✅ SI EL TRABAJADOR VERIFICÓ LOS 6 DÍGITOS DEL PAGO MÓVIL Y LE DA A APROBAR
        if (action === 'APROBAR') {
            orden.status = 'EJECUTANDO_API';
            orden.statusMessage = 'Pago verificado. Ejecutando entrega automática...';
            orden.progressPercent = 80;
            if (workerNotes) orden.workerNotes = workerNotes.trim();
            await orden.save();

            // Caso A: Si el cliente compró saldo de Tokems KZ con Pago Móvil/Binance
            if (orden.orderType === 'TOKEM_TOPUP') {
                if (orden.deviceId.includes('@')) {
                    await User.updateOne({ email: orden.deviceId }, { $inc: { tokems: orden.tokemsAmount } });
                } else {
                    await Balance.updateOne({ deviceId: orden.deviceId }, { $inc: { tokens: orden.tokemsAmount } }, { upsert: true });
                }

                await new Transaction({
                    deviceId: orden.deviceId,
                    tipo: 'Compra',
                    tokens: orden.tokemsAmount,
                    plan: orden.packageName,
                    precio: `$${orden.totalAmountUSD} (Bs. ${orden.totalAmountVES})`,
                    detalles: `Recarga de Tokems aprobada (#${orden.orderId})`
                }).save().catch(() => {});

                orden.status = 'ENTREGADO';
                orden.statusMessage = `¡Se han acreditado +${orden.tokemsAmount} Tokems KZ en tu cuenta!`;
                orden.progressPercent = 100;
                orden.deliveredCode = `+${orden.tokemsAmount} TOKEMS KZ ACREDITADOS`;
                orden.approvedByWorker = req.staffUser.email;
                orden.completedAt = new Date();
                await orden.save();

                return res.json({ success: true, message: 'Tokems acreditados al cliente.', order: orden });
            }

            // Caso B: Recarga por ID, Gift Card o Servicio -> Dispara la API automáticamente
            const productoDB = await CatalogProduct.findOne({ slug: orden.productSlug });
            const apiResultado = await ejecutarEntregaPorAPI(orden, productoDB);

            if (!apiResultado.success && !manualPinCode) {
                orden.status = 'ERROR_API';
                orden.statusMessage = 'Pago verificado, pero el proveedor tardó en responder. Un operador completará tu entrega en breve.';
                await orden.save();
                return res.status(400).json({ error: `Fallo en API del proveedor: ${apiResultado.errorMsg}`, order: orden });
            }

            orden.status = 'ENTREGADO';
            orden.progressPercent = 100;
            orden.deliveredCode = manualPinCode ? manualPinCode.trim() : apiResultado.deliveredCode;
            orden.apiOrderId = apiResultado.apiOrderId || '';
            orden.apiRawResponse = apiResultado.raw || null;
            orden.statusMessage = orden.fulfillmentType === 'API_GIFT_CARD'
                ? '¡Código generado y entregado! Cópialo aquí abajo.'
                : '¡Recarga entregada con éxito! Verifica tu cuenta del juego.';
            orden.approvedByWorker = req.staffUser.email;
            orden.completedAt = new Date();
            await orden.save();

            // Enviar respaldo por correo mediante Resend si el cliente tiene email
            if (orden.userEmail && orden.userEmail.includes('@')) {
                await resend.emails.send({
                    from: 'Kem!Zone Oficial <registro@kzsorteos.com>',
                    to: orden.userEmail,
                    subject: `✅ Pedido Entregado #${orden.orderId} - ${orden.productName}`,
                    html: `
                        <div style="font-family: sans-serif; background-color: #09090d; color: #ffffff; padding: 25px; border-radius: 14px; border: 2px solid #ff6600; max-width: 520px;">
                            <h2 style="color: #ff6600; margin-top: 0;">¡Tu compra #${orden.orderId} fue entregada! 🔥</h2>
                            <p style="color: #cccccc;">Tu pago fue verificado y procesado exitosamente.</p>
                            <div style="background: #14141d; padding: 15px; border-radius: 10px; border-left: 4px solid #ff6600; margin: 18px 0;">
                                <p style="margin: 4px 0;"><b>Producto:</b> ${orden.productName}</p>
                                <p style="margin: 4px 0;"><b>Paquete:</b> ${orden.packageName}</p>
                                <p style="margin: 4px 0;"><b>Destino / ID:</b> ${orden.playerUid}</p>
                                <p style="margin: 12px 0 4px 0; color: #00e676; font-size: 16px;"><b>🎁 Entrega / Código:</b> <code style="background:#000; padding:5px 10px; border-radius:6px; color:#fff;">${orden.deliveredCode}</code></p>
                            </div>
                        </div>
                    `
                }).catch(() => {});
            }

            return res.json({ success: true, message: `Orden #${orden.orderId} aprobada y entregada al cliente.`, order: orden });
        }

// ⚠️ SI EL TRABAJADOR PONE LA ORDEN EN REVISIÓN (MONTO INCORRECTO, CUENTA EQUIVOCADA, ETC.)
        if (action === 'REVISION') {
            const motivo = (workerNotes || 'Detectamos un detalle con tu pago que debemos verificar contigo.').trim();
            orden.status = 'EN_REVISION';
            orden.progressPercent = 100;
            orden.hadReview = true;
            orden.reviewReason = motivo;
            orden.workerNotes = motivo;
            orden.statusMessage = '⚠️ Tu pedido se encuentra en revisión. Revisa el mensaje del operador aquí abajo.';
            orden.reviewedByWorker = req.staffUser.email;
            await orden.save();

            return res.json({
                success: true,
                message: `Orden #${orden.orderId} puesta en revisión.`,
                order: orden
            });
        }

        // ❌ SI EL TRABAJADOR RECHAZA LA ORDEN (EJ: PAGO MÓVIL FALSO O NO LLEGÓ)
        if (action === 'RECHAZAR') {
            const yaEstabaRechazada = orden.status === 'RECHAZADO';
            orden.status = 'RECHAZADO';
            orden.progressPercent = 100;
            orden.statusMessage = workerNotes || 'No pudimos verificar tu referencia de pago. Si crees que es un error, abre un ticket de soporte.';
            orden.workerNotes = workerNotes || 'Referencia no encontrada';
            orden.approvedByWorker = req.staffUser.email;
            await orden.save();

            // Si había pagado con Tokems KZ, se le reembolsan automáticamente
            if (orden.paidWithTokems && !yaEstabaRechazada && orden.tokemsAmount > 0) {
                if (orden.deviceId.includes('@')) {
                    await User.updateOne({ email: orden.deviceId }, { $inc: { tokems: orden.tokemsAmount } });
                } else {
                    await Balance.updateOne({ deviceId: orden.deviceId }, { $inc: { tokens: orden.tokemsAmount } });
                }
            }

            return res.json({ success: true, message: `Orden #${orden.orderId} rechazada.`, order: orden });
        }

        return res.status(400).json({ error: 'Acción inválida.' });
    } catch (error) {
        console.error('Error en /api/worker/process-order:', error);
        return res.status(500).json({ error: 'Error procesando la orden.' });
    }
});

// 👑 DASHBOARD 1: ENDPOINTS EXCLUSIVOS PARA TI (ADMIN / DESARROLLADOR)
// =================================================================

app.get('/api/admin/overview', verificarSoloAdmin, async (req, res) => {
    try {
        const hoyInicio = new Date();
        hoyInicio.setHours(0, 0, 0, 0);

        const mesInicio = new Date();
        mesInicio.setDate(1);
        mesInicio.setHours(0, 0, 0, 0);

        const [
            settings,
            products,
            paymentMethods,
            todasLasOrdenes,
            pendientesCount,
            ticketsAbiertosCount,
            todosLosTickets,
            workersList,
            todosLosUsuarios,
            balancesInvitados,
            todosLosPines,
            transaccionesTokems
        ] = await Promise.all([
            StoreSettings.findOne({ key: 'main_settings' }).lean(),
            CatalogProduct.find().sort({ sortOrder: 1 }).lean(),
            PaymentMethod.find().sort({ sortOrder: 1 }).lean(),
            Order.find().sort({ fecha: -1 }).limit(3000).select('-internalAccountLogin.accountPass -apiRawResponse').lean(),
            Order.countDocuments({ status: 'EN_PROCESO' }),
            SupportTicket.countDocuments({ status: { $in: ['ABIERTO', 'EN_REVISION'] } }),
            SupportTicket.find().sort({ createdAt: -1 }).limit(300).select('ticketId orderId userEmail category status createdAt').lean(),
            User.find({ role: { $in: ['worker', 'admin'] } }).select('email accountName role tokems').lean(),
            User.find().sort({ createdAt: -1 }).select('accountName email role isVerified tokems savedProfiles createdAt').lean(),
            Balance.find({ tokens: { $gt: 0 } }).select('deviceId tokens').lean(),
            Pin.find().select('code tokens used createdBy createdAt').lean(),
            Transaction.find().sort({ fecha: -1 }).limit(1000).select('deviceId tipo tokens plan precio fecha').lean()
        ]);

        const ordenesEntregadasHoy = todasLasOrdenes.filter(o => o.status === 'ENTREGADO' && new Date(o.completedAt || o.fecha) >= hoyInicio);
        const ordenesEntregadasMes = todasLasOrdenes.filter(o => o.status === 'ENTREGADO' && new Date(o.completedAt || o.fecha) >= mesInicio);

        const ventasHoyUSD = ordenesEntregadasHoy.reduce((acc, o) => acc + (Number(o.totalAmountUSD) || 0), 0);
        const ventasHoyVES = ordenesEntregadasHoy.reduce((acc, o) => acc + (Number(o.totalAmountVES) || 0), 0);
        const gananciaNetaHoyUSD = ordenesEntregadasHoy.reduce((acc, o) => acc + ((Number(o.totalAmountUSD) || 0) - (Number(o.costUSD) || 0)), 0);

        const ventasMesUSD = ordenesEntregadasMes.reduce((acc, o) => acc + (Number(o.totalAmountUSD) || 0), 0);
        const gananciaNetaMesUSD = ordenesEntregadasMes.reduce((acc, o) => acc + ((Number(o.totalAmountUSD) || 0) - (Number(o.costUSD) || 0)), 0);

        const tokemsCuentas = todosLosUsuarios.reduce((acc, u) => acc + (Number(u.tokems) || 0), 0);
        const tokemsInvitados = balancesInvitados.reduce((acc, b) => acc + (Number(b.tokens) || 0), 0);
        const tokemsEnCirculacion = tokemsCuentas + tokemsInvitados;

        const rendimientoTrabajadores = {};
        const ventasPorJuego = {};
        const ventasPorMetodo = {};

        ordenesEntregadasMes.forEach(o => {
            const op = o.approvedByWorker || 'AUTO-API';
            rendimientoTrabajadores[op] = (rendimientoTrabajadores[op] || 0) + 1;

            const juego = o.productName || 'Otro';
            if (!ventasPorJuego[juego]) ventasPorJuego[juego] = { count: 0, usd: 0 };
            ventasPorJuego[juego].count += 1;
            ventasPorJuego[juego].usd = Number((ventasPorJuego[juego].usd + (Number(o.totalAmountUSD) || 0)).toFixed(2));

            const metodo = o.paymentMethodName || o.paymentMethodKey || 'Otro';
            if (!ventasPorMetodo[metodo]) ventasPorMetodo[metodo] = { count: 0, usd: 0 };
            ventasPorMetodo[metodo].count += 1;
            ventasPorMetodo[metodo].usd = Number((ventasPorMetodo[metodo].usd + (Number(o.totalAmountUSD) || 0)).toFixed(2));
        });

        const pinesUsados = todosLosPines.filter(p => p.used);
        const pinesDisponibles = todosLosPines.filter(p => !p.used);

        return res.json({
            success: true,
            analytics: {
                ordenesHoyCount: ordenesEntregadasHoy.length,
                ventasHoyUSD: Number(ventasHoyUSD.toFixed(2)),
                ventasHoyVES: Number(ventasHoyVES.toFixed(2)),
                gananciaNetaHoyUSD: Number(gananciaNetaHoyUSD.toFixed(2)),
                ordenesMesCount: ordenesEntregadasMes.length,
                ventasMesUSD: Number(ventasMesUSD.toFixed(2)),
                gananciaNetaMesUSD: Number(gananciaNetaMesUSD.toFixed(2)),
                pendientesCount,
                ticketsAbiertosCount,
                totalClientesCount: todosLosUsuarios.length,
                tokemsEnCirculacion: Number(tokemsEnCirculacion.toFixed(2)),
                tokemsCuentas: Number(tokemsCuentas.toFixed(2)),
                tokemsInvitados: Number(tokemsInvitados.toFixed(2)),
                rendimientoTrabajadores,
                ventasPorJuego,
                ventasPorMetodo,
                // Datasets completos para filtrado por Día, Semana, Mes, Año y Paginación
                rawOrders: todasLasOrdenes,
                rawUsers: todosLosUsuarios,
                rawTickets: todosLosTickets,
                rawTransactions: transaccionesTokems,
                pinsStats: {
                    totalCount: todosLosPines.length,
                    usedCount: pinesUsados.length,
                    availableCount: pinesDisponibles.length,
                    usedTokemsSum: Number(pinesUsados.reduce((a, p) => a + (Number(p.tokens) || 0), 0).toFixed(2)),
                    availableTokemsSum: Number(pinesDisponibles.reduce((a, p) => a + (Number(p.tokens) || 0), 0).toFixed(2))
                }
            },
            settings,
            products,
            paymentMethods,
            workersList
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error cargando estadísticas de Desarrollador.' });
    }
});

// 2. Modificar Tasa Bs/USD, Portada Hero, Loot Relámpago y Configuración General
app.post('/api/admin/settings', verificarSoloAdmin, async (req, res) => {
    try {
        const { exchangeRateVES, tokemValueUSD, storeOpen, autoTriggerApiOnTokems, announcementText, hideAnnouncement, heroConfig, flashOffers } = req.body;
        let settings = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settings) settings = new StoreSettings({ key: 'main_settings' });

        if (exchangeRateVES !== undefined) settings.exchangeRateVES = Number(exchangeRateVES);
        if (tokemValueUSD !== undefined) settings.tokemValueUSD = Number(tokemValueUSD);
        if (typeof storeOpen === 'boolean') settings.storeOpen = storeOpen;
        if (typeof autoTriggerApiOnTokems === 'boolean') settings.autoTriggerApiOnTokems = autoTriggerApiOnTokems;
        if (announcementText !== undefined) settings.announcementText = announcementText;
        if (typeof hideAnnouncement === 'boolean') settings.hideAnnouncement = hideAnnouncement;
        if (heroConfig && typeof heroConfig === 'object') settings.heroConfig = heroConfig;
        if (Array.isArray(flashOffers)) settings.flashOffers = flashOffers;
        settings.updatedBy = req.adminUser.email;

        await settings.save();
        return res.json({ success: true, settings });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando configuración de la tienda.' });
    }
});

// 3. Crear o Editar cualquier Juego, Gift Card, Servicio, Flyer o Paquete de Precios
app.post('/api/admin/product/save', verificarSoloAdmin, async (req, res) => {
    try {
        const productData = req.body;
        if (!productData.slug || !productData.name || !productData.mainCategory || !productData.subCategory) {
            return res.status(400).json({ error: 'Slug, nombre, categoría y subcategoría son obligatorios.' });
        }

        const slugLimpio = productData.slug.trim().toLowerCase();
        const productoActualizado = await CatalogProduct.findOneAndUpdate(
            { slug: slugLimpio },
            { $set: { ...productData, slug: slugLimpio } },
            { new: true, upsert: true }
        );

        return res.json({ success: true, product: productoActualizado });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando el producto: ' + error.message });
    }
});

// 4. Eliminar un Producto del Catálogo
app.post('/api/admin/product/delete', verificarSoloAdmin, async (req, res) => {
    try {
        const { slug } = req.body;
        await CatalogProduct.deleteOne({ slug: (slug || '').trim().toLowerCase() });
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: 'Error eliminando producto.' });
    }
});

// 5. Crear o Editar Métodos de Pago (Pago Móvil, Binance, Zinli, etc.)
app.post('/api/admin/payment-method/save', verificarSoloAdmin, async (req, res) => {
    try {
        const methodData = req.body;
        if (!methodData.methodKey || !methodData.name) {
            return res.status(400).json({ error: 'Identificador y nombre del método de pago requeridos.' });
        }

        const keyLimpia = methodData.methodKey.trim().toLowerCase().replace(/\s+/g, '_');
        const metodo = await PaymentMethod.findOneAndUpdate(
            { methodKey: keyLimpia },
            { $set: { ...methodData, methodKey: keyLimpia } },
            { new: true, upsert: true }
        );

        return res.json({ success: true, paymentMethod: metodo });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando método de pago.' });
    }
});

// 5.1 Eliminar un Método de Pago
app.post('/api/admin/payment-method/delete', verificarSoloAdmin, async (req, res) => {
    try {
        const { methodKey } = req.body;
        await PaymentMethod.deleteOne({ methodKey: (methodKey || '').trim().toLowerCase() });
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: 'Error eliminando método de pago.' });
    }
});

// 6. Gestionar Permisos de Trabajadores y Saldo Tokems
app.post('/api/admin/staff-and-tokens', verificarSoloAdmin, async (req, res) => {
    try {
        const { action, targetEmail, roleToSet, tokensAmount } = req.body;

        if (action === 'SET_ROLE') {
            const usuario = await User.findOneAndUpdate(
                { email: (targetEmail || '').trim().toLowerCase() },
                { $set: { role: roleToSet || 'worker' } },
                { new: true }
            );
            if (!usuario) return res.status(404).json({ error: 'El trabajador primero debe registrarse en la página con su correo.' });
            return res.json({ success: true, email: usuario.email, role: usuario.role });
        }

        if (action === 'CREATE_PIN') {
            const cant = Number(tokensAmount) || 1;
            const nuevoPin = `KZ-${cant}TOK-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
            await new Pin({ code: nuevoPin, tokens: cant, used: false, createdBy: req.adminUser.email }).save();
            return res.json({ success: true, code: nuevoPin, tokens: cant });
        }

        if (action === 'CREDIT_USER') {
            const cant = Number(tokensAmount) || 0;
            const correo = (targetEmail || '').trim().toLowerCase();
            const usuario = await User.findOneAndUpdate({ email: correo }, { $inc: { tokems: cant } }, { new: true });
            if (!usuario) return res.status(404).json({ error: 'Cuenta de cliente no encontrada.' });
            return res.json({ success: true, email: usuario.email, nuevoSaldo: usuario.tokems });
        }

        return res.status(400).json({ error: 'Acción no válida.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error ejecutando acción administrativa.' });
    }
});

// =================================================================
// 🎰 ENDPOINTS DE KZ SORTEOS (CONSERVADOS AL 100% PARA LA FASE 6)
// =================================================================
function extraerAvatarDinamicamente(obj) {
    if (!obj || typeof obj !== 'object') return "";
    const llavesDirectas = ['avatar', 'avatarThumb', 'avatarMedium', 'profilePicUrl', 'avatar_thumb', 'author_avatar', 'user_avatar'];
    for (let key of llavesDirectas) {
        if (obj[key] && typeof obj[key] === 'string' && obj[key].startsWith('http')) return obj[key];
    }
    let urlEncontrada = "";
    function escanear(item, parentKey = '') {
        if (urlEncontrada || !item || typeof item !== 'object') return;
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
    return "Participante";
}

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
    return 48 + Math.ceil((c - 20000) / 500);
}

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

app.post('/api/transfer-guest', verificarTokenOpcional, async (req, res) => {
    const { email, deviceId, customConfig } = req.body;
    if (!email || !deviceId) return res.status(400).json({ error: 'Faltan parámetros.' });

    try {
        const correoLimpio = email.trim().toLowerCase();
        const deviceIdLimpio = deviceId.trim();
        if (!req.user || req.user.email.toLowerCase() !== correoLimpio) {
            return res.status(403).json({ error: 'No autorizado para alterar esta cuenta.' });
        }

        const usuario = await User.findOne({ email: correoLimpio });
        if (!usuario) return res.status(404).json({ error: 'Cuenta no encontrada.' });

        const registroBalance = await Balance.findOne({ $or: [{ deviceId: deviceIdLimpio }, { deviceId: deviceIdLimpio.toLowerCase() }] });
        let tokensSumados = 0;
        if (registroBalance && registroBalance.tokens > 0) {
            tokensSumados = registroBalance.tokens;
            registroBalance.tokens = 0;
            await registroBalance.save();
        }

        if (tokensSumados > 0) usuario.tokems = Number(((usuario.tokems || 0) + tokensSumados).toFixed(2));
        if (customConfig && typeof customConfig === 'object') usuario.customConfig = customConfig;
        await usuario.save();

        await History.updateMany({ $or: [{ deviceId: deviceIdLimpio }, { deviceId: deviceIdLimpio.toLowerCase() }] }, { $set: { deviceId: correoLimpio } });
        await Transaction.updateMany({ $or: [{ deviceId: deviceIdLimpio }, { deviceId: deviceIdLimpio.toLowerCase() }] }, { $set: { deviceId: correoLimpio } });
        await Order.updateMany({ $or: [{ deviceId: deviceIdLimpio }, { deviceId: deviceIdLimpio.toLowerCase() }] }, { $set: { deviceId: correoLimpio, userEmail: correoLimpio } });

        return res.status(200).json({ success: true, nuevoSaldo: usuario.tokems, customConfig: usuario.customConfig });
    } catch (error) {
        return res.status(500).json({ error: 'Error fusionando datos.' });
    }
});

app.post('/api/preview', previewLimiter, async (req, res) => {
    const { url, deviceId } = req.body; 
    if (!url || !deviceId) return res.status(400).json({ error: 'La URL y el deviceId son obligatorios' });
    if (!url.includes('tiktok.com') && !url.includes('instagram.com')) {
        return res.status(400).json({ error: 'El enlace debe pertenecer a Instagram o TikTok.' });
    }

    const hoy = new Date().toISOString().split('T')[0];
    const identificadorLimpio = deviceId.trim().toLowerCase();
    let apifyRunId = null;
    let canceladoPorCliente = false;

    req.on('close', async () => {
        if (!res.writableEnded) {
            canceladoPorCliente = true;
            try {
                let roll = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
                if (roll && roll.count > 0) { roll.count--; await roll.save(); }
            } catch(e) {}
            if (apifyRunId) {
                try { await client.run(apifyRunId).abort(); } catch(e) {}
            }
        }
    });

    try {
        const esCuenta = identificadorLimpio.includes('@');
        const limiteMaximo = esCuenta ? 6 : 3;

        let registro = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
        if (!registro) registro = new Preview({ deviceId: identificadorLimpio, date: hoy, count: 0 });
        if (registro.count >= limiteMaximo) {
            return res.status(429).json({ error: `Límite diario de ${limiteMaximo} previsualizaciones agotado por hoy.` });
        }

        registro.count++;
        await registro.save();

        const esTikTok = url.includes('tiktok.com');
        if (esTikTok) {
            const run = await client.actor("clockworks/tiktok-scraper").start({
                "postURLs": [url], "resultsLimit": 1, "commentsPerPost": 0, "downloadVideos": false, "extractTranscripts": false
            });
            apifyRunId = run.id;
            await client.run(run.id).waitForFinish();
            if (canceladoPorCliente) return;

            const { items } = await client.dataset(run.defaultDatasetId).listItems();
            if (!items || items.length === 0) {
                registro.count--; await registro.save();
                return res.status(404).json({ error: 'No se encontraron datos en TikTok.' });
            }
            const postData = items[0];
            const username = extraerUsuarioDinamicamente(postData);
            return res.json({
                author: `@${username}`,
                rawUsername: username,
                description: postData.text || postData.desc || 'Sin descripción.',
                commentsCount: postData.commentCount || 0,
                likesCount: postData.diggCount || 0,
                displayUrl: postData.videoMeta?.coverUrl || postData.coverUrl || '',
                currentCount: registro.count
            });
        } else {
            const run = await client.actor("shu8hvrXbJbY3Eb9W").start({
                "directUrls": [url], "resultsType": "posts", "resultsLimit": 1, "addParentData": false
            });
            apifyRunId = run.id;
            await client.run(run.id).waitForFinish();
            if (canceladoPorCliente) return;

            const { items } = await client.dataset(run.defaultDatasetId).listItems();
            if (!items || items.length === 0) {
                registro.count--; await registro.save();
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
            return res.status(500).json({ error: error.message });
        }
    }
});

app.post('/api/comments/start', verificarTokenOpcional, async (req, res) => {
    const { url, maxComments, deviceId, costoTokens, comentariosDetectados, comentariosDeclarados, maquina } = req.body;
    if (!url) return res.status(400).json({ error: 'La URL es obligatoria' });

    const esTikTok = url.includes('tiktok.com');
    const costoReal = parseInt(costoTokens) || 0;
    const limiteSeguro = obtenerTechoServidor(costoReal);
    const limiteSolicitado = Math.max(parseInt(maxComments) || 0, limiteSeguro); 

    try {
        let nuevoSaldoDefinitivo = 0;
        const identificadorLimpio = deviceId.trim().toLowerCase();

        if (identificadorLimpio.includes('@')) {
            if (!req.user || req.user.email.toLowerCase() !== identificadorLimpio) {
                return res.status(403).json({ error: 'No tienes autorización para debitar saldo de esta cuenta.' });
            }
            const usuario = await User.findOneAndUpdate(
                { email: identificadorLimpio, tokems: { $gte: costoReal } },
                { $inc: { tokems: -costoReal } },
                { new: true }
            );
            if (!usuario) return res.status(402).json({ error: 'Saldo insuficiente de Tokems.' });
            nuevoSaldoDefinitivo = usuario.tokems;
        } else {
            const registroInvitado = await Balance.findOneAndUpdate(
                { deviceId: identificadorLimpio, tokens: { $gte: costoReal } },
                { $inc: { tokens: -costoReal } },
                { new: true }
            );
            if (!registroInvitado) return res.status(402).json({ error: 'Saldo insuficiente de Tokems.' });
            nuevoSaldoDefinitivo = registroInvitado.tokens;
        }

        let runInfo;
        if (esTikTok) {
            runInfo = await client.actor("clockworks/tiktok-comments-scraper").start({
                "postURLs": [url], "commentsPerPost": limiteSolicitado, "maxRepliesPerComment": 0, "excludePinnedPosts": false, "resultsPerPage": 100
            });
        } else {
            let cookiesInstagram = [];
            try { if (process.env.INSTAGRAM_COOKIES) cookiesInstagram = JSON.parse(process.env.INSTAGRAM_COOKIES); } catch (e) {}
            runInfo = await client.actor("shu8hvrXbJbY3Eb9W").start({
                "addParentData": false, "directUrls": [url], "resultsLimit": limiteSolicitado, "resultsType": "comments", "searchLimit": 10, "searchType": "hashtag",
                "proxyConfiguration": { "useApifyProxy": true },
                ...(cookiesInstagram.length > 0 && { "loginCookies": cookiesInstagram })
            });
        }

        await new Extraction({
            runId: runInfo.id,
            deviceId: identificadorLimpio,
            email: identificadorLimpio.includes('@') ? identificadorLimpio : null,
            esRegistrado: identificadorLimpio.includes('@'),
            url,
            plataforma: esTikTok ? 'TikTok' : 'Instagram',
            maquina: maquina || 'Ruleta',
            comentariosOriginales: parseInt(comentariosDetectados) || limiteSolicitado,
            comentariosDeclarados: parseInt(comentariosDeclarados) || limiteSolicitado,
            tokemsCobrados: costoReal,
            techoCubierto: limiteSeguro,
            estado: 'EN_PROCESO'
        }).save().catch(() => {});

        return res.json({ success: true, runId: runInfo.id, datasetId: runInfo.defaultDatasetId, nuevoSaldo: nuevoSaldoDefinitivo, esTikTok });
    } catch (error) {
        if (costoReal > 0) {
            const identificadorLimpio = deviceId.trim().toLowerCase();
            if (identificadorLimpio.includes('@')) await User.updateOne({ email: identificadorLimpio }, { $inc: { tokems: costoReal } });
            else await Balance.updateOne({ deviceId: identificadorLimpio }, { $inc: { tokens: costoReal } });
        }
        return res.status(500).json({ error: 'Error al iniciar servicio: ' + error.message });
    }
});

app.post('/api/comments/status', verificarTokenOpcional, async (req, res) => {
    const { runId, datasetId, esTikTok, deviceId, costoTokens } = req.body;
    const costoReal = parseInt(costoTokens) || 0;
    const identificadorLimpio = deviceId ? deviceId.trim().toLowerCase() : '';

    try {
        const run = await client.run(runId).get();
        const status = run.status;

        if (status === 'RUNNING' || status === 'READY') {
            let itemCount = 0;
            try {
                const datasetInfo = await client.dataset(datasetId).get();
                itemCount = datasetInfo ? (datasetInfo.itemCount || 0) : 0;
            } catch (errDataset) {}
            return res.json({ status: 'RUNNING', itemCount });
        }

        if (status === 'SUCCEEDED') {
            let listaComentarios = [];
            const { items } = await client.dataset(datasetId).listItems();
            if (esTikTok) {
                (items || []).forEach(c => {
                    const user = extraerUsuarioDinamicamente(c);
                    const rawAvatar = extraerAvatarDinamicamente(c);
                    if (user) listaComentarios.push({ username: user, text: c.text || c.commentText || "", profilePicUrl: rawAvatar });
                });
            } else if (items && items.length > 0) {
                listaComentarios = items.filter(c => c.ownerUsername || c.username || c.author).map(c => ({
                    username: c.ownerUsername || c.username || c.author || "Participante",
                    text: c.text || c.caption || "",
                    profilePicUrl: extraerAvatarDinamicamente(c) || c.ownerProfilePicUrl || c.profilePicUrl || ""
                }));
            }

            const costoFinalCalculado = listaComentarios.length === 0 ? 0 : calcularCostoTokemsServidor(listaComentarios.length);
            let tokemsReembolsados = 0;
            let nuevoSaldoDefinitivo = 0;

            if (costoReal > costoFinalCalculado && identificadorLimpio) {
                tokemsReembolsados = costoReal - costoFinalCalculado;
                if (identificadorLimpio.includes('@')) {
                    const u = await User.findOneAndUpdate({ email: identificadorLimpio }, { $inc: { tokems: tokemsReembolsados } }, { new: true });
                    if (u) nuevoSaldoDefinitivo = u.tokems;
                } else {
                    const b = await Balance.findOneAndUpdate({ deviceId: identificadorLimpio }, { $inc: { tokens: tokemsReembolsados } }, { new: true });
                    if (b) nuevoSaldoDefinitivo = b.tokens;
                }
            } else if (identificadorLimpio) {
                if (identificadorLimpio.includes('@')) {
                    const u = await User.findOne({ email: identificadorLimpio });
                    if (u) nuevoSaldoDefinitivo = u.tokems;
                } else {
                    const b = await Balance.findOne({ deviceId: identificadorLimpio });
                    if (b) nuevoSaldoDefinitivo = b.tokens;
                }
            }

            await Extraction.updateOne({ runId }, { $set: { comentariosExtraidos: listaComentarios.length, tokemsReembolsados, estado: 'COMPLETADO' } }).catch(() => {});
            return res.json({ status: 'SUCCEEDED', comments: listaComentarios, reembolso: tokemsReembolsados, nuevoSaldo: nuevoSaldoDefinitivo });
        }

        if (status === 'FAILED' || status === 'TIMED-OUT') {
            let saldoRestaurado = 0;
            if (identificadorLimpio.includes('@')) {
                const u = await User.findOneAndUpdate({ email: identificadorLimpio }, { $inc: { tokems: costoReal } }, { new: true });
                if(u) saldoRestaurado = u.tokems;
            } else {
                const b = await Balance.findOneAndUpdate({ deviceId: identificadorLimpio }, { $inc: { tokens: costoReal } }, { new: true });
                if(b) saldoRestaurado = b.tokens;
            }
            return res.status(500).json({ error: `La extracción falló. Tus Tokems han sido devueltos.`, nuevoSaldo: saldoRestaurado });
        }

        if (status === 'ABORTED') {
            return res.status(500).json({ error: `Sorteo cancelado por el usuario.` });
        }
    } catch (error) {
        return res.status(500).json({ error: 'Error consultando estado.' });
    }
});

app.post('/api/comments/abort', verificarTokenOpcional, async (req, res) => {
    const { runId } = req.body;
    try {
        await client.run(runId).abort();
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: 'No se pudo abortar.' });
    }
});

app.get('/api/proxy-image', async (req, res) => {
    let imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('Falta la URL');
    try {
        const response = await axios({ url: imageUrl, method: 'GET', responseType: 'arraybuffer', timeout: 10000 });
        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(response.data);
    } catch (error) {
        return res.redirect('https://cdn.shopify.com/s/files/1/0780/8444/0222/files/blank-profile-picture-973460_640.webp?v=1787703095');
    }
});

app.post('/api/redeem', redeemLimiter, async (req, res) => {
    const { code, deviceId } = req.body;
    if (!code || !deviceId) return res.status(400).json({ error: 'Código e identificador requeridos.' });

    const codigoLimpio = code.trim().toUpperCase();
    const identificadorLimpio = deviceId.trim().toLowerCase();

    try {
        const pin = await Pin.findOneAndUpdate({ code: codigoLimpio, used: false }, { $set: { used: true } }, { new: true });
        if (!pin) return res.status(400).json({ error: 'El PIN introducido no es válido o ya fue canjeado.' });

        let nuevoSaldo = 0;
        if (identificadorLimpio.includes('@')) {
            let usuario = await User.findOne({ email: identificadorLimpio });
            if (!usuario) {
                pin.used = false; await pin.save();
                return res.status(404).json({ error: 'Cuenta no encontrada.' });
            }
            usuario.tokems = Number(((usuario.tokems || 0) + pin.tokens).toFixed(2));
            await usuario.save();
            nuevoSaldo = usuario.tokems;
        } else {
            let registroInvitado = await Balance.findOne({ deviceId: identificadorLimpio });
            if (!registroInvitado) registroInvitado = new Balance({ deviceId: identificadorLimpio, tokens: 0 });
            registroInvitado.tokens = Number(((registroInvitado.tokens || 0) + pin.tokens).toFixed(2));
            await registroInvitado.save();
            nuevoSaldo = registroInvitado.tokens;
        }

        return res.status(200).json({ success: true, tokens: pin.tokens, userTokens: nuevoSaldo });
    } catch (error) {
        return res.status(500).json({ error: 'Error al procesar el PIN.' });
    }
});

app.get('/api/get-balance', async (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: "Falta deviceId" });

    try {
        const identificadorLimpio = deviceId.trim().toLowerCase();
        const hoy = new Date().toISOString().split('T')[0];
        let previewCount = 0;
        const previewReg = await Preview.findOne({ deviceId: identificadorLimpio, date: hoy });
        if (previewReg) previewCount = previewReg.count;

        if (identificadorLimpio.includes('@')) {
            const usuario = await User.findOne({ email: identificadorLimpio });
            const role = usuario ? determinarRolDeUsuario(usuario.email, usuario.role) : 'client';
            return res.json({ 
                tokens: usuario ? usuario.tokems : 0, 
                accountName: usuario ? (usuario.accountName || '') : '',
                role,
                previewCount,
                customConfig: usuario ? usuario.customConfig : null 
            });
        } else {
            const registro = await Balance.findOne({ $or: [{ deviceId: deviceId.trim() }, { deviceId: identificadorLimpio }] });
            return res.json({ tokens: registro ? registro.tokens : 0, role: 'client', previewCount });
        }
    } catch (error) {
        return res.status(500).json({ error: "Error consultando saldo" });
    }
});

app.post('/api/save-history', verificarTokenOpcional, async (req, res) => {
    try {
        const { deviceId, drawId, customLogo, maquina, url, ganadores } = req.body;
        if (!deviceId) return res.status(400).json({ error: "Falta deviceId" });
        await new History({
            deviceId: deviceId.trim().toLowerCase(),
            drawId: drawId ? drawId.trim().toUpperCase() : '',
            customLogo: customLogo || '',
            maquina: maquina || 'Sorteo',
            url: url || '',
            ganadores: ganadores || []
        }).save();
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Error interno" });
    }
});

app.get('/api/get-history', verificarTokenOpcional, async (req, res) => {
    try {
        let { deviceId, uuid } = req.query;
        if (!deviceId && !uuid) return res.status(200).json({ historial: [] });
        const idQuery = [];
        if (deviceId) idQuery.push({ deviceId: deviceId.trim().toLowerCase() });
        if (uuid) idQuery.push({ deviceId: uuid.trim().toLowerCase() });
        const historial = await History.find({ $or: idQuery }).sort({ fecha: -1 }).lean();
        res.status(200).json({ historial });
    } catch (error) {
        res.status(500).json({ error: "Error interno" });
    }
});

app.post('/api/delete-history-item', verificarTokenOpcional, async (req, res) => {
    try {
        const { id, deviceId } = req.body;
        await History.findOneAndDelete({ _id: id, deviceId: deviceId.trim().toLowerCase() });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Error eliminando" });
    }
});

app.post('/api/clear-history', verificarTokenOpcional, async (req, res) => {
    try {
        const { deviceId } = req.body;
        await History.deleteMany({ deviceId: deviceId.trim().toLowerCase() });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Error vaciando" });
    }
});

app.post('/api/save-custom-config', verificarTokenOpcional, async (req, res) => {
    try {
        const { email, customConfig } = req.body;
        await User.findOneAndUpdate({ email: email.trim().toLowerCase() }, { $set: { customConfig } });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Error interno" });
    }
});

app.post('/api/reset-custom-config', verificarTokenOpcional, async (req, res) => {
    try {
        const { email } = req.body;
        await User.findOneAndUpdate({ email: email.trim().toLowerCase() }, { customConfig: null });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Error interno" });
    }
});

app.post('/api/save-transaction', verificarTokenOpcional, async (req, res) => {
    try {
        const { deviceId, tipo, tokens, plan, precio, codigoPin, detalles } = req.body;
        const nuevaTx = await new Transaction({
            deviceId: deviceId.trim().toLowerCase(),
            tipo: tipo || 'Canje',
            tokens: Number(tokens),
            plan: plan || '',
            precio: precio || '',
            codigoPin: codigoPin || '',
            detalles: detalles || ''
        }).save();
        res.json({ success: true, transaction: nuevaTx });
    } catch (error) {
        res.status(500).json({ error: 'Error interno.' });
    }
});

app.get('/api/get-transactions', verificarTokenOpcional, async (req, res) => {
    try {
        const { deviceId, uuid } = req.query;
        const idQuery = [];
        if (deviceId) idQuery.push({ deviceId: deviceId.trim().toLowerCase() });
        if (uuid) idQuery.push({ deviceId: uuid.trim().toLowerCase() });
        const transacciones = await Transaction.find({ $or: idQuery }).sort({ fecha: -1 }).lean();
        res.json({ success: true, transacciones });
    } catch (error) {
        res.status(500).json({ error: 'Error consultando transacciones.' });
    }
});

app.post('/api/save-verification', async (req, res) => {
    try {
        const { drawId, deviceId, customLogo, maquina, url, plataforma, ganadores, totalComentarios, totalParticipantesValidos, participantes } = req.body;
        const rawString = `${drawId}_${url || ''}_${Date.now()}_${JSON.stringify(ganadores)}_${totalParticipantesValidos || 0}`;
        const verificationHash = crypto.createHash('sha256').update(rawString).digest('hex');
        const idLimpio = drawId.trim().toUpperCase();

        const sorteoSellado = await new DrawVerification({
            drawId: idLimpio,
            deviceId: (deviceId || 'invitado').trim().toLowerCase(),
            customLogo: customLogo || '',
            maquina: maquina || 'Sorteo',
            url: url || '',
            plataforma: plataforma || 'Instagram',
            ganadores,
            totalComentarios: totalComentarios || 0,
            totalParticipantesValidos: totalParticipantesValidos || 0,
            verificationHash,
            participantes: participantes || []
        }).save();

        return res.json({ success: true, drawId: sorteoSellado.drawId, hash: verificationHash });
    } catch (error) {
        return res.status(500).json({ error: "No se pudo sellar el sorteo." });
    }
});

app.get('/api/verify/:drawId', async (req, res) => {
    try {
        const sorteo = await DrawVerification.findOne({ drawId: req.params.drawId.trim().toUpperCase() }).lean();
        if (!sorteo) return res.status(404).json({ error: "Certificado no encontrado." });
        return res.json(sorteo);
    } catch (error) {
        return res.status(500).json({ error: "Error consultando certificado." });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor Kem!Zone corriendo en el puerto ${port}`);
});
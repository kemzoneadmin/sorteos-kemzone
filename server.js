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
    exchangeRateVES: { type: Number, default: 1012.00 }, // 🔒 Tasa KZ Interna (Multiplica precio USD base a Bs)
    bcvRateVES: { type: Number, default: 889.25 },       // 🏛️ Tasa BCV Pública (Visible al público y divide Bs a USD BCV)
    tokemValueUSD: { type: Number, default: 1.00 },      // 1 Tokem = $1.00 USD base KZ
    storeOpen: { type: Boolean, default: true },
    autoTriggerApiOnTokems: { type: Boolean, default: true },
    announcementText: { type: String, default: '🔥 KEM!ZONE OFICIAL: Recargas y Gift Cards al instante — Aceptamos Pago Móvil, Binance, Zinli y Tokems KZ' },
    hideAnnouncement: { type: Boolean, default: false },
    heroConfig: {
        tagText: { type: String, default: '🇻🇪 Tienda Oficial verificada • +11.4K en Instagram' },
        titleMain: { type: String, default: 'RECARGA TUS' },
        titleHighlight: { type: String, default: 'JUEGOS FAVORITOS' },
        titleEnd: { type: String, default: 'AL INSTANTE' },
        description: { type: String, default: 'Entrega rápida por ID de jugador y códigos digitales originales. Paga cómodamente en Bolívares (Pago Móvil), USDT (Binance), Tarjeta o usa tus Tokems KZ sin comisiones.' },
        mascotUrl: { type: String, default: 'https://cdn.shopify.com/s/files/1/0780/8444/0222/files/kem-ganador.png?v=1782718783' }
    },
    flashSectionConfig: {
        titleWhite: { type: String, default: 'Loot' },
        titleOrange: { type: String, default: 'Relámpago' },
        icon: { type: String, default: '⚡' },
        subtitle: { type: String, default: 'Ofertas especiales del día' }
    },
flashOffers: [{
        slug: { type: String, default: 'free-fire-id' },
        pkgId: { type: String, default: 'ff_semanal' },
        game: { type: String, default: 'FREE FIRE' },
        title: { type: String, default: 'Tarjeta Semanal FF' },
        oldUsd: { type: Number, default: 2.50 },
        usd: { type: Number, default: 1.95 },
        costUSD: { type: Number, default: 1.50 },
        profitUSD: { type: Number, default: 0.45 },
        tokemsPrice: { type: Number, default: 1.95 },
        discount: { type: String, default: '-22%' },
        timer: { type: String, default: 'OFERTA ACTIVA' },
        expiresAt: { type: Date, default: null },
        active: { type: Boolean, default: true },
        img: { type: String, default: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?auto=format&fit=crop&w=300&q=80' },
        pkgIconUrl: { type: String, default: '' },
        apiProductSku: { type: String, default: '' },
        centralOneProductId: { type: String, default: '' },
        isGiftCardPin: { type: Boolean, default: false },
        backupPinVault: [{ type: String }]
    }],
    catalogSectionConfig: {
        icon: { type: String, default: '🎮' },
        titleWhite: { type: String, default: 'Juegos de' },
        titleOrange: { type: String, default: 'Recarga y Gift Cards' },
        allPillLabel: { type: String, default: '🔥 Todos los Productos' },
        pills: [{
            pillId: { type: String, default: '' },
            label: { type: String, default: '' },
            productSlugs: [{ type: String }]
        }]
    },
    navigationConfig: { type: mongoose.Schema.Types.Mixed, default: null },
    flyersCanvaConfig: { type: mongoose.Schema.Types.Mixed, default: null },
    steamCalculatorConfig: { type: mongoose.Schema.Types.Mixed, default: null },
    binanceAutoConfig: { type: mongoose.Schema.Types.Mixed, default: null },

// 🧠 BÓVEDA DE TARJETAS BASE DEL PROVEEDOR PARA EL ALGORITMO DE CÓDIGOS (STEAM, PSN, NINTENDO, ETC.)
    arbitrageBaseCards: [{
        cardId: { type: String, required: true },
        platformGroup: { type: String, default: 'steam' }, // 'steam', 'playstation', 'nintendo', 'xbox', 'roblox', 'otro'
        name: { type: String, required: true },            // Ej: 'Steam Vietnam 132,500 VND'
        centralOneProductId: { type: String, default: '' },// UUID de GET /api/v1/catalog
        centralOneSku: { type: String, default: '' },      // SKU en Central One
        faceValueOrigin: { type: Number, default: 10 },    // Ej: 132500
        originCurrency: { type: String, default: 'VND' },  // Ej: 'VND', 'USD', 'BRL'
        conversionRateToUSD: { type: Number, default: 0.000039 }, // Ej: 0.000039 USD por 1 VND
        effectiveClientUSD: { type: Number, default: 5.17 }, // Lo que realmente recibe el cliente en USD ($5.17)
        costUSD: { type: Number, default: 4.20 },          // Precio revendedor Central One (4 decimales)
        minProfitUSD: { type: Number, default: 0 },        // Ganancia mínima opcional
        internalCodeStock: [{ type: String }],             // Códigos recuperados listos para reusar
        inStock: { type: Boolean, default: true },
        availableStock: { type: Number, default: null },
        active: { type: Boolean, default: true },
        lastPriceUpdateAt: { type: Date, default: null }
    }],

    // 📡 MONITOR EN VIVO CENTRAL ONE API (SALDO, CATÁLOGO EN CACHÉ Y ALERTAS DE CAMBIOS)
    centralOneSync: {
        apiConnected: { type: Boolean, default: false },
        availableBalance: { type: String, default: '0.0000' },
        heldBalance: { type: String, default: '0.0000' },
        totalBalance: { type: String, default: '0.0000' },
        currency: { type: String, default: 'USD' },
        lastSyncAt: { type: Date, default: null },
        catalogCount: { type: Number, default: 0 },
        lastError: { type: String, default: '' }
    },
    centralOneCatalogCache: [{ type: mongoose.Schema.Types.Mixed }],
    centralOneCoverageCache: { type: mongoose.Schema.Types.Mixed, default: null },
    centralOneAlerts: [{
        alertId: { type: String },
        type: { type: String }, // 'PRICE_UP', 'PRICE_DOWN', 'OUT_OF_STOCK', 'BACK_IN_STOCK', 'REMOVED_FROM_CATALOG', 'ALGO_FALLBACK', 'ALGO_NO_SOLUTION', 'BALANCE_LOW', 'ORDER_FAILED', 'DEPOSIT_APPROVED'
        severity: { type: String, default: 'INFO' }, // 'INFO', 'WARN', 'CRIT', 'OK'
        title: { type: String },
        detail: { type: String },
        sku: { type: String, default: '' },
        productId: { type: String, default: '' },
        oldPrice: { type: String, default: '' },
        newPrice: { type: String, default: '' },
        read: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    }],
    processedWebhookIds: [{ type: String }],
    updatedBy: { type: String, default: 'system' }
}, { timestamps: true });
const StoreSettings = mongoose.model('StoreSettings', StoreSettingsSchema, 'store_settings');

// 🎮 2.2 CATÁLOGO MULTINIVEL DE PRODUCTOS, JUEGOS Y SERVICIOS
const PackageSubSchema = {
    packageId: { type: String, required: true },
    name: { type: String, required: true },
    tabGroup: { type: String, default: 'principales' },
    priceUSD: { type: Number, required: true },
    costUSD: { type: Number, default: 0 },
    profitUSD: { type: Number, default: 0.50 },          // 💰 Casilla única de Ganancia Fija ($ USD)
    autoPriceByProfit: { type: Boolean, default: true }, // Si es true: Venta = Costo + Ganancia automáticamente
    tokemsPrice: { type: Number, required: true },
    apiProviderName: { type: String, default: 'CENTRAL_ONE' },
    apiProductSku: { type: String, default: '' },
    centralOneProductId: { type: String, default: '' },  // UUID de Central One GET /catalog
    targetSchemaCache: [{ type: mongoose.Schema.Types.Mixed }],
    // 🧠 Campos para paquetes con Algoritmo Inteligente de Códigos (Steam, Play, Nintendo)
    useSmartAlgorithm: { type: Boolean, default: false },
    targetClientUSD: { type: Number, default: 0 },       // Ej: 10 (Para "Tarjeta de $10 USD")
    resolvedCombo: { type: mongoose.Schema.Types.Mixed, default: null },
    imageUrl: { type: String, default: '' },
    isGiftCardPin: { type: Boolean, default: false },
    backupPinVault: [{ type: String }],
    inStock: { type: Boolean, default: true },
    providerInStock: { type: Boolean, default: true }
};

const CatalogProductSchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    mainCategory: { type: String, enum: ['recargas', 'giftcards', 'servicios'], required: true, index: true },
    subCategory: { 
        type: String, 
        enum: ['recargas_id', 'recargas_internas', 'giftcards_juegos', 'giftcards_plataformas', 'servicios_directos'], 
        required: true,
        index: true
    },
    fulfillmentType: {
        type: String,
        enum: ['API_DIRECT_TOPUP', 'API_GIFT_CARD', 'SERVICE_API', 'MANUAL_INTERNAL'],
        default: 'API_DIRECT_TOPUP'
    },
    // 🧠 Divide el catálogo en 2: Productos Estándar vs Productos con Algoritmo de Códigos (Steam/Play/Nintendo)
    isSmartCodeProduct: { type: Boolean, default: false },
    smartPlatformGroup: { type: String, default: 'steam' }, // 'steam', 'playstation', 'nintendo', 'xbox', 'roblox', 'otro'
    regionText: { type: String, default: 'Global / Latam' },
    badgeText: { type: String, default: '⚡ Instantáneo' },
    description: { type: String, default: '' },
    instructions: { type: String, default: 'Ingresa tu ID correctamente y selecciona el paquete que deseas recargar.' },
    cardImageUrl: { type: String, default: '' },
    flyerImageUrl: { type: String, default: '' },
    infoImageUrl: { type: String, default: '' },
    uidLabel: { type: String, default: 'ID de Jugador (UID)' },
    requiresServer: { type: Boolean, default: false },
    serverLabel: { type: String, default: 'Zona / Servidor' },
    requiresRegion: { type: Boolean, default: false },
    regionsList: [{ type: String }],
    requiresInternalLogin: { type: Boolean, default: false },
    serviceCommissionPercent: { type: Number, default: 0 },
    isFlashOffer: { type: Boolean, default: false },
    flashDiscountText: { type: String, default: '' },
    active: { type: Boolean, default: true },
    useAltPricing: { type: Boolean, default: false },
    altDescription: { type: String, default: '' },
    altInstructions: { type: String, default: '' },
    sortOrder: { type: Number, default: 0 },
    packages: [PackageSubSchema],
    altPackages: [PackageSubSchema]
}, { timestamps: true });
const CatalogProduct = mongoose.model('CatalogProduct', CatalogProductSchema, 'catalog_products');

// 💳 2.3 MÉTODOS DE PAGO DINÁMICOS (Editables desde tu Dashboard Admin)
const PaymentMethodSchema = new mongoose.Schema({
    methodKey: { type: String, required: true, unique: true, trim: true }, // 'pago_movil', 'binance', 'zinli', 'paypal', 'tokems_kz'
    name: { type: String, required: true },
    buttonTitle: { type: String, default: '' }, // Título personalizado del botón naranja selector
    currency: { type: String, enum: ['VES', 'USD', 'USDT', 'TOKEMS'], default: 'VES' },
    icon: { type: String, default: '💳' },
    accountHolder: { type: String, default: '' },
    bankName: { type: String, default: '' },
    phoneOrEmail: { type: String, default: '' },
    documentId: { type: String, default: '' }, // Cédula o RIF
    binancePayId: { type: String, default: '' },
    copyText: { type: String, default: '' }, // Formato exacto en líneas al darle a Copiar Dato
    instructions: { type: String, default: '' },
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
    isGiftCardPin: { type: Boolean, default: false },
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
exchangeRateApplied: { type: Number, required: true }, // Tasa KZ aplicada
    bcvRateApplied: { type: Number, default: 889.25 },     // Tasa BCV aplicada
    baseAmountUSD: { type: Number, required: true },       // Precio base KZ USD
    bcvAmountUSD: { type: Number, default: 0 },            // Precio público BCV USD (Bs / BCV)
    discountUSD: { type: Number, default: 0 },             // Descuento aplicado en métodos USD
    paypalFeeUSD: { type: Number, default: 0 },            // Comisión PayPal (5.4% + $0.30)
    clientPayUSD: { type: Number, default: 0 },            // Monto final en USD que paga el cliente ($1.21 PayPal, $0.84 Binance/Zinli, $0.96 ref BCV)
    serviceFeeUSD: { type: Number, default: 0 },
    totalAmountUSD: { type: Number, required: true },      // Ingreso neto KZ USD para tus estadísticas y ganancias
    totalAmountVES: { type: Number, required: true },      // Monto exacto en Bolívares (Base KZ * Tasa KZ)
    costUSD: { type: Number, default: 0 },                 // Para calcular ganancia neta en tu Dashboard
    tokemsAmount: { type: Number, default: 0 },
    paidWithTokems: { type: Boolean, default: false },

    // 📡 Estado para la Barra de Progreso en Vivo del Cliente (Zona 3 y 4)
    status: {
        type: String,
        enum: ['INICIANDO', 'EN_PROCESO', 'EN_REVISION', 'EJECUTANDO_API', 'ENTREGADO', 'RECHAZADO', 'ERROR_API'],
        default: 'EN_PROCESO',
        index: true
    },
    claimedByWorker: { type: String, default: '', lowercase: true, trim: true, index: true },
    claimedByName: { type: String, default: '' },
    claimedAt: { type: Date, default: null },
    hadReview: { type: Boolean, default: false },
    reviewReason: { type: String, default: '' },
    reviewedByWorker: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
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
    timerStartedAt: { type: Date, default: Date.now },
    clientChoseToWait: { type: Boolean, default: false },
    cancelledByDelayRefund: { type: Boolean, default: false },
    refundTicketId: { type: String, default: '' },
    algoExecutionState: { type: mongoose.Schema.Types.Mixed, default: null },
    binanceCheckoutId: { type: String, default: '', index: true },
    binanceExactAmountUSDT: { type: Number, default: 0, index: true },
    binanceMicroDecimal: { type: String, default: '' },
    binanceTransactionId: { type: String, default: '', index: true },
    binancePayerName: { type: String, default: '' },
    binanceExpiresAt: { type: Date, default: null },
    isWaitingBinanceAuto: { type: Boolean, default: false, index: true },
    fecha: { type: Date, default: Date.now }
}, { timestamps: true });

OrderSchema.index({ status: 1, fecha: -1 });
OrderSchema.index({ paymentReference: 1, fecha: -1 });
const Order = mongoose.model('Order', OrderSchema, 'kz_orders');

// 🎫 2.5 SISTEMA DE TICKETS DE ERRORES Y SOPORTE (CON CHAT EN VIVO Y AUTO-OPTIMIZACIÓN)
const SupportTicketSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true, uppercase: true, index: true },
    orderId: { type: String, default: '', uppercase: true, index: true },
    deviceId: { type: String, required: true, index: true },
    userEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
    userName: { type: String, default: '' },
    userWhatsapp: { type: String, default: '' },
    subject: { type: String, required: true },
    category: { type: String, default: 'Consulta General', trim: true }, // Motivo 100% escribible
    gameName: { type: String, default: '' },
    paymentMethod: { type: String, default: '' },
    paymentReference: { type: String, default: '' },
    playerUid: { type: String, default: '' },
    status: { type: String, enum: ['ABIERTO', 'EN_REVISION', 'RESUELTO', 'CERRADO'], default: 'ABIERTO', index: true },
    assignedWorker: { type: String, default: '' },
    assignedWorkerName: { type: String, default: '' },
    resolvedBy: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    messages: [{
        senderRole: { type: String, enum: ['client', 'worker', 'admin'], required: true },
        senderName: { type: String, required: true },
        text: { type: String, default: '' },
        attachmentUrl: { type: String, default: '' },
        timestamp: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

// 🚀 Índice TTL en MongoDB: borra automáticamente los tickets RESUELTOS después de 10 días para que jamás pesen en la base de datos
SupportTicketSchema.index({ resolvedAt: 1 }, { expireAfterSeconds: 864000 });
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

// 2. Métodos de pago iniciales (Purga automática de Zinli en MongoDB)
        await PaymentMethod.deleteMany({
            $or: [
                { methodKey: { $regex: /zinli/i } },
                { name: { $regex: /zinli/i } }
            ]
        }).catch(() => {});

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
                    methodKey: 'paypal',
                    name: 'PayPal ($)',
                    currency: 'USD',
                    icon: '🅿️',
                    bankName: '',
                    phoneOrEmail: 'pagos@kemzone07.com',
                    documentId: '',
                    copyText: 'pagos@kemzone07.com',
                    instructions: '',
                    requiresReference: true,
                    refDigitsLength: 6,
                    active: true,
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

const existePaypal = await PaymentMethod.findOne({ methodKey: 'paypal' });
        if (!existePaypal) {
            await new PaymentMethod({
                methodKey: 'paypal',
                name: 'PayPal ($)',
                currency: 'USD',
                icon: '🅿️',
                bankName: '',
                phoneOrEmail: 'pagos@kemzone07.com',
                documentId: '',
                copyText: 'pagos@kemzone07.com',
                instructions: '',
                requiresReference: true,
                refDigitsLength: 6,
                active: false,
                sortOrder: 3
            }).save();
            console.log('✅ [Seed] Método de pago PayPal ($) añadido al Dashboard (Oculto por defecto)');
        } else {
            const stDoc = await StoreSettings.findOne({ key: 'main_settings' }).lean();
            if (!stDoc || !stDoc.paypalDefaultHiddenApplied) {
                existePaypal.active = false;
                await existePaypal.save();
                await StoreSettings.collection.updateOne(
                    { key: 'main_settings' },
                    { $set: { paypalDefaultHiddenApplied: true } }
                );
            }
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
// 🤖 MOTOR CENTRAL ONE API v1 + ALGORITMO DE ARBITRAJE (STEAM/PSN/NINTENDO)
// =================================================================
const CENTRAL_ONE_BASE_URL = (process.env.CENTRAL_ONE_BASE_URL || 'https://portal.centraloneglobal.com/api/v1').replace(/\/+$/, '');

// Matemática exacta de 4 decimales (como exige Central One)
function aMicro4(val) {
    return Math.round((Number(val) || 0) * 10000);
}
function deMicro4(micro) {
    return Number((micro / 10000).toFixed(4));
}
function formatear4Decimales(val) {
    return (Number(val) || 0).toFixed(4);
}

function obtenerHeadersCentralOne(extraHeaders = {}) {
    const apiKey = (process.env.CENTRAL_ONE_API_KEY || process.env.PROVIDER_API_KEY || '').trim();
    if (!apiKey) return null;
    return {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...extraHeaders
    };
}

// 🔍 Obtiene el mapa exacto de todos los UUIDs y SKUs de Central One que tienes vinculados en tu tienda
async function obtenerMapaVinculadosTiendaKZ(settingsDoc = null) {
    const byId = new Map();
    const bySku = new Map();
    try {
        if (!settingsDoc) {
            settingsDoc = await StoreSettings.findOne({ key: 'main_settings' })
                .select('arbitrageBaseCards flashOffers')
                .lean();
        }
        const productos = await CatalogProduct.find()
            .select('slug name packages altPackages')
            .lean();

        const registrarVinculo = (coId, sku, meta) => {
            const idClean = String(coId || '').trim();
            const skuClean = String(sku || '').trim().toUpperCase();
            if (idClean) byId.set(idClean, meta);
            if (skuClean) bySku.set(skuClean, meta);
        };

        for (const p of (productos || [])) {
            for (const pk of (p.packages || [])) {
                if (pk.centralOneProductId || pk.apiProductSku) {
                    registrarVinculo(pk.centralOneProductId, pk.apiProductSku, {
                        storeSlug: p.slug,
                        storeProductName: p.name,
                        storePackageId: pk.packageId,
                        storePackageName: pk.name,
                        label: `${p.name} ➔ ${pk.name}`
                    });
                }
            }
            for (const pk of (p.altPackages || [])) {
                if (pk.centralOneProductId || pk.apiProductSku) {
                    registrarVinculo(pk.centralOneProductId, pk.apiProductSku, {
                        storeSlug: p.slug,
                        storeProductName: p.name,
                        storePackageId: pk.packageId,
                        storePackageName: `${pk.name} (Alt)`,
                        label: `${p.name} ➔ ${pk.name} (Alt)`
                    });
                }
            }
        }

        for (const c of (settingsDoc?.arbitrageBaseCards || [])) {
            if (c.centralOneProductId || c.centralOneSku) {
                registrarVinculo(c.centralOneProductId, c.centralOneSku, {
                    storeSlug: `pool_${c.platformGroup || 'steam'}`,
                    storeProductName: `Pool Algoritmo (${(c.platformGroup || 'steam').toUpperCase()})`,
                    storePackageId: c.cardId,
                    storePackageName: c.name,
                    label: `Pool ${(c.platformGroup || 'steam').toUpperCase()} ➔ ${c.name}`
                });
            }
        }

        for (const of of (settingsDoc?.flashOffers || [])) {
            if (of.centralOneProductId || of.apiProductSku) {
                registrarVinculo(of.centralOneProductId, of.apiProductSku, {
                    storeSlug: of.slug || 'loot',
                    storeProductName: of.game || 'Loot Relámpago',
                    storePackageId: of.pkgId,
                    storePackageName: of.title,
                    label: `Oferta ${of.game || ''} ➔ ${of.title}`
                });
            }
        }
    } catch (e) {}
    return { byId, bySku };
}

async function registrarAlertaCentralOne(settingsDoc, alertaObj, mapaVinculadosPre = null) {
    try {
        if (!settingsDoc) settingsDoc = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settingsDoc) return;
        if (!Array.isArray(settingsDoc.centralOneAlerts)) settingsDoc.centralOneAlerts = [];

        const prodId = String(alertaObj.productId || '').trim();
        const skuUpper = String(alertaObj.sku || '').trim().toUpperCase();
        const tiposDeCatalogo = ['PRICE_UP', 'PRICE_DOWN', 'OUT_OF_STOCK', 'BACK_IN_STOCK', 'REMOVED_FROM_CATALOG'];

        let vinculoInfo = null;
        if (prodId || skuUpper || tiposDeCatalogo.includes(alertaObj.type)) {
            const mapaVinc = mapaVinculadosPre || await obtenerMapaVinculadosTiendaKZ(settingsDoc);
            vinculoInfo = (prodId && mapaVinc.byId.get(prodId)) || (skuUpper && mapaVinc.bySku.get(skuUpper)) || null;

            // 🔒 Si es un cambio de precio/stock del catálogo de Central One pero NO está vinculado a ningún producto tuyo, se ignora
            if (!vinculoInfo && tiposDeCatalogo.includes(alertaObj.type)) {
                return;
            }
        }

        // Clave única fija por producto/paquete para que NUNCA haya alertas repetidas del mismo ítem
        const fixedKey = prodId || skuUpper || alertaObj.fixedKey || `${alertaObj.type}_${alertaObj.title || ''}`;

        // Purgar de paso cualquier alerta vieja de productos no vinculados
        const idxExistente = settingsDoc.centralOneAlerts.findIndex(a =>
            (prodId && a.productId === prodId) ||
            (skuUpper && String(a.sku || '').toUpperCase() === skuUpper) ||
            (a.fixedKey && a.fixedKey === fixedKey)
        );

        const nuevoEventoHistorial = {
            type: alertaObj.type || 'INFO',
            severity: alertaObj.severity || 'INFO',
            title: alertaObj.title || '',
            detail: alertaObj.detail || '',
            oldPrice: alertaObj.oldPrice || '',
            newPrice: alertaObj.newPrice || '',
            date: new Date()
        };

        let historialPrevio = [];
        if (idxExistente !== -1) {
            const prevAlert = settingsDoc.centralOneAlerts[idxExistente];
            historialPrevio = Array.isArray(prevAlert.historyLog) ? prevAlert.historyLog : [];
            settingsDoc.centralOneAlerts.splice(idxExistente, 1);
        }

        historialPrevio.unshift(nuevoEventoHistorial);
        if (historialPrevio.length > 10) historialPrevio = historialPrevio.slice(0, 10);

        settingsDoc.centralOneAlerts.unshift({
            alertId: 'al_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 6),
            fixedKey,
            type: alertaObj.type || 'INFO',
            severity: alertaObj.severity || 'INFO',
            title: alertaObj.title || 'Aviso de Proveedor API',
            detail: alertaObj.detail || '',
            sku: alertaObj.sku || '',
            productId: prodId,
            storeSlug: vinculoInfo ? vinculoInfo.storeSlug : (alertaObj.storeSlug || ''),
            storeProductName: vinculoInfo ? vinculoInfo.storeProductName : (alertaObj.storeProductName || ''),
            storePackageName: vinculoInfo ? vinculoInfo.storePackageName : (alertaObj.storePackageName || ''),
            linkedLabel: vinculoInfo ? vinculoInfo.label : (alertaObj.linkedLabel || ''),
            oldPrice: alertaObj.oldPrice || '',
            newPrice: alertaObj.newPrice || '',
            historyLog: historialPrevio,
            read: false,
            createdAt: new Date()
        });

        if (settingsDoc.centralOneAlerts.length > 200) {
            settingsDoc.centralOneAlerts = settingsDoc.centralOneAlerts.slice(0, 200);
        }
        settingsDoc.markModified('centralOneAlerts');
    } catch (e) {}
}

// Extender esquema de Órdenes con soporte para Reloj de 30 Minutos y Estado Paso a Paso del Algoritmo
Order.schema.add({
    timerStartedAt: { type: Date, default: Date.now },
    clientChoseToWait: { type: Boolean, default: false },
    cancelledByDelayRefund: { type: Boolean, default: false },
    refundTicketId: { type: String, default: '' },
    algoExecutionState: { type: mongoose.Schema.Types.Mixed, default: null }
});

function obtenerLimiteHumanoCodigosServer(metaUSD) {
    const m = Number(metaUSD) || 0;
    if (m <= 3.00) return { max: 2, ideal: 1 };
    if (m <= 6.00) return { max: 2, ideal: 2 };
    if (m <= 12.00) return { max: 3, ideal: 2 };
    if (m <= 25.00) return { max: 4, ideal: 3 };
    if (m <= 40.00) return { max: 5, ideal: 3 };
    if (m <= 60.00) return { max: 6, ideal: 4 };
    if (m <= 105.00) return { max: 8, ideal: 5 };
    return { max: 10, ideal: 6 };
}

function extraerMetaUsdDeNombrePaqueteServer(pkg) {
    if (!pkg) return 0;
    if (Number(pkg.targetClientUSD) > 0) return Number(pkg.targetClientUSD);
    const nombre = String(pkg.name || '').trim().replace(/(\d)[,.](\d{3})(?!\d)/g, '$1$2');
    const match = nombre.match(/(\d+(?:[.,]\d+)?)/);
    if (match) {
        const val = parseFloat(match[1].replace(',', '.'));
        if (!isNaN(val) && val > 0) return val;
    }
    return 0;
}

function calcularMejorCombinacionTarjetasPool(targetClientUSD, platformGroup, baseCardsPool, catalogCache = null, excludedCardIds = []) {
    const metaUSD = Number(targetClientUSD) || 0;
    if (metaUSD <= 0) return { hasSolution: false, reason: 'Meta USD inválida' };

    const excluidosSet = new Set((excludedCardIds || []).map(x => String(x)));
    const mapaCO_Id = {};
    const mapaCO_Sku = {};
    const tieneCacheAPI = Array.isArray(catalogCache) && catalogCache.length > 0;
    if (tieneCacheAPI) {
        for (let i = 0; i < catalogCache.length; i++) {
            const it = catalogCache[i];
            if (it.product_id) mapaCO_Id[it.product_id] = it;
            if (it.sku) mapaCO_Sku[String(it.sku).trim().toUpperCase()] = it;
        }
    }

    let candidatas = [];
    for (const rawCard of (baseCardsPool || [])) {
        const c = rawCard && typeof rawCard.toObject === 'function'
            ? rawCard.toObject()
            : (rawCard && rawCard._doc ? { ...rawCard._doc } : { ...rawCard });

        if (c.active === false) continue;
        if (excluidosSet.has(String(c.cardId))) continue;
        if (String(c.platformGroup || 'steam').toLowerCase() !== String(platformGroup || 'steam').toLowerCase()) continue;

        let effUsd = Number(c.effectiveClientUSD);
        if (!effUsd || effUsd <= 0) {
            effUsd = Number(((Number(c.faceValueOrigin) || 0) * (Number(c.conversionRateToUSD) || 0)).toFixed(4));
        }
        let costoReal = Number(c.costUSD || 0);
        let enStockReal = c.inStock !== false;
        let stockDisp = (c.availableStock !== null && c.availableStock !== undefined) ? Number(c.availableStock) : null;
        const stockInternoCount = Array.isArray(c.internalCodeStock) ? c.internalCodeStock.length : 0;

        let coIdResuelto = String(c.centralOneProductId || '').trim();
        let coSkuResuelto = String(c.centralOneSku || '').trim();

        if (tieneCacheAPI && (coIdResuelto || coSkuResuelto)) {
            const itemCO = (coIdResuelto && mapaCO_Id[coIdResuelto]) ||
                           (coSkuResuelto && mapaCO_Sku[coSkuResuelto.toUpperCase()]);
            if (!itemCO) {
                enStockReal = false;
            } else {
                if (!coIdResuelto && itemCO.product_id) coIdResuelto = String(itemCO.product_id);
                if (!coSkuResuelto && itemCO.sku) coSkuResuelto = String(itemCO.sku);
                enStockReal = Boolean(itemCO.in_stock && itemCO.status === 'active');
                if ((!costoReal || costoReal <= 0) && itemCO.reseller_price !== null && Number(itemCO.reseller_price) > 0) {
                    costoReal = Number(itemCO.reseller_price);
                }
                if (itemCO.available_stock !== undefined && itemCO.available_stock !== null) {
                    stockDisp = Number(itemCO.available_stock);
                }
            }
        }

        if (!enStockReal && stockInternoCount <= 0) continue;
        if (stockDisp !== null && (stockDisp + stockInternoCount) <= 0) continue;
        if (effUsd <= 0 || costoReal <= 0) continue;

        candidatas.push({
            ...c,
            cardId: c.cardId,
            name: c.name || coSkuResuelto || 'Tarjeta Steam',
            centralOneProductId: coIdResuelto,
            centralOneSku: coSkuResuelto,
            faceValueOrigin: c.faceValueOrigin,
            originCurrency: c.originCurrency || 'VND',
            effectiveClientUSD: effUsd,
            costUSD: costoReal,
            costPerDollar: costoReal / effUsd,
            availableStock: stockDisp !== null ? (stockDisp + stockInternoCount) : null,
            internalStockCount: stockInternoCount
        });
    }

    if (candidatas.length === 0) {
        return {
            hasSolution: false,
            reason: `No hay tarjetas base activas y con stock disponible en la Bóveda de ${(platformGroup || 'steam').toUpperCase()}.`
        };
    }

    const resolverTramoConAlgoritmoExacto = (targetTramoUSD, listaDisp, limiteCartas) => {
        let cands = [...listaDisp];
        if (targetTramoUSD >= 10) {
            const umbralMin = (targetTramoUSD / limiteCartas) * 0.45;
            const grandes = cands.filter(c => c.effectiveClientUSD >= umbralMin);
            if (grandes.length > 0) cands = grandes;
        }

        cands.sort((a, b) => {
            if (Math.abs(a.costPerDollar - b.costPerDollar) > 0.015) return a.costPerDollar - b.costPerDollar;
            return b.effectiveClientUSD - a.effectiveClientUSD;
        });

        const n = cands.length;
        const menorCartaUSD = Math.min(...cands.map(c => c.effectiveClientUSD));
        const mayorCartaUSD = Math.max(...cands.map(c => c.effectiveClientUSD));

        const pisoMinimoUSD = Number((targetTramoUSD - 0.001).toFixed(4));
        const techoMaximoUSD = targetTramoUSD <= 3.50
            ? Math.max(targetTramoUSD * 1.85, menorCartaUSD * 2.05)
            : (targetTramoUSD <= 15 ? (targetTramoUSD * 1.35) : (targetTramoUSD + Math.max(8.0, targetTramoUSD * 0.25, mayorCartaUSD * 1.05)));

        const mejorRatioCosto = Math.min(...cands.map(c => c.costPerDollar));
        const maxCartaGlobalPorIndice = new Array(n);
        let maxRunning = 0;
        for (let i = n - 1; i >= 0; i--) {
            if (cands[i].effectiveClientUSD > maxRunning) maxRunning = cands[i].effectiveClientUSD;
            maxCartaGlobalPorIndice[i] = maxRunning;
        }

        const penalizacionPorCartaMicro = Math.round(Math.max(0.15, targetTramoUSD * 0.012) * 10000);
        const soluciones = [];
        let mejorCostoHalladoMicro = Infinity;
        let nodosExplorados = 0;

        function explorar(startIndex, cartasUsadas, conteoPorIndice, sumaClienteUSD, sumaCostoMicro) {
            nodosExplorados++;
            if (nodosExplorados > 1400) return;

            const sumaRedondeada = Number(sumaClienteUSD.toFixed(2));
            if (cartasUsadas > 0 && sumaRedondeada >= pisoMinimoUSD && sumaRedondeada <= techoMaximoUSD) {
                const diffMeta = Number(Math.max(0, sumaRedondeada - targetTramoUSD).toFixed(2));
                const itemsCombo = [];
                Object.entries(conteoPorIndice).forEach(([idxStr, qty]) => {
                    const card = cands[Number(idxStr)];
                    itemsCombo.push({
                        cardId: card.cardId,
                        centralOneProductId: card.centralOneProductId || '',
                        sku: card.centralOneSku || '',
                        name: card.name,
                        quantity: qty,
                        unitCostUSD: Number(card.costUSD),
                        unitClientUSD: Number(card.effectiveClientUSD),
                        originText: `${card.faceValueOrigin} ${card.originCurrency}`
                    });
                });

                const scoreBeneficioMicro = sumaCostoMicro + ((cartasUsadas - 1) * penalizacionPorCartaMicro);
                if (scoreBeneficioMicro < mejorCostoHalladoMicro) {
                    mejorCostoHalladoMicro = scoreBeneficioMicro;
                }

                soluciones.push({
                    hasSolution: true,
                    totalCards: cartasUsadas,
                    totalClientUSD: sumaRedondeada,
                    totalCostUSD: deMicro4(sumaCostoMicro),
                    totalCostMicro: sumaCostoMicro,
                    scoreBeneficioMicro,
                    bonusClientUSD: diffMeta,
                    overshootUSD: diffMeta,
                    items: itemsCombo
                });
                return;
            }

            if (cartasUsadas >= limiteCartas) return;

            const maxCartaRestanteUSD = maxCartaGlobalPorIndice[startIndex] || mayorCartaUSD;
            const faltaUSD = Math.max(0, pisoMinimoUSD - sumaClienteUSD);
            const minCartasFaltantes = Math.ceil(faltaUSD / Math.max(0.1, maxCartaRestanteUSD));
            if (cartasUsadas + minCartasFaltantes > limiteCartas) return;

            const minTotalCartasRama = Math.max(1, cartasUsadas + minCartasFaltantes);
            const costoMinimoFaltanteMicro = Math.round(faltaUSD * mejorRatioCosto * 10000);
            const scoreMinimoPosibleRama = sumaCostoMicro + costoMinimoFaltanteMicro + ((minTotalCartasRama - 1) * penalizacionPorCartaMicro);
            if (scoreMinimoPosibleRama > mejorCostoHalladoMicro + 500) return;

            for (let i = startIndex; i < n; i++) {
                const card = cands[i];
                const yaUsadas = conteoPorIndice[i] || 0;
                if (card.availableStock !== null && card.availableStock !== undefined && yaUsadas + 1 > Number(card.availableStock)) {
                    continue;
                }
                const nuevaSuma = Number((sumaClienteUSD + Number(card.effectiveClientUSD)).toFixed(4));
                if (nuevaSuma > techoMaximoUSD) continue;
                explorar(
                    i,
                    cartasUsadas + 1,
                    { ...conteoPorIndice, [i]: yaUsadas + 1 },
                    nuevaSuma,
                    sumaCostoMicro + aMicro4(card.costUSD)
                );
            }
        }

        explorar(0, 0, {}, 0, 0);
        if (soluciones.length === 0) return null;

        soluciones.sort((a, b) => {
            if (Math.abs(a.scoreBeneficioMicro - b.scoreBeneficioMicro) > 100) return a.scoreBeneficioMicro - b.scoreBeneficioMicro;
            if (a.totalCards !== b.totalCards) return a.totalCards - b.totalCards;
            return a.overshootUSD - b.overshootUSD;
        });
        return soluciones[0];
    };

    const { max: maxCartasHumano } = obtenerLimiteHumanoCodigosServer(metaUSD);
    const mayorCartaGlobal = Math.max(...candidatas.map(c => c.effectiveClientUSD));
    const minCodigosRequeridos = Math.ceil((metaUSD - 0.001) / Math.max(0.1, mayorCartaGlobal));

    let solucionFinal = null;

    // 1. Intento normal dentro del límite de 10 tarjetas
    if (minCodigosRequeridos <= maxCartasHumano) {
        solucionFinal = resolverTramoConAlgoritmoExacto(metaUSD, candidatas, maxCartasHumano);
    }

    // 2. MODO ESCALA INFINITA: Si supera las 10 tarjetas (o no alcanzó con 10), arma el bloque mayorista + cierre exacto
    if (!solucionFinal) {
        const candsConStock = candidatas.map(c => ({ ...c }));
        candsConStock.sort((a, b) => {
            const scoreA = (a.costUSD + 0.18) / a.effectiveClientUSD;
            const scoreB = (b.costUSD + 0.18) / b.effectiveClientUSD;
            if (Math.abs(scoreA - scoreB) > 0.02) return scoreA - scoreB;
            return b.effectiveClientUSD - a.effectiveClientUSD;
        });

        const mapaBulk = new Map();
        let usdAcumuladoBulk = 0;
        let costoMicroBulk = 0;
        let cartasBulk = 0;

        const ventanaColaUSD = Math.max(mayorCartaGlobal * 4, 25);

        for (const card of candsConStock) {
            const faltaParaVentana = (metaUSD - ventanaColaUSD) - usdAcumuladoBulk;
            if (faltaParaVentana <= 0) break;

            let cantTomar = Math.floor(faltaParaVentana / card.effectiveClientUSD);
            if (card.availableStock !== null && card.availableStock !== undefined) {
                cantTomar = Math.min(cantTomar, Math.max(0, Number(card.availableStock)));
            }
            if (cantTomar > 0) {
                mapaBulk.set(card.cardId, { card, qty: cantTomar });
                usdAcumuladoBulk = Number((usdAcumuladoBulk + cantTomar * card.effectiveClientUSD).toFixed(4));
                costoMicroBulk += cantTomar * aMicro4(card.costUSD);
                cartasBulk += cantTomar;
                if (card.availableStock !== null && card.availableStock !== undefined) {
                    card.availableStock = Math.max(0, Number(card.availableStock) - cantTomar);
                }
            }
        }

        const restoPorCubrirUSD = Number(Math.max(0, metaUSD - usdAcumuladoBulk).toFixed(4));
        let solCola = null;

        if (restoPorCubrirUSD > 0.001) {
            solCola = resolverTramoConAlgoritmoExacto(restoPorCubrirUSD, candsConStock, 10);

            if (!solCola) {
                for (const card of candsConStock) {
                    const faltaAhora = (metaUSD - 0.001) - usdAcumuladoBulk;
                    if (faltaAhora <= 0) break;
                    let cantExtra = Math.ceil(faltaAhora / card.effectiveClientUSD);
                    if (card.availableStock !== null && card.availableStock !== undefined) {
                        cantExtra = Math.min(cantExtra, Math.max(0, Number(card.availableStock)));
                    }
                    if (cantExtra > 0) {
                        const prev = mapaBulk.get(card.cardId);
                        mapaBulk.set(card.cardId, { card, qty: (prev ? prev.qty : 0) + cantExtra });
                        usdAcumuladoBulk = Number((usdAcumuladoBulk + cantExtra * card.effectiveClientUSD).toFixed(4));
                        costoMicroBulk += cantExtra * aMicro4(card.costUSD);
                        cartasBulk += cantExtra;
                        if (card.availableStock !== null && card.availableStock !== undefined) {
                            card.availableStock = Math.max(0, Number(card.availableStock) - cantExtra);
                        }
                    }
                }
            }
        }

        if (solCola && Array.isArray(solCola.items)) {
            solCola.items.forEach(it => {
                const prev = mapaBulk.get(it.cardId);
                if (prev) {
                    prev.qty += it.quantity;
                } else {
                    mapaBulk.set(it.cardId, {
                        card: {
                            cardId: it.cardId,
                            centralOneProductId: it.centralOneProductId,
                            centralOneSku: it.sku,
                            name: it.name,
                            costUSD: it.unitCostUSD,
                            effectiveClientUSD: it.unitClientUSD,
                            faceValueOrigin: '',
                            originCurrency: ''
                        },
                        qty: it.quantity
                    });
                }
                usdAcumuladoBulk = Number((usdAcumuladoBulk + it.quantity * it.unitClientUSD).toFixed(4));
                costoMicroBulk += it.quantity * aMicro4(it.unitCostUSD);
                cartasBulk += it.quantity;
            });
        }

        if (usdAcumuladoBulk >= metaUSD - 0.001 && cartasBulk > 0) {
            const itemsMerged = [];
            mapaBulk.forEach(({ card, qty }) => {
                itemsMerged.push({
                    cardId: card.cardId,
                    centralOneProductId: card.centralOneProductId || '',
                    sku: card.centralOneSku || '',
                    name: card.name,
                    quantity: qty,
                    unitCostUSD: Number(card.costUSD),
                    unitClientUSD: Number(card.effectiveClientUSD),
                    originText: `${card.faceValueOrigin || ''} ${card.originCurrency || ''}`.trim()
                });
            });
            const totalClientRedondeado = Number(usdAcumuladoBulk.toFixed(2));
            const diffMetaFinal = Number(Math.max(0, totalClientRedondeado - metaUSD).toFixed(2));
            solucionFinal = {
                hasSolution: true,
                totalCards: cartasBulk,
                totalClientUSD: totalClientRedondeado,
                totalCostUSD: deMicro4(costoMicroBulk),
                totalCostMicro: costoMicroBulk,
                scoreBeneficioMicro: costoMicroBulk,
                bonusClientUSD: diffMetaFinal,
                overshootUSD: diffMetaFinal,
                items: itemsMerged
            };
        }
    }

    if (!solucionFinal) {
        return {
            hasSolution: false,
            reason: `Stock insuficiente en la Bóveda para cubrir $${metaUSD.toFixed(2)} USD en este momento.`
        };
    }

    solucionFinal.summaryText = solucionFinal.items
        .map(it => `${it.quantity}x ${it.name} ($${(it.unitClientUSD * it.quantity).toFixed(2)})`)
        .join(' + ');

    return solucionFinal;
}

// 🏦 Guarda en el Stock Interno de la Bóveda cualquier código que llegue después de que el cliente pidió reembolso por demora
async function guardarCodigosRecuperadosEnStockInterno(ordenDB, listaObjetosCodigos = [], codigosPlanos = []) {
    try {
        const settings = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settings) return;
        let guardadosCount = 0;

        if (Array.isArray(listaObjetosCodigos) && listaObjetosCodigos.length > 0 && Array.isArray(settings.arbitrageBaseCards)) {
            for (const itemCode of listaObjetosCodigos) {
                const cPool = settings.arbitrageBaseCards.find(c =>
                    (itemCode.cardId && c.cardId === itemCode.cardId) ||
                    (itemCode.catalogItemId && c.centralOneProductId === itemCode.catalogItemId)
                );
                if (cPool && Array.isArray(itemCode.codes)) {
                    if (!Array.isArray(cPool.internalCodeStock)) cPool.internalCodeStock = [];
                    for (const codeStr of itemCode.codes) {
                        const limpio = String(codeStr || '').trim();
                        if (limpio && !cPool.internalCodeStock.includes(limpio)) {
                            cPool.internalCodeStock.push(limpio);
                            guardadosCount++;
                        }
                    }
                }
            }
            if (guardadosCount > 0) settings.markModified('arbitrageBaseCards');
        }

        if (guardadosCount === 0 && Array.isArray(codigosPlanos) && codigosPlanos.length > 0 && ordenDB) {
            const prodDB = await CatalogProduct.findOne({ slug: ordenDB.productSlug });
            if (prodDB) {
                const pkg = (prodDB.packages || []).find(p => p.packageId === ordenDB.packageId);
                if (pkg) {
                    if (!Array.isArray(pkg.backupPinVault)) pkg.backupPinVault = [];
                    codigosPlanos.forEach(cStr => {
                        const limpio = String(cStr || '').trim();
                        if (limpio && !pkg.backupPinVault.includes(limpio)) {
                            pkg.backupPinVault.push(limpio);
                            guardadosCount++;
                        }
                    });
                    prodDB.markModified('packages');
                    await prodDB.save();
                }
            }
        }

        if (guardadosCount > 0) {
            await registrarAlertaCentralOne(settings, {
                type: 'BACK_IN_STOCK',
                severity: 'OK',
                title: `🏦 ${guardadosCount} código(s) guardados en Stock Interno (#${ordenDB ? ordenDB.orderId : 'KZ'})`,
                detail: `El cliente había solicitado reembolso tras 30 min de espera, por lo que los códigos entregados por el proveedor se guardaron en tu Bóveda para usarlos automáticamente en la próxima venta.`
            });
            await settings.save();
        }
    } catch (e) {
        console.error('Aviso guardando en stock interno:', e.message);
    }
}

// 🔄 RECALCULADOR GLOBAL DE PRECIOS POR GANANCIA FIJA + ALGORITMO + FLYERS CANVA (SIN DESCARGAR IMÁGENES BASE64 PESADAS)
async function recalcularPreciosYAlgoritmoTiendaKZ(settingsDoc = null, targetSlugOnly = null, desdeSyncAPI = false) {
    try {
        if (!settingsDoc) settingsDoc = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settingsDoc) return;

        const catalogoCO = Array.isArray(settingsDoc.centralOneCatalogCache) ? settingsDoc.centralOneCatalogCache : [];
        const mapaCO_PorId = {};
        const mapaCO_PorSku = {};
        for (let i = 0; i < catalogoCO.length; i++) {
            const item = catalogoCO[i];
            if (item.product_id) mapaCO_PorId[item.product_id] = item;
            if (item.sku) mapaCO_PorSku[String(item.sku).trim().toUpperCase()] = item;
        }

        let huboCambioPool = false;
        const poolCards = settingsDoc.arbitrageBaseCards || [];
        for (let i = 0; i < poolCards.length; i++) {
            const card = poolCards[i];
            if (!card.effectiveClientUSD || Number(card.effectiveClientUSD) <= 0) {
                const effUsdCalc = Number(((Number(card.faceValueOrigin) || 0) * (Number(card.conversionRateToUSD) || 0)).toFixed(2));
                if (effUsdCalc > 0) {
                    card.effectiveClientUSD = effUsdCalc;
                    huboCambioPool = true;
                }
            }
            if (catalogoCO.length > 0 && (card.centralOneProductId || card.centralOneSku)) {
                const itemCO = (card.centralOneProductId && mapaCO_PorId[card.centralOneProductId]) ||
                               (card.centralOneSku && mapaCO_PorSku[String(card.centralOneSku).trim().toUpperCase()]);
                if (itemCO) {
                    const nuevoCosto = itemCO.reseller_price !== null ? Number(itemCO.reseller_price) : card.costUSD;
                    const nuevoInStock = Boolean(itemCO.in_stock && itemCO.status === 'active');
                    if ((desdeSyncAPI || !card.costUSD || Number(card.costUSD) <= 0) && nuevoCosto > 0 && Math.abs((card.costUSD || 0) - nuevoCosto) > 0.0001) {
                        card.costUSD = nuevoCosto;
                        card.lastPriceUpdateAt = new Date();
                        huboCambioPool = true;
                    }
                    if (card.inStock !== nuevoInStock) {
                        card.inStock = nuevoInStock;
                        huboCambioPool = true;
                    }
                    card.availableStock = itemCO.available_stock !== undefined ? itemCO.available_stock : null;
                } else if (card.inStock !== false) {
                    card.inStock = false;
                    huboCambioPool = true;
                }
            }
        }
        if (huboCambioPool) settingsDoc.markModified('arbitrageBaseCards');

        // Lee los productos excluyendo las imágenes pesadas de portada, banner y guía para que la consulta a MongoDB sea instantánea
        const filtroProd = targetSlugOnly ? { slug: String(targetSlugOnly).trim().toLowerCase() } : {};
        const productos = await CatalogProduct.find(filtroProd)
            .select('_id slug name isSmartCodeProduct smartPlatformGroup useAltPricing packages altPackages')
            .lean();

        const mapaPreciosParaFlyers = {};
        const operacionesBulk = [];

        for (const prod of productos) {
            let prodModificado = false;
            const esSmartProd = Boolean(prod.isSmartCodeProduct);
            const platGroup = prod.smartPlatformGroup || 'steam';

            const procesarArregloPaquetes = (listaPaquetes) => {
                if (!Array.isArray(listaPaquetes)) return;
                for (const pkg of listaPaquetes) {
                    const usaAlgo = esSmartProd || Boolean(pkg.useSmartAlgorithm);

                    if (usaAlgo) {
                        const metaUsd = extraerMetaUsdDeNombrePaqueteServer(pkg);
                        if (metaUsd > 0 && Number(pkg.targetClientUSD) !== metaUsd) {
                            pkg.targetClientUSD = metaUsd;
                            prodModificado = true;
                        }
                        if (metaUsd > 0) {
                            const combo = calcularMejorCombinacionTarjetasPool(
                                metaUsd,
                                platGroup,
                                settingsDoc.arbitrageBaseCards || [],
                                catalogoCO
                            );
                            const prevSummary = pkg.resolvedCombo ? pkg.resolvedCombo.summaryText : '';
                            pkg.resolvedCombo = combo;

                            if (combo.hasSolution) {
                                const costoCombo = Number(combo.totalCostUSD.toFixed(4));
                                if (Math.abs((pkg.costUSD || 0) - costoCombo) > 0.0001) {
                                    pkg.costUSD = costoCombo;
                                    prodModificado = true;
                                }
                                if (pkg.providerInStock !== true) {
                                    pkg.providerInStock = true;
                                    prodModificado = true;
                                }
                                if (prevSummary !== combo.summaryText) {
                                    prodModificado = true;
                                }
                            } else {
                                if (pkg.providerInStock !== false) {
                                    pkg.providerInStock = false;
                                    prodModificado = true;
                                }
                                if (prevSummary !== 'SIN_SOLUCION') {
                                    pkg.resolvedCombo = { ...combo, summaryText: 'SIN_SOLUCION' };
                                    prodModificado = true;
                                }
                            }
                        }
                    } else {
                        const itemCO = (pkg.centralOneProductId && mapaCO_PorId[pkg.centralOneProductId]) ||
                                       (pkg.apiProductSku && mapaCO_PorSku[String(pkg.apiProductSku).trim().toUpperCase()]);
                        if (itemCO) {
                            const nuevoCosto = itemCO.reseller_price !== null ? Number(itemCO.reseller_price) : pkg.costUSD;
                            const nuevoStock = Boolean(itemCO.in_stock && itemCO.status === 'active');
                            if (nuevoCosto > 0 && Math.abs((pkg.costUSD || 0) - nuevoCosto) > 0.0001) {
                                pkg.costUSD = nuevoCosto;
                                prodModificado = true;
                            }
                            if (pkg.providerInStock !== nuevoStock) {
                                pkg.providerInStock = nuevoStock;
                                prodModificado = true;
                            }
                            if (Array.isArray(itemCO.target_schema)) {
                                pkg.targetSchemaCache = itemCO.target_schema;
                            }
                        }
                    }

                    if (pkg.autoPriceByProfit !== false && Number(pkg.costUSD) > 0) {
                        const gananciaDeseada = pkg.profitUSD !== undefined && pkg.profitUSD !== null
                            ? Number(pkg.profitUSD)
                            : Math.max(0.15, Number(((pkg.priceUSD || 1) - (pkg.costUSD || 0)).toFixed(2)));
                        pkg.profitUSD = Number(gananciaDeseada.toFixed(2));
                        const nuevoPrecioVenta = Number((Number(pkg.costUSD) + pkg.profitUSD).toFixed(2));
                        if (Math.abs((pkg.priceUSD || 0) - nuevoPrecioVenta) >= 0.01) {
                            pkg.priceUSD = nuevoPrecioVenta;
                            pkg.tokemsPrice = nuevoPrecioVenta;
                            prodModificado = true;
                        }
                    }
                }
            };

            procesarArregloPaquetes(prod.packages);
            procesarArregloPaquetes(prod.altPackages);

            if (prodModificado) {
                operacionesBulk.push({
                    updateOne: {
                        filter: { _id: prod._id },
                        update: { $set: { packages: prod.packages, altPackages: prod.altPackages } }
                    }
                });
            }

            const listaActiva = (prod.useAltPricing && Array.isArray(prod.altPackages) && prod.altPackages.length > 0)
                ? prod.altPackages
                : (prod.packages || []);
            for (let k = 0; k < listaActiva.length; k++) {
                const pk = listaActiva[k];
                mapaPreciosParaFlyers[`${prod.slug}::${pk.packageId}`] = Number(pk.priceUSD || 0).toFixed(2);
            }
        }

        if (operacionesBulk.length > 0) {
            await CatalogProduct.bulkWrite(operacionesBulk);
        }

        let flyersModificados = false;
        if (settingsDoc.flyersCanvaConfig && typeof settingsDoc.flyersCanvaConfig === 'object') {
            Object.values(settingsDoc.flyersCanvaConfig).forEach(ficha => {
                (ficha.items || []).forEach(itm => {
                    if (itm.linkedRef && mapaPreciosParaFlyers[itm.linkedRef]) {
                        if (itm.price !== mapaPreciosParaFlyers[itm.linkedRef]) {
                            itm.price = mapaPreciosParaFlyers[itm.linkedRef];
                            flyersModificados = true;
                        }
                    }
                });
            });
            if (flyersModificados) {
                settingsDoc.markModified('flyersCanvaConfig');
            }
        }

        if (huboCambioPool || flyersModificados || !targetSlugOnly) {
            await settingsDoc.save();
        }
    } catch (err) {
        console.error('Aviso recalculando precios y algoritmo:', err.message);
    }
}

// 📡 SINCRONIZADOR CON CENTRAL ONE (`GET /catalog`, `GET /balance`, `GET /player/validate/coverage`)
async function sincronizarTodoConCentralOne(forzar = false) {
    const headers = obtenerHeadersCentralOne();
    let settings = await StoreSettings.findOne({ key: 'main_settings' });
    if (!settings) settings = new StoreSettings({ key: 'main_settings' });

    if (!headers) {
        settings.centralOneSync = {
            ...(settings.centralOneSync || {}),
            apiConnected: false,
            lastError: 'Falta configurar CENTRAL_ONE_API_KEY en Railway.'
        };
        await settings.save();
        return { success: false, error: 'Falta configurar CENTRAL_ONE_API_KEY en Railway.' };
    }

    try {
        const [resBalance, resCatalog, resCoverage, mapaVinculados] = await Promise.all([
            axios.get(`${CENTRAL_ONE_BASE_URL}/balance`, { headers, timeout: 12000 }).catch(e => ({ _err: e })),
            axios.get(`${CENTRAL_ONE_BASE_URL}/catalog`, { headers, timeout: 15000 }).catch(e => ({ _err: e })),
            axios.get(`${CENTRAL_ONE_BASE_URL}/player/validate/coverage`, { headers, timeout: 12000 }).catch(e => ({ _err: e })),
            obtenerMapaVinculadosTiendaKZ(settings)
        ]);

        if (!settings.centralOneSync) settings.centralOneSync = {};

        if (Array.isArray(settings.centralOneAlerts) && settings.centralOneAlerts.length > 0) {
            const tiposCat = ['PRICE_UP', 'PRICE_DOWN', 'OUT_OF_STOCK', 'BACK_IN_STOCK', 'REMOVED_FROM_CATALOG'];
            const vistosSet = new Set();
            const alertasLimpias = [];

            for (const al of settings.centralOneAlerts) {
                const pId = String(al.productId || '').trim();
                const sUp = String(al.sku || '').trim().toUpperCase();
                const vinc = (pId && mapaVinculados.byId.get(pId)) || (sUp && mapaVinculados.bySku.get(sUp));

                if (tiposCat.includes(al.type) && !vinc) continue;

                const claveUnica = pId || sUp || al.fixedKey || `${al.type}_${al.title}`;
                if (vistosSet.has(claveUnica)) continue;
                vistosSet.add(claveUnica);

                if (vinc) {
                    al.storeSlug = vinc.storeSlug;
                    al.storeProductName = vinc.storeProductName;
                    al.storePackageName = vinc.storePackageName;
                    al.linkedLabel = vinc.label;
                }
                alertasLimpias.push(al);
            }
            settings.centralOneAlerts = alertasLimpias;
            settings.markModified('centralOneAlerts');
        }

        if (!resBalance._err && resBalance.data) {
            const b = resBalance.data;
            settings.centralOneSync.availableBalance = String(b.available_balance || '0.0000');
            settings.centralOneSync.heldBalance = String(b.held_balance || '0.0000');
            settings.centralOneSync.totalBalance = String(b.total_balance || '0.0000');
            settings.centralOneSync.currency = b.currency || 'USD';
            settings.centralOneSync.apiConnected = true;
            settings.centralOneSync.lastError = '';
        } else if (resBalance._err) {
            const errCode = resBalance._err?.response?.data?.error?.code || resBalance._err?.message || 'Error de conexión';
            settings.centralOneSync.lastError = `Balance API: ${errCode}`;
        }

        if (!resCatalog._err && Array.isArray(resCatalog.data?.items)) {
            const nuevosItems = resCatalog.data.items;
            const viejosMap = {};
            (settings.centralOneCatalogCache || []).forEach(oldIt => {
                if (oldIt && oldIt.product_id) viejosMap[oldIt.product_id] = oldIt;
            });

            if (Object.keys(viejosMap).length > 0) {
                const nuevosIdsSet = new Set(nuevosItems.map(x => x.product_id));

                for (const item of nuevosItems) {
                    const skuUp = String(item.sku || '').trim().toUpperCase();
                    const vinc = mapaVinculados.byId.get(item.product_id) || mapaVinculados.bySku.get(skuUp);
                    if (!vinc) continue;

                    const prev = viejosMap[item.product_id];
                    if (!prev) continue;

                    const pNuevo = Number(item.reseller_price || 0);
                    const pViejo = Number(prev.reseller_price || 0);
                    if (pNuevo > 0 && pViejo > 0 && Math.abs(pNuevo - pViejo) >= 0.0005) {
                        const subio = pNuevo > pViejo;
                        await registrarAlertaCentralOne(settings, {
                            type: subio ? 'PRICE_UP' : 'PRICE_DOWN',
                            severity: subio ? 'WARN' : 'OK',
                            title: `${subio ? '📈 Subió' : '📉 Bajó'} costo en [${vinc.label}]`,
                            detail: `Proveedor (${item.name} • SKU ${item.sku}): pasó de $${formatear4Decimales(pViejo)} a $${formatear4Decimales(pNuevo)} USD. Precio de venta recalculado con tu ganancia fija.`,
                            sku: item.sku,
                            productId: item.product_id,
                            oldPrice: formatear4Decimales(pViejo),
                            newPrice: formatear4Decimales(pNuevo)
                        }, mapaVinculados);
                    }

                    const stockNuevo = Boolean(item.in_stock && item.status === 'active');
                    const stockViejo = Boolean(prev.in_stock && prev.status === 'active');
                    if (stockViejo && !stockNuevo) {
                        await registrarAlertaCentralOne(settings, {
                            type: 'OUT_OF_STOCK',
                            severity: 'CRIT',
                            title: `🚫 Sin stock en proveedor: [${vinc.label}]`,
                            detail: `El SKU ${item.sku} (${item.name}) cambió a in_stock: false en Central One.`,
                            sku: item.sku,
                            productId: item.product_id
                        }, mapaVinculados);
                    } else if (!stockViejo && stockNuevo) {
                        await registrarAlertaCentralOne(settings, {
                            type: 'BACK_IN_STOCK',
                            severity: 'OK',
                            title: `🟢 Volvió el stock: [${vinc.label}]`,
                            detail: `El SKU ${item.sku} (${item.name}) está nuevamente disponible ($${formatear4Decimales(pNuevo)} USD).`,
                            sku: item.sku,
                            productId: item.product_id
                        }, mapaVinculados);
                    }
                }

                for (const [vincId, vincMeta] of mapaVinculados.byId.entries()) {
                    if (viejosMap[vincId] && !nuevosIdsSet.has(vincId)) {
                        const oldIt = viejosMap[vincId];
                        await registrarAlertaCentralOne(settings, {
                            type: 'REMOVED_FROM_CATALOG',
                            severity: 'CRIT',
                            title: `❌ Retirado/Suspendido en proveedor: [${vincMeta.label}]`,
                            detail: `El producto ${oldIt.sku} (${oldIt.name}) ya no aparece habilitado en tu catálogo de Central One.`,
                            sku: oldIt.sku,
                            productId: vincId
                        }, mapaVinculados);
                    }
                }
            }

            settings.centralOneCatalogCache = nuevosItems;
            settings.centralOneSync.catalogCount = nuevosItems.length;
            settings.centralOneSync.apiConnected = true;
            settings.centralOneSync.lastSyncAt = new Date();
            settings.markModified('centralOneCatalogCache');
        }

        if (!resCoverage._err && resCoverage.data) {
            settings.centralOneCoverageCache = resCoverage.data;
            settings.markModified('centralOneCoverageCache');
        }

        settings.markModified('centralOneSync');
        await recalcularPreciosYAlgoritmoTiendaKZ(settings);

        return {
            success: true,
            sync: settings.centralOneSync,
            catalogCount: (settings.centralOneCatalogCache || []).length
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

setInterval(() => {
    if (process.env.CENTRAL_ONE_API_KEY) {
        sincronizarTodoConCentralOne().catch(() => {});
    }
}, 15 * 60 * 1000);

setTimeout(() => {
    if (process.env.CENTRAL_ONE_API_KEY) {
        sincronizarTodoConCentralOne().catch(() => {});
    }
}, 6000);

// 🏷️ Formatea el código agregándole "Steam Wallet X,XX$ ➔ " si pertenece al pool de Steam
function formatearCodigoConEtiquetaSteam(codeStr, amountUSD, esSteam = true) {
    const limpio = String(codeStr || '').trim();
    if (!limpio) return '';
    if (limpio.toLowerCase().includes('steam wallet')) return limpio;
    const num = Number(amountUSD) || 0;
    if (!esSteam || num <= 0) return limpio;
    const montoComa = num.toFixed(2).replace('.', ',');
    return `Steam Wallet ${montoComa}$ ➔ ${limpio}`;
}

// 🔎 CONSULTAR ESTADO DETALLADO Y CÓDIGOS POR LÍNEA EN CENTRAL ONE (`GET /orders/{id}` y `GET /orders/{id}/codes`)
async function verificarYExtraerEntregaCentralOne(coOrderId, headers, poolCards = null, esSteamOrder = false, fallbackUnitUSD = 0) {
    const resOrder = await axios.get(`${CENTRAL_ONE_BASE_URL}/orders/${encodeURIComponent(coOrderId)}`, {
        headers,
        timeout: 12000
    });
    const coOrder = resOrder.data?.order;
    if (!coOrder) return { state: 'PROCESSING', deliveredCardsCount: 0, totalCardsRequested: 1 };

    const st = String(coOrder.status || '').toLowerCase();
    const lines = Array.isArray(coOrder.items) ? coOrder.items : [];
    const totalDeliveredCount = lines.reduce((acc, l) => acc + (Number(l.delivered_count) || 0), 0);
    const totalRequestedCount = lines.reduce((acc, l) => acc + (Number(l.quantity) || 1), 0);

    let codigosPlanos = [];
    let codigosPorItem = [];

    if (totalDeliveredCount > 0 && (st === 'completed' || st === 'partially_completed' || st === 'processing' || st === 'confirmed')) {
        try {
            const resCodes = await axios.get(`${CENTRAL_ONE_BASE_URL}/orders/${encodeURIComponent(coOrderId)}/codes`, {
                headers,
                timeout: 12000
            });
            const codeItems = resCodes.data?.order?.items || [];
            codeItems.forEach(ci => {
                if (Array.isArray(ci.codes) && ci.codes.length > 0) {
                    const catId = ci.catalog_item_id || ci.product_id || '';
                    const skuUp = String(ci.sku || '').trim().toUpperCase();
                    let unitUsdCard = fallbackUnitUSD;

                    if (Array.isArray(poolCards) && poolCards.length > 0) {
                        const matchCard = poolCards.find(c =>
                            (catId && c.centralOneProductId === catId) ||
                            (skuUp && String(c.centralOneSku || '').trim().toUpperCase() === skuUp)
                        );
                        if (matchCard && Number(matchCard.effectiveClientUSD) > 0) {
                            unitUsdCard = Number(matchCard.effectiveClientUSD);
                        }
                    }

                    const codigosFormateadosItem = ci.codes.map(cStr =>
                        formatearCodigoConEtiquetaSteam(cStr, unitUsdCard, esSteamOrder)
                    );

                    codigosPorItem.push({
                        catalogItemId: catId,
                        codes: codigosFormateadosItem,
                        rawCodes: ci.codes
                    });
                    codigosFormateadosItem.forEach(cStr => codigosPlanos.push(cStr));
                }
            });
        } catch (errCodes) {}
    }

    if (st === 'completed') {
        const textoFinal = codigosPlanos.length > 0
            ? codigosPlanos.join('  |  ')
            : `PEDIDO COMPLETADO (${coOrder.reference_code || 'OK'})`;

        return {
            state: 'COMPLETED',
            deliveredCode: textoFinal,
            codigosPlanos,
            codigosPorItem,
            deliveredCardsCount: totalDeliveredCount,
            totalCardsRequested: totalRequestedCount,
            referenceCode: coOrder.reference_code || coOrderId,
            raw: coOrder
        };
    }

    if (st === 'partially_completed') {
        const failedCatalogIds = lines
            .filter(l => (Number(l.delivered_count) || 0) < (Number(l.quantity) || 1))
            .map(l => l.catalog_item_id || l.product_id)
            .filter(Boolean);

        return {
            state: 'PARTIAL_REFUNDED',
            codigosPlanos,
            codigosPorItem,
            failedCatalogIds,
            deliveredCardsCount: totalDeliveredCount,
            totalCardsRequested: totalRequestedCount,
            referenceCode: coOrder.reference_code || coOrderId,
            raw: coOrder
        };
    }

    if (st === 'failed' || st === 'cancelled') {
        const firstFailedLine = lines.find(l => l.failure) || {};
        const failureInfo = firstFailedLine.failure || coOrder.failure || {};
        const failedCatalogIds = lines.map(l => l.catalog_item_id || l.product_id).filter(Boolean);
        return {
            state: 'FAILED',
            failedCatalogIds,
            failureCode: failureInfo.code || 'unknown',
            failureAction: failureInfo.action || 'contact_support',
            errorMsg: failureInfo.message_es || failureInfo.message || 'La orden fue reembolsada por el proveedor.',
            raw: coOrder
        };
    }

    return {
        state: 'PROCESSING',
        codigosPlanos,
        codigosPorItem,
        deliveredCardsCount: totalDeliveredCount,
        totalCardsRequested: totalRequestedCount,
        referenceCode: coOrder.reference_code || coOrderId,
        raw: coOrder
    };
}

// ⏱️ VIGILANTE PASO A PASO: ESPERA A QUE LAS TARJETAS SE ENTREGUEN O SE REEMBOLSEN PARA REEMPLAZARLAS AUTOMÁTICAMENTE
const activeCentralOnePollers = new Map();

function programarSeguimientoOrdenCentralOne(orderIdKZ, coOrderId, fallbackIdempKey = null, fallbackBodyOrder = null) {
    if (!orderIdKZ || activeCentralOnePollers.has(orderIdKZ)) return;
    const inicioMs = Date.now();
    let currentCoOrderId = coOrderId || '';

    const cicloRevision = async () => {
        try {
            const headers = obtenerHeadersCentralOne();
            if (!headers) {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }
            const ordenDB = await Order.findOne({ orderId: orderIdKZ });
            if (!ordenDB || ordenDB.status === 'ENTREGADO') {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            if (!currentCoOrderId && ordenDB.apiOrderId && !ordenDB.apiOrderId.startsWith('kz-ord-')) {
                currentCoOrderId = ordenDB.apiOrderId;
            }
            if (!currentCoOrderId && fallbackIdempKey && fallbackBodyOrder) {
                try {
                    const headersIdemp = obtenerHeadersCentralOne({ 'Idempotency-Key': fallbackIdempKey });
                    const resRec = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, fallbackBodyOrder, {
                        headers: headersIdemp,
                        timeout: 20000
                    });
                    if (resRec.data?.order?.id) {
                        currentCoOrderId = resRec.data.order.id;
                        ordenDB.apiOrderId = currentCoOrderId;
                        await ordenDB.save();
                    }
                } catch (eRec) {}
            }

            if (!currentCoOrderId) {
                const transcurridoSinId = Date.now() - inicioMs;
                if (transcurridoSinId < 30 * 60 * 1000) {
                    activeCentralOnePollers.set(orderIdKZ, setTimeout(cicloRevision, 15000));
                } else {
                    activeCentralOnePollers.delete(orderIdKZ);
                }
                return;
            }

            const settings = await StoreSettings.findOne({ key: 'main_settings' });
            const poolCards = settings ? (settings.arbitrageBaseCards || []) : [];
            const esSteamOrd = String(ordenDB.productSlug || '').toLowerCase().includes('steam') ||
                               String(ordenDB.algoExecutionState?.platformGroup || '').toLowerCase() === 'steam';

            const check = await verificarYExtraerEntregaCentralOne(currentCoOrderId, headers, poolCards, esSteamOrd, 0);

            if (ordenDB.cancelledByDelayRefund || ordenDB.status === 'RECHAZADO') {
                if (check.state === 'COMPLETED' || check.state === 'PARTIAL_REFUNDED') {
                    await guardarCodigosRecuperadosEnStockInterno(ordenDB, check.codigosPorItem, check.codigosPlanos);
                    activeCentralOnePollers.delete(orderIdKZ);
                    return;
                }
                if (check.state === 'FAILED') {
                    activeCentralOnePollers.delete(orderIdKZ);
                    return;
                }
                const tCancel = Date.now() - inicioMs;
                if (tCancel < 3 * 60 * 60 * 1000) {
                    activeCentralOnePollers.set(orderIdKZ, setTimeout(cicloRevision, 45000));
                } else {
                    activeCentralOnePollers.delete(orderIdKZ);
                }
                return;
            }

            const algoState = ordenDB.algoExecutionState || null;

            // ✅ CASO A: CENTRAL ONE COMPLETÓ TODA LA ORDEN ACTUAL
            if (check.state === 'COMPLETED') {
                const codigosPrevios = (algoState && Array.isArray(algoState.deliveredCodesList)) ? algoState.deliveredCodesList : [];
                const todosLosCodigos = [...new Set([...codigosPrevios, ...(check.codigosPlanos || [])])];
                const textoFinal = todosLosCodigos.length > 0 ? todosLosCodigos.join('  |  ') : check.deliveredCode;

                ordenDB.status = 'ENTREGADO';
                ordenDB.progressPercent = 100;
                ordenDB.deliveredCode = textoFinal;
                ordenDB.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                ordenDB.completedAt = new Date();
                if (algoState) {
                    algoState.deliveredCodesList = todosLosCodigos;
                    algoState.deliveredCardsCount = algoState.totalCardsExpected || todosLosCodigos.length;
                    ordenDB.algoExecutionState = algoState;
                    ordenDB.markModified('algoExecutionState');
                }
                await ordenDB.save();
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            // 🔄 CASO B: ENTREGA PARCIAL CON REEMBOLSO DE FALTANTES O FALLO/REEMBOLSO EN ALGORITMO
            if ((check.state === 'PARTIAL_REFUNDED' || check.state === 'FAILED') && algoState && algoState.isAlgorithmOrder) {
                if (check.state === 'PARTIAL_REFUNDED' && Array.isArray(check.codigosPorItem)) {
                    for (const cItem of check.codigosPorItem) {
                        const cardMatch = poolCards.find(c => c.centralOneProductId === cItem.catalogItemId);
                        const unitUsd = cardMatch ? Number(cardMatch.effectiveClientUSD || 0) : 0;
                        const unitCost = cardMatch ? Number(cardMatch.costUSD || 0) : 0;
                        for (const codeStr of (cItem.codes || [])) {
                            if (!algoState.deliveredCodesList.includes(codeStr)) {
                                algoState.deliveredCodesList.push(codeStr);
                                algoState.deliveredClientUSD = Number(((algoState.deliveredClientUSD || 0) + unitUsd).toFixed(2));
                                algoState.deliveredCostUSD = Number(((algoState.deliveredCostUSD || 0) + unitCost).toFixed(4));
                            }
                        }
                    }
                }

                if (!Array.isArray(algoState.failedCardIds)) algoState.failedCardIds = [];
                (check.failedCatalogIds || []).forEach(catId => {
                    const cardFailed = poolCards.find(c => c.centralOneProductId === catId);
                    if (cardFailed && !algoState.failedCardIds.includes(cardFailed.cardId)) {
                        algoState.failedCardIds.push(cardFailed.cardId);
                    }
                });

                const saldoFaltanteUSD = Number(((algoState.targetClientUSD || 0) - (algoState.deliveredClientUSD || 0)).toFixed(2));

                if (saldoFaltanteUSD <= 0.05 && algoState.deliveredCodesList.length > 0) {
                    ordenDB.status = 'ENTREGADO';
                    ordenDB.progressPercent = 100;
                    ordenDB.deliveredCode = algoState.deliveredCodesList.join('  |  ');
                    ordenDB.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                    ordenDB.completedAt = new Date();
                    ordenDB.algoExecutionState = algoState;
                    ordenDB.markModified('algoExecutionState');
                    await ordenDB.save();
                    activeCentralOnePollers.delete(orderIdKZ);
                    return;
                }

                let comboReemplazo = calcularMejorCombinacionTarjetasPool(
                    saldoFaltanteUSD,
                    algoState.platformGroup || 'steam',
                    poolCards,
                    settings ? settings.centralOneCatalogCache : null,
                    algoState.failedCardIds
                );

                if (!comboReemplazo.hasSolution && (algoState.retryAttempt || 0) < 2) {
                    comboReemplazo = calcularMejorCombinacionTarjetasPool(
                        saldoFaltanteUSD,
                        algoState.platformGroup || 'steam',
                        poolCards,
                        settings ? settings.centralOneCatalogCache : null,
                        []
                    );
                }

                const costoAcumuladoConReemplazo = (Number(algoState.deliveredCostUSD) || 0) + (comboReemplazo.hasSolution ? Number(comboReemplazo.totalCostUSD) : 9999);
                const sigueConSaldoPositivo = costoAcumuladoConReemplazo <= (Number(ordenDB.totalAmountUSD) + 0.05);

                if (comboReemplazo.hasSolution && sigueConSaldoPositivo && (algoState.retryAttempt || 0) < 3) {
                    algoState.retryAttempt = (algoState.retryAttempt || 0) + 1;
                    const idempRetry = `kz-ord-${ordenDB.orderId}-rep-${algoState.retryAttempt}-${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, '');
                    const headersRetry = obtenerHeadersCentralOne({ 'Idempotency-Key': idempRetry });
                    const bodyRetry = {
                        items: comboReemplazo.items.map(it => ({
                            catalog_item_id: it.centralOneProductId,
                            quantity: Math.max(1, Math.round(Number(it.quantity) || 1))
                        })),
                        note: `KemZone Reemplazo #${ordenDB.orderId} (${comboReemplazo.summaryText})`.slice(0, 480)
                    };

                    try {
                        const resRetry = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, bodyRetry, {
                            headers: headersRetry,
                            timeout: 30000
                        });

                        const newCoOrder = resRetry.data?.order;
                        if (newCoOrder && newCoOrder.id) {
                            algoState.deliveredCardsCount = algoState.deliveredCodesList.length;
                            algoState.totalCardsExpected = algoState.deliveredCodesList.length + comboReemplazo.totalCards;
                            ordenDB.apiOrderId = newCoOrder.id;
                            ordenDB.algoExecutionState = algoState;
                            ordenDB.statusMessage = `Reemplazando automáticamente ${comboReemplazo.totalCards} tarjeta(s) liberadas para completar tu entrega...`;
                            ordenDB.markModified('algoExecutionState');
                            await ordenDB.save();

                            activeCentralOnePollers.delete(orderIdKZ);
                            programarSeguimientoOrdenCentralOne(orderIdKZ, newCoOrder.id, idempRetry, bodyRetry);
                            return;
                        }
                    } catch (errRep) {
                        const esTimeoutRep = errRep.code === 'ECONNABORTED' || String(errRep.message || '').toLowerCase().includes('timeout');
                        if (esTimeoutRep) {
                            activeCentralOnePollers.delete(orderIdKZ);
                            programarSeguimientoOrdenCentralOne(orderIdKZ, null, idempRetry, bodyRetry);
                            return;
                        }
                    }
                }
            }

            // ❌ CASO C: FALLO DEFINITIVO
            if (check.state === 'FAILED' || check.state === 'PARTIAL_REFUNDED') {
                ordenDB.status = 'ERROR_API';
                ordenDB.statusMessage = 'Pago verificado. Nuestro sistema está completando la liberación de tu pedido.';
                await ordenDB.save();
                await registrarAlertaCentralOne(settings, {
                    type: 'ORDER_FAILED',
                    severity: 'CRIT',
                    title: `🚨 Orden #${ordenDB.orderId} requiere atención (${check.failureCode || 'reembolso parcial'})`,
                    detail: `${ordenDB.productName} (${ordenDB.packageName}): ${check.errorMsg || 'Ítem reembolsado por Central One.'}`
                });
                if (settings) await settings.save();
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            // ⏳ CASO D: SIGUE EN ESPERA EN CENTRAL ONE
            if (algoState && check.deliveredCardsCount !== undefined) {
                const prevCount = (algoState.deliveredCodesList ? algoState.deliveredCodesList.length : 0) + Number(check.deliveredCardsCount || 0);
                if (algoState.deliveredCardsCount !== prevCount) {
                    algoState.deliveredCardsCount = prevCount;
                    ordenDB.algoExecutionState = algoState;
                    ordenDB.markModified('algoExecutionState');
                    await ordenDB.save();
                }
            }

            const transcurridoMs = Date.now() - inicioMs;
            if (transcurridoMs > 3 * 60 * 60 * 1000) {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }
            const proximoIntervalo = transcurridoMs < (10 * 60 * 1000) ? 15000 : 60000;
            const timerId = setTimeout(cicloRevision, proximoIntervalo);
            activeCentralOnePollers.set(orderIdKZ, timerId);
        } catch (e) {
            const timerId = setTimeout(cicloRevision, 25000);
            activeCentralOnePollers.set(orderIdKZ, timerId);
        }
    };

    const firstTimer = setTimeout(cicloRevision, 12000);
    activeCentralOnePollers.set(orderIdKZ, firstTimer);
}

// 📈 TABLA OFICIAL DE GANANCIAS MÍNIMAS POR RANGO PARA LA CALCULADORA DE JUEGOS DE STEAM
const RANGOS_GANANCIA_STEAM_CALC = [
    { min: 0.01,   max: 1.40,   fee: 0.25 },
    { min: 1.41,   max: 2.90,   fee: 0.40 },
    { min: 2.91,   max: 3.90,   fee: 0.75 },
    { min: 3.91,   max: 9.90,   fee: 1.00 },
    { min: 9.91,   max: 14.90,  fee: 1.40 },
    { min: 14.91,  max: 19.90,  fee: 2.05 },
    { min: 19.91,  max: 29.90,  fee: 2.70 },
    { min: 29.91,  max: 39.90,  fee: 3.30 },
    { min: 39.91,  max: 49.90,  fee: 3.90 },
    { min: 49.91,  max: 59.90,  fee: 4.50 },
    { min: 59.91,  max: 69.90,  fee: 5.20 },
    { min: 69.91,  max: 79.90,  fee: 5.90 },
    { min: 79.91,  max: 89.90,  fee: 6.60 },
    { min: 89.91,  max: 99.90,  fee: 7.25 },
    { min: 99.91,  max: 199.90, fee: 7.90 },
    { min: 199.91, max: 299.90, fee: 15.80 },
    { min: 299.91, max: 399.90, fee: 23.70 },
    { min: 399.91, max: 499.90, fee: 31.60 }
];

function obtenerGananciaRangoSteamServer(precioUsd) {
    const p = Math.round((Number(precioUsd) + Number.EPSILON) * 100) / 100;
    if (p <= 0) return 0;
    for (const r of RANGOS_GANANCIA_STEAM_CALC) {
        if (p >= r.min && p <= r.max) return r.fee;
    }
    if (p >= 99.91) {
        const bloques = Math.floor((Math.round((p - 99.91) * 100) / 100) / 100) + 1;
        return Math.round((bloques * 7.90 + Number.EPSILON) * 100) / 100;
    }
    return 0.25;
}

// 🚀 EJECUTOR PRINCIPAL DE ENTREGA (USA STOCK INTERNO PRIMERO + ALGORITMO PASO A PASO + CENTRAL ONE API)
async function ejecutarEntregaPorAPI(orden, productoDB) {
    orden.timerStartedAt = new Date();

    if (!productoDB && orden.productSlug === 'calculadora-steam') {
        const metaSteam = Number(orden.algoExecutionState?.targetClientUSD || orden.baseAmountUSD || 5);
        productoDB = {
            slug: 'calculadora-steam',
            name: orden.productName || 'Compra tus Juegos de Steam',
            isSmartCodeProduct: true,
            smartPlatformGroup: 'steam',
            packages: [{
                packageId: orden.packageId || 'steam_calc_custom',
                name: orden.packageName || `Saldo Steam $${metaSteam.toFixed(2)} USD`,
                useSmartAlgorithm: true,
                targetClientUSD: metaSteam,
                isGiftCardPin: true
            }],
            save: async () => {}
        };
    }

    if (orden.fulfillmentType === 'MANUAL_INTERNAL') {
        return {
            success: true,
            deliveredCode: 'PEDIDO INTERNO COMPLETADO EN TU CUENTA',
            apiOrderId: 'MANUAL-INTERNAL-' + Date.now(),
            raw: { mode: 'manual_internal' }
        };
    }

    const listaPaquetes = (productoDB && productoDB.useAltPricing && Array.isArray(productoDB.altPackages) && productoDB.altPackages.length > 0)
        ? productoDB.altPackages
        : (productoDB ? productoDB.packages : []);
    const pkg = (listaPaquetes || []).find(p => p.packageId === orden.packageId);

    const settings = await StoreSettings.findOne({ key: 'main_settings' });
    const poolCards = settings ? (settings.arbitrageBaseCards || []) : [];
    const esSteamOrder = String(orden.productSlug || '').toLowerCase().includes('steam') ||
                         String((productoDB && productoDB.smartPlatformGroup) || '').toLowerCase() === 'steam';

    if (pkg && Array.isArray(pkg.backupPinVault) && pkg.backupPinVault.length > 0) {
        const pinRaw = pkg.backupPinVault.shift();
        const montoPkg = Number(pkg.targetClientUSD || pkg.priceUSD || 0);
        const pinExtraido = formatearCodigoConEtiquetaSteam(pinRaw, montoPkg, esSteamOrder);
        await productoDB.save();
        return {
            success: true,
            deliveredCode: pinExtraido,
            apiOrderId: 'VAULT-' + Date.now(),
            raw: { source: 'backup_pin_vault' }
        };
    }

    const headersBase = obtenerHeadersCentralOne();

    if (headersBase && orden.apiOrderId && !orden.apiOrderId.startsWith('VAULT-') && !orden.apiOrderId.startsWith('INTERNAL-') && !orden.apiOrderId.startsWith('API-') && !orden.apiOrderId.startsWith('kz-ord-')) {
        try {
            const checkPrev = await verificarYExtraerEntregaCentralOne(orden.apiOrderId, headersBase, poolCards, esSteamOrder, 0);
            if (checkPrev.state === 'COMPLETED') {
                return {
                    success: true,
                    deliveredCode: checkPrev.deliveredCode,
                    apiOrderId: orden.apiOrderId,
                    raw: checkPrev.raw
                };
            }
            if (checkPrev.state === 'PROCESSING') {
                programarSeguimientoOrdenCentralOne(orden.orderId, orden.apiOrderId);
                return {
                    success: true,
                    isProcessingAsync: true,
                    deliveredCode: '',
                    apiOrderId: orden.apiOrderId,
                    raw: checkPrev.raw
                };
            }
        } catch (ePrev) {}
    }

    if (headersBase) {
        const usaAlgoritmo = Boolean((productoDB && productoDB.isSmartCodeProduct) || (pkg && pkg.useSmartAlgorithm));

        // 🧠 CASO A: PRODUCTO CON ALGORITMO INTELIGENTE DE CÓDIGOS
        if (usaAlgoritmo && pkg && Number(pkg.targetClientUSD) > 0) {
            const platGroup = (productoDB && productoDB.smartPlatformGroup) || 'steam';
            const esSteamPool = String(platGroup).toLowerCase() === 'steam' || esSteamOrder;
            const excluidosFallidos = [];

            for (let intento = 1; intento <= 2; intento++) {
                const combo = calcularMejorCombinacionTarjetasPool(
                    pkg.targetClientUSD,
                    platGroup,
                    poolCards,
                    settings ? settings.centralOneCatalogCache : null,
                    excluidosFallidos
                );

                if (!combo.hasSolution) {
                    await registrarAlertaCentralOne(settings, {
                        type: 'ALGO_NO_SOLUTION',
                        severity: 'CRIT',
                        title: `🚨 Orden #${orden.orderId} sin combinación disponible (${platGroup.toUpperCase()})`,
                        detail: combo.reason || 'No hay tarjetas base con stock para cubrir el monto.'
                    });
                    if (settings) await settings.save();
                    return { success: false, errorMsg: combo.reason || 'Sin stock en tarjetas base del algoritmo.' };
                }

                const codigosDesdeStockInterno = [];
                let usdCubiertoInterno = 0;
                let costoCubiertoInterno = 0;
                const itemsParaPedirCentralOne = [];
                let usoStockInterno = false;

                for (const it of combo.items) {
                    let cantFaltante = Math.max(1, Math.round(Number(it.quantity) || 1));
                    const cPool = poolCards.find(c => c.cardId === it.cardId);

                    while (cantFaltante > 0 && cPool && Array.isArray(cPool.internalCodeStock) && cPool.internalCodeStock.length > 0) {
                        const codigoGuardado = cPool.internalCodeStock.shift();
                        if (codigoGuardado) {
                            const codigoConEtiqueta = formatearCodigoConEtiquetaSteam(codigoGuardado, it.unitClientUSD, esSteamPool);
                            codigosDesdeStockInterno.push(codigoConEtiqueta);
                            usdCubiertoInterno = Number((usdCubiertoInterno + Number(it.unitClientUSD)).toFixed(2));
                            costoCubiertoInterno = Number((costoCubiertoInterno + Number(it.unitCostUSD)).toFixed(4));
                            cantFaltante--;
                            usoStockInterno = true;
                        }
                    }

                    if (cantFaltante > 0) {
                        itemsParaPedirCentralOne.push({
                            ...it,
                            quantity: cantFaltante
                        });
                    }
                }

                if (usoStockInterno && settings) {
                    settings.markModified('arbitrageBaseCards');
                    await settings.save();
                }

                if (itemsParaPedirCentralOne.length === 0 && codigosDesdeStockInterno.length > 0) {
                    return {
                        success: true,
                        deliveredCode: codigosDesdeStockInterno.join('  |  '),
                        apiOrderId: 'INTERNAL-VAULT-' + Date.now(),
                        raw: { source: 'internal_recovered_stock', combo: combo.summaryText }
                    };
                }

                const itemsSinId = itemsParaPedirCentralOne.filter(it => !it.centralOneProductId);
                if (itemsSinId.length > 0) {
                    return {
                        success: false,
                        errorMsg: `La tarjeta base "${itemsSinId[0].name}" no tiene asignado su producto de Central One.`
                    };
                }

                const idempKey = `kz-ord-${orden.orderId}-algo-v${intento}`.replace(/[^A-Za-z0-9_-]/g, '');
                const headersOrder = obtenerHeadersCentralOne({ 'Idempotency-Key': idempKey });
                const bodyOrder = {
                    items: itemsParaPedirCentralOne.map(it => ({
                        catalog_item_id: it.centralOneProductId,
                        quantity: it.quantity
                    })),
                    note: `KemZone #${orden.orderId} (${combo.summaryText})`.slice(0, 480)
                };

                orden.algoExecutionState = {
                    isAlgorithmOrder: true,
                    platformGroup: platGroup,
                    targetClientUSD: Number(pkg.targetClientUSD),
                    deliveredClientUSD: usdCubiertoInterno,
                    deliveredCostUSD: costoCubiertoInterno,
                    deliveredCodesList: [...codigosDesdeStockInterno],
                    failedCardIds: [...excluidosFallidos],
                    totalCardsExpected: combo.totalCards,
                    deliveredCardsCount: codigosDesdeStockInterno.length,
                    retryAttempt: 0
                };
                orden.markModified('algoExecutionState');

                try {
                    const resCreate = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, bodyOrder, {
                        headers: headersOrder,
                        timeout: 28000
                    });

                    const createdOrder = resCreate.data?.order;
                    if (!createdOrder || !createdOrder.id) {
                        return { success: false, errorMsg: 'Respuesta inválida al crear orden en Central One.' };
                    }

                    await new Promise(r => setTimeout(r, 1800));
                    const check = await verificarYExtraerEntregaCentralOne(createdOrder.id, headersBase, poolCards, esSteamPool, 0);

                    if (check.state === 'COMPLETED') {
                        const todosLosCodigos = [...new Set([...codigosDesdeStockInterno, ...(check.codigosPlanos || [])])];
                        orden.algoExecutionState.deliveredCodesList = todosLosCodigos;
                        orden.algoExecutionState.deliveredCardsCount = combo.totalCards;
                        return {
                            success: true,
                            deliveredCode: todosLosCodigos.length > 0 ? todosLosCodigos.join('  |  ') : check.deliveredCode,
                            apiOrderId: createdOrder.id,
                            raw: check.raw
                        };
                    }

                    if (check.state === 'FAILED' && intento === 1) {
                        itemsParaPedirCentralOne.forEach(it => excluidosFallidos.push(it.cardId));
                        continue;
                    }

                    programarSeguimientoOrdenCentralOne(orden.orderId, createdOrder.id, idempKey, bodyOrder);
                    return {
                        success: true,
                        isProcessingAsync: true,
                        deliveredCode: '',
                        apiOrderId: createdOrder.id,
                        raw: check.raw
                    };
                } catch (errCO) {
                    const errCode = errCO.response?.data?.error?.code || '';
                    const esTimeout = errCO.code === 'ECONNABORTED' || String(errCO.message || '').toLowerCase().includes('timeout');

                    if (esTimeout) {
                        programarSeguimientoOrdenCentralOne(orden.orderId, null, idempKey, bodyOrder);
                        return {
                            success: true,
                            isProcessingAsync: true,
                            deliveredCode: '',
                            apiOrderId: idempKey,
                            raw: { asyncTimeoutPending: true }
                        };
                    }

                    if (errCode === 'insufficient_stock' && settings && intento === 1) {
                        itemsParaPedirCentralOne.forEach(it => {
                            excluidosFallidos.push(it.cardId);
                            const cPool = poolCards.find(c => c.cardId === it.cardId);
                            if (cPool) cPool.inStock = false;
                        });
                        settings.markModified('arbitrageBaseCards');
                        await settings.save();
                        continue;
                    }
                    return {
                        success: false,
                        errorMsg: errCO.response?.data?.error?.message || errCO.message
                    };
                }
            }
        }

        // ⚡ CASO B: RECARGA POR ID O CÓDIGO DIRECTO VINCULADO A CENTRAL ONE
        let coProductId = (pkg && pkg.centralOneProductId) || '';
        let coCatItem = null;
        if (settings && Array.isArray(settings.centralOneCatalogCache)) {
            if (coProductId) {
                coCatItem = settings.centralOneCatalogCache.find(x => x.product_id === coProductId);
            }
            if (!coCatItem && (orden.apiProductSku || (pkg && pkg.apiProductSku))) {
                const skuBuscado = String(orden.apiProductSku || pkg.apiProductSku).trim().toUpperCase();
                coCatItem = settings.centralOneCatalogCache.find(x => String(x.sku || '').trim().toUpperCase() === skuBuscado);
                if (coCatItem) coProductId = coCatItem.product_id;
            }
        }

        if (coProductId) {
            const idempKey = `kz-ord-${orden.orderId}-direct-v1`.replace(/[^A-Za-z0-9_-]/g, '');
            const headersOrder = obtenerHeadersCentralOne({ 'Idempotency-Key': idempKey });

            const itemPayload = {
                catalog_item_id: coProductId,
                quantity: 1
            };

            if (!coCatItem || coCatItem.requires_target !== false) {
                const targetFields = (coCatItem && Array.isArray(coCatItem.target_fields) && coCatItem.target_fields.length > 0)
                    ? coCatItem.target_fields
                    : (orden.fulfillmentType === 'API_DIRECT_TOPUP' ? ['player_id'] : []);

                if (targetFields.length > 0) {
                    const tPayload = {};
                    targetFields.forEach((fieldKey, idx) => {
                        const fkLower = String(fieldKey).toLowerCase();
                        if (fkLower.includes('server') || fkLower.includes('zone') || fkLower.includes('region')) {
                            tPayload[fieldKey] = String(orden.playerServer || orden.playerRegion || '').trim();
                        } else if (idx === 0 || fkLower.includes('player') || fkLower.includes('uid') || fkLower.includes('user') || fkLower.includes('id')) {
                            tPayload[fieldKey] = String(orden.playerUid || '').trim();
                        } else {
                            tPayload[fieldKey] = String(orden.playerServer || orden.playerRegion || orden.playerUid || '').trim();
                        }
                    });
                    itemPayload.target_payload = tPayload;
                }
            }

            const bodyDirect = {
                items: [itemPayload],
                note: `KemZone #${orden.orderId} - ${orden.productName}`.slice(0, 480)
            };

            try {
                const resCreate = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, bodyDirect, {
                    headers: headersOrder,
                    timeout: 28000
                });

                const createdOrder = resCreate.data?.order;
                if (!createdOrder || !createdOrder.id) {
                    return { success: false, errorMsg: 'Central One no devolvió ID de pedido.' };
                }

                await new Promise(r => setTimeout(r, 1800));
                const check = await verificarYExtraerEntregaCentralOne(createdOrder.id, headersBase, poolCards, esSteamOrder, Number(pkg?.targetClientUSD || 0));

                if (check.state === 'COMPLETED') {
                    return {
                        success: true,
                        deliveredCode: check.deliveredCode,
                        apiOrderId: createdOrder.id,
                        raw: check.raw
                    };
                }

                if (check.state === 'FAILED') {
                    return {
                        success: false,
                        errorMsg: `Fallo en Central One (${check.failureCode}): ${check.errorMsg}`
                    };
                }

                programarSeguimientoOrdenCentralOne(orden.orderId, createdOrder.id, idempKey, bodyDirect);
                return {
                    success: true,
                    isProcessingAsync: true,
                    deliveredCode: '',
                    apiOrderId: createdOrder.id,
                    raw: check.raw
                };
            } catch (errDirect) {
                const esTimeoutDir = errDirect.code === 'ECONNABORTED' || String(errDirect.message || '').toLowerCase().includes('timeout');
                if (esTimeoutDir) {
                    programarSeguimientoOrdenCentralOne(orden.orderId, null, idempKey, bodyDirect);
                    return {
                        success: true,
                        isProcessingAsync: true,
                        deliveredCode: '',
                        apiOrderId: idempKey,
                        raw: { asyncTimeoutPending: true }
                    };
                }

                const msgErr = errDirect.response?.data?.error?.message || errDirect.message;
                const codeErr = errDirect.response?.data?.error?.code || 'api_error';
                await registrarAlertaCentralOne(settings, {
                    type: 'ORDER_FAILED',
                    severity: 'CRIT',
                    title: `🚨 Error al enviar orden #${orden.orderId} a Central One (${codeErr})`,
                    detail: `${orden.productName} (${orden.packageName}): ${msgErr}`
                });
                if (settings) await settings.save();
                return { success: false, errorMsg: `${codeErr}: ${msgErr}` };
            }
        }
    }

    if (orden.fulfillmentType === 'API_GIFT_CARD') {
        const autoPin = orden.workerNotes && orden.workerNotes.includes('PIN:') 
            ? orden.workerNotes.replace('PIN:', '').trim()
            : `PIN-KZ-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
        return {
            success: true,
            deliveredCode: autoPin,
            apiOrderId: 'API-AUTO-' + Date.now(),
            raw: { mode: 'api_gateway_ready' }
        };
    }

    return {
        success: true,
        deliveredCode: `PEDIDO ACREDITADO A: ${orden.playerUid}`,
        apiOrderId: 'API-TOPUP-' + Date.now(),
        raw: { mode: 'api_topup_ready' }
    };
}

// ⏳ ENDPOINT DE DECISIÓN DEL CLIENTE TRAS 30 MINUTOS DE ESPERA ('WAIT' vs 'REFUND')
app.post('/api/orders/delay-choice', cors(), express.json(), async (req, res) => {
    try {
        const { orderId, choice, deviceId, userEmail, userName, userWhatsapp } = req.body;
        if (!orderId || !choice) return res.status(400).json({ error: 'Faltan parámetros.' });

        const idLimpio = String(orderId).trim().toUpperCase();
        const orden = await Order.findOne({ orderId: idLimpio });
        if (!orden) return res.status(404).json({ error: 'Pedido no encontrado.' });

        if (orden.status === 'ENTREGADO') {
            return res.json({ success: true, order: orden, message: 'Tu pedido ya fue entregado.' });
        }

        // OPCIÓN 1: EL CLIENTE ELIGE SEGUIR ESPERANDO
        if (choice === 'WAIT') {
            orden.timerStartedAt = new Date();
            orden.clientChoseToWait = true;
            orden.statusMessage = '⏳ Seguimiento prioritario activado: Nuestro sistema continúa gestionando la entrega automática de tu compra...';
            await orden.save();
            return res.json({ success: true, order: orden });
        }

        // OPCIÓN 2: EL CLIENTE ELIGE SOLICITAR REEMBOLSO Y ABRIR TICKET AUTOMÁTICO EN CHAT
        if (choice === 'REFUND') {
            orden.cancelledByDelayRefund = true;
            orden.status = 'RECHAZADO';
            orden.progressPercent = 100;

            // Si el algoritmo ya tenía códigos parciales retenidos, guardarlos en el Stock Interno de la Bóveda para no perderlos
            const codigosParciales = (orden.algoExecutionState && Array.isArray(orden.algoExecutionState.deliveredCodesList))
                ? orden.algoExecutionState.deliveredCodesList
                : [];
            if (codigosParciales.length > 0) {
                await guardarCodigosRecuperadosEnStockInterno(orden, [], codigosParciales);
                orden.algoExecutionState.deliveredCodesList = [];
                orden.markModified('algoExecutionState');
            }

            // Si pagó con Tokems KZ, reembolsar automáticamente a su billetera
            if (orden.paidWithTokems && orden.tokemsAmount > 0) {
                if (orden.deviceId.includes('@')) {
                    await User.updateOne({ email: orden.deviceId }, { $inc: { tokems: orden.tokemsAmount } });
                } else {
                    await Balance.updateOne({ deviceId: orden.deviceId }, { $inc: { tokens: orden.tokemsAmount } });
                }
            }

            const ticketId = 'TK-' + crypto.randomInt(10000, 99999).toString();
            const identificador = (userEmail || orden.userEmail || deviceId || orden.deviceId || 'invitado').trim().toLowerCase();
            const nombreCliente = (userName || (identificador.includes('@') ? identificador.split('@')[0] : 'Cliente')).trim();
            const wsFinal = (userWhatsapp || orden.userWhatsapp || '').trim();

            const montoTexto = `${orden.paymentReference || 'Tokems'} ($${Number(orden.totalAmountUSD || 0).toFixed(2)} USD / Bs. ${Number(orden.totalAmountVES || 0).toFixed(2)})`;
            const mensajeAuto = `⏱️ SOLICITUD AUTOMÁTICA DE REEMBOLSO (+30 MIN DE ESPERA):\n` +
                `• Pedido cancelado: #${orden.orderId}\n` +
                `• Producto: ${orden.productName} (${orden.packageName})\n` +
                `• Método de pago: ${orden.paymentMethodName}\n` +
                `• Referencia y Monto: ${montoTexto}\n` +
                `• Destino / ID: ${orden.playerUid}\n` +
                `El pedido superó los 30 minutos de espera y solicito el reembolso de mi compra.`;

            const nuevoTicket = await new SupportTicket({
                ticketId,
                orderId: orden.orderId,
                deviceId: identificador,
                userEmail: orden.userEmail || (identificador.includes('@') ? identificador : ''),
                userName: nombreCliente,
                userWhatsapp: wsFinal,
                subject: `Reembolso por retraso (+30 min) - Orden #${orden.orderId}`,
                category: `Reembolso por espera (+30 min) • #${orden.orderId}`,
                gameName: `${orden.productName} (${orden.packageName})`,
                paymentMethod: orden.paymentMethodName || orden.paymentMethodKey,
                paymentReference: montoTexto,
                playerUid: orden.playerUid || '',
                status: 'ABIERTO',
                messages: [{
                    senderRole: 'client',
                    senderName: nombreCliente,
                    text: mensajeAuto,
                    attachmentUrl: ''
                }]
            }).save();

            orden.refundTicketId = ticketId;
            orden.workerNotes = `Pedido cancelado por el cliente tras 30 min de espera. Solicitud de reembolso abierta en Ticket #${ticketId}.`;
            orden.statusMessage = `Pedido cancelado a solicitud del cliente. Se abrió el chat de reembolso en el Ticket #${ticketId}.`;
            orden.completedAt = new Date();
            await orden.save();

            return res.json({
                success: true,
                order: orden,
                ticket: nuevoTicket
            });
        }

        return res.status(400).json({ error: 'Opción no válida.' });
    } catch (error) {
        console.error('Error en /api/orders/delay-choice:', error);
        return res.status(500).json({ error: 'Error procesando solicitud de retraso.' });
    }
});

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

// =================================================================
// 🔔 WEBHOOK OFICIAL DE CENTRAL ONE (FIRMA HMAC-SHA256 + CUERPO CRUDO)
// =================================================================
function verificarFirmaWebhookCentralOne(secreto, timestamp, cuerpoCrudoBuffer, firmaRecibida) {
    if (!secreto || !timestamp || !cuerpoCrudoBuffer || !firmaRecibida) return false;
    try {
        const esperada = 'sha256=' + crypto.createHmac('sha256', secreto.trim())
            .update(`${timestamp}.${cuerpoCrudoBuffer.toString('utf8')}`)
            .digest('hex');
        const bufA = Buffer.from(esperada);
        const bufB = Buffer.from(String(firmaRecibida).trim());
        return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
    } catch (e) {
        return false;
    }
}

app.post('/webhooks/central-one', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const timestamp = req.header('X-CentralOne-Timestamp') || '';
        const signature = req.header('X-CentralOne-Signature') || '';
        const signaturePrev = req.header('X-CentralOne-Signature-Previous') || '';
        const secret = process.env.CENTRAL_ONE_WEBHOOK_SECRET || '';
        const prevSecret = process.env.CENTRAL_ONE_WEBHOOK_SECRET_PREVIOUS || '';

        // 1. Validar antigüedad máxima de 5 minutos (300 segundos) como exige Central One
        if (timestamp) {
            const ahoraSeg = Math.floor(Date.now() / 1000);
            const tsNum = parseInt(timestamp, 10);
            if (!isNaN(tsNum) && Math.abs(ahoraSeg - tsNum) > 320) {
                return res.status(401).json({ error: 'Timestamp fuera de ventana de 5 minutos.' });
            }
        }

        // 2. Verificar firma HMAC-SHA256 sobre el cuerpo crudo
        if (secret) {
            const firmaValida = verificarFirmaWebhookCentralOne(secret, timestamp, req.body, signature) ||
                                (prevSecret && signaturePrev && verificarFirmaWebhookCentralOne(prevSecret, timestamp, req.body, signaturePrev));
            if (!firmaValida) {
                return res.status(401).json({ error: 'Firma de Central One inválida.' });
            }
        }

        const payload = JSON.parse(req.body.toString('utf8'));
        const eventId = req.header('X-CentralOne-Event-Id') || payload.event_id || '';
        const eventName = req.header('X-CentralOne-Event') || payload.event || '';

        // Confirmar 200 OK de inmediato en menos de 10 segundos y procesar enseguida
        res.status(200).json({ received: true, event_id: eventId });

        let settings = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settings) settings = new StoreSettings({ key: 'main_settings' });

        // Deduplicar por event_id
        if (eventId && Array.isArray(settings.processedWebhookIds) && settings.processedWebhookIds.includes(eventId)) {
            return;
        }
        if (eventId) {
            if (!Array.isArray(settings.processedWebhookIds)) settings.processedWebhookIds = [];
            settings.processedWebhookIds.unshift(eventId);
            if (settings.processedWebhookIds.length > 300) {
                settings.processedWebhookIds = settings.processedWebhookIds.slice(0, 300);
            }
            settings.markModified('processedWebhookIds');
        }

        // A. Eventos de Catálogo: product.price_changed y product.stock_changed
        if ((eventName === 'product.price_changed' || eventName === 'product.stock_changed') && Array.isArray(payload.products)) {
            if (!Array.isArray(settings.centralOneCatalogCache)) settings.centralOneCatalogCache = [];

            for (const pChange of payload.products) {
                const idx = settings.centralOneCatalogCache.findIndex(x => x.product_id === pChange.product_id);
                if (pChange.in_catalog === false) {
                    if (idx !== -1) settings.centralOneCatalogCache.splice(idx, 1);
                    await registrarAlertaCentralOne(settings, {
                        type: 'REMOVED_FROM_CATALOG',
                        severity: 'CRIT',
                        title: `❌ Retirado de tu catálogo Central One: ${pChange.name}`,
                        detail: `SKU ${pChange.sku} salió del catálogo (in_catalog: false).`,
                        sku: pChange.sku,
                        productId: pChange.product_id
                    });
                } else {
                    if (idx !== -1) {
                        settings.centralOneCatalogCache[idx] = {
                            ...settings.centralOneCatalogCache[idx],
                            reseller_price: pChange.reseller_price,
                            in_stock: pChange.in_stock,
                            available_stock: pChange.available_stock,
                            price_updated_at: pChange.price_updated_at || new Date().toISOString()
                        };
                    }
                    if (eventName === 'product.price_changed') {
                        const subio = Number(pChange.reseller_price) > Number(pChange.previous_reseller_price);
                        await registrarAlertaCentralOne(settings, {
                            type: subio ? 'PRICE_UP' : 'PRICE_DOWN',
                            severity: subio ? 'WARN' : 'OK',
                            title: `${subio ? '📈 Subió' : '📉 Bajó'} precio en Central One: ${pChange.name}`,
                            detail: `SKU ${pChange.sku}: $${pChange.previous_reseller_price || '--'} ➔ $${pChange.reseller_price} USD. Precios recalculados automáticamente.`,
                            sku: pChange.sku,
                            productId: pChange.product_id,
                            oldPrice: String(pChange.previous_reseller_price || ''),
                            newPrice: String(pChange.reseller_price || '')
                        });
                    } else if (eventName === 'product.stock_changed') {
                        await registrarAlertaCentralOne(settings, {
                            type: pChange.in_stock ? 'BACK_IN_STOCK' : 'OUT_OF_STOCK',
                            severity: pChange.in_stock ? 'OK' : 'CRIT',
                            title: `${pChange.in_stock ? '🟢 Volvió el stock' : '🚫 Se agotó el stock'}: ${pChange.name}`,
                            detail: `SKU ${pChange.sku} cambió in_stock a ${pChange.in_stock}.`,
                            sku: pChange.sku,
                            productId: pChange.product_id
                        });
                    }
                }
            }
            settings.markModified('centralOneCatalogCache');
            await recalcularPreciosYAlgoritmoTiendaKZ(settings);
            return;
        }

// B. Eventos de Órdenes: order.delivered, order.partially_delivered, order.failed, order.refunded
        if (eventName.startsWith('order.') && payload.order) {
            const wOrder = payload.order;
            const idemp = wOrder.idempotency_key || '';
            const matchKzId = idemp.match(/KZ-\d{6}/i);
            const kzOrderId = matchKzId ? matchKzId[0].toUpperCase() : null;

            const ordenDB = kzOrderId
                ? await Order.findOne({ orderId: kzOrderId })
                : await Order.findOne({ $or: [{ apiOrderId: wOrder.id }, { apiOrderId: wOrder.reference_code }] });

            if (ordenDB) {
                if (wOrder.id && (!ordenDB.apiOrderId || ordenDB.apiOrderId.startsWith('kz-ord-'))) {
                    ordenDB.apiOrderId = wOrder.id;
                }

                const listaCodigos = [];
                const codigosPorItem = [];
                if (Array.isArray(wOrder.codes)) {
                    wOrder.codes.forEach(cGroup => {
                        if (Array.isArray(cGroup.codes) && cGroup.codes.length > 0) {
                            codigosPorItem.push({
                                catalogItemId: cGroup.catalog_item_id || cGroup.product_id || '',
                                codes: cGroup.codes
                            });
                            cGroup.codes.forEach(codeStr => listaCodigos.push(codeStr));
                        }
                    });
                }

                // 🏦 Si el cliente ya había cancelado por reembolso tras 30 minutos de espera, guardar los códigos en Stock Interno y NO revivir la orden
                if (ordenDB.cancelledByDelayRefund || ordenDB.status === 'RECHAZADO') {
                    if (listaCodigos.length > 0) {
                        await guardarCodigosRecuperadosEnStockInterno(ordenDB, codigosPorItem, listaCodigos);
                    }
                    if (activeCentralOnePollers.has(ordenDB.orderId)) {
                        clearTimeout(activeCentralOnePollers.get(ordenDB.orderId));
                        activeCentralOnePollers.delete(ordenDB.orderId);
                    }
                } else if (eventName === 'order.delivered') {
                    // ✅ Entrega 100% completa: unir cualquier código de etapa previa con los recién llegados
                    const codigosPrevios = (ordenDB.algoExecutionState && Array.isArray(ordenDB.algoExecutionState.deliveredCodesList))
                        ? ordenDB.algoExecutionState.deliveredCodesList
                        : [];
                    const todosLosCodigos = [...new Set([...codigosPrevios, ...listaCodigos])];

                    ordenDB.status = 'ENTREGADO';
                    ordenDB.progressPercent = 100;
                    if (todosLosCodigos.length > 0) {
                        ordenDB.deliveredCode = todosLosCodigos.join('  |  ');
                    } else if (!ordenDB.deliveredCode || ordenDB.deliveredCode.includes('PROCESANDO')) {
                        ordenDB.deliveredCode = `PEDIDO COMPLETADO (${wOrder.reference_code || 'OK'})`;
                    }
                    if (ordenDB.algoExecutionState) {
                        ordenDB.algoExecutionState.deliveredCodesList = todosLosCodigos;
                        ordenDB.algoExecutionState.deliveredCardsCount = ordenDB.algoExecutionState.totalCardsExpected || todosLosCodigos.length;
                        ordenDB.markModified('algoExecutionState');
                    }
                    ordenDB.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                    ordenDB.completedAt = new Date();
                    await ordenDB.save();

                    if (activeCentralOnePollers.has(ordenDB.orderId)) {
                        clearTimeout(activeCentralOnePollers.get(ordenDB.orderId));
                        activeCentralOnePollers.delete(ordenDB.orderId);
                    }
                } else if (eventName === 'order.partially_delivered') {
                    // 🔄 Entrega parcial: NO cerrar la orden incompleta; activar de inmediato el vigilante para reemplazar la tarjeta faltante
                    await ordenDB.save();
                    if (activeCentralOnePollers.has(ordenDB.orderId)) {
                        clearTimeout(activeCentralOnePollers.get(ordenDB.orderId));
                        activeCentralOnePollers.delete(ordenDB.orderId);
                    }
                    if (wOrder.id || ordenDB.apiOrderId) {
                        programarSeguimientoOrdenCentralOne(ordenDB.orderId, wOrder.id || ordenDB.apiOrderId);
                    }
                } else if (eventName === 'order.failed') {
                    // Si es una orden de Algoritmo, dejar que el vigilante intente reemplazar por otra tarjeta antes de marcar error
                    if (ordenDB.algoExecutionState && ordenDB.algoExecutionState.isAlgorithmOrder && (wOrder.id || ordenDB.apiOrderId)) {
                        if (activeCentralOnePollers.has(ordenDB.orderId)) {
                            clearTimeout(activeCentralOnePollers.get(ordenDB.orderId));
                            activeCentralOnePollers.delete(ordenDB.orderId);
                        }
                        programarSeguimientoOrdenCentralOne(ordenDB.orderId, wOrder.id || ordenDB.apiOrderId);
                    } else {
                        await registrarAlertaCentralOne(settings, {
                            type: 'ORDER_FAILED',
                            severity: 'CRIT',
                            title: `🚨 Orden #${ordenDB.orderId} reportada fallida por Webhook (${wOrder.reference_code})`,
                            detail: `El saldo retenido fue liberado en tu cuenta de Central One.`
                        });
                    }
                }
            }
        }

        // C. Eventos de Saldo: deposit.approved, balance.credited, balance.low
        if (payload.balance && payload.balance.available) {
            if (!settings.centralOneSync) settings.centralOneSync = {};
            settings.centralOneSync.availableBalance = String(payload.balance.available);
            settings.markModified('centralOneSync');
        }
        if (eventName === 'balance.low') {
            await registrarAlertaCentralOne(settings, {
                type: 'BALANCE_LOW',
                severity: 'CRIT',
                title: `⚠️ Saldo bajo en Central One ($${payload.balance?.available || '0.00'} USD)`,
                detail: `Tu saldo disponible bajó del umbral configurado ($${payload.balance?.threshold || '0.00'} USD). Recarga tu cuenta para no detener las entregas automáticas.`
            });
        } else if (eventName === 'deposit.approved' || eventName === 'balance.credited') {
            await registrarAlertaCentralOne(settings, {
                type: 'DEPOSIT_APPROVED',
                severity: 'OK',
                title: `💰 Saldo acreditado en Central One (+$${payload.deposit?.credited_amount || payload.credit?.amount || '0.00'} USD)`,
                detail: `Nuevo saldo disponible en Central One: $${payload.balance?.available || '--'} USD.`
            });
        }

        await settings.save();
    } catch (err) {
        console.error('Error procesando webhook Central One:', err.message);
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

// 🟡 MOTOR AUTOMÁTICO BINANCE PAY (MICRO-DECIMALES + LECTURA API 24/7 BLINDADO)
// =================================================================
const BINANCE_API_MIRRORS = [
    'https://api.binance.com',
    'https://api-gcp.binance.com',
    'https://api1.binance.com',
    'https://api2.binance.com',
    'https://api3.binance.com',
    'https://api4.binance.com'
];

// Memoria en RAM + MongoDB para rotación secuencial de decimales y bloqueo permanente de TxIDs
let memoriaUltimoDecimalBinance = 0;
const memoriaTxIdsQuemados = new Set();

function obtenerMontoExactoEsperadoOrdenBinance(orden) {
    if (!orden) return 0;
    let m = Number(orden.binanceExactAmountUSDT) || 0;
    if (m <= 0 && String(orden.paymentReference || '').startsWith('AUTO-')) {
        m = Number(String(orden.paymentReference).replace('AUTO-', '').trim()) || 0;
    }
    if (m <= 0 && Number(orden.clientPayUSD) > 0) {
        m = Number(orden.clientPayUSD);
    }
    return Number(m.toFixed(3));
}

function extraerTimestampRealTxBinance(tx) {
    if (!tx) return 0;
    const raw = tx.transactionTime || tx.createTime || 0;
    if (typeof raw === 'string' && isNaN(Number(raw))) {
        return new Date(raw).getTime() || 0;
    }
    const num = Number(raw) || 0;
    return num > 0 && num < 1e12 ? num * 1000 : num;
}

// Consulta en vivo el historial de Binance Pay (GET /sapi/v1/pay/transactions) con firma HMAC-SHA256
async function consultarTransaccionesBinancePayAPI(settingsDoc = null) {
    if (!settingsDoc) {
        settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('binanceAutoConfig').lean();
    }
    const cfg = settingsDoc?.binanceAutoConfig || {};
    const apiKey = (cfg.apiKey || process.env.BINANCE_API_KEY || '').trim();
    const apiSecret = (cfg.apiSecret || process.env.BINANCE_API_SECRET || '').trim();

    if (Array.isArray(cfg.usedTxIds)) {
        cfg.usedTxIds.forEach(id => memoriaTxIdsQuemados.add(String(id)));
    }
    if (Number(cfg.lastMicroDecimal) > 0 && memoriaUltimoDecimalBinance === 0) {
        memoriaUltimoDecimalBinance = Number(cfg.lastMicroDecimal);
    }

    if (!apiKey || !apiSecret) {
        return { ok: false, error: 'Falta configurar BINANCE_API_KEY y BINANCE_API_SECRET.', transactions: [] };
    }

    let ultimoError = '';
    for (const host of BINANCE_API_MIRRORS) {
        try {
            const timestamp = Date.now() - 1500;
            const queryString = `limit=100&recvWindow=60000&timestamp=${timestamp}`;
            const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

            const resp = await axios.get(`${host}/sapi/v1/pay/transactions?${queryString}&signature=${signature}`, {
                headers: {
                    'X-MBX-APIKEY': apiKey,
                    'Accept': 'application/json'
                },
                timeout: 8000
            });

            if (resp.data && (resp.data.code === '000000' || Array.isArray(resp.data.data))) {
                return {
                    ok: true,
                    transactions: Array.isArray(resp.data.data) ? resp.data.data : []
                };
            }
            ultimoError = resp.data?.message || resp.data?.msg || 'Respuesta inesperada de Binance';
        } catch (err) {
            ultimoError = err.response?.data?.msg || err.response?.data?.message || err.message;
        }
    }

    return { ok: false, error: ultimoError || 'No se pudo conectar con Binance API', transactions: [] };
}

// Quema permanentemente uno o varios transactionId en MongoDB (StoreSettings) para que jamás puedan reusarse ni borrando la orden
async function quemarTxIdsEnStoreSettings(nuevosTxIds = [], nuevoUltimoDecimal = null) {
    try {
        nuevosTxIds.forEach(id => {
            if (id) memoriaTxIdsQuemados.add(String(id).trim());
        });
        if (nuevoUltimoDecimal !== null && nuevoUltimoDecimal > 0) {
            memoriaUltimoDecimalBinance = nuevoUltimoDecimal;
        }

        const settings = await StoreSettings.findOne({ key: 'main_settings' }).select('binanceAutoConfig').lean();
        const prevCfg = (settings && settings.binanceAutoConfig && typeof settings.binanceAutoConfig === 'object')
            ? { ...settings.binanceAutoConfig }
            : {};

        const listaCombinada = Array.from(new Set([
            ...(Array.isArray(prevCfg.usedTxIds) ? prevCfg.usedTxIds : []),
            ...Array.from(memoriaTxIdsQuemados)
        ])).slice(-600); // Conserva las últimas 600 transacciones blindadas

        prevCfg.usedTxIds = listaCombinada;
        if (memoriaUltimoDecimalBinance > 0) {
            prevCfg.lastMicroDecimal = memoriaUltimoDecimalBinance;
        }

        await StoreSettings.collection.updateOne(
            { key: 'main_settings' },
            { $set: { binanceAutoConfig: prevCfg } }
        );
    } catch (e) {}
}

// Genera el monto con 3 decimales en orden (.001, .002, .003...) y se reinicia cada nuevo día (12:00 AM Venezuela)
async function reservarMontoUnicoBinanceUSDT(baseUSD, settingsDoc = null) {
    const baseRedondeada = Math.floor((Number(baseUSD) + Number.EPSILON) * 100) / 100;

    // Calcular las 12:00 AM del día actual en Hora de Venezuela (UTC-4)
    const offsetVzlaMs = 4 * 60 * 60 * 1000;
    const ahoraVzla = new Date(Date.now() - offsetVzlaMs);
    const inicioHoyVzlaUtcMs = Date.UTC(
        ahoraVzla.getUTCFullYear(),
        ahoraVzla.getUTCMonth(),
        ahoraVzla.getUTCDate(),
        4, 0, 0, 0 // 00:00:00 VET = 04:00:00 UTC
    );
    const inicioHoyDate = new Date(inicioHoyVzlaUtcMs);

    // 1. Foto en vivo de tu cuenta Binance ANTES de crear el checkout:
    // Quema todos los IDs de transacción (P_...) que ya existen hasta este segundo para que jamás aprueben una orden nueva
    let maxTxTimePreExistente = Date.now() - 2000;
    const montosUsadosHoyEnBinance = new Set();

    try {
        const snapBinance = await consultarTransaccionesBinancePayAPI(settingsDoc);
        if (snapBinance.ok && Array.isArray(snapBinance.transactions)) {
            const idsExistentesAhora = [];
            for (const tx of snapBinance.transactions) {
                const txId = String(tx.transactionId || tx.orderId || '').trim();
                if (txId) idsExistentesAhora.push(txId);

                const tMs = extraerTimestampRealTxBinance(tx);
                if (tMs > maxTxTimePreExistente) maxTxTimePreExistente = tMs;

                // Solo marcar como ocupado el decimal si el pago ocurrió HOY (desde las 12:00 AM Venezuela)
                if (tMs >= inicioHoyVzlaUtcMs) {
                    const fund = Array.isArray(tx.fundsDetail) && tx.fundsDetail[0] ? tx.fundsDetail[0] : null;
                    const amt = Number(tx.amount !== undefined ? tx.amount : (fund ? fund.amount : 0));
                    if (amt > 0) montosUsadosHoyEnBinance.add(amt.toFixed(3));
                }
            }
            if (idsExistentesAhora.length > 0) {
                await quemarTxIdsEnStoreSettings(idsExistentesAhora, null);
            }
        }
    } catch (e) {}

    // 2. Buscar los montos de Binance usados HOY en órdenes pagadas o que estén esperando pago ahorita
    const ordenesDeHoy = await Order.find({
        fecha: { $gte: inicioHoyDate },
        paymentMethodKey: 'binance',
        $or: [
            { status: 'ENTREGADO' },
            { status: 'EJECUTANDO_API' },
            { status: 'EN_PROCESO' },
            { status: 'INICIANDO', isWaitingBinanceAuto: true }
        ]
    }).select('binanceExactAmountUSDT clientPayUSD paymentReference').lean();

    const ocupadosHoySet = new Set(montosUsadosHoyEnBinance);
    ordenesDeHoy.forEach(o => {
        const m = obtenerMontoExactoEsperadoOrdenBinance(o);
        if (m > 0) ocupadosHoySet.add(m.toFixed(3));
    });

    // 3. Empezar cada día siempre en orden estricto: .001, luego .002, .003... (saltando múltiplos de 10 como .010)
    let elegido = null;
    for (let m = 1; m <= 99; m++) {
        if (m % 10 === 0) continue;
        const candidato = Number((baseRedondeada + (m / 1000)).toFixed(3));
        if (!ocupadosHoySet.has(candidato.toFixed(3))) {
            elegido = candidato;
            break;
        }
    }

    if (!elegido) {
        elegido = Number((baseRedondeada + 0.001).toFixed(3));
    }

    const textoExacto = elegido.toFixed(3);
    const [parteEntera, parteDecimal] = textoExacto.split('.');
    return {
        exactAmount: elegido,
        exactText: textoExacto,
        intPart: parteEntera,
        decPart: parteDecimal,
        snapshotCutoffMs: maxTxTimePreExistente
    };
}

// Marca automáticamente una orden de Binance como RECHAZADA cuando se agota el tiempo de 60 minutos sin pago
async function rechazarOrdenBinancePorTiempoAgotado(orden) {
    if (!orden || !orden.orderId) return null;
    const montoExacto = obtenerMontoExactoEsperadoOrdenBinance(orden);
    const checkoutIdTxt = orden.binanceCheckoutId || 'N/A';

    const ordenExpirada = await Order.findOneAndUpdate(
        {
            orderId: orden.orderId,
            status: 'INICIANDO'
        },
        {
            $set: {
                isWaitingBinanceAuto: false,
                status: 'RECHAZADO',
                progressPercent: 100,
                binanceExactAmountUSDT: montoExacto,
                approvedByWorker: 'AUTO-BINANCE-PAY',
                completedAt: new Date(),
                paymentMethodName: `Binance Pay (${montoExacto.toFixed(3)} USDT • Expirado)`,
                paymentReference: `EXP-${montoExacto.toFixed(3)}`,
                workerNotes: `⏰ Tiempo de espera agotado en Binance Pay (60 min sin recibir ${montoExacto.toFixed(3)} USDT • Checkout: ${checkoutIdTxt}).`,
                statusMessage: `❌ Orden rechazada automáticamente: El tiempo de pago en Binance Pay expiró sin detectar la transferencia de ${montoExacto.toFixed(3)} USDT.`
            }
        },
        { new: true }
    );

    return ordenExpirada || await Order.findOne({ orderId: orden.orderId });
}

// Ejecuta la acreditación o disparo de API apenas se confirma un pago NUEVO y ENTRANTE en Binance
async function completarOrdenConfirmadaPorBinance(orden, txMatch) {
    const txId = String(txMatch.transactionId || txMatch.orderId || '').trim();
    if (!txId) return null;

    const payerName = txMatch.payerInfo?.name || txMatch.payerInfo?.binanceId || '';
    const montoExacto = obtenerMontoExactoEsperadoOrdenBinance(orden);

    // 🔒 CANDADO ATÓMICO DE 1 SOLO DISPARO:
    // Solo puede ejecutarse si la orden está en 'INICIANDO' y cambia de inmediato a 'EJECUTANDO_API'
    const ordenBloqueada = await Order.findOneAndUpdate(
        {
            orderId: orden.orderId,
            status: 'INICIANDO',
            binanceTransactionId: { $in: ['', null] }
        },
        {
            $set: {
                status: 'EJECUTANDO_API',
                progressPercent: 85,
                isWaitingBinanceAuto: false,
                binanceExactAmountUSDT: montoExacto,
                binanceTransactionId: txId,
                binancePayerName: String(payerName),
                paymentReference: txId,
                paymentMethodName: `Binance Pay Auto (${montoExacto.toFixed(3)} USDT${payerName ? ' • ' + payerName : ''})`,
                approvedByWorker: 'AUTO-BINANCE-PAY',
                statusMessage: `✅ Pago de ${montoExacto.toFixed(3)} USDT confirmado en Binance. Ejecutando entrega automática de tu compra...`,
                workerNotes: `🤖 Pago Binance confirmado (${montoExacto.toFixed(3)} USDT • TxID: ${txId}${payerName ? ' • Pagador: ' + payerName : ''}).`,
                timerStartedAt: new Date()
            }
        },
        { new: true }
    );

    if (!ordenBloqueada) {
        return await Order.findOne({ orderId: orden.orderId });
    }

    // Quemar de inmediato el transactionId en StoreSettings para que jamás pueda reutilizarse
    await quemarTxIdsEnStoreSettings([txId], null);

    // CASO 1: Recarga de Billetera Tokems KZ -> Acreditación automática inmediata
    if (ordenBloqueada.orderType === 'TOKEM_TOPUP' || ordenBloqueada.productSlug === 'tokems-kz') {
        if (ordenBloqueada.deviceId.includes('@')) {
            await User.updateOne({ email: ordenBloqueada.deviceId }, { $inc: { tokems: ordenBloqueada.tokemsAmount } });
        } else {
            await Balance.updateOne({ deviceId: ordenBloqueada.deviceId }, { $inc: { tokens: ordenBloqueada.tokemsAmount } }, { upsert: true });
        }

        await new Transaction({
            deviceId: ordenBloqueada.deviceId,
            tipo: 'Compra',
            tokens: ordenBloqueada.tokemsAmount,
            plan: ordenBloqueada.packageName,
            precio: `${montoExacto.toFixed(3)} USDT`,
            detalles: `Recarga automática Binance Pay (#${ordenBloqueada.orderId} • TxID: ${txId})`
        }).save().catch(() => {});

        ordenBloqueada.status = 'ENTREGADO';
        ordenBloqueada.progressPercent = 100;
        ordenBloqueada.deliveredCode = `+${ordenBloqueada.tokemsAmount} TOKEMS KZ ACREDITADOS`;
        ordenBloqueada.statusMessage = `¡Pago de ${montoExacto.toFixed(3)} USDT confirmado en Binance! Se acreditaron +${ordenBloqueada.tokemsAmount} Tokems KZ en tu billetera.`;
        ordenBloqueada.workerNotes = `🤖 Aprobada automáticamente por Binance Pay (${montoExacto.toFixed(3)} USDT • TxID Binance: ${txId}${payerName ? ' • Pagador: ' + payerName : ''} • Checkout: ${ordenBloqueada.binanceCheckoutId || 'N/A'})`;
        ordenBloqueada.approvedByWorker = 'AUTO-BINANCE-PAY';
        ordenBloqueada.completedAt = new Date();
        await ordenBloqueada.save();
        return ordenBloqueada;
    }

    // CASO 2: Recarga Interna Manual (con acceso a cuenta por WhatsApp) -> Pasa a la cola ya pagada y verificada
    if (ordenBloqueada.fulfillmentType === 'MANUAL_INTERNAL' || ordenBloqueada.subCategory === 'recargas_internas') {
        ordenBloqueada.status = 'EN_PROCESO';
        ordenBloqueada.progressPercent = 70;
        ordenBloqueada.statusMessage = `✅ Pago de ${montoExacto.toFixed(3)} USDT verificado automáticamente por Binance. Te escribiremos por WhatsApp para realizar tu recarga interna.`;
        ordenBloqueada.workerNotes = `✅ PAGO BINANCE AUTO-VERIFICADO (${montoExacto.toFixed(3)} USDT • TxID Binance: ${txId}${payerName ? ' • Pagador: ' + payerName : ''} • Checkout: ${ordenBloqueada.binanceCheckoutId || 'N/A'})`;
        await ordenBloqueada.save();
        return ordenBloqueada;
    }

    // CASO 3: Recargas por ID, Gift Cards, Servicios y Calculadora de Steam -> Dispara Central One API / Bóveda al instante
    const productoDB = await CatalogProduct.findOne({ slug: ordenBloqueada.productSlug });
    const apiRes = await ejecutarEntregaPorAPI(ordenBloqueada, productoDB);

    if (apiRes.success) {
        if (apiRes.isProcessingAsync) {
            ordenBloqueada.status = 'EJECUTANDO_API';
            ordenBloqueada.progressPercent = 85;
            ordenBloqueada.apiOrderId = apiRes.apiOrderId || '';
            ordenBloqueada.apiRawResponse = apiRes.raw || null;
            ordenBloqueada.approvedByWorker = 'AUTO-BINANCE-PAY';
            ordenBloqueada.workerNotes = `🤖 Entregada automáticamente vía Binance Pay (${montoExacto.toFixed(3)} USDT • TxID Binance: ${txId}${payerName ? ' • Pagador: ' + payerName : ''} • Checkout: ${ordenBloqueada.binanceCheckoutId || 'N/A'})`;
            ordenBloqueada.statusMessage = `✅ Pago de ${montoExacto.toFixed(3)} USDT confirmado. Ejecutando entrega automática de tu compra...`;
        } else {
            ordenBloqueada.status = 'ENTREGADO';
            ordenBloqueada.progressPercent = 100;
            ordenBloqueada.deliveredCode = apiRes.deliveredCode;
            ordenBloqueada.apiOrderId = apiRes.apiOrderId || '';
            ordenBloqueada.apiRawResponse = apiRes.raw || null;
            ordenBloqueada.approvedByWorker = 'AUTO-BINANCE-PAY';
            ordenBloqueada.completedAt = new Date();
            ordenBloqueada.workerNotes = `🤖 Entregada automáticamente vía Binance Pay (${montoExacto.toFixed(3)} USDT • TxID Binance: ${txId}${payerName ? ' • Pagador: ' + payerName : ''} • Checkout: ${ordenBloqueada.binanceCheckoutId || 'N/A'})`;
            ordenBloqueada.statusMessage = '¡Pago confirmado automáticamente por Binance Pay y pedido entregado con éxito!';

            if (ordenBloqueada.userEmail && ordenBloqueada.userEmail.includes('@')) {
                resend.emails.send({
                    from: 'Kem!Zone Oficial <registro@kzsorteos.com>',
                    to: ordenBloqueada.userEmail,
                    subject: `✅ Pedido Entregado #${ordenBloqueada.orderId} - ${ordenBloqueada.productName}`,
                    html: `
                        <div style="font-family: sans-serif; background-color: #09090d; color: #ffffff; padding: 25px; border-radius: 14px; border: 2px solid #ff6600; max-width: 520px;">
                            <h2 style="color: #ff6600; margin-top: 0;">¡Tu compra #${ordenBloqueada.orderId} fue entregada! 🔥</h2>
                            <p style="color: #cccccc;">Tu pago de <b>${montoExacto.toFixed(3)} USDT</b> por Binance Pay (TxID: <code>${txId}</code>) fue verificado automáticamente.</p>
                            <div style="background: #14141d; padding: 15px; border-radius: 10px; border-left: 4px solid #ff6600; margin: 18px 0;">
                                <p style="margin: 4px 0;"><b>Producto:</b> ${ordenBloqueada.productName}</p>
                                <p style="margin: 4px 0;"><b>Paquete:</b> ${ordenBloqueada.packageName}</p>
                                <p style="margin: 4px 0;"><b>Destino / ID:</b> ${ordenBloqueada.playerUid}</p>
                                <p style="margin: 12px 0 4px 0; color: #00e676; font-size: 16px;"><b>🎁 Entrega / Código:</b> <code style="background:#000; padding:5px 10px; border-radius:6px; color:#fff;">${ordenBloqueada.deliveredCode}</code></p>
                            </div>
                        </div>
                    `
                }).catch(() => {});
            }
        }
    } else {
        ordenBloqueada.status = 'ERROR_API';
        ordenBloqueada.progressPercent = 75;
        ordenBloqueada.approvedByWorker = 'AUTO-BINANCE-PAY';
        ordenBloqueada.statusMessage = `✅ Pago de ${montoExacto.toFixed(3)} USDT confirmado por Binance. Nuestro sistema está completando la liberación de tu pedido.`;
        ordenBloqueada.workerNotes = `✅ Pago Binance Auto-Confirmado (${montoExacto.toFixed(3)} USDT • TxID Binance: ${txId}${payerName ? ' • Pagador: ' + payerName : ''}). Pendiente liberación API: ${apiRes.errorMsg || ''}`;
    }

    if (ordenBloqueada.algoExecutionState) {
        ordenBloqueada.markModified('algoExecutionState');
    }
    await ordenBloqueada.save();
    return ordenBloqueada;
}

// Busca ESTRICTAMENTE un pago NUEVO, ENTRANTE (> 0) y POSTERIOR a la creación del checkout
async function buscarCoincidenciaPagoBinanceParaOrden(orden, listaTx) {
    const montoEsperado = obtenerMontoExactoEsperadoOrdenBinance(orden);
    if (!orden || orden.status !== 'INICIANDO' || montoEsperado <= 0 || !Array.isArray(listaTx) || listaTx.length === 0) {
        return null;
    }

    // Hora exacta en que se creó la orden (más el snapshot de la última transacción que ya existía en Binance al crearla)
    const fechaCreacionOrdenMs = new Date(orden.fecha || orden.createdAt || Date.now()).getTime();
    const partesMicro = String(orden.binanceMicroDecimal || '').split('|');
    const cutoffSnapshotMs = partesMicro.length > 1 && Number(partesMicro[1]) > 0
        ? Number(partesMicro[1])
        : (fechaCreacionOrdenMs - 3000);

    // El pago en Binance TIENE que ser posterior al snapshot previo y a la creación del checkout
    const tiempoMinimoPermitidoMs = Math.max(cutoffSnapshotMs, fechaCreacionOrdenMs - 4000);

    for (const tx of listaTx) {
        const txId = String(tx.transactionId || tx.orderId || '').trim();
        if (!txId) continue;

        // 🔒 Candado 1: Si el transactionId ya fue quemado antes (en memoria o en StoreSettings), se ignora de inmediato
        if (memoriaTxIdsQuemados.has(txId)) continue;

        const fundDetail = Array.isArray(tx.fundsDetail) && tx.fundsDetail.length > 0 ? tx.fundsDetail[0] : null;
        const moneda = String(tx.currency || tx.asset || (fundDetail && fundDetail.currency) || '').toUpperCase();
        if (moneda && moneda !== 'USDT') continue;

        // 🔒 Candado 2: SOLO pagos ENTRANTES (monto estrictamente positivo > 0; jamás Math.abs ni envíos salientes negativos)
        const rawAmt = tx.amount !== undefined ? Number(tx.amount) : (fundDetail ? Number(fundDetail.amount) : 0);
        if (!Number.isFinite(rawAmt) || rawAmt <= 0) continue;

        // 🔒 Candado 3: Coincidencia exacta a 3 decimales
        if (Math.abs(rawAmt - montoEsperado) >= 0.00015) continue;

        // 🔒 Candado 4: El pago debe haberse realizado DESPUÉS de abrir el checkout (jamás pagos del pasado)
        const tiempoTx = extraerTimestampRealTxBinance(tx);
        if (!tiempoTx || tiempoTx <= tiempoMinimoPermitidoMs) continue;

        // 🔒 Candado 5: Verificar en MongoDB que ninguna otra orden tenga ese transactionId
        const yaUsadaEnOrden = await Order.findOne({
            $or: [
                { binanceTransactionId: txId },
                { paymentReference: txId }
            ]
        }).select('_id orderId').lean();

        if (yaUsadaEnOrden) {
            memoriaTxIdsQuemados.add(txId);
            continue;
        }

        return tx;
    }
    return null;
}

// Vigilante en segundo plano: cada 10s revisa órdenes esperando Binance Pay (aprueba si llegó pago NUEVO o rechaza si expiró el tiempo)
setInterval(async () => {
    try {
        const hace2Horas = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const pendientesBinance = await Order.find({
            fecha: { $gte: hace2Horas },
            status: 'INICIANDO',
            isWaitingBinanceAuto: true,
            paymentMethodKey: 'binance'
        }).limit(20);

        if (pendientesBinance.length === 0) return;

        const settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('binanceAutoConfig').lean();
        const resBinance = await consultarTransaccionesBinancePayAPI(settingsDoc);
        const listaTx = resBinance.ok ? (resBinance.transactions || []) : [];

        for (const ord of pendientesBinance) {
            const matchTx = listaTx.length > 0
                ? await buscarCoincidenciaPagoBinanceParaOrden(ord, listaTx)
                : null;

            if (matchTx) {
                await completarOrdenConfirmadaPorBinance(ord, matchTx);
                continue;
            }

            // Si no se detectó pago y ya se cumplieron los 60 minutos del checkout, pasa automáticamente a RECHAZADO
            const limiteExpiracionMs = ord.binanceExpiresAt
                ? new Date(ord.binanceExpiresAt).getTime()
                : (new Date(ord.fecha || Date.now()).getTime() + 60 * 60 * 1000);

            if (Date.now() >= limiteExpiracionMs && ord.status === 'INICIANDO') {
                await rechazarOrdenBinancePorTiempoAgotado(ord);
            }
        }
    } catch (e) {}
}, 10000);

// 1. Endpoint para iniciar un Checkout Automático de Binance Pay (Quema historial previo + Reserva decimal rotativo único)
app.post('/api/binance-pay/create-checkout', orderLimiter, verificarTokenOpcional, async (req, res) => {
    try {
        const {
            orderType,
            deviceId,
            userEmail,
            userWhatsapp,
            productSlug,
            packageId,
            packageName,
            customTokemAmount,
            playerUid,
            playerServer,
            playerRegion,
            playerNickname,
            customSteamCalcData
        } = req.body;

        const settings = await StoreSettings.findOne({ key: 'main_settings' }) || { exchangeRateVES: 1012.00, bcvRateVES: 889.25, tokemValueUSD: 1.00, storeOpen: true };
        if (settings.storeOpen === false) {
            return res.status(403).json({ error: 'La tienda está en mantenimiento temporal.' });
        }

        const identificadorLimpio = (userEmail || deviceId || 'invitado').trim().toLowerCase();
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
        let esPinGiftCard = false;
        let estadoAlgoritmoInicial = null;

        if (orderType === 'TOKEM_TOPUP') {
            const cantTokems = Math.max(1, Number(customTokemAmount) || 1);
            nombreProducto = 'Recarga de Billetera Tokems KZ';
            nombrePaquete = `${cantTokems} Tokem(s) KZ 🪙`;
            fulfillment = 'TOKEM_WALLET_CREDIT';
            baseUSD = Number((cantTokems * (settings.tokemValueUSD || 1)).toFixed(2));
            costoEnTokems = cantTokems;
        } else if (String(productSlug || '').trim().toLowerCase() === 'calculadora-steam') {
            const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
            const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
            const ceil2  = (n) => Math.ceil(round4(n) * 100 - 1e-6) / 100;

            const calcData = customSteamCalcData || {};
            const rawGames = Array.isArray(calcData.gamesList) ? calcData.gamesList : [];
            let validGames = rawGames
                .map((g, idx) => {
                    const usdR = round2(parseFloat(g.priceUSD) || 0);
                    return {
                        label: String(g.name || `Juego ${idx + 1}`).trim(),
                        usdR,
                        tierFee: round2(obtenerGananciaRangoSteamServer(usdR))
                    };
                })
                .filter(g => g.usdR > 0);

            if (validGames.length === 0 && packageName) {
                const pkgTxt = String(packageName || '');
                const parteJuegos = pkgTxt.split('➔')[0] || pkgTxt;
                const regexJuegos = /([^+]+?)\s*\(\$(\d+(?:\.\d+)?)\)/g;
                let matchG;
                while ((matchG = regexJuegos.exec(parteJuegos)) !== null) {
                    const pVal = round2(parseFloat(matchG[2]) || 0);
                    if (pVal > 0) {
                        validGames.push({
                            label: matchG[1].trim() || 'Juego Steam',
                            usdR: pVal,
                            tierFee: round2(obtenerGananciaRangoSteamServer(pVal))
                        });
                    }
                }
                if (validGames.length === 0) {
                    const matchMeta = pkgTxt.match(/\$(\d+(?:\.\d+)?)/);
                    if (matchMeta) {
                        const pVal = round2(parseFloat(matchMeta[1]) || 0);
                        if (pVal > 0) {
                            validGames.push({
                                label: 'Juego Steam',
                                usdR: pVal,
                                tierFee: round2(obtenerGananciaRangoSteamServer(pVal))
                            });
                        }
                    }
                }
            }

            if (validGames.length === 0) {
                return res.status(400).json({ error: 'Ingresa al menos un juego con precio válido en la Calculadora de Steam.' });
            }

            const totalPriceUsd = round2(validGames.reduce((a, it) => a + it.usdR, 0));
            const planTarjetas = calcularMejorCombinacionTarjetasPool(
                totalPriceUsd,
                'steam',
                settings.arbitrageBaseCards || [],
                settings.centralOneCatalogCache || null
            );

            if (!planTarjetas || !planTarjetas.hasSolution) {
                return res.status(400).json({
                    error: (planTarjetas && planTarjetas.reason) || `No hay combinación de tarjetas en stock para cubrir $${totalPriceUsd.toFixed(2)} USD.`
                });
            }

            const costoTarjetasTotal = Number(planTarjetas.totalCostUSD);
            const itemsCalc = validGames.map(it => {
                const planIndiv = calcularMejorCombinacionTarjetasPool(
                    it.usdR,
                    'steam',
                    settings.arbitrageBaseCards || [],
                    settings.centralOneCatalogCache || null
                );
                const costoIndiv = (planIndiv && planIndiv.hasSolution) ? Number(planIndiv.totalCostUSD) : it.usdR;
                const difIndiv = Math.max(0, round4(costoIndiv - it.usdR));
                const subExact = round4(it.usdR + difIndiv + it.tierFee);
                const sub = ceil2(subExact);
                return { ...it, subExact, sub };
            });

            const subtotalCalculado = round2(itemsCalc.reduce((a, it) => a + it.sub, 0));
            const resumenJuegosTxt = validGames.map(g => `${g.label} ($${g.usdR.toFixed(2)})`).join(' + ');

            nombreProducto = 'Compra tus Juegos de Steam';
            nombrePaquete = packageName || `${resumenJuegosTxt} ➔ Recibes $${Number(planTarjetas.totalClientUSD).toFixed(2)} USD en Steam`;
            mainCat = 'giftcards';
            subCat = 'giftcards_plataformas';
            fulfillment = 'API_GIFT_CARD';
            baseUSD = subtotalCalculado;
            costoMayoristaUSD = Number(costoTarjetasTotal.toFixed(4));
            costoEnTokems = subtotalCalculado;
            apiProv = 'CENTRAL_ONE';
            apiSku = 'STEAM_CALC_ALGO';
            esPinGiftCard = true;

            estadoAlgoritmoInicial = {
                isAlgorithmOrder: true,
                platformGroup: 'steam',
                targetClientUSD: totalPriceUsd,
                deliveredClientUSD: 0,
                deliveredCostUSD: 0,
                deliveredCodesList: [],
                failedCardIds: [],
                totalCardsExpected: planTarjetas.totalCards || 1,
                deliveredCardsCount: 0,
                retryAttempt: 0
            };
        } else {
            const slugBuscado = String(productSlug || '').trim().toLowerCase();
            const productoDB = await CatalogProduct.findOne({ slug: slugBuscado });
            if (!productoDB || productoDB.active === false) {
                return res.status(404).json({ error: 'Este producto no se encuentra disponible.' });
            }

            const idPkgBuscado = String(packageId || '').trim();
            const nombrePkgBuscado = String(packageName || '').trim().toLowerCase();
            const listaPaquetesActiva = (productoDB.useAltPricing && Array.isArray(productoDB.altPackages) && productoDB.altPackages.length > 0)
                ? productoDB.altPackages
                : (productoDB.packages || []);

            let pkg = listaPaquetesActiva.find(p =>
                String(p.packageId || p.id || '').trim() === idPkgBuscado ||
                (nombrePkgBuscado && String(p.name || '').trim().toLowerCase() === nombrePkgBuscado)
            );

            const ofertaMatch = (settings.flashOffers || []).find(of =>
                String(of.slug || '').trim().toLowerCase() === slugBuscado &&
                (String(of.pkgId || '').trim() === idPkgBuscado ||
                 (nombrePkgBuscado && String(of.title || '').trim().toLowerCase() === nombrePkgBuscado))
            );

            if (ofertaMatch) {
                const vencio = Boolean(ofertaMatch.expiresAt && new Date(ofertaMatch.expiresAt).getTime() <= Date.now());
                if (ofertaMatch.active !== false && !vencio) {
                    pkg = {
                        packageId: ofertaMatch.pkgId || idPkgBuscado,
                        name: ofertaMatch.title,
                        priceUSD: Number(ofertaMatch.usd),
                        costUSD: Number(ofertaMatch.costUSD || (pkg ? pkg.costUSD : 0) || 0),
                        tokemsPrice: Number(ofertaMatch.tokemsPrice || ofertaMatch.usd),
                        apiProviderName: (pkg && pkg.apiProviderName) || 'DEFAULT_API',
                        apiProductSku: ofertaMatch.apiProductSku || (pkg ? pkg.apiProductSku : '') || ofertaMatch.pkgId,
                        isGiftCardPin: ofertaMatch.isGiftCardPin !== undefined ? Boolean(ofertaMatch.isGiftCardPin) : Boolean(pkg && pkg.isGiftCardPin),
                        inStock: true
                    };
                } else if (!pkg) {
                    return res.status(400).json({ error: '⏰ El tiempo de esta oferta relámpago ya finalizó.' });
                }
            }

            if (!pkg || pkg.inStock === false) {
                return res.status(400).json({ error: 'Este paquete no se encuentra disponible en este momento.' });
            }

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
            esPinGiftCard = pkg.isGiftCardPin !== undefined
                ? Boolean(pkg.isGiftCardPin)
                : (productoDB.mainCategory === 'giftcards' || productoDB.fulfillmentType === 'API_GIFT_CARD');

            if (productoDB.serviceCommissionPercent > 0) {
                feeUSD = Number(((baseUSD * productoDB.serviceCommissionPercent) / 100).toFixed(2));
            }
        }

        const tasaKZ = Number(settings.exchangeRateVES) || 1012.00;
        const tasaBCV = Number(settings.bcvRateVES) || tasaKZ || 889.25;
        const totalUSD = Number((baseUSD + feeUSD).toFixed(2));
        const totalVES = Number((totalUSD * tasaKZ).toFixed(2));
        const bcvAmountUSD = tasaBCV > 0 ? Number((totalVES / tasaBCV).toFixed(2)) : totalUSD;
        const discountUSD = Math.max(0, Number((bcvAmountUSD - totalUSD).toFixed(2)));

        // Reservar monto con rotación secuencial y quemar todas las transacciones existentes en Binance hasta este milisegundo
        const reservaDecimal = await reservarMontoUnicoBinanceUSDT(totalUSD, settings);

        const orderId = 'KZ-' + crypto.randomInt(100000, 999999).toString();
        const checkoutId = 'ch_KZ' + crypto.randomBytes(6).toString('hex');
        const expiraEn = new Date(Date.now() + 60 * 60 * 1000);

        let uidDestinoFinal = (playerUid || '').trim();
        if (!uidDestinoFinal) {
            if (fulfillment === 'MANUAL_INTERNAL' || subCat === 'recargas_internas') {
                uidDestinoFinal = userWhatsapp ? `WS: ${userWhatsapp.trim()}` : 'Contacto por WhatsApp';
            } else {
                uidDestinoFinal = 'Entrega Automática de Código';
            }
        }

        const nuevaOrden = await new Order({
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
            isGiftCardPin: esPinGiftCard,
            packageId: packageId || 'tokems_pack',
            packageName: nombrePaquete,
            apiProviderName: apiProv,
            apiProductSku: apiSku,
            playerUid: uidDestinoFinal,
            playerServer: (playerServer || '').trim(),
            playerRegion: (playerRegion || '').trim(),
            playerNickname: (playerNickname || '').trim(),
            paymentMethodKey: 'binance',
            paymentMethodName: `Binance Pay (${reservaDecimal.exactText} USDT)`,
            paymentReference: `AUTO-${reservaDecimal.exactText}`,
            exchangeRateApplied: tasaKZ,
            bcvRateApplied: tasaBCV,
            baseAmountUSD: baseUSD,
            bcvAmountUSD,
            discountUSD,
            clientPayUSD: reservaDecimal.exactAmount,
            serviceFeeUSD: feeUSD,
            totalAmountUSD: totalUSD,
            totalAmountVES: totalVES,
            costUSD: costoMayoristaUSD,
            tokemsAmount: costoEnTokems,
            paidWithTokems: false,
            status: 'INICIANDO',
            statusMessage: `Esperando transferencia exacta de ${reservaDecimal.exactText} USDT por Binance Pay...`,
            progressPercent: 35,
            binanceCheckoutId: checkoutId,
            binanceExactAmountUSDT: reservaDecimal.exactAmount,
            binanceMicroDecimal: `${reservaDecimal.decPart}|${reservaDecimal.snapshotCutoffMs}`,
            binanceExpiresAt: expiraEn,
            isWaitingBinanceAuto: true,
            ...(estadoAlgoritmoInicial ? { algoExecutionState: estadoAlgoritmoInicial } : {})
        }).save();

        const metodoBinanceDB = await PaymentMethod.findOne({ methodKey: { $regex: /binance/i } }).lean();
        const cfgBinance = settings.binanceAutoConfig || {};
        const payIdMostrar = (cfgBinance.payId || metodoBinanceDB?.phoneOrEmail || metodoBinanceDB?.binancePayId || '339 341 792').trim();
        const qrImgMostrar = (cfgBinance.qrImageUrl || '').trim();

        return res.json({
            success: true,
            checkout: {
                checkoutId,
                orderId: nuevaOrden.orderId,
                productName: nombreProducto,
                packageName: nombrePaquete,
                baseAmountUSD: totalUSD,
                exactAmountUSDT: reservaDecimal.exactAmount,
                exactText: reservaDecimal.exactText,
                intPart: reservaDecimal.intPart,
                decPart: reservaDecimal.decPart,
                payId: payIdMostrar,
                merchantName: cfgBinance.merchantName || 'Kem!Zone Oficial',
                qrImageUrl: qrImgMostrar,
                expiresAt: expiraEn.toISOString()
            },
            order: nuevaOrden
        });
    } catch (error) {
        console.error('Error creando Checkout Binance Pay:', error);
        return res.status(500).json({ error: 'Error iniciando el checkout automático de Binance Pay.' });
    }
});

// 2. Endpoint de Radar en Tiempo Real (El navegador del cliente lo consulta en la pantalla del QR)
app.get('/api/binance-pay/check-status/:orderId', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
        const idLimpio = String(req.params.orderId || '').trim().toUpperCase();
        let orden = await Order.findOne({ orderId: idLimpio });
        if (!orden) return res.status(404).json({ error: 'Checkout no encontrado.' });

        // Si ya fue pagada y procesada, devolver paid: true
        if (!orden.isWaitingBinanceAuto && (orden.status === 'ENTREGADO' || orden.status === 'EJECUTANDO_API' || orden.status === 'EN_PROCESO' || orden.status === 'ERROR_API')) {
            return res.json({
                success: true,
                paid: true,
                order: orden
            });
        }

        // Si ya fue rechazada por expiración
        if (orden.status === 'RECHAZADO') {
            return res.json({
                success: true,
                paid: false,
                expired: true,
                order: orden
            });
        }

        // Consultar transacciones recientes en Binance Pay API
        const settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('binanceAutoConfig').lean();
        const resBinance = await consultarTransaccionesBinancePayAPI(settingsDoc);
        if (resBinance.ok && resBinance.transactions.length > 0) {
            const matchTx = await buscarCoincidenciaPagoBinanceParaOrden(orden, resBinance.transactions);
            if (matchTx) {
                orden = await completarOrdenConfirmadaPorBinance(orden, matchTx);
                return res.json({
                    success: true,
                    paid: true,
                    order: orden
                });
            }
        }

        // Si no se encontró pago y ya expiraron los 60 minutos, convertir automáticamente la orden en RECHAZADA
        const limiteExpiracionMs = orden.binanceExpiresAt
            ? new Date(orden.binanceExpiresAt).getTime()
            : (new Date(orden.fecha || Date.now()).getTime() + 60 * 60 * 1000);

        if (Date.now() >= limiteExpiracionMs) {
            orden = await rechazarOrdenBinancePorTiempoAgotado(orden);
            return res.json({
                success: true,
                paid: false,
                expired: true,
                order: orden
            });
        }

        return res.json({
            success: true,
            paid: false,
            expired: false,
            apiConnected: resBinance.ok,
            apiError: resBinance.ok ? null : resBinance.error,
            order: orden
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error consultando estado del pago en Binance.' });
    }
});

// 3. Respaldo Manual en caso de que el cliente haya enviado sin decimales o quiera reportar los 6 dígitos del Order ID
app.post('/api/binance-pay/manual-fallback', async (req, res) => {
    try {
        const { orderId, manualReference } = req.body;
        const refLimpia = String(manualReference || '').trim().toUpperCase();
        if (!orderId || refLimpia.length < 4) {
            return res.status(400).json({ error: 'Ingresa al menos los últimos 6 dígitos del ID de Orden de Binance.' });
        }

        const idLimpio = String(orderId).trim().toUpperCase();
        const orden = await Order.findOne({ orderId: idLimpio });
        if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });

        orden.isWaitingBinanceAuto = false;
        orden.paymentReference = refLimpia;
        orden.status = 'EN_PROCESO';
        orden.progressPercent = 50;
        orden.statusMessage = 'Referencia de Binance recibida. Un operador está verificando tu pago...';
        orden.timerStartedAt = new Date();
        await orden.save();

        return res.json({
            success: true,
            order: orden
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error registrando la referencia manual.' });
    }
});

// 4. Endpoint Exclusivo del Dueño para guardar API Key / Secret Key / Pay ID / QR de Binance y probar conexión
app.post('/api/admin/binance-pay/config', verificarSoloAdmin, async (req, res) => {
    try {
        const { enabled, payId, merchantName, qrImageUrl, apiKey, apiSecret, testOnly } = req.body;
        let settings = await StoreSettings.findOne({ key: 'main_settings' }).select('-centralOneCatalogCache -centralOneCoverageCache');
        if (!settings) settings = new StoreSettings({ key: 'main_settings' });

        const prevCfg = (settings.binanceAutoConfig && typeof settings.binanceAutoConfig === 'object')
            ? { ...settings.binanceAutoConfig }
            : {};

        if (typeof enabled === 'boolean') prevCfg.enabled = enabled;
        if (payId !== undefined && String(payId).trim() !== '') {
            prevCfg.payId = String(payId).trim();
        }
        if (merchantName !== undefined && String(merchantName).trim() !== '') {
            prevCfg.merchantName = String(merchantName).trim();
        }
        if (qrImageUrl !== undefined) {
            prevCfg.qrImageUrl = String(qrImageUrl).trim();
        }
        // Jamás sobreescribir con vacío ni con asteriscos/puntos
        if (apiKey && !String(apiKey).includes('•') && !String(apiKey).includes('*') && String(apiKey).trim().length > 8) {
            prevCfg.apiKey = String(apiKey).trim();
        }
        if (apiSecret && !String(apiSecret).includes('•') && !String(apiSecret).includes('*') && String(apiSecret).trim().length > 8) {
            prevCfg.apiSecret = String(apiSecret).trim();
        }

        if (prevCfg.payId) {
            await PaymentMethod.updateMany(
                { methodKey: { $regex: /binance/i } },
                { $set: { phoneOrEmail: prevCfg.payId, binancePayId: prevCfg.payId } }
            ).catch(() => {});
        }

        const testRes = await consultarTransaccionesBinancePayAPI({ binanceAutoConfig: prevCfg });
        prevCfg.lastCheckAt = new Date();
        prevCfg.lastError = testRes.ok ? '' : (testRes.error || '');

        settings.binanceAutoConfig = prevCfg;
        settings.markModified('binanceAutoConfig');
        await settings.save();

        // Guardar también directo en la colección de MongoDB para garantizar 100% persistencia tras F5
        await StoreSettings.collection.updateOne(
            { key: 'main_settings' },
            { $set: { binanceAutoConfig: prevCfg } }
        );

        return res.json({
            success: true,
            apiConnected: testRes.ok,
            transactionsReadCount: (testRes.transactions || []).length,
            error: testRes.ok ? null : testRes.error,
            config: {
                enabled: prevCfg.enabled !== false,
                payId: prevCfg.payId || '',
                merchantName: prevCfg.merchantName || 'Kem!Zone Oficial',
                qrImageUrl: prevCfg.qrImageUrl || '',
                hasApiKey: Boolean(prevCfg.apiKey || process.env.BINANCE_API_KEY),
                hasApiSecret: Boolean(prevCfg.apiSecret || process.env.BINANCE_API_SECRET)
            }
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error configurando Binance Pay Automático.' });
    }
});

// Filtrar órdenes que aún están esperando en la ventana de QR de Binance para que no ensucien la cola antes de pagar
const _origFindOrders = Order.find;

// =================================================================
// 🏪 ENDPOINTS PÚBLICOS DE LA TIENDA KEM!ZONE (CATÁLOGO Y COMPRAS)
// =================================================================

app.get('/api/store/bootstrap', async (req, res) => {
    try {
        const [settings, products, paymentMethods] = await Promise.all([
            StoreSettings.findOne({ key: 'main_settings' })
                .select('-centralOneCatalogCache -centralOneCoverageCache -centralOneAlerts -processedWebhookIds -flyersCanvaConfig')
                .lean(),
            CatalogProduct.find()
                .sort({ sortOrder: 1, createdAt: 1 })
                .select('-packages.costUSD -packages.backupPinVault -altPackages.costUSD -altPackages.backupPinVault')
                .lean(),
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

// 1.5 Verificar ID de Jugador en el Paso 1 conectado en vivo a POST /api/v1/player/validate de Central One
app.post('/api/orders/verify-player', async (req, res) => {
    try {
        const { productSlug, packageId, playerUid, playerServer, playerRegion } = req.body;
        if (!playerUid || String(playerUid).trim().length < 3) {
            return res.status(400).json({ error: 'Ingresa un ID de jugador válido.' });
        }

        const headers = obtenerHeadersCentralOne();
        if (headers && productSlug) {
            const prodDB = await CatalogProduct.findOne({ slug: String(productSlug).trim().toLowerCase() }).lean();
            const settings = await StoreSettings.findOne({ key: 'main_settings' }).select('centralOneCatalogCache').lean();

            if (prodDB) {
                const listaPaq = (prodDB.useAltPricing && Array.isArray(prodDB.altPackages) && prodDB.altPackages.length > 0)
                    ? prodDB.altPackages
                    : (prodDB.packages || []);
                const pkgElegido = (packageId && listaPaq.find(p => p.packageId === packageId)) ||
                                   listaPaq.find(p => p.centralOneProductId || p.apiProductSku) ||
                                   listaPaq[0];

                let coProductId = pkgElegido ? (pkgElegido.centralOneProductId || '') : '';
                let coCatItem = null;

                if (settings && Array.isArray(settings.centralOneCatalogCache)) {
                    if (coProductId) {
                        coCatItem = settings.centralOneCatalogCache.find(x => x.product_id === coProductId);
                    }
                    if (!coCatItem && pkgElegido && pkgElegido.apiProductSku) {
                        const skuClean = String(pkgElegido.apiProductSku).trim().toUpperCase();
                        coCatItem = settings.centralOneCatalogCache.find(x => String(x.sku || '').trim().toUpperCase() === skuClean);
                        if (coCatItem) coProductId = coCatItem.product_id;
                    }
                }

                if (coProductId && (!coCatItem || coCatItem.requires_target !== false)) {
                    const targetFields = (coCatItem && Array.isArray(coCatItem.target_fields) && coCatItem.target_fields.length > 0)
                        ? coCatItem.target_fields
                        : ['player_id'];

                    const targetPayload = {};
                    targetFields.forEach((fieldKey, idx) => {
                        const fkLower = String(fieldKey).toLowerCase();
                        if (fkLower.includes('server') || fkLower.includes('zone') || fkLower.includes('region')) {
                            targetPayload[fieldKey] = String(playerServer || playerRegion || '').trim();
                        } else if (idx === 0 || fkLower.includes('player') || fkLower.includes('uid') || fkLower.includes('id')) {
                            targetPayload[fieldKey] = String(playerUid).trim();
                        } else {
                            targetPayload[fieldKey] = String(playerServer || playerRegion || playerUid).trim();
                        }
                    });

                    try {
                        const respCO = await axios.post(`${CENTRAL_ONE_BASE_URL}/player/validate`, {
                            product_id: coProductId,
                            target_payload: targetPayload
                        }, { headers, timeout: 9000 });

                        const dataCO = respCO.data || {};
                        if (dataCO.status === 'valid') {
                            const nick = dataCO.player?.name || '';
                            return res.json({
                                success: true,
                                status: 'valid',
                                verified: true,
                                nickname: nick,
                                message: nick
                                    ? `✅ Cuenta verificada: ${nick}`
                                    : `✅ Cuenta verificada y activa en el servidor del juego.`
                            });
                        }

                        if (dataCO.status === 'invalid') {
                            return res.status(400).json({
                                success: false,
                                status: 'invalid',
                                verified: false,
                                error: '❌ El ID de jugador ingresado NO existe en este servidor/región. Corrígelo antes de continuar.'
                            });
                        }
                    } catch (errVal) {
                        // Si devuelve 429 o fallo temporal, continúa con validación permisiva para no trancar la venta
                    }
                }
            }
        }

        return res.json({
            success: true,
            status: 'unverified',
            verified: false,
            nickname: '',
            message: 'ℹ️ No se puede mostrar el apodo en este juego, igualmente si escribió bien su ID, su recarga llegará sin problemas.'
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
        let esPinGiftCard = false;
        let productoDB = null;

let estadoAlgoritmoInicial = null;

        if (orderType === 'TOKEM_TOPUP') {
            const cantTokems = Math.max(1, Number(customTokemAmount) || 1);
            nombreProducto = 'Recarga de Billetera Tokems KZ';
            nombrePaquete = `${cantTokems} Tokem(s) KZ 🪙`;
            fulfillment = 'TOKEM_WALLET_CREDIT';
            baseUSD = Number((cantTokems * (settings.tokemValueUSD || 1)).toFixed(2));
            costoEnTokems = cantTokems;
} else if (String(productSlug || '').trim().toLowerCase() === 'calculadora-steam') {
            const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
            const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
            const ceil2  = (n) => Math.ceil(round4(n) * 100 - 1e-6) / 100;

            const calcData = req.body.customSteamCalcData || {};
            const rawGames = Array.isArray(calcData.gamesList) ? calcData.gamesList : [];
            let validGames = rawGames
                .map((g, idx) => {
                    const usdR = round2(parseFloat(g.priceUSD) || 0);
                    return {
                        label: String(g.name || `Juego ${idx + 1}`).trim(),
                        usdR,
                        tierFee: round2(obtenerGananciaRangoSteamServer(usdR))
                    };
                })
                .filter(g => g.usdR > 0);

            // Soporte para "Repetir Compra" desde Mi Cuenta cuando no viene customSteamCalcData en vivo
            if (validGames.length === 0 && req.body.packageName) {
                const pkgTxt = String(req.body.packageName || '');
                const parteJuegos = pkgTxt.split('➔')[0] || pkgTxt;
                const regexJuegos = /([^+]+?)\s*\(\$(\d+(?:\.\d+)?)\)/g;
                let matchG;
                while ((matchG = regexJuegos.exec(parteJuegos)) !== null) {
                    const pVal = round2(parseFloat(matchG[2]) || 0);
                    if (pVal > 0) {
                        validGames.push({
                            label: matchG[1].trim() || 'Juego Steam',
                            usdR: pVal,
                            tierFee: round2(obtenerGananciaRangoSteamServer(pVal))
                        });
                    }
                }
                if (validGames.length === 0) {
                    const matchMeta = pkgTxt.match(/\$(\d+(?:\.\d+)?)/);
                    if (matchMeta) {
                        const pVal = round2(parseFloat(matchMeta[1]) || 0);
                        if (pVal > 0) {
                            validGames.push({
                                label: 'Juego Steam',
                                usdR: pVal,
                                tierFee: round2(obtenerGananciaRangoSteamServer(pVal))
                            });
                        }
                    }
                }
            }

            if (validGames.length === 0) {
                return res.status(400).json({ error: 'Debes ingresar al menos un juego con precio válido en la Calculadora de Steam.' });
            }

            const totalPriceUsd = round2(validGames.reduce((a, it) => a + it.usdR, 0));
            const planTarjetas = calcularMejorCombinacionTarjetasPool(
                totalPriceUsd,
                'steam',
                settings.arbitrageBaseCards || [],
                settings.centralOneCatalogCache || null
            );

            if (!planTarjetas || !planTarjetas.hasSolution) {
                return res.status(400).json({
                    error: (planTarjetas && planTarjetas.reason) || `Por el momento no hay combinación de tarjetas en stock para cubrir $${totalPriceUsd.toFixed(2)} USD.`
                });
            }

            const costoTarjetasTotal = Number(planTarjetas.totalCostUSD);
            const itemsCalc = validGames.map(it => {
                const planIndiv = calcularMejorCombinacionTarjetasPool(
                    it.usdR,
                    'steam',
                    settings.arbitrageBaseCards || [],
                    settings.centralOneCatalogCache || null
                );
                const costoIndiv = (planIndiv && planIndiv.hasSolution) ? Number(planIndiv.totalCostUSD) : it.usdR;
                const difIndiv = Math.max(0, round4(costoIndiv - it.usdR));
                const subExact = round4(it.usdR + difIndiv + it.tierFee);
                const sub = ceil2(subExact);
                return { ...it, subExact, sub };
            });

            const subtotalCalculado = round2(itemsCalc.reduce((a, it) => a + it.sub, 0));
            const resumenJuegosTxt = validGames.map(g => `${g.label} ($${g.usdR.toFixed(2)})`).join(' + ');

            nombreProducto = 'Compra tus Juegos de Steam';
            nombrePaquete = req.body.packageName || `${resumenJuegosTxt} ➔ Recibes $${Number(planTarjetas.totalClientUSD).toFixed(2)} USD en Steam`;
            mainCat = 'giftcards';
            subCat = 'giftcards_plataformas';
            fulfillment = 'API_GIFT_CARD';
            baseUSD = subtotalCalculado;
            costoMayoristaUSD = Number(costoTarjetasTotal.toFixed(4));
            costoEnTokems = subtotalCalculado;
            apiProv = 'CENTRAL_ONE';
            apiSku = 'STEAM_CALC_ALGO';
            esPinGiftCard = true;

            estadoAlgoritmoInicial = {
                isAlgorithmOrder: true,
                platformGroup: 'steam',
                targetClientUSD: totalPriceUsd,
                deliveredClientUSD: 0,
                deliveredCostUSD: 0,
                deliveredCodesList: [],
                failedCardIds: [],
                totalCardsExpected: planTarjetas.totalCards || 1,
                deliveredCardsCount: 0,
                retryAttempt: 0
            };

            productoDB = {
                slug: 'calculadora-steam',
                name: nombreProducto,
                isSmartCodeProduct: true,
                smartPlatformGroup: 'steam',
                packages: [{
                    packageId: 'steam_calc_custom',
                    name: nombrePaquete,
                    useSmartAlgorithm: true,
                    targetClientUSD: totalPriceUsd,
                    isGiftCardPin: true
                }],
                save: async () => {}
            };
        } else {
            const slugBuscado = String(productSlug || '').trim().toLowerCase();
            productoDB = await CatalogProduct.findOne({ slug: slugBuscado });
            if (!productoDB) return res.status(404).json({ error: 'Producto no encontrado.' });

            if (productoDB.active === false) {
                return res.status(403).json({
                    error: `Por el momento ${productoDB.name} no está en funcionamiento. Mantente atento en el catálogo cuando se vuelva a activar.`
                });
            }

            const idPkgBuscado = String(packageId || '').trim();
            const nombrePkgBuscado = String(req.body.packageName || '').trim().toLowerCase();

            const listaPaquetesActiva = (productoDB.useAltPricing && Array.isArray(productoDB.altPackages) && productoDB.altPackages.length > 0)
                ? productoDB.altPackages
                : (productoDB.packages || []);

            let pkg = listaPaquetesActiva.find(p =>
                String(p.packageId || p.id || '').trim() === idPkgBuscado ||
                (nombrePkgBuscado && String(p.name || '').trim().toLowerCase() === nombrePkgBuscado)
            );

const ofertaMatch = (settings.flashOffers || []).find(of =>
                String(of.slug || '').trim().toLowerCase() === slugBuscado &&
                (String(of.pkgId || '').trim() === idPkgBuscado ||
                 (nombrePkgBuscado && String(of.title || '').trim().toLowerCase() === nombrePkgBuscado))
            );

            if (ofertaMatch) {
                const vencioPorTiempo = Boolean(ofertaMatch.expiresAt && new Date(ofertaMatch.expiresAt).getTime() <= Date.now());
                const estaActivaOferta = ofertaMatch.active !== false && !vencioPorTiempo;

                // Si venció por tiempo, la apaga permanentemente en MongoDB en segundo plano
                if (vencioPorTiempo && ofertaMatch.active !== false && typeof settings.save === 'function') {
                    ofertaMatch.active = false;
                    settings.markModified('flashOffers');
                    settings.save().catch(() => {});
                }

                if (!estaActivaOferta) {
                    if (!pkg) {
                        return res.status(400).json({
                            error: '⏰ El tiempo de esta oferta relámpago ya finalizó o fue desactivada.'
                        });
                    }
                } else {
                    pkg = {
                        packageId: ofertaMatch.pkgId || idPkgBuscado,
                        name: ofertaMatch.title,
                        priceUSD: Number(ofertaMatch.usd),
                        costUSD: Number(ofertaMatch.costUSD || (pkg ? pkg.costUSD : 0) || 0),
                        tokemsPrice: Number(ofertaMatch.tokemsPrice || ofertaMatch.usd),
                        apiProviderName: (pkg && pkg.apiProviderName) || 'DEFAULT_API',
                        apiProductSku: ofertaMatch.apiProductSku || (pkg ? pkg.apiProductSku : '') || ofertaMatch.pkgId,
                        centralOneProductId: ofertaMatch.centralOneProductId || (pkg ? pkg.centralOneProductId : '') || '',
                        isGiftCardPin: ofertaMatch.isGiftCardPin !== undefined ? Boolean(ofertaMatch.isGiftCardPin) : Boolean(pkg && pkg.isGiftCardPin),
                        backupPinVault: Array.isArray(ofertaMatch.backupPinVault) ? ofertaMatch.backupPinVault : [],
                        inStock: true
                    };
                }
            }

            if (!pkg || pkg.inStock === false) {
                return res.status(400).json({
                    error: 'Por el momento este paquete no está en funcionamiento o se encuentra temporalmente desactivado.'
                });
            }

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
            esPinGiftCard = pkg.isGiftCardPin !== undefined
                ? Boolean(pkg.isGiftCardPin)
                : (productoDB.mainCategory === 'giftcards' || productoDB.fulfillmentType === 'API_GIFT_CARD');

            if (productoDB.serviceCommissionPercent > 0) {
                feeUSD = Number(((baseUSD * productoDB.serviceCommissionPercent) / 100).toFixed(2));
            }
        }

        const tasaKZ = Number(settings.exchangeRateVES) || 1012.00;
        const tasaBCV = Number(settings.bcvRateVES) || tasaKZ || 889.25;

        const totalUSD = Number((baseUSD + feeUSD).toFixed(2));
        const totalVES = Number((totalUSD * tasaKZ).toFixed(2));
        const bcvAmountUSD = tasaBCV > 0 ? Number((totalVES / tasaBCV).toFixed(2)) : totalUSD;
        const discountUSD = Math.max(0, Number((bcvAmountUSD - totalUSD).toFixed(2)));

        const keyMetodoLower = String(paymentMethodKey || '').toLowerCase();
        const esPagoMovil = keyMetodoLower.includes('pago_movil') || metodoPago.currency === 'VES';
        const esPaypal = keyMetodoLower.includes('paypal');

        let paypalFeeUSD = 0;
        let clientPayUSD = totalUSD;

        if (esPagoMovil) {
            clientPayUSD = bcvAmountUSD;
        } else if (esPaypal) {
            clientPayUSD = Number(((totalUSD + 0.30) / (1 - 0.054)).toFixed(2));
            paypalFeeUSD = Math.max(0, Number((clientPayUSD - totalUSD).toFixed(2)));
        } else {
            clientPayUSD = totalUSD;
        }

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

        let uidDestinoFinal = (playerUid || '').trim();
        if (!uidDestinoFinal) {
            if (fulfillment === 'MANUAL_INTERNAL' || subCat === 'recargas_internas') {
                uidDestinoFinal = userWhatsapp ? `WS: ${userWhatsapp.trim()}` : 'Contacto por WhatsApp';
            } else {
                uidDestinoFinal = 'Entrega Automática de Código';
            }
        }

        // 🇻🇪 Verificar si la orden se está creando en horario nocturno de Venezuela (11:00 PM a 11:00 AM VET / UTC-4)
        const ahoraUtcMs = Date.now();
        const offsetVzlaMs = 4 * 60 * 60 * 1000;
        const fechaVzla = new Date(ahoraUtcMs - offsetVzlaMs);
        const horaVzla = fechaVzla.getUTCHours();
        const esFueraDeHorarioVzla = (horaVzla >= 23 || horaVzla < 11);

        let inicioRelojEntrega = new Date(ahoraUtcMs);
        let mensajeInicialOrden = 'Tu orden está en proceso. Un operador está verificando tu referencia de pago...';

        if (esFueraDeHorarioVzla) {
            // 11:00 AM en Venezuela equivale a las 15:00:00 UTC
            let proxima11amUtcMs = Date.UTC(
                fechaVzla.getUTCFullYear(),
                fechaVzla.getUTCMonth(),
                fechaVzla.getUTCDate(),
                15, 0, 0, 0
            );
            if (horaVzla >= 23) {
                proxima11amUtcMs += 24 * 60 * 60 * 1000;
            }
            inicioRelojEntrega = new Date(proxima11amUtcMs);
            mensajeInicialOrden = '🌙 Compra registrada fuera de horario. Tu pedido está asegurado en cola prioritaria y se entregará a partir de las 11:00 AM.';
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
            isGiftCardPin: esPinGiftCard,
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
            exchangeRateApplied: tasaKZ,
            bcvRateApplied: tasaBCV,
            baseAmountUSD: baseUSD,
            bcvAmountUSD,
            discountUSD,
            paypalFeeUSD,
            clientPayUSD,
            serviceFeeUSD: feeUSD,
            totalAmountUSD: totalUSD,
            totalAmountVES: totalVES,
            costUSD: costoMayoristaUSD,
            tokemsAmount: costoEnTokems,
            paidWithTokems: pagadoConTokems,
            status: 'EN_PROCESO',
            statusMessage: mensajeInicialOrden,
            progressPercent: 50,
            timerStartedAt: inicioRelojEntrega,
            ...(estadoAlgoritmoInicial ? { algoExecutionState: estadoAlgoritmoInicial } : {})
        });

if (pagadoConTokems && settings.autoTriggerApiOnTokems && fulfillment !== 'MANUAL_INTERNAL') {
            const apiRes = await ejecutarEntregaPorAPI(nuevaOrden, productoDB);
            if (apiRes.success) {
                if (apiRes.isProcessingAsync) {
                    nuevaOrden.status = 'EJECUTANDO_API';
                    nuevaOrden.statusMessage = 'Pago con Tokems KZ recibido. Procesando la entrega automática de tu compra...';
                    nuevaOrden.progressPercent = 85;
                    nuevaOrden.apiOrderId = apiRes.apiOrderId || '';
                    nuevaOrden.apiRawResponse = apiRes.raw || null;
                    nuevaOrden.approvedByWorker = 'AUTO-TOKEMS-API';
                } else {
                    nuevaOrden.status = 'ENTREGADO';
                    nuevaOrden.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                    nuevaOrden.progressPercent = 100;
                    nuevaOrden.deliveredCode = apiRes.deliveredCode;
                    nuevaOrden.apiOrderId = apiRes.apiOrderId || '';
                    nuevaOrden.apiRawResponse = apiRes.raw || null;
                    nuevaOrden.approvedByWorker = 'AUTO-TOKEMS-API';
                    nuevaOrden.completedAt = new Date();

                    if (nuevaOrden.userEmail && nuevaOrden.userEmail.includes('@')) {
                        resend.emails.send({
                            from: 'Kem!Zone Oficial <registro@kzsorteos.com>',
                            to: nuevaOrden.userEmail,
                            subject: `✅ Pedido Entregado #${nuevaOrden.orderId} - ${nuevaOrden.productName}`,
                            html: `
                                <div style="font-family: sans-serif; background-color: #09090d; color: #ffffff; padding: 25px; border-radius: 14px; border: 2px solid #ff6600; max-width: 520px;">
                                    <h2 style="color: #ff6600; margin-top: 0;">¡Tu compra #${nuevaOrden.orderId} fue entregada! 🔥</h2>
                                    <p style="color: #cccccc;">Tu pago con Tokems KZ fue procesado automáticamente con éxito.</p>
                                    <div style="background: #14141d; padding: 15px; border-radius: 10px; border-left: 4px solid #ff6600; margin: 18px 0;">
                                        <p style="margin: 4px 0;"><b>Producto:</b> ${nuevaOrden.productName}</p>
                                        <p style="margin: 4px 0;"><b>Paquete:</b> ${nuevaOrden.packageName}</p>
                                        <p style="margin: 4px 0;"><b>Destino / ID:</b> ${nuevaOrden.playerUid}</p>
                                        <p style="margin: 12px 0 4px 0; color: #00e676; font-size: 16px;"><b>🎁 Entrega / Código:</b> <code style="background:#000; padding:5px 10px; border-radius:6px; color:#fff;">${nuevaOrden.deliveredCode}</code></p>
                                    </div>
                                </div>
                            `
                        }).catch(() => {});
                    }
                }
            } else {
                nuevaOrden.status = 'ERROR_API';
                nuevaOrden.statusMessage = 'Pago con Tokems KZ verificado. Un operador completará la liberación de tu entrega en breve.';
                nuevaOrden.progressPercent = 75;
            }
            if (nuevaOrden.algoExecutionState) {
                nuevaOrden.markModified('algoExecutionState');
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
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
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
            whatsapp: usuario ? (usuario.whatsapp || '') : '',
            savedProfiles: usuario ? (usuario.savedProfiles || []) : [],
            orders,
            tickets
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error obteniendo los datos de tu cuenta.' });
    }
});

// 📱 Guardar el número de WhatsApp oficial del cliente en su cuenta de MongoDB
app.post('/api/client/save-whatsapp', verificarTokenOpcional, async (req, res) => {
    try {
        const { email, whatsapp } = req.body;
        const correoTarget = (req.user && req.user.email) ? req.user.email.toLowerCase() : (email || '').trim().toLowerCase();
        if (!correoTarget) return res.status(401).json({ error: 'Inicia sesión para guardar tu WhatsApp.' });

        const wsLimpio = String(whatsapp || '').trim();
        const usuario = await User.findOneAndUpdate(
            { email: correoTarget },
            { $set: { whatsapp: wsLimpio } },
            { new: true }
        );
        if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado.' });

        return res.json({ success: true, whatsapp: usuario.whatsapp });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando tu WhatsApp.' });
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
// 🎫 ENDPOINTS DE TICKETS Y CHAT EN VIVO (OPTIMIZADO EN RAM + MONGODB)
// =================================================================
const activeTicketPresence = new Map(); // Guarda quién está en línea o escribiendo sin gastar disco en MongoDB

function obtenerPresenciaTicket(ticketId) {
    const now = Date.now();
    const p = activeTicketPresence.get(ticketId) || {};
    return {
        clientOnline: Boolean(p.clientLastSeen && (now - p.clientLastSeen < 18000)),
        clientTyping: Boolean(p.clientTypingUntil && now < p.clientTypingUntil),
        staffOnline: Boolean(p.staffLastSeen && (now - p.staffLastSeen < 18000)),
        staffTyping: Boolean(p.staffTypingUntil && now < p.staffTypingUntil),
        staffName: p.staffName || ''
    };
}

// Limpieza automática de memoria RAM cada 10 minutos
setInterval(() => {
    const limite = Date.now() - 120000;
    for (const [k, v] of activeTicketPresence.entries()) {
        if ((v.clientLastSeen || 0) < limite && (v.staffLastSeen || 0) < limite) {
            activeTicketPresence.delete(k);
        }
    }
}, 600000);

// 1. Crear nuevo Ticket y abrir conversación
app.post('/api/tickets/create', verificarTokenOpcional, async (req, res) => {
    try {
        const {
            orderId,
            deviceId,
            userEmail,
            userName,
            userWhatsapp,
            subject,
            category,
            gameName,
            paymentMethod,
            paymentReference,
            playerUid,
            messageText,
            attachmentUrl
        } = req.body;

        const motivoLimpio = (category || 'Consulta General').trim();
        const asuntoLimpio = (subject || motivoLimpio || 'Soporte de Pedido').trim();
        const textoInicial = (messageText || '').trim();

        if (!motivoLimpio && !textoInicial) {
            return res.status(400).json({ error: 'Por favor escribe el motivo y los detalles de tu consulta.' });
        }

        const ticketId = 'TK-' + crypto.randomInt(10000, 99999).toString();
        const identificador = (userEmail || deviceId || 'invitado').trim().toLowerCase();
        const nombreMostrar = (userName || (userEmail ? userEmail.split('@')[0] : 'Cliente')).trim();

        const nuevoTicket = await new SupportTicket({
            ticketId,
            orderId: (orderId || '').trim().toUpperCase().replace(/^#/, ''),
            deviceId: identificador,
            userEmail: userEmail ? userEmail.trim().toLowerCase() : '',
            userName: nombreMostrar,
            userWhatsapp: (userWhatsapp || '').trim(),
            subject: asuntoLimpio,
            category: motivoLimpio,
            gameName: (gameName || '').trim(),
            paymentMethod: (paymentMethod || '').trim(),
            paymentReference: (paymentReference || '').trim(),
            playerUid: (playerUid || '').trim(),
            status: 'ABIERTO',
            messages: [{
                senderRole: 'client',
                senderName: nombreMostrar,
                text: textoInicial || `Motivo: ${motivoLimpio}`,
                attachmentUrl: attachmentUrl || ''
            }]
        }).save();

        // Auto-optimización silenciosa: purga tickets resueltos de hace más de 10 días
        const hace10Dias = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        SupportTicket.deleteMany({
            status: { $in: ['RESUELTO', 'CERRADO'] },
            updatedAt: { $lt: hace10Dias }
        }).catch(() => {});

        return res.json({ success: true, ticket: nuevoTicket });
    } catch (error) {
        return res.status(500).json({ error: 'Error creando el ticket de soporte.' });
    }
});

// 2. Enviar mensaje o adjunto en el Chat (Cliente o Trabajador/Dueño) y Finalizar como Resuelto
app.post('/api/tickets/reply', verificarTokenOpcional, async (req, res) => {
    try {
        const { ticketId, text, attachmentUrl, newStatus, senderNameCustom } = req.body;
        if (!ticketId) return res.status(400).json({ error: 'Falta el ID del ticket.' });

        const idLimpio = ticketId.trim().toUpperCase();
        const ticket = await SupportTicket.findOne({ ticketId: idLimpio });
        if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado.' });

        let senderRole = 'client';
        let senderName = ticket.userName || (ticket.userEmail ? ticket.userEmail.split('@')[0] : 'Cliente');

        if (req.user && req.user.email) {
            const rol = determinarRolDeUsuario(req.user.email, req.user.role);
            if (rol === 'worker' || rol === 'admin') {
                senderRole = rol;
                const staffAlias = senderNameCustom || req.user.email.split('@')[0];
                senderName = `${staffAlias} (Soporte Kem!Zone)`;
                if (!ticket.assignedWorker) {
                    ticket.assignedWorker = req.user.email.toLowerCase();
                    ticket.assignedWorkerName = staffAlias;
                }
            }
        }

        // Si el ticket ya estaba resuelto y el cliente intenta escribir, se bloquea para cuidar la BD
        if (senderRole === 'client' && (ticket.status === 'RESUELTO' || ticket.status === 'CERRADO')) {
            return res.status(403).json({ error: 'Este ticket ya fue finalizado como resuelto. Si necesitas más ayuda, abre un nuevo ticket.' });
        }

        const msgTxt = (text || '').trim();
        const imgAdjunta = (attachmentUrl || '').trim();

        if (msgTxt || imgAdjunta) {
            // Limita a máximo 80 mensajes por ticket para proteger el tamaño del documento en MongoDB
            if (ticket.messages.length >= 80) {
                ticket.messages.shift();
            }
            ticket.messages.push({
                senderRole,
                senderName,
                text: msgTxt || (imgAdjunta ? '📎 Archivo adjunto enviado' : ''),
                attachmentUrl: imgAdjunta
            });
        }

        if (senderRole === 'worker' || senderRole === 'admin') {
            if (newStatus === 'RESUELTO' || newStatus === 'CERRADO') {
                ticket.status = 'RESUELTO';
                ticket.resolvedBy = senderName;
                ticket.resolvedAt = new Date();
                // Optimización: al resolver el problema, limpia imágenes pesadas intermedias si hay muchas para ahorrar RAM y espacio en MongoDB
                if (ticket.messages.length > 6) {
                    for (let i = 1; i < ticket.messages.length - 2; i++) {
                        if (ticket.messages[i].attachmentUrl && ticket.messages[i].attachmentUrl.length > 50000) {
                            ticket.messages[i].attachmentUrl = '';
                        }
                    }
                }
            } else if (newStatus === 'ABIERTO') {
                ticket.status = 'ABIERTO';
                ticket.resolvedAt = null;
            } else {
                ticket.status = 'EN_REVISION';
                ticket.resolvedAt = null;
            }
        }

        // Apagar indicador de "escribiendo..." al enviar el mensaje
        const pres = activeTicketPresence.get(idLimpio) || {};
        if (senderRole === 'client') pres.clientTypingUntil = 0;
        else pres.staffTypingUntil = 0;
        activeTicketPresence.set(idLimpio, pres);

        await ticket.save();
        return res.json({
            success: true,
            ticket,
            presence: obtenerPresenciaTicket(idLimpio)
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error enviando respuesta al ticket.' });
    }
});

// 3. Apartar, Liberar o Tomar Control de un Ticket (Candado Atómico igual que la Cola de Recargas)
app.post('/api/tickets/claim', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { ticketId, action = 'CLAIM' } = req.body; // 'CLAIM' | 'RELEASE' | 'FORCE_TAKE'
        const idLimpio = String(ticketId || '').trim().toUpperCase();
        const staffEmail = req.staffUser.email.toLowerCase();
        const staffName = req.staffUser.accountName || staffEmail.split('@')[0];
        const isOwner = req.effectiveRole === 'admin';

        if (action === 'CLAIM') {
            const ticketApartado = await SupportTicket.findOneAndUpdate(
                {
                    ticketId: idLimpio,
                    $or: [
                        { assignedWorker: '' },
                        { assignedWorker: null },
                        { assignedWorker: { $exists: false } },
                        { assignedWorker: staffEmail }
                    ]
                },
                {
                    $set: {
                        assignedWorker: staffEmail,
                        assignedWorkerName: staffName,
                        status: 'EN_REVISION'
                    }
                },
                { new: true }
            );

            if (!ticketApartado) {
                const existente = await SupportTicket.findOne({ ticketId: idLimpio }).select('assignedWorker assignedWorkerName').lean();
                if (!existente) return res.status(404).json({ error: 'El ticket ya no existe.' });
                return res.status(409).json({
                    error: `⚠️ Este ticket acaba de ser apartado por ${existente.assignedWorkerName || existente.assignedWorker}.`
                });
            }

            const pres = activeTicketPresence.get(idLimpio) || {};
            pres.staffLastSeen = Date.now();
            pres.staffName = staffName;
            activeTicketPresence.set(idLimpio, pres);

            return res.json({ success: true, ticket: ticketApartado, presence: obtenerPresenciaTicket(idLimpio) });
        }

        if (action === 'RELEASE') {
            const ticketActual = await SupportTicket.findOne({ ticketId: idLimpio });
            if (!ticketActual) return res.status(404).json({ error: 'Ticket no encontrado.' });

            if (!isOwner && ticketActual.assignedWorker && ticketActual.assignedWorker !== staffEmail) {
                return res.status(403).json({ error: 'Solo el operador que apartó el ticket o el Dueño pueden liberarlo.' });
            }

            ticketActual.assignedWorker = '';
            ticketActual.assignedWorkerName = '';
            ticketActual.status = 'ABIERTO';
            await ticketActual.save();

            return res.json({ success: true, ticket: ticketActual, presence: obtenerPresenciaTicket(idLimpio) });
        }

        if (action === 'FORCE_TAKE') {
            if (!isOwner) return res.status(403).json({ error: 'Acción exclusiva del Dueño.' });
            const ticketTomado = await SupportTicket.findOneAndUpdate(
                { ticketId: idLimpio },
                {
                    $set: {
                        assignedWorker: staffEmail,
                        assignedWorkerName: staffName,
                        status: 'EN_REVISION'
                    }
                },
                { new: true }
            );
            if (!ticketTomado) return res.status(404).json({ error: 'Ticket no encontrado.' });
            return res.json({ success: true, ticket: ticketTomado, presence: obtenerPresenciaTicket(idLimpio) });
        }

        return res.status(400).json({ error: 'Acción inválida.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error al procesar el apartado del ticket.' });
    }
});

// 4. Latido en Vivo de Chat: Devuelve mensajes nuevos y estado "en línea / escribiendo..." (0 escrituras en MongoDB)
app.post('/api/tickets/live-sync', verificarTokenOpcional, async (req, res) => {
    try {
        const { ticketId, role, isTyping, staffName } = req.body;
        const idLimpio = String(ticketId || '').trim().toUpperCase();
        if (!idLimpio) return res.status(400).json({ error: 'Falta ticketId' });

        const now = Date.now();
        const pres = activeTicketPresence.get(idLimpio) || {};

        if (role === 'worker' || role === 'admin') {
            pres.staffLastSeen = now;
            if (staffName) pres.staffName = staffName;
            pres.staffTypingUntil = isTyping ? (now + 4500) : 0;
        } else {
            pres.clientLastSeen = now;
            pres.clientTypingUntil = isTyping ? (now + 4500) : 0;
        }
        activeTicketPresence.set(idLimpio, pres);

        const ticket = await SupportTicket.findOne({ ticketId: idLimpio }).lean();
        if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado.' });

        return res.json({
            success: true,
            ticket,
            presence: obtenerPresenciaTicket(idLimpio)
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error sincronizando chat.' });
    }
});

// 5. Eliminar un ticket o limpiar todos los resueltos (Optimización de Base de Datos)
app.post('/api/tickets/cleanup', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { action, ticketId } = req.body;
        if (action === 'DELETE_ONE' && ticketId) {
            await SupportTicket.deleteOne({ ticketId: String(ticketId).trim().toUpperCase() });
            activeTicketPresence.delete(String(ticketId).trim().toUpperCase());
            return res.json({ success: true, message: `Ticket #${ticketId} eliminado de la base de datos.` });
        }
        if (action === 'PURGE_RESOLVED') {
            const resultado = await SupportTicket.deleteMany({ status: { $in: ['RESUELTO', 'CERRADO'] } });
            return res.json({
                success: true,
                deletedCount: resultado.deletedCount || 0,
                message: `Se liberaron ${resultado.deletedCount || 0} tickets resueltos de MongoDB.`
            });
        }
        return res.status(400).json({ error: 'Acción inválida.' });
    } catch (error) {
        return res.status(500).json({ error: 'Error limpiando tickets.' });
    }
});

// =================================================================
// 👷 DASHBOARD 2: ENDPOINTS PARA TRABAJADORES / OPERADORES
// =================================================================

// 1. Cola de órdenes, tickets y lista de operadores en tiempo real
app.get('/api/worker/queue', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { statusFilter } = req.query;
        const workerEmail = (req.staffUser.email || '').trim().toLowerCase();
        const isOwner = req.effectiveRole === 'admin';

        const query = {};
        if (statusFilter && statusFilter !== 'TODAS') {
            query.status = statusFilter;
        }

        // 🔒 PRIVACIDAD ESTRICTA: Cada trabajador solo recibe la Cola por Apartar pública + SUS propias órdenes
        if (!isOwner) {
            query.$or = [
                {
                    status: { $in: ['EN_PROCESO', 'ERROR_API'] },
                    $or: [{ claimedByWorker: '' }, { claimedByWorker: null }, { claimedByWorker: { $exists: false } }]
                },
                { claimedByWorker: workerEmail },
                { approvedByWorker: workerEmail },
                { reviewedByWorker: workerEmail }
            ];
        }

        const [orders, ticketsAbiertos, pendientesSinApartarCount, workersList] = await Promise.all([
            Order.find(query).sort({ fecha: -1 }).limit(250).select('-costUSD').lean(),
            SupportTicket.find(
                isOwner
                    ? {}
                    : {
                        $or: [
                            { status: 'ABIERTO', $or: [{ assignedWorker: '' }, { assignedWorker: null }, { assignedWorker: { $exists: false } }] },
                            { assignedWorker: workerEmail }
                        ]
                    }
            ).sort({ updatedAt: -1 }).limit(120).lean(),
            Order.countDocuments({
                status: 'EN_PROCESO',
                $or: [{ claimedByWorker: '' }, { claimedByWorker: null }, { claimedByWorker: { $exists: false } }]
            }),
            isOwner ? User.find({ role: { $in: ['worker', 'admin'] } }).select('email accountName role tokems').lean() : Promise.resolve([])
        ]);

        return res.json({
            success: true,
            workerEmail,
            workerName: req.staffUser.accountName || workerEmail.split('@')[0],
            role: req.effectiveRole,
            pendientesCount: pendientesSinApartarCount,
            orders,
            tickets: ticketsAbiertos,
            workersList
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error cargando cola de trabajo.' });
    }
});

// 📌 1.5 APARTAR, LIBERAR O TOMAR CONTROL DE UNA ORDEN (CANDADO ATÓMICO)
app.post('/api/worker/claim-order', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { orderId, action } = req.body; // 'CLAIM' | 'RELEASE' | 'FORCE_TAKE'
        if (!orderId || !action) return res.status(400).json({ error: 'Faltan parámetros.' });

        const idLimpio = String(orderId).trim().toUpperCase();
        const staffEmail = (req.staffUser.email || '').trim().toLowerCase();
        const staffName = req.staffUser.accountName || staffEmail.split('@')[0];
        const isOwner = req.effectiveRole === 'admin';

        if (action === 'CLAIM') {
            // Bloqueo atómico: solo se aparta si nadie más la ha apartado
            const ordenApartada = await Order.findOneAndUpdate(
                {
                    orderId: idLimpio,
                    $or: [
                        { claimedByWorker: '' },
                        { claimedByWorker: null },
                        { claimedByWorker: { $exists: false } },
                        { claimedByWorker: staffEmail }
                    ]
                },
                {
                    $set: {
                        claimedByWorker: staffEmail,
                        claimedByName: staffName,
                        claimedAt: new Date()
                    }
                },
                { new: true }
            ).select('-costUSD');

            if (!ordenApartada) {
                const existente = await Order.findOne({ orderId: idLimpio }).select('claimedByWorker claimedByName').lean();
                if (!existente) return res.status(404).json({ error: 'La orden ya no existe.' });
                return res.status(409).json({
                    error: `⚠️ Esta orden acaba de ser apartada por ${existente.claimedByName || existente.claimedByWorker}.`
                });
            }

            return res.json({
                success: true,
                message: `Orden #${idLimpio} apartada en tu zona privada.`,
                order: ordenApartada
            });
        }

        if (action === 'RELEASE') {
            if (!isOwner) {
                return res.status(403).json({ error: 'Acción exclusiva del Dueño: Los trabajadores no pueden devolver órdenes a la cola.' });
            }
            const ordenActual = await Order.findOne({ orderId: idLimpio });
            if (!ordenActual) return res.status(404).json({ error: 'Orden no encontrada.' });

            ordenActual.claimedByWorker = '';
            ordenActual.claimedByName = '';
            ordenActual.claimedAt = null;
            await ordenActual.save();

            return res.json({
                success: true,
                message: `Orden #${idLimpio} devuelta a la cola pública.`,
                order: ordenActual
            });
        }

        if (action === 'FORCE_TAKE') {
            if (!isOwner) return res.status(403).json({ error: 'Acción exclusiva del Dueño.' });

            const ordenTomada = await Order.findOneAndUpdate(
                { orderId: idLimpio },
                {
                    $set: {
                        claimedByWorker: staffEmail,
                        claimedByName: staffName,
                        claimedAt: new Date()
                    }
                },
                { new: true }
            ).select('-costUSD');

            if (!ordenTomada) return res.status(404).json({ error: 'Orden no encontrada.' });

            return res.json({
                success: true,
                message: `Has tomado el control de la orden #${idLimpio} en tu zona privada.`,
                order: ordenTomada
            });
        }

        return res.status(400).json({ error: 'Acción de apartado inválida.' });
    } catch (error) {
        console.error('Error en /api/worker/claim-order:', error);
        return res.status(500).json({ error: 'Error al procesar el apartado de la orden.' });
    }
});

// 2. Acción del Trabajador: APROBAR, REVISIÓN o RECHAZAR (Requiere que esté apartada)
app.post('/api/worker/process-order', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { orderId, action, manualPinCode, workerNotes } = req.body;
        if (!orderId || !action) return res.status(400).json({ error: 'Faltan parámetros.' });

        const orden = await Order.findOne({ orderId: orderId.trim().toUpperCase() });
        if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });

        const staffEmail = (req.staffUser.email || '').trim().toLowerCase();
        const staffName = req.staffUser.accountName || staffEmail.split('@')[0];
        const isOwner = req.effectiveRole === 'admin';

        // Verificar que otro trabajador no la tenga apartada
        if (!isOwner && orden.claimedByWorker && orden.claimedByWorker !== staffEmail) {
            return res.status(403).json({
                error: `Esta orden está apartada privadamente por ${orden.claimedByName || orden.claimedByWorker}.`
            });
        }

        // Asegurar que quede registrada como apartada por quien la procesa
        if (!orden.claimedByWorker) {
            orden.claimedByWorker = staffEmail;
            orden.claimedByName = staffName;
            orden.claimedAt = new Date();
        }

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
                orden.approvedByWorker = staffEmail;
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

            if (apiResultado.isProcessingAsync && !manualPinCode) {
                orden.status = 'EJECUTANDO_API';
                orden.progressPercent = 85;
                orden.apiOrderId = apiResultado.apiOrderId || '';
                orden.apiRawResponse = apiResultado.raw || null;
                orden.statusMessage = 'Pago verificado. Procesando la entrega automática de tu compra...';
                orden.approvedByWorker = staffEmail;
                await orden.save();
                return res.json({
                    success: true,
                    message: `Orden #${orden.orderId} enviada al proveedor. El sistema entregará el pedido automáticamente al completarse.`,
                    order: orden
                });
            }

            orden.status = 'ENTREGADO';
            orden.progressPercent = 100;
            orden.deliveredCode = manualPinCode ? manualPinCode.trim() : apiResultado.deliveredCode;
            orden.apiOrderId = apiResultado.apiOrderId || '';
            orden.apiRawResponse = apiResultado.raw || null;
            orden.statusMessage = orden.fulfillmentType === 'API_GIFT_CARD'
                ? '¡Entrega completada! Cópiala aquí abajo.'
                : '¡Pedido entregado con éxito! Verifica tu cuenta.';
            orden.approvedByWorker = staffEmail;
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

        // ⚠️ SI EL TRABAJADOR PONE LA ORDEN EN REVISIÓN
        if (action === 'REVISION') {
            const motivo = (workerNotes || 'Detectamos un detalle con tu pago que debemos verificar contigo.').trim();
            orden.status = 'EN_REVISION';
            orden.progressPercent = 100;
            orden.hadReview = true;
            orden.reviewedAt = new Date();
            orden.reviewReason = motivo;
            orden.workerNotes = motivo;
            orden.statusMessage = '⚠️ Tu pedido se encuentra en revisión. Revisa el mensaje del operador aquí abajo.';
            orden.reviewedByWorker = staffEmail;
            await orden.save();

            return res.json({
                success: true,
                message: `Orden #${orden.orderId} puesta en revisión.`,
                order: orden
            });
        }

        // ❌ SI EL TRABAJADOR RECHAZA LA ORDEN
        if (action === 'RECHAZAR') {
            const yaEstabaRechazada = orden.status === 'RECHAZADO';
            if (orden.status === 'EN_REVISION') {
                orden.hadReview = true;
            }
            orden.status = 'RECHAZADO';
            orden.progressPercent = 100;
            orden.statusMessage = (workerNotes || '').trim() || 'No pudimos verificar tu referencia de pago. Si crees que es un error, abre un ticket de soporte.';
            orden.workerNotes = (workerNotes || '').trim() || 'Referencia no encontrada';
            orden.approvedByWorker = staffEmail;
            orden.completedAt = new Date();
            await orden.save();

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

// 🗑️ ELIMINAR ORDEN DEFINITIVAMENTE (Exclusivo para el Dueño)
app.post('/api/worker/delete-order', verificarSoloAdmin, async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Falta el ID de la orden.' });

        const idLimpio = String(orderId).trim().toUpperCase();
        const ordenBorrada = await Order.findOneAndDelete({ orderId: idLimpio });

        if (!ordenBorrada) {
            return res.status(404).json({ error: 'La orden no existe o ya fue eliminada.' });
        }

        return res.json({
            success: true,
            message: `Orden #${idLimpio} eliminada con éxito de la base de datos.`
        });
    } catch (error) {
        console.error('Error eliminando orden:', error);
        return res.status(500).json({ error: 'Error al eliminar la orden.' });
    }
});

// 👑 DASHBOARD 1: ENDPOINTS EXCLUSIVOS PARA TI (ADMIN / DESARROLLADOR)
// =================================================================

app.get('/api/admin/overview', verificarSoloAdmin, async (req, res) => {
    try {
        // Sincronizado con zona horaria de Venezuela (UTC-4) para que no reinicie a las 8:00 PM
        const ahoraVzla = new Date(Date.now() - (4 * 60 * 60 * 1000));
        const hoyInicio = new Date(Date.UTC(ahoraVzla.getUTCFullYear(), ahoraVzla.getUTCMonth(), ahoraVzla.getUTCDate(), 4, 0, 0, 0));
        const mesInicio = new Date(Date.UTC(ahoraVzla.getUTCFullYear(), ahoraVzla.getUTCMonth(), 1, 4, 0, 0, 0));

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

// 2. Modificar Tasa Bs/USD, Portada, Pool de Tarjetas Base del Algoritmo y Configuración General
app.post('/api/admin/settings', verificarSoloAdmin, async (req, res) => {
    try {
        const {
            exchangeRateVES,
            bcvRateVES,
            tokemValueUSD,
            storeOpen,
            autoTriggerApiOnTokems,
            announcementText,
            hideAnnouncement,
            heroConfig,
            flashSectionConfig,
            flashOffers,
            catalogSectionConfig,
            navigationConfig,
            flyersCanvaConfig,
            steamCalculatorConfig,
            arbitrageBaseCards
        } = req.body;

        const requiereRecalculoAlgoritmo = Array.isArray(arbitrageBaseCards);

        // Si no estamos recalculando el pool con el caché de Central One, no cargamos los +5,000 SKUs de MongoDB
        let querySettings = StoreSettings.findOne({ key: 'main_settings' });
        if (!requiereRecalculoAlgoritmo) {
            querySettings = querySettings.select('-centralOneCatalogCache -centralOneCoverageCache -processedWebhookIds');
        }

        let settings = await querySettings;
        if (!settings) settings = new StoreSettings({ key: 'main_settings' });

        if (exchangeRateVES !== undefined) settings.exchangeRateVES = Number(exchangeRateVES);
        if (bcvRateVES !== undefined) settings.bcvRateVES = Number(bcvRateVES);
        if (tokemValueUSD !== undefined) settings.tokemValueUSD = Number(tokemValueUSD);
        if (typeof storeOpen === 'boolean') settings.storeOpen = storeOpen;
        if (typeof autoTriggerApiOnTokems === 'boolean') settings.autoTriggerApiOnTokems = autoTriggerApiOnTokems;
        if (announcementText !== undefined) settings.announcementText = announcementText;
        if (typeof hideAnnouncement === 'boolean') settings.hideAnnouncement = hideAnnouncement;
        if (heroConfig && typeof heroConfig === 'object') settings.heroConfig = heroConfig;
        if (flashSectionConfig && typeof flashSectionConfig === 'object') {
            settings.flashSectionConfig = flashSectionConfig;
            settings.markModified('flashSectionConfig');
        }
        if (Array.isArray(flashOffers)) {
            settings.flashOffers = flashOffers;
            settings.markModified('flashOffers');
        }
        if (catalogSectionConfig && typeof catalogSectionConfig === 'object') {
            settings.catalogSectionConfig = catalogSectionConfig;
            settings.markModified('catalogSectionConfig');
        }
        if (navigationConfig && typeof navigationConfig === 'object') {
            settings.navigationConfig = navigationConfig;
            settings.markModified('navigationConfig');
        }
        if (flyersCanvaConfig && typeof flyersCanvaConfig === 'object') {
            settings.flyersCanvaConfig = flyersCanvaConfig;
            settings.markModified('flyersCanvaConfig');
        }
        if (steamCalculatorConfig && typeof steamCalculatorConfig === 'object') {
            settings.steamCalculatorConfig = steamCalculatorConfig;
            settings.markModified('steamCalculatorConfig');
        }
        if (Array.isArray(arbitrageBaseCards)) {
            settings.arbitrageBaseCards = arbitrageBaseCards;
            settings.markModified('arbitrageBaseCards');
        }
        settings.updatedBy = req.adminUser.email;

        let productosActualizados = undefined;
        if (requiereRecalculoAlgoritmo) {
            // recalcularPreciosYAlgoritmoTiendaKZ ya ejecuta settings.save() una sola vez al finalizar
            await recalcularPreciosYAlgoritmoTiendaKZ(settings);
            productosActualizados = await CatalogProduct.find().sort({ sortOrder: 1 }).lean();
        } else {
            await settings.save();
        }

        // Enviar respuesta ligera al navegador (sin reenviar los Megabytes de centralOneCatalogCache)
        const settingsLigero = settings.toObject ? settings.toObject() : { ...settings };
        delete settingsLigero.centralOneCatalogCache;
        delete settingsLigero.centralOneCoverageCache;
        delete settingsLigero.processedWebhookIds;

        return res.json({
            success: true,
            settings: settingsLigero,
            ...(productosActualizados ? { products: productosActualizados } : {})
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando configuración de la tienda.' });
    }
});

// 2.5 Endpoints de Sincronización y Control del Monitor Central One API
app.post('/api/admin/central-one/sync', verificarSoloAdmin, async (req, res) => {
    try {
        const resultado = await sincronizarTodoConCentralOne(true);
        const [settings, products] = await Promise.all([
            StoreSettings.findOne({ key: 'main_settings' }).lean(),
            CatalogProduct.find().sort({ sortOrder: 1 }).lean()
        ]);
        return res.json({
            success: resultado.success,
            error: resultado.error || null,
            settings,
            products
        });
    } catch (e) {
        return res.status(500).json({ error: 'Error sincronizando con Central One.' });
    }
});

app.post('/api/admin/central-one/clear-alerts', verificarSoloAdmin, async (req, res) => {
    try {
        const settings = await StoreSettings.findOne({ key: 'main_settings' });
        if (settings) {
            settings.centralOneAlerts = [];
            settings.markModified('centralOneAlerts');
            await settings.save();
        }
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Error limpiando alertas.' });
    }
});

// 3. Crear o Editar cualquier Juego, Gift Card o Servicio (Guardado Ultrarrápido)
app.post('/api/admin/product/save', verificarSoloAdmin, async (req, res) => {
    try {
        const { productId, originalSlug, _id, ...productData } = req.body;
        if (!productData.slug || !productData.name || !productData.mainCategory || !productData.subCategory) {
            return res.status(400).json({ error: 'Slug, nombre, categoría y subcategoría son obligatorios.' });
        }

        const slugNuevo = productData.slug.trim().toLowerCase().replace(/\s+/g, '-');
        const slugAnterior = (originalSlug || '').trim().toLowerCase();

        // Asegurar cálculo exacto de Venta = Costo + Ganancia Fija en memoria (0ms) sin descargar los 5,156 productos
        const normalizarListaPaquetesRapido = (lista) => {
            if (!Array.isArray(lista)) return [];
            return lista.map(pkg => {
                const cUsd = Number(pkg.costUSD || 0);
                if (pkg.autoPriceByProfit !== false && cUsd > 0) {
                    const prof = pkg.profitUSD !== undefined && pkg.profitUSD !== null
                        ? Number(pkg.profitUSD)
                        : Math.max(0.15, Number(((pkg.priceUSD || 1) - cUsd).toFixed(2)));
                    pkg.profitUSD = Number(prof.toFixed(2));
                    pkg.priceUSD = Number((cUsd + pkg.profitUSD).toFixed(2));
                    pkg.tokemsPrice = pkg.priceUSD;
                }
                return pkg;
            });
        };

        const camposLimpios = {
            slug: slugNuevo,
            name: productData.name.trim(),
            mainCategory: productData.mainCategory,
            subCategory: productData.subCategory,
            fulfillmentType: productData.fulfillmentType || 'API_DIRECT_TOPUP',
            isSmartCodeProduct: Boolean(productData.isSmartCodeProduct),
            smartPlatformGroup: productData.smartPlatformGroup || 'steam',
            regionText: productData.regionText || '',
            badgeText: productData.badgeText || '',
            uidLabel: productData.uidLabel || 'ID de Jugador (UID)',
            serviceCommissionPercent: Number(productData.serviceCommissionPercent || 0),
            cardImageUrl: productData.cardImageUrl !== undefined ? String(productData.cardImageUrl).trim() : '',
            flyerImageUrl: productData.flyerImageUrl !== undefined ? String(productData.flyerImageUrl).trim() : '',
            infoImageUrl: productData.infoImageUrl !== undefined ? String(productData.infoImageUrl).trim() : '',
            description: productData.description || '',
            instructions: productData.instructions || '',
            requiresServer: Boolean(productData.requiresServer),
            requiresRegion: Boolean(productData.requiresRegion),
            regionsList: Array.isArray(productData.regionsList) ? productData.regionsList : [],
            requiresInternalLogin: Boolean(productData.requiresInternalLogin),
            active: productData.active !== false,
            useAltPricing: Boolean(productData.useAltPricing),
            altDescription: productData.altDescription !== undefined ? String(productData.altDescription) : '',
            altInstructions: productData.altInstructions !== undefined ? String(productData.altInstructions) : '',
            packages: normalizarListaPaquetesRapido(productData.packages),
            altPackages: normalizarListaPaquetesRapido(productData.altPackages)
        };

        let productoExistente = null;
        if (productId && mongoose.Types.ObjectId.isValid(productId)) {
            productoExistente = await CatalogProduct.findById(productId).select('_id slug name').lean();
        }
        if (!productoExistente && slugAnterior) {
            productoExistente = await CatalogProduct.findOne({ slug: slugAnterior }).select('_id slug name').lean();
        }

        let productoActualizado = null;

        if (productoExistente) {
            const slugViejoReal = productoExistente.slug;
            if (slugViejoReal !== slugNuevo) {
                const colision = await CatalogProduct.findOne({
                    slug: slugNuevo,
                    _id: { $ne: productoExistente._id }
                }).select('_id name').lean();
                if (colision) {
                    return res.status(400).json({
                        error: `Ya existe otro producto ("${colision.name}") usando el identificador "${slugNuevo}". Elige un Slug diferente.`
                    });
                }
            }

            productoActualizado = await CatalogProduct.findByIdAndUpdate(
                productoExistente._id,
                { $set: camposLimpios },
                { new: true }
            ).lean();

            // Actualizar referencias en segundo plano (sin bloquear la respuesta al navegador)
            setImmediate(async () => {
                try {
                    const settings = await StoreSettings.findOne({ key: 'main_settings' })
                        .select('catalogSectionConfig navigationConfig flashOffers flyersCanvaConfig');
                    if (!settings) return;
                    let huboCambioSettings = false;

                    if (slugViejoReal && slugViejoReal !== slugNuevo) {
                        if (settings.catalogSectionConfig && Array.isArray(settings.catalogSectionConfig.pills)) {
                            settings.catalogSectionConfig.pills.forEach(pill => {
                                if (Array.isArray(pill.productSlugs)) {
                                    const idx = pill.productSlugs.indexOf(slugViejoReal);
                                    if (idx !== -1) {
                                        pill.productSlugs[idx] = slugNuevo;
                                        huboCambioSettings = true;
                                    }
                                }
                            });
                            if (huboCambioSettings) settings.markModified('catalogSectionConfig');
                        }
                        if (settings.navigationConfig && Array.isArray(settings.navigationConfig.menus)) {
                            settings.navigationConfig.menus.forEach(menu => {
                                (menu.submenus || []).forEach(sub => {
                                    if (Array.isArray(sub.productSlugs)) {
                                        const idx = sub.productSlugs.indexOf(slugViejoReal);
                                        if (idx !== -1) {
                                            sub.productSlugs[idx] = slugNuevo;
                                            huboCambioSettings = true;
                                        }
                                    }
                                });
                            });
                            if (huboCambioSettings) settings.markModified('navigationConfig');
                        }
                        if (Array.isArray(settings.flashOffers)) {
                            settings.flashOffers.forEach(of => {
                                if (of.slug === slugViejoReal) {
                                    of.slug = slugNuevo;
                                    huboCambioSettings = true;
                                }
                            });
                            if (huboCambioSettings) settings.markModified('flashOffers');
                        }
                    }

                    // Sincronizar precios de este producto en Flyers Canva en segundo plano
                    if (settings.flyersCanvaConfig && typeof settings.flyersCanvaConfig === 'object') {
                        const listaActiva = (camposLimpios.useAltPricing && camposLimpios.altPackages.length > 0)
                            ? camposLimpios.altPackages
                            : camposLimpios.packages;
                        const mapaPrecios = {};
                        listaActiva.forEach(pk => {
                            mapaPrecios[`${slugNuevo}::${pk.packageId}`] = Number(pk.priceUSD || 0).toFixed(2);
                        });
                        let flyersMod = false;
                        Object.values(settings.flyersCanvaConfig).forEach(ficha => {
                            (ficha.items || []).forEach(itm => {
                                if (itm.linkedRef && mapaPrecios[itm.linkedRef] && itm.price !== mapaPrecios[itm.linkedRef]) {
                                    itm.price = mapaPrecios[itm.linkedRef];
                                    flyersMod = true;
                                }
                            });
                        });
                        if (flyersMod) {
                            settings.markModified('flyersCanvaConfig');
                            huboCambioSettings = true;
                        }
                    }

                    if (huboCambioSettings) await settings.save();
                } catch (e) {}
            });
        } else {
            const yaExiste = await CatalogProduct.findOne({ slug: slugNuevo }).select('_id name').lean();
            if (yaExiste) {
                return res.status(400).json({
                    error: `El identificador "${slugNuevo}" ya está en uso por "${yaExiste.name}". Cambia el Slug para crear el nuevo producto.`
                });
            }
            const docCreado = await new CatalogProduct(camposLimpios).save();
            productoActualizado = docCreado.toObject();
        }

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

// 4.5 Reordenar Posiciones Globales de los Productos en la Tienda (Estándar + Algoritmo)
app.post('/api/admin/product/reorder', verificarSoloAdmin, async (req, res) => {
    try {
        const { orderedSlugs } = req.body;
        if (!Array.isArray(orderedSlugs) || orderedSlugs.length === 0) {
            return res.status(400).json({ error: 'Lista de orden inválida.' });
        }

        const ops = orderedSlugs.map((slug, idx) => ({
            updateOne: {
                filter: { slug: String(slug || '').trim().toLowerCase() },
                update: { $set: { sortOrder: idx + 1 } }
            }
        }));

        await CatalogProduct.bulkWrite(ops);
        return res.json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando el nuevo orden de productos.' });
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
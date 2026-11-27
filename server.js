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
const https = require('https');
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 30000 });

const CENTRAL_ONE_BASE_URL = (process.env.CENTRAL_ONE_BASE_URL || 'https://portal.centraloneglobal.com/api/v1').replace(/\/+$/, '');

// ⚡ CACHÉ EN MEMORIA RAM DE ÍNDICES DE CENTRAL ONE (0ms DE BÚSQUEDA EN ALGORITMO Y CREACIÓN DE ÓRDENES)
let _ramCatalogRef = null;
let _ramMapaCO_Id = {};
let _ramMapaCO_Sku = {};

function obtenerIndicesCatalogoEnRAM(catalogCache) {
    if (!Array.isArray(catalogCache) || catalogCache.length === 0) {
        return { tieneCacheAPI: false, mapaCO_Id: {}, mapaCO_Sku: {} };
    }
    if (_ramCatalogRef !== catalogCache && Object.keys(_ramMapaCO_Id).length !== catalogCache.length) {
        const nuevoId = {};
        const nuevoSku = {};
        for (let i = 0; i < catalogCache.length; i++) {
            const it = catalogCache[i];
            if (it && it.product_id) nuevoId[it.product_id] = it;
            if (it && it.sku) nuevoSku[String(it.sku).trim().toUpperCase()] = it;
        }
        _ramCatalogRef = catalogCache;
        _ramMapaCO_Id = nuevoId;
        _ramMapaCO_Sku = nuevoSku;
    }
    return { tieneCacheAPI: true, mapaCO_Id: _ramMapaCO_Id, mapaCO_Sku: _ramMapaCO_Sku };
}

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
    if (m <= 3.00) return { max: 3, ideal: 1 };
    if (m <= 6.00) return { max: 3, ideal: 2 };
    if (m <= 12.00) return { max: 4, ideal: 2 };
    if (m <= 25.00) return { max: 5, ideal: 3 };
    if (m <= 40.00) return { max: 6, ideal: 3 };
    if (m <= 60.00) return { max: 7, ideal: 4 };
    if (m <= 105.00) return { max: 9, ideal: 5 };
    return { max: 11, ideal: 6 };
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
        let enStockAPI = c.inStock !== false;
        let stockDispAPI = (c.availableStock !== null && c.availableStock !== undefined) ? Number(c.availableStock) : null;
        const stockInternoCount = Array.isArray(c.internalCodeStock) ? c.internalCodeStock.length : 0;

        let coIdResuelto = String(c.centralOneProductId || '').trim();
        let coSkuResuelto = String(c.centralOneSku || '').trim();

        if (tieneCacheAPI && (coIdResuelto || coSkuResuelto)) {
            const itemCO = (coIdResuelto && mapaCO_Id[coIdResuelto]) ||
                           (coSkuResuelto && mapaCO_Sku[coSkuResuelto.toUpperCase()]);
            if (!itemCO) {
                enStockAPI = false;
            } else {
                if (!coIdResuelto && itemCO.product_id) coIdResuelto = String(itemCO.product_id);
                if (!coSkuResuelto && itemCO.sku) coSkuResuelto = String(itemCO.sku);
                enStockAPI = Boolean(itemCO.in_stock && itemCO.status === 'active');
                if (itemCO.reseller_price !== null && Number(itemCO.reseller_price) > 0) {
                    costoReal = Number(itemCO.reseller_price);
                }
                if (itemCO.available_stock !== undefined && itemCO.available_stock !== null) {
                    stockDispAPI = Number(itemCO.available_stock);
                }
                if (stockDispAPI !== null && stockDispAPI <= 0) enStockAPI = false;
            }
        }

        if (costoReal <= 0 && stockInternoCount > 0 && effUsd > 0) {
            costoReal = effUsd;
        }

        if (!enStockAPI && stockInternoCount <= 0) continue;
        const stockTotalEfectivo = !enStockAPI
            ? stockInternoCount
            : (stockDispAPI !== null ? (stockDispAPI + stockInternoCount) : null);
        if (stockTotalEfectivo !== null && stockTotalEfectivo <= 0) continue;
        if (effUsd <= 0 || costoReal <= 0) continue;

        candidatas.push({
            ...c,
            cardId: c.cardId,
            name: c.name || coSkuResuelto || 'Tarjeta Base',
            centralOneProductId: coIdResuelto,
            centralOneSku: coSkuResuelto,
            faceValueOrigin: c.faceValueOrigin,
            originCurrency: c.originCurrency || 'USD',
            effectiveClientUSD: effUsd,
            costUSD: costoReal,
            costPerDollar: costoReal / effUsd,
            availableStock: stockTotalEfectivo,
            internalStockCount: stockInternoCount,
            enStockAPI
        });
    }

    if (candidatas.length === 0) {
        return {
            hasSolution: false,
            reason: `No hay tarjetas base activas y con stock disponible en la Bóveda de ${(platformGroup || 'steam').toUpperCase()}.`
        };
    }

    const menorCartaGlobalUSD = Math.min(...candidatas.map(c => c.effectiveClientUSD));

    // 🔒 Techo máximo calibrado: impide sobrecostos exagerados pero permite cubrir montos pequeños como $1.50 USD
    const calcularTechoMaximoPermitidoUSD = (targetUSD, menorCartaDispUSD = 0) => {
        let techoBase = 0;
        if (targetUSD <= 3.00) techoBase = Number((targetUSD + 1.65).toFixed(2));
        else if (targetUSD <= 6.00) techoBase = Number((targetUSD + 1.85).toFixed(2));
        else if (targetUSD <= 15.00) techoBase = Number((targetUSD + 2.50).toFixed(2));
        else if (targetUSD <= 35.00) techoBase = Number((targetUSD + 3.80).toFixed(2));
        else techoBase = Number((targetUSD * 1.14).toFixed(2));

        if (menorCartaDispUSD > 0 && menorCartaDispUSD <= targetUSD + 2.10) {
            techoBase = Math.max(techoBase, Number((menorCartaDispUSD + 0.05).toFixed(2)));
        }
        return techoBase;
    };

    const resolverTramoConAlgoritmoExacto = (targetTramoUSD, listaDisp, limiteCartas, techoCustomUSD = null) => {
        const techoMaximoUSD = techoCustomUSD !== null
            ? techoCustomUSD
            : calcularTechoMaximoPermitidoUSD(targetTramoUSD, menorCartaGlobalUSD);

        let cands = listaDisp.filter(c => c.effectiveClientUSD <= techoMaximoUSD + 0.01);
        if (cands.length === 0) return null;

        if (targetTramoUSD >= 10) {
            const umbralMin = (targetTramoUSD / limiteCartas) * 0.40;
            const grandesOConStockPropio = cands.filter(c => c.effectiveClientUSD >= umbralMin || c.internalStockCount > 0);
            if (grandesOConStockPropio.length > 0) cands = grandesOConStockPropio;
        }

        cands.sort((a, b) => {
            const aTienePropio = a.internalStockCount > 0 ? 1 : 0;
            const bTienePropio = b.internalStockCount > 0 ? 1 : 0;
            if (aTienePropio !== bTienePropio) return bTienePropio - aTienePropio;
            if (Math.abs(a.costPerDollar - b.costPerDollar) > 0.015) return a.costPerDollar - b.costPerDollar;
            return b.effectiveClientUSD - a.effectiveClientUSD;
        });

        const n = cands.length;
        const mayorCartaUSD = Math.max(...cands.map(c => c.effectiveClientUSD));
        const pisoMinimoUSD = Number((targetTramoUSD - 0.001).toFixed(4));

        const maxCartaGlobalPorIndice = new Array(n);
        let maxRunning = 0;
        for (let i = n - 1; i >= 0; i--) {
            if (cands[i].effectiveClientUSD > maxRunning) maxRunning = cands[i].effectiveClientUSD;
            maxCartaGlobalPorIndice[i] = maxRunning;
        }

        // Penalización progresiva por tarjeta extra: obliga al algoritmo a preferir siempre la menor cantidad de tarjetas posible
        const penalizacionPorCartaMicro = Math.round(Math.max(0.22, targetTramoUSD * 0.015) * 10000);
        const soluciones = [];
        let nodosExplorados = 0;

        function explorar(startIndex, cartasUsadas, conteoPorIndice, sumaClienteUSD, sumaCostoMicro) {
            nodosExplorados++;
            if (nodosExplorados > 2200) return;

            const sumaRedondeada = Number(sumaClienteUSD.toFixed(2));
            if (cartasUsadas > 0 && sumaRedondeada >= pisoMinimoUSD && sumaRedondeada <= techoMaximoUSD) {
                const diffMeta = Number(Math.max(0, sumaRedondeada - targetTramoUSD).toFixed(2));
                const itemsCombo = [];
                let cartasCubiertasConStockPropio = 0;
                let usdCubiertoConStockPropio = 0;

                Object.entries(conteoPorIndice).forEach(([idxStr, qty]) => {
                    const card = cands[Number(idxStr)];
                    const cubiertasPropio = Math.min(qty, Number(card.internalStockCount || 0));
                    cartasCubiertasConStockPropio += cubiertasPropio;
                    usdCubiertoConStockPropio += Number((cubiertasPropio * card.effectiveClientUSD).toFixed(2));

                    itemsCombo.push({
                        cardId: card.cardId,
                        centralOneProductId: card.centralOneProductId || '',
                        sku: card.centralOneSku || '',
                        name: card.name,
                        quantity: qty,
                        unitCostUSD: Number(card.costUSD),
                        unitClientUSD: Number(card.effectiveClientUSD),
                        ownStockUsed: cubiertasPropio,
                        originText: `${card.faceValueOrigin} ${card.originCurrency}`
                    });
                });

                const cartasAPedirEnAPI = Math.max(0, cartasUsadas - cartasCubiertasConStockPropio);
                const cubierto100PorStockPropio = (cartasAPedirEnAPI === 0 && cartasCubiertasConStockPropio > 0);
                const scoreBeneficioMicro = sumaCostoMicro + ((cartasUsadas - 1) * penalizacionPorCartaMicro);

                soluciones.push({
                    hasSolution: true,
                    totalCards: cartasUsadas,
                    totalClientUSD: sumaRedondeada,
                    totalCostUSD: deMicro4(sumaCostoMicro),
                    totalCostMicro: sumaCostoMicro,
                    scoreBeneficioMicro,
                    bonusClientUSD: diffMeta,
                    overshootUSD: diffMeta,
                    ownStockCardsUsed: cartasCubiertasConStockPropio,
                    ownStockUSD: usdCubiertoConStockPropio,
                    apiCardsNeeded: cartasAPedirEnAPI,
                    isFullyCoveredByOwnStock: cubierto100PorStockPropio,
                    items: itemsCombo
                });
                return;
            }

            if (cartasUsadas >= limiteCartas) return;

            const maxCartaRestanteUSD = maxCartaGlobalPorIndice[startIndex] || mayorCartaUSD;
            const faltaUSD = Math.max(0, pisoMinimoUSD - sumaClienteUSD);
            const minCartasFaltantes = Math.ceil(faltaUSD / Math.max(0.1, maxCartaRestanteUSD));
            if (cartasUsadas + minCartasFaltantes > limiteCartas) return;

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

        // 🏆 ORDENAMIENTO INTELIGENTE EN SERVIDOR:
        // Prioriza siempre el menor costo, Stock Propio y la menor cantidad de tarjetas posible.
        soluciones.sort((a, b) => {
            const diffCostoUSD = Math.abs(a.totalCostUSD - b.totalCostUSD);
            const diffOvershootUSD = Math.abs(a.overshootUSD - b.overshootUSD);

            if (diffCostoUSD <= 0.18 && diffOvershootUSD <= 0.25) {
                if (a.isFullyCoveredByOwnStock !== b.isFullyCoveredByOwnStock) {
                    return a.isFullyCoveredByOwnStock ? -1 : 1;
                }
                if (Math.abs(a.ownStockUSD - b.ownStockUSD) > 0.10) {
                    return b.ownStockUSD - a.ownStockUSD;
                }
                if (a.totalCards !== b.totalCards) {
                    return a.totalCards - b.totalCards;
                }
            }

            if (Math.abs(a.scoreBeneficioMicro - b.scoreBeneficioMicro) > 120) {
                return a.scoreBeneficioMicro - b.scoreBeneficioMicro;
            }
            if (a.totalCards !== b.totalCards) return a.totalCards - b.totalCards;
            if (Math.abs(a.ownStockUSD - b.ownStockUSD) > 0.10) return b.ownStockUSD - a.ownStockUSD;
            return a.overshootUSD - b.overshootUSD;
        });
        return soluciones[0];
    };

    const { max: maxCartasHumano } = obtenerLimiteHumanoCodigosServer(metaUSD);
    const techoGlobalMeta = calcularTechoMaximoPermitidoUSD(metaUSD, menorCartaGlobalUSD);
    const candidatasValidasParaMeta = candidatas.filter(c => c.effectiveClientUSD <= techoGlobalMeta + 0.01);

    if (candidatasValidasParaMeta.length === 0) {
        return {
            hasSolution: false,
            reason: `Sin tarjetas de denominación pequeña en stock para armar $${metaUSD.toFixed(2)} USD (Paquete pausado automáticamente).`
        };
    }

    const mayorCartaValida = Math.max(...candidatasValidasParaMeta.map(c => c.effectiveClientUSD));
    const minCodigosRequeridos = Math.ceil((metaUSD - 0.001) / Math.max(0.1, mayorCartaValida));

    let solucionFinal = null;

    // 1. Intento principal con el límite ampliado (+1 tarjeta en cada rango)
    if (minCodigosRequeridos <= maxCartasHumano) {
        solucionFinal = resolverTramoConAlgoritmoExacto(metaUSD, candidatasValidasParaMeta, maxCartasHumano, techoGlobalMeta);
    }

    // 2. Rescate flexible (+1 tarjeta extra adicional o techo ligeramente ampliado) si aún no hubo combinación
    if (!solucionFinal) {
        const techoFlexible = Number((techoGlobalMeta + 0.85).toFixed(2));
        const candsFlexibles = candidatas.filter(c => c.effectiveClientUSD <= techoFlexible + 0.01);
        if (candsFlexibles.length > 0) {
            solucionFinal = resolverTramoConAlgoritmoExacto(metaUSD, candsFlexibles, Math.min(12, maxCartasHumano + 1), techoFlexible);
        }
    }

    if (!solucionFinal) {
        return {
            hasSolution: false,
            reason: `Sin stock disponible para armar $${metaUSD.toFixed(2)} USD en este momento (Paquete pausado automáticamente).`
        };
    }

    solucionFinal.summaryText = solucionFinal.items
        .map(it => `${it.quantity}x ${it.name} ($${(it.unitClientUSD * it.quantity).toFixed(2)})`)
        .join(' + ');

    return solucionFinal;
}

// 🏦 (guardarCodigosRecuperadosEnStockInterno unificada en la versión blindada por plataforma más abajo)

// 🔄 RECALCULADOR GLOBAL DE PRECIOS POR GANANCIA FIJA + ALGORITMO + AUTO-PAUSA Y CURACIÓN DE PRECIOS INFLADOS
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
                    card.availableStock = 0;
                    huboCambioPool = true;
                }
            }
        }
        if (huboCambioPool) settingsDoc.markModified('arbitrageBaseCards');

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
                    const usaAlgo = (pkg.useSmartAlgorithm === false)
                        ? false
                        : Boolean(esSmartProd || pkg.useSmartAlgorithm);

                    const tieneStockBovedaPaquete = Array.isArray(pkg.backupPinVault) && pkg.backupPinVault.length > 0;
                    const metaUsd = extraerMetaUsdDeNombrePaqueteServer(pkg);

                    // 🛡️ AUTO-CURACIÓN: Si algún paquete (como 4 USD o 5 USD de PlayStation) quedó con el costo inflado de $98.32 ($100 USD), devolverlo a su valor base normal
                    if (metaUsd > 0 && Number(pkg.costUSD) > Math.max(metaUsd * 2.1, metaUsd + 15)) {
                        pkg.costUSD = metaUsd;
                        const profSano = Number(pkg.profitUSD ?? 0.50);
                        pkg.priceUSD = Number((metaUsd + profSano).toFixed(2));
                        pkg.tokemsPrice = pkg.priceUSD;
                        prodModificado = true;
                    }

                    if (usaAlgo) {
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
                                // Si no hay tarjetas pequeñas para armar el paquete (ej. $2 o $5 de PlayStation), se pausa automáticamente y NO altera su precio normal
                                const estadoStockFinal = tieneStockBovedaPaquete ? true : false;
                                if (pkg.providerInStock !== estadoStockFinal) {
                                    pkg.providerInStock = estadoStockFinal;
                                    prodModificado = true;
                                }
                                if (prevSummary !== 'SIN_SOLUCION') {
                                    pkg.resolvedCombo = { ...combo, summaryText: 'SIN_SOLUCION' };
                                    prodModificado = true;
                                }
                            }
                        }
                    } else {
                        if (pkg.resolvedCombo) {
                            pkg.resolvedCombo = null;
                            prodModificado = true;
                        }
                        if (catalogoCO.length > 0 && (pkg.centralOneProductId || pkg.apiProductSku)) {
                            const skuUpper = String(pkg.apiProductSku || '').trim().toUpperCase();
                            const itemCO = (pkg.centralOneProductId && mapaCO_PorId[pkg.centralOneProductId]) ||
                                           (skuUpper && mapaCO_PorSku[skuUpper]);

                            const cardEnBoveda = (settingsDoc.arbitrageBaseCards || []).find(c =>
                                (pkg.centralOneProductId && c.centralOneProductId === pkg.centralOneProductId) ||
                                (skuUpper && String(c.centralOneSku || '').trim().toUpperCase() === skuUpper)
                            );
                            const tieneStockPropioBoveda = cardEnBoveda && Array.isArray(cardEnBoveda.internalCodeStock) && cardEnBoveda.internalCodeStock.length > 0;
                            const tieneRespaldoLocal = Boolean(tieneStockBovedaPaquete || tieneStockPropioBoveda);

                            if (itemCO) {
                                const nuevoCosto = itemCO.reseller_price !== null ? Number(itemCO.reseller_price) : pkg.costUSD;
                                const nuevoStock = Boolean((itemCO.in_stock && itemCO.status === 'active') || tieneRespaldoLocal);
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
                            } else if (pkg.centralOneProductId || (skuUpper && skuUpIncludesDash(skuUpper))) {
                                const stockRespaldo = tieneRespaldoLocal ? true : false;
                                if (pkg.providerInStock !== stockRespaldo) {
                                    pkg.providerInStock = stockRespaldo;
                                    prodModificado = true;
                                }
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

            function skuUpIncludesDash(s) {
                return s.includes('-');
            }

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
            _ramBootstrapPayload = null;
            _ramBootstrapTs = 0;
            _ramFastProductsTs = 0;
        }

        let ofertasModificadas = false;
        if (catalogoCO.length > 0 && Array.isArray(settingsDoc.flashOffers)) {
            for (const of of settingsDoc.flashOffers) {
                if (of.centralOneProductId || (of.apiProductSku && String(of.apiProductSku).includes('-'))) {
                    const skuOf = String(of.apiProductSku || '').trim().toUpperCase();
                    const itemCO = (of.centralOneProductId && mapaCO_PorId[of.centralOneProductId]) ||
                                   (skuOf && mapaCO_PorSku[skuOf]);
                    const tienePinOf = Array.isArray(of.backupPinVault) && of.backupPinVault.length > 0;
                    const hayStockOf = itemCO ? Boolean((itemCO.in_stock && itemCO.status === 'active') || tienePinOf) : tienePinOf;
                    if (!hayStockOf && of.active !== false) {
                        of.active = false;
                        ofertasModificadas = true;
                    }
                }
            }
            if (ofertasModificadas) settingsDoc.markModified('flashOffers');
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

        if (huboCambioPool || ofertasModificadas || flyersModificados || !targetSlugOnly) {
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

// ⚡ Compactar cada ítem del catálogo dejando solo los campos necesarios (Reduce un 80% el peso en RAM y red)
            const itemsCompactados = nuevosItems.map(c => ({
                product_id: c.product_id,
                sku: c.sku,
                name: c.name,
                reseller_price: c.reseller_price,
                in_stock: c.in_stock,
                status: c.status,
                available_stock: c.available_stock,
                product_family_name: c.product_family_name || '',
                requires_target: c.requires_target,
                target_fields: c.target_fields || [],
                region: c.region || c.country || '',
                target_schema: c.target_schema || null
            }));

            _ramCentralOneCatalogCache = itemsCompactados;
            obtenerIndicesCatalogoEnRAM(_ramCentralOneCatalogCache);

            settings.centralOneCatalogCache = itemsCompactados;
            settings.centralOneSync.catalogCount = itemsCompactados.length;
            settings.centralOneSync.apiConnected = true;
            settings.centralOneSync.lastSyncAt = new Date();
            settings.markModified('centralOneCatalogCache');
        }

        if (!resCoverage._err && resCoverage.data) {
            settings.centralOneCoverageCache = resCoverage.data;
            settings.markModified('centralOneCoverageCache');
        }

        settings.markModified('centralOneSync');
        await recalcularPreciosYAlgoritmoTiendaKZ(settings, null, true);

        return {
            success: true,
            sync: settings.centralOneSync,
            catalogCount: (_ramCentralOneCatalogCache || []).length
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// 🔄 Sincronización automática en segundo plano cada 3 minutos (en vez de 15 min) para detectar stock y precios rápido
setInterval(() => {
    if (process.env.CENTRAL_ONE_API_KEY) {
        sincronizarTodoConCentralOne().catch(() => {});
    }
}, 3 * 60 * 1000);

setTimeout(() => {
    if (process.env.CENTRAL_ONE_API_KEY) {
        sincronizarTodoConCentralOne().catch(() => {});
    }
}, 5000);

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

Order.schema.add({
    waitCyclesCount: { type: Number, default: 0 }
});

// 🔒 Candado en memoria RAM para evitar que un Webhook y el Vigilante procesen la misma orden al mismo milisegundo
const activeOrderProcessingLocks = new Set();

function extraerNumeroFacialDeTextoServer(txt) {
    if (!txt) return 0;
    let limpio = String(txt);
    while (/(\d)[,.](\d{3})(?!\d)/.test(limpio)) {
        limpio = limpio.replace(/(\d)[,.](\d{3})(?!\d)/g, '$1$2');
    }
    const matchMoneda = limpio.match(/(\d+(?:\.\d+)?)\s*(?:VND|IDR|BRL|ARS|CLP|COP|MXN|PEN|PHP|THB|MYR|SGD|HKD|TWD|TRY|EUR|GBP|USD)/i);
    if (matchMoneda) return parseFloat(matchMoneda[1]) || 0;
    const nums = limpio.match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length > 0) {
        const mayor = Math.max(...nums.map(Number).filter(n => !isNaN(n)));
        if (mayor > 0) return mayor;
    }
    return 0;
}

// 🕹️ Detecta a qué plataforma pertenece un producto de Central One por su nombre o SKU
function detectarPlataformaDeTextoCentralOne(txt) {
    const s = String(txt || '').toLowerCase();
    if (!s) return '';
    if (s.includes('playstation') || s.includes('psn') || s.includes('ps4') || s.includes('ps5')) return 'playstation';
    if (s.includes('xbox') || s.includes('game pass')) return 'xbox';
    if (s.includes('nintendo') || s.includes('eshop')) return 'nintendo';
    if (s.includes('steam')) return 'steam';
    if (s.includes('league of legends') || /\blol\b/.test(s) || s.includes('riot') || /\brp\b/.test(s)) return 'lol';
    if (s.includes('roblox') || s.includes('robux')) return 'roblox';
    return '';
}

// 🎯 Empareja cualquier línea de Central One con la tarjeta exacta que pidió la orden (BLINDADO POR PLATAFORMA ESTRICTA)
function emparejarItemCentralOneConMetaKZ(ci, lineIdx, batchItemsMeta, poolCards) {
    const catId = String(ci?.catalog_item_id || ci?.product_id || '').trim();
    const skuUp = String(ci?.sku || '').trim().toUpperCase();
    const nameLow = String(ci?.product_name || ci?.name || '').trim().toLowerCase();
    const textoCompletoCO = `${ci?.product_name || ''} ${ci?.name || ''} ${ci?.sku || ''} ${ci?.product_family_name || ''}`;
    const platDetectadaCO = detectarPlataformaDeTextoCentralOne(textoCompletoCO);
    const facialItem = extraerNumeroFacialDeTextoServer(textoCompletoCO);
    const unitPriceCO = Number(ci?.unit_price || ci?.reseller_price || 0);

    const listaMeta = Array.isArray(batchItemsMeta) ? batchItemsMeta : [];

    // 1. Por UUID o SKU exacto en la tanda pedida
    if (catId || skuUp) {
        const porIdOSku = listaMeta.find(m =>
            (catId && String(m.centralOneProductId || '').trim() === catId) ||
            (skuUp && String(m.sku || '').trim().toUpperCase() === skuUp)
        );
        if (porIdOSku) return porIdOSku;
    }

    // 2. Por valor facial numérico o nombre exacto en la tanda pedida (respetando plataforma si se conoce)
    if (facialItem > 0 || nameLow) {
        const porFacialMeta = listaMeta.find(m => {
            const platMeta = detectarPlataformaDeTextoCentralOne(`${m.name || ''} ${m.sku || ''}`);
            if (platDetectadaCO && platMeta && platDetectadaCO !== platMeta) return false;
            if (nameLow && String(m.name || '').trim().toLowerCase() === nameLow) return true;
            const fMeta = extraerNumeroFacialDeTextoServer(`${m.name || ''} ${m.sku || ''} ${m.originText || ''}`);
            return facialItem > 0 && fMeta > 0 && Math.abs(facialItem - fMeta) < 0.01;
        });
        if (porFacialMeta) return porFacialMeta;
    }

    // 3. Por costo unitario exacto en la tanda pedida
    if (unitPriceCO > 0) {
        const porCostoMeta = listaMeta.find(m => {
            const platMeta = detectarPlataformaDeTextoCentralOne(`${m.name || ''} ${m.sku || ''}`);
            if (platDetectadaCO && platMeta && platDetectadaCO !== platMeta) return false;
            return Number(m.unitCostUSD) > 0 && Math.abs(Number(m.unitCostUSD) - unitPriceCO) < 0.005;
        });
        if (porCostoMeta) return porCostoMeta;
    }

    // 4. Buscar en la Bóveda general (poolCards) en 4 PASADAS ESTRICTAS (Jamás mezcla PlayStation con Xbox/Steam/Nintendo)
    if (Array.isArray(poolCards) && poolCards.length > 0) {
        const convertirCardAMeta = (matchPool) => {
            const eff = Number(matchPool.effectiveClientUSD) ||
                        Number(((Number(matchPool.faceValueOrigin) || 0) * (Number(matchPool.conversionRateToUSD) || 0)).toFixed(2));
            return {
                cardId: matchPool.cardId,
                centralOneProductId: matchPool.centralOneProductId || '',
                sku: matchPool.centralOneSku || '',
                name: matchPool.name || '',
                platformGroup: matchPool.platformGroup || platDetectadaCO || '',
                unitClientUSD: eff,
                unitCostUSD: Number(matchPool.costUSD || 0)
            };
        };

        // Pasada 4.1: Coincidencia exacta por UUID de Central One
        if (catId) {
            const porUuid = poolCards.find(c => String(c.centralOneProductId || '').trim() === catId);
            if (porUuid) return convertirCardAMeta(porUuid);
        }

        // Pasada 4.2: Coincidencia exacta por SKU de Central One
        if (skuUp) {
            const porSku = poolCards.find(c => String(c.centralOneSku || '').trim().toUpperCase() === skuUp);
            if (porSku) return convertirCardAMeta(porSku);
        }

        // Filtrar candidatas de la Bóveda que pertenezcan OBLIGATORIAMENTE a la misma plataforma
        const candidatasMismaPlataforma = platDetectadaCO
            ? poolCards.filter(c => String(c.platformGroup || '').toLowerCase() === platDetectadaCO)
            : poolCards;

        // Pasada 4.3: Coincidencia por nombre exacto dentro de la misma plataforma
        if (nameLow) {
            const porNombre = candidatasMismaPlataforma.find(c => String(c.name || '').trim().toLowerCase() === nameLow);
            if (porNombre) return convertirCardAMeta(porNombre);
        }

        // Pasada 4.4: Coincidencia por Valor Facial ($10 === $10) o Costo Unitario ESTRICTAMENTE en la misma plataforma
        if (facialItem > 0) {
            const porFacial = candidatasMismaPlataforma.find(c => {
                const fPool = Number(c.faceValueOrigin) || extraerNumeroFacialDeTextoServer(`${c.name || ''} ${c.centralOneSku || ''}`);
                const effPool = Number(c.effectiveClientUSD || 0);
                return (fPool > 0 && Math.abs(facialItem - fPool) < 0.01) ||
                       (effPool > 0 && Math.abs(facialItem - effPool) < 0.01);
            });
            if (porFacial) return convertirCardAMeta(porFacial);
        }

        if (unitPriceCO > 0) {
            const porCosto = candidatasMismaPlataforma.find(c =>
                Number(c.costUSD) > 0 && Math.abs(Number(c.costUSD) - unitPriceCO) < 0.005
            );
            if (porCosto) return convertirCardAMeta(porCosto);
        }
    }

    // 5. Respaldo por índice de línea solo dentro de la tanda de la misma orden
    if (lineIdx >= 0 && lineIdx < listaMeta.length) {
        return listaMeta[lineIdx];
    }
    return null;
}

// 🎯 Resuelve el monto exacto en $ USD que entrega cada tarjeta individual (100% blindado)
function resolverMontoUsdTarjetaDeItemCentralOne(ci, idxGlobal, poolCards, algoState, fallbackUnitUSD = 0, lineIdx = -1) {
    const batchMeta = (algoState && Array.isArray(algoState.currentBatchItems) && algoState.currentBatchItems.length > 0)
        ? algoState.currentBatchItems
        : (algoState && Array.isArray(algoState.orderedItemsMeta) ? algoState.orderedItemsMeta : []);

    const metaMatch = emparejarItemCentralOneConMetaKZ(ci, lineIdx, batchMeta, poolCards);
    if (metaMatch && Number(metaMatch.unitClientUSD) > 0) {
        return Number(metaMatch.unitClientUSD);
    }

    if (algoState && Array.isArray(algoState.expectedUnitAmountsUSD) && Number(algoState.expectedUnitAmountsUSD[idxGlobal]) > 0) {
        return Number(algoState.expectedUnitAmountsUSD[idxGlobal]);
    }

    return Number(fallbackUnitUSD || 0);
}

// Extrae el string limpio de un código sin importar si Central One devuelve un string o un objeto { code, pin, voucher }
function extraerStringCodigoDeElementoCO(cEntry) {
    if (!cEntry) return '';
    if (typeof cEntry === 'string') return cEntry.trim();
    if (typeof cEntry === 'object') {
        const val = cEntry.code || cEntry.pin || cEntry.voucher_code || cEntry.voucher || cEntry.key || cEntry.serial || cEntry.value || '';
        return String(val || '').trim();
    }
    return '';
}

// 🏦 Guarda de forma atómica en el Stock Propio (internalCodeStock) de la tarjeta correspondiente en tu Bóveda cualquier código que Central One libere después de una entrega manual o reembolso
async function guardarCodigosRecuperadosEnStockInterno(ordenDB, listaObjetosCodigos = [], codigosPlanos = [], coOrderReference = '') {
    try {
        const settings = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settings) return 0;
        if (!Array.isArray(settings.arbitrageBaseCards)) settings.arbitrageBaseCards = [];

        const codigosExistentesEnBoveda = new Set();
        settings.arbitrageBaseCards.forEach(c => {
            (c.internalCodeStock || []).forEach(cod => {
                codigosExistentesEnBoveda.add(extraerCodigoCrudoDeTextoFormateado(cod));
            });
        });

        let guardadosEnBovedaCount = 0;
        let guardadosEnPaqueteCount = 0;
        const detallesGuardados = [];
        const codigosSinTarjetaBoveda = [];

        const textoOrdenLow = `${ordenDB?.productSlug || ''} ${ordenDB?.productName || ''} ${ordenDB?.algoExecutionState?.platformGroup || ''}`.toLowerCase();
        const platOrden = detectarPlataformaDeTextoCentralOne(textoOrdenLow);

        const itemsProcesar = Array.isArray(listaObjetosCodigos) && listaObjetosCodigos.length > 0
            ? listaObjetosCodigos
            : (Array.isArray(codigosPlanos) && codigosPlanos.length > 0
                ? [{ cardId: '', catalogItemId: '', sku: ordenDB?.apiProductSku || '', name: `${ordenDB?.productName || ''} ${ordenDB?.packageName || ''}`.trim(), unitClientUSD: Number(ordenDB?.baseAmountUSD || 0), rawCodes: codigosPlanos }]
                : []);

        for (const itemCode of itemsProcesar) {
            const platItem = detectarPlataformaDeTextoCentralOne(`${itemCode.name || ''} ${itemCode.sku || ''}`) || platOrden;

            const metaMatch = emparejarItemCentralOneConMetaKZ(
                {
                    catalog_item_id: itemCode.catalogItemId || itemCode.centralOneProductId || '',
                    sku: itemCode.sku || '',
                    product_name: itemCode.name || `${ordenDB?.productName || ''} ${ordenDB?.packageName || ''}`,
                    unit_price: itemCode.unitCostUSD || 0
                },
                -1,
                ordenDB?.algoExecutionState?.orderedItemsMeta || [],
                settings.arbitrageBaseCards
            );

            // 1. Buscar tarjeta exacta en la Bóveda por cardId, UUID o SKU (verificando que coincida la plataforma)
            let cPool = settings.arbitrageBaseCards.find(c => {
                if (itemCode.cardId && c.cardId === itemCode.cardId) return true;
                if (metaMatch && metaMatch.cardId && c.cardId === metaMatch.cardId) return true;
                if (itemCode.catalogItemId && String(c.centralOneProductId || '').trim() === String(itemCode.catalogItemId).trim()) return true;
                if (itemCode.sku && String(c.centralOneSku || '').trim().toUpperCase() === String(itemCode.sku).trim().toUpperCase()) return true;
                return false;
            });

            // Si por algún motivo cPool es de otra plataforma distinta a platItem, descartarlo y buscar en la plataforma correcta
            if (cPool && platItem && String(cPool.platformGroup || '').toLowerCase() !== platItem) {
                cPool = null;
            }

            // 2. Emparejar por plataforma + monto en $ USD (ej. PlayStation + $10 USD -> tarjeta de 10 USD en PlayStation)
            if (!cPool && platItem) {
                const montoBuscado = Number(itemCode.unitClientUSD) || extraerNumeroFacialDeTextoServer(`${itemCode.name || ''} ${ordenDB?.packageName || ''}`);
                if (montoBuscado > 0) {
                    cPool = settings.arbitrageBaseCards.find(c =>
                        String(c.platformGroup || '').toLowerCase() === platItem &&
                        (Math.abs(Number(c.effectiveClientUSD || 0) - montoBuscado) <= 0.35 || Math.abs(Number(c.faceValueOrigin || 0) - montoBuscado) <= 0.35)
                    );
                }
            }

            const listaCruda = Array.isArray(itemCode.rawCodes) && itemCode.rawCodes.length > 0
                ? itemCode.rawCodes
                : (Array.isArray(itemCode.codes) ? itemCode.codes : []);

            for (const rawC of listaCruda) {
                const limpio = rawC.includes('➔') ? rawC.split('➔').slice(1).join('➔').trim() : String(rawC || '').trim();
                const clave = extraerCodigoCrudoDeTextoFormateado(limpio);
                if (!limpio || !clave) continue;

                if (cPool) {
                    if (!Array.isArray(cPool.internalCodeStock)) cPool.internalCodeStock = [];
                    if (!codigosExistentesEnBoveda.has(clave)) {
                        cPool.internalCodeStock.push(limpio);
                        codigosExistentesEnBoveda.add(clave);
                        guardadosEnBovedaCount++;
                        detallesGuardados.push(`[${(cPool.platformGroup || platItem || 'POOL').toUpperCase()}] ${cPool.name}: ${limpio}`);
                    }
                } else {
                    codigosSinTarjetaBoveda.push(limpio);
                }
            }
        }

        // 3. Si era de un paquete individual que no está en la Bóveda, guardarlo en backupPinVault de ese paquete
        if (codigosSinTarjetaBoveda.length > 0 && ordenDB && ordenDB.productSlug) {
            const prodDB = await CatalogProduct.findOne({ slug: ordenDB.productSlug });
            if (prodDB) {
                const usarAlt = Boolean(prodDB.useAltPricing && Array.isArray(prodDB.altPackages) && prodDB.altPackages.length > 0);
                const listaPaq = usarAlt ? prodDB.altPackages : (prodDB.packages || []);
                const pkg = listaPaq.find(p =>
                    String(p.packageId || '').trim() === String(ordenDB.packageId || '').trim() ||
                    String(p.name || '').trim().toLowerCase() === String(ordenDB.packageName || '').trim().toLowerCase()
                );
                if (pkg) {
                    if (!Array.isArray(pkg.backupPinVault)) pkg.backupPinVault = [];
                    for (const codSuelto of codigosSinTarjetaBoveda) {
                        if (!pkg.backupPinVault.includes(codSuelto)) {
                            pkg.backupPinVault.push(codSuelto);
                            guardadosEnPaqueteCount++;
                            detallesGuardados.push(`${prodDB.name} (${pkg.name}): ${codSuelto}`);
                        }
                    }
                    if (guardadosEnPaqueteCount > 0) {
                        prodDB.markModified('packages');
                        prodDB.markModified('altPackages');
                        await prodDB.save();
                    }
                }
            }
        }

        const totalRecuperados = guardadosEnBovedaCount + guardadosEnPaqueteCount;
        if (totalRecuperados > 0) {
            settings.markModified('arbitrageBaseCards');
            await registrarAlertaCentralOne(settings, {
                type: 'BACK_IN_STOCK',
                severity: 'OK',
                title: `🏦 +${totalRecuperados} código(s) guardados automáticamente en tu Stock Propio (${coOrderReference || (ordenDB ? '#' + ordenDB.orderId : 'Central One')})`,
                detail: `Código liberado por Central One y depositado en tu stock listo para la próxima venta: ${detallesGuardados.join(' • ')}`
            });

            await StoreSettings.collection.updateOne(
                { key: 'main_settings' },
                {
                    $set: {
                        arbitrageBaseCards: settings.arbitrageBaseCards.map(c => (c.toObject ? c.toObject() : c)),
                        centralOneAlerts: settings.centralOneAlerts
                    }
                }
            );

            // Invalidar caché en RAM al instante para que el navegador vea el nuevo código en Stock Propio de inmediato
            if (typeof _ramFastSettingsTs !== 'undefined') _ramFastSettingsTs = 0;
            if (typeof _ramBootstrapPayload !== 'undefined') _ramBootstrapPayload = null;
            if (typeof _ramBootstrapTs !== 'undefined') _ramBootstrapTs = 0;

            setImmediate(() => {
                recalcularPreciosYAlgoritmoTiendaKZ().catch(() => {});
            });
        }
        return totalRecuperados;
    } catch (e) {
        console.error('Aviso guardando en stock interno:', e.message);
        return 0;
    }
}

// 🔎 CONSULTAR ESTADO DETALLADO, CÓDIGOS ENTREGADOS Y LÍNEAS FALTANTES EN CENTRAL ONE
async function verificarYExtraerEntregaCentralOne(coOrderId, headers, poolCards = null, esSteamOrder = false, fallbackUnitUSD = 0, algoState = null) {
    const resOrder = await axios.get(`${CENTRAL_ONE_BASE_URL}/orders/${encodeURIComponent(coOrderId)}`, {
        headers,
        timeout: 12000
    });
    const coOrder = resOrder.data?.order || resOrder.data;
    if (!coOrder || !coOrder.status) return { state: 'PROCESSING', deliveredCardsCount: 0, totalCardsRequested: 1 };

    const st = String(coOrder.status || '').toLowerCase();
    const lines = Array.isArray(coOrder.items) ? coOrder.items : [];
    const linesConEntrega = lines.filter(l => (Number(l.delivered_count) || 0) > 0);
    const totalDeliveredCount = lines.reduce((acc, l) => acc + (Number(l.delivered_count) || 0), 0);
    const totalRequestedCount = lines.reduce((acc, l) => acc + (Number(l.quantity) || 1), 0);

    const batchMeta = (algoState && Array.isArray(algoState.currentBatchItems) && algoState.currentBatchItems.length > 0)
        ? algoState.currentBatchItems
        : (algoState && Array.isArray(algoState.orderedItemsMeta) ? algoState.orderedItemsMeta : []);

    let codigosPlanos = [];
    let codigosPorItem = [];

    if (totalDeliveredCount > 0 || st === 'completed' || st === 'partially_completed') {
        try {
            const resCodes = await axios.get(`${CENTRAL_ONE_BASE_URL}/orders/${encodeURIComponent(coOrderId)}/codes`, {
                headers,
                timeout: 12000
            });
            const rawCodeItems = resCodes.data?.order?.items || resCodes.data?.items || resCodes.data?.codes || [];
            let globalCodeIndex = 0;

            rawCodeItems.forEach((ci, itemIdx) => {
                let rawArr = [];
                if (Array.isArray(ci?.codes)) rawArr = ci.codes;
                else if (Array.isArray(ci?.vouchers)) rawArr = ci.vouchers;
                else if (Array.isArray(ci?.pins)) rawArr = ci.pins;
                else if (typeof ci === 'string') rawArr = [ci];
                else if (ci && (ci.code || ci.pin || ci.voucher_code)) rawArr = [ci];

                const arrCodes = rawArr.map(extraerStringCodigoDeElementoCO).filter(Boolean);
                if (arrCodes.length > 0) {
                    const lineFallback = (ci?.order_item_id && lines.find(l => (l.id || l.order_item_id) === ci.order_item_id))
                        || ((ci?.catalog_item_id || ci?.product_id) && lines.find(l => (l.catalog_item_id || l.product_id) === (ci.catalog_item_id || ci.product_id)))
                        || (ci?.sku && lines.find(l => String(l.sku || '').toUpperCase() === String(ci.sku).toUpperCase()))
                        || (rawCodeItems.length === linesConEntrega.length ? linesConEntrega[itemIdx] : lines[itemIdx])
                        || {};

                    const ciEnriquecido = {
                        ...lineFallback,
                        ...(typeof ci === 'object' ? ci : {}),
                        catalog_item_id: ci?.catalog_item_id || ci?.product_id || lineFallback.catalog_item_id || lineFallback.product_id || '',
                        sku: ci?.sku || lineFallback.sku || '',
                        product_name: ci?.product_name || ci?.name || lineFallback.product_name || lineFallback.name || '',
                        unit_price: ci?.unit_price || lineFallback.unit_price || 0
                    };

                    const metaLinea = emparejarItemCentralOneConMetaKZ(ciEnriquecido, itemIdx, batchMeta, poolCards);
                    const unitUsdLinea = (metaLinea && Number(metaLinea.unitClientUSD) > 0)
                        ? Number(metaLinea.unitClientUSD)
                        : resolverMontoUsdTarjetaDeItemCentralOne(ciEnriquecido, globalCodeIndex, poolCards, algoState, fallbackUnitUSD, itemIdx);
                    const unitCostLinea = (metaLinea && Number(metaLinea.unitCostUSD) > 0)
                        ? Number(metaLinea.unitCostUSD)
                        : Number(lineFallback.unit_price || 0);

                    const codigosFormateadosItem = [];
                    const codigosCrudosLimpios = [];

                    arrCodes.forEach(rawClean => {
                        globalCodeIndex++;
                        codigosCrudosLimpios.push(rawClean);
                        codigosFormateadosItem.push(formatearCodigoConEtiquetaSteam(rawClean, unitUsdLinea, esSteamOrder));
                    });

                    codigosPorItem.push({
                        lineIndex: itemIdx,
                        cardId: metaLinea ? metaLinea.cardId : '',
                        catalogItemId: (metaLinea && metaLinea.centralOneProductId) || ciEnriquecido.catalog_item_id || '',
                        sku: (metaLinea && metaLinea.sku) || ciEnriquecido.sku || '',
                        name: (metaLinea && metaLinea.name) || ciEnriquecido.product_name || '',
                        unitClientUSD: unitUsdLinea,
                        unitCostUSD: unitCostLinea,
                        codes: codigosFormateadosItem,
                        rawCodes: codigosCrudosLimpios
                    });

                    codigosFormateadosItem.forEach(cStr => codigosPlanos.push(cStr));
                }
            });
        } catch (errCodes) {}
    }

    const missingLineItems = [];
    const failedCatalogIds = [];

    lines.forEach((l, lineIdx) => {
        const reqQty = Math.max(1, Number(l.quantity) || 1);
        const delQty = Math.max(0, Number(l.delivered_count) || 0);
        if (delQty < reqQty) {
            const missingQty = reqQty - delQty;
            const metaFaltante = emparejarItemCentralOneConMetaKZ(l, lineIdx, batchMeta, poolCards);
            const failureCode = String(l.failure?.code || coOrder.failure?.code || '').toLowerCase();
            const isOutOfStockFailure = failureCode.includes('stock') || failureCode.includes('unavailable') || failureCode.includes('disabled');

            const catIdReal = (metaFaltante && metaFaltante.centralOneProductId) || l.catalog_item_id || l.product_id || '';
            if (catIdReal && isOutOfStockFailure) {
                failedCatalogIds.push(catIdReal);
            }

            missingLineItems.push({
                lineIndex: lineIdx,
                cardId: metaFaltante ? metaFaltante.cardId : '',
                centralOneProductId: catIdReal,
                sku: (metaFaltante && metaFaltante.sku) || l.sku || '',
                name: (metaFaltante && metaFaltante.name) || l.product_name || l.name || 'Tarjeta Base',
                quantity: missingQty,
                unitClientUSD: (metaFaltante && Number(metaFaltante.unitClientUSD) > 0) ? Number(metaFaltante.unitClientUSD) : 0,
                unitCostUSD: (metaFaltante && Number(metaFaltante.unitCostUSD) > 0) ? Number(metaFaltante.unitCostUSD) : Number(l.unit_price || 0),
                failureCode,
                isOutOfStockFailure
            });
        }
    });

    if (st === 'completed') {
        const textoFinal = codigosPlanos.length > 0
            ? codigosPlanos.join('  |  ')
            : `PEDIDO COMPLETADO (${coOrder.reference_code || 'OK'})`;

        return {
            state: 'COMPLETED',
            deliveredCode: textoFinal,
            codigosPlanos,
            codigosPorItem,
            missingLineItems: [],
            deliveredCardsCount: totalDeliveredCount,
            totalCardsRequested: totalRequestedCount,
            referenceCode: coOrder.reference_code || coOrderId,
            raw: coOrder
        };
    }

    if (st === 'partially_completed') {
        return {
            state: 'PARTIAL_REFUNDED',
            codigosPlanos,
            codigosPorItem,
            missingLineItems,
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
        return {
            state: 'FAILED',
            missingLineItems,
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
        missingLineItems,
        deliveredCardsCount: totalDeliveredCount,
        totalCardsRequested: totalRequestedCount,
        referenceCode: coOrder.reference_code || coOrderId,
        raw: coOrder
    };
}

function extraerCodigoCrudoDeTextoFormateado(codeStr) {
    const str = String(codeStr || '').trim();
    if (str.includes('➔')) {
        return str.split('➔').slice(1).join('➔').trim().toUpperCase();
    }
    return str.toUpperCase();
}

const activeCentralOnePollers = new Map();

function programarSeguimientoOrdenCentralOne(orderIdKZ, coOrderId, fallbackIdempKey = null, fallbackBodyOrder = null, runImmediately = false) {
    if (!orderIdKZ) return;
    if (activeCentralOnePollers.has(orderIdKZ)) {
        clearTimeout(activeCentralOnePollers.get(orderIdKZ));
        activeCentralOnePollers.delete(orderIdKZ);
    }

    const inicioMs = Date.now();
    let currentCoOrderId = coOrderId || '';

    const cicloRevision = async () => {
        if (activeOrderProcessingLocks.has(orderIdKZ)) {
            activeCentralOnePollers.set(orderIdKZ, setTimeout(cicloRevision, 2000));
            return;
        }
        activeOrderProcessingLocks.add(orderIdKZ);

        try {
            const headers = obtenerHeadersCentralOne();
            if (!headers) {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }
            const ordenDB = await Order.findOne({ orderId: orderIdKZ });
            if (!ordenDB) {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            const algoState = ordenDB.algoExecutionState || {};
            if (ordenDB.status === 'ENTREGADO' && algoState.coLateCodesRecovered) {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            const pendingIdemp = algoState.pendingReplacementIdempKey || fallbackIdempKey || '';
            const pendingBody = algoState.pendingReplacementBody || fallbackBodyOrder || null;

            if (pendingIdemp && pendingBody && (!currentCoOrderId || (Array.isArray(algoState.processedPartialOrderIds) && algoState.processedPartialOrderIds.includes(currentCoOrderId)))) {
                try {
                    const headersIdemp = obtenerHeadersCentralOne({ 'Idempotency-Key': pendingIdemp });
                    const resRec = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, pendingBody, {
                        headers: headersIdemp,
                        timeout: 22000
                    });
                    if (resRec.data?.order?.id) {
                        currentCoOrderId = resRec.data.order.id;
                        ordenDB.apiOrderId = currentCoOrderId;
                        algoState.pendingReplacementIdempKey = '';
                        algoState.pendingReplacementBody = null;
                        ordenDB.algoExecutionState = algoState;
                        ordenDB.markModified('algoExecutionState');
                        await ordenDB.save();
                    }
                } catch (eRec) {}
            }

            if (!currentCoOrderId && ordenDB.apiOrderId && !ordenDB.apiOrderId.startsWith('kz-ord-') && !ordenDB.apiOrderId.startsWith('MANUAL-') && !ordenDB.apiOrderId.startsWith('VAULT-') && !ordenDB.apiOrderId.startsWith('INTERNAL-')) {
                currentCoOrderId = ordenDB.apiOrderId;
            }

            if (!currentCoOrderId) {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            const settings = await StoreSettings.findOne({ key: 'main_settings' }).select('arbitrageBaseCards centralOneAlerts');
            const poolCards = settings ? (settings.arbitrageBaseCards || []) : [];
            const esSteamOrd = String(ordenDB.productSlug || '').toLowerCase().includes('steam') ||
                               String(algoState?.platformGroup || '').toLowerCase() === 'steam';

            const check = await verificarYExtraerEntregaCentralOne(currentCoOrderId, headers, poolCards, esSteamOrd, 0, algoState);

            if (ordenDB.cancelledByDelayRefund || ordenDB.status === 'RECHAZADO' || ordenDB.status === 'ENTREGADO') {
                if (check.state === 'COMPLETED' || check.state === 'PARTIAL_REFUNDED') {
                    const codigosYaDadosAlCliente = new Set(
                        String(ordenDB.deliveredCode || '')
                            .split(/\s*\|\s*|\r?\n/)
                            .map(extraerCodigoCrudoDeTextoFormateado)
                            .filter(Boolean)
                    );

                    const itemsParaGuardar = (check.codigosPorItem || []).map(it => ({
                        ...it,
                        rawCodes: (it.rawCodes || []).filter(c => !codigosYaDadosAlCliente.has(extraerCodigoCrudoDeTextoFormateado(c))),
                        codes: (it.codes || []).filter(c => !codigosYaDadosAlCliente.has(extraerCodigoCrudoDeTextoFormateado(c)))
                    })).filter(it => it.rawCodes.length > 0);

                    if (itemsParaGuardar.length > 0) {
                        await guardarCodigosRecuperadosEnStockInterno(ordenDB, itemsParaGuardar, [], check.referenceCode || currentCoOrderId);
                    }

                    algoState.coLateCodesRecovered = true;
                    ordenDB.algoExecutionState = algoState;
                    ordenDB.markModified('algoExecutionState');
                    await ordenDB.save();
                    activeCentralOnePollers.delete(orderIdKZ);
                    return;
                }
                if (check.state === 'FAILED') {
                    algoState.coLateCodesRecovered = true;
                    ordenDB.algoExecutionState = algoState;
                    ordenDB.markModified('algoExecutionState');
                    await ordenDB.save();
                    activeCentralOnePollers.delete(orderIdKZ);
                    return;
                }
                if (Date.now() - inicioMs < 6 * 60 * 60 * 1000) {
                    activeCentralOnePollers.set(orderIdKZ, setTimeout(cicloRevision, 25000));
                } else {
                    activeCentralOnePollers.delete(orderIdKZ);
                }
                return;
            }

            // ✅ CASO A: CENTRAL ONE COMPLETÓ LA ORDEN ACTUAL
            if (check.state === 'COMPLETED') {
                const codigosPrevios = (algoState && Array.isArray(algoState.deliveredCodesList)) ? algoState.deliveredCodesList : [];
                const vistosRaw = new Set(codigosPrevios.map(extraerCodigoCrudoDeTextoFormateado));
                const todosLosCodigos = [...codigosPrevios];

                for (const nuevoCod of (check.codigosPlanos || [])) {
                    const rawKey = extraerCodigoCrudoDeTextoFormateado(nuevoCod);
                    if (rawKey && !vistosRaw.has(rawKey)) {
                        vistosRaw.add(rawKey);
                        todosLosCodigos.push(nuevoCod);
                    }
                }

                const maxCardsPermitidas = (algoState && Number(algoState.totalCardsExpected) > 0)
                    ? Number(algoState.totalCardsExpected)
                    : todosLosCodigos.length;
                const codigosParaCliente = todosLosCodigos.slice(0, maxCardsPermitidas);
                const codigosExcedentes = todosLosCodigos.slice(maxCardsPermitidas);

                if (codigosExcedentes.length > 0) {
                    const crudosExcedentes = codigosExcedentes.map(c => c.includes('➔') ? c.split('➔').slice(1).join('➔').trim() : c);
                    await guardarCodigosRecuperadosEnStockInterno(ordenDB, [], crudosExcedentes);
                }

                const textoFinal = codigosParaCliente.length > 0 ? codigosParaCliente.join('  |  ') : check.deliveredCode;

                ordenDB.status = 'ENTREGADO';
                ordenDB.progressPercent = 100;
                ordenDB.deliveredCode = textoFinal;
                ordenDB.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                ordenDB.completedAt = new Date();
                if (algoState) {
                    algoState.deliveredCodesList = codigosParaCliente;
                    algoState.deliveredCardsCount = codigosParaCliente.length;
                    algoState.pendingReplacementIdempKey = '';
                    algoState.pendingReplacementBody = null;
                    ordenDB.algoExecutionState = algoState;
                    ordenDB.markModified('algoExecutionState');
                }
                await ordenDB.save();
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            // 🔄 CASO B: ENTREGA PARCIAL O FALLIDA EN ORDEN CON ALGORITMO
            if ((check.state === 'PARTIAL_REFUNDED' || check.state === 'FAILED') && algoState && algoState.isAlgorithmOrder) {
                if (!Array.isArray(algoState.processedPartialOrderIds)) {
                    algoState.processedPartialOrderIds = [];
                }

                if (algoState.processedPartialOrderIds.includes(currentCoOrderId)) {
                    activeCentralOnePollers.delete(orderIdKZ);
                    return;
                }

                if (!Array.isArray(algoState.deliveredCodesList)) algoState.deliveredCodesList = [];
                const vistosRaw = new Set(algoState.deliveredCodesList.map(extraerCodigoCrudoDeTextoFormateado));

                if (Array.isArray(check.codigosPorItem)) {
                    for (const cItem of check.codigosPorItem) {
                        const unitUsd = Number(cItem.unitClientUSD || 0);
                        const unitCost = Number(cItem.unitCostUSD || 0);
                        for (const codeStr of (cItem.codes || [])) {
                            const rawKey = extraerCodigoCrudoDeTextoFormateado(codeStr);
                            if (rawKey && !vistosRaw.has(rawKey)) {
                                vistosRaw.add(rawKey);
                                algoState.deliveredCodesList.push(codeStr);
                                algoState.deliveredClientUSD = Number(((algoState.deliveredClientUSD || 0) + unitUsd).toFixed(2));
                                algoState.deliveredCostUSD = Number(((algoState.deliveredCostUSD || 0) + unitCost).toFixed(4));
                            }
                        }
                    }
                }
                algoState.deliveredCardsCount = algoState.deliveredCodesList.length;

                const lineasFaltantes = Array.isArray(check.missingLineItems) ? check.missingLineItems : [];
                let itemsFaltantesPorPedir = [];
                let usdFaltanteExacto = 0;

                for (const miss of lineasFaltantes) {
                    let cantRestante = Math.max(1, Number(miss.quantity) || 1);
                    const cPool = poolCards.find(c =>
                        (miss.cardId && c.cardId === miss.cardId) ||
                        (miss.centralOneProductId && c.centralOneProductId === miss.centralOneProductId)
                    );

                    while (cantRestante > 0 && cPool && Array.isArray(cPool.internalCodeStock) && cPool.internalCodeStock.length > 0) {
                        const codigoPropio = cPool.internalCodeStock.shift();
                        if (codigoPropio) {
                            const codFormateado = formatearCodigoConEtiquetaSteam(codigoPropio, miss.unitClientUSD, esSteamOrd);
                            const rawK = extraerCodigoCrudoDeTextoFormateado(codFormateado);
                            if (rawK && !vistosRaw.has(rawK)) {
                                vistosRaw.add(rawK);
                                algoState.deliveredCodesList.push(codFormateado);
                                algoState.deliveredClientUSD = Number(((algoState.deliveredClientUSD || 0) + Number(miss.unitClientUSD || 0)).toFixed(2));
                                algoState.deliveredCostUSD = Number(((algoState.deliveredCostUSD || 0) + Number(miss.unitCostUSD || 0)).toFixed(4));
                            }
                            cantRestante--;
                            if (settings) settings.markModified('arbitrageBaseCards');
                        }
                    }

                    if (cantRestante > 0) {
                        usdFaltanteExacto = Number((usdFaltanteExacto + (cantRestante * Number(miss.unitClientUSD || 0))).toFixed(2));
                        itemsFaltantesPorPedir.push({
                            ...miss,
                            quantity: cantRestante
                        });
                    }
                }

                if (settings && settings.isModified('arbitrageBaseCards')) {
                    await settings.save();
                }

                if (itemsFaltantesPorPedir.length === 0 && algoState.deliveredCodesList.length > 0) {
                    ordenDB.status = 'ENTREGADO';
                    ordenDB.progressPercent = 100;
                    ordenDB.deliveredCode = algoState.deliveredCodesList.join('  |  ');
                    ordenDB.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                    ordenDB.completedAt = new Date();
                    algoState.processedPartialOrderIds.push(currentCoOrderId);
                    ordenDB.algoExecutionState = algoState;
                    ordenDB.markModified('algoExecutionState');
                    await ordenDB.save();
                    activeCentralOnePollers.delete(orderIdKZ);
                    return;
                }

                let itemsReemplazoFinal = [];
                const huboFalloDeStockExplicito = itemsFaltantesPorPedir.some(x => x.isOutOfStockFailure || !x.centralOneProductId);

                if (!huboFalloDeStockExplicito && itemsFaltantesPorPedir.length > 0 && (algoState.retryAttempt || 0) === 0) {
                    itemsReemplazoFinal = itemsFaltantesPorPedir.map(x => ({
                        cardId: x.cardId,
                        centralOneProductId: x.centralOneProductId,
                        sku: x.sku,
                        name: x.name,
                        quantity: x.quantity,
                        unitClientUSD: x.unitClientUSD,
                        unitCostUSD: x.unitCostUSD
                    }));
                } else {
                    if (!Array.isArray(algoState.failedCardIds)) algoState.failedCardIds = [];
                    itemsFaltantesPorPedir.forEach(x => {
                        if (x.cardId && !algoState.failedCardIds.includes(x.cardId)) {
                            algoState.failedCardIds.push(x.cardId);
                        }
                    });

                    const metaRestanteUSD = usdFaltanteExacto > 0
                        ? usdFaltanteExacto
                        : Math.max(0, Number(((algoState.targetClientUSD || 0) - (algoState.deliveredClientUSD || 0)).toFixed(2)));

                    const catalogCacheUsar = _ramCentralOneCatalogCache.length > 0 ? _ramCentralOneCatalogCache : null;
                    if (metaRestanteUSD > 0.05) {
                        let comboAlt = calcularMejorCombinacionTarjetasPool(
                            metaRestanteUSD,
                            algoState.platformGroup || 'steam',
                            poolCards,
                            catalogCacheUsar,
                            algoState.failedCardIds
                        );
                        if (!comboAlt.hasSolution) {
                            comboAlt = calcularMejorCombinacionTarjetasPool(
                                metaRestanteUSD,
                                algoState.platformGroup || 'steam',
                                poolCards,
                                catalogCacheUsar,
                                []
                            );
                        }
                        if (comboAlt.hasSolution && Array.isArray(comboAlt.items)) {
                            itemsReemplazoFinal = comboAlt.items;
                        }
                    }
                }

                const costoFaltanteCalc = itemsReemplazoFinal.reduce((acc, it) => acc + (Number(it.unitCostUSD || 0) * Number(it.quantity || 1)), 0);
                const costoTotalProyectado = Number(algoState.deliveredCostUSD || 0) + costoFaltanteCalc;
                const dentroDePresupuestoSeguro = costoTotalProyectado <= (Number(ordenDB.totalAmountUSD || 0) + 0.35);

                if (itemsReemplazoFinal.length > 0 && dentroDePresupuestoSeguro && (algoState.retryAttempt || 0) < 2) {
                    const nuevoIntentoNum = (algoState.retryAttempt || 0) + 1;
                    const idempRetry = `kz-ord-${ordenDB.orderId}-rep-v${nuevoIntentoNum}`.replace(/[^A-Za-z0-9_-]/g, '');
                    const headersRetry = obtenerHeadersCentralOne({ 'Idempotency-Key': idempRetry });
                    const resumenFaltantesTxt = itemsReemplazoFinal
                        .map(it => `${it.quantity}x ${it.name} ($${(Number(it.unitClientUSD || 0) * Number(it.quantity || 1)).toFixed(2)})`)
                        .join(' + ');

                    const bodyRetry = {
                        items: itemsReemplazoFinal.map(it => ({
                            catalog_item_id: it.centralOneProductId,
                            quantity: Math.max(1, Math.round(Number(it.quantity) || 1))
                        })),
                        note: `KemZone Faltante #${ordenDB.orderId} (${resumenFaltantesTxt})`.slice(0, 480)
                    };

                    const nuevosMontosEsp = [];
                    let cantTarjetasFaltantes = 0;
                    itemsReemplazoFinal.forEach(it => {
                        const q = Math.max(1, Math.round(Number(it.quantity) || 1));
                        cantTarjetasFaltantes += q;
                        for (let k = 0; k < q; k++) nuevosMontosEsp.push(Number(it.unitClientUSD || 0));
                    });

                    algoState.retryAttempt = nuevoIntentoNum;
                    algoState.processedPartialOrderIds.push(currentCoOrderId);
                    algoState.currentBatchItems = itemsReemplazoFinal;
                    algoState.expectedUnitAmountsUSD = nuevosMontosEsp;
                    algoState.deliveredCardsCount = algoState.deliveredCodesList.length;
                    algoState.totalCardsExpected = algoState.deliveredCodesList.length + cantTarjetasFaltantes;
                    algoState.pendingReplacementIdempKey = idempRetry;
                    algoState.pendingReplacementBody = bodyRetry;

                    ordenDB.algoExecutionState = algoState;
                    ordenDB.statusMessage = `Completando la liberación de ${cantTarjetasFaltantes} tarjeta(s) restante(s) (${algoState.deliveredCodesList.length}/${algoState.totalCardsExpected} listas)...`;
                    ordenDB.markModified('algoExecutionState');
                    await ordenDB.save();

                    try {
                        const resRetry = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, bodyRetry, {
                            headers: headersRetry,
                            timeout: 28000
                        });

                        const newCoOrder = resRetry.data?.order;
                        if (newCoOrder && newCoOrder.id) {
                            ordenDB.apiOrderId = newCoOrder.id;
                            algoState.pendingReplacementIdempKey = '';
                            algoState.pendingReplacementBody = null;
                            ordenDB.algoExecutionState = algoState;
                            ordenDB.markModified('algoExecutionState');
                            await ordenDB.save();

                            programarSeguimientoOrdenCentralOne(orderIdKZ, newCoOrder.id, idempRetry, bodyRetry, true);
                            return;
                        }
                    } catch (errRep) {
                        const esTimeoutRep = errRep.code === 'ECONNABORTED' || String(errRep.message || '').toLowerCase().includes('timeout');
                        if (esTimeoutRep) {
                            programarSeguimientoOrdenCentralOne(orderIdKZ, null, idempRetry, bodyRetry, false);
                            return;
                        }
                    }
                }
            }

            // ❌ CASO C: FALLO DEFINITIVO
            if (check.state === 'FAILED' || check.state === 'PARTIAL_REFUNDED') {
                ordenDB.status = 'ERROR_API';
                ordenDB.statusMessage = 'Pago verificado. Nuestro sistema está completando la liberación de las tarjetas restantes de tu pedido.';
                await ordenDB.save();
                await registrarAlertaCentralOne(settings, {
                    type: 'ORDER_FAILED',
                    severity: 'CRIT',
                    title: `🚨 Orden #${ordenDB.orderId} requiere atención (${check.failureCode || 'entrega parcial'})`,
                    detail: `${ordenDB.productName} (${ordenDB.packageName}): ${check.errorMsg || 'Ítem reembolsado por Central One.'} (${algoState?.deliveredCodesList?.length || 0} código(s) ya resguardados).`
                });
                if (settings) await settings.save();
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }

            // ⏳ CASO D: SIGUE EN PROCESO EN CENTRAL ONE -> SONDEO RÁPIDO CADA 2.5s LOS PRIMEROS 2 MINUTOS
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
            const limitePollerMs = ordenDB.clientChoseToWait ? (12 * 60 * 60 * 1000) : (4 * 60 * 60 * 1000);
            if (transcurridoMs > limitePollerMs) {
                activeCentralOnePollers.delete(orderIdKZ);
                return;
            }
            const proximoIntervalo = transcurridoMs < (2 * 60 * 1000)
                ? 2500
                : (transcurridoMs < (10 * 60 * 1000) ? 8000 : 25000);
            const timerId = setTimeout(cicloRevision, proximoIntervalo);
            activeCentralOnePollers.set(orderIdKZ, timerId);
        } catch (e) {
            const timerId = setTimeout(cicloRevision, 4000);
            activeCentralOnePollers.set(orderIdKZ, timerId);
        } finally {
            activeOrderProcessingLocks.delete(orderIdKZ);
        }
    };

    const delayInicial = runImmediately ? 80 : 2200;
    const firstTimer = setTimeout(cicloRevision, delayInicial);
    activeCentralOnePollers.set(orderIdKZ, firstTimer);
}

// 📈 TABLA OFICIAL DE GANANCIAS MÍNIMAS POR RANGO PARA LA CALCULADORA DE JUEGOS DE STEAM
const RANGOS_GANANCIA_STEAM_CALC = [
    { min: 0.01,   max: 1.40,   fee: 0.25 },
    { min: 1.41,   max: 2.84,   fee: 0.40 },
    { min: 2.85,   max: 3.90,   fee: 0.60 },
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

// 🔍 Extrae la lista de juegos individuales de una orden de Calculadora de Steam
function extraerJuegosIndividualesDeOrdenSteam(orden) {
    if (!orden) return [];
    if (Array.isArray(orden.algoExecutionState?.gamesTargetsUSD) && orden.algoExecutionState.gamesTargetsUSD.length > 0) {
        return orden.algoExecutionState.gamesTargetsUSD
            .map((g, i) => ({
                label: String(g.label || g.name || `Juego ${i + 1}`).trim(),
                usdR: Math.round((Number(g.usdR || g.targetUSD || g.priceUSD || 0) + Number.EPSILON) * 100) / 100
            }))
            .filter(g => g.usdR > 0);
    }

    if (String(orden.productSlug || '').toLowerCase() === 'calculadora-steam' && orden.packageName) {
        const pkgTxt = String(orden.packageName || '');
        const parteJuegos = pkgTxt.split('➔')[0] || pkgTxt;
        const regexJuegos = /([^+]+?)\s*\(\$(\d+(?:[.,]\d+)?)\)/g;
        const extraidos = [];
        let m;
        while ((m = regexJuegos.exec(parteJuegos)) !== null) {
            const val = Math.round((parseFloat(String(m[2]).replace(',', '.')) + Number.EPSILON) * 100) / 100;
            if (val > 0) {
                extraidos.push({
                    label: m[1].trim() || `Juego ${extraidos.length + 1}`,
                    usdR: val
                });
            }
        }
        if (extraidos.length > 0) return extraidos;
    }
    return [];
}

// 🧠 Calcula los códigos exactos para cada juego POR SEPARADO y une las tarjetas resultantes
function calcularCombinacionListaJuegosSeparadosSteam(validGames, baseCardsPool, catalogCache = null, excludedCardIds = []) {
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

    if (!Array.isArray(validGames) || validGames.length === 0) {
        return { hasSolution: false, reason: 'No hay juegos válidos para calcular.' };
    }

    const poolSimulado = (baseCardsPool || []).map(rawCard => {
        const c = rawCard && typeof rawCard.toObject === 'function'
            ? rawCard.toObject()
            : (rawCard && rawCard._doc ? { ...rawCard._doc } : { ...rawCard });
        return {
            ...c,
            internalCodeStock: Array.isArray(c.internalCodeStock) ? [...c.internalCodeStock] : []
        };
    });

    const perGamePlans = [];
    const mapaTarjetasSumadas = new Map();
    let totalCardsSeparadas = 0;
    let totalClientUSDSeparado = 0;
    let totalCostUSDSeparado = 0;
    let totalPriceJuegosUSD = 0;

    for (let i = 0; i < validGames.length; i++) {
        const g = validGames[i];
        const metaJuegoUSD = round2(g.usdR || g.targetUSD || g.priceUSD || 0);
        if (metaJuegoUSD <= 0) continue;

        const planIndiv = calcularMejorCombinacionTarjetasPool(
            metaJuegoUSD,
            'steam',
            poolSimulado,
            catalogCache,
            excludedCardIds
        );

        if (!planIndiv || !planIndiv.hasSolution) {
            return {
                hasSolution: false,
                reason: `En ${g.label || `Juego ${i + 1}`} ($${metaJuegoUSD.toFixed(2)}): ${(planIndiv && planIndiv.reason) || 'Sin stock para cubrir este juego.'}`
            };
        }

        // Descontar stock simulado entre un juego y el siguiente de la misma compra
        (planIndiv.items || []).forEach(usedIt => {
            const cardEnPool = poolSimulado.find(c => c.cardId === usedIt.cardId);
            if (cardEnPool) {
                let qtyRestante = Number(usedIt.quantity || 1);
                while (qtyRestante > 0 && Array.isArray(cardEnPool.internalCodeStock) && cardEnPool.internalCodeStock.length > 0) {
                    cardEnPool.internalCodeStock.shift();
                    qtyRestante--;
                }
                if (cardEnPool.availableStock !== null && cardEnPool.availableStock !== undefined) {
                    cardEnPool.availableStock = Math.max(0, Number(cardEnPool.availableStock) - Number(usedIt.quantity || 1));
                }
            }
        });

        perGamePlans.push({
            label: g.label || `Juego ${i + 1}`,
            usdR: metaJuegoUSD,
            planIndiv
        });

        totalPriceJuegosUSD = round2(totalPriceJuegosUSD + metaJuegoUSD);
        totalCardsSeparadas += Number(planIndiv.totalCards || 0);
        totalClientUSDSeparado = round2(totalClientUSDSeparado + Number(planIndiv.totalClientUSD || 0));
        totalCostUSDSeparado = round4(totalCostUSDSeparado + Number(planIndiv.totalCostUSD || 0));

        (planIndiv.items || []).forEach(it => {
            const key = it.cardId || it.sku || it.name;
            if (mapaTarjetasSumadas.has(key)) {
                mapaTarjetasSumadas.get(key).quantity += Number(it.quantity || 1);
            } else {
                mapaTarjetasSumadas.set(key, { ...it, quantity: Number(it.quantity || 1) });
            }
        });
    }

    const itemsCombinados = Array.from(mapaTarjetasSumadas.values());
    const bonusTotal = round2(Math.max(0, totalClientUSDSeparado - totalPriceJuegosUSD));

    return {
        hasSolution: true,
        totalCards: totalCardsSeparadas,
        totalClientUSD: totalClientUSDSeparado,
        totalCostUSD: totalCostUSDSeparado,
        bonusClientUSD: bonusTotal,
        overshootUSD: bonusTotal,
        items: itemsCombinados,
        perGamePlans,
        summaryText: itemsCombinados
            .map(it => `${it.quantity}x ${it.name} ($${(it.unitClientUSD * it.quantity).toFixed(2)})`)
            .join(' + ')
    };
}

// 🏷️ Formatea cualquier código (Steam, PlayStation, Nintendo, Xbox, Roblox) colocando arriba qué cantidad en $ da ese código
function formatearCodigoConEtiquetaPlataforma(codeStr, amountUSD, platformGroup = 'steam', esSteam = true) {
    const limpio = String(codeStr || '').trim();
    if (!limpio) return '';
    if (limpio.includes('➔') || limpio.toLowerCase().includes('steam wallet')) return limpio;
    const num = Number(amountUSD) || 0;
    if (num <= 0) return limpio;
    const montoComa = num.toFixed(2).replace('.', ',');
    const plat = String(platformGroup || '').toLowerCase();

    if (esSteam || plat === 'steam') return `Steam Wallet ${montoComa}$ ➔ ${limpio}`;
    if (plat === 'playstation' || plat === 'psn') return `PlayStation ${montoComa}$ ➔ ${limpio}`;
    if (plat === 'nintendo' || plat === 'eshop') return `Nintendo eShop ${montoComa}$ ➔ ${limpio}`;
    if (plat === 'xbox') return `Xbox ${montoComa}$ ➔ ${limpio}`;
    if (plat === 'roblox') return `Roblox ${montoComa}$ ➔ ${limpio}`;
    return `Código ${montoComa}$ ➔ ${limpio}`;
}

// 🛡️ Candado Ultrarrápido en RAM (0ms): Bloquea compras de paquetes sin stock sin hacer doble consulta a MongoDB
app.use(['/api/orders/create', '/api/binance-pay/create-checkout'], express.json(), async (req, res, next) => {
    try {
        const { orderType, productSlug, packageId, packageName } = req.body || {};
        const slugClean = String(productSlug || '').trim().toLowerCase();
        if (!slugClean || orderType === 'TOKEM_TOPUP' || slugClean === 'tokems-kz' || slugClean === 'calculadora-steam') {
            return next();
        }
        const prodDB = typeof obtenerProductoCheckoutRAM === 'function'
            ? await obtenerProductoCheckoutRAM(slugClean)
            : await CatalogProduct.findOne({ slug: slugClean })
                .select('slug active useAltPricing packages.packageId packages.name packages.inStock packages.providerInStock packages.backupPinVault altPackages.packageId altPackages.name altPackages.inStock altPackages.providerInStock altPackages.backupPinVault')
                .lean();
        if (!prodDB) return next();

        const listaPaq = (prodDB.useAltPricing && Array.isArray(prodDB.altPackages) && prodDB.altPackages.length > 0)
            ? prodDB.altPackages
            : (prodDB.packages || []);
        const idBuscado = String(packageId || '').trim();
        const nomBuscado = String(packageName || '').trim().toLowerCase();

        const pkg = listaPaq.find(p =>
            String(p.packageId || p.id || '').trim() === idBuscado ||
            (nomBuscado && String(p.name || '').trim().toLowerCase() === nomBuscado)
        );

        if (pkg) {
            const tienePinesRespaldo = Array.isArray(pkg.backupPinVault) && pkg.backupPinVault.length > 0;
            if (pkg.inStock === false || (pkg.providerInStock === false && !tienePinesRespaldo)) {
                return res.status(400).json({
                    error: `Por el momento el paquete "${pkg.name}" se encuentra agotado temporalmente. Por favor selecciona otro paquete disponible.`
                });
            }
        }
        next();
    } catch (e) {
        next();
    }
});

// Sincronizar estado de stock de paquetes al iniciar el servidor (1 sola vez)
setTimeout(() => {
    recalcularPreciosYAlgoritmoTiendaKZ().catch(() => {});
}, 3500);

// ⚡ CACHÉ EN RAM DEL CATÁLOGO CENTRAL ONE PARA EVITAR DESCARGAR ~8MB DE MONGODB EN CADA COMPRA/APROBACIÓN
let _ramCentralOneCatalogCache = [];

setTimeout(async () => {
    try {
        const docInit = await StoreSettings.collection.findOne(
            { key: 'main_settings' },
            { projection: { centralOneCatalogCache: 1 } }
        );
        if (docInit && Array.isArray(docInit.centralOneCatalogCache) && docInit.centralOneCatalogCache.length > 0) {
            _ramCentralOneCatalogCache = docInit.centralOneCatalogCache;
            obtenerIndicesCatalogoEnRAM(_ramCentralOneCatalogCache);
        }
    } catch (e) {}
}, 1500);

StoreSettings.schema.pre('findOne', function() {
    const fields = this._fields;
    const sinProjectionExplicita = !fields || Object.keys(fields).length === 0;
    if (sinProjectionExplicita && _ramCentralOneCatalogCache.length > 0) {
        this.select('-centralOneCatalogCache -centralOneCoverageCache');
        this._injectRamCatalog = true;
    }
});

StoreSettings.schema.post('findOne', function(doc) {
    if (!doc) return;
    if (Array.isArray(doc.centralOneCatalogCache) && doc.centralOneCatalogCache.length > 0) {
        _ramCentralOneCatalogCache = doc.centralOneCatalogCache;
        obtenerIndicesCatalogoEnRAM(_ramCentralOneCatalogCache);
    } else if (_ramCentralOneCatalogCache.length > 0 && (this._injectRamCatalog || !doc.centralOneCatalogCache || doc.centralOneCatalogCache.length === 0)) {
        if (doc._doc) {
            doc._doc.centralOneCatalogCache = _ramCentralOneCatalogCache;
        } else {
            doc.centralOneCatalogCache = _ramCentralOneCatalogCache;
        }
    }
});

StoreSettings.schema.pre('save', function() {
    if (this.isModified('centralOneCatalogCache') && Array.isArray(this.centralOneCatalogCache) && this.centralOneCatalogCache.length > 0) {
        _ramCentralOneCatalogCache = this.centralOneCatalogCache;
        obtenerIndicesCatalogoEnRAM(_ramCentralOneCatalogCache);
    }
});

// Evita que el envío de correos de pedidos entregados congele el botón de "Aprobar"
if (resend && resend.emails && typeof resend.emails.send === 'function' && !resend._kzFastAsyncWrapped) {
    resend._kzFastAsyncWrapped = true;
    const _origResendSend = resend.emails.send.bind(resend.emails);
    resend.emails.send = function(payload) {
        if (payload && typeof payload.subject === 'string' && payload.subject.includes('Pedido Entregado')) {
            _origResendSend(payload).catch(() => {});
            return Promise.resolve({ id: 'async_queued' });
        }
        return _origResendSend(payload);
    };
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

    const settings = await StoreSettings.findOne({ key: 'main_settings' })
        .select('arbitrageBaseCards centralOneAlerts flashOffers');

    const usandoAlt = Boolean(productoDB && productoDB.useAltPricing && Array.isArray(productoDB.altPackages) && productoDB.altPackages.length > 0);
    const listaPaquetes = usandoAlt ? productoDB.altPackages : (productoDB ? productoDB.packages : []);

    const ofertaActivaMatch = (settings && Array.isArray(settings.flashOffers))
        ? settings.flashOffers.find(of =>
            String(of.slug || '').trim().toLowerCase() === String(orden.productSlug || '').trim().toLowerCase() &&
            (String(of.pkgId || '').trim() === String(orden.packageId || '').trim() ||
             String(of.linkedPackageId || '').trim() === String(orden.packageId || '').trim() ||
             String(of.title || '').trim().toLowerCase() === String(orden.packageName || '').trim().toLowerCase())
          )
        : null;

    let pkg = (listaPaquetes || []).find(p =>
        String(p.packageId || '').trim() === String(orden.packageId || '').trim() ||
        (ofertaActivaMatch && ofertaActivaMatch.linkedPackageId && String(p.packageId || '').trim() === String(ofertaActivaMatch.linkedPackageId).trim()) ||
        String(p.name || '').trim().toLowerCase() === String(orden.packageName || '').trim().toLowerCase()
    );

    if (!pkg && ofertaActivaMatch) {
        pkg = {
            packageId: ofertaActivaMatch.pkgId || orden.packageId,
            name: ofertaActivaMatch.title || orden.packageName,
            priceUSD: Number(ofertaActivaMatch.usd || orden.baseAmountUSD || 1),
            costUSD: Number(ofertaActivaMatch.costUSD || orden.costUSD || 0),
            apiProductSku: ofertaActivaMatch.apiProductSku || orden.apiProductSku || '',
            centralOneProductId: ofertaActivaMatch.centralOneProductId || '',
            useSmartAlgorithm: Boolean(productoDB && productoDB.isSmartCodeProduct),
            targetClientUSD: Number(ofertaActivaMatch.oldUsd || ofertaActivaMatch.usd || 0),
            isGiftCardPin: Boolean(ofertaActivaMatch.isGiftCardPin || orden.isGiftCardPin),
            backupPinVault: Array.isArray(ofertaActivaMatch.backupPinVault) ? ofertaActivaMatch.backupPinVault : []
        };
    }

    const poolCards = settings ? (settings.arbitrageBaseCards || []) : [];
    const catalogCacheActiva = _ramCentralOneCatalogCache.length > 0
        ? _ramCentralOneCatalogCache
        : (settings?.centralOneCatalogCache || null);

    const platGroupActual = (productoDB && productoDB.smartPlatformGroup) || (String(orden.productSlug || '').toLowerCase().includes('playstation') ? 'playstation' : (String(orden.productSlug || '').toLowerCase().includes('nintendo') ? 'nintendo' : 'steam'));
    const esSteamOrder = String(orden.productSlug || '').toLowerCase().includes('steam') ||
                         String(platGroupActual).toLowerCase() === 'steam';

    // 1. PRIORIDAD 1A: Bóveda de Pines de Oferta Relámpago
    if (ofertaActivaMatch && Array.isArray(ofertaActivaMatch.backupPinVault) && ofertaActivaMatch.backupPinVault.length > 0) {
        const pinOfertaRaw = String(ofertaActivaMatch.backupPinVault.shift() || '').trim();
        if (pinOfertaRaw) {
            const montoOf = Number(pkg?.targetClientUSD || ofertaActivaMatch.oldUsd || ofertaActivaMatch.usd || 0);
            const esGiftOf = Boolean(ofertaActivaMatch.isGiftCardPin || pkg?.isGiftCardPin || orden.isGiftCardPin || orden.fulfillmentType === 'API_GIFT_CARD');
            const pinFormateadoOf = (esSteamOrder || (esGiftOf && montoOf > 0))
                ? formatearCodigoConEtiquetaPlataforma(pinOfertaRaw, montoOf, platGroupActual, esSteamOrder)
                : pinOfertaRaw;

            await StoreSettings.collection.updateOne(
                { key: 'main_settings' },
                { $set: { flashOffers: settings.flashOffers } }
            ).catch(() => {});

            return {
                success: true,
                deliveredCode: pinFormateadoOf,
                apiOrderId: 'VAULT-FLASH-' + Date.now(),
                raw: { source: 'flash_offer_pin_vault', remainingInVault: ofertaActivaMatch.backupPinVault.length }
            };
        }
    }

    // 1. PRIORIDAD 1B: Bóveda de Pines del propio paquete del producto
    if (pkg && Array.isArray(pkg.backupPinVault) && pkg.backupPinVault.length > 0) {
        const pinRaw = String(pkg.backupPinVault.shift() || '').trim();
        if (pinRaw) {
            const montoPkg = Number(pkg.targetClientUSD || pkg.priceUSD || 0);
            const esGift = Boolean(pkg.isGiftCardPin || orden.isGiftCardPin || orden.fulfillmentType === 'API_GIFT_CARD');
            const pinExtraido = (esSteamOrder || (esGift && Number(pkg.targetClientUSD) > 0))
                ? formatearCodigoConEtiquetaPlataforma(pinRaw, montoPkg, platGroupActual, esSteamOrder)
                : pinRaw;

            if (productoDB && typeof productoDB.markModified === 'function') {
                productoDB.markModified('packages');
                productoDB.markModified('altPackages');
                await productoDB.save();
            }
            if (productoDB && productoDB._id) {
                await CatalogProduct.collection.updateOne(
                    { _id: productoDB._id },
                    { $set: { packages: productoDB.packages, altPackages: productoDB.altPackages } }
                ).catch(() => {});
            }

            return {
                success: true,
                deliveredCode: pinExtraido,
                apiOrderId: 'VAULT-' + Date.now(),
                raw: { source: 'backup_pin_vault', remainingInVault: pkg.backupPinVault.length }
            };
        }
    }

    const headersBase = obtenerHeadersCentralOne();

const consultarConEsperaCalienteCO = async (coOrderId, initialStatus, esSteamFlag, fallbackUsdVal, algoStObj) => {
        if (String(initialStatus || '').toLowerCase() === 'completed') {
            return await verificarYExtraerEntregaCentralOne(coOrderId, headersBase, poolCards, esSteamFlag, fallbackUsdVal, algoStObj);
        }
        // Sondeo rápido en caliente (hasta 3.2s) para que el código salga aprobado de una vez en el mismo clic
        const pausasMs = [450, 650, 850, 1100];
        let ultimoCheck = null;
        for (let p = 0; p < pausasMs.length; p++) {
            await new Promise(r => setTimeout(r, pausasMs[p]));
            ultimoCheck = await verificarYExtraerEntregaCentralOne(coOrderId, headersBase, poolCards, esSteamFlag, fallbackUsdVal, algoStObj);
            if (ultimoCheck && ultimoCheck.state !== 'PROCESSING') {
                return ultimoCheck;
            }
        }
        return ultimoCheck || { state: 'PROCESSING', deliveredCardsCount: 0 };
    };

    // 🔒 Si la orden ya tiene un apiOrderId de Central One asignado, verificarla de inmediato sin crear otra orden nueva
    if (headersBase && orden.apiOrderId && !orden.apiOrderId.startsWith('VAULT-') && !orden.apiOrderId.startsWith('INTERNAL-') && !orden.apiOrderId.startsWith('API-')) {
        if (orden.apiOrderId.startsWith('kz-ord-')) {
            programarSeguimientoOrdenCentralOne(orden.orderId, null, orden.apiOrderId, orden.algoExecutionState?.pendingReplacementBody || null, true);
            return {
                success: true,
                isProcessingAsync: true,
                deliveredCode: '',
                apiOrderId: orden.apiOrderId,
                raw: { recoveringIdempOrder: true }
            };
        }
        try {
            const checkPrev = await verificarYExtraerEntregaCentralOne(orden.apiOrderId, headersBase, poolCards, esSteamOrder, 0, orden.algoExecutionState);
            if (checkPrev.state === 'COMPLETED') {
                return {
                    success: true,
                    deliveredCode: checkPrev.deliveredCode,
                    apiOrderId: orden.apiOrderId,
                    raw: checkPrev.raw
                };
            }
            programarSeguimientoOrdenCentralOne(orden.orderId, orden.apiOrderId, null, null, true);
            return {
                success: true,
                isProcessingAsync: true,
                deliveredCode: '',
                apiOrderId: orden.apiOrderId,
                raw: checkPrev.raw
            };
        } catch (ePrev) {
            programarSeguimientoOrdenCentralOne(orden.orderId, orden.apiOrderId, null, null, true);
            return {
                success: true,
                isProcessingAsync: true,
                deliveredCode: '',
                apiOrderId: orden.apiOrderId,
                raw: { asyncCheckPending: true }
            };
        }
    }

const usaAlgoritmo = (pkg && pkg.useSmartAlgorithm === false)
        ? false
        : Boolean((productoDB && productoDB.isSmartCodeProduct) || (pkg && pkg.useSmartAlgorithm));

    // 🧠 CASO A: PRODUCTO CON ALGORITMO INTELIGENTE DE CÓDIGOS (STEAM, PLAYSTATION, NINTENDO, ETC.)
    if (usaAlgoritmo && pkg && Number(pkg.targetClientUSD) > 0) {
        const platGroup = (productoDB && productoDB.smartPlatformGroup) || 'steam';
        const esSteamPool = String(platGroup).toLowerCase() === 'steam' || esSteamOrder;
        const excluidosFallidos = [];
        const juegosSeparados = extraerJuegosIndividualesDeOrdenSteam(orden);

        // 🔒 Activar candado en RAM para que ningún Webhook ni radar pise la orden mientras se negocia con Central One
        activeOrderProcessingLocks.add(orden.orderId);

        // Conservar códigos de Stock Propio fuera del bucle de reintentos para que jamás se borren si pasa al intento 2
        const prevAlgoState = orden.algoExecutionState || {};
        const codigosDesdeStockInterno = Array.isArray(prevAlgoState.ownStockCodesReserved)
            ? [...prevAlgoState.ownStockCodesReserved]
            : (Array.isArray(prevAlgoState.deliveredCodesList) ? [...prevAlgoState.deliveredCodesList] : []);
        const registrosParaRollback = []; // Guarda { cardId, rawCode } por si Central One falla en todos los intentos

        try {
            for (let intento = 1; intento <= 2; intento++) {
                const combo = juegosSeparados.length > 0
                    ? calcularCombinacionListaJuegosSeparadosSteam(
                        juegosSeparados,
                        poolCards,
                        catalogCacheActiva,
                        excluidosFallidos
                      )
                    : calcularMejorCombinacionTarjetasPool(
                        pkg.targetClientUSD,
                        platGroup,
                        poolCards,
                        catalogCacheActiva,
                        excluidosFallidos
                      );

                if (!combo.hasSolution) {
                    // Si ya habíamos sacado códigos del Stock Propio en este clic y no hay solución en Central One, devolverlos intactos a su tarjeta
                    if (registrosParaRollback.length > 0 && settings) {
                        registrosParaRollback.forEach(({ cardId, rawCode }) => {
                            const cRestore = poolCards.find(c => c.cardId === cardId);
                            if (cRestore) {
                                if (!Array.isArray(cRestore.internalCodeStock)) cRestore.internalCodeStock = [];
                                if (!cRestore.internalCodeStock.includes(rawCode)) cRestore.internalCodeStock.unshift(rawCode);
                            }
                        });
                        await StoreSettings.collection.updateOne(
                            { key: 'main_settings' },
                            { $set: { arbitrageBaseCards: settings.arbitrageBaseCards } }
                        ).catch(() => {});
                    }

                    await registrarAlertaCentralOne(settings, {
                        type: 'ALGO_NO_SOLUTION',
                        severity: 'CRIT',
                        title: `🚨 Orden #${orden.orderId} sin combinación disponible (${platGroup.toUpperCase()})`,
                        detail: combo.reason || 'No hay tarjetas base con stock para cubrir el monto.'
                    });
                    if (settings) await settings.save();
                    return { success: false, errorMsg: combo.reason || 'Sin stock en tarjetas base del algoritmo.' };
                }

                let usdCubiertoInterno = Number(prevAlgoState.deliveredClientUSD || 0);
                let costoCubiertoInterno = Number(prevAlgoState.deliveredCostUSD || 0);
                const itemsParaPedirCentralOne = [];
                let usoStockInterno = false;

                // Contar cuántos códigos de cada monto ya tenemos reservados en codigosDesdeStockInterno
                let restantesYaReservados = codigosDesdeStockInterno.length;

                for (const it of combo.items) {
                    let cantFaltante = Math.max(1, Math.round(Number(it.quantity) || 1));
                    const cPool = poolCards.find(c =>
                        (it.cardId && c.cardId === it.cardId) ||
                        (it.centralOneProductId && c.centralOneProductId === it.centralOneProductId) ||
                        (it.sku && String(c.centralOneSku || '').trim().toUpperCase() === String(it.sku).trim().toUpperCase())
                    );

                    // Si en el intento 1 ya habíamos tomado un código de Stock Propio para esta orden, descontarlo de lo que falta pedir
                    while (cantFaltante > 0 && restantesYaReservados > 0 && registrosParaRollback.some(r => r.cardId === (cPool && cPool.cardId))) {
                        cantFaltante--;
                        restantesYaReservados--;
                    }

                    while (cantFaltante > 0 && cPool && Array.isArray(cPool.internalCodeStock) && cPool.internalCodeStock.length > 0) {
                        const codigoGuardado = String(cPool.internalCodeStock.shift() || '').trim();
                        if (codigoGuardado) {
                            const codigoConEtiqueta = formatearCodigoConEtiquetaPlataforma(codigoGuardado, it.unitClientUSD, platGroup, esSteamPool);
                            codigosDesdeStockInterno.push(codigoConEtiqueta);
                            registrosParaRollback.push({ cardId: cPool.cardId, rawCode: codigoGuardado, unitClientUSD: Number(it.unitClientUSD), unitCostUSD: Number(it.unitCostUSD) });
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
                    await StoreSettings.collection.updateOne(
                        { key: 'main_settings' },
                        { $set: { arbitrageBaseCards: settings.arbitrageBaseCards } }
                    ).catch(() => {});

                    if (typeof _ramFastSettingsTs !== 'undefined') _ramFastSettingsTs = 0;
                    if (typeof _ramBootstrapPayload !== 'undefined') _ramBootstrapPayload = null;

                    setImmediate(() => {
                        recalcularPreciosYAlgoritmoTiendaKZ().catch(() => {});
                    });
                }

                const montosEsperadosPorTarjeta = [];
                (itemsParaPedirCentralOne.length > 0 ? itemsParaPedirCentralOne : combo.items).forEach(it => {
                    const q = Math.max(1, Math.round(Number(it.quantity) || 1));
                    for (let k = 0; k < q; k++) {
                        montosEsperadosPorTarjeta.push(Number(it.unitClientUSD || 0));
                    }
                });

                orden.algoExecutionState = {
                    isAlgorithmOrder: true,
                    platformGroup: platGroup,
                    targetClientUSD: Number(pkg.targetClientUSD),
                    gamesTargetsUSD: juegosSeparados.length > 0 ? juegosSeparados : (orden.algoExecutionState?.gamesTargetsUSD || []),
                    orderedItemsMeta: combo.items,
                    currentBatchItems: itemsParaPedirCentralOne,
                    expectedUnitAmountsUSD: montosEsperadosPorTarjeta,
                    deliveredClientUSD: usdCubiertoInterno,
                    deliveredCostUSD: costoCubiertoInterno,
                    ownStockCodesReserved: [...codigosDesdeStockInterno],
                    deliveredCodesList: [...codigosDesdeStockInterno],
                    failedCardIds: [...excluidosFallidos],
                    processedPartialOrderIds: [],
                    pendingReplacementIdempKey: '',
                    pendingReplacementBody: null,
                    totalCardsExpected: combo.totalCards,
                    deliveredCardsCount: codigosDesdeStockInterno.length,
                    retryAttempt: 0
                };
                orden.markModified('algoExecutionState');

                // 🔒 GUARDAR EN MONGODB LOS CÓDIGOS DEL STOCK PROPIO ANTES DE LLAMAR A CENTRAL ONE
                // Así jamás podrán perderse aunque llegue un Webhook o consulta en vivo 100ms después
                await Order.collection.updateOne(
                    { orderId: orden.orderId },
                    { $set: { algoExecutionState: orden.algoExecutionState } }
                ).catch(() => {});

                if (itemsParaPedirCentralOne.length === 0 && codigosDesdeStockInterno.length > 0) {
                    return {
                        success: true,
                        deliveredCode: codigosDesdeStockInterno.join('  |  '),
                        apiOrderId: 'INTERNAL-VAULT-' + Date.now(),
                        raw: { source: 'internal_recovered_stock', combo: combo.summaryText }
                    };
                }

                if (!headersBase) {
                    // Rollback si no hay API configurada
                    if (registrosParaRollback.length > 0 && settings) {
                        registrosParaRollback.forEach(({ cardId, rawCode }) => {
                            const cRestore = poolCards.find(c => c.cardId === cardId);
                            if (cRestore) cRestore.internalCodeStock.unshift(rawCode);
                        });
                        await StoreSettings.collection.updateOne(
                            { key: 'main_settings' },
                            { $set: { arbitrageBaseCards: settings.arbitrageBaseCards } }
                        ).catch(() => {});
                    }
                    return { success: false, errorMsg: 'Faltan códigos en Stock Propio y no hay conexión a Central One API.' };
                }

                const itemsSinId = itemsParaPedirCentralOne.filter(it => !it.centralOneProductId);
                if (itemsSinId.length > 0) {
                    if (registrosParaRollback.length > 0 && settings) {
                        registrosParaRollback.forEach(({ cardId, rawCode }) => {
                            const cRestore = poolCards.find(c => c.cardId === cardId);
                            if (cRestore) cRestore.internalCodeStock.unshift(rawCode);
                        });
                        await StoreSettings.collection.updateOne(
                            { key: 'main_settings' },
                            { $set: { arbitrageBaseCards: settings.arbitrageBaseCards } }
                        ).catch(() => {});
                    }
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

                try {
                    const resCreate = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, bodyOrder, {
                        headers: headersOrder,
                        timeout: 22000
                    });

                    const createdOrder = resCreate.data?.order;
                    if (!createdOrder || !createdOrder.id) {
                        return { success: false, errorMsg: 'Respuesta inválida al crear orden en Central One.' };
                    }

                    // Guardar el apiOrderId junto con ownStockCodesReserved en MongoDB de inmediato
                    orden.apiOrderId = createdOrder.id;
                    await Order.collection.updateOne(
                        { orderId: orden.orderId },
                        { $set: { apiOrderId: createdOrder.id, algoExecutionState: orden.algoExecutionState } }
                    ).catch(() => {});

                    // ⚡ Sondeo en caliente para entregar en el mismo clic de aprobación
                    const check = await consultarConEsperaCalienteCO(createdOrder.id, createdOrder.status, esSteamPool, 0, orden.algoExecutionState);

                    if (check.state === 'COMPLETED') {
                        const vistosRaw = new Set(codigosDesdeStockInterno.map(extraerCodigoCrudoDeTextoFormateado));
                        const todosLosCodigos = [...codigosDesdeStockInterno];
                        for (const cNuevo of (check.codigosPlanos || [])) {
                            const rk = extraerCodigoCrudoDeTextoFormateado(cNuevo);
                            if (rk && !vistosRaw.has(rk)) {
                                vistosRaw.add(rk);
                                todosLosCodigos.push(cNuevo);
                            }
                        }
                        const codigosLimitados = todosLosCodigos.slice(0, combo.totalCards);
                        orden.algoExecutionState.deliveredCodesList = codigosLimitados;
                        orden.algoExecutionState.deliveredCardsCount = codigosLimitados.length;
                        orden.markModified('algoExecutionState');
                        return {
                            success: true,
                            deliveredCode: codigosLimitados.length > 0 ? codigosLimitados.join('  |  ') : check.deliveredCode,
                            apiOrderId: createdOrder.id,
                            raw: check.raw
                        };
                    }

                    if (check.state === 'FAILED' && intento === 1) {
                        itemsParaPedirCentralOne.forEach(it => excluidosFallidos.push(it.cardId));
                        continue;
                    }

                    programarSeguimientoOrdenCentralOne(orden.orderId, createdOrder.id, idempKey, bodyOrder, false);
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
                        orden.algoExecutionState.pendingReplacementIdempKey = idempKey;
                        orden.algoExecutionState.pendingReplacementBody = bodyOrder;
                        orden.markModified('algoExecutionState');
                        await Order.collection.updateOne(
                            { orderId: orden.orderId },
                            { $set: { algoExecutionState: orden.algoExecutionState } }
                        ).catch(() => {});
                        programarSeguimientoOrdenCentralOne(orden.orderId, null, idempKey, bodyOrder, false);
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
                        await StoreSettings.collection.updateOne(
                            { key: 'main_settings' },
                            { $set: { arbitrageBaseCards: settings.arbitrageBaseCards } }
                        ).catch(() => {});
                        continue;
                    }

                    // Si falló definitivamente Central One, devolver los códigos reservados de vuelta a tu Stock Propio para que no se pierdan
                    if (registrosParaRollback.length > 0 && settings) {
                        registrosParaRollback.forEach(({ cardId, rawCode }) => {
                            const cRestore = poolCards.find(c => c.cardId === cardId);
                            if (cRestore) {
                                if (!Array.isArray(cRestore.internalCodeStock)) cRestore.internalCodeStock = [];
                                if (!cRestore.internalCodeStock.includes(rawCode)) cRestore.internalCodeStock.unshift(rawCode);
                            }
                        });
                        orden.algoExecutionState.ownStockCodesReserved = [];
                        orden.algoExecutionState.deliveredCodesList = [];
                        orden.markModified('algoExecutionState');
                        await Promise.all([
                            StoreSettings.collection.updateOne(
                                { key: 'main_settings' },
                                { $set: { arbitrageBaseCards: settings.arbitrageBaseCards } }
                            ),
                            Order.collection.updateOne(
                                { orderId: orden.orderId },
                                { $set: { algoExecutionState: orden.algoExecutionState } }
                            )
                        ]).catch(() => {});
                    }

                    return {
                        success: false,
                        errorMsg: errCO.response?.data?.error?.message || errCO.message
                    };
                }
            }
        } finally {
            activeOrderProcessingLocks.delete(orden.orderId);
        }
    }

    // ⚡ CASO B: RECARGA POR ID O CÓDIGO DIRECTO VINCULADO A CENTRAL ONE
    if (headersBase || poolCards.length > 0) {
        let coProductId = (pkg && pkg.centralOneProductId) || '';
        let coCatItem = null;
        const { tieneCacheAPI, mapaCO_Id, mapaCO_Sku } = obtenerIndicesCatalogoEnRAM(catalogCacheActiva);

        if (tieneCacheAPI) {
            if (coProductId) {
                coCatItem = mapaCO_Id[coProductId] || null;
            }
            if (!coCatItem && (orden.apiProductSku || (pkg && pkg.apiProductSku))) {
                const skuBuscado = String(orden.apiProductSku || pkg.apiProductSku).trim().toUpperCase();
                coCatItem = mapaCO_Sku[skuBuscado] || null;
                if (coCatItem) coProductId = coCatItem.product_id;
            }
        }

        if (coProductId || orden.apiProductSku) {
            const skuDir = String(orden.apiProductSku || (pkg && pkg.apiProductSku) || '').trim().toUpperCase();
            const cardConStockPropio = poolCards.find(c =>
                Array.isArray(c.internalCodeStock) && c.internalCodeStock.length > 0 &&
                ((coProductId && c.centralOneProductId === coProductId) ||
                 (skuDir && String(c.centralOneSku || '').trim().toUpperCase() === skuDir))
            );

            if (cardConStockPropio) {
                const codigoPropioDir = String(cardConStockPropio.internalCodeStock.shift() || '').trim();
                if (codigoPropioDir) {
                    const montoCard = Number(cardConStockPropio.effectiveClientUSD || pkg?.targetClientUSD || pkg?.priceUSD || 0);
                    const platCard = cardConStockPropio.platformGroup || platGroupActual;
                    const codigoFormateadoDir = formatearCodigoConEtiquetaPlataforma(
                        codigoPropioDir,
                        montoCard,
                        platCard,
                        String(platCard).toLowerCase() === 'steam' || esSteamOrder
                    );

                    await StoreSettings.collection.updateOne(
                        { key: 'main_settings' },
                        { $set: { arbitrageBaseCards: settings.arbitrageBaseCards } }
                    ).catch(() => {});

                    return {
                        success: true,
                        deliveredCode: codigoFormateadoDir,
                        apiOrderId: 'INTERNAL-VAULT-' + Date.now(),
                        raw: { source: 'internal_card_stock_direct', remaining: cardConStockPropio.internalCodeStock.length }
                    };
                }
            }
        }

        if (headersBase && coProductId) {
            let primaryTargetPayload = null;
            let fallbackTargetPayload = null;

            if (!coCatItem || coCatItem.requires_target !== false) {
                const tieneCamposTarget = (coCatItem && Array.isArray(coCatItem.target_fields) && coCatItem.target_fields.length > 0) ||
                                          (orden.fulfillmentType === 'API_DIRECT_TOPUP');
                if (tieneCamposTarget) {
                    const resueltoTarget = construirTargetPayloadCentralOne(
                        coCatItem,
                        orden.playerUid,
                        orden.playerServer,
                        orden.playerRegion,
                        orden.productSlug
                    );
                    primaryTargetPayload = resueltoTarget.primaryPayload;
                    fallbackTargetPayload = resueltoTarget.fallbackPayload;
                }
            }

            const enviarOrdenDirectaCO = async (tPayloadUsar, sufijoIntento = 'v1') => {
                const idempKey = `kz-ord-${orden.orderId}-direct-${sufijoIntento}`.replace(/[^A-Za-z0-9_-]/g, '');
                const headersOrder = obtenerHeadersCentralOne({ 'Idempotency-Key': idempKey });
                const itemPayload = {
                    catalog_item_id: coProductId,
                    quantity: 1,
                    ...(tPayloadUsar ? { target_payload: tPayloadUsar } : {})
                };
                const bodyDirect = {
                    items: [itemPayload],
                    note: `KemZone #${orden.orderId} - ${orden.productName}`.slice(0, 480)
                };
                const resCreate = await axios.post(`${CENTRAL_ONE_BASE_URL}/orders`, bodyDirect, {
                    headers: headersOrder,
                    timeout: 22000
                });
                return { resCreate, idempKey, bodyDirect };
            };

            try {
                let intentoRes = null;
                try {
                    intentoRes = await enviarOrdenDirectaCO(primaryTargetPayload, 'v1');
                } catch (errV1) {
                    const statusHttp = errV1.response?.status || 0;
                    if ((statusHttp === 400 || statusHttp === 422) && fallbackTargetPayload) {
                        intentoRes = await enviarOrdenDirectaCO(fallbackTargetPayload, 'v2');
                    } else {
                        throw errV1;
                    }
                }

                let { resCreate, idempKey, bodyDirect } = intentoRes;
                let createdOrder = resCreate.data?.order;
                if (!createdOrder || !createdOrder.id) {
                    return { success: false, errorMsg: 'Central One no devolvió ID de pedido.' };
                }

                // ⚡ Sondeo en caliente también para productos directos
                let check = await consultarConEsperaCalienteCO(createdOrder.id, createdOrder.status, esSteamOrder, Number(pkg?.targetClientUSD || 0), null);

                if (check.state === 'FAILED' && fallbackTargetPayload && /target|server|region|zone|invalid|player/i.test(`${check.failureCode || ''} ${check.errorMsg || ''}`)) {
                    try {
                        const retryFb = await enviarOrdenDirectaCO(fallbackTargetPayload, 'v2');
                        if (retryFb.resCreate.data?.order?.id) {
                            createdOrder = retryFb.resCreate.data.order;
                            idempKey = retryFb.idempKey;
                            bodyDirect = retryFb.bodyDirect;
                            check = await consultarConEsperaCalienteCO(createdOrder.id, createdOrder.status, esSteamOrder, Number(pkg?.targetClientUSD || 0), null);
                        }
                    } catch (eRetryFb) {}
                }

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

                programarSeguimientoOrdenCentralOne(orden.orderId, createdOrder.id, idempKey, bodyDirect, false);
                return {
                    success: true,
                    isProcessingAsync: true,
                    deliveredCode: '',
                    apiOrderId: createdOrder.id,
                    raw: check.raw
                };
            } catch (errDirect) {
                const idempFallback = `kz-ord-${orden.orderId}-direct-v1`.replace(/[^A-Za-z0-9_-]/g, '');
                const bodyFallback = {
                    items: [{
                        catalog_item_id: coProductId,
                        quantity: 1,
                        ...(primaryTargetPayload ? { target_payload: primaryTargetPayload } : {})
                    }],
                    note: `KemZone #${orden.orderId} - ${orden.productName}`.slice(0, 480)
                };
                const esTimeoutDir = errDirect.code === 'ECONNABORTED' || String(errDirect.message || '').toLowerCase().includes('timeout');
                if (esTimeoutDir) {
                    programarSeguimientoOrdenCentralOne(orden.orderId, null, idempFallback, bodyFallback, false);
                    return {
                        success: true,
                        isProcessingAsync: true,
                        deliveredCode: '',
                        apiOrderId: idempFallback,
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

// 🔌 Enriquecedor automático de target_schema y región en /api/admin/overview para el Selector Maestro de Juegos
app.use('/api/admin/overview', (req, res, next) => {
    const _origJson = res.json.bind(res);
    res.json = function(body) {
        try {
            if (body && body.settings && Array.isArray(body.settings.centralOneCatalogCache) && Array.isArray(_ramCentralOneCatalogCache) && _ramCentralOneCatalogCache.length > 0) {
                const { mapaCO_Id } = obtenerIndicesCatalogoEnRAM(_ramCentralOneCatalogCache);
                body.settings.centralOneCatalogCache = body.settings.centralOneCatalogCache.map(item => {
                    const full = mapaCO_Id[item.product_id] || item;
                    return {
                        ...item,
                        region: full.region || full.country || item.region || '',
                        target_schema: full.target_schema || item.target_schema || null
                    };
                });
            }
        } catch (e) {}
        return _origJson(body);
    };
    next();
});

// ⏱️ Inyectar siempre la hora oficial del servidor (serverNowMs) en las órdenes en vivo para que ningún teléfono con hora adelantada altere el contador de 1 hora
app.use(['/api/orders/live-status', '/api/orders/create', '/api/binance-pay/check-status'], (req, res, next) => {
    const _origJson = res.json.bind(res);
    res.json = function(body) {
        if (body && body.order && typeof body.order === 'object') {
            if (typeof body.order.toObject === 'function') {
                body.order = body.order.toObject();
            }
            body.order.serverNowMs = Date.now();
        }
        return _origJson(body);
    };
    next();
});

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

        // 🔒 CANDADO DE 1 HORA EN EL SERVIDOR: Verificar cuánto tiempo real ha transcurrido en el reloj del servidor
        const DURACION_CICLO_1_HORA_MS = 60 * 60 * 1000; // 60 minutos reales
        const ahoraServidorMs = Date.now();
        const offsetVzlaMs = 4 * 60 * 60 * 1000;
        const ahoraVzla = new Date(ahoraServidorMs - offsetVzlaMs);
        const aperturaHoy11amUtcMs = Date.UTC(
            ahoraVzla.getUTCFullYear(),
            ahoraVzla.getUTCMonth(),
            ahoraVzla.getUTCDate(),
            15, 0, 0, 0
        );

        let inicioCicloMs = new Date(orden.timerStartedAt || orden.fecha || ahoraServidorMs).getTime();
        if ((Number(orden.waitCyclesCount) || 0) === 0 && inicioCicloMs < aperturaHoy11amUtcMs && ahoraServidorMs >= aperturaHoy11amUtcMs) {
            inicioCicloMs = aperturaHoy11amUtcMs;
        }

        const transcurridoRealServidorMs = Math.max(0, ahoraServidorMs - inicioCicloMs);

        // Si un cliente con caché antiguo (de 30 min) o reloj de teléfono adelantado envía la petición antes de cumplirse la hora real (mínimo 58 min en servidor), sincronizar su reloj sin reiniciar ni cancelar
        if (transcurridoRealServidorMs < (58 * 60 * 1000)) {
            const ordObj = orden.toObject ? orden.toObject() : { ...orden };
            ordObj.serverNowMs = ahoraServidorMs;
            return res.json({
                success: true,
                prematureSync: true,
                order: ordObj
            });
        }

        // OPCIÓN 1: EL CLIENTE ELIGE SEGUIR ESPERANDO (REINICIA 1 HORA MÁS Y AUMENTA EL CICLO SIN RE-PEDIR A LA API)
        if (choice === 'WAIT') {
            const nuevoCiclo = (Number(orden.waitCyclesCount) || 0) + 1;
            orden.waitCyclesCount = nuevoCiclo;
            orden.timerStartedAt = new Date(ahoraServidorMs);
            orden.clientChoseToWait = true;
            orden.statusMessage = nuevoCiclo >= 2
                ? `⏳ Seguimiento prioritario extendido (Ciclo #${nuevoCiclo + 1} de 1 hora): Nuestro sistema continúa esperando la liberación de tu entrega sin cargos adicionales...`
                : '⏳ Seguimiento prioritario activado (+1 hora): Nuestro sistema continúa gestionando la entrega automática de tu compra...';
            await orden.save();

            if (orden.apiOrderId && !orden.apiOrderId.startsWith('VAULT-') && !orden.apiOrderId.startsWith('INTERNAL-') && !orden.apiOrderId.startsWith('API-')) {
                if (!activeCentralOnePollers.has(orden.orderId)) {
                    const idCo = orden.apiOrderId.startsWith('kz-ord-') ? null : orden.apiOrderId;
                    const idempKey = orden.apiOrderId.startsWith('kz-ord-') ? orden.apiOrderId : (orden.algoExecutionState?.pendingReplacementIdempKey || null);
                    programarSeguimientoOrdenCentralOne(orden.orderId, idCo, idempKey, orden.algoExecutionState?.pendingReplacementBody || null);
                }
            }

            const ordOut = orden.toObject ? orden.toObject() : { ...orden };
            ordOut.serverNowMs = Date.now();
            return res.json({ success: true, order: ordOut });
        }

        // OPCIÓN 2: EL CLIENTE ELIGE SOLICITAR REEMBOLSO Y ABRIR TICKET AUTOMÁTICO EN CHAT TRAS 1 HORA (O MÁS) DE ESPERA
        if (choice === 'REFUND') {
            orden.cancelledByDelayRefund = true;
            orden.status = 'RECHAZADO';
            orden.progressPercent = 100;

            const codigosParciales = (orden.algoExecutionState && Array.isArray(orden.algoExecutionState.deliveredCodesList))
                ? orden.algoExecutionState.deliveredCodesList
                : [];
            if (codigosParciales.length > 0) {
                const crudosParciales = codigosParciales.map(c => c.includes('➔') ? c.split('➔').slice(1).join('➔').trim() : c);
                await guardarCodigosRecuperadosEnStockInterno(orden, [], crudosParciales);
                orden.algoExecutionState.deliveredCodesList = [];
                orden.markModified('algoExecutionState');
            }

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

            const ciclosEsperados = (Number(orden.waitCyclesCount) || 0) + 1;
            const minTotalesEsperados = ciclosEsperados * 60;
            const textoHoras = ciclosEsperados === 1 ? '1 hora (60 min)' : `${ciclosEsperados} horas (${minTotalesEsperados} min)`;
            const montoTexto = `${orden.paymentReference || 'Tokems'} ($${Number(orden.totalAmountUSD || 0).toFixed(2)} USD / Bs. ${Number(orden.totalAmountVES || 0).toFixed(2)})`;
            const mensajeAuto = `⏱️ SOLICITUD DE REEMBOLSO / AGENTE (+${textoHoras.toUpperCase()} DE ESPERA):\n` +
                `• Pedido cancelado: #${orden.orderId}\n` +
                `• Producto: ${orden.productName} (${orden.packageName})\n` +
                `• Método de pago: ${orden.paymentMethodName}\n` +
                `• Referencia y Monto: ${montoTexto}\n` +
                `• Destino / ID: ${orden.playerUid}\n` +
                `El pedido superó el tiempo de espera (${ciclosEsperados} ciclo(s) de 1 hora) y solicito mi reembolso o atención de un agente.`;

            const nuevoTicket = await new SupportTicket({
                ticketId,
                orderId: orden.orderId,
                deviceId: identificador,
                userEmail: orden.userEmail || (identificador.includes('@') ? identificador : ''),
                userName: nombreCliente,
                userWhatsapp: wsFinal,
                subject: `Reembolso por retraso (+${textoHoras}) - Orden #${orden.orderId}`,
                category: `Reembolso por espera (+${textoHoras}) • #${orden.orderId}`,
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
            orden.workerNotes = `Pedido cancelado por el cliente tras ${textoHoras} de espera. Solicitud de reembolso abierta en Ticket #${ticketId}.`;
            orden.statusMessage = `Pedido cancelado a solicitud del cliente. Se abrió el chat de reembolso en el Ticket #${ticketId}.`;
            orden.completedAt = new Date();
            await orden.save();

            const ordOut = orden.toObject ? orden.toObject() : { ...orden };
            ordOut.serverNowMs = Date.now();
            return res.json({
                success: true,
                order: ordOut,
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
// 🔔 WEBHOOK OFICIAL DE CENTRAL ONE (FIRMA HMAC-SHA256 + BLINDAJE DE ENTREGA)
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

        if (timestamp) {
            const ahoraSeg = Math.floor(Date.now() / 1000);
            const tsNum = parseInt(timestamp, 10);
            if (!isNaN(tsNum) && Math.abs(ahoraSeg - tsNum) > 320) {
                return res.status(401).json({ error: 'Timestamp fuera de ventana de 5 minutos.' });
            }
        }

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

        res.status(200).json({ received: true, event_id: eventId });

        let settings = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settings) settings = new StoreSettings({ key: 'main_settings' });

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

        // B. Eventos de Órdenes: delegar de forma sincronizada al Vigilante con candado para evitar carreras
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
                    await ordenDB.save();
                }

                // Activar el vigilante protegido por candado (procesa entregas completas, parciales, topes de tarjetas y reembolsos en 1 solo lugar)
                programarSeguimientoOrdenCentralOne(ordenDB.orderId, wOrder.id || ordenDB.apiOrderId);
            }
        }

        // C. Eventos de Saldo
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
            const planTarjetas = calcularCombinacionListaJuegosSeparadosSteam(
                validGames,
                settings.arbitrageBaseCards || [],
                settings.centralOneCatalogCache || null
            );

            if (!planTarjetas || !planTarjetas.hasSolution) {
                return res.status(400).json({
                    error: (planTarjetas && planTarjetas.reason) || `No hay combinación de tarjetas en stock para cubrir los juegos solicitados.`
                });
            }

            const costoTarjetasTotal = Number(planTarjetas.totalCostUSD);
            const itemsCalc = validGames.map((it, idx) => {
                const planIndiv = (planTarjetas.perGamePlans && planTarjetas.perGamePlans[idx]?.planIndiv)
                    ? planTarjetas.perGamePlans[idx].planIndiv
                    : calcularMejorCombinacionTarjetasPool(
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
            nombrePaquete = `${resumenJuegosTxt} ➔ Recibes $${Number(planTarjetas.totalClientUSD).toFixed(2)} USD en Steam`;
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
                gamesTargetsUSD: validGames.map(g => ({ label: g.label, usdR: g.usdR })),
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
                 String(of.linkedPackageId || '').trim() === idPkgBuscado ||
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
                    // Si la oferta está vinculada a un paquete existente del producto, hereda su configuración técnica (API, Algoritmo, Bóveda)
                    if (!pkg && ofertaMatch.linkedPackageId) {
                        pkg = listaPaquetesActiva.find(p => String(p.packageId || p.id || '').trim() === String(ofertaMatch.linkedPackageId).trim());
                    }
                    const bovedaOferta = Array.isArray(ofertaMatch.backupPinVault) && ofertaMatch.backupPinVault.length > 0
                        ? ofertaMatch.backupPinVault
                        : (pkg && Array.isArray(pkg.backupPinVault) ? pkg.backupPinVault : []);

                    pkg = {
                        ...(pkg ? (pkg.toObject ? pkg.toObject() : pkg) : {}),
                        packageId: (pkg && pkg.packageId) || ofertaMatch.linkedPackageId || ofertaMatch.pkgId || idPkgBuscado,
                        name: ofertaMatch.title || (pkg ? pkg.name : 'Paquete en Oferta'),
                        priceUSD: Number(ofertaMatch.usd),
                        costUSD: Number(ofertaMatch.costUSD || (pkg ? pkg.costUSD : 0) || 0),
                        tokemsPrice: Number(ofertaMatch.tokemsPrice || ofertaMatch.usd),
                        apiProviderName: (pkg && pkg.apiProviderName) || 'CENTRAL_ONE',
                        apiProductSku: ofertaMatch.apiProductSku || (pkg ? pkg.apiProductSku : '') || ofertaMatch.pkgId,
                        centralOneProductId: ofertaMatch.centralOneProductId || (pkg ? pkg.centralOneProductId : '') || '',
                        useSmartAlgorithm: Boolean((pkg && pkg.useSmartAlgorithm) || productoDB.isSmartCodeProduct),
                        targetClientUSD: Number((pkg && pkg.targetClientUSD) || 0),
                        isGiftCardPin: ofertaMatch.isGiftCardPin !== undefined ? Boolean(ofertaMatch.isGiftCardPin) : Boolean(pkg && pkg.isGiftCardPin),
                        backupPinVault: bovedaOferta,
                        inStock: true,
                        providerInStock: pkg && pkg.providerInStock !== undefined ? pkg.providerInStock : true
                    };
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

let _ramBootstrapPayload = null;
let _ramBootstrapTs = 0;
const _ramVerifiedPlayersCache = new Map();

// Invalidar en 0ms toda caché en RAM apenas el Dueño o Trabajador guarde cualquier cambio
app.use((req, res, next) => {
    if (req.method === 'POST' && (req.path.startsWith('/api/admin/') || req.path.startsWith('/api/worker/'))) {
        res.on('finish', () => {
            _ramBootstrapPayload = null;
            _ramBootstrapTs = 0;
            if (typeof _ramFastSettingsTs !== 'undefined') _ramFastSettingsTs = 0;
            if (typeof _ramFastProductsTs !== 'undefined') _ramFastProductsTs = 0;
            if (typeof _ramFastPaymentMethodsTs !== 'undefined') _ramFastPaymentMethodsTs = 0;
        });
    }
    next();
});

app.get('/api/store/bootstrap', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    try {
        const ahora = Date.now();
        const forzarFresco = Boolean(req.query.nocache === '1' || req.query._t);

        if (!forzarFresco && _ramBootstrapPayload && (ahora - _ramBootstrapTs < 3000)) {
            return res.json({
                ..._ramBootstrapPayload,
                serverTimestamp: ahora
            });
        }

        const [settingsRaw, products, paymentMethods] = await Promise.all([
            StoreSettings.collection.findOne(
                { key: 'main_settings' },
                {
                    projection: {
                        centralOneCatalogCache: 0,
                        centralOneCoverageCache: 0,
                        centralOneAlerts: 0,
                        processedWebhookIds: 0,
                        flyersCanvaConfig: 0
                    }
                }
            ),
            CatalogProduct.find()
                .sort({ sortOrder: 1, createdAt: 1 })
                .select('-packages.costUSD -packages.backupPinVault -packages.targetSchemaCache -altPackages.costUSD -altPackages.backupPinVault -altPackages.targetSchemaCache')
                .lean(),
            PaymentMethod.find({ active: true }).sort({ sortOrder: 1 }).lean()
        ]);

        const settings = settingsRaw || { exchangeRateVES: 1012.00, bcvRateVES: 889.25, tokemValueUSD: 1.00, storeOpen: true };
        if (typeof _ramScheduleConfig !== 'undefined' && _ramScheduleConfig) {
            settings.scheduleConfig = _ramScheduleConfig;
        }

        _ramBootstrapPayload = {
            success: true,
            settings,
            products: products || [],
            paymentMethods: paymentMethods || []
        };
        _ramBootstrapTs = ahora;

        return res.json({
            ..._ramBootstrapPayload,
            serverTimestamp: ahora
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error cargando catálogo de la tienda.' });
    }
});

// 🌍 TRADUCTOR INTELIGENTE DE REGIONES Y SERVIDORES HACIA CENTRAL ONE API
function normalizarValorServidorJuego(rawRegionOrServer, targetSchemaField = null, slugJuego = '') {
    const val = String(rawRegionOrServer || '').trim();
    if (!val) return { primary: '', fallback: '' };

    if (val.includes('|')) {
        const partes = val.split('|').map(s => s.trim()).filter(Boolean);
        return { primary: partes[1] || partes[0], fallback: partes[0] };
    }

    const vLow = val.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

    let stdName = val;
    let hoyoCode = val;

    if (vLow === 'america' || vLow === 'americas' || vLow === 'na' || vLow === 'north america' || vLow === 'norteamerica' || vLow === 'os_usa') {
        stdName = 'America';
        hoyoCode = 'os_usa';
    } else if (vLow === 'europa' || vLow === 'europe' || vLow === 'eu' || vLow === 'os_euro') {
        stdName = 'Europe';
        hoyoCode = 'os_euro';
    } else if (vLow === 'asia' || vLow === 'as' || vLow === 'os_asia') {
        stdName = 'Asia';
        hoyoCode = 'os_asia';
    } else if (vLow.includes('tw') || vLow.includes('hk') || vLow.includes('mo') || vLow === 'os_cht' || vLow.includes('sar')) {
        stdName = 'TW, HK, MO';
        hoyoCode = 'os_cht';
    } else if (vLow === 'latam' || vLow === 'latinoamerica' || vLow === 'sudamerica' || vLow === 'south america' || vLow === 'sa') {
        stdName = 'South America';
        hoyoCode = 'SA';
    } else if (vLow === 'brasil' || vLow === 'brazil' || vLow === 'br') {
        stdName = 'Brazil';
        hoyoCode = 'BR';
    }

    let schemaOptions = [];
    if (targetSchemaField && typeof targetSchemaField === 'object') {
        if (Array.isArray(targetSchemaField.options)) schemaOptions = targetSchemaField.options;
        else if (Array.isArray(targetSchemaField.enum)) schemaOptions = targetSchemaField.enum;
        else if (Array.isArray(targetSchemaField.values)) schemaOptions = targetSchemaField.values;
    }

    if (schemaOptions.length > 0) {
        const valoresSchema = schemaOptions.map(opt => {
            if (typeof opt === 'string') return { value: opt, label: opt };
            return {
                value: String(opt.value ?? opt.id ?? opt.code ?? opt.key ?? opt.label ?? ''),
                label: String(opt.label ?? opt.name ?? opt.title ?? opt.value ?? '')
            };
        }).filter(x => x.value);

        const matchExacto = valoresSchema.find(x =>
            x.value.toLowerCase() === val.toLowerCase() ||
            x.value.toLowerCase() === stdName.toLowerCase() ||
            x.value.toLowerCase() === hoyoCode.toLowerCase() ||
            x.label.toLowerCase() === stdName.toLowerCase() ||
            x.label.toLowerCase().includes(vLow)
        );
        if (matchExacto) {
            return {
                primary: matchExacto.value,
                fallback: matchExacto.value === stdName ? hoyoCode : stdName
            };
        }
    }

    return {
        primary: stdName,
        fallback: hoyoCode !== stdName ? hoyoCode : val
    };
}

function construirTargetPayloadCentralOne(coCatItem, rawUid, rawServer, rawRegion, slugJuego = '') {
    const targetFields = (coCatItem && Array.isArray(coCatItem.target_fields) && coCatItem.target_fields.length > 0)
        ? coCatItem.target_fields
        : ['player_id'];

    const rawSchema = coCatItem?.target_schema || null;
    const encontrarSchemaDeCampo = (fieldKey) => {
        if (!rawSchema) return null;
        if (Array.isArray(rawSchema)) {
            return rawSchema.find(f => (f.name || f.key || f.field || f.id) === fieldKey) || null;
        }
        if (rawSchema.properties && rawSchema.properties[fieldKey]) return rawSchema.properties[fieldKey];
        if (rawSchema[fieldKey]) return rawSchema[fieldKey];
        return null;
    };

    const uidLimpio = String(rawUid || '').trim();
    let srvORegionElegido = String(rawServer || rawRegion || '').trim();

    const esJuegoHoyo = /genshin|honkai|star-rail|zenless|zzz/i.test(`${slugJuego} ${coCatItem?.name || ''} ${coCatItem?.sku || ''}`);
    if (!srvORegionElegido && esJuegoHoyo && /^[6789]\d{8,9}$/.test(uidLimpio)) {
        const primerDigito = uidLimpio.charAt(0);
        if (primerDigito === '6') srvORegionElegido = 'America';
        else if (primerDigito === '7') srvORegionElegido = 'Europe';
        else if (primerDigito === '8') srvORegionElegido = 'Asia';
        else if (primerDigito === '9') srvORegionElegido = 'TW, HK, MO';
    }

    const payloadPrimario = {};
    const payloadAlternativo = {};
    let tieneAlternativo = false;

    targetFields.forEach((fieldKey, idx) => {
        const fkLower = String(fieldKey).toLowerCase();
        const fieldSchema = encontrarSchemaDeCampo(fieldKey);

        if (fkLower.includes('server') || fkLower.includes('zone') || fkLower.includes('region') || fkLower.includes('world')) {
            const valorCrudo = (fkLower.includes('zone') && rawServer)
                ? String(rawServer).trim()
                : (srvORegionElegido || String(rawRegion || rawServer || '').trim());

            const resuelto = normalizarValorServidorJuego(valorCrudo, fieldSchema, slugJuego);
            payloadPrimario[fieldKey] = resuelto.primary;
            payloadAlternativo[fieldKey] = resuelto.fallback || resuelto.primary;
            if (resuelto.fallback && resuelto.fallback !== resuelto.primary) {
                tieneAlternativo = true;
            }
        } else if (idx === 0 || fkLower.includes('player') || fkLower.includes('uid') || fkLower.includes('user') || fkLower.includes('id') || fkLower.includes('account')) {
            payloadPrimario[fieldKey] = uidLimpio;
            payloadAlternativo[fieldKey] = uidLimpio;
        } else {
            payloadPrimario[fieldKey] = srvORegionElegido || uidLimpio;
            payloadAlternativo[fieldKey] = srvORegionElegido || uidLimpio;
        }
    });

    return {
        primaryPayload: payloadPrimario,
        fallbackPayload: tieneAlternativo ? payloadAlternativo : null
    };
}

// 1.5 Verificar ID de Jugador en 0ms desde RAM + Caché de Jugadores Verificados (Sin descargar 8MB de MongoDB)
app.post('/api/orders/verify-player', async (req, res) => {
    try {
        const { productSlug, packageId, playerUid, playerServer, playerRegion } = req.body;
        const uidClean = String(playerUid || '').trim();
        if (!uidClean || uidClean.length < 3) {
            return res.status(400).json({ error: 'Ingresa un ID de jugador válido.' });
        }

        const slugClean = String(productSlug || '').trim().toLowerCase();
        const cacheKeyPlayer = `${slugClean}|${uidClean}|${String(playerServer || '').trim()}|${String(playerRegion || '').trim()}`;
        const cachedPlayer = _ramVerifiedPlayersCache.get(cacheKeyPlayer);
        if (cachedPlayer && (Date.now() - cachedPlayer.ts < 15 * 60 * 1000)) {
            return res.status(cachedPlayer.httpStatus).json(cachedPlayer.payload);
        }

        const headers = obtenerHeadersCentralOne();
        if (headers && slugClean) {
            const prodDB = await obtenerProductoCheckoutRAM(slugClean);

            if (!Array.isArray(_ramCentralOneCatalogCache) || _ramCentralOneCatalogCache.length === 0) {
                const docCat = await StoreSettings.collection.findOne(
                    { key: 'main_settings' },
                    { projection: { centralOneCatalogCache: 1 } }
                );
                if (docCat && Array.isArray(docCat.centralOneCatalogCache)) {
                    _ramCentralOneCatalogCache = docCat.centralOneCatalogCache;
                }
            }
            const { tieneCacheAPI, mapaCO_Id, mapaCO_Sku } = obtenerIndicesCatalogoEnRAM(_ramCentralOneCatalogCache);

            if (prodDB) {
                const listaPaq = (prodDB.useAltPricing && Array.isArray(prodDB.altPackages) && prodDB.altPackages.length > 0)
                    ? prodDB.altPackages
                    : (prodDB.packages || []);
                const pkgElegido = (packageId && listaPaq.find(p => p.packageId === packageId)) ||
                                   listaPaq.find(p => p.centralOneProductId || p.apiProductSku) ||
                                   listaPaq[0];

                let coProductId = pkgElegido ? (pkgElegido.centralOneProductId || '') : '';
                let coCatItem = null;

                if (tieneCacheAPI) {
                    if (coProductId) {
                        coCatItem = mapaCO_Id[coProductId] || null;
                    }
                    if (!coCatItem && pkgElegido && pkgElegido.apiProductSku) {
                        const skuClean = String(pkgElegido.apiProductSku).trim().toUpperCase();
                        coCatItem = mapaCO_Sku[skuClean] || null;
                        if (coCatItem) coProductId = coCatItem.product_id;
                    }
                }

                if (coProductId && (!coCatItem || coCatItem.requires_target !== false)) {
                    const { primaryPayload, fallbackPayload } = construirTargetPayloadCentralOne(
                        coCatItem,
                        uidClean,
                        playerServer,
                        playerRegion,
                        slugClean
                    );

                    const intentarValidacionCO = async (tPayload) => {
                        const respCO = await axios.post(`${CENTRAL_ONE_BASE_URL}/player/validate`, {
                            product_id: coProductId,
                            target_payload: tPayload
                        }, { headers, timeout: 6500 });
                        return respCO.data || {};
                    };

                    try {
                        let dataCO = await intentarValidacionCO(primaryPayload);

                        if (dataCO.status === 'invalid' && fallbackPayload) {
                            try {
                                const dataFallback = await intentarValidacionCO(fallbackPayload);
                                if (dataFallback && dataFallback.status === 'valid') {
                                    dataCO = dataFallback;
                                }
                            } catch (eFb) {}
                        }

                        if (dataCO.status === 'valid') {
                            const nick = dataCO.player?.name || '';
                            const okPayload = {
                                success: true,
                                status: 'valid',
                                verified: true,
                                nickname: nick,
                                message: nick
                                    ? `✅ Cuenta verificada: ${nick}`
                                    : `✅ Cuenta verificada y activa en el servidor del juego.`
                            };
                            _ramVerifiedPlayersCache.set(cacheKeyPlayer, { ts: Date.now(), httpStatus: 200, payload: okPayload });
                            return res.json(okPayload);
                        }

                        if (dataCO.status === 'invalid') {
                            const invPayload = {
                                success: false,
                                status: 'invalid',
                                verified: false,
                                error: '❌ El ID de jugador o la Región seleccionada NO coinciden con ninguna cuenta activa en este servidor. Revísalos e intenta de nuevo.'
                            };
                            _ramVerifiedPlayersCache.set(cacheKeyPlayer, { ts: Date.now(), httpStatus: 400, payload: invPayload });
                            return res.status(400).json(invPayload);
                        }
                    } catch (errVal) {
                        if (fallbackPayload) {
                            try {
                                const dataFb2 = await intentarValidacionCO(fallbackPayload);
                                if (dataFb2 && dataFb2.status === 'valid') {
                                    const nick = dataFb2.player?.name || '';
                                    const okFbPayload = {
                                        success: true,
                                        status: 'valid',
                                        verified: true,
                                        nickname: nick,
                                        message: nick ? `✅ Cuenta verificada: ${nick}` : `✅ Cuenta verificada en el servidor.`
                                    };
                                    _ramVerifiedPlayersCache.set(cacheKeyPlayer, { ts: Date.now(), httpStatus: 200, payload: okFbPayload });
                                    return res.json(okFbPayload);
                                }
                            } catch (eFb2) {}
                        }
                    }
                }
            }
        }

        return res.json({
            success: true,
            status: 'unverified',
            verified: false,
            nickname: '',
            message: 'ℹ️ No se puede mostrar el apodo en este juego, igualmente si escribió bien su ID y región, su recarga llegará sin problemas.'
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error al validar el ID.' });
    }
});

// ⚡ CACHÉ ULTRARRÁPIDO EN RAM PARA CHECKOUT ("ENVIAR PAGO" EN ~50ms SIN LEER 10MB DE DISCO)
let _ramFastSettings = null;
let _ramFastSettingsTs = 0;
let _ramFastPaymentMethods = null;
let _ramFastPaymentMethodsTs = 0;
let _ramFastProductsMap = new Map();
let _ramFastProductsTs = 0;

async function obtenerSettingsCheckoutRAM(forzar = false) {
    const ahora = Date.now();
    if (!forzar && _ramFastSettings && (ahora - _ramFastSettingsTs < 20000)) {
        return _ramFastSettings;
    }
    const doc = await StoreSettings.collection.findOne(
        { key: 'main_settings' },
        {
            projection: {
                exchangeRateVES: 1,
                bcvRateVES: 1,
                tokemValueUSD: 1,
                storeOpen: 1,
                autoTriggerApiOnTokems: 1,
                'flashOffers.slug': 1,
                'flashOffers.pkgId': 1,
                'flashOffers.linkedPackageId': 1,
                'flashOffers.title': 1,
                'flashOffers.usd': 1,
                'flashOffers.oldUsd': 1,
                'flashOffers.costUSD': 1,
                'flashOffers.tokemsPrice': 1,
                'flashOffers.apiProductSku': 1,
                'flashOffers.centralOneProductId': 1,
                'flashOffers.isGiftCardPin': 1,
                'flashOffers.backupPinVault': 1,
                'flashOffers.active': 1,
                'flashOffers.expiresAt': 1,
                arbitrageBaseCards: 1
            }
        }
    );
    if (doc) {
        _ramFastSettings = doc;
        _ramFastSettingsTs = ahora;
    }
    return _ramFastSettings;
}

async function obtenerMetodoPagoCheckoutRAM(paymentMethodKey) {
    const ahora = Date.now();
    if (!_ramFastPaymentMethods || (ahora - _ramFastPaymentMethodsTs > 30000)) {
        const lista = await PaymentMethod.collection.find(
            { active: true },
            { projection: { methodKey: 1, name: 1, currency: 1, requiresReference: 1, refDigitsLength: 1, active: 1 } }
        ).toArray();
        _ramFastPaymentMethods = lista || [];
        _ramFastPaymentMethodsTs = ahora;
    }
    const keyClean = String(paymentMethodKey || '').trim();
    return _ramFastPaymentMethods.find(m => m.methodKey === keyClean) ||
           (keyClean.startsWith('pago_movil') ? _ramFastPaymentMethods.find(m => m.methodKey === 'pago_movil') : null) ||
           null;
}

async function obtenerProductoCheckoutRAM(slugBuscado) {
    const slugClean = String(slugBuscado || '').trim().toLowerCase();
    if (!slugClean) return null;
    const ahora = Date.now();
    if (_ramFastProductsMap.has(slugClean) && (ahora - _ramFastProductsTs < 20000)) {
        return _ramFastProductsMap.get(slugClean);
    }
    const prods = await CatalogProduct.collection.find(
        {},
        {
            projection: {
                cardImageUrl: 0,
                flyerImageUrl: 0,
                infoImageUrl: 0,
                'packages.imageUrl': 0,
                'altPackages.imageUrl': 0,
                'packages.targetSchemaCache': 0,
                'altPackages.targetSchemaCache': 0
            }
        }
    ).toArray();
    const nuevoMapa = new Map();
    (prods || []).forEach(p => {
        if (p && p.slug) nuevoMapa.set(String(p.slug).trim().toLowerCase(), p);
    });
    _ramFastProductsMap = nuevoMapa;
    _ramFastProductsTs = ahora;
    return _ramFastProductsMap.get(slugClean) || null;
}

// Invalidar el caché en RAM automáticamente apenas el Dueño guarde cambios en Ajustes, Productos o Métodos de Pago
app.use(['/api/admin/settings', '/api/admin/central-one/sync', '/api/admin/product/save', '/api/admin/product/delete', '/api/admin/payment-method/save', '/api/admin/payment-method/delete'], (req, res, next) => {
    res.on('finish', () => {
        _ramFastSettingsTs = 0;
        _ramFastProductsTs = 0;
        _ramFastPaymentMethodsTs = 0;
    });
    next();
});

// 🔒 Candado Server-Side para el botón "🎁 Código Manual (Sin API)"
app.use('/api/worker/process-order', (req, res, next) => {
    if (req.body && req.body.action === 'APROBAR' && req.body.forceManualNoApi === true) {
        const codigoManual = String(req.body.manualPinCode || '').trim();
        if (!codigoManual) {
            return res.status(400).json({
                error: 'Estás en Modo Entrega Manual (Sin API). Debes pegar o escribir el código antes de confirmar.'
            });
        }
    }
    next();
});

// Precargar el caché en RAM al arrancar el servidor
setTimeout(() => {
    obtenerSettingsCheckoutRAM(true).catch(() => {});
    obtenerMetodoPagoCheckoutRAM('pago_movil').catch(() => {});
    obtenerProductoCheckoutRAM('free-fire-id').catch(() => {});
}, 2000);

// 2. Crear Orden en la Pestaña de Pago -> Pasa a la Pestaña de Entrega en Vivo (Instantáneo desde RAM ~50ms)
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

        const identificadorLimpio = (userEmail || deviceId || 'invitado').trim().toLowerCase();
        const refLimpia = (paymentReference || '').trim().toUpperCase();
        const slugBuscado = String(productSlug || '').trim().toLowerCase();
        const esOrdenProductoNormal = (orderType !== 'TOKEM_TOPUP' && slugBuscado && slugBuscado !== 'calculadora-steam' && slugBuscado !== 'tokems-kz');
        const hace48Horas = new Date(Date.now() - 48 * 60 * 60 * 1000);

        // ⚡ CONSULTA EN PARALELO DESDE RAM + VERIFICACIÓN INDEXADA DE REFERENCIA (~40ms)
        const [settingsRaw, metodoPagoDB, ordenConMismaRef, productoDBPre] = await Promise.all([
            obtenerSettingsCheckoutRAM(false),
            obtenerMetodoPagoCheckoutRAM(paymentMethodKey),
            (paymentMethodKey !== 'tokems_kz' && refLimpia.length >= 4)
                ? Order.findOne({
                    paymentReference: refLimpia,
                    fecha: { $gte: hace48Horas },
                    status: { $ne: 'RECHAZADO' }
                }).select('orderId productName').lean()
                : Promise.resolve(null),
            esOrdenProductoNormal
                ? (paymentMethodKey === 'tokems_kz'
                    ? CatalogProduct.findOne({ slug: slugBuscado })
                        .select('-cardImageUrl -flyerImageUrl -infoImageUrl -packages.imageUrl -altPackages.imageUrl -packages.targetSchemaCache -altPackages.targetSchemaCache')
                    : obtenerProductoCheckoutRAM(slugBuscado))
                : Promise.resolve(null)
        ]);

        const settings = settingsRaw || { exchangeRateVES: 1012.00, bcvRateVES: 889.25, tokemValueUSD: 1.00, storeOpen: true, autoTriggerApiOnTokems: true };
        if (settings.storeOpen === false) {
            return res.status(403).json({ error: 'La tienda está en mantenimiento temporal. Intenta en unos minutos.' });
        }

        const metodoPago = metodoPagoDB || {
            methodKey: paymentMethodKey || 'pago_movil',
            name: paymentMethodNameCustom || 'Pago Verificable',
            requiresReference: paymentMethodKey !== 'tokems_kz',
            refDigitsLength: 6
        };

        if (metodoPago.requiresReference && refLimpia.length < 4) {
            return res.status(400).json({ error: 'Debes ingresar los últimos dígitos de la referencia o ID de transacción.' });
        }

        let esRefDuplicada = false;
        let textoAlertaDuplicada = '';
        if (metodoPago.requiresReference && ordenConMismaRef) {
            esRefDuplicada = true;
            textoAlertaDuplicada = `⚠️ ALERTA: La referencia "${refLimpia}" ya fue usada en la orden #${ordenConMismaRef.orderId} (${ordenConMismaRef.productName}). Verifica tu banco con cuidado.`;
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
        let productoDB = productoDBPre;
        let estadoAlgoritmoInicial = null;

        if (orderType === 'TOKEM_TOPUP') {
            const cantTokems = Math.max(1, Number(customTokemAmount) || 1);
            nombreProducto = 'Recarga de Billetera Tokems KZ';
            nombrePaquete = `${cantTokems} Tokem(s) KZ 🪙`;
            fulfillment = 'TOKEM_WALLET_CREDIT';
            baseUSD = Number((cantTokems * (settings.tokemValueUSD || 1)).toFixed(2));
            costoEnTokems = cantTokems;
        } else if (slugBuscado === 'calculadora-steam') {
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
            const catalogCacheUsar = _ramCentralOneCatalogCache.length > 0 ? _ramCentralOneCatalogCache : null;

            const planTarjetas = calcularCombinacionListaJuegosSeparadosSteam(
                validGames,
                settings.arbitrageBaseCards || [],
                catalogCacheUsar
            );

            if (!planTarjetas || !planTarjetas.hasSolution) {
                return res.status(400).json({
                    error: (planTarjetas && planTarjetas.reason) || `Por el momento no hay combinación de tarjetas en stock para cubrir los juegos solicitados.`
                });
            }

            const costoTarjetasTotal = Number(planTarjetas.totalCostUSD);
            const itemsCalc = validGames.map((it, idx) => {
                const planIndiv = (planTarjetas.perGamePlans && planTarjetas.perGamePlans[idx]?.planIndiv)
                    ? planTarjetas.perGamePlans[idx].planIndiv
                    : calcularMejorCombinacionTarjetasPool(
                        it.usdR,
                        'steam',
                        settings.arbitrageBaseCards || [],
                        catalogCacheUsar
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
            nombrePaquete = `${resumenJuegosTxt} ➔ Recibes $${Number(planTarjetas.totalClientUSD).toFixed(2)} USD en Steam`;
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
                gamesTargetsUSD: validGames.map(g => ({ label: g.label, usdR: g.usdR })),
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
                 String(of.linkedPackageId || '').trim() === idPkgBuscado ||
                 (nombrePkgBuscado && String(of.title || '').trim().toLowerCase() === nombrePkgBuscado))
            );

            if (ofertaMatch) {
                const vencioPorTiempo = Boolean(ofertaMatch.expiresAt && new Date(ofertaMatch.expiresAt).getTime() <= Date.now());
                const estaActivaOferta = ofertaMatch.active !== false && !vencioPorTiempo;

                if (!estaActivaOferta) {
                    if (!pkg) {
                        return res.status(400).json({
                            error: '⏰ El tiempo de esta oferta relámpago ya finalizó o fue desactivada.'
                        });
                    }
                } else {
                    if (!pkg && ofertaMatch.linkedPackageId) {
                        pkg = listaPaquetesActiva.find(p => String(p.packageId || p.id || '').trim() === String(ofertaMatch.linkedPackageId).trim());
                    }
                    const bovedaOferta = Array.isArray(ofertaMatch.backupPinVault) && ofertaMatch.backupPinVault.length > 0
                        ? ofertaMatch.backupPinVault
                        : (pkg && Array.isArray(pkg.backupPinVault) ? pkg.backupPinVault : []);

                    pkg = {
                        ...(pkg ? (pkg.toObject ? pkg.toObject() : pkg) : {}),
                        packageId: (pkg && pkg.packageId) || ofertaMatch.linkedPackageId || ofertaMatch.pkgId || idPkgBuscado,
                        name: ofertaMatch.title || (pkg ? pkg.name : 'Paquete en Oferta'),
                        priceUSD: Number(ofertaMatch.usd),
                        costUSD: Number(ofertaMatch.costUSD || (pkg ? pkg.costUSD : 0) || 0),
                        tokemsPrice: Number(ofertaMatch.tokemsPrice || ofertaMatch.usd),
                        apiProviderName: (pkg && pkg.apiProviderName) || 'CENTRAL_ONE',
                        apiProductSku: ofertaMatch.apiProductSku || (pkg ? pkg.apiProductSku : '') || ofertaMatch.pkgId,
                        centralOneProductId: ofertaMatch.centralOneProductId || (pkg ? pkg.centralOneProductId : '') || '',
                        useSmartAlgorithm: Boolean((pkg && pkg.useSmartAlgorithm) || productoDB.isSmartCodeProduct),
                        targetClientUSD: Number((pkg && pkg.targetClientUSD) || 0),
                        isGiftCardPin: ofertaMatch.isGiftCardPin !== undefined ? Boolean(ofertaMatch.isGiftCardPin) : Boolean(pkg && pkg.isGiftCardPin),
                        backupPinVault: bovedaOferta,
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

            new Transaction({
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

        if (pagadoConTokems && settings.autoTriggerApiOnTokems !== false && fulfillment !== 'MANUAL_INTERNAL') {
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

// 📡 3. CONSULTA EN VIVO DE LA BARRA DE PROGRESO + AUTO-FUSIÓN BLINDADA DE STOCK PROPIO Y CENTRAL ONE
const _lastLiveStatusCoCheckMap = new Map();

// 🛡️ Auto-Curador Global en Order.prototype.save: Garantiza que ningún código reservado de Stock Propio (ownStockCodesReserved) pueda quedar fuera de deliveredCode al pasar a ENTREGADO
if (!Order.prototype._kzOwnStockMergeHooked) {
    Order.prototype._kzOwnStockMergeHooked = true;
    const _prevSaveMerge = Order.prototype.save;
    Order.prototype.save = async function(...args) {
        try {
            const algoSt = this.algoExecutionState;
            if (algoSt && Array.isArray(algoSt.ownStockCodesReserved) && algoSt.ownStockCodesReserved.length > 0) {
                const reservados = algoSt.ownStockCodesReserved.filter(Boolean);
                const listaActual = Array.isArray(algoSt.deliveredCodesList) ? algoSt.deliveredCodesList : [];
                const vistosList = new Set();
                const fusionLista = [];

                [...reservados, ...listaActual].forEach(c => {
                    const rk = extraerCodigoCrudoDeTextoFormateado(c);
                    if (rk && !vistosList.has(rk)) {
                        vistosList.add(rk);
                        fusionLista.push(c);
                    }
                });

                algoSt.deliveredCodesList = fusionLista;
                algoSt.deliveredCardsCount = fusionLista.length;
                this.algoExecutionState = algoSt;
                this.markModified('algoExecutionState');

                if (this.status === 'ENTREGADO' && this.deliveredCode) {
                    const partesEntregadas = String(this.deliveredCode)
                        .split(/\s*\|\s*|\r?\n/)
                        .map(s => s.trim())
                        .filter(Boolean);

                    const vistosDeliv = new Set();
                    const fusionEntregados = [];

                    [...reservados, ...partesEntregadas].forEach(c => {
                        const rk = extraerCodigoCrudoDeTextoFormateado(c);
                        if (rk && !vistosDeliv.has(rk)) {
                            vistosDeliv.add(rk);
                            fusionEntregados.push(c);
                        }
                    });

                    if (fusionEntregados.length > 0) {
                        this.deliveredCode = fusionEntregados.join('  |  ');
                    }
                }
            }
        } catch (e) {}
        return _prevSaveMerge.apply(this, args);
    };
}

app.get('/api/orders/live-status/:orderId', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    try {
        const idLimpio = req.params.orderId.trim().toUpperCase();
        const orden = await Order.findOne({ orderId: idLimpio }).select('-internalAccountLogin.accountPass -costUSD').lean();
        if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });

        // ⚡ Si la orden está en EJECUTANDO_API y no está bloqueada en medio de una creación, verifica en vivo contra Central One
        if (
            orden.status === 'EJECUTANDO_API' &&
            orden.apiOrderId &&
            !orden.apiOrderId.startsWith('VAULT-') &&
            !orden.apiOrderId.startsWith('INTERNAL-') &&
            !orden.apiOrderId.startsWith('API-') &&
            !orden.apiOrderId.startsWith('kz-ord-') &&
            !activeOrderProcessingLocks.has(idLimpio) &&
            !(typeof activeWorkerApprovalLocks !== 'undefined' && activeWorkerApprovalLocks.has(idLimpio))
        ) {
            const lastCheck = _lastLiveStatusCoCheckMap.get(idLimpio) || 0;
            if (Date.now() - lastCheck > 2000) {
                _lastLiveStatusCoCheckMap.set(idLimpio, Date.now());
                const headersCO = obtenerHeadersCentralOne();
                if (headersCO) {
                    try {
                        const settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('arbitrageBaseCards').lean();
                        const poolCards = settingsDoc ? (settingsDoc.arbitrageBaseCards || []) : [];
                        const algoSt = orden.algoExecutionState || null;
                        const esSteamOrd = String(orden.productSlug || '').toLowerCase().includes('steam') || String(algoSt?.platformGroup || '').toLowerCase() === 'steam';
                        const check = await verificarYExtraerEntregaCentralOne(orden.apiOrderId, headersCO, poolCards, esSteamOrd, 0, algoSt);

                        if (check.state === 'COMPLETED') {
                            // Unir SIEMPRE los códigos reservados de Stock Propio + los entregados previamente + los nuevos de Central One
                            const codigosPrevios = [
                                ...((algoSt && Array.isArray(algoSt.ownStockCodesReserved)) ? algoSt.ownStockCodesReserved : []),
                                ...((algoSt && Array.isArray(algoSt.deliveredCodesList)) ? algoSt.deliveredCodesList : [])
                            ];
                            const vistosRaw = new Set();
                            const todosLosCodigos = [];

                            codigosPrevios.forEach(cPrev => {
                                const rk = extraerCodigoCrudoDeTextoFormateado(cPrev);
                                if (rk && !vistosRaw.has(rk)) {
                                    vistosRaw.add(rk);
                                    todosLosCodigos.push(cPrev);
                                }
                            });

                            for (const nuevoCod of (check.codigosPlanos || [])) {
                                const rk = extraerCodigoCrudoDeTextoFormateado(nuevoCod);
                                if (rk && !vistosRaw.has(rk)) {
                                    vistosRaw.add(rk);
                                    todosLosCodigos.push(nuevoCod);
                                }
                            }

                            const maxCards = (algoSt && Number(algoSt.totalCardsExpected) > 0) ? Number(algoSt.totalCardsExpected) : todosLosCodigos.length;
                            const codigosCliente = todosLosCodigos.slice(0, maxCards);
                            const textoFinal = codigosCliente.length > 0 ? codigosCliente.join('  |  ') : check.deliveredCode;

                            const nuevoAlgoSt = algoSt ? {
                                ...algoSt,
                                deliveredCodesList: codigosCliente,
                                deliveredCardsCount: codigosCliente.length
                            } : null;

                            const ordenActualizada = await Order.findOneAndUpdate(
                                { orderId: idLimpio },
                                {
                                    $set: {
                                        status: 'ENTREGADO',
                                        progressPercent: 100,
                                        deliveredCode: textoFinal,
                                        statusMessage: '¡Tu pedido ha sido entregado automáticamente con éxito!',
                                        completedAt: new Date(),
                                        ...(nuevoAlgoSt ? { algoExecutionState: nuevoAlgoSt } : {})
                                    }
                                },
                                { new: true }
                            ).select('-internalAccountLogin.accountPass -costUSD').lean();

                            if (activeCentralOnePollers.has(idLimpio)) {
                                clearTimeout(activeCentralOnePollers.get(idLimpio));
                                activeCentralOnePollers.delete(idLimpio);
                            }
                            if (typeof invalidarCacheColaTrabajadorRAM === 'function') {
                                invalidarCacheColaTrabajadorRAM();
                            }

                            if (ordenActualizada) {
                                return res.json({ success: true, order: ordenActualizada });
                            }
                        } else if (check.state === 'PARTIAL_REFUNDED' || check.state === 'FAILED') {
                            programarSeguimientoOrdenCentralOne(idLimpio, orden.apiOrderId, null, null, true);
                        }
                    } catch (eLive) {}
                }
            }
        }

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

const zlib = require('zlib');
let _lastWorkerQueueCoSyncMs = 0;
let _ramQueueAllOrdersCache = null;
let _ramQueueAllOrdersTs = 0;
let _ramFastQueueOrdersCache = null;
let _ramFastQueueOrdersTs = 0;
let _ramQueueAllTicketsCache = null;
let _ramQueueAllTicketsTs = 0;
let _ramQueueMutationCounter = 1;
let _ramBootstrapMutationCounter = 1;
const _ramRecentDeletedOrderIds = new Set();

function invalidarCacheColaTrabajadorRAM() {
    _ramQueueAllOrdersCache = null;
    _ramQueueAllOrdersTs = 0;
    _ramFastQueueOrdersCache = null;
    _ramFastQueueOrdersTs = 0;
    _ramQueueAllTicketsCache = null;
    _ramQueueAllTicketsTs = 0;
    _ramQueueMutationCounter++;
}

function invalidarCacheTiendaBootstrapRAM() {
    _ramBootstrapPayload = null;
    _ramBootstrapTs = 0;
    if (typeof _ramFastSettingsTs !== 'undefined') _ramFastSettingsTs = 0;
    if (typeof _ramFastProductsTs !== 'undefined') _ramFastProductsTs = 0;
    if (typeof _ramFastPaymentMethodsTs !== 'undefined') _ramFastPaymentMethodsTs = 0;
    _ramBootstrapMutationCounter++;
}

// Inyecta o actualiza en 0ms cualquier orden recién creada/modificada directamente en la caché RAM de la cola
function inyectarOrdenEnRamQueueCache(doc) {
    try {
        _ramQueueMutationCounter++;
        _ramQueueAllOrdersCache = null;
        _ramQueueAllOrdersTs = 0;

        if (!doc || !doc.orderId) {
            _ramFastQueueOrdersCache = null;
            _ramFastQueueOrdersTs = 0;
            return;
        }

        const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
        const idUp = String(obj.orderId || '').trim().toUpperCase();
        if (!idUp || _ramRecentDeletedOrderIds.has(idUp)) return;

        // Ocultar checkouts de Binance que aún no han sido pagados
        if (obj.status === 'INICIANDO' && obj.isWaitingBinanceAuto) return;

        delete obj.costUSD;
        delete obj.apiRawResponse;
        if (obj.internalAccountLogin) delete obj.internalAccountLogin.accountPass;
        if (obj.algoExecutionState) {
            delete obj.algoExecutionState.pendingReplacementBody;
            delete obj.algoExecutionState.perGamePlans;
        }

        if (Array.isArray(_ramFastQueueOrdersCache)) {
            const idx = _ramFastQueueOrdersCache.findIndex(o => String(o.orderId || '').trim().toUpperCase() === idUp);
            if (idx !== -1) {
                _ramFastQueueOrdersCache[idx] = { ..._ramFastQueueOrdersCache[idx], ...obj, orderId: idUp };
            } else {
                _ramFastQueueOrdersCache.unshift({ ...obj, orderId: idUp });
            }
        }
    } catch (e) {
        _ramFastQueueOrdersCache = null;
        _ramFastQueueOrdersTs = 0;
    }
}

// 1. Compresor Gzip Nativo + Invalidación Global en 0ms al Crear/Modificar Órdenes en Cualquier Ruta
if (!app.response._kzBandwidthOptimizerInstalled) {
    app.response._kzBandwidthOptimizerInstalled = true;
    const _origExpressJson = app.response.json;

    app.response.json = function(body) {
        const req = this.req;
        try {
            if (req && req.method === 'POST') {
                const p = req.path || '';
                if (p === '/api/worker/delete-order' && req.body?.orderId) {
                    const idDel = String(req.body.orderId).trim().toUpperCase();
                    _ramRecentDeletedOrderIds.add(idDel);
                    if (_ramRecentDeletedOrderIds.size > 200) {
                        const first = _ramRecentDeletedOrderIds.values().next().value;
                        _ramRecentDeletedOrderIds.delete(first);
                    }
                    invalidarCacheColaTrabajadorRAM();
                } else if (
                    p.startsWith('/api/orders/') ||
                    p.startsWith('/api/worker/') ||
                    p.startsWith('/api/tickets/') ||
                    p.startsWith('/api/binance-pay/') ||
                    p.startsWith('/webhooks/')
                ) {
                    if (body && body.order && body.order.orderId) {
                        inyectarOrdenEnRamQueueCache(body.order);
                    } else {
                        invalidarCacheColaTrabajadorRAM();
                    }
                }
                if (
                    p.startsWith('/api/admin/') ||
                    p === '/api/worker/schedule-config' ||
                    p.startsWith('/webhooks/central-one')
                ) {
                    invalidarCacheTiendaBootstrapRAM();
                }
            }

            if (req && req.path === '/api/store/bootstrap' && body && body.success && Array.isArray(body.products)) {
                const verTienda = `bv_${_ramBootstrapMutationCounter}_${body.products.length}_${body.settings?.exchangeRateVES || 0}_${body.settings?.bcvRateVES || 0}_${body.settings?.storeOpen === false ? 0 : 1}`;
                body.version = verTienda;
                const clientVer = String(req.query?.knownVersion || '').trim();
                if (clientVer && clientVer === verTienda) {
                    return _origExpressJson.call(this, {
                        success: true,
                        notModified: true,
                        version: verTienda,
                        serverTimestamp: Date.now()
                    });
                }
            }

            const acceptEncoding = String(req?.headers?.['accept-encoding'] || '');
            if (acceptEncoding.includes('gzip') && body && typeof body === 'object' && !this.headersSent) {
                const jsonStr = JSON.stringify(body);
                if (jsonStr.length > 1200) {
                    const gzBuf = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'), { level: 6 });
                    this.set('Content-Type', 'application/json; charset=utf-8');
                    this.set('Content-Encoding', 'gzip');
                    this.set('Vary', 'Accept-Encoding');
                    this.set('Content-Length', String(gzBuf.length));
                    return this.send(gzBuf);
                }
            }
        } catch (e) {}
        return _origExpressJson.call(this, body);
    };
}

if (!Order.prototype._kzQueueCacheHooked) {
    Order.prototype._kzQueueCacheHooked = true;
    const _prevOrdSave = Order.prototype.save;
    Order.prototype.save = async function(...args) {
        const r = await _prevOrdSave.apply(this, args);
        inyectarOrdenEnRamQueueCache(r || this);
        return r;
    };
}

if (!SupportTicket.prototype._kzQueueCacheHooked) {
    SupportTicket.prototype._kzQueueCacheHooked = true;
    const _prevTkSave = SupportTicket.prototype.save;
    SupportTicket.prototype.save = async function(...args) {
        const r = await _prevTkSave.apply(this, args);
        _ramQueueAllTicketsCache = null;
        _ramQueueAllTicketsTs = 0;
        _ramQueueMutationCounter++;
        return r;
    };
}

app.get('/api/worker/queue', verificarTrabajadorOAdmin, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
        const { statusFilter, knownVersion, fastPoll, fullHistory } = req.query;
        const esModoRapido = (fastPoll === '1' && fullHistory !== '1');
        const workerEmail = (req.staffUser.email || '').trim().toLowerCase();
        const isOwner = req.effectiveRole === 'admin';
        const ahoraMs = Date.now();

        const fuenteEnMemoria = _ramFastQueueOrdersCache || _ramQueueAllOrdersCache || [];
        const hayEnEjecucionEnCache = Array.isArray(fuenteEnMemoria) && fuenteEnMemoria.some(o => o.status === 'EJECUTANDO_API');
        const intervaloCoCheck = hayEnEjecucionEnCache ? 2500 : 10000;

        if (ahoraMs - _lastWorkerQueueCoSyncMs > intervaloCoCheck) {
            _lastWorkerQueueCoSyncMs = ahoraMs;
            setImmediate(async () => {
                try {
                    const enEjecucion = await Order.find({ status: 'EJECUTANDO_API' }).limit(10);
                    if (enEjecucion.length === 0) return;

                    const headersCO = obtenerHeadersCentralOne();
                    const settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('arbitrageBaseCards').lean();
                    const poolCards = settingsDoc ? (settingsDoc.arbitrageBaseCards || []) : [];

                    for (const ordExec of enEjecucion) {
                        if (activeOrderProcessingLocks.has(ordExec.orderId)) continue;
                        const algoSt = ordExec.algoExecutionState || null;
                        const codigosGuardados = [
                            ...((algoSt && Array.isArray(algoSt.ownStockCodesReserved)) ? algoSt.ownStockCodesReserved : []),
                            ...((algoSt && Array.isArray(algoSt.deliveredCodesList)) ? algoSt.deliveredCodesList : [])
                        ];

                        if (ordExec.deliveredCode || (algoSt && Number(algoSt.totalCardsExpected) > 0 && codigosGuardados.length >= Number(algoSt.totalCardsExpected))) {
                            ordExec.status = 'ENTREGADO';
                            ordExec.progressPercent = 100;
                            if (!ordExec.deliveredCode && codigosGuardados.length > 0) {
                                ordExec.deliveredCode = Array.from(new Set(codigosGuardados)).join('  |  ');
                            }
                            ordExec.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                            ordExec.completedAt = ordExec.completedAt || new Date();
                            await ordExec.save();
                            continue;
                        }

                        if (headersCO && ordExec.apiOrderId && !ordExec.apiOrderId.startsWith('VAULT-') && !ordExec.apiOrderId.startsWith('INTERNAL-') && !ordExec.apiOrderId.startsWith('API-') && !ordExec.apiOrderId.startsWith('kz-ord-')) {
                            try {
                                const esSteamOrd = String(ordExec.productSlug || '').toLowerCase().includes('steam') || String(algoSt?.platformGroup || '').toLowerCase() === 'steam';
                                const check = await verificarYExtraerEntregaCentralOne(ordExec.apiOrderId, headersCO, poolCards, esSteamOrd, 0, algoSt);

                                if (check.state === 'COMPLETED') {
                                    const vistosRaw = new Set();
                                    const todos = [];
                                    [...codigosGuardados, ...(check.codigosPlanos || [])].forEach(c => {
                                        const rk = extraerCodigoCrudoDeTextoFormateado(c);
                                        if (rk && !vistosRaw.has(rk)) {
                                            vistosRaw.add(rk);
                                            todos.push(c);
                                        }
                                    });
                                    ordExec.status = 'ENTREGADO';
                                    ordExec.progressPercent = 100;
                                    ordExec.deliveredCode = todos.length > 0 ? todos.join('  |  ') : check.deliveredCode;
                                    ordExec.statusMessage = '¡Tu pedido ha sido entregado automáticamente con éxito!';
                                    ordExec.completedAt = new Date();
                                    if (algoSt) {
                                        algoSt.deliveredCodesList = todos;
                                        algoSt.deliveredCardsCount = todos.length;
                                        ordExec.algoExecutionState = algoSt;
                                        ordExec.markModified('algoExecutionState');
                                    }
                                    await ordExec.save();
                                } else if (check.state === 'PROCESSING') {
                                    if (!activeCentralOnePollers.has(ordExec.orderId)) {
                                        programarSeguimientoOrdenCentralOne(ordExec.orderId, ordExec.apiOrderId);
                                    }
                                } else if (check.state === 'FAILED' || check.state === 'PARTIAL_REFUNDED') {
                                    if (algoSt && algoSt.isAlgorithmOrder) {
                                        if (!activeCentralOnePollers.has(ordExec.orderId)) {
                                            programarSeguimientoOrdenCentralOne(ordExec.orderId, ordExec.apiOrderId);
                                        }
                                    } else {
                                        ordExec.status = 'ERROR_API';
                                        ordExec.statusMessage = 'Pago verificado. El proveedor reportó una demora en el servidor del juego; un operador reintentará tu entrega.';
                                        ordExec.workerNotes = `⚠️ Central One reembolsó/canceló el intento (${check.failureCode || 'fallo'}): ${check.errorMsg || 'Puedes reintentar el envío.'}`;
                                        ordExec.apiOrderId = '';
                                        await ordExec.save();
                                    }
                                }
                            } catch (eCheck) {}
                        }
                    }
                } catch (eBg) {}
            });
        }

        if (!global._ramWorkersListCache || (ahoraMs - (global._ramWorkersListTs || 0) > 60000)) {
            global._ramWorkersListCache = await User.find({ role: { $in: ['worker', 'admin'] } }).select('email accountName role tokems').lean();
            global._ramWorkersListTs = ahoraMs;
        }

        const projectionCola = '-costUSD -apiRawResponse -internalAccountLogin.accountPass -algoExecutionState.pendingReplacementBody -algoExecutionState.perGamePlans';

        if (!_ramQueueAllTicketsCache || (ahoraMs - _ramQueueAllTicketsTs > 3500)) {
            _ramQueueAllTicketsCache = await SupportTicket.find({})
                .sort({ updatedAt: -1 })
                .limit(100)
                .select('-messages.attachmentUrl')
                .lean() || [];
            _ramQueueAllTicketsTs = ahoraMs;
        }

        let listaBaseOrdenes = [];

        if (esModoRapido) {
            // 🚀 MODO FAST-POLL (~15ms): Todas las órdenes activas + las últimas 120 cerradas (~15 KB en vez de 5,000 órdenes)
            if (!_ramFastQueueOrdersCache || (ahoraMs - _ramFastQueueOrdersTs > 2000)) {
                const [activas, recientesCerradas] = await Promise.all([
                    Order.find({
                        status: { $in: ['EN_PROCESO', 'EN_REVISION', 'EJECUTANDO_API', 'ERROR_API'] },
                        isWaitingBinanceAuto: { $ne: true }
                    }).sort({ fecha: -1 }).limit(150).select(projectionCola).lean(),
                    Order.find({
                        status: { $in: ['ENTREGADO', 'RECHAZADO'] }
                    }).sort({ fecha: -1 }).limit(120).select(projectionCola).lean()
                ]);

                const mapaUnico = new Map();
                [...(activas || []), ...(recientesCerradas || [])].forEach(o => {
                    if (o && o.orderId) mapaUnico.set(o.orderId, o);
                });
                _ramFastQueueOrdersCache = Array.from(mapaUnico.values()).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
                _ramFastQueueOrdersTs = ahoraMs;
            }
            listaBaseOrdenes = _ramFastQueueOrdersCache;
        } else {
            // 📚 MODO HISTORIAL PROFUNDO (Se carga 1 sola vez en segundo plano, tope ágil de 600 órdenes = 40 páginas)
            if (!_ramQueueAllOrdersCache || (ahoraMs - _ramQueueAllOrdersTs > 10000)) {
                _ramQueueAllOrdersCache = await Order.find({
                    $nor: [{ status: 'INICIANDO', isWaitingBinanceAuto: true }]
                })
                .sort({ fecha: -1 })
                .limit(600)
                .select(projectionCola)
                .lean() || [];
                _ramQueueAllOrdersTs = ahoraMs;
            }
            listaBaseOrdenes = _ramQueueAllOrdersCache;
        }

        const pendientesSinApartarCount = listaBaseOrdenes.filter(o =>
            o.status === 'EN_PROCESO' &&
            !o.isWaitingBinanceAuto &&
            !o.claimedByWorker
        ).length;

        const firmaTop35 = listaBaseOrdenes.slice(0, 35).map(o =>
            `${o.orderId}:${o.status}:${o.claimedByWorker || ''}:${(o.deliveredCode || '').length}`
        ).join('|');
        const topTk = _ramQueueAllTicketsCache[0];
        const versionActualCola = `qv_${esModoRapido ? 'F' : 'H'}_${_ramQueueMutationCounter}_${listaBaseOrdenes.length}_${pendientesSinApartarCount}_${firmaTop35}_${_ramQueueAllTicketsCache.length}_${topTk ? `${topTk.ticketId}:${topTk.status}:${(topTk.messages || []).length}` : '0'}`;

        if (knownVersion && String(knownVersion).trim() === versionActualCola) {
            return res.json({
                success: true,
                notModified: true,
                version: versionActualCola,
                pendientesCount: pendientesSinApartarCount
            });
        }

        let orders = listaBaseOrdenes;
        if (statusFilter && statusFilter !== 'TODAS') {
            orders = orders.filter(o => o.status === statusFilter);
        }

        if (!isOwner) {
            orders = orders.filter(o => {
                const claimed = String(o.claimedByWorker || '').trim().toLowerCase();
                const approved = String(o.approvedByWorker || '').trim().toLowerCase();
                const reviewed = String(o.reviewedByWorker || '').trim().toLowerCase();
                const esSinApartarActiva = (o.status === 'EN_PROCESO' || o.status === 'ERROR_API' || o.status === 'EJECUTANDO_API') && !claimed;
                return esSinApartarActiva || claimed === workerEmail || approved === workerEmail || reviewed === workerEmail;
            });
        }

        let ticketsAbiertos = _ramQueueAllTicketsCache;
        if (!isOwner) {
            ticketsAbiertos = ticketsAbiertos.filter(t => {
                const assigned = String(t.assignedWorker || '').trim().toLowerCase();
                return (t.status === 'ABIERTO' && !assigned) || assigned === workerEmail;
            });
        }

        return res.json({
            success: true,
            isFullHistory: !esModoRapido,
            version: versionActualCola,
            workerEmail,
            workerName: req.staffUser.accountName || workerEmail.split('@')[0],
            role: req.effectiveRole,
            pendientesCount: pendientesSinApartarCount,
            deletedOrderIds: Array.from(_ramRecentDeletedOrderIds),
            orders,
            tickets: ticketsAbiertos,
            workersList: isOwner ? (global._ramWorkersListCache || []) : []
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error cargando cola de trabajo.' });
    }
});

// 📌 1.5 APARTAR, LIBERAR O TOMAR CONTROL DE UNA ORDEN (RESPETA SI EL DUEÑO APARTA DESDE LA COLA DE UN EMPLEADO)
app.post('/api/worker/claim-order', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { orderId, action, targetOperatorEmail } = req.body; // 'CLAIM' | 'RELEASE' | 'FORCE_TAKE'
        if (!orderId || !action) return res.status(400).json({ error: 'Faltan parámetros.' });

        const idLimpio = String(orderId).trim().toUpperCase();
        const staffEmail = (req.staffUser.email || '').trim().toLowerCase();
        const staffName = req.staffUser.accountName || staffEmail.split('@')[0];
        const isOwner = req.effectiveRole === 'admin';

        const targetOpClean = String(targetOperatorEmail || '').trim().toLowerCase();
        const emailAsignar = (isOwner && targetOpClean && targetOpClean.includes('@')) ? targetOpClean : staffEmail;
        const nombreAsignar = emailAsignar === staffEmail ? staffName : emailAsignar.split('@')[0];

        if (action === 'CLAIM') {
            const ordenApartada = await Order.findOneAndUpdate(
                {
                    orderId: idLimpio,
                    $or: [
                        { claimedByWorker: '' },
                        { claimedByWorker: null },
                        { claimedByWorker: { $exists: false } },
                        { claimedByWorker: emailAsignar },
                        ...(isOwner ? [{ claimedByWorker: { $exists: true } }] : [])
                    ]
                },
                {
                    $set: {
                        claimedByWorker: emailAsignar,
                        claimedByName: nombreAsignar,
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
                message: `Orden #${idLimpio} apartada en la cola de ${nombreAsignar}.`,
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
                message: `Has movido la orden #${idLimpio} a tu cola personal.`,
                order: ordenTomada
            });
        }

        return res.status(400).json({ error: 'Acción de apartado inválida.' });
    } catch (error) {
        console.error('Error en /api/worker/claim-order:', error);
        return res.status(500).json({ error: 'Error al procesar el apartado de la orden.' });
    }
});

// 🔒 Candado en RAM para impedir que 2 clics seguidos de "Aprobar" disparen dos veces el pedido en Central One
const activeWorkerApprovalLocks = new Set();

// 2. Acción del Trabajador/Dueño: APROBAR, REVISIÓN o RECHAZAR (Mantiene la orden en el empleado correspondiente si es de un empleado)
app.post('/api/worker/process-order', verificarTrabajadorOAdmin, async (req, res) => {
    const idLock = String(req.body?.orderId || '').trim().toUpperCase();
    if (!idLock || !req.body?.action) return res.status(400).json({ error: 'Faltan parámetros.' });

    if (req.body.action === 'APROBAR' && activeWorkerApprovalLocks.has(idLock)) {
        const ordEnCurso = await Order.findOne({ orderId: idLock });
        return res.json({
            success: true,
            alreadyProcessing: true,
            message: `🔒 La orden #${idLock} ya se está enviando al proveedor en este instante. No hace falta volver a darle.`,
            order: ordEnCurso
        });
    }

    if (req.body.action === 'APROBAR') {
        activeWorkerApprovalLocks.add(idLock);
    }

    try {
        const { orderId, action, manualPinCode, workerNotes, targetOperatorEmail } = req.body;
        const orden = await Order.findOne({ orderId: idLock });
        if (!orden) return res.status(404).json({ error: 'Orden no encontrada.' });

        const staffEmail = (req.staffUser.email || '').trim().toLowerCase();
        const staffName = req.staffUser.accountName || staffEmail.split('@')[0];
        const isOwner = req.effectiveRole === 'admin';

        if (!isOwner && orden.claimedByWorker && orden.claimedByWorker !== staffEmail) {
            return res.status(403).json({
                error: `Esta orden está apartada privadamente por ${orden.claimedByName || orden.claimedByWorker}.`
            });
        }

        // 🎯 DETERMINAR PROPIETARIO DE LA ORDEN:
        // Si la orden fue apartada por un empleado (o si el Dueño la está procesando dentro del apartado del empleado), se queda en el empleado
        const targetOpClean = String(targetOperatorEmail || '').trim().toLowerCase();
        const claimedExistente = String(orden.claimedByWorker || '').trim().toLowerCase();
        const reviewedExistente = String(orden.reviewedByWorker || '').trim().toLowerCase();
        const approvedExistente = String(orden.approvedByWorker || '').trim().toLowerCase();

        let operadorPropietario = staffEmail;
        if (claimedExistente && claimedExistente !== staffEmail) {
            operadorPropietario = claimedExistente;
        } else if (isOwner && targetOpClean && targetOpClean.includes('@') && targetOpClean !== staffEmail) {
            operadorPropietario = targetOpClean;
        } else if (reviewedExistente && reviewedExistente !== staffEmail) {
            operadorPropietario = reviewedExistente;
        } else if (approvedExistente && !approvedExistente.startsWith('auto-') && approvedExistente !== staffEmail) {
            operadorPropietario = approvedExistente;
        }

        const nombrePropietario = operadorPropietario === staffEmail
            ? staffName
            : (orden.claimedByName || operadorPropietario.split('@')[0]);

        if (!orden.claimedByWorker) {
            orden.claimedByWorker = operadorPropietario;
            orden.claimedByName = nombrePropietario;
            orden.claimedAt = new Date();
        }

        if (action === 'APROBAR') {
            // 1. Si la orden YA estaba ENTREGADA, solo actualizar Nota o PIN manual sin volver a llamar a la API
            if (orden.status === 'ENTREGADO') {
                if (manualPinCode && manualPinCode.trim()) {
                    orden.deliveredCode = manualPinCode.trim();
                }
                if (workerNotes !== undefined) {
                    orden.workerNotes = String(workerNotes || '').trim();
                }
                orden.approvedByWorker = operadorPropietario;
                await orden.save();
                return res.json({
                    success: true,
                    message: `Nota/PIN de la orden #${orden.orderId} actualizados sin volver a cobrar en API.`,
                    order: orden
                });
            }

            // 2. Si el operador ingresó un código manual escrito a mano, entregar de inmediato al cliente y dejar vigilando el código pendiente de Central One para guardarlo en Stock Propio
            if (manualPinCode && manualPinCode.trim()) {
                const habiaOrdenEnCentralOne = Boolean(
                    orden.apiOrderId &&
                    !orden.apiOrderId.startsWith('MANUAL-') &&
                    !orden.apiOrderId.startsWith('VAULT-') &&
                    !orden.apiOrderId.startsWith('INTERNAL-') &&
                    !orden.apiOrderId.startsWith('API-')
                );

                orden.status = 'ENTREGADO';
                orden.progressPercent = 100;
                orden.deliveredCode = manualPinCode.trim();
                if (!orden.apiOrderId) {
                    orden.apiOrderId = 'MANUAL-STAFF-' + Date.now();
                }
                if (workerNotes) orden.workerNotes = workerNotes.trim();
                orden.statusMessage = orden.fulfillmentType === 'API_GIFT_CARD' || orden.isGiftCardPin
                    ? '¡Entrega completada! Cópiala aquí abajo.'
                    : '¡Pedido entregado con éxito! Verifica tu cuenta.';
                orden.approvedByWorker = operadorPropietario;
                orden.completedAt = new Date();

                if (habiaOrdenEnCentralOne) {
                    const stAlgo = orden.algoExecutionState || {};
                    stAlgo.manuallyCompletedWhilePendingCO = true;
                    stAlgo.coLateCodesRecovered = false;
                    orden.algoExecutionState = stAlgo;
                    orden.markModified('algoExecutionState');
                }

                await orden.save();

                if (habiaOrdenEnCentralOne) {
                    const coIdVigilar = orden.apiOrderId.startsWith('kz-ord-') ? null : orden.apiOrderId;
                    const idempVigilar = orden.apiOrderId.startsWith('kz-ord-') ? orden.apiOrderId : (orden.algoExecutionState?.pendingReplacementIdempKey || null);
                    programarSeguimientoOrdenCentralOne(orden.orderId, coIdVigilar, idempVigilar, orden.algoExecutionState?.pendingReplacementBody || null);
                }

                return res.json({
                    success: true,
                    message: habiaOrdenEnCentralOne
                        ? `Orden #${orden.orderId} entregada manualmente. Cuando Central One libere el código pendiente, se guardará automáticamente en tu Stock Propio.`
                        : `Orden #${orden.orderId} completada manualmente.`,
                    order: orden
                });
            }

            // 3. 🔒 CANDADO ANTI-DOBLE PEDIDO: Si la orden YA está en EJECUTANDO_API y tiene apiOrderId en Central One, NO permitir que otro clic vuelva a pedir otra tarjeta
            if (orden.status === 'EJECUTANDO_API' && orden.apiOrderId && !orden.apiOrderId.startsWith('VAULT-') && !orden.apiOrderId.startsWith('INTERNAL-') && !orden.apiOrderId.startsWith('API-')) {
                const headersCO = obtenerHeadersCentralOne();
                if (headersCO && !orden.apiOrderId.startsWith('kz-ord-')) {
                    try {
                        const settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('arbitrageBaseCards').lean();
                        const poolCards = settingsDoc ? (settingsDoc.arbitrageBaseCards || []) : [];
                        const algoSt = orden.algoExecutionState || null;
                        const esSteamOrd = String(orden.productSlug || '').toLowerCase().includes('steam') || String(algoSt?.platformGroup || '').toLowerCase() === 'steam';
                        const checkPrev = await verificarYExtraerEntregaCentralOne(orden.apiOrderId, headersCO, poolCards, esSteamOrd, 0, algoSt);

                        if (checkPrev.state === 'COMPLETED') {
                            const previos = (algoSt && Array.isArray(algoSt.deliveredCodesList)) ? algoSt.deliveredCodesList : [];
                            const vistosRaw = new Set(previos.map(extraerCodigoCrudoDeTextoFormateado));
                            const todos = [...previos];
                            for (const cNuevo of (checkPrev.codigosPlanos || [])) {
                                const rk = extraerCodigoCrudoDeTextoFormateado(cNuevo);
                                if (rk && !vistosRaw.has(rk)) {
                                    vistosRaw.add(rk);
                                    todos.push(cNuevo);
                                }
                            }
                            orden.status = 'ENTREGADO';
                            orden.progressPercent = 100;
                            orden.deliveredCode = todos.length > 0 ? todos.join('  |  ') : checkPrev.deliveredCode;
                            orden.statusMessage = '¡Entrega completada! Cópiala aquí abajo.';
                            orden.approvedByWorker = operadorPropietario;
                            orden.completedAt = new Date();
                            await orden.save();
                            return res.json({ success: true, message: `¡Orden #${orden.orderId} ya liberada por Central One y entregada!`, order: orden });
                        }
                    } catch (eCheckEnCurso) {}
                }

                programarSeguimientoOrdenCentralOne(orden.orderId, orden.apiOrderId.startsWith('kz-ord-') ? null : orden.apiOrderId, orden.apiOrderId.startsWith('kz-ord-') ? orden.apiOrderId : null, null, true);
                return res.json({
                    success: true,
                    alreadyProcessing: true,
                    message: `🔒 El pedido #${orden.orderId} ya fue enviado a Central One y se está procesando. No se enviará dos veces.`,
                    order: orden
                });
            }

            // 4. Si la orden ya tenía todos sus códigos en algoExecutionState.deliveredCodesList, completarla de inmediato
            const algoSt = orden.algoExecutionState || null;
            if (algoSt && Array.isArray(algoSt.deliveredCodesList) && algoSt.deliveredCodesList.length > 0 && Number(algoSt.totalCardsExpected) > 0 && algoSt.deliveredCodesList.length >= Number(algoSt.totalCardsExpected)) {
                orden.status = 'ENTREGADO';
                orden.progressPercent = 100;
                orden.deliveredCode = algoSt.deliveredCodesList.join('  |  ');
                if (workerNotes) orden.workerNotes = workerNotes.trim();
                orden.statusMessage = '¡Tu pedido ha sido entregado con éxito!';
                orden.approvedByWorker = operadorPropietario;
                orden.completedAt = new Date();
                await orden.save();
                return res.json({ success: true, message: `Orden #${orden.orderId} marcada como entregada.`, order: orden });
            }

            // 5. Si estaba en ERROR_API con un apiOrderId previo, verificar primero en Central One antes de reintentar
            if (orden.apiOrderId && !orden.apiOrderId.startsWith('VAULT-') && !orden.apiOrderId.startsWith('INTERNAL-') && !orden.apiOrderId.startsWith('API-') && !orden.apiOrderId.startsWith('kz-ord-')) {
                const headersCO = obtenerHeadersCentralOne();
                if (headersCO) {
                    try {
                        const settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('arbitrageBaseCards').lean();
                        const poolCards = settingsDoc ? (settingsDoc.arbitrageBaseCards || []) : [];
                        const esSteamOrd = String(orden.productSlug || '').toLowerCase().includes('steam') || String(algoSt?.platformGroup || '').toLowerCase() === 'steam';
                        const checkPrev = await verificarYExtraerEntregaCentralOne(orden.apiOrderId, headersCO, poolCards, esSteamOrd, 0, algoSt);

                        if (checkPrev.state === 'COMPLETED') {
                            const previos = (algoSt && Array.isArray(algoSt.deliveredCodesList)) ? algoSt.deliveredCodesList : [];
                            const vistosRaw = new Set(previos.map(extraerCodigoCrudoDeTextoFormateado));
                            const todos = [...previos];
                            for (const cNuevo of (checkPrev.codigosPlanos || [])) {
                                const rk = extraerCodigoCrudoDeTextoFormateado(cNuevo);
                                if (rk && !vistosRaw.has(rk)) {
                                    vistosRaw.add(rk);
                                    todos.push(cNuevo);
                                }
                            }
                            orden.status = 'ENTREGADO';
                            orden.progressPercent = 100;
                            orden.deliveredCode = todos.length > 0 ? todos.join('  |  ') : checkPrev.deliveredCode;
                            if (workerNotes) orden.workerNotes = workerNotes.trim();
                            orden.statusMessage = '¡Entrega completada! Cópiala aquí abajo.';
                            orden.approvedByWorker = operadorPropietario;
                            orden.completedAt = new Date();
                            await orden.save();
                            return res.json({ success: true, message: `Orden #${orden.orderId} recuperada de Central One y entregada.`, order: orden });
                        } else if (checkPrev.state === 'FAILED') {
                            orden.apiOrderId = '';
                        }
                    } catch (ePrev) {}
                }
            }

            orden.status = 'EJECUTANDO_API';
            orden.statusMessage = 'Pago verificado. Ejecutando entrega automática...';
            orden.progressPercent = 80;
            orden.approvedByWorker = operadorPropietario;
            if (workerNotes) orden.workerNotes = workerNotes.trim();
            await orden.save();

            // Caso A: Si el cliente compró saldo de Tokems KZ
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
                orden.approvedByWorker = operadorPropietario;
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
                orden.approvedByWorker = operadorPropietario;
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
            orden.approvedByWorker = operadorPropietario;
            orden.completedAt = new Date();
            await orden.save();

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

        // ⚠️ SI EL TRABAJADOR / DUEÑO PONE LA ORDEN EN REVISIÓN
        if (action === 'REVISION') {
            const motivo = (workerNotes || 'Detectamos un detalle con tu pago que debemos verificar contigo.').trim();
            orden.status = 'EN_REVISION';
            orden.progressPercent = 100;
            orden.hadReview = true;
            orden.reviewedAt = new Date();
            orden.reviewReason = motivo;
            orden.workerNotes = motivo;
            orden.statusMessage = '⚠️ Tu pedido se encuentra en revisión. Revisa el mensaje del operador aquí abajo.';
            orden.reviewedByWorker = operadorPropietario;
            await orden.save();

            return res.json({
                success: true,
                message: `Orden #${orden.orderId} puesta en revisión.`,
                order: orden
            });
        }

        // ❌ SI EL TRABAJADOR / DUEÑO RECHAZA LA ORDEN
        if (action === 'RECHAZAR') {
            const yaEstabaRechazada = orden.status === 'RECHAZADO';
            if (orden.status === 'EN_REVISION') {
                orden.hadReview = true;
            }
            orden.status = 'RECHAZADO';
            orden.progressPercent = 100;
            orden.statusMessage = (workerNotes || '').trim() || 'No pudimos verificar tu referencia de pago. Si crees que es un error, abre un ticket de soporte.';
            orden.workerNotes = (workerNotes || '').trim() || 'Referencia no encontrada';
            orden.approvedByWorker = operadorPropietario;
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
    } finally {
        activeWorkerApprovalLocks.delete(idLock);
    }
});

// 🗑️ ELIMINAR ORDEN DEFINITIVAMENTE (Exclusivo para el Dueño — Limpia BD, Transacciones y Pollers en RAM)
app.post('/api/worker/delete-order', verificarSoloAdmin, async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) return res.status(400).json({ error: 'Falta el ID de la orden.' });

        const idLimpio = String(orderId).trim().toUpperCase();

        if (activeCentralOnePollers.has(idLimpio)) {
            clearTimeout(activeCentralOnePollers.get(idLimpio));
            activeCentralOnePollers.delete(idLimpio);
        }
        activeOrderProcessingLocks.delete(idLimpio);
        activeWorkerApprovalLocks.delete(idLimpio);
        _lastLiveStatusCoCheckMap.delete(idLimpio);

        const ordenBorrada = await Order.findOneAndDelete({ orderId: idLimpio });

        await Transaction.deleteMany({
            detalles: { $regex: new RegExp(`#${idLimpio}\\b`, 'i') }
        }).catch(() => {});

        if (ordenBorrada && ordenBorrada.refundTicketId) {
            await SupportTicket.deleteOne({ ticketId: ordenBorrada.refundTicketId }).catch(() => {});
        }

        return res.json({
            success: true,
            orderId: idLimpio,
            message: `Orden #${idLimpio} eliminada por completo de la base de datos y de las estadísticas.`
        });
    } catch (error) {
        console.error('Error eliminando orden:', error);
        return res.status(500).json({ error: 'Error al eliminar la orden.' });
    }
});

// 🕵️‍♂️ MOTOR FORENSE MULTINIVEL PARA OPERADORES Y DUEÑO (ULTRARRÁPIDO SIN DESCARGAR BASE64 + TRAZABILIDAD DE STOCK PROPIO)
app.post('/api/worker/forensic-verify', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { mode, query } = req.body;
        const rawQ = String(query || '').trim();
        if (!rawQ || rawQ.length < 2) {
            return res.status(400).json({ error: 'Ingresa al menos 2 caracteres para realizar la búsqueda forense.' });
        }

        const escaparRegex = (str) => String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const projectionOrden = req.effectiveRole === 'admin'
            ? '-internalAccountLogin.accountPass -apiRawResponse -algoExecutionState.pendingReplacementBody'
            : '-internalAccountLogin.accountPass -costUSD -apiRawResponse -algoExecutionState.pendingReplacementBody';

        // 1. VERIFICADOR DE REFERENCIAS DE PAGO MÓVIL (BS) Y BANCOS
        if (mode === 'PAGO_MOVIL') {
            const qClean = rawQ.replace(/[^a-zA-Z0-9-]/g, '').trim();
            const regexRef = new RegExp(escaparRegex(qClean), 'i');

            const [orders, tickets] = await Promise.all([
                Order.find({
                    paymentReference: { $regex: regexRef },
                    paymentMethodKey: { $nin: ['tokems_kz'] }
                }).sort({ fecha: -1 }).limit(25).select(projectionOrden).lean(),
                SupportTicket.find({
                    $or: [
                        { paymentReference: { $regex: regexRef } },
                        { 'messages.text': { $regex: regexRef } }
                    ]
                }).sort({ updatedAt: -1 }).limit(10).select('ticketId orderId userEmail userName status category paymentReference createdAt').lean()
            ]);

            return res.json({
                success: true,
                mode,
                query: qClean,
                orders,
                tickets
            });
        }

        // 2. VERIFICADOR DE TRANSACCIONES BINANCE PAY (TxID P_..., Order ID, Checkout ch_KZ..., Monto .001)
        if (mode === 'BINANCE') {
            const qClean = rawQ.trim();
            const regexBn = new RegExp(escaparRegex(qClean), 'i');
            const numMonto = parseFloat(qClean.replace(',', '.'));
            const filtroOr = [
                { binanceTransactionId: { $regex: regexBn } },
                { binanceCheckoutId: { $regex: regexBn } },
                { binancePayerName: { $regex: regexBn } },
                { paymentReference: { $regex: regexBn } }
            ];

            if (!isNaN(numMonto) && numMonto > 0) {
                filtroOr.push({
                    binanceExactAmountUSDT: { $gte: Number((numMonto - 0.0005).toFixed(4)), $lte: Number((numMonto + 0.0005).toFixed(4)) }
                });
            }

            const [orders, settingsDoc] = await Promise.all([
                Order.find({
                    $and: [
                        { $or: [{ paymentMethodKey: { $regex: /binance/i } }, { binanceCheckoutId: { $ne: '' } }, { binanceTransactionId: { $ne: '' } }] },
                        { $or: filtroOr }
                    ]
                }).sort({ fecha: -1 }).limit(25).select(projectionOrden).lean(),
                StoreSettings.collection.findOne(
                    { key: 'main_settings' },
                    { projection: { 'binanceAutoConfig.usedTxIds': 1 } }
                )
            ]);

            const usedTxIds = Array.isArray(settingsDoc?.binanceAutoConfig?.usedTxIds)
                ? settingsDoc.binanceAutoConfig.usedTxIds
                : [];
            const isBurnedInGateway = usedTxIds.some(id => String(id).toLowerCase().includes(qClean.toLowerCase())) ||
                                      memoriaTxIdsQuemados.has(qClean);

            return res.json({
                success: true,
                mode,
                query: qClean,
                orders,
                isBurnedInGateway
            });
        }

        // 3. LOCALIZADOR MAESTRO DE ÓRDENES (#KZ-...), ID CENTRAL ONE O CLIENTE (UID / WHATSAPP / CORREO)
        if (mode === 'KZ_ORDER') {
            const limpioSinHash = rawQ.replace(/^#/, '').trim();
            const soloDigitos = limpioSinHash.replace(/^KZ-/i, '').trim();
            const regexGeneral = new RegExp(escaparRegex(limpioSinHash), 'i');
            const regexKzId = new RegExp(escaparRegex(soloDigitos), 'i');

            const orders = await Order.find({
                $or: [
                    { orderId: { $regex: regexKzId } },
                    { apiOrderId: { $regex: regexGeneral } },
                    { playerUid: { $regex: regexGeneral } },
                    { userEmail: { $regex: regexGeneral } },
                    { userWhatsapp: { $regex: regexGeneral } },
                    { playerNickname: { $regex: regexGeneral } }
                ]
            }).sort({ fecha: -1 }).limit(25).select(projectionOrden).lean();

            const orderIdsHallados = orders.map(o => o.orderId).filter(Boolean);
            const tickets = await SupportTicket.find({
                $or: [
                    { orderId: { $in: orderIdsHallados } },
                    { orderId: { $regex: regexKzId } },
                    { ticketId: { $regex: regexGeneral } },
                    { playerUid: { $regex: regexGeneral } }
                ]
            }).sort({ updatedAt: -1 }).limit(15).select('ticketId orderId userEmail userName status category assignedWorkerName createdAt').lean();

            return res.json({
                success: true,
                mode,
                query: limpioSinHash,
                orders,
                tickets
            });
        }

        // 4. AUDITOR FORENSE DE CÓDIGOS PIN / CENTRAL ONE (CONSULTA LIGERA DIRECTA EN COLECCIÓN SIN IMÁGENES BASE64)
        if (mode === 'CODE_PIN') {
            const limpioCodigo = rawQ.includes('➔')
                ? rawQ.split('➔').slice(1).join('➔').trim()
                : rawQ.trim();

            if (limpioCodigo.length < 3) {
                return res.status(400).json({ error: 'El código a verificar debe tener al menos 3 caracteres.' });
            }

            const regexCode = new RegExp(escaparRegex(limpioCodigo), 'i');
            const codeUpper = limpioCodigo.toUpperCase();

            // Consulta directa a colecciones excluyendo Base64 (responde en ~25ms sin colapsar la red)
            const [ordersWithCodeRaw, settingsDoc, productsList, tokemPinDoc, tokemTxList] = await Promise.all([
                Order.find({
                    $or: [
                        { deliveredCode: { $regex: regexCode } },
                        { 'algoExecutionState.deliveredCodesList': { $regex: regexCode } }
                    ]
                }).sort({ fecha: -1 }).limit(20).select(projectionOrden).lean(),
                StoreSettings.collection.findOne(
                    { key: 'main_settings' },
                    {
                        projection: {
                            'arbitrageBaseCards.cardId': 1,
                            'arbitrageBaseCards.name': 1,
                            'arbitrageBaseCards.platformGroup': 1,
                            'arbitrageBaseCards.effectiveClientUSD': 1,
                            'arbitrageBaseCards.internalCodeStock': 1,
                            'flashOffers.game': 1,
                            'flashOffers.slug': 1,
                            'flashOffers.title': 1,
                            'flashOffers.backupPinVault': 1
                        }
                    }
                ),
                CatalogProduct.collection.find(
                    {},
                    {
                        projection: {
                            slug: 1,
                            name: 1,
                            'packages.name': 1,
                            'packages.backupPinVault': 1,
                            'altPackages.name': 1,
                            'altPackages.backupPinVault': 1
                        }
                    }
                ).toArray(),
                Pin.findOne({ code: codeUpper }).lean(),
                Transaction.find({
                    $or: [
                        { codigoPin: { $regex: regexCode } },
                        { detalles: { $regex: regexCode } }
                    ]
                }).sort({ fecha: -1 }).limit(10).lean()
            ]);

            // Marcar si la orden utilizó códigos provenientes de tu Stock Propio
            const ordersWithCode = (ordersWithCodeRaw || []).map(o => {
                const itemsMeta = o.algoExecutionState?.orderedItemsMeta || [];
                const usoStockPropio = String(o.apiOrderId || '').startsWith('INTERNAL-VAULT') ||
                                       String(o.apiOrderId || '').startsWith('VAULT-') ||
                                       itemsMeta.some(m => Number(m.ownStockUsed) > 0);
                return {
                    ...o,
                    deliveredFromOwnStock: Boolean(usoStockPropio)
                };
            });

            // A. Escanear Stock Propio de la Bóveda del Algoritmo (arbitrageBaseCards.internalCodeStock)
            const inOwnVaultCards = [];
            (settingsDoc?.arbitrageBaseCards || []).forEach(c => {
                const stockArr = Array.isArray(c.internalCodeStock) ? c.internalCodeStock : [];
                stockArr.forEach((codStr, posIdx) => {
                    const limpioStock = codStr.includes('➔') ? codStr.split('➔').slice(1).join('➔').trim() : String(codStr || '').trim();
                    if (limpioStock.toUpperCase().includes(codeUpper)) {
                        inOwnVaultCards.push({
                            cardId: c.cardId,
                            cardName: c.name,
                            platformGroup: (c.platformGroup || 'steam').toUpperCase(),
                            effectiveClientUSD: c.effectiveClientUSD,
                            positionInQueue: posIdx + 1,
                            totalInCard: stockArr.length,
                            exactCode: limpioStock
                        });
                    }
                });
            });

            // B. Escanear Bóvedas de Paquetes del Catálogo y Ofertas Relámpago (backupPinVault)
            const inProductVaults = [];
            (productsList || []).forEach(p => {
                const revisarListaPaq = (arr, modoLbl) => {
                    (arr || []).forEach(pk => {
                        const boveda = Array.isArray(pk.backupPinVault) ? pk.backupPinVault : [];
                        boveda.forEach((pinStr, idxPin) => {
                            if (String(pinStr || '').toUpperCase().includes(codeUpper)) {
                                inProductVaults.push({
                                    productName: p.name,
                                    packageName: `${pk.name}${modoLbl}`,
                                    positionInVault: idxPin + 1,
                                    exactCode: pinStr
                                });
                            }
                        });
                    });
                };
                revisarListaPaq(p.packages, '');
                revisarListaPaq(p.altPackages, ' (Alt)');
            });

            (settingsDoc?.flashOffers || []).forEach(of => {
                (of.backupPinVault || []).forEach((pinStr, idxPin) => {
                    if (String(pinStr || '').toUpperCase().includes(codeUpper)) {
                        inProductVaults.push({
                            productName: `Oferta Relámpago (${of.game || of.slug})`,
                            packageName: of.title,
                            positionInVault: idxPin + 1,
                            exactCode: pinStr
                        });
                    }
                });
            });

            return res.json({
                success: true,
                mode,
                query: limpioCodigo,
                ordersWithCode,
                inOwnVaultCards,
                inProductVaults,
                tokemPinDoc,
                tokemTxList
            });
        }

        return res.status(400).json({ error: 'Modo de verificación no válido.' });
    } catch (error) {
        console.error('Error en /api/worker/forensic-verify:', error);
        return res.status(500).json({ error: 'Error ejecutando la auditoría forense.' });
    }
});

// 👑 DASHBOARD 1: ENDPOINTS EXCLUSIVOS PARA TI (ADMIN / DESARROLLADOR)
// =================================================================

// ⚡ Evita que los listados masivos de tickets descarguen capturas Base64 pesadas (solo se descargan al abrir un ticket individual con findOne)
SupportTicket.schema.pre('find', function() {
    const fields = this._fields;
    if (!fields || Object.keys(fields).length === 0) {
        this.select('-messages.attachmentUrl');
    }
});

app.get('/api/admin/overview', verificarSoloAdmin, async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
        // ⚡ MODO SÓLO CATÁLOGO CENTRAL ONE: Si ya está en RAM, no descarga los ~8MB desde MongoDB Atlas (responde en 2ms)
        if (req.query.catalogOnly === '1') {
            const tieneEnRAM = Array.isArray(_ramCentralOneCatalogCache) && _ramCentralOneCatalogCache.length > 0;
            const projectionExtra = tieneEnRAM
                ? 'centralOneAlerts centralOneSync flyersCanvaConfig'
                : 'centralOneCatalogCache centralOneAlerts centralOneSync flyersCanvaConfig';

            const stExtra = await StoreSettings.findOne({ key: 'main_settings' })
                .select(projectionExtra)
                .lean();

            if (!tieneEnRAM && Array.isArray(stExtra?.centralOneCatalogCache) && stExtra.centralOneCatalogCache.length > 0) {
                _ramCentralOneCatalogCache = stExtra.centralOneCatalogCache;
                obtenerIndicesCatalogoEnRAM(_ramCentralOneCatalogCache);
            }

            const fuenteCatCO = Array.isArray(_ramCentralOneCatalogCache) && _ramCentralOneCatalogCache.length > 0
                ? _ramCentralOneCatalogCache
                : (stExtra?.centralOneCatalogCache || []);

            return res.json({
                success: true,
                catalogOnly: true,
                settings: {
                    centralOneCatalogCache: fuenteCatCO.map(c => ({
                        product_id: c.product_id,
                        sku: c.sku,
                        name: c.name,
                        reseller_price: c.reseller_price,
                        in_stock: c.in_stock,
                        status: c.status,
                        available_stock: c.available_stock,
                        product_family_name: c.product_family_name,
                        requires_target: c.requires_target,
                        target_fields: c.target_fields,
                        region: c.region || c.country || '',
                        target_schema: c.target_schema || null
                    })),
                    centralOneAlerts: stExtra?.centralOneAlerts || [],
                    centralOneSync: stExtra?.centralOneSync || null,
                    flyersCanvaConfig: stExtra?.flyersCanvaConfig || null
                }
            });
        }

        const isFastMode = req.query.fast === '1' || req.query.lite === '1';

        // Sincronizado con zona horaria de Venezuela (UTC-4)
        const ahoraVzla = new Date(Date.now() - (4 * 60 * 60 * 1000));
        const hoyInicio = new Date(Date.UTC(ahoraVzla.getUTCFullYear(), ahoraVzla.getUTCMonth(), ahoraVzla.getUTCDate(), 4, 0, 0, 0));
        const mesInicio = new Date(Date.UTC(ahoraVzla.getUTCFullYear(), ahoraVzla.getUTCMonth(), 1, 4, 0, 0, 0));

        const projectionSettings = isFastMode
            ? '-centralOneCatalogCache -centralOneCoverageCache -processedWebhookIds -flyersCanvaConfig'
            : '-centralOneCoverageCache -processedWebhookIds';

        const projectionProducts = '-packages.targetSchemaCache -altPackages.targetSchemaCache';

        const [
            settingsRaw,
            productsRaw,
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
            StoreSettings.findOne({ key: 'main_settings' })
                .select(projectionSettings)
                .lean(),
            CatalogProduct.find()
                .sort({ sortOrder: 1 })
                .select(projectionProducts)
                .lean(),
            PaymentMethod.find().sort({ sortOrder: 1 }).lean(),
            Order.find()
                .sort({ fecha: -1 })
                .limit(isFastMode ? 600 : 1500)
                .select('-internalAccountLogin.accountPass -apiRawResponse -algoExecutionState.pendingReplacementBody')
                .lean(),
            Order.countDocuments({ status: 'EN_PROCESO' }),
            SupportTicket.countDocuments({ status: { $in: ['ABIERTO', 'EN_REVISION'] } }),
            SupportTicket.find().sort({ createdAt: -1 }).limit(150).select('ticketId orderId userEmail category status assignedWorker assignedWorkerName createdAt').lean(),
            User.find({ role: { $in: ['worker', 'admin'] } }).select('email accountName role tokems').lean(),
            User.find().sort({ createdAt: -1 }).select('accountName email role isVerified tokems savedProfiles createdAt').lean(),
            Balance.find({ tokens: { $gt: 0 } }).select('deviceId tokens').lean(),
            Pin.find().select('code tokens used createdBy createdAt').lean(),
            Transaction.find().sort({ fecha: -1 }).limit(isFastMode ? 250 : 500).select('deviceId tipo tokens plan precio fecha').lean()
        ]);

        const settings = settingsRaw ? { ...settingsRaw } : {};
        const fuenteCatCO = Array.isArray(_ramCentralOneCatalogCache) && _ramCentralOneCatalogCache.length > 0
            ? _ramCentralOneCatalogCache
            : (settings.centralOneCatalogCache || []);

        if (isFastMode) {
            delete settings.centralOneCatalogCache;
            delete settings.flyersCanvaConfig;
        } else if (Array.isArray(fuenteCatCO) && fuenteCatCO.length > 0) {
            settings.centralOneCatalogCache = fuenteCatCO.map(c => ({
                product_id: c.product_id,
                sku: c.sku,
                name: c.name,
                reseller_price: c.reseller_price,
                in_stock: c.in_stock,
                status: c.status,
                available_stock: c.available_stock,
                product_family_name: c.product_family_name,
                requires_target: c.requires_target,
                target_fields: c.target_fields
            }));
        }

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
            isFastMode,
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
            products: productsRaw,
            paymentMethods,
            workersList
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error cargando estadísticas de Desarrollador.' });
    }
});

// 2. Modificar Tasa Bs/USD, Portada, Pool de Tarjetas Base del Algoritmo y Configuración General (Guardado Atómico 5ms)
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

        const camposSet = {
            updatedBy: req.adminUser.email,
            updatedAt: new Date()
        };

        if (exchangeRateVES !== undefined) camposSet.exchangeRateVES = Number(exchangeRateVES);
        if (bcvRateVES !== undefined) camposSet.bcvRateVES = Number(bcvRateVES);
        if (tokemValueUSD !== undefined) camposSet.tokemValueUSD = Number(tokemValueUSD);
        if (typeof storeOpen === 'boolean') camposSet.storeOpen = storeOpen;
        if (typeof autoTriggerApiOnTokems === 'boolean') camposSet.autoTriggerApiOnTokems = autoTriggerApiOnTokems;
        if (announcementText !== undefined) camposSet.announcementText = String(announcementText);
        if (typeof hideAnnouncement === 'boolean') camposSet.hideAnnouncement = hideAnnouncement;
        if (heroConfig && typeof heroConfig === 'object') camposSet.heroConfig = heroConfig;
        if (flashSectionConfig && typeof flashSectionConfig === 'object') camposSet.flashSectionConfig = flashSectionConfig;

        if (Array.isArray(flashOffers)) {
            camposSet.flashOffers = flashOffers.map(of => ({
                ...of,
                slug: String(of.slug || '').trim(),
                linkedPackageId: String(of.linkedPackageId || '').trim(),
                pkgId: String(of.pkgId || of.linkedPackageId || '').trim(),
                oldUsd: Number(of.oldUsd || 0),
                usd: Number(of.usd || 0),
                costUSD: Number(of.costUSD || 0),
                profitUSD: Number(of.profitUSD || 0),
                tokemsPrice: Number(of.tokemsPrice ?? of.usd ?? 0),
                expiresAt: of.expiresAt ? new Date(of.expiresAt) : null,
                active: of.active !== false,
                isGiftCardPin: Boolean(of.isGiftCardPin),
                backupPinVault: Array.isArray(of.backupPinVault) ? of.backupPinVault : []
            }));
        }

        if (catalogSectionConfig && typeof catalogSectionConfig === 'object') camposSet.catalogSectionConfig = catalogSectionConfig;
        if (navigationConfig && typeof navigationConfig === 'object') camposSet.navigationConfig = navigationConfig;
        if (flyersCanvaConfig && typeof flyersCanvaConfig === 'object') camposSet.flyersCanvaConfig = flyersCanvaConfig;
        if (steamCalculatorConfig && typeof steamCalculatorConfig === 'object') camposSet.steamCalculatorConfig = steamCalculatorConfig;

        if (Array.isArray(arbitrageBaseCards)) {
            camposSet.arbitrageBaseCards = arbitrageBaseCards.map((c, idx) => ({
                cardId: String(c.cardId || ('arb_' + idx)),
                platformGroup: String(c.platformGroup || 'steam').toLowerCase(),
                name: String(c.name || `Tarjeta Base #${idx + 1}`).trim(),
                centralOneProductId: String(c.centralOneProductId || '').trim(),
                centralOneSku: String(c.centralOneSku || '').trim(),
                faceValueOrigin: Number(c.faceValueOrigin) || 0,
                originCurrency: String(c.originCurrency || 'VND').trim().toUpperCase(),
                conversionRateToUSD: Number(c.conversionRateToUSD) || 0,
                effectiveClientUSD: Number(c.effectiveClientUSD) || 0,
                costUSD: Number(c.costUSD) || 0,
                minProfitUSD: Number(c.minProfitUSD) || 0,
                internalCodeStock: Array.isArray(c.internalCodeStock)
                    ? c.internalCodeStock.map(s => String(s || '').trim()).filter(Boolean)
                    : [],
                inStock: c.inStock !== false,
                availableStock: (c.availableStock !== null && c.availableStock !== undefined && c.availableStock !== '') ? Number(c.availableStock) : null,
                active: c.active !== false,
                lastPriceUpdateAt: c.lastPriceUpdateAt ? new Date(c.lastPriceUpdateAt) : new Date()
            }));
        }

        // Guardado atómico directo en MongoDB (Evita errores de versión o exclusión de Mongoose)
        await StoreSettings.collection.updateOne(
            { key: 'main_settings' },
            { $set: camposSet },
            { upsert: true }
        );

        if (Array.isArray(arbitrageBaseCards)) {
            setImmediate(() => {
                recalcularPreciosYAlgoritmoTiendaKZ().catch(() => {});
            });
        }

        const settingsActualizado = await StoreSettings.findOne({ key: 'main_settings' })
            .select('-centralOneCatalogCache -centralOneCoverageCache -processedWebhookIds')
            .lean();

        return res.json({
            success: true,
            settings: settingsActualizado
        });
    } catch (error) {
        console.error('Error en /api/admin/settings:', error);
        return res.status(500).json({ error: 'Error guardando configuración de la tienda.' });
    }
});

// 2.5 Endpoints de Sincronización y Control del Monitor Central One API (Respuesta Ultrarrápida)
app.post('/api/admin/central-one/sync', verificarSoloAdmin, async (req, res) => {
    try {
        const resultado = await sincronizarTodoConCentralOne(true);
        const [settings, products] = await Promise.all([
            StoreSettings.findOne({ key: 'main_settings' })
                .select('-centralOneCatalogCache -centralOneCoverageCache -processedWebhookIds -flyersCanvaConfig')
                .lean(),
            CatalogProduct.find()
                .sort({ sortOrder: 1 })
                .select('-cardImageUrl -flyerImageUrl -infoImageUrl -packages.imageUrl -altPackages.imageUrl -packages.targetSchemaCache -altPackages.targetSchemaCache')
                .lean()
        ]);

        if (settings) {
            settings.centralOneCatalogCache = _ramCentralOneCatalogCache || [];
        }

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

// =================================================================
// 🤖 MOTOR DE NOTIFICACIONES EN VIVO POR TELEGRAM (4 EVENTOS + INTERCEPTOR DIRECTO DE .SAVE())
// =================================================================
StoreSettings.schema.add({
    telegramConfig: { type: mongoose.Schema.Types.Mixed, default: null }
});

const _telegramPreventiveAlertSentSet = new Set();
global._tgNotifiedOrdersSet = global._tgNotifiedOrdersSet || new Set();
global._tgNotifiedTicketsSet = global._tgNotifiedTicketsSet || new Set();

async function obtenerConfigTelegramActiva(settingsDoc = null) {
    if (!settingsDoc) {
        settingsDoc = await StoreSettings.findOne({ key: 'main_settings' }).select('telegramConfig').lean();
    }
    const cfg = (settingsDoc && settingsDoc.telegramConfig && typeof settingsDoc.telegramConfig === 'object')
        ? settingsDoc.telegramConfig
        : {};

    const botToken = String(cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatIdsRaw = String(cfg.chatId || process.env.TELEGRAM_CHAT_ID || '').trim();
    const chatIds = chatIdsRaw.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);

    return {
        enabled: cfg.enabled !== false,
        botToken,
        chatId: chatIdsRaw,
        chatIds,
        notifyNewOrders: cfg.notifyNewOrders !== false,
        notifyAutoSales: cfg.notifyAutoSales !== false,
        notifyTickets: cfg.notifyTickets !== false,
        notifyDelay35m: cfg.notifyDelay35m !== false
    };
}

function escaparHtmlTelegram(texto) {
    return String(texto ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function enviarMensajeTelegramKZ(htmlText, inlineButtons = [], configOverride = null) {
    try {
        const cfg = configOverride || await obtenerConfigTelegramActiva();
        if (!cfg.enabled || !cfg.botToken || !Array.isArray(cfg.chatIds) || cfg.chatIds.length === 0) {
            return { ok: false, reason: 'Telegram no configurado o desactivado' };
        }

        const replyMarkup = (Array.isArray(inlineButtons) && inlineButtons.length > 0)
            ? { inline_keyboard: inlineButtons }
            : undefined;

        const resultados = await Promise.all(cfg.chatIds.map(async (cid) => {
            try {
                const resp = await axios.post(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
                    chat_id: cid,
                    text: htmlText,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
                }, { timeout: 8000 });
                return { chatId: cid, ok: Boolean(resp.data && resp.data.ok) };
            } catch (err) {
                return { chatId: cid, ok: false, error: err.response?.data?.description || err.message };
            }
        }));

        const algunoExitoso = resultados.some(r => r.ok);
        const primerError = resultados.find(r => !r.ok)?.error || '';
        return { ok: algunoExitoso, results: resultados, error: algunoExitoso ? '' : primerError };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function armarBotonesTelegramParaOrden(orden) {
    const fila1 = [
        { text: '📋 Abrir Cola (Staff)', url: 'https://kemzone07.com/DashWork' },
        { text: '👑 Dashwork Dueño', url: 'https://kemzone07.com/DashworkDueno' }
    ];
    const botones = [fila1];

    const numWs = String(orden?.userWhatsapp || '').replace(/\D/g, '');
    if (numWs.length >= 7) {
        const numConCod = numWs.startsWith('0') ? '58' + numWs.slice(1) : (numWs.startsWith('58') ? numWs : '58' + numWs);
        const msgWs = `¡Hola! Te escribe el soporte de Kem!Zone sobre tu pedido #${orden.orderId} (${orden.productName} - ${orden.packageName}).`;
        botones.push([
            { text: `💬 WhatsApp Cliente (${orden.userWhatsapp})`, url: `https://wa.me/${numConCod}?text=${encodeURIComponent(msgWs)}` }
        ]);
    }
    return botones;
}

// 📥 EVENTO 1: Nueva Orden en Cola por Apartar (Pago Móvil, PayPal o Fallback Manual Binance)
async function notificarTelegramNuevaOrdenEnCola(orden) {
    try {
        if (!orden || !orden.orderId) return;
        const cfg = await obtenerConfigTelegramActiva();
        if (!cfg.enabled || !cfg.notifyNewOrders || !cfg.botToken || cfg.chatIds.length === 0) return;

        const horaVzla = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(11, 19);
        const montoBs = Number(orden.totalAmountVES || 0).toFixed(2);
        const montoUsdBcv = Number(orden.clientPayUSD || orden.bcvAmountUSD || orden.totalAmountUSD || 0).toFixed(2);
        const montoUsdNeto = Number(orden.totalAmountUSD || 0).toFixed(2);
        const refTxt = orden.paymentReference || 'N/A';

        const alertaDuplicadaHtml = orden.isDuplicateRef
            ? `\n🚨 <b>¡ALERTA ANTI-FRAUDE!</b> <i>${escaparHtmlTelegram(orden.duplicateWarningText || 'Esta referencia de 6 dígitos YA FUE USADA en otra orden.')}</i>\n`
            : '';

        const extrasJugador = [
            orden.playerRegion ? `Región: ${orden.playerRegion}` : '',
            orden.playerServer ? `Zona: ${orden.playerServer}` : '',
            orden.playerNickname ? `Nick: ${orden.playerNickname}` : ''
        ].filter(Boolean).join(' • ');

        const tipoEntrega = orden.fulfillmentType === 'API_GIFT_CARD' || orden.isGiftCardPin
            ? '🎁 Código Digital / PIN'
            : (orden.fulfillmentType === 'MANUAL_INTERNAL' ? '🛡️ Recarga Interna (WhatsApp)' : '⚡ Recarga Directa por ID');

        const html = [
            `📥 <b>¡NUEVA ORDEN EN COLA POR APARTAR!</b> 🔥`,
            alertaDuplicadaHtml,
            `🧾 <b>Orden:</b> <code>#${escaparHtmlTelegram(orden.orderId)}</code>`,
            `🏷️ <b>Tipo:</b> ${tipoEntrega}`,
            `🎮 <b>Producto:</b> <b>${escaparHtmlTelegram(orden.productName)}</b>`,
            `📦 <b>Paquete:</b> <b>${escaparHtmlTelegram(orden.packageName)}</b>`,
            `────────────────────`,
            `💳 <b>Método:</b> <b>${escaparHtmlTelegram(orden.paymentMethodName || orden.paymentMethodKey)}</b>`,
            orden.paypalPayerName ? `👤 <b>Titular PayPal:</b> ${escaparHtmlTelegram(orden.paypalPayerName)}` : '',
            `🔢 <b>Referencia (Toca para copiar):</b> <code>${escaparHtmlTelegram(refTxt)}</code>`,
            `💰 <b>Monto a Verificar:</b> <code>Bs. ${montoBs}</code> <b>($${montoUsdBcv} BCV | Neto: $${montoUsdNeto})</b>`,
            `────────────────────`,
            `🆔 <b>Destino / UID (Toca para copiar):</b> <code>${escaparHtmlTelegram(orden.playerUid)}</code>`,
            extrasJugador ? `🌐 <b>Datos Extra:</b> ${escaparHtmlTelegram(extrasJugador)}` : '',
            orden.userEmail ? `📧 <b>Cliente:</b> ${escaparHtmlTelegram(orden.userEmail)}` : '',
            orden.userWhatsapp ? `📱 <b>WhatsApp:</b> <code>${escaparHtmlTelegram(orden.userWhatsapp)}</code>` : '',
            `🕒 <b>Hora Vzla:</b> ${horaVzla}`
        ].filter(Boolean).join('\n');

        await enviarMensajeTelegramKZ(html, armarBotonesTelegramParaOrden(orden), cfg);
    } catch (e) {}
}

// 🟡 EVENTO 2: Venta Automática 24/7 (Binance Pay Auto o Saldo Tokems KZ)
async function notificarTelegramVentaAutomatica(orden, origen = 'BINANCE_AUTO') {
    try {
        if (!orden || !orden.orderId) return;
        const cfg = await obtenerConfigTelegramActiva();
        if (!cfg.enabled || !cfg.notifyAutoSales || !cfg.botToken || cfg.chatIds.length === 0) return;

        const montoBs = Number(orden.totalAmountVES || 0).toFixed(2);
        const montoUsd = Number(orden.binanceExactAmountUSDT || orden.totalAmountUSD || 0).toFixed(origen === 'BINANCE_AUTO' ? 3 : 2);
        const txId = orden.binanceTransactionId || orden.paymentReference || 'TOKEMS-KZ';

        const html = [
            `🤖 <b>¡VENTA AUTOMÁTICA ${origen === 'BINANCE_AUTO' ? 'BINANCE PAY 24/7' : 'CON TOKEMS KZ'}!</b> ✅`,
            ``,
            `🧾 <b>Orden:</b> <code>#${escaparHtmlTelegram(orden.orderId)}</code>`,
            `🎮 <b>Producto:</b> <b>${escaparHtmlTelegram(orden.productName)}</b>`,
            `📦 <b>Paquete:</b> <b>${escaparHtmlTelegram(orden.packageName)}</b>`,
            `💳 <b>Pago Confirmado:</b> <b>${escaparHtmlTelegram(orden.paymentMethodName)}</b>`,
            `🔢 <b>TxID / Ref:</b> <code>${escaparHtmlTelegram(txId)}</code>`,
            `💰 <b>Monto:</b> <b>$${montoUsd} ${origen === 'BINANCE_AUTO' ? 'USDT' : 'USD'}</b> (Bs. ${montoBs})`,
            `🆔 <b>Destino / UID:</b> <code>${escaparHtmlTelegram(orden.playerUid)}</code>`,
            orden.userEmail ? `📧 <b>Cliente:</b> ${escaparHtmlTelegram(orden.userEmail)}` : '',
            `📡 <b>Estado:</b> <b>${orden.status === 'ENTREGADO' ? '✅ ENTREGADO AL INSTANTE' : '⚡ PROCESANDO ENTREGA'}</b>`
        ].filter(Boolean).join('\n');

        await enviarMensajeTelegramKZ(html, armarBotonesTelegramParaOrden(orden), cfg);
    } catch (e) {}
}

// 🎫 EVENTO 3: Nuevo Ticket de Soporte, Solicitud de Reembolso o Cliente deja su WhatsApp en Revisión
async function notificarTelegramEventoSoporte(tituloEvento, detallesLineas = [], botonesExtras = []) {
    try {
        const cfg = await obtenerConfigTelegramActiva();
        if (!cfg.enabled || !cfg.notifyTickets || !cfg.botToken || cfg.chatIds.length === 0) return;

        const html = [
            tituloEvento,
            ``,
            ...detallesLineas.filter(Boolean)
        ].join('\n');

        const botonesBase = [
            [
                { text: '🎧 Abrir Tickets (Staff)', url: 'https://kemzone07.com/DashWork' },
                { text: '👑 Dashwork Dueño', url: 'https://kemzone07.com/DashworkDueno' }
            ],
            ...botonesExtras
        ];

        await enviarMensajeTelegramKZ(html, botonesBase, cfg);
    } catch (e) {}
}

// Evaluador Central de Orden para Disparar Alertas de Telegram sin Duplicados
function evaluarYDispararAlertaTelegramOrden(doc) {
    try {
        if (!doc || !doc.orderId) return;

        // 1. Orden en Cola por Apartar (Pago Móvil, PayPal o Fallback Manual de Binance)
        const esEnColaPorApartar = doc.status === 'EN_PROCESO' &&
                                   !doc.isWaitingBinanceAuto &&
                                   !doc.paidWithTokems &&
                                   !doc.claimedByWorker;

        if (esEnColaPorApartar) {
            const keyNew = `${doc.orderId}_NEW_QUEUE`;
            if (!global._tgNotifiedOrdersSet.has(keyNew)) {
                global._tgNotifiedOrdersSet.add(keyNew);
                setImmediate(() => notificarTelegramNuevaOrdenEnCola(doc));
            }
        }

        // 2. Venta Automática 24/7 completada (Binance Pay Auto o Saldo Tokems KZ)
        const esAutoAprobada = (doc.approvedByWorker === 'AUTO-TOKEMS-API' || doc.approvedByWorker === 'AUTO-BINANCE-PAY');
        if (esAutoAprobada && (doc.status === 'ENTREGADO' || doc.status === 'EJECUTANDO_API')) {
            const keyAuto = `${doc.orderId}_AUTO_SALE`;
            if (!global._tgNotifiedOrdersSet.has(keyAuto)) {
                global._tgNotifiedOrdersSet.add(keyAuto);
                const origen = doc.approvedByWorker === 'AUTO-BINANCE-PAY' ? 'BINANCE_AUTO' : 'TOKEMS_AUTO';
                setImmediate(() => notificarTelegramVentaAutomatica(doc, origen));
            }
        }
    } catch (e) {}
}

function evaluarYDispararAlertaTelegramTicket(doc) {
    try {
        if (!doc || !doc.ticketId) return;
        if (doc.status === 'ABIERTO' && !global._tgNotifiedTicketsSet.has(doc.ticketId)) {
            global._tgNotifiedTicketsSet.add(doc.ticketId);
            const primerMsg = (doc.messages && doc.messages[0]) ? doc.messages[0].text : '';
            setImmediate(() => {
                notificarTelegramEventoSoporte(
                    `🎫 <b>¡NUEVO TICKET DE SOPORTE ABIERTO!</b> 🚨`,
                    [
                        `🎫 <b>Ticket:</b> <code>#${escaparHtmlTelegram(doc.ticketId)}</code>`,
                        doc.orderId ? `🧾 <b>Orden Vinculada:</b> <code>#${escaparHtmlTelegram(doc.orderId)}</code>` : '',
                        `📌 <b>Motivo:</b> <b>${escaparHtmlTelegram(doc.category || doc.subject)}</b>`,
                        doc.gameName ? `🎮 <b>Producto:</b> ${escaparHtmlTelegram(doc.gameName)}` : '',
                        doc.paymentReference ? `🔢 <b>Ref / Monto:</b> <code>${escaparHtmlTelegram(doc.paymentReference)}</code>` : '',
                        `👤 <b>Cliente:</b> ${escaparHtmlTelegram(doc.userName || doc.userEmail || 'Invitado')}`,
                        doc.userWhatsapp ? `📱 <b>WhatsApp:</b> <code>${escaparHtmlTelegram(doc.userWhatsapp)}</code>` : '',
                        primerMsg ? `💬 <b>Mensaje:</b> <i>"${escaparHtmlTelegram(primerMsg.slice(0, 260))}"</i>` : ''
                    ]
                );
            });
        }
    } catch (e) {}
}

// ⚡ INTERCEPTOR DIRECTO SOBRE EL MODELO YA COMPILADO (Dispara en 0.00ms en cada .save() y .findOneAndUpdate())
if (!Order.prototype._kzTelegramHooked) {
    Order.prototype._kzTelegramHooked = true;
    const _origOrderSave = Order.prototype.save;
    Order.prototype.save = async function(...args) {
        const resDoc = await _origOrderSave.apply(this, args);
        evaluarYDispararAlertaTelegramOrden(resDoc || this);
        return resDoc;
    };
}

if (!SupportTicket.prototype._kzTelegramHooked) {
    SupportTicket.prototype._kzTelegramHooked = true;
    const _origTicketSave = SupportTicket.prototype.save;
    SupportTicket.prototype.save = async function(...args) {
        const resDoc = await _origTicketSave.apply(this, args);
        evaluarYDispararAlertaTelegramTicket(resDoc || this);
        return resDoc;
    };
}

// Interceptar también cuando el cliente envía su WhatsApp en una orden EN REVISIÓN (/api/orders/client-review-contact)
app.use('/api/orders/client-review-contact', (req, res, next) => {
    const _origJson = res.json.bind(res);
    res.json = function(body) {
        if (body && body.success && body.order && body.order.userWhatsapp) {
            const o = body.order;
            const keyRevWs = `${o.orderId}_REV_WS_${o.userWhatsapp}`;
            if (!global._tgNotifiedOrdersSet.has(keyRevWs)) {
                global._tgNotifiedOrdersSet.add(keyRevWs);
                setImmediate(() => {
                    notificarTelegramEventoSoporte(
                        `📲 <b>¡CLIENTE EN REVISIÓN DEJÓ SU WHATSAPP!</b> 💬`,
                        [
                            `🧾 <b>Orden en Revisión:</b> <code>#${escaparHtmlTelegram(o.orderId)}</code>`,
                            `🎮 <b>Producto:</b> <b>${escaparHtmlTelegram(o.productName)} (${escaparHtmlTelegram(o.packageName)})</b>`,
                            `⚠️ <b>Motivo de Revisión:</b> ${escaparHtmlTelegram(o.reviewReason || o.workerNotes || 'Verificar pago')}`,
                            `📱 <b>WhatsApp del Cliente:</b> <code>${escaparHtmlTelegram(o.userWhatsapp)}</code>`
                        ],
                        armarBotonesTelegramParaOrden(o).slice(1)
                    );
                });
            }
        }
        return _origJson(body);
    };
    next();
});

// 🛡️ RADAR DE RESPALDO CADA 5 SEGUNDOS + AVISO PREVENTIVO DE RETRASO A LOS 35 MINUTOS
let _tgRadarInitialized = false;
setInterval(async () => {
    try {
        const cfg = await obtenerConfigTelegramActiva();
        if (!cfg.enabled || !cfg.botToken || cfg.chatIds.length === 0) return;

        // En el primer arranque, registrar órdenes antiguas ya cerradas para no re-notificar historial viejo, pero SÍ notificar cualquier orden que esté ahorita mismo en Cola por Apartar (como #KZ-669095)
        if (!_tgRadarInitialized) {
            _tgRadarInitialized = true;
            const hace2Horas = new Date(Date.now() - 2 * 60 * 60 * 1000);
            const recientes = await Order.find({ fecha: { $gte: hace2Horas } }).select('orderId status claimedByWorker isWaitingBinanceAuto paidWithTokems approvedByWorker').lean();
            recientes.forEach(r => {
                const estaPorApartarAhora = (r.status === 'EN_PROCESO' && !r.claimedByWorker && !r.isWaitingBinanceAuto && !r.paidWithTokems);
                if (!estaPorApartarAhora) {
                    global._tgNotifiedOrdersSet.add(`${r.orderId}_NEW_QUEUE`);
                }
                if (r.approvedByWorker === 'AUTO-TOKEMS-API' || r.approvedByWorker === 'AUTO-BINANCE-PAY') {
                    global._tgNotifiedOrdersSet.add(`${r.orderId}_AUTO_SALE`);
                }
            });

            const ticketsRecientes = await SupportTicket.find({ createdAt: { $gte: hace2Horas } }).select('ticketId status').lean();
            ticketsRecientes.forEach(tk => {
                if (tk.status !== 'ABIERTO') {
                    global._tgNotifiedTicketsSet.add(tk.ticketId);
                }
            });
        }

        // 1. Verificar cualquier orden en Cola por Apartar de los últimos 30 minutos que aún no haya sido notificada
        const hace30Min = new Date(Date.now() - 30 * 60 * 1000);
        const porApartarAhora = await Order.find({
            status: 'EN_PROCESO',
            isWaitingBinanceAuto: { $ne: true },
            paidWithTokems: { $ne: true },
            $or: [{ claimedByWorker: '' }, { claimedByWorker: null }, { claimedByWorker: { $exists: false } }],
            fecha: { $gte: hace30Min }
        }).sort({ fecha: 1 }).limit(10).lean();

        for (const ord of porApartarAhora) {
            evaluarYDispararAlertaTelegramOrden(ord);
        }

        // 2. Aviso Preventivo de Retraso a los 35 Minutos (en horario operativo 11:00 AM a 11:00 PM Venezuela)
        if (cfg.notifyDelay35m) {
            const offsetVzlaMs = 4 * 60 * 60 * 1000;
            const ahoraVzla = new Date(Date.now() - offsetVzlaMs);
            const horaVzla = ahoraVzla.getUTCHours();

            if (horaVzla >= 11 && horaVzla < 23) {
                const hace35Min = new Date(Date.now() - 35 * 60 * 1000);
                const hace90Min = new Date(Date.now() - 90 * 60 * 1000);

                const demoradas = await Order.find({
                    status: { $in: ['EN_PROCESO', 'ERROR_API'] },
                    isWaitingBinanceAuto: { $ne: true },
                    timerStartedAt: { $lte: hace35Min, $gte: hace90Min }
                }).limit(10).lean();

                for (const ord of demoradas) {
                    const keyAlert = `${ord.orderId}_c${ord.waitCyclesCount || 0}`;
                    if (_telegramPreventiveAlertSentSet.has(keyAlert)) continue;
                    _telegramPreventiveAlertSentSet.add(keyAlert);

                    const minTranscurridos = Math.round((Date.now() - new Date(ord.timerStartedAt || ord.fecha).getTime()) / 60000);
                    const estadoMesa = ord.claimedByWorker
                        ? `📌 Apartada por: <b>${escaparHtmlTelegram(ord.claimedByName || ord.claimedByWorker)}</b>`
                        : `📥 <b>¡SIN APARTAR EN LA COLA!</b>`;

                    const html = [
                        `⏰ <b>¡AVISO PREVENTIVO: ORDEN LLEVA ${minTranscurridos} MIN EN ESPERA!</b> ⚠️`,
                        `<i>Faltan ~${Math.max(1, 60 - minTranscurridos)} min para que se cumpla la hora del cliente.</i>`,
                        ``,
                        `🧾 <b>Orden:</b> <code>#${escaparHtmlTelegram(ord.orderId)}</code>`,
                        `👷 <b>Situación:</b> ${estadoMesa}`,
                        `🎮 <b>Producto:</b> <b>${escaparHtmlTelegram(ord.productName)} (${escaparHtmlTelegram(ord.packageName)})</b>`,
                        `💳 <b>Método:</b> ${escaparHtmlTelegram(ord.paymentMethodName)} • Ref: <code>${escaparHtmlTelegram(ord.paymentReference || 'N/A')}</code>`,
                        `💰 <b>Monto:</b> <code>Bs. ${Number(ord.totalAmountVES || 0).toFixed(2)}</code>`,
                        `🆔 <b>Destino:</b> <code>${escaparHtmlTelegram(ord.playerUid)}</code>`
                    ].join('\n');

                    await enviarMensajeTelegramKZ(html, armarBotonesTelegramParaOrden(ord), cfg);
                }
            }
        }
    } catch (e) {}
}, 5000);

// 🔍 ENDPOINT 1: Auto-Detectar el Chat ID o Grupo ID en 1 Clic después de escribirle "hola" al Bot
app.post('/api/admin/telegram/detect-chat', verificarSoloAdmin, async (req, res) => {
    try {
        const { botToken } = req.body;
        let settings = await StoreSettings.findOne({ key: 'main_settings' }).select('telegramConfig');
        const prevCfg = (settings && settings.telegramConfig && typeof settings.telegramConfig === 'object')
            ? settings.telegramConfig
            : {};

        const tokenUsar = (botToken && !String(botToken).includes('•') && String(botToken).trim().length > 15)
            ? String(botToken).trim()
            : String(prevCfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '').trim();

        if (!tokenUsar) {
            return res.status(400).json({ error: 'Primero pega el Token de tu Bot de Telegram (el que te dio @BotFather).' });
        }

        const [resMe, resUpdates] = await Promise.all([
            axios.get(`https://api.telegram.org/bot${tokenUsar}/getMe`, { timeout: 8000 }),
            axios.get(`https://api.telegram.org/bot${tokenUsar}/getUpdates?limit=30`, { timeout: 8000 })
        ]);

        const botInfo = resMe.data?.result || {};
        const updates = Array.isArray(resUpdates.data?.result) ? resUpdates.data.result : [];

        const chatsDetectadosMap = new Map();
        for (let i = updates.length - 1; i >= 0; i--) {
            const u = updates[i];
            const msg = u.message || u.channel_post || u.my_chat_member || u.edited_message;
            const chat = msg?.chat;
            if (chat && chat.id) {
                const cidStr = String(chat.id);
                if (!chatsDetectadosMap.has(cidStr)) {
                    const label = chat.title
                        ? `👥 Grupo/Canal: ${chat.title} (${cidStr})`
                        : `👤 Chat Personal: ${[chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Usuario'} (${cidStr})`;
                    chatsDetectadosMap.set(cidStr, { id: cidStr, label, type: chat.type });
                }
            }
        }

        const chatsList = Array.from(chatsDetectadosMap.values());
        if (chatsList.length === 0) {
            return res.status(404).json({
                error: `Conectado al bot @${botInfo.username || 'tu_bot'}, pero aún no hay mensajes recientes. Abre tu bot @${botInfo.username || ''} en Telegram (o mételo a tu grupo), envíale la palabra "hola" y vuelve a tocar este botón.`
            });
        }

        return res.json({
            success: true,
            botUsername: botInfo.username || '',
            botName: botInfo.first_name || '',
            detectedChats: chatsList,
            recommendedChatId: chatsList.map(c => c.id).join(', ')
        });
    } catch (error) {
        const desc = error.response?.data?.description || error.message;
        return res.status(400).json({ error: `Token de Telegram inválido o error de conexión: ${desc}` });
    }
});

// 💾 ENDPOINT 2: Guardar Configuración de Telegram en MongoDB y Enviar Alerta de Prueba
app.post('/api/admin/telegram/config', verificarSoloAdmin, async (req, res) => {
    try {
        const {
            enabled,
            botToken,
            chatId,
            notifyNewOrders,
            notifyAutoSales,
            notifyTickets,
            notifyDelay35m,
            sendTest
        } = req.body;

        const stExistente = await StoreSettings.findOne({ key: 'main_settings' }).select('telegramConfig').lean();
        const prevCfg = (stExistente && stExistente.telegramConfig && typeof stExistente.telegramConfig === 'object')
            ? { ...stExistente.telegramConfig }
            : {};

        if (typeof enabled === 'boolean') prevCfg.enabled = enabled;
        if (botToken && !String(botToken).includes('•') && String(botToken).trim().length > 15) {
            prevCfg.botToken = String(botToken).trim();
        }
        if (chatId !== undefined) {
            prevCfg.chatId = String(chatId || '').trim();
        }
        if (typeof notifyNewOrders === 'boolean') prevCfg.notifyNewOrders = notifyNewOrders;
        if (typeof notifyAutoSales === 'boolean') prevCfg.notifyAutoSales = notifyAutoSales;
        if (typeof notifyTickets === 'boolean') prevCfg.notifyTickets = notifyTickets;
        if (typeof notifyDelay35m === 'boolean') prevCfg.notifyDelay35m = notifyDelay35m;

        await StoreSettings.collection.updateOne(
            { key: 'main_settings' },
            { $set: { telegramConfig: prevCfg } },
            { upsert: true }
        );

        let testResult = null;
        if (sendTest) {
            const cfgActiva = await obtenerConfigTelegramActiva({ telegramConfig: prevCfg });
            const htmlPrueba = [
                `🟢 <b>¡BOT DE ALERTAS KEM!ZONE CONECTADO CON ÉXITO!</b> 🔥`,
                ``,
                `A partir de este momento recibirás aquí en <b>0.2 segundos</b>:`,
                `${cfgActiva.notifyNewOrders ? '✅' : '⚪'} 📥 <b>Nuevas Órdenes en Cola por Apartar</b> (Pago Móvil / PayPal)`,
                `${cfgActiva.notifyAutoSales ? '✅' : '⚪'} 🟡 <b>Ventas Automáticas 24/7</b> (Binance Pay y Tokems KZ)`,
                `${cfgActiva.notifyTickets ? '✅' : '⚪'} 🎫 <b>Nuevos Tickets de Soporte y WhatsApp en Revisión</b>`,
                `${cfgActiva.notifyDelay35m ? '✅' : '⚪'} ⏰ <b>Aviso Preventivo de Retraso</b> (a los 35 min en cola)`,
                ``,
                `🌐 <b>Tienda:</b> kemzone07.com`
            ].join('\n');

            testResult = await enviarMensajeTelegramKZ(htmlPrueba, [
                [
                    { text: '📋 Abrir Cola (Staff)', url: 'https://kemzone07.com/DashWork' },
                    { text: '👑 Dashwork Dueño', url: 'https://kemzone07.com/DashworkDueno' }
                ]
            ], cfgActiva);
        }

        return res.json({
            success: true,
            testOk: testResult ? testResult.ok : true,
            testError: testResult ? testResult.error : '',
            config: {
                enabled: prevCfg.enabled !== false,
                hasBotToken: Boolean(prevCfg.botToken || process.env.TELEGRAM_BOT_TOKEN),
                chatId: prevCfg.chatId || '',
                notifyNewOrders: prevCfg.notifyNewOrders !== false,
                notifyAutoSales: prevCfg.notifyAutoSales !== false,
                notifyTickets: prevCfg.notifyTickets !== false,
                notifyDelay35m: prevCfg.notifyDelay35m !== false
            }
        });
    } catch (error) {
        return res.status(500).json({ error: 'Error guardando configuración de Telegram.' });
    }
});

// =================================================================
// 🟢 RADAR EN MEMORIA RAM DE VISITANTES EN LÍNEA AHORA MISMO EN LA TIENDA
// =================================================================
const _ramOnlineVisitorsMap = new Map();
const VISITOR_TTL_MS = 75 * 1000; // 75 segundos de ventana activa en vivo

function limpiarYObtenerVisitantesEnLineaAhora() {
    const ahora = Date.now();
    for (const [vid, ts] of _ramOnlineVisitorsMap.entries()) {
        if (ahora - ts > VISITOR_TTL_MS) {
            _ramOnlineVisitorsMap.delete(vid);
        }
    }
    return _ramOnlineVisitorsMap.size;
}

// Endpoint ultraligero en RAM (0 escrituras en BD) para registrar visitantes reales con la tienda abierta
app.post('/api/store/ping', (req, res) => {
    try {
        const { visitorId, inDashboard, leave } = req.body || {};
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
        const key = String(visitorId || ip || '').trim().toLowerCase();

        if (key) {
            if (leave || inDashboard) {
                _ramOnlineVisitorsMap.delete(key);
            } else {
                _ramOnlineVisitorsMap.set(key, Date.now());
            }
        }
        return res.json({ onlineNow: limpiarYObtenerVisitantesEnLineaAhora() });
    } catch (e) {
        return res.json({ onlineNow: 0 });
    }
});

// Inyectar automáticamente onlineVisitorsNow en /api/admin/overview y /api/worker/queue
app.use(['/api/admin/overview', '/api/worker/queue'], (req, res, next) => {
    const _origJson = res.json.bind(res);
    res.json = function(body) {
        if (body && typeof body === 'object') {
            const countOnline = limpiarYObtenerVisitantesEnLineaAhora();
            body.onlineVisitorsNow = countOnline;
            if (body.analytics && typeof body.analytics === 'object') {
                body.analytics.onlineVisitorsNow = countOnline;
            }
        }
        return _origJson(body);
    };
    next();
});

// 🏦 RESCATADOR AUTOMÁTICO DE CÓDIGOS SUELTOS + FILTRO ESTRICTO POR FIRMA KEM!ZONE (PROTEGE COMPRAS DIRECTAS DE WHATSAPP)
// =================================================================
let _autoRescueInFlight = false;

async function ejecutarRescateYCorreccionCodigosSueltosCentralOne({ mode = 'AUTO_SCAN', orderQuery = '', isBackgroundAuto = false } = {}) {
    if (_autoRescueInFlight && isBackgroundAuto) {
        return { success: true, skipped: true };
    }
    _autoRescueInFlight = true;

    try {
        const headers = obtenerHeadersCentralOne();
        if (!headers) {
            return { success: false, error: 'Falta configurar CENTRAL_ONE_API_KEY en Railway.' };
        }

        const settings = await StoreSettings.findOne({ key: 'main_settings' });
        if (!settings) {
            return { success: false, error: 'Configuración de tienda no encontrada.' };
        }
        if (!Array.isArray(settings.arbitrageBaseCards)) settings.arbitrageBaseCards = [];

        // 1. Obtener todas las órdenes de Kem!Zone para mapear códigos ya entregados y los IDs de Central One creados por Kem!Zone
        const [ordenesKzTodas, productosTodos] = await Promise.all([
            Order.find({
                $or: [
                    { apiOrderId: { $nin: ['', null] } },
                    { deliveredCode: { $nin: ['', null] } },
                    { 'algoExecutionState.deliveredCodesList.0': { $exists: true } },
                    { status: 'EJECUTANDO_API' },
                    { status: 'EN_PROCESO' }
                ]
            }).select('orderId status fecha apiOrderId deliveredCode cancelledByDelayRefund algoExecutionState').lean(),
            CatalogProduct.collection.find(
                {},
                { projection: { 'packages.backupPinVault': 1, 'altPackages.backupPinVault': 1 } }
            ).toArray()
        ]);

        const codigosEntregadosAClientesSet = new Set();
        const coOrderIdsEnEjecucionActivaSet = new Set();
        const coIdsVinculadosAKemZoneSet = new Set();

        (ordenesKzTodas || []).forEach(o => {
            const apiIdClean = String(o.apiOrderId || '').trim();
            if (apiIdClean && !apiIdClean.startsWith('VAULT-') && !apiIdClean.startsWith('INTERNAL-') && !apiIdClean.startsWith('MANUAL-') && !apiIdClean.startsWith('API-')) {
                coIdsVinculadosAKemZoneSet.add(apiIdClean);
            }
            const partialIds = o.algoExecutionState?.processedPartialOrderIds;
            if (Array.isArray(partialIds)) {
                partialIds.forEach(pid => {
                    if (pid) coIdsVinculadosAKemZoneSet.add(String(pid).trim());
                });
            }

            if ((o.status === 'EJECUTANDO_API' || o.status === 'EN_PROCESO') && apiIdClean) {
                coOrderIdsEnEjecucionActivaSet.add(apiIdClean);
            }

            if (o.deliveredCode) {
                String(o.deliveredCode).split(/\s*\|\s*|\r?\n/).forEach(c => {
                    const k = extraerCodigoCrudoDeTextoFormateado(c);
                    if (k && k.length >= 4) codigosEntregadosAClientesSet.add(k);
                });
            }

            const listaAlgo = o.algoExecutionState?.deliveredCodesList;
            if (Array.isArray(listaAlgo) && o.status !== 'RECHAZADO') {
                listaAlgo.forEach(c => {
                    const k = extraerCodigoCrudoDeTextoFormateado(c);
                    if (k && k.length >= 4) codigosEntregadosAClientesSet.add(k);
                });
            }
        });

        // 🛡️ DETECTOR DE HUELLA DIGITAL KEM!ZONE:
        // Devuelve true SOLO si el pedido de Central One fue disparado por Kem!Zone (tiene kz-ord-, nota KemZone #KZ-... o está en MongoDB)
        const tieneHuellaDigitalKemZone = (coObj, fallbackId = '') => {
            const idCheck = String(coObj?.id || fallbackId || '').trim();
            const refCheck = String(coObj?.reference_code || '').trim();
            if ((idCheck && coIdsVinculadosAKemZoneSet.has(idCheck)) || (refCheck && coIdsVinculadosAKemZoneSet.has(refCheck))) {
                return true;
            }
            const idemp = String(coObj?.idempotency_key || coObj?.idempotencyKey || '').trim();
            if (idemp.startsWith('kz-ord-') || /KZ-\d{6}/i.test(idemp)) {
                return true;
            }
            const nota = String(coObj?.note || coObj?.notes || coObj?.customer_reference || '').trim();
            if (/KemZone\s*(Faltante)?\s*#?KZ-/i.test(nota) || /#KZ-\d{6}/i.test(nota)) {
                return true;
            }
            return false;
        };

        // 2. Mapear en qué tarjeta de tu Stock Propio está guardado cada código actualmente
        const mapaCodigoATarjetaActual = new Map();
        settings.arbitrageBaseCards.forEach(card => {
            if (!Array.isArray(card.internalCodeStock)) card.internalCodeStock = [];
            card.internalCodeStock.forEach(c => {
                const k = extraerCodigoCrudoDeTextoFormateado(c);
                if (k) mapaCodigoATarjetaActual.set(k, card);
            });
        });

        const codigosEnBovedaPaquetesSet = new Set();
        (productosTodos || []).forEach(p => {
            [...(p.packages || []), ...(p.altPackages || [])].forEach(pk => {
                (pk.backupPinVault || []).forEach(c => {
                    const k = extraerCodigoCrudoDeTextoFormateado(c);
                    if (k) codigosEnBovedaPaquetesSet.add(k);
                });
            });
        });

        // 3. Resolver qué pedidos de Central One vamos a inspeccionar
        const coOrdersToInspect = [];
        const vistosCoId = new Set();
        let ignoradosPortalDirectoCount = 0;

        const agregarCoOrder = (id, ref = '', confirmedKzOrigin = false) => {
            const cleanId = String(id || '').trim();
            if (!cleanId || cleanId.startsWith('VAULT-') || cleanId.startsWith('INTERNAL-') || cleanId.startsWith('MANUAL-') || cleanId.startsWith('API-') || cleanId.startsWith('kz-ord-')) {
                return;
            }
            if (!vistosCoId.has(cleanId)) {
                vistosCoId.add(cleanId);
                coOrdersToInspect.push({
                    id: cleanId,
                    reference_code: ref || cleanId,
                    confirmedKzOrigin: Boolean(confirmedKzOrigin || coIdsVinculadosAKemZoneSet.has(cleanId))
                });
            }
        };

        if (mode === 'BY_ORDER') {
            // Modo Manual Explícito: Cuando tú pegas un C1-... a propósito en la casilla para meterlo a tu Stock Propio
            const qRaw = String(orderQuery || '').trim().replace(/^#/, '');
            if (!qRaw) {
                return { success: false, statusHttp: 400, error: 'Ingresa la referencia (ej: C1-1MH168R3 o CO-ORD-...) o UUID del pedido.' };
            }

            const ordKz = await Order.findOne({
                $or: [
                    { orderId: qRaw.toUpperCase() },
                    { orderId: `KZ-${qRaw.toUpperCase()}` },
                    { apiOrderId: qRaw }
                ]
            }).select('orderId apiOrderId').lean();

            if (ordKz && ordKz.apiOrderId) {
                agregarCoOrder(ordKz.apiOrderId, ordKz.orderId, true);
            }

            if (coOrdersToInspect.length === 0) {
                const qUp = qRaw.toUpperCase();
                if (qUp.startsWith('C1-') || qUp.startsWith('CO-ORD-')) {
                    try {
                        const resList = await axios.get(`${CENTRAL_ONE_BASE_URL}/orders?limit=60`, { headers, timeout: 12000 });
                        const itemsList = resList.data?.orders || resList.data?.items || resList.data?.data || [];
                        const matchRef = itemsList.find(x => String(x.reference_code || '').trim().toUpperCase() === qUp);
                        if (matchRef && matchRef.id) {
                            agregarCoOrder(matchRef.id, matchRef.reference_code, true);
                        }
                    } catch (eList) {}
                } else {
                    agregarCoOrder(qRaw, qRaw, true);
                }
            }

            if (coOrdersToInspect.length === 0) {
                return {
                    success: false,
                    statusHttp: 404,
                    error: `No encontramos ningún pedido en Central One con la referencia "${qRaw}".`
                };
            }
        } else {
            // 🔒 MODO AUTO_SCAN: Primero revisa órdenes candidatas de MongoDB (canceladas tras 1h, entregadas manual mientras estaban en Recibida, o con entregas parciales)
            (ordenesKzTodas || []).forEach(o => {
                const apiId = String(o.apiOrderId || '').trim();
                if (!apiId || coOrderIdsEnEjecucionActivaSet.has(apiId)) return;
                const esCandidataRescate = (
                    o.status === 'RECHAZADO' ||
                    o.cancelledByDelayRefund === true ||
                    o.algoExecutionState?.manuallyCompletedWhilePendingCO === true ||
                    (Array.isArray(o.algoExecutionState?.processedPartialOrderIds) && o.algoExecutionState.processedPartialOrderIds.length > 0)
                );
                if (esCandidataRescate) {
                    agregarCoOrder(apiId, o.orderId, true);
                    (o.algoExecutionState?.processedPartialOrderIds || []).forEach(pid => {
                        if (pid && !coOrderIdsEnEjecucionActivaSet.has(String(pid).trim())) {
                            agregarCoOrder(pid, o.orderId, true);
                        }
                    });
                }
            });

            // Segundo: Revisa los últimos 30 pedidos de Central One, pero SOLO acepta los que tengan la Huella Digital de Kem!Zone
            try {
                const resList = await axios.get(`${CENTRAL_ONE_BASE_URL}/orders?limit=30`, { headers, timeout: 12000 });
                const itemsList = resList.data?.orders || resList.data?.items || resList.data?.data || [];
                const ahoraMs = Date.now();

                itemsList.forEach(coOrd => {
                    const st = String(coOrd.status || '').toLowerCase();
                    if ((st !== 'completed' && st !== 'partially_completed') || !coOrd.id) return;
                    if (coOrderIdsEnEjecucionActivaSet.has(coOrd.id)) return;

                    if (isBackgroundAuto && coOrd.created_at) {
                        const edadMs = ahoraMs - new Date(coOrd.created_at).getTime();
                        if (edadMs >= 0 && edadMs < 3 * 60 * 1000) return;
                    }

                    const vieneConFirmaEnLista = tieneHuellaDigitalKemZone(coOrd, coOrd.id);
                    const listadoTraeMetadatos = (
                        coOrd.note !== undefined ||
                        coOrd.notes !== undefined ||
                        coOrd.idempotency_key !== undefined ||
                        coOrd.idempotencyKey !== undefined
                    );

                    if (vieneConFirmaEnLista) {
                        agregarCoOrder(coOrd.id, coOrd.reference_code || coOrd.id, true);
                    } else if (listadoTraeMetadatos) {
                        // El listado ya trajo nota/idempotency_key y NO tiene firma de Kem!Zone -> Es compra directa tuya en el portal para WhatsApp
                        ignoradosPortalDirectoCount++;
                    } else {
                        // Si el listado resumido no incluía el campo note/idempotency_key, lo marcamos como false para verificar su firma al pedir el detalle GET /orders/:id
                        agregarCoOrder(coOrd.id, coOrd.reference_code || coOrd.id, false);
                    }
                });
            } catch (eList) {}
        }

        let totalRescatados = 0;
        let totalReubicados = 0;
        let yaEntregadosCount = 0;
        let yaEnStockCount = 0;
        const desgloseRescatados = [];
        const sinTarjetaMatch = [];

        const lotesInspeccion = coOrdersToInspect.slice(0, isBackgroundAuto ? 15 : 25);

        for (const coTarget of lotesInspeccion) {
            try {
                const check = await verificarYExtraerEntregaCentralOne(
                    coTarget.id,
                    headers,
                    settings.arbitrageBaseCards,
                    false,
                    0,
                    null
                );

                if (!check) continue;

                // 🔒 DOBLE CANDADO EN DETALLE COMPLETO (GET /orders/:id):
                // Si estamos en AUTO_SCAN y al ver el detalle completo del pedido en Central One NO tiene firma de Kem!Zone, lo ignoramos por completo
                if (mode !== 'BY_ORDER' && !coTarget.confirmedKzOrigin && !tieneHuellaDigitalKemZone(check.raw, coTarget.id)) {
                    ignoradosPortalDirectoCount++;
                    continue;
                }

                if (!Array.isArray(check.codigosPorItem) || check.codigosPorItem.length === 0) {
                    continue;
                }

                for (const itemCode of check.codigosPorItem) {
                    const textoItemCO = `${itemCode.name || ''} ${itemCode.sku || ''}`;
                    const platRealCO = detectarPlataformaDeTextoCentralOne(textoItemCO);
                    const montoFacialCO = extraerNumeroFacialDeTextoServer(textoItemCO) || Number(itemCode.unitClientUSD || 0);

                    const metaMatch = emparejarItemCentralOneConMetaKZ(
                        {
                            catalog_item_id: itemCode.catalogItemId || '',
                            sku: itemCode.sku || '',
                            product_name: itemCode.name || '',
                            unit_price: itemCode.unitCostUSD || 0
                        },
                        -1,
                        [],
                        settings.arbitrageBaseCards
                    );

                    let cPool = settings.arbitrageBaseCards.find(c => {
                        if (platRealCO && String(c.platformGroup || '').toLowerCase() !== platRealCO) return false;
                        if (itemCode.cardId && c.cardId === itemCode.cardId) return true;
                        if (metaMatch && metaMatch.cardId && c.cardId === metaMatch.cardId) return true;
                        if (itemCode.catalogItemId && String(c.centralOneProductId || '').trim() === String(itemCode.catalogItemId).trim()) return true;
                        if (itemCode.sku && String(c.centralOneSku || '').trim().toUpperCase() === String(itemCode.sku).trim().toUpperCase()) return true;
                        return false;
                    });

                    if (!cPool && platRealCO && montoFacialCO > 0) {
                        cPool = settings.arbitrageBaseCards.find(c =>
                            String(c.platformGroup || '').toLowerCase() === platRealCO &&
                            (Math.abs(Number(c.effectiveClientUSD || 0) - montoFacialCO) <= 0.35 ||
                             Math.abs(Number(c.faceValueOrigin || 0) - montoFacialCO) <= 0.35)
                        );
                    }

                    const listaCruda = Array.isArray(itemCode.rawCodes) && itemCode.rawCodes.length > 0
                        ? itemCode.rawCodes
                        : (Array.isArray(itemCode.codes) ? itemCode.codes : []);

                    for (const rawC of listaCruda) {
                        const limpio = rawC.includes('➔') ? rawC.split('➔').slice(1).join('➔').trim() : String(rawC || '').trim();
                        const clave = extraerCodigoCrudoDeTextoFormateado(limpio);
                        if (!limpio || !clave) continue;

                        if (codigosEntregadosAClientesSet.has(clave)) {
                            yaEntregadosCount++;
                            continue;
                        }
                        if (codigosEnBovedaPaquetesSet.has(clave)) {
                            yaEnStockCount++;
                            continue;
                        }

                        const tarjetaDondeEstaAhora = mapaCodigoATarjetaActual.get(clave);

                        if (tarjetaDondeEstaAhora) {
                            if (cPool && tarjetaDondeEstaAhora.cardId !== cPool.cardId) {
                                tarjetaDondeEstaAhora.internalCodeStock = (tarjetaDondeEstaAhora.internalCodeStock || []).filter(
                                    x => extraerCodigoCrudoDeTextoFormateado(x) !== clave
                                );
                                if (!Array.isArray(cPool.internalCodeStock)) cPool.internalCodeStock = [];
                                if (!cPool.internalCodeStock.some(x => extraerCodigoCrudoDeTextoFormateado(x) === clave)) {
                                    cPool.internalCodeStock.push(limpio);
                                }
                                mapaCodigoATarjetaActual.set(clave, cPool);
                                totalReubicados++;
                                desgloseRescatados.push(`<li>🔄 <b>Reubicado de [${tarjetaDondeEstaAhora.name}] ➔ [${cPool.name} (${(cPool.platformGroup || '').toUpperCase()})]</b>: <code style="color:#00e5ff; font-weight:900;">${limpio}</code></li>`);
                            } else {
                                yaEnStockCount++;
                            }
                            continue;
                        }

                        if (cPool) {
                            if (!Array.isArray(cPool.internalCodeStock)) cPool.internalCodeStock = [];
                            cPool.internalCodeStock.push(limpio);
                            mapaCodigoATarjetaActual.set(clave, cPool);
                            totalRescatados++;
                            desgloseRescatados.push(`<li><b>[${(cPool.platformGroup || '').toUpperCase()}] ${cPool.name}</b> (${check.referenceCode || coTarget.reference_code}): <code style="color:#00e676; font-weight:900;">${limpio}</code></li>`);
                        } else {
                            sinTarjetaMatch.push(`<li><b>${itemCode.name || itemCode.sku || 'Tarjeta no vinculada'}</b> (${check.referenceCode || coTarget.reference_code}): <code style="color:#ffb700; font-weight:900;">${limpio}</code> <i>(Importa primero esta tarjeta base a la Bóveda para asignarlo)</i></li>`);
                        }
                    }
                }
            } catch (eOrder) {}
        }

        if (totalRescatados > 0 || totalReubicados > 0) {
            settings.markModified('arbitrageBaseCards');
            await registrarAlertaCentralOne(settings, {
                type: 'BACK_IN_STOCK',
                severity: 'OK',
                title: `🏦 Stock Propio actualizado: +${totalRescatados} rescatado(s) de Kem!Zone${totalReubicados > 0 ? ` y ${totalReubicados} reubicado(s)` : ''}`,
                detail: `Se sincronizaron automáticamente en tu Inventario de Stock Propio (ignorando compras directas de portal).`
            });

            await StoreSettings.collection.updateOne(
                { key: 'main_settings' },
                {
                    $set: {
                        arbitrageBaseCards: settings.arbitrageBaseCards.map(c => (c.toObject ? c.toObject() : c)),
                        centralOneAlerts: settings.centralOneAlerts
                    }
                }
            );

            if (typeof _ramFastSettingsTs !== 'undefined') _ramFastSettingsTs = 0;
            if (typeof _ramBootstrapPayload !== 'undefined') _ramBootstrapPayload = null;
            if (typeof _ramBootstrapTs !== 'undefined') _ramBootstrapTs = 0;

            setImmediate(() => {
                recalcularPreciosYAlgoritmoTiendaKZ().catch(() => {});
            });
        }

        const notaProteccionPortal = ignoradosPortalDirectoCount > 0
            ? `<div style="margin-top:6px; font-size:0.74rem; color:#00e5ff;">🛡️ <b>Protección WhatsApp Activa:</b> Se ignoraron <b>${ignoradosPortalDirectoCount}</b> pedido(s) comprados directamente en el portal de Central One (sin firma de Kem!Zone) para no tocar códigos de tus clientes de WhatsApp.</div>`
            : '';

        let summaryHtml = '';
        if (totalRescatados > 0 || totalReubicados > 0) {
            summaryHtml = `
                <strong style="color:#00e676; display:block; margin-bottom:4px;">
                    ✅ ¡Stock Propio sincronizado! (${totalRescatados} nuevo(s) de Kem!Zone rescatado(s)${totalReubicados > 0 ? `, ${totalReubicados} movido(s) a su plataforma correcta` : ''}):
                </strong>
                <ul style="margin:0; padding-left:18px;">${desgloseRescatados.join('')}</ul>
                ${sinTarjetaMatch.length > 0 ? `<div style="margin-top:6px; color:#ffb700;">⚠️ Códigos de tarjetas que aún no tienes creadas en la Bóveda:<ul style="margin:2px 0 0 0; padding-left:18px;">${sinTarjetaMatch.join('')}</ul></div>` : ''}
                ${notaProteccionPortal}
            `;
        } else if (sinTarjetaMatch.length > 0) {
            summaryHtml = `
                <strong style="color:#ffb700; display:block; margin-bottom:4px;">⚠️ Se encontraron ${sinTarjetaMatch.length} código(s) sueltos de Kem!Zone, pero esa tarjeta aún no está agregada en tu Bóveda:</strong>
                <ul style="margin:0; padding-left:18px;">${sinTarjetaMatch.join('')}</ul>
                ${notaProteccionPortal}
            `;
        } else {
            summaryHtml = `
                <span style="color:#cbd5e1;">
                    🔎 Escaneo completado: <b>0 códigos sueltos pendientes de Kem!Zone</b>
                    ${yaEntregadosCount > 0 ? ` • <b>${yaEntregadosCount}</b> ya entregados a clientes` : ''}
                    ${yaEnStockCount > 0 ? ` • <b>${yaEnStockCount}</b> ya en tu Stock Propio` : ''}.
                </span>
                ${notaProteccionPortal}
            `;
        }

        return {
            success: true,
            recoveredCount: totalRescatados + totalReubicados,
            alreadyDeliveredCount: yaEntregadosCount,
            alreadyInStockCount: yaEnStockCount,
            ignoredPortalDirectCount: ignoradosPortalDirectoCount,
            arbitrageBaseCards: settings.arbitrageBaseCards,
            summaryHtml,
            message: (totalRescatados + totalReubicados) > 0
                ? `Se actualizaron +${totalRescatados + totalReubicados} código(s) de Kem!Zone en tu Stock Propio.`
                : `Sin códigos sueltos de Kem!Zone pendientes (${ignoradosPortalDirectoCount} compras directas de portal ignoradas).`
        };
    } catch (error) {
        console.error('Error en ejecutarRescateYCorreccionCodigosSueltosCentralOne:', error);
        return { success: false, statusHttp: 500, error: 'Error al escanear códigos sueltos en Central One.' };
    } finally {
        _autoRescueInFlight = false;
    }
}

app.post('/api/admin/central-one/recover-loose-codes', verificarSoloAdmin, async (req, res) => {
    const { mode = 'AUTO_SCAN', orderQuery = '' } = req.body || {};
    const resultado = await ejecutarRescateYCorreccionCodigosSueltosCentralOne({
        mode,
        orderQuery,
        isBackgroundAuto: false
    });
    if (!resultado.success) {
        return res.status(resultado.statusHttp || 500).json({ error: resultado.error || 'Error en rescate.' });
    }
    return res.json(resultado);
});

// 🔄 Barrido automático en segundo plano: solo rescata órdenes con huella digital de Kem!Zone
setTimeout(() => {
    if (process.env.CENTRAL_ONE_API_KEY) {
        ejecutarRescateYCorreccionCodigosSueltosCentralOne({ mode: 'AUTO_SCAN', isBackgroundAuto: true }).catch(() => {});
    }
}, 14000);

setInterval(() => {
    if (process.env.CENTRAL_ONE_API_KEY) {
        ejecutarRescateYCorreccionCodigosSueltosCentralOne({ mode: 'AUTO_SCAN', isBackgroundAuto: true }).catch(() => {});
    }
}, 90 * 1000);

// =================================================================
// 🌙 MOTOR DE HORARIO OPERATIVO PERSONALIZABLE EN SERVIDOR (VERIFICADOR Y TURNO)
// =================================================================
StoreSettings.schema.add({
    scheduleConfig: { type: mongoose.Schema.Types.Mixed, default: null }
});

let _ramScheduleConfig = null;

setTimeout(async () => {
    try {
        const docSch = await StoreSettings.collection.findOne(
            { key: 'main_settings' },
            { projection: { scheduleConfig: 1 } }
        );
        if (docSch && docSch.scheduleConfig) {
            _ramScheduleConfig = docSch.scheduleConfig;
        }
    } catch (e) {}
}, 1800);

function formatearHora24a12AMPMServer(time24Str) {
    const partes = String(time24Str || '11:00').trim().split(':');
    let h = parseInt(partes[0], 10);
    const m = parseInt(partes[1] || '0', 10);
    if (isNaN(h)) h = 11;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : (h % 12);
    const mStr = String(isNaN(m) ? 0 : m).padStart(2, '0');
    return `${h12}:${mStr} ${ampm}`;
}

function calcularEstadoHorarioVenezuelaServer(scheduleConfig = null) {
    const raw = scheduleConfig || _ramScheduleConfig || {};
    const mode = ['AUTO', 'FORCE_OPEN', 'FORCE_OFFHOURS'].includes(raw.mode) ? raw.mode : 'AUTO';
    const openTime = /^\d{2}:\d{2}$/.test(String(raw.openTime || '').trim()) ? String(raw.openTime).trim() : '11:00';
    const closeTime = /^\d{2}:\d{2}$/.test(String(raw.closeTime || '').trim()) ? String(raw.closeTime).trim() : '23:00';

    const ahoraUtcMs = Date.now();
    const offsetVzlaMs = 4 * 60 * 60 * 1000; // UTC-4 Venezuela
    const fechaVzla = new Date(ahoraUtcMs - offsetVzlaMs);

    const anioVzla = fechaVzla.getUTCFullYear();
    const mesVzla = fechaVzla.getUTCMonth();
    const diaVzla = fechaVzla.getUTCDate();
    const horaVzla = fechaVzla.getUTCHours();
    const minVzla = fechaVzla.getUTCMinutes();

    const [openH, openM] = openTime.split(':').map(Number);
    const [closeH, closeM] = closeTime.split(':').map(Number);

    const openMinDia = (openH * 60) + (openM || 0);
    const closeMinDia = (closeH * 60) + (closeM || 0);
    const actualMinDia = (horaVzla * 60) + minVzla;

    let enHorarioPorReloj = true;
    if (openMinDia < closeMinDia) {
        enHorarioPorReloj = (actualMinDia >= openMinDia && actualMinDia < closeMinDia);
    } else if (openMinDia > closeMinDia) {
        enHorarioPorReloj = (actualMinDia >= openMinDia || actualMinDia < closeMinDia);
    }

    let fueraDeHorario = !enHorarioPorReloj;
    if (mode === 'FORCE_OPEN') fueraDeHorario = false;
    else if (mode === 'FORCE_OFFHOURS') fueraDeHorario = true;

    const aperturaHoyUtcMs = Date.UTC(anioVzla, mesVzla, diaVzla, openH, openM || 0, 0, 0) + offsetVzlaMs;
    let proximaAperturaUtcMs = aperturaHoyUtcMs;
    if (actualMinDia >= openMinDia) {
        proximaAperturaUtcMs += 24 * 60 * 60 * 1000;
    }

    return {
        fueraDeHorario,
        mode,
        openTime,
        closeTime,
        openTimeFormatted: formatearHora24a12AMPMServer(openTime),
        closeTimeFormatted: formatearHora24a12AMPMServer(closeTime),
        aperturaHoyUtcMs,
        proximaAperturaUtcMs
    };
}

// Aplicar automáticamente el horario personalizado a toda nueva orden que se cree en la tienda
Order.schema.pre('save', function(next) {
    try {
        if (this.isNew && this.status === 'EN_PROCESO' && !this.isWaitingBinanceAuto) {
            const infoH = calcularEstadoHorarioVenezuelaServer(_ramScheduleConfig);
            if (infoH.fueraDeHorario) {
                this.timerStartedAt = new Date(infoH.proximaAperturaUtcMs);
                this.statusMessage = `🌙 Compra registrada fuera de horario. Tu pedido está asegurado en cola prioritaria y se entregará a partir de las ${infoH.openTimeFormatted}.`;
            } else {
                this.timerStartedAt = new Date();
                this.statusMessage = 'Tu orden está en proceso. Un operador está verificando tu referencia de pago...';
            }
        }
    } catch (e) {}
    if (typeof next === 'function') next();
});

// Endpoint para guardar el Horario Operativo desde "Verificador y Turno" (Trabajador o Dueño)
app.post('/api/worker/schedule-config', verificarTrabajadorOAdmin, async (req, res) => {
    try {
        const { mode, openTime, closeTime } = req.body || {};
        const nuevoConfig = {
            mode: ['AUTO', 'FORCE_OPEN', 'FORCE_OFFHOURS'].includes(mode) ? mode : 'AUTO',
            openTime: /^\d{2}:\d{2}$/.test(String(openTime || '').trim()) ? String(openTime).trim() : '11:00',
            closeTime: /^\d{2}:\d{2}$/.test(String(closeTime || '').trim()) ? String(closeTime).trim() : '23:00',
            updatedBy: req.staffUser?.email || 'staff',
            updatedAt: new Date()
        };

        _ramScheduleConfig = nuevoConfig;
        _ramBootstrapPayload = null;
        _ramBootstrapTs = 0;
        _ramFastSettingsTs = 0;

        await StoreSettings.collection.updateOne(
            { key: 'main_settings' },
            { $set: { scheduleConfig: nuevoConfig } },
            { upsert: true }
        );

        // Sincronizar también el reloj y mensaje de cualquier orden que esté actualmente EN_PROCESO
        const infoH = calcularEstadoHorarioVenezuelaServer(nuevoConfig);
        if (infoH.fueraDeHorario) {
            await Order.updateMany(
                { status: 'EN_PROCESO', isWaitingBinanceAuto: { $ne: true } },
                {
                    $set: {
                        timerStartedAt: new Date(infoH.proximaAperturaUtcMs),
                        statusMessage: `🌙 Compra registrada fuera de horario. Tu pedido está asegurado en cola prioritaria y se entregará a partir de las ${infoH.openTimeFormatted}.`
                    }
                }
            ).catch(() => {});
        } else {
            await Order.updateMany(
                {
                    status: 'EN_PROCESO',
                    isWaitingBinanceAuto: { $ne: true },
                    timerStartedAt: { $gt: new Date() }
                },
                {
                    $set: {
                        timerStartedAt: new Date(),
                        statusMessage: 'Tu orden está en proceso. Un operador está verificando tu referencia de pago...'
                    }
                }
            ).catch(() => {});
        }

        return res.json({
            success: true,
            scheduleConfig: nuevoConfig,
            liveInfo: infoH
        });
    } catch (error) {
        console.error('Error en /api/worker/schedule-config:', error);
        return res.status(500).json({ error: 'Error guardando el horario operativo.' });
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor Kem!Zone corriendo en el puerto ${port}`);
});
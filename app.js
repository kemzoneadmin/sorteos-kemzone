document.addEventListener('DOMContentLoaded', () => {
    // =================================================================
    // 0. CONFIGURACIÓN Y CONTROL LOGÍCO DE LA MÁQUINA DE VASOS (TRILE)
    // =================================================================
    // 🌐 Configuración de la URL de la API para producción o desarrollo local
    const API_BASE_URL = window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
        ? 'http://127.0.0.1:3000'
        : 'https://brave-gentleness-production-77a9.up.railway.app';
    let apiAbortController = null; // Guardará el controlador del fetch activo
let faseExtraccionReal = false; // Nos dirá si estamos en la fase 1 (vistas) o fase 2 (comentarios)
    let vasosMezclando = false;
    let juegoVasosIniciado = false;
    let ganadoresRestantesVasos = 0;
    let ganadoresTotalesVasos = 0;
    let listaGanadoresVasos = [];
    let posicionesVasos = [0, 1, 2]; // Índices de izquierda a derecha
let relojAvatarVasos = null;
let countdownIntervalVasos = null; // 🎯 Nueva línea: Controla el segundero de los vasos

    window.iniciarJuegoVasos = function() {
        // Evita doble ejecución accidental si ya está contando o barajando
        if (vasosMezclando || countdownIntervalVasos) return;

        const nombres = document.getElementById('nombres-vasos').value.split('\n').filter(n => n.trim() !== "");
        if (nombres.length < 1) {
            mostrarAlertaKZ("LISTA VACÍA", "Ingresa participantes para jugar.");
            return;
        }

        const btnStopVasos = document.getElementById('btn-stop-vasos');
        if (btnStopVasos) btnStopVasos.classList.remove('hidden');

        // 🔥 MODIFICACIÓN EXACTA: Si el juego ya está en sesión, mezcla de una sin contador
        if (juegoVasosIniciado) {
            actualizarUIVasos(); 
            mezclarVasosAnim(); // Arranca el barajado directo
            return; // Cortamos la ejecución aquí para saltar el intervalo del reloj
        }

        // Si es el primer tiro del sorteo, configuramos parámetros iniciales
        ganadoresTotalesVasos = parseInt(document.getElementById('input-ganadores-vasos').value) || 1;
        ganadoresRestantesVasos = ganadoresTotalesVasos;
        listaGanadoresVasos = [];
        juegoVasosIniciado = true;

        actualizarUIVasos(); 
        
        // SISTEMA DE CUENTA REGRESIVA NORMAL (SOLO PARA EL PRIMER INICIO)
        let countdownTime = 3;
        const timerOverlayVasos = document.getElementById('timerOverlayVasos');
        
        if (timerOverlayVasos) {
            timerOverlayVasos.textContent = countdownTime;
            timerOverlayVasos.classList.add('active', 'counting', 'pulse-timer');
        }

        if (!checkMute.checked && !document.hidden) {
            audioCountdown.currentTime = 0;
            audioCountdown.volume = document.getElementById('volCountdown').value / 100;
            audioCountdown.play().catch(e => {});
        }

        countdownIntervalVasos = setInterval(() => {
            countdownTime--;
            if (countdownTime > 0) {
                if (timerOverlayVasos) timerOverlayVasos.textContent = countdownTime;
            } else {
                clearInterval(countdownIntervalVasos);
                countdownIntervalVasos = null;
                audioCountdown.pause();
                audioCountdown.currentTime = 0;

                if (timerOverlayVasos) timerOverlayVasos.classList.remove('active', 'counting', 'pulse-timer');
                
                mezclarVasosAnim();
            }
        }, 1000);
    };

    function actualizarUIVasos() {
        document.getElementById('info-ronda-vasos').textContent = `RESTAN: ${ganadoresRestantesVasos} / ${ganadoresTotalesVasos}`;
        document.querySelectorAll('.cup-container').forEach(c => c.classList.remove('lifted'));
    }

    async function mezclarVasosAnim() {
        vasosMezclando = true;
        
        // Controladores del mini avatar que está dentro de la mesa
        const localWidget = document.getElementById('avatar-local-vasos');
        const localBubble = document.getElementById('avatarLocalBubble');
        const localImg = document.getElementById('avatarLocalImg');

        // Si el avatar ya estaba afuera, primero lo guardamos suavemente
        if (localWidget && localWidget.classList.contains('active')) {
            localWidget.classList.remove('active');
            await new Promise(r => setTimeout(r, 400)); 
        }

        document.getElementById('contenedor-vasos').classList.add('shuffling');

        // 🔥 FASE 1: FOTO CUANDO ESTÁ MEZCLANDO
        if (localWidget && localBubble && localImg) {
            // ✅ Conecta el "Avatar al Iniciar" (Opción 2) para la fase de mezcla
            localImg.src = (window.esModoPremium && window.customConfig.avatarStartSrc) ? window.customConfig.avatarStartSrc : 'imagenes/kem-inicio.png'; 
            
            localWidget.classList.remove('side-left', 'active');
            localWidget.classList.add('side-right');
            // Usamos la frase configurada en el diseño o la frase por defecto
localBubble.textContent = (window.esModoPremium && window.customConfig.inicio) ? window.customConfig.inicio : "Mezclando los vasos. Presta mucha atencion."; 
            
            setTimeout(() => { localWidget.classList.add('active'); }, 50);

            if (relojAvatarVasos) clearTimeout(relojAvatarVasos);
            relojAvatarVasos = setTimeout(() => {
                if (vasosMezclando) localWidget.classList.remove('active');
            }, 3000);
        }
        
        playEffect(audioSpin, 'volSpin');

        const totalPasos = 20; 
        for (let i = 0; i < totalPasos; i++) {
            if (!vasosMezclando) return;

            let tiempoPaso = 200; 
            if (i >= 15) {
                tiempoPaso = 200 + (i - 14) * 80; 
            }

            document.querySelectorAll('.cup-container').forEach(cup => {
                cup.style.transition = `left ${tiempoPaso / 1000}s cubic-bezier(0.25, 1, 0.5, 1), bottom 0.3s ease`;
            });

            let idx1 = Math.floor(Math.random() * 3);
            let idx2 = Math.floor(Math.random() * 3);
            while (idx1 === idx2) idx2 = Math.floor(Math.random() * 3);

            let temp = posicionesVasos[idx1];
            posicionesVasos[idx1] = posicionesVasos[idx2];
            posicionesVasos[idx2] = temp;

            actualizarPosicionesVisuales();
            await new Promise(r => setTimeout(r, tiempoPaso)); 
        }

        if (!vasosMezclando) return;

        document.querySelectorAll('.cup-container').forEach(cup => {
            cup.style.transition = '';
        });

        audioSpin.pause();
        vasosMezclando = false;
        const btnStopVasos = document.getElementById('btn-stop-vasos');
        if (btnStopVasos) btnStopVasos.classList.add('hidden');
        document.getElementById('contenedor-vasos').classList.remove('shuffling');
        
        // 🔥 FASE 2: FOTO CUANDO SE QUEDA ESPERANDO QUE SELECCIONEN
        if (localWidget && localBubble) {
            // Aquí pones el nombre de la foto para cuando se quede quieto esperando el click
            if (localImg) {
                // ✅ Detecta si hay un diseño premium subido para la fase de espera, si no, usa el predeterminado
                localImg.src = (window.esModoPremium && window.customConfig.avatarEsperaSrc) ? window.customConfig.avatarEsperaSrc : 'imagenes/kem-pensativo.png';
            }
            
            localWidget.classList.remove('side-left', 'active');
            localWidget.classList.add('side-right');
            localBubble.textContent = "Elige el vaso para seleccionar al ganador"; 
            setTimeout(() => { localWidget.classList.add('active'); }, 50);
        }
    }

    function actualizarPosicionesVisuales() {
        posicionesVasos.forEach((cupIdx, visualPos) => {
            const cupEl = document.getElementById(`cup-${cupIdx}`);
            if (cupEl) {
                // Le asignamos su posición visual (0, 1 o 2) para que el CSS se encargue del resto
                cupEl.setAttribute('data-pos', visualPos);
                // Limpiamos cualquier rastro de estilos inline anteriores
                cupEl.style.left = '';
            }
        });
    }

    /* 📑 BUSCA Y REEMPLAZA ESTA FUNCIÓN COMPLETA EN APP.JS: */
    window.seleccionarVaso = function(cupIdx) {
        if (vasosMezclando || !juegoVasosIniciado) return;
        
        const container = document.getElementById(`cup-${cupIdx}`);
        if (container.classList.contains('lifted')) return;

        // Ocultamos el mini avatar inmediatamente
        const localWidget = document.getElementById('avatar-local-vasos');
        if (localWidget) localWidget.classList.remove('active');

        // Calculamos el ganador de la ronda (Ya calculado anteriormente por JS)
        const nombres = document.getElementById('nombres-vasos').value.split('\n').filter(n => n.trim() !== "");
        const ganadorRonda = nombres[Math.floor(Math.random() * nombres.length)];

        // Levantamos el vaso aplicando la clase de animación
        container.classList.add('lifted');
        const preview = container.querySelector('.cup-winner-preview');

        // 🎯 LOGICA DE EXTRACCION DE FOTO (IGUAL QUE TRAGAPERRAS PREMIUM)
        // Verificamos si es modo Premium Y si el ganador existe en el diccionario de comentarios
        if (window.esModoPremium && window.comentariosDict && window.comentariosDict[ganadorRonda]) {
            const dataUsuario = window.comentariosDict[ganadorRonda];
            
            // Sanitizamos el nombre para UI-Avatars (quitamos @)
            const sanitizedName = ganadorRonda.replace('@','');
            const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(sanitizedName)}&background=ff6600&color=fff&size=128`;
            const avatarSrc = dataUsuario.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUsuario.profilePicUrl)}` : fallbackAvatar;
            
            // ✅ Inyectamos la imagen con estilo circular ajustado al círculo neón
            preview.innerHTML = `
                <img src="${avatarSrc}"
                     onerror="this.src='${fallbackAvatar}'"
                     alt="Avatar de ${ganadorRonda}"
                     style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;">
            `;
        } else {
            // 🛑 Fallback Manual: Mostramos el nombre texto (CSS ya lo estiliza como circulo neon)
            preview.innerHTML = ""; // Limpiamos HTML previo
            preview.textContent = ganadorRonda;
        }

        setTimeout(() => {
            procesarGanadorVaso(ganadorRonda);
        }, 600);
    };

    function procesarGanadorVaso(nombre) {
        ganadoresRestantesVasos--;
        
        const dataUsuario = window.comentariosDict ? window.comentariosDict[nombre] : null;
        if (dataUsuario) {
            const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nombre.replace('@',''))}&background=ff6600&color=fff&size=128`;
            const avatarSrc = dataUsuario.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUsuario.profilePicUrl)}` : fallbackAvatar;
            
            nombreDisplay.innerHTML = `
                <div class="winner-rich-card">
                    <!-- 🛡️ Se añade "this.onerror=null;" para matar el bucle si ambos servidores fallan -->
<img src="${avatarSrc}" onerror="this.onerror=null; this.src='${fallbackAvatar}';">
                    <h3>${nombre}</h3>
                    <p class="winner-comment">"${dataUsuario.text || '¡Ganó en los vasos!'}"</p>
                </div>`;
        } else {
            nombreDisplay.innerHTML = `<span style="font-size: 2.5rem; font-weight: 900; color: #ff6600;">${nombre}</span>`;
        }

        tituloModal.textContent = "¡VASO PREMIADO!";
        if (btnEliminar) btnEliminar.style.display = 'none'; 
        modalGanador.classList.remove('hidden');
        confetti({ particleCount: 150, spread: 70 });
        playEffect(audioConfetti, 'volConfetti');

        // 🥤 1. INTERACCIÓN DEL MINI-AVATAR DENTRO DE LA MESA DE VASOS
        const localWidget = document.getElementById('avatar-local-vasos');
        const localBubble = document.getElementById('avatarLocalBubble');
        const localImg = document.getElementById('avatarLocalImg');

        if (localWidget && localBubble && localImg) {
            localImg.src = (window.esModoPremium && window.customConfig.avatarEndSrc) ? window.customConfig.avatarEndSrc : 'imagenes/kem-ganador.png';
            localWidget.classList.remove('side-right', 'active');
            localWidget.classList.add('side-left');
            
            let fraseGanadorLocal = window.customConfig.ganador1.replace('{nombre}', nombre);
            fraseGanadorLocal = fraseGanadorLocal.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD00-\uDFFF]/g, '');
            localBubble.textContent = fraseGanadorLocal.trim();

            setTimeout(() => { localWidget.classList.add('active'); }, 50);
        }

        // 🎡 2. INTERACCIÓN DEL AVATAR FLOTANTE GLOBAL (LATERAL DE LA PANTALLA)
        if (avatarWidget && avatarBubble && avatarImgStart && avatarImgEnd) {
            avatarImgStart.style.display = 'none';
            avatarImgEnd.style.display = 'block';
            avatarWidget.classList.remove('side-right', 'active');
            avatarWidget.classList.add('side-left');
            
            let fraseGanadorGlobal = window.customConfig.ganador1.replace('{nombre}', nombre);
            fraseGanadorGlobal = fraseGanadorGlobal.replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD00-\uDFFF]/g, '');
            avatarBubble.textContent = fraseGanadorGlobal.trim();

            setTimeout(() => {
                avatarWidget.classList.add('active');
                playEffect(audioAvatar, 'volAvatar');
            }, 50);
        }

        const btnAceptar = document.getElementById('btn-conservar-ganador');
        const originalText = "✔️ Aceptar";
        
        if (ganadoresRestantesVasos > 0) {
            btnAceptar.innerHTML = "SIGUIENTE RONDA 🔄";
            btnAceptar.onclick = () => {
                modalGanador.classList.add('hidden');
                if (localWidget) localWidget.classList.remove('active'); 
                if (avatarWidget) avatarWidget.classList.remove('active'); 
                btnAceptar.innerHTML = originalText;
                actualizarUIVasos();
                mezclarVasosAnim(); 
            };
        } else {
            juegoVasosIniciado = false;
            btnAceptar.innerHTML = originalText;
            btnAceptar.onclick = () => {
                modalGanador.classList.add('hidden');
                if (localWidget) localWidget.classList.remove('active'); 
                if (avatarWidget) avatarWidget.classList.remove('active'); 
                actualizarUIVasos();
            };
        }
    }

    /* 📑 REEMPLÁZALO POR ESTE BLOQUE: */
    const btnStopVasos = document.getElementById('btn-stop-vasos');
    if(btnStopVasos) {
        btnStopVasos.addEventListener('click', () => {
            // Se ejecuta si está mezclando O si está contando el 3,2,1
            if (!vasosMezclando && !countdownIntervalVasos) return;
            
            // 🛑 Si el usuario frena en plena cuenta regresiva, matamos el intervalo
            if (countdownIntervalVasos) {
                clearInterval(countdownIntervalVasos);
                countdownIntervalVasos = null;
            }

            audioCountdown.pause(); audioCountdown.currentTime = 0;
            audioSpin.pause(); audioSpin.currentTime = 0;
            vasosMezclando = false;
            juegoVasosIniciado = false;
            btnStopVasos.classList.add('hidden');
            document.getElementById('info-ronda-vasos').textContent = "RONDA: 0 / 0";
            document.getElementById('contenedor-vasos').classList.remove('shuffling');
            
            const localWidget = document.getElementById('avatar-local-vasos');
            if (localWidget) localWidget.classList.remove('active');

            if (relojAvatarVasos) {
                clearTimeout(relojAvatarVasos);
                relojAvatarVasos = null;
            }

            // Ocultamos el cartel flotante del número por si acaso seguía visible
            const timerOverlayVasos = document.getElementById('timerOverlayVasos');
            if (timerOverlayVasos) {
                timerOverlayVasos.classList.remove('active', 'counting', 'pulse-timer');
            }

            avatarWidget.classList.remove('active');
            document.querySelectorAll('.cup-container').forEach(c => c.classList.remove('lifted'));
            posicionesVasos = [0, 1, 2];
            actualizarPosicionesVisuales();
        });
    }

    const btnReiniciarVasos = document.getElementById('btn-reiniciar-vasos');
    if(btnReiniciarVasos) {
        btnReiniciarVasos.addEventListener('click', () => {
            if (vasosMezclando) return;
            document.getElementById('nombres-vasos').value = "";
            document.getElementById('input-ganadores-vasos').value = 1;
            juegoVasosIniciado = false;
            actualizarUIVasos();
            document.getElementById('info-ronda-vasos').textContent = "RONDA: 0 / 0";
            avatarWidget.classList.remove('active');
            posicionesVasos = [0, 1, 2];
            actualizarPosicionesVisuales();
        });
    }

    // =================================================================
    // 1. CONFIGURACIONES GLOBALES Y MEMORIA PERSISTENTE
    // =================================================================
    window.esModoPremium = false;
    window.urlActualPost = ""; 

    window.customConfig = {
        titulo: "",
        inicio: "¡Se viene la ruleta, activos!",
        ganador1: "¡Felicidades {nombre}! Tú coronaste hoy.",
        ganador3: "¡Felicidades a los {nombre} ganadores! Coronaron duro.",
        color1: "#ff6600",
        color2: "#00ffcc",
        colorVaso: "#ff1a1a", // ✨ Variable propia para blindar el rojo nativo
        logoSrc: null,
        avatarStartSrc: null,
        avatarEndSrc: null,
        avatarEsperaSrc: null,
        ruletaColores: ["#ff6600", "#00ffcc", "#ff00ff", "#b052ff", "#ccff00", "#33ccff", "#ff3366", "#00ff66"]
    };

    const colores = ["#ff6600", "#00ffcc", "#ff00ff", "#b052ff", "#ccff00", "#33ccff", "#ff3366", "#00ff66"];

    const configGuardada = localStorage.getItem('kz_premium_saved_config');
    if (configGuardada) {
        try {
            const parsed = JSON.parse(configGuardada);
            window.customConfig = { ...window.customConfig, ...parsed };
            // Inyectamos las variables al CSS en el arranque si existen datos previos
            document.documentElement.style.setProperty('--premium-c1', window.customConfig.color1);
            document.documentElement.style.setProperty('--premium-c2', window.customConfig.color2);
            document.documentElement.style.setProperty('--premium-cup-color', window.customConfig.colorVaso || "#ff1a1a");
            reinyectarEstilosPremiumCSS();
        } catch(e) {
            console.error("Error leyendo LocalStorage de marca:", e);
        }
    }

    // =================================================================
    // 2. SISTEMA DE ALERTAS NEÓN KEMZONE
    // =================================================================
    function mostrarAlertaKZ(titulo, mensaje, tipo = 'error') {
        const alertOverlay = document.getElementById('kz-custom-alert');
        const alertCard = document.getElementById('kz-alert-card');
        const alertTitulo = document.getElementById('kz-alert-titulo');
        const alertMensaje = document.getElementById('kz-alert-mensaje');
        const alertBtn = document.getElementById('kz-alert-btn');

        if (!alertOverlay || !alertCard) return;

        alertBtn.innerHTML = "ACEPTAR"; 
        alertTitulo.innerHTML = titulo;
        alertMensaje.innerHTML = mensaje;

        if (tipo === 'exito') {
            alertTitulo.style.color = '#00ffcc';
            alertCard.style.border = '2px solid #00ffcc';
            alertCard.style.boxShadow = '0 0 25px rgba(0, 255, 204, 0.4), inset 0 0 15px rgba(0, 255, 204, 0.1)';
        } else { 
            alertTitulo.style.color = '#ff6600';
            alertCard.style.border = '2px solid #ff6600';
            alertCard.style.boxShadow = '0 0 25px rgba(255, 102, 0, 0.4), inset 0 0 15px rgba(255, 0, 255, 0.1)';
        }

        alertOverlay.classList.remove('hidden');
        alertBtn.onclick = () => alertOverlay.classList.add('hidden');
    }
    window.mostrarAlertaKZ = mostrarAlertaKZ;

    // =================================================================
    // 3. CONTROL DE AUDIO Y EFECTOS
    // =================================================================
    const audioCountdown = new Audio("Sonidos/Tic_Tac_Reloj.mp3");
    const audioSpin      = new Audio("Sonidos/Ruleta_Girando_Sonido.WAV");
    const audioAvatar    = new Audio("Sonidos/Whoops.WAV");
    const audioConfetti  = new Audio("Sonidos/Confetti.WAV");
    const audioCoin      = new Audio("Sonidos/Coin.wav"); 

    audioSpin.loop = true; audioCountdown.loop = true;

    const panelVolumen = document.getElementById('panel-volumen');
    const checkMute = document.getElementById('muteAllCheck');
    const btnResetVol = document.getElementById('btn-reset-volumen');
    const botonesVolumen = document.querySelectorAll('.btn-abrir-volumen, .btn-vol');
    
    /* 📑 REEMPLÁZALO POR ESTE BLOQUE: */
    botonesVolumen.forEach(btn => {
        btn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            
            // Guardamos si el panel estaba cerrado antes de hacer el click
            const estabaOculto = panelVolumen.classList.contains('hidden');
            panelVolumen.classList.toggle('hidden'); 
            
            // Si el panel se va a abrir, calculamos la posición exacta del botón presionado
            if (estabaOculto) {
                const posicionBoton = btn.getBoundingClientRect();
                
                panelVolumen.style.position = 'fixed';
                panelVolumen.style.top = `${posicionBoton.bottom + 10}px`; // 10 píxeles justo debajo del botón
                panelVolumen.style.left = `${posicionBoton.right - 220}px`; // Alinea el borde derecho del panel (mide 220px) con el botón
                panelVolumen.style.right = 'auto'; // Desactiva la regla vieja de CSS para que no se jale a la derecha
            }
        });
    });
    
    document.addEventListener('click', (e) => { 
        let isClickOnBtn = Array.from(botonesVolumen).some(btn => btn.contains(e.target));
        if (!panelVolumen.contains(e.target) && !isClickOnBtn) {
            panelVolumen.classList.add('hidden'); 
        }
    });

    checkMute.checked = false;

    btnResetVol.addEventListener('click', () => {
        document.getElementById('volCountdown').value = 70; 
        document.getElementById('volSpin').value = 60;
        document.getElementById('volAvatar').value = 80; 
        document.getElementById('volConfetti').value = 70;
        document.getElementById('volCoin').value = 40; 
        checkMute.checked = false;
    });

    function playEffect(audioObj, volInputId) {
        if (checkMute.checked || document.hidden) return; 
        if (audioObj === audioCoin) {
            let clone = audioObj.cloneNode();
            clone.volume = document.getElementById(volInputId).value / 100;
            clone.play().catch(e => {});
            return;
        }
        audioObj.currentTime = 0;
        audioObj.volume = document.getElementById(volInputId).value / 100;
        audioObj.play().catch(e => {});
    }

    // =================================================================
    // 4. CONTROL DE PANTALLAS Y ENTORNO DE DISEÑO (MANUAL VS PREMIUM)
    // =================================================================
    const pantallas = document.querySelectorAll('.pantalla');
    const botonesMenu = document.querySelectorAll('.menu-card[data-target]');
    const botonesVolver = document.querySelectorAll('.btn-volver');

    /* 📑 REEMPLÁZALA POR ESTA VERSIÓN CORRECTA: */
    function actualizarEstrellasFiltros() {
        const paneles = document.querySelectorAll('.panel-filtros-interno');
        paneles.forEach(panel => {
            const estrellas = panel.querySelectorAll('.premium-star');
            estrellas.forEach(estrella => {
                if (window.esModoPremium) {
                    // ✅ Si ya estás en Premium, limpiamos la interfaz ocultando todas las estrellitas
                    estrella.style.display = 'none';
                } else {
                    // ✅ Si estás en modo Manual, mantenemos las estrellitas únicamente en los 3 filtros bloqueados
                    const labelText = estrella.parentElement.textContent || "";
                    if (labelText.includes("@Mencion") || labelText.includes("Longitud") || labelText.includes("Excluir")) {
                        estrella.style.display = 'inline-block';
                    } else {
                        estrella.style.display = 'none';
                    }
                }
            });
        });
    }

    function sincronizarEntornoDeDiseno(pantallaId) {
        // 🎯 BLINDAJE: El Sorteo Tradicional SIEMPRE usa motor de diseño premium
        if (pantallaId === 'pantalla-tradicional') window.esModoPremium = true;
        const titleEl = document.querySelector(`#${pantallaId} .titulo-herramienta`);
        const logoImg = document.querySelector(`#${pantallaId} .pngtuber-header-img`);
        const targetImgStart = document.getElementById('avatarImgStart');
        const targetImgEnd = document.getElementById('avatarImgEnd');

        if (window.esModoPremium) {
            document.body.classList.add('premium-design-active');
            
            // 🎯 FORZAR REINYECCIÓN: Aplica los colores de la máquina seleccionada al instante de entrar
            reinyectarEstilosPremiumCSS();
            
            if (titleEl) {
                // 🎯 SI EL TÍTULO ESTÁ VACÍO, ASIGNA EL CORRESPONDIENTE POR MÁQUINA
                if (window.customConfig.titulo) {
                    titleEl.textContent = window.customConfig.titulo.toUpperCase();
                } else {
                    titleEl.textContent = (pantallaId === 'pantalla-tradicional') ? "SORTEO TRADICIONAL PREMIUM" : "SORTEO PREMIUM";
                }
            }
            
            // 🛡️ CORRECCIÓN TOTAL: Si el logo es null, fuerza la ruta de fábrica según la máquina activa
            if (logoImg) {
                logoImg.src = window.customConfig.logoSrc ? window.customConfig.logoSrc : 
                             (pantallaId === 'pantalla-ruleta' ? 'imagenes/ruleta-logo.png' : 
                              pantallaId === 'pantalla-tragaperras' ? 'imagenes/tragaperras-logo.png' : 
                              pantallaId === 'pantalla-tradicional' ? 'imagenes/logo-kemzone.png' : 'imagenes/vasos-logo.png');
            }
            
            // 🛡️ CORRECCIÓN TOTAL: Si los avatares son null (por reset), obliga a pintar los de KemZone
            if (targetImgStart) {
                targetImgStart.src = window.customConfig.avatarStartSrc ? window.customConfig.avatarStartSrc : 'imagenes/kem-inicio.png';
            }
            if (targetImgEnd) {
                targetImgEnd.src = window.customConfig.avatarEndSrc ? window.customConfig.avatarEndSrc : 'imagenes/kem-ganador.png';
            }
            
            // Sincronizar también el mini-avatar interno dentro de la mesa de vasos
            const localImg = document.getElementById('avatarLocalImg');
            if (localImg) {
                localImg.src = window.customConfig.avatarStartSrc ? window.customConfig.avatarStartSrc : 'imagenes/kem-inicio.png';
            }

        } else {
            document.body.classList.remove('premium-design-active');
            
            const styleTag = document.getElementById('dynamic-premium-styles');
            if (styleTag) styleTag.innerHTML = '';

            const botonesVasos = document.querySelectorAll('#pantalla-vasos .controles-ruleta .btn-accion, #pantalla-vasos .controles-ruleta .btn-secundario');
            botonesVasos.forEach(btn => {
                btn.style.background = '';
                btn.style.color = '';
                btn.style.borderColor = '';
            });

            if (titleEl) {
                if (pantallaId === 'pantalla-ruleta') titleEl.textContent = 'RULETA MANUAL';
                else if (pantallaId === 'pantalla-tragaperras') titleEl.textContent = 'TRAGAPERRAS MANUAL';
                else if (pantallaId === 'pantalla-vasos') titleEl.textContent = 'JUEGO DE VASOS';
            }
            if (logoImg) {
                if (pantallaId === 'pantalla-ruleta') logoImg.src = 'imagenes/ruleta-logo.png';
                else if (pantallaId === 'pantalla-tragaperras') logoImg.src = 'imagenes/tragaperras-logo.png';
                else if (pantallaId === 'pantalla-vasos') logoImg.src = 'imagenes/vasos-logo.png';
                else if (pantallaId === 'pantalla-tradicional') logoImg.src = 'imagenes/logo-kemzone.png';
            }
            if (targetImgStart) targetImgStart.src = 'imagenes/kem-inicio.png';
            if (targetImgEnd) targetImgEnd.src = 'imagenes/kem-ganador.png';

            if (pantallaId === 'pantalla-ruleta') {
                const txtArea = document.getElementById('nombres-ruleta');
                if (txtArea) txtArea.value = "";
                participantes = []; 
            } else if (pantallaId === 'pantalla-tragaperras') {
                const txtAreaTraga = document.getElementById('nombres-tragaperras');
                if (txtAreaTraga) txtAreaTraga.value = "";
            } else if (pantallaId === 'pantalla-vasos') {
                const txtAreaVasos = document.getElementById('nombres-vasos');
                if (txtAreaVasos) txtAreaVasos.value = "";
            }
        }
        
        actualizarEstrellasFiltros();
        if (pantallaId === 'pantalla-ruleta' && typeof dibujarRuleta === 'function') dibujarRuleta();
    }

    // 🎯 FUNCIÓN SECUNDARIA: Ejecuta el ruteo físico de la pantalla
    function ejecutarCambioPantalla(id) {
        const pantallasLocales = document.querySelectorAll('.pantalla');
        pantallasLocales.forEach(p => p.classList.remove('active'));
        
        const pantallaActiva = document.getElementById(id);
        if (pantallaActiva) pantallaActiva.classList.add('active');
        
        const filaVolCoin = document.getElementById('row-vol-coin');
        if (filaVolCoin) filaVolCoin.style.display = (id === 'pantalla-tragaperras') ? 'flex' : 'none';

        if (id === 'pantalla-ruleta' || id === 'pantalla-tragaperras' || id === 'pantalla-vasos' || id === 'pantalla-tradicional') {
            sincronizarEntornoDeDiseno(id);
        } else {
            document.body.classList.remove('premium-design-active');
            if (typeof actualizarEstrellasFiltros === 'function') actualizarEstrellasFiltros();
        }

        // Sincronización del saldo original
        const badge = document.getElementById('global-token-badge');
        if (badge && pantallaActiva) {
            badge.style.display = (id === 'splash-screen') ? 'none' : 'flex';
            if (id !== 'splash-screen') pantallaActiva.appendChild(badge);
        }

        // 🎯 NUEVO: Sincronización del botón Canjear
        const rBadge = document.getElementById('global-redeem-badge');
        if (rBadge && pantallaActiva) {
            rBadge.style.display = (id === 'splash-screen') ? 'none' : 'flex';
            if (id !== 'splash-screen') pantallaActiva.appendChild(rBadge);
        }
    }

    // 🎯 FUNCIÓN DE LIMPIEZA ABSOLUTA: Se ejecuta SOLO cuando se confirma la salida
    window.limpiarYRegresarAlMenuPrincipal = function() {
        const btnStopRuleta = document.getElementById('btn-stop');
        const btnStopSlots = document.getElementById('btn-stop-slots');
        const btnStopVasos = document.getElementById('btn-stop-vasos');
        const btnStopTrad = document.getElementById('btn-stop-tradicional');
        
        if (btnStopRuleta) btnStopRuleta.click();
        if (btnStopSlots) btnStopSlots.click();
        if (btnStopVasos) btnStopVasos.click();
        if (btnStopTrad) btnStopTrad.click();

        audioCountdown.pause(); audioCountdown.currentTime = 0; 
        audioSpin.pause(); audioSpin.currentTime = 0;

        window.esModoPremium = false; 

        // 🎰 A) REINICIO: TRAGAPERRAS A BASE CERO
        const txtAreaTraga = document.getElementById('nombres-tragaperras');
        if (txtAreaTraga) txtAreaTraga.value = "";
        if (typeof resTragaperras !== 'undefined' && resTragaperras) resTragaperras.textContent = "Tira de la palanca...";
        
        [1, 2, 3].forEach(num => {
            const reelStrip = document.getElementById(`reel-${num}`);
            if (reelStrip) {
                reelStrip.style.transition = 'none';
                reelStrip.style.transform = 'translateY(0)';
                reelStrip.innerHTML = `<div class="reel-item">?</div>`;
            }
        });

        // 🎡 B) REINICIO: RULETA A BASE CERO
        const txtAreaRuleta = document.getElementById('nombres-ruleta');
        if (txtAreaRuleta) txtAreaRuleta.value = "";
        participantes = []; 
        currentAngle = 0;
        if (typeof dibujarRuleta === 'function') dibujarRuleta();

        // 🥤 C) REINICIO: VASOS A BASE CERO
        const txtAreaVasos = document.getElementById('nombres-vasos');
        if (txtAreaVasos) txtAreaVasos.value = "";
        juegoVasosIniciado = false;
        vasosMezclando = false;
        
        const infoRondaV = document.getElementById('info-ronda-vasos');
        if (infoRondaV) infoRondaV.textContent = "RONDA: 0 / 0";
        
        document.querySelectorAll('.cup-container').forEach(c => {
            c.classList.remove('lifted');
            const preview = c.querySelector('.cup-winner-preview');
            if (preview) preview.innerHTML = "?";
        });
        
        posicionesVasos = [0, 1, 2];
        if (typeof actualizarPosicionesVisuales === 'function') actualizarPosicionesVisuales();
        
        const localWidget = document.getElementById('avatar-local-vasos');
        if (localWidget) localWidget.classList.remove('active');

        // 🎟️ D) REINICIO: SORTEO TRADICIONAL A BASE CERO
        const txtTradicional = document.getElementById('nombres-tradicional');
        if (txtTradicional) txtTradicional.value = "";
        const panelConfig = document.getElementById('panel-config-tradicional');
        if (panelConfig) panelConfig.classList.remove('hidden');
        const panelAnim = document.getElementById('panel-animacion-tradicional');
        if (panelAnim) panelAnim.classList.add('hidden');
        const ribbon = document.getElementById('carrusel-ribbon');
        if (ribbon) ribbon.innerHTML = "";
        
        const btnDisenoTrad = document.getElementById('btn-diseno-tradicional');
        if (btnDisenoTrad) btnDisenoTrad.classList.remove('hidden');

        // Redirección física final
        ejecutarCambioPantalla('main-menu');
        const avatarW = document.getElementById('avatarWidget');
        if (avatarW) avatarW.classList.remove('active'); 
    };

    // 🎯 FUNCIÓN MAESTRA: Intercepta y valida la salida del entorno premium
    window.mostrarPantalla = function(id) {
        if (id === 'main-menu' && window.esModoPremium) {
            const modalSalida = document.getElementById('modal-confirmacion-salida');
            if (modalSalida) {
                const btnConfirmar = document.getElementById('btn-confirmar-salir');
                
                // Clonar para limpiar adiciones redundantes de eventos previos
                const nuevoBtn = btnConfirmar.cloneNode(true);
                btnConfirmar.parentNode.replaceChild(nuevoBtn, btnConfirmar);
                
                nuevoBtn.addEventListener('click', () => {
                    modalSalida.classList.add('hidden');
                    window.limpiarYRegresarAlMenuPrincipal(); // Limpia y sale solo tras confirmar
                });
                
                modalSalida.classList.remove('hidden');
                return; // Frena el enrutamiento inmediato
            }
        }
        
        // Si no es premium, limpia directo o enruta de manera normal
        if (id === 'main-menu') {
            window.limpiarYRegresarAlMenuPrincipal();
        } else {
            ejecutarCambioPantalla(id);
        }
    };

    // ⏱️ Lanzamiento del menú principal tras pasar la pantalla de carga inicial
    setTimeout(() => { window.mostrarPantalla('main-menu'); }, 3000);
    
    botonesMenu.forEach(btn => btn.addEventListener('click', () => {
        if (btn.dataset.target) {
            window.esModoPremium = false; 
            mostrarPantalla(btn.dataset.target);
        }
    }));
    
    // =================================================================
    // PUNTO DE RETORNO GLOBAL: ESCUCHA A TODOS LOS BOTONES DE VOLVER
    // =================================================================
    botonesVolver.forEach(btn => btn.addEventListener('click', () => {
        window.mostrarPantalla('main-menu'); // ✅ Llama correctamente a la validación premium
    })); // ✅ Bloque cerrado impecable

    // =================================================================
    // 5. MOTOR DE PERSONALIZACIÓN PREMIUM
    // =================================================================
   /* 📑 REEMPLAZA ESTA FUNCIÓN EN APP.JS: */
window.abrirModalPersonalizacion = function() {
        let maquinaActiva = 'ruleta';
        if (document.getElementById('pantalla-tragaperras').classList.contains('active')) maquinaActiva = 'tragaperras';
        if (document.getElementById('pantalla-vasos').classList.contains('active')) maquinaActiva = 'vasos';
        if (document.getElementById('pantalla-tradicional').classList.contains('active')) maquinaActiva = 'tradicional';

        // 🎯 CORRECCIÓN: Si no es modo Premium Y TAMPOCO es la máquina tradicional, bloquear.
        if (!window.esModoPremium && maquinaActiva !== 'tradicional') {
            window.interceptarFiltroManual(new Event('click'), maquinaActiva);
            return;
        }

        const modal = document.getElementById('modal-personalizacion');
        if (!modal) return;

        const esVasos = maquinaActiva === 'vasos';
        const esRuleta = maquinaActiva === 'ruleta';
        const esTradicional = maquinaActiva === 'tradicional';

        const gridColoresRuleta = document.getElementById('contenedor-cust-colores-ruleta');
        if (gridColoresRuleta) gridColoresRuleta.style.display = esRuleta ? 'block' : 'none';

        const divAvatarEspera = document.getElementById('contenedor-avatar-espera');
        if (divAvatarEspera) divAvatarEspera.style.display = esVasos ? 'block' : 'none';

        const divColorVaso = document.getElementById('contenedor-cust-color-vaso');
        if (divColorVaso) divColorVaso.style.display = esVasos ? 'block' : 'none';

        const inputTitulo = document.getElementById('cust-titulo');
        const inputInicio = document.getElementById('cust-inicio');
        
        if (inputTitulo) {
            if (esVasos) inputTitulo.placeholder = "Título (Ej: ¡SUERTE EN LOS VASOS!)";
            else if (maquinaActiva === 'tragaperras') inputTitulo.placeholder = "Título (Ej: ¡SLOTS DE KEMZONE!)";
            else if (esTradicional) inputTitulo.placeholder = "Título (Ej: ¡SORTEO MASIVO TRADICIONAL!)";
            else inputTitulo.placeholder = "Título de la máquina (Ej: Sorteo de Navidades)";
        }
        
        if (inputInicio) {
            if (esVasos) inputInicio.placeholder = "Frase al Mezclar (Ej: ¡No los pierdas de vista! 👀)";
            else if (maquinaActiva === 'tragaperras') inputInicio.placeholder = "Frase al Iniciar (Ej: ¡Suerte en los rodillos! 🎰)";
            else if (esTradicional) inputInicio.placeholder = "Frase al Iniciar (Ej: ¡Se viene el sorteo masivo! 🎟️)";
            else inputInicio.placeholder = "Frase al Iniciar (Ej: ¡Vamos a darle con lo bueno!)";
        }

        // 🎯 VALIDACIÓN DE AMARILLO AUTOMÁTICO EN EL SELECTOR DE COLOR
        if (document.getElementById('cust-color1')) {
            if (esTradicional && window.customConfig.color1 === "#ff6600") {
                document.getElementById('cust-color1').value = "#ffd700";
            } else {
                document.getElementById('cust-color1').value = window.customConfig.color1;
            }
        }
        if (document.getElementById('cust-color2')) document.getElementById('cust-color2').value = window.customConfig.color2;
        if (document.getElementById('cust-color-vaso')) document.getElementById('cust-color-vaso').value = window.customConfig.colorVaso || "#ff1a1a";

        modal.classList.remove('hidden');
    };

    function reinyectarEstilosPremiumCSS() {
        // 🎯 DETECTAR SI ESTAMOS EN LA PANTALLA TRADICIONAL PARA APLICAR AMARILLO BASE
        const isTrad = document.getElementById('pantalla-tradicional').classList.contains('active');
        const c1 = (isTrad && window.customConfig.color1 === "#ff6600") ? "#ffd700" : window.customConfig.color1;
        const c2 = window.customConfig.color2;

        const hexToRgb = (hex) => {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `${r}, ${g}, ${b}`;
        };
        const rgb1 = hexToRgb(c1);
        const rgb2 = hexToRgb(c2);

        let styleTag = document.getElementById('dynamic-premium-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'dynamic-premium-styles';
            document.head.appendChild(styleTag);
        }

        styleTag.innerHTML = `
            /* 🟠 TEMA PRINCIPAL */
            body.premium-design-active .titulo-herramienta { color: ${c1} !important; text-shadow: 0 0 15px rgba(${rgb1}, 0.6) !important; }
            body.premium-design-active .btn-accion { background: linear-gradient(45deg, ${c1}, #ff00ff) !important; box-shadow: 0 8px 20px rgba(${rgb1}, 0.3) !important; }
            body.premium-design-active .ruleta-sombra { background: ${c1} !important; }
            body.premium-design-active #canvas-ruleta { box-shadow: 0 0 0 2px rgba(${rgb1},0.5), 0 15px 35px rgba(0,0,0,0.6) !important; }
            body.premium-design-active .puntero-neon { background: ${c1} !important; border-top-color: #fff !important; }
            body.premium-design-active #modal-titulo-dinamico, body.premium-design-active .modal-ganador h2 { color: ${c1} !important; text-shadow: 0 0 15px rgba(${rgb1}, 0.5) !important; }
            body.premium-design-active #nombre-ganador-display span { color: ${c1} !important; }

/* 🔥 TEMA DE CONTROLES, HOVERS Y FOCOS (DINÁMICO GLOBAL) */
           body.premium-design-active .float-btn { color: ${c1} !important; border-color: rgba(${rgb1}, 0.4) !important; }
            body.premium-design-active .float-btn:hover { 
                background: rgba(${rgb1}, 0.15) !important; 
                border-color: ${c1} !important; 
                color: ${c1} !important; /* 🔥 CON ESTO EL ICONO SE PONE AMARILLO/PREMIUM AL HOVER */
                box-shadow: 0 0 15px rgba(${rgb1}, 0.6) !important; 
            }
            body.premium-design-active .btn-volver { color: ${c1} !important; border-color: rgba(${rgb1}, 0.4) !important; }
            body.premium-design-active .btn-volver:hover { background: ${c1} !important; color: #0d0d14 !important; box-shadow: 0 0 20px rgba(${rgb1}, 0.6) !important; }
            
            body.premium-design-active input:focus, 
            body.premium-design-active textarea:focus,
            body.premium-design-active .input-glass:focus { 
                border-color: ${c1} !important; 
                box-shadow: 0 0 12px rgba(${rgb1}, 0.4) !important; 
                outline: none !important; 
            }
            
            body.premium-design-active .switch input:checked + .slider { 
                background-color: ${c1} !important; 
                box-shadow: 0 0 10px rgba(${rgb1}, 0.6) !important; 
            }

            /* ⏱️ CONTADOR / CUENTA ATRÁS DINÁMICA */
            body.premium-design-active .timer-overlay { color: ${c1} !important; text-shadow: 0 0 25px rgba(${rgb1}, 0.8) !important; }

            /* 📐 ACTUALIZACIÓN DE BORDES CURVOS ORIGINALES */
            body.premium-design-active .table-surface { border-bottom-color: ${c1} !important; }
            body.premium-design-active .slot-machine-case { border-color: ${c1} !important; box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 30px rgba(${rgb1}, 0.15), inset 0 2px 10px rgba(255, 255, 255, 0.05) !important; }
            body.premium-design-active #modal-ganador .modal-content { border-color: ${c1} !important; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 30px rgba(${rgb1}, 0.3) !important; }

            /* 💬 BURBUJAS DE TEXTO */
            body.premium-design-active .avatar-bubble, 
            body.premium-design-active .avatar-local-bubble { border-color: ${c1} !important; box-shadow: 0 0 30px rgba(${rgb1}, 0.6), inset 0 0 15px rgba(${rgb1}, 0.25) !important; }
            body.premium-design-active .avatar-widget.side-right .avatar-bubble::after,
            body.premium-design-active .avatar-widget.side-left .avatar-bubble::after,
            body.premium-design-active .avatar-local-widget .avatar-local-bubble::after { border-right-color: ${c1} !important; border-bottom-color: ${c1} !important; }

            /* 🔮 TEMA VICTORIA */
            body.premium-design-active #info-ronda-vasos, body.premium-design-active .info-ronda { color: ${c2} !important; text-shadow: 0 0 10px rgba(${rgb2}, 0.4) !important; }
            body.premium-design-active .btn-secundario { color: ${c2} !important; border-color: ${c2} !important; box-shadow: 0 0 10px rgba(${rgb2}, 0.2) !important; }
            body.premium-design-active .btn-secundario:hover { background: rgba(${rgb2}, 0.1) !important; box-shadow: 0 0 15px rgba(${rgb2}, 0.4) !important; }
            body.premium-design-active .btn-verde, body.premium-design-active #btn-conservar-ganador { background: ${c2} !important; box-shadow: 0 5px 15px rgba(${rgb2}, 0.4) !important; color: #0d0d14 !important; }
            body.premium-design-active .btn-verde:hover, body.premium-design-active #btn-conservar-ganador:hover { filter: brightness(1.2) !important; box-shadow: 0 8px 22px rgba(${rgb2}, 0.6) !important; color: #0d0d14 !important; }
            /* ✨ TARJETA INTERIOR DEL GANADOR */
            body.premium-design-active .winner-rich-card { border-color: ${c2} !important; box-shadow: 0 10px 30px rgba(${rgb2}, 0.2), inset 0 0 20px rgba(${rgb2}, 0.1) !important; }
            body.premium-design-active .winner-comment { border-left-color: ${c2} !important; }
            body.premium-design-active .multi-winner-rich { background: rgba(${rgb2}, 0.05) !important; border-color: rgba(${rgb2}, 0.2) !important; }
            body.premium-design-active .multi-winner-rich img { border-color: ${c2} !important; }
            body.premium-design-active .avatar-local-widget.side-left .avatar-local-bubble { border-color: ${c2} !important; box-shadow: 0 0 12px rgba(${rgb2}, 0.4) !important; }
            body.premium-design-active .cup-winner-preview { border-color: ${c2} !important; box-shadow: 0 0 15px rgba(${rgb2}, 0.4), inset 0 0 10px rgba(${rgb2}, 0.15) !important; }
            body.premium-design-active .slot-avatar-spin { border-color: ${c2} !important; box-shadow: 0 0 14px rgba(${rgb2}, 0.6) !important; }

            /* 🎟️ TEMA SORTEO TRADICIONAL PREMIUM */
            body.premium-design-active #titulo-tradicional-dinamico { color: ${c1} !important; text-shadow: 0 0 15px rgba(${rgb1}, 0.6) !important; }
            body.premium-design-active #btn-arrancar-tradicional { background: linear-gradient(45deg, ${c1}, ${c2}) !important; box-shadow: 0 8px 20px rgba(${rgb1}, 0.3) !important; color: #0d0d14 !important; }
            
            /* 🎯 CORRECCIÓN DE ENCUADRE Y SIMETRÍA FLUIDA (CENTRADO ABSOLUTO) */
            body.premium-design-active #panel-filtros-tradicional { 
                border-color: ${c1} !important; 
                width: 92% !important; /* Reduce el ancho sutilmente para alinearse con los inputs de arriba */
                margin-top: 25px !important;
    margin-bottom: 25px !important;
    margin-left: 2% !important;   /* 🔥 ESTO ES LO QUE LO MUEVE A LA IZQUIERDA */
    margin-right: auto !important; /* Todo el espacio sobrante se va a la derecha */
                box-sizing: border-box !important; 
                display: block !important;
                position: relative !important;
                left: 0 !important;
                right: 0 !important;
                float: none !important;
            }
            
            body.premium-design-active .linea-objetivo-tradicional { border-top-color: ${c1} !important; filter: drop-shadow(0 4px 10px rgba(${rgb1}, 0.7)) !important; }
            body.premium-design-active .caja-carrusel-tradicional-gigante { border-color: ${c1} !important; box-shadow: 0 0 30px rgba(${rgb1}, 0.25), inset 0 0 20px rgba(0,0,0,0.7) !important; }
            body.premium-design-active #live-status-tradicional { color: ${c1} !important; text-shadow: 0 0 10px rgba(${rgb1}, 0.3) !important; }
            body.premium-design-active .contenedor-ganadores-abajo h3 { color: ${c1} !important; text-shadow: 0 0 10px rgba(${rgb1}, 0.2) !important; }
            body.premium-design-active .ganador-item-tradicional .user { color: ${c1} !important; }
        `;
    }

    // Function transformarArchivoABase64 permanece idéntica...
    window.transformarArchivoABase64 = function(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = error => reject(error);
            reader.readAsDataURL(file);
        });
    };

    window.aplicarPersonalizacion = async function() {
        window.customConfig.titulo = document.getElementById('cust-titulo').value.trim();
        if (document.getElementById('cust-inicio').value.trim()) window.customConfig.inicio = document.getElementById('cust-inicio').value.trim();
        if (document.getElementById('cust-ganador').value.trim()) {
            window.customConfig.ganador1 = document.getElementById('cust-ganador').value.trim();
            window.customConfig.ganador3 = document.getElementById('cust-ganador').value.trim();
        }

        const esVasos = document.getElementById('pantalla-vasos').classList.contains('active');
        
        if (!esVasos) {
            for (let i = 1; i <= 8; i++) {
                const inputColor = document.getElementById(`rc-${i}`);
                if (inputColor) window.customConfig.ruletaColores[i - 1] = inputColor.value;
            }
        }

        window.customConfig.color1 = document.getElementById('cust-color1').value;
        window.customConfig.color2 = document.getElementById('cust-color2').value;
        
        if (document.getElementById('cust-color-vaso')) {
            window.customConfig.colorVaso = document.getElementById('cust-color-vaso').value;
        }

        document.documentElement.style.setProperty('--premium-c1', window.customConfig.color1);
        document.documentElement.style.setProperty('--premium-c2', window.customConfig.color2);
        document.documentElement.style.setProperty('--premium-cup-color', window.customConfig.colorVaso || "#ff1a1a");

        const fLogo = document.getElementById('cust-logo').files[0];
        const fStart = document.getElementById('cust-avatar-inicio').files[0];
        const fEnd = document.getElementById('cust-avatar-fin').files[0];
        const fEspera = document.getElementById('cust-avatar-espera').files[0];

        if (fLogo) window.customConfig.logoSrc = await window.transformarArchivoABase64(fLogo);
        if (fStart) window.customConfig.avatarStartSrc = await window.transformarArchivoABase64(fStart);
        if (fEnd) window.customConfig.avatarEndSrc = await window.transformarArchivoABase64(fEnd);
        if (fEspera) window.customConfig.avatarEsperaSrc = await window.transformarArchivoABase64(fEspera);

        reinyectarEstilosPremiumCSS();
        
        let idActual = 'pantalla-ruleta';
        if (document.getElementById('pantalla-tragaperras').classList.contains('active')) idActual = 'pantalla-tragaperras';
        if (document.getElementById('pantalla-vasos').classList.contains('active')) idActual = 'pantalla-vasos';
        if (document.getElementById('pantalla-tradicional').classList.contains('active')) idActual = 'pantalla-tradicional';
        
        sincronizarEntornoDeDiseno(idActual);

        document.getElementById('modal-personalizacion').classList.add('hidden');
        mostrarAlertaKZ("DISEÑO APLICADO", "El entorno y los avatares se han configurado con éxito.", "exito");
    };

    window.guardarAjustesPermanentes = async function() {
        await window.aplicarPersonalizacion();
        localStorage.setItem('kz_premium_saved_config', JSON.stringify(window.customConfig));
        document.getElementById('kz-custom-alert').classList.add('hidden');
        setTimeout(() => {
            mostrarAlertaKZ("💾 MARCA GUARDADA", "Los logos, colores de la rueda y frases se han guardado permanentemente en este dispositivo.", "exito");
        }, 150);
    };

    // =================================================================
    // 6. NAVEGACIÓN Y PANTALLA COMPLETA (SINCRO MULTI-BOTÓN GLOBAL)
    // =================================================================
    const btnsFullscreen = document.querySelectorAll('.btn-fullscreen-toggle');
    
    btnsFullscreen.forEach(btn => {
        btn.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen()
                    .catch(err => console.error(`Error al entrar en Pantalla Completa: ${err.message}`));
            } else {
                document.exitFullscreen()
                    .catch(err => console.error(`Error al salir de Pantalla Completa: ${err.message}`));
            }
        });
    });

    document.addEventListener('fullscreenchange', () => {
        const btnsGlobales = document.querySelectorAll('.btn-fullscreen-toggle');
        if (!document.fullscreenElement) {
            btnsGlobales.forEach(b => {
                b.textContent = '⛶';
                b.title = 'Pantalla Completa';
            });
        } else {
            btnsGlobales.forEach(b => {
                b.textContent = '🗗';
                b.title = 'Salir de Pantalla Completa';
            });
        }
    });

    // =================================================================
    // 7. LÓGICA DE LA RULETA CLÁSICA (SISTEMA MULTI-GIRO SECUENCIAL AUTOMÁTICO)
    // =================================================================
    const canvas = document.getElementById('canvas-ruleta');
    const ctx = canvas.getContext('2d');
    const inputRuleta = document.getElementById('nombres-ruleta');
    const btnGirar = document.getElementById('btn-girar-ruleta');
    const btnMezclar = document.getElementById('btn-mezclar');
    const btnReiniciar = document.getElementById('btn-reiniciar');
    const btnStop = document.getElementById('btn-stop');
    const avisoKem = document.getElementById('kem-aviso-ruleta');
    
    const timerInput = document.getElementById('input-cuenta');
    const winnersInput = document.getElementById('input-ganadores');
    const timerOverlay = document.getElementById('timerOverlay');
    const wheelWrapper = document.getElementById('ruleta-caja-animada');

    const modalGanador = document.getElementById('modal-ganador');
    const tituloModal = document.getElementById('modal-titulo-dinamico');
    const nombreDisplay = document.getElementById('nombre-ganador-display');
    const btnConservar = document.getElementById('btn-conservar-ganador');
    const btnEliminar = document.getElementById('btn-eliminar-ganador');

    const avatarWidget = document.getElementById('avatarWidget');
    const avatarBubble = document.getElementById('avatarBubble');
    const avatarImgStart = document.getElementById('avatarImgStart');
    const avatarImgEnd = document.getElementById('avatarImgEnd');

    let currentAngle = 0; let isSpinning = false; let countdownInterval = null;
    let spinAnimationFrameId = null; let participantes = []; let indicesGanadoresRecientes = []; 
    let veniaGirando = false;
    let ganadorPrincipalPrecalculado = null; 

    // 🎡 VARIABLES PREMIUM DE CONTROL PARA RÁFAGAS MULTI-GIRO
    let totalGanadoresPedidos = 0;
    let ganadoresAcumulados = [];
    let giroActualSorteo = 0;
    let timeoutProximoGiro = null;

    function obtenerNombres() { return inputRuleta.value.split('\n').map(n => n.trim()).filter(n => n !== ""); }

    inputRuleta.addEventListener('input', () => { participantes = obtenerNombres(); dibujarRuleta(); });

    btnMezclar.addEventListener('click', () => {
        if(isSpinning) return;
        participantes = participantes.sort(() => Math.random() - 0.5);
        inputRuleta.value = participantes.join('\n'); dibujarRuleta();
    });

    btnReiniciar.addEventListener('click', () => {
        if(isSpinning) return;
        inputRuleta.value = ""; participantes = []; currentAngle = 0;
        timerInput.value = 3; winnersInput.value = 1;
        avatarWidget.classList.remove('active');
        if (timeoutProximoGiro) { clearTimeout(timeoutProximoGiro); timeoutProximoGiro = null; }
        dibujarRuleta();
    });

    function dibujarEjeCentral(centro, radio) {
        const isLight = document.body.classList.contains('light-theme');
        ctx.beginPath(); 
        ctx.arc(centro, centro, radio * 0.15, 0, 2 * Math.PI);
        ctx.fillStyle = isLight ? "#ffffff" : "#0d0d14"; 
        ctx.fill();
        ctx.lineWidth = 4; 
        ctx.strokeStyle = "#ff6600"; 
        ctx.stroke();
    }

    function dibujarRuleta() {
        const isLight = document.body.classList.contains('light-theme');
        const totalReal = participantes.length;
        const radio = canvas.width / 2;
        const centro = radio;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (totalReal === 0) {
            ctx.beginPath(); 
            ctx.arc(centro, centro, radio - 5, 0, 2 * Math.PI);
            ctx.fillStyle = isLight ? "#e0e0e5" : "#0d0d14"; 
            ctx.fill();
            ctx.fillStyle = isLight ? "#666666" : "#4a4a5e"; 
            ctx.font = "bold 16px 'Segoe UI', Arial";
            ctx.textAlign = "center"; 
            ctx.textBaseline = "middle";
            ctx.fillText("Esperando nombres...", centro, centro - 45);
            dibujarEjeCentral(centro, radio); 
            if(avisoKem) avisoKem.classList.add('hidden');
            return;
        }

        if (avisoKem) {
            if (totalReal > 150) avisoKem.classList.remove('hidden');
            else avisoKem.classList.add('hidden');
        }

        const visualTotal = Math.min(totalReal, 150);
        const arcSize = (2 * Math.PI) / visualTotal;
        const showNames = totalReal <= 80;
        const showDots  = totalReal > 80; 

        for (let i = 0; i < visualTotal; i++) {
            const angle = currentAngle + i * arcSize;
            ctx.beginPath(); 
            
            ctx.fillStyle = window.esModoPremium 
                ? window.customConfig.ruletaColores[i % window.customConfig.ruletaColores.length]
                : colores[i % colores.length];
            
            ctx.moveTo(centro, centro); 
            ctx.arc(centro, centro, radio - 5, angle, angle + arcSize); 
            ctx.fill();
            
            if (visualTotal > 1) { 
                ctx.lineWidth = 1; 
                ctx.strokeStyle = "#2d2d3f"; 
                ctx.stroke(); 
            }

            if (showNames || showDots) {
                ctx.save(); 
                ctx.translate(centro, centro);
                
                if (visualTotal === 1) {
                    ctx.textAlign = "center"; 
                    ctx.textBaseline = "middle"; 
                    ctx.fillStyle = "#0d0d14"; 
                    ctx.font = "bold 24px 'Segoe UI', Arial";
                    ctx.fillText(participantes[i].length > 15 ? participantes[i].substring(0, 15) + "..." : participantes[i], 0, -45); 
                } else {
                    ctx.rotate(angle + arcSize / 2); 
                    ctx.textAlign = "right"; 
                    ctx.textBaseline = "middle"; 
                    ctx.fillStyle = (ctx.fillStyle === "#1a1a24" || ctx.fillStyle === "#0d0d14") ? "#ffffff" : "#0d0d14";
                    
                    if (showNames) {
                        let fontSize = 15; 
                        if (visualTotal > 15) fontSize = 12; 
                        if (visualTotal > 30) fontSize = 10;
                        if (visualTotal > 50) fontSize = 8;
                        
                        ctx.font = `bold ${fontSize}px 'Segoe UI', Arial`;
                        ctx.shadowColor = "rgba(0,0,0,0.5)"; 
                        ctx.shadowBlur = 4;
                        
                        let textToDraw = participantes[i];
                        let maxWidth = radio - 40;
                        
                        while (ctx.measureText(textToDraw + "...").width > maxWidth && textToDraw.length > 0) {
                            textToDraw = textToDraw.slice(0, -1);
                        }
                        if (participantes[i].length > textToDraw.length) {
                            textToDraw += "...";
                        }
                        ctx.fillText(textToDraw, radio - 20, 0);
                    } else if (showDots) {
                        ctx.font = `bold 10px 'Segoe UI', Arial`;
                        ctx.fillText("•••••••", radio - 20, 0);
                    }
                }
                ctx.restore();
            }
        }
        dibujarEjeCentral(centro, radio);
    }

    // 🔥 DETONADOR DEL SORTEO (INICIALIZA EL LOTE COMPLETO)
    btnGirar.addEventListener('click', () => {
        if (window.esModoPremium && typeof window.reaplicarFiltrosLive === 'function') {
            window.reaplicarFiltrosLive();
            participantes = obtenerNombres(); 
        }

        if (participantes.length < 1 || isSpinning) return;
        
        // 1. Configurar lote de ganadores inicial
        totalGanadoresPedidos = parseInt(winnersInput.value) || 1;
        totalGanadoresPedidos = Math.min(totalGanadoresPedidos, participantes.length);
        ganadoresAcumulados = [];
        giroActualSorteo = 0;

        isSpinning = true; 
        btnGirar.style.opacity = "0.5"; 
        btnStop.classList.remove('hidden'); 
        
        avatarImgStart.style.display = 'block'; 
        avatarImgEnd.style.display = 'none';
        avatarWidget.classList.remove('side-left', 'active'); 
        avatarWidget.classList.add('side-right');
        
        setTimeout(() => {
            avatarBubble.textContent = window.customConfig.inicio;
            avatarWidget.classList.add('active'); 
            playEffect(audioAvatar, 'volAvatar');
        }, 50);
        
        wheelWrapper.classList.add('pre-spin'); 
        let countdownTime = parseInt(timerInput.value) || 0;

        if (countdownTime === 0) {
            wheelWrapper.classList.remove('pre-spin'); 
            avatarWidget.classList.remove('active');
            ejecutarCicloDeGiro(); 
            return;
        }

        timerOverlay.textContent = countdownTime; 
        timerOverlay.classList.add('active', 'counting');

        if (!checkMute.checked && !document.hidden) {
            audioCountdown.currentTime = 0; 
            audioCountdown.volume = document.getElementById('volCountdown').value / 100;
            audioCountdown.play().catch(e => {});
        }

        countdownInterval = setInterval(() => {
            countdownTime--;
            if (countdownTime > 0) { 
                timerOverlay.textContent = countdownTime; 
            } else {
                clearInterval(countdownInterval); 
                countdownInterval = null;
                audioCountdown.pause(); 
                audioCountdown.currentTime = 0;
                timerOverlay.classList.remove('active', 'counting'); 
                wheelWrapper.classList.remove('pre-spin');
                avatarWidget.classList.remove('active'); 
                setTimeout(ejecutarCicloDeGiro, 200); 
            }
        }, 1000);
    });

    // 🚀 EXECUTOR INDIVIDUAL DE GIROS (MÓDULO REACTIVO AL VOLUMEN DE GANADORES)
    function ejecutarCicloDeGiro() {
        if (!isSpinning) return;

        // Filtrar pool para que un usuario no pueda coronar dos veces en la misma ráfaga
        let disponibles = participantes.filter(p => !ganadoresAcumulados.includes(p));
        if (disponibles.length === 0) {
            terminarLoteSorteo();
            return;
        }

        // Precalculamos el ganador de este giro particular
        let nombreGanadorRonda = disponibles[Math.floor(Math.random() * disponibles.length)];
        ganadorPrincipalPrecalculado = participantes.indexOf(nombreGanadorRonda);

        // 🔥 DURACIÓN DINÁMICA: 1 ganador = 6500ms. Cada ganador extra acelera la rueda hasta un suelo estable de 2600ms.
        let duration = 6500;
        if (totalGanadoresPedidos > 1) {
            duration = Math.max(2500, 6500 - (totalGanadoresPedidos - 1) * 800);
        }

        const startTimestamp = performance.now();
        let visualTotal = Math.min(participantes.length, 150);
        let totalRotation;

        if (ganadorPrincipalPrecalculado < visualTotal) {
            let maxRotations = 15 + Math.floor(Math.random() * 5); 
            if (duration < 4000) maxRotations = 6 + Math.floor(Math.random() * 3); // Menos fricción si va rápido

            const arcSizeMain = (2 * Math.PI) / visualTotal;
            let targetNormalizedAngle = ganadorPrincipalPrecalculado * arcSizeMain + (arcSizeMain / 2);
            let desiredCurrentAngle = 1.5 * Math.PI - targetNormalizedAngle;
            
            while(desiredCurrentAngle < currentAngle) desiredCurrentAngle += 2 * Math.PI;
            desiredCurrentAngle += maxRotations * 2 * Math.PI;
            totalRotation = desiredCurrentAngle - currentAngle;
        } else {
            let vueltas = (15 + Math.random() * 10);
            if (duration < 4000) vueltas = (7 + Math.random() * 4);
            totalRotation = vueltas * Math.PI * 2;
        }

        const initialAngle = currentAngle;

        if (!checkMute.checked && !document.hidden) {
            audioSpin.currentTime = 0; 
            audioSpin.volume = document.getElementById('volSpin').value / 100;
            audioSpin.play().catch(e => {});
        }

        function animate(timestamp) {
            if (!isSpinning) return;
            const elapsed = timestamp - startTimestamp; 
            const progress = Math.min(elapsed / duration, 1);
            const easeOut = 1 - Math.pow(1 - progress, 4); 
            
            currentAngle = initialAngle + (easeOut * totalRotation); 
            dibujarRuleta();

            if (!checkMute.checked && !document.hidden) {
                audioSpin.volume = (document.getElementById('volSpin').value / 100) * (1 - progress);
            }

            if (progress < 1) { 
                spinAnimationFrameId = requestAnimationFrame(animate); 
            } else { 
                spinAnimationFrameId = null; 
                audioSpin.pause(); 
                
                // Consolidar ganador de esta ronda
                ganadoresAcumulados.push(nombreGanadorRonda);
                giroActualSorteo++;

                // Transición al festejo intermedio
                celebrarGanadorIntermedio(nombreGanadorRonda);
            }
        }
        spinAnimationFrameId = requestAnimationFrame(animate);
    }

    // 🎉 CELEBRACIÓN INTERMEDIA Y RE-LANZAMIENTO AUTOMÁTICO (CON AUDIO DE BÚSQUEDA AÑADIDO)
    function celebrarGanadorIntermedio(nombreWinner) {
        // Confeti y audio garantizados con coordenadas fijas en cada iteración de la ráfaga
        confetti({ particleCount: 60, spread: 70, origin: { x: 0.5, y: 0.5 } });
        playEffect(audioConfetti, 'volConfetti');
        
        // 1. Apagamos y movemos de bando primero para reiniciar el estado de la transición
        avatarWidget.classList.remove('side-right', 'active'); 
        avatarWidget.classList.add('side-left');
        
        avatarImgStart.style.display = 'none'; 
        avatarImgEnd.style.display = 'block';
        avatarBubble.textContent = `¡Ganador #${giroActualSorteo}: ${nombreWinner}! 🏆`;
        
        // Pequeña pausa para que el navegador registre el cambio de lado antes de deslizar
        setTimeout(() => {
            avatarWidget.classList.add('active');
            playEffect(audioAvatar, 'volAvatar');
        }, 50);

        // ¿Quedan giros por hacer?
        if (giroActualSorteo < totalGanadoresPedidos) {
            timeoutProximoGiro = setTimeout(() => {
                avatarWidget.classList.remove('active');
                
                timeoutProximoGiro = setTimeout(() => {
                    // Volvemos a alternar el bando limpiamente
                    avatarWidget.classList.remove('side-left');
                    avatarWidget.classList.add('side-right');
                    
                    avatarImgStart.style.display = 'block'; 
                    avatarImgEnd.style.display = 'none';
                    avatarBubble.textContent = "¡Buscando al siguiente ganador...! 👀";
                    
                    // 🔥 AJUSTE: Se añade el playEffect para que suene el "whoosh" al salir a buscar al siguiente
                    setTimeout(() => {
                        avatarWidget.classList.add('active');
                        playEffect(audioAvatar, 'volAvatar');
                    }, 50);
                    
                    // Relanzamiento en piloto automático
                    ejecutarCicloDeGiro();
                }, 400);
            }, 2000); 
        } else {
            // Lote terminado, disparamos modal general de cierre
            setTimeout(terminarLoteSorteo, 1000);
        }
    }

    // 🏆 CIERRE GLOBAL: DESPLIEGA EL CONJUNTO FINAL DE CORONADOS (SIN WHOOSH REPETITIVO)
    function terminarLoteSorteo() {
        isSpinning = false; 
        btnGirar.style.opacity = "1"; 
        btnStop.classList.add('hidden');
        
        if (btnEliminar) btnEliminar.style.display = 'inline-block';

        // Vincular índices para el correcto descarte con el botón eliminar
        indicesGanadoresRecientes = ganadoresAcumulados.map(name => participantes.indexOf(name)).filter(idx => idx !== -1);

        avatarImgStart.style.display = 'none'; 
        avatarImgEnd.style.display = 'block';
        
        avatarWidget.classList.add('side-left');
        avatarWidget.classList.add('active'); 

        if (ganadoresAcumulados.length === 1) {
            tituloModal.textContent = "🎉 ¡TENEMOS UN GANADOR! 🎉"; 
            const winnerName = ganadoresAcumulados[0];
            const dataUsuario = window.comentariosDict ? window.comentariosDict[winnerName] : null;

            if (dataUsuario) {
                const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(winnerName.replace('@',''))}&background=ff6600&color=fff&size=128`;
                const avatarSrc = dataUsuario.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUsuario.profilePicUrl)}` : fallbackAvatar;
                
                nombreDisplay.innerHTML = `
                    <div class="winner-rich-card">
                        <img src="${avatarSrc}" onerror="this.onerror=null; this.src='${fallbackAvatar}';" alt="Foto de perfil">
                        <h3>${winnerName}</h3>
                        <p class="winner-comment">"${dataUsuario.text || 'Participante cargado correctamente.'}"</p>
                    </div>
                `;
            } else {
                nombreDisplay.innerHTML = winnerName;
            }
            
            avatarBubble.textContent = window.customConfig.ganador1.replace('{nombre}', winnerName);
        } else {
            tituloModal.textContent = "🏆 ¡LOS GANADORES SON! 🏆";
            
            let listItems = ganadoresAcumulados.map((w, i) => {
                const dataUsuario = window.comentariosDict ? window.comentariosDict[w] : null;
                if (dataUsuario) {
                    const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(w.replace('@',''))}&background=00ffcc&color=0d0d14&size=64`;
                    const avatarSrc = dataUsuario.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUsuario.profilePicUrl)}` : fallbackAvatar;
                    return `
                        <li class="multi-winner-rich">
                            <img src="${avatarSrc}" onerror="this.onerror=null; this.src='${fallbackAvatar}';" alt="Avatar">
                            <div class="multi-winner-info">
                                <strong>#${i + 1} ${w}</strong>
                                <span class="multi-winner-text">"${dataUsuario.text || 'Participante válido.'}"</span>
                            </div>
                        </li>
                    `;
                } else {
                    return `<li><strong>#${i + 1}</strong> ${w}</li>`;
                }
            }).join('');
            
            nombreDisplay.innerHTML = `<ul class="lista-multi-ganadores rich-list">${listItems}</ul>`;
            avatarBubble.textContent = window.customConfig.ganador3.replace('{nombre}', ganadoresAcumulados.length);
        }

        modalGanador.classList.remove('hidden');
        confetti({ particleCount: 150, spread: 80, origin: { x: 0.5, y: 0.6 } });
        playEffect(audioConfetti, 'volConfetti');
        
        // Animación limpia con la propiedad independiente 'scale' (No rompe el espejo CSS)
        avatarImgEnd.animate([
            { scale: '1' },
            { scale: '0.86 0.86' }, 
            { scale: '1' }
        ], {
            duration: 350,
            easing: 'ease-in-out'
        });

        // 🔥 AJUSTE: Se eliminó la línea playEffect(audioAvatar) de aquí para evitar ruidos duplicados en la lista final
    }

    // 🛑 CONTROL DE PARADA DE EMERGENCIA MÚLTIPLE
    btnStop.addEventListener('click', () => {
        if (!isSpinning) return;
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
        if (spinAnimationFrameId) { cancelAnimationFrame(spinAnimationFrameId); spinAnimationFrameId = null; }
        if (timeoutProximoGiro) { clearTimeout(timeoutProximoGiro); timeoutProximoGiro = null; } 
        
        audioCountdown.pause(); audioCountdown.currentTime = 0; 
        audioSpin.pause(); audioSpin.currentTime = 0;

        isSpinning = false; 
        btnGirar.style.opacity = "1"; 
        btnStop.classList.add('hidden');
        timerOverlay.classList.remove('active', 'counting'); 
        wheelWrapper.classList.remove('pre-spin');
        avatarWidget.classList.remove('active'); 
        dibujarRuleta();
    });

    btnConservar.addEventListener('click', () => { 
        modalGanador.classList.add('hidden'); 
        avatarWidget.classList.remove('active'); 
    });
    
    btnEliminar.addEventListener('click', () => {
        indicesGanadoresRecientes.sort((a, b) => b - a);
        indicesGanadoresRecientes.forEach(idx => { participantes.splice(idx, 1); });
        inputRuleta.value = participantes.join('\n'); 
        dibujarRuleta(); 
        modalGanador.classList.add('hidden'); 
        avatarWidget.classList.remove('active');
    });

    // =================================================================
    // 8. MÁQUINA TRAGAPERRAS 3D (SLOTS)
    // =================================================================
    const inputTragaperras = document.getElementById('nombres-tragaperras');
    const resTragaperras = document.getElementById('resultado-tragaperras');
    
    let tragaperrasGirando = false;
    let countdownIntervalSlots = null;
    let slotTimeouts = []; 
    
    const btnStopSlots = document.getElementById('btn-stop-slots');
    const timerInputSlots = document.getElementById('input-cuenta-slots');
    const timerOverlaySlots = document.getElementById('timerOverlaySlots');
    const wheelWrapperSlots = document.getElementById('slots-caja-animada');
    const btnReiniciarSlots = document.getElementById('btn-reiniciar-slots');

    if(btnReiniciarSlots) {
        btnReiniciarSlots.addEventListener('click', () => {
            if (tragaperrasGirando) return; 
            inputTragaperras.value = "";
            if(timerInputSlots) timerInputSlots.value = 3;
            document.getElementById('select-modo-slots').value = "3";
            resTragaperras.textContent = "Tira de la palanca...";
            
            [1, 2, 3].forEach(num => {
                const reelStrip = document.getElementById(`reel-${num}`);
                if(reelStrip) {
                    reelStrip.style.transition = 'none';
                    reelStrip.style.transform = 'translateY(0)';
                    reelStrip.innerHTML = `<div class="reel-item">?</div>`;
                }
            });
        });
    }

    window.girarTragaperras = function() {
        if (tragaperrasGirando) return; 

        const nombres = inputTragaperras.value.split('\n').map(n => n.trim()).filter(n => n !== "");
        const modoJuego = document.getElementById('select-modo-slots').value;

        if (modoJuego === "3" && nombres.length < 3) {
            mostrarAlertaKZ("DATOS INSUFICIENTES", "Para seleccionar 3 ganadores en este modo de juego, debes ingresar al menos 3 nombres en la lista.");
            return;
        }
        if (modoJuego === "1" && nombres.length < 1) {
            mostrarAlertaKZ("LISTA VACÍA", "Por favor, ingresa al menos un nombre en el campo de texto para poder iniciar el juego.");
            return;
        }

        const leverArm = document.getElementById('lever-arm');
        if(leverArm) {
            leverArm.classList.add('pulled');
            setTimeout(() => { leverArm.classList.remove('pulled'); }, 400); 
        }

        tragaperrasGirando = true;
        resTragaperras.textContent = "Preparando motores...";
        if(btnStopSlots) btnStopSlots.classList.remove('hidden'); 

        if (avatarImgStart) {
            avatarImgStart.src = (window.esModoPremium && window.customConfig.avatarSlotsStartSrc) ? window.customConfig.avatarSlotsStartSrc : 'imagenes/slots-inicio.png';
        }

        avatarImgStart.style.display = 'block'; 
        avatarImgEnd.style.display = 'none';
        avatarWidget.classList.remove('side-left', 'active'); 
        avatarWidget.classList.add('side-right');
        
        setTimeout(() => {
            const frasePersonalizada = document.getElementById('cust-inicio')?.value.trim();
            avatarBubble.textContent = frasePersonalizada ? frasePersonalizada : "¡Se viene el tragaperras, activos! 🎰";
            
            avatarWidget.classList.add('active'); 
            playEffect(audioAvatar, 'volAvatar');
        }, 50);

        let countdownTime = parseInt(timerInputSlots ? timerInputSlots.value : 0) || 0;

        if (countdownTime === 0) {
            avatarWidget.classList.remove('active'); 
            iniciarRotacionSlots(nombres, modoJuego);
            return;
        }

        if(timerOverlaySlots) {
            timerOverlaySlots.textContent = countdownTime; 
            timerOverlaySlots.classList.add('active', 'counting');
        }
        if(wheelWrapperSlots) wheelWrapperSlots.classList.add('pre-spin');

        if (!checkMute.checked && !document.hidden) {
            audioCountdown.currentTime = 0; 
            audioCountdown.volume = document.getElementById('volCountdown').value / 100;
            audioCountdown.play().catch(e => {});
        }

        countdownIntervalSlots = setInterval(() => {
            countdownTime--;
            if (countdownTime > 0) { 
                if(timerOverlaySlots) timerOverlaySlots.textContent = countdownTime; 
            } else {
                clearInterval(countdownIntervalSlots); 
                countdownIntervalSlots = null;
                audioCountdown.pause(); 
                audioCountdown.currentTime = 0;
                
                if(timerOverlaySlots) timerOverlaySlots.classList.remove('active', 'counting'); 
                if(wheelWrapperSlots) wheelWrapperSlots.classList.remove('pre-spin');
                
                avatarWidget.classList.remove('active'); 
                setTimeout(() => { iniciarRotacionSlots(nombres, modoJuego); }, 200); 
            }
        }, 1000);
    }

    function iniciarRotacionSlots(nombres, modoJuego) {
        if (!tragaperrasGirando) return; 

        resTragaperras.textContent = "Girando...";

        if (!checkMute.checked && !document.hidden) {
            audioSpin.currentTime = 0; 
            audioSpin.volume = document.getElementById('volSpin').value / 100;
            audioSpin.play().catch(e => {});
        }

        const nombresMezclados = [...nombres].sort(() => 0.5 - Math.random());
        let ganadores = [];

        if (modoJuego === "1") {
            const unicoGanador = nombresMezclados[0];
            ganadores = [unicoGanador, unicoGanador, unicoGanador];
        } else {
            ganadores = [nombresMezclados[0], nombresMezclados[1], nombresMezclados[2]];
        }

        // 🎯 AJUSTE DE TIEMPO EXACTO: 6 segundos para el primer resultado, manteniendo el escalonado clásico original
        // 🎯 LA MATEMÁTICA EXACTA: 3s de cuenta + 3s de giro = 6 segundos exactos para revelar al primer ganador
        prepararYAnimarRodillo(1, ganadores[0], nombres, 8000); 
        prepararYAnimarRodillo(2, ganadores[1], nombres, 8500); 
        prepararYAnimarRodillo(3, ganadores[2], nombres, 9000); 

        slotTimeouts.push(setTimeout(() => { playEffect(audioCoin, 'volCoin'); }, 8000));
        slotTimeouts.push(setTimeout(() => { playEffect(audioCoin, 'volCoin'); }, 8500));
        slotTimeouts.push(setTimeout(() => { playEffect(audioCoin, 'volCoin'); }, 9000));

        slotTimeouts.push(setTimeout(() => {
            if (modoJuego === "1") {
                resTragaperras.textContent = `🎰 ¡GRAN GANADOR: ${ganadores[0]}! 🎰`;
            } else {
                resTragaperras.textContent = `🎉 ¡Ganadores: ${ganadores[0]}, ${ganadores[1]} y ${ganadores[2]}! 🎉`;
            }
            
            playEffect(audioConfetti, 'volConfetti');
            if (!document.hidden) confetti({ particleCount: 200, spread: 90, origin: { y: 0.6 } });
            
            audioSpin.pause();
            tragaperrasGirando = false;
            if(btnStopSlots) btnStopSlots.classList.add('hidden'); 
            
            avatarImgStart.style.display = 'none'; 
            avatarImgEnd.style.display = 'block';
            avatarWidget.classList.remove('side-right', 'active'); 
            avatarWidget.classList.add('side-left');

            if (modoJuego === "1") {
                avatarBubble.textContent = window.customConfig.ganador1.replace('{nombre}', ganadores[0]);
            } else {
                avatarBubble.textContent = window.customConfig.ganador3.replace('{nombre}', ganadores.length);
            }

            setTimeout(() => { 
                avatarWidget.classList.add('active'); 
                playEffect(audioAvatar, 'volAvatar'); 
            }, 50);

            slotTimeouts.push(setTimeout(() => {
                avatarWidget.classList.remove('active');
            }, 6050)); 

            setTimeout(() => {
                if (btnEliminar) btnEliminar.style.display = 'none'; 

                if (modoJuego === "1") {
                    tituloModal.textContent = "🎉 ¡TENEMOS UN GANADOR! 🎉"; 
                    const winnerName = ganadores[0];
                    const dataUsuario = window.comentariosDict ? window.comentariosDict[winnerName] : null;

                    if (dataUsuario) {
                        const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(winnerName.replace('@',''))}&background=ff6600&color=fff&size=128`;
                        const avatarSrc = dataUsuario.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUsuario.profilePicUrl)}` : fallbackAvatar;
                        
                        nombreDisplay.innerHTML = `
                            <div class="winner-rich-card">
                                <img src="${avatarSrc}" onerror="this.src='${fallbackAvatar}'" alt="Foto de perfil">
                                <h3>${winnerName}</h3>
                                <p class="winner-comment">"${dataUsuario.text || 'Participante cargado correctamente.'}"</p>
                            </div>
                        `;
                    } else {
                        nombreDisplay.innerHTML = `<span style="font-size: 2.5rem; font-weight: 900; color: #ff6600; text-shadow: 0 0 10px rgba(255,102,0,0.3);">${winnerName}</span>`;
                    }
                } else {
                    tituloModal.textContent = "🏆 ¡LOS 3 GANADORES! 🏆";
                    
                    let listItems = [ganadores[0], ganadores[1], ganadores[2]].map((w, i) => {
                        const dataUsuario = window.comentariosDict ? window.comentariosDict[w] : null;
                        if (dataUsuario) {
                            const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(w.replace('@',''))}&background=00ffcc&color=0d0d14&size=64`;
                            const avatarSrc = dataUsuario.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUsuario.profilePicUrl)}` : fallbackAvatar;
                            return `
                                <li class="multi-winner-rich">
                                    <img src="${avatarSrc}" onerror="this.src='${fallbackAvatar}'" alt="Avatar">
                                    <div class="multi-winner-info">
                                        <strong>#${i + 1} ${w}</strong>
                                        <span class="multi-winner-text">"${dataUsuario.text || 'Participante válido.'}"</span>
                                    </div>
                                </li>
                            `;
                        } else {
                            return `<li style="background: rgba(255, 102, 0, 0.1); border: 1px solid rgba(255, 102, 0, 0.2); padding: 10px; border-radius: 10px; font-size: 1.1rem; color: white;"><strong>#${i + 1}</strong> ${w}</li>`;
                        }
                    }).join('');
                    
                    nombreDisplay.innerHTML = `<ul class="lista-multi-ganadores rich-list" style="display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 420px; margin: 0 auto;">${listItems}</ul>`;
                }

                modalGanador.classList.remove('hidden');
            }, 400);
            
        }, 9100)); // Dispara el modal final justo después de los 9 segundos del último rodillo
    }

    function prepararYAnimarRodillo(numeroRodillo, nombreGanador, listaNombres, tiempoFrenado) {
        const reelStrip = document.getElementById(`reel-${numeroRodillo}`);
        reelStrip.style.transition = 'none';
        reelStrip.style.transform = 'translateY(0)';
        
        let html = '';
        const cantidadRelleno = 40; 
        
        for (let i = 0; i < cantidadRelleno; i++) {
            const nombreAleatorio = listaNombres[Math.floor(Math.random() * listaNombres.length)];
            
            if (window.esModoPremium && window.comentariosDict && window.comentariosDict[nombreAleatorio]) {
                const dataUsuario = window.comentariosDict[nombreAleatorio];
                const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nombreAleatorio.replace('@',''))}&background=ff6600&color=fff&size=128`;
                const avatarSrc = dataUsuario.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUsuario.profilePicUrl)}` : fallbackAvatar;
                
                html += `
                    <div class="reel-item" style="display: flex !important; justify-content: center; align-items: center; height: 100px;">
                        <img src="${avatarSrc}" onerror="this.src='${fallbackAvatar}'" class="slot-avatar-spin" style="width: 75px; height: 75px; border-radius: 50%; border: 2px solid #00ffcc; object-fit: cover; flex-shrink: 0; box-shadow: 0 0 12px rgba(0, 255, 204, 0.5);">
                    </div>`;
            } else {
                html += `<div class="reel-item">${nombreAleatorio}</div>`;
            }
        }
        
        if (window.esModoPremium && window.comentariosDict && window.comentariosDict[nombreGanador]) {
            const dataGanador = window.comentariosDict[nombreGanador];
            const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(nombreGanador.replace('@',''))}&background=ff00ff&color=fff&size=128`;
            const avatarSrc = dataGanador.profilePicUrl ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataGanador.profilePicUrl)}` : fallbackAvatar;
            
            html += `
                <div class="reel-item" style="display: flex !important; justify-content: center; align-items: center; height: 100px;">
                    <img src="${avatarSrc}" onerror="this.src='${fallbackAvatar}'" style="width: 85px; height: 85px; border-radius: 50%; border: 3px solid #ff00ff; object-fit: cover; flex-shrink: 0; box-shadow: 0 0 18px rgba(255, 0, 255, 0.8); animation: pulseTimer 0.5s infinite alternate;">
                </div>`;
        } else {
            html += `<div class="reel-item" style="color: #ff00ff; font-size: 1.3rem !important; text-shadow: 0 0 10px rgba(255,0,255,0.8);">${nombreGanador}</div>`;
        }
        
        html += `<div class="reel-item">?</div>`;
        html += `<div class="reel-item">?</div>`;
        
        reelStrip.innerHTML = html;
        reelStrip.offsetHeight; 

        const alturaItem = 100; 
        const distanciaBajar = -(cantidadRelleno * alturaItem); // ✅ Unido correctamente

        reelStrip.style.transition = `transform ${tiempoFrenado}ms cubic-bezier(0.1, 0.7, 0.1, 1)`;
        reelStrip.style.transform = `translateY(${distanciaBajar}px)`;
    }

    if(btnStopSlots) {
        btnStopSlots.addEventListener('click', () => {
            if (!tragaperrasGirando) return;
            if (countdownIntervalSlots) { clearInterval(countdownIntervalSlots); countdownIntervalSlots = null; }
            slotTimeouts.forEach(t => clearTimeout(t));
            slotTimeouts = [];

            audioCountdown.pause(); audioCountdown.currentTime = 0; 
            audioSpin.pause(); audioSpin.currentTime = 0;

            tragaperrasGirando = false; 
            btnStopSlots.classList.add('hidden');
            if(timerOverlaySlots) timerOverlaySlots.classList.remove('active', 'counting'); 
            if(wheelWrapperSlots) wheelWrapperSlots.classList.remove('pre-spin');
            resTragaperras.textContent = "Tira de la palanca...";

            avatarWidget.classList.remove('active'); 

            [1, 2, 3].forEach(num => {
                const reelStrip = document.getElementById(`reel-${num}`);
                reelStrip.style.transition = 'none';
                reelStrip.style.transform = 'translateY(0)';
                reelStrip.innerHTML = `<div class="reel-item">?</div>`;
            });
        });
    }

    // =================================================================
    // 9. MOTOR DE FILTROS AVANZADOS EN TIEMPO REAL (REACTIVO)
    // =================================================================
    window.toggleFiltrosPanel = function(btn, panelId) {
        const panel = document.getElementById(panelId);
        const arrow = btn.querySelector('.arrow-icon');
        
        actualizarEstrellasFiltros();

        if (panel.classList.contains('hidden')) {
            panel.classList.remove('hidden');
            arrow.textContent = '▲';
            btn.style.borderColor = '#ff6600';
        } else {
            panel.classList.add('hidden');
            arrow.textContent = '▼';
            btn.style.borderColor = 'rgba(255,255,255,0.2)';
        }
    };

    window.interceptarFiltroManual = function(event, tipoHerramienta) {
        if (window.esModoPremium) return;

        event.preventDefault();
        event.stopPropagation();

        mostrarAlertaKZ("APARTADO EXCLUSIVO", "Esta configuración forma parte de las herramientas avanzadas de extracción automatizada.");
        
        const alertBtn = document.getElementById('kz-alert-btn');
        alertBtn.innerHTML = "IR A VERSIÓN PREMIUM 🚀";
        
        alertBtn.onclick = () => {
            document.getElementById('kz-custom-alert').classList.add('hidden');
            cerrarModales();
            mostrarPantalla('main-menu');
            setTimeout(() => { window.abrirModalRedes(tipoHerramienta); }, 350);
        };
    };

    function aplicarFiltrosDeSorteo(comentariosCrudos, maquina) {
        let maquinaReal = maquina;
        if (!maquinaReal) {
            if (document.getElementById('pantalla-ruleta').classList.contains('active')) maquinaReal = 'ruleta';
            else if (document.getElementById('pantalla-tragaperras').classList.contains('active')) maquinaReal = 'slots';
            else if (document.getElementById('pantalla-vasos').classList.contains('active')) maquinaReal = 'vasos';
            else if (document.getElementById('pantalla-tradicional').classList.contains('active')) maquinaReal = 'tradicional';
        }

        const idPanel = (maquinaReal === 'ruleta') ? 'panel-filtros-ruleta' : 
                        (maquinaReal === 'slots' ? 'panel-filtros-slots' : 
                        (maquinaReal === 'tradicional' ? 'panel-filtros-tradicional' : 'panel-filtros-vasos'));
        const panelContenedor = document.getElementById(idPanel);

        if (!panelContenedor) return comentariosCrudos;

        const sufijo = (maquinaReal === 'ruleta') ? '-ruleta' : 
                       ((maquinaReal === 'slots') ? '-slots' : 
                       (maquinaReal === 'tradicional' ? '-tradicional' : '-vasos'));

        const chkDuplicados = panelContenedor.querySelector(`#filtro-duplicados${sufijo}`)?.checked || false;
        const minMenciones = parseInt(panelContenedor.querySelector(`#filtro-menciones${sufijo}`)?.value) || 0;
        const reqHashtag = (panelContenedor.querySelector(`#filtro-hashtag${sufijo}`)?.value || "").trim().toLowerCase();
        const reqMencion = (panelContenedor.querySelector(`#filtro-mencion-directa${sufijo}`)?.value || "").trim().toLowerCase();
        const minPalabras = parseInt(panelContenedor.querySelector(`#filtro-longitud${sufijo}`)?.value) || 0;
        const excluirTexto = (panelContenedor.querySelector(`#filtro-excluir${sufijo}`)?.value || "").toLowerCase();
        const excluidos = excluirTexto.split('\n').map(n => n.trim().replace('@', '')).filter(n => n !== "");

        let filtrados = [];
        let usuariosVistos = new Set();

        for (const c of comentariosCrudos) {
            const uname = (c.username || "usuario_desconocido").toLowerCase();
            const texto = (c.text || "").toLowerCase();

            if (excluidos.includes(uname)) continue;

            if (chkDuplicados) {
                if (usuariosVistos.has(uname)) continue;
                usuariosVistos.add(uname);
            }

            if (minPalabras > 0) {
                const words = texto.split(/\s+/).filter(w => w.length > 0);
                if (words.length < minPalabras) continue;
            }

            if (minMenciones > 0) {
                const countMentions = (texto.match(/@[\w.]+/g) || []).length;
                if (countMentions < minMenciones) continue;
            }

            if (reqHashtag) {
                const cleanHash = reqHashtag.startsWith('#') ? reqHashtag : '#' + reqHashtag;
                if (!texto.includes(cleanHash)) continue;
            }

            if (reqMencion) {
                const cleanMention = reqMencion.startsWith('@') ? reqMencion : '@' + reqMencion;
                if (!texto.includes(cleanMention)) continue;
            }

            filtrados.push(c);
        }
        return filtrados;
    }

    window.reaplicarFiltrosLive = function() {
        if (!window.comentariosCrudosGlobal || window.comentariosCrudosGlobal.length === 0) return;
        
        let maquinaActiva = 'ruleta';
        if (document.getElementById('pantalla-tragaperras').classList.contains('active')) maquinaActiva = 'slots';
        if (document.getElementById('pantalla-vasos').classList.contains('active')) maquinaActiva = 'vasos';
        
        const comentariosFiltrados = aplicarFiltrosDeSorteo(window.comentariosCrudosGlobal, maquinaActiva);
        
        window.comentariosDict = {}; 
        let listaFormateada = "";

        comentariosFiltrados.forEach(c => {
            const unameFormateado = "@" + c.username;
            listaFormateada += `${unameFormateado}\n`;
            if (!window.comentariosDict[unameFormateado]) {
                window.comentariosDict[unameFormateado] = c;
            }
        });

        if (maquinaActiva === 'ruleta') {
            const txtArea = document.getElementById('nombres-ruleta');
            if (txtArea) {
                txtArea.value = listaFormateada.trim();
                txtArea.dispatchEvent(new Event('input')); 
            }
        } else if (maquinaActiva === 'slots') {
            const txtAreaTraga = document.getElementById('nombres-tragaperras');
            if (txtAreaTraga) txtAreaTraga.value = listaFormateada.trim();
        } else if (maquinaActiva === 'vasos') {
            const txtAreaVasos = document.getElementById('nombres-vasos');
            if (txtAreaVasos) txtAreaVasos.value = listaFormateada.trim();
        }
    };

// =================================================================
    // 10. TIENDA DE TOKEMS Y PROCESADOR DE EXTRACCIÓN AUTOMATIZADA
    // =================================================================
    const modalRedes = document.getElementById('modal-redes');
    const modalUrl = document.getElementById('modal-url');
    const modalPreview = document.getElementById('modal-preview');
    const tituloRedActiva = document.getElementById('titulo-red-activa');
    const inputUrlPost = document.getElementById('input-url-post');
    const modalTienda = document.getElementById('modal-tienda');
    const displayTokensGlobal = document.getElementById('token-saldo-display');

    let maquinaDestino = ''; 
    let redSeleccionada = ''; 
    let saldoTokens = 0; 
    let costoSorteoActual = 0;

    // 🎯 GESTIÓN DE CIERRES COERCITIVOS (INTERCEPTOR)
    function gestionarCierreProceso(funcionCierreOriginal) {
        // Caso base: no hay ninguna petición HTTP activa en curso
        if (!apiAbortController) {
            funcionCierreOriginal();
            return;
        }

        // CASO 1: Estamos buscando el enlace inicial (TikTok o Instagram)
        if (!faseExtraccionReal) {
            apiAbortController.abort(); // Corta el fetch inmediatamente
            apiAbortController = null;
            funcionCierreOriginal(); // Cierra las ventanas normales
            console.log("Búsqueda inicial abortada de forma segura.");
        } 
        // CASO 2: Extrayendo comentarios reales (Fase crítica de pérdida de Token)
        else {
            const modalConfirm = document.getElementById('cancel-confirm-modal');
            if (modalConfirm) modalConfirm.style.display = 'flex';

            // Confirmar salir del proceso y sacrificar token
            document.getElementById('btn-abort-confirm').onclick = function() {
                if (apiAbortController) apiAbortController.abort();
                apiAbortController = null;
                if (modalConfirm) modalConfirm.style.display = 'none';
                funcionCierreOriginal(); // Rompe vistas y regresa al menú
            };

            // Cancelar el aviso y seguir esperando en la pantalla actual
            document.getElementById('btn-abort-cancel').onclick = function() {
                if (modalConfirm) modalConfirm.style.display = 'none';
            };
        }
    }

    window.abrirModalTienda = function() { modalTienda.classList.remove('hidden'); }
    window.cerrarModalTienda = function() { modalTienda.classList.add('hidden'); }

    window.comprarTokens = function(cantidad, nombrePlan) {
        const unidadTexto = cantidad === 1 ? 'Tokem' : 'Tokems';
        mostrarAlertaKZ("COMPRA EXITOSA", `Has adquirido el paquete ${nombrePlan}. Se han acreditado ${cantidad} ${unidadTexto} a tu saldo de KEMZONE.`, 'exito');
        saldoTokens += cantidad;
        actualizarSaldoUI();
        cerrarModalTienda();
    }

    function actualizarSaldoUI() {
        if(displayTokensGlobal) {
            displayTokensGlobal.textContent = saldoTokens;
            const badge = document.getElementById('global-token-badge');
            badge.style.transform = 'scale(1.2)';
            badge.style.borderColor = '#00ffcc';
            setTimeout(() => {
                badge.style.transform = 'scale(1)';
                badge.style.borderColor = 'rgba(255, 215, 0, 0.5)';
            }, 300);
        }
    }

    window.abrirModalRedes = function(maquina) {
        maquinaDestino = maquina;
        const labelTitulo = document.getElementById('titulo-modal-redes');
        if (labelTitulo) {
            if (maquina === 'ruleta') labelTitulo.innerHTML = "Ruleta Premium";
            else if (maquina === 'tragaperras') labelTitulo.innerHTML = "Tragaperras Premium";
            else if (maquina === 'vasos') labelTitulo.innerHTML = "Vasos Premium";
            else if (maquina === 'tradicional') labelTitulo.innerHTML = "Sorteo Tradicional Premium"; 
        }
        modalRedes.classList.remove('hidden');
    }

    window.abrirModalURL = function(red) {
        redSeleccionada = red;
        modalRedes.classList.add('hidden');
        tituloRedActiva.textContent = `Enlace de ${red}`;
        inputUrlPost.placeholder = (red === 'Instagram') ? "Ej: https://www.instagram.com/p/XYZ..." : "Ej: https://www.tiktok.com/@user/video/123...";
        inputUrlPost.value = ''; 
        modalUrl.classList.remove('hidden');

        const hoy = new Date().toLocaleDateString();
        let previewDate = localStorage.getItem('kz_preview_date');
        let previewCount = parseInt(localStorage.getItem('kz_preview_count') || '0');
        if (previewDate !== hoy) previewCount = 0;
        const displayCount = document.getElementById('preview-count-display');
        if (displayCount) displayCount.textContent = previewCount;
    }

    // 🎯 ENVOLTURAS PREMIUM PARA INTERCEPTAR CLICS EN BOTONES VOLVER Y CERRAR
    window.volverModalRedes = function() { 
        gestionarCierreProceso(() => { modalUrl.classList.add('hidden'); modalRedes.classList.remove('hidden'); }); 
    }
    window.volverModalUrl = function() { 
        gestionarCierreProceso(() => { modalPreview.classList.add('hidden'); modalUrl.classList.remove('hidden'); }); 
    }
    window.cerrarModales = function() { 
        gestionarCierreProceso(() => { modalRedes.classList.add('hidden'); modalUrl.classList.add('hidden'); modalPreview.classList.add('hidden'); }); 
    }

    window.simularExtraccion = async function() {
        const url = inputUrlPost.value.trim();
        if (url === "") {
            mostrarAlertaKZ("ENLACE REQUERIDO", "Por favor, ingresa una URL válida para poder realizar la extracción.");
            return;
        }
        
        window.urlActualPost = url; 

        let hardwareUUID = localStorage.getItem('kz_hardware_uuid');
        if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Device) {
            try {
                const infoDispositivo = await window.Capacitor.Plugins.Device.getId();
                hardwareUUID = infoDispositivo.uuid;
            } catch(e) {}
        }
        if (!hardwareUUID) {
            hardwareUUID = 'kz_web_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
            localStorage.setItem('kz_hardware_uuid', hardwareUUID);
        }

        const hoy = new Date().toLocaleDateString();
        let previewDate = localStorage.getItem('kz_preview_date');
        let previewCount = parseInt(localStorage.getItem('kz_preview_count') || '0');

        if (previewDate !== hoy) {
            previewCount = 0;
            localStorage.setItem('kz_preview_date', hoy);
            localStorage.setItem('kz_preview_count', '0');
        }

        if (previewCount >= 3) {
            mostrarAlertaKZ("ACCESO RESTRINGIDO", "Límite diario de previsualizaciones agotado por hoy.");
            return;
        }

        // 🎯 COBRO ANTICIPADO: Lo sumamos al iniciar
        previewCount++;
        localStorage.setItem('kz_preview_count', previewCount);
        
        const displayCount = document.getElementById('preview-count-display');
        if (displayCount) displayCount.textContent = previewCount;
        
        const btn = document.querySelector('.btn-extraer');
        btn.innerHTML = `⏳ Conectando (Suele tardar 30s)...`;
        btn.classList.add('loading-active'); 
        btn.style.opacity = "0.7";
        btn.style.pointerEvents = "none";
        
        apiAbortController = new AbortController();
        faseExtraccionReal = false;

        try {
            const response = await fetch('http://localhost:3000/api/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: url, deviceId: hardwareUUID }),
                signal: apiAbortController.signal 
            });

            const data = await response.json();

            // Si hay un error del servidor o enlace inválido
            if (response.status === 429 || data.error) {
                if (response.status === 429) {
                    localStorage.setItem('kz_preview_count', '3');
                    if (displayCount) displayCount.textContent = '3';
                } else {
                    // 🔄 SISTEMA DE REEMBOLSO: Fue un error de enlace, no del usuario. Le devolvemos su previsualización.
                    let c = parseInt(localStorage.getItem('kz_preview_count') || '1');
                    if (c > 0) { 
                        c--; 
                        localStorage.setItem('kz_preview_count', c); 
                        if (displayCount) displayCount.textContent = c; 
                    }
                }
                
                let msgFinal = data.error || "Se ha excedido el límite de hardware permitido por hoy.";
                if (msgFinal.includes("input.directUrls") || msgFinal.includes("regular expression")) {
                    msgFinal = "El enlace proporcionado no es válido. Por favor, verifica la URL e intenta nuevamente.";
                }
                mostrarAlertaKZ("ERROR DE EXTRACCIÓN", msgFinal);
                return;
            }

            const authorEl = document.getElementById('preview-author');
            if (authorEl) authorEl.textContent = data.author || '@Participante';

            const descEl = document.getElementById('preview-desc');
            if (descEl) descEl.textContent = data.description || 'Sin descripción.';
            
            const totalComments = data.commentsCount || 0;
            const commentsEl = document.getElementById('preview-comments');
            if (commentsEl) commentsEl.textContent = totalComments.toLocaleString();

            if (document.getElementById('preview-likes')) {
                document.getElementById('preview-likes').textContent = (data.likesCount || 0).toLocaleString(); 
            }

            if (totalComments <= 300) costoSorteoActual = 1;
            else if (totalComments <= 600) costoSorteoActual = 2;
            else if (totalComments <= 1000) costoSorteoActual = 3;
            else if (totalComments <= 2000) costoSorteoActual = 6;
            else if (totalComments <= 4000) costoSorteoActual = 12;
            else if (totalComments <= 10000) costoSorteoActual = 24;
            else costoSorteoActual = 48;

            const warningEl = document.getElementById('preview-warning-tokens');
            if (warningEl) {
                warningEl.innerHTML = `<div style="width: 100%; text-align: center; color: #fff; font-size: 0.9rem; padding: 0; display: flex; justify-content: center; align-items: center; column-gap: 8px; row-gap: 3px; flex-wrap: wrap; line-height: 1.2;">
                    <span>¡Wow! <b>${totalComments.toLocaleString()}</b> comentarios</span>
                    <span style="color: rgba(255,255,255,0.3);">•</span>
                    <span>Se requiere: <b>${costoSorteoActual} Tokem</b> 🪙</span>
                </div>`;
            }

            const btnDesbloquear = document.getElementById('btn-desbloquear-sorteo');
            if (btnDesbloquear) btnDesbloquear.innerHTML = `Realizar Sorteo x ${costoSorteoActual} 🪙`;
            
            const coverEl = document.getElementById('preview-cover');
            if (coverEl) {
                coverEl.innerHTML = '';
                if (data.displayUrl) {
                    const proxyCover = `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(data.displayUrl)}`;
                    const imgCover = document.createElement('img');
                    imgCover.style.cssText = "width:100%; height:100%; border-radius:16px; object-fit:cover;";
                    imgCover.src = proxyCover; 
                    imgCover.onerror = function() { this.style.display = 'none'; coverEl.innerHTML = '📸'; };
                    coverEl.appendChild(imgCover);
                } else {
                    coverEl.innerHTML = '📸';
                }
            }

            modalUrl.classList.add('hidden');
            modalPreview.classList.remove('hidden');
            
        } catch (error) {
            // Si el usuario presionó la "X" a propósito, asumimos el cobro.
            if (error.name === 'AbortError') {
                console.log("Petición abortada voluntariamente. Extracción cobrada.");
                return;
            }
            
            // 🔄 SISTEMA DE REEMBOLSO: Falló el internet o el servidor. Devolvemos la previsualización.
            let c = parseInt(localStorage.getItem('kz_preview_count') || '1');
            if (c > 0) { 
                c--; 
                localStorage.setItem('kz_preview_count', c); 
                const displayCount = document.getElementById('preview-count-display');
                if (displayCount) displayCount.textContent = c; 
            }
            
            mostrarAlertaKZ("SERVIDOR DESCONECTADO", "No se pudo conectar con KEMZONE o hubo un fallo de red.");
        } finally {
            apiAbortController = null; 
            btn.innerHTML = "Extraer Comentarios 🚀";
            btn.classList.remove('loading-active'); 
            btn.style.opacity = "1";
            btn.style.pointerEvents = "auto";
        }
    };

    window.cargarDatosEnRuleta = async function() {
        const btnCargar = document.getElementById('btn-desbloquear-sorteo');
        const textoOriginal = btnCargar.innerHTML;
        
        btnCargar.innerHTML = "⏳ Extrayendo datos reales (Esto toma minutos)...";
        btnCargar.classList.add('loading-active'); 
        btnCargar.style.opacity = "0.7";
        btnCargar.style.pointerEvents = "none";
        
        apiAbortController = new AbortController();
        faseExtraccionReal = true;

        try {
            let hardwareUUID = localStorage.getItem('kz_hardware_uuid');
            
            const response = await fetch('http://localhost:3000/api/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: window.urlActualPost, deviceId: hardwareUUID }),
                signal: apiAbortController.signal 
            });

            const contentType = response.headers.get("content-type");
            if (!contentType || !contentType.includes("application/json")) {
                throw new Error("El servidor experimentó un fallo interno.");
            }

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            window.comentariosCrudosGlobal = data.comments || [];
            const comentariosFiltrados = aplicarFiltrosDeSorteo(window.comentariosCrudosGlobal, maquinaDestino);

            if (comentariosFiltrados.length === 0) {
                throw new Error("No quedó ningún participante después de aplicar los filtros.");
            }

            window.comentariosDict = {}; 
            let listaFormateada = "";

            comentariosFiltrados.forEach(c => {
                const unameFormateado = "@" + c.username;
                listaFormateada += `${unameFormateado}\n`;
                if (!window.comentariosDict[unameFormateado]) {
                    window.comentariosDict[unameFormateado] = c;
                }
            });

            apiAbortController = null;
            cerrarModales(); 
            window.esModoPremium = true; 

            if (maquinaDestino === 'ruleta') {
                mostrarPantalla('pantalla-ruleta');
                const txtArea = document.getElementById('nombres-ruleta');
                txtArea.value = listaFormateada.trim();
                txtArea.dispatchEvent(new Event('input')); 
            } else if (maquinaDestino === 'tragaperras' || maquinaDestino === 'slots') {
                mostrarPantalla('pantalla-tragaperras');
                document.getElementById('nombres-tragaperras').value = listaFormateada.trim();
            } else if (maquinaDestino === 'vasos') {
                mostrarPantalla('pantalla-vasos');
                document.getElementById('nombres-vasos').value = listaFormateada.trim();
            } else if (maquinaDestino === 'tradicional') {
                mostrarPantalla('pantalla-tradicional');
                const txtTradicional = document.getElementById('nombres-tradicional');
                if (txtTradicional) txtTradicional.value = listaFormateada.trim();
                const ribbonTradicional = document.getElementById('carrusel-ribbon');
                if (ribbonTradicional) ribbonTradicional.innerHTML = ""; 
                const statusTradicional = document.getElementById('status-tradicional');
                if (statusTradicional) {
                    statusTradicional.textContent = `Participantes cargados: ${comentariosFiltrados.length}. ¡Listo!`;
                } else {
                    const liveStatus = document.getElementById('live-status-tradicional');
                    if (liveStatus) liveStatus.textContent = `Participantes cargados: ${comentariosFiltrados.length}.`;
                }
            }
            
            const plataformaActiva = window.urlActualPost.includes('tiktok.com') ? 'TikTok' : 'Instagram';
            mostrarAlertaKZ("CARGA EXITOSA", `Se han procesado ${window.comentariosCrudosGlobal.length} comentarios de ${plataformaActiva} correctamente.`, "exito");
            
            maquinaDestino = ''; 
            redSeleccionada = '';

        } catch (err) {
            // Si abortas saliendo intencionalmente de la advertencia roja, pierdes tus Tokems
            if (err.name === 'AbortError') {
                console.log("Raspado masivo cancelado. Tokems consumidos por penalización de salida.");
                return;
            }
            
            // 🔄 REEMBOLSO DE TOKEMS: Si el servidor falla o Apify se cae, devolvemos tu dinero al instante
            saldoTokens += costoSorteoActual;
            actualizarSaldoUI();
            
            mostrarAlertaKZ("FALLO DE EXTRACCIÓN", err.message || "Ocurrió un error. Tus Tokems han sido devueltos a tu cuenta.");
        } finally {
            apiAbortController = null;
            btnCargar.innerHTML = textoOriginal;
            btnCargar.classList.remove('loading-active'); 
            btnCargar.style.opacity = "1";
            btnCargar.style.pointerEvents = "auto";
        }
    }
    
    window.procesarPagoYcargar = function() {
        const unidadRequerida = costoSorteoActual === 1 ? 'Tokem' : 'Tokems';
        const unidadSaldo = saldoTokens === 1 ? 'Tokem' : 'Tokems';

        if (saldoTokens >= costoSorteoActual) {
            saldoTokens -= costoSorteoActual;
            actualizarSaldoUI();
            cargarDatosEnRuleta();
        } else {
            // 🎯 1. Eliminamos el texto de "redirigiendo..." y mostramos la alerta de forma estática
            mostrarAlertaKZ("TOKEMS INSUFICIENTES", `Este sorteo requiere ${costoSorteoActual} ${unidadRequerida} y tu saldo actual es de ${saldoTokens} ${unidadSaldo}.`);
            
            // 🎯 2. Interceptamos el botón ACEPTAR para darle el comportamiento de triple acción
            const alertBtn = document.getElementById('kz-alert-btn');
            if (alertBtn) {
                alertBtn.onclick = function() {
                    // Paso A: Ocultar la alerta de emergencia de tokens insuficientes
                    document.getElementById('kz-custom-alert').classList.add('hidden');
                    
                    // Paso B: Ocultar la ventana de publicación encontrada por debajo
                    const modalPreview = document.getElementById('modal-preview');
                    if (modalPreview) modalPreview.classList.add('hidden');
                    
                    // Paso C: Abrir la tienda de manera inmediata y directa
                    abrirModalTienda();
                };
            }
        }
    };

    window.cargarDatosEnRuleta = async function() {
        const btnCargar = document.getElementById('btn-desbloquear-sorteo');
        const textoOriginal = btnCargar.innerHTML;
        
        btnCargar.innerHTML = "⏳ Extrayendo datos reales (Esto toma minutos)...";
        btnCargar.classList.add('loading-active'); 
        btnCargar.style.opacity = "0.7";
        btnCargar.style.pointerEvents = "none";
        
        // 🎯 INICIALIZACIÓN DE INTERRUPTOR FASE 2 (ZONA CRÍTICA)
        apiAbortController = new AbortController();
        faseExtraccionReal = true;

        try {
            let hardwareUUID = localStorage.getItem('kz_hardware_uuid');
            
            const response = await fetch('http://localhost:3000/api/comments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: window.urlActualPost, deviceId: hardwareUUID }),
                signal: apiAbortController.signal // 🎯 ASOCIACIÓN AL AVISO DE CONTROL DE PÉRDIDA DE TOKEN
            });

            const contentType = response.headers.get("content-type");
            if (!contentType || !contentType.includes("application/json")) {
                throw new Error("El servidor de KEMZONE experimentó un fallo interno (HTML). Revisa la consola de Node.");
            }

            const data = await response.json();
            if (data.error) throw new Error(data.error);

            window.comentariosCrudosGlobal = data.comments || [];
            
            const comentariosFiltrados = aplicarFiltrosDeSorteo(window.comentariosCrudosGlobal, maquinaDestino);

            if (comentariosFiltrados.length === 0) {
                throw new Error("No quedó ningún participante después de aplicar los filtros iniciales.");
            }

            window.comentariosDict = {}; 
            let listaFormateada = "";

            comentariosFiltrados.forEach(c => {
                const unameFormateado = "@" + c.username;
                listaFormateada += `${unameFormateado}\n`;
                if (!window.comentariosDict[unameFormateado]) {
                    window.comentariosDict[unameFormateado] = c;
                }
            });

            // 🎯 DESVINCULAR CONTROLADOR ANTES DE LIMPIAR VENTANAS (Éxito completo)
            apiAbortController = null;

            cerrarModales(); 
            window.esModoPremium = true; 

            if (maquinaDestino === 'ruleta') {
                mostrarPantalla('pantalla-ruleta');
                const txtArea = document.getElementById('nombres-ruleta');
                txtArea.value = listaFormateada.trim();
                txtArea.dispatchEvent(new Event('input')); 
            } else if (maquinaDestino === 'tragaperras' || maquinaDestino === 'slots') {
                mostrarPantalla('pantalla-tragaperras');
                document.getElementById('nombres-tragaperras').value = listaFormateada.trim();
            } else if (maquinaDestino === 'vasos') {
                mostrarPantalla('pantalla-vasos');
                document.getElementById('nombres-vasos').value = listaFormateada.trim();
            } else if (maquinaDestino === 'tradicional') {
                mostrarPantalla('pantalla-tradicional');
                
                const txtTradicional = document.getElementById('nombres-tradicional');
                if (txtTradicional) {
                    txtTradicional.value = listaFormateada.trim();
                }
                
                const ribbonTradicional = document.getElementById('carrusel-ribbon');
                if (ribbonTradicional) {
                    ribbonTradicional.innerHTML = ""; 
                }
                
                const statusTradicional = document.getElementById('status-tradicional');
                if (statusTradicional) {
                    statusTradicional.textContent = `Participantes cargados: ${comentariosFiltrados.length}. ¡Listo!`;
                } else {
                    const liveStatus = document.getElementById('live-status-tradicional');
                    if (liveStatus) liveStatus.textContent = `Participantes cargados: ${comentariosFiltrados.length}.`;
                }
            }
            
            const plataformaActiva = window.urlActualPost.includes('tiktok.com') ? 'TikTok' : 'Instagram';
            mostrarAlertaKZ("CARGA EXITOSA", `Se han procesado ${window.comentariosCrudosGlobal.length} comentarios de ${plataformaActiva} correctamente.`, "exito");
            
            maquinaDestino = ''; 
            redSeleccionada = '';

        } catch (err) {
            // 🎯 INTERCEPTACIÓN PURA EN FASE 2: Evitamos lanzar la alerta de error genérica del catch
            if (err.name === 'AbortError') {
                console.log("Raspado de datos masivo cancelado voluntariamente por el usuario.");
                return;
            }
            mostrarAlertaKZ("FALLO DE EXTRACCIÓN", err.message || "Ocurrió un error obteniendo los comentarios reales.");
        } finally {
            apiAbortController = null;
            btnCargar.innerHTML = textoOriginal;
            btnCargar.classList.remove('loading-active'); 
            btnCargar.style.opacity = "1";
            btnCargar.style.pointerEvents = "auto";
        }
    }

    // =================================================================
    // 11. SISTEMA COMPLEMENTARIO CONFIGURACIÓN TEMA NATIVO
    // =================================================================
    const modalConfig = document.getElementById('modal-configuracion');
    const themeToggle = document.getElementById('theme-toggle');
    const themeIcon   = document.getElementById('theme-icon');
    const langSelect  = document.getElementById('lang-select');

    window.abrirModalConfig = function() { modalConfig.classList.remove('hidden'); }
    window.cerrarModalConfig = function() { modalConfig.classList.add('hidden'); }

    if (localStorage.getItem('kz_theme') === 'light') {
        document.body.classList.add('light-theme');
        themeToggle.checked = true;
        themeIcon.textContent = '☀️';
    } else {
        themeIcon.textContent = '🌙';
    }
    if (localStorage.getItem('kz_lang')) langSelect.value = localStorage.getItem('kz_lang');

    themeToggle.addEventListener('change', () => {
        if (themeToggle.checked) {
            document.body.classList.add('light-theme');
            localStorage.setItem('kz_theme', 'light');
            themeIcon.textContent = '☀️';
        } else {
            document.body.classList.remove('light-theme');
            localStorage.setItem('kz_theme', 'dark');
            themeIcon.textContent = '🌙';
        }
        dibujarRuleta(); 
    });
    langSelect.addEventListener('change', () => { localStorage.setItem('kz_lang', langSelect.value); });

    // =================================================================
    // 12. LISTENERS COMPACTOS PARA LOS PANELES DE FILTROS PREMIUM
    // =================================================================
    ['panel-filtros-ruleta', 'panel-filtros-slots', 'panel-filtros-vasos'].forEach(panelId => {
        const panel = document.getElementById(panelId);
        if (panel) {
            panel.querySelectorAll('input, textarea, select').forEach(input => {
                input.addEventListener('input', () => window.reaplicarFiltrosLive());
                input.addEventListener('change', () => window.reaplicarFiltrosLive());
            });
        }
    });

// =================================================================
    // 13. RESTAURACIÓN DE CONFIGURACIÓN DE FÁBRICA (PREMIUM RESET)
    // =================================================================
    const btnResetParam = document.getElementById('btn-reset-personalizacion');
    if (btnResetParam) {
        btnResetParam.addEventListener('click', () => {
            localStorage.removeItem('kz_premium_saved_config');

            // Devolver configuraciones a estado de fábrica
            window.customConfig = {
                titulo: "",
                inicio: "¡Se viene la ruleta, activos!",
                ganador1: "¡Felicidades {nombre}! Tú coronaste hoy.",
                ganador3: "¡Felicidades a los {nombre} ganadores! Coronaron duro.",
                color1: "#ff6600",
                color2: "#00ffcc",
                colorVaso: "#ff1a1a",
                logoSrc: null,
                avatarStartSrc: null,
                avatarEndSrc: null,
                avatarEsperaSrc: null,
                ruletaColores: ["#ff6600", "#00ffcc", "#ff00ff", "#b052ff", "#ccff00", "#33ccff", "#ff3366", "#00ff66"]
            };

            const esTradActive = document.getElementById('pantalla-tradicional').classList.contains('active');

            if (document.getElementById('cust-titulo')) document.getElementById('cust-titulo').value = "";
            if (document.getElementById('cust-inicio')) document.getElementById('cust-inicio').value = "";
            if (document.getElementById('cust-ganador')) document.getElementById('cust-ganador').value = "";
            
            if (document.getElementById('cust-color1')) {
                document.getElementById('cust-color1').value = esTradActive ? "#ffd700" : "#ff6600";
            }
            if (document.getElementById('cust-color2')) document.getElementById('cust-color2').value = "#00ffcc";
            if (document.getElementById('cust-color-vaso')) document.getElementById('cust-color-vaso').value = "#ff1a1a";

            document.documentElement.style.setProperty('--premium-c1', esTradActive ? '#ffd700' : '#ff6600');
            document.documentElement.style.setProperty('--premium-c2', '#00ffcc');
            document.documentElement.style.setProperty('--premium-cup-color', '#ff1a1a');

            ['cust-logo', 'cust-avatar-inicio', 'cust-avatar-fin', 'cust-avatar-espera'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = "";
            });

            for (let i = 1; i <= 8; i++) {
                const inputColor = document.getElementById(`rc-${i}`);
                if (inputColor) inputColor.value = window.customConfig.ruletaColores[i - 1];
            }

            reinyectarEstilosPremiumCSS();

            let idActual = 'pantalla-ruleta';
            if (document.getElementById('pantalla-tragaperras').classList.contains('active')) idActual = 'pantalla-tragaperras';
            if (document.getElementById('pantalla-vasos').classList.contains('active')) idActual = 'pantalla-vasos';
            if (document.getElementById('pantalla-tradicional').classList.contains('active')) idActual = 'pantalla-tradicional';
            
            sincronizarEntornoDeDiseno(idActual);

            document.getElementById('modal-personalizacion').classList.add('hidden');
            window.mostrarAlertaKZ("DISEÑO REINICIADO", "Los avatares, colores y títulos han vuelto a su estado original de fábrica.", "exito");
        });
    }

    // =================================================================
    // 🎯 MOTOR DE ANIMACIÓN HORIZONTAL: SORTEO TRADICIONAL PREMIUM
    // =================================================================
    let tradicionalGirando = false;
    let tradicionalCountdown = null;
    let tradicionalTimeouts = [];
    
    let tradGanadoresPedidos = 0;
    let tradGanadoresAcumulados = [];
    let tradRondaActual = 0;

    window.iniciarSorteoTradicional = function() {
        if (tradicionalGirando || tradicionalCountdown) return;

        const nombresEl = document.getElementById('nombres-tradicional');
        if (!nombresEl) {
            mostrarAlertaKZ("ERROR DE INTERFAZ", "No se encontró el contenedor de participantes.");
            return;
        }

        let poolNombres = [];
        if (window.comentariosCrudosGlobal && window.comentariosCrudosGlobal.length > 0) {
            const filtradosLive = aplicarFiltrosDeSorteo(window.comentariosCrudosGlobal, 'tradicional');
            poolNombres = filtradosLive.map(c => "@" + c.username);
            
            filtradosLive.forEach(c => {
                window.comentariosDict["@" + c.username] = c;
            });
        } else {
            poolNombres = nombresEl.value.split('\n').filter(n => n.trim() !== "");
        }

        if (poolNombres.length < 1) {
            mostrarAlertaKZ("SIN PARTICIPANTES", "Ningún comentario cumple con los criterios de los filtros avanzados.");
            return;
        }

        tradGanadoresPedidos = parseInt(document.getElementById('input-ganadores-tradicional').value) || 1;
        tradGanadoresPedidos = Math.min(tradGanadoresPedidos, poolNombres.length);
        tradGanadoresAcumulados = [];
        tradRondaActual = 0;

        tradicionalGirando = true;
        
        document.getElementById('panel-config-tradicional').classList.add('hidden');
        document.getElementById('panel-animacion-tradicional').classList.remove('hidden');
        document.getElementById('lista-ganadores-tradicional-live').innerHTML = ""; 
        document.getElementById('live-status-tradicional').textContent = "Preparando sorteo masivo...";

        // 🎯 OCULTAR BOTÓN DE DISEÑO EN LA ANIMACIÓN Y RESULTADOS
        const btnDisenoTrad = document.getElementById('btn-diseno-tradicional');
        if (btnDisenoTrad) btnDisenoTrad.classList.add('hidden');

        const btnStopTrad = document.getElementById('btn-stop-tradicional');
        if (btnStopTrad) btnStopTrad.classList.remove('hidden');

        avatarImgStart.style.display = 'block'; avatarImgEnd.style.display = 'none';
        avatarWidget.classList.remove('side-right', 'active'); avatarWidget.classList.add('side-left');
        setTimeout(() => {
            avatarBubble.textContent = window.customConfig.inicio ? window.customConfig.inicio : "¡Comienza el sorteo tradicional, mucha suerte! 🎟️";
            avatarWidget.classList.add('active');
            playEffect(audioAvatar, 'volAvatar');
        }, 50);

        let countdownTime = parseInt(document.getElementById('input-cuenta-tradicional').value) || 0;
        const overlay = document.getElementById('timerOverlayTradicional');

        if (countdownTime === 0) {
            avatarWidget.classList.remove('active');
            ejecutarGiroTradicional(poolNombres);
            return;
        }

        if (overlay) {
            overlay.textContent = countdownTime;
            overlay.classList.add('active', 'counting');
        }

        playEffect(audioCountdown, 'volCountdown');

        tradicionalCountdown = setInterval(() => {
            countdownTime--;
            if (countdownTime > 0) {
                if (overlay) overlay.textContent = countdownTime;
            } else {
                clearInterval(tradicionalCountdown);
                tradicionalCountdown = null;
                audioCountdown.pause(); audioCountdown.currentTime = 0;
                if (overlay) overlay.classList.remove('active', 'counting');
                avatarWidget.classList.remove('active');
                setTimeout(() => { ejecutarGiroTradicional(poolNombres); }, 200);
            }
        }, 1000);
    };

    function ejecutarGiroTradicional(nombres) {
        if (!tradicionalGirando) return;

        let disponibles = nombres.filter(p => !tradGanadoresAcumulados.includes(p));
        if (disponibles.length === 0) {
            finalizarLoteTradicional();
            return;
        }

        tradRondaActual++;
        document.getElementById('live-status-tradicional').textContent = `Girando cinta... Buscando Ganador #${tradRondaActual} de ${tradGanadoresPedidos}`;

        const ribbon = document.getElementById('carrusel-ribbon');
        ribbon.style.transition = 'none';
        ribbon.style.transform = 'translateX(0)';

        const ganadorRonda = disponibles[Math.floor(Math.random() * disponibles.length)];

        let htmlCinta = "";
        const posicionGanadorEnCinta = 75; 
        const totalItemsCinta = 85; 

        for (let i = 0; i < totalItemsCinta; i++) {
            let candidato = nombres[Math.floor(Math.random() * nombres.length)];
            if (i === posicionGanadorEnCinta) candidato = ganadorRonda;

            const dataUser = window.comentariosDict ? window.comentariosDict[candidato] : null;
            const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(candidato.replace('@',''))}&background=1a1a24&color=ffd700&size=128`;
            const src = (dataUser && dataUser.profilePicUrl) ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataUser.profilePicUrl)}` : fallback;
            
            htmlCinta += `<img src="${src}" onerror="this.src='${fallback}'" class="avatar-cinta-tradicional" alt="User">`;
        }

        ribbon.innerHTML = htmlCinta;
        ribbon.offsetHeight; 

        const marcoContainer = document.getElementById('marco-carrusel-tradicional');
        const anchoCajaContenedora = marcoContainer ? marcoContainer.offsetWidth : 800;
        
        const anchoAvatar = window.innerWidth <= 768 ? 70 : 90;
        const gapFijo = 15;
        const pasoTotalItem = anchoAvatar + gapFijo;

        const centroVisor = anchoCajaContenedora / 2;
        const distanciaAlGanador = (posicionGanadorEnCinta * pasoTotalItem) + (anchoAvatar / 2);
        const puntoDeFrenoExacto = centroVisor - distanciaAlGanador;

        const ticker = document.querySelector('.linea-objetivo-tradicional');
        if (ticker) ticker.classList.add('vibrando');

        if (!checkMute.checked && !document.hidden) {
            audioSpin.currentTime = 0; 
            audioSpin.volume = document.getElementById('volSpin').value / 100;
            audioSpin.play().catch(e => {});
        }

        // 🎯 AJUSTE: Duración exacta de 9 segundos
        ribbon.style.transition = `transform 9000ms cubic-bezier(0.1, 0.85, 0.1, 1)`;
        ribbon.style.transform = `translateX(${puntoDeFrenoExacto}px)`;

        tradicionalTimeouts.push(setTimeout(() => {
            audioSpin.pause();
            if (ticker) ticker.classList.remove('vibrando');

            playEffect(audioCoin, 'volCoin');
            playEffect(audioConfetti, 'volConfetti');
            if (!document.hidden) confetti({ particleCount: 80, spread: 60 });

            tradGanadoresAcumulados.push(ganadorRonda);

            const listaLive = document.getElementById('lista-ganadores-tradicional-live');
            const dataGanador = window.comentariosDict ? window.comentariosDict[ganadorRonda] : null;
            const fallbackG = `https://ui-avatars.com/api/?name=${encodeURIComponent(ganadorRonda.replace('@',''))}&background=ffd700&color=0d0d14&size=64`;
            const srcG = (dataGanador && dataGanador.profilePicUrl) ? `http://localhost:3000/api/proxy-image?url=${encodeURIComponent(dataGanador.profilePicUrl)}` : fallbackG;

            const li = document.createElement('li');
            li.className = 'ganador-item-tradicional';
            li.innerHTML = `
                <img src="${srcG}" onerror="this.src='${fallbackG}'" alt="Winner">
                <div class="detalles">
                    <span class="user">#${tradRondaActual} ${ganadorRonda}</span>
                    <span class="txt">"${dataGanador ? (dataGanador.text || '¡Coronó en sorteo tradicional!') : 'Participante válido.'}"</span>
                </div>
            `;
            if (listaLive) listaLive.insertBefore(li, listaLive.firstChild);

            if (tradGanadoresAcumulados.length < tradGanadoresPedidos) {
                tradicionalTimeouts.push(setTimeout(() => {
                    ribbon.style.transition = 'none';
                    ribbon.style.transform = 'translateX(0)';
                    ejecutarGiroTradicional(nombres);
                }, 1800)); 
            } else {
                finalizarLoteTradicional();
            }

        }, 9100)); 
    }

    function finalizarLoteTradicional() {
        tradicionalGirando = false;
        document.getElementById('live-status-tradicional').textContent = "¡Todos los ganadores han sido seleccionados!";
        const btnStopTrad = document.getElementById('btn-stop-tradicional');
        if (btnStopTrad) btnStopTrad.classList.add('hidden');

        ganadoresAcumulados = tradGanadoresAcumulados;
        indicesGanadoresRecientes = []; 
        
        terminarLoteSorteo();
        if (btnEliminar) btnEliminar.style.display = 'none';
    }

    window.regresarMenuDesdeTradicional = function() {
        window.mostrarPantalla('main-menu');
    };

    const btnVolverTradicional = document.getElementById('btn-volver-tradicional');
    if (btnVolverTradicional) {
        btnVolverTradicional.removeAttribute('onclick'); 
        btnVolverTradicional.addEventListener('click', regresarMenuDesdeTradicional);
    }

    const btnStopTradicional = document.getElementById('btn-stop-tradicional');
    if (btnStopTradicional) {
        btnStopTradicional.addEventListener('click', () => {
            if (tradicionalCountdown) { clearInterval(tradicionalCountdown); tradicionalCountdown = null; }
            tradicionalTimeouts.forEach(t => clearTimeout(t)); tradicionalTimeouts = [];

            audioCountdown.pause(); audioCountdown.currentTime = 0;
            audioSpin.pause(); audioSpin.currentTime = 0;

            tradicionalGirando = false;
            btnStopTradicional.classList.add('hidden');
            
            const overlay = document.getElementById('timerOverlayTradicional');
            if (overlay) overlay.classList.remove('active', 'counting');
            
            const ticker = document.querySelector('.linea-objetivo-tradicional');
            if (ticker) ticker.classList.remove('vibrando');

            document.getElementById('panel-config-tradicional').classList.remove('hidden');
            document.getElementById('panel-animacion-tradicional').classList.add('hidden');
            const ribbon = document.getElementById('carrusel-ribbon');
            if (ribbon) ribbon.innerHTML = "";
            
            // 🎯 MOSTRAR EL BOTÓN DE DISEÑO AL REGRESAR AL PANEL DE FILTROS
            const btnDisenoTrad = document.getElementById('btn-diseno-tradicional');
            if (btnDisenoTrad) btnDisenoTrad.classList.remove('hidden');

            avatarWidget.classList.remove('side-right');
            avatarWidget.classList.add('side-left', 'active');
            avatarWidget.classList.remove('active');
        });
    }

    const btnRegresarConfigTrad = document.getElementById('btn-regresar-config-tradicional');
    if (btnRegresarConfigTrad) {
        btnRegresarConfigTrad.addEventListener('click', () => {
            const btnStopTrad = document.getElementById('btn-stop-tradicional');
            if (btnStopTrad) {
                btnStopTrad.click(); 
                document.getElementById('live-status-tradicional').textContent = "Regresaste a la configuración. Ajusta los filtros y reintenta.";
            }
        });
    }

// 🎟️ CONTROLADORES DEL MODAL DE CANJE PREPAGO
    window.abrirModalCanjear = function() {
        document.getElementById('modal-canjear').classList.remove('hidden');
    };
    
    window.cerrarModalCanjear = function() {
        document.getElementById('modal-canjear').classList.add('hidden');
        document.getElementById('input-codigo-canje').value = '';
    };

    window.procesarCanjeCodigo = async function() {
        const input = document.getElementById('input-codigo-canje');
        const codigo = input.value.trim().toUpperCase();

        if (codigo === "") {
            mostrarAlertaKZ("PIN REQUERIDO", "Por favor, ingresa el código prepago para procesar la validación.");
            return;
        }

        try {
            // 🎯 CAMBIO CLAVE: Usamos 127.0.0.1 para que el canje responda en 0 milisegundos
            const response = await fetch('http://127.0.0.1:3000/api/redeem', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: codigo })
            });

            const data = await response.json();

            // Si el pin está mal escrito o ya se usó, el cartel salta de inmediato
            if (!response.ok || data.error) {
                mostrarAlertaKZ("CÓDIGO INVÁLIDO", data.error || "El pin prepago ingresado no es correcto o ya expiró.");
                return;
            }

            saldoTokens += data.tokens;
            actualizarSaldoUI();
            cerrarModalCanjear();

            mostrarAlertaKZ(
                "CANJE EXITOSO 🌟", 
                `¡Felicidades! Código validado correctamente.<br>Se han acreditado <b>${data.tokens} Tokems</b> a tu balance central.`, 
                "exito"
            );

        } catch (error) {
            // Manejo de contingencia rápido por si el servidor local está apagado
            mostrarAlertaKZ("CÓDIGO INVÁLIDO", "No se pudo procesar el pin. Verifica la escritura o comprueba tu conexión local.");
        }
    };
    
}); // Fin de DOMContentLoaded. Nada va debajo de esto.
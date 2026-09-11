/* CINE-MÁS — pantalla del televisor */
(function () {
  'use strict';

  var COLS = 3;
  var LAUNCH_SECONDS = 3;

  var el = {
    grid: document.getElementById('grid'),
    overlay: document.getElementById('overlay'),
    panel: document.getElementById('panel'),
    remoteQr: document.getElementById('remoteQr'),
    remoteUrl: document.getElementById('remoteUrl'),
    remotePin: document.getElementById('remotePin'),
    remoteCard: document.getElementById('remoteCard'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    clockTime: document.getElementById('clockTime'),
    clockDate: document.getElementById('clockDate'),
    video: document.getElementById('remoteVideo'),
    sharingBadge: document.getElementById('sharingBadge')
  };

  var platforms = window.PLATFORMS.list;

  var state = {
    screen: 'home',       // home | launch | playing | seeke | ajustes
    focus: 0,
    info: null,
    pin: '',
    shareToken: '',
    hostIndex: Number(localStorage.getItem('cinemas.hostIndex') || 0),
    launchTimer: null,
    launchLeft: 0,
    openedWindow: null,
    watchWindow: null,
    pc: null,
    sharing: false,
    ws: null,
    reconnectDelay: 800
  };

  /* ---------------- Utilidades ---------------- */
  function host() {
    var list = (state.info && state.info.addresses) || [];
    if (!list.length) return location.hostname || 'localhost';
    return list[Math.min(state.hostIndex, list.length - 1)];
  }
  function remoteUrl() {
    if (!state.info) return '';
    return 'http://' + host() + ':' + state.info.httpPort + '/r';
  }
  function shareUrl() {
    if (!state.info) return '';
    if (state.info.https && state.info.httpsPort) {
      return 'https://' + host() + ':' + state.info.httpsPort + '/s?t=' + state.shareToken;
    }
    return 'http://' + host() + ':' + state.info.httpPort + '/s?t=' + state.shareToken;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- Rejilla ---------------- */
  function renderGrid() {
    el.grid.innerHTML = '';
    platforms.forEach(function (p, i) {
      var card = document.createElement('div');
      card.className = 'card';
      card.style.background = p.background;
      card.style.setProperty('--acento', p.accent);
      card.dataset.index = String(i);
      card.innerHTML =
        (p.action === 'share' ? '<span class="badge">Celular</span>' : '') +
        '<div class="logo"><img src="' + esc(p.logo) + '" alt="' + esc(p.name) + '"' +
        ' style="max-width:' + Math.round((p.logoScale || 0.7) * 100) + '%' +
        (p.filtro ? ';filter:' + p.filtro + ' drop-shadow(0 6px 20px rgba(0,0,0,.55))' : '') + '"></div>' +
        '<div class="meta"><div class="name">' + esc(p.name) + '</div>' +
        '<div class="subtitle">' + esc(p.subtitle) + '</div></div>';
      card.addEventListener('click', function () { state.focus = i; paintFocus(); select(); });
      card.addEventListener('mouseenter', function () { state.focus = i; paintFocus(); });
      el.grid.appendChild(card);
    });
    paintFocus();
  }

  function paintFocus() {
    var cards = el.grid.children;
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle('focus', i === state.focus);
    }
    publishState();
  }

  function move(dx, dy) {
    if (state.screen !== 'home') return;
    var rows = Math.ceil(platforms.length / COLS);
    var col = state.focus % COLS;
    var row = Math.floor(state.focus / COLS);
    col = Math.max(0, Math.min(COLS - 1, col + dx));
    row = Math.max(0, Math.min(rows - 1, row + dy));
    var next = row * COLS + col;
    if (next < platforms.length) state.focus = next;
    paintFocus();
  }

  /* ---------------- Acciones ---------------- */
  function select() {
    if (state.screen === 'launch') return openNow();
    if (state.screen === 'playing') return focusOpened();
    if (state.screen === 'seeke') return activarSonido();
    if (state.screen !== 'home') return;
    var p = platforms[state.focus];
    if (!p) return;
    if (p.action === 'share') return abrirSeeke();
    lanzar(p);
  }

  function back() {
    if (state.screen === 'launch') { cancelarLanzamiento(); return; }
    if (state.screen === 'seeke') { cerrarSeeke(); return; }
    if (state.screen === 'ajustes') { cerrarOverlay(); return; }
    if (state.screen === 'playing') { cerrarVentana(); return; }
  }

  function home() {
    if (state.screen === 'seeke') cerrarSeeke();
    else cerrarOverlay();
  }

  function abrirPorId(id) {
    var idx = -1;
    platforms.forEach(function (p, i) { if (p.id === id) idx = i; });
    if (idx < 0) return;
    state.focus = idx;
    paintFocus();
    var p = platforms[idx];
    if (p.action === 'share') return abrirSeeke();
    // Desde el celular no hay gesto del usuario en la tele: abrimos directo.
    lanzar(p, true);
  }

  /* ---------------- Lanzar una plataforma ---------------- */
  function lanzar(p, inmediato) {
    state.screen = 'launch';
    state.launchPlatform = p;
    state.launchLeft = inmediato ? 1 : LAUNCH_SECONDS;
    mostrarPanel(
      '<img class="launch-logo" src="' + esc(p.logo) + '" alt="' + esc(p.name) + '">' +
      '<h2>Abriendo ' + esc(p.name) + '</h2>' +
      '<p>' + esc(p.url) + '</p>' +
      '<div class="countdown"><div class="ring" style="--acento:' + esc(p.accent) + '"></div>' +
      '<div><div style="font-size:clamp(16px,1.5vw,28px);font-weight:700" id="cuenta">' + state.launchLeft + '</div>' +
      '<div style="color:var(--texto-suave)">Pulsa <kbd>Enter</kbd> para abrir ya, <kbd>Esc</kbd> para cancelar</div></div></div>' +
      '<div class="acciones">' +
      '<button class="boton primario" data-accion="abrir">Abrir ahora</button>' +
      '<button class="boton" data-accion="cancelar">Cancelar</button></div>'
    );
    clearInterval(state.launchTimer);
    state.launchTimer = setInterval(function () {
      state.launchLeft -= 1;
      var c = document.getElementById('cuenta');
      if (c) c.textContent = String(Math.max(0, state.launchLeft));
      if (state.launchLeft <= 0) openNow();
    }, 1000);
    publishState();
  }

  function cancelarLanzamiento() {
    clearInterval(state.launchTimer);
    state.launchTimer = null;
    cerrarOverlay();
  }

  function openNow() {
    clearInterval(state.launchTimer);
    state.launchTimer = null;
    var p = state.launchPlatform;
    if (!p) return cerrarOverlay();

    var modo = localStorage.getItem('cinemas.modoApertura') || 'ventana';
    var abierta = null;
    if (modo === 'ventana') {
      try { abierta = window.open(p.url, '_blank'); } catch (err) { abierta = null; }
    }
    if (abierta && !abierta.closed) {
      state.openedWindow = abierta;
      pantallaReproduciendo(p);
      try { abierta.focus(); } catch (err) { /* sin permiso para enfocar */ }
    } else {
      // El navegador bloqueó la ventana nueva: abrimos en la misma pestaña.
      publishState('saliendo');
      location.href = p.url;
    }
  }

  function pantallaReproduciendo(p) {
    state.screen = 'playing';
    mostrarPanel(
      '<img class="launch-logo" src="' + esc(p.logo) + '" alt="' + esc(p.name) + '">' +
      '<h2>' + esc(p.name) + ' está abierto</h2>' +
      '<p>Se abrió en otra ventana del navegador. Cuando termines, vuelve aquí y cierra esa ventana ' +
      'o usa el botón de abajo (también funciona desde el celular).</p>' +
      '<div class="acciones">' +
      '<button class="boton primario" data-accion="cerrar-ventana">Cerrar ' + esc(p.name) + ' y volver</button>' +
      '<button class="boton" data-accion="enfocar">Ir a la ventana</button>' +
      '<button class="boton" data-accion="inicio">Dejarlo abierto</button></div>'
    );
    clearInterval(state.watchWindow);
    state.watchWindow = setInterval(function () {
      if (!state.openedWindow || state.openedWindow.closed) {
        clearInterval(state.watchWindow);
        state.openedWindow = null;
        if (state.screen === 'playing') cerrarOverlay();
      }
    }, 1000);
    publishState();
  }

  function cerrarVentana() {
    try { if (state.openedWindow && !state.openedWindow.closed) state.openedWindow.close(); } catch (err) {}
    state.openedWindow = null;
    clearInterval(state.watchWindow);
    cerrarOverlay();
    window.focus();
  }
  function focusOpened() {
    try { if (state.openedWindow && !state.openedWindow.closed) state.openedWindow.focus(); } catch (err) {}
  }

  /* ---------------- Seeke: compartir pantalla ---------------- */
  function abrirSeeke() {
    state.screen = 'seeke';
    pintarSeeke();
    publishState();
  }

  function pintarSeeke(mensaje) {
    var url = shareUrl();
    var seguro = state.info && state.info.https;
    mostrarPanel(
      '<div class="seeke-head"><img src="img/seeke.svg" alt="Seeke">' +
      '<h2 style="margin:0">Comparte la pantalla de tu celular</h2></div>' +
      '<div class="share-layout">' +
        '<div><div class="share-qr" id="seekeQr"></div><div class="share-url">' + esc(url) + '</div></div>' +
        '<div>' +
          '<ol class="steps">' +
            '<li><strong>Escanea el código QR</strong> con la cámara del celular.</li>' +
            (seguro
              ? '<li>El celular avisará de que el certificado <strong>no es de confianza</strong>. Es normal: es tu propio equipo. Toca <strong>Avanzado → Continuar</strong>.</li>'
              : '<li>Si el navegador no deja capturar, activa HTTPS (ver README) o usa <strong>Enviar enlace</strong>.</li>') +
            '<li>Elige <strong>Compartir pantalla</strong>, <strong>Compartir cámara</strong> o <strong>Enviar enlace</strong> para abrir Seeke en la tele.</li>' +
          '</ol>' +
          '<div class="aviso" id="seekeEstado">' + esc(mensaje || 'Esperando a que se conecte un celular…') + '</div>' +
          '<div class="acciones">' +
            '<button class="boton" data-accion="rotar-token">Cambiar el código</button>' +
            '<button class="boton" data-accion="inicio">Volver</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    var qr = document.getElementById('seekeQr');
    if (qr && url) window.QR.render(qr, url, { ecl: 'M', margin: 2 });
  }

  function estadoSeeke(texto) {
    var box = document.getElementById('seekeEstado');
    if (box) box.textContent = texto;
  }

  function cerrarSeeke() {
    pararRecepcion();
    cerrarOverlay();
  }

  function pararRecepcion() {
    if (state.pc) {
      try { state.pc.close(); } catch (err) {}
      state.pc = null;
    }
    if (el.video.srcObject) {
      el.video.srcObject.getTracks().forEach(function (t) { t.stop(); });
      el.video.srcObject = null;
    }
    el.video.hidden = true;
    el.sharingBadge.hidden = true;
    state.sharing = false;
    publishState();
  }

  function iceServers() {
    return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  }

  function crearPeer() {
    pararRecepcionSoloPeer();
    var pc = new RTCPeerConnection({ iceServers: iceServers() });
    pc.onicecandidate = function (e) {
      if (e.candidate) enviar({ t: 'signal', data: { kind: 'ice', candidate: e.candidate } });
    };
    pc.ontrack = function (e) {
      el.video.srcObject = e.streams[0];
      el.video.hidden = false;
      el.sharingBadge.hidden = false;
      state.sharing = true;
      el.video.muted = false;
      el.video.play().catch(function () {
        el.video.muted = true;
        el.video.play().catch(function () {});
        el.sharingBadge.textContent = 'Seeke · compartiendo (sin sonido: pulsa Enter para activarlo)';
        el.sharingBadge.hidden = false;
      });
      estadoSeeke('Recibiendo la pantalla del celular.');
      publishState();
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        estadoSeeke('Se perdió la conexión con el celular.');
        pararRecepcion();
        if (state.screen === 'seeke') pintarSeeke('Se perdió la conexión. Vuelve a intentarlo desde el celular.');
      }
    };
    state.pc = pc;
    return pc;
  }

  function pararRecepcionSoloPeer() {
    if (state.pc) { try { state.pc.close(); } catch (err) {} state.pc = null; }
  }

  function activarSonido() {
    if (!el.video.srcObject) return;
    el.video.muted = false;
    el.video.play().catch(function () {});
    el.sharingBadge.textContent = 'Seeke · compartiendo desde el celular · Esc para salir';
  }

  function onSignal(data) {
    if (!data) return;
    if (data.kind === 'offer') {
      if (state.screen !== 'seeke') abrirSeeke();
      estadoSeeke('Celular conectado, negociando el vídeo…');
      var pc = crearPeer();
      pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) { return pc.setLocalDescription(answer).then(function () { return answer; }); })
        .then(function (answer) { enviar({ t: 'signal', data: { kind: 'answer', sdp: answer } }); })
        .catch(function (err) { estadoSeeke('Error al conectar: ' + err.message); });
      return;
    }
    if (data.kind === 'ice' && state.pc) {
      state.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function () {});
      return;
    }
    if (data.kind === 'bye') {
      pararRecepcion();
      if (state.screen === 'seeke') pintarSeeke('El celular dejó de compartir.');
    }
  }

  /* ---------------- Ajustes ---------------- */
  function abrirAjustes() {
    state.screen = 'ajustes';
    var info = state.info || {};
    var direcciones = info.addresses || [];
    var modo = localStorage.getItem('cinemas.modoApertura') || 'ventana';
    mostrarPanel(
      '<h2>Ajustes</h2>' +
      '<p>CINE-MÁS funciona en tu red local. El celular tiene que estar en el mismo wifi.</p>' +
      '<div class="ajustes-lista">' +
        '<div class="ajuste"><span>Dirección de la tele en la red</span>' +
          '<span><span class="valor">' + esc(host()) + '</span> ' +
          (direcciones.length > 1 ? '<button class="boton" data-accion="siguiente-ip">Probar otra (' + direcciones.length + ')</button>' : '') +
          '</span></div>' +
        '<div class="ajuste"><span>Contraseña del control remoto</span>' +
          '<span><span class="valor" style="font-size:1.4em;letter-spacing:.2em;color:var(--oro)">' + esc(state.pin) + '</span> ' +
          '<button class="boton" data-accion="rotar-pin">Cambiar</button></span></div>' +
        '<div class="ajuste"><span>HTTPS para compartir pantalla</span>' +
          '<span class="valor">' + (info.https ? 'activo en el puerto ' + info.httpsPort : 'no disponible') + '</span></div>' +
        '<div class="ajuste"><span>Al elegir una plataforma</span>' +
          '<span><span class="valor">' + (modo === 'ventana' ? 'abrir en ventana nueva' : 'abrir en esta pestaña') + '</span> ' +
          '<button class="boton" data-accion="modo-apertura">Cambiar</button></span></div>' +
        '<div class="ajuste"><span>Pantalla completa</span>' +
          '<span><button class="boton" data-accion="pantalla-completa">Activar o salir</button></span></div>' +
      '</div>' +
      (direcciones.length ? '' : '<div class="aviso">No se encontró ninguna dirección de red local. ' +
        'Conecta este equipo al wifi o al cable de red para poder usar el celular como control.</div>') +
      (modo === 'ventana' ? '<div class="aviso">Permite las ventanas emergentes para esta página: así CINE-MÁS ' +
        'sigue abierto detrás y puedes volver al menú desde el celular. Si el navegador las bloquea, la ' +
        'plataforma se abrirá en esta misma pestaña y tendrás que usar el botón Atrás del navegador.</div>' : '') +
      '<div class="acciones"><button class="boton primario" data-accion="inicio">Listo</button></div>'
    );
    publishState();
  }

  /* ---------------- Capa superpuesta ---------------- */
  function mostrarPanel(html) {
    el.panel.innerHTML = html;
    el.overlay.hidden = false;
  }
  function cerrarOverlay() {
    clearInterval(state.launchTimer);
    state.launchTimer = null;
    el.overlay.hidden = true;
    el.panel.innerHTML = '';
    state.screen = 'home';
    publishState();
  }

  el.panel.addEventListener('click', function (e) {
    var boton = e.target.closest('[data-accion]');
    if (!boton) return;
    var accion = boton.dataset.accion;
    if (accion === 'abrir') openNow();
    else if (accion === 'cancelar') cancelarLanzamiento();
    else if (accion === 'inicio') home();
    else if (accion === 'cerrar-ventana') cerrarVentana();
    else if (accion === 'enfocar') focusOpened();
    else if (accion === 'rotar-token') enviar({ t: 'rotate-share' });
    else if (accion === 'rotar-pin') enviar({ t: 'rotate-pin' });
    else if (accion === 'siguiente-ip') siguienteIP();
    else if (accion === 'modo-apertura') cambiarModo();
    else if (accion === 'pantalla-completa') pantallaCompleta();
  });

  function siguienteIP() {
    var total = ((state.info && state.info.addresses) || []).length || 1;
    state.hostIndex = (state.hostIndex + 1) % total;
    localStorage.setItem('cinemas.hostIndex', String(state.hostIndex));
    pintarCabecera();
    abrirAjustes();
  }
  function cambiarModo() {
    var modo = localStorage.getItem('cinemas.modoApertura') || 'ventana';
    localStorage.setItem('cinemas.modoApertura', modo === 'ventana' ? 'pestana' : 'ventana');
    abrirAjustes();
  }
  function pantallaCompleta() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(function () {});
  }

  /* ---------------- Cabecera ---------------- */
  function pintarCabecera() {
    var url = remoteUrl();
    if (url) {
      el.remoteUrl.textContent = url.replace(/^https?:\/\//, '');
      window.QR.render(el.remoteQr, url, { ecl: 'M', margin: 1 });
    } else {
      el.remoteUrl.textContent = 'sin red local';
    }
    el.remotePin.textContent = state.pin || '····';
  }

  function reloj() {
    var d = new Date();
    el.clockTime.textContent = d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    el.clockDate.textContent = d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'short' });
  }

  function estado(ok, texto) {
    el.statusDot.className = 'dot ' + (ok ? 'on' : 'off');
    el.statusText.textContent = texto;
  }

  /* ---------------- WebSocket ---------------- */
  function enviar(obj) {
    if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function publishState(extra) {
    enviar({
      t: 'state',
      screen: extra || state.screen,
      focus: state.focus,
      platform: platforms[state.focus] ? platforms[state.focus].id : null,
      sharing: state.sharing
    });
  }

  function conectar() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var sock = new WebSocket(proto + location.host + '/ws');
    state.ws = sock;

    sock.onopen = function () {
      state.reconnectDelay = 800;
      sock.send(JSON.stringify({ t: 'hello', role: 'tv' }));
    };

    sock.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }

      if (msg.t === 'welcome') {
        state.pin = msg.pin;
        state.shareToken = msg.shareToken;
        pintarCabecera();
        estado(true, 'listo');
        publishState();
        if (state.screen === 'seeke') pintarSeeke();
        return;
      }
      if (msg.t === 'denied') {
        estado(false, 'sin permiso');
        mostrarPanel('<h2>Esta pantalla no está autorizada</h2><p>' + esc(msg.message || '') + '</p>' +
          '<p>Abre la tele en <strong>http://localhost:' + (state.info ? state.info.httpPort : 8123) + '/</strong> ' +
          'o arranca el servidor con <strong>CINEMAS_TV_HOSTS=' + esc(location.hostname) + '</strong> ' +
          '(o <strong>CINEMAS_TV_HOSTS=*</strong> para permitir cualquier equipo de tu red).</p>');
        state.screen = 'denegado';
        return;
      }
      if (msg.t === 'share-token') {
        state.shareToken = msg.shareToken;
        if (state.screen === 'seeke') pintarSeeke('Código nuevo. Vuelve a escanear.');
        return;
      }
      if (msg.t === 'cmd') {
        ejecutar(msg.action, msg);
        return;
      }
      if (msg.t === 'openurl') {
        abrirEnlace(msg.url);
        return;
      }
      if (msg.t === 'signal') {
        onSignal(msg.data);
        return;
      }
      if (msg.t === 'share-gone') {
        pararRecepcion();
        if (state.screen === 'seeke') pintarSeeke('El celular se desconectó.');
        return;
      }
      if (msg.t === 'peers') {
        var n = msg.peers.remote;
        estado(true, n ? (n === 1 ? '1 control conectado' : n + ' controles conectados') : 'listo');
        return;
      }
    };

    sock.onclose = function () {
      estado(false, 'reconectando…');
      state.ws = null;
      setTimeout(conectar, state.reconnectDelay);
      state.reconnectDelay = Math.min(8000, state.reconnectDelay * 1.6);
    };
    sock.onerror = function () { try { sock.close(); } catch (err) {} };
  }

  function abrirEnlace(url) {
    if (!/^https?:\/\//i.test(url)) return;
    var abierta = null;
    try { abierta = window.open(url, '_blank'); } catch (err) { abierta = null; }
    if (abierta && !abierta.closed) {
      state.openedWindow = abierta;
      pantallaReproduciendo({ name: 'el enlace', logo: 'img/seeke.svg', url: url, accent: '#22d3ee' });
    } else {
      publishState('saliendo');
      location.href = url;
    }
  }

  /* ---------------- Entrada (teclado y control remoto) ---------------- */
  function ejecutar(accion, msg) {
    switch (accion) {
      case 'up': move(0, -1); break;
      case 'down': move(0, 1); break;
      case 'left': move(-1, 0); break;
      case 'right': move(1, 0); break;
      case 'ok': select(); break;
      case 'back': back(); break;
      case 'home': home(); break;
      case 'open': if (msg && msg.id) abrirPorId(msg.id); break;
      case 'seeke': abrirSeeke(); break;
      case 'ajustes': abrirAjustes(); break;
      case 'cerrar-ventana': cerrarVentana(); break;
      case 'pantalla-completa': pantallaCompleta(); break;
      case 'sonido': activarSonido(); break;
    }
  }

  document.addEventListener('keydown', function (e) {
    var mapa = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Enter: 'ok', ' ': 'ok', Escape: 'back', Backspace: 'back', Home: 'home'
    };
    var accion = mapa[e.key];
    if (!accion && (e.key === 'f' || e.key === 'F')) accion = 'pantalla-completa';
    if (!accion && (e.key === 's' || e.key === 'S')) accion = 'ajustes';
    if (!accion) return;
    e.preventDefault();
    ejecutar(accion);
  });

  el.remoteCard.addEventListener('click', abrirAjustes);
  el.video.addEventListener('click', activarSonido);

  window.addEventListener('beforeunload', function () { publishState('saliendo'); });

  /* ---------------- Arranque ---------------- */
  function iniciar() {
    renderGrid();
    reloj();
    setInterval(reloj, 15000);
    estado(false, 'conectando…');

    fetch('api/info')
      .then(function (r) { return r.json(); })
      .then(function (info) {
        state.info = info;
        if (info.pin) state.pin = info.pin;
        pintarCabecera();
      })
      .catch(function () { el.remoteUrl.textContent = 'no se pudo leer la red'; })
      .then(conectar);
  }

  iniciar();
})();

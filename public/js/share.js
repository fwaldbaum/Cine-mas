/* CINE-MÁS — Seeke: comparte la pantalla del celular con el televisor */
(function () {
  'use strict';

  var el = {
    punto: document.getElementById('punto'),
    estadoTexto: document.getElementById('estadoTexto'),
    bloqueado: document.getElementById('bloqueado'),
    motivoBloqueo: document.getElementById('motivoBloqueo'),
    principal: document.getElementById('principal'),
    avisoSeguro: document.getElementById('avisoSeguro'),
    previo: document.getElementById('previo'),
    botonesCaptura: document.getElementById('botonesCaptura'),
    btnPantalla: document.getElementById('btnPantalla'),
    btnCamara: document.getElementById('btnCamara'),
    btnParar: document.getElementById('btnParar'),
    mensaje: document.getElementById('mensaje'),
    enlace: document.getElementById('enlace'),
    enviarEnlace: document.getElementById('enviarEnlace'),
    mensajeEnlace: document.getElementById('mensajeEnlace'),
    notaAyuda: document.getElementById('notaAyuda')
  };

  var token = new URLSearchParams(location.search).get('t') || '';
  var ws = null;
  var pc = null;
  var stream = null;
  var autorizado = false;
  var reintento = 800;

  function estado(ok, texto) {
    el.punto.className = 'punto' + (ok ? ' on' : '');
    el.estadoTexto.textContent = texto;
  }
  function mensaje(texto, tipo) {
    el.mensaje.textContent = texto || '';
    el.mensaje.style.color = tipo === 'bien' ? '#b6f2d2' : (tipo === 'malo' ? '#ff9ca0' : '');
  }
  function enviar(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }
  function senal(data) { return enviar({ t: 'signal', data: data }); }

  /* ---------- Comprobaciones del navegador ---------- */
  var puedePantalla = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  var puedeCamara = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  function revisarEntorno() {
    if (!window.isSecureContext) {
      el.avisoSeguro.classList.remove('oculto');
      el.avisoSeguro.textContent =
        'Esta página no se abrió de forma segura (https), así que el navegador no deja usar la cámara ' +
        'ni compartir la pantalla. Vuelve a escanear el QR de la tele, que usa https, o usa la opción de enviar un enlace.';
      el.btnPantalla.disabled = true;
      el.btnCamara.disabled = true;
      return;
    }
    if (!puedePantalla) {
      el.btnPantalla.disabled = true;
      el.btnPantalla.textContent = 'Pantalla no disponible';
      el.notaAyuda.textContent =
        'Tu navegador no permite compartir la pantalla completa (es lo normal en iPhone y en muchos Android). ' +
        'Puedes compartir la cámara, o enviar el enlace de Seeke para verlo directamente en la tele.';
    }
    if (!puedeCamara) el.btnCamara.disabled = true;
  }

  /* ---------- WebRTC ---------- */
  function crearPeer() {
    cerrarPeer();
    pc = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
    });
    pc.onicecandidate = function (e) {
      if (e.candidate) senal({ kind: 'ice', candidate: e.candidate });
    };
    pc.onconnectionstatechange = function () {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        mensaje('Conectado con la tele. Ya se está viendo.', 'bien');
        estado(true, 'compartiendo');
      } else if (pc.connectionState === 'failed') {
        mensaje('No se pudo conectar con la tele. Comprueba que los dos estén en el mismo wifi.', 'malo');
      }
    };
    return pc;
  }

  function cerrarPeer() {
    if (pc) { try { pc.close(); } catch (err) {} pc = null; }
  }

  function pararTodo(avisar) {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    cerrarPeer();
    el.previo.srcObject = null;
    el.previo.classList.add('oculto');
    el.btnParar.classList.add('oculto');
    el.botonesCaptura.classList.remove('oculto');
    if (avisar) senal({ kind: 'bye' });
    estado(autorizado, autorizado ? 'listo' : 'sin conexión');
  }

  function compartir(tipo) {
    if (!autorizado) return mensaje('Todavía no hay conexión con la tele.', 'malo');
    mensaje('Pidiendo permiso…');

    var peticion = tipo === 'pantalla'
      ? navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 30 } },
          audio: true
        })
      : navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: true
        });

    peticion.then(function (s) {
      stream = s;
      el.previo.srcObject = s;
      el.previo.classList.remove('oculto');
      el.botonesCaptura.classList.add('oculto');
      el.btnParar.classList.remove('oculto');
      mensaje('Enviando a la tele…');

      s.getTracks().forEach(function (t) {
        t.addEventListener('ended', function () { pararTodo(true); mensaje('Dejaste de compartir.'); });
      });

      var peer = crearPeer();
      s.getTracks().forEach(function (t) { peer.addTrack(t, s); });

      return peer.createOffer()
        .then(function (offer) { return peer.setLocalDescription(offer).then(function () { return offer; }); })
        .then(function (offer) { senal({ kind: 'offer', sdp: offer }); });
    }).catch(function (err) {
      var texto = 'No se pudo compartir: ' + (err && err.message ? err.message : err);
      if (err && (err.name === 'NotAllowedError')) texto = 'No diste permiso al navegador.';
      if (err && (err.name === 'NotSupportedError' || err.name === 'TypeError')) {
        texto = 'Este navegador no permite compartir la pantalla. Prueba con la cámara o envía el enlace.';
      }
      mensaje(texto, 'malo');
      pararTodo(false);
    });
  }

  el.btnPantalla.addEventListener('click', function () { compartir('pantalla'); });
  el.btnCamara.addEventListener('click', function () { compartir('camara'); });
  el.btnParar.addEventListener('click', function () { pararTodo(true); mensaje('Dejaste de compartir.'); });

  el.enviarEnlace.addEventListener('click', function () {
    var url = (el.enlace.value || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!enviar({ t: 'openurl', url: url })) {
      el.mensajeEnlace.textContent = 'Sin conexión con la tele.';
      el.mensajeEnlace.style.color = '#ff9ca0';
      return;
    }
    el.mensajeEnlace.textContent = 'Enviado…';
    el.mensajeEnlace.style.color = '';
  });

  /* ---------- WebSocket ---------- */
  function conectar() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');

    ws.onopen = function () {
      reintento = 800;
      enviar({ t: 'hello', role: 'share', token: token });
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }

      if (msg.t === 'welcome') {
        autorizado = true;
        el.bloqueado.classList.add('oculto');
        el.principal.classList.remove('oculto');
        estado(true, 'listo');
        revisarEntorno();
        return;
      }
      if (msg.t === 'denied') {
        autorizado = false;
        el.principal.classList.add('oculto');
        el.bloqueado.classList.remove('oculto');
        el.motivoBloqueo.textContent = msg.message || 'Vuelve a escanear el código de la tele.';
        estado(false, 'sin acceso');
        return;
      }
      if (msg.t === 'signal' && msg.data) {
        if (msg.data.kind === 'answer' && pc) {
          pc.setRemoteDescription(new RTCSessionDescription(msg.data.sdp)).catch(function (err) {
            mensaje('Error al conectar: ' + err.message, 'malo');
          });
        } else if (msg.data.kind === 'ice' && pc) {
          pc.addIceCandidate(new RTCIceCandidate(msg.data.candidate)).catch(function () {});
        }
        return;
      }
      if (msg.t === 'ok') {
        el.mensajeEnlace.textContent = msg.message || 'Listo';
        el.mensajeEnlace.style.color = '#b6f2d2';
        return;
      }
      if (msg.t === 'error') {
        el.mensajeEnlace.textContent = msg.message || 'Error';
        el.mensajeEnlace.style.color = '#ff9ca0';
        return;
      }
      if (msg.t === 'peers') {
        if (autorizado && !stream) estado(msg.peers.tv > 0, msg.peers.tv > 0 ? 'listo' : 'la tele no está abierta');
        return;
      }
      if (msg.t === 'bye') {
        pararTodo(false);
        autorizado = false;
        el.principal.classList.add('oculto');
        el.bloqueado.classList.remove('oculto');
        el.motivoBloqueo.textContent = 'El código cambió en la tele. Vuelve a escanearlo.';
        return;
      }
    };

    ws.onclose = function () {
      estado(false, 'reconectando…');
      ws = null;
      setTimeout(conectar, reintento);
      reintento = Math.min(6000, reintento * 1.6);
    };
    ws.onerror = function () { try { ws.close(); } catch (err) {} };
  }

  if (!token) {
    el.bloqueado.classList.remove('oculto');
    el.motivoBloqueo.textContent = 'Falta el código. Escanea el QR que aparece en la pantalla de Seeke en la tele.';
    estado(false, 'sin código');
  } else {
    conectar();
  }
})();

/* CINE-MÁS — control remoto desde el celular */
(function () {
  'use strict';

  var el = {
    acceso: document.getElementById('acceso'),
    control: document.getElementById('control'),
    pin: document.getElementById('pin'),
    entrar: document.getElementById('entrar'),
    errorPin: document.getElementById('errorPin'),
    punto: document.getElementById('punto'),
    estadoTexto: document.getElementById('estadoTexto'),
    plataformas: document.getElementById('plataformas'),
    ahoraLogo: document.getElementById('ahoraLogo'),
    ahoraNombre: document.getElementById('ahoraNombre'),
    ahoraDetalle: document.getElementById('ahoraDetalle'),
    enlace: document.getElementById('enlace'),
    enviarEnlace: document.getElementById('enviarEnlace'),
    mensajeEnlace: document.getElementById('mensajeEnlace')
  };

  var platforms = window.PLATFORMS.list;
  var ws = null;
  var autorizado = false;
  var pinGuardado = sessionStorage.getItem('cinemas.pin') || '';
  var reintento = 800;

  function estado(ok, texto) {
    el.punto.className = 'punto' + (ok ? ' on' : '');
    el.estadoTexto.textContent = texto;
  }

  function vibrar(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms || 12); } catch (err) {} }
  }

  function enviar(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  function cmd(action, extra) {
    if (!autorizado) return;
    var msg = { t: 'cmd', action: action };
    if (extra) Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
    enviar(msg);
    vibrar();
  }

  /* ---------- Plataformas ---------- */
  function pintarPlataformas() {
    el.plataformas.innerHTML = '';
    platforms.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'plat';
      b.style.setProperty('--acento', p.accent);
      b.dataset.id = p.id;
      b.innerHTML = '<img src="' + p.logo + '" alt="' + p.name + '"><span>' + p.name + '</span>';
      b.addEventListener('click', function () {
        cmd('open', { id: p.id });
        marcarActiva(p.id);
      });
      el.plataformas.appendChild(b);
    });
  }

  function marcarActiva(id) {
    Array.prototype.forEach.call(el.plataformas.children, function (b) {
      b.classList.toggle('activa', b.dataset.id === id);
    });
    var p = window.PLATFORMS.byId(id);
    if (p) {
      el.ahoraLogo.src = p.logo;
      el.ahoraNombre.textContent = p.name;
    }
  }

  function pintarEstadoTele(s) {
    if (!s) return;
    if (s.platform) marcarActiva(s.platform);
    var textos = {
      home: 'seleccionando en el menú',
      launch: 'abriendo…',
      playing: 'abierto en la tele',
      seeke: 'esperando el celular para compartir',
      ajustes: 'en los ajustes',
      saliendo: 'saliendo de CINE-MÁS'
    };
    el.ahoraDetalle.textContent = textos[s.screen] || 'en el menú principal';
    if (s.sharing) el.ahoraDetalle.textContent = 'compartiendo pantalla';
  }

  /* ---------- Botones ---------- */
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cmd]');
    if (!b) return;
    cmd(b.dataset.cmd);
  });

  el.enviarEnlace.addEventListener('click', function () {
    var url = (el.enlace.value || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (!enviar({ t: 'openurl', url: url })) return;
    el.mensajeEnlace.textContent = 'Enviado…';
    el.mensajeEnlace.style.color = '';
    vibrar(20);
  });

  /* ---------- Acceso ---------- */
  function intentar() {
    var pin = (el.pin.value || '').trim();
    if (!/^\d{4,8}$/.test(pin)) {
      el.errorPin.textContent = 'Escribe la contraseña de la tele.';
      return;
    }
    pinGuardado = pin;
    el.errorPin.textContent = 'Comprobando…';
    if (!enviar({ t: 'hello', role: 'remote', pin: pin })) {
      el.errorPin.textContent = 'Sin conexión con el servidor.';
    }
  }

  el.entrar.addEventListener('click', intentar);
  el.pin.addEventListener('keydown', function (e) { if (e.key === 'Enter') intentar(); });

  /* ---------- WebSocket ---------- */
  function conectar() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');

    ws.onopen = function () {
      reintento = 800;
      estado(false, 'conectado, falta la contraseña');
      if (pinGuardado) enviar({ t: 'hello', role: 'remote', pin: pinGuardado });
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }

      if (msg.t === 'welcome') {
        autorizado = true;
        sessionStorage.setItem('cinemas.pin', pinGuardado);
        el.acceso.classList.add('oculto');
        el.control.classList.remove('oculto');
        el.errorPin.textContent = '';
        estado(true, 'control activo');
        pintarEstadoTele(msg.state);
        vibrar(30);
        return;
      }
      if (msg.t === 'denied') {
        autorizado = false;
        sessionStorage.removeItem('cinemas.pin');
        pinGuardado = '';
        el.control.classList.add('oculto');
        el.acceso.classList.remove('oculto');
        el.errorPin.textContent = msg.message || 'No se pudo entrar.';
        el.pin.value = '';
        estado(false, 'sin acceso');
        return;
      }
      if (msg.t === 'state') { pintarEstadoTele(msg.state); return; }
      if (msg.t === 'peers') {
        if (autorizado) estado(msg.peers.tv > 0, msg.peers.tv > 0 ? 'control activo' : 'la tele no está abierta');
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
      if (msg.t === 'bye') {
        autorizado = false;
        sessionStorage.removeItem('cinemas.pin');
        pinGuardado = '';
        el.control.classList.add('oculto');
        el.acceso.classList.remove('oculto');
        el.errorPin.textContent = msg.reason === 'pin-cambiado'
          ? 'La contraseña cambió. Mira la nueva en la tele.'
          : 'Sesión cerrada.';
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

  pintarPlataformas();
  conectar();
  if (!pinGuardado) setTimeout(function () { el.pin.focus(); }, 300);
})();

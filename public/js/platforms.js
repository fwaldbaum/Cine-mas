/**
 * Plataformas del selector de CINE-MÁS.
 *
 * Para cambiar una dirección (por ejemplo si tu país usa otro dominio),
 * edita el campo "url" de la plataforma correspondiente.
 */
(function (global) {
  'use strict';

  var PLATFORMS = [
    {
      id: 'netflix',
      name: 'Netflix',
      subtitle: 'Series y películas',
      url: 'https://www.netflix.com',
      logo: 'img/netflix.svg',
      accent: '#e50914',
      background: 'radial-gradient(circle at 30% 20%, #3a0a0e 0%, #120507 70%)',
      logoScale: 0.74
    },
    {
      id: 'disney',
      name: 'Disney+',
      subtitle: 'Disney, Pixar, Marvel',
      url: 'https://www.disneyplus.com',
      logo: 'img/disney-plus.svg',
      accent: '#3fb8e6',
      background: 'radial-gradient(circle at 30% 20%, #123a63 0%, #06121f 70%)',
      logoScale: 0.78,
      filtro: 'brightness(1.16) saturate(1.15)'
    },
    {
      id: 'hbomax',
      name: 'HBO Max',
      subtitle: 'HBO, Warner y DC',
      url: 'https://www.hbomax.com',
      logo: 'img/hbo-max.svg',
      accent: '#8b5cf6',
      background: 'radial-gradient(circle at 30% 20%, #2a1657 0%, #0b0718 70%)',
      logoScale: 0.62
    },
    {
      id: 'prime',
      name: 'Prime Video',
      subtitle: 'Amazon Prime Video',
      url: 'https://www.primevideo.com',
      logo: 'img/prime-video.svg',
      accent: '#00a8e1',
      background: 'radial-gradient(circle at 30% 20%, #0b3550 0%, #04121c 70%)',
      logoScale: 0.80
    },
    {
      id: 'youtube',
      name: 'YouTube',
      subtitle: 'Vídeos y directos',
      url: 'https://www.youtube.com',
      logo: 'img/youtube.svg',
      accent: '#ff0033',
      background: 'radial-gradient(circle at 30% 20%, #3d0510 0%, #140205 70%)',
      logoScale: 0.46
    },
    {
      id: 'seeke',
      name: 'Seeke',
      subtitle: 'Comparte la pantalla del celular',
      action: 'share',
      logo: 'img/seeke.svg',
      accent: '#22d3ee',
      background: 'radial-gradient(circle at 30% 20%, #0c3f46 0%, #04161a 70%)',
      logoScale: 0.72
    }
  ];

  function byId(id) {
    for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].id === id) return PLATFORMS[i];
    return null;
  }

  var api = { list: PLATFORMS, byId: byId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PLATFORMS = api;
})(typeof window !== 'undefined' ? window : globalThis);

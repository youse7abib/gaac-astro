/* GAAC - script.js */
'use strict';

/* Add js-ready class so CSS reveal animations activate */
document.body.classList.add('js-ready');

/* ── 1. HEADER SCROLL CLASS ── */
var header = document.querySelector('.site-header');
if (header) {
  window.addEventListener('scroll', function () {
    header.classList.toggle('scrolled', window.scrollY > 30);
  }, { passive: true });
}

/* ── 2. MOBILE NAV TOGGLE ── */
var navToggle = document.querySelector('.nav-toggle');
var siteNav   = document.querySelector('.site-nav');
if (navToggle && siteNav) {
  navToggle.addEventListener('click', function () {
    var isOpen = siteNav.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });
  siteNav.querySelectorAll('a').forEach(function (link) {
    link.addEventListener('click', function () {
      siteNav.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

/* ── 3. COUNTDOWN ── */
document.querySelectorAll('[data-countdown]').forEach(function (el) {
  var now               = new Date();
  var registrationOpen  = new Date('2026-07-12T00:00:00');
  var registrationClose = new Date('2026-08-30T23:59:59');
  var mockTest          = new Date('2026-09-02T00:00:00');
  var round1            = new Date('2026-09-05T00:00:00');
  var round2            = new Date('2026-09-10T00:00:00');
  var finalResults      = new Date('2026-09-15T23:59:59');
  var days = function (d) { return Math.max(0, Math.ceil((d - now) / 86400000)); };

  if      (now < registrationOpen) el.textContent = 'Registration opens in ' + days(registrationOpen) + ' day' + (days(registrationOpen) !== 1 ? 's' : '') + ' — 12 July 2026';
  else if (now <= registrationClose) el.textContent = 'Registration is open until 30 August 2026.';
  else if (now < mockTest)           el.textContent = 'Registration closed. Mock test on 2 September 2026.';
  else if (now < round1)             el.textContent = 'Mock test done. Round 1 starts 5 September 2026.';
  else if (now < round2)             el.textContent = 'Round 1 in progress. Round 2 on 10 September 2026.';
  else if (now < finalResults)       el.textContent = 'Round 2 in progress. Final results on 15 September 2026.';
  else if (now <= finalResults)      el.textContent = 'GAAC 2026 results are being finalized. Certificates releasing 15 September 2026.';
  else                               el.textContent = 'GAAC 2026 has concluded.';
});

/* ── 4. SCROLL REVEAL (all 5 variants) ── */
var allRevealClasses = ['.reveal', '.reveal-left', '.reveal-right', '.reveal-scale', '.reveal-flip'];
var revealEls = document.querySelectorAll(allRevealClasses.join(','));

if ('IntersectionObserver' in window) {
  var revealObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  revealEls.forEach(function (el) { revealObserver.observe(el); });
} else {
  /* Fallback: show everything immediately */
  revealEls.forEach(function (el) { el.classList.add('visible'); });
}

/* ── 5. CURSOR GLOW + PARALLAX (desktop only) ── */
var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!reduceMotion && window.innerWidth > 768) {

  /* Cursor glow orb */
  var glow = document.createElement('div');
  glow.className = 'cursor-glow';
  document.body.appendChild(glow);

  var mouseX = -9999, mouseY = -9999;
  var glowX  = -9999, glowY  = -9999;

  var lerp = function (a, b, t) { return a + (b - a) * t; };

  var animateGlow = function () {
    glowX = lerp(glowX, mouseX, 0.08);
    glowY = lerp(glowY, mouseY, 0.08);
    glow.style.transform = 'translate3d(' + (glowX - 190) + 'px,' + (glowY - 190) + 'px,0)';
    requestAnimationFrame(animateGlow);
  };

  document.addEventListener('mousemove', function (e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    glow.style.opacity = '1';
  }, { passive: true });

  document.addEventListener('mouseleave', function () { glow.style.opacity = '0'; });
  animateGlow();

  /* Card inner mouse-glow (--mx / --my CSS vars) */
  var glowCards = document.querySelectorAll(
    '.stat-card, .format-panel article, .portal-card, .partner-card, ' +
    '.info-card, .round-card, .syllabus-card, .round-syllabus article, .callout, .organizer'
  );
  glowCards.forEach(function (card) {
    card.addEventListener('mousemove', function (e) {
      var rect = card.getBoundingClientRect();
      var x = ((e.clientX - rect.left) / rect.width  * 100).toFixed(1);
      var y = ((e.clientY - rect.top)  / rect.height * 100).toFixed(1);
      card.style.setProperty('--mx', x + '%');
      card.style.setProperty('--my', y + '%');
    }, { passive: true });
  });

  /* Hero logo parallax */
  var heroMark = document.querySelector('.hero-mark');
  if (heroMark) {
    var hx = 0, hy = 0, thx = 0, thy = 0;
    document.addEventListener('mousemove', function (e) {
      thx = (e.clientX / window.innerWidth  - 0.5) * 16;
      thy = (e.clientY / window.innerHeight - 0.5) * 10;
    }, { passive: true });

    var animateHero = function () {
      hx = lerp(hx, thx, 0.06);
      hy = lerp(hy, thy, 0.06);
      heroMark.style.transform = 'translate(' + hx.toFixed(2) + 'px,' + hy.toFixed(2) + 'px)';
      requestAnimationFrame(animateHero);
    };
    animateHero();
  }
}

/* ── 6. SPACETIME FABRIC CANVAS ── */
var canvas = document.querySelector('[data-space-canvas]');
if (canvas && !reduceMotion) {
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0;
  var rafId = 0;
  var mx = -9999, my = -9999;
  var tmx = -9999, tmy = -9999;

  document.addEventListener('mousemove', function (e) {
    tmx = e.clientX;
    tmy = e.clientY;
  }, { passive: true });

  var gridSpacing = 45;
  var points = [];
  var cols = 0, rows = 0;

  var initGrid = function() {
    points = [];
    cols = Math.floor(W / gridSpacing) + 2;
    rows = Math.floor(H / gridSpacing) + 2;
    for (var i = 0; i < cols; i++) {
      for (var j = 0; j < rows; j++) {
        points.push({
          baseX: (i - 1) * gridSpacing,
          baseY: (j - 1) * gridSpacing,
          x: (i - 1) * gridSpacing,
          y: (j - 1) * gridSpacing
        });
      }
    }
  };

  var resize = function () {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initGrid();
  };

  var lerp = function (a, b, t) { return a + (b - a) * t; };

  var draw = function () {
    ctx.clearRect(0, 0, W, H);
    mx = lerp(mx, tmx, 0.1);
    my = lerp(my, tmy, 0.1);

    var influenceRadius = 300;

    // Update points
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var dx = mx - p.baseX;
      var dy = my - p.baseY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < influenceRadius) {
        // Curve towards mouse creating a gravity well effect
        var force = (influenceRadius - dist) / influenceRadius;
        // smooth step
        force = force * force * (3 - 2 * force);
        p.x = p.baseX + dx * force * 0.45;
        p.y = p.baseY + dy * force * 0.45;
      } else {
        p.x = p.baseX;
        p.y = p.baseY;
      }
    }

    ctx.lineWidth = 1;
    // Draw vertical lines
    ctx.beginPath();
    for (var i = 0; i < cols; i++) {
      for (var j = 0; j < rows; j++) {
        var idx = i * rows + j;
        if (j === 0) {
          ctx.moveTo(points[idx].x, points[idx].y);
        } else {
          ctx.lineTo(points[idx].x, points[idx].y);
        }
      }
    }
    
    // Draw horizontal lines
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var idx = i * rows + j;
        if (i === 0) {
          ctx.moveTo(points[idx].x, points[idx].y);
        } else {
          ctx.lineTo(points[idx].x, points[idx].y);
        }
      }
    }
    
    // Create gradient stroke for the grid
    var grad = ctx.createRadialGradient(mx, my, 0, mx, my, influenceRadius * 1.5);
    grad.addColorStop(0, 'rgba(0, 229, 255, 0.4)');
    grad.addColorStop(0.5, 'rgba(38, 183, 255, 0.15)');
    grad.addColorStop(1, 'rgba(38, 183, 255, 0.05)');
    ctx.strokeStyle = grad;
    ctx.stroke();

    rafId = requestAnimationFrame(draw);
  };

  resize();
  draw();
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('pagehide', function () { cancelAnimationFrame(rafId); });
}

/* ── 7. SHOOTING STARS ── */
if (!reduceMotion) {
  var spawnStar = function () {
    var star = document.createElement('div');
    star.className = 'shooting-star';
    star.style.left      = (Math.random() * window.innerWidth) + 'px';
    star.style.top       = (Math.random() * window.innerHeight * 0.45) + 'px';
    star.style.transform = 'rotate(' + (95 + Math.random() * 50) + 'deg)';
    document.body.appendChild(star);
    setTimeout(function () { star.remove(); }, 1200);
  };

  var scheduleShoot = function () {
    spawnStar();
    setTimeout(scheduleShoot, 4000 + Math.random() * 5000);
  };
  setTimeout(scheduleShoot, 3000 + Math.random() * 2000);
}

/* ── 8. NUMBER COUNTERS ── */
var counterEls = document.querySelectorAll('.counter');
if (counterEls.length > 0 && 'IntersectionObserver' in window) {
  var countObserver = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (entry.isIntersecting) {
        var el = entry.target;
        var target = parseInt(el.getAttribute('data-target'), 10);
        var duration = 2000; // 2 seconds
        var start = null;
        var step = function(timestamp) {
          if (!start) start = timestamp;
          var progress = timestamp - start;
          // easeOutQuad
          var t = Math.min(progress / duration, 1);
          var current = Math.floor(target * t * (2 - t));
          el.textContent = current;
          if (progress < duration) {
            requestAnimationFrame(step);
          } else {
            el.textContent = target;
          }
        };
        requestAnimationFrame(step);
        countObserver.unobserve(el);
      }
    });
  }, { threshold: 0.1 });
  counterEls.forEach(function(el) { countObserver.observe(el); });
} else {
  counterEls.forEach(function(el) {
    el.textContent = el.getAttribute('data-target');
  });
}

/* ── 9. METEOR CURSOR ── */
if (!reduceMotion && window.innerWidth > 768) {
  var meteor = document.createElement('div');
  meteor.className = 'meteor-cursor';
  document.body.appendChild(meteor);

  var isHovering = false;
  var lastX = 0, lastY = 0;

  document.addEventListener('mousemove', function(e) {
    meteor.style.left = e.clientX + 'px';
    meteor.style.top = e.clientY + 'px';
    
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    var dist = Math.sqrt(dx*dx + dy*dy);
    lastX = e.clientX;
    lastY = e.clientY;

    // Create trail particles based on movement speed
    if (dist > 2 || Math.random() > 0.5) {
      var trail = document.createElement('div');
      trail.className = 'meteor-trail' + (isHovering ? ' hovering-trail' : '');
      var ox = (Math.random() - 0.5) * 8;
      var oy = (Math.random() - 0.5) * 8;
      trail.style.left = (e.clientX + ox) + 'px';
      trail.style.top = (e.clientY + oy) + 'px';
      document.body.appendChild(trail);
      
      requestAnimationFrame(function() {
        trail.style.opacity = '0';
        trail.style.transform = 'translate(-50%, -50%) scale(0.1)';
      });
      setTimeout(function() { trail.remove(); }, 600);
    }
  }, { passive: true });

  var interactables = document.querySelectorAll('a, button, .nav-toggle, .nav-cta, input, select, textarea');
  interactables.forEach(function(el) {
    el.addEventListener('mouseenter', function() {
      isHovering = true;
      meteor.classList.add('hovering');
    });
    el.addEventListener('mouseleave', function() {
      isHovering = false;
      meteor.classList.remove('hovering');
    });
  });
}

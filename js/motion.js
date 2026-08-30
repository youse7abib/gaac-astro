/* GAAC - motion.js
   Mouse FX for the block sections — vanilla, dependency-free.
   - scramble ............... cyberpunk decode of the hero eyebrow
   - tilt + glare ........... portal & syllabus cards follow the cursor
   - micro-parallax ......... numbers / domain icons pull against the cursor
   - magnetic CTAs .......... hero buttons ease toward the cursor
   - PDF tilt ............... 3D tilt + glow on the rules card
   While a system lerps transform in JS it temporarily removes the CSS
   transform transition so the two never fight. Pointer-only
   (fine pointers, >768px), honors prefers-reduced-motion. */
'use strict';

(function () {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  /* 1. SCRAMBLE — decode the hero eyebrow */
  var el = document.querySelector('[data-hero-scramble]');
  if (el) {
    var charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*<>/{}';
    var source = el.textContent;
    var startedAt = null;
    var duration = 1100;
    var trail = 6;

    function tick(now) {
      if (startedAt === null) startedAt = now;
      var p = Math.min((now - startedAt) / duration, 1);
      var revealed = Math.floor(p * source.length);
      var out = '';
      for (var i = 0; i < source.length; i++) {
        if (i < revealed) {
          out += source[i];
        } else if (p < 1 && i < revealed + trail) {
          out += charset[(Math.random() * charset.length) | 0];
        } else if (p < 1) {
          out += source[i] === ' ' ? '&nbsp;' : '';
        }
      }
      if (p >= 1) out = source;
      el.innerHTML = out;
      if (p < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  /* Pointer-only systems below */
  if (!window.matchMedia('(pointer: fine)').matches || window.innerWidth <= 768) return;

  /* 2. CARD TILT + GLARE + MICRO-PARALLAX (portal & syllabus) */
  document.querySelectorAll('.portal-card, .syllabus-card').forEach(function (card) {
    var glare = document.createElement('div');
    glare.className = 'tilt-glare';
    glare.setAttribute('aria-hidden', 'true');
    card.appendChild(glare);

    var crx = 0, cry = 0, trx = 0, trY = 0, raf = null;

    function tick() {
      crx += (trx - crx) * 0.16;
      cry += (trY - cry) * 0.16;
      card.style.transform =
        'perspective(1000px) rotateX(' + crx.toFixed(2) + 'deg) rotateY(' + cry.toFixed(2) + 'deg)';
      if (Math.abs(trx - crx) > 0.03 || Math.abs(trY - cry) > 0.03) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = null;
        card.style.transition = '';
        if (trx === 0 && trY === 0) card.style.transform = '';
      }
    }

    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width;
      var py = (e.clientY - r.top) / r.height;
      trx = (0.5 - py) * 5;
      trY = (px - 0.5) * 5;
      card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
      card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
      card.style.setProperty('--pxa', ((px - 0.5) * 14).toFixed(2) + 'px');
      card.style.setProperty('--pya', ((py - 0.5) * 14).toFixed(2) + 'px');
      card.style.transition = 'border-color 260ms ease, border-left-color 260ms ease, box-shadow 260ms ease';
      if (!raf) raf = requestAnimationFrame(tick);
    }, { passive: true });

    card.addEventListener('pointerleave', function () {
      trx = 0;
      trY = 0;
      card.style.setProperty('--pxa', '0px');
      card.style.setProperty('--pya', '0px');
      if (!raf) raf = requestAnimationFrame(tick);
    });
  });

  /* 3. PARTNER LOGO PARALLAX */
  document.querySelectorAll('.partner-card').forEach(function (card) {
    if (!card.querySelector('img')) return;
    card.addEventListener('pointermove', function (e) {
      var r = card.getBoundingClientRect();
      card.style.setProperty('--px', (((e.clientX - r.left) / r.width - 0.5) * 10).toFixed(2) + 'px');
      card.style.setProperty('--py', (((e.clientY - r.top) / r.height - 0.5) * 10).toFixed(2) + 'px');
    }, { passive: true });
    card.addEventListener('pointerleave', function () {
      card.style.setProperty('--px', '0px');
      card.style.setProperty('--py', '0px');
    });
  });

  /* 4. MAGNETIC HERO CTAs (keeps the resting -3px lift) */
  document.querySelectorAll('.hero-actions .button').forEach(function (btn) {
    var x = 0, y = 0, tx = 0, ty = 0, raf = null, hover = false;

    function step() {
      x += (tx - x) * 0.2;
      y += (ty - y) * 0.2;
      var settled = !hover && Math.abs(x) < 0.2 && Math.abs(y) < 0.2;
      btn.style.transform = settled ? '' : 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0)';
      if (settled) {
        raf = null;
        btn.style.transition = '';
      } else {
        btn.style.transition = 'box-shadow 220ms ease, border-color 220ms ease, background 220ms ease';
        raf = requestAnimationFrame(step);
      }
    }

    btn.addEventListener('pointermove', function (e) {
      var r = btn.getBoundingClientRect();
      tx = (e.clientX - r.left - r.width / 2) * 0.22;
      ty = (e.clientY - r.top - r.height / 2) * 0.22 - 3;
      hover = true;
      if (!raf) raf = requestAnimationFrame(step);
    }, { passive: true });

    btn.addEventListener('pointerleave', function () {
      tx = 0;
      ty = 0;
      hover = false;
      if (!raf) raf = requestAnimationFrame(step);
    });
  });

  /* 5. RULES PDF CARD — 3D tilt + mouse-follow glow */
  var wrap = document.querySelector('.structure-wrap');
  var card = document.querySelector('.structure-doc');
  if (wrap && card) {
    var rx = 0, ry = 0, raf2 = null;

    function paint() {
      var active = Math.abs(rx) > 0.01 || Math.abs(ry) > 0.01;
      card.style.transform = active
        ? 'translateY(-2px) rotateX(' + rx.toFixed(3) + 'deg) rotateY(' + ry.toFixed(3) + 'deg)'
        : '';
      raf2 = null;
      if (!active) card.style.transition = '';
    }

    function schedule() {
      if (!raf2) raf2 = requestAnimationFrame(paint);
    }

    wrap.addEventListener('pointermove', function (e) {
      var r = wrap.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width;
      var py = (e.clientY - r.top) / r.height;
      ry = (px - 0.5) * 8;
      rx = (0.5 - py) * 8;
      card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
      card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
      card.style.transition = 'border-color 300ms ease, box-shadow 300ms ease';
      schedule();
    }, { passive: true });

    wrap.addEventListener('pointerleave', function () {
      rx = 0;
      ry = 0;
      schedule();
    });
  }
})();
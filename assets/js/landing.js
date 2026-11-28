/* SynapGPU landing: slideshow + nav mobile. Vanilla, tanpa dependensi. */
(function () {
  'use strict';

  /* ---- Nav mobile ---- */
  var burger = document.querySelector('.nav-burger');
  var links = document.querySelector('.nav-links');
  if (burger && links) {
    burger.addEventListener('click', function () {
      links.classList.toggle('open');
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') links.classList.remove('open');
    });
  }

  /* ---- Slideshow ---- */
  var slider = document.querySelector('[data-slider]');
  if (!slider) return;
  var slides = Array.prototype.slice.call(slider.querySelectorAll('.slide'));
  var dots = Array.prototype.slice.call(slider.querySelectorAll('.slider-dots button'));
  var cap = slider.querySelector('.slider-cap');
  var idx = 0, timer = null, DELAY = 5500;

  function show(n) {
    idx = (n + slides.length) % slides.length;
    slides.forEach(function (s, i) { s.classList.toggle('on', i === idx); });
    dots.forEach(function (d, i) { d.classList.toggle('on', i === idx); });
    if (cap) cap.textContent = slides[idx].getAttribute('data-cap') || '';
  }
  function next() { show(idx + 1); }
  function prev() { show(idx - 1); }
  function arm() {
    if (timer) clearInterval(timer);
    timer = setInterval(next, DELAY);
  }

  dots.forEach(function (d, i) {
    d.addEventListener('click', function () { show(i); arm(); });
  });
  var bNext = slider.querySelector('[data-next]');
  var bPrev = slider.querySelector('[data-prev]');
  if (bNext) bNext.addEventListener('click', function () { next(); arm(); });
  if (bPrev) bPrev.addEventListener('click', function () { prev(); arm(); });

  slider.addEventListener('mouseenter', function () { if (timer) clearInterval(timer); });
  slider.addEventListener('mouseleave', arm);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { next(); arm(); }
    if (e.key === 'ArrowLeft') { prev(); arm(); }
  });

  show(0);
  arm();
})();

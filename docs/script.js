// Doftar site. Three small jobs: theme toggle, reveal-on-scroll, copy button.
(function () {
  var root = document.documentElement;
  var KEY = 'doftar-theme';

  // Theme. Cycles system → the opposite of what is showing → saved choice.
  var themeBtn = document.getElementById('theme');
  var isDark = function () {
    return root.getAttribute('data-theme') === 'dark' ||
      (!root.hasAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
  };
  var labelTheme = function () {
    if (themeBtn) themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light theme' : 'Switch to dark theme');
  };
  if (themeBtn) {
    labelTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', labelTheme);
    themeBtn.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) {}
      labelTheme();
    });
  }

  // Sticky nav gets a hairline once the page scrolls.
  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle('is-stuck', window.scrollY > 8);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // Reveal on scroll, once, staggered within a viewport batch.
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var items = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      var i = 0;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        el.style.transitionDelay = (i++ * 60) + 'ms';
        el.classList.add('in');
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }

  // Demos only animate while on screen.
  var demos = document.querySelectorAll('.demo .stage, .addr-demo, .split-demo');
  if ('IntersectionObserver' in window) {
    demos.forEach(function (el) { el.classList.add('off'); });
    var po = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        entry.target.classList.toggle('off', !entry.isIntersecting);
      });
    }, { rootMargin: '80px 0px' });
    demos.forEach(function (el) { po.observe(el); });
  }

  // The fly demo's travel distance depends on the stage width.
  var fly = document.querySelector('.demo.fly .stage');
  if (fly) {
    var setFly = function () {
      var w = fly.clientWidth;
      fly.style.setProperty('--fly-x', Math.max(120, w - 18 - 140 + 62 - 26) + 'px');
    };
    setFly();
    window.addEventListener('resize', setFly);
  }
})();

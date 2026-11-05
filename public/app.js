// hoomuch's only script, and an optional one: every form works without it. It shows that a
// submitted form is on its way (the pressed button gets aria-busy, daisyUI's loading spinner and
// an optional data-busy label such as "Checking key…") and ignores a second submit meanwhile.
// The spinner's classes are listed in src/styles/app.css (@source inline), since public/ isn't scanned.
(function () {
  'use strict';
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post') return;
    if (form.hasAttribute('data-sending')) {
      e.preventDefault();
      return;
    }
    form.setAttribute('data-sending', '');
    var button = e.submitter || form.querySelector('button[type="submit"], button:not([type])');
    if (!button) return;
    button.setAttribute('aria-busy', 'true');
    var busy = button.getAttribute('data-busy');
    if (busy) {
      button.setAttribute('data-label', button.textContent);
      button.textContent = busy;
    }
    if (button.classList.contains('btn')) {
      var spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs';
      spinner.setAttribute('aria-hidden', 'true');
      spinner.setAttribute('data-spinner', '');
      button.prepend(spinner);
    }
  });
  // Back/Forward can restore this page from memory: make its forms usable again.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('form[data-sending]').forEach(function (f) {
      f.removeAttribute('data-sending');
    });
    document.querySelectorAll('[aria-busy="true"]').forEach(function (b) {
      b.removeAttribute('aria-busy');
      b.querySelectorAll('[data-spinner]').forEach(function (s) {
        s.remove();
      });
      var label = b.getAttribute('data-label');
      if (label !== null) b.textContent = label;
    });
  });
})();

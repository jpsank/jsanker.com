// Only for visitors who prefer reduced motion: show a still frame, click to play/stop.
(function () {
  if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var imgs = document.querySelectorAll('img[data-still]');
  Array.prototype.forEach.call(imgs, function (img) {
    var moving = img.getAttribute('src');
    var still = img.getAttribute('data-still');
    var playing = false;
    function set(on) {
      playing = on;
      img.src = on ? moving : still;
      img.classList.toggle('still', !on);
      img.title = on ? 'Click to stop' : 'Click to play';
    }
    img.setAttribute('role', 'button');
    img.tabIndex = 0;
    img.addEventListener('click', function () { set(!playing); });
    img.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(!playing); }
    });
    set(false);
  });
})();

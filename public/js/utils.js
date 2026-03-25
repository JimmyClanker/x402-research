// Round 79: scroll-to-top button
(function() {
  var btn = document.getElementById('scroll-top-btn');
  if (!btn) return;
  window.addEventListener('scroll', function() {
    var show = window.scrollY > 400;
    btn.style.opacity = show ? '1' : '0';
    btn.style.pointerEvents = show ? 'auto' : 'none';
  }, { passive: true });
  btn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  btn.addEventListener('mouseenter', function() {
    btn.style.borderColor = 'rgba(212,88,10,0.4)';
    btn.style.color = '#D4580A';
    btn.style.transform = 'translateY(-2px)';
  });
  btn.addEventListener('mouseleave', function() {
    btn.style.borderColor = '';
    btn.style.color = '';
    btn.style.transform = '';
  });
})();

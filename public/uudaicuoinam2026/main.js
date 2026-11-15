/* Đông Phú Gia – Tri ân cuối năm 2026 */
(function () {
  'use strict';

  /* ===== CONFIG – điền trước khi đưa lên dongphugia.vn ===== */
  var CONFIG = {
    // URL Web App của Google Apps Script (xem apps-script/Code.gs và README.md).
    // Để trống = chế độ demo: form chỉ hiện thông báo, không gửi đi đâu.
    SHEET_ENDPOINT: 'https://script.google.com/macros/s/AKfycbyGUU3STkL4PJicCAn1c1rQohBzCKphrUHbBjDx_8E74wD0HNqJ_uc9x890JwCrbQ1G/exec',
    // Link Messenger của fanpage, ví dụ 'https://m.me/tenfanpage'. Để trống = ẩn nút.
    MESSENGER_URL: ''
  };

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---- Header height → sticky offsets ---- */
  var hdr = $('.hdr');
  function setHdr() { document.documentElement.style.setProperty('--hdr-h', hdr.offsetHeight + 'px'); }
  setHdr();
  window.addEventListener('resize', setHdr);

  /* ---- Messenger button ---- */
  var msg = $('[data-messenger]');
  if (msg && CONFIG.MESSENGER_URL) { msg.href = CONFIG.MESSENGER_URL; msg.hidden = false; }

  /* ---- Tabs (ARIA) ---- */
  var tabs = $$('.tab');
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
    tab.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectTab(t); });
    t.addEventListener('keydown', function (e) {
      var n = null;
      if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
      if (e.key === 'Home') n = tabs[0];
      if (e.key === 'End') n = tabs[tabs.length - 1];
      if (n) { e.preventDefault(); selectTab(n, true); }
    });
  });

  /* ---- Current TOTO gift phase ---- */
  var today = new Date(); today.setHours(0, 0, 0, 0);
  $$('[data-phases] li').forEach(function (li) {
    var s = new Date(li.dataset.start + 'T00:00:00');
    var e = new Date(li.dataset.end + 'T23:59:59');
    if (today >= s && today <= e) li.classList.add('is-now');
    else if (today > e) li.classList.add('is-past');
  });

  /* ---- Active nav on scroll ---- */
  var navLinks = $$('.hdr__nav a, .hdr__chips a');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var id = '#' + en.target.id;
        navLinks.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('href') === id); });
        var chip = $('.hdr__chips a[href="' + id + '"]');
        if (chip && chip.scrollIntoView) chip.parentNode.scrollLeft = chip.offsetLeft - 18;
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    ['uu-dai', 'qua-toto', 'qua-dpg', 'vong-quay', 'boc-tham', 'lien-he'].forEach(function (id) {
      var el = document.getElementById(id); if (el) io.observe(el);
    });
  }

  /* ---- Prize image switcher (hover / focus / tap) ---- */
  var prizeImg = $('#prize-img');
  var prizeBtns = $$('.prize[data-img]');
  if (prizeImg && prizeBtns.length) {
    prizeBtns.forEach(function (b) { var i = new Image(); i.src = b.dataset.img; }); // preload
    var showPrize = function (b) {
      if (b.classList.contains('is-active')) return;
      prizeBtns.forEach(function (x) { var on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      var rank = $('.prize__rank', b).textContent, name = $('.prize__item', b).textContent;
      var val = $('.prize__val', b).textContent;
      $('#prize-cap-rank').textContent = rank;
      $('#prize-cap-name').textContent = name;
      $('#prize-cap-val').textContent = 'Trị giá ' + val;
      prizeImg.classList.add('is-fading');
      setTimeout(function () {
        prizeImg.src = b.dataset.img;
        prizeImg.alt = rank + ': ' + name;
        prizeImg.classList.remove('is-fading');
      }, 180);
    };
    prizeBtns.forEach(function (b) {
      b.addEventListener('mouseenter', function () { showPrize(b); });
      b.addEventListener('focus', function () { showPrize(b); });
      b.addEventListener('click', function () {
        showPrize(b);
        // On phones the picture sits above the list: bring it into view if it is off-screen.
        var r = prizeImg.getBoundingClientRect();
        if (r.bottom < 80 || r.top > window.innerHeight) prizeImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  /* ---- "Nhận báo giá" on product cards → prefill form ---- */
  var form = $('#lead-form');
  var interestMap = { 'panel-neorest': 'Bàn cầu thông minh NEOREST', 'panel-washlet': 'Nắp rửa điện tử / bàn cầu Washlet', 'panel-ketop': 'Bàn cầu kết hợp Washlet', 'panel-combo': 'Combo phòng tắm' };
  $$('.card__cta').forEach(function (b) {
    b.addEventListener('click', function () {
      $('#f-product').value = b.dataset.product || '';
      var panel = b.closest('.panel');
      if (panel && interestMap[panel.id]) $('#f-interest').value = interestMap[panel.id];
      goToForm();
    });
  });
  $$('[data-scroll-form]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); goToForm(); });
  });
  function goToForm() {
    document.getElementById('lien-he').scrollIntoView({ behavior: 'smooth' });
    setTimeout(function () { $('#f-name').focus({ preventScroll: true }); }, 600);
  }

  /* ---- Lead form ---- */
  function normPhone(v) { return String(v || '').replace(/[^\d+]/g, '').replace(/^\+84/, '0').replace(/^84(?=\d{9}$)/, '0'); }
  function validPhone(v) { return /^0\d{9}$/.test(normPhone(v)); }
  function setErr(id, bad) {
    var input = document.getElementById(id);
    input.closest('.field').classList.toggle('is-invalid', bad);
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    var err = document.getElementById(id + '-err');
    if (err) { err.hidden = !bad; if (bad) input.setAttribute('aria-describedby', id + '-err'); }
  }
  function utm(k) { try { return new URLSearchParams(location.search).get(k) || ''; } catch (e) { return ''; } }
  function showMsg(text, ok) {
    var m = $('#form-msg');
    m.textContent = text; m.hidden = false;
    m.className = 'form__msg ' + (ok ? 'is-ok' : 'is-err');
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (form.classList.contains('is-sending')) return;
    var name = $('#f-name').value.trim();
    var phone = $('#f-phone').value;
    var badName = name.length < 2, badPhone = !validPhone(phone);
    setErr('f-name', badName); setErr('f-phone', badPhone);
    if (badName) { $('#f-name').focus(); return; }
    if (badPhone) { $('#f-phone').focus(); return; }

    var data = new URLSearchParams();
    data.append('name', name);
    data.append('phone', normPhone(phone));
    data.append('area', $('#f-area').value.trim());
    data.append('interest', $('#f-interest').value);
    data.append('product', $('#f-product').value.trim());
    data.append('note', $('#f-note').value.trim());
    data.append('website', $('#f-website').value); // honeypot
    data.append('page', location.href.split('#')[0]);
    data.append('utm_source', utm('utm_source'));
    data.append('utm_medium', utm('utm_medium'));
    data.append('utm_campaign', utm('utm_campaign'));

    var done = function () {
      form.classList.remove('is-sending');
      form.reset();
      showMsg('Cảm ơn ' + name + '! Đông Phú Gia đã nhận yêu cầu và sẽ liên hệ với bạn qua số ' + normPhone(phone) + '. Cần gấp, gọi hotline 0913 865 685.', true);
    };

    if (!CONFIG.SHEET_ENDPOINT) {
      showMsg('Chưa thể gửi yêu cầu lúc này. Vui lòng gọi hotline 0913 865 685 để được tư vấn.', false);
      return;
    }

    form.classList.add('is-sending');
    // Apps Script web app: a form-encoded POST is a "simple" request (no preflight), and the
    // redirected reply allows any origin, so we can read {ok:true}. Anything else = not saved.
    var fail = function () {
      form.classList.remove('is-sending');
      showMsg('Chưa gửi được thông tin. Vui lòng thử lại hoặc gọi hotline 0913 865 685 để được tư vấn ngay.', false);
    };
    fetch(CONFIG.SHEET_ENDPOINT, { method: 'POST', body: data })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) done(); else fail(); })
      .catch(fail);
  });
})();

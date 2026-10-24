(() => {
  const script = document.currentScript;
  if (!script) return;
  const api = (script.dataset.api || script.src.replace(/\/widget\.js(?:\?.*)?$/, '')).replace(/\/$/, '');
  const key = script.dataset.key || '';
  const clinic = (script.dataset.clinic || 'default').replace(/[<>&"]/g, '');
  let privacyUrl = '';
  try {
    const candidate = new URL(script.dataset.privacyUrl || '');
    if (candidate.protocol === 'https:') privacyUrl = candidate.href;
  } catch { /* Optional in local demos; production keys are issued with a clinic notice URL. */ }
  const requestedAccent = script.dataset.color || '#216f58';
  const accent = /^#[0-9a-f]{3,8}$/i.test(requestedAccent) ? requestedAccent : '#216f58';
  let mount;
  try { mount = script.dataset.mount ? document.querySelector(script.dataset.mount) : null; } catch { mount = null; }
  const host = mount || document.body;
  if (!key || !host) return;

  const element = document.createElement('div');
  element.setAttribute('data-mediassist-widget', clinic);
  const shadow = element.attachShadow({ mode: 'open' });
  const inline = Boolean(mount);
  const minDate = new Date();
  minDate.setDate(minDate.getDate() + 1);
  const firstAvailableDate = new Date(minDate);
  while ([0, 6].includes(firstAvailableDate.getDay())) firstAvailableDate.setDate(firstAvailableDate.getDate() + 1);
  const dateString = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const minDateValue = dateString(minDate);
  const dateValue = dateString(firstAvailableDate);

  shadow.innerHTML = `
    <style>
      :host{all:initial;color:#1d2a25;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px;line-height:1.45;--accent:${accent};--accent-dark:color-mix(in srgb,${accent} 82%,#000)}
      *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}
      .launcher{position:fixed;right:24px;bottom:24px;z-index:2147483000;border:0;border-radius:999px;background:var(--accent);color:#fff;padding:14px 19px;box-shadow:0 12px 28px #183d302d;font-weight:700;display:flex;align-items:center;gap:9px}
      .launcher:hover,.submit:hover{background:var(--accent-dark)}.spark{font-size:18px;line-height:1}
      .panel{position:fixed;z-index:2147483001;right:24px;bottom:84px;width:min(390px,calc(100vw - 32px));max-height:min(760px,calc(100vh - 112px));overflow:auto;background:#fff;border:1px solid #e1e8e2;border-radius:22px;box-shadow:0 24px 80px #152d2250;padding:22px;animation:enter .18s ease-out}
      .panel.inline{position:relative;right:auto;bottom:auto;width:min(100%,430px);max-height:none;animation:none}.hidden{display:none!important}
      @keyframes enter{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      .top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:18px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;color:#6c8175;font-size:10px;font-weight:800;margin-bottom:5px}.title{margin:0;font-size:21px;letter-spacing:-.03em;font-weight:750}.close{border:0;background:#f1f5f1;color:#53665b;border-radius:9px;width:34px;height:34px;font-size:19px;line-height:1}
      label{display:block;font-size:12px;color:#3c5045;font-weight:650;margin:14px 0 6px}.field{width:100%;height:43px;border:1px solid #dce5dd;border-radius:11px;background:#fff;color:#1c2b23;padding:0 12px;outline:none}.field:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 16%,transparent)}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.helper{font-size:11px;color:#78887e;margin:8px 0 0}.submit{width:100%;height:46px;border:0;border-radius:12px;background:var(--accent);color:#fff;font-weight:750;margin-top:18px}.submit:disabled{opacity:.6;cursor:wait}.status{min-height:18px;margin:12px 0 0;font-size:12px;color:#53685c}.status.error{color:#ad352d}.status.success{color:#217354}.foot{font-size:10px;color:#89968e;margin-top:16px;text-align:center}.foot a{color:var(--accent);font-weight:650;text-decoration:underline;text-underline-offset:2px}
      @media(max-width:480px){.launcher{right:15px;bottom:15px}.panel{right:8px;bottom:76px;width:calc(100vw - 16px);padding:19px}.panel.inline{right:auto;bottom:auto;width:100%}}
    </style>
    ${inline ? '' : '<button class="launcher" type="button" aria-haspopup="dialog" aria-expanded="false"><span class="spark" aria-hidden="true">✳</span> Book an appointment</button>'}
    <section class="panel ${inline ? '' : 'hidden'} ${inline ? 'inline' : ''}" role="dialog" aria-modal="false" aria-labelledby="ma-title" aria-hidden="${inline ? 'false' : 'true'}">
      <div class="top"><div><div class="eyebrow">${clinic.replace(/[<>]/g, '')}</div><h2 class="title" id="ma-title">Book a visit</h2></div><button class="close ${inline ? 'hidden' : ''}" type="button" aria-label="Close booking form">×</button></div>
      <form novalidate>
        <label for="ma-date">Choose a date</label><input class="field" id="ma-date" name="date" type="date" min="${minDateValue}" value="${dateValue}" required>
        <label for="ma-slot">Available time</label><select class="field" id="ma-slot" name="slotId" required><option value="">Loading times…</option></select>
        <p class="helper">Times shown in your clinic's local timezone.</p>
        <div class="grid"><div><label for="ma-name">Full name</label><input class="field" id="ma-name" name="name" autocomplete="name" maxlength="120" required></div><div><label for="ma-phone">Phone</label><input class="field" id="ma-phone" name="phone" type="tel" autocomplete="tel" maxlength="40"></div></div>
        <label for="ma-email">Email address</label><input class="field" id="ma-email" name="email" type="email" autocomplete="email" maxlength="254" required>
        <button class="submit" type="submit">Confirm appointment</button><div class="status" role="status" aria-live="polite"></div>
      </form>
      <div class="foot">${privacyUrl ? `<a href="${privacyUrl}" target="_blank" rel="noopener noreferrer">Clinic privacy notice</a>` : 'Your details are used to manage this appointment.'}</div>
    </section>`;

  host.append(element);
  const launcher = shadow.querySelector('.launcher');
  const panel = shadow.querySelector('.panel');
  const closeButton = shadow.querySelector('.close');
  const dateInput = shadow.querySelector('#ma-date');
  const slotSelect = shadow.querySelector('#ma-slot');
  const form = shadow.querySelector('form');
  const status = shadow.querySelector('.status');
  const submit = shadow.querySelector('.submit');
  let busy = false;
  let booked = false;
  let bookingIdempotencyKey = '';
  let bookingCorrelationId = '';
  let previousFocus = null;
  const correlationId = globalThis.crypto?.randomUUID?.() || `widget-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const createRequestId = (prefix) => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const setStatus = (message, kind = '') => {
    status.textContent = message;
    status.className = `status ${kind}`;
  };
  const request = async (path, options = {}) => {
    const response = await fetch(`${api}${path}`, {
      ...options,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-request-id': correlationId, ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'The booking service is unavailable.');
    return payload;
  };
  const loadSlots = async () => {
    slotSelect.disabled = true;
    slotSelect.innerHTML = '<option value="">Loading times…</option>';
    setStatus('Checking availability…');
    try {
      const result = await request(`/public/slots?date=${encodeURIComponent(dateInput.value)}`);
      slotSelect.innerHTML = '';
      if (!result.slots?.length) {
        slotSelect.add(new Option('No times available', ''));
        setStatus('No appointments available for that date. Choose another day.');
      } else {
        slotSelect.add(new Option('Select a time', ''));
        result.slots.forEach((slot) => slotSelect.add(new Option(`${slot.time} · ${slot.clinician}`, slot.id)));
        setStatus('');
      }
    } catch (error) {
      slotSelect.innerHTML = '<option value="">Could not load times</option>';
      setStatus(`${error.message} Change the date to retry.`, 'error');
    } finally {
      slotSelect.disabled = false;
    }
  };
  const open = () => {
    previousFocus = document.activeElement;
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    launcher?.setAttribute('aria-expanded', 'true');
    shadow.querySelector('#ma-date').focus();
  };
  const close = () => {
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    launcher?.setAttribute('aria-expanded', 'false');
    previousFocus?.focus?.();
  };

  launcher?.addEventListener('click', open);
  closeButton?.addEventListener('click', close);
  shadow.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !inline) close(); });
  dateInput.addEventListener('change', () => { booked = false; bookingIdempotencyKey = ''; bookingCorrelationId = ''; loadSlots(); });
  slotSelect.addEventListener('change', () => { if (!booked) { bookingIdempotencyKey = ''; bookingCorrelationId = ''; } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || booked) return;
    if (!form.reportValidity()) return;
    busy = true;
    bookingIdempotencyKey ||= createRequestId('booking-key');
    bookingCorrelationId ||= createRequestId('booking-trace');
    submit.disabled = true;
    submit.textContent = 'Confirming…';
    setStatus('Saving your appointment…');
    const data = new FormData(form);
    try {
      const result = await request('/public/bookings', { method: 'POST', headers: { 'idempotency-key': bookingIdempotencyKey, 'x-request-id': bookingCorrelationId }, body: JSON.stringify({ slotId: data.get('slotId'), name: data.get('name'), email: data.get('email'), phone: data.get('phone') || undefined }) });
      booked = true;
      submit.textContent = 'Appointment confirmed';
      setStatus(`Your appointment is booked for ${result.booking.slot.date} at ${result.booking.slot.time}. This page shows the confirmation for ${result.booking.email}.`, 'success');
      void request('/public/events/booking-created', { method: 'POST', headers: { 'x-request-id': bookingCorrelationId }, body: JSON.stringify({ bookingId: result.booking.id }) }).catch(() => {});
    } catch (error) {
      setStatus(`${error.message} Please try again.`, 'error');
      await loadSlots();
    } finally {
      busy = false;
      if (!booked) {
        submit.disabled = false;
        submit.textContent = 'Confirm appointment';
      }
    }
  });
  void loadSlots();
})();

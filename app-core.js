/* ============================================================================
   app-core.js — клиентское ядро MVP 1 SAGAT
   Аутентификация, кабинет кандидата, контур симуляции, рабочее место HR.
   Состояние хранится в памяти + на сервере; storage браузера не используется,
   потому что предпросмотр работает в песочнице iframe.
   ========================================================================== */
(function () {
  'use strict';

  const API = 'port/8000'.startsWith('__') ? 'http://localhost:8000' : 'port/8000';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (v) =>
    String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('ru-RU');
  /* русские склонения: _pl(2, 'кандидат', 'кандидата', 'кандидатов') */
  const _pl = (n, one, few, many) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  };
  const initials = (name) =>
    String(name || '')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0] || '')
      .join('')
      .toUpperCase() || '—';

  const ROLE_LABEL = { candidate: 'кандидат', company: 'компания · HR' };
  const HR_STATUS = {
    new: 'новый',
    shortlist: 'в shortlist',
    interview: 'интервью',
    offer: 'оффер',
    reject: 'отказ',
  };

  /* ───────────────── состояние ───────────────── */
  const S = {
    token: null,
    user: null,
    stats: null,
    catalog: null,
    route: { name: 'dash', params: {} },
    attempts: [],
    vacancies: [],
    run: null,
    online: true,
  };

  /* ───────────────── идентификатор устройства ─────────────────
     В песочнице iframe web storage недоступен, поэтому идентификатор храним
     в cookie, а если и она заблокирована — в памяти страницы.
     Сервер восстанавливает сессию по этому идентификатору (X-Visitor-Id). */
  const VISITOR = (function () {
    const KEY = 'sagat_vid';
    const make = () => 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    try {
      const m = document.cookie.match(/(?:^|;\s*)sagat_vid=([^;]+)/);
      if (m) return m[1];
      const v = make();
      document.cookie = KEY + '=' + v + ';path=/;max-age=2592000;SameSite=Lax';
      if (document.cookie.indexOf(KEY) > -1) return v;
      return v;
    } catch (e) {
      /* cookie недоступны — работаем в памяти страницы */
    }
    return make();
  })();

  /* ───────────────── сеть ───────────────── */
  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json', 'X-Visitor-Id': VISITOR };
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    let res;
    try {
      res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      setOnline(false);
      throw new Error('Сервер платформы недоступен');
    }
    setOnline(true);
    let data = null;
    const txt = await res.text();
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch (e) {
      data = null;
    }
    if (!res.ok) {
      const msg = (data && (data.detail || data.message)) || 'Ошибка запроса (' + res.status + ')';
      const err = new Error(typeof msg === 'string' ? msg : 'Ошибка запроса');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setOnline(v) {
    if (S.online === v) return;
    S.online = v;
    const box = $('#appOffline');
    if (box) box.hidden = v;
  }

  /* ───────────────── тосты ───────────────── */
  let toastTimer = null;
  function toast(msg, kind) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    el.className = 'toast on' + (kind ? ' toast--' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = 'toast';
      el.hidden = true;
    }, 3600);
  }

  /* ═══════════════════════════════════════════════════════════════════
     АУТЕНТИФИКАЦИЯ
     ═══════════════════════════════════════════════════════════════════ */
  const dlg = $('#auth');
  let mode = 'signup';
  let role = 'candidate';
  let afterAuth = null;

  function syncMode() {
    const isUp = mode === 'signup';
    $$('[data-auth-tab]').forEach((b) => {
      if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', b.dataset.authTab === mode ? 'true' : 'false');
    });
    $('#authTitle').textContent = isUp ? 'Создать аккаунт' : 'Вход в аккаунт';
    $('#authSub').textContent = isUp
      ? 'Выберите, с какой стороны вы приходите на платформу.'
      : 'Введите почту и пароль вашего аккаунта 1 SAGAT.';
    $('#afSubmit').textContent = isUp ? 'Создать аккаунт' : 'Войти';
    $('#authAlt').innerHTML = isUp
      ? 'Уже есть аккаунт? <button type="button" class="lnk" data-auth-tab="signin">Войти</button>'
      : 'Нет аккаунта? <button type="button" class="lnk" data-auth-tab="signup">Зарегистрироваться</button>';
    $$('[data-only]').forEach((el) => {
      el.hidden = el.dataset.only !== mode;
    });
    $('#afPass').setAttribute('autocomplete', isUp ? 'new-password' : 'current-password');
    $('.auth-roles').hidden = !isUp;
    syncRole();
    hideErr();
  }

  function syncRole() {
    $$('.auth-roles [data-role]').forEach((b) => b.setAttribute('aria-checked', b.dataset.role === role ? 'true' : 'false'));
    $$('.auth-pts li').forEach((li) => {
      li.hidden = li.dataset.for !== role;
    });
    const wrap = $('#afOrgWrap');
    if (wrap) {
      wrap.firstChild.textContent = role === 'company' ? 'Название компании' : 'Вуз или место учёбы';
      $('#afOrg').placeholder = role === 'company' ? 'TechnoDom Digital' : 'КБТУ, 3 курс';
    }
  }

  function showErr(msg) {
    const el = $('#afErr');
    el.textContent = msg;
    el.hidden = false;
  }
  function hideErr() {
    $('#afErr').hidden = true;
  }

  function openAuth(nextMode, nextRole, next) {
    if (nextMode) mode = nextMode;
    if (nextRole) role = nextRole;
    if (next) afterAuth = next;
    syncMode();
    if (dlg.showModal && !dlg.open) dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => $('#afEmail').focus(), 60);
  }
  function closeAuth() {
    if (dlg.close && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
  }

  $$('[data-auth-open]').forEach((b) =>
    b.addEventListener('click', () => openAuth(b.dataset.authOpen, b.dataset.authRole))
  );
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-auth-tab]');
    if (!t) return;
    mode = t.dataset.authTab;
    syncMode();
  });
  $$('.auth-roles [data-role]').forEach((b) =>
    b.addEventListener('click', () => {
      role = b.dataset.role;
      syncRole();
    })
  );
  $('#authClose').addEventListener('click', closeAuth);
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) closeAuth();
  });

  const eye = $('#afEye');
  eye &&
    eye.addEventListener('click', () => {
      const f = $('#afPass');
      const show = f.type === 'password';
      f.type = show ? 'text' : 'password';
      eye.textContent = show ? 'скрыть' : 'показать';
    });

  $('#afPass').addEventListener('input', () => {
    const v = $('#afPass').value;
    const meter = $('#afMeter');
    if (!meter) return;
    let sc = 0;
    if (v.length >= 8) sc++;
    if (/\d/.test(v)) sc++;
    if (/[a-zа-я]/i.test(v) && /[A-ZА-Я]/.test(v)) sc++;
    if (v.length >= 12 || /[^\w\s]/.test(v)) sc++;
    const labels = ['слишком простой', 'слабый', 'нормальный', 'надёжный', 'сильный'];
    meter.dataset.score = String(sc);
    $$('i', meter).forEach((i, idx) => i.classList.toggle('on', idx < sc));
    $('span', meter).textContent = v ? labels[sc] : '—';
  });

  $('#authForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideErr();
    const email = $('#afEmail').value.trim();
    const pass = $('#afPass').value;
    const btn = $('#afSubmit');
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) return showErr('Введите корректный email.');
    if (pass.length < 8) return showErr('Пароль должен быть не короче 8 символов.');
    const body = { email: email, password: pass };
    if (mode === 'signup') {
      const name = $('#afName').value.trim();
      if (name.split(/\s+/).length < 2) return showErr('Укажите имя и фамилию.');
      if (!$('#afAgree').checked) return showErr('Нужно согласиться с правилами честного прохождения.');
      body.name = name;
      body.role = role;
      body.org = $('#afOrg').value.trim();
      body.city = 'Алматы';
    }
    btn.disabled = true;
    btn.textContent = 'Секунду...';
    try {
      const out = await api(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', body: body });
      S.token = out.token;
      S.user = out.user;
      closeAuth();
      $('#authForm').reset();
      $('#afMeter') && $$('i', $('#afMeter')).forEach((i) => i.classList.remove('on'));
      toast(mode === 'signup' ? 'Аккаунт создан. Добро пожаловать в 1 SAGAT.' : 'С возвращением, ' + S.user.name.split(' ')[0] + '.');
      await afterLogin();
    } catch (e) {
      showErr(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = mode === 'signup' ? 'Создать аккаунт' : 'Войти';
    }
  });

  $$('[data-demo-login]').forEach((b) =>
    b.addEventListener('click', async () => {
      const who = b.dataset.demoLogin;
      try {
        const out = await api('/api/auth/login', {
          method: 'POST',
          body: { email: who === 'hr' ? 'hr@sagat.kz' : 'student@sagat.kz', password: 'sagat2026' },
        });
        S.token = out.token;
        S.user = out.user;
        closeAuth();
        toast('Вход в демо-аккаунт: ' + out.user.name);
        await afterLogin();
      } catch (e) {
        toast(e.message, 'bad');
      }
    })
  );

  async function afterLogin() {
    await refreshMe();
    syncHeader();
    const next = afterAuth;
    afterAuth = null;
    openApp(next || (S.user.role === 'company' ? 'hr' : 'dash'));
  }

  async function refreshMe() {
    const out = await api('/api/me');
    S.user = out.user;
    S.stats = out.stats || null;
    return S.user;
  }

  function syncHeader() {
    const signed = !!S.user;
    $$('.auth-btn').forEach((b) => (b.hidden = signed));
    const acct = $('#acct');
    if (acct) acct.hidden = !signed;
    if (signed) {
      $('#acctAva').textContent = initials(S.user.name);
      $('#acctName').textContent = S.user.name;
      $('#acctRole').textContent = ROLE_LABEL[S.user.role] + (S.user.org ? ' · ' + S.user.org : '');
      $('#appAva').textContent = initials(S.user.name);
      $('#appName').textContent = S.user.name;
      $('#appRole').textContent = ROLE_LABEL[S.user.role] + (S.user.org ? ' · ' + S.user.org : '');
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      /* всё равно чистим локально */
    }
    S.token = null;
    S.user = null;
    S.stats = null;
    S.attempts = [];
    S.vacancies = [];
    S.run = null;
    syncHeader();
    closeApp();
    toast('Вы вышли из аккаунта.');
  }

  $('#acctOut') && $('#acctOut').addEventListener('click', logout);
  $('#appOut') && $('#appOut').addEventListener('click', logout);

  /* ═══════════════════════════════════════════════════════════════════
     ОБОЛОЧКА КАБИНЕТА
     ═══════════════════════════════════════════════════════════════════ */
  const appEl = $('#app');
  const viewEl = $('#appView');

  const NAV = {
    candidate: [
      ['dash', 'Обзор'],
      ['run', 'Симуляция'],
      ['history', 'История и бейджи'],
      ['profile', 'Профиль'],
    ],
    company: [
      ['hr', 'Отборы'],
      ['new', 'Новый отбор'],
      ['profile', 'Профиль'],
    ],
  };

  function renderNav() {
    const nav = $('#appNav');
    if (!S.user) return (nav.innerHTML = '');
    const items = NAV[S.user.role] || [];
    nav.innerHTML = items
      .map(
        ([k, label]) =>
          `<button type="button" data-go="${k}" class="${S.route.name === k || (k === 'hr' && S.route.name === 'vacancy') ? 'on' : ''}">${esc(label)}</button>`
      )
      .join('');
    $('#appModeLabel').textContent = S.user.role === 'company' ? 'hiring challenge' : 'career challenge';
  }

  function openApp(route, params) {
    if (!S.user) {
      openAuth('signup', route === 'hr' || route === 'new' ? 'company' : 'candidate', route);
      return;
    }
    appEl.hidden = false;
    document.body.classList.add('app-on');
    go(route || (S.user.role === 'company' ? 'hr' : 'dash'), params);
  }

  function closeApp() {
    appEl.hidden = true;
    document.body.classList.remove('app-on');
    stopTimer();
  }

  $$('[data-app-close]').forEach((b) => b.addEventListener('click', closeApp));

  document.addEventListener('click', async (ev) => {
    const open = ev.target.closest && ev.target.closest('[data-app-open]');
    if (open) {
      const what = open.dataset.appOpen;
      if (what === 'demo-hr') {
        if (!S.user || S.user.role !== 'company') {
          try {
            const out = await api('/api/auth/login', { method: 'POST', body: { email: 'hr@sagat.kz', password: 'sagat2026' } });
            S.token = out.token;
            S.user = out.user;
            await refreshMe();
            syncHeader();
          } catch (e) {
            return toast(e.message, 'bad');
          }
        }
        return openApp('hr');
      }
      if (what === 'auto' || what === 'me') return openApp(S.user && S.user.role === 'company' ? 'hr' : 'dash');
      if (what === 'run' && S.user && S.user.role === 'company') {
        toast('Симуляции проходят кандидаты. Для компании — отборы под вакансии.');
        return openApp('hr');
      }
      return openApp(what);
    }
    const goBtn = ev.target.closest && ev.target.closest('[data-go]');
    if (goBtn) {
      ev.preventDefault();
      go(goBtn.dataset.go, goBtn.dataset.params ? JSON.parse(goBtn.dataset.params) : {});
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !appEl.hidden && S.route.name !== 'run') closeApp();
  });

  const VIEWS = {};
  async function go(name, params) {
    S.route = { name: name, params: params || {} };
    renderNav();
    const fn = VIEWS[name];
    if (!fn) return;
    viewEl.innerHTML = '<div class="skel-wrap"><div class="skel"></div><div class="skel"></div><div class="skel skel--wide"></div></div>';
    try {
      await fn(params || {});
    } catch (e) {
      viewEl.innerHTML =
        '<div class="app-wrap"><div class="err-box"><h3>Не удалось загрузить раздел</h3><p>' +
        esc(e.message) +
        '</p><button class="btn btn--ghost btn--sm" type="button" data-go="' +
        (S.user && S.user.role === 'company' ? 'hr' : 'dash') +
        '">Назад</button></div></div>';
    }
    viewEl.scrollTop = 0;
  }

  /* ───────────────── общие компоненты разметки ───────────────── */
  function kpi(items) {
    return (
      '<ul class="kpis">' +
      items
        .map(
          (i) =>
            `<li><b class="tnum">${esc(i[0])}</b><span>${esc(i[1])}</span>${i[2] ? `<i class="kpi-note">${esc(i[2])}</i>` : ''}</li>`
        )
        .join('') +
      '</ul>'
    );
  }

  function barsHtml(criteria, penalty) {
    let html = criteria
      .map(
        (c) => `<li>
        <div class="row"><span>${esc(c.title)}</span><span class="tnum">${c.score} / ${c.max}</span></div>
        <div class="track"><i style="inline-size:${Math.round((c.score / c.max) * 100)}%"></i></div>
        ${c.evidence ? `<p class="crit-ev">${esc(c.evidence)}</p>` : ''}
        ${c.recommendation ? `<p class="crit-rec">${esc(c.recommendation)}</p>` : ''}
      </li>`
      )
      .join('');
    if (penalty > 0) {
      html += `<li><div class="row"><span>Штраф за телеметрию</span><span class="tnum">−${penalty} · макс. −12</span></div>
        <div class="track"><i style="inline-size:${Math.round((penalty / 12) * 100)}%;background:var(--color-danger)"></i></div></li>`;
    }
    return '<ul class="bars">' + html + '</ul>';
  }

  function badgeChip(badge, label) {
    const cls = badge === 'verified' ? 'chip chip--on' : badge === 'partial' ? 'chip' : 'chip chip--muted';
    return `<span class="${cls}"><i class="dot"></i>${esc(label || (badge === 'verified' ? 'Verified Skill Badge · выдан' : badge === 'partial' ? 'Бейдж · частично' : 'Бейдж не выдан'))}</span>`;
  }

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: ОБЗОР КАНДИДАТА
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.dash = async function () {
    const [me, list, cat] = await Promise.all([api('/api/me'), api('/api/attempts'), S.catalog ? Promise.resolve({ ...S.catalog }) : api('/api/catalog')]);
    S.user = me.user;
    S.stats = me.stats;
    S.catalog = cat;
    S.attempts = list.attempts;
    const st = me.stats || {};
    const open = S.attempts.filter((a) => a.status === 'open' || a.status === 'submitted')[0];
    const last = S.attempts.filter((a) => a.status === 'scored')[0];

    viewEl.innerHTML = `
      <div class="app-wrap">
        <header class="page-head">
          <div>
            <p class="eyebrow">Career Challenge · бесплатно</p>
            <h1>Привет, ${esc(S.user.name.split(' ')[0])}</h1>
            <p class="lede">Проходите профессиональные симуляции, получайте разбор по пяти критериям и Verified Skill Badge, который можно приложить к профилю вместо обещаний в резюме.</p>
          </div>
          <div class="page-head-act">
            <button class="btn btn--primary" type="button" data-go="run">${open ? 'Вернуться в сессию' : 'Новая симуляция'}</button>
          </div>
        </header>

        ${kpi([
          [num(st.attempts || 0), 'симуляций завершено'],
          [num(st.best || 0), 'лучший балл из 100'],
          [num(st.avg || 0), 'средний балл'],
          [num(st.badges || 0), 'подтверждённых бейджей'],
        ])}

        ${open ? `<div class="notice notice--warn"><b>Есть незавершённая сессия.</b> ${esc(open.case_title || '')} — статус «${open.status === 'open' ? 'решение пишется' : 'ожидает защиты'}». <button class="lnk" type="button" data-go="run">продолжить</button></div>` : ''}

        <div class="grid-2">
          <article class="card">
            <h3>Профиль навыков</h3>
            <p class="card-sub">Средняя доля от максимума по критериям рубрикатора за все попытки.</p>
            ${
              st.radar && Object.keys(st.radar).length
                ? '<div class="chart-box"><canvas id="radarChart" aria-label="Профиль навыков по критериям"></canvas></div>'
                : '<div class="empty"><p>Пока нет данных. Пройдите первую симуляцию — профиль соберётся из фактических оценок.</p><button class="btn btn--primary btn--sm" type="button" data-go="run">Начать</button></div>'
            }
          </article>
          <article class="card">
            <h3>Динамика баллов</h3>
            <p class="card-sub">Последние попытки в хронологическом порядке.</p>
            ${
              (st.trend || []).length > 1
                ? '<div class="chart-box"><canvas id="trendChart" aria-label="Динамика итоговых баллов"></canvas></div>'
                : '<div class="empty"><p>Динамика появится со второй попытки — так виден реальный прогресс, а не единичный результат.</p></div>'
            }
          </article>
        </div>

        ${
          last
            ? `<article class="card">
                <div class="card-head">
                  <div><h3>Последний результат</h3><p class="card-sub">${esc(last.case_title || '')} · ${esc(last.role_title)}</p></div>
                  ${badgeChip(last.badge)}
                </div>
                <div class="last-row">
                  <p class="total tnum"><span>${last.total}</span><sub>/100</sub></p>
                  <div class="last-crit">${(last.scores ? last.scores.criteria : []).map((c) => `<span>${esc(c.title)} <b class="tnum">${c.score}/${c.max}</b></span>`).join('')}</div>
                  <button class="btn btn--ghost btn--sm" type="button" data-go="result" data-params='${JSON.stringify({ id: last.id })}'>Полный разбор</button>
                </div>
              </article>`
            : ''
        }

        <article class="card">
          <div class="card-head">
            <div><h3>Доступные направления</h3><p class="card-sub">Кейсы с реальными B2B-ограничениями: бюджет, стек, сроки, требования к данным.</p></div>
          </div>
          <ul class="role-grid">
            ${(S.catalog.roles || [])
              .map(
                (r) => `<li>
                  <b>${esc(r.title)}</b>
                  <span class="mono">${esc(r.stack)}</span>
                  <p>${esc(r.skills.join(' · '))}</p>
                  <button class="btn btn--ghost btn--sm" type="button" data-go="run" data-params='${JSON.stringify({ role: r.key })}'>Пройти</button>
                </li>`
              )
              .join('')}
          </ul>
        </article>
      </div>`;

    if (st.radar && Object.keys(st.radar).length && window.Chart) drawRadar(st.radar);
    if ((st.trend || []).length > 1 && window.Chart) drawTrend(st.trend);
  };

  function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      primary: cs.getPropertyValue('--color-primary').trim() || '#48b3ae',
      text: cs.getPropertyValue('--color-text-faint').trim() || '#8b8f96',
      grid: cs.getPropertyValue('--color-border').trim() || '#2a2d33',
    };
  }

  function drawRadar(radar) {
    const titles = (S.catalog && S.catalog.rubric && S.catalog.rubric.titles) || {};
    const keys = Object.keys(radar);
    const c = chartColors();
    new window.Chart($('#radarChart'), {
      type: 'radar',
      data: {
        labels: keys.map((k) => titles[k] || k),
        datasets: [
          {
            data: keys.map((k) => radar[k]),
            borderColor: c.primary,
            backgroundColor: c.primary + '33',
            pointBackgroundColor: c.primary,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          r: {
            min: 0,
            max: 100,
            angleLines: { color: c.grid },
            grid: { color: c.grid },
            pointLabels: { color: c.text, font: { size: 10 } },
            ticks: { display: false },
          },
        },
      },
    });
  }

  function drawTrend(trend) {
    const c = chartColors();
    new window.Chart($('#trendChart'), {
      type: 'line',
      data: {
        labels: trend.map((_, i) => 'попытка ' + (i + 1)),
        datasets: [
          {
            data: trend,
            borderColor: c.primary,
            backgroundColor: c.primary + '22',
            fill: true,
            tension: 0.35,
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { min: 0, max: 100, grid: { color: c.grid }, ticks: { color: c.text } },
          x: { grid: { display: false }, ticks: { color: c.text } },
        },
      },
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: СИМУЛЯЦИЯ
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.run = async function (params) {
    const list = await api('/api/attempts');
    S.attempts = list.attempts;
    const active = S.attempts.filter((a) => a.status === 'open' || a.status === 'submitted')[0];
    if (active) {
      const d = await api('/api/attempts/' + active.id);
      return mountRun(d.attempt);
    }
    if (!S.catalog) S.catalog = await api('/api/catalog');
    const preRole = params.role || 'ai';
    viewEl.innerHTML = `
      <div class="app-wrap">
        <header class="page-head">
          <div>
            <p class="eyebrow">Новая сессия</p>
            <h1>Выберите контур прохождения</h1>
            <p class="lede">60 минут, один сквозной кейс, смена вводных в середине и защита решения перед ИИ-интервьюером. Вставка из буфера заблокирована — оценивается ваша собственная работа.</p>
          </div>
        </header>
        <div class="grid-2">
          <article class="card">
            <span class="chip chip--on"><i class="dot"></i>Career Challenge · бесплатно</span>
            <h3 style="margin-top:var(--space-4)">Самодиагностика</h3>
            <p class="card-sub">Результат виден только вам: разбор ошибок, план развития и бейдж для профиля.</p>
            <label class="af">Профессия
              <select id="runRole">
                ${(S.catalog.roles || [])
                  .map((r) => `<option value="${r.key}" ${r.key === preRole ? 'selected' : ''}>${esc(r.title)}</option>`)
                  .join('')}
              </select>
            </label>
            <button class="btn btn--primary" type="button" id="runStartCareer">Начать симуляцию</button>
          </article>
          <article class="card">
            <span class="chip"><i class="dot"></i>Hiring Challenge · по коду компании</span>
            <h3 style="margin-top:var(--space-4)">Отбор на вакансию</h3>
            <p class="card-sub">Кейс собирается из требований компании. Результат уходит в её shortlist с доказательной базой. Попытка одна.</p>
            <label class="af">Код отбора
              <input type="text" id="runCode" placeholder="SG-DEMO1" autocomplete="off" />
            </label>
            <p class="hint" id="runCodeInfo">Демо-код для показа: <button class="lnk" type="button" id="runCodeFill">SG-DEMO1</button></p>
            <button class="btn btn--ghost" type="button" id="runStartHiring">Проверить код и начать</button>
          </article>
        </div>
        <p class="hint" style="margin-block-start:var(--space-6)">Правила честного прохождения: вставка текста блокируется, уходы из окна и длинные паузы фиксируются, после сдачи ИИ задаёт уточняющие вопросы по вашей логике. Всё это влияет на итоговый балл.</p>
      </div>`;

    $('#runCodeFill').addEventListener('click', () => {
      $('#runCode').value = 'SG-DEMO1';
    });
    $('#runStartCareer').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const out = await api('/api/attempts', { method: 'POST', body: { mode: 'career', role_key: $('#runRole').value } });
        mountRun(out.attempt);
      } catch (err) {
        toast(err.message, 'bad');
        e.target.disabled = false;
      }
    });
    $('#runStartHiring').addEventListener('click', async (e) => {
      const code = $('#runCode').value.trim();
      if (!code) return toast('Введите код отбора', 'bad');
      e.target.disabled = true;
      try {
        const out = await api('/api/attempts', { method: 'POST', body: { mode: 'hiring', code: code } });
        mountRun(out.attempt);
      } catch (err) {
        toast(err.message, 'bad');
        e.target.disabled = false;
      }
    });
  };

  /* ───────── контур прохождения ───────── */
  let timer = null;
  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const SLOTS = 48;

  function mountRun(attempt) {
    stopTimer();
    const c = attempt.case;
    S.run = {
      id: attempt.id,
      case: c,
      secondsLeft: attempt.seconds_left || 3600,
      injected: !!attempt.inject_shown,
      injectOffset: 0,
      paste: 0,
      blur: 0,
      idle: 0,
      keys: 0,
      lastKey: 0,
      t0: Date.now(),
      buckets: new Array(SLOTS).fill(0),
      submitted: attempt.status === 'submitted',
      questions: attempt.questions || [],
    };

    viewEl.innerHTML = `
      <div class="app-wrap app-wrap--run">
        <div class="sim sim--live">
          <div class="sim-bar">
            <span class="title">1 sagat · ${esc(attempt.mode === 'hiring' ? 'hiring challenge' : 'career challenge')} · ${esc(attempt.role_title)}</span>
            <span class="chip" id="rState"><i class="dot"></i>Ожидание ввода</span>
            <span class="chip mono tnum" id="rClock">60:00</span>
          </div>
          <div class="sim-body">
            <div class="sim-main">
              <div class="brief">
                <h4>Задача · ${esc(c.title)}</h4>
                <p class="mono brief-client">${esc(c.client)}</p>
                <p>${esc(c.task)}</p>
                <ul class="constraints">${(c.constraints || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
              </div>

              <div class="inject" id="rInject" role="status">
                <strong>Вводные изменились · тест на адаптивность</strong>
                <p id="rInjectText"></p>
              </div>

              <label class="fl" for="rAnswer">Ваше решение</label>
              <textarea id="rAnswer" spellcheck="false" placeholder="Опишите архитектуру и решения по пунктам. Называйте цифры из ограничений: бюджет, срок, нагрузку. Объясняйте, почему выбран именно этот вариант..."></textarea>
              <div class="sim-actions">
                <button class="btn btn--primary btn--sm" id="rSubmit" disabled>Сдать решение</button>
                <span class="hint" id="rHint">0 символов · минимум 180 для сдачи</span>
              </div>

              <div class="qa" id="rQa">
                <p class="eyebrow" style="color:var(--color-primary)">Live Defense · ИИ-интервью</p>
                <p class="card-sub">Вопросы подобраны по содержанию вашего решения. Отвечайте измеримо: сигнал, порог, способ проверки.</p>
                <div id="rQaList"></div>
                <div class="sim-actions">
                  <button class="btn btn--primary btn--sm" id="rFinish">Сформировать карточку кандидата</button>
                  <span class="hint">Достаточно содержательно ответить на 2 из 3 вопросов</span>
                </div>
              </div>
            </div>

            <aside class="sim-side" aria-label="Телеметрия сессии">
              <p class="eyebrow" style="color:var(--color-primary)">Телеметрия</p>
              <ul class="tele" style="margin-block-start:var(--space-5)">
                <li><span class="k">Ритм печати</span><span class="v tnum" id="tWpm2">0 зн/мин</span></li>
                <li><span class="k">Вставка из буфера</span><span class="v tnum" id="tPaste2">0</span></li>
                <li><span class="k">Потеря фокуса окна</span><span class="v tnum" id="tBlur2">0</span></li>
                <li><span class="k">Пауз &gt; 20 сек</span><span class="v tnum" id="tIdle2">0</span></li>
                <li><span class="k">Объём решения</span><span class="v tnum" id="tLen2">0 зн.</span></li>
              </ul>
              <p class="k mono side-cap">Плотность ввода</p>
              <canvas id="rRhythm" height="120" aria-label="График плотности ввода по времени"></canvas>
              <p class="side-note">Телеметрия уходит на сервер вместе с решением и влияет на итоговый балл. Каждая вставка из буфера — минус 5, уход из окна — минус 2 (суммарно не более 12).</p>
              <button class="btn btn--ghost btn--sm" type="button" id="rAbort" style="margin-block-start:var(--space-5)">Прервать сессию</button>
            </aside>
          </div>
        </div>
      </div>`;

    const ta = $('#rAnswer');
    ta.value = attempt.answer || '';
    if (attempt.inject_shown && S.run.case.inject_enabled) showInject(attempt.case.inject);
    if (S.run.submitted) {
      renderQuestions(S.run.questions);
      ta.readOnly = true;
      $('#rSubmit').disabled = true;
      setState('Защита решения', 'chip--on');
    }

    ta.addEventListener('paste', (e) => {
      e.preventDefault();
      S.run.paste += 1;
      setState('Вставка заблокирована', 'chip--alert');
      ta.classList.add('flash-bad');
      setTimeout(() => {
        ta.classList.remove('flash-bad');
        if (!S.run.submitted) setState('Сессия идёт', 'chip--on');
      }, 1400);
      renderTele();
    });
    ta.addEventListener('drop', (e) => {
      e.preventDefault();
      S.run.paste += 1;
      renderTele();
    });
    ta.addEventListener('copy', (e) => e.preventDefault());
    ta.addEventListener('keydown', () => {
      S.run.keys += 1;
      S.run.lastKey = Date.now();
      S.run._idleFlag = false;
      const slot = Math.min(SLOTS - 1, Math.floor((Date.now() - S.run.t0) / 5000));
      S.run.buckets[slot] += 1;
      drawRhythm();
    });
    ta.addEventListener('input', renderTele);
    ta.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('blur', onBlur);
    $('#rSubmit').addEventListener('click', doSubmit);
    $('#rFinish').addEventListener('click', doFinish);
    $('#rAbort').addEventListener('click', () => {
      if (!confirm('Прервать сессию? Незавершённая попытка не попадёт в историю.')) return;
      stopTimer();
      window.removeEventListener('blur', onBlur);
      S.run = null;
      go('dash');
    });

    setState('Сессия идёт', 'chip--on');
    renderTele();
    drawRhythm();
    timer = setInterval(tick, 1000);
    tick();
    ta.focus();
  }

  function onBlur() {
    if (!S.run || S.run.submitted) return;
    S.run.blur += 1;
    renderTele();
  }

  function setState(text, cls) {
    const el = $('#rState');
    if (!el) return;
    el.className = 'chip' + (cls ? ' ' + cls : '');
    el.innerHTML = '<i class="dot"></i>' + esc(text);
  }

  function tick() {
    if (!S.run) return stopTimer();
    S.run.secondsLeft = Math.max(0, S.run.secondsLeft - 1);
    const el = $('#rClock');
    if (el) {
      const m = Math.floor(S.run.secondsLeft / 60);
      const s = S.run.secondsLeft % 60;
      el.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      el.classList.toggle('chip--alert', S.run.secondsLeft < 300);
    }
    const ta = $('#rAnswer');
    if (ta && S.run.lastKey && Date.now() - S.run.lastKey > 20000 && !S.run.submitted && !S.run._idleFlag) {
      S.run.idle += 1;
      S.run._idleFlag = true;
      renderTele();
    }
    if (!S.run.injected && !S.run.submitted && ta && S.run.case.inject_enabled && (ta.value.length >= 320 || 3600 - S.run.secondsLeft >= 240)) {
      triggerInject();
    }
    if (S.run.secondsLeft === 0 && !S.run.submitted) {
      const t = $('#rAnswer');
      if (t && t.value.trim().length >= 180) doSubmit();
      else toast('Время сессии истекло. Решение не набрало минимальный объём.', 'bad');
    }
    drawRhythm();
  }

  async function triggerInject() {
    S.run.injected = true;
    const ta = $('#rAnswer');
    S.run.injectOffset = ta ? ta.value.length : 0;
    try {
      const out = await api('/api/attempts/' + S.run.id + '/inject', { method: 'POST', body: { offset: S.run.injectOffset } });
      if (out && out.inject) showInject(out.inject);
    } catch (e) {
      showInject(S.run.case.inject);
    }
  }

  function showInject(text) {
    const box = $('#rInject');
    if (!box) return;
    $('#rInjectText').textContent = text || '';
    box.classList.add('on');
    setState('Вводные изменились', 'chip--alert');
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setTimeout(() => {
      if (S.run && !S.run.submitted) setState('Сессия идёт', 'chip--on');
    }, 5000);
  }

  function renderTele() {
    if (!S.run) return;
    const ta = $('#rAnswer');
    const len = ta ? ta.value.length : 0;
    const mins = Math.max(0.2, (Date.now() - S.run.t0) / 60000);
    const cpm = Math.round(S.run.keys / mins);
    S.run.cpm = cpm;
    const set = (id, v, cls) => {
      const el = $(id);
      if (!el) return;
      el.textContent = v;
      el.className = 'v tnum' + (cls || '');
    };
    set('#tWpm2', cpm + ' зн/мин');
    set('#tLen2', num(len) + ' зн.');
    set('#tPaste2', S.run.paste, S.run.paste ? ' bad' : '');
    set('#tBlur2', S.run.blur, S.run.blur ? ' warn' : '');
    set('#tIdle2', S.run.idle, S.run.idle ? ' warn' : '');
    const hint = $('#rHint');
    if (hint) hint.textContent = len < 180 ? len + ' символов · минимум 180 для сдачи' : num(len) + ' символов · можно сдавать';
    const btn = $('#rSubmit');
    if (btn) btn.disabled = len < 180 || S.run.submitted;
  }

  function drawRhythm() {
    const cv = $('#rRhythm');
    if (!cv || !S.run) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth || 280;
    const h = 60;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement);
    const accent = cs.getPropertyValue('--color-primary').trim();
    const faint = cs.getPropertyValue('--color-surface-3').trim();
    const max = Math.max(6, ...S.run.buckets);
    const bw = w / SLOTS;
    for (let i = 0; i < SLOTS; i++) {
      const v = S.run.buckets[i];
      const bh = v === 0 ? 1.5 : Math.max(2.5, (v / max) * (h - 4));
      ctx.fillStyle = v === 0 ? faint : accent;
      ctx.fillRect(i * bw + 0.8, h - bh, Math.max(1.6, bw - 1.6), bh);
    }
  }

  function telemetry() {
    const ta = $('#rAnswer');
    return {
      paste: S.run.paste,
      blur: S.run.blur,
      idle: S.run.idle,
      cpm: S.run.cpm || 0,
      chars: ta ? ta.value.length : 0,
      seconds: 3600 - S.run.secondsLeft,
    };
  }

  async function doSubmit() {
    const ta = $('#rAnswer');
    const btn = $('#rSubmit');
    btn.disabled = true;
    btn.textContent = 'Отправка...';
    if (!S.run.injected && S.run.case.inject_enabled) await triggerInject();
    try {
      const out = await api('/api/attempts/' + S.run.id + '/submit', {
        method: 'POST',
        body: { answer: ta.value, telemetry: telemetry() },
      });
      S.run.submitted = true;
      S.run.questions = out.questions;
      ta.readOnly = true;
      setState('Защита решения', 'chip--on');
      renderQuestions(out.questions);
    } catch (e) {
      toast(e.message, 'bad');
      btn.disabled = false;
    } finally {
      btn.textContent = 'Сдать решение';
    }
  }

  function renderQuestions(qs) {
    $('#rQaList').innerHTML = (qs || [])
      .map(
        (q, i) =>
          `<div class="q"><p class="who">ИИ-интервьюер · вопрос ${i + 1}</p><p>${esc(q)}</p>
           <textarea id="rQa${i}" rows="2" aria-label="Ответ на вопрос ${i + 1}" placeholder="Коротко и по существу..."></textarea></div>`
      )
      .join('');
    $('#rQa').classList.add('on');
    $('#rQa').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  async function doFinish() {
    const btn = $('#rFinish');
    btn.disabled = true;
    btn.textContent = 'Оценка...';
    const answers = (S.run.questions || []).map((_, i) => {
      const el = $('#rQa' + i);
      return el ? el.value.trim() : '';
    });
    try {
      const out = await api('/api/attempts/' + S.run.id + '/finish', { method: 'POST', body: { defense: answers, telemetry: telemetry() } });
      stopTimer();
      window.removeEventListener('blur', onBlur);
      const id = S.run.id;
      S.run = null;
      S.stats = out.stats;
      go('result', { id: id });
    } catch (e) {
      toast(e.message, 'bad');
      btn.disabled = false;
      btn.textContent = 'Сформировать карточку кандидата';
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: РЕЗУЛЬТАТ
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.result = async function (params) {
    const d = await api('/api/attempts/' + params.id);
    const a = d.attempt;
    const sc = a.scores || {};
    const c = a.case || {};
    const badgeUrl = a.badge_pid ? location.origin + location.pathname + '#/badge/' + a.badge_pid : null;

    viewEl.innerHTML = `
      <div class="app-wrap">
        <header class="page-head">
          <div>
            <p class="eyebrow">Карточка кандидата · ${esc(sc.rubric_version || '')}</p>
            <h1>${esc(c.title || 'Результат симуляции')}</h1>
            <p class="lede">${esc(a.role_title)} · оценка по ${(sc.criteria || []).length} критериям${a.mode === 'hiring' ? ' · результат передан в shortlist компании' : ''}</p>
          </div>
          <div class="page-head-act">
            <button class="btn btn--ghost" type="button" data-go="dash">В обзор</button>
            <button class="btn btn--primary" type="button" data-go="run">Ещё симуляция</button>
          </div>
        </header>

        <div class="result-top">
          <div class="score-head">
            <p class="total tnum"><span id="resTotal">0</span><sub>/100</sub></p>
            <div>
              ${badgeChip(a.badge, sc.badge_label)}
              <p class="mono res-meta">${esc(sc.rubric_version || '')} · отпечаток ${esc(sc.fingerprint || '')}</p>
            </div>
          </div>
          ${
            sc.flags && sc.flags.length
              ? `<div class="flags"><b>Флаги достоверности</b><ul>${sc.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`
              : '<div class="flags flags--ok"><b>Флагов достоверности нет</b><p>Телеметрия чистая: вставок из буфера и аномалий ввода не зафиксировано.</p></div>'
          }
        </div>

        <article class="card">
          <h3>Оценка по рубрикатору</h3>
          ${barsHtml(sc.criteria || [], sc.penalty || 0)}
        </article>

        <div class="grid-2">
          <article class="card">
            <h3>Заключение</h3>
            <p class="verdict-txt">${esc(sc.verdict || '')}</p>
            ${sc.strengths && sc.strengths.length ? `<p class="card-sub" style="margin-block-start:var(--space-5)"><b>Сильные стороны:</b> ${esc(sc.strengths.join(', '))}</p>` : ''}
            ${sc.gaps && sc.gaps.length ? `<p class="card-sub"><b>Пробелы:</b> ${esc(sc.gaps.join(', '))}</p>` : ''}
          </article>
          <article class="card">
            <h3>Что делать дальше</h3>
            <ul class="plist" style="margin-block-start:var(--space-4)">
              ${(sc.next_steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}
            </ul>
          </article>
        </div>

        ${
          a.badge_pid
            ? `<article class="card badge-card badge-card--wide">
                <header><span class="mono">verified skill badge</span></header>
                <h3>${esc(a.role_title)}</h3>
                <p class="bc-score"><b class="tnum">${a.total}</b><span>из 100 · выдан ${new Date(a.finished_at).toLocaleDateString('ru-RU')}</span></p>
                <p class="bc-id mono">публичная ссылка проверки · ${esc(a.badge_pid)}</p>
                <div class="bc-act">
                  <button class="btn btn--primary btn--sm" type="button" data-go="badge" data-params='${JSON.stringify({ pid: a.badge_pid })}'>Открыть страницу бейджа</button>
                  <button class="btn btn--ghost btn--sm" type="button" id="resCopy">Скопировать ссылку</button>
                </div>
              </article>`
            : `<div class="notice">Бейдж не выдан: для подтверждения навыка нужно набрать минимум 45 баллов. Повторная попытка доступна сразу — кейс будет другим.</div>`
        }

        <details class="card details">
          <summary>Ваше решение и защита целиком</summary>
          <pre class="answer-dump">${esc(a.answer)}</pre>
          ${(a.questions || [])
            .map((q, i) => `<div class="q q--static"><p class="who">Вопрос ${i + 1}</p><p>${esc(q)}</p><p class="ans">${esc((a.defense || [])[i] || '— без ответа')}</p></div>`)
            .join('')}
        </details>
      </div>`;

    const out = $('#resTotal');
    const target = a.total || 0;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 800);
      out.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);

    const copy = $('#resCopy');
    copy &&
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(badgeUrl);
          toast('Ссылка на бейдж скопирована.');
        } catch (e) {
          toast(badgeUrl);
        }
      });
  };

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: ИСТОРИЯ
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.history = async function () {
    const list = await api('/api/attempts');
    S.attempts = list.attempts;
    const scored = S.attempts.filter((a) => a.status === 'scored');
    viewEl.innerHTML = `
      <div class="app-wrap">
        <header class="page-head">
          <div>
            <p class="eyebrow">История</p>
            <h1>Попытки и бейджи</h1>
            <p class="lede">Каждая завершённая сессия сохраняется с решением, защитой, телеметрией и оценкой по рубрикатору. Это и есть портфолио доказательств вместо строк в резюме.</p>
          </div>
        </header>
        ${
          scored.length
            ? `<article class="card"><ul class="hist hist--big">
                ${scored
                  .map(
                    (a) => `<li>
                      <span class="mono">${new Date(a.finished_at).toLocaleDateString('ru-RU')}</span>
                      <span class="hist-t"><b>${esc(a.case_title || a.role_title)}</b><small>${esc(a.role_title)}${a.vacancy_title ? ' · отбор: ' + esc(a.vacancy_title) : ' · самодиагностика'}</small></span>
                      ${badgeChip(a.badge, a.badge === 'verified' ? 'бейдж выдан' : a.badge === 'partial' ? 'частично' : 'без бейджа')}
                      <b class="tnum">${a.total}</b>
                      <button class="btn btn--ghost btn--sm" type="button" data-go="result" data-params='${JSON.stringify({ id: a.id })}'>Разбор</button>
                    </li>`
                  )
                  .join('')}
              </ul></article>`
            : '<div class="empty empty--card"><p>Завершённых попыток пока нет.</p><button class="btn btn--primary btn--sm" type="button" data-go="run">Пройти первую симуляцию</button></div>'
        }
      </div>`;
  };

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: ПУБЛИЧНЫЙ БЕЙДЖ
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.badge = async function (params) {
    const d = await api('/api/badge/' + params.pid);
    const b = d.badge;
    viewEl.innerHTML = `
      <div class="app-wrap app-wrap--narrow">
        <article class="card badge-public">
          <header class="bp-head">
            <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 4H7a3 3 0 0 0-3 3v18a3 3 0 0 0 3 3h5" />
              <path d="M20 4h5a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3h-5" />
              <path d="M11 16.5l3.6 3.6L21.5 12" />
            </svg>
            <span class="mono">verified skill badge · 1 sagat</span>
          </header>
          <h1>${esc(b.name)}</h1>
          <p class="lede">${esc(b.role_title)}</p>
          <p class="bp-score"><b class="tnum">${b.total}</b><span>из 100 · ${esc(b.badge_label)}</span></p>
          <ul class="bc-crit">
            ${(b.criteria || []).map((c) => `<li style="--v:${Math.round((c.score / (c.max || 1)) * 100)}%"><span>${esc(c.title)}</span><b class="tnum">${c.score} / ${c.max}</b></li>`).join('')}
          </ul>
          <p class="bc-id mono">кейс: ${esc(b.case_title)}<br />рубрикатор ${esc(b.rubric_version)} · отпечаток ${esc(b.fingerprint)}<br />выдан ${b.issued_at ? new Date(b.issued_at).toLocaleDateString('ru-RU') : '—'}</p>
          ${b.flags && b.flags.length ? `<p class="bp-flags">Флаги достоверности: ${esc(b.flags.join('; '))}</p>` : '<p class="bp-ok">Проверка достоверности пройдена без флагов</p>'}
          <button class="btn btn--ghost btn--sm" type="button" data-go="${S.user && S.user.role === 'company' ? 'hr' : 'dash'}">Назад</button>
        </article>
      </div>`;
  };

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: HR — СПИСОК ОТБОРОВ
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.hr = async function () {
    const [me, list] = await Promise.all([api('/api/me'), api('/api/vacancies')]);
    S.user = me.user;
    S.stats = me.stats;
    S.vacancies = list.vacancies;
    const st = me.stats || {};
    viewEl.innerHTML = `
      <div class="app-wrap">
        <header class="page-head">
          <div>
            <p class="eyebrow">Hiring Challenge · ${esc(S.user.org || 'компания')}</p>
            <h1>Отборы под вакансии</h1>
            <p class="lede">Один отбор — одна вакансия. Кандидаты проходят симуляцию по вашим ограничениям, вы получаете ранжированный shortlist с доказательной базой вместо стопки CV.</p>
          </div>
          <div class="page-head-act">
            <button class="btn btn--primary" type="button" data-go="new">Создать отбор</button>
          </div>
        </header>

        ${kpi([
          [num(st.vacancies || 0), 'активных отборов'],
          [num(st.completed || 0), 'завершённых симуляций'],
          [num(st.shortlisted || 0), 'кандидатов в shortlist'],
          [st.hours_saved + ' ч', 'ручного скрининга снято', 'по 33 минуты на CV'],
        ])}

        ${
          S.vacancies.length
            ? `<ul class="vac-grid">
                ${S.vacancies
                  .map(
                    (v) => `<li class="card vac-card">
                      <div class="vac-top">
                        <span class="chip ${v.status === 'active' ? 'chip--on' : 'chip--muted'}"><i class="dot"></i>${v.status === 'active' ? 'отбор активен' : 'закрыт'}</span>
                        <span class="mono">${esc(v.code)}</span>
                      </div>
                      <h3>${esc(v.title)}</h3>
                      <p class="card-sub">${esc(v.role_title)} · ${esc(v.city || '')} · порог ${v.threshold}</p>
                      <ul class="vac-stats">
                        <li><b class="tnum">${num(v.stats.completed)}</b><span>прошли</span></li>
                        <li><b class="tnum">${num(v.stats.shortlist)}</b><span>в shortlist</span></li>
                        <li><b class="tnum">${num(v.stats.avg)}</b><span>средний балл</span></li>
                        <li><b class="tnum">${v.stats.hours_saved} ч</b><span>сэкономлено</span></li>
                      </ul>
                      <div class="bc-act">
                        <button class="btn btn--primary btn--sm" type="button" data-go="vacancy" data-params='${JSON.stringify({ id: v.id })}'>Открыть shortlist</button>
                        <button class="btn btn--ghost btn--sm" type="button" data-copy-code="${esc(v.code)}">Ссылка для кандидатов</button>
                      </div>
                    </li>`
                  )
                  .join('')}
              </ul>`
            : '<div class="empty empty--card"><p>Отборов пока нет. Опишите роль и ограничения проекта — платформа соберёт кейс, рубрикатор и код приглашения для кандидатов.</p><button class="btn btn--primary btn--sm" type="button" data-go="new">Создать первый отбор</button></div>'
        }
      </div>`;

    $$('[data-copy-code]').forEach((b) =>
      b.addEventListener('click', async () => {
        const link = location.origin + location.pathname + '#code=' + b.dataset.copyCode;
        try {
          await navigator.clipboard.writeText(link);
          toast('Ссылка для кандидатов скопирована. Код: ' + b.dataset.copyCode);
        } catch (e) {
          toast('Код отбора: ' + b.dataset.copyCode);
        }
      })
    );
  };

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: HR — НОВЫЙ ОТБОР
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.new = async function () {
    if (!S.catalog) S.catalog = await api('/api/catalog');
    viewEl.innerHTML = `
      <div class="app-wrap">
        <header class="page-head">
          <div>
            <p class="eyebrow">Конструктор отбора</p>
            <h1>Опишите роль — платформа соберёт кейс</h1>
            <p class="lede">Вы не пишете тестовое задание и не придумываете критерии. Движок превращает требования в кейс с ограничениями, рубрикатор оценки и код приглашения для кандидатов.</p>
          </div>
        </header>
        <div class="vb vb--app">
          <div class="vb-form">
            <h3>Требования к роли</h3>
            <div class="vb-fields">
              <label>Название вакансии<input type="text" id="nTitle" value="Junior AI Engineer · продуктовая команда" /></label>
              <label>Профессия
                <select id="nRole">${(S.catalog.roles || []).map((r) => `<option value="${r.key}">${esc(r.title)}</option>`).join('')}</select>
              </label>
              <label>Город<input type="text" id="nCity" value="Алматы" /></label>
              <label>Технологический стек<input type="text" id="nStack" value="Python, FastAPI, PostgreSQL + pgvector" /></label>
              <label>Бюджет инфраструктуры, $/мес<input type="number" id="nBudget" value="300" min="50" max="20000" step="50" /></label>
              <label>Срок на решение, дней<input type="number" id="nDays" value="14" min="1" max="120" /></label>
              <label>Откликов на вакансию<input type="number" id="nApps" value="214" min="0" max="5000" /></label>
              <label>Проходной балл в shortlist<input type="number" id="nCut" value="65" min="30" max="95" /></label>
            </div>
            <label class="chkline"><input type="checkbox" id="nLocal" checked /> Данные должны оставаться в контуре Казахстана</label>
            <label class="chkline"><input type="checkbox" id="nInject" checked /> Включить проверку на смену ТЗ в середине сессии</label>
            <div class="vb-act">
              <button class="btn btn--primary btn--sm" type="button" id="nCreate">Запустить отбор</button>
              <span class="vb-hint">Кандидаты получат код приглашения сразу после создания</span>
            </div>
          </div>
          <div class="vb-out">
            <header class="vb-outhead">
              <span class="mono">предпросмотр кейса · собирается из требований</span>
              <span class="chip chip--on mono">${esc((S.catalog.rubric || {}).version || '')}</span>
            </header>
            <div class="vb-brief">
              <h4 id="nPTitle">—</h4>
              <p id="nPTask">—</p>
              <ul class="constraints" id="nPChips"></ul>
              <div class="inject on" id="nPInjBox">
                <strong>смена вводных в середине сессии</strong>
                <p id="nPInj">—</p>
              </div>
            </div>
            <ul class="vb-rows">
              <li><span>Ожидаемо завершат симуляцию</span><b class="tnum" id="nPDone">—</b></li>
              <li><span>Пройдут порог и попадут в shortlist</span><b class="tnum" id="nPShort">—</b></li>
              <li class="calc-hi"><span>Резюме, которые не нужно читать вручную</span><b class="tnum" id="nPSkip">—</b></li>
            </ul>
            <p class="vb-note">Прогноз воронки — модель по отраслевым данным: около 32% доходят до конца, распределение баллов нормальное со средним 58. Фактические цифры появятся в отборе после первых сессий.</p>
          </div>
        </div>
      </div>`;

    const preview = () => {
      const role = $('#nRole').value;
      const budget = +$('#nBudget').value || 300;
      const days = +$('#nDays').value || 10;
      const stack = $('#nStack').value.trim();
      const cut = +$('#nCut').value || 65;
      const apps = +$('#nApps').value || 0;
      const roleTitle = ((S.catalog.roles || []).filter((r) => r.key === role)[0] || {}).title || '';
      const TASKS = {
        ai: 'Спроектировать LLM-ассистента первой линии по базе документов с отказом от ответа и эскалацией на оператора: архитектура, контроль качества, стоимость.',
        be: 'Спроектировать бэкенд оформления заказа с внешним платёжным шлюзом: модель данных, контракты, поведение при сбоях, защита от двойного списания.',
        da: 'Найти причину падения повторных покупок: определения метрик, срезы, качество данных, отделение сезонности и вывод для продуктовой команды.',
        qa: 'Собрать стратегию проверки платёжного модуля в недельном релизном цикле: приоритеты по риску, автоматизация, критерии блокировки релиза.',
      };
      $('#nPTitle').textContent = $('#nTitle').value.trim() || roleTitle;
      $('#nPTask').textContent = TASKS[role] || '';
      const chips = [`бюджет $${budget}/мес`, `срок ${days} дней`, stack || 'стек по умолчанию'];
      chips.push(role === 'ai' ? 'без собственных GPU' : 'без новых внешних сервисов');
      if ($('#nLocal').checked) chips.push('данные не покидают РК');
      $('#nPChips').innerHTML = chips.map((c) => `<li>${esc(c)}</li>`).join('');
      const injBox = $('#nPInjBox');
      injBox.hidden = !$('#nInject').checked;
      $('#nPInj').textContent =
        'Бюджет урезан до $' + Math.max(40, Math.round(budget * 0.3)) + '/мес, добавлено требование по скорости ответа. Кандидат должен перестроить решение и назвать компромисс.';
      const done = Math.round(apps * 0.32);
      const short = Math.max(0, Math.round(done * (1 - Math.min(0.97, Math.max(0.03, (cut - 30) / 55)))));
      $('#nPDone').textContent = num(done);
      $('#nPShort').textContent = num(short);
      $('#nPSkip').textContent = num(Math.max(0, apps - short));
    };
    $$('#nTitle,#nRole,#nCity,#nStack,#nBudget,#nDays,#nApps,#nCut,#nLocal,#nInject').forEach((el) =>
      el.addEventListener('input', preview)
    );
    $('#nRole').addEventListener('change', () => {
      const r = (S.catalog.roles || []).filter((x) => x.key === $('#nRole').value)[0];
      if (r) {
        $('#nStack').value = r.stack;
        $('#nTitle').value = r.title + ' · продуктовая команда';
      }
      preview();
    });
    preview();

    $('#nCreate').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const out = await api('/api/vacancies', {
          method: 'POST',
          body: {
            title: $('#nTitle').value.trim(),
            role_key: $('#nRole').value,
            city: $('#nCity').value.trim(),
            stack: $('#nStack').value.trim(),
            budget: +$('#nBudget').value || 300,
            days: +$('#nDays').value || 10,
            threshold: +$('#nCut').value || 65,
            applicants: +$('#nApps').value || 0,
            inject_on: $('#nInject').checked,
            local_data: $('#nLocal').checked,
          },
        });
        toast('Отбор создан. Код для кандидатов: ' + out.vacancy.code);
        go('vacancy', { id: out.vacancy.id });
      } catch (err) {
        toast(err.message, 'bad');
        e.target.disabled = false;
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: HR — SHORTLIST ОДНОГО ОТБОРА
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.vacancy = async function (params) {
    const d = await api('/api/vacancies/' + params.id);
    const v = d.vacancy;
    const cands = d.candidates;
    const an = d.analytics || { criteria: [] };
    let sort = 'total';
    let hideFlagged = false;
    let statusFilter = 'all';
    let query = '';
    let selected = cands.length ? cands[0].attempt_id : null;

    viewEl.innerHTML = `
      <div class="app-wrap">
        <header class="page-head">
          <div>
            <p class="eyebrow">Отбор · ${esc(v.code)}</p>
            <h1>${esc(v.title)}</h1>
            <p class="lede">${esc(v.role_title)} · ${esc(v.city || '')} · порог shortlist ${v.threshold} · ${esc(v.stack || '')}</p>
          </div>
          <div class="page-head-act">
            <button class="btn btn--ghost" type="button" id="vExport">Выгрузить CSV</button>
            <button class="btn btn--ghost" type="button" id="vCopy">Код для кандидатов</button>
            <button class="btn btn--ghost" type="button" data-go="hr">Все отборы</button>
          </div>
        </header>

        ${kpi([
          [num(v.applicants), 'откликов на вакансию'],
          [num(v.stats.completed), 'завершили симуляцию'],
          [num(v.stats.shortlist), 'в shortlist с доказательствами'],
          [v.stats.hours_saved + ' ч', 'ручного скрининга снято'],
        ])}

        ${cands.length && an.criteria && an.criteria.length ? `<section class="vstat">
          <header class="vstat-head">
            <div>
              <h2>Где кандидаты проваливаются</h2>
              <p>Средний результат по каждому критерию рубрикатора среди ${an.count} завершённых симуляций. Расчёт детерминированный — те же баллы, что в строках ниже.</p>
            </div>
            <p class="vstat-avg"><b class="tnum">${an.avg_total}</b><span>средний балл · медиана ${an.median_total}</span></p>
          </header>
          <ul class="vstat-bars">
            ${an.criteria
              .map(
                (x) => `<li${an.weakest && an.weakest.key === x.key ? ' class="low"' : ''}>
                  <div class="row"><span>${esc(x.title)}</span><span class="tnum">${x.avg}%</span></div>
                  <div class="track"><i style="inline-size:${Math.max(2, Math.round(x.avg))}%"></i></div>
                  <small>${x.passed} из ${an.count} ${_pl(an.count, 'кандидата', 'кандидатов', 'кандидатов')} выше 60% · лучший результат ${x.best}%</small>
                </li>`
              )
              .join('')}
          </ul>
          <div class="vstat-foot">
            ${an.weakest ? `<p class="vstat-insight"><b>Слабое место отбора — ${esc(an.weakest.title.toLowerCase())}: ${an.weakest.avg}% в среднем.</b> Если это критично для вакансии, поднимите порог shortlist или сортируйте список по этому критерию.</p>` : ''}
            <ul class="vstat-chips">
              <li>выше порога ${an.threshold}: <b class="tnum">${an.above_threshold}</b></li>
              <li>Verified Skill Badge: <b class="tnum">${an.with_badge}</b></li>
              <li>с флагами достоверности: <b class="tnum">${an.flagged}</b></li>
              <li>с заметкой HR: <b class="tnum" id="vNotes">${an.notes}</b></li>
            </ul>
          </div>
        </section>` : ''}

        ${cands.length ? `<div class="hrd hrd--app">
          <div class="hrd-body">
            <div class="hrd-list">
              <div class="hrd-tools">
                <label class="fl" for="vSort">Сортировка</label>
                <select id="vSort">
                  <option value="total">по итоговому баллу</option>
                  <option value="adaptivity">по адаптивности к смене ТЗ</option>
                  <option value="defense">по защите решения</option>
                  <option value="constraints">по соблюдению ограничений</option>
                  <option value="tech">по технической корректности</option>
                </select>
                <input type="search" id="vQuery" class="inp inp--sm" placeholder="Поиск по имени или городу" aria-label="Поиск по имени или городу" />
                <button type="button" class="chip chip--btn" id="vFlag" aria-pressed="false">Скрыть кандидатов с флагами</button>
              </div>
              <div class="hrd-filters" id="vStatus" role="group" aria-label="Фильтр по статусу">
                ${[['all', 'все'], ['new', 'новые'], ['shortlist', 'в shortlist'], ['interview', 'интервью'], ['offer', 'оффер'], ['reject', 'отказ']]
                  .map(([k, label]) => {
                    const cnt = k === 'all' ? cands.length : cands.filter((c) => (c.hr_status || 'new') === k).length;
                    return `<button type="button" class="chip chip--btn ${k === 'all' ? 'on' : ''}" data-st="${k}"${cnt ? '' : ' disabled'}>${label} <i class="cnt tnum">${cnt}</i></button>`;
                  })
                  .join('')}
              </div>
              <p class="hrd-count" id="vCount"></p>
              <ul class="hrd-rows" id="vRows"></ul>
            </div>
            <aside class="hrd-panel" id="vPanel" aria-live="polite"></aside>
          </div>
        </div>` : '<div class="empty empty--card"><p>Пока никто не завершил симуляцию этого отбора. Отправьте кандидатам код ' + esc(v.code) + ' — результаты появятся здесь автоматически.</p><p class="side-note">Код можно скопировать кнопкой «Код для кандидатов» выше.</p></div>'}
      </div>`;

    const critLabel = (c, key) => {
      const f = (c.criteria || []).filter((x) => x.key === key)[0];
      return f ? f.score + '/' + f.max : '—';
    };

    const critVal = (c, key) => {
      const f = (c.criteria || []).filter((x) => x.key === key)[0];
      return f ? f.score / f.max : 0;
    };

    const initialsOf = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

    function rows() {
      if (!$('#vRows')) return;
      let list = cands.slice();
      if (hideFlagged) list = list.filter((c) => !(c.flags || []).length);
      if (statusFilter !== 'all') list = list.filter((c) => (c.hr_status || 'new') === statusFilter);
      if (query) {
        const q = query.toLowerCase();
        list = list.filter((c) => (c.name || '').toLowerCase().indexOf(q) > -1 || (c.city || '').toLowerCase().indexOf(q) > -1);
      }
      list.sort((a, b) => (sort === 'total' ? b.total - a.total : critVal(b, sort) - critVal(a, sort) || b.total - a.total));
      if ($('#vCount')) {
        $('#vCount').textContent =
          list.length === cands.length
            ? cands.length + ' ' + _pl(cands.length, 'кандидат', 'кандидата', 'кандидатов') + ' с завершённой симуляцией'
            : 'Показано ' + list.length + ' из ' + cands.length;
      }
      $('#vRows').innerHTML = list
        .map(
          (c, i) => `<li class="${c.attempt_id === selected ? 'on' : ''}" data-cand="${c.attempt_id}" tabindex="0">
            <span class="rank tnum">${i + 1}</span>
            <span class="ava" data-tone="${c.badge === 'verified' ? 'ok' : c.badge === 'partial' ? 'mid' : 'low'}" aria-hidden="true">${initialsOf(c.name)}</span>
            <span class="who"><b>${esc(c.name)}</b><small>${esc(c.city || '—')} · ${esc(HR_STATUS[c.hr_status] || c.hr_status)}</small></span>
            <span class="tags">
              ${c.in_shortlist ? '<i class="tag tag--on">shortlist</i>' : ''}
              ${(c.flags || []).length ? '<i class="tag tag--bad">флаги: ' + c.flags.length + '</i>' : ''}
              ${c.badge === 'verified' ? '<i class="tag">бейдж</i>' : ''}
              ${(c.hr_note || '').trim() ? '<i class="tag tag--note">заметка</i>' : ''}
            </span>
            <span class="sc-alt tnum">${sort === 'total' ? '' : critLabel(c, sort)}</span>
            <span class="sc tnum">${c.total}</span>
          </li>`
        )
        .join('');
      if (!list.length) {
        $('#vRows').innerHTML =
          '<li class="hrd-none">Под текущий фильтр не подходит ни один кандидат. Сбросьте поиск или выберите статус «все».</li>';
      }
      $$('#vRows li[data-cand]').forEach((li) => {
        const pick = () => {
          selected = +li.dataset.cand;
          rows();
          panel();
        };
        li.addEventListener('click', pick);
        li.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
            return;
          }
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const all = $$('#vRows li[data-cand]');
            const i = all.indexOf(li);
            const nx = all[e.key === 'ArrowDown' ? i + 1 : i - 1];
            if (nx) {
              selected = +nx.dataset.cand;
              rows();
              panel();
              const fresh = $('#vRows li[data-cand="' + selected + '"]');
              if (fresh) fresh.focus();
            }
          }
        });
      });
    }

    function panel() {
      const c = cands.filter((x) => x.attempt_id === selected)[0];
      const box = $('#vPanel');
      if (!box) return;
      if (!c) {
        box.innerHTML = '<div class="empty"><p>Выберите кандидата, чтобы увидеть доказательную базу оценки.</p></div>';
        return;
      }
      box.innerHTML = `
        <header class="hp-head">
          <div><b>${esc(c.name)}</b><small class="mono">${esc(c.email)}</small></div>
          <p class="hp-score tnum">${c.total}<sub>/100</sub></p>
        </header>
        ${badgeChip(c.badge)}
        <p class="hp-case mono">${esc(c.case_title)} · ${c.minutes} мин · ${c.finished_at ? new Date(c.finished_at).toLocaleDateString('ru-RU') : ''}</p>
        ${barsHtml(c.criteria || [], (c.telemetry && c.telemetry.penalty) || 0)}
        ${
          (c.flags || []).length
            ? `<div class="flags"><b>Флаги достоверности</b><ul>${c.flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`
            : '<div class="flags flags--ok"><b>Флагов нет</b><p>Вставок из буфера и аномалий ввода не зафиксировано.</p></div>'
        }
        <div class="hp-block">
          <h4>Заключение рубрикатора</h4>
          <p>${esc(c.verdict)}</p>
        </div>
        <div class="hp-block">
          <h4>Защита решения</h4>
          ${(c.questions || [])
            .map((q, i) => `<div class="q q--static"><p class="who">Вопрос ${i + 1}</p><p>${esc(q)}</p><p class="ans">${esc((c.defense || [])[i] || '— без ответа')}</p></div>`)
            .join('')}
        </div>
        <details class="hp-block">
          <summary>Решение кандидата целиком</summary>
          <pre class="answer-dump">${esc(c.answer)}</pre>
        </details>
        <div class="hp-block">
          <h4>Решение по кандидату</h4>
          <div class="hp-status">
            ${Object.keys(HR_STATUS)
              .map(
                (k) =>
                  `<button type="button" class="chip chip--btn ${c.hr_status === k ? 'on' : ''}" data-hr="${k}">${esc(HR_STATUS[k])}</button>`
              )
              .join('')}
          </div>
          <div class="hp-note">
            <label class="fl" for="vHrNote">Заметка для команды</label>
            <textarea id="vHrNote" class="inp" rows="3" maxlength="2000" placeholder="Например: сильная адаптивность, обсудить ожидания по зарплате на интервью">${esc(c.hr_note || '')}</textarea>
            <div class="hp-note-act">
              <button type="button" class="btn btn--ghost btn--sm" id="vHrNoteSave">Сохранить заметку</button>
              <span class="side-note" id="vHrNoteHint">Заметка попадает в выгрузку CSV рядом с кандидатом.</span>
            </div>
          </div>
          ${c.badge_pid ? `<button class="btn btn--ghost btn--sm" type="button" data-go="badge" data-params='${JSON.stringify({ pid: c.badge_pid })}' style="margin-block-start:var(--space-4)">Открыть публичный бейдж</button>` : ''}
        </div>`;

      const noteEl = $('#vHrNote', box);
      const saveNote = async () => {
        const val = noteEl.value.trim();
        if (val === (c.hr_note || '').trim()) {
          toast('Заметка без изменений.');
          return;
        }
        try {
          await api('/api/attempts/' + c.attempt_id + '/hr', { method: 'PATCH', body: { hr_note: val } });
          c.hr_note = val;
          if ($('#vNotes')) $('#vNotes').textContent = String(cands.filter((x) => (x.hr_note || '').trim()).length);
          toast(val ? 'Заметка сохранена.' : 'Заметка удалена.');
          rows();
        } catch (e) {
          toast(e.message, 'bad');
        }
      };
      if (noteEl) {
        $('#vHrNoteSave', box).addEventListener('click', saveNote);
        noteEl.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            saveNote();
          }
        });
      }

      $$('[data-hr]', box).forEach((b) =>
        b.addEventListener('click', async () => {
          try {
            await api('/api/attempts/' + c.attempt_id + '/hr', { method: 'PATCH', body: { hr_status: b.dataset.hr } });
            c.hr_status = b.dataset.hr;
            toast('Статус кандидата обновлён: ' + HR_STATUS[b.dataset.hr]);
            $$('#vStatus [data-st]').forEach((chip) => {
              const k = chip.dataset.st;
              const cnt = k === 'all' ? cands.length : cands.filter((x) => (x.hr_status || 'new') === k).length;
              const el = $('.cnt', chip);
              if (el) el.textContent = String(cnt);
              chip.disabled = !cnt && k !== statusFilter;
            });
            rows();
            panel();
          } catch (e) {
            toast(e.message, 'bad');
          }
        })
      );
    }

    if ($('#vQuery')) $('#vQuery').addEventListener('input', (e) => {
      query = e.target.value.trim();
      rows();
    });
    $$('#vStatus [data-st]').forEach((b) =>
      b.addEventListener('click', () => {
        statusFilter = b.dataset.st;
        $$('#vStatus [data-st]').forEach((x) => x.classList.toggle('on', x === b));
        rows();
      })
    );
    if ($('#vSort')) $('#vSort').addEventListener('change', (e) => {
      sort = e.target.value;
      rows();
    });
    if ($('#vFlag')) $('#vFlag').addEventListener('click', (e) => {
      hideFlagged = !hideFlagged;
      e.target.setAttribute('aria-pressed', String(hideFlagged));
      e.target.classList.toggle('on', hideFlagged);
      e.target.textContent = hideFlagged ? 'Показать всех кандидатов' : 'Скрыть кандидатов с флагами';
      rows();
    });
    $('#vExport').addEventListener('click', async () => {
      try {
        const h = { 'X-Visitor-Id': VISITOR };
        if (S.token) h.Authorization = 'Bearer ' + S.token;
        const res = await fetch(API + '/api/vacancies/' + v.id + '/export.csv', { headers: h });
        if (!res.ok) throw new Error('csv');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'shortlist-' + v.code + '.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        toast('CSV со shortlist выгружен.');
      } catch (e) {
        toast('Не удалось выгрузить CSV', 'bad');
      }
    });
    $('#vCopy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(v.code);
        toast('Код отбора скопирован: ' + v.code);
      } catch (e) {
        toast('Код отбора: ' + v.code);
      }
    });

    rows();
    panel();
  };

  /* ═══════════════════════════════════════════════════════════════════
     ВИД: ПРОФИЛЬ
     ═══════════════════════════════════════════════════════════════════ */
  VIEWS.profile = async function () {
    const me = await api('/api/me');
    S.user = me.user;
    const isCo = S.user.role === 'company';
    viewEl.innerHTML = `
      <div class="app-wrap app-wrap--narrow">
        <header class="page-head">
          <div>
            <p class="eyebrow">Профиль</p>
            <h1>Аккаунт и данные</h1>
            <p class="lede">Имя используется в карточке кандидата и в публичном бейдже${isCo ? ', название компании — в отборах и приглашениях' : ''}.</p>
          </div>
        </header>
        <article class="card">
          <div class="vb-fields">
            <label>Имя и фамилия<input type="text" id="pName" value="${esc(S.user.name)}" /></label>
            <label>${isCo ? 'Компания' : 'Вуз или место учёбы'}<input type="text" id="pOrg" value="${esc(S.user.org)}" /></label>
            <label>Город<input type="text" id="pCity" value="${esc(S.user.city)}" /></label>
            <label>Почта<input type="text" value="${esc(S.user.email)}" disabled /></label>
          </div>
          <div class="vb-act">
            <button class="btn btn--primary btn--sm" type="button" id="pSave">Сохранить</button>
            <span class="vb-hint">Роль аккаунта: ${esc(ROLE_LABEL[S.user.role])} · на платформе с ${new Date(S.user.created_at).toLocaleDateString('ru-RU')}</span>
          </div>
        </article>
        <article class="card">
          <h3>Правила честного прохождения</h3>
          <ul class="plist" style="margin-block-start:var(--space-4)">
            <li><b>Вставка из буфера заблокирована.</b> Каждая попытка фиксируется и снижает итоговый балл.</li>
            <li><b>Уходы из окна и длинные паузы считаются.</b> Они не запрещены, но попадают в карточку как флаги достоверности.</li>
            <li><b>Защита решения обязательна.</b> Без ответов на вопросы ИИ-интервьюера максимум по критерию Live Defense недостижим.</li>
          </ul>
        </article>
      </div>`;
    $('#pSave').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const out = await api('/api/me', {
          method: 'PATCH',
          body: { name: $('#pName').value.trim(), org: $('#pOrg').value.trim(), city: $('#pCity').value.trim() },
        });
        S.user = out.user;
        syncHeader();
        toast('Профиль сохранён.');
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        e.target.disabled = false;
      }
    });
  };

  /* ═══════════════════════════════════════════════════════════════════
     СТАРТ
     ═══════════════════════════════════════════════════════════════════ */
  const themeBtn = $('[data-theme-toggle-app]');
  themeBtn &&
    themeBtn.addEventListener('click', () => {
      const main = $('[data-theme-toggle]');
      main && main.click();
    });
  function syncThemeBtn() {
    const src = $('[data-theme-toggle]');
    if (src && themeBtn) themeBtn.innerHTML = src.innerHTML;
  }
  window.addEventListener('themechange', syncThemeBtn);
  syncThemeBtn();

  (async function boot() {
    try {
      const cat = await api('/api/catalog');
      S.catalog = cat;
      const vEl = $('#rubricVer');
      if (vEl) vEl.textContent = (cat.rubric || {}).version || '';
    } catch (e) {
      setOnline(false);
    }
    try {
      const out = await api('/api/me');
      if (out && out.user) {
        S.user = out.user;
        S.stats = out.stats;
        syncHeader();
      }
    } catch (e) {
      /* гость */
    }
    const hash = location.hash || '';
    const badge = hash.match(/#\/badge\/([\w-]+)/);
    if (badge) {
      appEl.hidden = false;
      document.body.classList.add('app-on');
      renderNav();
      go('badge', { pid: badge[1] });
      return;
    }
    window.addEventListener('hashchange', () => {
      const b = (location.hash || '').match(/#\/badge\/([\w-]+)/);
      if (!b) return;
      appEl.hidden = false;
      document.body.classList.add('app-on');
      renderNav();
      go('badge', { pid: b[1] });
    });
    const code = hash.match(/#code=([\w-]+)/i);
    if (code && S.user && S.user.role === 'candidate') {
      openApp('run');
      setTimeout(() => {
        const f = $('#runCode');
        if (f) f.value = code[1].toUpperCase();
      }, 500);
    }
  })();

  window.SAGAT = { state: S, api: api, openApp: openApp, toast: toast };
})();

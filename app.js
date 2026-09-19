/* ================= reveal on scroll ================= */
(function () {
  const root = document.documentElement;
  const els = document.querySelectorAll('.rv');
  if (!els.length) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;
  root.classList.add('js');
  const show = (el) => el.classList.add('is-in');
  const io = new IntersectionObserver(
    (ents) => ents.forEach((e) => { if (e.isIntersecting) { show(e.target); io.unobserve(e.target); } }),
    { rootMargin: '0px 0px -6% 0px', threshold: 0.01 }
  );
  els.forEach((el) => io.observe(el));
  // safety net: nothing stays invisible
  setTimeout(() => els.forEach(show), 2600);
})();

/* ================= theme ================= */
(function () {
  const btn = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;
  const SUN =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';
  const MOON =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  let mode = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const apply = () => {
    root.setAttribute('data-theme', mode);
    if (!btn) return;
    btn.innerHTML = mode === 'dark' ? SUN : MOON;
    btn.setAttribute('aria-label', mode === 'dark' ? 'Переключить на светлую тему' : 'Переключить на тёмную тему');
    window.dispatchEvent(new CustomEvent('themechange'));
  };
  apply();
  btn && btn.addEventListener('click', () => { mode = mode === 'dark' ? 'light' : 'dark'; apply(); });
})();

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ================= count-up stats ================= */
(function () {
  const els = document.querySelectorAll('[data-count]');
  if (!els.length) return;
  const fmt = (n) => n.toLocaleString('ru-RU');
  const run = (el) => {
    const target = parseFloat(el.dataset.count);
    const dur = 900;
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(target * e));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const io = new IntersectionObserver(
    (entries) => entries.forEach((en) => { if (en.isIntersecting) { run(en.target); io.unobserve(en.target); } }),
    { threshold: 0.4 }
  );
  els.forEach((el) => { el.textContent = '0'; io.observe(el); });
})();

/* ================= market chart ================= */
(function () {
  const cv = document.getElementById('mktChart');
  if (!cv || !window.Chart) return;
  const years = [];
  const vals = [];
  for (let i = 0; i <= 9; i++) {
    years.push(String(2025 + i));
    vals.push(i === 9 ? 57.1 : Math.round(25.4 * Math.pow(1.094, i) * 10) / 10);
  }
  const chart = new Chart(cv, {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{ data: vals, borderRadius: 3, borderSkipped: false, maxBarThickness: 46 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.parsed.y.toLocaleString('ru-RU') + ' млрд $' } },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { beginAtZero: true, border: { display: false }, ticks: { maxTicksLimit: 5 } },
      },
      animation: { duration: 700, easing: 'easeOutCubic' },
    },
  });
  const theme = () => {
    const accent = cssVar('--color-primary');
    const muted = cssVar('--color-text-muted');
    const grid = cssVar('--color-border');
    const hex = accent.replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    const dim = `rgba(${r},${g},${b},0.42)`;
    chart.data.datasets[0].backgroundColor = vals.map((_, i) => (i === 0 || i === 9 ? accent : dim));
    chart.options.scales.x.ticks = { color: muted, font: { family: 'JetBrains Mono, monospace', size: 11 } };
    chart.options.scales.y.ticks = Object.assign({ maxTicksLimit: 5, color: muted, font: { family: 'JetBrains Mono, monospace', size: 11 } });
    chart.options.scales.y.grid = { color: grid };
    chart.update('none');
  };
  theme();
  window.addEventListener('themechange', theme);
})();

/* ================= HR shortlist dashboard (demo data) ================= */
(function () {
  const rowsEl = document.getElementById('hrRows');
  const panel = document.getElementById('hrPanel');
  if (!rowsEl || !panel) return;

  const C = [
    {
      id: 'K-1042', name: 'Айдана Сериккали', role: 'Junior AI Engineer', city: 'Алматы', min: 54,
      s: { logic: 23, tech: 22, constr: 18, adapt: 13, defense: 14 }, pen: 0,
      flags: [], badge: 'ok',
      quote: 'Гибридный retrieval: pgvector + BM25, реранк только для top-20. При урезании бюджета убираю реранк и поднимаю порог отказа — качество падает предсказуемо, латентность держится под 2 с.',
      qa: [
        ['Почему не дообучали модель?', 'Дороже и медленнее в итерациях; при 12 000 документов выигрыш даёт retrieval, а не веса.'],
        ['Что сломается при росте потока в 3 раза?', 'Первым упадёт p95 на реранке — поэтому он вынесен в отдельный сервис и отключается флагом.'],
      ],
      next: 'Сильный кандидат: явно назвал компромисс до того, как его спросили.',
    },
    {
      id: 'K-0987', name: 'Тимур Жақсылық', role: 'Junior AI Engineer', city: 'Астана', min: 58,
      s: { logic: 21, tech: 20, constr: 17, adapt: 12, defense: 12 }, pen: 0,
      flags: [], badge: 'ok',
      quote: 'RAG на pgvector, кэш ответов по нормализованному вопросу, эскалация на оператора при низкой уверенности. После смены ТЗ отказался от реранка и сократил контекст до 4 чанков.',
      qa: [
        ['Как считаете уверенность?', 'Порог по сходству top-1 плюс проверка, что ответ опирается на найденный фрагмент.'],
        ['Почему 4 чанка?', 'Это укладывается в бюджет токенов после урезания расходов; на выборке ответы не деградировали.'],
      ],
      next: 'Решение аккуратное, но без оценки нагрузки в цифрах.',
    },
    {
      id: 'K-1120', name: 'Мадина Ержан', role: 'Junior AI Engineer', city: 'Алматы', min: 60,
      s: { logic: 19, tech: 18, constr: 16, adapt: 11, defense: 11 }, pen: 2,
      flags: ['1 потеря фокуса'], badge: 'ok',
      quote: 'Векторный поиск, фильтр по категории документа, fallback на оператора. Уложился в $80, отказавшись от внешнего реранкера в пользу простого скоринга.',
      qa: [
        ['Почему фильтр по категории?', 'Сокращает выборку и убирает ответы не по теме — дешевле, чем реранк.'],
        ['Где узкое место?', 'Эмбеддинг запроса при пиках; спасает кэш популярных вопросов.'],
      ],
      next: 'Уверенная база, слабее аргументация выбора компонентов.',
    },
    {
      id: 'K-0915', name: 'Нұрсұлтан Абдуали', role: 'Junior AI Engineer', city: 'Шымкент', min: 47,
      s: { logic: 18, tech: 17, constr: 12, adapt: 9, defense: 10 }, pen: 0,
      flags: [], badge: 'partial',
      quote: 'Ассистент на векторном поиске с эскалацией. Стоимость подробно не считал, ориентировался на архитектуру.',
      qa: [
        ['Как уложитесь в $80 в месяц?', 'Точно не считал, планировал взять более дешёвую модель.'],
        ['Что даёт кэш?', 'Снижает число вызовов модели на повторяющихся вопросах.'],
      ],
      next: 'Техническая часть есть, ограничения учтены частично.',
    },
    {
      id: 'K-1188', name: 'Ерасыл Төлеген', role: 'Junior AI Engineer', city: 'Алматы', min: 39,
      s: { logic: 16, tech: 19, constr: 14, adapt: 5, defense: 6 }, pen: 7,
      flags: ['3 попытки вставки', '2 потери фокуса'], badge: 'partial',
      quote: 'Подробная архитектура с реранком и мониторингом, но после смены ТЗ решение почти не изменилось.',
      qa: [
        ['Что меняете при бюджете $80?', 'Оставлю как есть, попробую договориться о бюджете.'],
        ['Почему выбран реранк?', 'Он улучшает качество выдачи.'],
      ],
      next: 'Текст сильнее защиты: расхождение между решением и ответами.',
    },
    {
      id: 'K-1203', name: 'Камила Сағындық', role: 'Junior AI Engineer', city: 'Караганда', min: 44,
      s: { logic: 14, tech: 13, constr: 11, adapt: 8, defense: 8 }, pen: 0,
      flags: [], badge: 'partial',
      quote: 'Поиск по документам и генерация ответа, ручные правила для частых сценариев. Ограничения учтены на уровне выбора модели.',
      qa: [
        ['Как отказываетесь от ответа?', 'По порогу сходства, если ничего не нашлось.'],
        ['Что с латентностью?', 'Думаю, около секунды, замеров не делал.'],
      ],
      next: 'Базовый уровень, нужна доработка по нагрузке и стоимости.',
    },
    {
      id: 'K-1075', name: 'Арман Кенжебек', role: 'Junior AI Engineer', city: 'Алматы', min: 22,
      s: { logic: 11, tech: 12, constr: 8, adapt: 4, defense: 3 }, pen: 12,
      flags: ['6 попыток вставки', '4 потери фокуса', 'ровный ритм печати'], badge: 'no',
      quote: 'Развёрнутый шаблонный ответ без привязки к ограничениям задачи.',
      qa: [
        ['Почему именно эта база данных?', 'Она популярна для таких задач.'],
        ['Как решение меняется при новом ТЗ?', 'Не успел разобрать.'],
      ],
      next: 'Телеметрия и защита не подтверждают авторство решения.',
    },
    {
      id: 'K-1131', name: 'Диас Мұқашев', role: 'Junior AI Engineer', city: 'Астана', min: 31,
      s: { logic: 10, tech: 9, constr: 7, adapt: 5, defense: 5 }, pen: 4,
      flags: ['2 попытки вставки'], badge: 'no',
      quote: 'Общее описание чат-бота без архитектурных решений и без реакции на смену ТЗ.',
      qa: [
        ['Как устроен поиск по документам?', 'Через поиск по ключевым словам.'],
        ['Что с бюджетом?', 'Не рассчитывал.'],
      ],
      next: 'Рекомендация кандидату: разбор ошибок и повторная попытка.',
    },
  ];

  const MAX = { logic: 25, tech: 25, constr: 20, adapt: 15, defense: 15 };
  const LBL = {
    logic: 'Логика решения',
    tech: 'Техническая корректность',
    constr: 'Соблюдение ограничений',
    adapt: 'Адаптивность к смене ТЗ',
    defense: 'Защита решения',
  };
  const BADGE = {
    ok: ['tag--ok', 'бейдж выдан'],
    partial: ['tag--warn', 'бейдж частично'],
    no: ['tag--bad', 'бейдж не выдан'],
  };
  C.forEach((c) => {
    c.total = Math.max(0, Object.keys(MAX).reduce((n, k) => n + c.s[k], 0) - c.pen);
  });

  const sortSel = document.getElementById('hrSort');
  const filterBtn = document.getElementById('hrFilter');
  let sortKey = 'total';
  let hideFlagged = false;
  let active = C[0].id;
  const decided = {};

  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  function visible() {
    let list = C.filter((c) => (hideFlagged ? c.flags.length === 0 : true));
    list.sort((a, b) => (sortKey === 'total' ? b.total - a.total : b.s[sortKey] - a.s[sortKey]));
    return list;
  }

  const TONE = { ok: 'ok', partial: 'mid', no: 'low' };
  const initials = (n) => n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function renderRows() {
    const list = visible();
    rowsEl.innerHTML = list
      .map((c) => {
        const [cls, txt] = BADGE[c.badge];
        const mini = Object.keys(MAX)
          .map((k) => `<i style="inline-size:${Math.max(6, Math.round((c.s[k] / MAX[k]) * 34))}px${c.s[k] / MAX[k] < 0.45 ? ';background:var(--color-signal)' : ''}"></i>`)
          .join('');
        const flag = c.flags.length
          ? `<span class="tag tag--warn">${c.flags.length} флаг${c.flags.length > 1 ? 'а' : ''}</span>`
          : '<span class="tag tag--ok">без флагов</span>';
        const st = decided[c.id] ? `<span class="tag ${decided[c.id] === 'in' ? 'tag--ok' : 'tag--bad'}">${decided[c.id] === 'in' ? 'в интервью' : 'фидбек отправлен'}</span>` : '';
        return (
          `<li><button type="button" class="hrd-row" data-id="${c.id}" aria-current="${c.id === active}">` +
          `<span class="sc tnum">${c.total}<small>из 100</small></span>` +
          `<span class="idn"><span class="ava" data-tone="${TONE[c.badge]}" aria-hidden="true">${initials(c.name)}</span><span class="idn-t">` +
          `<span class="who">${esc(c.name)}<i class="ccode">${c.id}</i></span>` +
          `<span class="meta">${esc(c.city)} · ${esc(c.role)} · сессия ${c.min} мин · защита ${c.s.defense}/15</span>` +
          `<span class="mini">${mini}</span></span></span>` +
          `<span class="tags"><span class="tag ${cls}">${txt}</span>${flag}${st}</span>` +
          `</button></li>`
        );
      })
      .join('');
    if (!list.some((c) => c.id === active) && list.length) { active = list[0].id; renderPanel(); }
    if (!list.length) rowsEl.innerHTML = '<li class="hrd-note" style="border:0;padding:0">Ни один кандидат не проходит текущий фильтр.</li>';
  }

  function renderPanel() {
    const c = C.find((x) => x.id === active);
    if (!c) { panel.innerHTML = '<p class="empty">Выберите кандидата в списке.</p>'; return; }
    const [cls, txt] = BADGE[c.badge];
    const bars = Object.keys(MAX)
      .map(
        (k) =>
          `<li><div class="row"><span>${LBL[k]}</span><span class="tnum">${c.s[k]} / ${MAX[k]}</span></div>` +
          `<div class="track"><i style="inline-size:${Math.round((c.s[k] / MAX[k]) * 100)}%${c.s[k] / MAX[k] < 0.45 ? ';background:var(--color-signal)' : ''}"></i></div></li>`
      )
      .join('');
    const pen = c.pen
      ? `<li><div class="row"><span>Штраф за телеметрию</span><span class="tnum">−${c.pen} · макс. −12</span></div>` +
        `<div class="track"><i style="inline-size:${Math.round((c.pen / 12) * 100)}%;background:var(--color-danger)"></i></div></li>`
      : '';
    panel.innerHTML =
      `<p class="eyebrow" style="color:var(--color-primary)">Доказательная база</p>` +
      `<div class="phead"><span class="ava ava--lg" data-tone="${TONE[c.badge]}" aria-hidden="true">${initials(c.name)}</span>` +
      `<span><h4>${esc(c.name)}</h4><p class="pmeta">${c.id} · ${esc(c.city)}</p></span></div>` +
      `<div class="pscore"><b class="tnum">${c.total}</b><span>из 100 · <span class="tag ${cls}">${txt}</span></span></div>` +
      `<ul class="plist">${bars}${pen}</ul>` +
      `<blockquote>${esc(c.quote)}</blockquote>` +
      `<p class="eyebrow" style="color:var(--color-primary);margin-block-start:var(--space-5)">Live Defense</p>` +
      `<ul class="qa">${c.qa.map(([q, a]) => `<li><b>${esc(q)}</b><span>${esc(a)}</span></li>`).join('')}</ul>` +
      `<p style="font-size:var(--text-xs);color:var(--color-text-muted);margin-block-start:var(--space-4)">Телеметрия: ${c.flags.length ? esc(c.flags.join(', ')) : 'аномалий не зафиксировано'}.</p>` +
      `<p style="font-size:var(--text-sm);margin-block-start:var(--space-3)">${esc(c.next)}</p>` +
      `<div class="pact"><button type="button" class="btn btn--primary btn--sm" data-act="in">В интервью</button>` +
      `<button type="button" class="btn btn--ghost btn--sm" data-act="out">Отказ с фидбеком</button></div>`;
  }

  rowsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.hrd-row');
    if (!b) return;
    active = b.dataset.id;
    renderRows();
    renderPanel();
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    decided[active] = b.dataset.act;
    renderRows();
  });
  sortSel && sortSel.addEventListener('change', () => { sortKey = sortSel.value; renderRows(); });
  filterBtn &&
    filterBtn.addEventListener('click', () => {
      hideFlagged = !hideFlagged;
      filterBtn.setAttribute('aria-pressed', String(hideFlagged));
      filterBtn.textContent = hideFlagged ? 'Показать всех кандидатов' : 'Скрыть кандидатов с флагами';
      renderRows();
    });

  renderRows();
  renderPanel();
})();

/* ================= screening economics calculator ================= */
(function () {
  const ids = ['cVac', 'cCv', 'cMin', 'cRate'];
  const f = ids.map((i) => document.getElementById(i));
  if (f.some((el) => !el)) return;
  const out = {
    now: document.getElementById('oNow'),
    nw: document.getElementById('oNew'),
    save: document.getElementById('oSave'),
    note: document.getElementById('oNote'),
  };
  const num = (n) => n.toLocaleString('ru-RU');
  const SHORTLIST = 12;

  function calc() {
    const [vac, cv, min, rate] = f.map((el) => Math.max(0, parseFloat(el.value) || 0));
    const hNow = (vac * cv * min) / 60;
    const hNew = (vac * Math.min(SHORTLIST, cv) * min) / 60;
    const money = (hNow - hNew) * rate;
    out.now.textContent = `${num(Math.round(hNow))} ч · $${num(Math.round(hNow * rate))}`;
    out.nw.textContent = `${num(Math.round(hNew))} ч · $${num(Math.round(hNew * rate))}`;
    out.save.textContent = `${num(Math.round(hNow - hNew))} ч · $${num(Math.round(money))}`;
    out.note.textContent =
      `Допущение: рекрутёр просматривает ${SHORTLIST} кандидатов shortlist вместо ${num(Math.round(cv))} резюме на вакансию, ` +
      `время на одного остаётся тем же. Освобождённые часы — это и есть то, за что платит компания.`;
  }
  f.forEach((el) => el.addEventListener('input', calc));
  calc();
})();

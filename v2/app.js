/* MediaDock — UX mock (no backend)
 * - Tabs: Buscar / Colar link
 * - Results: mock items
 * - AdBlock detection: best-effort client-side + manual toggle
 * - Rewarded ad: countdown simulation -> unlock download
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  adblockDetected: false,
  manualAdblock: null, // if user toggles
  unlocked: new Set(), // itemId+format unlocked
  lastAction: null, // { item, format }
};

const MOCK_ITEMS = [
  { id: "m1", title: "Lo-fi Study Mix (Creative Commons)", source: "Exemplo", duration: "58:12" },
  { id: "m2", title: "Podcast: produtividade sem estresse", source: "Exemplo", duration: "32:04" },
  { id: "m3", title: "Aula curta: fundamentos de edição", source: "Exemplo", duration: "12:48" },
];

function safeText(s) {
  return (s ?? "").toString();
}

function iconSvg(type) {
  if (type === "shield") {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M9.5 12l1.7 1.7L14.8 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }
  if (type === "play") {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M10 8l8 4-8 4V8z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <path d="M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z" stroke="currentColor" stroke-width="1.6"/>
    </svg>`;
  }
  if (type === "star") {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M12 2l3 7h7l-5.5 4.2L18 21l-6-4-6 4 1.5-7.8L2 9h7l3-7z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;
  }
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
    <path d="M12 17h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    <path d="M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

// Best-effort adblock detection (client side). Not bulletproof.
async function detectAdblock() {
  // If user manually toggled, respect it.
  if (state.manualAdblock !== null) return state.manualAdblock;

  // Heuristic: attempt to load a "bait" element and check if hidden
  const bait = document.createElement("div");
  bait.className = "ad adsbox ad-banner adunit ad-placement pub_300x250";
  bait.style.cssText = "position:absolute;left:-10000px;top:-10000px;width:1px;height:1px;";
  document.body.appendChild(bait);

  await new Promise(r => setTimeout(r, 60));

  const blocked =
    bait.offsetParent === null ||
    bait.offsetHeight === 0 ||
    bait.offsetWidth === 0 ||
    getComputedStyle(bait).display === "none" ||
    getComputedStyle(bait).visibility === "hidden";

  bait.remove();
  return blocked;
}

function setAdblockUI(isBlocked) {
  state.adblockDetected = isBlocked;
  const badge = $("#adblockBadge");
  if (!badge) return;

  if (isBlocked) {
    badge.className = "inline-flex items-center gap-2 rounded-full bg-rose-500/15 px-3 py-1 text-xs text-rose-200 ring-1 ring-rose-400/20";
    badge.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-rose-400"></span>AdBlock detectado`;
  } else {
    badge.className = "inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-200 ring-1 ring-emerald-400/20";
    badge.innerHTML = `<span class="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>Ads OK`;
  }
}

function tabInit() {
  const btns = $$(".tab-btn");
  const panels = $$(".tab-panel");

  function activate(tab) {
    btns.forEach(b => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("bg-white/10", active);
      b.classList.toggle("text-slate-200", active);
      b.classList.toggle("text-slate-300", !active);
    });
    panels.forEach(p => {
      p.classList.toggle("hidden", p.dataset.panel !== tab);
    });
  }

  btns.forEach(b => b.addEventListener("click", () => activate(b.dataset.tab)));
  activate("search");
}

function renderResults(items) {
  const wrap = $("#results");
  wrap.innerHTML = "";

  items.forEach(item => {
    wrap.appendChild(renderCard(item));
  });
}

function formatKey(itemId, fmt) {
  return `${itemId}:${fmt}`;
}

function isUnlocked(itemId, fmt) {
  return state.unlocked.has(formatKey(itemId, fmt));
}

function setUnlocked(itemId, fmt, v=true) {
  const key = formatKey(itemId, fmt);
  if (v) state.unlocked.add(key);
  else state.unlocked.delete(key);
  updateCardButtons(itemId);
}

function updateCardButtons(itemId) {
  const card = document.querySelector(`[data-card-id="${itemId}"]`);
  if (!card) return;

  const btnMp4 = card.querySelector(`[data-action="mp4"]`);
  const btnMp3 = card.querySelector(`[data-action="mp3"]`);

  const setBtn = (btn, fmt) => {
    const unlocked = isUnlocked(itemId, fmt);
    btn.dataset.unlocked = unlocked ? "1" : "0";
    btn.textContent = unlocked ? `Baixar ${fmt.toUpperCase()}` : `Assistir → liberar ${fmt.toUpperCase()}`;
  };

  if (btnMp4) setBtn(btnMp4, "mp4");
  if (btnMp3) setBtn(btnMp3, "mp3");
}

function renderCard(item) {
  const el = document.createElement("div");
  el.className = "rounded-2xl bg-slate-900/30 p-4 ring-1 ring-white/10 hover:bg-slate-900/40 transition";
  el.dataset.cardId = item.id;

  el.innerHTML = `
    <div class="flex items-start gap-4">
      <div class="h-14 w-24 shrink-0 rounded-xl bg-white/5 ring-1 ring-white/10 flex items-center justify-center">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" class="text-slate-300">
          <path d="M4 7h16v10H4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M10 11l4 2-4 2v-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        </svg>
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold text-slate-100">${safeText(item.title)}</div>
            <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span class="rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10">${safeText(item.source)}</span>
              <span class="rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10">${safeText(item.duration)}</span>
              <span class="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-200 ring-1 ring-emerald-400/15">Autorizado (mock)</span>
            </div>
          </div>
          <button class="rounded-xl bg-white/5 px-3 py-2 text-xs text-slate-200 ring-1 ring-white/10 hover:bg-white/10" data-more="1">
            Detalhes
          </button>
        </div>

        <div class="mt-4 flex flex-wrap gap-2">
          <button class="rounded-xl bg-indigo-500/25 px-4 py-2.5 text-sm font-semibold text-indigo-100 ring-1 ring-indigo-400/30 hover:bg-indigo-500/35"
                  data-action="mp4" aria-label="Baixar vídeo">
            Assistir → liberar MP4
          </button>
          <button class="rounded-xl bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/10"
                  data-action="mp3" aria-label="Baixar áudio">
            Assistir → liberar MP3
          </button>
        </div>
      </div>
    </div>
  `;

  // Bind actions
  el.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;

    if (btn.dataset.more === "1") {
      openDetails(item);
      return;
    }

    const fmt = btn.dataset.action;
    if (!fmt) return;

    const blocked = await detectAdblock();
    setAdblockUI(blocked);

    if (blocked) {
      openAdblockModal();
      return;
    }

    // If already unlocked, proceed to "download"
    if (isUnlocked(item.id, fmt)) {
      triggerDownload(item, fmt);
      return;
    }

    // Otherwise open rewarded ad modal
    state.lastAction = { item, fmt };
    openRewardedAdModal(item, fmt);
  });

  // Initialize button state
  updateCardButtons(item.id);

  return el;
}

function setModal({ title, subtitle, icon, bodyHtml, footerButtons }) {
  const backdrop = $("#modalBackdrop");
  const modalIcon = $("#modalIcon");
  const modalTitle = $("#modalTitle");
  const modalSubtitle = $("#modalSubtitle");
  const modalBody = $("#modalBody");
  const modalFooter = $("#modalFooter");

  modalIcon.className = "inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/5 ring-1 ring-white/10 text-slate-200";
  modalIcon.innerHTML = iconSvg(icon);

  modalTitle.textContent = title;
  modalSubtitle.textContent = subtitle ?? "";
  modalBody.innerHTML = bodyHtml ?? "";

  modalFooter.innerHTML = "";
  (footerButtons ?? []).forEach(btn => {
    const b = document.createElement("button");
    b.className = btn.className;
    b.textContent = btn.label;
    b.addEventListener("click", btn.onClick);
    modalFooter.appendChild(b);
  });

  backdrop.classList.remove("hidden");
  backdrop.classList.add("flex");
}

function closeModal() {
  const backdrop = $("#modalBackdrop");
  backdrop.classList.add("hidden");
  backdrop.classList.remove("flex");
  $("#modalBody").innerHTML = "";
  $("#modalFooter").innerHTML = "";
}

function openHowItWorks() {
  setModal({
    title: "Como funciona (mock)",
    subtitle: "Fluxo de teste de UX sem backend",
    icon: "info",
    bodyHtml: `
      <div class="space-y-3 text-sm">
        <p>1) Você busca ou cola um link. Nós geramos resultados simulados.</p>
        <p>2) Ao clicar em <strong>MP4/MP3</strong>, o site verifica AdBlock (best-effort).</p>
        <p>3) Se estiver tudo ok, abrimos um <strong>anúncio recompensado</strong> (simulado) com contagem.</p>
        <p>4) Após o tempo, liberamos o botão de download (download de um arquivo placeholder).</p>
        <p class="text-slate-400 text-xs">Na integração real, a validação do anúncio vem do provedor + backend.</p>
      </div>
    `,
    footerButtons: [
      {
        label: "Entendi",
        className: "rounded-2xl bg-indigo-500/25 px-5 py-2.5 text-sm font-semibold text-indigo-100 ring-1 ring-indigo-400/30 hover:bg-indigo-500/35",
        onClick: closeModal
      }
    ]
  });
}

function openDetails(item) {
  setModal({
    title: "Detalhes do item",
    subtitle: "Metadados (mock)",
    icon: "info",
    bodyHtml: `
      <div class="space-y-3">
        <div class="space-y-3">
        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-slate-100">1 dia</div>
              <div class="text-xs text-slate-400">Acesso premium por 24h</div>
            </div>
            <div class="text-sm font-semibold text-indigo-100">R$ 2,99</div>
          </div>
        </div>
        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-slate-100">1 semana</div>
              <div class="text-xs text-slate-400">Sem anúncios por 7 dias</div>
            </div>
            <div class="text-sm font-semibold text-indigo-100">R$ 6,99</div>
          </div>
        </div>
        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-slate-100">1 mês</div>
              <div class="text-xs text-slate-400">Sem anúncios por 30 dias</div>
            </div>
            <div class="text-sm font-semibold text-indigo-100">R$ 13,99</div>
          </div>
        </div>
        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <div class="flex items-center justify-between gap-4">
            <div>
              <div class="text-sm font-semibold text-slate-100">1 ano</div>
              <div class="text-xs text-slate-400">Melhor custo-benefício</div>
            </div>
            <div class="text-sm font-semibold text-indigo-100">R$ 49,99</div>
          </div>
        </div>
      </div>

        <p class="text-xs text-slate-400">
          Depois: vinculamos a assinatura a uma conta opcional (email/Google) e salvamos no backend.
        </p>
      </div>
    `,
    footerButtons: [
      {
        label: "Fechar",
        className: "rounded-2xl bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/10",
        onClick: closeModal
      },
      {
        label: "Simular assinatura",
        className: "rounded-2xl bg-indigo-500/25 px-5 py-2.5 text-sm font-semibold text-indigo-100 ring-1 ring-indigo-400/30 hover:bg-indigo-500/35",
        onClick: () => {
          closeModal();
          toast("Assinatura simulada! (no backend isso vira um pagamento real)");
        }
      }
    ]
  });
}

function openLoginModal() {
  setModal({
    title: "Entrar (mock)",
    subtitle: "Conta opcional — só para Premium/histórico",
    icon: "info",
    bodyHtml: `
      <div class="space-y-3">
        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <label class="block text-xs text-slate-400">Email</label>
          <input type="email" placeholder="voce@exemplo.com" class="mt-2 w-full rounded-2xl bg-slate-900/40 px-4 py-3 text-sm text-slate-100 ring-1 ring-white/10 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-400/50" />
          <button class="mt-3 w-full rounded-2xl bg-indigo-500/25 px-4 py-3 text-sm font-semibold text-indigo-100 ring-1 ring-indigo-400/30 hover:bg-indigo-500/35">Continuar</button>
        </div>
        <button class="w-full rounded-2xl bg-white/5 px-4 py-3 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/10">
          Continuar com Google (mock)
        </button>
        <p class="text-xs text-slate-400">Na fase 2: autenticação real + vinculação da assinatura.</p>
      </div>
    `,
    footerButtons: [
      {
        label: "Fechar",
        className: "rounded-2xl bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/10",
        onClick: closeModal
      }
    ]
  });
}

function openRewardedAdModal(item, fmt) {
  // 2 anúncios seguidos para liberar (versão gratuita)
  const steps = [
    { label: "Anúncio 1/2", seconds: 6 },
    { label: "Anúncio 2/2", seconds: 6 },
  ];

  let stepIndex = 0;
  let remaining = steps[0].seconds;
  let timer = null;

  const renderBody = () => {
    const step = steps[stepIndex];
    const total = step.seconds;
    const pct = Math.round((1 - (remaining / total)) * 100);

    return `
      <div class="space-y-4">
        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <div class="text-xs text-slate-400">Você vai liberar</div>
          <div class="mt-1 text-sm font-semibold text-slate-100">${fmt.toUpperCase()} — ${safeText(item.title)}</div>
        </div>

        <div class="rounded-2xl bg-slate-900/40 p-4 ring-1 ring-white/10">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-2 text-sm font-semibold text-slate-100">
              ${iconSvg("play")}
              Anúncio recompensado (simulado)
            </div>
            <div class="flex items-center gap-2">
              <span class="rounded-full bg-white/5 px-3 py-1 text-xs text-slate-200 ring-1 ring-white/10">${step.label}</span>
              <span id="adCountdown" class="rounded-full bg-indigo-500/20 px-3 py-1 text-xs text-indigo-100 ring-1 ring-indigo-400/20">
                ${remaining}s
              </span>
            </div>
          </div>

          <div class="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/5 ring-1 ring-white/10">
            <div id="adBar" class="h-full rounded-full bg-indigo-400/60" style="width:${pct}%"></div>
          </div>

          <p class="mt-3 text-xs text-slate-400">
            No produto real, esse player vem do provedor de ads e a liberação é validada no backend.
          </p>
        </div>

        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10">
          <div class="text-xs text-slate-400">Por que 2 anúncios?</div>
          <div class="mt-1 text-sm text-slate-200">
            Para manter a versão gratuita sustentável sem virar um festival de banners.
          </div>
        </div>
      </div>
    `;
  };

  const btnNext = {
    label: "Aguarde…",
    className: "rounded-2xl bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-400 ring-1 ring-white/10 cursor-not-allowed",
    onClick: () => {}
  };

  const btnCancel = {
    label: "Cancelar",
    className: "rounded-2xl bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/10",
    onClick: () => {
      if (timer) clearInterval(timer);
      closeModal();
    }
  };

  setModal({
    title: "Liberar download",
    subtitle: "Assista 2 anúncios para desbloquear",
    icon: "play",
    bodyHtml: renderBody(),
    footerButtons: [btnCancel, btnNext]
  });

  const footer = $("#modalFooter");
  const nextBtnEl = footer.querySelectorAll("button")[1];

  function refreshUI() {
    $("#modalBody").innerHTML = renderBody();
  }

  function armButtonForNextStep() {
    if (stepIndex < steps.length - 1) {
      nextBtnEl.textContent = "Ir para anúncio 2/2";
      nextBtnEl.className = "rounded-2xl bg-indigo-500/25 px-5 py-2.5 text-sm font-semibold text-indigo-100 ring-1 ring-indigo-400/30 hover:bg-indigo-500/35";
      nextBtnEl.onclick = () => {
        stepIndex += 1;
        remaining = steps[stepIndex].seconds;
        nextBtnEl.textContent = "Aguarde…";
        nextBtnEl.className = "rounded-2xl bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-400 ring-1 ring-white/10 cursor-not-allowed";
        nextBtnEl.onclick = () => {};
        refreshUI();
        startTimer();
      };
    } else {
      nextBtnEl.textContent = "Liberar agora";
      nextBtnEl.className = "rounded-2xl bg-indigo-500/25 px-5 py-2.5 text-sm font-semibold text-indigo-100 ring-1 ring-indigo-400/30 hover:bg-indigo-500/35";
      nextBtnEl.onclick = () => {
        closeModal();
        setUnlocked(item.id, fmt, true);
        triggerDownload(item, fmt);
      };
    }
  }

  function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      remaining -= 1;
      refreshUI();
      if (remaining <= 0) {
        clearInterval(timer);
        armButtonForNextStep();
      }
    }, 1000);
  }

  startTimer();
}

function triggerDownload(item, fmt) {
  // For mock: download a tiny text file
  const content = [
    "MediaDock (mock)",
    `Item: ${item.title}`,
    `Formato: ${fmt.toUpperCase()}`,
    "",
    "Este arquivo é apenas um placeholder para testar o fluxo de download.",
    "No backend real, você gerará um arquivo (mp4/mp3) e fornecerá um link temporário.",
  ].join("\n");

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `mediadock-mock-${item.id}.${fmt === "mp3" ? "txt" : "txt"}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);

  toast(`Download (mock) iniciado: ${fmt.toUpperCase()}`);
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-2xl bg-slate-950 px-4 py-3 text-sm text-slate-100 ring-1 ring-white/10 shadow-glow";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2400);
}

function initEvents() {
  $("#btnCloseModal").addEventListener("click", closeModal);
  $("#modalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "modalBackdrop") closeModal();
  });

  $("#btnHowItWorks").addEventListener("click", openHowItWorks);
  $("#btnPremium").addEventListener("click", openPremiumModal);
  $("#btnPremiumMini").addEventListener("click", openPremiumModal);
  $("#btnPremiumTop").addEventListener("click", openPremiumModal);
  $("#btnLoginTop").addEventListener("click", openLoginModal);

  $("#btnContact").addEventListener("click", () => {
    setModal({
      title: "Contato (mock)",
      subtitle: "Ajustes de UX e feedback",
      icon: "info",
      bodyHtml: `
        <div class="space-y-3">
          <p class="text-sm">Depois que você publicar no GitHub Pages, me manda o link e o feedback (principalmente mobile).</p>
          <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10 text-xs text-slate-300">
            Sugestões de feedback: <br/>
            • tamanhos de botões <br/>
            • legibilidade <br/>
            • clareza do fluxo “assistir → liberar” <br/>
            • pontos de atrito
          </div>
        </div>
      `,
      footerButtons: [
        { label: "Fechar", className: "rounded-2xl bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/10", onClick: closeModal }
      ]
    });
  });

  $("#btnClear").addEventListener("click", () => {
    state.unlocked.clear();
    renderResults([]);
    renderResultsPlaceholder();
    toast("Limpou resultados e liberações");
  });

  $("#btnSearch").addEventListener("click", () => {
    const q = safeText($("#searchInput").value).trim();
    const items = MOCK_ITEMS.map(x => ({ ...x, title: q ? `${x.title} — “${q}”` : x.title }));
    renderResults(items);
  });

  $("#btnParseLink").addEventListener("click", () => {
    const url = safeText($("#linkInput").value).trim();
    const item = {
      id: "link1",
      title: url ? `Conteúdo do link (mock)` : "Conteúdo do link (mock)",
      source: url ? new URL(url, location.href).hostname : "exemplo.com",
      duration: "—"
    };
    renderResults([item]);
  });

  $("#btnSimulateAdblock").addEventListener("click", async () => {
    state.manualAdblock = !(state.manualAdblock ?? state.adblockDetected);
    const blocked = await detectAdblock();
    setAdblockUI(blocked);
    toast(blocked ? "AdBlock: ON (simulado)" : "AdBlock: OFF (simulado)");
  });

  // Footer links mock
  $("#lnkTerms").addEventListener("click", (e) => { e.preventDefault(); openDocModal("Termos (mock)", "Termos de uso simulados para teste de layout."); });
  $("#lnkPrivacy").addEventListener("click", (e) => { e.preventDefault(); openDocModal("Privacidade (mock)", "Política de privacidade simulada para teste de layout."); });
  $("#lnkHelp").addEventListener("click", (e) => { e.preventDefault(); openDocModal("Ajuda (mock)", "FAQ e ajuda simulados. No backend entra suporte/contato real."); });
}

function openDocModal(title, intro) {
  setModal({
    title,
    subtitle: "Conteúdo demonstrativo",
    icon: "info",
    bodyHtml: `
      <div class="space-y-3 text-sm">
        <p>${intro}</p>
        <div class="rounded-2xl bg-white/5 p-4 ring-1 ring-white/10 text-xs text-slate-300">
          <div class="font-semibold text-slate-100">Placeholder</div>
          <p class="mt-2">Aqui você colocará o texto real (compliance/uso permitido/licenças), ou links para páginas legais.</p>
        </div>
      </div>
    `,
    footerButtons: [
      { label: "Fechar", className: "rounded-2xl bg-white/5 px-5 py-2.5 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/10", onClick: closeModal }
    ]
  });
}

function renderResultsPlaceholder() {
  const wrap = $("#results");
  wrap.innerHTML = `
    <div class="rounded-2xl bg-slate-900/30 p-4 ring-1 ring-white/10">
      <div class="flex items-start gap-4">
        <div class="h-14 w-24 rounded-xl bg-white/5 ring-1 ring-white/10"></div>
        <div class="flex-1">
          <div class="h-3 w-2/3 rounded bg-white/10"></div>
          <div class="mt-2 h-3 w-1/3 rounded bg-white/10"></div>
          <div class="mt-4 flex gap-2">
            <div class="h-9 w-28 rounded-xl bg-white/10"></div>
            <div class="h-9 w-28 rounded-xl bg-white/10"></div>
          </div>
        </div>
      </div>
      <p class="mt-3 text-xs text-slate-400">Digite uma busca ou cole um link para ver o fluxo completo.</p>
    </div>
  `;
}

async function boot() {
  $("#year").textContent = new Date().getFullYear().toString();
  tabInit();
  initEvents();
  renderResultsPlaceholder();

  const blocked = await detectAdblock();
  setAdblockUI(blocked);
}

boot();

import { ChevronLeft, ChevronRight } from "lucide";
import { lucideHtml } from "../icons.js";
import { state } from "../../state.js";
import {
  streamBodCodOriginal,
  bodLevel,
  codLevel,
  fmtMgL,
} from "../../data/streamsBodCod.js";

/**
 * Compact drainage navigator above the chainage ruler.
 * ‹  Name (D-n)  i / N  ›
 */
export function mountJoiningStreamsNav(root) {
  const el = document.createElement("div");
  el.className = "joining-streams-nav map-chrome";
  el.id = "joining-streams-nav";
  el.hidden = true;
  el.setAttribute("aria-label", "Joining streams navigation");
  el.innerHTML = `
    <button type="button" class="joining-streams-nav__btn" id="js-nav-prev" aria-label="Previous drainage">
      ${lucideHtml(ChevronLeft, { size: 18, strokeWidth: 2.25 })}
    </button>
    <div class="joining-streams-nav__body">
      <div class="joining-streams-nav__name" id="js-nav-name">—</div>
      <div class="joining-streams-nav__meta" id="js-nav-meta">0 / 0</div>
      <div class="joining-streams-nav__wq" id="js-nav-wq" hidden></div>
    </div>
    <button type="button" class="joining-streams-nav__btn" id="js-nav-next" aria-label="Next drainage">
      ${lucideHtml(ChevronRight, { size: 18, strokeWidth: 2.25 })}
    </button>
  `;
  root.appendChild(el);

  const nameEl = el.querySelector("#js-nav-name");
  const metaEl = el.querySelector("#js-nav-meta");
  const wqEl = el.querySelector("#js-nav-wq");

  /** @type {object|null} */
  let lastRec = null;
  /** @type {object|null} */
  let hoverSample = null;

  function setWq(rec, sample) {
    lastRec = rec || null;
    if (sample !== undefined) hoverSample = sample || null;
    const q = hoverSample || (rec ? streamBodCodOriginal(rec) : null);
    if (!wqEl) return;
    const bod = Number.isFinite(q?.bod) ? q.bod : q?.bodMean;
    const cod = Number.isFinite(q?.cod) ? q.cod : q?.codMean;
    const ok = Number.isFinite(bod) || Number.isFinite(cod);
    wqEl.hidden = !ok;
    wqEl.innerHTML = ok
      ? `<span class="jsl-wq" data-level="${bodLevel(bod)}">BOD <b>${fmtMgL(bod)}</b></span>` +
        `<span class="jsl-wq" data-level="${codLevel(cod)}">COD <b>${fmtMgL(cod)}</b></span>` +
        `<span class="jsl-wq-unit">mg/L</span>`
      : "";
  }

  function onJoiningWq(e) {
    const rec = e?.detail?.rec;
    const sample = e?.detail?.sample;
    if (!rec) {
      setWq(lastRec, null);
      return;
    }
    const sameId =
      lastRec &&
      ((lastRec.id != null && rec.id != null && String(lastRec.id) === String(rec.id)) ||
        String(lastRec.displayName || lastRec.meta?.name || "")
          .trim()
          .toLowerCase() ===
          String(rec.displayName || rec.meta?.name || "")
            .trim()
            .toLowerCase());
    if (sameId) setWq(lastRec, sample || null);
  }
  document.addEventListener("joining-stream-wq", onJoiningWq);

  el.querySelector("#js-nav-prev")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.__MM_SCENE__?.stepJoiningStream?.(-1);
  });
  el.querySelector("#js-nav-next")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.__MM_SCENE__?.stepJoiningStream?.(1);
  });
  el.querySelector("#js-nav-prev")?.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.querySelector("#js-nav-next")?.addEventListener("pointerdown", (e) => e.stopPropagation());

  function setVisible(on) {
    const show = !!on && !!state.joiningStreamsMode;
    el.hidden = !show;
    if (show) el.style.pointerEvents = "auto";
  }

  function update(rec, list = []) {
    const total = list.length || 0;
    if (!rec || !total) {
      if (nameEl) nameEl.textContent = "—";
      if (metaEl) metaEl.textContent = total ? `0 / ${total}` : "0 / 0";
      setWq(null, null);
      return;
    }
    const idx = rec.navigationNumber ?? (rec.navIndex ?? 0) + 1;
    const totalNav = rec.navigationCount || total;
    // Source name only — never fall back to D-ID / Unnamed …
    const raw = String(rec.displayName || rec.meta?.name || rec.meta?.nameEn || rec.name || "").trim();
    const name = raw && !/^unnamed\b/i.test(raw) ? raw : "";
    if (nameEl) {
      nameEl.textContent = name;
      nameEl.hidden = !name;
      nameEl.style.display = name ? "" : "none";
    }
    if (metaEl) metaEl.textContent = `${idx} / ${totalNav}`;
    setWq(rec, null);
  }

  window.__MM_JOINING_NAV__ = { update, setVisible, el };

  return {
    el,
    update,
    setVisible,
    dispose() {
      document.removeEventListener("joining-stream-wq", onJoiningWq);
      el.remove();
      if (window.__MM_JOINING_NAV__?.el === el) delete window.__MM_JOINING_NAV__;
    },
  };
}
